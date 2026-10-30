import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
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
  waitForSocket: (child: Child, deadline?: number, lastRefusal?: unknown) => Promise<void>;
  waitForExit: (proc: ChildProcess, timeoutMs: number) => Promise<boolean>;
  waitForReady: (child: Child) => Promise<void>;
  waitForExitByPid: (pid: number, timeoutMs: number) => Promise<boolean>;
  cleanupStaleChildFiles: (child: Child) => Promise<void>;
  sendToChild: (child: Child, command: { type: string }) => void;
  failLaunch: (child: Child, reason: string) => Promise<Result>;
  killChild: (child: Child) => Promise<void>;
};
const internal = (fleet: FleetModule): Internal => fleet as unknown as Internal;
const fixtures: Array<{ fleet: FleetModule; dir: string }> = [];

function fixture(options: object = {}, config: FleetModuleConfig = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-lifecycle-'));
  const recipe = join(dir, 'recipe.json');
  writeFileSync(recipe, JSON.stringify(options));
  const fleet = new FleetModule({
    childIndexPath: join(import.meta.dir, 'mock-fleet-lifecycle-child.ts'),
    socketWaitTimeoutMs: 10_000,
    readyTimeoutMs: 10_000,
    gracefulShutdownMs: 100,
    sigtermEscalationMs: 100,
    ...config,
  });
  fixtures.push({ fleet, dir });
  const input = { name: 'leaf', recipe, dataDir: join(dir, 'leaf') };
  return { fleet, dir, input };
}

const NESTED_FLEET_RECIPE = {
  name: 'nested-fleet', agent: { name: 'leaf', systemPrompt: 'Offline only.' }, modules: { fleet: true },
};

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

/** `ps` works on Linux and macOS alike. */
function isOurChild(pid: number): boolean {
  const ps = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'command=']);
  const command = ps.stdout.toString();
  return command.includes('mock-fleet-lifecycle-child') || command.includes('--headless');
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}

