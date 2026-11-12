import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCall, ToolResult } from '@animalabs/agent-framework';
import { SetupModule } from '../src/modules/setup-module.js';

const TOKEN = 'MTEx.fake-token-value.abc';
const VIEW = 1 << 10;
const SEND = 1 << 11;
const ADMINISTRATOR = 1 << 3;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakeServer {
  id: string;
  name: string;
  ownerId: string;
  everyone: number;
  botRoles: Array<{ id: string; permissions: number }>;
  members: Array<{ id: string; username: string; global_name?: string; nick?: string }>;
  channels: Array<{ id: string; name: string; type: number; position: number; parent_id?: string; overwrites?: Array<{ id: string; type: 0 | 1; allow?: number; deny?: number }> }>;
}

const HOME: FakeServer = {
  id: '100', name: 'Home', ownerId: '700', everyone: VIEW | SEND,
  botRoles: [{ id: '110', permissions: 0 }],
  members: [
    { id: '700', username: 'ada_l', global_name: 'Ada', nick: 'ada in home' },
    { id: '701', username: 'adam.k', global_name: 'Adam' },
    { id: '900', username: 'ember' },
  ],
  channels: [
    { id: '104', name: 'Projects', type: 4, position: 1 },
    { id: '105', name: 'garden', type: 0, position: 0, parent_id: '104' },
    { id: '101', name: 'general', type: 0, position: 0 },
    { id: '106', name: 'news', type: 5, position: 1, overwrites: [{ id: '100', type: 0, deny: SEND }] },
    { id: '102', name: 'secret-room', type: 0, position: 2, overwrites: [{ id: '100', type: 0, deny: VIEW }] },
    { id: '107', name: 'voice', type: 2, position: 3 },
  ],
};

const ADMIN: FakeServer = {
  id: '200', name: 'Elsewhere', ownerId: '701', everyone: 0,
  botRoles: [{ id: '210', permissions: ADMINISTRATOR }],
  members: [{ id: '701', username: 'adam.k' }, { id: '900', username: 'ember' }],
  channels: [{ id: '201', name: 'lobby', type: 0, position: 0, overwrites: [{ id: '200', type: 0, deny: VIEW | SEND }] }],
};

function fakeDiscord(servers: FakeServer[], answers: Record<string, () => Response> = {}) {
  const asked: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace(/^\/api\/v10/, '');
    asked.push(`${path}${url.search}`);
    if (answers[path]) return answers[path]!();
    if (new Headers(init?.headers).get('authorization') !== `Bot ${TOKEN}`) {
      return Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 });
    }
    if (path === '/users/@me') return Response.json({ id: '900', username: 'ember', bot: true });
    if (path === '/applications/@me') return Response.json({ id: '901', name: 'Ember', flags: 0 });
    if (path === '/users/@me/guilds') return Response.json(servers.map((s) => ({ id: s.id, name: s.name, owner: false })));
    const m = /^\/guilds\/(\d+)(?:\/(roles|channels|members\/search|members\/(\d+)))?$/.exec(path);
    const server = m ? servers.find((s) => s.id === m[1]) : undefined;
    if (!m || !server) return Response.json({ message: 'Unknown Guild', code: 10004 }, { status: 404 });
    const member = (id: string) => {
      const found = server.members.find((each) => each.id === id)!;
      return { user: { id: found.id, username: found.username, global_name: found.global_name ?? null }, nick: found.nick ?? null, roles: id === '900' ? server.botRoles.map((r) => r.id) : [] };
    };
    if (m[2] === undefined) return Response.json({ id: server.id, name: server.name, owner_id: server.ownerId });
    if (m[2] === 'roles') {
      return Response.json([{ id: server.id, permissions: String(server.everyone) },
        ...server.botRoles.map((r) => ({ id: r.id, permissions: String(r.permissions) }))]);
    }
    if (m[2] === 'channels') {
      return Response.json(server.channels.map((c) => ({
        id: c.id, name: c.name, type: c.type, position: c.position, parent_id: c.parent_id ?? null,
        permission_overwrites: (c.overwrites ?? []).map((o) => ({ id: o.id, type: o.type, allow: String(o.allow ?? 0), deny: String(o.deny ?? 0) })),
      })));
    }
    if (m[2] === 'members/search') {
      const query = (url.searchParams.get('query') ?? '').toLowerCase();
      const limit = Number(url.searchParams.get('limit') ?? 1);
      return Response.json(server.members
        .filter((each) => each.username.toLowerCase().startsWith(query) || (each.nick ?? '').toLowerCase().startsWith(query))
        .slice(0, limit).map((each) => member(each.id)));
    }
    return Response.json(member(m[3]!));
  }) as typeof fetch;
  return { fetch: fetchFn, asked };
}

function install(discord: { fetch: typeof fetch }, envFile = `DISCORD_TOKEN="${TOKEN}"\n`) {
  const dir = mkdtempSync(join(tmpdir(), 'setup-discord-'));
  dirs.push(dir);
  if (envFile !== '') writeFileSync(join(dir, '.env'), envFile, { mode: 0o600 });
  const shown: string[] = [];
  const module = new SetupModule({
    dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir }, asker: () => null,
    show: (line) => shown.push(line), fetch: discord.fetch,
  });
  return { dir, module, shown };
}

const read = (module: SetupModule, input: Record<string, unknown> = {}): Promise<ToolResult> =>
  module.handleToolCall({ id: 'd1', name: 'discord', input } as ToolCall);

