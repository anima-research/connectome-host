const REQUEST_LIMIT_MS = 15_000;

export type ProviderAnswer<T> =
  | { kind: 'accepted'; value: T }
  | { kind: 'refused'; status: number }
  | { kind: 'unsendable' }
  | { kind: 'answered'; status: number; said: string | null; retryAfter?: { shown: string | null; seconds: boolean } }
  | { kind: 'redirected'; status: number; to: string | null }
  | { kind: 'unrecognized'; status: number }
  | { kind: 'unanswered'; why: string };

interface Request {
  url: string;
  headers: Record<string, string>;
}

interface ProviderKey {
  provider: string;
  check(key: string, env: ReadonlyMap<string, string>): Request;
  accepts(body: unknown): boolean;
  models(key: string, env: ReadonlyMap<string, string>): Request;
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const dataOf = (body: unknown): unknown =>
  (body !== null && typeof body === 'object' ? (body as { data?: unknown }).data : undefined);
const idsOf = (body: unknown): string[] | undefined => {
  const data = dataOf(body);
  if (!Array.isArray(data)) return undefined;
  const ids = data.map((model) => (model as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === 'string');
  return ids.length === data.length ? ids : undefined;
};
const listed = (body: unknown): boolean => idsOf(body) !== undefined;
// A base URL and a path joined as @anthropic-ai/sdk 0.52.0's buildURL joins them, as the key check does: a base
// ending in / takes the path without its first /.
const under = (base: string, path: string) => base + (base.endsWith('/') ? path.slice(1) : path);

export const JSON_TYPE = /^application\/([\w.+-]+\+)?json\s*(;|$)/i;

// A relative Location is resolved against the origin of the URL asked, not the whole URL as RFC 9110 (10.2.2) has
// it, so a credential in the URL's user part stays out of the target.
export function redirectTarget(location: string, asked: string): string {
  try {
    return new URL(location, new URL(asked).origin).href;
  } catch {
    return location;
  }
}

function openaiModels(key: string, env: ReadonlyMap<string, string>): Request {
  return { url: under(env.get('OPENAI_BASE_URL') || 'https://api.openai.com/v1', '/models'), headers: bearer(key) };
}

const openrouter = (path: string) => (key: string, env: ReadonlyMap<string, string>): Request =>
  ({ url: under(env.get('OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1', path), headers: bearer(key) });

// Anthropic's List Models takes `limit` from 1 to 1000 (https://docs.anthropic.com/en/api/models-list).
function anthropicModels(key: string, env: ReadonlyMap<string, string>): Request {
  return {
    url: under(env.get('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com', '/v1/models?limit=1000'),
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  };
}

// Not Bedrock's keys, since a request with them needs AWS's signing, nor Codex's, a ChatGPT login rather than a key.
export const PROVIDER_KEYS: Readonly<Record<string, ProviderKey>> = {
  OPENAI_API_KEY: { provider: 'OpenAI', check: openaiModels, accepts: listed, models: openaiModels },
  ANTHROPIC_API_KEY: { provider: 'Anthropic', check: anthropicModels, accepts: listed, models: anthropicModels },
  OPENROUTER_API_KEY: {
    provider: 'OpenRouter',
    check: openrouter('/key'),
    accepts: (body) => {
      const data = dataOf(body);
      return data !== null && typeof data === 'object' && !Array.isArray(data);
    },
    models: openrouter('/models'),
  },
};

interface Options {
  fetch?: typeof fetch;
  limitMs?: number;
  env?: ReadonlyMap<string, string>;
  hide?: readonly { name: string; value: string }[];
}

export function checkProviderKey(name: string, key: string, options: Options = {}): Promise<ProviderAnswer<null>> | null {
  const provider = PROVIDER_KEYS[name];
  if (provider === undefined) return null;
  return ask(provider.check(key, options.env ?? new Map()), name, key, options,
    (body) => (provider.accepts(body) ? null : undefined));
}

export function listModels(
  name: string, key: string, options: Options = {},
): Promise<ProviderAnswer<{ ids: string[]; shownIds: string[]; more: boolean }>> | null {
  const provider = PROVIDER_KEYS[name];
  if (provider === undefined) return null;
  return ask(provider.models(key, options.env ?? new Map()), name, key, options, (body) => {
    const ids = idsOf(body);
    if (ids === undefined) return undefined;
    return { ids, shownIds: ids.map((id) => hidden(id, key, name, options.hide)), more: (body as { has_more?: unknown }).has_more === true };
  });
}

async function ask<T>(
  request: Request, name: string, key: string, options: Options, read: (body: unknown) => T | undefined,
): Promise<ProviderAnswer<T>> {
  try {
    new Headers(request.headers);
  } catch {
    return { kind: 'unsendable' };
  }
  const limitMs = options.limitMs ?? REQUEST_LIMIT_MS;
  const unanswered = (error: unknown): ProviderAnswer<T> => {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    const words = timedOut ? `no answer within ${limitMs / 1000} s`
      : error instanceof Error ? error.message : String(error);
    return { kind: 'unanswered', why: hidden(words, key, name, options.hide) };
  };
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(request.url, {
      headers: request.headers, signal: AbortSignal.timeout(limitMs), redirect: 'manual',
    });
  } catch (error) {
    return unanswered(error);
  }
  const type = response.headers.get('content-type');
  const typedJson = type === null || JSON_TYPE.test(type.trim());
  if (response.status === 401 || response.status === 403) {
    return typedJson ? { kind: 'refused', status: response.status } : { kind: 'unrecognized', status: response.status };
  }
  if (response.status === 404 && !typedJson) return { kind: 'unrecognized', status: response.status };
  if (response.status >= 300 && response.status < 400) {
    const to = response.headers.get('location');
    return {
      kind: 'redirected', status: response.status,
      to: to === null ? null : redirectTarget(hidden(to, key, name, options.hide), request.url),
    };
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return unanswered(error);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const value = response.ok ? read(body) : undefined;
  if (value !== undefined) return { kind: 'accepted', value };
  if (response.ok && body === undefined) return { kind: 'unrecognized', status: response.status };
  const error = (body as { error?: unknown } | undefined)?.error;
  const message = typeof error === 'string' ? error
    : typeof (error as { message?: unknown } | undefined)?.message === 'string' ? (error as { message: string }).message
    : null;
  // Retry-After is a number of seconds or an HTTP date (RFC 9110, 10.2.3); anything that isn't digits or a date
  // JavaScript reads is no wait asked for.
  const after = response.headers.get('retry-after')?.trim() ?? '';
  const seconds = /^\d+$/.test(after);
  return {
    kind: 'answered', status: response.status, said: message === null ? null : hidden(message, key, name, options.hide),
    ...(seconds || !Number.isNaN(Date.parse(after))
      ? { retryAfter: { shown: hidden(after, key, name, options.hide) === after ? after : null, seconds } } : {}),
  };
}

// The key under test in any letter case, since a server that puts it in a URL's host gives it back lowercased.
function hidden(words: string, key: string, name: string, also: Options['hide'] = []): string {
  const forms = [...[key, key.trim()].map((value) => ({ name, value, anyCase: true })),
    ...also.flatMap((form) => [form.value, form.value.trim()].map((value) => ({ name: form.name, value, anyCase: false })))]
    .filter(({ value }) => value !== '').sort((a, b) => b.value.length - a.value.length);
  for (const form of forms) {
    words = words.replace(new RegExp(form.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), form.anyCase ? 'gi' : 'g'),
      `<${form.name}>`);
  }
  return words;
}

export function familyOf(model: string): string {
  const at = model.search(/[-.]/);
  return at === -1 ? model : model.slice(0, at);
}
