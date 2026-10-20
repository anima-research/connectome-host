import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectWhenAccepting } from './ipc-connect.js';

for (const mode of ['healthy', 'failure', 'delayed-failure', 'ready-window', 'slow-log-failure', 'late-write-failure', 'stuck-log']) {
  test(`headless shutdown ${mode} reports exit status and cleans IPC artifacts`, async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-stop-')));
    const child = spawn(process.execPath, [join(import.meta.dir, 'mock-headless-shutdown-child.ts'), mode], {
      cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', stderr = '', socket: Socket | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    child.stdout!.on('data', chunk => { output += chunk; });
    child.stderr!.on('data', chunk => { output += chunk; stderr += chunk; });
    const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    try {
      const socketPath = join(dir, 'ipc.sock');
      const deadline = performance.now() + 5000;
      while (!existsSync(socketPath)) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Child failed at startup: ${output}`);
        if (performance.now() >= deadline) throw new Error(`Startup timed out: ${output}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      socket = await connectWhenAccepting(socketPath);
      await new Promise<void>((resolve, reject) => {
        let buffer = '';
        socket!.setEncoding('utf8');
        socket!.on('error', reject);
        socket!.on('data', (chunk: string) => {
          buffer += chunk;
          if (buffer.split('\n').some(line => line.includes('"phase":"ready"'))) resolve();
        });
        timer = setTimeout(() => reject(new Error('No ready event')), 3000);
      });
      clearTimeout(timer);
      // Duplicated commands must not call framework.stop twice.
      socket.write('{"type":"shutdown"}\n{"type":"shutdown"}\n');
      timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      const result = await closed;
      clearTimeout(timer);
      expect(result.signal).toBeNull();
      // A log that never finishes still lets the process exit, within the
      // 10 s the timer above allows, and the host says on its stderr that it
      // went without its last lines.
      expect(result.code).toBe(mode === 'healthy' || mode === 'ready-window' || mode === 'stuck-log' ? 0 : 1);
      // Only a log that never finishes holds the exit to the limit; every
      // other exit comes at the log's finish.
      if (mode === 'stuck-log') expect(stderr).toContain("headless.log hadn't taken its last lines after 2 s");
      else expect(stderr).not.toContain("headless.log hadn't taken its last lines");
      expect(JSON.parse(readFileSync(join(dir, 'stop-calls.json'), 'utf8'))).toEqual({ stopCalls: 1 });
      if (mode === 'ready-window') {
        expect(JSON.parse(readFileSync(join(dir, 'stop-order.json'), 'utf8'))).toEqual([
          'stop-entered', 'listen-callback', 'stop-returning',
        ]);
      }
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(join(dir, 'headless.pid'))).toBe(false);
      // On a slow disk too, the exit waits for the log to take its last line.
      // A line written after the log ended goes to the host's stderr, not to
      // the ended stream, where it would have failed the log's last lines and
      // never printed; each write's callback is answered, with no error.
      if (mode.endsWith('failure')) expect(readFileSync(join(dir, 'headless.log'), 'utf8')).toContain('injected framework stop failure');
      if (mode === 'late-write-failure') {
        const log = readFileSync(join(dir, 'headless.log'), 'utf8');
        for (const form of ['its callback second', 'after an undefined encoding', 'after utf8']) {
          expect(log).toContain(`a line written before the log ended, ${form}`);
          expect(stderr).toContain(`a line written after the log ended, ${form}`);
        }
        expect(log).toContain('a stderr line written before the log ended');
        expect(stderr).toContain('a stderr line written after the log ended');
        expect(log).not.toContain('written after the log ended');
        // The host's own log line for a client's line after the end.
        expect(stderr).toMatch(/malformed JSON line dropped \(.*\): a client line after the log ended/);
        // Each callback is answered with no error, and one of a write made
        // before the end only once headless.log holds its line.
        for (const when of ['before', 'after']) {
          for (const form of ['second', 'undefined', 'utf8', 'stderr']) {
            const file = `callback-${when}-${form}.json`;
            expect({ file, ...JSON.parse(readFileSync(join(dir, file), 'utf8')) })
              .toEqual(when === 'before' ? { file, error: null, landed: true } : { file, error: null });
          }
        }
      }
    } finally {
      clearTimeout(timer);
      socket?.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
}
