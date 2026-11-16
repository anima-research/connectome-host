import { describe, expect, test } from 'bun:test';
import { checkKey } from '../src/setup/key-check.js';
import { checkProviderKey } from '../src/setup/provider-key.js';
import { checkDiscordToken } from '../src/setup/discord-token.js';

const PROVIDER_WORDS = 'Your credit balance is too low to access the Anthropic API.';

function answering(status: number, headers: Record<string, string> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ error: { message: PROVIDER_WORDS } }), { status, headers });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('the key check', () => {
  test('a 2xx is a key that works, from one call to the model at the base URL, with no redirect followed', async () => {
    const { fetch, calls } = answering(200);
    expect(await checkKey({ key: 'k', model: 'claude-opus-5-5', baseUrl: 'https://gateway.example/', fetch })).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://gateway.example/v1/messages');
    expect(calls[0]!.init.redirect).toBe('manual');
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe('claude-opus-5-5');
  });

  for (const [status, words] of [
    [400, 'api.anthropic.com answered 400: a new account with no credit is the likeliest cause.'],
    [401, 'api.anthropic.com answered 401: the key was refused: check that it was copied whole.'],
    [302, 'api.anthropic.com answered 302: a redirect, which setup doesn\'t follow with a key.'],
    [502, 'api.anthropic.com answered 502: its side had a problem: try again shortly.'],
    [418, 'api.anthropic.com answered 418.'],
  ] as const) {
    test(`a ${status} is said in the house's words, and not the provider's`, async () => {
      expect(await checkKey({ key: 'k', model: 'm', fetch: answering(status).fetch })).toEqual({ ok: false, said: words });
    });
  }

  test('a call that gets no answer names its error\'s code', async () => {
    const fetch = (async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); }) as unknown as typeof globalThis.fetch;
    const checked = await checkKey({ key: 'k', model: 'm', fetch });
    expect(checked).toEqual({ ok: false, said: 'The call to api.anthropic.com didn\'t get an answer (ECONNREFUSED). Check this machine\'s network, and any proxy it goes through.' });
  });
});

describe('the checks as a secret is entered', () => {
  test('accepted, refused, or not known with the status, and no provider words', async () => {
    expect(await checkProviderKey('OPENAI_API_KEY', 'k', new Map(), answering(200).fetch)).toEqual({ kind: 'accepted' });
    expect(await checkProviderKey('OPENAI_API_KEY', 'k', new Map(), answering(401).fetch)).toEqual({ kind: 'refused', why: 'api.openai.com refused it (401)' });
    expect(await checkDiscordToken('t', answering(500).fetch)).toEqual({ kind: 'unknown', why: 'discord.com answered 500' });
  });

  test('ask at the base URL .env names for the provider', async () => {
    const { fetch, calls } = answering(200);
    await checkProviderKey('OPENROUTER_API_KEY', 'k', new Map([['OPENROUTER_BASE_URL', 'https://router.example/api/v1/']]), fetch);
    expect(calls[0]!.url).toBe('https://router.example/api/v1/key');
  });
});