const clearedTimers = new Set<unknown>();
const nativeClearTimeout = globalThis.clearTimeout;
globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
  clearedTimers.add(handle);
  nativeClearTimeout(handle);
}) as typeof clearTimeout;

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
    const log = join(dir, 'leaf', 'launches.jsonl');
    let rows: Array<{ pid: number }> = [];
    try { rows = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch {}
    for (const { pid } of rows) {
      if (isAlive(pid) && isOurChild(pid)) {
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

  test("a child's exit ends the helpers it left in its process group", async () => {
    const { fleet, dir, input } = fixture();
    const helperPid = join(dir, 'helper.pid');
    const crash = join(dir, 'crash-now');
    writeFileSync(input.recipe, JSON.stringify({ helperPid, crashOnFile: crash }));
    expect((await internal(fleet).handleLaunch(input, { viaAutoStart: true })).success).toBe(true);
    const helper = Number(readFileSync(helperPid, 'utf8'));
    expect(isAlive(helper)).toBe(true);
    try {
      writeFileSync(crash, '');
      await until(() => fleet.getChildren().get('leaf')?.status === 'crashed', 'the child exited');
      await until(() => !isAlive(helper), 'the helper ended with its child');
    } finally {
      try { process.kill(helper, 'SIGKILL'); } catch { }
    }
  });

  test("stopping an adopted child ends the helpers it left in its process group", async () => {
    const first = fixture();
    const second = fixture({}, {
      autoStart: [{ name: first.input.name, recipe: first.input.recipe, dataDir: first.input.dataDir, autoStart: false }],
    });
    const helperPid = join(first.dir, 'helper.pid');
    writeFileSync(first.input.recipe, JSON.stringify({ helperPid }));
    let state: unknown = null;
    const context = {
      getState: () => state,
      setState: (next: unknown) => { state = structuredClone(next); },
    } as unknown as Parameters<FleetModule['start']>[0];
    await first.fleet.start(context);
    expect((await internal(first.fleet).handleLaunch(first.input, { viaAutoStart: true })).success).toBe(true);
    const helper = Number(readFileSync(helperPid, 'utf8'));
    first.fleet.setDetachMode(true);
    await first.fleet.stop();
    first.fleet.getChildren().get('leaf')!.process!.removeAllListeners('exit');
    try {
      await second.fleet.start(context);
      expect(second.fleet.getChildren().get('leaf')!.process).toBeNull();
      expect(isAlive(helper)).toBe(true);
      const result = await second.fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } });
      expect(result.success, JSON.stringify(result)).toBe(true);
      await until(() => !isAlive(helper), 'the helper ended with its adopted child');
    } finally {
      first.fleet.setDetachMode(false);
      try { process.kill(helper, 'SIGKILL'); } catch { }
    }
  });

  test("an adopted child whose connection has closed, though its process lives, has its group signalled neither by its stop nor by the host's exit", async () => {
    for (const how of ['stop', 'exit'] as const) {
      const first = fixture();
      const second = fixture({}, {
        autoStart: [{ name: first.input.name, recipe: first.input.recipe, dataDir: first.input.dataDir, autoStart: false }],
      });
      const helperPid = join(first.dir, 'helper.pid');
      writeFileSync(first.input.recipe, JSON.stringify({ helperPid }));
      let state: unknown = null;
      const context = {
        getState: () => state,
        setState: (next: unknown) => { state = structuredClone(next); },
      } as unknown as Parameters<FleetModule['start']>[0];
      await first.fleet.start(context);
      expect((await internal(first.fleet).handleLaunch(first.input, { viaAutoStart: true })).success).toBe(true);
      const leader = first.fleet.getChildren().get('leaf')!.pid!;
      const helper = Number(readFileSync(helperPid, 'utf8'));
      first.fleet.setDetachMode(true);
      await first.fleet.stop();
      first.fleet.getChildren().get('leaf')!.process!.removeAllListeners('exit');
      const kill = process.kill.bind(process);
      const signalled: Array<[number, unknown]> = [];
      let recording: ReturnType<typeof spyOn> | undefined;
      try {
        await second.fleet.start(context);
        const adopted = second.fleet.getChildren().get('leaf')!;
        expect(adopted).toMatchObject({ process: null, status: 'ready' });
        adopted.socket!.destroy();
        await until(() => adopted.socket === null, 'its connection closed');
        expect(isAlive(leader)).toBe(true);
        recording = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
          signalled.push([pid, signal]);
          return kill(pid, signal);
        }) as typeof process.kill);
        if (how === 'stop') {
          await second.fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } });
        } else {
          (second.fleet as unknown as { killAllOnExitSync: () => void }).killAllOnExitSync();
        }
        expect(signalled.filter(([pid, signal]) => pid === -leader && signal !== 0), how).toEqual([]);
        expect(signalled.some(([pid, signal]) => pid === leader && signal !== 0), how).toBe(true);
      } finally {
        recording?.mockRestore();
        first.fleet.setDetachMode(false);
        for (const pid of [leader, helper]) {
          try { process.kill(pid, 'SIGKILL'); } catch { }
        }
      }
    }
  }, 60_000);

  test("stopping an adopted child whose process had already ended signals nothing of its group, and says a process of it is left", async () => {
    const first = fixture();
    const second = fixture({}, {
      autoStart: [{ name: first.input.name, recipe: first.input.recipe, dataDir: first.input.dataDir, autoStart: false }],
    });
    const helperPid = join(first.dir, 'helper.pid');
    writeFileSync(first.input.recipe, JSON.stringify({ helperPid }));
    let state: unknown = null;
    const context = {
      getState: () => state,
      setState: (next: unknown) => { state = structuredClone(next); },
    } as unknown as Parameters<FleetModule['start']>[0];
    await first.fleet.start(context);
    expect((await internal(first.fleet).handleLaunch(first.input, { viaAutoStart: true })).success).toBe(true);
    const leader = first.fleet.getChildren().get('leaf')!.pid!;
    const helper = Number(readFileSync(helperPid, 'utf8'));
    first.fleet.setDetachMode(true);
    await first.fleet.stop();
    first.fleet.getChildren().get('leaf')!.process!.removeAllListeners('exit');
    const kill = process.kill.bind(process);
    const signalled: Array<[number, unknown]> = [];
    let recording: ReturnType<typeof spyOn> | undefined;
    try {
      await second.fleet.start(context);
      expect(second.fleet.getChildren().get('leaf')).toMatchObject({ process: null, status: 'ready' });
      // An adopted child isn't this host's subprocess, so no exit event comes for
      // it here.
      kill(leader, 'SIGKILL');
      await until(() => !isAlive(leader), 'the adopted child ended');
      await until(() => second.fleet.getChildren().get('leaf')!.socket === null, 'its connection closed');
      recording = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
        signalled.push([pid, signal]);
        return kill(pid, signal);
      }) as typeof process.kill);
      (second.fleet as unknown as { killAllOnExitSync: () => void }).killAllOnExitSync();
      expect(signalled.filter(([pid, signal]) => pid === -leader && signal !== 0)).toEqual([]);
      const result = await second.fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } });
      expect(result.success, JSON.stringify(result)).toBe(true);
      expect(signalled.filter(([pid, signal]) => pid === -leader && signal !== 0)).toEqual([]);
      expect(isAlive(helper)).toBe(true);
      const left = `Its process has ended, but process group ${leader}, which it led, still has a process, which this ` +
        "host didn't signal, since nothing showed that group was still the child's when its process ended, and its id " +
        'may since have been taken by another. Once sure that group is still the child\'s, whoever runs this host can ' +
        `end it, as a user allowed to signal it, with \`kill -KILL -- -${leader}\`; a process held in the kernel ends only ` +
        'once the kernel lets it go.';
      expect((result.data as { note?: string }).note).toBe(left);
      const again = await second.fleet.handleToolCall({ id: 'kill-again', name: 'kill', input: { name: 'leaf' } });
      expect((again.data as { note?: string }).note).toBe(`already stopped. ${left}`);
    } finally {
      recording?.mockRestore();
      first.fleet.setDetachMode(false);
      try { process.kill(helper, 'SIGKILL'); } catch { }
    }
  });

  test("a host's exit ends an adopted child's process group while its connection to the child is open", async () => {
    const first = fixture();
    const second = fixture({}, {
      autoStart: [{ name: first.input.name, recipe: first.input.recipe, dataDir: first.input.dataDir, autoStart: false }],
    });
    const helperPid = join(first.dir, 'helper.pid');
    writeFileSync(first.input.recipe, JSON.stringify({ helperPid }));
    let state: unknown = null;
    const context = {
      getState: () => state,
      setState: (next: unknown) => { state = structuredClone(next); },
    } as unknown as Parameters<FleetModule['start']>[0];
    await first.fleet.start(context);
    expect((await internal(first.fleet).handleLaunch(first.input, { viaAutoStart: true })).success).toBe(true);
    const helper = Number(readFileSync(helperPid, 'utf8'));
    first.fleet.setDetachMode(true);
    await first.fleet.stop();
    first.fleet.getChildren().get('leaf')!.process!.removeAllListeners('exit');
    try {
      await second.fleet.start(context);
      expect(second.fleet.getChildren().get('leaf')).toMatchObject({ process: null, status: 'ready' });
      expect(second.fleet.getChildren().get('leaf')!.socket).not.toBeNull();
      (second.fleet as unknown as { killAllOnExitSync: () => void }).killAllOnExitSync();
      await until(() => !isAlive(helper), 'the helper ended with its adopted child');
    } finally {
      first.fleet.setDetachMode(false);
      try { process.kill(helper, 'SIGKILL'); } catch { }
    }
  });

  test("the host's entry, started as a fleet's child told to wait, does nothing in its data directory until told, and ends when its stdin does", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-entry-gate-'));
    const started: ChildProcess[] = [];
    try {
      const recipe = join(dir, 'recipe.json');
      writeFileSync(recipe, JSON.stringify({
        name: 'entry-gate',
        agent: { name: 'leaf', systemPrompt: 'Offline only; never asked to infer.' },
        modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
      }));
      const start = (dataDir: string): ChildProcess => {
        mkdirSync(dataDir, { recursive: true });
        const child = spawn(process.execPath, [new URL('../src/index.ts', import.meta.url).pathname, recipe, '--headless'], {
          env: { ...process.env, DATA_DIR: dataDir, ANTHROPIC_API_KEY: 'sk-offline-entry-gate-test', CONNECTOME_FLEET_BEGIN: 'line' },
          stdio: ['pipe', 'ignore', 'ignore'],
          detached: true,
        });
        child.stdin!.on('error', () => { });
        started.push(child);
        return child;
      };
      const toldDir = join(dir, 'told');
      const told = start(toldDir);
      told.stdin!.write('\n');
      const deadline = Date.now() + 60_000;
      while (!existsSync(join(toldDir, 'headless.pid')) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(join(toldDir, 'headless.pid'))).toBe(true);
      const untoldDir = join(dir, 'untold');
      const untold = start(untoldDir);
      const exit = new Promise<number | null>((done) => untold.on('exit', (code) => done(code)));
      // More than its stdin can buffer, so the write completes only once the child
      // reads it, which only its gate does.
      const wrote = await new Promise<Error | null | undefined>((done) => untold.stdin!.write(Buffer.alloc(4 << 20, 120), done));
      expect(wrote ?? null).toBeNull();
      expect(untold.exitCode).toBeNull();
      expect(readdirSync(untoldDir)).toEqual([]);
      untold.stdin!.end();
      expect(await exit).toBe(1);
      expect(readdirSync(untoldDir)).toEqual([]);
    } finally {
      for (const child of started) {
        try { process.kill(-child.pid!, 'SIGKILL'); } catch { }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('real headless relaunch survives the stale socket left after ready failure', async () => {
    const { fleet, input } = fixture({}, {
      childIndexPath: new URL('../src/index.ts', import.meta.url).pathname,
      socketWaitTimeoutMs: 10_000,
      readyTimeoutMs: 10_000,
    });
    writeFileSync(input.recipe, JSON.stringify({
      name: 'stale-socket-regression',
      agent: { name: 'leaf', systemPrompt: 'Offline only; never asked to infer.' },
      modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
    }));
    const trusted = { ...input, env: { ANTHROPIC_API_KEY: 'sk-offline-stale-socket-test' } };
    const api = internal(fleet);
    const ready = api.waitForReady.bind(fleet);
    api.waitForReady = async () => { throw new Error('injected readiness failure'); };
    const failed = await api.handleLaunch(trusted, { viaAutoStart: true });
    expect(failed.success).toBe(false);
    const original = fleet.getChildren().get('leaf')!;
    expect(isAlive(original.pid!)).toBe(false);
    expect(existsSync(original.socketPath)).toBe(true);
    api.waitForReady = ready;
    const relaunched = await api.handleLaunch(trusted, { viaAutoStart: true });
    expect(relaunched.success).toBe(true);
    expect(fleet.getChildren().get('leaf')!.pid).not.toBe(original.pid);
  }, 20_000);

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
      expect(child.exitReason).toBe('launch failed: socket failure with natural exit notification pending (exit: code=1)');
      expect(child.autoRestartStopped).toBeUndefined();
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
    expect(child.exitReason).toStartWith('child did not become ready: ');
    expect(child.exitReason).toEndWith(' (exit: SIGKILL)');
    expect(child.autoRestartStopped).toBe(
      'its start failed and it was ended by SIGKILL, which is not retried; fleet--restart or fleet--launch starts it again',
    );
  });

  test('missing socket aborts the still-live owned subprocess', async () => {
    const { fleet, input } = fixture({ noSocket: true }, { socketWaitTimeoutMs: 100 });
    const result = await internal(fleet).handleLaunch(input, { viaAutoStart: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain("its socket didn't appear within 100 ms");
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
    expect(result.error).toStartWith("Child 'leaf' didn't start (subscribe failed: injected subscription failure) and has exited.");
    expect(result.error!.split('\n')[1]).toBe(`The child wrote nothing to ${join(input.dataDir, 'startup.log')} during this launch.`);
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
      expect(result.error).toContain("this host couldn't confirm that its process stopped");
      const child = fleet.getChildren().get('leaf')!;
      expect(child.status).toBe('starting');
      expect(child.killRequested).toBe(false);
      expect(child.socket).toBeNull();
      expect(isAlive(child.pid!)).toBe(true);
      const sent = await fleet.handleToolCall({ id: 'send', name: 'send', input: { name: 'leaf', content: 'hi' } });
      expect(sent.error).toStartWith("Nothing was sent: child 'leaf' is recorded as starting (child did not become ready: ");
      expect(sent.error).toEndWith(
        `; its stop is unconfirmed (pid ${child.pid})), and this host has no connection to it. fleet--status for ` +
        "'leaf' shows its state.",
      );
      const retry = await api.handleLaunch(input, { viaAutoStart: true });
      expect(retry.success).toBe(false);
      expect(retry.error).toContain('already starting');

      api.waitForExit = wait;
      process.kill(child.pid!, 'SIGKILL');
      await until(() => child.status === 'crashed', 'real death observed');
      expect(child.exitReason).toStartWith('child did not become ready: ');
      expect(child.exitReason).toEndWith(' (exit: SIGKILL)');
      api.connectChildSocket = connect;
      const relaunched = await api.handleLaunch(input, { viaAutoStart: true });
      expect(relaunched.error).toStartWith("Child 'leaf' didn't start (child did not become ready: ");
      expect(fleet.getChildren().get('leaf')).not.toBe(child);
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
    const status = (await fleet.handleToolCall({ id: 'status', name: 'status', input: { name: 'leaf' } })).data as Record<string, unknown>;
    expect(status.autoRestart).toBe(true);
    expect(status.autoRestartStopped).toBe('3 restarts within 60s; fleet--restart or fleet--launch starts it again, with a fresh retry budget');
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
    expect(fleet.getChildren().get('leaf')!.exitReason).toBe(
      'launch failed: the child exited with code 1 before its socket appeared (exit: code=1)',
    );
  });

  test('expired history starts a new first attempt', async () => {
    const { fleet, input } = fixture();
    const clock = controlRestarts(fleet);
    expect((await internal(fleet).handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true })).success).toBe(true);
    const child = fleet.getChildren().get('leaf')!;
    child.restartAttempts.push(Date.now() - 61_000, Date.now() - 60_001, Date.now() - 60_000);
    await crash(fleet, child);
    expect(clock.pending).toHaveLength(1);
    expect(clock.pending[0]!.delay).toBeGreaterThanOrEqual(1_000);
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
    expect(clock.completed[1]!.result.error).toStartWith(
      "Nothing was launched: a fleet--kill of 'leaf' was acknowledged while this launch loaded the recipe.",
    );
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
      expect(clock.completed[1]!.result.error).toStartWith(
        `Nothing was launched: ${action === 'stop' ? 'this host began shutting down' : "a fleet--kill of 'leaf' was acknowledged"} while this launch checked the files an earlier run left${action === 'stop' ? ', so it starts no new children' : '.'}`,
      );
      expect(fleet.getChildren().get('leaf')).toBe(child);
      expect(launches(input)).toHaveLength(1);
    });
  }

  for (const action of ['kill', 'stop'] as const) {
    test(action + ' during an automatic retry\'s adoption cancels it and closes the adopted connection', async () => {
      const { fleet, input } = fixture();
      const api = internal(fleet) as Internal & {
        canRetryAdoption: (child: Child) => boolean;
        probeLiveness: (child: Child) => Promise<boolean>;
        reattachToLivingChild: (child: Child) => Promise<Child>;
      };
      const clock = controlRestarts(fleet);
      expect((await api.handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true })).success).toBe(true);
      const child = fleet.getChildren().get('leaf')!;
      await crash(fleet, child);
      (child as { process: ChildProcess | null }).process = null;
      let entered = false;
      let release!: () => void;
      const adoption = new Promise<void>(resolve => { release = resolve; });
      let closed = 0;
      api.canRetryAdoption = () => true;
      api.probeLiveness = async () => true;
      api.reattachToLivingChild = async existing => {
        entered = true;
        await adoption;
        return { ...existing, socket: { destroy: () => { closed++; } } } as unknown as Child;
      };
      try {
        clock.release(0);
        await until(() => entered, 'adoption started');
        if (action === 'stop') await fleet.stop();
        else expect((await fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } })).success).toBe(true);
      } finally {
        release();
      }
      await until(() => clock.completed.length === 2, 'cancelled adoption settled');
      expect(clock.completed[1]!.result.success).toBe(false);
      expect(clock.completed[1]!.result.error).toStartWith(
        `Nothing was launched: ${action === 'stop' ? 'this host began shutting down' : "a fleet--kill of 'leaf' was acknowledged"} while this launch reattached to the child's running process${action === 'stop' ? ', so it starts no new children' : '.'}`,
      );
      expect(closed).toBe(1);
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