describe('setup--discord', () => {
  test('with no token stored, or a .env setup can\'t read, it reads nothing and says what to do first', async () => {
    const discord = fakeDiscord([HOME]);
    const none = install(discord, '');
    const unstored = await read(none.module);
    expect(unstored.success).toBe(false);
    expect(unstored.error).toBe(`Nothing is stored as DISCORD_TOKEN in ${join(none.dir, '.env')}, so Discord can't be read. Ask the person for the bot's token with setup--ask_secret first.`);
    const odd = install(discord, 'DISCORD_TOKEN=two words\n');
    const unread = await read(odd.module);
    expect(unread.success).toBe(false);
    expect(unread.error).toStartWith('Nothing was read: ');
    expect(discord.asked).toEqual([]);
  });

  test('it gives the application\'s id, each server with its owner, and its text channels under their categories, each with whether the bot can view it and send there', async () => {
    const { module } = install(fakeDiscord([HOME]));
    const r = await read(module);
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      application: { id: '901' },
      bot: { id: '900', name: 'ember' },
      servers: [{
        id: '100', name: 'Home',
        owner: { id: '700', username: 'ada_l', displayName: 'Ada', nickname: 'ada in home' },
        channels: [
          { id: '101', name: 'general', category: null, view: true, send: true },
          { id: '106', name: 'news', category: null, view: true, send: false },
          { id: '102', name: 'secret-room', category: null, view: false, send: false },
          { id: '105', name: 'garden', category: 'Projects', view: true, send: true },
        ],
      }],
    });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  test('a bot with Administrator can view and send in every channel, whatever a channel denies', async () => {
    const { module } = install(fakeDiscord([ADMIN]));
    const r = await read(module);
    expect((r.data as { servers: Array<{ channels: unknown[] }> }).servers[0]!.channels)
      .toEqual([{ id: '201', name: 'lobby', category: null, view: true, send: true }]);
  });

  test('given a server and a username, it asks Discord for up to ten members whose username or nickname starts with it, and gives them', async () => {
    const discord = fakeDiscord([HOME]);
    const { module } = install(discord);
    const r = await read(module, { server: '100', username: 'ada' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      server: '100', username: 'ada',
      members: [
        { id: '700', username: 'ada_l', displayName: 'Ada', nickname: 'ada in home' },
        { id: '701', username: 'adam.k', displayName: 'Adam', nickname: null },
      ],
    });
    expect(discord.asked).toContain('/guilds/100/members/search?query=ada&limit=10');
    const half = await read(module, { server: '100' });
    expect(half.success).toBe(false);
    expect(half.error).toContain('given both server');
  });

  test('the person is told of each read made with the bot\'s token, with a stored secret given as a username shown by its name', async () => {
    const { module, shown } = install(fakeDiscord([HOME]), `DISCORD_TOKEN="${TOKEN}"\nOPENAI_API_KEY="sk-test-secret-value"\n`);
    await read(module);
    await read(module, { server: '100', username: 'sk-test-secret-value' });
    expect(shown).toEqual([
      'Reading the bot\'s servers and channels from Discord.',
      'Searching a Discord server\'s members for <OPENAI_API_KEY>.',
    ]);
  });

  test('a refused token, a busy Discord, one that asks for a wait, an answer that isn\'t JSON, and one that doesn\'t answer each say what Discord did and what to do, never with the token', async () => {
    const refused = await read(install(fakeDiscord([HOME], { '/users/@me': () => Response.json({ message: '401: Unauthorized' }, { status: 401 }) })).module);
    expect(refused.error).toBe('Discord refused the bot token stored as DISCORD_TOKEN (401), so the read stopped there. Ask the person for the token again with setup--ask_secret.');

    const busy = await read(install(fakeDiscord([HOME], { '/applications/@me': () => Response.json({ message: 'Service Unavailable' }, { status: 503 }) })).module);
    expect(busy.error).toBe('Discord answered 503 to GET /applications/@me: Service Unavailable, so the read stopped there. Call setup--discord again in a minute, and if it answers the same, tell the person what it says.');

    const wait = await read(install(fakeDiscord([HOME], { '/users/@me/guilds': () => Response.json({ message: 'You are being rate limited.', retry_after: 2.5 }, { status: 429 }) })).module);
    expect(wait.error).toBe('Discord answered 429 to GET /users/@me/guilds?limit=200: You are being rate limited., so the read stopped there. It asks for 3 s: call setup--discord again once that has passed.');

    const echoed = await read(install(fakeDiscord([HOME], { '/guilds/100/channels': () => Response.json({ message: `Missing Access for ${TOKEN}`, code: 50001 }, { status: 403 }) })).module);
    expect(echoed.error).toBe('Discord answered 403 to GET /guilds/100/channels: Missing Access for <DISCORD_TOKEN> (code 50001), so the read stopped there. The bot may no longer be in that server: call setup--discord with no input to see the servers it\'s in now.');

    const page = await read(install(fakeDiscord([HOME], { '/applications/@me': () => new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } }) })).module);
    expect(page.error).toBe('Discord answered GET /applications/@me with something other than JSON, so the read stopped there. Tell the person: something between this machine and Discord may be answering in its place.');

    const silent = install({ fetch: (async () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND discord.com'); }) as unknown as typeof fetch });
    const unanswered = await read(silent.module);
    expect(unanswered.error).toBe('Discord couldn\'t be asked GET /users/@me (fetch failed: getaddrinfo ENOTFOUND discord.com), so the read stopped there. Call setup--discord again, and if it fails the same way, tell the person: their connection to discord.com is theirs to check.');
  });
});
