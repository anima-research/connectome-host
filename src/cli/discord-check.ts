import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  botGuilds, channelPermissions, DiscordFailed, discordReader, SEND_MESSAGES, TEXT_CHANNEL_TYPES, VIEW_CHANNEL, type Channel,
  type DiscordFailure,
} from '../setup/discord-read.js';
import { checkDiscordToken, sentToken } from '../setup/discord-token.js';
import { dotenvFileBefore } from '../setup/secrets.js';
import { resolveOverlayEntry, type AgentOverlayEntry } from '../mcpl-config.js';
import { ENV_REFERENCE } from '../recipe-document.js';

const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;
const GUILD_CATEGORY = 4;
const TEXT_CHAT_TYPES = [...TEXT_CHANNEL_TYPES, 2, 13];
const REQUEST_LIMIT_MS = 15_000;

export interface DiscordCheck {
  lines: string[];
  problems: string[];
}

export interface TokenRoute {
  id: string;
  defined: 'overlay' | 'file' | 'recipe';
  file: string;
  recipe: string;
  gets: { by: 'given' } | { by: 'mapped'; name: string; fallback: string | null } | { by: 'inherited' } | { by: 'none' };
  beneath: 'file' | 'recipe' | null;
}

export function tokenRoute(id: string, sources: {
  recipe: string;
  servers: string;
  overlay: string;
  recipeServers: Record<string, unknown>;
  fileServers: ReadonlyArray<{ id: string } & Record<string, unknown>>;
  overlayServers: Record<string, AgentOverlayEntry>;
  inheritEnv: boolean;
}): TokenRoute {
  const fields = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const tokenIn = (entry: Record<string, unknown> | null | undefined): unknown => {
    const env = fields(entry?.env);
    return env !== null && Object.hasOwn(env, 'DISCORD_TOKEN') ? env.DISCORD_TOKEN : undefined;
  };
  const named = Object.hasOwn(sources.recipeServers, id) ? fields(sources.recipeServers[id]) : null;
  const fileEntry = sources.fileServers.find((server) => server.id === id);
  const beneath = named === null ? null : fileEntry !== undefined ? 'file' : named.command || named.url ? 'recipe' : null;
  const base = { id, recipe: sources.recipe };
  const overlaid = Object.hasOwn(sources.overlayServers, id) ? sources.overlayServers[id] : undefined;
  if (overlaid !== undefined && resolveOverlayEntry(id, overlaid) !== null) {
    return { ...base, defined: 'overlay', file: sources.overlay, beneath,
      gets: tokenIn(fields(overlaid)) === undefined ? { by: 'none' } : { by: 'given' } };
  }
  const inherits = { by: sources.inheritEnv ? 'inherited' : 'none' } as const;
  if (beneath === 'file') {
    return { ...base, defined: 'file', file: sources.servers, beneath: null,
      gets: tokenIn(fileEntry) === undefined ? inherits : { by: 'given' } };
  }
  const written = tokenIn(named);
  const mapped = typeof written === 'string' ? new RegExp(`^${ENV_REFERENCE}$`).exec(written) : null;
  return { ...base, defined: 'recipe', file: sources.recipe, beneath: null,
    gets: mapped !== null ? { by: 'mapped', name: mapped[1]!, fallback: mapped[2] ?? null }
      : written === undefined ? inherits : { by: 'given' } };
}

interface Guild { id: string; name: string; visible: Channel[]; ids: Set<string>; unsendable: Set<string> }
interface Filters { guildIds: string[]; guildChannels: Record<string, string[]> }

class DiscordAnswer extends Error {}

export const BEFORE_ENV_FILE = 'another of the files Bun reads there, such as .env.local or .env.development, or the ' +
  'service\'s own environment, comes before .env where it sets the name';

const listed = (command: string): string => 'Discord listed that server for the bot a moment before, so if the bot ' +
  `has been removed from it since, invite it again, and otherwise run ${command} doctor again.`;

const waited = (unchecked: string, seconds: number, command: string): string =>
  `${unchecked}: Discord asked for ${Math.ceil(seconds)} s before the next request, so run ${command} doctor again after that`;

