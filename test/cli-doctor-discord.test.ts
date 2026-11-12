import { describe, test, expect } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDiscord } from '../src/cli/discord-check.js';
import { DISCORD_API, discordUserAgent } from '../src/setup/discord-token.js';

const TOKEN = 'MTEx.fake-token-value.abc';
const VIEW = 1 << 10;
const SEND = 1 << 11;
const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;

interface FakeGuild {
  id: string;
  name: string;
  owner?: boolean;
  everyone: number;
  roles: Array<{ id: string; permissions: number }>;
  botRoles: string[];
  channels: Array<{ id: string; name: string; type: number; parent_id?: string; overwrites?: Array<{ id: string; type: 0 | 1; allow?: number; deny?: number }> }>;
}

function fakeDiscord(opts: {
  token?: string;
  flags?: number;
  guilds?: FakeGuild[];
  answer?: () => Response;
  answers?: Record<string, () => Response>;
  fails?: 'reject' | 'hang';
}) {
  const requests: Array<{ path: string; origin: string; headers: Headers }> = [];
  const guilds = opts.guilds ?? [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const path = url.pathname.replace(/^\/api\/v10/, '');
    requests.push({ path, origin: url.href.slice(0, url.href.indexOf(path)), headers });
    if (opts.fails === 'reject') throw new TypeError('fetch failed: getaddrinfo ENOTFOUND discord.com');
    if (opts.fails === 'hang') {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    }
    if (opts.answer) return opts.answer();
    if (opts.answers?.[path]) return opts.answers[path]!();
    if (headers.get('authorization') !== `Bot ${opts.token ?? TOKEN}`) {
      return Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 });
    }
    if (path === '/users/@me') return Response.json({ id: '900', username: 'ember', bot: true });
    if (path === '/applications/@me') return Response.json({ id: '901', name: 'Ember', flags: opts.flags ?? 0 });
    if (path === '/users/@me/guilds') {
      const limit = Number(url.searchParams.get('limit') ?? 200);
      const after = url.searchParams.get('after');
      const from = after === null ? 0 : guilds.findIndex((g) => g.id === after) + 1;
      return Response.json(guilds.slice(from, from + Math.min(limit, 200)).map((g) => ({ id: g.id, name: g.name, owner: g.owner ?? false })));
    }
    const m = /^\/guilds\/(\d+)\/(roles|channels|members\/900)$/.exec(path);
    const guild = m ? guilds.find((g) => g.id === m[1]) : undefined;
    if (!m || !guild) return Response.json({ message: 'Unknown Guild', code: 10004 }, { status: 404 });
    if (m[2] === 'roles') {
      return Response.json([{ id: guild.id, name: '@everyone', permissions: String(guild.everyone) },
        ...guild.roles.map((r) => ({ id: r.id, name: `role-${r.id}`, permissions: String(r.permissions) }))]);
    }
    if (m[2] === 'members/900') return Response.json({ user: { id: '900' }, roles: guild.botRoles });
    return Response.json(guild.channels.map((c) => ({
      id: c.id, name: c.name, type: c.type, parent_id: c.parent_id ?? null,
      permission_overwrites: (c.overwrites ?? []).map((o) => ({ id: o.id, type: o.type, allow: String(o.allow ?? 0), deny: String(o.deny ?? 0) })),
    })));
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}

const HOME: FakeGuild = {
  id: '100',
  name: 'Home',
  everyone: VIEW | SEND,
  roles: [{ id: '110', permissions: 0 }],
  botRoles: ['110'],
  channels: [
    { id: '101', name: 'general', type: 0 },
    { id: '102', name: 'secret-room', type: 0, overwrites: [{ id: '100', type: 0, deny: VIEW }] },
    { id: '103', name: 'bots-only', type: 0, overwrites: [{ id: '100', type: 0, deny: VIEW }, { id: '110', type: 0, allow: VIEW }] },
    { id: '104', name: 'Projects', type: 4 },
    { id: '105', name: 'garden', type: 0, parent_id: '104' },
  ],
};
const ELSEWHERE: FakeGuild = {
  id: '200', name: 'Elsewhere', everyone: 0, roles: [{ id: '210', permissions: 8 }], botRoles: ['210'],
  channels: [{ id: '201', name: 'lobby', type: 0, overwrites: [{ id: '200', type: 0, deny: VIEW }] }],
};

function workdir(): string {
  return mkdtempSync(join(tmpdir(), 'chost-doctor-discord-'));
}

async function run(
  env: Record<string, string | undefined>, discord: ReturnType<typeof fakeDiscord>, dir = workdir(), requestLimitMs?: number,
  command = 'connectome',
) {
  const result = await checkDiscord(env, { fetch: discord.fetch, workingDir: dir, command, ...(requestLimitMs ? { requestLimitMs } : {}) });
  return { ...result, text: result.lines.join('\n') };
}

const scopeOf = (r: { lines: string[] }): string => r.lines.slice(r.lines.findIndex((l) => /^The scope/.test(l))).join('\n');

