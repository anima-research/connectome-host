import { DISCORD_API, discordHeaders } from './discord-token.js';

const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const ADMINISTRATOR = 1n << 3n;
const TEXT_CHANNEL_TYPES = [0, 5];
// Discord's most for one page of a bot's servers (https://discord.com/developers/docs/resources/user#get-current-user-guilds).
const GUILD_PAGE = 200;
const REQUEST_LIMIT_MS = 15_000;

/** Where a read stopped: the path, and Discord's status and numeric code, or why there was no answer. */
export interface DiscordFailure {
  path: string;
  status: number | null;
  code?: number;
  retryAfter?: number;
  unreadable?: true;
  why?: string;
}

export class DiscordFailed extends Error {
  constructor(readonly failure: DiscordFailure) {
    super(`Discord's answer to GET ${failure.path}`);
    this.name = 'DiscordFailed';
  }
}

/** GETs from Discord's API with a bot token, following no redirect; `last` is the path asked last. */
export class DiscordReader {
  last = '';

  constructor(private readonly token: string, private readonly fetchFn: typeof globalThis.fetch = globalThis.fetch) {}

  async get<T>(path: string): Promise<T> {
    this.last = path;
    let response: Response;
    let text: string;
    try {
      const fetch = this.fetchFn;
      response = await fetch(DISCORD_API + path, {
        headers: discordHeaders(this.token), redirect: 'manual', signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
      text = await response.text();
    } catch (error) {
      const { name, code } = error as { name?: string; code?: string };
      throw new DiscordFailed({ path, status: null, why: code ?? name ?? 'no answer' });
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (response.ok && body !== undefined) return body as T;
    const said = body as { code?: unknown; retry_after?: unknown } | null | undefined;
    const header = Number(response.headers.get('retry-after'));
    const retryAfter = typeof said?.retry_after === 'number' ? said.retry_after : header > 0 ? header : undefined;
    throw new DiscordFailed({
      path, status: response.status,
      ...(typeof said?.code === 'number' ? { code: said.code } : {}),
      ...(retryAfter === undefined ? {} : { retryAfter }),
      ...(body === undefined ? { unreadable: true } : {}),
    });
  }
}

interface DiscordMember { user: { id: string; username: string; global_name?: string | null }; nick?: string | null }
interface Overwrite { id: string; type: number; allow: string; deny: string }
interface Channel {
  id: string; name: string; type: number; position?: number; parent_id?: string | null; permission_overwrites?: Overwrite[];
}

export function memberOf(member: DiscordMember) {
  return { id: member.user.id, username: member.user.username, displayName: member.user.global_name ?? null, nickname: member.nick ?? null };
}

export async function botServers(reader: DiscordReader): Promise<string[]> {
  const ids: string[] = [];
  for (;;) {
    const after = ids.length === 0 ? '' : `&after=${ids[ids.length - 1]}`;
    const page = await reader.get<Array<{ id: string }>>(`/users/@me/guilds?limit=${GUILD_PAGE}${after}`);
    ids.push(...page.map((guild) => guild.id));
    if (page.length < GUILD_PAGE) return ids;
  }
}

/** A server with its owner and its text and announcement channels, in Discord's order, each with whether the bot can send there. */
export async function serverOf(reader: DiscordReader, id: string, botId: string) {
  const guild = await reader.get<{ name: string; owner_id: string }>(`/guilds/${id}`);
  const roles = new Map((await reader.get<Array<{ id: string; permissions: string }>>(`/guilds/${id}/roles`))
    .map((role) => [role.id, BigInt(role.permissions)] as const));
  const botRoles = (await reader.get<{ roles: string[] }>(`/guilds/${id}/members/${botId}`)).roles;
  const all = await reader.get<Channel[]>(`/guilds/${id}/channels`);
  const owner = await reader.get<DiscordMember>(`/guilds/${id}/members/${guild.owner_id}`);
  let base = roles.get(id) ?? 0n;
  for (const role of botRoles) base |= roles.get(role) ?? 0n;
  const every = guild.owner_id === botId || (base & ADMINISTRATOR) !== 0n;
  const byId = new Map(all.map((channel) => [channel.id, channel] as const));
  const channels = all.filter((channel) => TEXT_CHANNEL_TYPES.includes(channel.type))
    .map((channel) => {
      const category = channel.parent_id ? byId.get(channel.parent_id) : undefined;
      const perms = every ? VIEW_CHANNEL | SEND_MESSAGES : permissionsIn(channel, base, id, botRoles, botId);
      return {
        at: [category?.position ?? -1, channel.position ?? 0],
        channel: { id: channel.id, name: channel.name, category: category?.name ?? null,
          send: (perms & VIEW_CHANNEL) !== 0n && (perms & SEND_MESSAGES) !== 0n },
      };
    })
    .sort((a, b) => a.at[0]! - b.at[0]! || a.at[1]! - b.at[1]!)
    .map((each) => each.channel);
  return { id, name: guild.name, owner: memberOf(owner), channels };
}

/** Discord's order for a channel's overwrites: @everyone's, then the bot's roles' together, then the bot's own. */
function permissionsIn(channel: Channel, base: bigint, everyone: string, botRoles: string[], botId: string): bigint {
  const overwrites = channel.permission_overwrites ?? [];
  const apply = (perms: bigint, allow: bigint, deny: bigint) => (perms & ~deny) | allow;
  let perms = base;
  const all = overwrites.find((o) => o.type === 0 && o.id === everyone);
  if (all) perms = apply(perms, BigInt(all.allow), BigInt(all.deny));
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites.filter((o) => o.type === 0 && o.id !== everyone && botRoles.includes(o.id))) {
    allow |= BigInt(o.allow);
    deny |= BigInt(o.deny);
  }
  perms = apply(perms, allow, deny);
  const own = overwrites.find((o) => o.type === 1 && o.id === botId);
  return own ? apply(perms, BigInt(own.allow), BigInt(own.deny)) : perms;
}
