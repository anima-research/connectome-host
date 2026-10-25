// Delegated access (MCPL RFC-015): the host's answer to `access/token`.
//
// agent-framework owns the protocol (the grant check, parameter validation,
// time bounds, the -32040 mapping, the advertisement); these tests pin the
// host's half: which servers get an `accessToken` provider at all, how it
// mints (a 15-minute lifetime asked of the home node, the real `exp` given
// back), its cache and two-minute margin, `fresh`, schemes, the refusal kinds,
// and the audit — with the home node a local HTTP server, and no real key.
import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';

import { IdentityModule } from '../src/modules/identity-module.ts';
import {
  ANSWER_CEILING_MS,
  ANSWER_MARGIN_MS,
  CACHE_MARGIN_MS,
  DELEGATED_TTL,
  DelegatedAccess,
  accessTokenGrant,
  auditEndpoint,
  auditLine,
  delegatedAccessFor,
  rfc3339,
  wireAccessTokens,
} from '../src/delegated-access.ts';
import { AccessRefusedError, type AccessTokenRequest } from '../src/af-access-shim.ts';
import {
  AGENT_DEPLOY_DENIED_CAPABILITIES,
  applyAgentOverlay,
  loadMcplServers,
  mergeRecipeServers,
  resolveOverlayEntry,
} from '../src/mcpl-config.ts';
import { validateRecipe } from '../src/recipe.ts';

const PRINCIPAL = 'agent:example@id.example';
const HOME = 'id.example';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type Reply = { status: number; json?: unknown } | 'hang';

/**
 * A home node on a local port: `/token` answers with `reply(body, n)` for its
 * n-th request (from 1), and records every body. The identity module dials
 * `https://<home>/token`; its fetchImpl sends that to this server instead.
 */
async function homeNode(reply: (body: Record<string, unknown>, n: number) => Reply) {
  const bodies: Array<Record<string, unknown>> = [];
  const hung: ServerResponse[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      bodies.push(body);
      const answer = req.url === '/token' ? reply(body, bodies.length) : { status: 404, json: { error: 'no route' } };
      if (answer === 'hang') {
        hung.push(res);
        return;
      }
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.json ?? {}));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => new Promise<void>((done) => {
    for (const res of hung) res.destroy();
    server.closeAllConnections?.();
    server.close(() => done());
  }));
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    return fetch(`http://127.0.0.1:${port}${u.pathname}`, init);
  }) as typeof fetch;
  return { bodies, fetchImpl, port };
}

/** An identity registered as PRINCIPAL: a throwaway key made for the test,
 *  and its record written as the host writes one (the host makes no new key
 *  beside a registration, so the key comes first). */
function registeredIdentity(fetchImpl: typeof fetch, opts: { registered?: boolean } = {}) {
  const dir = tempDir('deleg-');
  const keyPath = join(dir, 'identity-key.pem');
  if (opts.registered !== false) {
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    writeFileSync(join(dir, 'identity-key.json'), JSON.stringify({ sub: PRINCIPAL, name: 'Example', home: HOME, enrolledAt: 'then' }));
  }
  const identity = new IdentityModule({ keyPath, home: HOME, fetchImpl });
  return { identity, dir, auditPath: join(dir, 'access-audit.jsonl') };
}

function request(overrides: Partial<AccessTokenRequest> = {}): AccessTokenRequest {
  return { serverId: 'games', audience: 'games', fresh: false, schemes: ['bearer'], timeoutMs: 30_000, ...overrides };
}

/** Seconds since the epoch, `ms` from now. */
const expIn = (ms: number, now = Date.now()) => Math.floor((now + ms) / 1000);

function auditRecords(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function refusalOf(promise: Promise<unknown>): Promise<{ kind: string; reason: string }> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AccessRefusedError);
    return err as unknown as { kind: string; reason: string };
  }
  throw new Error('expected a refusal');
}

// ---------------------------------------------------------------------------

