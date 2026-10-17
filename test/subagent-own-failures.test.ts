/**
 * The subagent module's retries, its time limit and its concurrency limit.
 *
 * - Its own failures (a prompt over its limit, its own time limit) end the
 *   retry loop without their words being read, and the framework's
 *   failures are read without the ephemeral agent's name in them, which
 *   holds the name the agent chose. Before, a subagent named "migrate"
 *   (which holds "rate") counted as a rate limit and halved concurrency, one
 *   named "idle-watch" counted as transient, and a 1500 ms limit (which
 *   holds "500") was retried.
 * - At its time limit a run is stopped, not left working untracked.
 * - Raising the concurrency limit lets a waiting spawn start, except while a
 *   rate limit's halving holds.
 * - A sync run moves to the background at its timeoutMs and goes on; only an
 *   async run's timeoutMs is a hard limit, and it covers the retries.
 * - Slots are released once, and waiting spawns start wherever the limit
 *   rises or a slot frees.
 * - A run not started by its deadline is dropped by the framework and
 *   reported as the time limit; one whose setup outlasts it isn't started.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module, ToolCall } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { SubagentModule } from '../src/modules/subagent-module.js';

type Internal = {
  rateLimitCooldownMs: number;
  onRateLimitHit(): Promise<void>;
  asyncHandles: Map<string, { promise: Promise<unknown> }>;
  activeSubagents: Map<string, { lastActivityAt: number; status: string }>;
  cancellationHandles: Map<string, unknown>;
  liveSubagents: Map<string, { frameworkAgentName: string }>;
  callIdIndex: Map<string, string>;
  lastInputTokens: Map<string, number>;
  parentMap: Map<string, string>;
  waitOrStop(ms: number, cancelled: Promise<never>): Promise<unknown>;
  acquireSlot(slotTimeoutMs?: number, cancelled?: Promise<never>): Promise<{ waitedMs: number; slot: object }>;
  releaseSlot(slot: object): void;
  persistState(): void;
  effectiveConcurrent: number;
  configuredMaxConcurrent: number;
  consecutiveSuccesses: number;
  throttled: boolean;
  reclaimZombieSlots(): number;
  stopRun(agent: unknown): void;
  withTimeout<T>(p: Promise<T>, name: string, limitMs: number, deadline: number, stop: () => void): Promise<T>;
  isRateLimitError(err: Error): boolean;
  isTransientError(err: Error): boolean;
};
const internal = (s: SubagentModule) => s as unknown as Internal;

interface Harness {
  framework: AgentFramework;
  subagent: SubagentModule;
  runs(): number;
  /** Whether a run of this subagent is in the framework now, past its
   *  setup: the point at which a stop or a reclaim can end it. */
  running(name: string): boolean;
  cleanup(): Promise<void>;
}

/** What the module gives the framework's run of an ephemeral agent. */
type Watchdogs = { startupTimeoutMs?: number } | undefined;
type Run = (agent: { name: string }, contextManager: unknown, watchdogs: Watchdogs) => Promise<{ speech: string; toolCallsCount: number }>;

/** `run` stands in for the framework's run of each ephemeral agent; left
 *  out, the framework runs it against the mock provider. */
async function harness(
  config: ConstructorParameters<typeof SubagentModule>[0],
  run?: Run,
  adapter = new MockAdapter({ defaultResponse: 'ok' }),
): Promise<Harness> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sub-own-'));
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
  const subagent = new SubagentModule({ parentAgentName: 'parent', defaultModel: 'mock', defaultMaxTokens: 256, ...config });
  // The rate-limit cooldown is 30 s; nothing here depends on its length.
  (subagent as unknown as Internal).rateLimitCooldownMs = 0;
  const framework = await AgentFramework.create({
    storePath: join(tmpDir, 'store'),
    membrane,
    agents: [{ name: 'parent', model: 'mock', systemPrompt: 'parent', maxTokens: 256 }],
    modules: [subagent as unknown as Module],
  });
  let runs = 0;
  const fw = framework as unknown as {
    createEphemeralAgent: (c: unknown) => Promise<unknown>;
    runEphemeralToCompletion: Run;
    agents: Map<string, unknown>;
  };
  const create = fw.createEphemeralAgent.bind(fw);
  fw.createEphemeralAgent = (c) => { runs++; return create(c); };
  if (run) {
    fw.runEphemeralToCompletion = (agent, contextManager, watchdogs) => {
      // Registered by name while it runs, as the framework's own run does,
      // so a stop finds it.
      fw.agents.set(agent.name, agent);
      const ran = run(agent, contextManager, watchdogs);
      const drop = () => { if (fw.agents.get(agent.name) === agent) fw.agents.delete(agent.name); };
      ran.then(drop, drop);
      return ran;
    };
  }
  subagent.setFramework(framework);
  framework.start();
  return {
    framework,
    subagent,
    runs: () => runs,
    running: (name: string) => [...fw.agents.keys()].some((k) => k.startsWith(`spawn-${name}-`) || k.startsWith(`${name}-d`)),
    cleanup: async () => {
      try { await framework.stop(); } catch { /* noop */ }
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function spawn(name: string, extra: Record<string, unknown> = {}): ToolCall {
  return { id: `t-${name}-${Math.random().toString(36).slice(2)}`, name: 'spawn', input: { name, systemPrompt: 'sp', task: 't', ...extra }, callerAgentName: 'parent' };
}

function fork(name: string, extra: Record<string, unknown> = {}): ToolCall {
  return { id: `t-${name}-${Math.random().toString(36).slice(2)}`, name: 'fork', input: { name, task: 't', ...extra }, callerAgentName: 'parent' };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait for what a step brings about rather than for a set time, and fail
 *  if it doesn't come. */
async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() >= end) throw new Error(`not brought about within ${ms} ms`);
    await sleep(10);
  }
}
/** A promise the test opens when it's ready: it holds a run open for as
 *  long as the test's probes need, rather than for a set time. */
function gate(): { open(): void; wait: Promise<void> } {
  let open!: () => void;
  const wait = new Promise<void>((r) => { open = r; });
  return { open, wait };
}
/** The waits a run makes between attempts (a rate limit's cooldown, the
 *  back-off before a retry): each one's length, and whether the run's
 *  cancel or its own timer ended it. */
function watchWaits(sub: SubagentModule): Array<{ ms: number; endedBy?: 'cancel' | 'timer' }> {
  const waits: Array<{ ms: number; endedBy?: 'cancel' | 'timer' }> = [];
  const m = internal(sub);
  const wait = m.waitOrStop.bind(sub);
  m.waitOrStop = async (ms, cancelled) => {
    const w: { ms: number; endedBy?: 'cancel' | 'timer' } = { ms };
    waits.push(w);
    const stopped = await wait(ms, cancelled);
    w.endedBy = stopped ? 'cancel' : 'timer';
    return stopped;
  };
  return waits;
}
/** The reasons of the promise rejections nothing handled while it watched. */
function watchUnhandled(): { reasons: unknown[]; stop(): void } {
  const reasons: unknown[] = [];
  const record = (reason: unknown) => { reasons.push(reason); };
  process.on('unhandledRejection', record);
  return { reasons, stop: () => { process.off('unhandledRejection', record); } };
}
/** The settled outcome of an async subagent, from its handle. */
async function outcome(h: Harness, name: string): Promise<{ ok: boolean; text: string }> {
  const handle = internal(h.subagent).asyncHandles.get(name);
  if (!handle) throw new Error(`no async handle for ${name}`);
  return handle.promise.then(
    (r) => ({ ok: true, text: (r as { summary: string }).summary }),
    (e) => ({ ok: false, text: e instanceof Error ? e.message : String(e) }),
  );
}
/** What the module delivers to the parent agent: each message it adds to
 *  the parent's context, and each inference it requests. */
function deliveries(h: Harness): { messages: string[]; requests: string[] } {
  const got = { messages: [] as string[], requests: [] as string[] };
  const ctx = (h.subagent as unknown as { ctx: {
    addMessage(participant: string, content: Array<{ type: string; text?: string }>): unknown;
    pushEvent(event: { type: string; reason?: string }): unknown;
  } }).ctx;
  const add = ctx.addMessage.bind(ctx);
  const push = ctx.pushEvent.bind(ctx);
  ctx.addMessage = (participant, content) => {
    for (const block of content) if (block.type === 'text' && block.text) got.messages.push(block.text);
    return add(participant, content);
  };
  ctx.pushEvent = (event) => {
    if (event.type === 'inference-request' && event.reason) got.requests.push(event.reason);
    return push(event);
  };
  return got;
}

/** Count each ephemeral agent's stops (cancelStream calls) and when they came. */
function countStops(h: Harness): number[] {
  const at: number[] = [];
  const fw = h.framework as unknown as { createEphemeralAgent: (c: unknown) => Promise<{ agent: { cancelStream(): void } }> };
  const create = fw.createEphemeralAgent.bind(fw);
  fw.createEphemeralAgent = async (c) => {
    const made = await create(c);
    const cancel = made.agent.cancelStream.bind(made.agent);
    made.agent.cancelStream = () => { at.push(Date.now()); cancel(); };
    return made;
  };
  return at;
}

