/** Bounded diagnostics and cleanup for Linux fake children, never a host/UID scan. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connectWhenAccepting } from './ipc-connect.js';

export const FIXTURE_OUTPUT_LIMIT = 16_384;
const startTime = (pid: number): string | undefined => {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
};

export function ownedFixtureChild(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; ipc?: boolean } = {}) {
  const { ipc, ...spawnOptions } = options;
  const child = spawn(process.execPath, args, { ...spawnOptions, stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
  const started = child.pid === undefined ? undefined : startTime(child.pid);
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), spawnError: Error | undefined, stdoutOverflow = false;
  const tail = (previous: Buffer, chunk: Buffer) => Buffer.from(Buffer.concat([previous, chunk]).subarray(-FIXTURE_OUTPUT_LIMIT));
  child.stdout!.on('data', chunk => {
    stdoutOverflow ||= stdout.length + chunk.length > FIXTURE_OUTPUT_LIMIT;
    stdout = tail(stdout, chunk);
  });
  child.stderr!.on('data', chunk => { stderr = tail(stderr, chunk); });
  const closed = new Promise<{ code: number | null; signal: string | null }>(resolve => {
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const diagnostics = () => `fixture pid=${child.pid ?? 'unspawned'} exit=${child.exitCode} signal=${child.signalCode}` +
    `${spawnError ? ` spawn=${String(spawnError)}` : ''}\nstderr tail (${stderr.length} bytes):\n${stderr.toString()}`;
  const assertRunning = () => {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) throw Error('Child exited during startup');
  };
  const waitClosed = (timeoutMs: number): Promise<boolean> => new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void closed.then(() => { clearTimeout(timer); resolve(true); });
  });
  const signalOwned = (signal: NodeJS.Signals) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    const current = startTime(child.pid);
    if (current === undefined) return; // Already exited; wait for our ChildProcess to reap it.
    if (started === undefined || current !== started) throw Error(`Refusing to signal unverified fixture pid=${child.pid}`);
    child.kill(signal);
  };
  return {
    child, closed, diagnostics,
    stdout: () => {
      if (stdoutOverflow) throw Error(`Fixture stdout exceeded ${FIXTURE_OUTPUT_LIMIT} bytes; refusing truncated command output`);
      return stdout.toString();
    }, stderr: () => stderr.toString(),
    async connect(path: string, timeoutMs = 8_000) {
      try {
        assertRunning();
        const socket = await connectWhenAccepting(path, { timeoutMs, onFailedConnect: assertRunning });
        try { assertRunning(); } catch (error) { socket.destroy(); throw error; }
        return socket;
      } catch (error) { throw Error(`Fixture socket startup failed at ${path}: ${String(error)}\n${diagnostics()}`); }
    },
    async stop(crash = false) {
      signalOwned(crash ? 'SIGKILL' : 'SIGTERM');
      if (await waitClosed(1_500)) return;
      signalOwned('SIGKILL');
      if (!await waitClosed(1_500)) throw Error(`Fixture did not close after owned-PID cleanup: ${diagnostics()}`);
    },
    async result(timeoutMs = 8_000) {
      if (!await waitClosed(timeoutMs)) throw Error(`Fixture exit deadline: ${diagnostics()}`);
      return closed;
    },
  };
}
export type OwnedFixtureChild = ReturnType<typeof ownedFixtureChild>;
