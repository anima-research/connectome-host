import { afterEach, describe, expect, test } from 'bun:test';
import { OpenAIResponsesAPIAdapter, type ProviderRequest } from '@animalabs/membrane';
import { CodexSubscriptionAdapter, codexGateAuth } from '../src/codex-subscription-adapter.js';

const originalFetch = globalThis.fetch;
const originalBaseURL = process.env.CODEX_BASE_URL;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBaseURL === undefined) delete process.env.CODEX_BASE_URL;
  else process.env.CODEX_BASE_URL = originalBaseURL;
});
const request: ProviderRequest = { model: 'gpt-5.4', messages: [], maxTokens: 100 };
const completed = () => new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n');

describe('Codex host integration', () => {
  test('bridges token refresh and the refreshed account ID to Membrane', async () => {
    const flags: boolean[] = [];
    const headers: Headers[] = [];
    let account = 'old-account';
    globalThis.fetch = async (_url, init) => {
      headers.push(new Headers(init?.headers));
      return headers.length === 1 ? new Response('expired', { status: 401 }) : completed();
    };
    const adapter = new CodexSubscriptionAdapter({ authProvider: {
      getAccessToken: async (forceRefresh = false) => {
        flags.push(forceRefresh);
        if (forceRefresh) account = 'new-account';
        return forceRefresh ? 'fresh' : 'expired';
      },
      getAccountId: () => account,
    } });
    expect(adapter).toBeInstanceOf(OpenAIResponsesAPIAdapter);
    expect(adapter.usageCacheConvention).toBe('cache-inclusive');
    await adapter.complete(request);
    expect(flags).toEqual([false, true]);
    expect(headers[1]?.get('authorization')).toBe('Bearer fresh');
    expect(headers[1]?.get('chatgpt-account-id')).toBe('new-account');
  });

  test('preserves CODEX_BASE_URL, Fast controls and auth disposal', async () => {
    process.env.CODEX_BASE_URL = 'https://example.test/codex/';
    const calls: Array<{ url: string; body: any }> = [];
    let disposed = false;
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return completed();
    };
    const adapter = new CodexSubscriptionAdapter({ fastMode: true, authProvider: {
      getAccessToken: async () => 'token', dispose: () => { disposed = true; },
    } });
    expect(adapter.isFastMode()).toBe(true);
    await adapter.complete(request);
    adapter.setFastMode(false);
    await adapter.complete(request);
    expect(calls[0]?.url).toBe('https://example.test/codex/responses');
    expect(calls[0]?.body.service_tier).toBe('priority');
    expect(calls[1]?.body.service_tier).toBeUndefined();
    adapter.dispose();
    expect(disposed).toBe(true);
  });

  test('a gate token authenticates to the gate, with no login and no account id', async () => {
    expect(codexGateAuth({})).toBeUndefined();
    expect(codexGateAuth({ CODEX_GATE_TOKEN: '  ' })).toBeUndefined();
    expect(() => codexGateAuth({ CODEX_GATE_TOKEN: 'gt_x' })).toThrow(/CODEX_BASE_URL/);
    process.env.CODEX_BASE_URL = 'https://gate.test/codex';
    const auth = codexGateAuth({ CODEX_GATE_TOKEN: 'gt_devops', CODEX_BASE_URL: process.env.CODEX_BASE_URL })!;
    const seen: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers) });
      // the gate refreshed the login behind a 401; the single retry meets it
      return seen.length === 1 ? new Response('expired', { status: 401 }) : completed();
    };
    const adapter = new CodexSubscriptionAdapter({ codexBinary: '/nonexistent/codex', authProvider: auth });
    await adapter.complete(request);
    expect(seen.map((c) => c.url)).toEqual(['https://gate.test/codex/responses', 'https://gate.test/codex/responses']);
    expect(seen.every((c) => c.headers.get('authorization') === 'Bearer gt_devops')).toBe(true);
    expect(seen[0]!.headers.get('chatgpt-account-id')).toBeNull();
    expect(await adapter.readRateLimits()).toBeNull();
    adapter.dispose();
  });

  test('passes explicit endpoint configuration through the host wrapper', async () => {
    process.env.CODEX_BASE_URL = 'https://unused.test';
    let endpoint: string | undefined;
    globalThis.fetch = async url => { endpoint = String(url); return completed(); };
    await new CodexSubscriptionAdapter({ baseURL: 'https://explicit.test', authProvider: { getAccessToken: async () => 'token' } }).complete(request);
    expect(endpoint).toBe('https://explicit.test/responses');
  });
});

