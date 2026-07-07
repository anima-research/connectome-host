/**
 * Unit tests for the shared shutdown primitives (fragility audit, Group 1).
 *
 * These are the pieces that make SIGTERM/Ctrl+C survivable everywhere:
 *  - stopWithDeadline: a hung framework.stop() resolves as 'timed-out'
 *    instead of parking the process forever (1.3 / 1.6);
 *  - createSignalHandler: second signal force-exits instead of being
 *    swallowed by the shutting-down guard (1.3);
 *  - readAlivePid: PID-file liveness probe behind the headless
 *    double-start refusal (1.2).
 */
import { describe, test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSignalHandler, readAlivePid, stopWithDeadline } from '../src/shutdown.js';

describe('stopWithDeadline', () => {
  test('resolves "stopped" when stop() completes in time', async () => {
    const outcome = await stopWithDeadline(async () => { /* immediate */ }, 1_000);
    expect(outcome).toBe('stopped');
  });

  test('resolves "timed-out" when stop() never resolves', async () => {
    const started = Date.now();
    const outcome = await stopWithDeadline(
      () => new Promise<void>(() => { /* hangs forever */ }),
      100,
    );
    expect(outcome).toBe('timed-out');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('resolves "stop-failed" (never rejects) when stop() rejects', async () => {
    const logs: string[] = [];
    const outcome = await stopWithDeadline(
      () => Promise.reject(new Error('boom')),
      1_000,
      (m) => logs.push(m),
    );
    expect(outcome).toBe('stop-failed');
    expect(logs.some((l) => l.includes('boom'))).toBe(true);
  });
});

describe('createSignalHandler', () => {
  test('first signal → graceful path; second signal → force path', () => {
    const calls: string[] = [];
    const handler = createSignalHandler({
      onFirstSignal: (sig) => calls.push(`first:${sig}`),
      onSecondSignal: (sig) => calls.push(`second:${sig}`),
    });
    handler('SIGTERM');
    handler('SIGTERM');
    handler('SIGINT');
    expect(calls).toEqual(['first:SIGTERM', 'second:SIGTERM', 'second:SIGINT']);
  });
});

describe('readAlivePid', () => {
  test('returns null for missing file, garbage content, and own pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fkm-pid-'));
    try {
      expect(readAlivePid(join(dir, 'nope.pid'))).toBeNull();

      const garbagePath = join(dir, 'garbage.pid');
      writeFileSync(garbagePath, 'not-a-pid');
      expect(readAlivePid(garbagePath)).toBeNull();

      // Own pid is the normal "we just wrote our own pid file" case — must
      // not be treated as a conflicting instance.
      const ownPath = join(dir, 'own.pid');
      writeFileSync(ownPath, String(process.pid));
      expect(readAlivePid(ownPath)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns the pid for a live process, null after it exits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fkm-pid-'));
    try {
      const child = spawn('sleep', ['30'], { stdio: 'ignore' });
      const pidPath = join(dir, 'child.pid');
      writeFileSync(pidPath, String(child.pid));

      expect(readAlivePid(pidPath)).toBe(child.pid!);

      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      // Give the OS a beat to reap.
      await new Promise((r) => setTimeout(r, 50));
      expect(readAlivePid(pidPath)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
