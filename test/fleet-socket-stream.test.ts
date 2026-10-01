import { test, expect } from 'bun:test';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetModule } from '../src/modules/fleet-module.js';

// Exercise the existing connection/event owner on a real socket. Waiting for
// the first data callback forces a byte split instead of relying on OS timing.
async function connectionFixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-stream-')));
  const server = createServer();
  server.listen(join(dir, 'ipc.sock'));
  await once(server, 'listening');
  const peers: Socket[] = [];
  server.on('connection', peer => peers.push(peer));
  const fleet = new FleetModule();
  const child = { name: 'stream', socketPath: join(dir, 'ipc.sock'), socket: null as Socket | null,
    buffer: '', events: [] as any[], status: 'ready', lastEventAt: null };
  const transport = fleet as unknown as { connectChildSocket(child: unknown): Promise<void> };
  async function connect() {
    const accepted = once(server, 'connection');
    await transport.connectChildSocket(child);
    const [peer] = await accepted;
    return peer as Socket;
  }
  const peer = await connect();
  async function close() {
    child.socket?.destroy();
    for (const socket of peers) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
  return { fleet, child, peer, connect, close };
}

test('Fleet preserves Unicode JSONL at every byte boundary', async () => {
  const f = await connectionFixture();
  const received: any[] = [];
  const off = f.fleet.onChildEvent('*', (_name, event) => received.push(event));
  const event = { type: 'workspace-file-snapshot', content: 'é Я ─ 😀 漢字', corrId: 'unicode' };
  const frame = Buffer.from(JSON.stringify(event) + '\n');
  try {
    for (let cut = 1; cut < frame.length; cut++) {
      const first = once(f.child.socket!, 'data');
      f.peer.write(frame.subarray(0, cut));
      await first;
      expect(received).toHaveLength(cut - 1);
      const rest = once(f.child.socket!, 'data');
      f.peer.write(frame.subarray(cut));
      await rest;
      expect(received.at(-1)).toEqual(event);
      expect(received).toHaveLength(cut);
    }
    // Multiple complete lines in a single chunk retain event order.
    const batch = once(f.child.socket!, 'data');
    f.peer.write(Buffer.concat([frame, frame]));
    await batch;
    expect(received.slice(-2)).toEqual([event, event]);
  } finally { off(); await f.close(); }
}, 10000);

test('Fleet reconnect starts a fresh line and Unicode stream', async () => {
  const f = await connectionFixture();
  const received: any[] = [];
  const off = f.fleet.onChildEvent('*', (_name, event) => received.push(event));
  const event = { type: 'workspace-file-snapshot', content: '😀 fresh', corrId: 'new-stream' };
  const frame = Buffer.from(JSON.stringify(event) + '\n');
  const cut = frame.indexOf(Buffer.from('😀')) + 1;
  try {
    const old = f.child.socket!;
    const first = once(old, 'data');
    f.peer.write(frame.subarray(0, cut));
    await first;
    expect(received).toHaveLength(0);
    old.destroy();
    const peer = await f.connect();
    old.emit('data', JSON.stringify({ ...event, corrId: 'old-stream' }) + '\n');
    expect(received).toHaveLength(0);
    const next = once(f.child.socket!, 'data');
    peer.write(frame);
    await next;
    expect(received).toEqual([event]);
  } finally { off(); await f.close(); }
}, 10000);