describe('FleetModule lifecycle: every launch answers to stop, kill and newer launches', () => {
  function holdReconciliation(fleet: FleetModule) {
    const api = internal(fleet);
    const cleanup = api.cleanupStaleChildFiles.bind(fleet);
    const launch = api.handleLaunch.bind(fleet);
    let begun = false;
    let before = 0;
    let entered = 0;
    let holding = true;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    api.handleLaunch = async (...args) => {
      begun = true;
      return launch(...args);
    };
    api.cleanupStaleChildFiles = async (existing) => {
      if (!begun) before++;
      else {
        entered++;
        if (holding) { holding = false; await gate; }
      }
      await cleanup(existing);
    };
    return { before: () => before, entered: () => entered, release };
  }

  test('stop during a manual launch\'s await refuses it, and nothing is spawned', async () => {
    const { fleet, input } = fixture();
    expect((await internal(fleet).handleLaunch(input, { viaAutoStart: true })).success).toBe(true);
    await crash(fleet, fleet.getChildren().get('leaf')!);
    const held = holdReconciliation(fleet);
    const relaunch = internal(fleet).handleLaunch(input, { viaAutoStart: true });
    await until(() => held.entered() === 1, 'manual launch reconciling');
    await fleet.stop();
    held.release();
    const result = await relaunch;
    expect(result.error).toStartWith('Nothing was launched: this host began shutting down while this launch checked the files an earlier run left,');
    expect(launches(input)).toHaveLength(1);
  });

  test('a kill acknowledged during a restart\'s relaunch stops the replacement', async () => {
    const { fleet, input } = fixture();
    expect((await internal(fleet).handleLaunch(input, { viaAutoStart: true })).success).toBe(true);
    const held = holdReconciliation(fleet);
    const restart = fleet.handleToolCall({ id: 'restart', name: 'restart', input: { name: 'leaf' } });
    await until(() => held.entered() === 1, 'relaunch reconciling');
    const killed = await fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } });
    expect(killed.success).toBe(true);
    held.release();
    const result = await restart;
    expect(result.error).toStartWith("Nothing was launched: a fleet--kill of 'leaf' was acknowledged while this launch checked the files an earlier run left.");
    expect(launches(input)).toHaveLength(1);
  });

  test('a kill acknowledged during a restart\'s relaunch stops the replacement after the old generation left its pid file', async () => {
    const { fleet, input } = fixture();
    expect((await internal(fleet).handleLaunch(input, { viaAutoStart: true })).success).toBe(true);
    const old = fleet.getChildren().get('leaf')!;
    old.process!.once('exit', () => writeFileSync(join(input.dataDir, 'headless.pid'), String(old.pid)));
    const held = holdReconciliation(fleet);
    const restart = fleet.handleToolCall({ id: 'restart', name: 'restart', input: { name: 'leaf' } });
    await until(() => held.entered() === 1, 'relaunch reconciling');
    expect(held.before()).toBe(1);
    const killed = await fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } });
    expect(killed.success).toBe(true);
    held.release();
    const result = await restart;
    expect(result.error).toStartWith("Nothing was launched: a fleet--kill of 'leaf' was acknowledged while this launch checked the files an earlier run left.");
    expect(launches(input)).toHaveLength(1);
  });

  test('a manual launch cancels a pending automatic replacement before its awaits', async () => {
    const { fleet, input } = fixture();
    const clock = controlRestarts(fleet);
    expect((await internal(fleet).handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true })).success).toBe(true);
    const crashed = fleet.getChildren().get('leaf')!;
    await crash(fleet, crashed);
    expect(crashed.restartTimer).toBeDefined();
    const held = holdReconciliation(fleet);
    const manual = internal(fleet).handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true });
    await until(() => held.entered() === 1, 'manual launch reconciling');
    expect(crashed.restartTimer).toBeUndefined();
    clock.release(0);
    held.release();
    expect((await manual).success).toBe(true);
    expect(clock.calls).toHaveLength(2);
    expect(launches(input)).toHaveLength(2);
  });

  for (const action of ['kill', 'restart', 'stop'] as const) {
    test(action + " releases the pending automatic replacement's timer, which would otherwise hold the process up to 10.5 s", async () => {
      const { fleet, input } = fixture();
      const clock = controlRestarts(fleet);
      expect((await internal(fleet).handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true })).success).toBe(true);
      const crashed = fleet.getChildren().get('leaf')!;
      await crash(fleet, crashed);
      expect(clearedTimers.has(clock.pending[0]!.handle)).toBe(false);
      if (action === 'stop') await fleet.stop();
      else await fleet.handleToolCall({ id: action, name: action, input: { name: 'leaf' } });
      expect(clearedTimers.has(clock.pending[0]!.handle)).toBe(true);
    });
  }

  test('an automatic retry yields to a manual launch that replaced its generation meanwhile', async () => {
    const { fleet, input } = fixture();
    const clock = controlRestarts(fleet);
    expect((await internal(fleet).handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true })).success).toBe(true);
    await crash(fleet, fleet.getChildren().get('leaf')!);
    const held = holdReconciliation(fleet);
    clock.release(0);
    await until(() => held.entered() === 1, 'automatic retry reconciling');
    const manual = await internal(fleet).handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true });
    expect(manual.success).toBe(true);
    const installed = fleet.getChildren().get('leaf')!;
    held.release();
    await until(() => clock.completed.length === 3, 'automatic retry settled');
    const retry = clock.completed.find((c) => c.result.success === false)!;
    expect(retry.result.error).toBe(
      "Nothing was launched: another launch of 'leaf' took its place while this launch checked the files an earlier run left. " +
      "fleet--status for 'leaf' shows the child that launch started.",
    );
    expect(fleet.getChildren().get('leaf')).toBe(installed);
    expect(launches(input)).toHaveLength(2);
  });

  test('a manual launch wins over an automatic launch already in its awaits', async () => {
    const { fleet, input } = fixture();
    const clock = controlRestarts(fleet);
    expect((await internal(fleet).handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true })).success).toBe(true);
    await crash(fleet, fleet.getChildren().get('leaf')!);
    const api = internal(fleet);
    const cleanup = api.cleanupStaleChildFiles.bind(fleet);
    const gates: Array<() => void> = [];
    api.cleanupStaleChildFiles = async (existing) => {
      await new Promise<void>(resolve => gates.push(resolve));
      await cleanup(existing);
    };
    clock.release(0);
    await until(() => gates.length === 1, 'automatic launch reconciling');
    const manual = api.handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true });
    await until(() => gates.length === 2, 'manual launch reconciling');
    gates[0]!();
    await until(() => clock.completed.length === 2, 'automatic launch settled');
    expect(clock.completed[1]!.result.error).toBe(
      "Nothing was launched: the automatic restart of 'leaf' was cancelled, by a kill, launch or restart of it, " +
      'while this launch checked the files an earlier run left.',
    );
    gates[1]!();
    expect((await manual).success).toBe(true);
    expect(launches(input)).toHaveLength(2);
  });

  test('a child killed by a signal before its socket appears is reported as that signal', async () => {
    const { fleet, input } = fixture({ noSocket: true }, { socketWaitTimeoutMs: 3_000 });
    const launch = internal(fleet).handleLaunch(input, { viaAutoStart: true });
    await until(() => (fleet.getChildren().get('leaf')?.pid ?? null) !== null, 'child spawned');
    await until(() => existsSync(join(input.dataDir, 'launches.jsonl')), 'child running');
    process.kill(fleet.getChildren().get('leaf')!.pid!, 'SIGKILL');
    const result = await launch;
    expect(result.error).toContain('the child was ended by SIGKILL before its socket appeared');
  });

  test('a child that exits after a refused connect is reported with the refusal', async () => {
    const { fleet, input } = fixture();
    const api = internal(fleet);
    api.connectChildSocket = async (child) => {
      child.process!.kill('SIGKILL');
      await until(() => child.process!.signalCode !== null, 'child dead');
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };
    const result = await api.handleLaunch(input, { viaAutoStart: true });
    expect(result.error).toContain('the child was ended by SIGKILL before this host could connect to its socket; the last connect failed: connect ECONNREFUSED');
  });

  test('a launch failure after the process exited but before its exit event marks the record, and signals its group then', async () => {
    const { fleet } = fixture();
    const child = {
      name: 'leaf', status: 'starting', exitedAt: null, exitCode: null, exitReason: null, pid: 4242,
      process: { exitCode: 1, signalCode: null, pid: 4242 }, socket: null,
    } as unknown as Child;
    const signalled: Array<[number, unknown]> = [];
    const spy = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      signalled.push([pid, signal]);
      if (signal === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    }) as typeof process.kill);
    let result: Awaited<ReturnType<ReturnType<typeof internal>['failLaunch']>>;
    try {
      result = await internal(fleet).failLaunch(child, 'subscribe failed: gone');
    } finally {
      spy.mockRestore();
    }
    expect(signalled.filter(([, signal]) => signal !== 0)).toEqual([[-4242, 'SIGKILL']]);
    expect(result.error).toBe("Child 'leaf' didn't start (subscribe failed: gone) and has exited. Nothing is running, so call fleet--launch again once the cause is fixed.");
    expect(child.status).toBe('crashed');
    expect(child.exitCode).toBe(1);
    expect(child.exitReason).toBe('subscribe failed: gone (exit: code=1)');
  });

  test('a kill acknowledged during a restart\'s own kill wait refuses the relaunch', async () => {
    const { fleet, input } = fixture();
    const api = internal(fleet);
    expect((await api.handleLaunch(input, { viaAutoStart: true })).success).toBe(true);
    const kill = api.killChild.bind(fleet);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    api.killChild = async (child) => {
      if (++calls === 1) await gate;
      await kill(child);
    };
    const restart = fleet.handleToolCall({ id: 'restart', name: 'restart', input: { name: 'leaf' } });
    await until(() => calls === 1, 'restart killing');
    const killed = await fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } });
    expect(killed.success).toBe(true);
    release();
    expect((await restart).error).toStartWith("Nothing was launched: a fleet--kill of 'leaf' was acknowledged while this launch loaded the recipe.");
    expect(launches(input)).toHaveLength(1);
  });

  test('a manual launch refused after taking over says automatic restarts stopped', async () => {
    const { fleet, dir, input } = fixture();
    controlRestarts(fleet);
    expect((await internal(fleet).handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true })).success).toBe(true);
    const crashed = fleet.getChildren().get('leaf')!;
    await crash(fleet, crashed);
    const nested = join(dir, 'nested.json');
    writeFileSync(nested, JSON.stringify(NESTED_FLEET_RECIPE));
    const refused = await internal(fleet).handleLaunch({ ...input, recipe: nested, autoRestart: true }, { viaAutoStart: true });
    expect(refused.error).toContain("declares a 'fleet' module of its own");
    expect(fleet.getChildren().get('leaf')).toBe(crashed);
    expect(crashed.restartTimer).toBeUndefined();
    const status = (await fleet.handleToolCall({ id: 'status', name: 'status', input: { name: 'leaf' } })).data as Record<string, unknown>;
    expect(status.autoRestartStopped).toBe('a manual launch or restart took over; until one succeeds, nothing restarts this child');
  });

  test('an automatic replacement refused before spawning records why restarts stopped', async () => {
    const { fleet, input } = fixture();
    const clock = controlRestarts(fleet);
    expect((await internal(fleet).handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true })).success).toBe(true);
    const crashed = fleet.getChildren().get('leaf')!;
    await crash(fleet, crashed);
    writeFileSync(input.recipe, JSON.stringify(NESTED_FLEET_RECIPE));
    clock.release(0);
    await until(() => clock.completed.length === 2, 'replacement refused');
    expect(crashed.autoRestartStopped).toStartWith("the replacement was refused: Nothing was launched: the recipe at ");
  });

  test('a kill that fails is not counted against a launch', async () => {
    const { fleet, input } = fixture();
    expect((await internal(fleet).handleLaunch(input, { viaAutoStart: true })).success).toBe(true);
    const child = fleet.getChildren().get('leaf')!;
    const proc = child.process!;
    (child as { process: ChildProcess | null }).process = null;
    const killed = await fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } });
    expect(killed.success).toBe(false);
    expect(child.killAcks ?? 0).toBe(0);
    proc.kill('SIGKILL');
  });

  test('a launch that starts while the host is stopping is refused at once', async () => {
    const { fleet, input } = fixture();
    await fleet.stop();
    expect((await internal(fleet).handleLaunch(input, { viaAutoStart: true })).error)
      .toBe("Nothing was launched: this host is shutting down, so it starts no new children, and calling fleet--launch again won't change that.");
    expect(existsSync(join(input.dataDir, 'launches.jsonl'))).toBe(false);
  });

  for (const action of ['kill', 'stop', 'detach'] as const) {
    test('an adoption refused by ' + action + ' ' + (action === 'detach' ? 'leaves' : 'stops') + ' the child it confirmed', async () => {
      const { fleet, input } = fixture();
      const api = internal(fleet) as Internal & {
        canRetryAdoption: (child: Child) => boolean;
        probeLiveness: (child: Child) => Promise<boolean>;
        reattachToLivingChild: (child: Child) => Promise<Child>;
      };
      expect((await api.handleLaunch(input, { viaAutoStart: true })).success).toBe(true);
      const child = fleet.getChildren().get('leaf')!;
      await crash(fleet, child);
      const living = Bun.spawn(['sleep', '30']);
      let entered = false;
      let release!: () => void;
      const adoption = new Promise<void>(resolve => { release = resolve; });
      api.canRetryAdoption = () => true;
      api.probeLiveness = async () => true;
      (child as { process: ChildProcess | null }).process = null;
      api.reattachToLivingChild = async existing => {
        entered = true;
        await adoption;
        return { ...existing, process: null, adopted: true, pid: living.pid, status: 'ready', exitedAt: null,
          socket: { destroy: () => {} } } as unknown as Child;
      };
      try {
        const launch = api.handleLaunch(input, { viaAutoStart: true });
        await until(() => entered, 'adoption started');
        if (action === 'kill') expect((await fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } })).success).toBe(true);
        else { if (action === 'detach') fleet.setDetachMode(true); await fleet.stop(); }
        release();
        const result = await launch;
        expect(result.success).toBe(false);
        expect(result.error).toEndWith(action === 'detach'
          ? ' This host leaves that process running for the next host to adopt.'
          : ` This launch stopped the process it had reattached to (pid ${living.pid}).`);
        if (action === 'detach') {
          expect(isAlive(living.pid)).toBe(true);
        } else {
          await until(() => !isAlive(living.pid), 'adopted child stopped');
        }
      } finally {
        living.kill('SIGKILL');
        if (action === 'detach') fleet.setDetachMode(false);
      }
    });
  }

  test('an adoption refused by a kill whose stop is unconfirmed says the process may still be running', async () => {
    const { fleet, input } = fixture();
    const api = internal(fleet) as Internal & {
      canRetryAdoption: (child: Child) => boolean;
      probeLiveness: (child: Child) => Promise<boolean>;
      reattachToLivingChild: (child: Child) => Promise<Child>;
    };
    expect((await api.handleLaunch(input, { viaAutoStart: true })).success).toBe(true);
    const child = fleet.getChildren().get('leaf')!;
    await crash(fleet, child);
    const living = Bun.spawn(['sleep', '30']);
    let entered = false;
    let release!: () => void;
    const adoption = new Promise<void>(resolve => { release = resolve; });
    api.canRetryAdoption = () => true;
    api.probeLiveness = async () => true;
    (child as { process: ChildProcess | null }).process = null;
    api.reattachToLivingChild = async existing => {
      entered = true;
      await adoption;
      return { ...existing, process: null, adopted: true, pid: living.pid, status: 'ready', exitedAt: null,
        socket: { destroy: () => {} } } as unknown as Child;
    };
    try {
      const launch = api.handleLaunch(input, { viaAutoStart: true });
      await until(() => entered, 'adoption started');
      expect((await fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } })).success).toBe(true);
      api.waitForExitByPid = async () => false;
      release();
      expect((await launch).error).toEndWith(
        ` This launch couldn't confirm that the process it had reattached to stopped (pid ${living.pid}), so it ` +
        "may still be running; fleet--status for 'leaf' shows its record.",
      );
    } finally {
      living.kill('SIGKILL');
    }
  });

  test('a kill during backoff records that it ended automatic restarts', async () => {
    const { fleet, input } = fixture();
    controlRestarts(fleet);
    expect((await internal(fleet).handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true })).success).toBe(true);
    const crashed = fleet.getChildren().get('leaf')!;
    await crash(fleet, crashed);
    expect((await fleet.handleToolCall({ id: 'kill', name: 'kill', input: { name: 'leaf' } })).success).toBe(true);
    expect(crashed.autoRestartStopped).toBe('fleet--kill ended automatic restarts; fleet--restart or fleet--launch starts it again');
  });

  test('a signal exit from outside records that it is not retried', async () => {
    const { fleet, input } = fixture();
    const clock = controlRestarts(fleet);
    expect((await internal(fleet).handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true })).success).toBe(true);
    const child = fleet.getChildren().get('leaf')!;
    child.process!.kill('SIGKILL');
    await until(() => child.status === 'crashed', 'child ended by a signal');
    expect(clock.pending).toHaveLength(0);
    expect(child.autoRestartStopped).toBe('it was ended by SIGKILL, which is not retried; fleet--restart or fleet--launch starts it again');
  });

  test('an automatic replacement that throws records why restarts stopped', async () => {
    const { fleet, input } = fixture();
    const clock = controlRestarts(fleet);
    const api = internal(fleet);
    expect((await api.handleLaunch({ ...input, autoRestart: true }, { viaAutoStart: true })).success).toBe(true);
    const crashed = fleet.getChildren().get('leaf')!;
    await crash(fleet, crashed);
    api.handleLaunch = async () => { throw new Error('boom'); };
    clock.release(0);
    await until(() => crashed.autoRestartStopped !== undefined, 'throw recorded');
    expect(crashed.autoRestartStopped).toBe('the replacement failed: boom');
  });

  test('a detaching stop during a launch\'s ready wait leaves the child running, told to begin where its host keeps the children file', async () => {
    for (const gated of [false, true]) {
      const parentDir = gated ? mkdtempSync(join(tmpdir(), 'fleet-lifecycle-parent-')) : undefined;
      const childrenFile = parentDir === undefined ? undefined : join(parentDir, 'fleet-children.json');
      const { fleet, input } = fixture({ ready: false }, { readyTimeoutMs: 300, ...(childrenFile ? { childrenFile } : {}) });
      const launch = internal(fleet).handleLaunch(input, { viaAutoStart: true });
      await until(() => fleet.getChildren().get('leaf')?.socket != null, 'launch connected');
      const pid = fleet.getChildren().get('leaf')!.pid!;
      try {
        fleet.setDetachMode(true);
        await fleet.stop();
        const result = await launch;
        expect(result.error, String(gated)).toEndWith(': this host is shutting down and leaves it running for the next host to adopt, so there is nothing to retry here.');
        expect(isAlive(pid), String(gated)).toBe(true);
      } finally {
        fleet.setDetachMode(false);
        try { process.kill(pid, 'SIGKILL'); } catch { }
        if (parentDir !== undefined) rmSync(parentDir, { recursive: true, force: true });
      }
    }
  });

  test('a detaching stop during a launch whose child then exits says it has exited', async () => {
    const { fleet, dir, input } = fixture({}, { readyTimeoutMs: 5_000 });
    const exitNow = join(dir, 'exit-now');
    writeFileSync(input.recipe, JSON.stringify({ ready: false, crashOnFile: exitNow, stderr: 'leaf is exiting\n' }));
    const launch = internal(fleet).handleLaunch(input, { viaAutoStart: true });
    await until(() => fleet.getChildren().get('leaf')?.socket != null, 'launch connected');
    try {
      fleet.setDetachMode(true);
      await fleet.stop();
      writeFileSync(exitNow, '');
      const result = await launch;
      expect(result.error).toStartWith(
        "Child 'leaf' didn't start (child did not become ready: the child crashed before it reported ready) and has " +
        'exited, and this host is shutting down, so there is nothing to retry here.',
      );
      expect(result.error).toContain('leaf is exiting');
    } finally {
      fleet.setDetachMode(false);
    }
  });

  test("a stop during a launch's ready wait says there is nothing to retry", async () => {
    const { fleet, input } = fixture({ ready: false }, { readyTimeoutMs: 5_000 });
    const launch = internal(fleet).handleLaunch(input, { viaAutoStart: true });
    await until(() => fleet.getChildren().get('leaf')?.socket != null, 'launch connected');
    await fleet.stop();
    expect((await launch).error).toContain(
      'and has exited. Nothing is running, and this host is shutting down, so there is nothing to retry here.',
    );
  });

  test('a socket that keeps refusing connections is reported as having run out its wait', async () => {
    const { fleet, input } = fixture({ noSocket: true }, { socketWaitTimeoutMs: 300 });
    const api = internal(fleet);
    api.waitForSocket = async (child) => {
      if (!existsSync(child.socketPath)) writeFileSync(child.socketPath, '');
    };
    api.connectChildSocket = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };
    const result = await api.handleLaunch(input, { viaAutoStart: true });
    expect(result.error).toContain('its socket refused connections for 300 ms; the last connect failed: connect ECONNREFUSED');
  });

  test('a launch while another adopts the child is refused', async () => {
    const { fleet, input } = fixture();
    const api = internal(fleet) as Internal & {
      canRetryAdoption: (child: Child) => boolean;
      probeLiveness: (child: Child) => Promise<boolean>;
      reattachToLivingChild: (child: Child) => Promise<Child>;
    };
    expect((await api.handleLaunch(input, { viaAutoStart: true })).success).toBe(true);
    const child = fleet.getChildren().get('leaf')!;
    await crash(fleet, child);
    (child as { process: ChildProcess | null }).process = null;
    let entered = false;
    let release!: () => void;
    const adoption = new Promise<void>(resolve => { release = resolve; });
    api.canRetryAdoption = () => true;
    api.probeLiveness = async () => { entered = true; await adoption; return false; };
    const first = api.handleLaunch(input, { viaAutoStart: true });
    await until(() => entered, 'adoption started');
    expect((await api.handleLaunch(input, { viaAutoStart: true })).error).toStartWith(
      "Nothing was launched: another launch is reattaching to the running process of child 'leaf' right now.",
    );
    release();
    await first;
    expect(child.adopting).toBe(false);
  });
});
