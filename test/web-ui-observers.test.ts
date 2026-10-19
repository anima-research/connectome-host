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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  __getSharedServerPortForTests,
  __resetSharedServerForTests,
} from '../src/modules/web-ui-module.js';
import {
  ObserverRegistry,
  ObserverSessions,
  observerStatement,
  saveObserversFile,
  loadObserversFile,
  filterEntryForScopes,
  traceRequiredScope,
  scopeWelcome,
  type ObserverScope,
  type ObserversFile,
} from '../src/modules/web-ui-observers.js';
import type { WelcomeMessage, WelcomeMessageEntry } from '../src/web/protocol.js';

// ---------------------------------------------------------------------------
// Key helpers — raw ed25519 via node:crypto
// ---------------------------------------------------------------------------

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  const id = `ed25519:${raw.toString('base64url')}`;
  return { id, privateKey };
}

function helloFor(kp: ReturnType<typeof makeKeypair>, host: string, timestamp = new Date().toISOString()) {
  const proof = cryptoSign(null, Buffer.from(observerStatement(host, timestamp), 'utf8'), kp.privateKey);
  return {
    scheme: 'ed25519' as const,
    id: kp.id,
    proof: proof.toString('base64url'),
    timestamp,
  };
}

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

  test('full interiority scopes → identical entry', () => {
    const f = filterEntryForScopes(entry, new Set<ObserverScope>(['messages', 'thinking', 'tools']));
    expect(f).toEqual(entry);
  });

  test('trace scope mapping', () => {
    expect(traceRequiredScope({ type: 'ops:alert' })).toBe('ops');
    expect(traceRequiredScope({ type: 'mcpl:server-closed' })).toBe('ops');
    expect(traceRequiredScope({ type: 'usage:updated' })).toBe('health');
    expect(traceRequiredScope({ type: 'inference:tokens', blockType: 'thinking' } as never)).toBe('thinking');
    expect(traceRequiredScope({ type: 'inference:tokens', blockType: 'tool_call' } as never)).toBe('tools');
    expect(traceRequiredScope({ type: 'inference:tokens', blockType: 'text' } as never)).toBe('messages');
    expect(traceRequiredScope({ type: 'tool:started' })).toBe('tools');
    expect(traceRequiredScope({ type: 'inference:completed' })).toBe('messages');
  });

  test('scopeWelcome without messages empties conversation payload', () => {
    const welcome = {
      type: 'welcome', protocolVersion: 1,
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
  });

  // Health-gated telemetry must be masked exactly like its live frames:
  // `usage` and `call-ledger` pushes require the 'health' scope, so the
  // welcome cannot hand the same data to a messages-only observer.
  test('scopeWelcome without health strips callLedger/perAgentCost and zeroes usage', () => {
    const welcome = {
      type: 'welcome', protocolVersion: 1,
      messages: [entry],
      history: { startIndex: 40, totalCount: 240 },
      localTree: { asOfTs: 1, nodes: [], callIdIndex: {} },
      childTrees: [],
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 5, currency: 'USD' } },
      perAgentCost: [{ name: 'main', usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
      callLedger: {
        calls: [{ model: 'secret-model', error: 'raw provider error', costUsd: 0.42 }],
      },
    } as unknown as WelcomeMessage;

    const w = scopeWelcome(welcome, new Set<ObserverScope>(['messages']));
    expect(w.callLedger).toBeUndefined();
    expect(w.perAgentCost).toBeUndefined();
    expect(w.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(w.messages.length).toBe(1); // messages scope still gets content
    // No trace of the ledger anywhere in the serialized frame.
    expect(JSON.stringify(w)).not.toContain('secret-model');
    expect(JSON.stringify(w)).not.toContain('raw provider error');

    // Same masking on the no-messages branch (e.g. ops-only observer).
    const opsOnly = scopeWelcome(welcome, new Set<ObserverScope>(['ops']));
    expect(opsOnly.callLedger).toBeUndefined();
    expect(opsOnly.perAgentCost).toBeUndefined();
    expect(opsOnly.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

    // A health-scoped observer keeps the telemetry verbatim.
    const h = scopeWelcome(welcome, new Set<ObserverScope>(['health']));
    expect(h.callLedger).toEqual(welcome.callLedger);
    expect(h.perAgentCost).toEqual(welcome.perAgentCost);
    expect(h.usage).toEqual(welcome.usage);

    // Input welcome is never mutated (shared across clients in sendWelcome).
    expect(welcome.callLedger).toBeDefined();
    expect(welcome.usage.input).toBe(1);
  });
});

describe('ObserverSessions', () => {
  test('mint/lookup round-trip; bad token null; full flag carried', () => {
    const s = new ObserverSessions();
    const scopes = new Set<ObserverScope>(['health']);
    const token = s.mint(scopes);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(s.lookup(token)!.scopes).toBe(scopes);
    expect(s.lookup(token)!.full).toBe(false);
    expect(s.lookup('0'.repeat(64))).toBeNull();
    expect(s.lookup(null)).toBeNull();

    // Full sessions (password sign-in path) carry operator authority.
    const fullToken = s.mint(new Set(), { full: true });
    expect(s.lookup(fullToken)!.full).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end over a live module: empty grants → historical behavior; grant
// hot-appears → observer flow works.
// ---------------------------------------------------------------------------

const BASIC = `Basic ${Buffer.from('admin:pw').toString('base64')}`;

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
    await __resetSharedServerForTests();
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

    // Read-only: mutating messages are refused, naming the send's corrId so
    // the composer can take its row back.
    ws.send(JSON.stringify({ type: 'user-message', content: 'hi', corrId: 'obs-1' }));
    const errFrame = await got('error');
    expect(String(errFrame.message)).toContain('forbidden');
    expect(errFrame.corrId).toBe('obs-1');

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

  test("before the host is ready, an operator's send is refused naming its corrId", async () => {
    // This harness binds no app, so every message meets 'host not ready'.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin: base(), authorization: BASIC },
    } as unknown as undefined);
    const frames: Record<string, unknown>[] = [];
    ws.addEventListener('message', (ev) => frames.push(JSON.parse(String(ev.data))));
    await new Promise<void>((resolveOpen, reject) => {
      const t = setTimeout(() => reject(new Error('ws never opened')), 5000);
      ws.addEventListener('open', () => { clearTimeout(t); resolveOpen(); });
    });
    ws.send(JSON.stringify({ type: 'user-message', content: 'hi', corrId: 'early-1' }));
    const deadline = Date.now() + 5000;
    while (!frames.some((f) => f.type === 'error') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(frames.find((f) => f.type === 'error')).toMatchObject({ message: 'host not ready', corrId: 'early-1' });
    ws.close();
  });

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

  // Last: it takes the grants away for the rest of this block.
  test('file removed (hot-reload): the static shell needs the password again', async () => {
    expect((await fetch(`${base()}/`)).status).toBe(200);
    rmSync(observersPath);
    // Two checks 3 s apart take the grants away.
    expect(await shellStatusBecomes(401)).toBe(401);
  }, 20_000);
});
