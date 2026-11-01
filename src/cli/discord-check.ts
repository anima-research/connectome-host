import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkDiscordToken, DISCORD_API, discordUserAgent } from '../setup/discord-token.js';

const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;
const GUILD_CATEGORY = 4;
const GUILD_PAGE = 200;
const REQUEST_LIMIT_MS = 15_000;

export interface DiscordCheck {
  lines: string[];
  problems: string[];
}

interface Overwrite { id: string; type: number; allow: string; deny: string }
interface Channel { id: string; name: string; type: number; parent_id?: string | null; permission_overwrites?: Overwrite[] }
interface Guild { id: string; name: string; visible: Channel[]; ids: Set<string> }
interface Filters { guildIds: string[]; guildChannels: Record<string, string[]> }

class DiscordAnswer extends Error {}

export async function checkDiscord(
  env: Record<string, string | undefined>,
  options: { fetch: typeof fetch; workingDir: string; requestLimitMs?: number },
): Promise<DiscordCheck> {
  const lines: string[] = [];
  const problems: string[] = [];
  const problem = (text: string): void => {
    problems.push(text);
    lines.push(`✗ ${text}`);
  };

  const given = env.DISCORD_TOKEN ?? '';
  // discord.js's Client.login drops this prefix before it uses the token (14.16.0 on), so the token is checked so.
  const token = given.replace(/^(Bot|Bearer)\s*/i, '');
  if (token.trim() === '') {
    problem('The Discord server\'s env has no DISCORD_TOKEN, or an empty one, so discord-mcpl can\'t log in. If .env doesn\'t hold the ' +
      `bot token yet, store it with \`connectome setup discord\`, which keeps it in ${join(options.workingDir, '.env')}. ` +
      mappingRemedy('DISCORD_TOKEN', true));
    return { lines, problems };
  }
  if (token !== given) {
    lines.push(`DISCORD_TOKEN begins with "${given.slice(0, given.length - token.length).trim()}", which discord.js drops ` +
      'when discord-mcpl logs in with it, so the token is checked without it.');
  }
  if (token !== token.trimEnd()) {
    lines.push('DISCORD_TOKEN ends with whitespace. Discord\'s REST API, which doctor asks, doesn\'t see it, since it ' +
      'isn\'t part of a header\'s value, but discord.js sends the token as it is when it logs in to the gateway, which ' +
      'doctor can\'t check. Store it without the whitespace: `connectome setup discord` stores it trimmed.');
  }
  const userAgent = discordUserAgent();
  const limitMs = options.requestLimitMs ?? REQUEST_LIMIT_MS;
  const unchecked = 'so the Discord checks after it weren\'t made';
  const again = `${unchecked}: run connectome doctor again`;
  const source = 'Where the recipe alone defines the server and maps "${DISCORD_TOKEN}" in its env, or the server is handed ' +
    'the host\'s whole environment ("inheritEnv": true, in the recipe or mcpl-servers.json) with no DISCORD_TOKEN ' +
    'of its own, the token is the service\'s DISCORD_TOKEN. `connectome setup discord` stores it in ' +
    `${join(options.workingDir, '.env')}, and another of the files Bun reads there, such as .env.local or ` +
    '.env.development, or the service\'s own environment, comes before .env where it sets the name: a token reset on ' +
    'the Developer Portal\'s Bot page has to be stored again in whichever gives the service its value. Where the ' +
    'entry that defines the server gives DISCORD_TOKEN a value itself, that value is the one to replace: ' +
    'mcpl-servers.json and the agent overlay take it as written, a "${DISCORD_TOKEN}" included, and an overlay ' +
    'entry or mcpl-servers.json\'s replaces a recipe entry\'s env. Then restart the service.';
  const refused = `Discord refused the bot token the server is given as DISCORD_TOKEN (401), ${unchecked}. ${source}`;
  const get = async <T>(path: string): Promise<T> => {
    let res: Response;
    let text: string;
    try {
      res = await options.fetch(DISCORD_API + path, {
        headers: { authorization: `Bot ${token}`, 'user-agent': userAgent },
        signal: AbortSignal.timeout(limitMs),
      });
      text = await res.text();
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new DiscordAnswer(`Discord ${timedOut ? `didn't answer GET ${path} within ${limitMs / 1000} s` : `couldn't be asked GET ${path}: ${errorText(error)}`}, ${again}.`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (res.status === 401) throw new DiscordAnswer(refused);
    const said = body as { message?: unknown; code?: unknown } | undefined;
    if (!res.ok) {
      throw new DiscordAnswer(`Discord answered ${res.status} to GET ${path}` +
        (typeof said?.message === 'string' ? `: ${said.message}${said.code !== undefined ? ` (code ${String(said.code)})` : ''}` : ', with no message') +
        `, ${res.status === 429 || res.status >= 500 ? again : unchecked}.`);
    }
    if (body === undefined) throw new DiscordAnswer(`Discord answered GET ${path} with something other than JSON, ${unchecked}.`);
    return body as T;
  };

  try {
    const bot = await whoseToken(token, { fetch: options.fetch, limitMs }, { unchecked, again, refused, source });
    lines.push(`✓ The token in DISCORD_TOKEN works: the bot is ${bot.name} (${bot.id}).`);

    const app = await get<{ flags?: number }>('/applications/@me');
    if (((app.flags ?? 0) & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED)) !== 0) {
      lines.push('✓ The Message Content intent is on.');
    } else {
      problem('The Message Content intent is off, so a server message that doesn\'t mention the bot arrives without ' +
        'its text. Turn it on in the Developer Portal, under Bot, Privileged Gateway Intents.');
    }

    const joined: Array<{ id: string; name: string }> = [];
    for (;;) {
      const after = joined.length === 0 ? '' : `&after=${joined[joined.length - 1]!.id}`;
      const page = await get<typeof joined>(`/users/@me/guilds?limit=${GUILD_PAGE}${after}`);
      joined.push(...page);
      if (page.length < GUILD_PAGE) break;
    }
    const guilds: Guild[] = [];
    for (const { id, name } of joined) {
      const roles = new Map((await get<Array<{ id: string; permissions: string }>>(`/guilds/${id}/roles`))
        .map((r) => [r.id, BigInt(r.permissions)] as const));
      const member = await get<{ roles: string[] }>(`/guilds/${id}/members/${bot.id}`);
      const channels = await get<Channel[]>(`/guilds/${id}/channels`);
      guilds.push({
        id, name, visible: channels.filter((c) => canView(id, bot.id, roles, member.roles, c)), ids: new Set(channels.map((c) => c.id)),
      });
    }
    lines.push(guilds.length === 0
      ? 'The bot is in no server, so it hears only DMs until it\'s invited to one.'
      : 'Channels the bot can see:');
    for (const guild of guilds) {
      lines.push(`  ${guild.name} (${guild.id})`);
      for (const channel of guild.visible) lines.push(`    ${channelName(channel)}`);
    }

    for (const line of scopeLines(env, options.workingDir, guilds, problem)) lines.push(line);
  } catch (error) {
    if (!(error instanceof DiscordAnswer)) throw error;
    problem(error.message);
  }
  return { lines, problems };
}

async function whoseToken(
  token: string,
  options: { fetch: typeof fetch; limitMs: number },
  words: { unchecked: string; again: string; refused: string; source: string },
): Promise<{ name: string; id: string }> {
  const path = '/users/@me';
  const check = await checkDiscordToken(token, options);
  switch (check.kind) {
    case 'accepted': return check;
    case 'refused': throw new DiscordAnswer(words.refused);
    case 'unsendable':
      throw new DiscordAnswer('The bot token the server is given as DISCORD_TOKEN holds a character a request header ' +
        `can't carry, so it can't be a bot token and wasn't sent. The Discord checks after it weren't made. ${words.source}`);
    case 'unanswered': throw new DiscordAnswer(`Discord couldn't be asked GET ${path}: ${check.why}, ${words.again}.`);
    case 'answered':
      if (check.status >= 300 && check.status < 400) {
        throw new DiscordAnswer(`Discord answered ${check.status} to GET ${path}, a redirect, which doctor doesn't follow ` +
          `with the token, ${words.unchecked}.`);
      }
      if (check.status >= 200 && check.status < 300) {
        throw new DiscordAnswer(`Discord answered GET ${path} with something other than the bot's user, ${words.unchecked}.`);
      }
      throw new DiscordAnswer(`Discord answered ${check.status} to GET ${path}` +
        (check.said === null ? ', with no message' : `: ${check.said}`) +
        `, ${check.status === 429 || check.status >= 500 ? words.again : words.unchecked}.`);
  }
}

export function mappingRemedy(name: string, envOnly = false): string {
  return `Name it as "\${${name}}" in the recipe entry of the server that needs it: in its env, as "${name}": ` +
    `"\${${name}}"${envOnly ? '' : ', or in its args, or, for a server the host dials, in its token or url'}. ` +
    'mcpl-servers.json and the agent overlay take their values as written, with no ${…} substituted. For a server ' +
    'mcpl-servers.json starts, a recipe entry can\'t set its env or args: move the server\'s definition out of ' +
    'mcpl-servers.json into the recipe, or set "inheritEnv": true in its recipe entry, which hands it the host\'s ' +
    `whole environment, with ${name} left out of the file's env, whose value would replace the host's. An agent ` +
    'overlay entry replaces the recipe\'s and the file\'s, so the recipe can\'t reach a server the overlay defines ' +
    'while that entry is there: take the entry out of the overlay, put the server\'s definition, with its command or ' +
    'url, in the recipe, or in mcpl-servers.json with a recipe entry that names it, and follow the steps above for ' +
    'whichever then defines it. Then restart the service.';
}

function canView(guildId: string, botId: string, roles: Map<string, bigint>, botRoles: string[], channel: Channel): boolean {
  let base = roles.get(guildId) ?? 0n;
  for (const role of botRoles) base |= roles.get(role) ?? 0n;
  if ((base & ADMINISTRATOR) !== 0n) return true;
  const overwrites = channel.permission_overwrites ?? [];
  const apply = (perms: bigint, allow: bigint, deny: bigint): bigint => (perms & ~deny) | allow;
  let perms = base;
  const everyone = overwrites.find((o) => o.type === 0 && o.id === guildId);
  if (everyone) perms = apply(perms, BigInt(everyone.allow), BigInt(everyone.deny));
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.type === 0 && o.id !== guildId && botRoles.includes(o.id)) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  }
  perms = apply(perms, allow, deny);
  const own = overwrites.find((o) => o.type === 1 && o.id === botId);
  if (own) perms = apply(perms, BigInt(own.allow), BigInt(own.deny));
  return (perms & VIEW_CHANNEL) !== 0n;
}

