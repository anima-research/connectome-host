import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { type Socket } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectWhenAccepting } from './ipc-connect.js';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

for (const mode of ['same-client', 'replacement', 'disconnect-and-reconnect'] as const) {
  test(`a pending request's answer reaches only the client that asked: ${mode}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'headless-command-owner-'));
    const sockets: Socket[] = [];
    const child = spawn(process.execPath, [new URL('./mock-headless-command-child.ts', import.meta.url).pathname], {
      env: { ...process.env, DATA_DIR: dir }, stdio: 'ignore',
    });
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const open = async () => {
      const socket = await connectWhenAccepting(join(dir, 'ipc.sock'));
      sockets.push(socket);
      const events: Array<Record<string, unknown>> = [];
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.trim()) events.push(JSON.parse(line));
        }
      });
      await until(() => events.some(event => event.type === 'lifecycle' && event.phase === 'ready'), 'ready');
      const send = (command: object) => socket.write(JSON.stringify(command) + '\n');
      const answered = (corrId: string) => events.some(event => event.corrId === corrId);
      send({ type: 'subscribe', events: [] });
      return { socket, events, send, answered };
    };
    try {
      await until(() => existsSync(join(dir, 'ipc.sock')), 'socket');
      const first = await open();
      first.send({ type: 'request-workspace-tree', corrId: 'pending', mount: '/m' });
      await until(() => existsSync(join(dir, 'started')), 'request started');

      let active = first;
      if (mode !== 'same-client') {
        if (mode === 'disconnect-and-reconnect') first.socket.destroy();
        active = await open();
        active.send({ type: 'describe', corrId: 'replacement-ready' });
        await until(() => active.answered('replacement-ready'), 'replacement subscribed');
      }
      writeFileSync(join(dir, 'release'), 'go');
      await until(() => existsSync(join(dir, 'done')), 'pending request settled');
      active.send({ type: 'describe', corrId: 'barrier' });
      await until(() => active.answered('barrier'), 'ordered reply after result');
      const carriesResult = (event: Record<string, unknown>) => JSON.stringify(event).includes('ORIGINAL-CALLER-RESULT');
      if (mode === 'same-client') expect(active.events.some(event => event.corrId === 'pending' && carriesResult(event))).toBe(true);
      else expect(active.events.some(carriesResult)).toBe(false);
      const log = () => readFileSync(join(dir, 'headless.log'), 'utf8');
      const droppedReply = 'reply dropped: workspace-tree-snapshot, requester superseded/closed';
      if (mode !== 'same-client') {
        await until(() => log().includes(droppedReply), 'dropped-reply diagnostic');
        expect(log()).not.toContain('ORIGINAL-CALLER-RESULT');
      } else {
        expect(log()).not.toContain(droppedReply);
      }
    } finally {
      for (const socket of sockets) socket.destroy();
      if (!exited()) child.kill('SIGTERM');
      try { await until(exited, 'child shutdown'); }
      catch { child.kill('SIGKILL'); await until(exited, 'child forced shutdown'); }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
}