export async function checkDiscord(
  env: Record<string, string | undefined>,
  options: {
    fetch: typeof fetch;
    workingDir: string;
    command: string;
    requestLimitMs?: number;
    route: TokenRoute;
    service: Record<string, string | undefined>;
    nodeEnv?: string;
  },
): Promise<DiscordCheck> {
  const { command, route } = options;
  const work = options.workingDir;
  const entry = `${route.defined === 'recipe' ? 'mcpServers' : 'mcplServers'}.${route.id}`;
  const portal = 'the bot token from the Developer Portal\'s Bot page';
  const restore = (name: string): string => {
    const before = dotenvFileBefore(work, options.nodeEnv, name);
    return (before !== null
      ? `${name} is set in ${join(work, before)}, which Bun reads before .env: put ${portal} there`
      : name === 'DISCORD_TOKEN'
        ? `Store ${portal} with \`${command} setup discord\`, which stores it in ${join(work, '.env')}`
        : `Put ${portal} in ${join(work, '.env')} as ${name}`) +
      `, then restart the service and run \`${command} doctor\` again. Where something other than the dotenv files gives ` +
      `the service ${name}, doctor's Service section then names it.`;
  };
  const filled = (name: string): boolean => (options.service[name] ?? '') !== '';
  const emptyStep = (): string => {
    const { gets } = route;
    if (gets.by === 'mapped') return restore(gets.name);
    if (gets.by === 'inherited' || !filled('DISCORD_TOKEN')) return restore('DISCORD_TOKEN');
    if (route.defined === 'overlay') {
      return `The agent overlay ${route.file} defines the server at ${entry}, and the overlay can neither put in a "\${…}" nor ` +
        'hand a server the service\'s environment: take that entry out of the overlay, ' +
        (route.beneath === null
          ? `and add the server to mcpServers in ${route.recipe}, with its command and "DISCORD_TOKEN": "\${DISCORD_TOKEN}" in its ` +
            'env, then restart the service.'
          : `so that ${route.beneath === 'file' ? 'the entry mcpl-servers.json has for it' : 'the recipe\'s entry for it'} defines ` +
            `the server, then run \`${command} doctor\` again.`);
    }
    if (route.defined === 'file') {
      return (gets.by === 'given' ? `mcpl-servers.json gives DISCORD_TOKEN an empty value at ${entry}.env in ${route.file}, which ` +
        'replaces the service\'s: take it out of that env, and' : 'mcpl-servers.json defines the server and takes its env as written:') +
        ` set "inheritEnv": true in mcpServers.${route.id} in ${route.recipe}, which hands the server the service's DISCORD_TOKEN, ` +
        'then restart the service.';
    }
    return `${gets.by === 'given' ? 'Make DISCORD_TOKEN "${DISCORD_TOKEN}" in' : 'Add "DISCORD_TOKEN": "${DISCORD_TOKEN}" to'} the ` +
      `env of ${entry} in ${route.recipe}, then restart the service.`;
  };
  // The one step for a token Discord refuses or a header can't carry, where it comes from.
  const source = ((): string => {
    const { gets } = route;
    if (gets.by === 'mapped') {
      const named = `${entry}.env.DISCORD_TOKEN`;
      return (!filled(gets.name) && gets.fallback !== null
        ? `The token is the default that ${named} gives in ${route.recipe}, since the service's ${gets.name} is empty or unset. `
        : `The token is the service's ${gets.name}${gets.name === 'DISCORD_TOKEN' ? '' : `, which ${named} names in ${route.recipe}`}. `) +
        restore(gets.name);
    }
    if (gets.by === 'given') {
      return `The token is the value written at ${entry}.env.DISCORD_TOKEN in ${route.file}` + (route.defined === 'recipe'
        ? `: make it exactly "\${DISCORD_TOKEN}", so the server gets the service's DISCORD_TOKEN. ${restore('DISCORD_TOKEN')}`
        : `, which takes it as written: replace it with ${portal}, then restart the service.`);
    }
    return `The token is the service's DISCORD_TOKEN, which the server inherits. ${restore('DISCORD_TOKEN')}`;
  })();
  const lines: string[] = [];
  const problems: string[] = [];
  const problem = (text: string): void => {
    problems.push(text);
    lines.push(`✗ ${text}`);
  };

  const given = env.DISCORD_TOKEN ?? '';
  // discord.js's Client.login drops this prefix before it uses the token (14.16.0 on), so the token is checked so.
  const token = sentToken(given);
  if (token.trim() === '') {
    problem('The Discord server\'s env has no DISCORD_TOKEN, or an empty one, so discord-mcpl can\'t log in. ' + emptyStep());
    return { lines, problems };
  }
  if (token !== given) {
    lines.push(`DISCORD_TOKEN begins with "${given.slice(0, given.length - token.length).trim()}", which discord.js drops ` +
      'when discord-mcpl logs in with it, so the token is checked without it.');
  }
  if (token !== token.trimEnd()) {
    lines.push('DISCORD_TOKEN ends with whitespace. Discord\'s REST API, which doctor asks, doesn\'t see it, since it ' +
      'isn\'t part of a header\'s value, but discord.js sends the token as it is when it logs in to the gateway, which ' +
      'doctor can\'t check. Store it without the whitespace where the server\'s value comes from. ' +
      `\`${command} setup discord\` stores it trimmed in ${join(options.workingDir, '.env')}, which is that place unless ` +
      `the server's entry gives DISCORD_TOKEN a value itself, or ${BEFORE_ENV_FILE}.`);
  }
  const limitMs = options.requestLimitMs ?? REQUEST_LIMIT_MS;
  const unchecked = 'so the Discord checks after it weren\'t made';
  const again = `${unchecked}: run ${command} doctor again`;
  const reach = `${unchecked}: check that this machine can resolve and reach discord.com, then run ${command} doctor again`;
  const between = 'Something between this machine and Discord, such as a proxy, may be answering in its place.';
  const refused = `Discord refused the bot token the server is given as DISCORD_TOKEN (401), ${unchecked}. ${source}`;
  const reader = discordReader(token, { fetch: options.fetch, limitMs });
  const wordsFor = (failure: DiscordFailure): string => {
    const { path } = failure;
    switch (failure.kind) {
      case 'unanswered':
        return `Discord ${failure.timedOut ? `didn't answer GET ${path} within ${limitMs / 1000} s` : `couldn't be asked GET ${path}: ${failure.why}`}, ${reach}.`;
      case 'redirected':
        return `Discord answered ${failure.status} to GET ${path}, a redirect, which doctor doesn't follow with ` +
          `the token, ${unchecked}. ${between}`;
      case 'unrecognized':
        return failure.ok
          ? `Discord answered GET ${path} with something other than JSON, ${unchecked}. ${between}`
          : `Discord answered ${failure.status} to GET ${path} with something other than JSON, ` +
            `${failure.retryAfter !== undefined ? waited(unchecked, failure.retryAfter, command)
              : failure.status === 429 || failure.status >= 500 ? again : unchecked}. ${between}`;
      case 'refused':
        return refused;
      case 'answered': {
        const wait = failure.retryAfter === undefined ? undefined : waited(unchecked, failure.retryAfter, command);
        return `Discord answered ${failure.status} to GET ${path}` +
          (failure.said !== null ? `: ${failure.said}${failure.code !== undefined ? ` (code ${failure.code})` : ''}` : ', with no message') +
          `, ${wait ?? (failure.status === 429 || failure.status >= 500 ? again : unchecked)}.` +
          (failure.status === 403 || failure.status === 404
            ? path.startsWith('/guilds/') ? ` ${listed(command)}` : path === '/applications/@me' ? ` ${between}` : ''
            : '');
      }
    }
  };

  try {
    const bot = await whoseToken(token, { fetch: options.fetch, limitMs }, { unchecked, again, reach, between, refused, source, command });
    lines.push(`✓ The token in DISCORD_TOKEN works: the bot is ${bot.name} (${bot.id}).`);

    const app = await reader.get<{ flags?: number }>('/applications/@me');
    if (((app.flags ?? 0) & (GATEWAY_MESSAGE_CONTENT | GATEWAY_MESSAGE_CONTENT_LIMITED)) !== 0) {
      lines.push('✓ The Message Content intent is on.');
    } else {
      problem('The Message Content intent is off, so a server message that doesn\'t mention the bot arrives without ' +
        'its text. Turn it on in the Developer Portal, under Bot, Privileged Gateway Intents.');
    }

    const guilds: Guild[] = (await botGuilds(reader, bot.id)).map((guild) => {
      const visible = guild.channels.filter((c) => (channelPermissions(guild, bot.id, c) & VIEW_CHANNEL) !== 0n);
      return {
        id: guild.id,
        name: guild.name,
        visible,
        ids: new Set(guild.channels.map((c) => c.id)),
        unsendable: new Set(visible.filter((c) => TEXT_CHAT_TYPES.includes(c.type)
          && (channelPermissions(guild, bot.id, c) & SEND_MESSAGES) === 0n).map((c) => c.id)),
      };
    });
    lines.push(guilds.length === 0
      ? 'The bot is in no server, so it hears only DMs until it\'s invited to one.'
      : 'Channels the bot can see:');
    for (const guild of guilds) {
      lines.push(`  ${guild.name} (${guild.id})`);
      for (const channel of guild.visible) {
        lines.push(`    ${channelName(channel)}${guild.unsendable.has(channel.id) ? ', where it can\'t send' : ''}`);
      }
    }

    for (const line of scopeLines(env, options.workingDir, guilds, problem)) lines.push(line);
  } catch (error) {
    problem(error instanceof DiscordAnswer ? error.message
      : error instanceof DiscordFailed ? wordsFor(error.failure)
        : `The Discord check stopped: ${errorText(error)}`);
  }
  return { lines, problems };
}

