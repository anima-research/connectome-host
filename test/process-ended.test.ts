/**
 * test/process-ended.ts: the rule tests share for whether a process has
 * ended as /proc shows it, which counts one being reaped as ended.
 */
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { processEnded, waitForEnd } from './process-ended.js';

const status = (state: string) => () => `Name:\tsleep\nUmask:\t0022\nState:\t${state}\nTgid:\t4242\n`;
const failing = (code: string) => () => { throw Object.assign(new Error(code), { code }); };

describe('processEnded', () => {
  test('a zombie and one being reaped have ended, and a running, sleeping or waiting one has not', () => {
    for (const [state, ended] of [
      ['Z (zombie)', true], ['X (dead)', true], ['R (running)', false], ['S (sleeping)', false], ['D (disk sleep)', false],
    ] as const) {
      expect(processEnded(4242, status(state)), state).toBe(ended);
    }
  });

  test("one whose status read fails with ESRCH, as it can while the process is reaped, has ended", () => {
    expect(processEnded(4242, failing('ESRCH'))).toBe(true);
  });

  test('with no status to read, as without /proc, the process itself says: this one runs, and one reaped has ended', async () => {
    expect(processEnded(process.pid, failing('ENOENT'))).toBe(false);
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    child.kill('SIGKILL');
    // Bun reports a child's exit once it has reaped it.
    await new Promise((exited) => child.once('exit', exited));
    expect(processEnded(child.pid!, failing('ENOENT'))).toBe(true);
  });

  test('another error reading the status is thrown, rather than read as ended', () => {
    expect(() => processEnded(4242, failing('EIO'))).toThrow('EIO');
  });

  test("a value that isn't a process id is refused, rather than read as ended", () => {
    for (const pid of [Number.NaN, 0, -1, 1.5]) expect(() => processEnded(pid)).toThrow('processEnded needs a process id');
  });
});

describe('waitForEnd', () => {
  test("answers false for a process that runs past the wait, and true for one that ends while it waits", async () => {
    const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
    try {
      expect(await waitForEnd(sleeper.pid!, 200)).toBe(false);
      const waiting = waitForEnd(sleeper.pid!, 10_000);
      await Bun.sleep(200);
      sleeper.kill('SIGKILL');
      expect(await waiting).toBe(true);
    } finally {
      sleeper.kill('SIGKILL');
    }
  });
});
