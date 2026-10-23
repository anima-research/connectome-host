/**
 * Observer identity (docs/observability.md M2) — unit tests for the pure
 * layer (verifyHello, scope filters, sessions, file ops) plus an end-to-end
 * WS drill against a real WebUiModule:
 *
 *   no grants → everything behaves as pre-observer builds (401s)
 *   grant hot-appears → static goes public, unauthenticated WS upgrade OK
 *   signed hello → observer-ack with the grant's scopes + session token
 *   session cookie → /healthz by scope, /debug still denied without 'debug'
 *   wrong key / stale timestamp / wrong host → rejected
 *   observer is read-only (user-message → forbidden)
 */
import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, utimesSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  __getSharedServerPortForTests,
  stopWebUiServer,
} from '../src/modules/web-ui-module.js';
import {
  ObserverRegistry,
  ObserverSessions,
  closeConnectionsWithoutGrant,
  saveObserversFile,
  loadObserversFile,
  filterEntryForScopes,
  traceScopes,
  TRACE_SCOPES,
  childEventScopes,
  frameScopes,
  streamEndedFor,
  clientHolds,
  FULL_CLIENTS_ONLY,
  scopeWelcome,
  keepNamedStrings,
  frameWithoutFailureText,
  HEALTH_STRINGS,
  QUOTA_STRINGS,
  type ObserverScope,
  type ObserversFile,
} from '../src/modules/web-ui-observers.js';
import { WEB_PROTOCOL_VERSION, type WebUiServerMessage, type WelcomeMessage, type WelcomeMessageEntry } from '../src/web/protocol.js';
import { STREAM_END_TRACES } from '../src/state/turn-trace.js';
import { BASIC, helloFor, makeKeypair } from './web-ui-observed-host.js';

// ---------------------------------------------------------------------------
// Unit: registry verification
// ---------------------------------------------------------------------------

describe('ObserverRegistry.verifyHello', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'observers-unit-'));
  const path = join(tmp, 'observers.json');
  const kp = makeKeypair();
  const HOST = 'agent.example:7342';

  const file: ObserversFile = {
    observers: [
      { key: kp.id, label: 'test-device', scopes: ['health', 'ops'] },
      { key: 'ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', label: 'expired', scopes: ['health'], expires: '2000-01-01T00:00:00Z' },
    ],
  };
  saveObserversFile(path, file);
  const registry = new ObserverRegistry(path);
  registry.start();
  afterAll(() => { registry.stop(); rmSync(tmp, { recursive: true, force: true }); });

  test('valid hello → grant + scopes', () => {
    const res = registry.verifyHello(helloFor(kp, HOST), HOST);
    expect(res).not.toBeNull();
    expect(res!.grant.label).toBe('test-device');
    expect([...res!.scopes].sort()).toEqual(['health', 'ops']);
  });

  test('stale timestamp rejected', () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    expect(registry.verifyHello(helloFor(kp, HOST, old), HOST)).toBeNull();
  });

  test('host mismatch rejected (relay-proof)', () => {
    expect(registry.verifyHello(helloFor(kp, 'evil.example:7342'), HOST)).toBeNull();
  });

  test('unknown key rejected', () => {
    const stranger = makeKeypair();
    expect(registry.verifyHello(helloFor(stranger, HOST), HOST)).toBeNull();
  });

  test('tampered proof rejected', () => {
    const h = helloFor(kp, HOST);
    const buf = Buffer.from(h.proof, 'base64url');
    buf[0]! ^= 0xff;
    expect(registry.verifyHello({ ...h, proof: buf.toString('base64url') }, HOST)).toBeNull();
  });

  test('parse-error keeps previous grants (fail-safe)', () => {
    expect(loadObserversFile(path)).not.toBeNull();
    writeFileSync(path, '{not json');
    expect(loadObserversFile(path)).toBeNull();
    // registry still holds the last good state
    expect(registry.verifyHello(helloFor(kp, HOST), HOST)).not.toBeNull();
    saveObserversFile(path, file); // restore
  });
});