describe('wiring: only an explicit grant, only with an identity', () => {
  it('grants access.token for the exact path alone, never a wildcard or a parent', () => {
    expect(accessTokenGrant({ enabledCapabilities: ['channels', 'access.token'] })).toEqual({ granted: true, warnings: [] });
    for (const near of ['access.*', '*.token', '*.*', 'access', '*']) {
      const grant = accessTokenGrant({ enabledCapabilities: ['channels', near] });
      expect(grant.granted).toBe(false);
      expect(grant.warnings).toHaveLength(1);
      expect(grant.warnings[0]).toContain(JSON.stringify(near));
      expect(grant.warnings[0]).toContain('name "access.token" itself');
    }
    // Not named at all, or not a list: nothing granted, nothing to warn of.
    expect(accessTokenGrant({ enabledCapabilities: ['channels', 'pushEvents'] })).toEqual({ granted: false, warnings: [] });
    expect(accessTokenGrant({})).toEqual({ granted: false, warnings: [] });
    expect(accessTokenGrant({ enabledCapabilities: 'access.token' })).toEqual({ granted: false, warnings: [] });
    // Case and spacing are not the path.
    expect(accessTokenGrant({ enabledCapabilities: ['Access.Token', ' access.token'] }).granted).toBe(false);
  });

  it('lets a deny-list pattern covering access.token win over the grant', () => {
    for (const deny of ['access', 'access.token', 'access.*', '*', '*.token']) {
      const grant = accessTokenGrant({ enabledCapabilities: ['access.token'], disabledCapabilities: [deny] });
      expect(grant.granted).toBe(false);
      expect(grant.warnings[0]).toContain('the deny-list wins');
    }
    // A deny-list that covers something else leaves the grant.
    expect(accessTokenGrant({ enabledCapabilities: ['access.token'], disabledCapabilities: ['contextHooks', 'access.other'] }).granted)
      .toBe(true);
  });

  it('attaches the provider to the explicitly granted servers alone, and drops one a config carried', async () => {
    const { fetchImpl } = await homeNode(() => ({ status: 500 }));
    const { identity, auditPath } = registeredIdentity(fetchImpl);
    const wiring = delegatedAccessFor(identity, { auditPath });
    expect(wiring.access).toBeInstanceOf(DelegatedAccess);
    const servers: Array<{ id: string } & Record<string, unknown>> = [
      { id: 'granted', url: 'ws://127.0.0.1:1/x', enabledCapabilities: ['tools', 'access.token'] },
      { id: 'wildcard', url: 'ws://127.0.0.1:1/x', enabledCapabilities: ['access.*'] },
      { id: 'plain', command: 'node' },
      { id: 'smuggled', command: 'node', accessToken: 'not a function' },
    ];
    const lines = wireAccessTokens(servers, wiring);
    expect(servers[0].accessToken).toBe(wiring.access!.provide);
    for (const server of servers.slice(1)) expect('accessToken' in server).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[mcpl] server "wildcard"');
  });

  it('wires nothing, and says so, for a host with no identity or no registration', async () => {
    const none = delegatedAccessFor(null, { auditPath: null });
    expect(none.access).toBeNull();
    const servers = [{ id: 'granted', command: 'node', enabledCapabilities: ['access.token'] }];
    const lines = wireAccessTokens(servers, none);
    expect('accessToken' in servers[0]).toBe(false);
    expect(lines.join('\n')).toContain('the recipe has no identity module');
    expect(lines.join('\n')).toContain('the host doesn\'t advertise access to it');

    const { fetchImpl, bodies } = await homeNode(() => ({ status: 200, json: { token: 'never', exp: expIn(900_000) } }));
    const { identity } = registeredIdentity(fetchImpl, { registered: false });
    const unregistered = delegatedAccessFor(identity, { auditPath: null });
    expect(unregistered.access).toBeNull();
    const again = [{ id: 'granted', command: 'node', enabledCapabilities: ['access.token'] }];
    expect(wireAccessTokens(again, unregistered).join('\n')).toContain(`no registration with the identity service at ${HOME}`);
    expect('accessToken' in again[0]).toBe(false);
    expect(bodies).toHaveLength(0);
  });

  it('never grants access.token to a server the agent deployed for itself', () => {
    expect(AGENT_DEPLOY_DENIED_CAPABILITIES).toContain('access');
    const resolved = resolveOverlayEntry('mine', {
      url: 'ws://127.0.0.1:1/x',
      enabledCapabilities: ['access.token'],
    } as never, join(tmpdir(), 'mcpl-servers.agent.json'))!;
    expect(resolved.enabledCapabilities).toBeUndefined();
    expect(resolved.disabledCapabilities).toContain('access');
    expect(accessTokenGrant(resolved).granted).toBe(false);
  });

  it('keeps the grant on a server the recipe defines, and only there', () => {
    const fileServers = [{ id: 'filed', command: 'node' }];
    const merged = mergeRecipeServers(
      {
        own: { command: 'node', enabledCapabilities: ['access.token'] },
        filed: { enabledCapabilities: ['access.token'] },
      },
      fileServers,
    );
    const byId = Object.fromEntries(merged.map((s) => [s.id, s]));
    expect(accessTokenGrant(byId.own).granted).toBe(true);
    // A recipe's override of a file server never passes the grant on.
    expect(accessTokenGrant(byId.filed).granted).toBe(false);
    // And an overlay entry replacing the recipe's server takes it away.
    const dir = tempDir('deleg-overlay-');
    const overlayPath = join(dir, 'mcpl-servers.agent.json');
    writeFileSync(overlayPath, JSON.stringify({ mcplServers: { own: { command: 'node', enabledCapabilities: ['access.token'] } } }));
    const replaced = applyAgentOverlay(merged, overlayPath).find((s) => s.id === 'own')!;
    expect(accessTokenGrant(replaced).granted).toBe(false);
  });
});

