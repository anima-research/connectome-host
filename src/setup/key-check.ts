export const ANTHROPIC_API = 'https://api.anthropic.com';

export type KeyCheck = { ok: true } | { ok: false; said: string };

const MEANS: Record<number, string> = {
  400: 'a new account with no credit is the likeliest cause',
  401: 'the key was refused: check that it was copied whole',
  403: 'the key isn\'t allowed to make this call',
  404: 'this key has no such model, or the base URL doesn\'t lead to Anthropic\'s Messages API',
  429: 'the key\'s calls are being limited: try again shortly',
  529: 'the API is overloaded: try again in a few minutes',
};

export async function checkKey(options: { key: string; model: string; baseUrl?: string; fetch?: typeof fetch }):
  Promise<KeyCheck> {
  const base = (options.baseUrl ?? ANTHROPIC_API).replace(/\/+$/, '');
  const url = new URL(`${base}/v1/messages`);
  const headers = { 'x-api-key': options.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  try {
    new Headers(headers);
  } catch {
    return { ok: false, said: 'The key holds a character a request header can\'t carry, so it wasn\'t sent. Check what was copied.' };
  }
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: 'POST', headers, redirect: 'manual', signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ model: options.model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
    });
  } catch (error) {
    const { name, code } = error as { name?: string; code?: string };
    return {
      ok: false,
      said: `The call to ${url.host} didn't get an answer (${code ?? name ?? 'no answer'}). Check this machine's ` +
        'network, and any proxy it goes through.',
    };
  }
  await response.body?.cancel();
  if (response.ok) return { ok: true };
  const status = response.status;
  const means = MEANS[status] ?? (status >= 500 ? 'its side had a problem: try again shortly'
    : status >= 300 && status < 400 ? 'a redirect, which setup doesn\'t follow with a key' : null);
  return { ok: false, said: `${url.host} answered ${status}${means === null ? '.' : `: ${means}.`}` };
}
