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

  test('given a server and a username, it asks Discord for up to 1,000 members, its most, whose username or nickname starts with it, and gives them', async () => {
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
    expect(discord.asked).toContain('/guilds/100/members/search?query=ada&limit=1000');
    const half = await read(module, { username: 'ada' });
    expect(half.success).toBe(false);
    expect(half.error).toContain('given both server');
  });

  test('where more members match than one answer holds, it gives the first that fit and says how many matched, so a longer start narrows them', async () => {
    const matching = (count: number): FakeServer => ({
      ...HOME,
      members: [...Array.from({ length: count }, (_, i) => ({ id: `${10_000 + i}`, username: `ada${i}`, global_name: `Ada the ${i}th`, nick: `ada of the garden ${i}` })), { id: '900', username: 'ember' }],
    });
    const capped = (module: SetupModule, resultMaxChars?: number) =>
      module.handleToolCall({ id: 'd1', name: 'discord', input: { server: '100', username: 'ada' }, ...(resultMaxChars ? { resultMaxChars } : {}) } as ToolCall);
    const thirty = install(fakeDiscord([matching(30)])).module;
    const all = await capped(thirty);
    expect((all.data as { members: unknown[] }).members).toHaveLength(30);
    expect(all.data).not.toHaveProperty('note');
    const cut = await capped(thirty, 1_000);
    expect(JSON.stringify(cut.data).length).toBeLessThanOrEqual(1_000);
    const data = cut.data as { members: Array<{ username: string }>; note: string };
    expect(data.members.length).toBeGreaterThan(0);
    expect(data.members.length).toBeLessThan(30);
    expect(data.members.map((m) => m.username)).toEqual(Array.from({ length: data.members.length }, (_, i) => `ada${i}`));
    expect(data.note).toBe(`${data.members.length} of the 30 members that match are shown, since one answer can't hold more: call setup--discord again with more of the username or nickname.`);
    const most = await capped(install(fakeDiscord([matching(1_001)])).module);
    const top = most.data as { members: unknown[]; note: string };
    expect(JSON.stringify(top).length).toBeLessThanOrEqual(24_000);
    expect(top.note).toBe(`${top.members.length} of the 1000 members that match, the most Discord gives, are shown, since one answer can't hold more, and more may match: call setup--discord again with more of the username or nickname.`);
  });

  test('given a server alone, it reads that one server as the full read gives it, without listing the others', async () => {
    const discord = fakeDiscord([HOME, ADMIN]);
    const { module } = install(discord);
    const whole = await read(module);
    const r = await read(module, { server: '100' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ bot: { id: '900', name: 'ember' }, server: (whole.data as { servers: unknown[] }).servers[0] });
    expect(discord.asked.slice(discord.asked.lastIndexOf('/users/@me')).filter((p) => p.startsWith('/users/@me/guilds'))).toEqual([]);
    const gone = await read(module, { server: '300' });
    expect(gone.error).toContain('The bot may no longer be in that server');
  });

  const big = (id: string, count: number, name = `Server ${id}`): FakeServer => ({
    ...HOME, id, name, members: HOME.members,
    channels: Array.from({ length: count }, (_, i) => ({ id: `${id}${String(i).padStart(4, '0')}`, name: `channel-${i}`, type: 0, position: i })),
  });

  test('where every server\'s channels together would pass what one answer can hold, the servers come with their counts of channels and without the channels, and say to read one server', async () => {
    const r = await read(install(fakeDiscord([HOME, big('300', 400)])).module);
    expect(r.success).toBe(true);
    expect(JSON.stringify(r.data).length).toBeLessThanOrEqual(24_000);
    const data = r.data as { servers: Array<Record<string, unknown>>; note: string };
    expect(data.servers.map((s) => [s.id, s.textChannels, 'channels' in s])).toEqual([['100', 4, false], ['300', 400, false]]);
    expect(data.note).toBe('Every server\'s channels together would pass what one answer can hold, so the servers come without them: call setup--discord with a server\'s id as server to read its channels.');
  });

  test('where the servers alone would pass what one answer can hold, the first that fit come, with how many of how many, and how the person copies another\'s id', async () => {
    const servers = Array.from({ length: 150 }, (_, i) => big(`${400 + i}`, 1, `A server with a long name, number ${i}`));
    const r = await read(install(fakeDiscord(servers)).module);
    expect(r.success).toBe(true);
    expect(JSON.stringify(r.data).length).toBeLessThanOrEqual(24_000);
    const data = r.data as { servers: Array<{ id: string }>; note: string };
    expect(data.servers.length).toBeLessThan(150);
    expect(data.servers.map((s) => s.id)).toEqual(servers.slice(0, data.servers.length).map((s) => s.id));
    expect(data.note).toBe(`${data.servers.length} of 150 servers are shown, since one answer can't hold more, without their channels: call setup--discord with a server's id as server to read its channels. The person can copy the id of a server not shown in Discord: with Developer Mode on (User Settings, Advanced), right-click the server and choose Copy Server ID.`);
  });

  test('where one server\'s channels would pass what one answer can hold, the first that fit in the tool\'s order come, with how many of how many, and how the person copies another\'s id', async () => {
    const r = await read(install(fakeDiscord([big('300', 400)])).module, { server: '300' });
    expect(r.success).toBe(true);
    expect(JSON.stringify(r.data).length).toBeLessThanOrEqual(24_000);
    const data = r.data as { server: { channels: Array<{ name: string }> }; note: string };
    const n = data.server.channels.length;
    expect(n).toBeLessThan(400);
    expect(data.server.channels.map((c) => c.name)).toEqual(Array.from({ length: n }, (_, i) => `channel-${i}`));
    expect(data.note).toBe(`${n} of 400 text and announcement channels are shown, since one answer can't hold more. The person can copy the id of a channel not shown in Discord: with Developer Mode on (User Settings, Advanced), right-click the channel and choose Copy Channel ID.`);
  });

  test('the person sees the read\'s line before Discord is asked anything, and a secret question asked meanwhile doesn\'t wait for the read', async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const discord = fakeDiscord([HOME]);
    const shown: string[] = [];
    const lineAtRequest: boolean[] = [];
    const slow = (async (input: string, init: RequestInit) => {
      lineAtRequest.push(shown.includes('Reading the bot\'s servers and channels from Discord.'));
      await gate;
      return discord.fetch(input, init);
    }) as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), 'setup-discord-'));
    dirs.push(dir);
    writeFileSync(join(dir, '.env'), `DISCORD_TOKEN="${TOKEN}"\n`, { mode: 0o600 });
    const module = new SetupModule({
      dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir }, asker: () => ({ ask: async () => 'a-typed-value' }),
      show: (line) => shown.push(line), fetch: slow,
    });
    const reading = read(module);
    await Bun.sleep(20);
    expect(shown).toContain('Reading the bot\'s servers and channels from Discord.');
    expect(lineAtRequest).toEqual([true]);
    const asked = module.handleToolCall({ id: 'a1', name: 'ask_secret', input: { name: 'NEW_TOKEN', purpose: 'a test' } } as ToolCall);
    expect(await Promise.race([asked.then(() => 'answered'), Bun.sleep(500).then(() => 'waited')])).toBe('answered');
    release();
    expect((await reading).success).toBe(true);
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
    expect(wait.error).toBe('Discord answered 429 to GET /users/@me/guilds: You are being rate limited., so the read stopped there. It asks for 3 s: call setup--discord again once that has passed.');

    const echoed = await read(install(fakeDiscord([HOME], { '/guilds/100/channels': () => Response.json({ message: `Missing Access for ${TOKEN}`, code: 50001 }, { status: 403 }) })).module);
    expect(echoed.error).toBe('Discord answered 403 to GET /guilds/100/channels: Missing Access for <DISCORD_TOKEN> (code 50001), so the read stopped there. The bot may no longer be in that server: call setup--discord with no input to see the servers it\'s in now, and if that server is still listed and answers the same, tell the person what it says.');

    const own = await read(install(fakeDiscord([HOME], { '/applications/@me': () => Response.json({ message: 'Missing Access', code: 50001 }, { status: 403 }) })).module);
    expect(own.error).toBe('Discord answered 403 to GET /applications/@me: Missing Access (code 50001), so the read stopped there. Tell the person: something between this machine and Discord may be answering in its place.');

    const user = await read(install(fakeDiscord([HOME], { '/users/@me': () => Response.json({ message: 'Unknown User', code: 10013 }, { status: 404 }) })).module);
    expect(user.error).toBe('Discord answered 404 to GET /users/@me: Unknown User, so the read stopped there. Tell the person: something between this machine and Discord may be answering in its place.');

    const page = await read(install(fakeDiscord([HOME], { '/applications/@me': () => new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } }) })).module);
    expect(page.error).toBe('Discord answered GET /applications/@me with something other than JSON, so the read stopped there. Tell the person: something between this machine and Discord may be answering in its place.');

    const silent = install({ fetch: (async () => { throw new TypeError('fetch failed: getaddrinfo ENOTFOUND discord.com'); }) as unknown as typeof fetch });
    const unanswered = await read(silent.module);
    expect(unanswered.error).toBe('Discord couldn\'t be asked GET /users/@me (fetch failed: getaddrinfo ENOTFOUND discord.com), so the read stopped there. Call setup--discord again, and if it fails the same way, tell the person: their connection to discord.com is theirs to check.');

    const notBot = await read(install(fakeDiscord([HOME], { '/users/@me': () => Response.json({}) })).module);
    expect(notBot.error).toBe('Discord answered GET /users/@me with something other than the bot\'s user, so the read stopped there. Tell the person: something between this machine and Discord may be answering in its place.');
  });

  test('a 401 to a read after the token check is decided by its type before its body, as the token check decides one: typed JSON is a refusal, any other type isn\'t Discord\'s', async () => {
    const REFUSED = 'Discord refused the bot token stored as DISCORD_TOKEN (401), so the read stopped there. Ask the person for the token again with setup--ask_secret.';
    const typed = (type: string, body: BodyInit) => () => new Response(body, { status: 401, headers: { 'content-type': type } });
    const page = await read(install(fakeDiscord([HOME], { '/users/@me/guilds': typed('text/html', '{"message":"401: Unauthorized","code":0}') })).module);
    expect(page.error).toBe('Discord answered 401 to GET /users/@me/guilds with something other than JSON, so the read stopped there. Tell the person: something between this machine and Discord may be answering in its place.');
    const json = await read(install(fakeDiscord([HOME], { '/users/@me/guilds': typed('application/json', '<html>401</html>') })).module);
    expect(json.error).toBe(REFUSED);
    const stalled = await read(install(fakeDiscord([HOME], { '/users/@me/guilds': typed('application/json', new ReadableStream({ start() {} })) })).module);
    expect(stalled.error).toBe(REFUSED);
  });

  test('a 429 to the token check or a later read that gives no retry_after asks for Retry-After\'s seconds, whether or not its body is JSON', async () => {
    const limited = (body: string, type: string) => () => new Response(body, { status: 429, headers: { 'content-type': type, 'retry-after': '300' } });
    const token = await read(install(fakeDiscord([HOME], { '/users/@me': limited('<html>slow down</html>', 'text/html') })).module);
    expect(token.error).toBe('Discord answered 429 to GET /users/@me with something other than JSON, so the read stopped there. It asks for 300 s: call setup--discord again once that has passed.');
    const page = await read(install(fakeDiscord([HOME], { '/users/@me/guilds': limited('<html>slow down</html>', 'text/html') })).module);
    expect(page.error).toBe('Discord answered 429 to GET /users/@me/guilds with something other than JSON, so the read stopped there. It asks for 300 s: call setup--discord again once that has passed.');
    const json = await read(install(fakeDiscord([HOME], { '/users/@me/guilds': limited('{"message":"You are being rate limited."}', 'application/json') })).module);
    expect(json.error).toBe('Discord answered 429 to GET /users/@me/guilds: You are being rate limited., so the read stopped there. It asks for 300 s: call setup--discord again once that has passed.');
  });

  test('an answer in JSON that setup can\'t read the way it reads Discord\'s stops the read in setup\'s words, never with the token, rather than throwing', async () => {
    const shapes: Array<[Record<string, () => Response>, Record<string, unknown>]> = [
      [{ '/guilds/100/members/search': () => Response.json({ members: [] }) }, { server: '100', username: 'ada' }],
      [{ '/guilds/100/roles': () => Response.json([{ id: '100', permissions: `lots ${TOKEN}` }]) }, {}],
      [{ '/users/@me/guilds': () => Response.json(null) }, {}],
    ];
    for (const [answers, input] of shapes) {
      const r = await read(install(fakeDiscord([HOME], answers)).module, input);
      expect(r.success).toBe(false);
      expect(r.error).toStartWith('The read stopped on an answer setup can\'t read (');
      expect(r.error).toEndWith('). Tell the person: something between this machine and Discord may be answering in its place.');
      expect(r.error).not.toContain(TOKEN);
    }
  });

  test('a call outside setup--discord\'s shapes is refused naming the value it refused, a stored secret by its name', async () => {
    const discord = fakeDiscord([HOME]);
    const { module } = install(discord, `DISCORD_TOKEN="${TOKEN}"\nOPENAI_API_KEY="sk-test-secret-value"\n`);
    const shapes = 'setup--discord searches members given both server, a server\'s id as it gives them, and username, ' +
      'the start of a username or server nickname. Call it with server alone to read that server, or with neither to ' +
      'read the servers and channels.';
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ server: 'general' }, 'server is "general", which isn\'t a server\'s id: one is digits, given as text.'],
      [{ server: 100 }, 'server is 100, which isn\'t a server\'s id: one is digits, given as text.'],
      [{ server: 'sk-test-secret-value' }, 'server is "<OPENAI_API_KEY>", which isn\'t a server\'s id: one is digits, given as text.'],
      [{ username: 'ada' }, 'username is "ada", given without server, the server whose members to search.'],
      [{ server: '100', username: '  ' }, 'username is "  ", which holds no start of a name to search for.'],
      [{ server: '100', username: 7 }, 'username is 7, which holds no start of a name to search for.'],
    ];
    for (const [input, says] of cases) {
      const r = await read(module, input);
      expect([input, r.success, r.error]).toEqual([input, false, `${says} ${shapes}`]);
    }
    expect(discord.asked).toEqual([]);
  });

  test('a read asked for while a question is being asked waits for its answer: no line and no request to Discord come before it', async () => {
    let answer!: (value: string) => void;
    const typed = new Promise<string>((done) => { answer = done; });
    const discord = fakeDiscord([HOME]);
    const dir = mkdtempSync(join(tmpdir(), 'setup-discord-'));
    dirs.push(dir);
    writeFileSync(join(dir, '.env'), `DISCORD_TOKEN="${TOKEN}"\n`, { mode: 0o600 });
    const shown: string[] = [];
    const module = new SetupModule({
      dir, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir }, asker: () => ({ ask: () => typed }),
      show: (line) => shown.push(line), fetch: discord.fetch,
    });
    const asked = module.handleToolCall({ id: 'a1', name: 'ask_secret', input: { name: 'NEW_TOKEN', purpose: 'a test' } } as ToolCall);
    await Bun.sleep(20);
    const reading = read(module);
    await Bun.sleep(50);
    expect(shown.filter((line) => line.startsWith('Reading'))).toEqual([]);
    expect(discord.asked).toEqual([]);
    answer('a-typed-value');
    await asked;
    expect((await reading).success).toBe(true);
    expect(shown).toContain('Reading the bot\'s servers and channels from Discord.');
    expect(discord.asked.length).toBeGreaterThan(0);
  });

  test('a stored secret in what Discord gives back, or in the call\'s own username, comes in the answer by its name', async () => {
    const named: FakeServer = { ...HOME, name: `Home ${TOKEN}`, members: [...HOME.members, { id: '702', username: 'sk-test-secret-value-fan' }] };
    const env = `DISCORD_TOKEN="${TOKEN}"\nOPENAI_API_KEY="sk-test-secret-value"\n`;
    const whole = await read(install(fakeDiscord([named]), env).module);
    expect(whole.success).toBe(true);
    expect(JSON.stringify(whole.data)).not.toContain(TOKEN);
    expect((whole.data as { servers: Array<{ name: string }> }).servers[0]!.name).toBe('Home <DISCORD_TOKEN>');
    const one = await read(install(fakeDiscord([named]), env).module, { server: '100' });
    expect((one.data as { server: { name: string } }).server.name).toBe('Home <DISCORD_TOKEN>');
    const found = await read(install(fakeDiscord([named]), env).module, { server: '100', username: 'sk-test-secret-value' });
    expect(found.success).toBe(true);
    expect(JSON.stringify(found.data)).not.toContain('sk-test-secret-value');
    expect(found.data).toMatchObject({ username: '<OPENAI_API_KEY>', members: [{ id: '702', username: '<OPENAI_API_KEY>-fan' }] });
  });

  test('a call that carries the framework\'s lowest cap, 1,000, gets an answer that fits it, saying how many are shown; a call with none fits 24,000', async () => {
    const discord = fakeDiscord([big('300', 50), big('400', 50)]);
    const { module } = install(discord);
    const capped = (input: Record<string, unknown>, resultMaxChars: number) =>
      module.handleToolCall({ id: 'd1', name: 'discord', input, resultMaxChars } as ToolCall);
    const free = await read(module, { server: '300' });
    expect(JSON.stringify(free.data).length).toBeGreaterThan(1_000);
    for (const [input, note] of [[{}, /^(Every server's channels together would pass|\d+ of 2 servers are shown)/], [{ server: '300' }, /^\d+ of 50 text and announcement channels are shown/]] as const) {
      const r = await capped(input, 1_000);
      expect([input, r.success]).toEqual([input, true]);
      expect([input, JSON.stringify(r.data).length <= 1_000]).toEqual([input, true]);
      expect((r.data as { note: string }).note).toMatch(note);
    }
    const whole = await read(module);
    expect(JSON.stringify(whole.data).length).toBeLessThanOrEqual(24_000);
    expect(whole.data).toMatchObject({ servers: [{ id: '300' }, { id: '400' }] });
    expect((whole.data as { servers: Array<{ channels: unknown[] }> }).servers[0]!.channels.length).toBe(50);
  });

  test('a failed read names its endpoint without its query, and a stored secret that the call sent or Discord gave back comes by its name', async () => {
    const OTHER = 'sk-stored-583-other';
    const env = `DISCORD_TOKEN="${TOKEN}"\nOPENAI_API_KEY="${OTHER}"\n`;
    const missing = install(fakeDiscord([HOME], {
      '/guilds/100/members/search': () => Response.json({ message: `Unknown Member ${OTHER}`, code: 10007 }, { status: 404 }),
    }), env);
    const searched = await read(missing.module, { server: '100', username: OTHER });
    expect(searched.success).toBe(false);
    expect(searched.error).toStartWith('Discord answered 404 to GET /guilds/100/members/search: Unknown Member <OPENAI_API_KEY> (code 10007), so the read stopped there.');
    expect(searched.error).not.toContain(OTHER);
    const down = install(fakeDiscord([HOME], { '/users/@me': () => Response.json({ message: `down for ${OTHER}` }, { status: 503 }) }), env);
    const checked = await read(down.module);
    expect(checked.error).toStartWith('Discord answered 503 to GET /users/@me: down for <OPENAI_API_KEY>, so the read stopped there.');
  });

  test('a server or application id that is a stored secret\'s value comes by its name, and an ordinary id as it is', async () => {
    const discord = fakeDiscord([HOME, ADMIN]);
    const held = install(discord, `DISCORD_TOKEN="${TOKEN}"\nOPENAI_API_KEY="100"\nANTHROPIC_API_KEY="901"\n`);
    expect((await read(held.module, { server: '100', username: 'ada' })).data).toMatchObject({ server: '<OPENAI_API_KEY>' });
    expect((await read(held.module, { server: '200', username: 'adam' })).data).toMatchObject({ server: '200' });
    expect((await read(held.module)).data).toMatchObject({ application: { id: '<ANTHROPIC_API_KEY>' } });
    const plain = install(discord);
    expect((await read(plain.module)).data).toMatchObject({ application: { id: '901' } });
  });
});
