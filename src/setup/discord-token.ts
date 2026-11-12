import { HOST_PACKAGE_JSON } from '../bun-floor-check.js';
import { hostVersionOf } from '../update/update.js';
import { JSON_TYPE, redirectTarget } from './provider-key.js';
import { DISCORD_TOKEN, shownByName } from './secrets.js';

export const DISCORD_API = 'https://discord.com/api/v10';
const REQUEST_LIMIT_MS = 15_000;

export type TokenCheck =
  | { kind: 'accepted'; name: string; id: string }
  | { kind: 'refused' }
  | { kind: 'unsendable' }
  | { kind: 'answered'; status: number; said: string | null; retryAfter?: number }
  | { kind: 'redirected'; status: number; to: string | null }
  | { kind: 'unrecognized'; status: number; retryAfter?: number }
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
  if (response.status === 401) return refusedByType(response) ? { kind: 'refused' } : { kind: 'unrecognized', status: 401 };
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
  let body: { id?: unknown; username?: unknown; message?: unknown; retry_after?: unknown } | undefined;
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    body = undefined;
  }
  if (response.ok && typeof body?.id === 'string' && typeof body.username === 'string') {
    return { kind: 'accepted', name: hidden(body.username, token), id: hidden(body.id, token) };
  }
  const wait = retryWait(response, body);
  const after = wait === undefined ? {} : { retryAfter: wait };
  if (body === undefined) return { kind: 'unrecognized', status: response.status, ...after };
  const said = typeof body?.message === 'string' ? hidden(body.message, token) : null;
  return { kind: 'answered', status: response.status, said, ...after };
}

export function refusedByType(response: Response): boolean {
  const type = response.headers.get('content-type');
  return type === null || JSON_TYPE.test(type.trim());
}

export function retryWait(response: Response, body: unknown): number | undefined {
  if (response.status !== 429) return undefined;
  const said = (body as { retry_after?: unknown } | null | undefined)?.retry_after;
  if (typeof said === 'number' && Number.isFinite(said)) return said;
  const header = response.headers.get('retry-after')?.trim() ?? '';
  return /^\d+$/.test(header) ? Number(header) : undefined;
}

// Its ASCII letters in any case, since a server that puts the token in a URL's host gives it back lowercased.
export function hidden(words: string, token: string): string {
  return shownByName(words, [{ name: DISCORD_TOKEN, value: token }]);
}
