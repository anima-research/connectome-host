import { test, expect, spyOn } from 'bun:test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { FleetModule } from '../src/modules/fleet-module.ts';

const fixture = join(import.meta.dir, 'mock-headless-fleet-shutdown-child.ts');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await sleep(10);
  }
}

for (const mode of ['timeout', 'detach']) {
  test(`real headless Fleet shutdown ${mode} preserves child ownership`, async () => {
    // macOS's standard temp path leaves too little Unix socket path capacity.
    const dir = mkdtempSync('/tmp/fleet-stop-');
    const parent = spawn(process.execPath, [join(import.meta.dir, 'mock-headless-fleet-shutdown-parent.ts'), mode], {
      cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', pid: number | undefined, socket: Socket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    parent.stdout!.on('data', chunk => { output += chunk; });
    parent.stderr!.on('data', chunk => { output += chunk; });
    const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      parent.once('error', reject);
      parent.once('close', (code, signal) => resolve({ code, signal }));
    });
    try {
      await waitFor(() => {
        if (parent.exitCode !== null || parent.signalCode !== null) throw new Error(`Parent startup failed: ${output}`);
        return existsSync(join(dir, 'ipc.sock'));
      }, 'parent IPC startup');
      pid = JSON.parse(readFileSync(join(dir, 'child-pid.json'), 'utf8')).pid;
      expect(Number.isSafeInteger(pid) && pid! > 0).toBe(true);
      expect(alive(pid!)).toBe(true);
      socket = connect(join(dir, 'ipc.sock'));
      await new Promise<void>((resolve, reject) => {
        let buffer = '';
        socket!.setEncoding('utf8');
        socket!.on('error', reject);
        socket!.on('data', (chunk: string) => {
          buffer += chunk;
          if (buffer.includes('"phase":"ready"')) resolve();
        });
        timer = setTimeout(() => reject(new Error('Parent ready timed out')), 3000);
      });
      clearTimeout(timer);
      socket.write('{"type":"shutdown"}\n');
      const result = await Promise.race([closed, sleep(5000).then(() => {
        const log = readFileSync(join(dir, 'headless.log'), 'utf8');
        throw new Error(`Parent exit timed out: ${log}\n${output}`);
      })]);
      expect(result.signal).toBeNull();
      expect(result.code).toBe(mode === 'timeout' ? 1 : 0);
      if (mode === 'timeout') {
        await waitFor(() => !alive(pid!), 'owned child actually died');
        expect(readFileSync(join(dir, 'headless.log'), 'utf8')).toContain('synthetic framework module shutdown deadline');
      } else {
        await sleep(100);
        expect(alive(pid!)).toBe(true);
        expect(JSON.parse(readFileSync(join(dir, 'detach-cleanup.json'), 'utf8'))).toEqual({
          exitHandler: null, context: null, socket: null,
        });
      }
    } finally {
      clearTimeout(timer);
      socket?.destroy();
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
      await closed;
      if (pid === undefined && existsSync(join(dir, 'child-pid.json'))) pid = JSON.parse(readFileSync(join(dir, 'child-pid.json'), 'utf8')).pid;
      if (pid !== undefined && alive(pid)) {
        // Bind cleanup to this exact fixture and unique launch argument before
        // signaling a detached PID; never use a broad process match.
        const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
        if (!command.includes(fixture) || !command.includes(join(dir, 'fixture-recipe.json'))) {
          throw new Error(`Refusing cleanup of changed PID ${pid}`);
        }
        process.kill(pid, 'SIGKILL');
        await waitFor(() => !alive(pid!), 'fixture cleanup death confirmed');
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
}

test('Fleet reports child cleanup failure and retains original context and exit handler for retry', async () => {
  const fleet = new FleetModule();
  const context = {} as Parameters<FleetModule['start']>[0];
  await fleet.start(context);
  const internals = fleet as any;
  const handler = internals.exitHandler;
  internals.children.set('fixture', { name: 'fixture', adopted: true });
  const error = new Error('child death unconfirmed');
  const kill = spyOn(internals, 'killChild').mockRejectedValue(error);
  try {
    await expect(fleet.stop()).rejects.toThrow('child death unconfirmed');
    expect(internals.ctx).toBe(context);
    expect(process.listeners('exit')).toContain(handler);
    kill.mockImplementation(async () => { expect(internals.ctx).toBe(context); });
    await fleet.stop();
    expect(internals.ctx).toBeNull();
    expect(process.listeners('exit')).not.toContain(handler);
  } finally {
    kill.mockRestore();
    internals.children.clear();
    await fleet.stop();
  }
});

test('Fleet waits for pending owned cleanup before reporting all original failures', async () => {
  const fleet = new FleetModule();
  const context = {} as Parameters<FleetModule['start']>[0];
  await fleet.start(context);
  const internals = fleet as any;
  const handler = internals.exitHandler;
  internals.children.set('failed', { name: 'failed', adopted: true });
  internals.children.set('pending', { name: 'pending', adopted: true });
  const first = new Error('first child death unconfirmed');
  const second = new Error('second child death unconfirmed');
  let finish!: () => void;
  const pending = new Promise<void>((_, reject) => { finish = () => reject(second); });
  const kill = spyOn(internals, 'killChild').mockImplementation((child: { name: string }) =>
    child.name === 'failed' ? Promise.reject(first) : pending);
  let settled = false;
  const stopped = fleet.stop().then(() => { settled = true; return null; }, error => { settled = true; return error; });
  try {
    await sleep(10);
    expect(settled).toBe(false);
    expect(internals.ctx).toBe(context);
    expect(process.listeners('exit')).toContain(handler);
    finish();
    const failure = await stopped;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([first, second]);
    expect(failure.errors[0]).toBe(first);
    expect(failure.errors[1]).toBe(second);
    expect(internals.ctx).toBe(context);
    expect(process.listeners('exit')).toContain(handler);
  } finally {
    finish();
    await stopped;
    kill.mockRestore();
    internals.children.clear();
    await fleet.stop();
  }
});
