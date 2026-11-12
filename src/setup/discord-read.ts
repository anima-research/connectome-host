import { DISCORD_API, discordUserAgent, hidden } from './discord-token.js';

export const VIEW_CHANNEL = 1n << 10n;
export const SEND_MESSAGES = 1n << 11n;
export const TEXT_CHANNEL_TYPES = [0, 5];
const ADMINISTRATOR = 1n << 3n;
const EVERY_PERMISSION = (1n << 64n) - 1n;
const GUILD_PAGE = 200;
const REQUEST_LIMIT_MS = 15_000;

export type DiscordFailure =
  | { kind: 'unanswered'; path: string; timedOut: boolean; why: string }
  | { kind: 'redirected'; path: string; status: number }
  | { kind: 'unrecognized'; path: string; status: number; ok: boolean }
  | { kind: 'refused'; path: string }
  | { kind: 'answered'; path: string; status: number; said: string | null; code?: string; retryAfter?: number };

export class DiscordFailed extends Error {
  constructor(readonly failure: DiscordFailure) {
    super(`Discord's answer to GET ${failure.path}: ${failure.kind}`);
    this.name = 'DiscordFailed';
  }
}

export interface DiscordReader {
  limitMs: number;
  get<T>(path: string): Promise<T>;
}

export function discordReader(token: string, options: { fetch: typeof fetch; limitMs?: number }): DiscordReader {
  const limitMs = options.limitMs ?? REQUEST_LIMIT_MS;
  const userAgent = discordUserAgent();
  const get = async <T>(path: string): Promise<T> => {
    const unanswered = (error: unknown): DiscordFailed => {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      const why = error instanceof Error ? error.message : String(error);
      return new DiscordFailed({ kind: 'unanswered', path, timedOut, why: hidden(why, token) });
    };
    let res: Response;
    try {
      res = await options.fetch(DISCORD_API + path, {
        headers: { authorization: `Bot ${token}`, 'user-agent': userAgent },
        signal: AbortSignal.timeout(limitMs),
        redirect: 'manual',
      });
    } catch (error) {
      throw unanswered(error);
    }
    if (res.status >= 300 && res.status < 400) throw new DiscordFailed({ kind: 'redirected', path, status: res.status });
    let text: string;
    try {
      text = await res.text();
    } catch (error) {
      throw unanswered(error);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (body === undefined) throw new DiscordFailed({ kind: 'unrecognized', path, status: res.status, ok: res.ok });
    if (res.status === 401) throw new DiscordFailed({ kind: 'refused', path });
    if (!res.ok) {
      const said = body as { message?: unknown; code?: unknown; retry_after?: unknown } | null;
      const wait = said?.retry_after;
      throw new DiscordFailed({
        kind: 'answered', path, status: res.status,
        said: typeof said?.message === 'string' ? hidden(said.message, token) : null,
        ...(said?.code !== undefined ? { code: hidden(String(said.code), token) } : {}),
        ...(res.status === 429 && typeof wait === 'number' && Number.isFinite(wait) ? { retryAfter: wait } : {}),
      });
    }
    return body as T;
  };
  return { limitMs, get };
}

export interface Overwrite { id: string; type: number; allow: string; deny: string }
export interface Channel {
  id: string;
  name: string;
  type: number;
  position?: number;
  parent_id?: string | null;
  permission_overwrites?: Overwrite[];
}
export interface BotGuild {
  id: string;
  name: string;
  botOwns: boolean;
  roles: Map<string, bigint>;
  botRoles: string[];
  channels: Channel[];
}

export async function botGuilds(reader: DiscordReader, botId: string): Promise<BotGuild[]> {
  const joined: Array<{ id: string; name: string; owner?: boolean }> = [];
  for (;;) {
    const after = joined.length === 0 ? '' : `&after=${joined[joined.length - 1]!.id}`;
    const page = await reader.get<typeof joined>(`/users/@me/guilds?limit=${GUILD_PAGE}${after}`);
    joined.push(...page);
    if (page.length < GUILD_PAGE) break;
  }
  const guilds: BotGuild[] = [];
  for (const { id, name, owner } of joined) guilds.push(await botGuild(reader, botId, { id, name, botOwns: owner === true }));
  return guilds;
}

export async function botGuild(reader: DiscordReader, botId: string, guild: { id: string; name: string; botOwns: boolean }): Promise<BotGuild> {
  const roles = new Map((await reader.get<Array<{ id: string; permissions: string }>>(`/guilds/${guild.id}/roles`))
    .map((r) => [r.id, BigInt(r.permissions)] as const));
  const member = await reader.get<{ roles: string[] }>(`/guilds/${guild.id}/members/${botId}`);
  const channels = await reader.get<Channel[]>(`/guilds/${guild.id}/channels`);
  return { ...guild, roles, botRoles: member.roles, channels };
}

export function channelPermissions(guild: BotGuild, botId: string, channel: Channel): bigint {
  if (guild.botOwns) return EVERY_PERMISSION;
  let base = guild.roles.get(guild.id) ?? 0n;
  for (const role of guild.botRoles) base |= guild.roles.get(role) ?? 0n;
  if ((base & ADMINISTRATOR) !== 0n) return EVERY_PERMISSION;
  const overwrites = channel.permission_overwrites ?? [];
  const apply = (perms: bigint, allow: bigint, deny: bigint): bigint => (perms & ~deny) | allow;
  let perms = base;
  const everyone = overwrites.find((o) => o.type === 0 && o.id === guild.id);
  if (everyone) perms = apply(perms, BigInt(everyone.allow), BigInt(everyone.deny));
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.type === 0 && o.id !== guild.id && guild.botRoles.includes(o.id)) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  }
  perms = apply(perms, allow, deny);
  const own = overwrites.find((o) => o.type === 1 && o.id === botId);
  if (own) perms = apply(perms, BigInt(own.allow), BigInt(own.deny));
  return perms;
}
