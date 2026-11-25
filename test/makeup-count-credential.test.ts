import { describe, expect, test } from 'bun:test';
import { buildContextMakeup } from '../src/web/panel-data.js';

const COUNT_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'COUNT_TOKENS_MODEL'] as const;
type CountEnv = Partial<Record<(typeof COUNT_VARS)[number], string>>;
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

/** The makeup answer with exactly `env` for the four variables a count reads,
 *  none of them taken from the developer's environment, and each request that
 *  the count sends. */
async function makeupWith(app: ReturnType<typeof appOn>, env: CountEnv, answer: () => Response = () => Response.json({ input_tokens: 7 })) {
  const prior = Object.fromEntries(COUNT_VARS.map((name) => [name, process.env[name]]));
  const sent: Sent[] = [];
  const realFetch = globalThis.fetch;
  for (const name of COUNT_VARS) {
    const value = env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  globalThis.fetch = (async (url: unknown, init?: { headers?: HeadersInit }) => {
    sent.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return answer();
  }) as unknown as typeof fetch;
  try {
    return { makeup: await buildContextMakeup(app as never, 'agent'), sent };
  } finally {
    globalThis.fetch = realFetch;
    for (const name of COUNT_VARS) {
      const value = prior[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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
    ['an ANTHROPIC_BASE_URL of spaces', { ANTHROPIC_BASE_URL: '  ' }],
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

  test('with an ANTHROPIC_BASE_URL of spaces and a key: the request goes to Anthropic', async () => {
    const { makeup, sent } = await makeupWith(appOn('bedrock', 'anthropic.claude-sonnet-4-5-20250929-v1:0'), { ANTHROPIC_BASE_URL: '  ', ANTHROPIC_API_KEY: 'key-test' });
    expect(sent.map((s) => s.url)).toEqual([COUNT_URL]);
    expect(makeup.countHost).toBe('api.anthropic.com');
  });

  test('with an ANTHROPIC_BASE_URL that is not a URL: the makeup still answers, and names no host', async () => {
    const { makeup } = await makeupWith(appOn(undefined, 'claude-haiku-4-5'), { ANTHROPIC_BASE_URL: 'not a url', ANTHROPIC_API_KEY: 'key-test' });
    expect('countHost' in makeup).toBe(false);
  });

  for (const [label, bearer, env] of [
    ['an ANTHROPIC_AUTH_TOKEN of spaces', undefined, { ANTHROPIC_AUTH_TOKEN: '  ', ANTHROPIC_API_KEY: 'key-test' }],
    ['a subscription login whose token is spaces', '  ', { ANTHROPIC_API_KEY: 'key-test' }],
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
      const { makeup } = await makeupWith(appOn(undefined, 'claude-haiku-4-5'), { ANTHROPIC_API_KEY: 'key-test' }, () => Response.json(body));
      expect(makeup.exactTotalTokens).toBeNull();
      expect(makeup.countSource).toBe('count_tokens');
    });
  }

  test('an answer of 0 gives a total of 0', async () => {
    const { makeup } = await makeupWith(appOn(undefined, 'claude-haiku-4-5'), { ANTHROPIC_API_KEY: 'key-test' }, () => Response.json({ input_tokens: 0 }));
    expect(makeup.exactTotalTokens).toBe(0);
  });
});
