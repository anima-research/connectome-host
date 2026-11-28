import { describe, expect, test } from 'bun:test';
import { buildContextMakeup } from '../src/web/panel-data.js';
import { type CountEnv, withCountEnv } from './count-env.js';

type Sent = { url: string; headers: Record<string, string> };

function appOn(provider: string | undefined, model: string, bearer?: string) {
  return {
    recipe: { agent: { name: 'agent', ...(provider ? { provider } : {}) } },
    ...(bearer !== undefined ? { credentials: { bearer: () => bearer } } : {}),
    framework: {
      getAgent: () => ({ model, getContextManager: () => ({ getRenderStats: () => null }) }),
      previewActivation: async () => ({ messages: [{ participant: 'Lari', content: [{ type: 'text', text: 'hi' }] }] }),
    },
  };
}

async function makeupWith(app: ReturnType<typeof appOn>, env: CountEnv, answer: () => Response = () => Response.json({ input_tokens: 7 })) {
  const sent: Sent[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { headers?: HeadersInit }) => {
    sent.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (!URL.canParse(String(url))) throw new TypeError('Invalid URL');
    return answer();
  }) as unknown as typeof fetch;
  try {
    return { makeup: await withCountEnv(env, () => buildContextMakeup(app as never, 'agent')), sent };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const COUNT_URL = 'https://api.anthropic.com/v1/messages/count_tokens';

describe('a host with no Anthropic credential and no gateway', () => {
  for (const [provider, model, countModel] of [
    ['bedrock', 'anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5-20250929'],
    ['openrouter', 'anthropic/claude-sonnet-4.5', 'claude-sonnet-4.5'],
    ['openai-compatible', 'claude-haiku-4-5', 'claude-haiku-4-5'],
    ['mock', 'claude-haiku-4-5', 'claude-haiku-4-5'],
  ] as const) {
    test(`on ${provider}, sends no count request and says it has no credential`, async () => {
      const { makeup, sent } = await makeupWith(appOn(provider, model), {});
      expect(sent).toEqual([]);
      expect(makeup.exactTotalTokens).toBeNull();
      expect(makeup.countModel).toBe(countModel);
      expect(makeup.countSource).toBe('count_tokens_no_credential');
      expect('countHost' in makeup).toBe(false);
    });
  }

  for (const [label, env] of [
    ['an empty ANTHROPIC_API_KEY', { ANTHROPIC_API_KEY: '' }],
    ['an ANTHROPIC_API_KEY of spaces', { ANTHROPIC_API_KEY: '   ' }],
    ['an ANTHROPIC_AUTH_TOKEN of spaces', { ANTHROPIC_AUTH_TOKEN: ' \t ' }],
    ['ANTHROPIC_BASE_URL at Anthropic\'s own address', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }],
    ['ANTHROPIC_BASE_URL at Anthropic\'s own address with a slash at its end', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' }],
    ['ANTHROPIC_BASE_URL at Anthropic\'s address in capitals', { ANTHROPIC_BASE_URL: 'https://API.ANTHROPIC.COM' }],
    ['ANTHROPIC_BASE_URL at Anthropic\'s address with its port', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com:443' }],
    ['ANTHROPIC_BASE_URL at Anthropic\'s address with a path', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1' }],
    ['ANTHROPIC_BASE_URL at Anthropic\'s address as an absolute DNS name', { ANTHROPIC_BASE_URL: 'https://api.anthropic.com.' }],
  ] as const) {
    test(`with ${label} and nothing else, sends no count request`, async () => {
      const { makeup, sent } = await makeupWith(appOn('bedrock', 'anthropic.claude-sonnet-4-5-20250929-v1:0'), env);
      expect(sent).toEqual([]);
      expect(makeup.countSource).toBe('count_tokens_no_credential');
    });
  }

  test('with a subscription login whose token is spaces, and nothing else, sends no count request', async () => {
    const { makeup, sent } = await makeupWith(appOn(undefined, 'claude-haiku-4-5', '  '), {});
    expect(sent).toEqual([]);
    expect(makeup.countSource).toBe('count_tokens_no_credential');
  });
});

describe('a host that holds a credential or a gateway asks for the count', () => {
  test('with ANTHROPIC_API_KEY on bedrock: one request to Anthropic with the key, and the answer names the address', async () => {
    const { makeup, sent } = await makeupWith(appOn('bedrock', 'anthropic.claude-sonnet-4-5-20250929-v1:0'), { ANTHROPIC_API_KEY: 'key-test' });
    expect(sent.map((s) => s.url)).toEqual([COUNT_URL]);
    expect(sent[0]!.headers['x-api-key']).toBe('key-test');
    expect(sent[0]!.headers.authorization).toBeUndefined();
    expect(makeup.exactTotalTokens).toBe(7);
    expect(makeup.countSource).toBe('count_tokens');
    expect(makeup.countHost).toBe('api.anthropic.com');
  });

  test('with ANTHROPIC_AUTH_TOKEN alone on bedrock: one request with the bearer header', async () => {
    const { makeup, sent } = await makeupWith(appOn('bedrock', 'anthropic.claude-sonnet-4-5-20250929-v1:0'), { ANTHROPIC_AUTH_TOKEN: 'token-test' });
    expect(sent.map((s) => s.url)).toEqual([COUNT_URL]);
    expect(sent[0]!.headers.authorization).toBe('Bearer token-test');
    expect(sent[0]!.headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(sent[0]!.headers['x-api-key']).toBeUndefined();
    expect(makeup.countHost).toBe('api.anthropic.com');
  });

  test("with a gateway at ANTHROPIC_BASE_URL and no credential: one request to the gateway with an empty key, and the answer names the gateway's host and port alone", async () => {
    const { makeup, sent } = await makeupWith(
      appOn('bedrock', 'anthropic.claude-sonnet-4-5-20250929-v1:0'),
      { ANTHROPIC_BASE_URL: 'https://user:secret@gateway.example:8443/anthropic/' },
    );
    expect(sent.map((s) => s.url)).toEqual(['https://user:secret@gateway.example:8443/anthropic/v1/messages/count_tokens']);
    expect(sent[0]!.headers['x-api-key']).toBe('');
    expect(sent[0]!.headers.authorization).toBeUndefined();
    expect(makeup.countHost).toBe('gateway.example:8443');
    expect(JSON.stringify(makeup)).not.toContain('secret');
    expect(JSON.stringify(makeup)).not.toContain('/anthropic');
  });

  for (const [label, env] of [
    ['a key', { ANTHROPIC_BASE_URL: '  ', ANTHROPIC_API_KEY: 'key-test' }],
    ['no credential', { ANTHROPIC_BASE_URL: '  ' }],
  ] as const) {
    test(`with an ANTHROPIC_BASE_URL of spaces and ${label}: the request fails on the machine, as inference's does, and names no host`, async () => {
      const { makeup, sent } = await makeupWith(appOn('bedrock', 'anthropic.claude-sonnet-4-5-20250929-v1:0'), env);
      expect(sent).toHaveLength(1);
      expect(URL.canParse(sent[0]!.url)).toBe(false);
      expect(makeup.countSource).toBe('count_tokens_error');
      expect('countHost' in makeup).toBe(false);
    });
  }

  test('with an ANTHROPIC_BASE_URL that is not a URL: the request fails as fetch fails, and the answer says so and names no host', async () => {
    const { makeup, sent } = await makeupWith(appOn(undefined, 'claude-haiku-4-5'), { ANTHROPIC_BASE_URL: 'not a url', ANTHROPIC_API_KEY: 'key-test' });
    expect(sent).toHaveLength(1);
    expect(makeup.countSource).toBe('count_tokens_error');
    expect('countHost' in makeup).toBe(false);
  });

  test('with an ANTHROPIC_BASE_URL that ends in several slashes: the request goes to the canonical path', async () => {
    const { sent } = await makeupWith(appOn(undefined, 'claude-haiku-4-5'), { ANTHROPIC_BASE_URL: 'https://gateway.example///', ANTHROPIC_API_KEY: 'key-test' });
    expect(sent.map((s) => s.url)).toEqual(['https://gateway.example/v1/messages/count_tokens']);
  });

  test('with an ANTHROPIC_BASE_URL of a bare scheme: the answer names the host that the request goes to', async () => {
    const { makeup, sent } = await makeupWith(appOn(undefined, 'claude-haiku-4-5'), { ANTHROPIC_BASE_URL: 'https://', ANTHROPIC_API_KEY: 'key-test' });
    expect(sent.map((s) => new URL(s.url).host)).toEqual(['v1']);
    expect(makeup.countHost).toBe('v1');
  });

  test('a count whose request throws still names where it asked', async () => {
    const { makeup, sent } = await makeupWith(appOn(undefined, 'claude-haiku-4-5'), { ANTHROPIC_API_KEY: 'key-test' }, () => {
      throw new TypeError('fetch failed');
    });
    expect(sent).toHaveLength(1);
    expect(makeup.countSource).toBe('count_tokens_error');
    expect(makeup.countHost).toBe('api.anthropic.com');
  });

  for (const [label, bearer, env] of [
    ['an ANTHROPIC_AUTH_TOKEN of spaces', undefined, { ANTHROPIC_AUTH_TOKEN: '  ', ANTHROPIC_API_KEY: 'key-test' }],
  ] as const) {
    test(`with ${label} and a real ANTHROPIC_API_KEY: the request carries the key and no bearer header`, async () => {
      const { sent } = await makeupWith(appOn(undefined, 'claude-haiku-4-5', bearer), env);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.headers['x-api-key']).toBe('key-test');
      expect(sent[0]!.headers.authorization).toBeUndefined();
    });
  }

  test("on provider anthropic with its subscription login: one request with the login's bearer", async () => {
    const { makeup, sent } = await makeupWith(appOn(undefined, 'claude-haiku-4-5', 'login-test'), {});
    expect(sent.map((s) => s.url)).toEqual([COUNT_URL]);
    expect(sent[0]!.headers.authorization).toBe('Bearer login-test');
    expect(makeup.exactTotalTokens).toBe(7);
    expect(makeup.countHost).toBe('api.anthropic.com');
  });

  test('with a subscription login and an ANTHROPIC_AUTH_TOKEN: the request carries the login, as before', async () => {
    const { sent } = await makeupWith(appOn(undefined, 'claude-haiku-4-5', 'login-test'), { ANTHROPIC_AUTH_TOKEN: 'token-test' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.authorization).toBe('Bearer login-test');
  });

  test('with a subscription login whose token is spaces: neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY stands in, so no request', async () => {
    const { makeup, sent } = await makeupWith(appOn(undefined, 'claude-haiku-4-5', '  '), { ANTHROPIC_AUTH_TOKEN: 'token-test', ANTHROPIC_API_KEY: 'key-test' });
    expect(sent).toEqual([]);
    expect(makeup.countSource).toBe('count_tokens_no_credential');
  });

  test('with a subscription login whose token is spaces and a gateway: the request goes to the gateway with no credential', async () => {
    const { sent } = await makeupWith(appOn(undefined, 'claude-haiku-4-5', '  '), { ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_API_KEY: 'key-test' });
    expect(sent.map((s) => s.url)).toEqual(['https://gateway.example/v1/messages/count_tokens']);
    expect(sent[0]!.headers['x-api-key']).toBe('');
    expect(sent[0]!.headers.authorization).toBeUndefined();
  });

  test('with a subscription login and an ANTHROPIC_API_KEY: the request carries the login, as before', async () => {
    const { sent } = await makeupWith(appOn(undefined, 'claude-haiku-4-5', 'login-test'), { ANTHROPIC_API_KEY: 'key-test' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.authorization).toBe('Bearer login-test');
    expect(sent[0]!.headers['x-api-key']).toBeUndefined();
  });

  test('a count that answers with an error status still names where it asked', async () => {
    const { makeup } = await makeupWith(appOn(undefined, 'claude-haiku-4-5'), { ANTHROPIC_API_KEY: 'key-test' }, () => new Response('{}', { status: 429 }));
    expect(makeup.countSource).toBe('count_tokens_failed_429');
    expect(makeup.countHost).toBe('api.anthropic.com');
  });
});

describe('COUNT_TOKENS_MODEL for an agent whose model count_tokens does not take', () => {
  test('without a credential: no request, and the reason is the missing credential, for the override model', async () => {
    const { makeup, sent } = await makeupWith(appOn('openrouter', 'openai/gpt-6'), { COUNT_TOKENS_MODEL: 'claude-haiku-4-5' });
    expect(sent).toEqual([]);
    expect(makeup.countSource).toBe('count_tokens_no_credential');
    expect(makeup.countModel).toBe('claude-haiku-4-5');
  });

  test('with a credential: one request, counted for the override model', async () => {
    const { makeup, sent } = await makeupWith(appOn('openrouter', 'openai/gpt-6'), { COUNT_TOKENS_MODEL: 'claude-haiku-4-5', ANTHROPIC_API_KEY: 'key-test' });
    expect(sent).toHaveLength(1);
    expect(makeup.exactTotalTokens).toBe(7);
    expect(makeup.countModel).toBe('claude-haiku-4-5');
  });
});

describe('a COUNT_TOKENS_MODEL of spaces counts as unset', () => {
  test('a Claude agent with a key: counted with its own model', async () => {
    const { makeup, sent } = await makeupWith(appOn(undefined, 'claude-haiku-4-5'), { COUNT_TOKENS_MODEL: '   ', ANTHROPIC_API_KEY: 'key-test' });
    expect(sent).toHaveLength(1);
    expect(makeup.countModel).toBe('claude-haiku-4-5');
  });

  test('an agent on a model that count_tokens does not take: no request', async () => {
    const { makeup, sent } = await makeupWith(appOn('openrouter', 'openai/gpt-6'), { COUNT_TOKENS_MODEL: '   ', ANTHROPIC_API_KEY: 'key-test' });
    expect(sent).toEqual([]);
    expect(makeup.countSource).toBe('count_tokens_unsupported_model');
  });
});

describe('a model that count_tokens does not take', () => {
  for (const [label, env] of [['without a credential', {}], ['with a credential', { ANTHROPIC_API_KEY: 'key-test' }]] as const) {
    test(`${label}: no request, and it says so`, async () => {
      const { makeup, sent } = await makeupWith(appOn('openrouter', 'openai/gpt-6'), env);
      expect(sent).toEqual([]);
      expect(makeup.countSource).toBe('count_tokens_unsupported_model');
      expect(makeup.exactTotalTokens).toBeNull();
    });
  }
});

describe('a count is a whole number that is not negative', () => {
  for (const [label, body] of [
    ['a string', { input_tokens: '12' }],
    ['an object', { input_tokens: { n: 12 } }],
    ['true', { input_tokens: true }],
    ['-1', { input_tokens: -1 }],
    ['1.5', { input_tokens: 1.5 }],
    ['past the safe integers', { input_tokens: 2 ** 53 }],
    ['no field', {}],
    ['JSON null as the whole answer', null],
  ] as const) {
    test(`an answer of ${label} gives no total`, async () => {
      const { makeup, sent } = await makeupWith(appOn(undefined, 'claude-haiku-4-5'), { ANTHROPIC_API_KEY: 'key-test' }, () => Response.json(body));
      expect(sent).toHaveLength(1);
      expect(makeup.exactTotalTokens).toBeNull();
      expect(makeup.countSource).toBe('count_tokens');
    });
  }

  test('an answer of 0 gives a total of 0', async () => {
    const { makeup, sent } = await makeupWith(appOn(undefined, 'claude-haiku-4-5'), { ANTHROPIC_API_KEY: 'key-test' }, () => Response.json({ input_tokens: 0 }));
    expect(sent).toHaveLength(1);
    expect(makeup.exactTotalTokens).toBe(0);
  });
});