async function whoseToken(
  token: string,
  options: { fetch: typeof fetch; limitMs: number },
  words: { unchecked: string; again: string; reach: string; between: string; refused: string; source: string; command: string },
): Promise<{ name: string; id: string }> {
  const path = '/users/@me';
  const check = await checkDiscordToken(token, options);
  switch (check.kind) {
    case 'accepted': return check;
    case 'refused': throw new DiscordAnswer(words.refused);
    case 'unsendable':
      throw new DiscordAnswer('The bot token the server is given as DISCORD_TOKEN holds a character a request header ' +
        `can't carry, so it can't be a bot token and wasn't sent. The Discord checks after it weren't made. ${words.source}`);
    case 'unanswered': throw new DiscordAnswer(`Discord couldn't be asked GET ${path}: ${check.why}, ${words.reach}.`);
    case 'redirected':
      throw new DiscordAnswer(`Discord answered ${check.status} to GET ${path}, a redirect, which doctor doesn't follow ` +
        `with the token, ${words.unchecked}. ${words.between}`);
    case 'unrecognized':
    case 'answered':
      if (check.kind === 'unrecognized' && (check.status < 200 || check.status >= 300)) {
        throw new DiscordAnswer(`Discord answered ${check.status} to GET ${path} with something other than JSON, ` +
          `${check.retryAfter !== undefined ? waited(words.unchecked, check.retryAfter, words.command)
            : check.status === 429 || check.status >= 500 ? words.again : words.unchecked}. ${words.between}`);
      }
      if (check.kind === 'unrecognized' || (check.status >= 200 && check.status < 300)) {
        throw new DiscordAnswer(`Discord answered GET ${path} with something other than the bot's user, ${words.unchecked}. ` +
          words.between);
      }
      throw new DiscordAnswer(`Discord answered ${check.status} to GET ${path}` +
        (check.said === null ? ', with no message' : `: ${check.said}${check.code !== undefined ? ` (code ${check.code})` : ''}`) +
        `, ${check.retryAfter !== undefined ? waited(words.unchecked, check.retryAfter, words.command)
          : check.status === 429 || check.status >= 500 ? words.again : words.unchecked}.` +
        (check.status === 403 || check.status === 404 ? ` ${words.between}` : ''));
  }
}