describe('doctor: Discord', () => {
  test('a working token names the bot by name and id, sent with a real User-Agent, and its value is never printed', async () => {
    const discord = fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME] });
    const r = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '100' }, discord);
    expect(r.text).toContain('ember');
    expect(r.text).toContain('900');
    expect(r.text).not.toContain(TOKEN);
    for (const req of discord.requests) {
      expect(req.headers.get('user-agent')).toBe(discordUserAgent());
      expect(req.origin).toBe(DISCORD_API);
    }
    expect(discordUserAgent()).toMatch(/^DiscordBot \(https?:\/\/\S+, \S+\)$/);
    expect(r.problems).toEqual([]);
  });

  test('a token Discord refuses is a problem that names its variable and .env, without its value', async () => {
    const r = await run({ DISCORD_TOKEN: 'wrong-token-value' }, fakeDiscord({ guilds: [HOME] }));
    expect(r.problems.length).toBe(1);
    expect(r.problems[0]).toContain('DISCORD_TOKEN');
    expect(r.problems[0]).toContain('.env');
    expect(r.problems[0]).toMatch(/^Discord refused the bot token the server is given as DISCORD_TOKEN \(401\), so the Discord checks after it weren't made\./);
    expect(r.problems[0]).toMatch(/Where the recipe alone defines the server and maps "\$\{DISCORD_TOKEN\}" in its env, or the server is handed the host's whole environment \("inheritEnv": true, in the recipe or mcpl-servers\.json\) with no DISCORD_TOKEN of its own, the token is the service's DISCORD_TOKEN\. `connectome setup discord` stores it in .*\.env, and another of the files Bun reads there, such as \.env\.local or \.env\.development, or the service's own environment, comes before \.env where it sets the name: a token reset on the Developer Portal's Bot page has to be stored again in whichever gives the service its value\./);
    expect(r.problems[0]).toMatch(/Where the entry that defines the server gives DISCORD_TOKEN a value itself, that value is the one to replace: mcpl-servers\.json and the agent overlay take it as written, a "\$\{DISCORD_TOKEN\}" included, and an overlay entry or mcpl-servers\.json's replaces a recipe entry's env\. Then restart the service\./);
    expect(r.text).not.toContain('wrong-token-value');
  });

  test('a server entry with no DISCORD_TOKEN in its env is a problem that says how to store it, and nothing is asked of Discord', async () => {
    const discord = fakeDiscord({ guilds: [HOME] });
    const dir = workdir();
    const r = await run({ DISCORD_GUILD_ID: '100' }, discord, dir);
    expect(r.problems.length).toBe(1);
    expect(r.problems[0]).toContain('DISCORD_TOKEN');
    expect(r.problems[0]).toMatch(/^The Discord server's env has no DISCORD_TOKEN, or an empty one, so discord-mcpl can't log in\./);
    expect(r.problems[0]).toMatch(/If \.env doesn't hold the bot token yet, store it with `connectome setup discord`, which keeps it in .*\.env\. Name it as "\$\{DISCORD_TOKEN\}" in the recipe entry of the server that needs it: in its env, as "DISCORD_TOKEN": "\$\{DISCORD_TOKEN\}"\. mcpl-servers\.json and the agent overlay take their values as written, .* For a server mcpl-servers\.json starts, a recipe entry can't set its env or args: .*Then restart the service\./);
    expect(r.problems[0]).not.toContain('or in its args');
    expect(discord.requests).toEqual([]);
    const empty = await run({ DISCORD_TOKEN: '', DISCORD_GUILD_ID: '100' }, discord, dir);
    expect(empty.problems).toEqual(r.problems);
    expect(discord.requests).toEqual([]);
  });

  test('another refusal is a problem giving Discord\'s own message, or saying it gave none, and that the checks after it weren\'t made, and no raw body', async () => {
    const json = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ answer: () => Response.json({ message: 'Missing Access', code: 50001 }, { status: 403 }) }));
    expect(json.problems.length).toBe(1);
    expect(json.problems[0]).toStartWith('Discord answered 403 to GET /users/@me: Missing Access, so the Discord checks after it weren\'t made.');
    const later = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ answers: { '/applications/@me': () => Response.json({ message: 'Missing Access', code: 50001 }, { status: 403 }) } }));
    expect(later.problems).toEqual([expect.stringContaining('Discord answered 403 to GET /applications/@me: Missing Access (code 50001)')]);
    expect(json.problems[0]).toMatch(/weren't made/);
    expect(json.problems[0]).not.toMatch(/again|its message says/);
    const silent = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ answer: () => Response.json({ code: 0 }, { status: 403 }) }));
    expect(silent.problems.length).toBe(1);
    expect(silent.problems[0]).toContain('403');
    expect(silent.problems[0]).toContain('with no message');
    expect(silent.problems[0]).not.toMatch(/its message says/);
  });

  test('an error answer that isn\'t JSON isn\'t read as Discord\'s error, whatever its status, and no raw body shows', async () => {
    const between = ' Something between this machine and Discord, such as a proxy, may be answering in its place.';
    const raw = (status: number) => () => new Response(`error code: 1010 ${TOKEN.slice(0, 9)}`, { status, headers: { 'content-type': 'text/html' } });
    for (const status of [401, 403, 404]) {
      const own = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ answer: raw(status) }));
      expect(own.problems).toEqual([`Discord answered ${status} to GET /users/@me with something other than JSON, so the Discord checks after it weren't made.${between}`]);
      expect(own.text).not.toContain('error code');
      const later = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ answers: { '/applications/@me': raw(status) } }));
      expect(later.problems).toEqual([`Discord answered ${status} to GET /applications/@me with something other than JSON, so the Discord checks after it weren't made.${between}`]);
    }
    const server = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME], answers: { '/guilds/100/roles': raw(404) } }));
    expect(server.problems).toEqual([`Discord answered 404 to GET /guilds/100/roles with something other than JSON, so the Discord checks after it weren't made.${between}`]);
    const busy = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ answer: raw(503) }));
    expect(busy.problems).toEqual([`Discord answered 503 to GET /users/@me with something other than JSON, so the Discord checks after it weren't made: run connectome doctor again.${between}`]);
    const refused = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ answer: () => Response.json({ message: '401: Unauthorized', code: 0 }, { status: 401 }) }));
    expect(refused.problems[0]).toStartWith('Discord refused the bot token the server is given as DISCORD_TOKEN (401)');
  });

  test('a 429 that gives no retry_after says to run doctor again after Retry-After\'s seconds, to the token check and to a later read, whether or not its body is JSON', async () => {
    const between = ' Something between this machine and Discord, such as a proxy, may be answering in its place.';
    const wait = 'so the Discord checks after it weren\'t made: Discord asked for 300 s before the next request, so run connectome doctor again after that.';
    const page = () => new Response('<html>slow down</html>', { status: 429, headers: { 'content-type': 'text/html', 'retry-after': '300' } });
    const json = () => Response.json({ message: 'You are being rate limited.' }, { status: 429, headers: { 'retry-after': '300' } });
    for (const path of ['/users/@me', '/applications/@me']) {
      const unread = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ answers: { [path]: page } }));
      expect(unread.problems).toEqual([`Discord answered 429 to GET ${path} with something other than JSON, ${wait}${between}`]);
      const read = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ answers: { [path]: json } }));
      expect(read.problems).toEqual([`Discord answered 429 to GET ${path}: You are being rate limited., ${wait}`]);
    }
  });

  test('a 403 or 404 to the bot\'s own user or application says what may be answering in Discord\'s place, and one to a server\'s read says what that read says', async () => {
    const between = ' Something between this machine and Discord, such as a proxy, may be answering in its place.';
    for (const status of [403, 404]) {
      const own = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ answers: { '/users/@me': () => Response.json({ message: 'Missing Access', code: 50001 }, { status }) } }));
      expect(own.problems).toEqual([`Discord answered ${status} to GET /users/@me: Missing Access, so the Discord checks after it weren't made.${between}`]);
      const app = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ answers: { '/applications/@me': () => Response.json({ message: 'Missing Access', code: 50001 }, { status }) } }));
      expect(app.problems).toEqual([`Discord answered ${status} to GET /applications/@me: Missing Access (code 50001), so the Discord checks after it weren't made.${between}`]);
    }
    const server = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME], answers: { '/guilds/100/roles': () => Response.json({ message: 'Missing Access', code: 50001 }, { status: 403 }) } }));
    expect(server.problems).toEqual([expect.stringContaining('Discord listed that server for the bot a moment before')]);
    expect(server.problems[0]).not.toContain('Something between');
  });

  test('each remedy that tells the person to run a command names it as doctor was given it, for an install whose own connectome isn\'t first on PATH', async () => {
    const typed = '/opt/chost/connectome';
    const bare = /(^|[\s`])connectome (doctor|setup)/;
    const limited = (retry?: number) => () => Response.json({ message: 'You are being rate limited.', ...(retry === undefined ? {} : { retry_after: retry }) }, { status: 429 });
    const cases: Array<[string, Promise<{ lines: string[]; problems: string[] }>, string]> = [
      ['no token', run({}, fakeDiscord({}), workdir(), undefined, typed), `\`${typed} setup discord\`, which keeps it in`],
      ['whitespace after the token', run({ DISCORD_TOKEN: `${TOKEN}  ` }, fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME] }), workdir(), undefined, typed), `\`${typed} setup discord\` stores it trimmed in`],
      ['a refused token', run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ token: 'other' }), workdir(), undefined, typed), `\`${typed} setup discord\` stores it in`],
      ['Discord busy', run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ answer: limited() }), workdir(), undefined, typed), `weren't made: run ${typed} doctor again`],
      ['a wait asked for by the first request', run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ answers: { '/users/@me': limited(2.5) } }), workdir(), undefined, typed), `so run ${typed} doctor again after that`],
      ['a wait asked for by a later request', run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ answers: { '/applications/@me': limited(2.5) } }), workdir(), undefined, typed), `so run ${typed} doctor again after that`],
      ['Discord out of reach', run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ fails: 'reject' }), workdir(), undefined, typed), `then run ${typed} doctor again`],
      ['a server read refused', run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME], answers: { '/guilds/100/roles': () => Response.json({ message: 'Missing Access', code: 50001 }, { status: 403 }) } }), workdir(), undefined, typed), `and otherwise run ${typed} doctor again.`],
    ];
    for (const [name, ran, says] of cases) {
      const text = (await ran).lines.join('\n');
      expect([name, text]).toEqual([name, expect.stringContaining(says)]);
      expect([name, bare.test(text)]).toEqual([name, false]);
    }
  });

  test('an answer that can change by itself, Discord busy or limiting the rate, says to run doctor again', async () => {
    for (const status of [429, 503]) {
      const r = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ answer: () => Response.json({ message: 'try later', code: 0 }, { status }) }));
      expect(r.problems.length).toBe(1);
      expect(r.problems[0]).toMatch(/weren't made: run connectome doctor again/);
    }
  });

  test('Discord that can\'t be reached, or answers what isn\'t JSON, is a problem, and the check still returns', async () => {
    const rejected = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ fails: 'reject' }));
    expect(rejected.problems.length).toBe(1);
    expect(rejected.problems[0]).toContain('ENOTFOUND');
    expect(rejected.problems[0]).toMatch(/weren't made: check that this machine can resolve and reach discord\.com, then run connectome doctor again/);
    const notJson = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ answer: () => new Response('<html>', { status: 200 }) }));
    expect(notJson.problems).toEqual(['Discord answered GET /users/@me with something other than the bot\'s user, so the Discord checks after it weren\'t made. Something between this machine and Discord, such as a proxy, may be answering in its place.']);
    const laterNotJson = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ answers: { '/applications/@me': () => new Response('<html>', { status: 200 }) } }));
    expect(laterNotJson.problems).toEqual([expect.stringMatching(/GET \/applications\/@me with something other than JSON/)]);
  });

  test('an answer whose body breaks off while it\'s read is a failed request, not an answer that isn\'t JSON', async () => {
    const broken = () => new Response(new ReadableStream({ start(c) { c.error(new TypeError('the connection was reset')); } }), { status: 200 });
    const r = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ answer: broken }));
    expect(r.problems.length).toBe(1);
    expect(r.problems[0]).toMatch(/couldn't be asked GET \/users\/@me: the connection was reset/);
    expect(r.problems[0]).not.toMatch(/other than/);
  });

  test('a later request whose body breaks off while it\'s read is a failed request, not an answer that isn\'t JSON, and what doctor found before it is still said', async () => {
    const broken = () => new Response(new ReadableStream({ start(c) { c.error(new TypeError('the connection was reset')); } }), { status: 200 });
    const r = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ guilds: [HOME], answers: { '/applications/@me': broken } }));
    expect(r.lines[0]).toBe('\u2713 The token in DISCORD_TOKEN works: the bot is ember (900).');
    expect(r.problems).toEqual([expect.stringMatching(/^Discord couldn't be asked GET \/applications\/@me: the connection was reset, /)]);
  });

  test('Discord that doesn\'t answer within the limit is a problem when the limit runs out', async () => {
    const r = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ fails: 'hang' }), workdir(), 200);
    expect(r.problems.length).toBe(1);
    expect(r.problems[0]).toMatch(/^Discord couldn't be asked GET \/users\/@me: no answer within 0\.2 s, /);
    expect(r.problems[0]).toMatch(/weren't made: check that this machine can resolve and reach discord\.com, then run connectome doctor again/);
  });

  test('a 200 that isn\'t the bot\'s user stops the checks, rather than naming a bot it can\'t name', async () => {
    const discord = fakeDiscord({ answers: { '/users/@me': () => Response.json({ message: 'ok' }) }, guilds: [HOME] });
    const r = await run({ DISCORD_TOKEN: TOKEN }, discord);
    expect(r.problems).toEqual(['Discord answered GET /users/@me with something other than the bot\'s user, so the Discord checks after it weren\'t made. Something between this machine and Discord, such as a proxy, may be answering in its place.']);
    expect(r.text).not.toContain('undefined');
    expect(discord.requests.map((each) => each.path)).toEqual(['/users/@me']);
  });

  test('an answer doctor can\'t read the way it reads Discord\'s stops the check, and what it found before is still said', async () => {
    for (const list of [null, {}]) {
      const r = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ guilds: [HOME], answers: { '/users/@me/guilds': () => Response.json(list) } }));
      expect(r.lines[0]).toBe('\u2713 The token in DISCORD_TOKEN works: the bot is ember (900).');
      expect(r.problems).toHaveLength(2);
      expect(r.problems[0]).toStartWith('The Message Content intent is off');
      expect(r.problems[1]).toStartWith('The Discord check stopped: ');
    }
  });

  test('a redirect, to the first request or a later one, is reported, not followed with the token', async () => {
    const moved = () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/' } });
    for (const path of ['/users/@me', '/applications/@me', '/guilds/100/roles']) {
      const asked: Array<RequestRedirect | undefined> = [];
      const discord = fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME], answers: { [path]: moved } });
      const r = await run({ DISCORD_TOKEN: TOKEN }, { ...discord, fetch: (async (input: string, init: RequestInit) => { asked.push(init.redirect); return discord.fetch(input, init); }) as typeof fetch });
      expect([path, asked]).toEqual([path, discord.requests.map(() => 'manual')]);
      expect(discord.requests.at(-1)!.path).toBe(path);
      expect(r.problems).toEqual([`Discord answered 307 to GET ${path}, a redirect, which doctor doesn't follow with the token, so the Discord checks after it weren't made. Something between this machine and Discord, such as a proxy, may be answering in its place.`]);
    }
  });

  test('a redirect to a later request whose body stays open is reported as a redirect at once, not as a request with no answer', async () => {
    const discord = fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME] });
    const held = (async (input: string, init: RequestInit) => {
      if (!String(input).endsWith('/applications/@me')) return discord.fetch(input, init);
      const body = new ReadableStream({ start(c) { init.signal?.addEventListener('abort', () => c.error(init.signal!.reason)); } });
      return new Response(body, { status: 302, headers: { location: 'https://elsewhere.example/' } });
    }) as typeof fetch;
    const r = await run({ DISCORD_TOKEN: TOKEN }, { ...discord, fetch: held }, workdir(), 2_000);
    expect(r.problems).toEqual(['Discord answered 302 to GET /applications/@me, a redirect, which doctor doesn\'t follow with the token, so the Discord checks after it weren\'t made. Something between this machine and Discord, such as a proxy, may be answering in its place.']);
  });

  test('a token a request header can\'t carry is named as such and never sent, with where the service\'s token comes from', async () => {
    const discord = fakeDiscord({ guilds: [HOME] });
    const r = await run({ DISCORD_TOKEN: 'MTEx.part\u2028part' }, discord);
    expect(discord.requests).toEqual([]);
    expect(r.problems.length).toBe(1);
    expect(r.problems[0]).toStartWith('The bot token the server is given as DISCORD_TOKEN holds a character a request header can\'t carry, so it can\'t be a bot token and wasn\'t sent. The Discord checks after it weren\'t made.');
    expect(r.problems[0]).toContain('a token reset on the Developer Portal\'s Bot page has to be stored again in whichever gives the service its value.');
    expect(r.problems[0]).not.toMatch(/again: run|run connectome doctor again/);
  });

  test('a token given with the Bot or Bearer prefix discord.js drops at login is checked without it, as the connection uses it, and says so', async () => {
    for (const prefix of ['Bot ', 'bearer  ', 'Bot']) {
      const discord = fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME] });
      const r = await run({ DISCORD_TOKEN: `${prefix}${TOKEN}`, DISCORD_GUILD_ID: '100' }, discord);
      expect(r.problems, prefix).toEqual([]);
      expect(discord.requests.map((each) => each.path)).toEqual(['/users/@me', '/applications/@me', '/users/@me/guilds',
        '/guilds/100/roles', '/guilds/100/members/900', '/guilds/100/channels']);
      for (const req of discord.requests) expect(req.headers.get('authorization')).toBe(`Bot ${TOKEN}`);
      expect(r.lines[0]).toBe(`DISCORD_TOKEN begins with "${prefix.trim()}", which discord.js drops when discord-mcpl logs in with it, so the token is checked without it.`);
      expect(r.text).not.toContain(TOKEN);
    }
  });

  test('a token with whitespace around it, as a quoted .env value keeps it, keeps its leading whitespace in the header and is never trimmed by doctor, though the header drops what trails it', async () => {
    const discord = fakeDiscord({ token: ` ${TOKEN}`, flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME] });
    const r = await run({ DISCORD_TOKEN: ` ${TOKEN} \t` }, discord);
    expect(discord.requests[0]!.headers.get('authorization')).toBe(`Bot  ${TOKEN}`);
    expect(r.problems).toEqual([]);
    expect(r.text).not.toContain(TOKEN);
  });

  test('a token whose .env value keeps whitespace after it, as a quoted one does, gets a line saying the gateway login sends it and how to store it; one Bun has trimmed, unquoted, gets none', async () => {
    const bunReads = (line: string): string => {
      const dir = workdir();
      writeFileSync(join(dir, '.env'), `${line}\n`);
      const ran = Bun.spawnSync([process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env.DISCORD_TOKEN))'], { cwd: dir, env: { PATH: process.env.PATH ?? '' } });
      return JSON.parse(ran.stdout.toString()) as string;
    };
    const dir = workdir();
    const line = 'DISCORD_TOKEN ends with whitespace. Discord\'s REST API, which doctor asks, doesn\'t see it, since it isn\'t part of a header\'s value, but discord.js sends the token as it is when it logs in to the gateway, which doctor can\'t check. Store it without the whitespace where the server\'s value comes from. `connectome setup discord` stores it trimmed in ' +
      `${join(dir, '.env')}, which is that place unless the server's entry gives DISCORD_TOKEN a value itself, or another of the files Bun reads there, ` +
      'such as .env.local or .env.development, or the service\'s own environment, comes before .env where it sets the name.';
    const quoted = await run({ DISCORD_TOKEN: bunReads(`DISCORD_TOKEN="${TOKEN}  "`) }, fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME] }), dir);
    expect(quoted.lines[0]).toBe(line);
    expect(quoted.problems).toEqual([]);
    const unquoted = await run({ DISCORD_TOKEN: bunReads(`DISCORD_TOKEN=${TOKEN}  `) }, fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME] }), dir);
    expect(unquoted.lines).not.toContain(line);
    expect(unquoted.problems).toEqual([]);
  });

  test('a value that is nothing once discord.js\'s prefix and whitespace go is the missing token, and nothing is sent', async () => {
    const discord = fakeDiscord({ guilds: [HOME] });
    const dir = workdir();
    const missing = await run({}, discord, dir);
    for (const value of ['   ', 'Bot', 'Bearer  ', 'bot \t']) {
      const r = await run({ DISCORD_TOKEN: value }, discord, dir);
      expect(r.problems, JSON.stringify(value)).toEqual(missing.problems);
    }
    expect(discord.requests).toEqual([]);
  });

  test('a bot in more servers than one page of Discord\'s list holds sees the scoped server on a later page', async () => {
    const many: FakeGuild[] = Array.from({ length: 201 }, (_, i) => ({
      id: String(1000 + i), name: `server-${i}`, everyone: VIEW | SEND, roles: [], botRoles: [], channels: [{ id: String(5000 + i), name: 'general', type: 0 }],
    }));
    const r = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '1200' }, fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: many }));
    expect(r.problems).toEqual([]);
    expect(scopeOf(r)).toContain('server-200 (1200): all its channels');
  });

  test('the Message Content intent is on with either flag, and a problem with neither', async () => {
    for (const flags of [GATEWAY_MESSAGE_CONTENT, GATEWAY_MESSAGE_CONTENT_LIMITED]) {
      const r = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '100' }, fakeDiscord({ flags, guilds: [HOME] }));
      expect(r.problems).toEqual([]);
      expect(r.text).toContain('Message Content');
    }
    const off = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '100' }, fakeDiscord({ flags: 0, guilds: [HOME] }));
    expect(off.problems.length).toBe(1);
    expect(off.problems[0]).toContain('Message Content');
  });

  test('the channels listed are the ones the bot can view, by name and id', async () => {
    const r = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '100,200' }, fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME, ELSEWHERE] }));
    expect(r.text).toContain('general');
    expect(r.text).toContain('101');
    expect(r.text).toContain('bots-only');
    expect(r.text).toContain('garden');
    expect(r.text).not.toContain('secret-room');
    expect(r.text).toContain('lobby'); // an administrator sees every channel
  });

  test('a server the bot owns shows every channel, since its owner holds every permission', async () => {
    const owned: FakeGuild = {
      id: '300', name: 'Its own', owner: true, everyone: 0, roles: [], botRoles: [],
      channels: [{ id: '301', name: 'hall', type: 0 }, { id: '302', name: 'closed', type: 0, overwrites: [{ id: '300', type: 0, deny: VIEW }] }],
    };
    const r = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [owned] }));
    expect(r.lines).toContain('  Its own (300)');
    expect(r.lines).toContain('    #hall (301)');
    expect(r.lines).toContain('    #closed (302)');
    expect(r.problems).toEqual([]);
  });

  test('the scope reads back by name, and a server the bot isn\'t in, or a channel Discord lists that the bot can\'t see, is a problem', async () => {
    const discord = fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME, ELSEWHERE] });
    const ok = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '100:101+104,200' }, discord);
    expect(ok.problems).toEqual([]);
    const scope = ok.lines.slice(ok.lines.findIndex((l) => /scope/i.test(l)));
    expect(scope.join('\n')).toContain('Home');
    expect(scope.join('\n')).toContain('general');
    expect(scope.join('\n')).toContain('Projects');
    expect(scope.join('\n')).toContain('Elsewhere');

    const comma = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '100:101,105' }, discord);
    expect(comma.problems.length).toBe(1);
    expect(comma.problems[0]).toContain('105');
    expect(comma.problems[0]).toMatch(/invite the bot/);
    expect(comma.problems[0]).toMatch(/In DISCORD_GUILD_ID a server's id is followed by : and its channels joined with \+, as 100:101\+104, and a comma starts another server\./);
    const hidden = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '100:102' }, discord);
    expect(hidden.problems.length).toBe(1);
    expect(hidden.problems[0]).toContain('102');
    expect(hidden.problems[0]).toMatch(/give the bot View Channel/);
    expect(hidden.problems[0]).not.toMatch(/thread/);
  });

  test('a scope id that isn\'t among a server\'s channels may be a thread, which doctor doesn\'t look up: a line, not a problem', async () => {
    const r = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '100:101+150' }, fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME] }));
    expect(r.problems).toEqual([]);
    expect(scopeOf(r)).toContain('Home (100): #general (101)');
    expect(scopeOf(r)).toContain('150 isn\'t among the channels Discord lists to the bot in Home (100). It may be a thread, since discord-mcpl takes a thread\'s id in a scope and doctor doesn\'t look threads up; a channel the bot lacks View Channel in, which Discord leaves out of that list from November 16, 2026, so give the bot View Channel there; or a wrong id, to correct.');
  });

  test('a channel the scope names that Discord leaves out of the list, as it does from November 16, 2026 for one the bot can\'t view, is named with View Channel as a cause', async () => {
    const omitting: FakeGuild = { ...HOME, channels: HOME.channels.filter((c) => c.id !== '102') };
    const r = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '100:101+102' }, fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [omitting] }));
    expect(r.problems).toEqual([]);
    expect(scopeOf(r)).toContain('Home (100): #general (101)');
    expect(scopeOf(r)).toMatch(/102 isn't among the channels Discord lists to the bot in Home \(100\)\. .*give the bot View Channel there/);
  });

  test('with no scope set, it says every server the bot is in is admitted, which isn\'t a problem', async () => {
    const r = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME] }));
    expect(r.problems).toEqual([]);
    expect(r.text).toMatch(/No scope is set \(DISCORD_GUILD_ID\): every server the bot is in is admitted\./);
  });

  test.skipIf(process.getuid?.() === 0)('a filters file under a directory this user can\'t search isn\'t said to be missing', async () => {
    const discord = fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME] });
    const dir = workdir();
    mkdirSync(join(dir, 'locked'));
    writeFileSync(join(dir, 'locked', 'filters.json'), JSON.stringify({ guildIds: ['100'] }));
    chmodSync(join(dir, 'locked'), 0o000);
    try {
      const r = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '100', DISCORD_FILTERS_FILE: 'locked/filters.json' }, discord, dir);
      expect(r.text).not.toContain('isn\'t there');
      expect(r.problems).toEqual([`${join(dir, 'locked', 'filters.json')} (DISCORD_FILTERS_FILE) isn't a filters file discord-mcpl can read. ` +
        'If it was unreadable when discord-mcpl started, DISCORD_GUILD_ID applies, as below; if it broke since, the filters read ' +
        'before stay in force until it\'s fixed.']);
    } finally {
      chmodSync(join(dir, 'locked'), 0o755);
    }
  });

  test('a filters file that parses replaces the variables; one that doesn\'t is a problem, and discord-mcpl starts with the variables', async () => {
    const discord = fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME, ELSEWHERE] });
    const dir = workdir();
    writeFileSync(join(dir, 'filters.json'), JSON.stringify({ guildIds: ['200'] }));
    const fromFile = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '999', DISCORD_FILTERS_FILE: 'filters.json' }, discord, dir);
    expect(fromFile.problems).toEqual([]);
    expect(fromFile.text).toContain('filters.json');
    expect(scopeOf(fromFile)).toContain('Elsewhere (200): all its channels');
    expect(scopeOf(fromFile)).not.toContain('Home');
    writeFileSync(join(dir, 'filters.json'), '{ not json');
    const broken = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '100', DISCORD_FILTERS_FILE: 'filters.json' }, discord, dir);
    expect(broken.problems.length).toBe(1);
    expect(broken.problems[0]).toContain('filters.json');
    expect(scopeOf(broken)).toMatch(/^The scope discord-mcpl starts with, from DISCORD_GUILD_ID/);
    expect(scopeOf(broken)).toContain('Home (100): all its channels');
    writeFileSync(join(dir, 'filters.json'), JSON.stringify({ guildIds: ['200'], suppressedReactionEmojis: 'not a list' }));
    const refused = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '100', DISCORD_FILTERS_FILE: 'filters.json' }, discord, dir);
    expect(refused.problems.length).toBe(1);
    expect(scopeOf(refused)).toContain('Home (100): all its channels');
    expect(scopeOf(refused)).not.toContain('Elsewhere');
    for (const written of [JSON.stringify(['200']), JSON.stringify({ guildIds: ['200'], suppressedReactionEmojis: [1] })]) {
      writeFileSync(join(dir, 'filters.json'), written);
      const r = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '100', DISCORD_FILTERS_FILE: 'filters.json' }, discord, dir);
      expect(r.problems.length).toBe(1);
      expect(scopeOf(r)).toContain('Home (100): all its channels');
      expect(scopeOf(r)).not.toContain('Elsewhere');
    }
  });

  test('a filters file that isn\'t there is named, with the scope discord-mcpl writes it from when it starts', async () => {
    const dir = workdir();
    const r = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '100', DISCORD_FILTERS_FILE: 'filters.json' },
      fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME] }), dir);
    expect(r.problems).toEqual([]);
    expect(r.text).toContain(`${join(dir, 'filters.json')} (DISCORD_FILTERS_FILE) isn't there`);
    expect(scopeOf(r)).toMatch(/^The scope discord-mcpl starts with, from DISCORD_GUILD_ID/);
    expect(scopeOf(r)).toContain('Home (100): all its channels');

    const unscoped = await run({ DISCORD_TOKEN: TOKEN, DISCORD_FILTERS_FILE: 'filters.json' },
      fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME] }), dir);
    expect(unscoped.problems).toEqual([]);
    expect(unscoped.text).toContain('discord-mcpl starts with no scope (DISCORD_GUILD_ID): every server the bot is in is admitted.');
  });

  test('a filters file\'s server with an empty channel list is all its channels, and channels of a server it doesn\'t list are left out, as discord-mcpl reads it', async () => {
    const dir = workdir();
    writeFileSync(join(dir, 'filters.json'), JSON.stringify({ guildIds: ['100'], guildChannels: { '100': [], '200': ['201'] } }));
    const r = await run({ DISCORD_TOKEN: TOKEN, DISCORD_FILTERS_FILE: 'filters.json' },
      fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME, ELSEWHERE] }), dir);
    expect(r.problems).toEqual([]);
    expect(scopeOf(r)).toContain('Home (100): all its channels');
    expect(scopeOf(r)).not.toContain('Elsewhere');
    expect(scopeOf(r)).not.toMatch(/the bot is in no server/);
  });

  test('a channel the scope names that the bot can see but can\'t send in is a problem, a whole server in the scope isn\'t, and the list marks every text or announcement channel it can\'t send in', async () => {
    const quiet: FakeGuild = {
      ...HOME,
      channels: [...HOME.channels,
        { id: '106', name: 'announcements', type: 5, overwrites: [{ id: '100', type: 0, deny: SEND }] },
        { id: '107', name: 'read-only', type: 0, overwrites: [{ id: '110', type: 0, deny: SEND }] }],
    };
    const discord = fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [quiet] });
    const r = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '100:101+106' }, discord);
    expect(r.problems).toEqual(['The scope names 106, a channel of Home (100) the bot can see but can\'t send in: give the bot Send Messages in it.']);
    expect(r.lines).toContain('    #announcements (106), where it can\'t send');
    expect(r.lines).toContain('    #read-only (107), where it can\'t send');
    expect(r.lines).toContain('    #general (101)');
    expect(scopeOf(r)).toContain('Home (100): #general (101), #announcements (106)');
    const wide = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '100' }, discord);
    expect(wide.problems).toEqual([]);
  });

  test('a voice or stage channel the bot can see but can\'t send in is marked, and a problem where the scope names it, since discord-mcpl delivers from its text chat', async () => {
    const voiced: FakeGuild = {
      ...HOME,
      channels: [...HOME.channels,
        { id: '108', name: 'lounge', type: 2, overwrites: [{ id: '100', type: 0, deny: SEND }] },
        { id: '109', name: 'town-hall', type: 13, overwrites: [{ id: '100', type: 0, deny: SEND }] },
        { id: '121', name: 'open-voice', type: 2 }],
    };
    const r = await run({ DISCORD_TOKEN: TOKEN, DISCORD_GUILD_ID: '100:101+108+109+121' }, fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [voiced] }));
    expect(r.problems).toEqual([
      'The scope names 108, a channel of Home (100) the bot can see but can\'t send in: give the bot Send Messages in it.',
      'The scope names 109, a channel of Home (100) the bot can see but can\'t send in: give the bot Send Messages in it.',
    ]);
    expect(r.lines).toContain('    #lounge (108), where it can\'t send');
    expect(r.lines).toContain('    #town-hall (109), where it can\'t send');
    expect(r.lines).toContain('    #open-voice (121)');
  });

  test('the bot\'s own overwrite in a channel wins over its roles\' overwrites there, whichever way each goes', async () => {
    const own: FakeGuild = {
      ...HOME,
      channels: [...HOME.channels,
        { id: '122', name: 'muted', type: 0, overwrites: [{ id: '110', type: 0, allow: SEND }, { id: '900', type: 1, deny: SEND }] },
        { id: '123', name: 'let-in', type: 0, overwrites: [{ id: '110', type: 0, deny: SEND }, { id: '900', type: 1, allow: SEND }] }],
    };
    const r = await run({ DISCORD_TOKEN: TOKEN }, fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [own] }));
    expect(r.lines).toContain('    #muted (122), where it can\'t send');
    expect(r.lines).toContain('    #let-in (123)');
  });

  test('a server a filters file names that the bot isn\'t in says to invite it, without DISCORD_GUILD_ID\'s separators', async () => {
    const dir = workdir();
    writeFileSync(join(dir, 'filters.json'), JSON.stringify({ guildIds: ['300'] }));
    const r = await run({ DISCORD_TOKEN: TOKEN, DISCORD_FILTERS_FILE: 'filters.json' },
      fakeDiscord({ flags: GATEWAY_MESSAGE_CONTENT, guilds: [HOME] }), dir);
    expect(r.problems.length).toBe(1);
    expect(r.problems[0]).toMatch(/invite the bot/);
    expect(r.problems[0]).not.toContain('+');
  });
});
