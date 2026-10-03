import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

// Observe the actual server socket without replacing its decoder or listeners.
// Each acknowledgment follows raw receipt on a later event-loop turn.
const preload = `
import { Server } from 'node:net';
import { join } from 'node:path';
let peer;
const originalEmit = Server.prototype.emit;
Server.prototype.emit = function (event, ...args) {
  if (event === 'connection' && this.address() === join(process.env.DATA_DIR, 'ipc.sock')) {
    peer = args[0];
    Server.prototype.emit = originalEmit;
  }
  return originalEmit.call(this, event, ...args);
};
process.on('message', ({ target }) => {
  const deadline = performance.now() + 3000;
  function observe() {
    if (!peer || peer.destroyed) throw new Error('No active server socket');
    if (peer.bytesRead >= target) { process.send({ target }); return; }
    if (performance.now() >= deadline) throw new Error('Raw prefix receipt timed out');
    setImmediate(observe);
  }
  setImmediate(observe);
});
`;

test('production headless receiver preserves Unicode commands at every byte boundary', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-stream-')));
  let socket: Socket | undefined;
  let failure: Error | undefined;
  let closing = false;
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<void> | undefined;
  const acknowledged = new Set<number>();
  const snapshots: Array<Record<string, unknown>> = [];
  async function waitFor(check: () => boolean, label: string, timeout = 3000) {
    const deadline = performance.now() + timeout;
    while (true) {
      if (failure) throw failure;
      if (check()) return;
      if (performance.now() >= deadline) throw new Error(`Timed out: ${label}`);
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
  }
  // Cleanup owns all resources before setup awaits, including startup failure.
  try {
    const recipePath = join(dir, 'recipe.json');
    const preloadPath = join(dir, 'observe.ts');
    const socketPath = join(dir, 'ipc.sock');
    writeFileSync(recipePath, JSON.stringify({
      name: 'Unicode transport test',
      agent: { name: 'commander', provider: 'mock', model: 'mock', systemPrompt: 'Transport test' },
      modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
    }));
    writeFileSync(preloadPath, preload);
    child = spawn(process.execPath, ['--preload', preloadPath, join(root, 'src/index.ts'), recipePath, '--headless'], {
      cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child.on('error', error => { failure = error; });
    closed = new Promise<void>(resolve => child!.once('close', (code, signal) => {
      if (!closing) failure = new Error(`Headless child exited: code=${code}, signal=${signal}`);
      resolve();
    }));
    child.on('message', message => {
      try {
        if (!message || typeof message !== 'object' || Array.isArray(message) ||
            !Number.isSafeInteger((message as { target?: unknown }).target) ||
            (message as { target: number }).target < 0) throw new Error('Malformed raw-byte IPC acknowledgment');
        acknowledged.add((message as { target: number }).target);
      } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
    });
    await waitFor(() => existsSync(socketPath), 'headless startup', 15000);
    socket = connect(socketPath);
    socket.on('error', error => { failure = error; });
    socket.setEncoding('utf8');
    let buffer = '';
    let ready = false;
    socket.on('data', (chunk: string) => {
      try {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const event = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Malformed headless event');
          if (event.type === 'lifecycle' && event.phase === 'ready') ready = true;
          if (event.type === 'snapshot') snapshots.push(event);
        }
      } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
    });
    await waitFor(() => ready, 'ready event');
    const corrId = 'é Я 漢 𐐷\nsecond line';
    const frame = Buffer.from(JSON.stringify({ type: 'describe', corrId }) + '\n');
    let written = 0;
    const splitWidths = new Set<number>();
    for (let cut = 1; cut < frame.length; cut++) {
      // Record continuation-byte cuts to verify 2/3/4-byte coverage.
      if ((frame[cut]! & 0xc0) === 0x80) {
        let start = cut - 1;
        while ((frame[start]! & 0xc0) === 0x80) start--;
        const lead = frame[start]!;
        splitWidths.add(lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4);
      }
      socket.write(frame.subarray(0, cut));
      written += cut;
      child.send({ target: written });
      await waitFor(() => acknowledged.has(written), 'server raw prefix receipt');
      expect(snapshots).toHaveLength(cut - 1);
      socket.write(frame.subarray(cut));
      written += frame.length - cut;
      await waitFor(() => snapshots.length >= cut, 'describe snapshot');
      expect(snapshots).toHaveLength(cut);
      expect(snapshots.at(-1)!.corrId).toBe(corrId);
    }
    expect([...splitWidths].sort()).toEqual([2, 3, 4]);
    const batch = ['é first', '漢 second', '𐐷 third'];
    socket.write(batch.map(corrId => JSON.stringify({ type: 'describe', corrId }) + '\n').join(''));
    await waitFor(() => snapshots.length >= frame.length - 1 + batch.length, 'ordered batch');
    expect(snapshots).toHaveLength(frame.length - 1 + batch.length);
    expect(snapshots.slice(-batch.length).map(event => event.corrId)).toEqual(batch);
  } finally {
    closing = true;
    socket?.destroy();
    if (child && closed) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (child!.exitCode === null && child!.signalCode === null) child!.kill('SIGKILL');
      }, 3000);
      try { await closed; } finally { clearTimeout(timer); }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
