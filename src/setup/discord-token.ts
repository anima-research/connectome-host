import { HOST_PACKAGE_JSON } from '../bun-floor-check.js';
import { hostVersionOf } from '../update/update.js';
import { redirectTarget } from './provider-key.js';

export const DISCORD_API = 'https://discord.com/api/v10';
const REQUEST_LIMIT_MS = 15_000;

export type TokenCheck =
  | { kind: 'accepted'; name: string; id: string }
  | { kind: 'refused' }
  | { kind: 'unsendable' }
  | { kind: 'answered'; status: number; said: string | null }
  | { kind: 'redirected'; status: number; to: string | null }
  | { kind: 'unrecognized'; status: number }
  | { kind: 'unanswered'; why: string };

/** Discord asks API callers for a User-Agent naming their library; one with none can get a 403 unrelated to its
 *  permissions. */
export function discordUserAgent(): string {
  return `DiscordBot (https://github.com/anima-research/connectome-host, ${hostVersionOf(HOST_PACKAGE_JSON)})`;
}

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
  // A refusal in a body that isn't JSON, such as a network's sign-in page, isn't Discord's.
  const type = response.headers.get('content-type');
  if (response.status === 401) {
    return type === null || /^application\/json\b/i.test(type.trim())
      ? { kind: 'refused' } : { kind: 'unrecognized', status: response.status };
  }
  if (response.status >= 300 && response.status < 400) {
    const to = response.headers.get('location');
    return { kind: 'redirected', status: response.status, to: to === null ? null : redirectTarget(hidden(to, token), DISCORD_API) };
  }
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
  if (response.ok && body === undefined) return { kind: 'unrecognized', status: response.status };
  const said = typeof body?.message === 'string' ? hidden(body.message, token) : null;
  return { kind: 'answered', status: response.status, said };
}

// In any letter case, since a server that puts the token in a URL's host gives it back lowercased.
function hidden(words: string, token: string): string {
  const forms = [...new Set([token, token.trim()])].filter((form) => form !== '').sort((a, b) => b.length - a.length);
  for (const form of forms) {
    words = words.replace(new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<DISCORD_TOKEN>');
  }
  return words;
}
