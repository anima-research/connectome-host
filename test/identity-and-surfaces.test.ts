// Identity module (archipelago-home client) + the tools↔utilities surface
// flags on mcpl-admin and observers. See docs/home-node.md §4 and the af
// utils meta-tool (Module.getUtilities).
//
// Design under test: the AGENT surface is credential-free (status /
// accept_invite, no tokens in any result); credentials exist only on the
// HOST-facing API (accessFor/httpAuthFor) that the MCPL dial provider
// and HTTP helpers consume outside model context.
import { afterEach, describe, it, expect, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { JsStore } from '@animalabs/chronicle';
import { WorkspaceModule, WorkspaceReadError } from '@animalabs/agent-framework';

import { IdentityError, IdentityModule } from '../src/modules/identity-module.ts';
import { McplAdminModule } from '../src/modules/mcpl-admin-module.ts';
import { ObserversModule } from '../src/modules/observers-module.ts';

// agent-framework's code for a link among a path's directories that stays
// inside the mount, from its release with anima-research/agent-framework#468.
const PARENT_SYMLINK = 'parent_symlink' as WorkspaceReadError['code'];
// anima-research/agent-framework#460's code for a path in another mount's
// directory nested in the one named.
const OTHER_MOUNT = 'other_mount' as WorkspaceReadError['code'];

const REQUEST_BODY_MAX_FOR_TEST = 256 * 1024;

// Temporary directories and stores a test makes are removed after it, passed
// or failed, so a run leaves none behind.
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
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
    const dir = tempDir('ident-');
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
    const dir = tempDir('ident-');
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
    expect(again.error).toContain('Nothing changed: this host is already registered as "Ferro"');
  });


  it('request: allowlisted service, host-attached access, no credential in result', async () => {
    const dir = tempDir('ident-');
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
    expect(unknown.error).toContain('Nothing was sent: there\'s no service "nope" here.');
    expect(unknown.error).toContain('orrery');
    const badPath = await mod.handleToolCall(call('request', { service: 'orrery', path: 'api/ops' }));
    expect(badPath.success).toBe(false);
  });

  it('request: services come from the home node directory, and a newly-listed one works without a restart', async () => {
    const dir = tempDir('ident-');
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
    expect(before.error).toContain('there\'s no service "music"');

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
    const dir = tempDir('ident-');
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
    const dir = tempDir('ident-');
    // A file far larger than the JSON body cap — the case that made this exist.
    const audio = Buffer.alloc(REQUEST_BODY_MAX_FOR_TEST + 4096, 0);
    audio.write('ID3', 0);
    audio[audio.length - 1] = 0x7f;
    let sentBody: Buffer | null = null;
    let sentType = '';
    // The resident wrote the file through the workspace, and disk has no copy.
    const workspace = {
      readFileFromDisk: async (path: string) => { throw new WorkspaceReadError('not_found', `File not found: ${path}`, 'lstat', 'ENOENT'); },
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
    // a receipt, but never the payload itself, in the agent-visible result,
    // naming the copy that went
    expect((res.data as any).sent).toEqual({
      path: 'files/music/track.mp3',
      size: audio.byteLength,
      contentType: 'audio/mpeg',
      from: 'the workspace, since disk has no file at this path',
    });
    expect(JSON.stringify(res.data).length).toBeLessThan(1000);

    // guard rails
    const both = await mod.handleToolCall(
      call('request', { service: 'music', path: '/x', method: 'PUT', body: { a: 1 }, fromFile: 'files/music/track.mp3' }),
    );
    expect(both.error).toContain('not both');
    const onGet = await mod.handleToolCall(call('request', { service: 'music', path: '/x', fromFile: 'files/music/track.mp3' }));
    expect(onGet.error).toContain('needs a method that sends a body');
    const missing = await mod.handleToolCall(
      call('request', { service: 'music', path: '/x', method: 'PUT', fromFile: 'files/nope.mp3' }),
    );
    expectSays(missing.error, 'Nothing was sent to "music"', '"files/nope.mp3" couldn\'t be read');
  });

  it('request: every writing method carries a JSON body or a workspace file; GET carries neither', async () => {
    const dir = tempDir('ident-');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0x7f]);
    const sent: Array<{ url: string; method: string; type: string; auth: string; body: unknown }> = [];
    const workspace = {
      readFileFromDisk: async (path: string) => {
        if (path === 'files/artifacts/grid.png') return { bytes: png, size: png.byteLength, truncated: false };
        throw new WorkspaceReadError('not_found', `File not found: ${path}`, 'lstat', 'ENOENT');
      },
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
        if (u.startsWith('https://orrery.test/api/nodes/')) {
          sent.push({
            url: u,
            method: String(init?.method),
            type: String(init?.headers?.['content-type'] ?? ''),
            auth: String(init?.headers?.authorization ?? ''),
            body: init?.body instanceof Uint8Array ? Buffer.from(init.body) : init?.body,
          });
          // An empty 204, as PATCH and DELETE routes often answer.
          if (u.endsWith('/empty')) return new Response(null, { status: 204 });
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
    // before the handler runs, so the schema has to offer every verb.
    const request = mod.getUtilities().find((u) => u.name === 'request')!;
    const methods = (request.inputSchema.properties as any).method.enum as string[];
    expect(methods).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      // A JSON body, as orrery's PATCH-only node update takes one.
      const withBody = await mod.handleToolCall(call('request', {
        service: 'orrery', path: '/api/nodes/n1', method, body: { starred: true, note: 'the open ring' },
      }));
      expect(withBody.success).toBe(true);
      expect(withBody.data).toEqual({ status: 200, body: { id: 'n1', starred: true, note: 'the open ring' } });
      expect(sent.at(-1)).toEqual({
        url: 'https://orrery.test/api/nodes/n1',
        method,
        type: 'application/json',
        auth: 'Bearer aid1.fresh.secret',
        body: JSON.stringify({ starred: true, note: 'the open ring' }),
      });
      expect(JSON.stringify(withBody.data)).not.toContain('aid1.');

      // A workspace file's bytes, byte-exactly, with the upload receipt.
      const withFile = await mod.handleToolCall(call('request', {
        service: 'orrery', path: '/api/nodes/n1', method, fromFile: 'files/artifacts/grid.png',
      }));
      expect(withFile.success).toBe(true);
      expect((withFile.data as any).sent).toEqual({ path: 'files/artifacts/grid.png', size: png.byteLength, contentType: 'image/png', from: 'disk' });
      expect(sent.at(-1)).toMatchObject({ method, type: 'image/png', auth: 'Bearer aid1.fresh.secret' });
      expect(Buffer.isBuffer(sent.at(-1)!.body) && (sent.at(-1)!.body as Buffer).equals(png)).toBe(true);
      expect(JSON.stringify(withFile.data)).not.toContain('aid1.');
    }
    expect(sent.length).toBe(8);

    // A writing method with neither body nor file sends neither, and no type.
    const bare = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/nodes/n1', method: 'PATCH' }));
    expect(bare.success).toBe(true);
    expect(sent.at(-1)).toEqual({ url: 'https://orrery.test/api/nodes/n1', method: 'PATCH', type: '', auth: 'Bearer aid1.fresh.secret', body: undefined });

    // An empty 204 is an empty success, with no advice to repeat the write.
    const empty = await mod.handleToolCall(call('request', {
      service: 'orrery', path: '/api/nodes/empty', method: 'DELETE',
    }));
    expect(empty.success).toBe(true);
    expect(empty.data).toEqual({ status: 204, body: '' });
    expect(sent.length).toBe(10);

    // Refused before the wire: a body or a file with GET, whether GET was
    // given or defaulted; body with fromFile; an unlisted verb.
    for (const input of [
      { method: 'GET', body: { starred: true } },
      { body: { starred: true } },
      { method: 'GET', fromFile: 'files/artifacts/grid.png' },
      { fromFile: 'files/artifacts/grid.png' },
    ]) {
      const refused = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/nodes/n1', ...input }));
      expect(refused.success).toBe(false);
      expect(refused.error).toContain('needs a method that sends');
      expect(refused.error).toContain('POST, PUT, PATCH, DELETE');
      expect(refused.error).toContain(input.method ? 'method is GET' : 'method is GET by default');
    }
    const both = await mod.handleToolCall(call('request', {
      service: 'orrery', path: '/api/nodes/n1', method: 'PATCH', body: { starred: true }, fromFile: 'files/artifacts/grid.png',
    }));
    expect(both.success).toBe(false);
    expect(both.error).toContain('not both');
    expect(methods).not.toContain('TRACE');
    const trace = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/nodes/n1', method: 'TRACE' }));
    expect(trace.success).toBe(false);
    expect(trace.error).toContain('Nothing was sent: method "TRACE" isn\'t one this utility sends. Use GET, POST, PUT, PATCH or DELETE.');
    expect(sent.length).toBe(10);
  });

  it('request: binary responses are described safely or saved byte-exactly to workspace', async () => {
    const dir = tempDir('ident-');
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
      getModule: (name: string) => name === 'workspace' ? keepingWorkspace(async (path: string, data: Buffer, mime: string) => {
        saved = { path, data: Buffer.from(data), mime };
        return { success: true, data: { path, size: data.length, mimeType: mime } };
      }) : null,
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
    const dir = tempDir('ident-');
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
    await expect(mod.accessFor()).rejects.toThrow(/no registration with the identity service at id\.test is recorded on this host/);

    await mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' }));
    expect(await mod.accessFor()).toBe('aid1.fresh.1');
    expect(await mod.accessFor('eidoverse')).toBe('aid1.fresh.2'); // fresh per call — dial-time rotation
    expect((await mod.httpAuthFor()).authorization).toBe('Bearer aid1.fresh.3');
    await expect(mod.accessFor('nope')).rejects.toThrow(/unknown audience/);
    expect(mod.isEnrolled()).toBe(true);
    expect(mod.sub()).toBe('agent:a@guest');
  });
});

/** That `text` says each thing the agent needs, whatever words surround it. */
function expectSays(text: unknown, ...parts: string[]): void {
  for (const part of parts) expect(String(text)).toContain(part);
}

/** A workspace fake that says what mounts it has (`files` writable, `docs`
 *  read-only), as `saveAs` is checked against them before anything is sent,
 *  and keeps a response with the given write. */
function keepingWorkspace(
  writeBinary: (path: string, data: Buffer, mime: string) => Promise<unknown> = async () => ({ success: true }),
  rest: Record<string, unknown> = {},
) {
  return {
    getMounts: () => [{ name: 'files', mode: 'read-write' }, { name: 'docs', mode: 'read-only' }],
    resolveAbsolutePath: (path: string) => (path.split('/').includes('..') ? null : `/mounts/${path}`),
    writeBinary,
    ...rest,
  };
}

/** What console.error writes while `run` runs: the operator's log. */
async function logged(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await run();
  } finally {
    console.error = original;
  }
  return lines;
}

