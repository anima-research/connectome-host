import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectWhenAccepting } from './ipc-connect.js';
import type { Socket } from 'node:net';

for (const mode of ['normal', 'interactive-window', 'control-window', 'replaced-claim']) for (const via of ['command', 'SIGTERM', 'SIGINT'] as const) {
  test(`shutdown ${via} ${mode}: optional startup cannot outlive stop or clean a replaced claim`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'control-start-'));
    const child = spawn(process.execPath, [new URL('./mock-headless-control-start-child.ts', import.meta.url).pathname, mode], {
      cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', socket: Socket | undefined;
    child.stdout!.on('data', chunk => { output = (output + chunk).slice(-16_384); });
    child.stderr!.on('data', chunk => { output = (output + chunk).slice(-16_384); });
    const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const startTime = () => readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
    const started = startTime();
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null && startTime() === started) child.kill('SIGKILL');
    }, 5_000);
    try {
      const end = Date.now() + 3_000;
      const marker = join(dir, mode === 'normal' ? 'q/s' : 'held');
      while (!existsSync(marker)) {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() > end) throw Error(`startup failed: ${output}`);
        await Bun.sleep(10);
      }
      if (via === 'command') {
        socket = await connectWhenAccepting(join(dir, 'ipc.sock'));
        socket.write('{"type":"shutdown"}\n{"type":"shutdown"}\n');
      } else {
        expect(startTime()).toBe(started);
        child.kill(via);
      }
      expect(await closed).toEqual({ code: 0, signal: null });
      const remaining = mode === 'replaced-claim';
      const stopped = { socket: remaining, claim: remaining, listening: false, aliases: 0, controlFDs: 0 };
      expect(JSON.parse(readFileSync(join(dir, 'stopped.json'), 'utf8'))).toEqual({ stopCalls: 1, before: stopped, after: stopped });
      expect(existsSync(join(dir, 'q/s'))).toBe(remaining);
      expect(existsSync(join(dir, 'q/owner.json'))).toBe(remaining);
      expect(existsSync(join(dir, 'ipc.sock'))).toBe(false);
      expect(existsSync(join(dir, 'headless.pid'))).toBe(false);
      if (remaining) expect(JSON.parse(readFileSync(join(dir, 'preserved.json'), 'utf8'))).toEqual({ socket: 'unknown endpoint', claim: 'unknown claim' });
    } finally {
      clearTimeout(timer); socket?.destroy();
      if (child.exitCode === null && child.signalCode === null) { expect(startTime()).toBe(started); child.kill('SIGKILL'); }
      await closed; rmSync(dir, { recursive: true, force: true });
    }
  }, 7_000);
}
