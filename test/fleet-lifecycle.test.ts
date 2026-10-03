import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { FleetModule, type FleetModuleConfig } from '../src/modules/fleet-module.js';

type Child = ReturnType<FleetModule['getChildren']> extends ReadonlyMap<string, infer C> ? C : never;
type Result = Awaited<ReturnType<FleetModule['handleToolCall']>>;
type Launch = {
  name: string; recipe: string; dataDir: string; env?: Record<string, string>;
  autoRestart?: boolean; subscription?: string[];
};
type Internal = {
  handleLaunch: (input: Launch, opts: { viaAutoStart: boolean; autoRestartOf?: Child }) => Promise<Result>;
  tryAutoRestart: (child: Child) => void;
  connectChildSocket: (child: Child) => Promise<void>;
  waitForExit: (proc: ChildProcess, timeoutMs: number) => Promise<boolean>;
  waitForReady: (child: Child) => Promise<void>;
  waitForExitByPid: (pid: number, timeoutMs: number) => Promise<boolean>;
  cleanupStaleChildFiles: (child: Child) => Promise<void>;
  sendToChild: (child: Child, command: { type: string }) => void;
};
const internal = (fleet: FleetModule): Internal => fleet as unknown as Internal;
const fixtures: Array<{ fleet: FleetModule; dir: string }> = [];

function fixture(options: object = {}, config: FleetModuleConfig = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-lifecycle-'));
  const recipe = join(dir, 'recipe.json');
  writeFileSync(recipe, JSON.stringify(options));
  const fleet = new FleetModule({
    childIndexPath: join(import.meta.dir, 'mock-fleet-lifecycle-child.ts'),
    socketWaitTimeoutMs: 1_000,
    readyTimeoutMs: 1_000,
    gracefulShutdownMs: 100,
    sigtermEscalationMs: 100,
    ...config,
  });
  fixtures.push({ fleet, dir });
  const input = { name: 'leaf', recipe, dataDir: join(dir, 'leaf') };
  return { fleet, dir, input };
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out: ' + label);
    await Bun.sleep(5);
  }
}