for (const mode of ['subscription', 'api'] as const) {
  for (const lane of ['complete', 'stream'] as const) {
    test(`logging wrapper preserves disjoint Membrane usage (${mode}/${lane})`, async () => {
      const { Membrane, OpenAIResponsesFormatter } = await import('@animalabs/membrane');
      const { LoggingProviderAdapter } = await import('../src/logging-provider-wrapper.js');
      const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const dir = mkdtempSync(`${tmpdir()}/codex-usage-`);
      try {
        const data = { status: 'completed', model: 'gpt-5.4', output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
        ], usage: { input_tokens: 100, output_tokens: 2, input_tokens_details: { cached_tokens: 80 } } };
        globalThis.fetch = async (_url, init) => JSON.parse(String(init?.body)).stream
          ? new Response(`data: ${JSON.stringify({ type: 'response.completed', response: data })}\n\n`)
          : new Response(JSON.stringify(data));
        const adapter = mode === 'subscription'
          ? new CodexSubscriptionAdapter({ authProvider: { getAccessToken: async () => 'token' } })
          : new OpenAIResponsesAPIAdapter({ apiKey: 'sk-fixture' });
        const wrapped = new LoggingProviderAdapter(adapter, `${dir}/calls.jsonl`);
        const membrane = new Membrane(wrapped, { formatter: new OpenAIResponsesFormatter() });
        const normalized = { messages: [{ participant: 'user', content: [{ type: 'text' as const, text: 'hello' }] }], config: { model: 'gpt-5.4', maxTokens: 100 } };
        const response = lane === 'complete' ? await membrane.complete(normalized) : await membrane.stream(normalized, { onChunk: () => {} });
        // 2026-07-31 incident: adding cached tokens twice ratcheted calibration until the agent wedged.
        expect(response.usage.inputTokens).toBe(20);
        expect(response.usage.cacheReadTokens).toBe(80);
        const log = JSON.parse(readFileSync(`${dir}/calls.jsonl`, 'utf8').trim());
        expect(log.response.usage.inputTokens).toBe(100);
        expect(log.response.usage.cacheConvention).toBe('cache-inclusive');
        expect(log.provider).toBe(mode === 'subscription' ? 'openai-codex' : 'openai-responses-api');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
}

test('wrapped subscription maintenance calls keep participant attribution', async () => {
  const { Membrane, OpenAIResponsesFormatter, NativeFormatter } = await import('@animalabs/membrane');
  const { LoggingProviderAdapter } = await import('../src/logging-provider-wrapper.js');
  let input: unknown;
  globalThis.fetch = async (_url, init) => { input = JSON.parse(String(init?.body)).input; return completed(); };
  const adapter = new LoggingProviderAdapter(new CodexSubscriptionAdapter({ authProvider: { getAccessToken: async () => 't' } }), '/dev/null');
  const membrane = new Membrane(adapter, { formatter: new OpenAIResponsesFormatter() });
  await membrane.complete({ messages: [
    { participant: 'Alice', content: [{ type: 'text', text: 'first' }] },
    { participant: 'Bob', content: [{ type: 'text', text: 'second' }] },
  ], config: { model: 'gpt-5.4', maxTokens: 100 } }, { formatter: new NativeFormatter({ participantMode: 'multiuser' }) });
  expect(JSON.stringify(input)).toContain('Alice: first');
  expect(JSON.stringify(input)).toContain('Bob: second');
  expect(adapter.requiresNativeResponsesInput).toBe(false);
});

test('a forced refresh waits behind an ordinary acquisition rather than joining it', async () => {
  const { CodexAppServerAuth } = await import('../src/codex-subscription-adapter.js');
  const auth = new CodexAppServerAuth();
  const flags: boolean[] = [];
  let release!: (token: string) => void;
  // Only the app-server exchange is stubbed; exercise real acquisition coordination.
  (auth as any).authenticate = (refresh: boolean) => {
    flags.push(refresh);
    return refresh ? Promise.resolve('fresh') : new Promise<string>(resolve => { release = resolve; });
  };
  const ordinary = auth.getAccessToken(false);
  const forced = auth.getAccessToken(true);
  const secondForced = auth.getAccessToken(true);
  release('stale');
  expect(await ordinary).toBe('stale');
  expect(await forced).toBe('fresh');
  expect(await secondForced).toBe('fresh');
  expect(flags).toEqual([false, true]);
});
