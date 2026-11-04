import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ipcConnect, send, sleep, spawnHost, stopHost } from '../common.mjs';
import { lineReader, listenForPeers } from './control.mjs';
import { openWebUi } from './webui.mjs';
import { cutError, cutText, cutThrow } from './cut.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'mcpl-server.mjs');
const PRELOAD = join(HERE, 'virtual-date.mjs');
const MODULE = join(HERE, 'module.mjs');
const BOOT_MS = 120_000;
const TURN_MS = 120_000;
const COMMAND_MS = 60_000;
const MAINTAIN_MS = 120_000;
const SHUTDOWN_MS = 30_000;
const RESTART_MS = 1_000;

const FENCE = 'settle-fence:';

const COMMANDS = {
  session: (lines) => {
    if (lines.some((l) => /^Session renamed to /.test(l))) return 'done';
    if (lines.some((l) => /^(Usage: \/session rename|No active session)/.test(l))) return 'failed';
    return null;
  },
  budget: (lines) => {
    if (lines.some((l) => /^Stream budget set to /.test(l))) return 'done';
    if (lines.some((l) => /^(Invalid token count|No agents)/.test(l))) return 'failed';
    return null;
  },
  newtopic: (lines) => {
    if (lines.some((l) => /^(Topic reset failed:|\/newtopic refused:|No context manager)/.test(l))) return 'failed';
    const at = lines.indexOf('Topic reset. Transition summary:');
    return at >= 0 && lines.length > at + 1 ? 'done' : null;
  },
  undo: (lines) => {
    if (lines.some((l) => /^Undone\. Switched to branch "/.test(l))) return 'done';
    if (lines.some((l) => /^(Nothing to undo|Undo failed|No agent context manager|\/undo refused:)/.test(l))) return 'failed';
    return null;
  },
  redo: (lines) => {
    if (lines.some((l) => /^Redone\. Switched to branch "/.test(l))) return 'done';
    if (lines.some((l) => /^(Nothing to redo|Redo failed|No agent context manager|\/redo refused:)/.test(l))) return 'failed';
    return null;
  },
  checkout: (lines) => {
    if (lines.some((l) => /^Switched to branch /.test(l))) return 'done';
    if (lines.some((l) => /^(Usage: \/checkout|Branch ".*" not found|Checkout failed|No agent context manager|\/checkout refused:)/.test(l))) return 'failed';
    return null;
  },
  branches: (lines) => {
    if (lines.some((l) => /^No agent context manager/.test(l))) return 'failed';
    const at = lines.findIndex((l) => /^--- Branches \(\d+\) ---$/.test(l));
    if (at < 0) return null;
    return lines.length > at + Number(/\((\d+)\)/.exec(lines[at])[1]) ? 'done' : null;
  },
};

const WEBUI_LISTENING = /\[webui\] listening on (https?:\/\/\S+)/;

export function hostFacts({ hostDir, configuration }) {
  const recipe = laneRecipe({ configuration, control: '', channels: [], boot: 0 });
  const model = recipe.agent.model;
  const src = (f) => JSON.stringify(join(hostDir, 'src', f));
  const code = [
    `const { getDefaultModelLimits } = await import(${src('model-limits.ts')});`,
    `const { buildFrameworkAgentConfig } = await import(${src('framework-agent-config.ts')});`,
    `const agentConfig = buildFrameworkAgentConfig(${JSON.stringify(recipe)}, ${JSON.stringify(recipe.agent.name)}, ${JSON.stringify(model)}, undefined);`,
    'console.log(JSON.stringify({',
    `  window: getDefaultModelLimits(${JSON.stringify(model)})?.maxContextTokens ?? null,`,
    '  streamBound: agentConfig.maxStreamTokens ?? null,',
    '  budget: agentConfig.contextBudgetTokens ?? null,',
    '  maxTokens: agentConfig.maxTokens ?? null,',
    '}));',
  ].join('\n');
  const r = spawnSync('bun', ['-e', code], { cwd: hostDir, encoding: 'utf-8', timeout: 60_000, env: { ...process.env, NO_COLOR: '1' } });
  const line = (r.stdout || '').trim().split('\n').at(-1);
  try {
    return JSON.parse(line);
  } catch {
    throw cutThrow((cut) => `couldn't read the installed host's recipe facts (bun exited ${r.status}): ${cut((r.stderr || r.stdout || '').trim(), -2000)}`);
  }
}

export async function lastTake({ boot, take, log, fail, step = null }) {
  await take().catch((e) => {
    log('compiles', { boot, lost: String(e?.message ?? e) });
    const { shown, full } = cutError(e, 500);
    const said = `boot ${boot}'s last take of the module's compiles failed: `;
    fail({ step, reason: `${said}${shown}`, ...(full ? { full: `${said}${full}` } : {}) });
  });
}

export function shutdownFailure({ boot, timedOut, exited, seconds }) {
  if (timedOut) return `boot ${boot}: the host didn't exit within ${seconds} s of its shutdown`;
  if (exited && (exited.code !== 0 || exited.signal)) return `boot ${boot}: the host exited (${exited.code ?? exited.signal}) on its shutdown`;
  return null;
}

const exitWithin = (child, ms) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
  const timer = setTimeout(() => resolve(false), ms);
  child.once('exit', () => { clearTimeout(timer); resolve(true); });
});

// The host shapes requests alike for no binding-probe outcome and for an account that refuses or drops a changed
// block (logging-adapter.ts tells only `shows` apart), so a binding configuration boots with the probe off.
export function hostEnv({ configuration, standinUrl, control, clock }) {
  return {
    ANTHROPIC_BASE_URL: standinUrl, ANTHROPIC_API_KEY: 'sk-ant-fixture', TZ: 'UTC', AGENT_TIMEZONE: undefined, FIXTURE_CONTROL: control, FIXTURE_EPOCH_MS: String(clock),
    ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_OAUTH_CREDENTIALS_FILE: undefined, ANTHROPIC_OAUTH_AUTO_REFRESH: undefined,
    MODEL: undefined, COUNT_TOKENS_MODEL: undefined,
    ...(configuration.binds ? { THINKING_BINDING_PROBE: 'off' } : {}),
    FIXTURE_RECORD: configuration.recording === false ? 'off' : undefined,
  };
}

const BASE_AGENT = { name: 'fixture', provider: 'anthropic', systemPrompt: 'You are the strategy fixture\'s agent.' };

export function laneRecipe({ configuration, control, channels, boot }) {
  const agent = { ...BASE_AGENT, ...configuration.agent };
  return {
    name: `Strategy fixture (${configuration.name})`,
    agent,
    ...(configuration.maintenanceIntervalMs !== undefined ? { maintenanceIntervalMs: configuration.maintenanceIntervalMs } : {}),
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [SERVER],
        env: { FIXTURE_CONTROL: control, FIXTURE_CHANNELS: channels.join(','), FIXTURE_BOOT: String(boot) },
        enabledFeatureSets: ['fixture'],
        allowHostCommands: true,
        ...configuration.fixtureServer,
      },
    },
    modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false, ...configuration.modules },
    extensions: { 'whole-host-harness': { kind: 'module', path: MODULE } },
    ...(configuration.subconscious ? { subconscious: configuration.subconscious } : {}),
  };
}