describe('the module\'s own failures end the retry loop without their words being read', () => {
  for (const name of ['migrate', 'idle-watch']) {
    test(`a prompt over the limit, for a subagent named ${name}, runs once and leaves concurrency alone`, async () => {
      const h = await harness({ maxPromptTokens: 10, maxRetries: 1 });
      try {
        const res = await h.subagent.handleToolCall(spawn(name, { sync: true }));
        expect(res.error ?? '').toContain(`Prompt too large for subagent ${name}`);
        expect(h.runs()).toBe(1);
        expect(h.subagent.getConcurrencyStatus().effective).toBe(5);
      } finally { await h.cleanup(); }
    }, 20_000);
  }

  test('an async time limit of 1500 ms is not retried', async () => {
    const h = await harness({ maxRetries: 1 }, () => new Promise(() => { /* never settles */ }));
    try {
      await h.subagent.handleToolCall(spawn('scout', { timeoutMs: 1500 }));
      const out = await outcome(h, 'scout');
      expect(out).toEqual({ ok: false, text: 'Subagent scout timed out after 1500ms' });
      expect(h.runs()).toBe(1);
    } finally { await h.cleanup(); }
  }, 20_000);
});

describe('a framework failure is read without the ephemeral agent\'s name, and numbers as whole numbers', () => {
  // agent-framework 0.22.2's startup watchdog, which quotes the agent's name.
  const watchdog = (agent: { name: string }) => new Error(
    `Ephemeral agent "${agent.name}" failed to start inference within 15000ms — zombie detected. ` +
    'The event loop may have stalled or the inference request was dropped.',
  );

  test('a subagent named migrate whose run the watchdog ended runs once and leaves concurrency alone', async () => {
    const h = await harness({ maxRetries: 1 }, async (agent) => { throw watchdog(agent); });
    try {
      const res = await h.subagent.handleToolCall(spawn('migrate', { sync: true }));
      expect(res.error ?? '').toContain('failed to start inference within 15000ms');
      expect(h.runs()).toBe(1);
      expect(h.subagent.getConcurrencyStatus().effective).toBe(5);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('control: a provider\'s own transient words are still retried', async () => {
    const h = await harness({ maxRetries: 1 }, async () => { throw new Error('503 overloaded: socket hang up'); });
    try {
      const res = await h.subagent.handleToolCall(spawn('scout', { sync: true }));
      expect(res.success).toBe(false);
      expect(h.runs()).toBe(2);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('the classifiers read status codes as whole numbers and rate limits by their phrases', async () => {
    const h = await harness({});
    try {
      const sub = internal(h.subagent);
      expect(sub.isTransientError(new Error('no activity for 1500s (threshold 900s)'))).toBe(false);
      expect(sub.isTransientError(new Error('HTTP 503 Service Unavailable'))).toBe(true);
      expect(sub.isTransientError(new Error('status=529 overloaded'))).toBe(true);
      expect(sub.isRateLimitError(new Error('failed to generate a moderate answer'))).toBe(false);
      expect(sub.isRateLimitError(new Error('waited 14290ms'))).toBe(false);
      expect(sub.isRateLimitError(new Error('rate_limit_error: slow down'))).toBe(true);
      expect(sub.isRateLimitError(new Error('429 Too Many Requests'))).toBe(true);
      expect(sub.isRateLimitError(new Error('Rate exceeded'))).toBe(true);
      expect(sub.isRateLimitError(new Error('upstream_rate_limit_exceeded'))).toBe(true);
      expect(sub.isRateLimitError(new Error('x-ratelimit-remaining: 0'))).toBe(true);
      expect(sub.isRateLimitError(new Error('Too many concurrent requests'))).toBe(true);
      expect(sub.isRateLimitError(new Error('the answer was rated poorly, rather than ratio'))).toBe(false);
      expect(sub.isRateLimitError(new Error('too many tokens in the prompt'))).toBe(false);
    } finally { await h.cleanup(); }
  });
});

describe('a sync run moves to the background at its timeoutMs and goes on', () => {
  test('with timeoutMs, the call answers "moved to background", the run is not stopped, and its result arrives', async () => {
    const h = await harness({ maxRetries: 0 }, () => sleep(700).then(() => ({ speech: 'done', toolCallsCount: 0 })));
    const stops = countStops(h);
    const delivered = deliveries(h);
    try {
      const res = await h.subagent.handleToolCall(spawn('scout', { sync: true, timeoutMs: 200 }));
      expect(String(res.data)).toContain('moved to background');
      expect(await outcome(h, 'scout')).toEqual({ ok: true, text: 'done' });
      expect(stops).toEqual([]);
      // The parent gets the result as a message, and one turn to read it.
      await until(() => delivered.requests.length > 0);
      await sleep(50);
      expect(delivered.messages.filter((m) => m.startsWith("[Subagent 'scout'"))).toEqual(["[Subagent 'scout' returned]\n\ndone"]);
      expect(delivered.requests).toEqual(['subagent-completed:scout']);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('without timeoutMs, it moves at maxExecutionMs, the default, and isn\'t stopped there either', async () => {
    const h = await harness({ maxRetries: 0, maxExecutionMs: 200 }, () => sleep(700).then(() => ({ speech: 'done', toolCallsCount: 0 })));
    const stops = countStops(h);
    const delivered = deliveries(h);
    try {
      const res = await h.subagent.handleToolCall(spawn('scout', { sync: true }));
      expect(String(res.data)).toContain('moved to background');
      expect(await outcome(h, 'scout')).toEqual({ ok: true, text: 'done' });
      expect(stops).toEqual([]);
      // The parent gets the result as a message, and one turn to read it.
      await until(() => delivered.requests.length > 0);
      await sleep(50);
      expect(delivered.messages.filter((m) => m.startsWith("[Subagent 'scout'"))).toEqual(["[Subagent 'scout' returned]\n\ndone"]);
      expect(delivered.requests).toEqual(['subagent-completed:scout']);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a sync fork does the same', async () => {
    const h = await harness({ maxRetries: 0 }, () => sleep(700).then(() => ({ speech: 'done', toolCallsCount: 0 })));
    const stops = countStops(h);
    const delivered = deliveries(h);
    try {
      const res = await h.subagent.handleToolCall(fork('probe', { sync: true, timeoutMs: 200 }));
      expect(String(res.data)).toContain('moved to background');
      expect(await outcome(h, 'probe')).toEqual({ ok: true, text: 'done' });
      expect(stops).toEqual([]);
      // The parent gets the result as a message, and one turn to read it.
      await until(() => delivered.requests.length > 0);
      await sleep(50);
      expect(delivered.messages.filter((m) => m.startsWith("[Subagent 'probe'"))).toEqual(["[Subagent 'probe' returned]\n\ndone"]);
      expect(delivered.requests).toEqual(['subagent-completed:probe']);
    } finally { await h.cleanup(); }
  }, 20_000);
});

describe('an async run is stopped at its time limit, which covers its retries', () => {
  test('no more of its stream arrives after the stop, and the framework lets the run go', async () => {
    // 60 one-character chunks 100 ms apart: about 6 s of streaming.
    const adapter = new MockAdapter({ defaultResponse: 'x'.repeat(60), streamChunkSize: 1, streamChunkDelayMs: 100 });
    const h = await harness({ maxRetries: 0 }, undefined, adapter);
    const stops = countStops(h);
    const tokensAt: number[] = [];
    h.framework.onTrace((e) => {
      const ev = e as { type: string; agentName?: string };
      if (ev.type === 'inference:tokens' && ev.agentName?.startsWith('spawn-scout-')) tokensAt.push(Date.now());
    });
    const runs = (h.framework as unknown as { ephemeralRuns: Map<string, unknown> }).ephemeralRuns;
    const live = () => [...runs.keys()].filter((k) => k.startsWith('spawn-scout-'));
    try {
      await h.subagent.handleToolCall(spawn('scout', { timeoutMs: 1000 }));
      expect(await outcome(h, 'scout')).toEqual({ ok: false, text: 'Subagent scout timed out after 1000ms' });
      expect(tokensAt.length).toBeGreaterThan(0);
      expect(stops.length).toBeGreaterThan(0); // the limit stopped the run
      // The framework lets the run go well before its stream would have
      // ended by itself, about 6 s in.
      await until(() => live().length === 0, 2_000);
      expect(live()).toEqual([]);
      // Once the framework has let the run go, it drops the stream's later
      // events unread (agent-framework 0.22.2, driveStream's check that the
      // agent still owns its name), so the count is final. At most a chunk
      // already on its way when the stream was cancelled.
      const stoppedAt = stops[0]!;
      expect(tokensAt.filter((t) => t > stoppedAt).length).toBeLessThanOrEqual(1);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a run that ends before its limit is not stopped later by its timer', async () => {
    const h = await harness({ maxRetries: 0 }, () => sleep(20).then(() => ({ speech: 'ok', toolCallsCount: 0 })));
    const stops = countStops(h);
    try {
      await h.subagent.handleToolCall(spawn('scout', { timeoutMs: 1500 }));
      expect(await outcome(h, 'scout')).toEqual({ ok: true, text: 'ok' });
      await sleep(1700);
      expect(stops).toEqual([]);
    } finally { await h.cleanup(); }
  });

  test('a retry that couldn\'t start within the limit isn\'t started, and the failure is reported', async () => {
    let attempts = 0;
    const h = await harness({ maxRetries: 1 }, async () => { attempts++; await sleep(50); throw new Error('503 overloaded'); });
    try {
      await h.subagent.handleToolCall(spawn('scout', { timeoutMs: 3000 }));
      expect(await outcome(h, 'scout')).toEqual({ ok: false, text: '503 overloaded' });
      expect(attempts).toBe(1); // the retry's 5 s back-off would end past the 3 s limit
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a retry that starts within the limit gets only what is left of it', async () => {
    const given: Watchdogs[] = [];
    const h = await harness({ maxRetries: 1 }, async (_agent, _cm, watchdogs) => {
      given.push(watchdogs);
      if (given.length === 1) { await sleep(50); throw new Error('503 overloaded'); }
      return new Promise(() => { /* never settles */ });
    });
    try {
      const started = Date.now();
      await h.subagent.handleToolCall(spawn('scout', { timeoutMs: 6000 }));
      const out = await outcome(h, 'scout');
      const took = Date.now() - started;
      expect(out).toEqual({ ok: false, text: 'Subagent scout timed out after 6000ms' });
      expect(given).toHaveLength(2);
      // The retry started after the 5 s back-off with what was left, under
      // 1 s, where a fresh limit would have given it 6 s.
      expect(given[0]!.startupTimeoutMs!).toBeGreaterThan(5000);
      expect(given[1]!.startupTimeoutMs!).toBeLessThanOrEqual(1000);
      expect(took).toBeLessThan(8500); // a fresh limit would end at about 11 s
    } finally { await h.cleanup(); }
  }, 20_000);

  for (const kind of ['spawn', 'fork'] as const) {
    test(`a rate limit's cooldown ends at the run's limit, for a ${kind}`, async () => {
      const h = await harness({ maxRetries: 1 }, async () => { await sleep(1000); throw new Error('429 Too Many Requests'); });
      internal(h.subagent).rateLimitCooldownMs = 5000;
      const lines: string[] = [];
      const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
      try {
        const started = Date.now();
        await h.subagent.handleToolCall(kind === 'spawn' ? spawn('scout', { timeoutMs: 1500 }) : fork('scout', { timeoutMs: 1500 }));
        const out = await outcome(h, 'scout');
        const took = Date.now() - started;
        expect(out).toEqual({ ok: false, text: '429 Too Many Requests' });
        expect(h.runs()).toBe(1);
        // It cooled down for what was left of its limit, about 500 ms, not 5 s.
        const cooled = lines.map((l) => /cooling down (\d+)ms/.exec(l)?.[1]).filter((m) => m !== undefined).map(Number);
        expect(cooled).toHaveLength(1);
        expect(cooled[0]!).toBeLessThanOrEqual(500);
        expect(took).toBeLessThan(4000); // a whole cooldown would end at about 6 s
        expect(h.subagent.getConcurrencyStatus().effective).toBe(2); // the halving holds
      } finally {
        spy.mockRestore();
        await h.cleanup();
      }
    }, 20_000);
  }

  test('a run not started by its deadline is dropped by the framework\'s startup watchdog, and reported as the time limit', async () => {
    const given: Watchdogs[] = [];
    // As agent-framework 0.22.2 does: a run whose inference hasn't started
    // by its startup watchdog is rejected with the framework's own words.
    // Its timer fires a millisecond early, as Node's can, so it settles the
    // attempt before the module's own limit does.
    const h = await harness({ maxRetries: 1 }, (agent, _cm, watchdogs) => {
      given.push(watchdogs);
      const ms = watchdogs?.startupTimeoutMs ?? 30_000;
      return new Promise((_, reject) => setTimeout(() => reject(new Error(
        `Ephemeral agent "${agent.name}" failed to start inference within ${ms}ms — zombie detected. ` +
        'The event loop may have stalled or the inference request was dropped.',
      )), ms - 1));
    });
    try {
      await h.subagent.handleToolCall(spawn('scout', { timeoutMs: 1500 }));
      expect(await outcome(h, 'scout')).toEqual({ ok: false, text: 'Subagent scout timed out after 1500ms' });
      expect(h.runs()).toBe(1);
      expect(given).toHaveLength(1);
      expect(given[0]!.startupTimeoutMs!).toBeGreaterThan(1000);
      expect(given[0]!.startupTimeoutMs!).toBeLessThanOrEqual(1500);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a run without a limit leaves the framework\'s watchdogs as they are', async () => {
    const given: Watchdogs[] = [];
    const h = await harness({ maxRetries: 0 }, async (_agent, _cm, watchdogs) => {
      given.push(watchdogs);
      return { speech: 'ok', toolCallsCount: 0 };
    });
    try {
      await h.subagent.handleToolCall(spawn('scout'));
      expect(await outcome(h, 'scout')).toEqual({ ok: true, text: 'ok' });
      expect(given).toEqual([undefined]);
    } finally { await h.cleanup(); }
  });

  test('an async run\'s limit counts from when it holds a slot, not from the call', async () => {
    const given: Record<string, Watchdogs> = {};
    const h = await harness({ maxConcurrent: 1, maxRetries: 0 }, (agent, _cm, watchdogs) => {
      const name = agent.name.split('-')[1]!;
      given[name] = watchdogs;
      return name === 'first'
        ? sleep(800).then(() => ({ speech: 'ok', toolCallsCount: 0 }))
        : new Promise(() => { /* never settles */ });
    });
    try {
      await h.subagent.handleToolCall(spawn('first'));
      await until(() => h.subagent.getConcurrencyStatus().active === 1);
      await h.subagent.handleToolCall(spawn('second', { timeoutMs: 1500 }));
      expect(await outcome(h, 'second')).toEqual({ ok: false, text: 'Subagent second timed out after 1500ms' });
      // It waited about 800 ms for its slot, and its limit started then.
      expect(given.second!.startupTimeoutMs!).toBeGreaterThan(1000);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a run whose setup outlasts its limit isn\'t started', async () => {
    let started = 0;
    const h = await harness({ maxRetries: 0 }, () => { started++; return new Promise(() => { /* never settles */ }); });
    try {
      const fw = h.framework as unknown as { createEphemeralAgent: (c: unknown) => Promise<unknown> };
      const create = fw.createEphemeralAgent.bind(fw);
      fw.createEphemeralAgent = async (c) => { await sleep(700); return create(c); };
      await h.subagent.handleToolCall(spawn('scout', { timeoutMs: 500 }));
      expect(await outcome(h, 'scout')).toEqual({ ok: false, text: 'Subagent scout timed out after 500ms' });
      expect(started).toBe(0);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a fork with a 1500 ms limit is stopped once and not retried', async () => {
    const h = await harness({ maxRetries: 1 }, () => new Promise(() => { /* never settles */ }));
    const stops = countStops(h);
    try {
      await h.subagent.handleToolCall(fork('probe', { timeoutMs: 1500 }));
      expect(await outcome(h, 'probe')).toEqual({ ok: false, text: 'Subagent probe timed out after 1500ms' });
      expect(h.runs()).toBe(1);
      expect(stops).toHaveLength(1);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a fork whose prompt is over the limit runs once and leaves concurrency alone', async () => {
    const h = await harness({ maxPromptTokens: 10, maxRetries: 1 });
    try {
      const res = await h.subagent.handleToolCall(fork('migrate', { sync: true }));
      expect(res.error ?? '').toContain('Prompt too large for subagent migrate');
      expect(h.runs()).toBe(1);
      expect(h.subagent.getConcurrencyStatus().effective).toBe(5);
    } finally { await h.cleanup(); }
  }, 20_000);
});

describe('the stop', () => {
  test('cancels the live stream of an agent at a tool boundary, which cancelStream alone leaves', async () => {
    const h = await harness({});
    try {
      const calls: string[] = [];
      const agent = {
        state: { status: 'ready', stream: { cancel: () => calls.push('stream.cancel') } },
        cancelStream: () => calls.push('cancelStream'),
      };
      internal(h.subagent).stopRun(agent);
      expect(calls).toEqual(['stream.cancel', 'cancelStream']);
      calls.length = 0;
      internal(h.subagent).stopRun({ state: { status: 'streaming' }, cancelStream: () => calls.push('cancelStream') });
      expect(calls).toEqual(['cancelStream']);
    } finally { await h.cleanup(); }
  });

  test('sets the agent idle even when the stream\'s cancel throws, or there is no stream', async () => {
    const h = await harness({});
    try {
      const calls: string[] = [];
      const throwing = {
        state: { status: 'ready', stream: { cancel: () => { throw new Error('gone'); } } },
        cancelStream: () => calls.push('cancelStream'),
      };
      expect(() => internal(h.subagent).stopRun(throwing)).toThrow('gone');
      expect(calls).toEqual(['cancelStream']);
      calls.length = 0;
      internal(h.subagent).stopRun({ state: { status: 'ready' }, cancelStream: () => calls.push('cancelStream') });
      expect(calls).toEqual(['cancelStream']);
    } finally { await h.cleanup(); }
  });

  test('a user\'s cancel stops the run through it', async () => {
    const h = await harness({ maxRetries: 0 }, () => new Promise(() => { /* never settles */ }));
    try {
      const sub = internal(h.subagent);
      const stopped: unknown[] = [];
      const stop = sub.stopRun.bind(sub);
      sub.stopRun = (agent) => { stopped.push(agent); stop(agent); };
      await h.subagent.handleToolCall(spawn('scout'));
      await until(() => h.running('scout'));
      expect(h.subagent.cancelSubagent('scout')).toBe(true);
      expect((await outcome(h, 'scout')).text).toContain('[Stopped by user]');
      expect(stopped).toHaveLength(1);
    } finally { await h.cleanup(); }
  });

  test('a stop that throws still ends the attempt at its limit, and is logged', async () => {
    const h = await harness({});
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    try {
      const never = new Promise<never>(() => {});
      const ended = await internal(h.subagent).withTimeout(never, 'scout', 50, Date.now() + 50, () => { throw new Error('boom'); })
        .then(() => 'resolved', (e: Error) => e.message);
      expect(ended).toBe('Subagent scout timed out after 50ms');
      expect(lines).toContain('[subagent] scout: stopping the run at its time limit failed: boom');
    } finally {
      spy.mockRestore();
      await h.cleanup();
    }
  });
});

describe('concurrency slots', () => {
  test('a spawn waiting for a slot starts when the limit rises', async () => {
    const order: string[] = [];
    const h = await harness({ maxConcurrent: 1, maxRetries: 0 }, (agent) => new Promise((resolve) => {
      const ms = agent.name.startsWith('spawn-long-') ? 3000 : 50;
      setTimeout(() => { order.push(agent.name.split('-')[1]!); resolve({ speech: 'ok', toolCallsCount: 0 }); }, ms);
    }));
    try {
      await h.subagent.handleToolCall(spawn('long'));
      await until(() => h.subagent.getConcurrencyStatus().active === 1);
      await h.subagent.handleToolCall(spawn('short'));
      await until(() => h.subagent.getConcurrencyStatus().queued === 1);
      expect(h.subagent.getConcurrencyStatus()).toEqual({ configured: 1, effective: 1, active: 1, queued: 1 });
      const raised = await h.subagent.handleToolCall({ id: 't-c', name: 'concurrency', input: { maxConcurrent: 2 }, callerAgentName: 'parent' });
      expect(raised.data).toEqual({ configured: 2, effective: 2, active: 2, queued: 0 });
      const short = outcome(h, 'short');
      const long = outcome(h, 'long');
      await short;
      expect(order).toEqual(['short']);
      await long;
    } finally { await h.cleanup(); }
  }, 20_000);

  test('while a rate limit holds the limit down, a higher ceiling waits for successes, and the answer says so', async () => {
    const h = await harness({ maxConcurrent: 4 });
    try {
      await internal(h.subagent).onRateLimitHit();
      expect(h.subagent.getConcurrencyStatus().effective).toBe(2);
      h.subagent.setConcurrency(8);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({
        configured: 8,
        effective: 2,
        note: 'A rate limit holds the limit at 2. It rises by one after every three subagents that finish without error, up to 8.',
      });
      h.subagent.setConcurrency(1);
      expect(h.subagent.getConcurrencyStatus()).toEqual({ configured: 1, effective: 1, active: 0, queued: 0 });
      h.subagent.setConcurrency(3);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ configured: 3, effective: 3 });
    } finally { await h.cleanup(); }
  });

  test('once successes bring a halved limit back to the ceiling, a raise takes effect at once', async () => {
    const h = await harness({ maxConcurrent: 2, maxRetries: 0 }, () => sleep(5).then(() => ({ speech: 'ok', toolCallsCount: 0 })));
    try {
      await internal(h.subagent).onRateLimitHit();
      expect(h.subagent.getConcurrencyStatus().effective).toBe(1);
      // Three successes in a row raise the effective limit by one.
      for (let i = 0; i < 3; i++) await h.subagent.handleToolCall(spawn(`ok${i}`, { sync: true }));
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ configured: 2, effective: 2 });
      h.subagent.setConcurrency(5);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ configured: 5, effective: 5 });
    } finally { await h.cleanup(); }
  });

  test('a success that raises the limit starts every waiting spawn there\'s room for', async () => {
    const h = await harness({ maxConcurrent: 3, maxRetries: 0 }, (agent) => (agent.name.startsWith('spawn-short-')
      ? sleep(100).then(() => ({ speech: 'ok', toolCallsCount: 0 }))
      : new Promise(() => { /* holds its slot */ })));
    try {
      const sub = internal(h.subagent);
      sub.effectiveConcurrent = 2;
      sub.throttled = true;
      sub.consecutiveSuccesses = 2;
      await h.subagent.handleToolCall(spawn('long'));
      await h.subagent.handleToolCall(spawn('short'));
      await h.subagent.handleToolCall(spawn('w1'));
      await h.subagent.handleToolCall(spawn('w2'));
      await until(() => h.subagent.getConcurrencyStatus().queued === 2);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ effective: 2, active: 2, queued: 2 });
      await outcome(h, 'short');
      // The success raised the limit to 3 as its slot freed: both waiting spawns start.
      await until(() => h.subagent.getConcurrencyStatus().queued === 0);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ effective: 3, active: 3, queued: 0 });
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a reclaimed zombie\'s slot is released once, and goes to a waiting spawn', async () => {
    const h = await harness({ maxConcurrent: 2, maxRetries: 0 }, () => new Promise(() => { /* holds its slot */ }));
    try {
      const sub = internal(h.subagent);
      await h.subagent.handleToolCall(spawn('zombie'));
      await h.subagent.handleToolCall(spawn('long'));
      await h.subagent.handleToolCall(spawn('waiting'));
      // Both runs have reached the point where a reclaim can end them.
      await until(() => h.subagent.getConcurrencyStatus().queued === 1
        && h.running('zombie') && h.running('long'));
      const stopped: unknown[] = [];
      const stop = sub.stopRun.bind(sub);
      sub.stopRun = (agent) => { stopped.push(agent); stop(agent); };
      sub.activeSubagents.get('spawn-zombie')!.lastActivityAt = Date.now() - 200_000;
      expect(sub.reclaimZombieSlots()).toBe(1);
      expect(stopped).toHaveLength(1);
      expect((await outcome(h, 'zombie')).text).toContain('[Terminated: zombie]');
      // The zombie's own finally found its slot released already.
      await until(() => h.subagent.getConcurrencyStatus().active === 2 && h.subagent.getConcurrencyStatus().queued === 0);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 2, queued: 0 });
      await sleep(50);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 2, queued: 0 });
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a finished fork of the same name doesn\'t hide a stuck spawn from the reclaim', async () => {
    const h = await harness({ maxConcurrent: 2, maxRetries: 0 }, (agent) => (agent.name.startsWith('spawn-')
      ? new Promise(() => { /* holds its slot */ })
      : sleep(5).then(() => ({ speech: 'ok', toolCallsCount: 0 }))));
    try {
      const sub = internal(h.subagent);
      expect((await h.subagent.handleToolCall(fork('scout', { sync: true }))).success).toBe(true);
      await h.subagent.handleToolCall(spawn('scout'));
      await until(() => h.running('scout'));
      sub.activeSubagents.get('spawn-scout')!.lastActivityAt = Date.now() - 200_000;
      expect(sub.reclaimZombieSlots()).toBe(1);
      expect((await outcome(h, 'scout')).text).toContain('[Terminated: zombie]');
      await until(() => h.subagent.getConcurrencyStatus().active === 0);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0 });
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a waiter whose wait runs out takes the slot a last-chance reclaim frees, and leaves the others waiting', async () => {
    const h = await harness({ maxConcurrent: 1, maxRetries: 0 }, () => new Promise(() => { /* holds its slot */ }));
    try {
      const sub = internal(h.subagent);
      await h.subagent.handleToolCall(spawn('zombie'));
      await until(() => h.running('zombie'));
      const first = sub.acquireSlot(100); // gives up after 100 ms, unless a reclaim then frees a slot
      const second = sub.acquireSlot(10_000);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 1, queued: 2 });
      sub.activeSubagents.get('spawn-zombie')!.lastActivityAt = Date.now() - 200_000;
      const got = await first;
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 1, queued: 1 });
      sub.releaseSlot(got.slot);
      sub.releaseSlot((await second).slot);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0, queued: 0 });
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a throw while the run registers still releases its slot', async () => {
    const h = await harness({ maxRetries: 0 });
    try {
      const sub = internal(h.subagent);
      const persist = sub.persistState.bind(sub);
      let failed = false;
      sub.persistState = () => {
        if (!failed && sub.activeSubagents.has('spawn-scout')) { failed = true; throw new Error('state store unavailable'); }
        persist();
      };
      const res = await h.subagent.handleToolCall(spawn('scout', { sync: true }));
      expect(failed).toBe(true);
      expect(res.success).toBe(false);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0 });
    } finally { await h.cleanup(); }
  });

  test('a run whose agent can\'t be created is marked failed and holds no slot', async () => {
    const h = await harness({ maxRetries: 0 });
    try {
      const fw = h.framework as unknown as { createEphemeralAgent: (c: unknown) => Promise<unknown> };
      fw.createEphemeralAgent = async () => { throw new Error('agent store unavailable'); };
      const res = await h.subagent.handleToolCall(spawn('scout', { sync: true }));
      expect(res.success).toBe(false);
      expect(internal(h.subagent).activeSubagents.get('spawn-scout')).toMatchObject({ status: 'failed' });
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0 });
    } finally { await h.cleanup(); }
  });
});