/** What a refused registration's log line adds for an earlier call whose outcome was unknown. */
const EARLIER_CALL =
  'If an earlier call got no reply, a fault of the service\'s own, or a 400 not about the name, it may have registered ' +
  'this host: check the service, and if it holds this registration, record it by hand as that call\'s line says.';

/**
 * An identity module registered with a fake identity service, its `/token`
 * and `/enroll` answers chosen per test, and one service, orrery, whose
 * answer the test chooses too. `seen` counts the calls that reached orrery
 * and keeps the bodies they carried.
 */
function registeredModule(opts: {
  token?: () => Response;
  enroll?: () => Response | Promise<Response>;
  orrery?: (init?: RequestInit) => Response | Promise<Response>;
  workspace?: unknown;
  register?: boolean;
} = {}) {
  const dir = tempDir('ident-');
  const seen = { orrery: 0, bodies: [] as Buffer[] };
  const mod = new IdentityModule({
    keyPath: join(dir, 'k.pem'),
    home: 'id.test',
    services: { orrery: 'https://orrery.test' },
    fetchImpl: (async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('/services')) return new Response(JSON.stringify({ services: {} }), { status: 200 });
      if (u.includes('/enroll')) return (await opts.enroll?.()) ?? new Response(JSON.stringify({ sub: 'agent:a@guest' }), { status: 200 });
      if (u.includes('/token')) return opts.token?.() ?? new Response(JSON.stringify({ token: 'aid1.fresh.secret' }), { status: 200 });
      if (u.startsWith('https://orrery.test/')) {
        seen.orrery++;
        if (init?.body !== undefined) seen.bodies.push(Buffer.from(init.body as Uint8Array));
        return opts.orrery?.(init) ?? new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch,
  });
  if (opts.workspace !== undefined) (mod as any).ctx = { getModule: (n: string) => (n === 'workspace' ? opts.workspace : null) };
  return { mod, dir, seen, ready: opts.register === false ? Promise.resolve() : mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' })) };
}

const cutStream = () => new Response(new ReadableStream({ start(c) { c.error(new Error('stream cut')); } }), { status: 201 });

describe('identity: what the agent reads when a call fails', () => {
  // The workspace's copy stands in for a file disk doesn't have, and a file
  // disk has but can't read is refused: an upload never sends a copy that
  // may differ from disk's without saying so. Disk's and the workspace's
  // copies differ here, so each test can tell which went.
  describe('fromFile', () => {
    const onDisk = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const inWorkspace = Buffer.from('the workspace\'s copy');
    // What agent-framework's readFileFromDisk throws where disk has no file.
    const notOnDisk = (errno = 'ENOENT') => new WorkspaceReadError('not_found', 'File not found: files/grid.png', 'lstat', errno);
    const workspaceFor = (disk: WorkspaceReadError | null, storeError: string | null = null) => {
      const calls = { store: 0 };
      return {
        ...keepingWorkspace(),
        calls,
        readFileFromDisk: async () => {
          if (disk) throw disk;
          return { bytes: onDisk, size: onDisk.byteLength, truncated: false };
        },
        readBinary: async () => { calls.store++; return storeError === null ? { data: inWorkspace } : { error: storeError }; },
      };
    };
    const upload = (mod: IdentityModule) =>
      mod.handleToolCall(call('request', { service: 'orrery', path: '/api/up', method: 'PUT', fromFile: 'files/grid.png' }));

    it("sends disk's copy, and says so", async () => {
      const { mod, ready, seen } = registeredModule({ workspace: workspaceFor(null) });
      await ready;
      expect(((await upload(mod)).data as any).sent.from).toBe('disk');
      expect(seen.bodies).toEqual([onDisk]);
    });

    it("sends the workspace's copy of a file disk doesn't have, and says it was the workspace's", async () => {
      for (const errno of ['ENOENT', 'ENOTDIR', 'ENAMETOOLONG']) {
        const { mod, ready, seen } = registeredModule({ workspace: workspaceFor(notOnDisk(errno)) });
        await ready;
        const res = await upload(mod);
        expect((res.data as any).sent.from).toBe('the workspace, since disk has no file at this path');
        expect(seen.bodies).toEqual([inWorkspace]);
      }
    });

    it("refuses a file disk can't read, naming disk's reason, and sends nothing", async () => {
      const ws = workspaceFor(new WorkspaceReadError('not_found', 'Unable to read file: files/grid.png', 'open', 'EACCES'));
      const { mod, ready, seen } = registeredModule({ workspace: ws });
      await ready;
      const res = await upload(mod);
      expectSays(
        res.error, 'Nothing was sent to "orrery"', '"files/grid.png" couldn\'t be read from disk',
        'the workspace\'s copy wasn\'t sent in its place', 'On disk: Unable to read file: files/grid.png (EACCES).',
      );
      expect(ws.calls.store).toBe(0);
      expect(seen.orrery).toBe(0);
    });

    it("says what to do about each of disk's refusals", async () => {
      const cases: Array<[WorkspaceReadError, string]> = [
        [new WorkspaceReadError('directory', 'Path is a directory: files/grid.png', 'lstat'), 'Name a file, not a directory.'],
        [new WorkspaceReadError('symlink', 'Symlinks are not allowed: files/grid.png', 'lstat'), 'If you know it points to a file in the workspace, name that file by its own path; otherwise an upload can\'t send it, though your operator can put the file in the workspace.'],
        [new WorkspaceReadError('escape', 'Symlink escape detected: files/grid.png', 'realpath'), 'your operator can put it in the workspace'],
        [new WorkspaceReadError('changed', 'File changed during read: files/grid.png', 'stat', 'ENOENT'), 'calling again reads it afresh'],
        [new WorkspaceReadError('mount_unavailable', 'Mount unavailable: files', 'realpath_root', 'EACCES'), 'ask your operator, giving them this reason'],
      ];
      for (const [refusal, remedy] of cases) {
        const { mod, ready, seen } = registeredModule({ workspace: workspaceFor(refusal) });
        await ready;
        expectSays((await upload(mod)).error, 'couldn\'t be read from disk', remedy);
        expect(seen.orrery).toBe(0);
      }
    });

    // fetch refuses a header value it can't send before it connects, which
    // would read as no reply. The runtime's own Headers is asked first.
    it("refuses a content type the runtime can't send as a header, before the file is read", async () => {
      let reads = 0;
      const ws = {
        ...workspaceFor(null),
        readFileFromDisk: async () => { reads++; return { bytes: onDisk, size: onDisk.byteLength, truncated: false }; },
      };
      const types: string[] = [];
      const { mod, ready, seen } = registeredModule({
        workspace: ws,
        orrery: (init) => {
          types.push(String((init?.headers as Record<string, string> | undefined)?.['content-type']));
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      });
      await ready;
      const send = (contentType: string) =>
        mod.handleToolCall(call('request', { service: 'orrery', path: '/api/up', method: 'PUT', fromFile: 'files/grid.png', contentType }));
      for (const contentType of ['audio/mpeg\nx', 'a\u0000b', '\u2603/x']) {
        expectSays(
          (await send(contentType)).error, `Nothing was sent: \`contentType\` ${JSON.stringify(contentType)} can't be sent as a header.`,
          'Pass one such as "audio/mpeg", or leave it out to have it inferred from the file\'s extension.',
        );
      }
      expect(reads).toBe(0);
      expect(seen.orrery).toBe(0);
      // One the runtime takes goes out as given, in the header and the receipt, past ASCII too.
      for (const contentType of ['audio/mpeg; name="x y"', 'audio/mpeg; name="\u00e9"']) {
        expect(((await send(contentType)).data as any).sent.contentType).toBe(contentType);
      }
      expect(types).toEqual(['audio/mpeg; name="x y"', 'audio/mpeg; name="\u00e9"']);
      expect(seen.bodies).toEqual([onDisk, onDisk]);
    });

    // The extension is looked up in the table's own entries, never in a name
    // every object inherits.
    it('types a file whose extension names an inherited member as application/octet-stream', async () => {
      const types: string[] = [];
      const { mod, ready } = registeredModule({
        workspace: workspaceFor(null),
        orrery: (init) => {
          types.push(String((init?.headers as Record<string, string> | undefined)?.['content-type']));
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      });
      await ready;
      for (const fromFile of ['files/x.constructor', 'files/x.__proto__']) {
        const sent = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/up', method: 'PUT', fromFile }));
        expect((sent.data as any).sent).toEqual({ path: fromFile, size: onDisk.byteLength, contentType: 'application/octet-stream', from: 'disk' });
      }
      expect(types).toEqual(['application/octet-stream', 'application/octet-stream']);
    });

    it('gives a reason both reads share once, and each where they differ', async () => {
      const same = registeredModule({ workspace: workspaceFor(notOnDisk(), 'File not found: files/grid.png') });
      await same.ready;
      expect((await upload(same.mod)).error).toBe('Nothing was sent to "orrery": "files/grid.png" couldn\'t be read. File not found: files/grid.png.');
      const differ = registeredModule({ workspace: workspaceFor(notOnDisk('ENOTDIR'), 'Blob not found for: files/grid.png') });
      await differ.ready;
      expect((await upload(differ.mod)).error).toBe(
        'Nothing was sent to "orrery": "files/grid.png" couldn\'t be read. On disk: File not found: files/grid.png (ENOTDIR). ' +
        'In the workspace: Blob not found for: files/grid.png.',
      );
    });

    it('says which copy went whatever the response: saved with saveAs, binary, or empty', async () => {
      let answer = () => new Response(onDisk, { status: 200, headers: { 'content-type': 'image/png' } });
      const { mod, ready } = registeredModule({ workspace: workspaceFor(null), orrery: () => answer() });
      await ready;
      const saved = await mod.handleToolCall(call('request', {
        service: 'orrery', path: '/api/up', method: 'PUT', fromFile: 'files/grid.png', saveAs: 'files/thumb.png',
      }));
      expect((saved.data as any).saved.path).toBe('files/thumb.png');
      expect((saved.data as any).saved.diskCopyError).toBeUndefined();
      expect((saved.data as any).sent).toMatchObject({ path: 'files/grid.png', from: 'disk' });
      const binary = await upload(mod);
      expect((binary.data as any).binary.contentType).toBe('image/png');
      expect((binary.data as any).sent).toMatchObject({ path: 'files/grid.png', from: 'disk' });
      answer = () => new Response(null, { status: 204 });
      expect((await upload(mod)).data).toMatchObject({ status: 204, body: '', sent: { path: 'files/grid.png', from: 'disk' } });
    });

    // Every failure once the request may have gone out: a response cut short,
    // no reply, a response over the limit, and one the workspace couldn't save.
    it("names the workspace's copy in a failure after an upload of it went out, and disk's copy not at all", async () => {
      const copy = 'The upload was the workspace\'s copy of "files/grid.png", since disk has no file at this path.';
      const fromWorkspace = registeredModule({ workspace: workspaceFor(notOnDisk()), orrery: cutStream });
      await fromWorkspace.ready;
      expectSays((await upload(fromWorkspace.mod)).error, 'was answered with status 201', copy, 'Anything the PUT changed on the service stays changed');
      const noReply = registeredModule({ workspace: workspaceFor(notOnDisk()), orrery: () => { throw new Error('connection reset'); } });
      await noReply.ready;
      expectSays((await upload(noReply.mod)).error, 'got no reply', 'Whether it reached the service is unknown', copy);
      const big = { status: 200, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(64 * 1024 * 1024 + 1) } as unknown as Response;
      const overLimit = registeredModule({ workspace: workspaceFor(notOnDisk()), orrery: () => big });
      await overLimit.ready;
      expectSays((await upload(overLimit.mod)).error, 'over the 67108864-byte limit, so it wasn\'t kept.', copy);
      const unsaved = registeredModule({
        workspace: { ...workspaceFor(notOnDisk()), writeBinary: async () => ({ success: false, error: 'Content exceeds max file size (5242880 bytes)' }) },
      });
      await unsaved.ready;
      expectSays(
        (await unsaved.mod.handleToolCall(call('request', {
          service: 'orrery', path: '/api/up', method: 'PUT', fromFile: 'files/grid.png', saveAs: 'files/out.json',
        }))).error,
        'couldn\'t be saved to "files/out.json"', copy,
      );
      const fromDisk = registeredModule({ workspace: workspaceFor(null), orrery: cutStream });
      await fromDisk.ready;
      expect((await upload(fromDisk.mod)).error).not.toContain('workspace\'s copy');
    });

    // A failure the module doesn't expect from the read comes before anything
    // is sent, and the agent gets what names it, never its words.
    it("says a read that failed unexpectedly is the host's, by the error's class, before anything was sent", async () => {
      for (const thrown of [new TypeError('/srv/host/private/path'), null]) {
        const ws = { ...workspaceFor(null), readFileFromDisk: async () => { throw thrown; } };
        const { mod, ready, seen } = registeredModule({ workspace: ws });
        await ready;
        const res = await upload(mod);
        expectSays(res.error, 'identity--request failed before anything was sent (', 'It\'s the host\'s to fix', 'ask your operator');
        expect(res.error).not.toContain('/srv/host');
        expect(seen.orrery).toBe(0);
      }
    });
  });

  // Sending a write again would repeat it, so only a GET's note says to, and
  // without a workspace no note advises saveAs, which needs one.
  it("doesn't advise sending a write again to keep its binary response, nor saveAs where there's no workspace", async () => {
    const png = () => new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } });
    const { mod, ready } = registeredModule({ workspace: keepingWorkspace(), orrery: png });
    await ready;
    const write = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/render', method: 'POST', body: {} }));
    expectSays((write.data as any).binary.note, 'sending this POST again with `saveAs` would repeat it', 'pass `saveAs` with the write itself');
    expect((write.data as any).binary.note).not.toContain('repeat the request');
    const read = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/render' }));
    expectSays((read.data as any).binary.note, 'repeat the request with saveAs');
    const bare = registeredModule({ orrery: png });
    await bare.ready;
    for (const method of ['GET', 'POST']) {
      const res = await bare.mod.handleToolCall(call('request', { service: 'orrery', path: '/api/render', method, ...(method === 'POST' ? { body: {} } : {}) }));
      expectSays((res.data as any).binary.note, 'not kept', 'this host has none', 'your operator can enable the workspace');
      expect((res.data as any).binary.note).not.toContain('repeat');
    }
  });

  it("refuses saveAs with no workspace before anything is sent", async () => {
    const { mod, ready, seen } = registeredModule();
    await ready;
    const res = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x', method: 'POST', body: {}, saveAs: 'files/x.json' }));
    expectSays(res.error, 'Nothing was sent', '`saveAs` writes the response to the workspace', 'Leave `saveAs` out');
    expect(seen.orrery).toBe(0);
  });

  it('refuses saveAs before anything is sent where no writable mount would keep the response', async () => {
    // A path the workspace's resolver puts outside its mount is refused too.
    // No form found on Linux reaches that check past the ones before it, so
    // the resolver here is a stand-in that puts "files/away.json" outside.
    const resolveAbsolutePath = (path: string) => (path === 'files/away.json' || path.split('/').includes('..') ? null : `/mounts/${path}`);
    const { mod, ready, seen } = registeredModule({ workspace: keepingWorkspace(undefined, { resolveAbsolutePath }) });
    await ready;
    const send = async (saveAs: string) =>
      (await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x', method: 'POST', body: {}, saveAs }))).error;
    expectSays(await send('nope/out.json'), 'Nothing was sent: `saveAs` names no mount the workspace has: "nope/out.json"', 'a mount it can write to (files)');
    expectSays(await send('files'), 'names the mount "files" but no file in it');
    expectSays(await send('files/../../etc/out.json'), 'has a "." or ".." in it', 'such as "files/out.json"');
    expectSays(await send('files//out.json'), 'has an empty part right after the mount\'s name', 'such as "files/out.json"');
    expectSays(await send('files/away.json'), '`saveAs` "files/away.json" leads out of the mount "files"');
    expectSays(await send('docs/out.json'), 'names the read-only mount "docs"', 'a mount it can write to (files)');
    expect(seen.orrery).toBe(0);
  });

  // Every saveAs form without a "." or ".." part after its mount's name that
  // agent-framework's own write accepts goes out and is saved, and every form
  // it would refuse is refused before anything is sent: none goes out only to
  // have its answer lost. Each of those forms is also written straight
  // through the workspace's write, so the two verdicts are compared form by
  // form. A form with such a part the host refuses itself, naming the plain
  // path: agent-framework 0.22.3's write refuses such a path, and its release
  // with anima-research/agent-framework#536 reads one that stays in the mount
  // as the plain path it names.
  it('sends every saveAs without a "." or ".." part after its mount\'s name that the workspace\'s write accepts, and nothing it would refuse', async () => {
    const dir = tempDir('ident-saveas-');
    mkdirSync(join(dir, 'files'));
    mkdirSync(join(dir, 'docs'));
    const workspace = new WorkspaceModule({
      mounts: [
        { name: 'files', path: join(dir, 'files'), mode: 'read-write', watch: 'never' },
        { name: 'docs', path: join(dir, 'docs'), mode: 'read-only', watch: 'never' },
      ],
    });
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    cleanups.push(() => store.close?.());
    workspace.initStore(store);
    const { mod, ready, seen } = registeredModule({ workspace });
    await ready;
    // No two forms the host sends name the same file, so no form's save decides another's.
    const forms = [
      'files/out.json', 'files/sub/out.json', 'files/end.json/', 'files/twice//slash.json', 'files/dir/', 'files/a//b/c.json',
      'files/ends.json//', 'files/./out.json', 'files/sub/../out.json', 'files/sub/./out.json', 'files//out.json',
      'files/../out.json', 'files/', 'files', '/files/out.json', './files/out.json', 'nope/out.json', 'docs/out.json',
      'FILES/out.json', 'files//', `files/${join(dir, 'files')}/inside.json`,
    ];
    const dotted = (form: string) => form.split('/').slice(1).some((part) => part === '.' || part === '..');
    const outcomes: Record<string, string> = {};
    const reasons: Record<string, string | undefined> = {};
    const writes: Record<string, string> = {};
    for (const saveAs of forms) {
      const before = seen.orrery;
      const res = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x', method: 'POST', body: {}, saveAs }));
      outcomes[saveAs] = res.success ? 'sent and saved' : seen.orrery === before ? 'not sent' : 'sent, answer lost';
      reasons[saveAs] = res.error;
      if (dotted(saveAs)) continue;
      // The workspace's own verdict on the same form, as its write gives it.
      try {
        const written = await workspace.writeBinary(saveAs, Buffer.from('{}'), 'application/json');
        writes[saveAs] = written.success || (written.data as { inChronicle?: boolean } | undefined)?.inChronicle ? 'accepted' : 'refused';
      } catch {
        writes[saveAs] = 'refused';
      }
    }
    expect(Object.values(outcomes)).not.toContain('sent, answer lost');
    for (const form of forms) {
      if (dotted(form)) {
        expect([form, outcomes[form], reasons[form]]).toEqual([form, 'not sent', expect.stringContaining(
          `"${form}" has a "." or ".." in it, which the workspace can't save to; name the file by its plain path, such as "files/out.json".`,
        )]);
      } else expect([form, outcomes[form] === 'sent and saved']).toEqual([form, writes[form] === 'accepted']);
    }
    expect(Object.keys(outcomes).filter((form) => outcomes[form] === 'sent and saved')).toEqual([
      'files/out.json', 'files/sub/out.json', 'files/end.json/', 'files/twice//slash.json', 'files/dir/', 'files/a//b/c.json',
      'files/ends.json//',
    ]);
  });

  it('tells a request that got no reply from one whose reply came back but couldn\'t be read or saved', async () => {
    const noReply = registeredModule({ orrery: () => { throw new Error('connection reset'); } });
    await noReply.ready;
    const write = await noReply.mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x', method: 'POST', body: {} }));
    expectSays(write.error, 'got no reply: connection reset.', 'Whether it reached the service is unknown', 'check whether the POST took effect');
    const read = await noReply.mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x' }));
    expectSays(read.error, 'got no reply', 'a GET only reads, so it can be sent again');

    const cut = registeredModule({ orrery: cutStream });
    await cut.ready;
    const cutWrite = await cut.mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x', method: 'PATCH', body: {} }));
    expectSays(
      cutWrite.error, 'The request to "orrery" was answered with status 201, but its response couldn\'t be read or kept',
      'Anything the PATCH changed on the service stays changed',
    );

    const unsaved = registeredModule({
      workspace: keepingWorkspace(async () => ({ success: false, error: 'Content exceeds max file size (5242880 bytes)' })),
    });
    await unsaved.ready;
    const saved = await unsaved.mod.handleToolCall(call('request', {
      service: 'orrery', path: '/api/x', method: 'POST', body: {}, saveAs: 'files/out.json',
    }));
    expectSays(
      saved.error, 'was answered with status 200, but its response couldn\'t be saved to "files/out.json": Content exceeds max file size (5242880 bytes).',
      'Anything the POST changed on the service stays changed, so check before sending it again',
    );
  });

  it("says a response over the limit wasn't kept, and that what the write changed stays changed", async () => {
    const big = { status: 200, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(64 * 1024 * 1024 + 1) } as unknown as Response;
    const { mod, ready } = registeredModule({ orrery: () => big });
    await ready;
    expectSays(
      (await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x', method: 'POST', body: {} }))).error,
      'was answered with status 200, but its response is 67108865 bytes, over the 67108864-byte limit, so it wasn\'t kept.',
      'Anything the POST changed on the service stays changed',
    );
  });

  // agent-framework's writeBinary stores the file in the workspace before it
  // writes the copy on disk, and marks a write that got that far inChronicle.
  it('counts a response the workspace stored as saved when only its copy on disk failed, and says what disk lacks', async () => {
    const diskFailed = '"files/out.json" is saved in the workspace, but updating its copy on disk didn\'t complete: EACCES.';
    const { mod, ready } = registeredModule({
      workspace: keepingWorkspace(async () => ({ success: false, isError: true, error: diskFailed, data: { inChronicle: true } })),
    });
    await ready;
    const res = await mod.handleToolCall(call('request', {
      service: 'orrery', path: '/api/x', method: 'POST', body: {}, saveAs: 'files/out.json',
    }));
    expect(res.success).toBe(true);
    expect((res.data as any).saved).toMatchObject({ path: 'files/out.json', diskCopyError: diskFailed });
  });

  it("words the identity service's answers by their status: retry a 429, a 5xx or an unread 200, and not a refusal", async () => {
    let answer = () => new Response(JSON.stringify({ error: 'busy' }), { status: 503 });
    const { mod, ready, seen } = registeredModule({ token: () => answer() });
    await ready;
    const ask = async () => (await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x' }))).error;
    expectSays(await ask(), 'Nothing was sent to "orrery"', 'couldn\'t give access to "orrery" just now (503: busy)', 'Try again shortly');
    answer = () => new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 });
    expectSays(await ask(), 'just now (429: rate limited)', 'Try again shortly');
    answer = () => new Response('<html>', { status: 200 });
    expectSays(await ask(), 'answered 200 for access to "orrery", but its reply couldn\'t be read', 'Try again shortly');
    answer = () => new Response(JSON.stringify({ error: 'audience not allowed' }), { status: 403 });
    const refused = await ask();
    expectSays(refused, 'refused access to "orrery" (403: audience not allowed)', 'identity--status', 'ask your operator, giving them the reason');
    expect(refused).not.toContain('Try again');
    expect(seen.orrery).toBe(0);
  });

  // accessFor's two readers: the agent through request, and whoever runs the
  // host through the MCPL dial's log line, which shows the error's message.
  it("gives the agent and the operator's log each their own sentence when access can't be had", async () => {
    let token = (): Response => { throw new Error('connect ECONNREFUSED'); };
    const { mod, dir, ready, seen } = registeredModule({ token: () => token() });
    await ready;
    const ask = async () => (await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x' }))).error;
    expectSays(
      await ask(), 'Nothing was sent to "orrery": the identity service at id.test couldn\'t be reached for access to "orrery" (connect ECONNREFUSED).',
      'Try again shortly',
    );
    const unreachable = await mod.accessFor('orrery').catch((err: unknown) => err);
    expect(unreachable).toBeInstanceOf(IdentityError);
    expect((unreachable as Error).message).toBe('the identity service at id.test couldn\'t be reached for access to "orrery" (connect ECONNREFUSED)');
    token = () => new Response(JSON.stringify({ error: 'audience not allowed' }), { status: 403 });
    const refused = await mod.accessFor('orrery').catch((err: unknown) => err) as IdentityError;
    expect(refused.message).toBe('the identity service at id.test refused access to "orrery" (403: audience not allowed)');
    expectSays(refused.forAgent, 'identity--status', 'ask your operator');
    const noAudience = await mod.accessFor().catch((err: unknown) => err) as IdentityError;
    expectSays(noAudience.message, 'modules.identity.audience');
    expect(noAudience.message).not.toContain('identity:');
    // The key can't be read: the log gets its path and the error, the agent neither.
    writeFileSync(join(dir, 'k.pem'), 'not a key at all');
    let keyless = '';
    const lines = await logged(async () => { keyless = String(await ask()); });
    expectSays(keyless, 'Nothing was sent to "orrery": this host\'s identity couldn\'t be loaded', 'ask your operator', 'host\'s log');
    expect(keyless).not.toContain(dir);
    expect(keyless.toLowerCase()).not.toContain('key');
    expect(lines.some((line) => line.includes(join(dir, 'k.pem')))).toBe(true);
    expect(seen.orrery).toBe(0);
  });

  it('says a request goes nowhere until the host is registered, and how to register', async () => {
    const { mod, ready, seen } = registeredModule({ register: false });
    await ready;
    const res = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x' }));
    expectSays(
      res.error, 'Nothing was sent to "orrery": no registration with the identity service at id.test is recorded on this host',
      'identity--accept_invite',
    );
    expectSays(((await mod.handleToolCall(call('status', {}))).data as any).note, 'No registration with id.test is recorded on this host');
    expect(seen.orrery).toBe(0);
  });

  // A record that can't be read leaves whether this host is registered
  // unknown, and registering again would be refused if it is.
  it("says whether this host is registered is unknown when its record can't be read, never that it isn't", async () => {
    const { mod, dir, seen } = registeredModule({ register: false });
    writeFileSync(join(dir, 'k.json'), '{ not json');
    let status: Awaited<ReturnType<IdentityModule['handleToolCall']>> | undefined;
    const lines = await logged(async () => { status = await mod.handleToolCall(call('status', {})); });
    expectSays(
      status!.error, 'identity--status failed: this host\'s registration record couldn\'t be read, so whether this host is registered is unknown',
      'ask your operator', 'host\'s log',
    );
    expect(lines.some((line) => line.includes(join(dir, 'k.json')) && line.includes('(it isn\'t JSON)'))).toBe(true);
    const request = await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x' }));
    expectSays(request.error, 'Nothing was sent to "orrery": this host\'s registration record couldn\'t be read');
    const register = await mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A' }));
    expectSays(register.error, 'identity--accept_invite failed before anything was sent: this host\'s registration record couldn\'t be read');
    for (const text of [status!.error, request.error, register.error]) {
      expect(text).not.toContain(dir);
      expect(text).not.toContain('accept_invite with');
      expect(text).not.toContain('JSON');
    }
    rmSync(join(dir, 'k.json'));
    mkdirSync(join(dir, 'k.json'));
    let unreadable = '';
    const eisdir = await logged(async () => { unreadable = String((await mod.handleToolCall(call('status', {}))).error); });
    expectSays(unreadable, 'couldn\'t be read, so whether this host is registered is unknown');
    expect(unreadable).not.toContain('EISDIR');
    expect(eisdir.some((line) => line.includes('EISDIR'))).toBe(true);
    expect(seen.orrery).toBe(0);
  });

  it('accept_invite: a refused name, a busy service, no reply or a fault of its own, and a registration this host couldn\'t record', async () => {
    let enroll = () => new Response(JSON.stringify({ error: 'name taken' }), { status: 403 });
    const { mod, dir } = registeredModule({ register: false, enroll: () => enroll() });
    const join_ = (name = 'A') => mod.handleToolCall(call('accept_invite', { invite: 'inv', name }));
    let refused = '';
    const refusedLog = await logged(async () => { refused = String((await join_()).error); });
    // The operator's log has the answer and its reason, such as a key the service already holds, and allows
    // for an earlier call as the agent's text does.
    expect(refusedLog).toContain(`[identity] registering this host as "A" with id.test: the service answered 403: name taken. ${EARLIER_CALL}`);
    expectSays(
      refused, 'answered the registration with 403: name taken.',
      'If an earlier call got no reply, a fault of the service\'s own, or a 400 not about the name',
      'don\'t try another name', 'if it refused the name, call identity--accept_invite again with another',
    );
    expect(refused).not.toContain('Nothing was registered');
    enroll = () => new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 });
    expectSays(
      (await join_()).error, 'couldn\'t take the registration just now (429: rate limited), so this call registered nothing',
      'Try again shortly',
    );
    // A fault of its own can come after the service registered the host, as a lost reply can.
    enroll = () => new Response(JSON.stringify({ error: 'internal error' }), { status: 500 });
    expectSays(
      (await join_()).error, 'answered with a fault of its own (500: internal error)', 'whether it registered this host is unknown',
      'don\'t try another name',
    );
    enroll = () => { throw new Error('connection reset'); };
    let noReply = '';
    const noReplyLog = await logged(async () => { noReply = String((await join_()).error); });
    expectSays(
      noReply, 'gave no reply (connection reset)', 'whether it registered this host is unknown',
      'again shortly with the same code and name', 'don\'t try another name', 'ask your operator',
    );
    // The operator's log says where the record goes, should the service hold
    // it, and leaves out the id this host doesn't have, saying to add it.
    const byHand = noReplyLog.find((line) => line.includes('gave no reply (connection reset)'));
    expectSays(
      byHand, `{"name":"A","home":"id.test","enrolledAt":`, `to ${join(dir, 'k.json')}, adding "sub" with the id the identity ` +
        'service holds for this registration.',
    );
    expect(byHand).not.toContain('"sub":');
    // The record can't be written: a directory where its temporary file goes.
    mkdirSync(join(dir, 'k.json.tmp'));
    enroll = () => new Response(JSON.stringify({ sub: 'agent:a@guest' }), { status: 200 });
    let unrecorded: Awaited<ReturnType<IdentityModule['handleToolCall']>> | undefined;
    const lines = await logged(async () => { unrecorded = await join_(); });
    expectSays(
      unrecorded!.error, 'registered this host as "A" (agent:a@guest), but this host couldn\'t record that.',
      'holds the registration until it restarts', 'Don\'t call identity--accept_invite again', 'Ask your operator',
    );
    expect(unrecorded!.error).not.toContain(dir);
    expect(unrecorded!.error).not.toContain('key');
    expect(unrecorded!.error).not.toContain('EISDIR');
    // The failure's line is the log's only one: no line says the record was written.
    expect(lines).toHaveLength(1);
    // The log says where the record goes and what to write in it.
    expect(lines.some((line) => line.includes('EISDIR') && line.includes('only until it restarts') &&
      line.includes(`to ${join(dir, 'k.json')}`) && line.includes('"sub":"agent:a@guest","name":"A","home":"id.test"'))).toBe(true);
    // Held until the host restarts: status shows it, access works, and registering again is refused here.
    const status = await mod.handleToolCall(call('status', {}));
    expect(status.data).toMatchObject({ registeredAs: 'A', id: 'agent:a@guest' });
    expectSays((status.data as any).note, 'only until it restarts', 'ask them to');
    expect(await mod.accessFor('orrery')).toBe('aid1.fresh.secret');
    expectSays((await join_('B')).error, 'Nothing changed: this host is already registered as "A"', 'only until it restarts', 'ask them to');
    // A session switch builds a new module for the same key, which holds it
    // too, however the key's path is spelled.
    const switched = new IdentityModule({ keyPath: `${dir}/./k.pem`, home: 'id.test' });
    const switchedStatus = await switched.handleToolCall(call('status', {}));
    expect(switchedStatus.data).toMatchObject({ registeredAs: 'A', id: 'agent:a@guest' });
    expectSays((switchedStatus.data as any).note, 'only until it restarts');
    expectSays(
      (await switched.handleToolCall(call('accept_invite', { invite: 'inv', name: 'B' }))).error,
      'Nothing changed: this host is already registered as "A"', 'only until it restarts',
    );
  });

  // After an unknown outcome, the log's last word was to record the
  // registration by hand. A retry that registers records it, and says so.
  it('logs each registration it records, so a retry after no reply settles the log', async () => {
    let enroll = (): Response => { throw new Error('connection reset'); };
    const { mod, dir } = registeredModule({ register: false, enroll: () => enroll() });
    const join_ = () => mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A' }));
    let first = '';
    let retry: Awaited<ReturnType<IdentityModule['handleToolCall']>> | undefined;
    const lines = await logged(async () => {
      first = String((await join_()).error);
      enroll = () => new Response(JSON.stringify({ sub: 'agent:a@guest' }), { status: 200 });
      retry = await join_();
    });
    expectSays(first, 'gave no reply (connection reset)');
    expect(retry!.data).toMatchObject({ registeredAs: 'A', id: 'agent:a@guest' });
    expect(lines).toHaveLength(2);
    expectSays(lines[0], 'whether it registered this host is unknown', 'record it by hand');
    expect(lines[1]).toBe(`[identity] registered this host as "A" with id.test (agent:a@guest), recorded at ${join(dir, 'k.json')}.`);
    expect(JSON.parse(readFileSync(join(dir, 'k.json'), 'utf8'))).toMatchObject({ sub: 'agent:a@guest', name: 'A', home: 'id.test' });
  });

  // An operator often reads the log from its last line. After an unknown
  // outcome, a refused retry is that line, so it allows for the earlier call
  // as the agent's text does, though the host keeps no note of that call.
  it('logs a refused retry after no reply allowing for the earlier call', async () => {
    let enroll = (): Response => { throw new Error('connection reset'); };
    const { mod } = registeredModule({ register: false, enroll: () => enroll() });
    const join_ = () => mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A' }));
    const lines = await logged(async () => {
      await join_();
      enroll = () => new Response(JSON.stringify({ error: 'invite exhausted' }), { status: 403 });
      await join_();
    });
    expect(lines).toHaveLength(2);
    expectSays(lines[0], 'whether it registered this host is unknown', 'record it by hand');
    expect(lines[1]).toBe(`[identity] registering this host as "A" with id.test: the service answered 403: invite exhausted. ${EARLIER_CALL}`);
  });

  // The agent's name goes into the log quoted as JSON, so each registration
  // line stays one line, whatever name the agent asked for.
  it('quotes the name in every registration line it logs', async () => {
    let enroll = () => new Response(JSON.stringify({ error: 'name taken' }), { status: 403 });
    const { mod } = registeredModule({ register: false, enroll: () => enroll() });
    const join_ = () => mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A\nB' }));
    const taken = await logged(async () => { await join_(); });
    expect(taken).toEqual([`[identity] registering this host as "A\\nB" with id.test: the service answered 403: name taken. ${EARLIER_CALL}`]);
    enroll = () => new Response(JSON.stringify({ error: 'bad name (1-32 chars, alnum/space/_/./-)' }), { status: 400 });
    const bad = await logged(async () => { await join_(); });
    expect(bad).toHaveLength(1);
    expectSays(bad[0], '[identity] registering this host as "A\\nB" with id.test: the service answered with 400: bad name');
    // A 200 whose reply names no id is held in memory, so it gets a module of its own.
    const noId = registeredModule({ register: false, enroll: () => new Response('{}', { status: 200 }) });
    const held = await logged(async () => { await noId.mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A\nB' })); });
    expect(held).toHaveLength(1);
    expectSays(held[0], '[identity] id.test answered 200 to registering this host as "A\\nB", but no id could be read');
    enroll = () => new Response(JSON.stringify({ sub: 'agent:ab@guest' }), { status: 200 });
    const recorded = await logged(async () => { await join_(); });
    expect(recorded).toHaveLength(1);
    expectSays(recorded[0], '[identity] registered this host as "A\\nB" with id.test (agent:ab@guest)');
    for (const line of [...taken, ...bad, ...held, ...recorded]) expect(line).not.toContain('\n');
  });

  // A 400 can come before the service registers anything or after it, as
  // archipelago-home's "no audience configured" does, so it says neither.
  it('accept_invite: a 400 leaves whether the host is registered unknown, and sends a name problem back to the name', async () => {
    let enroll = () => new Response(JSON.stringify({ error: 'no audience configured' }), { status: 400 });
    const { mod, dir } = registeredModule({ register: false, enroll: () => enroll() });
    const join_ = (name = 'A') => mod.handleToolCall(call('accept_invite', { invite: 'inv', name }));
    let noAudience = '';
    const lines = await logged(async () => { noAudience = String((await join_()).error); });
    expectSays(
      noAudience, 'answered the registration with 400: no audience configured.', 'whether this call did is unknown',
      'If the reason is about the name, call identity--accept_invite again with another name',
      'Otherwise ask your operator, giving them the reason, to check whether the service holds this registration',
      'record it on this host by hand',
    );
    expect(noAudience).not.toContain('Nothing was registered');
    expect(noAudience).not.toContain(dir);
    expect(lines.some((line) => line.includes('whether it registered this host is unknown') && line.includes(join(dir, 'k.json')))).toBe(true);
    enroll = () => new Response(JSON.stringify({ error: 'bad name (1-32 chars, alnum/space/_/./-)' }), { status: 400 });
    expectSays((await join_('A!')).error, '400: bad name', 'If the reason is about the name, call identity--accept_invite again with another name');
    // What the host knows: nothing is recorded, which is what status says.
    expectSays(((await mod.handleToolCall(call('status', {}))).data as any).note, 'No registration with id.test is recorded on this host');
  });

  // The guard is cleared however the registration ends, a throw included.
  it('releases its in-flight guard when a registration fails before sending, so a later call registers', async () => {
    const { mod, dir } = registeredModule({ register: false });
    mkdirSync(join(dir, 'k.pem')); // a key path that can't be read as a key
    for (const name of ['A', 'B']) {
      const res = await mod.handleToolCall(call('accept_invite', { invite: 'inv', name }));
      expectSays(res.error, 'identity--accept_invite failed before anything was sent: this host\'s identity couldn\'t be loaded');
      expect(res.error).not.toContain('under way');
    }
    rmSync(join(dir, 'k.pem'), { recursive: true });
    let registered: Awaited<ReturnType<IdentityModule['handleToolCall']>> | undefined;
    await logged(async () => { registered = await mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A' })); });
    expect(registered!.data).toMatchObject({ registeredAs: 'A', id: 'agent:a@guest' });
  });

  // The service holds a registration under the key that made it, so a new
  // key made in a missing one's place would be refused on every access.
  it('makes no new key where the key is missing beside a registration, and says why in the log', async () => {
    const { mod, dir, ready, seen } = registeredModule();
    await ready;
    rmSync(join(dir, 'k.pem'));
    let status = '';
    let request = '';
    const lines = await logged(async () => {
      status = String((await mod.handleToolCall(call('status', {}))).error);
      request = String((await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x' }))).error);
    });
    expectSays(status, 'identity--status failed: this host\'s identity couldn\'t be loaded', 'host\'s log');
    expectSays(request, 'Nothing was sent to "orrery": this host\'s identity couldn\'t be loaded');
    for (const text of [status, request]) {
      expect(text).not.toContain(dir);
      expect(text.toLowerCase()).not.toContain('key');
    }
    expect(existsSync(join(dir, 'k.pem'))).toBe(false);
    expect(lines.some((line) => line.includes(`${join(dir, 'k.pem')} is missing, so no new key was made`) &&
      line.includes('To rotate the key on purpose, remove the record as well and register this host again with an invitation code'))).toBe(true);
    expect(seen.orrery).toBe(0);
  });

  // A key of another type, such as an X25519 key, which loads but can't sign,
  // fails where it loads, as a key that can't be read does: status, request
  // and accept_invite alike. The agent gets the one sentence, the log the
  // key's type, and the file stays the operator's to replace.
  it("refuses a key that isn't ed25519 where it loads, and leaves its file as it is", async () => {
    const { mod, dir, ready, seen } = registeredModule();
    await ready;
    const x25519 = generateKeyPairSync('x25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
    writeFileSync(join(dir, 'k.pem'), x25519);
    const files = readdirSync(dir).sort();
    let request = '';
    let status = '';
    const lines = await logged(async () => {
      request = String((await mod.handleToolCall(call('request', { service: 'orrery', path: '/api/x' }))).error);
      status = String((await mod.handleToolCall(call('status', {}))).error);
    });
    expect(request).toBe('Nothing was sent to "orrery": this host\'s identity couldn\'t be loaded. It\'s the host\'s to fix: ask your operator, who can find the reason in the host\'s log.');
    expect(status).toBe('identity--status failed: this host\'s identity couldn\'t be loaded. It\'s the host\'s to fix: ask your operator, who can find the reason in the host\'s log.');
    expect(lines.some((line) => line.includes(`${join(dir, 'k.pem')} couldn't be read, made or used: it holds a key of type x25519, not ed25519`))).toBe(true);
    // Nothing made over the refused key or beside it.
    expect(readFileSync(join(dir, 'k.pem'), 'utf8')).toBe(String(x25519));
    expect(readdirSync(dir).sort()).toEqual(files);
    expect(seen.orrery).toBe(0);
    // A host not yet registered, registering with such a key: refused before anything is sent.
    const fresh = registeredModule({ register: false });
    writeFileSync(join(fresh.dir, 'k.pem'), x25519);
    let joined = '';
    await logged(async () => { joined = String((await fresh.mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A' }))).error); });
    expect(joined).toBe('identity--accept_invite failed before anything was sent: this host\'s identity couldn\'t be loaded. It\'s the host\'s to fix: ask your operator, who can find the reason in the host\'s log.');
    expect(readFileSync(join(fresh.dir, 'k.pem'), 'utf8')).toBe(String(x25519));
    expect(readdirSync(fresh.dir)).toEqual(['k.pem']);
  });

  // A call to /enroll or /token that hangs ends after 15 seconds: a
  // registration as no reply, and access as unreachable. The limit is asked
  // of AbortSignal.timeout, which here answers with a 20 ms signal, and the
  // service never answers: each call ends only when its signal fires, with
  // the signal's own reason, as fetch's does.
  it('gives /enroll and /token 15 seconds each, after which a hung registration reads as no reply and access as unreachable', async () => {
    const real = AbortSignal.timeout.bind(AbortSignal);
    const limits: number[] = [];
    const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      limits.push(ms);
      return real(20);
    });
    try {
      const dir = tempDir('ident-');
      const mod = new IdentityModule({
        keyPath: join(dir, 'k.pem'),
        home: 'id.test',
        fetchImpl: ((_url: any, init?: RequestInit) => new Promise<Response>((_answer, fail) => {
          init!.signal!.addEventListener('abort', () => fail(init!.signal!.reason));
        })) as typeof fetch,
      });
      const join_ = () => mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A' }));
      expectSays((await join_()).error, 'gave no reply (The operation timed out.)', 'whether it registered this host is unknown');
      // The in-flight guard is released: a second call goes out, and isn't refused as under way.
      const again = String((await join_()).error);
      expectSays(again, 'gave no reply (The operation timed out.)');
      expect(again).not.toContain('under way');
      writeFileSync(join(dir, 'k.json'), JSON.stringify({ sub: 'agent:a@guest', name: 'A', home: 'id.test', enrolledAt: 'then' }));
      let thrown: unknown;
      try {
        await mod.accessFor('orrery');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(IdentityError);
      expectSays((thrown as IdentityError).message, 'couldn\'t be reached for access to "orrery" (The operation timed out.)');
      expect(limits).toEqual([15_000, 15_000, 15_000]);
    } finally {
      timeout.mockRestore();
    }
  });

  it('holds a registration whose reply named no id it could read, and asks the operator to record it', async () => {
    const { mod, dir } = registeredModule({ register: false, enroll: () => new Response('<html>registered</html>', { status: 200 }) });
    let answer = '';
    const lines = await logged(async () => {
      answer = String((await mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A' }))).error);
    });
    expectSays(
      answer, 'answered that it registered this host as "A" (200), but no id could be read from its reply', 'holds the registration until it restarts',
      'Don\'t call identity--accept_invite again', 'record this registration on this host by hand',
    );
    expect(existsSync(join(dir, 'k.json'))).toBe(false);
    // The operator's log: no id could be read, the hold ends at restart, and
    // the record to write, without the id the host doesn't have.
    const byHand = lines.find((line) => line.includes('no id could be read from its reply'));
    expectSays(
      byHand, 'only until it restarts', `{"name":"A","home":"id.test","enrolledAt":`,
      `to ${join(dir, 'k.json')}, adding "sub" with the id the identity service holds for this registration.`,
    );
    expect(byHand).not.toContain('"sub":');
    expect((await mod.handleToolCall(call('status', {}))).data).toMatchObject({ registeredAs: 'A', id: null });
    expect(await mod.accessFor('orrery')).toBe('aid1.fresh.secret');
    // A copy of that record made as written, without the id, reads as holding
    // no registration on a host that doesn't hold it in memory, as once it
    // restarts: it fails closed. The hold is the process's, so the copy and
    // the key go where no module of this process has held anything.
    const restartedDir = tempDir('ident-');
    writeFileSync(join(restartedDir, 'k.json'), byHand!.match(/write (\{.*?\}) to /)![1]);
    writeFileSync(join(restartedDir, 'k.pem'), readFileSync(join(dir, 'k.pem')));
    const restarted = new IdentityModule({ keyPath: join(restartedDir, 'k.pem'), home: 'id.test' });
    expectSays(
      (await restarted.handleToolCall(call('status', {}))).error,
      'identity--status failed: this host\'s registration record couldn\'t be read, so whether this host is registered is unknown',
    );
    // The key gone while the registration is held: refused, no new key made,
    // and the log's way to rotate fits a registration held in memory.
    rmSync(join(dir, 'k.pem'));
    let status = '';
    const keyLines = await logged(async () => { status = String((await mod.handleToolCall(call('status', {}))).error); });
    expectSays(status, 'identity--status failed: this host\'s identity couldn\'t be loaded');
    expect(keyLines.some((line) => line.includes(`is held in memory, but its identity key at ${join(dir, 'k.pem')} is missing`) &&
      line.includes('restart the host, which forgets the registration it holds in memory, and register it again with an invitation code'))).toBe(true);
    expect(existsSync(join(dir, 'k.pem'))).toBe(false);
  });

  // A reply whose body can't be read, or isn't a JSON object, reads as one
  // that names no id and no reason, never as a throw after the service may
  // have acted. The status that arrived is the service's answer.
  it('reads a reply body that can\'t be read, or is not a JSON object, as one that names nothing', async () => {
    const held = registeredModule({ register: false, enroll: () => new Response('null', { status: 200 }) });
    const answer = String((await held.mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A' }))).error);
    expectSays(answer, 'answered that it registered this host as "A" (200), but no id could be read from its reply');
    expect(answer).not.toContain('before anything was sent');
    const cut = registeredModule({
      register: false,
      enroll: () => new Response(new ReadableStream({ start(c) { c.error(new Error('stream cut')); } }), { status: 200 }),
    });
    expectSays(
      (await cut.mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A' }))).error,
      'answered that it registered this host as "A" (200), but no id could be read from its reply',
    );
    const refused = registeredModule({ register: false, enroll: () => new Response('[]', { status: 403 }) });
    expectSays(
      (await refused.mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A' }))).error,
      'answered the registration with 403: no reason given.',
    );
    const access = registeredModule({ token: () => new Response('null', { status: 200 }) });
    await access.ready;
    let thrown: unknown;
    try {
      await access.mod.accessFor('orrery');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IdentityError);
    expectSays((thrown as IdentityError).message, 'answered 200 for access to "orrery", but its reply couldn\'t be read');
  });

  it('refuses a second registration while one is under way', async () => {
    let answer!: (res: Response) => void;
    const { mod, dir } = registeredModule({ register: false, enroll: () => new Promise<Response>((resolve) => { answer = resolve; }) });
    const first = mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A' }));
    // Its answer goes to the first call, which a switch leaves in another
    // session, so the refusal says what status shows, never the outcome.
    const refusal = String((await mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'B' }))).error);
    expectSays(
      refusal, 'Nothing was sent: a registration is already under way on this host, and its answer goes to the call ' +
        'that started it, which may be in an earlier session.', 'It ends within 15 seconds, and identity--status then ' +
        'shows this host\'s registration if it recorded or holds one.', 'If it shows none, call identity--accept_invite ' +
        'again with the same code and name.',
    );
    expect(refusal).not.toContain('its own answer');
    // A session switch builds a new module for the same key, which refuses it too.
    const switched = new IdentityModule({ keyPath: join(dir, 'k.pem'), home: 'id.test' });
    expectSays(
      (await switched.handleToolCall(call('accept_invite', { invite: 'inv', name: 'B' }))).error,
      'Nothing was sent: a registration is already under way on this host',
    );
    answer(new Response(JSON.stringify({ sub: 'agent:a@guest' }), { status: 200 }));
    expect((await first).success).toBe(true);
    expectSays((await mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'B' }))).error, 'already registered as "A"');
  });

  // The operator is asked to record a held registration by hand while the
  // host runs. Once they have, the file is what the host reads, and the hold
  // is dropped.
  it('reads a record written by hand while it holds the registration, and drops the hold', async () => {
    const { mod, dir } = registeredModule({ register: false, enroll: () => new Response('<html>registered</html>', { status: 200 }) });
    const lines = await logged(async () => { await mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A' })); });
    const byHand = lines.find((line) => line.includes('no id could be read from its reply'));
    expect((await mod.handleToolCall(call('status', {}))).data).toMatchObject({ registeredAs: 'A', id: null });
    // A copy made as written, without the id, holds no registration, so the
    // hold still answers, as it does for a record file that can't be read.
    const asWritten = byHand!.match(/write (\{.*?\}) to /)![1];
    writeFileSync(join(dir, 'k.json'), asWritten);
    const stillHeld = await mod.handleToolCall(call('status', {}));
    expect(stillHeld.data).toMatchObject({ registeredAs: 'A', id: null });
    expectSays((stillHeld.data as any).note, 'only until it restarts');
    // The record as the log says to write it, with the id added.
    writeFileSync(join(dir, 'k.json'), JSON.stringify({ ...JSON.parse(asWritten), sub: 'agent:a@guest' }));
    const status = (await mod.handleToolCall(call('status', {}))).data as Record<string, unknown>;
    expect(status).toMatchObject({ registeredAs: 'A', id: 'agent:a@guest' });
    expect(String(status.note)).not.toContain('only until it restarts');
    const again = String((await mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A' }))).error);
    expectSays(again, 'Nothing changed: this host is already registered as "A" (agent:a@guest)');
    expect(again).not.toContain('only until it restarts');
    // The module a session switch builds reads it the same way.
    const switched = new IdentityModule({ keyPath: join(dir, 'k.pem'), home: 'id.test' });
    expect((await switched.handleToolCall(call('status', {}))).data).toMatchObject({ registeredAs: 'A', id: 'agent:a@guest' });
  });

  // A record written by hand that isn't the held registration is the
  // operator's to write: the file is read, and the hold is dropped all the
  // same, since the log line written when it began keeps every field of it.
  it('drops the hold for a record written by hand that differs from it, whose fields its log line kept', async () => {
    const { mod, dir } = registeredModule({ register: false });
    // The record can't be written: a directory where its temporary file goes.
    mkdirSync(join(dir, 'k.json.tmp'));
    const lines = await logged(async () => { await mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A' })); });
    expect((await mod.handleToolCall(call('status', {}))).data).toMatchObject({ registeredAs: 'A', id: 'agent:a@guest' });
    writeFileSync(join(dir, 'k.json'), JSON.stringify({ sub: 'agent:b@guest', name: 'B', home: 'id.test', enrolledAt: '2026-10-01T00:00:00.000Z' }));
    const status = (await mod.handleToolCall(call('status', {}))).data as Record<string, unknown>;
    expect(status).toMatchObject({ registeredAs: 'B', id: 'agent:b@guest' });
    expect(String(status.note)).not.toContain('only until it restarts');
    // Access signs with this host's key, whatever the record names.
    expect(await mod.accessFor('orrery')).toBe('aid1.fresh.secret');
    // Dropped, not set aside: with the record gone too, nothing is recorded
    // or held, and the held registration is in the log line from its start.
    rmSync(join(dir, 'k.json'));
    expect((await mod.handleToolCall(call('status', {}))).data).toMatchObject({ registeredAs: null });
    expect(lines.some((line) => line.includes('only until it restarts') &&
      line.includes('"sub":"agent:a@guest","name":"A","home":"id.test","enrolledAt":'))).toBe(true);
  });

  // A session switch stops the module whose registration is under way and
  // builds another for the same key. The registration goes on, and its end
  // is the new module's to act on: recorded, or, with no reply, the guard
  // released so the new module may register.
  it('ends a registration under way across a session switch in a state the new module acts on', async () => {
    let answer!: (res: Response) => void;
    const { mod, dir } = registeredModule({ register: false, enroll: () => new Promise<Response>((resolve) => { answer = resolve; }) });
    const first = mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A' }));
    await mod.stop();
    const switched = new IdentityModule({ keyPath: join(dir, 'k.pem'), home: 'id.test' });
    expectSays(
      (await switched.handleToolCall(call('accept_invite', { invite: 'inv', name: 'B' }))).error,
      'Nothing was sent: a registration is already under way on this host',
    );
    answer(new Response(JSON.stringify({ sub: 'agent:a@guest' }), { status: 200 }));
    expect((await first).success).toBe(true);
    expect((await switched.handleToolCall(call('status', {}))).data).toMatchObject({ registeredAs: 'A', id: 'agent:a@guest' });

    let drop!: (err: Error) => void;
    const lost = registeredModule({ register: false, enroll: () => new Promise<Response>((_answer, reject) => { drop = reject; }) });
    const unanswered = lost.mod.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A' }));
    await lost.mod.stop();
    let enrolls = 0;
    const next = new IdentityModule({
      keyPath: join(lost.dir, 'k.pem'),
      home: 'id.test',
      fetchImpl: (async (url: any) => {
        if (String(url).includes('/enroll')) enrolls++;
        return new Response(JSON.stringify({ sub: 'agent:a@guest' }), { status: 200 });
      }) as typeof fetch,
    });
    drop(new Error('connection reset'));
    let noReply = '';
    await logged(async () => { noReply = String((await unanswered).error); });
    expectSays(noReply, 'gave no reply (connection reset)');
    let registered = false;
    await logged(async () => { registered = (await next.handleToolCall(call('accept_invite', { invite: 'inv', name: 'A' }))).success; });
    expect(registered).toBe(true);
    expect(enrolls).toBe(1);
  });

  it('names what a call lacks: the service, the path as given, both of invite and name', async () => {
    const { mod, ready } = registeredModule();
    await ready;
    expectSays((await mod.handleToolCall(call('request', { path: '/x' }))).error, 'needs `service`', 'orrery');
    expectSays((await mod.handleToolCall(call('request', { service: 'orrery', path: 'api/ops' }))).error, 'starting with "/"', 'it was "api/ops"');
    for (const lacking of [{ invite: 'x' }, { name: 'A' }]) {
      expectSays((await mod.handleToolCall(call('accept_invite', lacking))).error, 'Nothing was sent', 'both `invite`', '`name`');
    }
  });

  it('points a body over the limit at fromFile only where there is a workspace to read one from', async () => {
    const big = { text: 'x'.repeat(REQUEST_BODY_MAX_FOR_TEST + 1) };
    const bare = registeredModule();
    await bare.ready;
    const noWorkspace = await bare.mod.handleToolCall(call('request', { service: 'orrery', path: '/x', method: 'POST', body: big }));
    expectSays(noWorkspace.error, 'Nothing was sent: the body is', 'over the 262144-character limit');
    expect(noWorkspace.error).not.toContain('fromFile');
    const withWs = registeredModule({ workspace: keepingWorkspace() });
    await withWs.ready;
    expectSays((await withWs.mod.handleToolCall(call('request', { service: 'orrery', path: '/x', method: 'POST', body: big }))).error, '`fromFile`');
  });

  // A key file that can't be read is the host's to fix; the log has why, and
  // the agent gets neither its words nor its code, since it can't act on them.
  it("says a failure before anything is sent is the host's, without its paths", async () => {
    const dir = tempDir('ident-');
    writeFileSync(join(dir, 'k.pem'), 'not a key at all');
    const mod = new IdentityModule({ keyPath: join(dir, 'k.pem'), home: 'id.test' });
    const res = await mod.handleToolCall(call('status', {}));
    expectSays(res.error, 'identity--status failed: this host\'s identity couldn\'t be loaded', 'It\'s the host\'s to fix', 'ask your operator');
    expect(res.error).not.toContain(dir);
  });

  it('answers a utility it lacks with its utilities and how to run them', async () => {
    const { mod } = registeredModule({ register: false });
    expectSays(
      (await mod.handleToolCall(call('nope', {}))).error,
      'There\'s no tool "identity--nope", so nothing ran', 'identity--status', 'identity--request', 'identity--accept_invite', 'utils',
    );
  });
});

describe('mcpl-admin access grants', () => {
  it('deploy with `access` requires identity wiring, and stores the NAME not a credential', async () => {
    const dir = tempDir('mcpl-');
    const mod = new McplAdminModule({ overlayPath: join(dir, 'overlay.json') });
    // stub framework so the deploy reaches the access check
    mod.setFramework({
      getModule: () => null,
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
    const dir = tempDir('obs-');
    const asTools = new ObserversModule({ path: join(dir, 'observers.json') });
    const asUtils = new ObserversModule({ path: join(dir, 'observers.json'), surface: 'utilities' });
    expect(asTools.getTools().map((t) => t.name)).toEqual(asUtils.getUtilities().map((u) => u.name));
    expect(asTools.getUtilities().length).toBe(0);
    expect(asUtils.getTools().length).toBe(0);
  });
});

// An upload reads only what the workspace mount allows. agent-framework's
// readFileFromDisk keeps the mount's link policy and reads only inside it;
// the disk read this used before checked the path's text alone and followed
// any link, so a link in the mount sent a file from outside it to the
// service. These run agent-framework's own WorkspaceModule and store on a
// real mount. The mount doesn't materialize, so a copy written through the
// workspace is in the store alone, as a file the resident wrote and never
// materialized.
describe('identity request: fromFile reads only what the mount allows', () => {
  const CAP = 64 * 1024 * 1024;

  async function mounted(opts: { followSymlinks?: boolean } = {}) {
    const dir = tempDir('ident-mount-');
    const mountDir = join(dir, 'files');
    const outside = join(dir, 'outside');
    mkdirSync(mountDir);
    mkdirSync(outside);
    writeFileSync(join(outside, 'host-secret.txt'), 'the host\'s own file');
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    cleanups.push(() => store.close?.());
    const workspace = new WorkspaceModule({
      mounts: [{ name: 'files', path: mountDir, mode: 'read-write', watch: 'never', ...(opts.followSymlinks ? { followSymlinks: true } : {}) }],
    });
    workspace.initStore(store);
    // What each disk read asked for and what it read.
    const diskReads: Array<{ maxBytes?: number; read: number; truncated: boolean }> = [];
    const readFileFromDisk = workspace.readFileFromDisk.bind(workspace);
    workspace.readFileFromDisk = async (path, options) => {
      const result = await readFileFromDisk(path, options);
      diskReads.push({ maxBytes: options?.maxBytes, read: result.bytes.byteLength, truncated: result.truncated });
      return result;
    };
    /** A copy of a path in the store, written through the workspace as the resident would. */
    const putInStore = async (path: string, text: string) => {
      expect((await workspace.writeBinary(path, Buffer.from(text), 'application/octet-stream')).success).toBe(true);
    };
    const bodies: Buffer[] = [];
    const mod = new IdentityModule({
      keyPath: join(dir, 'k.pem'),
      home: 'id.test',
      services: { orrery: 'https://orrery.test' },
      fetchImpl: (async (url: any, init?: any) => {
        const u = String(url);
        if (u.includes('/enroll')) return new Response(JSON.stringify({ sub: 'agent:a@guest' }), { status: 200 });
        if (u.includes('/token')) return new Response(JSON.stringify({ token: 'aid1.fresh.secret' }), { status: 200 });
        if (u.includes('/services')) return new Response(JSON.stringify({ services: {} }), { status: 200 });
        bodies.push(Buffer.from(init?.body as Uint8Array));
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    (mod as any).ctx = { getModule: (n: string) => (n === 'workspace' ? workspace : null) };
    await mod.handleToolCall(call('accept_invite', { invite: 'i', name: 'A' }));
    const upload = (fromFile: string) =>
      mod.handleToolCall(call('request', { service: 'orrery', path: '/api/up', method: 'PUT', fromFile }));
    return { dir, mountDir, outside, workspace, putInStore, diskReads, bodies, upload };
  }

  it("sends a file in the mount from disk, not the workspace's copy of it", async () => {
    const { mountDir, putInStore, bodies, upload } = await mounted();
    writeFileSync(join(mountDir, 'grid.png'), 'disk bytes');
    await putInStore('files/grid.png', 'store bytes');
    expect((await upload('files/grid.png')).success).toBe(true);
    expect(bodies.map(String)).toEqual(['disk bytes']);
  });

  // A link that stays inside the mount is the mount's to allow: followed where
  // the mount sets followSymlinks, refused where it doesn't, whatever the
  // workspace holds at the link's path.
  it('sends the file a link names when that file is in the same mount and the mount follows links', async () => {
    const { mountDir, putInStore, bodies, upload } = await mounted({ followSymlinks: true });
    writeFileSync(join(mountDir, 'v2.png'), 'the file the link names');
    symlinkSync('v2.png', join(mountDir, 'latest.png'));
    await putInStore('files/latest.png', 'store bytes');
    expect((await upload('files/latest.png')).success).toBe(true);
    expect(bodies.map(String)).toEqual(['the file the link names']);
  });

  it("refuses a link to a file in the same mount when the mount doesn't follow links", async () => {
    const { mountDir, putInStore, bodies, upload } = await mounted();
    writeFileSync(join(mountDir, 'v2.png'), 'the file the link names');
    symlinkSync('v2.png', join(mountDir, 'latest.png'));
    await putInStore('files/latest.png', 'store bytes');
    const res = await upload('files/latest.png');
    expect(res.error).toContain('Nothing was sent to "orrery": "files/latest.png" couldn\'t be read from disk');
    expect(res.error).toContain('Symlinks are not allowed: files/latest.png');
    expect(bodies).toEqual([]);
  });

  it('refuses a link in the mount to a file outside it, sends nothing, and names no host path', async () => {
    const { dir, mountDir, outside, putInStore, bodies, upload } = await mounted();
    symlinkSync(join(outside, 'host-secret.txt'), join(mountDir, 'link.txt'));
    // Even with a copy in the store, the refusal stands: it isn't sent in the link's place.
    await putInStore('files/link.txt', 'store bytes');
    const res = await upload('files/link.txt');
    expect(res.success).toBe(false);
    expect(res.error).toContain('Nothing was sent to "orrery": "files/link.txt" couldn\'t be read from disk');
    expect(res.error).toContain('Symlinks are not allowed: files/link.txt');
    expect(res.error).not.toContain(dir);
    expect(bodies).toEqual([]);
  });

  it('refuses a link leading out of the mount where the mount follows links', async () => {
    const { mountDir, outside, putInStore, bodies, upload } = await mounted({ followSymlinks: true });
    symlinkSync(join(outside, 'host-secret.txt'), join(mountDir, 'link.txt'));
    await putInStore('files/link.txt', 'store bytes');
    const res = await upload('files/link.txt');
    expect(res.error).toContain('Nothing was sent to "orrery": "files/link.txt" couldn\'t be read from disk');
    expect(res.error).toContain('Symlink escape detected: files/link.txt');
    expect(bodies).toEqual([]);
  });

  // A directory on the path that links out of the mount: agent-framework
  // 0.22.3 follows the link and refuses the file, whose canonical path lies
  // outside, and its release with anima-research/agent-framework#468 refuses
  // the link itself. Both say escape, in words of their own.
  it('refuses a file reached through a parent directory that links out of the mount', async () => {
    const { dir, mountDir, outside, workspace, bodies, upload } = await mounted();
    symlinkSync(outside, join(mountDir, 'out'));
    const read = await workspace.readFileFromDisk('files/out/host-secret.txt').then(
      () => null,
      (err: WorkspaceReadError) => err,
    );
    expect(read?.code).toBe('escape');
    const res = await upload('files/out/host-secret.txt');
    expect(res.error).toContain('Nothing was sent to "orrery": "files/out/host-secret.txt" couldn\'t be read from disk');
    expect(res.error).toContain(read!.message.replace(/\.+$/, ''));
    expect(res.error).toContain('It leads, through a link, outside this mount');
    expect(res.error).not.toContain(dir);
    expect(bodies).toEqual([]);
  });

  it('refuses a directory, even with a copy of that path in the workspace', async () => {
    const { mountDir, putInStore, bodies, upload } = await mounted();
    mkdirSync(join(mountDir, 'album'));
    await putInStore('files/album', 'store bytes');
    const res = await upload('files/album');
    expect(res.error).toContain('Nothing was sent to "orrery": "files/album" couldn\'t be read from disk');
    expect(res.error).toContain('Path is a directory: files/album');
    expect(bodies).toEqual([]);
  });

  it("refuses a file in a nested mount's directory, and names the path to use", async () => {
    const { workspace, putInStore, bodies, upload } = await mounted();
    await putInStore('files/inner/x.txt', 'store bytes');
    // As anima-research/agent-framework#460 reports a path in another mount's directory nested in the one named.
    workspace.readFileFromDisk = async (path) => {
      throw new WorkspaceReadError(
        OTHER_MOUNT,
        `"${path}" lies in mount "inner", nested in mount "files", which neither reads nor writes it: use "inner/x.txt".`,
        'parse',
      );
    };
    const res = await upload('files/inner/x.txt');
    // The file is the nested mount's, so the outer mount's copy isn't sent
    // or weighed, and the reason names the path to use.
    expect(res.error).toBe('Nothing was sent to "orrery": "files/inner/x.txt" lies in mount "inner", nested in mount ' +
      '"files", which neither reads nor writes it: use "inner/x.txt".');
    expect(bodies).toEqual([]);
  });

  it("refuses a file reached through a link among its directories, and says what can be done", async () => {
    const { workspace, putInStore, bodies, upload } = await mounted();
    await putInStore('files/via/x.txt', 'store bytes');
    // As agent-framework's release with anima-research/agent-framework#468
    // reports a link among a path's directories that stays inside the mount.
    workspace.readFileFromDisk = async (path) => {
      throw new WorkspaceReadError(
        PARENT_SYMLINK,
        `${path}: "files/via" is a symlink to "files/real", which this mount does not follow; the mount's host can set followSymlinks: true`,
        'readlink',
      );
    };
    const res = await upload('files/via/x.txt');
    expect(res.error).toContain('Nothing was sent to "orrery": "files/via/x.txt" couldn\'t be read from disk');
    expect(res.error).toContain('"files/via" is a symlink to "files/real"');
    expect(res.error).toContain('A directory on its path is a link, and this mount doesn\'t follow links. If the link ' +
      'leads to a directory, which the reason shows by saying the mount\'s host can set followSymlinks, name the file ' +
      'by its path there. Otherwise ask your operator');
    expect(bodies).toEqual([]);
  });

  it("refuses a file disk can't read, even with a copy in the workspace", async () => {
    const { workspace, putInStore, bodies, upload } = await mounted();
    await putInStore('files/locked.png', 'store bytes');
    // As agent-framework reports a file whose open is refused (EACCES).
    workspace.readFileFromDisk = async (path) => {
      throw new WorkspaceReadError('not_found', `Unable to read file: ${path}`, 'open', 'EACCES');
    };
    const res = await upload('files/locked.png');
    expect(res.error).toContain('Nothing was sent to "orrery": "files/locked.png" couldn\'t be read from disk');
    expect(res.error).toContain('Unable to read file: files/locked.png (EACCES)');
    expect(bodies).toEqual([]);
  });

  // mount_unavailable comes after the read's lstat found an entry, when the
  // mount root's realpath fails: no file only when the root has gone.
  it("takes a mount root gone during the read as no file, and a root that can't be resolved as a refusal", async () => {
    const { workspace, putInStore, bodies, upload } = await mounted();
    await putInStore('files/notes.txt', 'the workspace\'s copy');
    let errno = 'ENOENT';
    workspace.readFileFromDisk = async () => {
      throw new WorkspaceReadError('mount_unavailable', 'Mount unavailable: files', 'realpath_root', errno);
    };
    expect((await upload('files/notes.txt')).success).toBe(true);
    errno = 'EACCES';
    const res = await upload('files/notes.txt');
    expect(res.error).toContain('Nothing was sent to "orrery": "files/notes.txt" couldn\'t be read from disk');
    expect(res.error).toContain('Mount unavailable: files (EACCES)');
    expect(bodies.map(String)).toEqual(['the workspace\'s copy']);
  });

  it('refuses a file over the upload cap, having read no more of it than the cap', async () => {
    const { mountDir, diskReads, bodies, upload } = await mounted();
    // A sparse file one byte over the cap: nothing that large is written to the test's disk.
    writeFileSync(join(mountDir, 'huge.bin'), '');
    truncateSync(join(mountDir, 'huge.bin'), CAP + 1);
    expect((await upload('files/huge.bin')).error).toContain(`"files/huge.bin" is ${CAP + 1} bytes, over the ${CAP}-byte upload limit`);
    expect(diskReads).toEqual([{ maxBytes: CAP, read: CAP, truncated: true }]);
    expect(bodies).toEqual([]);
  });

  it("refuses the workspace's copy when it's over the upload cap", async () => {
    const { workspace, bodies, upload } = await mounted();
    (workspace as unknown as { readBinary: () => Promise<unknown> }).readBinary = async () => ({ data: { byteLength: CAP + 1 } });
    expect((await upload('files/big.wav')).error).toContain(`the workspace's copy of "files/big.wav" is ${CAP + 1} bytes, over the ${CAP}-byte upload limit`);
    expect(bodies).toEqual([]);
  });

  it('refuses a path no mount holds, and one leading out of its mount, each with its own reason', async () => {
    const { bodies, upload, workspace } = await mounted();
    expect((await upload('nope/grid.png')).error).toBe('Nothing was sent to "orrery": Unknown mount: "nope". Available: files.');
    // A path that climbs out of its mount: agent-framework 0.22.3 says it
    // "resolves outside mount", and its release with
    // anima-research/agent-framework#536 says it "climbs above the root" of
    // the mount. The upload passes on the read's own refusal.
    const climb = await workspace.readFileFromDisk('files/../outside/host-secret.txt').then(
      () => { throw new Error('agent-framework read a path that climbs out of its mount'); },
      (err: WorkspaceReadError) => err,
    );
    expect(climb.code).toBe('traversal');
    expect(climb.message).toStartWith('Path traversal detected: "files/../outside/host-secret.txt" ');
    expect((await upload('files/../outside/host-secret.txt')).error).toBe(
      `Nothing was sent to "orrery": ${climb.message.trim().replace(/\.+$/, '')}.`,
    );
    expect(bodies).toEqual([]);
  });

  // The store holds only what the resident wrote or what the sync took from
  // regular files inside the mount, so the copy that stands in is the
  // workspace's own, whatever is (or isn't) on disk at the path now. Each
  // case is its own test with one fixture, as every other test here is, so
  // no test carries two fixtures' work against its time limit.
  it("sends the workspace's own copy of a file deleted from disk", async () => {
    const { mountDir, workspace, bodies, upload } = await mounted();
    writeFileSync(join(mountDir, 'old.txt'), 'synced before it was deleted');
    expect('data' in (await workspace.readBinary('files/old.txt'))).toBe(true); // the workspace takes it in
    rmSync(join(mountDir, 'old.txt'));
    expect((await upload('files/old.txt')).success).toBe(true);
    expect(bodies.map(String)).toEqual(['synced before it was deleted']);
  });

  it("sends the workspace's own copy where a link leads nowhere", async () => {
    const { mountDir, outside, putInStore, bodies, upload } = await mounted({ followSymlinks: true });
    symlinkSync(join(outside, 'missing.txt'), join(mountDir, 'gone.txt'));
    await putInStore('files/gone.txt', 'written through the workspace');
    expect((await upload('files/gone.txt')).success).toBe(true);
    expect(bodies.map(String)).toEqual(['written through the workspace']);
  });

  // A linked directory on the path that leads nowhere, on a mount that doesn't
  // follow links: agent-framework 0.22.3 reads the path as one disk has no
  // file at (not_found with ENOENT), so the workspace's copy stands in, and its
  // release with anima-research/agent-framework#468 refuses the link as
  // parent_symlink, so nothing is sent.
  it('answers a path through a linked directory that leads nowhere as the mount\'s read does', async () => {
    const { mountDir, workspace, putInStore, bodies, upload } = await mounted();
    await putInStore('files/gone/x.txt', 'written through the workspace');
    symlinkSync(join(mountDir, 'missing'), join(mountDir, 'gone'));
    const read = await workspace.readFileFromDisk('files/gone/x.txt').then(
      () => null,
      (err: WorkspaceReadError) => err,
    );
    const res = await upload('files/gone/x.txt');
    if (read?.code === 'not_found') {
      expect(res.success).toBe(true);
      expect(bodies.map(String)).toEqual(['written through the workspace']);
    } else {
      expect(read?.code).toBe(PARENT_SYMLINK);
      expect(res.error).toContain(read!.message.replace(/\.+$/, ''));
      expect(bodies).toEqual([]);
    }
  });

  it("sends the workspace's copy where disk has no file: never materialized, under a file, a name disk can't hold, a gone mount", async () => {
    const { mountDir, putInStore, bodies, upload } = await mounted();
    await putInStore('files/notes.txt', 'never materialized');
    writeFileSync(join(mountDir, 'plain.txt'), 'a file, not a directory');
    await putInStore('files/plain.txt/inner.txt', 'under a file'); // ENOTDIR
    const long = `files/${'n'.repeat(300)}.txt`;
    await putInStore(long, 'a name disk can\'t hold'); // ENAMETOOLONG
    for (const path of ['files/notes.txt', 'files/plain.txt/inner.txt', long]) {
      expect((await upload(path)).success).toBe(true);
    }
    rmSync(mountDir, { recursive: true, force: true });
    expect((await upload('files/notes.txt')).success).toBe(true);
    expect(bodies.map(String)).toEqual(['never materialized', 'under a file', 'a name disk can\'t hold', 'never materialized']);
  });
});