describe('toolHints (RFC-014 opt-in)', () => {
  it('is a per-server boolean in the recipe, passed through, and refused as anything else', () => {
    const recipe = (toolHints: unknown) => ({
      name: 'hints',
      agent: { systemPrompt: 'sys' },
      mcpServers: { surfaces: { command: 'node', toolHints } },
    });
    expect(validateRecipe(recipe(true)).mcpServers!.surfaces.toolHints).toBe(true);
    expect(validateRecipe(recipe(false)).mcpServers!.surfaces.toolHints).toBe(false);
    expect(() => validateRecipe(recipe('true'))).toThrow('mcpServers.surfaces.toolHints must be true or false');
  });

  it('comes from mcpl-servers.json, and a recipe naming the server may override it', () => {
    const dir = tempDir('deleg-file-');
    const path = join(dir, 'mcpl-servers.json');
    writeFileSync(path, JSON.stringify({ mcplServers: { surfaces: { command: 'node', toolHints: true }, other: { command: 'node' } } }));
    const loaded = loadMcplServers(path);
    expect(loaded.find((s) => s.id === 'surfaces')!.toolHints).toBe(true);
    expect('toolHints' in loaded.find((s) => s.id === 'other')!).toBe(false);
    const merged = mergeRecipeServers({ surfaces: { toolHints: false }, other: {} }, loaded as never);
    expect(merged.find((s) => s.id === 'surfaces')!.toolHints).toBe(false);

    writeFileSync(path, JSON.stringify({ mcplServers: { surfaces: { command: 'node', toolHints: 'yes' } } }));
    expect(() => loadMcplServers(path)).toThrow('mcplServers.surfaces.toolHints must be true or false');
  });
});