function launches(input: Launch): Array<{ pid: number; sentinel: string | null }> {
  return readFileSync(join(input.dataDir, 'launches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}

/**
 * Capture only timers created synchronously by tryAutoRestart. Native socket,
 * readiness, and cleanup timers keep their real clocks. Tests release each
 * callback explicitly, including already-cancelled callbacks to check identity.
 */
function controlRestarts(fleet: FleetModule) {
  const pending: Array<{ callback: () => void; delay: number; handle: ReturnType<typeof setTimeout> }> = [];
  const api = internal(fleet);
  const restart = api.tryAutoRestart.bind(fleet);
  const launch = api.handleLaunch.bind(fleet);
  const calls: Launch[] = [];
  const completed: Array<{ result: Result; child: Child | undefined }> = [];
  api.handleLaunch = async (...args) => {
    calls.push(args[0]);
    const result = await launch(...args);
    completed.push({ result, child: fleet.getChildren().get('leaf') });
    return result;
  };
  api.tryAutoRestart = (child) => {
    const nativeTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      const handle = nativeTimeout(() => {}, 60_000);
      handle.unref();
      pending.push({ callback, delay, handle });
      return handle;
    }) as typeof setTimeout;
    try { restart(child); }
    finally { globalThis.setTimeout = nativeTimeout; }
  };
  return {
    pending, completed, calls,
    release(index: number) {
      const timer = pending[index]!;
      clearTimeout(timer.handle);
      timer.callback();
    },
  };
}

async function crash(fleet: FleetModule, child: Child): Promise<void> {
  const result = await fleet.handleToolCall({ id: 'crash', name: 'command', input: { name: 'leaf', command: '/crash' } });
  expect(result.success).toBe(true);
  await until(() => child.process!.exitCode !== null, 'crashed process exit');
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async ({ fleet, dir }) => {
    await fleet.stop();
    // Include generations removed from the map by unfixed code.
    const log = join(dir, 'leaf', 'launches.jsonl');
    let rows: Array<{ pid: number }> = [];
    try { rows = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch {}
    for (const { pid } of rows) {
      if (isAlive(pid)) {
        process.kill(pid, 'SIGKILL');
        await until(() => !isAlive(pid), 'fixture cleanup');
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }));
});

describe('FleetModule lifecycle', () => {
  for (const autoRestart of [true, false]) {
    test('manual restart preserves trusted env and autoRestart=' + autoRestart, async () => {
      const { fleet, input } = fixture();
      const subscription = autoRestart ? [] : ['lifecycle'];
      const result = await internal(fleet).handleLaunch({
        ...input, env: { FLEET_TEST_SENTINEL: 'kept' }, autoRestart, subscription,
      }, { viaAutoStart: true });
      expect(result.success).toBe(true);
      const before = fleet.getChildren().get('leaf')!;
      before.restartAttempts.push(Date.now());
      const restarted = await fleet.handleToolCall({ id: 'restart', name: 'restart', input: { name: 'leaf' } });
      expect(restarted.success).toBe(true);
      const after = fleet.getChildren().get('leaf')!;
      expect(after.pid).not.toBe(before.pid);
      expect(launches(input).map(row => row.sentinel)).toEqual(['kept', 'kept']);
      expect(after.autoRestart).toBe(autoRestart);
      expect(after.subscription).toEqual(subscription);
      expect(after.restartAttempts).toEqual([]);
      expect(isAlive(before.pid!)).toBe(false);
    });
  }

  test('PID-only exit confirmation distinguishes permission errors from absence', async () => {
    const fleet = new FleetModule();
    for (const code of ['EPERM', 'EACCES', 'ESRCH']) {
      const kill = process.kill;
      let result: Promise<boolean>;
      // The first probe runs synchronously inside the promise constructor.
      // Restore process.kill before awaiting so unrelated work keeps real I/O.
      process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
        if (pid === process.pid && signal === 0) throw Object.assign(new Error(code), { code });
        return kill(pid, signal);
      }) as typeof process.kill;
      try { result = internal(fleet).waitForExitByPid(process.pid, 10); }
      finally { process.kill = kill; }
      expect(await result!).toBe(code === 'ESRCH');
    }
  });

  test('manual restart of an adopted child confirms its death and starts a replacement', async () => {
    const first = fixture();
    const second = fixture({}, {
      autoStart: [{
        name: first.input.name, recipe: first.input.recipe, dataDir: first.input.dataDir,
        autoStart: false, autoRestart: true, env: { FLEET_TEST_SENTINEL: 'adopted' },
      }],
    });
    let state: unknown = null;
    const context = {
      getState: () => state,
      setState: (next: unknown) => { state = structuredClone(next); },
    } as unknown as Parameters<FleetModule['start']>[0];
    await first.fleet.start(context);
    expect((await internal(first.fleet).handleLaunch({
      ...first.input, autoRestart: true, env: { FLEET_TEST_SENTINEL: 'adopted' },
    }, { viaAutoStart: true })).success).toBe(true);
    const original = first.fleet.getChildren().get('leaf')!;
    first.fleet.setDetachMode(true);
    await first.fleet.stop();
    try {
      await second.fleet.start(context);
      const adopted = second.fleet.getChildren().get('leaf')!;
      expect(adopted.process).toBeNull();
      expect(adopted.pid).toBe(original.pid);
      const result = await second.fleet.handleToolCall({ id: 'restart', name: 'restart', input: { name: 'leaf' } });
      expect(result.success).toBe(true);
      expect(adopted.status).toBe('exited');
      expect(adopted.exitedAt).not.toBeNull();
      expect(isAlive(original.pid!)).toBe(false);
      const replacement = second.fleet.getChildren().get('leaf')!;
      expect(replacement.pid).not.toBe(original.pid);
      expect(replacement.autoRestart).toBe(true);
      expect(launches(first.input).map(row => row.sentinel)).toEqual(['adopted', 'adopted']);
    } finally {
      first.fleet.setDetachMode(false);
    }
  });

  for (const failure of ['ready', 'subscribe'] as const) {
    test('real headless relaunch survives the stale socket left after ' + failure + ' failure', async () => {
      const { fleet, input } = fixture({}, {
        childIndexPath: new URL('../src/index.ts', import.meta.url).pathname,
        socketWaitTimeoutMs: 10_000,
      });
      writeFileSync(input.recipe, JSON.stringify({
        name: 'stale-socket-regression',
        agent: { name: 'leaf', systemPrompt: 'Offline only; never asked to infer.' },
        modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
      }));
      const trusted = { ...input, env: { ANTHROPIC_API_KEY: 'sk-offline-stale-socket-test' } };
      const api = internal(fleet);
      const ready = api.waitForReady.bind(fleet);
      const send = api.sendToChild.bind(fleet);
      if (failure === 'ready') api.waitForReady = async () => { throw new Error('injected readiness failure'); };
      else api.sendToChild = (child, command) => {
        if (command.type === 'subscribe') throw new Error('injected subscription failure');
        send(child, command);
      };
      const failed = await api.handleLaunch(trusted, { viaAutoStart: true });
      expect(failed.success).toBe(false);
      const original = fleet.getChildren().get('leaf')!;
      expect(isAlive(original.pid!)).toBe(false);
      expect(existsSync(original.socketPath)).toBe(true);
      api.waitForReady = ready;
      api.sendToChild = send;
      const relaunched = await api.handleLaunch(trusted, { viaAutoStart: true });
      expect(relaunched.success).toBe(true);
      expect(fleet.getChildren().get('leaf')!.pid).not.toBe(original.pid);
    }, 20_000);
  }

  test('a natural nonzero exit reported during launch cleanup keeps its automatic retry', async () => {
    const { fleet, dir, input } = fixture();
    const release = join(dir, 'crash-now');
    writeFileSync(input.recipe, JSON.stringify({ crashOnFile: release }));
    const clock = controlRestarts(fleet);
    const api = internal(fleet);
    const connect = api.connectChildSocket.bind(fleet);
    let proc: ChildProcess | null = null;
    let kill: ChildProcess['kill'] | null = null;
    api.connectChildSocket = async child => {
      await connect(child);
      proc = child.process!;
      kill = proc.kill.bind(proc);
      // Model SIGKILL losing the race to a natural exit. The exit notification
      // still arrives from a real subprocess, after the failure handler starts.
      proc.kill = () => false;
      writeFileSync(release, 'crash');
      throw new Error('socket failure with natural exit notification pending');
    };
    try {
      const result = await api.handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true });
      expect(result.success).toBe(false);
      const child = fleet.getChildren().get('leaf')!;
      expect(child.process!.exitCode).toBe(1);
      expect(clock.pending).toHaveLength(1);
      expect(child.restartAttempts).toHaveLength(1);
    } finally {
      if (proc && kill) (proc as ChildProcess).kill = kill;
    }
  });

  test('ready timeout returns only after the owned child and connection are stopped', async () => {
    const { fleet, input } = fixture({ ready: false }, { readyTimeoutMs: 100 });
    const result = await internal(fleet).handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('child did not become ready');
    const child = fleet.getChildren().get('leaf')!;
    expect(isAlive(child.pid!)).toBe(false);
    expect(child.socket).toBeNull();
    expect(child.status).toBe('crashed');
    expect(child.killRequested).toBe(false);
    expect(child.restartAttempts).toEqual([]);
    expect(await internal(fleet).waitForExit(child.process!, 10)).toBe(true);
  });

  test('missing socket aborts the still-live owned subprocess', async () => {
    const { fleet, input } = fixture({ noSocket: true }, { socketWaitTimeoutMs: 100 });
    const result = await internal(fleet).handleLaunch(input, { viaAutoStart: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('socket did not appear');
    const child = fleet.getChildren().get('leaf')!;
    expect(isAlive(child.pid!)).toBe(false);
    expect(child.status).toBe('crashed');
    expect(child.killRequested).toBe(false);
  });

  test('subscribe-send failure terminates a child even if ready already arrived', async () => {
    const { fleet, input } = fixture();
    const api = internal(fleet);
    const send = api.sendToChild.bind(fleet);
    const connect = api.connectChildSocket.bind(fleet);
    api.connectChildSocket = async child => {
      await connect(child);
      await until(() => child.status === 'ready', 'ready before subscribe failure');
    };
    api.sendToChild = (child, command) => {
      if (command.type === 'subscribe') throw new Error('injected subscription failure');
      send(child, command);
    };
    const result = await api.handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('injected subscription failure');
    const child = fleet.getChildren().get('leaf')!;
    expect(isAlive(child.pid!)).toBe(false);
    expect(child.socket).toBeNull();
    expect(child.killRequested).toBe(false);
  });

  test('unconfirmed termination keeps the child blocked and reports the cleanup failure', async () => {
    const { fleet, input } = fixture({ ready: false }, { readyTimeoutMs: 100 });
    const api = internal(fleet);
    const connect = api.connectChildSocket.bind(fleet);
    const wait = api.waitForExit.bind(fleet);
    let originalKill: ChildProcess['kill'] | undefined;
    api.connectChildSocket = async child => {
      await connect(child);
      originalKill = child.process!.kill.bind(child.process!);
      child.process!.kill = () => false;
    };
    api.waitForExit = async () => false;
    try {
      const result = await api.handleLaunch(input, { viaAutoStart: true });
      expect(result.success).toBe(false);
      expect(result.error).toContain('child termination unconfirmed');
      const child = fleet.getChildren().get('leaf')!;
      expect(child.status).toBe('starting');
      expect(child.killRequested).toBe(false);
      expect(child.socket).toBeNull();
      expect(isAlive(child.pid!)).toBe(true);
      const retry = await api.handleLaunch(input, { viaAutoStart: true });
      expect(retry.success).toBe(false);
      expect(retry.error).toContain('already starting');
    } finally {
      api.waitForExit = wait;
      const child = fleet.getChildren().get('leaf');
      if (child?.process && originalKill) child.process.kill = originalKill;
    }
  });

  test('real replacements retain attempt history, advance backoff, and stop at the cap', async () => {
    const { fleet, input } = fixture();
    const clock = controlRestarts(fleet);
    expect((await internal(fleet).handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true })).success).toBe(true);
    for (let index = 0; index < 3; index++) {
      const old = fleet.getChildren().get('leaf')!;
      await crash(fleet, old);
      expect(fleet.getChildren().get('leaf')).toBe(old);
      expect(clock.pending).toHaveLength(index + 1);
      expect(old.restartAttempts).toHaveLength(index + 1);
      const lower = [1_000, 3_000, 10_000][index]!;
      const upper = lower + Math.min(500, lower / 4);
      expect(clock.pending[index]!.delay).toBeGreaterThanOrEqual(lower);
      expect(clock.pending[index]!.delay).toBeLessThan(upper);
      clock.release(index);
      await until(() => clock.completed.length === index + 2, 'replacement launch settled');
      expect(clock.completed.at(-1)!.result.success).toBe(true);
      expect(fleet.getChildren().get('leaf')!.restartAttempts).toHaveLength(index + 1);
    }
    const last = fleet.getChildren().get('leaf')!;
    await crash(fleet, last);
    expect(clock.pending).toHaveLength(3);
    expect(fleet.getChildren().get('leaf')).toBe(last);
    expect(last.status).toBe('crashed');
    expect(launches(input)).toHaveLength(4);
  });

  test('crash before socket still preserves the retry chain through failed launches', async () => {
    const { fleet, input } = fixture({ crashBeforeSocket: true });
    const clock = controlRestarts(fleet);
    expect((await internal(fleet).handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true })).success).toBe(false);
    for (let index = 0; index < 3; index++) {
      expect(clock.pending).toHaveLength(index + 1);
      clock.release(index);
      await until(() => clock.completed.length === index + 2, 'failed replacement launch settled');
      expect(clock.completed.at(-1)!.result.success).toBe(false);
    }
    expect(clock.pending).toHaveLength(3);
    expect(fleet.getChildren().get('leaf')!.restartAttempts).toHaveLength(3);
    expect(launches(input)).toHaveLength(4);
  });

  test('expired history starts a new first attempt', async () => {
    const { fleet, input } = fixture();
    const clock = controlRestarts(fleet);
    expect((await internal(fleet).handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true })).success).toBe(true);
    const child = fleet.getChildren().get('leaf')!;
    child.restartAttempts.push(Date.now() - 61_000, Date.now() - 60_001, Date.now() - 60_000);
    await crash(fleet, child);
    expect(clock.pending).toHaveLength(1);
    expect(clock.pending[0]!.delay).toBeLessThan(1_250);
    expect(child.restartAttempts).toHaveLength(1);
  });

  test('kill after the retry callback starts cancels across recipe-loading await', async () => {
    const { fleet, input } = fixture();
    const clock = controlRestarts(fleet);
    expect((await internal(fleet).handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true })).success).toBe(true);
    const child = fleet.getChildren().get('leaf')!;
    await crash(fleet, child);
    clock.release(0);
    expect(clock.calls).toHaveLength(2);
    const killed = await fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } });
    expect(killed.success).toBe(true);
    await until(() => clock.completed.length === 2, 'cancelled launch settled');
    expect(clock.completed[1]!.result.success).toBe(false);
    expect(clock.completed[1]!.result.error).toContain('changed during launch');
    expect(fleet.getChildren().get('leaf')).toBe(child);
    expect(launches(input)).toHaveLength(1);
  });

  for (const action of ['kill', 'stop'] as const) {
    test(action + ' during asynchronous ownership reconciliation cancels automatic replacement', async () => {
      const { fleet, input } = fixture();
      const api = internal(fleet);
      const clock = controlRestarts(fleet);
      expect((await api.handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true })).success).toBe(true);
      const child = fleet.getChildren().get('leaf')!;
      await crash(fleet, child);
      let entered = false;
      let release!: () => void;
      const reconciliation = new Promise<void>(resolve => { release = resolve; });
      const cleanup = api.cleanupStaleChildFiles.bind(fleet);
      api.cleanupStaleChildFiles = async existing => {
        entered = true;
        await reconciliation;
        await cleanup(existing);
      };
      try {
        clock.release(0);
        await until(() => entered, 'ownership reconciliation started');
        if (action === 'stop') await fleet.stop();
        else expect((await fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } })).success).toBe(true);
      } finally {
        release();
      }
      await until(() => clock.completed.length === 2, 'cancelled reconciliation settled');
      expect(clock.completed[1]!.result.success).toBe(false);
      expect(clock.completed[1]!.result.error).toContain('changed during reconciliation');
      expect(fleet.getChildren().get('leaf')).toBe(child);
      expect(launches(input)).toHaveLength(1);
    });
  }

  for (const action of ['kill', 'restart', 'stop', 'replace'] as const) {
    test(action + ' during backoff cancels stale automatic replacement', async () => {
      const { fleet, input } = fixture();
      const clock = controlRestarts(fleet);
      expect((await internal(fleet).handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true })).success).toBe(true);
      const child = fleet.getChildren().get('leaf')!;
      await crash(fleet, child);
      expect(clock.pending).toHaveLength(1);
      if (action === 'stop') await fleet.stop();
      else if (action === 'replace') {
        expect((await internal(fleet).handleLaunch(input, { viaAutoStart: true })).success).toBe(true);
      } else {
        expect((await fleet.handleToolCall({ id: action, name: action, input: { name: 'leaf' } })).success).toBe(true);
      }
      const current = fleet.getChildren().get('leaf');
      const count = clock.calls.length;
      clock.release(0);
      expect(clock.calls).toHaveLength(count);
      expect(fleet.getChildren().get('leaf')).toBe(current);
      expect(launches(input)).toHaveLength(action === 'restart' || action === 'replace' ? 2 : 1);
      if (action === 'restart') expect(current!.restartAttempts).toEqual([]);
    });
  }
});
