import { HOST_PACKAGE_JSON } from '../bun-floor-check.js';
import { hostVersionOf } from '../update/update.js';

export const DISCORD_API = 'https://discord.com/api/v10';
const REQUEST_LIMIT_MS = 15_000;

/** What Discord said of a bot token: whose it is, that it refused it, something else, or nothing at all. */
export type TokenCheck =
  | { kind: 'accepted'; name: string; id: string }
  | { kind: 'refused' }
  | { kind: 'unsendable' }
  | { kind: 'answered'; status: number; said: string | null }
  | { kind: 'unanswered'; why: string };

/** Discord asks API callers for a User-Agent naming their library; one with none can get a 403 unrelated to its
 *  permissions. */
export function discordUserAgent(): string {
  return `DiscordBot (https://github.com/anima-research/connectome-host, ${hostVersionOf(HOST_PACKAGE_JSON)})`;
}

/** Asks Discord whose bot token this is (GET /users/@me), calling `asking` just before it asks; a token a request
 *  header can't carry is never sent. No answer holds the token: where an error's words quote it, they show
 *  <DISCORD_TOKEN> in its place. */
export async function checkDiscordToken(
  token: string,
  options: { fetch?: typeof fetch; limitMs?: number; asking?: () => void } = {},
): Promise<TokenCheck> {
  const authorization = `Bot ${token}`;
  try {
    new Headers({ authorization });
  } catch {
    return { kind: 'unsendable' };
  }
  const userAgent = discordUserAgent();
  options.asking?.();
  const limitMs = options.limitMs ?? REQUEST_LIMIT_MS;
  const unanswered = (error: unknown): TokenCheck => {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    const words = timedOut ? `no answer within ${limitMs / 1000} s`
      : error instanceof Error ? error.message : String(error);
    return { kind: 'unanswered', why: hidden(words, token) };
  };
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${DISCORD_API}/users/@me`, {
      headers: { authorization, 'user-agent': userAgent },
      signal: AbortSignal.timeout(limitMs),
      redirect: 'manual',
    });
  } catch (error) {
    return unanswered(error);
  }
  if (response.status === 401) return { kind: 'refused' };
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return unanswered(error);
  }
  let body: { id?: unknown; username?: unknown; message?: unknown } | undefined;
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = undefined;
  }
  if (response.ok && typeof body?.id === 'string' && typeof body.username === 'string') {
    return { kind: 'accepted', name: hidden(body.username, token), id: hidden(body.id, token) };
  }
  const said = typeof body?.message === 'string' ? hidden(body.message, token) : null;
  return { kind: 'answered', status: response.status, said };
}

function hidden(words: string, token: string): string {
  const forms = [...new Set([token, token.trim()])].filter((form) => form !== '').sort((a, b) => b.length - a.length);
  for (const form of forms) words = words.split(form).join('<DISCORD_TOKEN>');
  return words;
}
