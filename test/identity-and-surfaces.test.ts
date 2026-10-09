// Identity module (archipelago-home client) + the tools↔utilities surface
// flags on mcpl-admin and observers. See docs/home-node.md §4 and the af
// utils meta-tool (Module.getUtilities).
//
// Design under test: the AGENT surface is credential-free (status /
// accept_invite, no tokens in any result); credentials exist only on the
// HOST-facing API (accessFor/httpAuthFor) that the MCPL dial provider
// and HTTP helpers consume outside model context.
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

import { IdentityModule } from '../src/modules/identity-module.ts';
import { McplAdminModule } from '../src/modules/mcpl-admin-module.ts';
import { ObserversModule } from '../src/modules/observers-module.ts';

const REQUEST_BODY_MAX_FOR_TEST = 256 * 1024;
const call = (name: string, input: unknown) => ({ id: 't1', name, input });

function fakeHome(routes: Record<string, (body: any) => { status: number; json: unknown }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const handler = routes[path];
    if (!handler) return new Response('{}', { status: 404 });
    const body = JSON.parse(String(init?.body ?? '{}'));
    const { status, json } = handler(body);
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
}

describe('identity module', () => {
  it('is utilities-only, and the agent surface never mentions or returns credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    const mod = new IdentityModule({ keyPath: join(dir, 'identity-key.pem'), home: 'id.test' });
    expect(mod.getTools()).toEqual([]);
    expect(mod.getUtilities().map((u) => u.name)).toEqual(['status', 'request', 'accept_invite']);
    // Framing check: no crypto/credential vocabulary in agent-visible text.
    const visible = JSON.stringify(mod.getUtilities()).toLowerCase();
    for (const scary of ['token', 'key', 'sign', 'proof', 'ed25519', 'mint', 'bearer']) {
      expect(visible).not.toContain(scary);
    }

    const res = await mod.handleToolCall(call('status', {}));
    expect(res.success).toBe(true);
    const data = res.data as { registeredAs: unknown; note: string };
    expect(data.registeredAs).toBe(null);
    expect(data.note).toContain('invitation code');
    expect(JSON.stringify(res.data)).not.toContain('ed25519'); // key exists on disk, not in results
    expect(existsSync(join(dir, 'identity-key.pem'))).toBe(true);
  });

  it('accept_invite registers, echoes NO credential, and is one-time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    let seen: any = null;
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      fetchImpl: fakeHome({
        '/enroll': (body) => {
          seen = body;
          return { status: 200, json: { sub: 'agent:ferro@guest', token: 'aid1.SECRET.x' } };
        },
      }),
    });
    const res = await mod.handleToolCall(call('accept_invite', { invite: 'inv_1', name: 'Ferro' }));
    expect(res.success).toBe(true);
    expect((res.data as any).id).toBe('agent:ferro@guest');
    // The home node's response token must NOT reach the agent.
    expect(JSON.stringify(res.data)).not.toContain('aid1.');

    // Wire-level: the signed statement is the spec's, verifiable by the module's own key.
    const raw = Buffer.from(seen.id.slice('ed25519:'.length), 'base64url');
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
      format: 'der', type: 'spki',
    });
    const statement = `archipelago-enroll|v1|id.test|inv_1|${seen.timestamp}`;
    expect(cryptoVerify(null, Buffer.from(statement), key, Buffer.from(seen.proof, 'base64url'))).toBe(true);

    const rec = JSON.parse(readFileSync(join(dir, 'k.json'), 'utf8'));
    expect(rec.sub).toBe('agent:ferro@guest');

    const again = await mod.handleToolCall(call('accept_invite', { invite: 'inv_2', name: 'Ferro2' }));
    expect(again.success).toBe(false);
    expect(again.error).toContain('Already registered');
  });


  it('request: allowlisted service, host-attached access, no credential in result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    let authSeen = '';
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      services: { orrery: 'https://orrery.test' },
      fetchImpl: (async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes('/enroll')) return new Response(JSON.stringify({ sub: 'agent:a@guest', token: 't0' }), { status: 200 });
        if (u.includes('/token')) return new Response(JSON.stringify({ token: 'aid1.fresh.secret' }), { status: 200 });
        if (u === 'https://orrery.test/api/ops') {
          authSeen = String(init?.headers?.authorization ?? '');
          return new Response(JSON.stringify({ ops: [1, 2] }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      }) as typeof fetch,
    });
    // not registered yet -> neutral failure
    const early = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/ops' }));
    expect(early.success).toBe(false);

    await mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' }));
    const res = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/ops' }));
    expect(res.success).toBe(true);
    expect((res.data as any).status).toBe(200);
    expect((res.data as any).body).toEqual({ ops: [1, 2] });
    expect(authSeen).toBe('Bearer aid1.fresh.secret');
    // the credential must never appear in the agent-visible result
    expect(JSON.stringify(res.data)).not.toContain('aid1.');

    const unknown = await mod.handleToolCall(call('request', { service: 'nope', path: '/x' }));
    expect(unknown.error).toContain('Available: orrery');
    const badPath = await mod.handleToolCall(call('request', { service: 'orrery', path: 'api/ops' }));
    expect(badPath.success).toBe(false);
  });

  it('request: services come from the home node directory, and a newly-listed one works without a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    // The archipelago's service list lives at the home node, not in this host.
    // It changes underneath us mid-run: `music` is added after the module has
    // already fetched and cached a directory without it.
    let directory: Record<string, string> = { orrery: 'https://orrery.test' };
    let directoryFetches = 0;
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      fetchImpl: (async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes('/enroll')) return new Response(JSON.stringify({ sub: 'agent:a@id.test', token: 't0' }), { status: 200 });
        if (u.includes('/token')) return new Response(JSON.stringify({ token: 'aid1.fresh.secret' }), { status: 200 });
        if (u === 'https://id.test/services') {
          directoryFetches++;
          return new Response(JSON.stringify({ home: 'id.test', services: directory }), { status: 200 });
        }
        if (u === 'https://music.test/api/me') return new Response(JSON.stringify({ me: 'mythos' }), { status: 200 });
        return new Response('{}', { status: 404 });
      }) as typeof fetch,
    });
    await mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' }));

    // nothing compiled in, nothing in the recipe: the directory supplied it
    const listed = await mod.handleToolCall(call('request', { service: 'orrery', path: '/x' }));
    expect(listed.success).toBe(true); // resolved and called; upstream 404 is reported, not a resolution failure
    expect((listed.data as any).status).toBe(404);

    // music does not exist yet -> refused, and the refusal cost a re-check
    const before = await mod.handleToolCall(call('request', { service: 'music', path: '/api/me' }));
    expect(before.success).toBe(false);
    expect(before.error).toContain('Unknown service "music"');

    // operator adds it at the home node; no restart, no recipe edit here
    directory = { orrery: 'https://orrery.test', music: 'https://music.test' };
    const fetchesBefore = directoryFetches;

    const after = await mod.handleToolCall(call('request', { service: 'music', path: '/api/me' }));
    expect(after.success).toBe(true);
    expect((after.data as any).body).toEqual({ me: 'mythos' });
    // it re-asked rather than serving a stale "unknown" from cache
    expect(directoryFetches).toBeGreaterThan(fetchesBefore);
  });

  it('request: a home node that cannot be reached degrades to the built-in map, never to an outage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      fetchImpl: (async (url: any) => {
        const u = String(url);
        if (u.includes('/enroll')) return new Response(JSON.stringify({ sub: 'agent:a@id.test', token: 't0' }), { status: 200 });
        if (u.includes('/token')) return new Response(JSON.stringify({ token: 'aid1.fresh.secret' }), { status: 200 });
        if (u === 'https://id.test/services') return new Response('nope', { status: 503 });
        if (u === 'https://eidoverse.animalabs.ai/api/ping') return new Response(JSON.stringify({ ok: true }), { status: 200 });
        return new Response('{}', { status: 404 });
      }) as typeof fetch,
    });
    await mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' }));
    const res = await mod.handleToolCall(call('request', { service: 'eidoverse', path: '/api/ping' }));
    expect(res.success).toBe(true);
    expect((res.data as any).body).toEqual({ ok: true });
  });

  it('request: fromFile uploads a workspace file byte-exactly, without the bytes touching context', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    // A file far larger than the JSON body cap — the case that made this exist.
    const audio = Buffer.alloc(REQUEST_BODY_MAX_FOR_TEST + 4096, 0);
    audio.write('ID3', 0);
    audio[audio.length - 1] = 0x7f;
    let sentBody: Buffer | null = null;
    let sentType = '';
    const workspace = {
      readBinary: async (path: string) =>
        path === 'files/music/track.mp3' ? { data: audio } : { error: `File not found: ${path}` },
      writeBinary: async () => ({ success: true }),
    };
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      services: { music: 'https://music.test' },
      fetchImpl: (async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes('/enroll')) return new Response(JSON.stringify({ sub: 'agent:a@id.test', token: 't0' }), { status: 200 });
        if (u.includes('/token')) return new Response(JSON.stringify({ token: 'aid1.fresh.secret' }), { status: 200 });
        if (u.includes('/services')) return new Response(JSON.stringify({ services: {} }), { status: 200 });
        if (u === 'https://music.test/api/upload/1/audio') {
          sentBody = Buffer.from(init?.body as Uint8Array);
          sentType = String(init?.headers?.['content-type'] ?? '');
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      }) as typeof fetch,
    });
    (mod as any).ctx = { getModule: (n: string) => (n === 'workspace' ? workspace : null) };
    await mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' }));

    const res = await mod.handleToolCall(
      call('request', { service: 'music', path: '/api/upload/1/audio', method: 'PUT', fromFile: 'files/music/track.mp3' }),
    );
    expect(res.success).toBe(true);
    // byte-exact, and typed from the extension rather than guessed by the model
    expect(sentBody!.equals(audio)).toBe(true);
    expect(sentType).toBe('audio/mpeg');
    // a receipt, but never the payload itself, in the agent-visible result
    expect((res.data as any).sent).toEqual({
      path: 'files/music/track.mp3',
      size: audio.byteLength,
      contentType: 'audio/mpeg',
    });
    expect(JSON.stringify(res.data).length).toBeLessThan(1000);

    // guard rails
    const both = await mod.handleToolCall(
      call('request', { service: 'music', path: '/x', method: 'PUT', body: { a: 1 }, fromFile: 'files/music/track.mp3' }),
    );
    expect(both.error).toContain('not both');
    const onGet = await mod.handleToolCall(call('request', { service: 'music', path: '/x', fromFile: 'files/music/track.mp3' }));
    expect(onGet.error).toContain('needs a method other than GET');
    const missing = await mod.handleToolCall(
      call('request', { service: 'music', path: '/x', method: 'PUT', fromFile: 'files/nope.mp3' }),
    );
    expect(missing.error).toContain('could not read');
  });

  it('request: PATCH carries a JSON body or a workspace file, as POST and PUT do', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x7f]);
    const sent: Array<{ url: string; method: string; type: string; auth: string; body: unknown }> = [];
    const workspace = {
      readBinary: async (path: string) =>
        path === 'files/artifacts/grid.png' ? { data: png } : { error: `File not found: ${path}` },
      writeBinary: async () => ({ success: true }),
    };
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      services: { orrery: 'https://orrery.test' },
      fetchImpl: (async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes('/enroll')) return new Response(JSON.stringify({ sub: 'agent:a@id.test', token: 't0' }), { status: 200 });
        if (u.includes('/token')) return new Response(JSON.stringify({ token: 'aid1.fresh.secret' }), { status: 200 });
        if (u.includes('/services')) return new Response(JSON.stringify({ services: {} }), { status: 200 });
        if (u === 'https://orrery.test/api/nodes/n1') {
          sent.push({
            url: u,
            method: String(init?.method),
            type: String(init?.headers?.['content-type'] ?? ''),
            auth: String(init?.headers?.authorization ?? ''),
            body: init?.body instanceof Uint8Array ? Buffer.from(init.body) : init?.body,
          });
          return new Response(JSON.stringify({ id: 'n1', starred: true, note: 'the open ring' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 404 });
      }) as typeof fetch,
    });
    (mod as any).ctx = { getModule: (n: string) => (n === 'workspace' ? workspace : null) };
    await mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' }));

    // The framework's `utils run` checks args against the advertised enum
    // before the handler runs, so the schema has to offer PATCH too.
    const request = mod.getUtilities().find((u) => u.name === 'request')!;
    const methods = (request.inputSchema.properties as any).method.enum as string[];
    expect(methods).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

    // orrery's node update (starred, archived, note) is PATCH-only.
    const patched = await mod.handleToolCall(call('request', {
      service: 'orrery', path: '/api/nodes/n1', method: 'PATCH', body: { starred: true, note: 'the open ring' },
    }));
    expect(patched.success).toBe(true);
    expect(patched.data).toEqual({ status: 200, body: { id: 'n1', starred: true, note: 'the open ring' } });
    expect(sent).toEqual([{
      url: 'https://orrery.test/api/nodes/n1',
      method: 'PATCH',
      type: 'application/json',
      auth: 'Bearer aid1.fresh.secret',
      body: JSON.stringify({ starred: true, note: 'the open ring' }),
    }]);
    expect(JSON.stringify(patched.data)).not.toContain('aid1.');

    // fromFile sends the file's bytes with PATCH, and still with DELETE.
    for (const method of ['PATCH', 'DELETE']) {
      const res = await mod.handleToolCall(call('request', {
        service: 'orrery', path: '/api/nodes/n1', method, fromFile: 'files/artifacts/grid.png',
      }));
      expect(res.success).toBe(true);
      expect((res.data as any).sent).toEqual({ path: 'files/artifacts/grid.png', size: png.byteLength, contentType: 'image/png' });
      const last = sent.at(-1)!;
      expect(last).toMatchObject({ method, type: 'image/png', auth: 'Bearer aid1.fresh.secret' });
      expect(Buffer.isBuffer(last.body) && last.body.equals(png)).toBe(true);
      expect(JSON.stringify(res.data)).not.toContain('aid1.');
    }

    // Still refused before the wire: body with fromFile, and an unlisted verb.
    const both = await mod.handleToolCall(call('request', {
      service: 'orrery', path: '/api/nodes/n1', method: 'PATCH', body: { starred: true }, fromFile: 'files/artifacts/grid.png',
    }));
    expect(both.success).toBe(false);
    expect(both.error).toContain('not both');
    expect(methods).not.toContain('TRACE');
    const trace = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/nodes/n1', method: 'TRACE' }));
    expect(trace.success).toBe(false);
    expect(trace.error).toContain('unsupported method TRACE');
    expect(sent.length).toBe(3);
  });

  it('request: binary responses are described safely or saved byte-exactly to workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x7f]);
    let saved: { path: string; data: Buffer; mime: string } | null = null;
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      services: { orrery: 'https://orrery.test' },
      fetchImpl: (async (url: any) => {
        const u = String(url);
        if (u.includes('/enroll')) return new Response(JSON.stringify({ sub: 'agent:a@guest' }), { status: 200 });
        if (u.includes('/token')) return new Response(JSON.stringify({ token: 'aid1.fresh.secret' }), { status: 200 });
        if (u === 'https://orrery.test/api/assets/img/file') {
          return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
        }
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    await mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' }));

    const described = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/assets/img/file' }));
    expect(described.success).toBe(true);
    expect((described.data as any).body).toBe(null);
    expect((described.data as any).binary).toMatchObject({ size: png.length, contentType: 'image/png' });
    expect(JSON.stringify(described.data)).not.toContain('�PNG');

    await mod.start({
      getModule: (name: string) => name === 'workspace' ? {
        writeBinary: async (path: string, data: Buffer, mime: string) => {
          saved = { path, data: Buffer.from(data), mime };
          return { success: true, data: { path, size: data.length, mimeType: mime } };
        },
      } : null,
    } as any);
    const written = await mod.handleToolCall(call('request', {
      service: 'orrery', path: '/api/assets/img/file', saveAs: 'files/artifacts/candidate.png',
    }));
    expect(written.success).toBe(true);
    expect((written.data as any).saved).toMatchObject({
      path: 'files/artifacts/candidate.png', size: png.length, contentType: 'image/png',
    });
    expect(saved?.path).toBe('files/artifacts/candidate.png');
    expect(saved?.mime).toBe('image/png');
    expect(saved?.data.equals(png)).toBe(true);
  });

  it('host-facing accessFor: requires registration, then exchanges per call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ident-'));
    let mints = 0;
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      defaultAudience: 'eidoverse',
      fetchImpl: fakeHome({
        '/enroll': () => ({ status: 200, json: { sub: 'agent:a@guest', token: 't0' } }),
        '/token': (body) => body.audience === 'eidoverse'
          ? { status: 200, json: { token: `aid1.fresh.${++mints}` } }
          : { status: 400, json: { error: 'unknown audience' } },
      }),
    });
    await expect(mod.accessFor()).rejects.toThrow(/not registered/);

    await mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' }));
    expect(await mod.accessFor()).toBe('aid1.fresh.1');
    expect(await mod.accessFor('eidoverse')).toBe('aid1.fresh.2'); // fresh per call — dial-time rotation
    expect((await mod.httpAuthFor()).authorization).toBe('Bearer aid1.fresh.3');
    await expect(mod.accessFor('nope')).rejects.toThrow(/unknown audience/);
    expect(mod.isEnrolled()).toBe(true);
    expect(mod.sub()).toBe('agent:a@guest');
  });
});