describe('minting', () => {
  it('asks the home node for a 15-minute lifetime and gives back its real exp, as RFC 3339 UTC', async () => {
    const exp = expIn(14 * 60_000 + 30_000);
    const { fetchImpl, bodies } = await homeNode(() => ({ status: 200, json: { token: 'aid1.minted.1', sub: PRINCIPAL, exp } }));
    const { identity, auditPath } = registeredIdentity(fetchImpl);
    const access = new DelegatedAccess({ identity, auditPath });
    const result = await access.provide(request({ endpoint: 'wss://games.example/mcpl', purpose: 'doom-1: opened by the agent' }));
    expect(result).toEqual({ scheme: 'bearer', credential: 'aid1.minted.1', expiresAt: rfc3339(exp * 1000), principal: PRINCIPAL });
    expect(result.expiresAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].ttl).toBe(DELEGATED_TTL);
    expect(DELEGATED_TTL).toBe('15m');
    expect(bodies[0].audience).toBe('games');
    expect(typeof bodies[0].proof).toBe('string');
  });

  it('leaves accessFor, the per-dial exchange, as it was: no ttl, its own token back', async () => {
    const { fetchImpl, bodies } = await homeNode((_body, n) => ({ status: 200, json: { token: `aid1.dial.${n}`, sub: PRINCIPAL } }));
    const { identity } = registeredIdentity(fetchImpl);
    expect(await identity.accessFor('eidoverse')).toBe('aid1.dial.1');
    expect(await identity.accessFor('eidoverse')).toBe('aid1.dial.2');
    expect(bodies.map((b) => 'ttl' in b)).toEqual([false, false]);
    expect(bodies.map((b) => b.audience)).toEqual(['eidoverse', 'eidoverse']);
  });

  it('reports a provider\'s own lifetime truthfully when it can\'t shorten it', async () => {
    // An identity service that ignores ttl issues its own lifetime.
    const exp = expIn(7 * 86_400_000);
    const { fetchImpl } = await homeNode(() => ({ status: 200, json: { token: 'aid1.long', sub: PRINCIPAL, exp } }));
    const { identity } = registeredIdentity(fetchImpl);
    const result = await new DelegatedAccess({ identity, auditPath: null }).provide(request());
    expect(result.expiresAt).toBe(rfc3339(exp * 1000));
  });

  it('offers bearer only: refuses a request that can\'t take it as host_policy, asking nothing of the home node', async () => {
    const { fetchImpl, bodies } = await homeNode((_b, n) => ({ status: 200, json: { token: `aid1.s.${n}`, sub: PRINCIPAL, exp: expIn(900_000) } }));
    const { identity, auditPath } = registeredIdentity(fetchImpl);
    const access = new DelegatedAccess({ identity, auditPath, log: () => {} });
    const refusal = await refusalOf(access.provide(request({ schemes: ['example-pop'] })));
    expect(refusal.kind).toBe('host_policy');
    expect(refusal.reason).toContain('"bearer"');
    expect(refusal.reason).toContain('"example-pop"');
    expect(bodies).toHaveLength(0);
    // Bearer anywhere in the list is bearer.
    expect((await access.provide(request({ schemes: ['example-pop', 'bearer'] }))).scheme).toBe('bearer');
  });
});

describe('cache', () => {
  it('reuses a credential per server and audience, and mints for another of either', async () => {
    const { fetchImpl, bodies } = await homeNode((_b, n) => ({ status: 200, json: { token: `aid1.c.${n}`, sub: PRINCIPAL, exp: expIn(900_000) } }));
    const { identity, auditPath } = registeredIdentity(fetchImpl);
    const access = new DelegatedAccess({ identity, auditPath });
    const first = await access.provide(request());
    expect((await access.provide(request())).credential).toBe(first.credential);
    expect((await access.provide(request({ audience: 'orrery' }))).credential).toBe('aid1.c.2');
    expect((await access.provide(request({ serverId: 'surfaces' }))).credential).toBe('aid1.c.3');
    expect((await access.provide(request({ serverId: 'surfaces' }))).credential).toBe('aid1.c.3');
    expect(bodies).toHaveLength(3);
    expect(auditRecords(auditPath).map((r) => r.cached)).toEqual([false, true, false, false, true]);
  });

  it('shares one mint among requests that arrive while it is under way', async () => {
    const { fetchImpl, bodies } = await homeNode((_b, n) => ({ status: 200, json: { token: `aid1.p.${n}`, sub: PRINCIPAL, exp: expIn(900_000) } }));
    const { identity } = registeredIdentity(fetchImpl);
    const access = new DelegatedAccess({ identity, auditPath: null });
    const results = await Promise.all([access.provide(request()), access.provide(request()), access.provide(request())]);
    expect(new Set(results.map((r) => r.credential))).toEqual(new Set(['aid1.p.1']));
    expect(bodies).toHaveLength(1);
  });

  it('never answers from the cache with under two minutes left', async () => {
    let clock = Date.now();
    const start = clock;
    // A credential that lasts five minutes from the start.
    const { fetchImpl, bodies } = await homeNode((_b, n) => ({
      status: 200,
      json: { token: `aid1.m.${n}`, sub: PRINCIPAL, exp: expIn(5 * 60_000 + (n - 1) * 60 * 60_000, start) },
    }));
    const { identity } = registeredIdentity(fetchImpl);
    const access = new DelegatedAccess({ identity, auditPath: null, now: () => clock });
    const first = await access.provide(request());
    const expiresAtMs = Date.parse(first.expiresAt);
    // Exactly two minutes left: still from the cache.
    clock = expiresAtMs - CACHE_MARGIN_MS;
    expect((await access.provide(request())).credential).toBe('aid1.m.1');
    // A moment less: minted anew.
    clock = expiresAtMs - CACHE_MARGIN_MS + 1;
    expect((await access.provide(request())).credential).toBe('aid1.m.2');
    expect(bodies).toHaveLength(2);
    expect(CACHE_MARGIN_MS).toBe(120_000);
  });

  it('mints anew for `fresh`, and later requests get the newer credential', async () => {
    const { fetchImpl, bodies } = await homeNode((_b, n) => ({ status: 200, json: { token: `aid1.f.${n}`, sub: PRINCIPAL, exp: expIn(900_000 + n * 1000) } }));
    const { identity, auditPath } = registeredIdentity(fetchImpl);
    const access = new DelegatedAccess({ identity, auditPath });
    expect((await access.provide(request())).credential).toBe('aid1.f.1');
    expect((await access.provide(request({ fresh: true }))).credential).toBe('aid1.f.2');
    expect((await access.provide(request())).credential).toBe('aid1.f.2');
    expect(bodies).toHaveLength(2);
    expect(auditRecords(auditPath).map((r) => [r.fresh, r.cached])).toEqual([[false, false], [true, false], [false, true]]);
  });

  it('keys the cache by principal, so a changed registration never gets the old one\'s credential', async () => {
    const { fetchImpl } = await homeNode((_b, n) => ({ status: 200, json: { token: `aid1.k.${n}`, exp: expIn(900_000) } }));
    const { identity, dir } = registeredIdentity(fetchImpl);
    const access = new DelegatedAccess({ identity, auditPath: null });
    expect(await access.provide(request())).toMatchObject({ credential: 'aid1.k.1', principal: PRINCIPAL });
    writeFileSync(join(dir, 'identity-key.json'), JSON.stringify({ sub: 'agent:other@id.example', name: 'Other', home: HOME, enrolledAt: 'then' }));
    expect(await access.provide(request())).toMatchObject({ credential: 'aid1.k.2', principal: 'agent:other@id.example' });
  });
});

