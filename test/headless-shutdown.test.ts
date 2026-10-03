import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const mode of ['healthy', 'failure', 'delayed-failure']) {
  test(`headless shutdown ${mode} reports exit status and cleans IPC artifacts`, async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-stop-')));
    const child = spawn(process.execPath, [join(import.meta.dir, 'mock-headless-shutdown-child.ts'), mode], {
      cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', socket: Socket | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    child.stdout!.on('data', chunk => { output += chunk; });
    child.stderr!.on('data', chunk => { output += chunk; });
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
      socket = connect(socketPath);
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
      timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      const result = await closed;
      clearTimeout(timer);
      expect(result.signal).toBeNull();
      expect(result.code).toBe(mode === 'healthy' ? 0 : 1);
      expect(JSON.parse(readFileSync(join(dir, 'stop-calls.json'), 'utf8'))).toEqual({ stopCalls: 1 });
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(join(dir, 'headless.pid'))).toBe(false);
      if (mode !== 'healthy') expect(readFileSync(join(dir, 'headless.log'), 'utf8')).toContain('injected framework stop failure');
    } finally {
      clearTimeout(timer);
      socket?.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
}