// connectome-host's `/budget` writes a header, then a line per agent, `  <name>: …`.
export function budgetReportDone(lines, agent) {
  return lines.some((l) => l.startsWith(`  ${agent}: `) || !(l === BUDGET_HEADER || /^ {2}\S/.test(l)));
}
const BUDGET_HEADER = '--- Stream Token Budgets ---';

export function readSettle(answer, previous, ticks = {}) {
  const agents = answer?.maintenance?.agents ?? [];
  const host = answer?.hostMode ?? {};
  const progress = JSON.stringify({
    agents: agents.map((a) => {
      const p = a.progress ?? {};
      return [a.agentName, p.chunksCompressed, p.summaryCounts, p.l1QueueLength, p.mergeQueueLength, a.pending];
    }),
    deferredWrites: host.deferredWrites,
  });
  // A maintain pass returns at once while a compression the host's auto-tick started is in flight, and no event marks
  // that work's end, so the test module's tick counts hold the settle too.
  const ticking = Object.entries(ticks).filter(([, n]) => n !== 0).map(([name, n]) => `${name} ${n}`);
  return {
    ticking,
    settled: answer?.ok === true && agents.every((a) => a.ready === true) && host.drained === true && host.deferredWrites === 0 && !ticking.length,
    inFlight: agents.some((a) => a.progress?.pending === true) || (host.activeTurnAgents ?? []).length > 0 || (host.parkedAdmissions ?? 0) > 0 || ticking.length > 0,
    moved: progress !== previous,
    progress,
  };
}