describe('mcpl-admin access grants', () => {
  it('deploy with `access` requires identity wiring, and stores the NAME not a credential', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpl-'));
    const mod = new McplAdminModule({ overlayPath: join(dir, 'overlay.json') });
    // stub framework so the deploy reaches the access check
    mod.setFramework({
      listMcplServers: () => [],
      connectMcplServer: async () => {},
      restartMcplServer: async () => {},
      disconnectMcplServer: async () => {},
    } as any);

    // no identity wired → clear bounce
    const refused = await mod.handleToolCall(call('mcpl_deploy', {
      id: 'worlds', url: 'wss://example.test/mcpl', access: 'eidoverse',
    }) as any);
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('identity');
  });

  it('surface flags: default keeps four first-class tools; utilities parks them', () => {
    const asTools = new McplAdminModule({});
    expect(asTools.getTools().length).toBe(4);
    expect(asTools.getUtilities().length).toBe(0);

    const asUtils = new McplAdminModule({ surface: 'utilities' });
    expect(asUtils.getTools().length).toBe(0);
    expect(asUtils.getUtilities().map((u) => u.name).sort()).toEqual(
      ['mcpl_deploy', 'mcpl_list', 'mcpl_restart', 'mcpl_unload'],
    );
  });
});

describe('observers surface flag', () => {
  it('same definitions on either surface', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-'));
    const asTools = new ObserversModule({ path: join(dir, 'observers.json') });
    const asUtils = new ObserversModule({ path: join(dir, 'observers.json'), surface: 'utilities' });
    expect(asTools.getTools().map((t) => t.name)).toEqual(asUtils.getUtilities().map((u) => u.name));
    expect(asTools.getUtilities().length).toBe(0);
    expect(asUtils.getTools().length).toBe(0);
  });
});