function channelName(channel: Channel): string {
  return channel.type === GUILD_CATEGORY ? `${channel.name} (${channel.id}), a category` : `#${channel.name} (${channel.id})`;
}

function scopeLines(
  env: Record<string, string | undefined>,
  workingDir: string,
  guilds: Guild[],
  problem: (text: string) => void,
): string[] {
  const lines: string[] = [];
  let filters = filtersFromEnv(env.DISCORD_GUILD_ID);
  let from = 'DISCORD_GUILD_ID';
  let atStart = false;
  if (env.DISCORD_FILTERS_FILE) {
    const path = resolve(workingDir, env.DISCORD_FILTERS_FILE);
    if (!existsSync(path)) {
      lines.push(`${path} (DISCORD_FILTERS_FILE) isn't there. discord-mcpl writes it from DISCORD_GUILD_ID when it ` +
        'starts, so that is the scope it starts with.');
      atStart = true;
    } else {
      const read = filtersFromFile(path);
      if (read) {
        filters = read;
        from = `${path} (DISCORD_FILTERS_FILE), which replaces DISCORD_GUILD_ID`;
      } else {
        problem(`${path} (DISCORD_FILTERS_FILE) isn't a filters file discord-mcpl can read. If it was unreadable when ` +
          'discord-mcpl started, DISCORD_GUILD_ID applies, as below; if it broke since, the filters read before stay in ' +
          'force until it\'s fixed.');
        atStart = true;
      }
    }
  }

  if (filters.guildIds.length === 0) {
    lines.push(`${atStart ? 'discord-mcpl starts with no scope' : 'No scope is set'} (${from}): every server the bot ` +
      'is in is admitted.');
    return lines;
  }
  lines.push(`${atStart ? 'The scope discord-mcpl starts with' : 'The scope'}, from ${from}:`);
  for (const guildId of filters.guildIds) {
    const guild = guilds.find((g) => g.id === guildId);
    if (!guild) {
      problem(`The scope names ${guildId} as a server, and the bot is in no server with that id: invite the bot to ` +
        'it, or correct the id.' + (from === 'DISCORD_GUILD_ID' ? ' In DISCORD_GUILD_ID a server\'s id is followed by : and ' +
        'its channels joined with +, as 100:101+104, and a comma starts another server.' : ''));
      continue;
    }
    const wanted = filters.guildChannels[guildId];
    if (!wanted) {
      lines.push(`  ${guild.name} (${guild.id}): all its channels`);
      continue;
    }
    const named: string[] = [];
    const unlisted: string[] = [];
    for (const channelId of wanted) {
      const channel = guild.visible.find((c) => c.id === channelId);
      if (channel) named.push(channelName(channel));
      else if (guild.ids.has(channelId)) {
        problem(`The scope names ${channelId}, a channel of ${guild.name} (${guild.id}) the bot can't see: give the bot ` +
          'View Channel in it.');
      } else {
        unlisted.push(`  ${channelId} isn't a channel of ${guild.name} (${guild.id}). discord-mcpl takes a thread's id ` +
          'in a scope, and doctor doesn\'t look threads up, so if it isn\'t a thread there, correct the id.');
      }
    }
    if (named.length > 0) lines.push(`  ${guild.name} (${guild.id}): ${named.join(', ')}`);
    lines.push(...unlisted);
  }
  return lines;
}