class RunFailure extends Error {}

export async function runScript({ steps, configuration, standin, hostDir, facts, work, storeDir, epoch, logPath, hostLogs }) {
  mkdirSync(work, { recursive: true });
  mkdirSync(hostLogs.dir, { recursive: true });
  const hostLogOf = (b) => `${hostLogs.at}/host-${b.n}.log`;
  const ending = (b, out) => `its whole output is ${hostLogOf(b)} in the evidence, and its last lines are:\n${tail(out)}`;
  mkdirSync(storeDir, { recursive: true });
  const t0 = performance.now();
  const wall = () => Math.round((performance.now() - t0) * 10) / 10;
  let seq = 0;
  let clock = epoch;
  let current = null;
  const log = (kind, fields = {}) => appendFileSync(logPath, `${JSON.stringify({ seq: seq++, wall: wall(), clock, step: current?.id ?? null, kind, ...fields })}\n`);
  const channels = [...new Set(steps.filter((s) => s.kind === 'channel').map((s) => s.channel))];
  const runName = `fx-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const agentName = { ...BASE_AGENT, ...configuration.agent }.name;
  let recipeOf = configuration;
  const control = join(tmpdir(), `${runName}.ctl`);
  const ctl = await listenForPeers(control);
  const watchers = new Set();
  const poke = () => { for (const w of [...watchers]) w(); };
  let failure = null;
  const fail = (f) => { if (!failure) { failure = f; log('failure', f); } poke(); };
  const until = (check, timeoutMs, label, { pollMs = 0 } = {}) => new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); clearInterval(poll); watchers.delete(attempt); };
    const attempt = () => {
      if (failure) { stop(); reject(new RunFailure(failure.reason)); return; }
      const v = check();
      if (v) { stop(); resolve(v); }
    };
    const timer = setTimeout(() => { stop(); fail({ step: current?.id ?? null, reason: `${label}: nothing after ${timeoutMs} ms` }); reject(new RunFailure(label)); }, timeoutMs);
    const poll = pollMs ? setInterval(attempt, pollMs) : undefined;
    watchers.add(attempt);
    attempt();
  });
  const unlessFailed = (p) => new Promise((resolve, reject) => {
    const check = () => { if (failure) { watchers.delete(check); reject(new RunFailure(failure.reason)); } };
    watchers.add(check);
    check();
    p.then((v) => { watchers.delete(check); resolve(v); }, (e) => { watchers.delete(check); reject(e); });
  });

  const notices = [];
  ctl.onNotice((n) => { notices.push(n); log('notice', n); poke(); });
  standin.onHeld(async (request) => {
    try {
      await compressionIdle(request);
    } catch (e) {
      const c = e instanceof RunFailure ? { shown: e.message } : cutText((cut) => cut(String(e?.stack || e), 2000));
      if (!failure) fail({ step: current?.id ?? null, reason: `while ${request.id} was held: ${c.shown}`, ...(c.full ? { full: `while ${request.id} was held: ${c.full}` } : {}) });
    } finally {
      standin.releaseHeld();
    }
  });

  let ended = false;
  standin.setClock(clock);
  standin.onRequest((r) => {
    if (ended) return;
    log('request', { request: r });
    if (r.kind === 'unclassified') fail({ step: current?.id ?? null, reason: `the stand-in got a request it couldn't classify (${r.reason ?? r.id})` });
  });

  let host = null;
  let boots = 0;
  const timing = { boots: [], steps: [] };
  const copies = [];

  async function boot() {
    if (boots > 0) {
      const to = clock + RESTART_MS;
      log('advance', { from: clock, to, restart: true });
      clock = to;
      standin.setClock(clock);
    }
    const b = { n: ++boots, events: [], stopping: false };
    const started = performance.now();
    const recipe = laneRecipe({ configuration: recipeOf, control, channels, boot: b.n });
    const recipePath = join(work, `recipe-${b.n}.json`);
    writeFileSync(recipePath, JSON.stringify(recipe, null, 2));
    const sockPath = join(tmpdir(), `${runName}-${b.n}.sock`);
    rmSync(sockPath, { force: true });
    const since = { server: ctl.generation('server'), clock: ctl.generation('clock'), module: ctl.generation('module') };
    log('boot', { boot: b.n, recipePath, storeDir });
    const env = hostEnv({ configuration, standinUrl: standin.url, control, clock });
    const { child, out } = spawnHost({ hostDir, recipePath, dataDir: storeDir, cwd: work, sockPath, env, preload: PRELOAD });
    Object.assign(b, { child, out, sockPath });
    host = b;
    child.once('exit', (code, signal) => {
      b.exited = { code, signal };
      log('exit', { boot: b.n, code, signal, expected: b.stopping });
      if (!b.stopping) fail({ step: current?.id ?? null, reason: `the host exited (${code ?? signal}); ${ending(b, out)}` });
      poke();
    });
    await until(() => existsSync(sockPath), BOOT_MS, `boot ${b.n}: the host's IPC socket`, { pollMs: 50 });
    for (let attempt = 0; !b.sock; attempt++) {
      try { b.sock = await ipcConnect(sockPath); } catch (e) {
        if (attempt >= 40 || failure) throw new RunFailure(`boot ${b.n}: couldn't connect to IPC: ${e.message}`);
        await sleep(50);
      }
    }
    lineReader(b.sock, (e) => {
      const at = wall();
      b.events.push({ at, e });
      if (!(e.type === 'snapshot' && String(e.corrId).startsWith(FENCE))) log('ipc', { at, event: e });
      poke();
    });
    await until(() => b.events.some(({ e }) => e.type === 'lifecycle' && e.phase === 'ready'), BOOT_MS, `boot ${b.n}: lifecycle ready`);
    await unlessFailed(ctl.waitConnected('server', { since: since.server, timeoutMs: BOOT_MS }));
    await unlessFailed(ctl.waitConnected('clock', { since: since.clock, timeoutMs: BOOT_MS }));
    await unlessFailed(ctl.waitConnected('module', { since: since.module, timeoutMs: BOOT_MS }));
    b.module = true;
    timing.boots.push(Math.round(performance.now() - started));
    log('ready', { boot: b.n, ms: timing.boots.at(-1) });
    await takeCompiles('boot');
    await budgetReport(b);
  }

  async function budgetReport(b) {
    const started = performance.now();
    const from = b.events.length;
    send(b.sock, { type: 'command', command: '/budget' });
    const lines = () => b.events.slice(from).filter(({ e }) => e.type === 'command-output').map(({ e }) => String(e.text));
    await until(() => budgetReportDone(lines(), agentName), COMMAND_MS, `boot ${b.n}: /budget`);
    log('budget-report', { boot: b.n, lines: lines(), ms: Math.round(performance.now() - started) });
  }

  async function takeCompiles(at = null) {
    if (!host) return;
    const { lines, store, blobs, submissions } = await ctl.moduleRequest('take');
    if (lines.length || Object.keys(store).length || Object.keys(blobs).length || submissions?.length) log('compiles', { boot: host.n, ...(at ? { at } : {}), lines, store, blobs, ...(submissions?.length ? { submissions } : {}) });
  }

  async function shutdown() {
    const b = host;
    if (!b) return;
    if (b.module) await lastTake({ boot: b.n, take: takeCompiles, log, fail, step: current?.id ?? null });
    host = null;
    b.stopping = true;
    if (!b.exited) {
      if (b.sock) send(b.sock, { type: 'shutdown' });
      const timedOut = !(await exitWithin(b.child, SHUTDOWN_MS));
      if (timedOut) {
        stopHost(b.child);
        await exitWithin(b.child, SHUTDOWN_MS);
      }
      const why = shutdownFailure({ boot: b.n, timedOut, exited: b.exited, seconds: SHUTDOWN_MS / 1000 });
      if (why) fail({ step: current?.id ?? null, reason: `${why}; ${ending(b, b.out)}` });
    }
    try { b.sock?.destroy(); } catch {}
    b.webui?.close();
    stopHost(b.child);
    writeFileSync(join(hostLogs.dir, `host-${b.n}.log`), b.out.join(''));
    log('shutdown', { boot: b.n, hostLog: hostLogOf(b) });
  }

  const eventAfter = (from, test) => host.events.slice(from).find(({ e }) => test(e));

  let fences = 0;
  async function ipcFence() {
    const t = performance.now();
    const corrId = `${FENCE}${++fences}`;
    const from = host.events.length;
    send(host.sock, { type: 'describe', corrId });
    await until(() => eventAfter(from, (e) => e.type === 'snapshot' && e.corrId === corrId), COMMAND_MS, 'the IPC answer that ends a settle');
    return Math.round((performance.now() - t) * 10) / 10;
  }

  async function settle() {
    const started = performance.now();
    let progress = null;
    let pass = 0;
    for (;;) {
      pass++;
      const t = performance.now();
      const answer = await ctl.hostCommand({ command: 'maintain' }, { timeoutMs: MAINTAIN_MS });
      const read = readSettle(answer, progress, await ctl.moduleRequest('ticks'));
      const { ticking } = read;
      const first = progress === null;
      progress = read.progress;
      const agents = answer?.maintenance?.agents ?? [];
      const { drained, deferredWrites, activeTurnAgents = [] } = answer?.hostMode ?? {};
      log('settle', { phase: 'pass', pass, ms: Math.round(performance.now() - t), ok: answer?.ok, ran: answer?.maintenance?.ran, runId: answer?.maintenance?.history?.[0]?.id ?? null, agents, drained, deferredWrites, activeTurnAgents, inFlight: read.inFlight, moved: read.moved, ...(ticking.length ? { ticking } : {}) });
      if (read.settled) {
        const fence = await ipcFence();
        log('settle', { phase: 'end', settled: true, passes: pass, ms: Math.round(performance.now() - started), fenceMs: fence });
        await takeCompiles();
        return pass;
      }
      if (failure) throw new RunFailure(failure.reason);
      const whyOf = (cut) => (!answer?.ok ? `maintain answered ${cut(JSON.stringify(answer), 300)}`
        : !read.inFlight && !first && !read.moved ? 'nothing in flight, and the last pass moved nothing on'
          : performance.now() - started >= TURN_MS ? `still unsettled after ${TURN_MS} ms between passes, the bound a turn's speech has`
            : null);
      const why = whyOf((v, n) => String(v).slice(0, n));
      if (why) {
        const ms = Math.round(performance.now() - started);
        log('settle', { phase: 'end', settled: false, passes: pass, ms, why });
        const host = [
          drained === true ? 'the host drained' : drained === false ? `the host not drained (turns alive: ${activeTurnAgents.join(', ') || 'none named'})` : 'no drained state in the host\'s answer',
          typeof deferredWrites !== 'number' || deferredWrites === 0 ? null : `${deferredWrites} deferred write(s) still to land`,
        ].filter(Boolean).join(', ');
        const said = cutText((cut) => {
          const notReady = agents.filter((a) => a.ready !== true).map((a) => (a.agentName ? `${a.agentName} (${a.error ?? a.pending ?? 'no pending work named'})` : cut(JSON.stringify(a), 200)));
          return `the run didn't settle (${whyOf(cut)}; ${pass} maintenance passes in ${(ms / 1000).toFixed(1)} s): ${notReady.length ? `not ready: ${notReady.join(', ')}` : 'every agent ready'}, ${host}. A wait timed by the host's virtual clock can't end inside a settle, since the clock moves only at an advance step.`;
        });
        fail({ step: current?.id ?? null, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
        throw new RunFailure('unsettled');
      }
    }
  }

  // The turn whose request is held keeps the host from draining, so settle() would wait on it.
  async function compressionIdle(request) {
    const started = performance.now();
    for (let pass = 1; ; pass++) {
      const answer = await ctl.hostCommand({ command: 'maintain' }, { timeoutMs: MAINTAIN_MS });
      const agents = answer?.maintenance?.agents ?? [];
      const ticks = await ctl.moduleRequest('ticks');
      const idle = answer?.ok === true && agents.every((a) => a.ready === true && a.progress?.pending !== true) && !readSettle(answer, null, ticks).ticking.length;
      if (idle) {
        log('held', { request: request.id, agent: request.agent, passes: pass, ms: Math.round(performance.now() - started) });
        return;
      }
      if (performance.now() - started >= TURN_MS) throw new RunFailure(`compression didn't go idle within ${TURN_MS} ms (${pass} passes)`);
    }
  }

  const channelMessage = (step, { id, participant, text, images, tags }) => ({ channelId: step.channel, messageId: id, author: { id: `u-${String(participant).toLowerCase()}`, name: participant }, topic: step.topic, text, ...(images ? { images } : {}), ...(tags ? { tags } : {}), at: clock });
  const sendSummary = (message) => ({ ...message, text: `${message.text.length} chars`, ...(message.images ? { images: message.images.length } : {}) });

  async function channelTurn(step) {
    const from = host.events.length;
    const message = channelMessage(step, { id: step.id, participant: step.participant, text: step.text, images: step.images, tags: step.tags });
    log('send', { via: 'channel', message: sendSummary(message) });
    await ctl.deliver(message, { timeoutMs: TURN_MS });
    if (step.reader) {
      await until(() => eventAfter(from, (e) => e.agentName === step.reader && e.type === 'inference:started'), TURN_MS, `turn ${step.id}: ${step.reader}'s turn`);
      await settle();
      const failed = eventAfter(from, (e) => e.agentName === step.reader && /^inference:(exhausted|aborted)$/.test(e.type));
      if (failed && step.mayFail) {
        log('turn-failed', { agent: step.reader, event: failed.e.type, error: failed.e.error ?? null });
        return;
      }
      if (failed) {
        const said = cutText((cut) => `${step.reader}'s turn ended in ${failed.e.type}: ${cut(JSON.stringify(failed.e), 1500)}`);
        fail({ step: step.id, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
        throw new RunFailure(failed.e.type);
      }
      return;
    }
    if (step.arrival) {
      const { after } = step.arrival;
      await until(() => notices.some((n) => n.notice === 'held' && n.canary === after), TURN_MS, `turn ${step.id}: the call held for ${after}`);
      const arrival = channelMessage(step, { id: `${step.id}.arrival`, ...step.arrival });
      log('send', { via: 'channel', during: after, message: sendSummary(arrival) });
      await ctl.deliver(arrival, { timeoutMs: TURN_MS });
      await ctl.release(after, { timeoutMs: COMMAND_MS });
      log('send', { via: 'release', canary: after });
    }
    const ending = step.mayFail || step.retries ? /^inference:(exhausted|aborted)$/ : /^inference:(failed|exhausted|aborted)$/;
    const ended = await until(() => eventAfter(from, (e) => e.type === 'inference:speech' || ending.test(e.type)), TURN_MS, `turn ${step.id}: its speech`);
    if (ended.e.type !== 'inference:speech' && step.mayFail) {
      log('turn-failed', { event: ended.e.type, error: ended.e.error ?? null });
      await settle();
      return;
    }
    if (ended.e.type !== 'inference:speech') {
      // agent-framework reports inference:failed before it decides whether to retry, and the
      // event doesn't say which; the fixture stops at the first failure either way.
      const what = ended.e.type === 'inference:failed'
        ? 'the turn\'s first inference failure (inference:failed, which agent-framework may still have retried)'
        : `the turn's end in ${ended.e.type}`;
      const said = cutText((cut) => `${what}: ${cut(JSON.stringify(ended.e), 1500)}`);
      fail({ step: step.id, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
      throw new RunFailure(ended.e.type);
    }
    const speechAt = host.events.indexOf(ended);
    const published = await until(() => eventAfter(speechAt, (e) => e.type === 'inference:published_complete' || e.type === 'mcpl:speech-route-failed'), TURN_MS, `turn ${step.id}: its stream's end`);
    if (published.e.type === 'mcpl:speech-route-failed') log('undelivered', { reason: published.e.reason ?? null });
    await settle();
  }

  async function command(step) {
    const name = /^\/(\S+)/.exec(step.command)?.[1];
    const ends = COMMANDS[name];
    if (!ends) {
      fail({ step: step.id, reason: `the driver doesn't know when ${JSON.stringify(step.command)} ends` });
      throw new RunFailure('unknown command');
    }
    const from = host.events.length;
    log('send', { via: 'ipc', command: step.command });
    send(host.sock, { type: 'command', command: step.command });
    const lines = () => host.events.slice(from).filter(({ e }) => e.type === 'command-output').map(({ e }) => String(e.text));
    const outcome = await until(() => ends(lines()), COMMAND_MS, `command ${step.command}`);
    if (outcome !== (step.expect ?? 'done')) {
      const said = cutText((cut) => `${step.command} ${outcome}, where the step expects it ${step.expect ?? 'done'}: ${cut(lines().join(' | '), 1500)}`);
      fail({ step: step.id, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
      throw new RunFailure(`command ${outcome}`);
    }
    await settle();
  }

  async function advance(step) {
    await settle();
    const to = clock + step.ms;
    await ctl.advance(to);
    log('advance', { from: clock, to });
    clock = to;
    standin.setClock(clock);
  }

  async function health(id, what) {
    await settle();
    const corrId = `${id}:health`;
    const from = host.events.length;
    send(host.sock, { type: 'panel-request', op: 'health', corrId });
    return (await until(() => eventAfter(from, (e) => e.type === 'panel-response' && e.corrId === corrId), COMMAND_MS, `${what}: the health panel`)).e;
  }

  async function checkpoint(step, last) {
    log('checkpoint', { name: step.name, health: await health(step.id, `checkpoint ${step.id}`) });
    if (!step.copyStore) return;
    await shutdown();
    const dest = join(work, 'copies', step.name ?? step.id);
    rmSync(dest, { recursive: true, force: true });
    cpSync(storeDir, dest, { recursive: true });
    const sessions = existsSync(join(dest, 'sessions')) ? readdirSync(join(dest, 'sessions')).map((id) => join(dest, 'sessions', id)) : [];
    copies.push({ step: step.id, name: step.name, path: dest, sessions, clock });
    log('copy', { path: dest, sessions });
    if (!last) await boot();
  }

  async function restart(step) {
    await settle();
    const agent = agentName;
    const dry = async () => ({ boot: host.n, seq: (await ctl.moduleRequest('dry-compile', { agent })).seq });
    const before = step.reloadCheck ? await dry() : null;
    const patch = step.agent ? await resolveMessages(step.agent) : null;
    await shutdown();
    if (patch) {
      const { strategy, ...rest } = patch;
      recipeOf = { ...recipeOf, agent: { ...recipeOf.agent, ...rest, ...(strategy ? { strategy: { ...recipeOf.agent?.strategy, ...strategy } } : {}) } };
      log('recipe', { agent: patch });
    }
    await boot();
    if (!step.reloadCheck) return;
    await settle();
    const after = await dry();
    await takeCompiles();
    log('reload', { agent, before, after });
  }

  async function moduleRead(op, params) {
    return unlessFailed(ctl.moduleRequest(op, params, { timeoutMs: COMMAND_MS }));
  }

  async function stored(which) {
    const messages = await moduleRead('messages', { agent: agentName });
    const all = messages?.messages ?? messages ?? [];
    let found;
    if (which.canary !== undefined) found = all.find((m) => (m.canaries ?? []).includes(which.canary));
    else {
      const from = Math.min(all.length - 1, Math.floor(all.length * which.storeAt));
      const plain = (m) => !m.bodyGroupId && m.metadata?.system !== true;
      found = all.slice(from).find((m) => plain(m) && (!which.withBlock || m.blocks.some((b) => b.type === which.withBlock)));
    }
    if (!found) {
      fail({ step: current?.id ?? null, reason: `no stored message is ${JSON.stringify(which)}` });
      throw new RunFailure('no such message');
    }
    return found;
  }

  let panelRequests = 0;
  async function panelRequest(op, params) {
    const corrId = `${current?.id ?? 'run'}:panel:${++panelRequests}`;
    const from = host.events.length;
    send(host.sock, { type: 'panel-request', op, params, corrId });
    return (await until(() => eventAfter(from, (e) => e.type === 'panel-response' && e.corrId === corrId), COMMAND_MS, `panel ${op}`)).e;
  }

  async function pinId(name) {
    const answer = await panelRequest('pins', {});
    const pin = (answer.data?.pins ?? []).find((p) => p.name === name);
    if (!pin) {
      fail({ step: current?.id ?? null, reason: `the panel lists no pin named ${JSON.stringify(name)}` });
      throw new RunFailure('no such pin');
    }
    return pin.id;
  }

  async function resolveMessages(value) {
    if (Array.isArray(value)) return Promise.all(value.map(resolveMessages));
    if (!value || typeof value !== 'object') return value;
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'canary') return (await stored(value)).id;
    if (keys.length === 1 && keys[0] === 'sequenceOf') return (await stored({ canary: value.sequenceOf })).sequence;
    if (keys.includes('storeAt') && keys.every((k) => k === 'storeAt' || k === 'withBlock')) return (await stored(value)).id;
    if (keys.length === 1 && keys[0] === 'pin') return pinId(value.pin);
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await resolveMessages(v)])));
  }

  async function panel(step) {
    const params = await resolveMessages(step.params ?? {});
    log('send', { via: 'panel', op: step.op, params });
    let answer = await panelRequest(step.op, params);
    log('panel', { op: step.op, response: answer });
    for (let attempt = 0; step.edge && answer.ok !== true && attempt < 4; attempt++) {
      const floor = /folded floor renders (\d+) tokens/.exec(String(answer.error ?? ''));
      if (!floor) break;
      const lowest = Math.ceil((Number(floor[1]) + step.edge.reserve) * 1.01 / 1000) * 1000;
      log('send', { via: 'panel', op: step.op, params: { ...params, contextBudgetTokens: lowest }, edge: Number(floor[1]) });
      answer = await panelRequest(step.op, { ...params, contextBudgetTokens: lowest });
      log('panel', { op: step.op, response: answer });
    }
    const expected = (step.expect ?? 'ok') === 'ok';
    const ok = answer.ok === true && answer.data?.warning === undefined;
    if (ok !== expected) {
      fail({ step: step.id, reason: `the panel's ${step.op} answered ${ok ? 'ok' : `not ok (${answer.data?.warning ?? answer.error ?? answer.status ?? 'no reason given'})`}, where the step expects ${step.expect ?? 'ok'}` });
      throw new RunFailure('panel');
    }
    await settle();
  }

  async function webui() {
    if (host.webui) return host.webui;
    const line = host.out.join('').match(WEBUI_LISTENING);
    if (!line) throw new RunFailure(`the host logged no "[webui] listening on" line, so the web UI isn't on in this recipe`);
    host.webui = await unlessFailed(openWebUi({ url: line[1], basicAuth: configuration.modules?.webui?.basicAuth ?? null, timeoutMs: COMMAND_MS }));
    return host.webui;
  }

  let suppressions = 0;
  async function suppress(step) {
    const messageIds = await resolveMessages(step.messages);
    const ui = await webui();
    const corrId = `${step.id}:suppress:${++suppressions}`;
    log('send', { via: 'webui', op: 'suppress', messageIds });
    ui.send({ type: 'suppress', messageIds, sessionId: ui.welcome.session.id, corrId });
    const result = await unlessFailed(ui.next((m) => m.type === 'surgery-result' && m.corrId === corrId, { label: `the suppress result for ${corrId}` }));
    log('suppress', { result });
    if (result.ok !== true) {
      const said = cutText((cut) => `the web UI's suppress failed: ${result.error ?? cut(JSON.stringify(result), 500)}`);
      fail({ step: step.id, reason: said.shown, ...(said.full ? { full: said.full } : {}) });
      throw new RunFailure('suppress');
    }
    await settle();
  }

  const KINDS = { channel: channelTurn, command, advance, restart, panel, suppress };
  try {
    await boot();
    for (const [i, step] of steps.entries()) {
      current = step;
      standin.setStep(step);
      const started = performance.now();
      if (step.kind === 'checkpoint') await checkpoint(step, i === steps.length - 1);
      else if (KINDS[step.kind]) await KINDS[step.kind](step);
      else { fail({ step: step.id, reason: `the driver has no step kind ${JSON.stringify(step.kind)}` }); throw new RunFailure('unknown kind'); }
      for (const read of step.reads ?? []) {
        const { op, ...params } = typeof read === 'string' ? { op: read } : read;
        log('read', { op, ...(Object.keys(params).length ? { params } : {}), answer: await moduleRead(op, { agent: agentName, ...params }) });
      }
      timing.steps.push({ id: step.id, kind: step.kind, ms: Math.round(performance.now() - started) });
    }
    if (host) log('health', { name: 'end', health: await health('end', 'the run\'s end') });
    else log('health', { name: 'end', skipped: 'the run\'s last step stopped its host' });
  } catch (e) {
    const c = e instanceof RunFailure ? { shown: e.message } : cutText((cut) => cut(String(e?.stack || e), 3000));
    if (!failure) fail({ step: current?.id ?? null, reason: c.shown, ...(c.full ? { full: c.full } : {}) });
    if (host) log('host-output', { boot: host.n, hostLog: hostLogOf(host), tail: tail(host.out) });
  } finally {
    await shutdown();
    await ctl.close();
    ended = true;
    log('end', { ok: !failure, clockEnd: clock });
  }
  return { ok: !failure, failure, clockEnd: clock, copies, timing };
}

const tail = (out) => out.join('').split('\n').slice(-30).join('\n');