describe('a cancel reaches the whole run', () => {
  test('a spawn waiting for a slot leaves the queue when it\'s cancelled, and never starts', async () => {
    const h = await harness({ maxConcurrent: 1, maxRetries: 0 }, (agent) => (agent.name.startsWith('spawn-long-')
      ? sleep(300).then(() => ({ speech: 'ok', toolCallsCount: 0 }))
      : sleep(5).then(() => ({ speech: 'ran', toolCallsCount: 0 }))));
    try {
      await h.subagent.handleToolCall(spawn('long'));
      await until(() => h.running('long'));
      await h.subagent.handleToolCall(spawn('waiting'));
      await until(() => h.subagent.getConcurrencyStatus().queued === 1);
      expect(h.subagent.cancelSubagent('waiting')).toBe(true);
      expect(await outcome(h, 'waiting')).toEqual({
        ok: true,
        text: '[Stopped by user] (no output: it was still waiting for a concurrency slot, and never started)',
      });
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 1, queued: 0 });
      await outcome(h, 'long');
      await sleep(50);
      expect(h.runs()).toBe(1); // only "long" ever ran
    } finally { await h.cleanup(); }
  }, 20_000);

  test('cancelling them all reaches a spawn still waiting for a slot', async () => {
    const h = await harness({ maxConcurrent: 1, maxRetries: 0 }, () => new Promise(() => { /* never settles */ }));
    try {
      await h.subagent.handleToolCall(spawn('long'));
      await until(() => h.running('long'));
      await h.subagent.handleToolCall(spawn('waiting'));
      await until(() => h.subagent.getConcurrencyStatus().queued === 1);
      expect(h.subagent.cancelAll()).toBe(2);
      const waiting = outcome(h, 'waiting');
      const long = outcome(h, 'long');
      expect((await waiting).text).toStartWith('[Stopped by user] (no output: it was still waiting');
      expect((await long).text).toStartWith('[Stopped by user]');
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0, queued: 0 });
    } finally { await h.cleanup(); }
  }, 20_000);

  for (const [what, failure] of [['the back-off before a retry', '503 overloaded'], ["a rate limit's cooldown", '429 Too Many Requests']] as const) {
    for (const call of [spawn, fork]) {
      test(`a cancel during ${what} ends the ${call.name}'s run there`, async () => {
        let attempts = 0;
        const h = await harness({ maxRetries: 1 }, async () => { attempts++; await sleep(20); throw new Error(failure); });
        internal(h.subagent).rateLimitCooldownMs = 5000;
        const waits = watchWaits(h.subagent);
        try {
          await h.subagent.handleToolCall(call('scout'));
          await until(() => waits.length === 1); // past the attempt, into the wait of 5 s
          expect(h.subagent.cancelSubagent('scout')).toBe(true);
          expect((await outcome(h, 'scout')).text).toStartWith('[Stopped by user]');
          expect(waits).toEqual([{ ms: 5000, endedBy: 'cancel' }]);
          expect(attempts).toBe(1);
          expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0 });
        } finally { await h.cleanup(); }
      }, 20_000);
    }
  }

  for (const [call, config] of [[spawn, {}], [fork, {}], [spawn, { maxPromptTokens: 10 }]] as const) {
    const over = 'maxPromptTokens' in config ? ' whose prompt is over the limit' : '';
    test(`a cancel during a ${call.name}'s setup${over} ends the run before the attempt starts`, async () => {
      let started = 0;
      const h = await harness({ maxRetries: 0, ...config }, async () => { started++; await sleep(5); return { speech: 'ran', toolCallsCount: 0 }; });
      const fw = h.framework as unknown as { createEphemeralAgent: (c: unknown) => Promise<unknown> };
      const create = fw.createEphemeralAgent.bind(fw);
      let creating = false;
      fw.createEphemeralAgent = async (c) => { creating = true; await sleep(200); return create(c); };
      try {
        await h.subagent.handleToolCall(call('scout'));
        await until(() => creating);
        const done = outcome(h, 'scout');
        expect(h.subagent.cancelSubagent('scout')).toBe(true);
        expect((await done).text).toStartWith('[Stopped by user]');
        await sleep(100);
        expect(started).toBe(0);
        expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0, queued: 0 });
      } finally { await h.cleanup(); }
    }, 20_000);
  }

  for (const call of [spawn, fork]) {
    test(`a cancel that lands just as a ${call.name}'s prompt compiles ends the run before the attempt starts`, async () => {
      let started = 0;
      const h = await harness({ maxRetries: 0 }, async () => { started++; await sleep(5); return { speech: 'ran', toolCallsCount: 0 }; });
      const fw = h.framework as unknown as { createEphemeralAgent: (c: unknown) => Promise<{ contextManager: { compile(): Promise<unknown> } }> };
      const create = fw.createEphemeralAgent.bind(fw);
      fw.createEphemeralAgent = async (c) => {
        const created = await create(c);
        const compile = created.contextManager.compile.bind(created.contextManager);
        created.contextManager.compile = () => {
          const compiled = compile();
          // Runs when compiling settles, just before the setup's race takes
          // up its result. The race still takes compile's result, which
          // reached it before the cancel did, so only the check after the
          // race can see this cancel.
          void compiled.then(() => h.subagent.cancelSubagent('scout'));
          return compiled;
        };
        return created;
      };
      try {
        await h.subagent.handleToolCall(call('scout'));
        expect((await outcome(h, 'scout')).text).toStartWith('[Stopped by user]');
        await sleep(100);
        expect(started).toBe(0);
        expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0, queued: 0 });
      } finally { await h.cleanup(); }
    }, 20_000);
  }

  test('a reclaim during the back-off ends the run, which starts no attempt without its slot', async () => {
    let attempts = 0;
    const h = await harness({ maxRetries: 1 }, async () => { attempts++; await sleep(20); throw new Error('503 overloaded'); });
    const waits = watchWaits(h.subagent);
    try {
      const sub = internal(h.subagent);
      await h.subagent.handleToolCall(spawn('scout'));
      await until(() => waits.length === 1); // in the back-off, still registered
      sub.activeSubagents.get('spawn-scout')!.lastActivityAt = Date.now() - 200_000;
      expect(sub.reclaimZombieSlots()).toBe(1);
      expect((await outcome(h, 'scout')).text).toContain('[Terminated: zombie]');
      expect(waits).toEqual([{ ms: 5000, endedBy: 'cancel' }]);
      expect(attempts).toBe(1);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0 });
    } finally { await h.cleanup(); }
  }, 20_000);

  test('cancelling a subagent reaches its child still waiting for a slot', async () => {
    const h = await harness({ maxConcurrent: 1, maxRetries: 0 }, () => new Promise(() => { /* never settles */ }));
    try {
      await h.subagent.handleToolCall(spawn('lead'));
      await until(() => h.running('lead'));
      const lead = internal(h.subagent).liveSubagents.get('lead')!.frameworkAgentName;
      await h.subagent.handleToolCall({ ...spawn('child'), callerAgentName: lead });
      await until(() => h.subagent.getConcurrencyStatus().queued === 1);
      const child = outcome(h, 'child');
      const leadDone = outcome(h, 'lead');
      expect(h.subagent.cancelSubagent('lead')).toBe(true);
      expect((await child).text).toStartWith('[Stopped by user] (no output: it was still waiting');
      expect((await leadDone).text).toStartWith('[Stopped by user]');
      await sleep(50);
      expect(h.runs()).toBe(1); // the child never started
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0, queued: 0 });
    } finally { await h.cleanup(); }
  }, 20_000);

  test('cancelling them all counts a parent and its child, each once', async () => {
    const h = await harness({ maxConcurrent: 2, maxRetries: 0 }, () => new Promise(() => { /* never settles */ }));
    try {
      await h.subagent.handleToolCall(spawn('lead'));
      await until(() => h.running('lead'));
      const lead = internal(h.subagent).liveSubagents.get('lead')!.frameworkAgentName;
      await h.subagent.handleToolCall({ ...spawn('child'), callerAgentName: lead });
      await until(() => h.running('child'));
      const child = outcome(h, 'child');
      const leadDone = outcome(h, 'lead');
      expect(h.subagent.cancelAll()).toBe(2);
      expect((await child).text).toStartWith('[Stopped by user]');
      expect((await leadDone).text).toStartWith('[Stopped by user]');
    } finally { await h.cleanup(); }
  }, 20_000);

  for (const call of [spawn, fork]) {
    test(`cancelling a ${call.name} that has retried reaches the children its earlier attempt spawned`, async () => {
      const isLead = (agentName: string) => agentName.startsWith(call === spawn ? 'spawn-lead-' : 'lead-d');
      let leadAttempts = 0;
      let h!: Harness;
      h = await harness({ maxConcurrent: 3, maxRetries: 1 }, async (agent) => {
        if (isLead(agent.name)) {
          if (++leadAttempts === 1) {
            await h.subagent.handleToolCall({ ...spawn('child'), callerAgentName: agent.name });
            throw new Error('503 overloaded');
          }
          return new Promise(() => { /* the retry runs until cancelled */ });
        }
        return new Promise(() => { /* the child runs until cancelled */ });
      });
      internal(h.subagent).waitOrStop = async () => null; // retry at once
      try {
        await h.subagent.handleToolCall(call('lead'));
        await until(() => leadAttempts === 2 && h.running('child'));
        let childText: string | undefined;
        void outcome(h, 'child').then((o) => { childText = o.text; });
        const lead = outcome(h, 'lead');
        expect(h.subagent.cancelSubagent('lead')).toBe(true);
        await until(() => childText !== undefined);
        expect(childText).toStartWith('[Stopped by user]');
        expect((await lead).text).toStartWith('[Stopped by user]');
      } finally { await h.cleanup(); }
    }, 20_000);
  }

  test('cancelling a subagent in its back-off reaches the children its earlier attempt spawned', async () => {
    // The earlier attempt is still live in its back-off (its catch waits
    // before its finally unregisters it), so a lookup through live attempts
    // reached this child too; the next test's window is the one only the
    // index of every attempt covers.
    let leadAttempts = 0;
    let h!: Harness;
    h = await harness({ maxConcurrent: 3, maxRetries: 1 }, async (agent) => {
      if (agent.name.startsWith('spawn-lead-')) {
        leadAttempts++;
        await h.subagent.handleToolCall({ ...spawn('child'), callerAgentName: agent.name });
        throw new Error('503 overloaded');
      }
      return new Promise(() => { /* the child runs until cancelled */ });
    });
    const waits = watchWaits(h.subagent);
    try {
      await h.subagent.handleToolCall(spawn('lead'));
      await until(() => waits.length === 1 && h.running('child')); // the lead is in its back-off
      let childText: string | undefined;
      void outcome(h, 'child').then((o) => { childText = o.text; });
      const lead = outcome(h, 'lead');
      expect(h.subagent.cancelSubagent('lead')).toBe(true);
      await until(() => childText !== undefined);
      expect(childText).toStartWith('[Stopped by user]');
      expect((await lead).text).toStartWith('[Stopped by user]');
      expect(waits).toEqual([{ ms: 5000, endedBy: 'cancel' }]);
      expect(leadAttempts).toBe(1);
    } finally { await h.cleanup(); }
  }, 20_000);

  test("cancelling a subagent while its retry sets up reaches the children its earlier attempt spawned", async () => {
    let leadAttempts = 0;
    let retrySettingUp = false;
    let h!: Harness;
    h = await harness({ maxConcurrent: 3, maxRetries: 1 }, async (agent) => {
      if (agent.name.startsWith('spawn-lead-')) {
        leadAttempts++;
        await h.subagent.handleToolCall({ ...spawn('child'), callerAgentName: agent.name });
        throw new Error('503 overloaded');
      }
      return new Promise(() => { /* the child runs until cancelled */ });
    });
    internal(h.subagent).waitOrStop = async () => null; // retry at once
    // The lead's second attempt never finishes creating its agent: between
    // its attempts, with neither attempt live.
    const fw = h.framework as unknown as { createEphemeralAgent: (c: { name: string }) => Promise<unknown> };
    const create = fw.createEphemeralAgent.bind(fw);
    let leadCreates = 0;
    fw.createEphemeralAgent = async (c) => {
      if (c.name.startsWith('spawn-lead-') && ++leadCreates === 2) {
        retrySettingUp = true;
        return new Promise(() => { /* never settles */ });
      }
      return create(c);
    };
    try {
      await h.subagent.handleToolCall(spawn('lead'));
      await until(() => retrySettingUp && h.running('child'));
      let childText: string | undefined;
      void outcome(h, 'child').then((o) => { childText = o.text; });
      const lead = outcome(h, 'lead');
      expect(h.subagent.cancelSubagent('lead')).toBe(true);
      await until(() => childText !== undefined);
      expect(childText).toStartWith('[Stopped by user]');
      expect((await lead).text).toStartWith('[Stopped by user]');
      expect(leadAttempts).toBe(1);
    } finally { await h.cleanup(); }
  }, 20_000);

  for (const call of [spawn, fork]) {
    test(`a child ${call.name} whose wait for a slot times out leaves no parent link`, async () => {
      const h = await harness({ maxConcurrent: 1, maxRetries: 0 }, () => new Promise(() => { /* never settles */ }));
      const sub = internal(h.subagent);
      const acquire = sub.acquireSlot.bind(h.subagent);
      sub.acquireSlot = (_slotTimeoutMs?: number, cancelled?: Promise<never>) => acquire(50, cancelled);
      try {
        await h.subagent.handleToolCall(spawn('lead'));
        await until(() => h.running('lead'));
        const lead = sub.liveSubagents.get('lead')!.frameworkAgentName;
        await h.subagent.handleToolCall({ ...call('child'), callerAgentName: lead });
        expect(sub.parentMap.get('child')).toBe(lead); // taken as it queued
        const child = await outcome(h, 'child');
        expect(child.text).toContain('Timed out waiting for a concurrency slot');
        expect(sub.parentMap.has('child')).toBe(false);
      } finally { await h.cleanup(); }
    }, 20_000);
  }

  test('a run leaves no cancel behind, so a second cancel finds nothing', async () => {
    const h = await harness({ maxRetries: 0 }, (agent) => (agent.name.startsWith('spawn-quick-')
      ? sleep(5).then(() => ({ speech: 'ok', toolCallsCount: 0 }))
      : new Promise(() => { /* never settles */ })));
    try {
      const sub = internal(h.subagent);
      await h.subagent.handleToolCall(spawn('quick'));
      await outcome(h, 'quick');
      expect(sub.cancellationHandles.has('quick')).toBe(false);
      expect(h.subagent.cancelSubagent('quick')).toBe(false);

      await h.subagent.handleToolCall(spawn('long'));
      await until(() => h.running('long'));
      const long = outcome(h, 'long');
      expect(h.subagent.cancelAll()).toBe(1);
      expect(h.subagent.cancelAll()).toBe(0);
      expect(h.subagent.cancelSubagent('long')).toBe(false);
      expect((await long).text).toStartWith('[Stopped by user]');
      expect(sub.cancellationHandles.size).toBe(0);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a spawn under a running subagent\'s name is refused, and a cancel still stops the running one', async () => {
    const h = await harness({ maxConcurrent: 1, maxRetries: 0 }, () => new Promise(() => { /* never settles */ }));
    try {
      await h.subagent.handleToolCall(spawn('scan'));
      await until(() => h.running('scan'));
      const scan = outcome(h, 'scan');
      expect((await h.subagent.handleToolCall(spawn('scan'))).error ?? '').toStartWith("Nothing was started: a subagent named 'scan' is already running");
      expect(h.subagent.getConcurrencyStatus().queued).toBe(0);
      expect(h.subagent.cancelSubagent('scan')).toBe(true);
      expect((await scan).text).toStartWith('[Stopped by user]');
    } finally { await h.cleanup(); }
  }, 20_000);
});