export function secretStep(name: string, envOnly = false): string {
  return 'Doctor can\'t tell which server needs it: give it to that server in the env' + (envOnly ? '' : ' or args') +
    ` of the entry that defines it, as ${envOnly ? `"${name}": ` : ''}"\${${name}}" in the recipe, and as its value in ` +
    'mcpl-servers.json or the agent overlay, which take values as written' +
    (envOnly ? '' : ', or, for a server the host dials, in its token or url') + '. Then restart the service.';
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
    const failed = statError(path);
    if (failed?.code === 'ENOENT') {
      lines.push(`${path} (DISCORD_FILTERS_FILE) isn't there. discord-mcpl writes it from DISCORD_GUILD_ID when it ` +
        'starts, so that is the scope it starts with. If a running discord-mcpl had read it, and it was removed since, ' +
        'the last filters it read stay in force until the file is back.');
      atStart = true;
    } else if (failed?.code === 'ENOTDIR') {
      problem(`${path} (DISCORD_FILTERS_FILE) can't be looked at: ${errorText(failed).replace(/\.$/, '')}. discord-mcpl can't read ` +
        'it or write it there, so it starts with DISCORD_GUILD_ID\'s scope, as below. Repair what that path runs through.');
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
      if (channel && guild.unsendable.has(channel.id)) {
        problem(`The scope names ${channelId}, a channel of ${guild.name} (${guild.id}) the bot can see but can't send ` +
          'in: give the bot Send Messages in it.');
      }
      if (channel) named.push(channelName(channel));
      else if (guild.ids.has(channelId)) {
        problem(`The scope names ${channelId}, a channel of ${guild.name} (${guild.id}) the bot can't see: give the bot ` +
          'View Channel in it.');
      } else {
        unlisted.push(`  ${channelId} isn't among the channels Discord lists to the bot in ${guild.name} (${guild.id}). It ` +
          'may be a thread, since discord-mcpl takes a thread\'s id in a scope and doctor doesn\'t look threads up; a channel ' +
          'the bot lacks View Channel in, which Discord leaves out of that list from November 16, 2026, so give the bot View ' +
          'Channel there; or a wrong id, to correct.');
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

function statError(path: string): NodeJS.ErrnoException | null {
  try {
    statSync(path);
    return null;
  } catch (error) {
    return error as NodeJS.ErrnoException;
  }
}