describe('ObserverRegistry when the grants file is removed', () => {
  test('the next check admits no one the file had admitted, says so once, and reads a file put back', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-removed-'));
    const path = join(tmp, 'observers.json');
    const kp = makeKeypair();
    const HOST = 'agent.example:7342';
    const grants: ObserversFile = { observers: [{ key: kp.id, label: 'device', scopes: ['health'], protected: true }] };
    saveObserversFile(path, grants);
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    const registry = new ObserverRegistry(path, 20);
    const until = async (done: () => boolean) => {
      const end = Date.now() + 3_000;
      while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    };
    const admits = () => registry.verifyHello(helloFor(kp, HOST), HOST) !== null;
    const gone = `[webui-observers] ${path} is gone — admitting no grants from it`;
    try {
      registry.start();
      expect(admits()).toBe(true);
      rmSync(path);
      await until(() => !registry.active());
      for (let i = 0; i < 5; i++) check(registry); // five more checks find it gone
      expect(admits()).toBe(false);
      expect(registry.active()).toBe(false);
      expect(lines.filter((l) => l.includes('admitting no grants'))).toEqual([gone]);
      saveObserversFile(path, grants);
      await until(() => registry.active());
      expect(admits()).toBe(true);
      // Removed again after a good read, it's said again.
      rmSync(path);
      await until(() => !registry.active());
      expect(lines.filter((l) => l.includes('admitting no grants'))).toEqual([gone, gone]);
    } finally {
      registry.stop();
      spy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('grants kept while the file wasn\'t valid JSON go too when it\'s removed', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-removed-'));
    const path = join(tmp, 'observers.json');
    const kp = makeKeypair();
    saveObserversFile(path, { observers: [{ key: kp.id, label: 'device', scopes: ['health'] }] });
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    const registry = new ObserverRegistry(path, 20);
    const until = async (done: () => boolean) => {
      const end = Date.now() + 3_000;
      while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    };
    try {
      registry.start();
      writeFileSync(path, '{"observers": [');
      const later = new Date(Date.now() + 5_000);
      utimesSync(path, later, later);
      await until(() => lines.some((l) => l.endsWith('keeping the previous grants until it parses')));
      expect(lines.some((l) => l.endsWith('keeping the previous grants until it parses'))).toBe(true);
      expect(registry.active()).toBe(true);
      rmSync(path);
      await until(() => !registry.active());
      expect(registry.active()).toBe(false);
      expect(lines).toContain(`[webui-observers] ${path} is gone — admitting no grants from it`);
    } finally {
      registry.stop();
      spy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('ObserverRegistry checks', () => {
  const setup = () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-checks-'));
    const path = join(tmp, 'observers.json');
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    const registry = new ObserverRegistry(path, 60_000); // checks driven by hand
    const done = () => { registry.stop(); spy.mockRestore(); rmSync(tmp, { recursive: true, force: true }); };
    return { tmp, path, lines, registry, done };
  };

  test('a host that never had the file says nothing about it', () => {
    const { lines, registry, done } = setup();
    try {
      registry.start();
      for (let i = 0; i < 5; i++) check(registry);
      expect(lines).toEqual([]);
      expect(registry.active()).toBe(false);
    } finally { done(); }
  });

  test('a file back by the second check, as after a save that removes it first, changes nothing', () => {
    const { path, lines, registry, done } = setup();
    const kp = makeKeypair();
    try {
      saveObserversFile(path, { observers: [{ key: kp.id, label: 'device', scopes: ['health'] }] });
      registry.start();
      rmSync(path);
      check(registry); // the first check to miss it takes nothing away
      expect(registry.grants().map((g) => g.label)).toEqual(['device']);
      saveObserversFile(path, { observers: [{ key: kp.id, label: 'device', scopes: ['health'] }] });
      check(registry);
      check(registry);
      expect(registry.grants().map((g) => g.label)).toEqual(['device']);
      expect(lines.filter((l) => l.includes('admitting no grants'))).toEqual([]);
    } finally { done(); }
  });

  test('removing a file the viewer couldn\'t use is said too', () => {
    const { path, lines, registry, done } = setup();
    try {
      writeFileSync(path, '{"observers": [');
      registry.start();
      rmSync(path);
      check(registry);
      check(registry);
      expect(lines.at(-1)).toBe(`[webui-observers] ${path} is gone — admitting no grants from it`);
    } finally { done(); }
  });

  test('a file put back with its old mtime, or replaced by one with the same mtime, is read again', () => {
    const { path, registry, done } = setup();
    const a = makeKeypair();
    const b = makeKeypair();
    try {
      saveObserversFile(path, { observers: [{ key: a.id, label: 'a', scopes: ['health'] }] });
      const was = statSync(path).mtime;
      registry.start();
      rmSync(path);
      check(registry);
      check(registry);
      expect(registry.active()).toBe(false);
      saveObserversFile(path, { observers: [{ key: a.id, label: 'a', scopes: ['health'] }] });
      utimesSync(path, was, was);
      check(registry);
      expect(registry.grants().map((g) => g.label)).toEqual(['a']);
      // Between two checks, a file with other grants and the same mtime.
      saveObserversFile(path, { observers: [{ key: b.id, label: 'b', scopes: ['health'] }] });
      utimesSync(path, was, was);
      check(registry);
      expect(registry.grants().map((g) => g.label)).toEqual(['b']);
    } finally { done(); }
  });

  test('a file that can\'t be reached from the start is named once', () => {
    const { tmp, lines, done } = setup();
    // A name longer than a directory entry can be fails the stat with
    // ENAMETOOLONG, which a test can make without chmod, as root too.
    const path = join(tmp, 'x'.repeat(300), 'observers.json');
    const registry = new ObserverRegistry(path, 60_000);
    try {
      registry.start();
      for (let i = 0; i < 5; i++) check(registry);
      expect(lines).toEqual([`[webui-observers] ${path} can't be read (ENAMETOOLONG) — admitting no grants from it`]);
      expect(registry.active()).toBe(false);
    } finally { registry.stop(); done(); }
  });

  test('a link whose file goes away is named as a link', () => {
    const { tmp, path, lines, registry, done } = setup();
    const kp = makeKeypair();
    const target = join(tmp, 'grants.json');
    try {
      saveObserversFile(target, { observers: [{ key: kp.id, label: 'a', scopes: ['health'] }] });
      symlinkSync(target, path);
      registry.start();
      expect(registry.grants().map((g) => g.label)).toEqual(['a']);
      rmSync(target);
      check(registry);
      check(registry);
      expect(registry.grants()).toEqual([]);
      expect(lines.at(-1)).toBe(`[webui-observers] ${path} is a link to a file that can't be read (ENOENT) — admitting no grants from it`);
    } finally { done(); }
  });

  test('a file there but unreadable is named with why', () => {
    const { path, lines, registry, done } = setup();
    try {
      saveObserversFile(path, { observers: [] });
      registry.start();
      rmSync(path);
      symlinkSync(path, path); // a link to itself: ELOOP
      check(registry);
      check(registry);
      expect(lines.at(-1)).toBe(`[webui-observers] ${path} can't be read (ELOOP) — admitting no grants from it`);
    } finally { done(); }
  });
});

/** Run one of the registry's checks now, as its timer would. */
function check(registry: ObserverRegistry): void {
  (registry as unknown as { check(): void }).check();
}

/** Wait until `done` holds, up to `ms`. */
async function waitUntil(done: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
}

describe('observer sessions and connections end with their grant', () => {
  const K = `ed25519:${'K'.repeat(42)}A`; // canonical: its last character carries no stray bits

  test('at each check, a session keeps only what its grant still holds, and ends for good when the grant is revoked, expires, keeps none of its scopes or its file goes', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-sessions-'));
    const path = join(tmp, 'observers.json');
    saveObserversFile(path, { observers: [{ key: K, label: 'phone', scopes: ['health', 'ops'] }] });
    const registry = new ObserverRegistry(path, 60_000); // checks driven by hand
    const sessions = new ObserverSessions();
    let now = Date.now();
    // One check of the file, then of the sessions, as the web UI's hook runs
    // after each; it returns how many sessions the check ended.
    const checked = () => { check(registry); return sessions.narrowToGrants((key) => registry.liveScopes(key, now)); };
    const write = (observers: ObserversFile['observers']) => { saveObserversFile(path, { observers }); return checked(); };
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      registry.start();
      const token = sessions.mint(new Set(['health', 'ops'] as ObserverScope[]), { key: K });
      expect([...sessions.lookup(token)!.scopes].sort()).toEqual(['health', 'ops']);

      expect(write([{ key: K, label: 'phone', scopes: ['health'] }])).toBe(0);
      expect([...sessions.lookup(token)!.scopes]).toEqual(['health']);
      // Widened again: the narrowing stays, and the next hello takes up the wider grant.
      expect(write([{ key: K, label: 'phone', scopes: ['health', 'ops'] }])).toBe(0);
      expect([...sessions.lookup(token)!.scopes]).toEqual(['health']);

      expect(write([])).toBe(1);
      expect(sessions.lookup(token)).toBeNull();
      // Granting the key again doesn't bring it back: that takes a new hello.
      expect(write([{ key: K, label: 'phone', scopes: ['health', 'ops'] }])).toBe(0);
      expect(sessions.lookup(token)).toBeNull();

      // A grant that keeps none of the session's scopes ends it.
      const opsLess = sessions.mint(new Set(['health'] as ObserverScope[]), { key: K });
      expect(write([{ key: K, label: 'phone', scopes: ['ops'] }])).toBe(1);
      expect(sessions.lookup(opsLess)).toBeNull();

      expect(write([{ key: K, label: 'phone', scopes: ['health'], expires: new Date(now + 60_000).toISOString() }])).toBe(0);
      const expiring = sessions.mint(new Set(['health'] as ObserverScope[]), { key: K });
      expect(checked()).toBe(0);
      now += 120_000;
      expect(checked()).toBe(1);
      expect(sessions.lookup(expiring)).toBeNull();
      now = Date.now();

      expect(write([{ key: K, label: 'phone', scopes: ['health'] }])).toBe(0);
      const removed = sessions.mint(new Set(['health'] as ObserverScope[]), { key: K });
      rmSync(path);
      expect(checked()).toBe(0); // a removal counts at the second check that misses the file
      expect(checked()).toBe(1);
      expect(sessions.lookup(removed)).toBeNull();

      // A password session has no grant to end with.
      const password = sessions.mint(new Set(), { full: true });
      expect(checked()).toBe(0);
      expect(sessions.lookup(password)?.full).toBe(true);
    } finally {
      registry.stop();
      spy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('an entry the viewer can\'t use counts as no grant: its session ends at the check', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-session-unusable-'));
    const path = join(tmp, 'observers.json');
    saveObserversFile(path, { observers: [{ key: K, label: 'phone', scopes: ['health'] }] });
    const registry = new ObserverRegistry(path, 60_000);
    const sessions = new ObserverSessions();
    const live = (key: string) => registry.liveScopes(key);
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      registry.start();
      const token = sessions.mint(new Set(['health'] as ObserverScope[]), { key: K });
      // An unknown scope makes the entry one the viewer can't use.
      saveObserversFile(path, { observers: [{ key: K, label: 'phone', scopes: ['health', 'everything' as ObserverScope] }] });
      check(registry);
      expect(registry.liveScopes(K)).toBeNull();
      expect(sessions.narrowToGrants(live)).toBe(1);
      expect(sessions.lookup(token)).toBeNull();
    } finally {
      registry.stop();
      spy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a session already past its 12 hours isn't counted among those a check ended", () => {
    const sessions = new ObserverSessions();
    const token = sessions.mint(new Set(['health'] as ObserverScope[]), { key: K });
    // Its 12 hours are up, and no mint has swept it since.
    const held = (sessions as unknown as { sessions: Map<string, { expiresAt: number }> }).sessions;
    held.get(token)!.expiresAt = Date.now() - 1;
    expect(sessions.narrowToGrants(() => null)).toBe(0);
    expect(sessions.lookup(token)).toBeNull();
    // It's left for the next mint to sweep.
    expect(held.has(token)).toBe(true);
    sessions.mint(new Set(), { full: true });
    expect(held.has(token)).toBe(false);
  });

  test('a read that fails after a good stat takes the grants away only at the second check in a row', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-read-fails-'));
    const path = join(tmp, 'observers.json');
    const grants: ObserversFile = { observers: [{ key: K, label: 'phone', scopes: ['health'] }] };
    saveObserversFile(path, grants);
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    const registry = new ObserverRegistry(path, 60_000);
    // A directory in its place: the stat succeeds and the read fails (EISDIR).
    const unreadable = () => { rmSync(path, { recursive: true, force: true }); mkdirSync(path); };
    const readable = () => { rmSync(path, { recursive: true, force: true }); saveObserversFile(path, grants); };
    try {
      registry.start();
      unreadable();
      check(registry);
      expect(registry.liveScopes(K)).not.toBeNull(); // one failed read changes nothing
      readable();
      check(registry);
      expect(registry.liveScopes(K)).not.toBeNull();
      expect(lines.filter((l) => l.includes('admitting no grants'))).toEqual([]);

      unreadable();
      check(registry);
      expect(registry.liveScopes(K)).not.toBeNull();
      check(registry);
      expect(registry.liveScopes(K)).toBeNull();
      expect(lines.filter((l) => l.includes('admitting no grants')).length).toBe(1);
      expect(lines.at(-1)).toStartWith(`[webui-observers] ${path} can't be read (EISDIR`);
      readable();
      check(registry);
      expect(registry.liveScopes(K)).not.toBeNull();
    } finally {
      registry.stop();
      spy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('the sweep closes a connection whose grant is gone (4401) or narrowed (4403), leaves the rest, and goes on past a close that throws', () => {
    const closed: string[] = [];
    const conn = (name: string, auth: string, observerKey: string | undefined, scopes: ObserverScope[] | null, throws = false) => ({
      auth,
      observerKey,
      label: observerKey === undefined ? undefined : name,
      scopes: scopes === null ? null : new Set(scopes),
      ws: { close: (code?: number, reason?: string) => { if (throws) throw new Error('socket'); closed.push(`${name}:${code}:${reason}`); } },
    });
    const grants: Record<string, Set<ObserverScope>> = { A: new Set(['health', 'ops']), B: new Set(['health']), W: new Set(['health', 'ops']) };
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    try {
      const connections = [
        conn('same', 'observer', 'A', ['health', 'ops']),
        conn('widened', 'observer', 'W', ['health']),
        conn('narrowed', 'observer', 'B', ['health', 'ops']),
        conn('throws', 'observer', 'C', ['health'], true),
        conn('gone', 'observer', 'C', ['health']),
        conn('keyless', 'observer', undefined, ['health']),
        conn('password', 'full', undefined, null),
        conn('pending', 'pending', undefined, null),
      ];
      const registry = { liveScopes: (key: string) => grants[key] ?? null };
      const swept = closeConnectionsWithoutGrant(connections, registry);
      expect(closed).toEqual([
        'narrowed:4403:observer grant narrowed',
        'gone:4401:observer grant gone or expired',
        'keyless:4401:observer grant gone or expired',
      ]);
      // The socket whose close threw isn't counted, and it's named.
      expect(swept).toBe(3);
      expect(lines).toEqual(["[webui-observers] observer connection couldn't be closed: throws (socket); each check tries again while its grant is gone, expired or narrowed"]);
    } finally { spy.mockRestore(); }
  });

  test('the sweep closes a connection whose grant has expired', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-expired-'));
    const path = join(tmp, 'observers.json');
    const at = Date.now();
    saveObserversFile(path, { observers: [
      { key: K, label: 'expired', scopes: ['health'], expires: new Date(at - 1000).toISOString() },
    ] });
    const registry = new ObserverRegistry(path, 60_000);
    const closed: number[] = [];
    try {
      registry.start();
      expect(registry.grants().map((g) => g.label)).toEqual(['expired']);
      const swept = closeConnectionsWithoutGrant(
        [{ auth: 'observer', observerKey: K, scopes: new Set(['health'] as ObserverScope[]), ws: { close: (code?: number) => { closed.push(code!); } } }],
        registry,
      );
      expect(swept).toBe(1);
      expect(closed).toEqual([4401]);
    } finally {
      registry.stop();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a grants file that parses but has the wrong shape takes every grant away at the check that reads it, and the sweep closes their connections', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-shape-'));
    const path = join(tmp, 'observers.json');
    saveObserversFile(path, { observers: [{ key: K, label: 'kept', scopes: ['health'] }] });
    const registry = new ObserverRegistry(path, 50);
    const closed: number[] = [];
    const connection = {
      auth: 'observer', observerKey: K, scopes: new Set(['health'] as ObserverScope[]),
      ws: { close: (code?: number) => { closed.push(code!); connection.auth = 'closed'; } },
    };
    let checksSinceWrite = -1;
    let closedAt = -1;
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      registry.start(() => {
        if (checksSinceWrite >= 0) checksSinceWrite++;
        if (closeConnectionsWithoutGrant([connection], registry) > 0) closedAt = checksSinceWrite;
      });
      expect(registry.liveScopes(K)).not.toBeNull();
      writeFileSync(path, JSON.stringify({ observers: null }));
      checksSinceWrite = 0;
      await waitUntil(() => closedAt >= 0, 5000);
      expect(closedAt).toBe(1);
      expect(closed).toEqual([4401]);
      expect(registry.liveScopes(K)).toBeNull();
    } finally {
      spy.mockRestore();
      registry.stop();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('the registry runs its hook after every check, and logs a hook that throws', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-hook-'));
    const path = join(tmp, 'observers.json');
    saveObserversFile(path, { observers: [] });
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    let calls = 0;
    const registry = new ObserverRegistry(path, 20);
    try {
      registry.start(() => { calls++; throw new Error('hook'); });
      await waitUntil(() => calls >= 2);
    } finally {
      registry.stop();
      spy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(lines.filter((l) => l === '[webui-observers] after a check: hook').length).toBe(calls);
  });

  test('the hook runs after the check, so it acts on the file as that check read it', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'observers-hook-order-'));
    const path = join(tmp, 'observers.json');
    saveObserversFile(path, { observers: [{ key: K, label: 'phone', scopes: ['health'] }] });
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    const registry = new ObserverRegistry(path, 20);
    let calls = 0;
    let revoked = false;
    const stale: number[] = [];
    try {
      registry.start(() => {
        calls++;
        if (revoked && registry.liveScopes(K) !== null) stale.push(calls);
      });
      await waitUntil(() => calls >= 2);
      saveObserversFile(path, { observers: [] });
      revoked = true; // in the same turn as the write, before any check can run
      const at = calls;
      await waitUntil(() => calls >= at + 3);
      expect(calls).toBeGreaterThanOrEqual(at + 3);
      expect(stale).toEqual([]);
      expect(registry.liveScopes(K)).toBeNull();
    } finally {
      registry.stop();
      spy.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Unit: scope filters + sessions
// ---------------------------------------------------------------------------

describe('scope filters', () => {
  const entry: WelcomeMessageEntry = {
    index: 0,
    participant: 'assistant',
    text: 'hi',
    blocks: [
      { kind: 'thinking', text: 'private' } as never,
      { kind: 'tool_use', id: 't1', name: 'shell', inputJson: '{}' } as never,
      { kind: 'tool_result', toolUseId: 't1', text: 'out' } as never,
      { kind: 'text', text: 'hi' } as never,
    ],
  };

  test('no messages scope → entry dropped entirely', () => {
    expect(filterEntryForScopes(entry, new Set<ObserverScope>(['health', 'ops']))).toBeNull();
  });

  test('messages without thinking/tools → those blocks elided', () => {
    const f = filterEntryForScopes(entry, new Set<ObserverScope>(['messages']))!;
    expect(f.blocks.map((b) => b.kind)).toEqual(['text']);
  });

  test("an image a tool returned goes with its result, and an image in a message stays with the message's text", () => {
    const withImages: WelcomeMessageEntry = {
      index: 1,
      participant: 'user',
      text: 'and this',
      blocks: [
        { kind: 'tool_result', toolUseId: 't1', text: 'a frame' },
        { kind: 'media', mediaType: 'image/png', ref: 'm2/0.1', toolUseId: 't1' },
        { kind: 'text', text: 'and this' },
        { kind: 'media', mediaType: 'image/png', ref: 'm2/2' },
      ],
    };
    expect(filterEntryForScopes(withImages, new Set<ObserverScope>(['messages']))!.blocks)
      .toEqual([{ kind: 'text', text: 'and this' }, { kind: 'media', mediaType: 'image/png', ref: 'm2/2' }]);
    expect(filterEntryForScopes(withImages, new Set<ObserverScope>(['messages', 'thinking']))!.blocks.map((b) => b.kind))
      .toEqual(['text', 'media']);
    expect(filterEntryForScopes(withImages, new Set<ObserverScope>(['messages', 'tools']))).toEqual(withImages);
  });

  test('an entry whose every block the scopes remove is dropped, and one that had no blocks stays', () => {
    const toolOnly: WelcomeMessageEntry = {
      index: 2,
      participant: 'assistant',
      text: '',
      blocks: [
        { kind: 'thinking', text: 'private' } as never,
        { kind: 'tool_use', id: 't1', name: 'shell', inputJson: '{}' } as never,
      ],
    };
    expect(filterEntryForScopes(toolOnly, new Set<ObserverScope>(['messages']))).toBeNull();
    expect(filterEntryForScopes(toolOnly, new Set<ObserverScope>(['messages', 'thinking']))!.blocks.map((b) => b.kind))
      .toEqual(['thinking']);
    const empty: WelcomeMessageEntry = { index: 3, participant: 'user', text: '', blocks: [] };
    expect(filterEntryForScopes(empty, new Set<ObserverScope>(['messages']))).toEqual(empty);
  });

  test('full interiority scopes → identical entry', () => {
    const f = filterEntryForScopes(entry, new Set<ObserverScope>(['messages', 'thinking', 'tools']));
    expect(f).toEqual(entry);
  });

  test("a trace needs every scope whose data it carries, a token or block its block's too, and any type not in the table goes to full clients alone", () => {
    expect(traceScopes({ type: 'message:added' })).toEqual(['messages']);
    expect(traceScopes({ type: 'inference:tokens', blockType: 'text' })).toEqual(['messages']);
    expect(traceScopes({ type: 'inference:tokens', blockType: 'thinking' })).toEqual(['messages', 'thinking']);
    expect(traceScopes({ type: 'inference:content_block', blockType: 'tool_call' })).toEqual(['messages', 'tools']);
    expect(traceScopes({ type: 'inference:tokens', blockType: 'tool_result' })).toEqual(['messages', 'tools']);
    expect(traceScopes({ type: 'inference:tokens', blockType: 'a-block-added-later' })).toBe(FULL_CLIENTS_ONLY);
    expect(traceScopes({ type: 'inference:tool_calls_yielded' })).toEqual(['messages', 'tools']);
    expect(traceScopes({ type: 'tool:completed' })).toEqual(['messages', 'tools']);
    // A failed or dropped call's error, and an operator's call for the agent.
    for (const type of ['tool:failed', 'tool:result_dropped', 'puppet:tool-call']) {
      expect(traceScopes({ type })).toEqual(['messages', 'tools', 'ops']);
    }
    // Whole process events and module responses.
    for (const type of ['process:received', 'process:completed']) {
      expect(traceScopes({ type })).toEqual(['messages', 'thinking', 'tools', 'health', 'ops']);
    }
    expect(traceScopes({ type: 'inference:completed' })).toEqual(['messages', 'health']);
    expect(traceScopes({ type: 'inference:usage' })).toEqual(['health']);
    expect(traceScopes({ type: 'host:quiesce' })).toEqual(['health']);
    expect(traceScopes({ type: 'inference:failed' })).toEqual(['ops']);
    expect(traceScopes({ type: 'inference:exhausted' })).toEqual(['ops']);
    // Why a turn was stopped is ops; that it ended reaches messages as stream-ended.
    expect(traceScopes({ type: 'inference:aborted' })).toEqual(['messages', 'ops']);
    for (const type of ['inbound:observer-failed', 'mcpl:request-handler-error', 'prose:drafts-held', 'prose:draft-resent', 'prose:drafts-dismissed']) {
      expect(traceScopes({ type })).toEqual(['ops']);
    }
    // The operator log's entry, as request-operator-log gives ops.
    expect(traceScopes({ type: 'operator:action' })).toEqual(['ops']);
    expect(traceScopes({ type: 'mcpl:server-closed' })).toEqual(['ops']);
    // A batched wake run without its gate line, which agent-framework adds after 0.26.0.
    expect(traceScopes({ type: 'gate:wake-line-omitted' })).toEqual(['ops']);
    expect(traceScopes({ type: 'mcpl:speech-routed' })).toEqual(['messages', 'ops']);
    for (const type of ['inference:published', 'inference:published_complete']) {
      expect(traceScopes({ type })).toEqual(['messages']);
    }
    expect(traceScopes({ type: 'a-trace-added-later' })).toBe(FULL_CLIENTS_ONLY);
    expect(traceScopes({ type: 'toString' })).toBe(FULL_CLIENTS_ONLY);
  });

  test("every trace type the installed agent-framework defines has an entry in the table", () => {
    // Read the source the runtime resolves the package to from here, as the host loads it, wherever
    // it's installed: in this repository's node_modules, or in one above it, as a hoisted install or a
    // linked checkout leaves it. Its exports give Bun the index of that source.
    const index = Bun.resolveSync('@animalabs/agent-framework', import.meta.dir);
    const source = readFileSync(join(dirname(index), 'types', 'trace.ts'), 'utf-8');
    const types = [...new Set([...source.matchAll(/\btype: '([^']+)'/g)].map((m) => m[1]!))].sort();
    expect(types.length).toBeGreaterThan(50);
    expect(types.filter((type) => !Object.hasOwn(TRACE_SCOPES, type))).toEqual([]);
  });

  test("a child's events go by the host's trace table, its lifecycle needs health, its snapshot a tree's scopes, its speech thinking and tools, a stream end's stand-in messages, and any other kind a full client", () => {
    expect(childEventScopes({ type: 'message:added' })).toEqual(['messages']);
    expect(childEventScopes({ type: 'inference:tokens', blockType: 'thinking' } as never)).toEqual(['messages', 'thinking']);
    expect(childEventScopes({ type: 'tool:started' })).toEqual(['messages', 'tools']);
    expect(childEventScopes({ type: 'usage:updated' })).toEqual(['health']);
    expect(childEventScopes({ type: 'ops:alert' })).toEqual(['ops']);
    expect(childEventScopes({ type: 'inference:speech' })).toEqual(['messages', 'thinking', 'tools']);
    expect(childEventScopes({ type: 'stream-ended', agentName: 'kid' } as never)).toEqual(['messages']);
    expect(childEventScopes({ type: 'lifecycle', phase: 'ready' } as never)).toEqual(['health']);
    expect(childEventScopes({ type: 'snapshot' })).toEqual(['messages', 'thinking', 'tools', 'health', 'ops']);
    for (const type of ['command-output', 'a-kind-added-later', 'private:new-kind', '', undefined, 7]) {
      expect(childEventScopes({ type })).toBe(FULL_CLIENTS_ONLY);
    }
  });

  test('a frame sent to more than one client needs what its welcome field or request needs, and any other goes to full clients alone', () => {
    const scopesOf = (frame: Record<string, unknown>) => frameScopes(frame as never);
    expect(scopesOf({ type: 'trace', event: { type: 'tool:started' } })).toEqual(['messages', 'tools']);
    expect(scopesOf({ type: 'child-event', childName: 'kid', event: { type: 'lifecycle' } })).toEqual(['health']);
    for (const type of ['usage', 'call-ledger', 'credential-state', 'host-mode']) expect(scopesOf({ type })).toEqual(['health']);
    for (const type of ['inbound-trigger', 'branch-changed', 'stream-ended']) expect(scopesOf({ type })).toEqual(['messages']);
    for (const type of ['pins-list', 'settings-state', 'a-frame-added-later']) expect(scopesOf({ type })).toBe(FULL_CLIENTS_ONLY);
  });

  test('a stream-end trace has a stand-in that says only whose stream ended, and no other trace has one', () => {
    for (const type of STREAM_END_TRACES) {
      expect(streamEndedFor({ type, agentName: 'main', error: 'provider said no', stack: 'at x' } as never))
        .toEqual({ type: 'stream-ended', agentName: 'main' });
    }
    expect(streamEndedFor({ type: 'inference:failed' })).toEqual({ type: 'stream-ended' });
    for (const type of ['inference:started', 'inference:tokens', 'tool:failed', 'ops:alert']) {
      expect(streamEndedFor({ type, agentName: 'main' })).toBeNull();
    }
  });

  test('a full client holds every frame, an observer what its scopes cover, and a connection waiting for its hello nothing', () => {
    const full = { auth: 'full', scopes: null };
    const waiting = { auth: 'pending', scopes: null };
    const observer = { auth: 'observer', scopes: new Set<ObserverScope>(['messages', 'health']) };
    expect(clientHolds(full, FULL_CLIENTS_ONLY)).toBe(true);
    expect(clientHolds(full, ['thinking'])).toBe(true);
    expect(clientHolds(waiting, ['health'])).toBe(false);
    expect(clientHolds(observer, ['health'])).toBe(true);
    expect(clientHolds(observer, ['messages', 'health'])).toBe(true);
    expect(clientHolds(observer, ['messages', 'thinking'])).toBe(false);
    expect(clientHolds(observer, FULL_CLIENTS_ONLY)).toBe(false);
  });

  test("scopeWelcome without messages empties conversation payload, and the session's and branch's names", () => {
    const welcome = {
      type: 'welcome', protocolVersion: WEB_PROTOCOL_VERSION,
      agents: [{ name: 'main', model: 'claude-x' }],
      session: { id: 's1', name: 'Debugging the bridge', autoNamed: true },
      branch: { id: 'b1', name: 'experiment' },
      messages: [entry],
      history: { startIndex: 40, totalCount: 240 },
      localTree: { asOfTs: 1, nodes: [{ secret: true }], callIdIndex: { a: 'b' } },
      childTrees: [{ name: 'c', asOfTs: 1, nodes: [], callIdIndex: {} }],
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    } as unknown as WelcomeMessage;
    const w = scopeWelcome(welcome, new Set<ObserverScope>(['health', 'ops']));
    expect(w.messages).toEqual([]);
    expect(w.localTree.nodes).toEqual([]);
    expect(w.childTrees).toEqual([]);
    expect(w.history.startIndex).toBe(240);
    expect(w.usage.input).toBe(1); // structure/usage survive
    // An auto-named session's name summarizes the conversation, and branch
    // names are request-branches' tier; the ids stay, as the client's key.
    expect(w.session).toEqual({ id: 's1', name: '', autoNamed: true });
    expect(w.branch).toEqual({ id: 'b1', name: '' });
    const reader = scopeWelcome(welcome, new Set<ObserverScope>(['messages']));
    expect(reader.session).toEqual(welcome.session);
    expect(reader.branch).toEqual(welcome.branch);
    expect(welcome.session.name).toBe('Debugging the bridge'); // never mutated
  });

  // Health-gated telemetry must be masked exactly like its live frames:
  // `usage`, `call-ledger` and `host-mode` pushes require the 'health' scope,
  // so the welcome cannot hand the same data to a messages-only observer.
  test('scopeWelcome without health strips callLedger/perAgentCost/hostMode and zeroes usage', () => {
    const welcome = {
      type: 'welcome', protocolVersion: WEB_PROTOCOL_VERSION,
      messages: [entry],
      history: { startIndex: 40, totalCount: 240 },
      localTree: { asOfTs: 1, nodes: [], callIdIndex: {} },
      childTrees: [],
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 5, currency: 'USD' } },
      perAgentCost: [{ name: 'main', usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      callLedger: {
        calls: [{ model: 'secret-model', error: 'raw provider error', costUsd: 0.42 }],
      },
      hostMode: { mode: 'quiesced', detail: {} },
      agents: [{ name: 'main', model: 'secret-model' }],
    } as unknown as WelcomeMessage;

    const w = scopeWelcome(welcome, new Set<ObserverScope>(['messages']));
    expect(w.agents).toEqual([{ name: 'main', model: '' }]);
    expect(w.callLedger).toBeUndefined();
    expect(w.perAgentCost).toBeUndefined();
    expect(w.hostMode).toBeUndefined();
    expect(w.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(w.messages.length).toBe(1); // messages scope still gets content
    // No trace of the ledger anywhere in the serialized frame.
    expect(JSON.stringify(w)).not.toContain('secret-model');
    expect(JSON.stringify(w)).not.toContain('raw provider error');

    // Same masking on the no-messages branch (e.g. ops-only observer).
    const opsOnly = scopeWelcome(welcome, new Set<ObserverScope>(['ops']));
    expect(opsOnly.callLedger).toBeUndefined();
    expect(opsOnly.perAgentCost).toBeUndefined();
    expect(opsOnly.hostMode).toBeUndefined();
    expect(opsOnly.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

    // An observer with health and ops keeps the telemetry verbatim.
    const h = scopeWelcome(welcome, new Set<ObserverScope>(['health', 'ops']));
    expect(h.callLedger).toEqual(welcome.callLedger);
    expect(h.perAgentCost).toEqual(welcome.perAgentCost);
    expect(h.hostMode).toEqual(welcome.hostMode);
    expect(h.agents).toEqual(welcome.agents);
    expect(h.usage).toEqual(welcome.usage);
    // With health alone the rest is the same, and the ledger keeps only the
    // strings LEDGER_STRINGS names: none, in this shape.
    const healthOnly = scopeWelcome(welcome, new Set<ObserverScope>(['health']));
    expect(JSON.parse(JSON.stringify(healthOnly.callLedger))).toEqual({ calls: [{ model: '', error: '', costUsd: 0.42 }] });
    expect(healthOnly.perAgentCost).toEqual(welcome.perAgentCost);
    expect(healthOnly.hostMode).toEqual(welcome.hostMode);
    expect(healthOnly.agents).toEqual(welcome.agents);
    expect(healthOnly.usage).toEqual(welcome.usage);

    // Input welcome is never mutated (shared across clients in sendWelcome).
    expect(welcome.callLedger).toBeDefined();
    expect(welcome.hostMode).toBeDefined();
    expect(welcome.usage.input).toBe(1);
  });

  test("keepNamedStrings empties each string its spec doesn't keep, and keeps numbers, flags, nulls, every key and each list's length", () => {
    // From JSON, as a payload comes, so an agent named `__proto__` is an own key.
    const value = JSON.parse(`{
      "name": "main", "note": "free text", "count": 2, "ok": true, "none": null,
      "byAgent": { "alice": { "state": "healthy", "error": "it broke" }, "__proto__": { "state": "degraded", "error": "also broke" } },
      "list": ["a", "b"],
      "rows": [{ "verdict": "ERROR", "cause": "raw provider text" }, { "verdict": "HIT", "cause": "90% from cache" }],
      "whole": { "anything": "kept", "deep": ["x"] }
    }`);
    const kept = keepNamedStrings(value, {
      name: true,
      whole: true,
      byAgent: { '*': { state: true } },
      rows: { verdict: true, cause: (row) => row.verdict !== 'ERROR' },
    });
    expect(JSON.stringify(kept)).toBe(JSON.stringify(JSON.parse(`{
      "name": "main", "note": "", "count": 2, "ok": true, "none": null,
      "byAgent": { "alice": { "state": "healthy", "error": "" }, "__proto__": { "state": "degraded", "error": "" } },
      "list": ["", ""],
      "rows": [{ "verdict": "ERROR", "cause": "" }, { "verdict": "HIT", "cause": "90% from cache" }],
      "whole": { "anything": "kept", "deep": ["x"] }
    }`)));
    // A value that isn't an object or a string comes back as it is.
    expect(keepNamedStrings(3, undefined)).toBe(3);
    expect(keepNamedStrings('text', undefined)).toBe('');
    expect(keepNamedStrings('text', true)).toBe('text');
  });

  test("HEALTH_STRINGS and QUOTA_STRINGS keep every name, id, code and time /healthz and /quota hold, and empty only their failure text", () => {
    const text = 'the provider said: overloaded';
    const cost = {
      input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1, total: 2, currency: 'USD', grade: 'billing', pricingVersion: 'p1',
      rates: { inputPerMillion: 1, outputPerMillion: 1, cacheWrite5mPerMillion: 1, cacheWrite1hPerMillion: 1, cacheReadPerMillion: 1 },
    };
    const call = {
      id: 'c1', timestamp: '2026-10-22T06:00:00.000Z', kind: 'stream', originEstimate: 'turn~', model: 'a-model', messages: 3, durationMs: 10,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, cost, cache: { breakpoints: 2, ttls: ['5m', '1h'], effectiveTtl: '5m' },
      verdict: 'HIT', cause: '90% from cache', stopReason: 'end_turn',
    };
    // agent-framework 0.24.0's healthSnapshot, and every section the host adds, with a value in each place.
    const health = {
      at: '2026-10-22T06:00:00.000Z',
      uptimeSec: 5,
      gate: { inferring: ['main'], bufferedEvents: 1, droppedBufferedEvents: 0, sleepUntil: 0 },
      pendingRequests: 1,
      activeStreams: ['main'],
      agents: [{
        name: 'main',
        status: 'inferring',
        consecutiveInferenceFailures: 1,
        providerAdmission: {
          primaryActive: true, primaryPending: false, auxiliaryInFlight: 0, auxiliaryDeferred: 0,
          cooldownUntil: 2, cooldownReason: text, hostHold: false, heldRequests: 0,
          lastRecovery: { startedAt: 1, releasedAt: 2, completedAt: 3, cooldownMs: 4, waitedMs: 5, failures: 1, heldRequests: 0, messageCount: 2, toolCount: 0, stopReason: 'end_turn' },
          providerWaits: [{ model: 'a-model', until: '2026-10-22T06:05:00.000Z', reason: text, setAt: '2026-10-22T06:00:00.000Z' }],
        },
        lastInference: { startedAt: 1, endedAt: 2, failedAt: 3, lastError: text },
        refusalStats: { total: 1, byCategory: { policy: 1 }, lastAt: 3, lastCategory: 'policy' },
      }],
      credential: {
        subscription: true, agent: 'main', kind: 'auth-login-required', provider: 'anthropic', message: text, since: 1, until: 2, windows: ['5h'],
        rotatable: false, expiresAt: 3, actions: [{ id: 'login', label: 'Restart login', hint: 'Starts a new device-code login.' }],
        login: { verificationUrl: 'https://example.invalid/device', userCode: 'ABCD-1234' },
        lastAction: { id: 'refresh', at: 1, ok: false, message: text },
      },
      compressionQuarantine: {
        main: {
          count: 1, keys: ['q1'],
          spans: [{ chunkSourceHash: 'h1', firstMessageId: 'm1', lastMessageId: 'm2', closedAgeMs: 1, quarantinedAt: 1, records: 1, answeredAttempts: 1, latestOutcome: 'provider_error:invalid_request' }],
        },
      },
      compressionDebt: {
        main: {
          state: 'unknown', error: text, failure: 'report', pendingChunks: 1, oldestPendingAgeMs: 2, mergeQueueDepth: 0, mergeQueueMaxAttempts: 0,
          mergeQuarantineCount: 1, mergeQuarantineKeys: ['mq1'], mergeHeldIds: ['s1'], compressionQuarantineCount: 1,
          unmergedFrontier: { l1: 1, l2: 0, l3: 0 }, lastMintAt: 1, topologyViolations: 0, topologyRefusals: 0,
        },
      },
      contextComposition: {
        main: {
          head: { messages: 1, tokens: 1 }, tail: { messages: 1, tokens: 1 }, middleRaw: { messages: 0, tokens: 0 },
          summaries: { l1: { count: 0, tokens: 0 }, l2: { count: 0, tokens: 0 }, l3: { count: 0, tokens: 0 } },
          pending: { chunks: 0, merges: 0 }, total: { messages: 2, tokens: 2 },
          calibration: { multiplier: 1, pricingEpoch: 1, provisional: true, reset: { discardedMultiplier: 2, fromEpoch: null, at: 1 } },
          planVsActual: {
            planned: 1, actual: 1, delta: 0, budgetMet: true, exhausted: false, moves: 0, solver: 'kv-stable', messages: 2, compileMs: 1, solveMs: 1,
            ceiling: 'whatIfs:2', dryRun: true,
            foldDiff: { moves: 1, deepened: 1, raised: 0, runs: [{ from: 0, to: 1, count: 1, firstChunkId: 'k1', lastChunkId: 'k2' }], runsTotal: 1, divergenceOffset: null, suffixTokens: null },
          },
        },
      },
      runtimeSettings: {
        main: {
          contextBudgetTokens: 1000, effectiveContextBudgetTokens: 1000, tailTokens: 10, transitionPaceTokens: 10,
          sameRoundThinkTextPolicy: 'keep', sameRoundThinkTextPolicySource: 'default', transition: 'blocked', transitionReason: 'transition_pace_too_small',
        },
      },
      readFailures: { main: { contextComposition: text } },
      callLedger: {
        rows: [{ ...call, id: 'c0', verdict: 'ERROR', cause: text, error: text }, call],
        summary: { calls: 2, input: 2, output: 2, cacheRead: 0, cacheWrite: 0, cacheHitRatio: 0, cost: { total: 2, currency: 'USD', pricedCalls: 1, unpricedCalls: 1, pricingVersion: 'p1' }, byVerdict: { ERROR: 1, HIT: 1 } },
      },
    };
    const expected = structuredClone(health);
    const main = expected.agents[0]!;
    main.providerAdmission.cooldownReason = '';
    main.providerAdmission.providerWaits[0]!.reason = '';
    main.lastInference.lastError = '';
    expected.compressionDebt.main.error = '';
    expected.readFailures.main.contextComposition = '';
    Object.assign(expected.callLedger.rows[0]!, { cause: '', error: '' });
    expected.credential.message = '';
    expected.credential.lastAction.message = '';
    expect(JSON.parse(JSON.stringify(keepNamedStrings(health, HEALTH_STRINGS)))).toEqual(expected);

    const quota = {
      subscription: true, provider: 'anthropic', fetchedAt: 1, error: text, blockedUntil: null, parked: false,
      windows: [{ key: 'five_hour', label: '5h', utilization: 10, resetsAt: 1, model: 'a-model', advisory: false }],
    };
    expect(JSON.parse(JSON.stringify(keepNamedStrings(quota, QUOTA_STRINGS)))).toEqual({ ...quota, error: '' });
  });

  test('frameWithoutFailureText gives the call ledger and the credential state without their failure text, and any other frame as it is', () => {
    const ledger = {
      type: 'call-ledger',
      ledger: { rows: [{ id: 'c1', model: 'a-model', verdict: 'ERROR', cause: 'raw', error: 'raw' }], summary: { calls: 1, byVerdict: { ERROR: 1 } } },
    } as unknown as WebUiServerMessage;
    expect(JSON.parse(JSON.stringify(frameWithoutFailureText(ledger)))).toEqual({
      type: 'call-ledger',
      ledger: { rows: [{ id: 'c1', model: 'a-model', verdict: 'ERROR', cause: '', error: '' }], summary: { calls: 1, byVerdict: { ERROR: 1 } } },
    });
    const credential = {
      type: 'credential-state', scope: 'kid', subscription: true, agent: 'main', kind: 'auth-rejected', provider: 'anthropic',
      message: 'anthropic rejected the credential (raw)', since: 1, rotatable: true, actions: [{ id: 'refresh', label: 'Refresh' }],
      lastAction: { id: 'refresh', at: 2, ok: false, message: 'refresh failed: raw' },
    } as unknown as WebUiServerMessage;
    expect(JSON.parse(JSON.stringify(frameWithoutFailureText(credential)))).toEqual({
      ...credential, message: '', lastAction: { id: 'refresh', at: 2, ok: false, message: '' },
    });
    const trace = { type: 'trace', event: { type: 'usage:updated', agentName: 'main' } } as unknown as WebUiServerMessage;
    expect(frameWithoutFailureText(trace)).toBe(trace);
  });

  test('the agent trees go only with every scope but debug, since their nodes carry token counts and how each run ended', () => {
    const tree = { asOfTs: 1, nodes: [{ name: 'main', tokens: { input: 5 } }], callIdIndex: {} };
    const welcome = {
      type: 'welcome', protocolVersion: WEB_PROTOCOL_VERSION, agents: [], messages: [],
      session: { id: 's', name: 's', autoNamed: false }, branch: { id: 'b', name: 'b' },
      history: { startIndex: 0, totalCount: 0 },
      localTree: tree,
      childTrees: [{ name: 'kid', ...tree, recipe: { name: 'kid', agentModel: 'a-model' } }],
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    } as unknown as WelcomeMessage;
    for (const missing of ['messages', 'thinking', 'tools', 'health', 'ops'] as const) {
      const scopes = new Set<ObserverScope>(['messages', 'thinking', 'tools', 'health', 'ops']);
      scopes.delete(missing);
      const w = scopeWelcome(welcome, scopes);
      expect(w.localTree.nodes).toEqual([]);
      expect(w.childTrees).toEqual([]);
    }
    const all = scopeWelcome(welcome, new Set<ObserverScope>(['messages', 'thinking', 'tools', 'health', 'ops']));
    expect(all.localTree).toEqual(tree);
    expect(all.childTrees).toEqual(welcome.childTrees);
  });
});

describe('ObserverSessions', () => {
  test('mint/lookup round-trip; bad token null; full flag carried', () => {
    const s = new ObserverSessions();
    const scopes = new Set<ObserverScope>(['health']);
    const token = s.mint(scopes, { key: 'k' });
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(s.lookup(token)!.scopes).toBe(scopes);
    expect(s.lookup(token)!.full).toBe(false);
    expect(s.lookup('0'.repeat(64))).toBeNull();
    expect(s.lookup(null)).toBeNull();
    // Narrowing a session at a check leaves the set it was minted with alone, which the hello's connection holds too.
    const wide = new Set<ObserverScope>(['health', 'ops']);
    const wideToken = s.mint(wide, { key: 'k' });
    expect(s.narrowToGrants(() => new Set<ObserverScope>(['health']))).toBe(0);
    expect([...s.lookup(wideToken)!.scopes]).toEqual(['health']);
    expect([...wide].sort()).toEqual(['health', 'ops']);

    // Full sessions (password sign-in path) carry operator authority.
    const fullToken = s.mint(new Set(), { full: true });
    expect(s.lookup(fullToken)!.full).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end over a live module: empty grants → historical behavior; grant
// hot-appears → observer flow works.
// ---------------------------------------------------------------------------

describe('WebUiModule observer flow (e2e)', () => {
  let tmp: string;
  let observersPath: string;
  let port: number;
  let mod: WebUiModule;
  const kp = makeKeypair();

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'webui-observers-'));
    const staticRoot = join(tmp, 'web');
    mkdirSync(staticRoot, { recursive: true });
    writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>t</title>');
    observersPath = join(tmp, 'observers.json');
    saveObserversFile(observersPath, { observers: [] }); // present but EMPTY

    mod = new WebUiModule({
      port: 0,
      host: '127.0.0.1',
      basicAuth: { username: 'admin', password: 'pw' },
      staticDir: staticRoot,
      observersPath,
    });
    await mod.start({} as ModuleContext);
    port = __getSharedServerPortForTests()!;
  });

  afterAll(async () => {
    await mod.stop();
    await stopWebUiServer();
    rmSync(tmp, { recursive: true, force: true });
  });

  const base = () => `http://127.0.0.1:${port}`;
  /** The static shell's status once it is `want`, or the last one seen when
   *  `ms` runs out: the registry's checks come on its own timer, which a
   *  loaded host can delay. */
  const shellStatusBecomes = async (want: number, ms = 12_000): Promise<number> => {
    const end = Date.now() + ms;
    for (;;) {
      const status = (await fetch(`${base()}/`)).status;
      if (status === want || Date.now() >= end) return status;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  test('no grants: static requires basic auth, unauthenticated WS upgrade 401', async () => {
    expect((await fetch(`${base()}/`)).status).toBe(401);
    const res = await fetch(`${base()}/ws`, {
      headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    });
    expect(res.status).toBe(401);
  });

  test('grant appears (hot-reload): static public, observer WS flow end-to-end', async () => {
    saveObserversFile(observersPath, {
      observers: [{ key: kp.id, label: 'e2e-device', scopes: ['health', 'ops', 'debug'] }],
    });
    // The registry's next check, within about 3 s, admits it, and the static
    // app shell, which carries no data, is public from then on.
    expect(await shellStatusBecomes(200)).toBe(200);
    // But data routes still gated — including the credential state, scoped
    // to a fleet child or not (it can carry a pending device-code login).
    expect((await fetch(`${base()}/healthz`)).status).toBe(401);
    expect((await fetch(`${base()}/credential`)).status).toBe(401);
    expect((await fetch(`${base()}/credential?scope=child-a`)).status).toBe(401);

    // Unauthenticated WS: auth-required → signed hello → ack.
    const host = `127.0.0.1:${port}`;
    const ws = new WebSocket(`ws://${host}/ws`);
    const frames: Record<string, unknown>[] = [];
    const got = (type: string) =>
      new Promise<Record<string, unknown>>((resolvePromise, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 5000);
        const check = () => {
          const f = frames.find((m) => m.type === type);
          if (f) { clearTimeout(t); resolvePromise(f); return true; }
          return false;
        };
        if (check()) return;
        ws.addEventListener('message', () => { check(); });
      });
    ws.addEventListener('message', (ev) => frames.push(JSON.parse(String(ev.data))));

    const authReq = await got('observer-auth-required');
    expect(authReq.host).toBe(host);

    ws.send(JSON.stringify({ type: 'observer-hello', identity: helloFor(kp, host) }));
    const ack = await got('observer-ack');
    expect(ack.label).toBe('e2e-device');
    expect((ack.scopes as string[]).sort()).toEqual(['debug', 'health', 'ops']);

    // Read-only: mutating messages are refused.
    ws.send(JSON.stringify({ type: 'user-message', content: 'hi' }));
    const errFrame = await got('error');
    expect(String(errFrame.message)).toContain('forbidden');

    // Branch listing rides the 'messages' scope, which this grant lacks.
    ws.send(JSON.stringify({ type: 'request-branches' }));
    const branchErr = await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for request-branches refusal')), 5000);
      const check = () => {
        const f = frames.find((m) => m.type === 'error' && String(m.message).includes('request-branches'));
        if (f) { clearTimeout(t); resolvePromise(f); return true; }
        return false;
      };
      if (check()) return;
      ws.addEventListener('message', () => { check(); });
    });
    expect(String(branchErr.message)).toContain('forbidden');

    // Session cookie: ordinary debug is allowed by scope, but retrieval traces
    // remain operator-only because they can expose lessons and opt-in inputs.
    const cookie = `fkm_obs=${ack.sessionToken}`;
    // 503 means authorization passed but this harness has no bound app.
    expect((await fetch(`${base()}/healthz`, { headers: { cookie } })).status).toBe(503);
    expect((await fetch(`${base()}/credential`, { headers: { cookie } })).status).toBe(503);
    expect((await fetch(`${base()}/debug/context`, { headers: { cookie } })).status).toBe(503);
    expect((await fetch(`${base()}/debug/retrieval`, { headers: { cookie } })).status).toBe(401);
    expect((await fetch(`${base()}/debug/retrieval/view`, { headers: { cookie } })).status).toBe(401);
    // Basic auth still works for everything.
    expect((await fetch(`${base()}/healthz`, { headers: { authorization: BASIC } })).status).toBe(503);

    ws.close();
  }, 25_000);

  test('password sign-in mints a full-session cookie the WS upgrade honors', async () => {
    // /auth/basic with valid credentials → 302 + full-session cookie.
    const res = await fetch(`${base()}/auth/basic`, { headers: { authorization: BASIC }, redirect: 'manual' });
    expect(res.status).toBe(302);
    const m = /fkm_obs=([a-f0-9]{64})/.exec(res.headers.get('set-cookie') ?? '');
    expect(m).not.toBeNull();

    // A WS upgrade carrying ONLY the cookie (no Authorization — the Chrome
    // situation) must be treated as a FULL client: no observer-auth-required
    // demand. (Full clients are parked silently in this app-less harness;
    // the observer path would send auth-required immediately.)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: `fkm_obs=${m![1]}` } } as never);
    const firstFrame = await Promise.race([
      new Promise<string>((r) => ws.addEventListener('message', (ev) => r(String((ev as MessageEvent).data)))),
      new Promise<string>((r) => setTimeout(() => r('SILENCE'), 1500)),
    ]);
    ws.close();
    expect(firstFrame).toBe('SILENCE'); // not observer-auth-required
  }, 10_000);

  test('wrong key: hello rejected and socket closed', async () => {
    const stranger = makeKeypair();
    const host = `127.0.0.1:${port}`;
    const ws = new WebSocket(`ws://${host}/ws`);
    const closed = new Promise<number>((r) => ws.addEventListener('close', (ev) => r(ev.code)));
    // An upgrade refused (no grant active yet) closes without opening; say so
    // rather than wait for an open that won't come.
    const opened = await new Promise<boolean>((r) => {
      ws.addEventListener('open', () => r(true));
      ws.addEventListener('close', () => r(false));
    });
    expect(opened).toBe(true);
    ws.send(JSON.stringify({ type: 'observer-hello', identity: helloFor(stranger, host) }));
    expect(await closed).toBe(4401);
  }, 10_000);

  // It takes the grants away; the case after it writes its own.
  test('file removed (hot-reload): the static shell needs the password again', async () => {
    expect((await fetch(`${base()}/`)).status).toBe(200);
    rmSync(observersPath);
    // Two checks 3 s apart take the grants away.
    expect(await shellStatusBecomes(401)).toBe(401);
  }, 20_000);

  test("an observer whose socket's close throws is named, and closed at a later check while its grant stays gone", async () => {
    const kp4 = makeKeypair();
    const host = `127.0.0.1:${port}`;
    const id = 900_001;
    const sent: string[] = [];
    const closes: number[] = [];
    let throws = 1;
    const m = mod as unknown as { onWsOpen(ws: unknown): void; onWsMessage(ws: unknown, msg: string): void; onWsClose(ws: unknown): void };
    const fakeWs = {
      data: { id, authed: false, host },
      send: (s: string) => { sent.push(s); return s.length; },
      // A close that succeeds runs the server's close handler inside it, as
      // Bun's does (receipt ws-close-timing-bun-1.4.3-and-1.3.14.txt).
      close: (code?: number) => {
        if (throws-- > 0) throw new Error('socket');
        closes.push(code!);
        m.onWsClose(fakeWs);
      },
    };
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    try {
      saveObserversFile(observersPath, { observers: [{ key: kp4.id, label: 'unclosable', scopes: ['health'] }] });
      expect(await shellStatusBecomes(200)).toBe(200);
      m.onWsOpen(fakeWs);
      m.onWsMessage(fakeWs, JSON.stringify({ type: 'observer-hello', identity: helloFor(kp4, host) }));
      await waitUntil(() => sent.some((s) => (JSON.parse(s) as { type: string }).type === 'observer-ack'), 5000);

      saveObserversFile(observersPath, { observers: [] });
      await waitUntil(() => closes.length > 0, 15_000);
      // The revoke's check named it, and a later check closed it.
      expect(closes).toEqual([4401]);
      expect(lines.filter((l) => l.startsWith('[webui-observers] observer connection'))).toEqual([
        "[webui-observers] observer connection couldn't be closed: unclosable (socket); each check tries again while its grant is gone, expired or narrowed",
      ]);
    } finally {
      spy.mockRestore();
      saveObserversFile(observersPath, { observers: [] });
      await shellStatusBecomes(401);
    }
  }, 30_000);

  test('a session the check narrowed stays narrowed when the grant is widened again, though it was not used between', async () => {
    const kp3 = makeKeypair();
    const host = `127.0.0.1:${port}`;
    const sockets: WebSocket[] = [];
    // Says hello on a new socket and resolves with the ack and the socket's close code.
    const connect = async () => {
      const ws = new WebSocket(`ws://${host}/ws`);
      sockets.push(ws);
      const frames: Record<string, unknown>[] = [];
      ws.addEventListener('message', (ev) => frames.push(JSON.parse(String(ev.data))));
      const closed = new Promise<number>((r) => ws.addEventListener('close', (ev) => r(ev.code)));
      const frame = async (type: string) => {
        await waitUntil(() => frames.some((m) => m.type === type), 5000);
        const f = frames.find((m) => m.type === type);
        if (!f) throw new Error(`timeout waiting for ${type}`);
        return f;
      };
      await frame('observer-auth-required');
      ws.send(JSON.stringify({ type: 'observer-hello', identity: helloFor(kp3, host) }));
      return { ack: await frame('observer-ack'), closed };
    };
    const debug = async (cookie: string) => (await fetch(`${base()}/debug/state`, { headers: { cookie } })).status;
    // Whether the static shell is served without the password: some grant is in.
    const shellOpen = async () => (await fetch(`${base()}/`)).status === 200;
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      saveObserversFile(observersPath, { observers: [{ key: kp3.id, label: 'narrowed', scopes: ['health', 'debug'] }] });
      // The next check admits it: the static shell no longer asks for the password.
      for (const end = Date.now() + 8000; !(await shellOpen()) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
      const kept = await connect();
      expect(kept.ack.scopes).toEqual(['health', 'debug']);
      const keptCookie = `fkm_obs=${kept.ack.sessionToken}`;

      // Narrowed at a check, while nothing uses the kept session.
      saveObserversFile(observersPath, { observers: [{ key: kp3.id, label: 'narrowed', scopes: ['health'] }] });
      expect(await kept.closed).toBe(4403);

      // Widened again: a new hello gets debug back once a check reads it,
      // and until then gets the narrowed grant.
      saveObserversFile(observersPath, { observers: [{ key: kp3.id, label: 'narrowed', scopes: ['health', 'debug'] }] });
      let fresh = await connect();
      for (const end = Date.now() + 8000; !(fresh.ack.scopes as string[]).includes('debug') && Date.now() < end;) {
        expect(fresh.ack.scopes).toEqual(['health']);
        await new Promise((r) => setTimeout(r, 200));
        fresh = await connect();
      }
      expect(fresh.ack.scopes).toEqual(['health', 'debug']);
      expect(await debug(`fkm_obs=${fresh.ack.sessionToken}`)).not.toBe(401);

      // The kept session, first used now, stays as the check narrowed it:
      // refused debug, and still past the health gate it kept, which answers
      // 503 here with no app, where an ended session would get 401.
      expect(await debug(keptCookie)).toBe(401);
      expect((await fetch(`${base()}/healthz`, { headers: { cookie: keptCookie } })).status).toBe(503);
    } finally {
      for (const ws of sockets) ws.close();
      // Leave the file with no grants, as the next case expects, once a check has read it.
      saveObserversFile(observersPath, { observers: [] });
      for (const end = Date.now() + 8000; (await shellOpen()) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
      spy.mockRestore();
    }
  }, 40_000);

  test('narrowing a grant closes its socket (4403) and narrows its cookie; revoking it closes the socket (4401) and ends the cookie', async () => {
    const kp2 = makeKeypair();
    const host = `127.0.0.1:${port}`;
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    // Says hello on a new socket and resolves with the ack and the socket's close code.
    const connect = async () => {
      const ws = new WebSocket(`ws://${host}/ws`);
      const frames: Record<string, unknown>[] = [];
      ws.addEventListener('message', (ev) => frames.push(JSON.parse(String(ev.data))));
      const closed = new Promise<number>((r) => ws.addEventListener('close', (ev) => r(ev.code)));
      const frame = async (type: string) => {
        await waitUntil(() => frames.some((m) => m.type === type), 5000);
        const f = frames.find((m) => m.type === type);
        if (!f) throw new Error(`timeout waiting for ${type}`);
        return f;
      };
      await frame('observer-auth-required');
      ws.send(JSON.stringify({ type: 'observer-hello', identity: helloFor(kp2, host) }));
      return { ack: await frame('observer-ack'), closed };
    };
    const healthz = async (cookie: string) => (await fetch(`${base()}/healthz`, { headers: { cookie } })).status;
    const debug = async (cookie: string) => (await fetch(`${base()}/debug/state`, { headers: { cookie } })).status;
    try {
      saveObserversFile(observersPath, { observers: [{ key: kp2.id, label: 'to-revoke', scopes: ['health', 'debug'] }] });
      // The next check admits it: the static shell no longer asks for the password.
      const shellOpen = async () => (await fetch(`${base()}/`)).status === 200;
      for (const end = Date.now() + 8000; !(await shellOpen()) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));

      const first = await connect();
      const cookie = `fkm_obs=${first.ack.sessionToken}`;
      expect(await healthz(cookie)).toBe(503);
      expect(await debug(cookie)).not.toBe(401);

      saveObserversFile(observersPath, { observers: [{ key: kp2.id, label: 'to-revoke', scopes: ['health'] }] });
      expect(await first.closed).toBe(4403);
      expect(await healthz(cookie)).toBe(503);
      expect(await debug(cookie)).toBe(401);
      const second = await connect();
      expect(second.ack.scopes).toEqual(['health']);

      saveObserversFile(observersPath, { observers: [] });
      expect(await second.closed).toBe(4401);
      expect(await healthz(cookie)).toBe(401);
      expect(lines.filter((l) => l.startsWith('[webui-observers] closed '))).toEqual([
        '[webui-observers] closed 1 observer connection(s) whose grant is gone, expired or narrowed, and ended 0 observer session(s) whose grant is gone, expired or keeps none of their scopes',
        '[webui-observers] closed 1 observer connection(s) whose grant is gone, expired or narrowed, and ended 2 observer session(s) whose grant is gone, expired or keeps none of their scopes',
      ]);

      // The second cookie wasn't used while the grant was gone. It ended at
      // that check all the same, and granting the key again doesn't bring it back.
      saveObserversFile(observersPath, { observers: [{ key: kp2.id, label: 'to-revoke', scopes: ['health'] }] });
      for (const end = Date.now() + 8000; !(await shellOpen()) && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
      expect(await shellOpen()).toBe(true);
      expect(await healthz(`fkm_obs=${second.ack.sessionToken}`)).toBe(401);
    } finally { spy.mockRestore(); }
  }, 40_000);
});
