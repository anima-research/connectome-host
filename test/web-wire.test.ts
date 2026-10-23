/**
 * The page's wire (web/src/wire.ts): what it takes the page's observer
 * sign-in to be, connection by connection. The host acks an observer before
 * its welcome, so a welcome on a socket that got no observer-ack is a full
 * client's, a refused connection holds no grant, and a sign-in that finishes
 * after its connection closed leaves the next connection's state alone. A
 * scripted host stands in for the real one, as the page's own browser runs do.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createWireClient, type WireClient } from '../web/src/wire.js';

type Socket = { send(data: string): void; close(code?: number): void };

// The observer-ack stores the page's session cookie, which a page keeps in
// its document; this stands in for it.
(globalThis as { document?: { cookie: string } }).document ??= { cookie: '' };

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

type Host = { ack: { scopes: string[] } | null; signIn: string | null; sockets: Set<Socket> };

/** A page's wire to a host that asks each connection to sign in as an
 *  observer for `host.signIn` while that's set, and sends it nothing more, as
 *  the real host does until a hello. Otherwise the host acks each connection
 *  as an observer granted `host.ack.scopes` while `host.ack` is set, and
 *  welcomes it either way. */
function connect(ack: { scopes: string[] } | null, signIn: string | null = null): { host: Host; wire: WireClient } {
  const host: Host = { ack, signIn, sockets: new Set<Socket>() };
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('no', { status: 400 })),
    websocket: {
      open(ws) {
        host.sockets.add(ws);
        if (host.signIn !== null) {
          ws.send(JSON.stringify({ type: 'observer-auth-required', host: host.signIn }));
          return;
        }
        if (host.ack) ws.send(JSON.stringify({ type: 'observer-ack', scopes: host.ack.scopes, sessionToken: 'a'.repeat(64), label: 'probe' }));
        ws.send(JSON.stringify({ type: 'welcome' }));
      },
      message() {},
      close(ws) { host.sockets.delete(ws); },
    },
  });
  const wire = createWireClient({ url: `ws://127.0.0.1:${server.port}/ws`, initialDelayMs: 10, maxDelayMs: 20 });
  cleanups.push(() => server.stop(true), () => wire.close());
  return { host, wire };
}

async function until(what: string, ok: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

describe("the page's wire", () => {
  test("a page that signed in as an observer and reconnects as a full client forgets the observer's grant", async () => {
    const { host, wire } = connect({ scopes: ['messages'] });
    await until('the observer sign-in', () => wire.observerState() === 'observer');
    expect(wire.observer()).toEqual({ label: 'probe', scopes: ['messages'] });

    host.ack = null;
    for (const ws of host.sockets) ws.close();
    await until("the full client's welcome", () => wire.observerState() === 'none');
    expect(wire.observer()).toBeNull();
  });

  test('an observer that reconnects and is acked again stays an observer, with the new grant', async () => {
    const { host, wire } = connect({ scopes: ['messages'] });
    await until('the observer sign-in', () => wire.observerState() === 'observer');

    host.ack = { scopes: ['messages', 'tools'] };
    for (const ws of host.sockets) ws.close();
    await until('the second grant', () => (wire.observer()?.scopes.length ?? 0) === 2);
    expect(wire.observerState()).toBe('observer');
  });

  test('a connection the host refuses (4401) leaves the page with no grant', async () => {
    const { host, wire } = connect({ scopes: ['messages', 'thinking', 'tools', 'health', 'ops'] });
    await until('the observer sign-in', () => wire.observerState() === 'observer');

    for (const ws of host.sockets) ws.close(4401);
    await until('the refusal', () => wire.observerState() === 'denied');
    expect(wire.observer()).toBeNull();
  });

  test("a sign-in that finishes after its connection closed leaves the next connection's state alone", async () => {
    // The page keeps its device key in IndexedDB, which bun doesn't have. This
    // stand-in holds the key's opening until the test fails it, so the first
    // connection's sign-in finishes, with no key, once the next connection has
    // been welcomed.
    const opening: { fail?: () => void } = {};
    const scope = globalThis as { indexedDB?: unknown };
    scope.indexedDB = {
      open() {
        const request: { error?: Error; onerror?: () => void } = {};
        opening.fail = () => { request.error = new Error('no key'); request.onerror?.(); };
        return request;
      },
    };
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    cleanups.push(() => { delete scope.indexedDB; }, () => warn.mockRestore());

    const { host, wire } = connect(null, 'probe.test');
    await until('the sign-in to begin', () => opening.fail !== undefined);
    expect(wire.observerState()).toBe('authing');

    host.signIn = null;
    for (const ws of host.sockets) ws.close();
    await until("the full client's welcome", () => wire.observerState() === 'none');

    opening.fail!();
    // What's left of that sign-in is promise steps, all run before a timer fires.
    await Bun.sleep(10);
    expect(warn).toHaveBeenCalledWith('[observer] device key unavailable:', expect.any(Error));
    expect(wire.observerState()).toBe('none');
  });
});
