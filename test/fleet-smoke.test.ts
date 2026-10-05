/**
 * Phase 2 smoke test for FleetModule.
 *
 * Drives the module's tool surface directly (no full framework needed) and
 * exercises the end-to-end loop:
 *   launch -> ready, list, status, command (/help, offline-safe), peek
 *   shows command-output events, kill exits the child cleanly.
 *
 * fleet--send is intentionally NOT tested here — it triggers inference and
 * needs a real ANTHROPIC_API_KEY.  That's manual-test territory.
 */
import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, lstatSync, readFileSync, readlinkSync, symlinkSync, renameSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetModule } from '../src/modules/fleet-module.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');
const INDEX_PATH = join(REPO_ROOT, 'src', 'index.ts');

const MINIMAL_RECIPE = {
  name: 'Fleet Smoke Test',
  agent: { name: 'leaf', systemPrompt: 'never asked to infer in this test' },
  modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
};

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
}

describe('FleetModule — unresolved launch artifacts', () => {
  let tmpDir: string;
  const fleets: FleetModule[] = [];
  beforeAll(() => { tmpDir = mkdtempSync(join(tmpdir(), 'fkm-fleet-guard-')); });
  afterAll(async () => {
    await Promise.all(fleets.map((fleet) => fleet.stop()));
    rmSync(tmpDir, { recursive: true, force: true });
  }, 15_000);

  function makeFleet(defaultSubscription?: string[]) {
    const fleet = new FleetModule({
      childIndexPath: join(TEST_DIR, 'mock-headless-child.ts'),
      defaultSubscription,
      socketWaitTimeoutMs: 5_000, readyTimeoutMs: 5_000,
      gracefulShutdownMs: 1_000, sigtermEscalationMs: 500,
    });
    fleets.push(fleet);
    return fleet;
  }
  function launch(fleet: FleetModule, dataDir: string) {
    return fleet.handleToolCall({ id: 'guard-launch', name: 'launch', input: {
      name: 'guard', recipe: 'mock-recipe', dataDir,
    } });
  }
  async function startOwner(dataDir: string, autoRestart = false,
    ctx = {} as Parameters<FleetModule['start']>[0], subscription?: string[]) {
    const fleet = new FleetModule({
      childIndexPath: join(TEST_DIR, 'mock-headless-child.ts'),
      socketWaitTimeoutMs: 5_000, readyTimeoutMs: 5_000,
      gracefulShutdownMs: 1_000, sigtermEscalationMs: 500,
      autoStart: [{ name: 'guard', recipe: 'mock-recipe', dataDir, autoRestart, subscription,
        env: { ANTHROPIC_API_KEY: 'sk-test-fleet-guard', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } }],
    });
    fleets.push(fleet);
    await fleet.start(ctx);
    await waitFor(() => fleet.getChildren().get('guard')?.status === 'ready', 10_000, 'mock child ready');
    return fleet;
  }

  for (const artifact of ['headless.pid', 'ipc.sock']) {
    for (const kind of ['file', 'dangling symlink', 'FIFO', 'directory']) {
      test(`refuses unknown ${artifact} ${kind} without touching it`, async () => {
        const dataDir = mkdtempSync(join(tmpDir, 'unknown-'));
        const path = join(dataDir, artifact);
        if (kind === 'file') writeFileSync(path, 'unknown artifact bytes');
        if (kind === 'dangling symlink') symlinkSync('missing-target', path);
        if (kind === 'FIFO') execFileSync('mkfifo', [path]);
        if (kind === 'directory') mkdirSync(path);
        const before = lstatSync(path);
        const fleet = makeFleet();
        const result = await launch(fleet, dataDir);
        expect(result.success).toBe(false);
        expect(result.isError).toBe(true);
        expect(result.error).toContain('reconcile');
        expect(fleet.getChildren().size).toBe(0);
        expect(existsSync(join(dataDir, 'startup.log'))).toBe(false);
        const after = lstatSync(path);
        expect(after.ino).toBe(before.ino);
        expect(after.mode).toBe(before.mode);
        expect(after.mtimeMs).toBe(before.mtimeMs);
        if (kind === 'file') expect(readFileSync(path, 'utf8')).toBe('unknown artifact bytes');
        if (kind === 'dangling symlink') expect(readlinkSync(path)).toBe('missing-target');
      });
    }
  }

  test('non-ENOENT inspection failure refuses launch', async () => {
    const dataDir = join(tmpDir, 'not-a-directory');
    writeFileSync(dataDir, 'unchanged');
    const fleet = makeFleet();
    const result = await launch(fleet, dataDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot inspect launch artifact');
    expect(fleet.getChildren().size).toBe(0);
    expect(readFileSync(dataDir, 'utf8')).toBe('unchanged');
  });

  test('fresh parent refuses an occupied dataDir and preserves the owner connection', async () => {
    const dataDir = join(tmpDir, 'occupied');
    const owner = await startOwner(dataDir);
    const child = owner.getChildren().get('guard')!;
    const pidFile = readFileSync(join(dataDir, 'headless.pid'), 'utf8');
    const socketInode = lstatSync(child.socketPath).ino;
    const log = readFileSync(join(dataDir, 'startup.log'), 'utf8');
    const stranger = makeFleet();
    await stranger.start({} as Parameters<FleetModule['start']>[0]);
    expect((await launch(stranger, dataDir)).success).toBe(false);
    expect(stranger.getChildren().size).toBe(0);
    expect(readFileSync(join(dataDir, 'headless.pid'), 'utf8')).toBe(pidFile);
    expect(lstatSync(child.socketPath).ino).toBe(socketInode);
    expect(readFileSync(join(dataDir, 'startup.log'), 'utf8')).toBe(log);
    expect(child.process?.exitCode).toBeNull();
    expect(child.process?.signalCode).toBeNull();
    const count = child.events.length;
    expect((await owner.handleToolCall({ id: 'owner-help', name: 'command',
      input: { name: 'guard', command: '/help' } })).success).toBe(true);
    await waitFor(() => child.events.slice(count).some((e) => e.type === 'command-output'),
      3_000, 'original owner still receives output');
    expect((await launch(owner, dataDir)).error).toContain('already ready');
    await owner.stop();
  }, 20_000);

  test('persisted ready child killed by parent exit recovers through second-parent autoStart', async () => {
    let state: any;
    const ctx = { setState: (value: unknown) => { state = value; }, getState: () => state,
      pushEvent: () => {}, getModule: () => null } as unknown as Parameters<FleetModule['start']>[0];
    const dataDir = join(tmpDir, 'parent-exit');
    const owner = await startOwner(dataDir, false, ctx);
    const old = owner.getChildren().get('guard')!;
    const readyState = JSON.parse(JSON.stringify(state));
    (owner as any).killAllOnExitSync();
    await waitFor(() => old.process?.signalCode === 'SIGKILL', 5_000, 'parent-exit child reaped');
    expect(existsSync(old.socketPath)).toBe(true);
    expect(existsSync(join(dataDir, 'headless.pid'))).toBe(true);
    state = readyState; // Parent died before its exit handler could persist.
    const restored = await startOwner(dataDir, false, ctx);
    expect(restored.getChildren().get('guard')?.pid).not.toBe(old.pid);
    expect(restored.getChildren().get('guard')?.status).toBe('ready');
    await restored.stop(); await owner.stop();
  }, 20_000);

  test('historical crashed record recovers through explicit launch', async () => {
    let state: unknown;
    const ctx = { setState: (value: unknown) => { state = value; }, getState: () => state,
      pushEvent: () => {}, getModule: () => null } as unknown as Parameters<FleetModule['start']>[0];
    const dataDir = join(tmpDir, 'historical');
    const owner = await startOwner(dataDir, false, ctx);
    const old = owner.getChildren().get('guard')!;
    await owner.handleToolCall({ id: 'historical-crash', name: 'command',
      input: { name: 'guard', command: '/crash' } });
    await waitFor(() => old.process?.exitCode === 1, 5_000, 'historical exit');
    const restored = makeFleet();
    await restored.start(ctx);
    expect((await launch(restored, dataDir)).success).toBe(true);
    expect(restored.getChildren().get('guard')?.pid).not.toBe(old.pid);
    await restored.stop(); await owner.stop();
  }, 15_000);

  for (const status of ['exited', 'crashed'] as const) {
    test(`confirmed ${status} record never contacts a live reused PID on boot or launch`, async () => {
      let ownerState: any;
      const ownerCtx = { setState: (s: unknown) => { ownerState = s; }, getState: () => ownerState,
        pushEvent: () => {}, getModule: () => null } as any;
      const dataDir = join(tmpDir, `terminal-${status}`);
      const owner = await startOwner(dataDir, false, ownerCtx);
      const child = owner.getChildren().get('guard')!;
      let state = JSON.parse(JSON.stringify(ownerState));
      Object.assign(state.children.guard, { status, exitedAt: 1234, exitCode: 1, exitReason: 'confirmed prior exit' });
      const restored = makeFleet();
      const probe = spyOn(restored as any, 'probeLiveness');
      const connect = spyOn(restored as any, 'connectChildSocket');
      const pidBytes = readFileSync(join(dataDir, 'headless.pid'), 'utf8');
      const inode = lstatSync(child.socketPath).ino;
      try {
        await restored.start({ getState: () => state, setState: (s: any) => { state = s; } } as any);
        expect(restored.getChildren().get('guard')?.status).toBe(status);
        expect(restored.getChildren().get('guard')?.exitedAt).toBe(1234);
        expect((await launch(restored, dataDir)).success).toBe(false);
        expect(probe).not.toHaveBeenCalled();
        expect(connect).not.toHaveBeenCalled();
        expect(readFileSync(join(dataDir, 'headless.pid'), 'utf8')).toBe(pidBytes);
        expect(lstatSync(child.socketPath).ino).toBe(inode);
        const count = child.events.length;
        expect((await owner.handleToolCall({ id: 'terminal-help', name: 'command',
          input: { name: 'guard', command: '/help' } })).success).toBe(true);
        await waitFor(() => child.events.slice(count).some(e => e.type === 'command-output'), 3_000, 'original connection survives');
      } finally { probe.mockRestore(); connect.mockRestore(); await restored.stop(); await owner.stop(); }
    }, 15_000);
  }

  for (const retry of ['boot', 'launch requested', 'launch omitted', 'launch empty', 'launch send error', 'restart']) {
    test(`transient adoption failure re-probes the same live PID via ${retry}`, async () => {
      let state: any;
      const ctx = { setState: (value: unknown) => { state = value; }, getState: () => state,
        pushEvent: () => {}, getModule: () => null } as unknown as Parameters<FleetModule['start']>[0];
      const dataDir = join(tmpDir, `transient-${retry}`);
      const saved = ['command-output'];
      const requested = ['inference:speech'];
      const configuredDefault = ['inference:speech', 'error'];
      const expected = retry === 'launch requested' ? requested
        : retry === 'launch omitted' ? configuredDefault : retry === 'launch empty' ? [] : saved;
      const owner = await startOwner(dataDir, false, ctx, saved);
      const old = owner.getChildren().get('guard')!;
      let restored: FleetModule | undefined;
      let writes: ReturnType<typeof spyOn<Socket, 'write'>> | undefined;
      owner.setDetachMode(true);
      try {
        await owner.stop();
        const socket = lstatSync(old.socketPath, { bigint: true });
        const pidFile = readFileSync(join(dataDir, 'headless.pid'));
        const log = readFileSync(join(dataDir, 'startup.log'));
        restored = makeFleet(configuredDefault);
        const connectFailure = spyOn(restored as any, 'connectChildSocket').mockRejectedValueOnce(new Error('temporary connection failure'));
        try { await restored.start(ctx); } finally { connectFailure.mockRestore(); }
        expect(restored.getChildren().get('guard')?.socket).toBeNull();
        expect(restored.getChildren().get('guard')?.subscription).toEqual(saved);
        expect(state.children.guard.subscription).toEqual(saved);
        // Capture actual socket writes; the mock child itself ignores subscribe.
        const write = Socket.prototype.write;
        writes = spyOn(Socket.prototype, 'write');
        if (retry === 'launch send error') {
          const orphan = restored.getChildren().get('guard')!;
          const persisted = JSON.stringify(state);
          const failedSockets: Socket[] = [];
          writes.mockImplementation(function (this: Socket, data: string | Uint8Array,
            encoding?: BufferEncoding | ((err?: Error | null) => void), cb?: (err?: Error | null) => void) {
            if (typeof data === 'string' && JSON.parse(data).type === 'subscribe') {
              failedSockets.push(this);
              throw new Error('injected subscribe send failure');
            }
            return typeof encoding === 'function'
              ? write.bind(this)(data, encoding) : write.bind(this)(data, encoding, cb);
          });
          const result = await restored.handleToolCall({ id: 'retry-send-error', name: 'launch',
            input: { name: 'guard', recipe: 'mock-recipe', dataDir, subscription: requested } });
          expect(result.success).toBe(false);
          expect(result.isError).toBe(true);
          expect(failedSockets).toHaveLength(1);
          expect(failedSockets[0].destroyed).toBe(true);
          expect(restored.getChildren().get('guard')).toBe(orphan);
          expect(orphan.socket).toBeNull();
          expect(orphan.process).toBeNull();
          expect(orphan.pid).toBe(old.pid);
          expect(orphan.subscription).toEqual(saved);
          expect(JSON.stringify(state)).toBe(persisted);
          expect(lstatSync(old.socketPath, { bigint: true }).ino).toBe(socket.ino);
          expect(lstatSync(old.socketPath, { bigint: true }).ctimeNs).toBe(socket.ctimeNs);
          expect(readFileSync(join(dataDir, 'headless.pid'))).toEqual(pidFile);
          expect(readFileSync(join(dataDir, 'startup.log'))).toEqual(log);
          return;
        }
        // Exercise a previously persisted failed-adoption record on another boot too.
        if (retry === 'boot') {
          state.children.guard.status = 'crashed';
          await restored.stop();
          restored = makeFleet(configuredDefault);
          await restored.start(ctx);
        } else {
          const subscriptionInput = retry === 'launch requested' ? { subscription: requested }
            : retry === 'launch empty' ? { subscription: [] } : {};
          expect((await restored.handleToolCall({ id: 'retry', name: retry.startsWith('launch') ? 'launch' : retry,
            input: retry.startsWith('launch')
              ? { name: 'guard', recipe: 'mock-recipe', dataDir, ...subscriptionInput }
              : { name: 'guard' } })).success).toBe(true);
        }
        const adopted = restored.getChildren().get('guard')!;
        expect(adopted.pid).toBe(old.pid);
        expect(adopted.status).toBe('ready');
        expect(adopted.process).toBeNull();
        expect(adopted.recipePath).toBe(old.recipePath);
        expect(adopted.dataDir).toBe(old.dataDir);
        expect(adopted.socketPath).toBe(old.socketPath);
        expect(adopted.env).toEqual(old.env);
        expect(adopted.subscription).toEqual(expected);
        expect(state.children.guard.subscription).toEqual(expected);
        const status = await restored.handleToolCall({ id: 'retry-status', name: 'status', input: { name: 'guard' } });
        expect((status.data as { subscription: string[] }).subscription).toEqual(expected);
        const subscribes = writes.mock.calls
          .flatMap(([data]) => typeof data === 'string' ? data.trim().split('\n') : [])
          .map(line => JSON.parse(line))
          .filter(command => command.type === 'subscribe');
        expect(subscribes).toHaveLength(1);
        const wire = subscribes[0].events as string[];
        for (const event of expected) expect(wire).toContain(event);
        // Fixed wire requirements are independent of the production union helper.
        const mandatory = ['inference:started', 'inference:tokens', 'inference:tool_calls_yielded',
          'inference:usage', 'inference:completed', 'inference:failed', 'inference:exhausted',
          'inference:aborted', 'inference:stream_resumed', 'inference:stream_restarted',
          'inference:turn_ended', 'tool:started', 'tool:completed', 'tool:failed', 'usage:updated'];
        for (const event of mandatory) expect(wire).toContain(event);
        expect(wire).toHaveLength(expected.length + mandatory.length);
        expect(wire.includes('inference:speech')).toBe(expected.includes('inference:speech'));
        expect(wire.includes('command-output')).toBe(expected.includes('command-output'));
        expect(wire.includes('error')).toBe(expected.includes('error'));
        expect(wire).not.toContain('*');
        expect(lstatSync(old.socketPath, { bigint: true }).ctimeNs).toBe(socket.ctimeNs);
        expect(readFileSync(join(dataDir, 'headless.pid'))).toEqual(pidFile);
        expect(readFileSync(join(dataDir, 'startup.log'))).toEqual(log);
        const count = adopted.events.length;
        expect((await restored.handleToolCall({ id: 'retry-help', name: 'command',
          input: { name: 'guard', command: '/help' } })).success).toBe(true);
        await waitFor(() => adopted.events.slice(count).some(e => e.type === 'command-output'), 3_000, 'adopted output');
      } finally {
        writes?.mockRestore();
        try { await restored?.stop(); } finally { owner.setDetachMode(false); }
      }
    }, 20_000);
  }

  for (const escalation of [false, true]) {
    test(`adopted-child restart records confirmed death, escalation=${escalation}`, async () => {
      let state: any;
      const transitions: any[] = [];
      const ctx = { setState: (value: unknown) => { state = value; transitions.push(JSON.parse(JSON.stringify(value))); }, getState: () => state,
        pushEvent: () => {}, getModule: () => null } as unknown as Parameters<FleetModule['start']>[0];
      const dataDir = join(tmpDir, `adopted-restart-${escalation}`);
      const owner = await startOwner(dataDir, false, ctx);
      const old = owner.getChildren().get('guard')!;
      owner.setDetachMode(true); await owner.stop();
      const restored = makeFleet();
      await restored.start(ctx);
      const adopted = restored.getChildren().get('guard')!;
      expect(adopted.process).toBeNull();
      if (escalation) process.kill(old.pid!, 'SIGSTOP'); // Cannot answer shutdown or handle SIGTERM.
      try {
        const res = await restored.handleToolCall({ id: 'adopted-restart', name: 'restart', input: { name: 'guard' } });
        expect(res.success).toBe(true);
        expect(adopted.status).toBe('exited');
        expect(adopted.exitedAt).not.toBeNull();
        expect(adopted.exitCode).toBeNull();
        expect(adopted.exitReason).toContain('ESRCH');
        expect(adopted.socket).toBeNull();
        const terminal = transitions.find(s => s.children.guard?.pid === old.pid && s.children.guard.status === 'exited');
        expect(terminal).toBeDefined();
        expect(terminal.children.guard.exitCode).toBeNull();
        expect(terminal.children.guard.exitedAt).not.toBeNull();
        expect(terminal.children.guard).not.toHaveProperty('adopted');
        expect(restored.getChildren().get('guard')?.status).toBe('ready');
        expect(restored.getChildren().get('guard')?.pid).not.toBe(old.pid);
        if (escalation) expect(old.process?.signalCode).toBe('SIGKILL');
      } finally {
        try { process.kill(old.pid!, 'SIGCONT'); } catch { /* already reaped */ }
        await restored.stop(); owner.setDetachMode(false); await owner.stop();
      }
    }, 20_000);
  }

  function trackedState(dataDir: string, pid: number | null = 2_147_483_647) {
    return { children: { guard: { name: 'guard', recipePath: resolve('mock-recipe'), dataDir,
      socketPath: join(dataDir, 'ipc.sock'), pid, status: 'ready', startedAt: 1,
      exitedAt: null, lastEventAt: null, exitCode: null, exitReason: null,
      subscription: ['*'], autoRestart: false, env: null } } };
  }
  async function restoreRecord(dataDir: string, pid: number | null = 2_147_483_647) {
    const fleet = makeFleet();
    let state: any = trackedState(dataDir, pid);
    await fleet.start({ getState: () => state, setState: (s: unknown) => { state = s; } } as any);
    return fleet;
  }

  for (const [bytes, pid] of [
    ['garbage', 2_147_483_647], ['2147483647junk', 2_147_483_647], ['0', 0], ['-1', -1],
    ['1'.repeat(33), 2_147_483_647], ['2147483646', 2_147_483_647], ['1.5', 1.5],
  ] as const) {
    test(`tracked recovery preserves malformed/nonpositive PID metadata ${bytes}`, async () => {
      const dataDir = mkdtempSync(join(tmpDir, 'bad-pid-'));
      const path = join(dataDir, 'headless.pid');
      writeFileSync(path, bytes);
      const before = lstatSync(path, { bigint: true });
      const fleet = await restoreRecord(dataDir, pid);
      expect((await launch(fleet, dataDir)).success).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(bytes);
      expect(lstatSync(path, { bigint: true }).ctimeNs).toBe(before.ctimeNs);
      expect(existsSync(join(dataDir, 'startup.log'))).toBe(false);
    });
  }

  for (const kind of ['dangling symlink', 'FIFO', 'directory']) {
    test(`tracked recovery preserves PID ${kind}`, async () => {
      const dataDir = mkdtempSync(join(tmpDir, 'bad-type-'));
      const path = join(dataDir, 'headless.pid');
      if (kind === 'dangling symlink') symlinkSync('missing', path);
      if (kind === 'FIFO') execFileSync('mkfifo', [path]);
      if (kind === 'directory') mkdirSync(path);
      const before = lstatSync(path, { bigint: true });
      const fleet = await restoreRecord(dataDir);
      expect((await launch(fleet, dataDir)).success).toBe(false);
      expect(lstatSync(path, { bigint: true }).ctimeNs).toBe(before.ctimeNs);
    });
  }

  test('confirmed tracked death with absent socket removes only matching PID metadata', async () => {
    const dataDir = mkdtempSync(join(tmpDir, 'absent-socket-'));
    const pidPath = join(dataDir, 'headless.pid');
    writeFileSync(pidPath, '2147483647');
    const fleet = new FleetModule({ childIndexPath: '' });
    fleets.push(fleet);
    let state: any = trackedState(dataDir);
    await fleet.start({ getState: () => state, setState: (s: unknown) => { state = s; } } as any);
    const result = await launch(fleet, dataDir);
    // Deliberately stop at the existing no-entry-script guard, after reconciliation.
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot determine connectome-host script path');
    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(join(dataDir, 'startup.log'))).toBe(false);
  });

  test('missing Node probe preserves unknown endpoint', async () => {
    const fleet = makeFleet();
    const previous = process.env.PATH;
    try { process.env.PATH = ''; expect(await (fleet as any).socketRefusesConnection('/unused-test-socket')).toBe(false); }
    finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
  });

  test('Node probe deadline fails closed and reaps a silent helper', async () => {
    const dir = mkdtempSync(join(tmpDir, 'silent-node-'));
    const executable = join(dir, 'node');
    writeFileSync(executable, '#!/bin/sh\nexec /bin/sleep 30\n');chmodSync(executable, 0o700);
    const fleet = makeFleet();const previous = process.env.PATH;
    const start = Date.now();
    try {
      process.env.PATH = dir;
      expect(await (fleet as any).socketRefusesConnection('/unused-test-socket')).toBe(false);
      expect(Date.now() - start).toBeLessThan(5_000);
    } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
  }, 6_000);

  test('resource exhaustion cannot turn a live Unix listener into stale evidence', async () => {
    const path = join(tmpDir, 'resource-probe.sock');
    const server = createServer(socket => socket.destroy());
    await new Promise<void>(resolve => server.listen(path, resolve));
    const script = `import {openSync,closeSync} from 'node:fs';
      import {FleetModule} from ${JSON.stringify(join(REPO_ROOT, 'src/modules/fleet-module.ts'))};
      const fleet=new FleetModule({});const fds=[];let exhausted=false;
      try{for(let i=0;i<512;i++)fds.push(openSync('/dev/null','r'));}catch(e){exhausted=e.code==='EMFILE';}
      let refused;try{refused=await fleet.socketRefusesConnection(process.argv[2]);}
      finally{for(const fd of fds)closeSync(fd);}
      console.log(JSON.stringify({exhausted,refused}));process.exitCode=exhausted && refused===false?0:1;`;
    const file = join(tmpDir, 'resource-probe.ts');writeFileSync(file, script);
    try {
      const result = execFileSync('/bin/sh', ['-c', 'ulimit -n 128; exec "$0" "$@"', process.execPath, file, path],
        { encoding: 'utf8', timeout: 8_000, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } });
      expect(JSON.parse(result)).toEqual({ exhausted: true, refused: false });
      expect(lstatSync(path).isSocket()).toBe(true);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  test('EPERM preserves tracked metadata and cannot confirm adopted death', async () => {
    const dataDir = mkdtempSync(join(tmpDir, 'eperm-'));
    writeFileSync(join(dataDir, 'headless.pid'), String(process.pid));
    const kill = spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });
    try {
      const fleet = await restoreRecord(dataDir, process.pid);
      expect((await launch(fleet, dataDir)).success).toBe(false);
      expect(readFileSync(join(dataDir, 'headless.pid'), 'utf8')).toBe(String(process.pid));
      expect(await (fleet as any).waitForExitByPid(process.pid, 10)).toBe(false);
      const child = (fleet as any).children.get('guard');
      child.adopted = true; // Validated adoption is the signal authority under test.
      const result = await fleet.handleToolCall({ id: 'eperm-restart', name: 'restart', input: { name: 'guard' } });
      expect(result.success).toBe(false);
      expect(result.error).toContain('death unconfirmed');
      expect(child.status).toBe('starting');
      expect(child.exitedAt).toBeNull();
      child.adopted = false;
    } finally { kill.mockRestore(); }
  });

  test('unvalidated restored record never signals an unknown live PID', async () => {
    const dataDir = mkdtempSync(join(tmpDir, 'unknown-owner-'));
    writeFileSync(join(dataDir, 'headless.pid'), String(process.pid));
    const fleet = await restoreRecord(dataDir, process.pid);
    const signals: unknown[] = [];
    const kill = spyOn(process, 'kill').mockImplementation((_pid, signal) => { signals.push(signal); return true; });
    try {
      (fleet as any).killAllOnExitSync();
      expect((await fleet.handleToolCall({ id: 'unknown-kill', name: 'kill', input: { name: 'guard' } })).success).toBe(false);
      await fleet.stop();
      expect(signals).toEqual([]);
      expect(readFileSync(join(dataDir, 'headless.pid'), 'utf8')).toBe(String(process.pid));
    } finally { kill.mockRestore(); }
  });

  test('adopted restart honors the final SIGKILL wait before claiming death', async () => {
    const dataDir = mkdtempSync(join(tmpDir, 'unknown-death-'));
    writeFileSync(join(dataDir, 'headless.pid'), String(process.pid));
    const fleet = await restoreRecord(dataDir, process.pid);
    const child = (fleet as any).children.get('guard');
    child.adopted = true;
    const signals: unknown[] = [];
    const kill = spyOn(process, 'kill').mockImplementation((_pid, signal) => { signals.push(signal); return true; });
    const waits: number[] = [];
    const wait = spyOn(fleet as any, 'waitForExitByPid').mockImplementation(async (_pid: number, ms: number) => {
      waits.push(ms); return false;
    });
    try {
      const result = await fleet.handleToolCall({ id: 'unknown-restart', name: 'restart', input: { name: 'guard' } });
      expect(result.success).toBe(false);
      expect(waits).toEqual([1_000, 500, 2_000]);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(child.status).toBe('starting');
      expect(child.exitedAt).toBeNull();
      expect(child.exitCode).toBeNull();
      expect(readFileSync(join(dataDir, 'headless.pid'), 'utf8')).toBe(String(process.pid));
    } finally { child.adopted = false; wait.mockRestore(); kill.mockRestore(); }
  });

  for (const drift of ['unknown probe', 'PID metadata', 'socket', 'record path', 'record generation']) {
    test(`tracked stale recovery preserves artifacts after ${drift}`, async () => {
      const dataDir = mkdtempSync(join(tmpDir, 'probe-drift-'));
      const pidPath = join(dataDir, 'headless.pid');
      const socketPath = join(dataDir, 'ipc.sock');
      writeFileSync(pidPath, '2147483647');
      const server = createServer();
      await new Promise<void>((ok, no) => { server.once('error', no); server.listen(socketPath, ok); });
      // Retain a real Unix socket inode after closing its listener.
      renameSync(socketPath, socketPath + '.retained');
      await new Promise<void>((ok, no) => server.close(err => err ? no(err) : ok()));
      renameSync(socketPath + '.retained', socketPath);
      const fleet = await restoreRecord(dataDir);
      const before = lstatSync(socketPath, { bigint: true });
      const record = (fleet as any).children.get('guard');
      // Inject a failed probe or mutation after a real native refusal, before cleanup rechecks.
      const probe = (fleet as any).socketRefusesConnection.bind(fleet);
      const connect = spyOn(fleet as any, 'socketRefusesConnection').mockImplementation(async (path: string) => {
        if (drift === 'unknown probe') return false;
        const refused = await probe(path);
        if (drift === 'PID metadata') {
          renameSync(pidPath, pidPath + '.old'); writeFileSync(pidPath, '2147483647');
        }
        if (drift === 'socket') {
          renameSync(socketPath, socketPath + '.old'); writeFileSync(socketPath, 'replacement');
        }
        if (drift === 'record path') record.socketPath += '.changed';
        if (drift === 'record generation') record.startedAt++;
        return refused;
      });
      try {
        expect((await launch(fleet, dataDir)).success).toBe(false);
        expect(readFileSync(pidPath, 'utf8')).toBe('2147483647');
        if (drift === 'socket') expect(readFileSync(socketPath, 'utf8')).toBe('replacement');
        else expect(lstatSync(socketPath, { bigint: true }).ctimeNs).toBe(before.ctimeNs);
        expect(existsSync(join(dataDir, 'startup.log'))).toBe(false);
      } finally { connect.mockRestore(); }
    }, 10_000);
  }

  test('reaped handle cannot clean artifacts from a different generation', async () => {
    const dataDir = mkdtempSync(join(tmpDir, 'new-generation-'));
    const owner = await startOwner(dataDir);
    const old = owner.getChildren().get('guard')!;
    await owner.handleToolCall({ id: 'generation-crash', name: 'command', input: { name: 'guard', command: '/crash' } });
    await waitFor(() => old.exitedAt !== null && old.process?.exitCode === 1, 5_000, 'old generation exit');
    // A different live generation's PID replaces our reaped child's metadata.
    writeFileSync(join(dataDir, 'headless.pid'), String(process.pid));
    const inode = lstatSync(old.socketPath).ino;
    const startup = readFileSync(join(dataDir, 'startup.log'), 'utf8');
    expect((await launch(owner, dataDir)).success).toBe(false);
    expect(readFileSync(join(dataDir, 'headless.pid'), 'utf8')).toBe(String(process.pid));
    expect(lstatSync(old.socketPath).ino).toBe(inode);
    expect(readFileSync(join(dataDir, 'startup.log'), 'utf8')).toBe(startup);
    expect(owner.getChildren().get('guard')).toBe(old);
    await owner.stop();
  }, 15_000);

  test('reaped handle preserves a replacement live socket even with the old PID file', async () => {
    const dataDir = mkdtempSync(join(tmpDir, 'replaced-socket-'));
    const owner = await startOwner(dataDir);
    const old = owner.getChildren().get('guard')!;
    await owner.handleToolCall({ id: 'socket-generation-crash', name: 'command', input: { name: 'guard', command: '/crash' } });
    await waitFor(() => old.exitedAt !== null && old.process?.exitCode === 1, 5_000, 'old socket owner exit');
    const pid = readFileSync(join(dataDir, 'headless.pid'), 'utf8');
    const startup = readFileSync(join(dataDir, 'startup.log'), 'utf8');
    // Preserve the original inode and bind a different live server to its path,
    // reproducing a replacement runtime whose PID-file write failed.
    renameSync(old.socketPath, old.socketPath + '.retained');
    const server = createServer(socket => socket.end('replacement-owner'));
    try {
      await new Promise<void>((ok, no) => { server.once('error', no); server.listen(old.socketPath, ok); });
      const inode = lstatSync(old.socketPath).ino;
      expect((await launch(owner, dataDir)).success).toBe(false);
      expect(readFileSync(join(dataDir, 'headless.pid'), 'utf8')).toBe(pid);
      expect(lstatSync(old.socketPath).ino).toBe(inode);
      expect(readFileSync(join(dataDir, 'startup.log'), 'utf8')).toBe(startup);
      expect(owner.getChildren().get('guard')).toBe(old);
      expect(server.listening).toBe(true);
    } finally {
      await owner.stop();
      if(server.listening) await new Promise<void>((ok, no) => server.close(err => err ? no(err) : ok()));
    }
  }, 15_000);

  for (const failure of ['dead persisted PID', 'adoption PID mismatch']) {
    test(`restored parent preserves replacement artifacts after ${failure}`, async () => {
      let state: any;
      const ownerCtx = { setState: (value: unknown) => { state = value; }, getState: () => state,
        pushEvent: () => {}, getModule: () => null } as unknown as Parameters<FleetModule['start']>[0];
      const dataDir = mkdtempSync(join(tmpDir, 'restore-replacement-'));
      const owner = await startOwner(dataDir, false, ownerCtx);
      const old = owner.getChildren().get('guard')!;
      const persisted = JSON.parse(JSON.stringify(state)); // Last ready state before parent crash.
      await owner.handleToolCall({ id: 'restore-crash', name: 'command', input: { name: 'guard', command: '/crash' } });
      await waitFor(() => old.exitedAt !== null && old.process?.exitCode === 1, 5_000, 'persisted owner exit');
      if (failure === 'adoption PID mismatch') persisted.children.guard.pid = process.pid;
      const pidFile = readFileSync(join(dataDir, 'headless.pid'), 'utf8');
      const startup = readFileSync(join(dataDir, 'startup.log'), 'utf8');
      renameSync(old.socketPath, old.socketPath + '.retained');
      const connections = new Set<Socket>();
      const server = createServer(socket => {
        connections.add(socket);socket.on('close', () => connections.delete(socket));
        socket.on('error', () => {});
        socket.write(JSON.stringify({ type: 'lifecycle', phase: 'ready', pid: old.pid }) + '\n');
      });
      const restored = makeFleet();
      try {
        await new Promise<void>((ok, no) => { server.once('error', no); server.listen(old.socketPath, ok); });
        const inode = lstatSync(old.socketPath).ino;
        const restoredCtx = { ...ownerCtx, getState: () => persisted, setState: () => {} };
        await restored.start(restoredCtx);
        expect(readFileSync(join(dataDir, 'headless.pid'), 'utf8')).toBe(pidFile);
        expect(lstatSync(old.socketPath).ino).toBe(inode);
        expect(restored.getChildren().get('guard')?.socket).toBeNull();
        expect(restored.getChildren().get('guard')?.status).toBe(failure === 'dead persisted PID' ? 'crashed' : 'starting');
        const blocked = restored.getChildren().get('guard')!;
        const savedSubscription = [...blocked.subscription];
        const savedStatus = blocked.status;
        const socketCtime = lstatSync(old.socketPath, { bigint: true }).ctimeNs;
        const savedState = JSON.stringify(persisted);
        expect((await restored.handleToolCall({ id: 'mismatched-retry', name: 'launch',
          input: { name: 'guard', recipe: 'mock-recipe', dataDir, subscription: ['inference:speech'] } })).success).toBe(false);
        expect(restored.getChildren().get('guard')).toBe(blocked);
        expect(blocked.socket).toBeNull();
        expect(blocked.process).toBeNull();
        expect(blocked.status).toBe(savedStatus);
        expect(blocked.pid).toBe(persisted.children.guard.pid);
        expect(blocked.subscription).toEqual(savedSubscription);
        expect(JSON.stringify(persisted)).toBe(savedState);
        expect(lstatSync(old.socketPath, { bigint: true }).ctimeNs).toBe(socketCtime);
        expect(lstatSync(old.socketPath).ino).toBe(inode);
        expect(readFileSync(join(dataDir, 'headless.pid'), 'utf8')).toBe(pidFile);
        expect(readFileSync(join(dataDir, 'startup.log'), 'utf8')).toBe(startup);
        expect(server.listening).toBe(true);
      } finally {
        await restored.stop(); await owner.stop();
        for (const socket of connections) socket.destroy();
        if (server.listening) await new Promise<void>((ok, no) => server.close(err => err ? no(err) : ok()));
      }
    }, 15_000);
  }

  for (const mode of ['manual launch', 'restart', 'autoRestart']) {
    test(`reaped same-owner crash supports ${mode}`, async () => {
      const dataDir = mkdtempSync(join(tmpDir, 'crash-'));
      const owner = await startOwner(dataDir, mode === 'autoRestart');
      const old = owner.getChildren().get('guard')!;
      await owner.handleToolCall({ id: 'crash', name: 'command', input: { name: 'guard', command: '/crash' } });
      await waitFor(() => old.exitedAt !== null && old.process?.exitCode === 1, 5_000, 'owner observes exit');
      expect(existsSync(join(dataDir, 'headless.pid'))).toBe(true);
      // A fresh Fleet has no cleanup authority, even after the child is dead.
      expect((await launch(makeFleet(), dataDir)).success).toBe(false);
      if (mode === 'manual launch') expect((await launch(owner, dataDir)).success).toBe(true);
      if (mode === 'restart') expect((await owner.handleToolCall({ id: 'restart', name: 'restart',
        input: { name: 'guard' } })).success).toBe(true);
      await waitFor(() => {
        const next = owner.getChildren().get('guard');
        return next?.status === 'ready' && next.pid !== old.pid;
      }, 10_000, 'new child ready');
      const next = owner.getChildren().get('guard')!;
      expect(readFileSync(join(dataDir, 'headless.pid'), 'utf8')).toBe(String(next.pid));
      expect((await owner.handleToolCall({ id: 'graceful-restart', name: 'restart',
        input: { name: 'guard' } })).success).toBe(true);
      await owner.stop();
    }, 25_000);
  }

  // Owned shutdown reconciliation: only confirmed death of the tracked
  // generation reuses the existing guarded cleanupStaleChildFiles owner.
  for (const mode of ['graceful stop', 'forced kill tool', 'forced stop'] as const) {
    test(`confirmed ${mode} reconciles the tracked generation's stale artifacts`, async () => {
      const dataDir = mkdtempSync(join(tmpDir, 'owned-stop-'));
      const owner = await startOwner(dataDir);
      const child = owner.getChildren().get('guard')!;
      const pidPath = join(dataDir, 'headless.pid');
      expect(readFileSync(pidPath, 'utf8')).toBe(String(child.pid));
      expect(lstatSync(child.socketPath).isSocket()).toBe(true);
      const cleanup = spyOn(owner as any, 'cleanupStaleChildFiles');
      const forced = mode !== 'graceful stop';
      if (forced) process.kill(child.pid!, 'SIGSTOP'); // Cannot answer shutdown or handle SIGTERM.
      try {
        if (mode === 'forced kill tool') {
          expect((await owner.handleToolCall({ id: 'owned-kill', name: 'kill', input: { name: 'guard' } })).success).toBe(true);
        } else {
          await owner.stop();
        }
        expect(child.exitedAt).not.toBeNull();
        if (forced) expect(child.process?.signalCode).toBe('SIGKILL');
        else expect(child.process?.exitCode).toBe(0);
        expect(cleanup).toHaveBeenCalledWith(child);
        expect(existsSync(pidPath)).toBe(false);
        expect(existsSync(child.socketPath)).toBe(false);
      } finally {
        cleanup.mockRestore();
        if (child.process?.exitCode === null && child.process?.signalCode === null) {
          try { process.kill(child.pid!, 'SIGCONT'); } catch { /* already gone */ }
        }
        await owner.stop();
      }
    }, 15_000);
  }

  for (const terminal of ['crashed', 'exited'] as const) {
    test(`stop reconciles an already ${terminal} tracked generation`, async () => {
      // Keep Unix socket fixture paths within the native OS path bound.
      const dataDir = mkdtempSync(join(tmpDir, `t${terminal[0]}-`));
      const owner = await startOwner(dataDir);
      const child = owner.getChildren().get('guard')!;
      if (terminal === 'crashed') {
        await owner.handleToolCall({ id: 'terminal-crash', name: 'command', input: { name: 'guard', command: '/crash' } });
      } else {
        process.kill(child.pid!, 'SIGTERM'); // External exit; the mock leaves its markers behind.
      }
      await waitFor(() => child.exitedAt !== null && child.process?.exitCode === (terminal === 'crashed' ? 1 : 0),
        5_000, `${terminal} child reaped`);
      expect(child.status).toBe(terminal);
      const pidPath = join(dataDir, 'headless.pid');
      expect(readFileSync(pidPath, 'utf8')).toBe(String(child.pid));
      expect(lstatSync(child.socketPath).isSocket()).toBe(true);
      const cleanup = spyOn(owner as any, 'cleanupStaleChildFiles');
      try {
        await owner.stop();
        expect(cleanup).toHaveBeenCalledWith(child);
        expect(existsSync(pidPath)).toBe(false);
        expect(existsSync(child.socketPath)).toBe(false);
      } finally { cleanup.mockRestore(); }
    }, 15_000);
  }

  test('unconfirmed death preserves artifacts and never enters reconciliation', async () => {
    const dataDir = mkdtempSync(join(tmpDir, 'unconfirmed-stop-'));
    const owner = await startOwner(dataDir);
    const child = owner.getChildren().get('guard')!;
    const pidPath = join(dataDir, 'headless.pid');
    const pidBytes = readFileSync(pidPath, 'utf8');
    const before = lstatSync(child.socketPath, { bigint: true });
    const wait = spyOn(owner as any, 'waitForExit').mockImplementation(async () => false);
    const cleanup = spyOn(owner as any, 'cleanupStaleChildFiles');
    try {
      const result = await owner.handleToolCall({ id: 'unconfirmed-kill', name: 'kill', input: { name: 'guard' } });
      expect(result.success).toBe(false);
      expect(result.error).toContain('death unconfirmed');
      expect(cleanup).not.toHaveBeenCalled();
      expect(readFileSync(pidPath, 'utf8')).toBe(pidBytes);
      const after = lstatSync(child.socketPath, { bigint: true });
      expect(after.ino).toBe(before.ino);
      expect(after.ctimeNs).toBe(before.ctimeNs);
    } finally { wait.mockRestore(); cleanup.mockRestore(); await owner.stop(); }
  }, 15_000);

  test('detach stop leaves a live tracked child and its artifacts untouched', async () => {
    const dataDir = mkdtempSync(join(tmpDir, 'detach-stop-'));
    const owner = await startOwner(dataDir);
    const child = owner.getChildren().get('guard')!;
    const pidPath = join(dataDir, 'headless.pid');
    const pidBytes = readFileSync(pidPath, 'utf8');
    const before = lstatSync(child.socketPath, { bigint: true });
    const cleanup = spyOn(owner as any, 'cleanupStaleChildFiles');
    owner.setDetachMode(true);
    try {
      await owner.stop();
      expect(cleanup).not.toHaveBeenCalled();
      expect(child.process?.exitCode).toBeNull();
      expect(child.process?.signalCode).toBeNull();
      expect(readFileSync(pidPath, 'utf8')).toBe(pidBytes);
      const after = lstatSync(child.socketPath, { bigint: true });
      expect(after.ino).toBe(before.ino);
      expect(after.ctimeNs).toBe(before.ctimeNs);
    } finally { cleanup.mockRestore(); owner.setDetachMode(false); await owner.stop(); }
  }, 15_000);

  test('stop preserves replaced PID metadata after a reaped crash', async () => {
    const dataDir = mkdtempSync(join(tmpDir, 'stop-replaced-pid-'));
    const owner = await startOwner(dataDir);
    const old = owner.getChildren().get('guard')!;
    await owner.handleToolCall({ id: 'replaced-pid-crash', name: 'command', input: { name: 'guard', command: '/crash' } });
    await waitFor(() => old.exitedAt !== null && old.process?.exitCode === 1, 5_000, 'old generation exit');
    const pidPath = join(dataDir, 'headless.pid');
    // A different live generation's PID replaces our reaped child's metadata.
    writeFileSync(pidPath, String(process.pid));
    const before = lstatSync(old.socketPath, { bigint: true });
    const cleanup = spyOn(owner as any, 'cleanupStaleChildFiles');
    try {
      await owner.stop();
      expect(cleanup).toHaveBeenCalledWith(old);
      expect(readFileSync(pidPath, 'utf8')).toBe(String(process.pid));
      const after = lstatSync(old.socketPath, { bigint: true });
      expect(after.ino).toBe(before.ino);
      expect(after.ctimeNs).toBe(before.ctimeNs);
    } finally { cleanup.mockRestore(); }
  }, 15_000);

  test('stop preserves a replacement live socket even with the old PID file', async () => {
    const dataDir = mkdtempSync(join(tmpDir, 'stop-replaced-socket-'));
    const owner = await startOwner(dataDir);
    const old = owner.getChildren().get('guard')!;
    await owner.handleToolCall({ id: 'replaced-socket-crash', name: 'command', input: { name: 'guard', command: '/crash' } });
    await waitFor(() => old.exitedAt !== null && old.process?.exitCode === 1, 5_000, 'old socket owner exit');
    const pidPath = join(dataDir, 'headless.pid');
    const pid = readFileSync(pidPath, 'utf8');
    renameSync(old.socketPath, old.socketPath + '.retained');
    const server = createServer(socket => socket.end('replacement-owner'));
    const cleanup = spyOn(owner as any, 'cleanupStaleChildFiles');
    try {
      await new Promise<void>((ok, no) => { server.once('error', no); server.listen(old.socketPath, ok); });
      const before = lstatSync(old.socketPath, { bigint: true });
      await owner.stop();
      expect(cleanup).toHaveBeenCalledWith(old);
      expect(readFileSync(pidPath, 'utf8')).toBe(pid);
      const after = lstatSync(old.socketPath, { bigint: true });
      expect(after.ino).toBe(before.ino);
      expect(after.ctimeNs).toBe(before.ctimeNs);
      expect(server.listening).toBe(true);
    } finally {
      cleanup.mockRestore();
      await owner.stop();
      if (server.listening) await new Promise<void>((ok, no) => server.close(err => err ? no(err) : ok()));
    }
  }, 15_000);

  test('confirmed forced death of an adopted generation reconciles its stale artifacts', async () => {
    let state: any;
    const ctx = { setState: (value: unknown) => { state = value; }, getState: () => state,
      pushEvent: () => {}, getModule: () => null } as unknown as Parameters<FleetModule['start']>[0];
    const dataDir = mkdtempSync(join(tmpDir, 'adopted-forced-'));
    const owner = await startOwner(dataDir, false, ctx);
    const old = owner.getChildren().get('guard')!;
    owner.setDetachMode(true); await owner.stop();
    const restored = makeFleet();
    await restored.start(ctx);
    const adopted = restored.getChildren().get('guard')!;
    expect(adopted.process).toBeNull();
    expect(adopted.pid).toBe(old.pid);
    const pidPath = join(dataDir, 'headless.pid');
    const cleanup = spyOn(restored as any, 'cleanupStaleChildFiles');
    process.kill(old.pid!, 'SIGSTOP'); // Cannot answer shutdown or handle SIGTERM.
    try {
      expect((await restored.handleToolCall({ id: 'adopted-forced-kill', name: 'kill', input: { name: 'guard' } })).success).toBe(true);
      await waitFor(() => old.process?.signalCode === 'SIGKILL', 2_000, 'original handle observes SIGKILL');
      expect(adopted.status).toBe('exited');
      expect(adopted.exitReason).toContain('ESRCH');
      expect(cleanup).toHaveBeenCalledWith(adopted);
      expect(existsSync(pidPath)).toBe(false);
      expect(existsSync(adopted.socketPath)).toBe(false);
    } finally {
      cleanup.mockRestore();
      if (old.process?.exitCode === null && old.process?.signalCode === null) {
        try { process.kill(old.pid!, 'SIGCONT'); } catch { /* already gone */ }
      }
      await restored.stop(); owner.setDetachMode(false); await owner.stop();
    }
  }, 20_000);
});

