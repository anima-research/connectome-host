/**
 * The Web UI's socket wrapper says whether a frame went out (web/src/wire.ts),
 * so the composer keeps a message the socket didn't take.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { createWireClient, type WireClient } from '../web/src/wire.js';

const frames: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
  },
  websocket: {
    message(_ws, data) { frames.push(String(data)); },
  },
});

let client: WireClient | null = null;
afterEach(() => { client?.close(); client = null; frames.length = 0; });

const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await Bun.sleep(5);
  }
};

describe('wire.send', () => {
  test('is false, and sends nothing, before the socket is open', () => {
    client = createWireClient({ url: `ws://127.0.0.1:${server.port}/ws` });
    expect(client.status()).toBe('connecting');
    expect(client.send({ type: 'ping' })).toBe(false);
  });

  test('is true once the socket is open, and the frame arrives', async () => {
    client = createWireClient({ url: `ws://127.0.0.1:${server.port}/ws` });
    await until(() => client!.status() === 'open');
    expect(client.send({ type: 'ping' })).toBe(true);
    await until(() => frames.length === 1);
    expect(JSON.parse(frames[0]!)).toEqual({ type: 'ping' });
  });

  test('is false after the connection is gone', async () => {
    client = createWireClient({ url: `ws://127.0.0.1:${server.port}/ws`, initialDelayMs: 60_000 });
    await until(() => client!.status() === 'open');
    server.stop(true);
    await until(() => client!.status() === 'reconnecting');
    expect(client.send({ type: 'ping' })).toBe(false);
  });
});