describe('refusals: each failure has its kind', () => {
  const cases: Array<[string, Reply, string, string]> = [
    ['a 403', { status: 403, json: { error: 'audience not allowed' } }, 'provider_refused', 'refused access to "games" (403: audience not allowed)'],
    ['a 400', { status: 400, json: { error: 'unknown audience' } }, 'provider_refused', '(400: unknown audience)'],
    ['a 429', { status: 429, json: { error: 'slow down' } }, 'rate_limited', '(429: slow down)'],
    ['a 500', { status: 500, json: { error: 'boom' } }, 'unavailable', '(500: boom)'],
    ['a 503', { status: 503 }, 'unavailable', '(503: no reason given)'],
    ['a 200 with no token', { status: 200, json: { sub: PRINCIPAL, exp: 1 } }, 'unavailable', 'its reply couldn\'t be read'],
    ['no exp', { status: 200, json: { token: 'aid1.noexp', sub: PRINCIPAL } }, 'unavailable', 'gave no expiry'],
    ['an exp that isn\'t a number', { status: 200, json: { token: 'aid1.isoexp', sub: PRINCIPAL, exp: '2099-01-01T00:00:00Z' } }, 'unavailable', 'gave no expiry'],
    ['an exp already past', { status: 200, json: { token: 'aid1.stale', sub: PRINCIPAL, exp: 1_000_000 } }, 'unavailable', 'already expired'],
  ];
  for (const [what, reply, kind, says] of cases) {
    it(`maps ${what} to ${kind}`, async () => {
      const { fetchImpl } = await homeNode(() => reply);
      const { identity, auditPath } = registeredIdentity(fetchImpl);
      const logged: string[] = [];
      const refusal = await refusalOf(new DelegatedAccess({ identity, auditPath, log: (l) => logged.push(l) }).provide(request()));
      expect(refusal.kind).toBe(kind);
      expect(refusal.reason).toContain(says);
      const [record] = auditRecords(auditPath);
      expect(record).toMatchObject({ outcome: 'refused', kind, server: 'games', audience: 'games' });
      expect(record.expiresAt).toBeUndefined();
      // A credential the home node gave without a usable expiry is never kept or said.
      const everything = readFileSync(auditPath, 'utf8') + logged.join('\n') + refusal.reason;
      expect(everything).not.toContain('aid1.');
    });
  }

  it('maps a home node that can\'t be reached to unavailable', async () => {
    const { port } = await homeNode(() => ({ status: 200 }));
    await cleanups.pop()!(); // close it: the port now refuses connections
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${port}${new URL(String(url)).pathname}`, init)) as typeof fetch;
    const { identity } = registeredIdentity(fetchImpl);
    const refusal = await refusalOf(new DelegatedAccess({ identity, auditPath: null, log: () => {} }).provide(request()));
    expect(refusal.kind).toBe('unavailable');
    expect(refusal.reason).toContain(`the identity service at ${HOME} couldn't be reached`);
  });

  it('answers unavailable inside agent-framework\'s wait when the home node doesn\'t answer, and audits that', async () => {
    const { fetchImpl, bodies } = await homeNode(() => 'hang');
    const { identity, auditPath } = registeredIdentity(fetchImpl);
    // agent-framework hands the callback its own wait: for a request's
    // smallest timeoutMs, 5000, that's 5000 − 2000 = 3000 ms.
    const started = Date.now();
    const refusal = await refusalOf(
      new DelegatedAccess({ identity, auditPath, log: () => {} }).provide(request({ timeoutMs: 3_000 })),
    );
    const took = Date.now() - started;
    expect(refusal.kind).toBe('unavailable');
    expect(took).toBeGreaterThanOrEqual(3_000 - ANSWER_MARGIN_MS - 100);
    expect(took).toBeLessThan(3_000);
    expect(bodies).toHaveLength(1);
    expect(auditRecords(auditPath)).toMatchObject([{ outcome: 'refused', kind: 'unavailable' }]);
  });

  it('never waits past 20 seconds, whatever wait it is handed', async () => {
    const { fetchImpl } = await homeNode(() => 'hang');
    const { identity } = registeredIdentity(fetchImpl);
    const asked: number[] = [];
    const watched = Object.assign(Object.create(identity) as IdentityModule, {
      mint: (audience: string, opts: { ttl?: string; timeoutMs?: number }) => {
        asked.push(opts.timeoutMs!);
        return Promise.reject(new Error('stop here'));
      },
    });
    const clock = Date.now();
    await refusalOf(
      new DelegatedAccess({ identity: watched, auditPath: null, log: () => {}, now: () => clock }).provide(request({ timeoutMs: 118_000 })),
    );
    expect(asked).toEqual([ANSWER_CEILING_MS - ANSWER_MARGIN_MS]);
  });

  it('refuses no_identity when the registration is gone after wiring, or the key can\'t be had', async () => {
    const { fetchImpl, bodies } = await homeNode(() => ({ status: 200, json: { token: 'aid1.x', exp: expIn(900_000) } }));
    const { identity, dir } = registeredIdentity(fetchImpl);
    const access = new DelegatedAccess({ identity, auditPath: null, log: () => {} });
    rmSync(join(dir, 'identity-key.json'));
    const gone = await refusalOf(access.provide(request()));
    expect(gone.kind).toBe('no_identity');
    expect(gone.reason).toContain(`no registration with the identity service at ${HOME}`);

    writeFileSync(join(dir, 'identity-key.json'), JSON.stringify({ sub: PRINCIPAL, name: 'Example', home: HOME, enrolledAt: 'then' }));
    writeFileSync(join(dir, 'identity-key.pem'), 'not a key');
    const unloaded = await refusalOf(access.provide(request()));
    expect(unloaded.kind).toBe('no_identity');
    expect(unloaded.reason).toBe('the host\'s identity couldn\'t be loaded');
    // No host path reaches the server.
    expect(unloaded.reason).not.toContain(dir);
    expect(bodies).toHaveLength(0);
  });
});

