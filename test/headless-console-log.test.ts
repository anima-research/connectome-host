import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectWhenAccepting } from './ipc-connect.js';

test('a headless host writes its console.error and console.warn lines to headless.log, and still prints them for its supervisor', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-console-')));
  const child = spawn(process.execPath, [join(import.meta.dir, 'mock-headless-console-child.ts')], {
    cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', stderr = '', socket: Socket | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  child.stdout!.on('data', (chunk) => { output += chunk; });
  child.stderr!.on('data', (chunk) => { output += chunk; stderr += chunk; });
  const closed = new Promise<{ code: number | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code }));
  });
  try {
    const socketPath = join(dir, 'ipc.sock');
    const deadline = performance.now() + 5000;
    while (!existsSync(socketPath)) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Child failed at startup: ${output}`);
      if (performance.now() >= deadline) throw new Error(`Startup timed out: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    socket = await connectWhenAccepting(socketPath);
    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      socket!.setEncoding('utf8');
      socket!.on('error', reject);
      socket!.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.split('\n').some((line) => line.includes('"phase":"ready"'))) resolve();
      });
      timer = setTimeout(() => reject(new Error('No ready event')), 3000);
    });
    clearTimeout(timer);
    await new Promise((resolve) => setTimeout(resolve, 300));
    socket.write('{"type":"shutdown"}\n');
    timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const result = await closed;
    clearTimeout(timer);
    expect(result.code).toBe(0);
    const log = readFileSync(join(dir, 'headless.log'), 'utf8');
    expect(log).toContain('[probe] zz-console-error line 1\n');
    expect(log).toContain('[probe] zz-console-warn line\n');
    // The supervisor (journald, or a fleet parent's startup.log) still gets them.
    expect(stderr).toContain('[probe] zz-console-error line 1');
    expect(stderr).toContain('[probe] zz-console-warn line');
  } finally {
    clearTimeout(timer);
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
