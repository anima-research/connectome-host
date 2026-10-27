import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Receipt {
  status: string;
  stopCalls: number;
  switchedStopCalls: number;
  traceDetached: number;
  followedAfterStop: number;
  detachedAtStop: number | null;
  switchedDetachedAtStop: number | null;
  serverStops: number;
  activeAfterStop: number;
  settledBeforeSwitch: boolean | null;
  destroyed: boolean;
  unhandled: boolean;
  originalError: boolean;
}

const KILL_AFTER_MS = 45_000;

async function spawnChild(mode: string, control: string): Promise<{ stdout: string; code: number | null; signal: string | null; stderr: string; log: string }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tui-shutdown-')));
  const child = spawn(process.execPath, [join(import.meta.dir, 'mock-tui-shutdown-child.ts'), mode, control], {
    cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout!.on('data', chunk => { stdout += chunk; });
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS);
  try {
    const { code, signal } = await closed;
    const logPath = join(dir, 'tui-error.log');
    return { stdout, code, signal, stderr, log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '' };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runChild(mode: string, control: string): Promise<{ receipt: Receipt; code: number | null; signal: string | null; stdout: string; stderr: string; log: string }> {
  const { stdout, code, signal, stderr, log } = await spawnChild(mode, control);
  const match = stdout.match(/TUI_RESULT (\{[^\n]+\})/);
  if (!match) throw new Error(`No TUI result (code ${code}, signal ${signal}): ${stderr.replace(/[^\x20-\x7e\r\n\t]/g, '')}`);
  return { receipt: JSON.parse(match[1]) as Receipt, code, signal, stdout, stderr, log };
}

const terminalLines = (log: string) => log.split('\n').filter(line => line.startsWith('terminal failed'));
const stoppingLines = (log: string) => log.split('\n').filter(line => line.startsWith('stopping:'));

const STOPPED_ONCE = {
  stopCalls: 1, switchedStopCalls: 0, traceDetached: 1, followedAfterStop: 0, detachedAtStop: 1, switchedDetachedAtStop: null,
  serverStops: 0, activeAfterStop: 0, modulesReadAfterStop: 0, settledBeforeSwitch: null, destroyed: true, unhandled: false,
};

for (const control of ['ctrl-c', 'quit', 'SIGTERM', 'SIGINT', 'SIGHUP']) {
  for (const mode of ['healthy', 'failure', 'delayed-failure']) {
    test(`TUI ${control} shutdown ${mode} settles after terminal cleanup`, async () => {
      const { receipt, code, signal, stderr, log } = await runChild(mode, control);
      expect(receipt).toEqual({
        ...STOPPED_ONCE,
        status: mode === 'healthy' ? 'fulfilled' : 'rejected',
        originalError: mode !== 'healthy',
      });
      expect(signal).toBeNull();
      expect(code).toBe(mode === 'healthy' ? 0 : 1);
      if (mode !== 'healthy') expect(stderr).toContain('injected Fleet cleanup failure');
      expect([...terminalLines(log), ...stoppingLines(log)]).toEqual([]);
    }, 60_000);
  }
}

for (const [control, line] of [
  ['stdout-error', 'terminal failed (write EIO): stopping as /quit does'],
  ['stdin-error', 'terminal failed (write EIO): stopping as /quit does'],
  ['two-errors', 'terminal failed (setRawMode failed with errno: 5): stopping as /quit does'],
]) {
  test(`TUI ${control} stops the framework once, and the log names the first error`, async () => {
    const { receipt, code, signal, log } = await runChild('healthy', control);
    expect(receipt).toEqual({ ...STOPPED_ONCE, status: 'fulfilled', originalError: false });
    expect(terminalLines(log)).toEqual([line]);
    expect({ code, signal }).toEqual({ code: 0, signal: null });
  }, 60_000);
}

for (const [control, line] of [
  ['title-throws', 'stopping: resetting the title failed (injected title write failure); the stop goes on'],
  ['detach-throws', 'stopping: ending the trace subscription failed (injected trace detach failure); the stop goes on'],
]) {
  test(`TUI ${control} logs the failed step, and still stops the framework once`, async () => {
    const { receipt, code, signal, log } = await runChild('healthy', control);
    expect(receipt).toEqual({ ...STOPPED_ONCE, status: 'fulfilled', originalError: false });
    expect(stoppingLines(log)).toEqual([line]);
    expect({ code, signal }).toEqual({ code: 0, signal: null });
  }, 60_000);
}

test('a terminal error once the stop has settled, after the log has ended, is swallowed and writes nothing', async () => {
  const { receipt, code, signal, log } = await runChild('healthy', 'late-error');
  expect(receipt).toEqual({ ...STOPPED_ONCE, status: 'fulfilled', originalError: false });
  expect(terminalLines(log)).toEqual([]);
  expect({ code, signal }).toEqual({ code: 0, signal: null });
}, 60_000);

test("the TUI settles only once its log has its last lines, so a host that exits at once after a failed stop keeps them", async () => {
  const { code, signal, stderr, log } = await spawnChild('failure', 'exit-at-once');
  expect(stderr).toContain('injected Fleet cleanup failure');
  expect(stoppingLines(log)).toEqual(['stopping: resetting the title failed (injected title write failure); the stop goes on']);
  expect({ code, signal }).toEqual({ code: 1, signal: null });
}, 60_000);

test('a terminal error that comes once a signal has started the stop gets its line too', async () => {
  const { receipt, code, signal, log } = await runChild('slow', 'error-during-stop');
  expect(receipt).toEqual({ ...STOPPED_ONCE, status: 'fulfilled', originalError: false });
  expect(terminalLines(log)).toEqual(['terminal failed (write EIO): stopping as /quit does']);
  expect({ code, signal }).toEqual({ code: 0, signal: null });
}, 60_000);

for (const second of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  test(`a second stop signal, ${second}, while the framework stops joins the stop`, async () => {
    const { receipt, code, signal } = await runChild('slow', `SIGTERM-then-${second}`);
    expect(receipt).toEqual({ ...STOPPED_ONCE, status: 'fulfilled', originalError: false });
    expect({ code, signal }).toEqual({ code: 0, signal: null });
  }, 60_000);
}

test('a command whose work answers once the stop has begun draws nothing, and nothing throws', async () => {
  const { receipt, code, signal, stdout } = await runChild('healthy', 'late-command');
  expect(stdout).toContain('LATE_COMMAND_ANSWERED');
  expect(receipt).toEqual({ ...STOPPED_ONCE, status: 'fulfilled', originalError: false });
  expect({ code, signal }).toEqual({ code: 0, signal: null });
}, 60_000);

for (const mode of ['healthy', 'failure']) {
  test(`once a ${mode === 'healthy' ? 'clean' : 'failed'} stop has settled, a stop signal ends a host that something else keeps running`, async () => {
    const { stdout, code, signal } = await spawnChild(mode, 'linger');
    expect(stdout).toContain('TUI_SETTLED');
    expect({ code, signal }).toEqual({ code: null, signal: 'SIGTERM' });
  }, 60_000);
}

test("a stop during a session switch doesn't wait for it, and the switch stops what it made", async () => {
  const { receipt, code, signal, log } = await runChild('healthy', 'switch');
  expect(receipt).toEqual({
    status: 'fulfilled',
    settledBeforeSwitch: true,
    stopCalls: 1, detachedAtStop: 1, traceDetached: 1,
    switchedStopCalls: 1, switchedDetachedAtStop: 1, serverStops: 1, followedAfterStop: 0, activeAfterStop: 0, modulesReadAfterStop: 0,
    destroyed: true, unhandled: false, originalError: false,
  });
  expect(stoppingLines(log)).toEqual([]);
  expect({ code, signal }).toEqual({ code: 0, signal: null });
}, 60_000);