describe('audit', () => {
  it('records each request, never the credential, with the endpoint cut to scheme, host, port and path', async () => {
    const { fetchImpl } = await homeNode((_b, n) => (n === 1
      ? { status: 200, json: { token: 'aid1.SECRET-CREDENTIAL', sub: PRINCIPAL, exp: expIn(900_000) } }
      : { status: 403, json: { error: 'audience not allowed' } }));
    const { identity, auditPath } = registeredIdentity(fetchImpl);
    const logged: string[] = [];
    const access = new DelegatedAccess({ identity, auditPath, log: (l) => logged.push(l) });
    const purpose = 'doom-1: opened\u2028by the agent \u202e';
    const issued = await access.provide(request({
      endpoint: 'wss://user:pw@games.example:8443/mcpl/v1?token=QUERYSECRET#FRAGSECRET',
      purpose,
    }));
    await access.provide(request());
    await refusalOf(access.provide(request({ audience: 'orrery', endpoint: 'https://orrery.example:443/api?x=1' })));

    const raw = readFileSync(auditPath, 'utf8');
    for (const secret of ['aid1.', 'SECRET', 'user:pw', 'QUERYSECRET', 'FRAGSECRET']) expect(raw).not.toContain(secret);
    expect(logged.join('\n')).not.toContain('aid1.');
    // Free text reaches the record as data: the line separator and the bidi
    // override are escaped in the line, and read back as given.
    expect(raw).not.toContain('\u2028');
    expect(raw).not.toContain('\u202e');
    expect(raw).toContain('\\u2028');
    expect(raw.trim().split('\n')).toHaveLength(3);

    const [first, second, third] = auditRecords(auditPath);
    expect(first).toMatchObject({
      server: 'games',
      audience: 'games',
      endpoint: 'wss://games.example:8443/mcpl/v1',
      purpose,
      fresh: false,
      outcome: 'issued',
      cached: false,
      scheme: 'bearer',
      expiresAt: issued.expiresAt,
      principal: PRINCIPAL,
    });
    expect(Date.parse(String(first.time))).not.toBeNaN();
    expect(second).toMatchObject({ outcome: 'issued', cached: true, expiresAt: issued.expiresAt });
    expect('endpoint' in second).toBe(false);
    expect(third).toMatchObject({
      audience: 'orrery',
      endpoint: 'https://orrery.example/api',
      outcome: 'refused',
      kind: 'provider_refused',
    });
    expect(String(third.reason)).toContain('audience not allowed');
  });

  it('cuts endpoints as RFC-015 §8.2 says, and records an unreadable one as null, not as given', () => {
    expect(auditEndpoint('wss://games.example/mcpl')).toBe('wss://games.example/mcpl');
    expect(auditEndpoint('https://a:b@api.example:8443/p/q?token=t#f')).toBe('https://api.example:8443/p/q');
    expect(auditEndpoint('https://api.example:443/p')).toBe('https://api.example/p');
    expect(auditEndpoint('mcpl://user@host.example:99/x?y')).toBe('mcpl://host.example:99/x');
    expect(auditEndpoint('file:///srv/socket')).toBe('file:///srv/socket');
    expect(auditEndpoint('urn:example:games?token=t')).toBe('urn:example:games');
    expect(auditEndpoint('relative/path?token=t')).toBeNull();
    expect(auditEndpoint(undefined)).toBeUndefined();
  });

  it('escapes what a log reader could misread, and keeps the line valid JSON', () => {
    const line = auditLine({
      time: 't', server: 's', audience: 'a\u0085b', purpose: 'x\u2029y\u200bz\u0000"', fresh: false, outcome: 'refused',
    });
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b\u2029]/);
    expect(JSON.parse(line)).toMatchObject({ audience: 'a\u0085b', purpose: 'x\u2029y\u200bz\u0000"' });
  });

  it('keeps answering when the audit can\'t be written, and says so in the log without the credential', async () => {
    const { fetchImpl } = await homeNode(() => ({ status: 200, json: { token: 'aid1.unaudited', sub: PRINCIPAL, exp: expIn(900_000) } }));
    const { identity, dir } = registeredIdentity(fetchImpl);
    const logged: string[] = [];
    const access = new DelegatedAccess({ identity, auditPath: join(dir, 'missing-dir', 'audit.jsonl'), log: (l) => logged.push(l) });
    expect((await access.provide(request())).credential).toBe('aid1.unaudited');
    expect(logged.join('\n')).toContain('couldn\'t append to the access audit');
    expect(logged.join('\n')).not.toContain('aid1.');
  });
});
