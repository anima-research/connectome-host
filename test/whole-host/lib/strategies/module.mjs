import { AsyncLocalStorage } from 'node:async_hooks';
import { connect } from 'node:net';
import { lineReader } from './control.mjs';
import { isUnreadable, readable } from './invariants.mjs';
import { cutError } from './cut.mjs';
import { namingCanaries, messageNames } from './names.mjs';
import { blobStore, compiledLine, messagesOf, plain, refusedLine, stateOf, storeDelta } from './recorder.mjs';

const CALLER = new AsyncLocalStorage();
// Each request compile is stamped from CLOCK_MONOTONIC, the clock the driver's Node reads for process.hrtime on Linux
// (libuv's uv_hrtime), so the stand-in's arrival stamps order against it. Bun's process.hrtime counts from its own
// start, and elsewhere than Linux libuv reads another clock, so there the compile goes unstamped and unjudged.
const monotonic = await (async () => {
  if (typeof Bun === 'undefined') return () => process.hrtime.bigint();
  if (process.platform !== 'linux') return () => null;
  try {
    const { dlopen, FFIType, ptr } = await import('bun:ffi');
    const { symbols } = dlopen('libc.so.6', { clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
    const ts = new BigInt64Array(2);
    return () => (symbols.clock_gettime(1, ptr(ts)) === 0 ? ts[0] * 1_000_000_000n + ts[1] : null);
  } catch {
    return () => null;
  }
})();
const WRAPPED = Symbol.for('connectome-host.whole-host.wrapped');
const AGENT_COMPILES = ['compileWithInjections', 'compileContext'];
// context-manager's compile takes this budget when it's given none (context-manager.ts `compile`).
const DEFAULT_BUDGET = { maxTokens: 100000, reserveForResponse: 4000 };

export function register(api) {
  api.registerModule(() => new HarnessModule(process.env.FIXTURE_CONTROL, { record: process.env.FIXTURE_RECORD !== 'off' }));
}

export class HarnessModule {
  constructor(controlPath, { record = true } = {}) {
    this.name = 'whole-host-harness';
    this.controlPath = controlPath;
    this.recording = record;
    this.framework = null;
    this.sock = null;
    this.lines = [];
    this.seq = 0;
    this.assemblies = 0;
    this.blobs = blobStore();
    this.ticks = new WeakMap();
    this.submitting = new WeakSet();
    this.submissions = [];
    this.agentOf = new WeakMap();
    this.seen = new Map();
    this.managers = new Map();
    this.watching = new Set();
  }

  async start() {}

  async stop() {
    this.sock?.destroy();
    this.sock = null;
  }

  getTools() {
    return [];
  }

  async handleToolCall(call) {
    return { success: false, isError: true, error: `There's no tool ${JSON.stringify(call?.name)}, so nothing ran: the whole-host harness module offers none.` };
  }

  async onProcess() {
    return {};
  }

  setFramework(framework) {
    if (!this.controlPath) {
      console.warn('[whole-host-harness] FIXTURE_CONTROL is unset, so the harness module records nothing');
      return;
    }
    this.framework = framework;
    const primary = framework.getPrimaryAgentName();
    const agent = primary === null ? null : framework.getAgent(primary);
    if (!agent) throw new Error(`the whole-host harness module found no primary agent to record (getPrimaryAgentName() is ${JSON.stringify(primary)})`);
    if (this.recording) this.wrapAgentCompiles(Object.getPrototypeOf(agent));
    this.wrapManagerCompile(Object.getPrototypeOf(agent.getContextManager()));
    this.watchTicks(agent.getContextManager());
    this.connect();
  }

  wrapAgentCompiles(proto) {
    const module = this;
    for (const method of AGENT_COMPILES) {
      const original = proto[method];
      if (typeof original !== 'function' || original[WRAPPED]) continue;
      const wrapped = function (...args) {
        const caller = { agent: this.name, manager: this.getContextManager(), assembly: ++module.assemblies, open: true };
        const close = () => { caller.open = false; };
        const result = CALLER.run(caller, () => original.apply(this, args));
        if (result && typeof result.then === 'function') result.then(close, close);
        else close();
        return result;
      };
      wrapped[WRAPPED] = true;
      proto[method] = wrapped;
    }
  }

  wrapManagerCompile(proto) {
    const module = this;
    const original = proto.compile;
    if (typeof original !== 'function' || original[WRAPPED]) return;
    const wrapped = async function (...args) {
      module.watchTicks(this);
      if (!module.recording) return original.apply(this, args);
      const [budget, , opts] = args;
      const caller = CALLER.getStore();
      const own = caller?.manager === this && caller.open;
      const dry = opts?.dryRun === true;
      const head = {
        seq: ++module.seq,
        agent: module.agentName(this, own ? caller : null),
        kind: dry ? 'dry' : own ? 'request' : 'other',
        ...(own ? { assembly: caller.assembly } : {}),
        dry,
        budget: budget === undefined ? null : plain(budget),
      };
      if (head.agent !== null) module.managers.set(head.agent, this);
      let result;
      try {
        result = await original.apply(this, args);
      } catch (error) {
        module.record(head, () => refusedLine(error, module.blobs));
        throw error;
      }
      const line = module.record(head, () => compiledLine(this, budget ?? DEFAULT_BUDGET, result, module.blobs, (ids) => module.elsewhere(this, ids)));
      if (own && !dry) line.stamp = String(monotonic());
      return result;
    };
    wrapped[WRAPPED] = true;
    proto.compile = wrapped;
    const add = proto.addMessage;
    if (typeof add === 'function' && !add[WRAPPED]) {
      const watchedAdd = function (...args) {
        module.watchTicks(this);
        return add.apply(this, args);
      };
      watchedAdd[WRAPPED] = true;
      proto.addMessage = watchedAdd;
    }
  }

  record(head, body) {
    let line;
    try {
      line = { ...head, ...body() };
    } catch (error) {
      const { shown, full } = cutError(error, 300);
      line = { ...head, outcome: 'unrecordable', reason: shown, ...(full ? { full } : {}) };
    }
    this.lines.push(line);
    return line;
  }


  watchSubmissions(strategy) {
    if (!strategy || this.submitting.has(strategy) || typeof strategy.beginKvUnifiedSubmission !== 'function') return;
    this.submitting.add(strategy);
    const begin = strategy.beginKvUnifiedSubmission.bind(strategy);
    strategy.beginKvUnifiedSubmission = (args, ...rest) => {
      const result = begin(args, ...rest);
      this.submissions.push(String(args?.submissionId));
      return result;
    };
  }

  watchTicks(manager) {
    let strategy;
    try { strategy = manager.getStrategy(); } catch { return; }
    this.watching.add(manager);
    if (this.recording) this.watchSubmissions(strategy);
    if (!strategy || this.ticks.has(strategy) || typeof strategy.tick !== 'function') return;
    const counter = { inFlight: 0 };
    this.ticks.set(strategy, counter);
    const tick = strategy.tick.bind(strategy);
    strategy.tick = (...args) => {
      counter.inFlight++;
      let p;
      try { p = tick(...args); } catch (error) { counter.inFlight--; throw error; }
      return Promise.resolve(p).finally(() => { counter.inFlight--; });
    };
  }

  elsewhere(manager, ids) {
    const wanted = new Set(ids);
    const found = [];
    const from = [];
    const holders = [];
    const others = new Set(this.managers.values());
    for (const record of this.framework?.listAgents() ?? []) {
      const agent = this.framework.getAgent(record.name);
      if (agent) others.add(agent.getContextManager());
    }
    others.delete(manager);
    // A derived context (a fork) writes its own branch; a view merges slots on the compiling manager's branch.
    const branchOf = (m) => { const d = readable(() => m.getDerivation?.() ?? null); return isUnreadable(d) ? undefined : d?.branch ?? null; };
    const branch = branchOf(manager);
    for (const other of others) {
      if (branch === undefined || branchOf(other) !== branch) continue;
      if (!wanted.size) break;
      const messages = readable(() => other.getAllMessages());
      if (isUnreadable(messages)) continue;
      const before = found.length;
      for (const m of messages) if (wanted.delete(String(m.id))) found.push(m);
      if (found.length > before) {
        from.push(this.agentName(other, null));
        holders.push({ messages, agent: this.agentName(other, null) });
      }
    }
    const named = new Map();
    const nameOf = (id) => {
      const holder = holders.find(({ messages }) => messages.some((m) => String(m.id) === id));
      if (!holder) return null;
      if (!named.has(holder)) {
        const byId = new Map(holder.messages.map((m) => [String(m.id), m]));
        named.set(holder, messageNames([...byId.keys()], (x) => namingCanaries(byId.get(x).content)[0]));
      }
      return `${holder.agent ?? '?'}/${named.get(holder)(id)}`;
    };
    return { found, unfound: [...wanted], from: from.filter(Boolean), nameOf };
  }

  ticksInFlight(manager) {
    try { return this.ticks.get(manager.getStrategy())?.inFlight ?? 0; } catch { return null; }
  }

  agentName(manager, caller) {
    if (caller) return caller.agent;
    const known = this.agentOf.get(manager);
    if (known) return known;
    for (const record of this.framework?.listAgents({ includeEnded: true }) ?? []) {
      const agent = this.framework.getAgent(record.name);
      if (agent && agent.getContextManager() === manager) {
        this.agentOf.set(manager, record.name);
        return record.name;
      }
    }
    return null;
  }

  agentNamed(name) {
    const agent = this.framework?.getAgent(String(name));
    if (!agent) throw Object.assign(new Error(`no agent ${JSON.stringify(name)} is running`), { code: -32602 });
    return agent;
  }

  managerOf(name) {
    return this.agentNamed(name).getContextManager();
  }

  connect() {
    const sock = connect(this.controlPath, () => sock.write(`${JSON.stringify({ type: 'hello', peer: 'module', pid: process.pid })}\n`));
    sock.unref();
    sock.on('error', (e) => console.error(`[whole-host-harness] control socket ${this.controlPath}: ${e.message}`));
    lineReader(sock, (msg) => {
      if (msg?.id === undefined || typeof msg.op !== 'string') return;
      Promise.resolve()
        .then(() => this.answer(msg))
        .then((result) => ({ id: msg.id, result }), (error) => ({ id: msg.id, error: { code: error?.code ?? -32000, message: String(error?.message ?? error) } }))
        .then((reply) => sock.write(`${JSON.stringify(reply)}\n`));
    });
    this.sock = sock;
  }

  takeDelta(store, name, manager) {
    const delta = storeDelta(manager, this.seen.get(name), this.blobs);
    this.seen.set(name, delta.seen);
    if (delta.changed) store[name] = delta.out;
    return delta.unread;
  }

  async answer(msg) {
    switch (msg.op) {
      case 'take': {
        if (!this.recording) return { lines: [], store: {}, blobs: {} };
        const lines = this.lines;
        this.lines = [];
        const store = {};
        const live = new Map();
        for (const record of this.framework.listAgents() ?? []) {
          const agent = this.framework.getAgent(record.name);
          if (agent) live.set(record.name, agent.getContextManager());
        }
        // agent-framework deregisters an ephemeral agent at its run's end without closing its manager, so the
        // changes of one that compiled and has left are read from the manager kept from its compiles until its
        // ticks settle.
        for (const [name, manager] of this.managers) {
          if (live.get(name) === manager) continue;
          const unread = this.takeDelta(store, name, manager);
          if (unread || this.ticksInFlight(manager) > 0) continue;
          this.managers.delete(name);
          this.seen.delete(name);
        }
        for (const [name, manager] of live) this.takeDelta(store, name, manager);
        const submissions = this.submissions.splice(0);
        return { lines, store, blobs: this.blobs.take(), ...(submissions.length ? { submissions } : {}) };
      }
      case 'agents':
        return (this.framework.listAgents({ includeEnded: true }) ?? []).map((r) => r.name);
      case 'ticks': {
        const out = {};
        const live = new Set();
        for (const record of this.framework.listAgents() ?? []) {
          const agent = this.framework.getAgent(record.name);
          if (!agent) continue;
          live.add(agent.getContextManager());
          out[record.name] = this.ticksInFlight(agent.getContextManager());
        }
        // agent-framework releases an ended agent's manager without awaiting its tick, so it still counts until done.
        for (const manager of this.watching) {
          if (live.has(manager)) continue;
          const n = this.ticksInFlight(manager);
          if (n) out[`${this.agentName(manager, null) ?? 'an agent'} (ended)`] = n;
        }
        return out;
      }
      case 'state':
        return stateOf(this.managerOf(msg.agent));
      case 'messages':
        return messagesOf(this.managerOf(msg.agent));
      case 'dry-compile': {
        // agent-framework 0.32.0's compileBudget: the budget its own request compile passes, the context budget with
        // the tool-result guard's reservation.
        const agent = this.agentNamed(msg.agent);
        const budget = msg.budget ?? (typeof agent.compileBudget === 'function' ? agent.compileBudget() : undefined);
        const before = this.seq;
        await agent.getContextManager().compile(budget, undefined, { dryRun: true }).catch(() => null);
        return { seq: this.lines.find((l) => l.seq === before + 1 && l.kind === 'dry')?.seq ?? null };
      }
      default:
        throw Object.assign(new Error(`the harness module has no op ${JSON.stringify(msg.op)}`), { code: -32601 });
    }
  }
}