function filtersFromEnv(value: string | undefined): Filters {
  const filters: Filters = { guildIds: [], guildChannels: {} };
  for (const entry of (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [guildId, channels] = entry.split(':', 2) as [string, string | undefined];
    filters.guildIds.push(guildId);
    if (channels) filters.guildChannels[guildId] = channels.split('+').map((s) => s.trim()).filter(Boolean);
  }
  return normalized(filters);
}

/** discord-mcpl 0.5.0's normalizeFilters (src/filters.ts): an empty channel list is every channel, and channels of
 *  a server the scope doesn't list are dropped. */
function normalized(filters: Filters): Filters {
  const guildIds = [...new Set(filters.guildIds)];
  const guildChannels: Record<string, string[]> = {};
  for (const [guildId, channels] of Object.entries(filters.guildChannels)) {
    if (channels.length > 0 && guildIds.includes(guildId)) guildChannels[guildId] = [...new Set(channels)];
  }
  return { guildIds, guildChannels };
}

function filtersFromFile(path: string): Filters | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if ('suppressedReactionEmojis' in r) {
    const v = r.suppressedReactionEmojis;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return null;
  }
  const guildIds = Array.isArray(r.guildIds) ? r.guildIds.map(String).filter(Boolean) : [];
  const guildChannels: Record<string, string[]> = {};
  if (r.guildChannels && typeof r.guildChannels === 'object' && !Array.isArray(r.guildChannels)) {
    for (const [guildId, channels] of Object.entries(r.guildChannels as Record<string, unknown>)) {
      if (Array.isArray(channels)) guildChannels[guildId] = channels.map(String).filter(Boolean);
    }
  }
  return normalized({ guildIds, guildChannels });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
