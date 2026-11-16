export type KeyAnswer = { kind: 'accepted' } | { kind: 'refused' | 'unknown'; why: string };

const REQUEST_LIMIT_MS = 15_000;

/** One GET, with no redirect followed, since a redirect followed would carry the key wherever it points. */
export async function answerOf(url: string, headers: Record<string, string>, fetch = globalThis.fetch,
  forbiddenUnknown = false): Promise<KeyAnswer> {
  try {
    new Headers(headers);
  } catch {
    return { kind: 'refused', why: 'it holds a character a request header can\'t carry, so it can\'t be sent' };
  }
  let response: Response;
  try {
    response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_LIMIT_MS) });
  } catch (error) {
    const { name, code } = error as { name?: string; code?: string };
    return { kind: 'unknown', why: `${new URL(url).host} couldn't be reached (${code ?? name ?? 'no answer'})` };
  }
  await response.body?.cancel();
  if (response.ok) return { kind: 'accepted' };
  if (response.status === 403 && forbiddenUnknown) {
    return { kind: 'unknown', why: `${new URL(url).host} answered 403, as a gateway can for a listing it doesn't serve` };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: 'refused', why: `${new URL(url).host} refused it (${response.status})` };
  }
  return { kind: 'unknown', why: `${new URL(url).host} answered ${response.status}` };
}

interface ProviderKey {
  provider: string;
  baseName: string;
  base: string;
  path: string;
  headers(key: string): Record<string, string>;
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

// Bedrock's keys need AWS's signing, Codex runs on a ChatGPT login, and an openai-compatible endpoint is the recipe's.
export const PROVIDER_KEYS: Readonly<Record<string, ProviderKey>> = {
  ANTHROPIC_API_KEY: {
    provider: 'Anthropic', baseName: 'ANTHROPIC_BASE_URL', base: 'https://api.anthropic.com', path: '/v1/models',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
  },
  OPENAI_API_KEY: { provider: 'OpenAI', baseName: 'OPENAI_BASE_URL', base: 'https://api.openai.com/v1', path: '/models', headers: bearer },
  OPENROUTER_API_KEY: {
    provider: 'OpenRouter', baseName: 'OPENROUTER_BASE_URL', base: 'https://openrouter.ai/api/v1', path: '/key', headers: bearer,
  },
};

/** Asks the provider, at the base URL .env names for it if it names one, whether it accepts the key. */
export function checkProviderKey(name: string, key: string, dotenv: ReadonlyMap<string, string>, fetch?: typeof globalThis.fetch):
  Promise<KeyAnswer> {
  const provider = PROVIDER_KEYS[name]!;
  const given = dotenv.get(provider.baseName);
  const base = (given || provider.base).replace(/\/+$/, '');
  if (!URL.canParse(`${base}${provider.path}`)) {
    return Promise.resolve({ kind: 'unknown', why: `${provider.baseName} in .env, ${JSON.stringify(given)}, isn't a URL` });
  }
  return answerOf(`${base}${provider.path}`, provider.headers(key), fetch, Boolean(given));
}