describe('a name means one subagent until its result has come back', () => {
  const refused = (name: string) => new RegExp(`^Nothing was started: a subagent named '${name}' `);
  const ran = (speech: string) => ({ speech, toolCallsCount: 0 });

  test('a spawn or fork under a running subagent\'s name is refused, and the name is free once its result has come back', async () => {
    const held = gate();
    const h = await harness({ maxRetries: 0 }, async () => { await held.wait; return ran('first'); });
    const delivered = deliveries(h);
    try {
      await h.subagent.handleToolCall(spawn('scout'));
      await until(() => h.running('scout'));
      const again = await h.subagent.handleToolCall(spawn('scout'));
      expect(again.success).toBe(false);
      expect(again.error).toMatch(/^Nothing was started: a subagent named 'scout' is already running \(for \d+ s\), and a name means one subagent until its result has come back\. Choose another name, or wait for that one's result\.$/);
      expect((await h.subagent.handleToolCall(fork('scout'))).error).toMatch(refused('scout'));
      expect((await h.subagent.handleToolCall(spawn('scout', { sync: true }))).error).toMatch(refused('scout'));
      expect((await h.subagent.handleToolCall(fork('scout', { sync: true }))).error).toMatch(refused('scout'));
      held.open();
      await until(() => delivered.requests.length === 1);
      expect(delivered.messages).toEqual(["[Subagent 'scout' returned]\n\nfirst"]);
      expect((await h.subagent.handleToolCall(spawn('scout'))).success).toBe(true);
    } finally { held.open(); await h.cleanup(); }
  }, 20_000);

  test('a fork from inside a subagent can\'t take another running subagent\'s name', async () => {
    const held = gate();
    const h = await harness({ maxRetries: 0 }, async () => { await held.wait; return ran('done'); });
    try {
      await h.subagent.handleToolCall(spawn('lead'));
      await h.subagent.handleToolCall(spawn('scout'));
      await until(() => h.running('lead') && h.running('scout'));
      const lead = internal(h.subagent).liveSubagents.get('lead')!.frameworkAgentName;
      const nested = await h.subagent.handleToolCall({ ...fork('scout'), callerAgentName: lead });
      expect(nested.error).toMatch(refused('scout'));
    } finally { held.open(); await h.cleanup(); }
  }, 20_000);

  test('a name waiting for a concurrency slot is refused', async () => {
    const h = await harness({ maxConcurrent: 1, maxRetries: 0 }, () => new Promise(() => { /* never settles */ }));
    try {
      await h.subagent.handleToolCall(spawn('long'));
      await until(() => h.running('long'));
      await h.subagent.handleToolCall(spawn('waiting'));
      await until(() => h.subagent.getConcurrencyStatus().queued === 1);
      const again = await h.subagent.handleToolCall(spawn('waiting'));
      expect(again.error).toStartWith("Nothing was started: a subagent named 'waiting' is already waiting for a concurrency slot, and");
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 1, queued: 1 });
      h.subagent.cancelAll();
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a sync spawn still blocking its caller holds its name until it returns', async () => {
    const held = gate();
    const h = await harness({ maxRetries: 0 }, async () => { await held.wait; return ran('done'); });
    try {
      const first = h.subagent.handleToolCall(spawn('scout', { sync: true }));
      await until(() => h.running('scout'));
      expect((await h.subagent.handleToolCall(spawn('scout'))).error).toMatch(refused('scout'));
      held.open();
      expect((await first).success).toBe(true);
      expect((await h.subagent.handleToolCall(spawn('scout', { sync: true }))).success).toBe(true);
    } finally { held.open(); await h.cleanup(); }
  }, 20_000);

  test('a sync spawn moved to the background holds its name until its result has come back', async () => {
    const held = gate();
    const h = await harness({ maxRetries: 0 }, async () => { await held.wait; return ran('done'); });
    const delivered = deliveries(h);
    try {
      const res = await h.subagent.handleToolCall(spawn('scout', { sync: true, timeoutMs: 100 }));
      expect(String(res.data)).toContain('moved to background');
      expect((await h.subagent.handleToolCall(spawn('scout'))).error).toMatch(refused('scout'));
      held.open();
      await until(() => delivered.requests.length === 1);
      expect((await h.subagent.handleToolCall(spawn('scout'))).success).toBe(true);
    } finally { held.open(); await h.cleanup(); }
  }, 20_000);

  test('a cancelled subagent is finishing, and keeps its name until its result has come back, so a new run\'s result isn\'t taken for it', async () => {
    let calls = 0;
    const h = await harness({ maxRetries: 0 }, () => (++calls === 1
      ? new Promise(() => { /* never settles: the cancel ends it */ })
      : sleep(20).then(() => ran('second'))));
    const delivered = deliveries(h);
    try {
      await h.subagent.handleToolCall(spawn('scout'));
      await until(() => h.running('scout'));
      expect(h.subagent.cancelSubagent('scout')).toBe(true);
      expect((await h.subagent.handleToolCall(spawn('scout'))).error).toBe(
        "Nothing was started: a subagent named 'scout' is still finishing, and a name means one subagent until its result has come back. Choose another name, or wait for that one's result.",
      );
      await until(() => delivered.requests.length === 1);
      expect(delivered.messages.at(-1)).toStartWith("[Subagent 'scout' returned]\n\n[Stopped by user]");
      expect((await h.subagent.handleToolCall(spawn('scout'))).success).toBe(true);
      expect(await outcome(h, 'scout')).toEqual({ ok: true, text: 'second' });
      await until(() => delivered.requests.length === 2);
      expect(delivered.messages.at(-1)).toBe("[Subagent 'scout' returned]\n\nsecond");
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a result stashed with return by a run that was then cancelled isn\'t taken by the next run under its name', async () => {
    let calls = 0;
    const h = await harness({ maxRetries: 0 }, () => (++calls === 1
      ? new Promise(() => { /* never settles: the cancel ends it */ })
      : sleep(20).then(() => ran('second'))));
    const delivered = deliveries(h);
    try {
      await h.subagent.handleToolCall(spawn('scout'));
      await until(() => h.running('scout'));
      // The run returns a result, then is cancelled before its attempt settles.
      internal(h.subagent).callIdIndex.set('ret-1', 'scout');
      await h.subagent.handleToolCall({ id: 'ret-1', name: 'return', input: { result: 'stale' } });
      expect(h.subagent.cancelSubagent('scout')).toBe(true);
      await until(() => delivered.requests.length === 1);
      expect((await h.subagent.handleToolCall(spawn('scout'))).success).toBe(true);
      expect(await outcome(h, 'scout')).toEqual({ ok: true, text: 'second' });
    } finally { await h.cleanup(); }
  }, 20_000);

  for (const call of [spawn, fork]) {
    test(`a ${call.name}'s retry doesn't report a result an earlier attempt returned before it failed`, async () => {
      let attempts = 0;
      let h!: Harness;
      h = await harness({ maxRetries: 1 }, async () => {
        if (++attempts === 1) {
          internal(h.subagent).callIdIndex.set('ret-1', 'scout');
          await h.subagent.handleToolCall({ id: 'ret-1', name: 'return', input: { result: 'stale' } });
          throw new Error('503 overloaded');
        }
        return ran('fresh');
      });
      internal(h.subagent).waitOrStop = async () => null; // retry at once
      try {
        await h.subagent.handleToolCall(call('scout'));
        expect(await outcome(h, 'scout')).toEqual({ ok: true, text: 'fresh' });
        expect(attempts).toBe(2);
      } finally { await h.cleanup(); }
    }, 20_000);
  }

  test('a new run under a name starts with none of the last run\'s leftovers', async () => {
    const h = await harness({ maxRetries: 0 }, async () => ran('done'));
    try {
      const sub = internal(h.subagent);
      expect((await h.subagent.handleToolCall(spawn('scout'))).success).toBe(true);
      await until(() => !sub.asyncHandles.has('scout')); // its result has come back
      sub.lastInputTokens.set('scout', 1234);
      expect(sub.parentMap.get('scout')).toBe('parent');
      const { callerAgentName: _caller, ...noCaller } = spawn('scout');
      expect((await h.subagent.handleToolCall(noCaller as ToolCall)).success).toBe(true);
      expect(sub.parentMap.has('scout')).toBe(false);
      expect(sub.lastInputTokens.has('scout')).toBe(false);
    } finally { await h.cleanup(); }
  }, 20_000);

  for (const call of [spawn, fork]) {
    test(`a cancel of a new ${call.name} under a name doesn't reach a child the name's last run left running`, async () => {
      const isLead = (agentName: string) => agentName.startsWith(call === spawn ? 'spawn-lead-' : 'lead-d');
      let leadRuns = 0;
      let h!: Harness;
      h = await harness({ maxConcurrent: 3, maxRetries: 0 }, async (agent) => {
        if (isLead(agent.name)) {
          if (++leadRuns === 1) {
            await h.subagent.handleToolCall({ ...spawn('child'), callerAgentName: agent.name });
            return ran('done');
          }
          return new Promise(() => { /* the second run under the name runs until cancelled */ });
        }
        return new Promise(() => { /* the child runs until cancelled */ });
      });
      const sub = internal(h.subagent);
      try {
        await h.subagent.handleToolCall(call('lead'));
        await until(() => h.running('child') && !sub.asyncHandles.has('lead')); // the first run's result has come back
        expect((await h.subagent.handleToolCall(call('lead'))).success).toBe(true);
        await until(() => leadRuns === 2);
        const lead = outcome(h, 'lead');
        expect(h.subagent.cancelSubagent('lead')).toBe(true);
        expect((await lead).text).toStartWith('[Stopped by user]');
        // The child is the last run's, so this run's cancel left it, and its
        // own cancel still finds it.
        expect(h.subagent.cancelSubagent('child')).toBe(true);
      } finally { await h.cleanup(); }
    }, 20_000);
  }

  for (const stuck of ['creating its agent', 'compiling its prompt'] as const) {
    test(`a cancel ends a run whose setup never finishes ${stuck}, and frees its name`, async () => {
      const h = await harness({ maxRetries: 0 }, async () => ran('ran'));
      const fw = h.framework as unknown as { createEphemeralAgent: (c: unknown) => Promise<{ contextManager: { compile(): Promise<unknown> } }> };
      const create = fw.createEphemeralAgent.bind(fw);
      let reached = false;
      fw.createEphemeralAgent = async (c) => {
        if (stuck === 'creating its agent') { reached = true; return new Promise(() => { /* never settles */ }); }
        const created = await create(c);
        created.contextManager.compile = () => { reached = true; return new Promise(() => { /* never settles */ }); };
        return created;
      };
      const delivered = deliveries(h);
      try {
        await h.subagent.handleToolCall(spawn('scout'));
        await until(() => reached);
        expect(h.subagent.cancelSubagent('scout')).toBe(true);
        await until(() => delivered.requests.length === 1);
        expect(delivered.messages.at(-1)).toStartWith("[Subagent 'scout' returned]\n\n[Stopped by user]");
        expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0, queued: 0 });
        expect(internal(h.subagent).asyncHandles.has('scout')).toBe(false);
      } finally { await h.cleanup(); }
    }, 20_000);
  }

  for (const kind of ['spawn', 'fork'] as const) {
    test(`an agent a ${kind}'s creation gives after its run was cancelled is given back`, async () => {
      const h = await harness({ maxRetries: 0 }, async () => ran('ran'));
      const fw = h.framework as unknown as { createEphemeralAgent: (c: unknown) => Promise<{ cleanup: () => void }> };
      const create = fw.createEphemeralAgent.bind(fw);
      let finish!: () => void;
      let cleanups = 0;
      fw.createEphemeralAgent = (c) => new Promise((resolve, reject) => {
        // Creation finishes only when the test says, after the cancel.
        finish = () => create(c).then((created) => resolve({ ...created, cleanup: () => { cleanups++; created.cleanup(); } }), reject);
      });
      const delivered = deliveries(h);
      try {
        await h.subagent.handleToolCall(kind === 'spawn' ? spawn('scout') : fork('scout'));
        await until(() => finish !== undefined);
        expect(h.subagent.cancelSubagent('scout')).toBe(true);
        await until(() => delivered.requests.length === 1);
        expect(delivered.messages.at(-1)).toStartWith("[Subagent 'scout' returned]\n\n[Stopped by user]");
        expect(cleanups).toBe(0);
        finish();
        await until(() => cleanups === 1);
        expect(cleanups).toBe(1);
      } finally { await h.cleanup(); }
    }, 20_000);
  }

  test('a creation that fails after its run was cancelled leaves nothing to give back, and raises nothing', async () => {
    const h = await harness({ maxRetries: 0 }, async () => ran('ran'));
    const fw = h.framework as unknown as { createEphemeralAgent: (c: unknown) => Promise<unknown> };
    let fail!: () => void;
    fw.createEphemeralAgent = () => new Promise((_resolve, reject) => {
      // Creation fails only when the test says, after the cancel.
      fail = () => reject(new Error('creation failed late'));
    });
    const delivered = deliveries(h);
    const unhandled = watchUnhandled();
    try {
      await h.subagent.handleToolCall(spawn('scout'));
      await until(() => fail !== undefined);
      expect(h.subagent.cancelSubagent('scout')).toBe(true);
      await until(() => delivered.requests.length === 1);
      expect(delivered.messages.at(-1)).toStartWith("[Subagent 'scout' returned]\n\n[Stopped by user]");
      fail();
      await sleep(20); // an unhandled rejection is reported once the turn it happens in has ended
      expect(unhandled.reasons).toEqual([]);
      expect(delivered.requests.length).toBe(1);
    } finally { unhandled.stop(); await h.cleanup(); }
  }, 20_000);

  test('a cleanup that throws as an agent is given back is logged, naming the run, and raises nothing', async () => {
    const h = await harness({ maxRetries: 0 }, async () => ran('ran'));
    const fw = h.framework as unknown as { createEphemeralAgent: (c: unknown) => Promise<{ cleanup: () => void }> };
    const create = fw.createEphemeralAgent.bind(fw);
    let finish!: () => void;
    let cleanups = 0;
    fw.createEphemeralAgent = (c) => new Promise((resolve, reject) => {
      finish = () => create(c).then((created) => resolve({ ...created, cleanup: () => { cleanups++; throw new Error('the store refused'); } }), reject);
    });
    const delivered = deliveries(h);
    const unhandled = watchUnhandled();
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    try {
      await h.subagent.handleToolCall(spawn('scout'));
      await until(() => finish !== undefined);
      expect(h.subagent.cancelSubagent('scout')).toBe(true);
      await until(() => delivered.requests.length === 1);
      finish();
      await until(() => cleanups === 1);
      await sleep(20); // an unhandled rejection is reported once the turn it happens in has ended
      expect(lines.filter((l) => l.includes('giving back'))).toEqual(['[subagent] scout: giving back an agent created after its run was stopped failed: the store refused']);
      expect(unhandled.reasons).toEqual([]);
    } finally { spy.mockRestore(); unhandled.stop(); await h.cleanup(); }
  }, 20_000);

  test('a reclaim ends a run whose setup never finishes compiling its prompt, and frees its name', async () => {
    const h = await harness({ maxRetries: 0 }, async () => ran('ran'));
    const fw = h.framework as unknown as { createEphemeralAgent: (c: unknown) => Promise<{ contextManager: { compile(): Promise<unknown> } }> };
    const create = fw.createEphemeralAgent.bind(fw);
    let reached = false;
    // The reaper reads the runs registered for peek, which a run is once
    // it has its agent, so this one sticks compiling.
    fw.createEphemeralAgent = async (c) => {
      const created = await create(c);
      created.contextManager.compile = () => { reached = true; return new Promise(() => { /* never settles */ }); };
      return created;
    };
    const delivered = deliveries(h);
    try {
      const sub = internal(h.subagent);
      await h.subagent.handleToolCall(spawn('scout'));
      await until(() => reached);
      sub.activeSubagents.get('spawn-scout')!.lastActivityAt = Date.now() - 200_000;
      expect(sub.reclaimZombieSlots()).toBe(1);
      await until(() => delivered.requests.length === 1);
      expect(delivered.messages.at(-1)).toContain('[Terminated: zombie]');
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0, queued: 0 });
      expect(sub.asyncHandles.has('scout')).toBe(false);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a cancel ends a fork whose setup never finishes reading its parent\'s context, and frees its name', async () => {
    const h = await harness({ maxRetries: 0 }, async () => ran('ran'));
    const parent = h.framework.getAgent('parent') as unknown as { getContextManager(): { compile(): Promise<unknown> } };
    const cm = parent.getContextManager();
    const compile = cm.compile.bind(cm);
    let reached = false;
    // Only the fork's read of the parent's context never settles; the
    // parent's own turn after the result compiles as usual.
    cm.compile = () => {
      if (reached) return compile();
      reached = true;
      return new Promise(() => { /* never settles */ });
    };
    const delivered = deliveries(h);
    try {
      await h.subagent.handleToolCall(fork('scout'));
      await until(() => reached);
      expect(h.subagent.cancelSubagent('scout')).toBe(true);
      await until(() => delivered.requests.length === 1);
      expect(delivered.messages.at(-1)).toStartWith("[Subagent 'scout' returned]\n\n[Stopped by user]");
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0, queued: 0 });
      expect(internal(h.subagent).asyncHandles.has('scout')).toBe(false);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('a throw while delivering a result is logged, not delivered as the run\'s failure', async () => {
    const h = await harness({ maxRetries: 0 }, async () => ran('done'));
    const ctx = (h.subagent as unknown as { ctx: { addMessage(...args: unknown[]): unknown } }).ctx;
    const add = ctx.addMessage.bind(ctx);
    const added: string[] = [];
    let first = true;
    ctx.addMessage = (participant, content) => {
      const text = (content as Array<{ text?: string }>)[0]?.text ?? '';
      if (first) { first = false; throw new Error('store unavailable'); }
      added.push(text);
      return add(participant, content);
    };
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    try {
      await h.subagent.handleToolCall(spawn('scout'));
      await until(() => lines.some((l) => l.includes("delivering scout's result")));
      await sleep(20);
      expect(lines.filter((l) => l.startsWith('[subagent] delivering'))).toEqual(["[subagent] delivering scout's result: store unavailable"]);
      expect(added.filter((t) => t.startsWith("[Subagent 'scout' failed]"))).toEqual([]);
    } finally { spy.mockRestore(); await h.cleanup(); }
  }, 20_000);

  test('a failed run frees its name once its failure has come back, async or sync', async () => {
    const h = await harness({ maxRetries: 0 }, async () => { await sleep(5); throw new Error('the model refused'); });
    const delivered = deliveries(h);
    try {
      await h.subagent.handleToolCall(spawn('scout'));
      await until(() => delivered.requests.length === 1);
      expect(delivered.messages.at(-1)).toStartWith("[Subagent 'scout' failed]");
      const sync = await h.subagent.handleToolCall(spawn('scout', { sync: true }));
      expect(sync.success).toBe(false);
      expect(sync.error ?? '').not.toMatch(refused('scout'));
      expect((await h.subagent.handleToolCall(spawn('scout'))).success).toBe(true);
    } finally { await h.cleanup(); }
  }, 20_000);
});
