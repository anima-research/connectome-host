import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCall, ToolResult } from '@animalabs/agent-framework';
import { SetupModule, type SetupModuleConfig } from '../src/modules/setup-module.js';

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
    if (path === '/users/@me/guilds') {
      const after = url.searchParams.get('after');
      const from = after === null ? 0 : servers.findIndex((s) => s.id === after) + 1;
      return Response.json(servers.slice(from, from + Number(url.searchParams.get('limit') ?? 200))
        .map((s) => ({ id: s.id, name: s.name, owner: false })));
    }
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

function install(discord: { fetch: typeof fetch }, envFile = `DISCORD_TOKEN="${TOKEN}"\n`,
  asker: SetupModuleConfig['asker'] = () => null) {
  const dir = mkdtempSync(join(tmpdir(), 'setup-discord-'));
  dirs.push(dir);
  if (envFile !== '') writeFileSync(join(dir, '.env'), envFile, { mode: 0o600 });
  const shown: string[] = [];
  const module = new SetupModule({
    dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir }, asker, show: (line) => shown.push(line),
    fetch: discord.fetch,
  });
  return { dir, module, shown };
}

const read = (module: SetupModule, input: Record<string, unknown> = {}, resultMaxChars?: number): Promise<ToolResult> =>
  module.handleToolCall({ id: 'd1', name: 'discord', input, ...(resultMaxChars === undefined ? {} : { resultMaxChars }) } as ToolCall);

const big = (id: string, count: number, name = `Server ${id}`): FakeServer => ({
  ...HOME, id, name,
  channels: Array.from({ length: count }, (_, i) => ({ id: `${id}${String(i).padStart(4, '0')}`, name: `channel-${i}`, type: 0, position: i })),
});

const COPY_CHANNEL = 'The person can copy a channel\'s id in Discord: with Developer Mode on (User Settings, Advanced), ' +
  'right-click the channel and choose Copy Channel ID.';