describe('FleetModule — Phase 2', () => {
  let tmpDir: string;
  let recipePath: string;
  let dataDir: string;
  let fleet: FleetModule;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-fleet-'));
    recipePath = join(tmpDir, 'recipe.json');
    dataDir = join(tmpDir, 'leaf');
    writeFileSync(recipePath, JSON.stringify(MINIMAL_RECIPE), 'utf-8');

    // Inject a dummy ANTHROPIC_API_KEY into the env that children inherit;
    // they validate it on startup but never call the API in this test.
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test-fleet-smoke';

    fleet = new FleetModule({
      childIndexPath: INDEX_PATH,
      // Snappier timeouts for a hermetic test.
      socketWaitTimeoutMs: 15_000,
      readyTimeoutMs: 10_000,
      gracefulShutdownMs: 5_000,
      sigtermEscalationMs: 2_000,
    });
  });

  afterAll(async () => {
    // Defensive cleanup — kill any children the test left behind.
    try { await fleet.stop(); } catch { /* noop */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('launch → list → status → command/peek → kill round trip', async () => {
    // -- launch --
    const spawnRes = await fleet.handleToolCall({
      id: 't-launch',
      name: 'launch',
      input: { name: 'leaf', recipe: recipePath, dataDir },
    });
    expect(spawnRes.success).toBe(true);
    const spawnData = spawnRes.data as { name: string; pid: number | null; status: string };
    expect(spawnData.name).toBe('leaf');
    expect(spawnData.status).toBe('ready');
    expect(typeof spawnData.pid).toBe('number');

    // -- list --
    const listRes = await fleet.handleToolCall({ id: 't-list', name: 'list', input: {} });
    expect(listRes.success).toBe(true);
    const listData = listRes.data as Array<{ name: string; status: string; eventCount: number }>;
    expect(listData).toHaveLength(1);
    expect(listData[0]!.name).toBe('leaf');
    expect(listData[0]!.status).toBe('ready');

    // -- status --
    const statusRes = await fleet.handleToolCall({ id: 't-status', name: 'status', input: { name: 'leaf' } });
    expect(statusRes.success).toBe(true);
    const statusData = statusRes.data as { name: string; status: string; subscription: string[] };
    expect(statusData.status).toBe('ready');
    expect(statusData.subscription).toContain('*');  // default subscription

    // -- command (/help is offline-safe — no LLM call) --
    const cmdRes = await fleet.handleToolCall({
      id: 't-cmd',
      name: 'command',
      input: { name: 'leaf', command: '/help' },
    });
    expect(cmdRes.success).toBe(true);

    // Wait for the command-output events to land in the buffer.
    await waitFor(
      () => {
        const child = fleet.getChildren().get('leaf');
        return !!child && child.events.filter((e) => e.type === 'command-output').length >= 5;
      },
      5_000,
      'command-output events from /help',
    );

    // -- peek --
    const peekRes = await fleet.handleToolCall({
      id: 't-peek',
      name: 'peek',
      input: { name: 'leaf', lines: 30 },
    });
    expect(peekRes.success).toBe(true);
    const peekData = peekRes.data as { name: string; count: number; events: Array<{ type: string }> };
    expect(peekData.name).toBe('leaf');
    expect(peekData.count).toBeGreaterThan(0);
    const cmdOutputs = peekData.events.filter((e) => e.type === 'command-output');
    expect(cmdOutputs.length).toBeGreaterThanOrEqual(5);

    // -- kill --
    const killRes = await fleet.handleToolCall({ id: 't-kill', name: 'kill', input: { name: 'leaf' } });
    expect(killRes.success).toBe(true);

    // Final status should be 'exited' (graceful shutdown via socket).
    const child = fleet.getChildren().get('leaf');
    expect(child?.status).toBe('exited');
    expect(child?.exitCode).toBe(0);

    // Socket file should be removed by the child's own cleanup path.
    expect(existsSync(join(dataDir, 'ipc.sock'))).toBe(false);
    expect(existsSync(join(dataDir, 'headless.pid'))).toBe(false);
  }, 60_000);

  test('launch rejects duplicate name while child is running', async () => {
    const dataDir2 = join(tmpDir, 'duplicate');
    const first = await fleet.handleToolCall({
      id: 't-dup-1',
      name: 'launch',
      input: { name: 'dup', recipe: recipePath, dataDir: dataDir2 },
    });
    expect(first.success).toBe(true);

    const second = await fleet.handleToolCall({
      id: 't-dup-2',
      name: 'launch',
      input: { name: 'dup', recipe: recipePath, dataDir: dataDir2 },
    });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already/);

    // Cleanup: kill the running one.
    await fleet.handleToolCall({ id: 't-dup-kill', name: 'kill', input: { name: 'dup' } });
  }, 60_000);

  test('onChildEvent fans out wire events live (no buffer poll needed)', async () => {
    const dataDir3 = join(tmpDir, 'sub');
    const seen: Array<{ child: string; type: string }> = [];
    const unsub = fleet.onChildEvent('*', (childName, evt) => {
      seen.push({ child: childName, type: evt.type });
    });

    const spawnRes = await fleet.handleToolCall({
      id: 't-sub-spawn',
      name: 'launch',
      input: { name: 'sub', recipe: recipePath, dataDir: dataDir3 },
    });
    expect(spawnRes.success).toBe(true);

    // The lifecycle:ready event should have been fanned out by the time
    // launch returned (handleLaunch awaits waitForReady which polls status).
    expect(seen.some((e) => e.child === 'sub' && e.type === 'lifecycle')).toBe(true);

    await fleet.handleToolCall({ id: 't-sub-cmd', name: 'command', input: { name: 'sub', command: '/help' } });

    // Wait for command-output events to fan out.
    const start = Date.now();
    while (Date.now() - start < 5_000) {
      if (seen.filter((e) => e.type === 'command-output').length >= 5) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(seen.filter((e) => e.type === 'command-output').length).toBeGreaterThanOrEqual(5);

    unsub();
    await fleet.handleToolCall({ id: 't-sub-kill', name: 'kill', input: { name: 'sub' } });
  }, 60_000);

  test('handlers reject unknown child names', async () => {
    const send = await fleet.handleToolCall({ id: 't-u-send', name: 'send', input: { name: 'ghost', content: 'hi' } });
    expect(send.success).toBe(false);
    expect(send.error).toMatch(/Unknown child/);

    const peek = await fleet.handleToolCall({ id: 't-u-peek', name: 'peek', input: { name: 'ghost' } });
    expect(peek.success).toBe(false);

    const kill = await fleet.handleToolCall({ id: 't-u-kill', name: 'kill', input: { name: 'ghost' } });
    expect(kill.success).toBe(false);
  });
});

describe('FleetModule — Phase 4 autoStart + allowlist', () => {
  let tmpDir: string;
  let recipePath: string;
  // Each test below builds its own FleetModule and (in the happy path) calls
  // .stop() before returning.  But if a test throws or times out — or, like
  // adopt-on-restart, intentionally uses detachMode — children spawned with
  // detached:true survive and orphan to PID 1.  Push every fleet here so
  // afterAll can defensively reap whatever the test bodies missed.
  const activeFleets: FleetModule[] = [];

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-fleet-as-'));
    recipePath = join(tmpDir, 'recipe.json');
    writeFileSync(recipePath, JSON.stringify(MINIMAL_RECIPE), 'utf-8');
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test-fleet-smoke';
  });

  afterAll(async () => {
    // Reap in parallel; serial awaits would exceed Bun's hook budget on the
    // worst-case timeout path. undo any leftover detach-mode (adopt-on-restart
    // sets it) so stop() actually kills children, not just disconnects sockets.
    await Promise.all(activeFleets.map(async (f) => {
      try { f.setDetachMode(false); } catch { /* noop */ }
      try { await f.stop(); } catch { /* noop */ }
    }));
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  }, 30_000);

  test('autoStart children launch during start() and reach ready', async () => {
    const fleet = new FleetModule({
      childIndexPath: INDEX_PATH,
      autoStart: [
        { name: 'a', recipe: recipePath, dataDir: join(tmpDir, 'a') },
        { name: 'b', recipe: recipePath, dataDir: join(tmpDir, 'b') },
      ],
      socketWaitTimeoutMs: 15_000,
      readyTimeoutMs: 10_000,
      gracefulShutdownMs: 5_000,
      sigtermEscalationMs: 2_000,
    });
    activeFleets.push(fleet);

    // Minimal ModuleContext stub — start() only uses ctx for .setState which we don't exercise here.
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);

    // autoStart is fire-and-forget, so wait for both to reach ready.
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const ready = [...fleet.getChildren().values()].filter((c) => c.status === 'ready').length;
      if (ready === 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const children = [...fleet.getChildren().values()];
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.status === 'ready')).toBe(true);

    await fleet.stop();
  }, 60_000);

  test('allowlist rejects recipes outside the list (children recipes are implicitly allowed)', async () => {
    const fleet = new FleetModule({
      childIndexPath: INDEX_PATH,
      autoStart: [],
      allowedRecipes: [recipePath],  // only this one path
      socketWaitTimeoutMs: 15_000,
      readyTimeoutMs: 10_000,
      gracefulShutdownMs: 5_000,
      sigtermEscalationMs: 2_000,
    });
    activeFleets.push(fleet);
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);

    const bogus = join(tmpDir, 'bogus-recipe.json');
    const res = await fleet.handleToolCall({
      id: 't-allow-deny',
      name: 'launch',
      input: { name: 'nope', recipe: bogus, dataDir: join(tmpDir, 'nope') },
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/allowlist/i);

    // Listed path should be accepted.
    const ok = await fleet.handleToolCall({
      id: 't-allow-ok',
      name: 'launch',
      input: { name: 'ok', recipe: recipePath, dataDir: join(tmpDir, 'ok') },
    });
    expect(ok.success).toBe(true);

    await fleet.stop();
  }, 60_000);

  test('subscription filter narrows per-subscriber event stream', async () => {
    const fleet = new FleetModule({
      childIndexPath: INDEX_PATH,
      autoStart: [],
      socketWaitTimeoutMs: 15_000,
      readyTimeoutMs: 10_000,
      gracefulShutdownMs: 5_000,
      sigtermEscalationMs: 2_000,
    });
    activeFleets.push(fleet);
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);

    const allEvents: string[] = [];
    const filteredEvents: string[] = [];
    const unsubAll = fleet.onChildEvent('*', (_n, e) => { allEvents.push(e.type); });
    const unsubFiltered = fleet.onChildEvent('*', (_n, e) => { filteredEvents.push(e.type); }, ['lifecycle']);

    const dataDir = join(tmpDir, 'filter');
    const res = await fleet.handleToolCall({
      id: 't-filt-spawn',
      name: 'launch',
      input: { name: 'filt', recipe: recipePath, dataDir },
    });
    expect(res.success).toBe(true);

    await fleet.handleToolCall({ id: 't-filt-cmd', name: 'command', input: { name: 'filt', command: '/help' } });

    await new Promise((r) => setTimeout(r, 500));

    // Unfiltered should include both lifecycle and command-output.
    expect(allEvents.some((t) => t === 'lifecycle')).toBe(true);
    expect(allEvents.some((t) => t === 'command-output')).toBe(true);
    // Filtered should include ONLY lifecycle — no command-output leak-through.
    expect(filteredEvents.some((t) => t === 'lifecycle')).toBe(true);
    expect(filteredEvents.every((t) => t === 'lifecycle')).toBe(true);

    unsubAll();
    unsubFiltered();
    await fleet.handleToolCall({ id: 't-filt-kill', name: 'kill', input: { name: 'filt' } });
    await fleet.stop();
  }, 60_000);

  test('adopt-on-restart: second FleetModule with shared state reattaches to running child', async () => {
    // A minimal in-memory ctx that survives across FleetModule instances.
    const store: { fleet?: unknown } = {};
    const stubCtx = {
      setState: <T>(s: T): void => { store.fleet = s; },
      getState: <T>(): T | null => (store.fleet as T | null) ?? null,
      pushEvent: (): void => {},
      getModule: (): null => null,
    } as unknown as Parameters<FleetModule['start']>[0];

    // First parent: spawn, detach (child keeps running).
    const fleet1 = new FleetModule({
      childIndexPath: INDEX_PATH,
      socketWaitTimeoutMs: 15_000,
      readyTimeoutMs: 10_000,
      // Snappy shutdown so the afterAll safety net stays within hook budget
      // if anything between detach and the explicit kill below throws.
      gracefulShutdownMs: 1_000,
      sigtermEscalationMs: 500,
    });
    activeFleets.push(fleet1);
    await fleet1.start(stubCtx);
    const dataDir = join(tmpDir, 'adopt');
    const res1 = await fleet1.handleToolCall({
      id: 't-adopt-spawn',
      name: 'launch',
      input: { name: 'adoptee', recipe: recipePath, dataDir },
    });
    expect(res1.success).toBe(true);
    const pidBefore = (res1.data as { pid: number }).pid;

    fleet1.setDetachMode(true);
    await fleet1.stop();

    // Brief gap to simulate parent restart.
    await new Promise((r) => setTimeout(r, 200));

    // Second parent: same shared state; should adopt rather than respawn.
    const fleet2 = new FleetModule({
      childIndexPath: INDEX_PATH,
      socketWaitTimeoutMs: 15_000,
      readyTimeoutMs: 10_000,
      gracefulShutdownMs: 1_000,
      sigtermEscalationMs: 500,
    });
    activeFleets.push(fleet2);
    await fleet2.start(stubCtx);

    // The adopted child should be in the new fleet's map, ready, with the SAME pid.
    const adopted = fleet2.getChildren().get('adoptee');
    expect(adopted).toBeDefined();
    expect(adopted?.status).toBe('ready');
    expect(adopted?.pid).toBe(pidBefore);

    // Send a command to confirm the socket works end-to-end.
    const cmd = await fleet2.handleToolCall({
      id: 't-adopt-cmd',
      name: 'command',
      input: { name: 'adoptee', command: '/help' },
    });
    expect(cmd.success).toBe(true);

    await fleet2.handleToolCall({ id: 't-adopt-kill', name: 'kill', input: { name: 'adoptee' } });
    await fleet2.stop();
  }, 60_000);

  test('relative launch path matches implicit absolute-path allowlist via CWD resolve', async () => {
    // Simulates the conductor's post-fix situation: autoStart children carry
    // absolute paths (resolved at recipe-load time), so the implicit allowlist
    // is absolute; but the agent calls fleet--launch with a CWD-relative
    // string.  The launch check must try both forms.
    const fleet = new FleetModule({
      childIndexPath: INDEX_PATH,
      autoStart: [
        // Registers an absolute path in the implicit allowlist without
        // actually starting (autoStart: false).
        { name: 'placeholder', recipe: recipePath, autoStart: false },
      ],
      socketWaitTimeoutMs: 15_000,
      readyTimeoutMs: 10_000,
      gracefulShutdownMs: 5_000,
      sigtermEscalationMs: 2_000,
    });
    activeFleets.push(fleet);
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);

    // Run the launch from the recipe's directory so CWD-resolving "recipe.json"
    // lands on the absolute path registered above.
    const originalCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      const res = await fleet.handleToolCall({
        id: 't-relative-allow',
        name: 'launch',
        input: { name: 'relauth', recipe: 'recipe.json', dataDir: join(tmpDir, 'relauth') },
      });
      expect(res.success).toBe(true);
      await fleet.handleToolCall({ id: 't-relative-kill', name: 'kill', input: { name: 'relauth' } });
    } finally {
      process.chdir(originalCwd);
    }

    await fleet.stop();
  }, 60_000);

  test('allowlist prefix wildcard works', async () => {
    const fleet = new FleetModule({
      childIndexPath: INDEX_PATH,
      autoStart: [],
      allowedRecipes: [`${tmpDir}/*`],
      socketWaitTimeoutMs: 15_000,
      readyTimeoutMs: 10_000,
      gracefulShutdownMs: 5_000,
      sigtermEscalationMs: 2_000,
    });
    activeFleets.push(fleet);
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);

    // Any recipe under tmpDir/ should match.
    const ok = await fleet.handleToolCall({
      id: 't-glob-ok',
      name: 'launch',
      input: { name: 'glob', recipe: recipePath, dataDir: join(tmpDir, 'glob') },
    });
    expect(ok.success).toBe(true);

    // Something outside tmpDir should not.
    const bad = await fleet.handleToolCall({
      id: 't-glob-bad',
      name: 'launch',
      input: { name: 'bad', recipe: '/somewhere/else.json', dataDir: join(tmpDir, 'bad') },
    });
    expect(bad.success).toBe(false);

    await fleet.stop();
  }, 60_000);
});
