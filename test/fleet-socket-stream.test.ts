import { test, expect } from 'bun:test';
import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetModule } from '../src/modules/fleet-module.js';

// Exercise the existing connection/event owner on a real socket. Raw prefix
// receipt and decoded event completion are observed independently.
async function connectionFixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fleet-stream-')));
  const server = createServer();
  const peers: Socket[] = [];
  let closing = false;
  server.on('connection', peer => {
    peers.push(peer);
    if (closing) peer.destroy();
  });
  const fleet = new FleetModule();
  const child = { name: 'stream', socketPath: join(dir, 'ipc.sock'), socket: null as Socket | null,
    buffer: '', events: [] as any[], status: 'ready', lastEventAt: null };
  const transport = fleet as unknown as { connectChildSocket(child: unknown): Promise<void> };
  async function connect() {
    const controller = new AbortController();
    const accepted = once(server, 'connection', { signal: controller.signal });
    try {
      // Observe both promises immediately, including acceptance rejection.
      const [, [peer]] = await Promise.all([transport.connectChildSocket(child), accepted]);
      return peer as Socket;
    } finally {
      controller.abort();
    }
  }
  async function close() {
    closing = true;
    try {
      child.socket?.destroy();
      for (const socket of peers) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // Cleanup ownership exists before either setup await can reject.
  try {
    server.listen(join(dir, 'ipc.sock'));
    await once(server, 'listening');
    const peer = await connect();
    return { fleet, child, peer, connect, close };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Socket fixture setup and cleanup failed'); }
    throw error;
  }
}

// A transport callback may contain only part of a line or ordered batch.
// Completion belongs to Fleet's decoded event observation, not socket data.
function observeEvents(fleet: FleetModule) {
  const received: any[] = [];
  let progress: (() => void) | undefined;
  const off = fleet.onChildEvent('*', (_name, event) => {
    received.push(event);
    progress?.();
  });
  async function writeAndWait(count: number, write: () => void) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const complete = new Promise<void>((resolve, reject) => {
      progress = () => { if (received.length >= count) resolve(); };
      timer = setTimeout(() => reject(new Error(`Expected ${count} Fleet events, received ${received.length}`)), 3000);
      progress();
    });
    try {
      write();
      await complete;
    } finally {
      clearTimeout(timer);
      progress = undefined;
    }
  }
  return { received, writeAndWait, off };
}

// An incomplete UTF-8 byte can be received without producing decoded data.
// Observe raw receipt on a later turn, after the transport pushed those bytes.
async function writePrefix(socket: Socket, peer: Socket, prefix: Buffer) {
  const target = socket.bytesRead + prefix.length;
  const deadline = performance.now() + 3000;
  peer.write(prefix);
  while (true) {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (socket.destroyed) throw new Error('Socket closed before prefix observation');
    if (socket.bytesRead >= target) return;
    if (performance.now() >= deadline) throw new Error(`Expected ${target} socket bytes, received ${socket.bytesRead}`);
  }
}

test('Fleet preserves Unicode JSONL at every byte boundary', async () => {
  const f = await connectionFixture();
  const { received, writeAndWait, off } = observeEvents(f.fleet);
  const event = { type: 'workspace-file-snapshot', content: 'é Я 漢 𐐷 漢字', corrId: 'unicode' };
  const frame = Buffer.from(JSON.stringify(event) + '\n');
  try {
    for (let cut = 1; cut < frame.length; cut++) {
      await writePrefix(f.child.socket!, f.peer, frame.subarray(0, cut));
      expect(received).toHaveLength(cut - 1);
      await writeAndWait(cut, () => f.peer.write(frame.subarray(cut)));
      expect(received.at(-1)).toEqual(event);
      expect(received).toHaveLength(cut);
    }
    // Multiple complete lines in a single chunk retain event order.
    await writeAndWait(frame.length + 1, () => f.peer.write(Buffer.concat([frame, frame])));
    expect(received).toHaveLength(frame.length + 1);
    expect(received.slice(-2)).toEqual([event, event]);
  } finally { off(); await f.close(); }
}, 10000);

test('Fleet reconnect starts a fresh line and Unicode stream', async () => {
  const f = await connectionFixture();
  const { received, writeAndWait, off } = observeEvents(f.fleet);
  const event = { type: 'workspace-file-snapshot', content: '𐐷 fresh', corrId: 'new-stream' };
  const frame = Buffer.from(JSON.stringify(event) + '\n');
  const cut = frame.indexOf(Buffer.from('𐐷')) + 1;
  try {
    const old = f.child.socket!;
    await writePrefix(old, f.peer, frame.subarray(0, cut));
    expect(received).toHaveLength(0);
    old.destroy();
    const peer = await f.connect();
    await writeAndWait(1, () => peer.write(frame));
    expect(received).toEqual([event]);
  } finally { off(); await f.close(); }
}, 10000);

// Start with an empty old buffer so stale callbacks cannot be hidden by an
// invalid concatenated frame from the separate reconnect-reset regression.
test('Fleet ignores data from a superseded socket', async () => {
  const f = await connectionFixture();
  const { received, writeAndWait, off } = observeEvents(f.fleet);
  const event = { type: 'workspace-file-snapshot', content: '𐐷 fresh', corrId: 'active-stream' };
  try {
    const old = f.child.socket!;
    expect(f.child.buffer).toBe('');
    old.destroy();
    const peer = await f.connect();
    old.emit('data', JSON.stringify({ ...event, corrId: 'stale-stream' }) + '\n');
    expect(received).toHaveLength(0);
    await writeAndWait(1, () => peer.write(JSON.stringify(event) + '\n'));
    expect(received).toEqual([event]);
  } finally { off(); await f.close(); }
}, 10000);
