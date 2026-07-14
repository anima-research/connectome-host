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
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
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
});

describe('ObserverSessions', () => {
  test('mint/lookup round-trip; bad token null', () => {
    const s = new ObserverSessions();
    const scopes = new Set<ObserverScope>(['health']);
    const token = s.mint(scopes);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(s.lookup(token)).toBe(scopes);
    expect(s.lookup('0'.repeat(64))).toBeNull();
    expect(s.lookup(null)).toBeNull();
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

  test('no grants: static requires basic auth, unauthenticated WS upgrade 401', async () => {
    expect((await fetch(`${base()}/`)).status).toBe(401);
    const res = await fetch(`${base()}/ws`, {
      headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    });
    expect(res.status).toBe(401);
  });

  test('grant appears (hot-reload): static public, observer WS flow end-to-end', async () => {
    saveObserversFile(observersPath, {
      observers: [{ key: kp.id, label: 'e2e-device', scopes: ['health', 'ops'] }],
    });
    await new Promise((r) => setTimeout(r, 3600)); // registry poll is 3s

    // Static app shell now public (carries no data).
    expect((await fetch(`${base()}/`)).status).toBe(200);
    // But data routes still gated.
    expect((await fetch(`${base()}/healthz`)).status).toBe(401);

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
    expect((ack.scopes as string[]).sort()).toEqual(['health', 'ops']);

    // Read-only: mutating messages are refused.
    ws.send(JSON.stringify({ type: 'user-message', content: 'hi' }));
    const errFrame = await got('error');
    expect(String(errFrame.message)).toContain('forbidden');

    // Session cookie: health allowed, debug denied (not in scopes).
    const cookie = `fkm_obs=${ack.sessionToken}`;
    // healthz returns 503 (app not bound in this harness) — auth passed.
    expect((await fetch(`${base()}/healthz`, { headers: { cookie } })).status).toBe(503);
    expect((await fetch(`${base()}/debug/context`, { headers: { cookie } })).status).toBe(401);
    // Basic auth still works for everything.
    expect((await fetch(`${base()}/healthz`, { headers: { authorization: BASIC } })).status).toBe(503);

    ws.close();
  }, 15_000);

  test('wrong key: hello rejected and socket closed', async () => {
    const stranger = makeKeypair();
    const host = `127.0.0.1:${port}`;
    const ws = new WebSocket(`ws://${host}/ws`);
    const closed = new Promise<number>((r) => ws.addEventListener('close', (ev) => r(ev.code)));
    await new Promise<void>((r) => ws.addEventListener('open', () => r()));
    ws.send(JSON.stringify({ type: 'observer-hello', identity: helloFor(stranger, host) }));
    expect(await closed).toBe(4401);
  }, 10_000);
});