describe('setup--discord', () => {
  test('is a tool of setup\'s, which its recipe allows', async () => {
    const { module } = install(fakeDiscord([HOME]));
    expect(module.getTools().map((tool) => tool.name)).toContain('discord');
    const recipe = JSON.parse(readFileSync(join(import.meta.dir, '..', 'recipes', 'setup.json'), 'utf-8')) as { agent: { allowedTools: string[] } };
    expect(recipe.agent.allowedTools).toContain('setup--discord');
  });

  test('with no token stored, it reads nothing and says to ask for one first', async () => {
    const discord = fakeDiscord([HOME]);
    const none = install(discord, '');
    const r = await read(none.module);
    expect(r.success).toBe(false);
    expect(r.error).toBe(`Nothing is stored as DISCORD_TOKEN in ${join(none.dir, '.env')}, so Discord can't be read. Ask the ` +
      'person for the bot\'s token with setup--ask_secret first.');
    expect(discord.asked).toEqual([]);
  });

  test('it gives the application\'s id and each server with its owner and its text and announcement channels under their categories, each with whether the bot can send there', async () => {
    const { module } = install(fakeDiscord([HOME]));
    const r = await read(module);
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      application: { id: '901' },
      servers: [{
        id: '100', name: 'Home',
        owner: { id: '700', username: 'ada_l', displayName: 'Ada', nickname: 'ada in home' },
        channels: [
          { id: '101', name: 'general', category: null, send: true },
          { id: '106', name: 'news', category: null, send: false },
          { id: '102', name: 'secret-room', category: null, send: false },
          { id: '105', name: 'garden', category: 'Projects', send: true },
        ],
      }],
    });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  test('a bot with Administrator, or one that owns the server, can send in every channel, whatever a channel denies', async () => {
    const admin = await read(install(fakeDiscord([ADMIN])).module);
    expect((admin.data as { servers: Array<{ channels: unknown[] }> }).servers[0]!.channels)
      .toEqual([{ id: '201', name: 'lobby', category: null, send: true }]);
    const owned = await read(install(fakeDiscord([{ ...ADMIN, ownerId: '900', botRoles: [] }])).module);
    expect((owned.data as { servers: Array<{ channels: unknown[] }> }).servers[0]!.channels)
      .toEqual([{ id: '201', name: 'lobby', category: null, send: true }]);
  });

  test('given a server and a username, it asks Discord for up to 1,000 members, its most, whose username or nickname starts with it, and gives them', async () => {
    const discord = fakeDiscord([{ ...HOME, members: [...HOME.members, { id: '703', username: 'lovelace', global_name: 'Countess', nick: 'ada of the hall' }] }]);
    const { module } = install(discord);
    const r = await read(module, { server: '100', username: 'ada' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      members: [
        { id: '700', username: 'ada_l', displayName: 'Ada', nickname: 'ada in home' },
        { id: '701', username: 'adam.k', displayName: 'Adam', nickname: null },
        { id: '703', username: 'lovelace', displayName: 'Countess', nickname: 'ada of the hall' },
      ],
    });
    expect(discord.asked).toContain('/guilds/100/members/search?query=ada&limit=1000');
  });

  test('where Discord gives its 1,000 members, it says more may match', async () => {
    const many: FakeServer = { ...HOME, members: Array.from({ length: 1_000 }, (_, i) => ({ id: `${10_000 + i}`, username: `ad${i}` })) };
    const r = await read(install(fakeDiscord([many])).module, { server: '100', username: 'ad' }, 1_000_000);
    expect((r.data as { members: unknown[] }).members).toHaveLength(1_000);
    expect((r.data as { note: string }).note).toBe('Discord gives at most 1,000 members, so more may match: call setup--discord ' +
      'again with more of the username or nickname.');
  });

  test('given a server alone, it reads that one server as the full read gives it, without listing the others', async () => {
    const discord = fakeDiscord([HOME, ADMIN]);
    const { module } = install(discord);
    const whole = await read(module);
    const before = discord.asked.length;
    const r = await read(module, { server: '100' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ server: (whole.data as { servers: unknown[] }).servers[0] });
    expect(discord.asked.slice(before).filter((path) => path.startsWith('/users/@me/guilds') || path === '/applications/@me')).toEqual([]);
  });

  test('it reads every server the bot is in, a page of 200 at a time', async () => {
    const servers = Array.from({ length: 201 }, (_, i) => big(`${1000 + i}`, 1));
    const discord = fakeDiscord(servers);
    const r = await read(install(discord).module, {}, 1_000_000);
    expect((r.data as { servers: Array<{ id: string }> }).servers.map((s) => s.id)).toEqual(servers.map((s) => s.id));
    expect(discord.asked.filter((path) => path.startsWith('/users/@me/guilds')))
      .toEqual(['/users/@me/guilds?limit=200', '/users/@me/guilds?limit=200&after=1199']);
  });

  test('it follows no redirect, which would carry the token wherever it points', async () => {
    const discord = fakeDiscord([HOME], { '/users/@me': () => new Response(null, { status: 301, headers: { location: 'https://elsewhere.example/' } }) });
    const redirects: Array<RequestRedirect | undefined> = [];
    const watched = { fetch: (async (input: string, init?: RequestInit) => {
      redirects.push(init?.redirect);
      return discord.fetch(input, init);
    }) as typeof fetch };
    expect((await read(install(watched).module)).error).toBe('Discord answered 301 to GET /users/@me with something other ' +
      'than JSON, so the read stopped there. Tell the person what it answered.');
    expect((await read(install(fakeDiscord([HOME])).module)).success).toBe(true);
    await read(install(watched).module, { server: '100' });
    expect(redirects.length).toBeGreaterThan(0);
    expect(new Set(redirects)).toEqual(new Set(['manual']));
  });

  test('a call outside its shapes is refused, and Discord isn\'t asked', async () => {
    const discord = fakeDiscord([HOME]);
    const { module } = install(discord);
    for (const input of [{ server: 100 }, { server: '1e2' }, { server: '../users/@me' }]) {
      expect((await read(module, input)).error).toBe('setup--discord\'s server is a server\'s id: digits, given as text.');
    }
    for (const input of [{ username: 'ada' }, { server: '100', username: ' ' }, { server: '100', username: 7 }]) {
      expect((await read(module, input)).error).toBe('setup--discord\'s username is the start of a username or server ' +
        'nickname, given as text with server.');
    }
    expect(discord.asked).toEqual([]);
  });

  test('where every server\'s channels together don\'t fit one answer, the servers come without them, and say to read one server', async () => {
    const r = await read(install(fakeDiscord([HOME, big('300', 400)])).module);
    expect(r.success).toBe(true);
    expect(JSON.stringify(r.data).length).toBeLessThanOrEqual(24_000);
    expect(r.data).toEqual({
      application: { id: '901' },
      servers: [
        { id: '100', name: 'Home', owner: { id: '700', username: 'ada_l', displayName: 'Ada', nickname: 'ada in home' } },
        { id: '300', name: 'Server 300', owner: { id: '700', username: 'ada_l', displayName: 'Ada', nickname: 'ada in home' } },
      ],
      note: 'Every server\'s channels together don\'t fit in one answer: call setup--discord with a server\'s id as server ' +
        'to read its channels.',
    });
    const whole = await read(install(fakeDiscord([HOME, big('300', 400)])).module, {}, 1_000_000);
    expect((whole.data as { servers: Array<{ channels: unknown[] }> }).servers[1]!.channels).toHaveLength(400);
  });

  test('where one server\'s channels, a search, or the servers alone don\'t fit one answer, it says so in one line, with what to do', async () => {
    const channels = await read(install(fakeDiscord([big('300', 400)])).module, { server: '300' });
    expect(channels).toEqual({ success: false, isError: true,
      error: `That server's channels don't fit in one answer. ${COPY_CHANNEL}` });
    const many: FakeServer = { ...HOME, members: Array.from({ length: 300 }, (_, i) => ({ id: `${10_000 + i}`, username: `ada${i}` })) };
    const search = await read(install(fakeDiscord([many])).module, { server: '100', username: 'ada' }, 2_000);
    expect(search.error).toBe('The members that match don\'t fit in one answer: call setup--discord again with more of the ' +
      'username or nickname.');
    const servers = Array.from({ length: 30 }, (_, i) => big(`${400 + i}`, 1, `A server with a long name, number ${i}`));
    const all = await read(install(fakeDiscord(servers)).module, {}, 2_000);
    expect(all.error).toBe('The bot\'s servers don\'t fit in one answer, even without their channels. The person can copy ' +
      'a server\'s id in Discord: with Developer Mode on (User Settings, Advanced), right-click the server and choose Copy ' +
      'Server ID.');
  });

  test('the person sees a line for each read, before Discord is asked, with a stored secret given as a username shown by its name', async () => {
    const discord = fakeDiscord([HOME]);
    const { module, shown } = install(discord, `DISCORD_TOKEN="${TOKEN}"\nOPENAI_API_KEY="sk-test-secret-value"\n`);
    await read(module);
    await read(module, { server: '100' });
    await read(module, { server: '100', username: 'sk-test-secret-value' });
    expect(shown).toEqual([
      'Setup\'s agent reads the bot\'s servers and channels from Discord.',
      'Setup\'s agent reads one of the bot\'s servers from Discord.',
      'Setup\'s agent searches a Discord server\'s members for <OPENAI_API_KEY>.',
    ]);
  });

  test('a read asked for while a secret is being asked waits for its answer, through the one queue', async () => {
    let answer!: (value: string) => void;
    const typed = new Promise<string>((done) => { answer = done; });
    let entered!: () => void;
    const asking = new Promise<void>((done) => { entered = done; });
    const discord = fakeDiscord([HOME]);
    const { module, shown } = install(discord, `DISCORD_TOKEN="${TOKEN}"\n`, () => ({ ask: () => { entered(); return typed; } }));
    const asked = module.handleToolCall({ id: 'a1', name: 'ask_secret', input: { name: 'OTHER_SECRET', purpose: 'a test' } } as ToolCall);
    await asking;
    const reading = read(module);
    await Bun.sleep(50);
    expect(shown).toEqual([]);
    expect(discord.asked).toEqual([]);
    answer('a-typed-value-1234');
    expect((await asked).success).toBe(true);
    expect((await reading).success).toBe(true);
    expect(shown).toEqual(['Setup\'s agent reads the bot\'s servers and channels from Discord.']);
  });

  test('a failed read gives the path, Discord\'s status and code, and what to do, and none of Discord\'s words or the token', async () => {
    const fails = async (answers: Record<string, () => Response>) => (await read(install(fakeDiscord([HOME], answers)).module)).error;
    expect(await fails({ '/users/@me': () => Response.json({ message: `401: Unauthorized ${TOKEN}`, code: 0 }, { status: 401 }) }))
      .toBe('Discord answered 401 (code 0) to GET /users/@me, so the read stopped there. It refused the bot token stored ' +
        'as DISCORD_TOKEN: ask the person for it again with setup--ask_secret.');
    expect(await fails({ '/guilds/100/channels': () => Response.json({ message: 'Missing Access', code: 50001 }, { status: 403 }) }))
      .toBe('Discord answered 403 (code 50001) to GET /guilds/100/channels, so the read stopped there. The bot may no ' +
        'longer be in that server: call setup--discord with no input to see the servers it\'s in now.');
    expect(await fails({ '/users/@me/guilds': () => Response.json({ message: 'You are being rate limited.', retry_after: 2.5 }, { status: 429 }) }))
      .toBe('Discord answered 429 to GET /users/@me/guilds, so the read stopped there. It asks for 3 s: call setup--discord ' +
        'again once that has passed.');
    expect(await fails({ '/applications/@me': () => new Response('busy', { status: 503, headers: { 'retry-after': '7' } }) }))
      .toBe('Discord answered 503 to GET /applications/@me with something other than JSON, so the read stopped there. It ' +
        'asks for 7 s: call setup--discord again once that has passed.');
    expect(await fails({ '/applications/@me': () => Response.json({ message: 'Unknown Application', code: 10002 }, { status: 404 }) }))
      .toBe('Discord answered 404 (code 10002) to GET /applications/@me, so the read stopped there. Tell the person what it ' +
        'answered.');
    const silent = install({ fetch: (async () => { throw Object.assign(new TypeError('fetch failed'), { code: 'ENOTFOUND' }); }) as unknown as typeof fetch });
    expect((await read(silent.module)).error).toBe('Discord couldn\'t be reached for GET /users/@me (ENOTFOUND), so the ' +
      'read stopped there. Call setup--discord again, and if it fails the same way, tell the person: their connection to ' +
      'discord.com is theirs to check.');
    const searched = install(fakeDiscord([HOME], { '/guilds/100/members/search': () => Response.json({ message: 'no', code: 50013 }, { status: 403 }) }));
    expect((await read(searched.module, { server: '100', username: 'a&b' })).error).toStartWith('Discord answered 403 (code 50013) to GET /guilds/100/members/search, so');
  });

  test('an answer setup can\'t read as Discord\'s stops the read in setup\'s words', async () => {
    const r = await read(install(fakeDiscord([HOME], { '/users/@me/guilds': () => Response.json({ not: 'a list' }) })).module);
    expect(r.error).toBe('Discord\'s answer to GET /users/@me/guilds isn\'t one setup can read, so the read stopped there. ' +
      'Tell the person: something between this machine and Discord may be answering in its place.');
  });
});
