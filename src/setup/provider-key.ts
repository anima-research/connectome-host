export type KeyAnswer = { kind: 'accepted' } | { kind: 'refused' | 'unknown'; why: string };

const REQUEST_LIMIT_MS = 15_000;

export async function answerOf(url: string, headers: Record<string, string>, fetch = globalThis.fetch,
  gateway?: string): Promise<KeyAnswer> {
  const host = gateway ?? new URL(url).host;
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
    return { kind: 'unknown', why: `${host} couldn't be reached (${code ?? name ?? 'no answer'})` };
  }
  await response.body?.cancel();
  if (response.ok) return { kind: 'accepted' };
  if (response.status === 403 && gateway !== undefined) {
    return { kind: 'unknown', why: `${host} answered 403, as a gateway can for a listing it doesn't serve` };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: 'refused', why: `${host} refused it (${response.status})` };
  }
  return { kind: 'unknown', why: `${host} answered ${response.status}` };
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

export function checkProviderKey(name: string, key: string, dotenv: ReadonlyMap<string, string>, fetch?: typeof globalThis.fetch):
  Promise<KeyAnswer> {
  const provider = PROVIDER_KEYS[name]!;
  const given = dotenv.get(provider.baseName);
  const base = (given || provider.base).replace(/\/+$/, '');
  if (!URL.canParse(`${base}${provider.path}`)) {
    return Promise.resolve({ kind: 'unknown', why: `${provider.baseName} in .env isn't a URL` });
  }
  return answerOf(`${base}${provider.path}`, provider.headers(key), fetch,
    given ? `the host of ${provider.baseName} in .env` : undefined);
}
