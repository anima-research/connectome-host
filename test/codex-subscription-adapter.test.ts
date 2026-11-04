import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { MembraneError, OpenAIResponsesAPIAdapter, type ProviderRequest } from '@animalabs/membrane';
import { CodexAppServerAuth, CodexSubscriptionAdapter, codexGateAuth, type CodexAppServerAuthConfig } from '../src/codex-subscription-adapter.js';
import * as codexSubscription from '../src/codex-subscription-adapter.js';

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
    const adapter = new CodexSubscriptionAdapter({ requireExistingLogin: true, authProvider: {
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
      return seen.length === 1 ? new Response('expired', { status: 401 }) : completed();
    };
    const adapter = new CodexSubscriptionAdapter({ codexBinary: '/nonexistent/codex', requireExistingLogin: true, authProvider: auth });
    await adapter.complete(request);
    expect(seen.map((c) => c.url)).toEqual(['https://gate.test/codex/responses', 'https://gate.test/codex/responses']);
    expect(seen.every((c) => c.headers.get('authorization') === 'Bearer gt_devops')).toBe(true);
    expect(seen[0]!.headers.get('chatgpt-account-id')).toBeNull();
    expect(await adapter.readRateLimits()).toBeNull();
    const source = adapter.credentialSource();
    expect(source.provider).toBe('openai-codex via https://gate.test/codex');
    expect(source.canRefresh()).toBe(false);
    expect(source.refresh).toBeUndefined();
    expect(source.login).toBeUndefined();
    expect(source.setToken).toBeUndefined();
    expect(source.probe).toBeUndefined();
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

describe('Codex existing-login-only authentication', () => {
  const adapters: CodexSubscriptionAdapter[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.dispose();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Exercise authentication and adapter wiring with only the app-server transport replaced.
  const fixture = (
    accounts: unknown[],
    config: Pick<CodexAppServerAuthConfig, 'requireExistingLogin' | 'codexBinary'> = {},
    suppliedAuth = false,
  ) => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-existing-login-'));
    dirs.push(codexHome);
    const credentialPath = join(codexHome, 'auth.json');
    const writeToken = (token: string, accountId = 'fixture-account', refreshToken: string | null = 'fixture-refresh') =>
      writeFileSync(credentialPath, JSON.stringify({ tokens: { access_token: token, account_id: accountId, refresh_token: refreshToken ?? undefined } }));
    writeToken('fixture-token');
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const loginEvents: Array<{ verificationUrl: string; userCode: string }> = [];
    const authConfig: CodexAppServerAuthConfig = {
      ...config,
      codexHome,
      loginTimeoutMs: 1000,
      onLoginRequired: details => {
        loginEvents.push(details);
        queueMicrotask(() => auth.handleLine(JSON.stringify({
          method: 'account/login/completed', params: { loginId: 'fixture-login', success: true },
        })));
      },
    };
    const adapter = new CodexSubscriptionAdapter({
      ...authConfig,
      ...(suppliedAuth ? { authProvider: new CodexAppServerAuth({ ...authConfig, requireExistingLogin: false }) } : {}),
    });
    adapters.push(adapter);
    const auth = (adapter as any).auth;
    auth.ensureStarted = async () => {};
    auth.request = async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'account/read') {
        if (accounts.length === 0) throw new Error('Unexpected account/read');
        const account = accounts.shift();
        return account === undefined ? {} : { account };
      }
      if (method === 'account/login/start') {
        return { loginId: 'fixture-login', verificationUrl: 'https://example.test/login', userCode: 'fixture-code' };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    };
    return { adapter, auth, calls, loginEvents, writeToken, codexHome };
  };

  test('public flag parser preserves opt-in values and warns when an unknown value leaves login enabled', () => {
    const warnings: string[] = [];
    const parse = (value: string | undefined) => codexSubscription.parseCodexRequireExistingLogin(value, message => warnings.push(message));
    for (const value of ['1', 'true', ' TRUE ', ' 1 ']) expect(parse(value)).toBe(true);
    for (const value of [undefined, '', ' ', '0', 'false', ' FALSE ']) expect(parse(value)).toBe(false);
    expect(warnings).toEqual([]);
    for (const value of ['yes', 'treu', 'synthetic-private-value']) expect(parse(value)).toBe(false);
    expect(warnings).toHaveLength(3);
    expect(warnings.every(message => message.includes('CODEX_REQUIRE_EXISTING_LOGIN') && message.includes('restriction is off'))).toBe(true);
    expect(warnings.join()).not.toContain('synthetic-private-value');
  });

  test('the public parser enables refusal at the adapter boundary', async () => {
    const { adapter, calls, loginEvents } = fixture([null], {
      requireExistingLogin: codexSubscription.parseCodexRequireExistingLogin('1'),
    });
    let fetches = 0;
    globalThis.fetch = Object.assign(async () => { fetches++; return completed(); }, { preconnect: originalFetch.preconnect });
    await expect(adapter.complete(request)).rejects.toMatchObject({ type: 'auth', retryable: false });
    expect(calls).toEqual([{ method: 'account/read', params: { refreshToken: false } }]);
    expect(fetches).toBe(0);
    expect(loginEvents).toEqual([]);
  });

  for (const forceRefresh of [false, true]) {
    test(`adapter policy restricts a supplied app-server on token acquisition (refresh=${forceRefresh})`, async () => {
      const { adapter, calls, loginEvents } = fixture([null], { requireExistingLogin: true }, true);
      let fetches = 0;
      globalThis.fetch = Object.assign(async () => { fetches++; return completed(); }, { preconnect: originalFetch.preconnect });
      await expect(forceRefresh ? adapter.refreshCredentials() : adapter.complete(request))
        .rejects.toMatchObject({ type: 'auth', retryable: false });
      expect(calls).toEqual([{ method: 'account/read', params: { refreshToken: forceRefresh } }]);
      expect(loginEvents).toEqual([]);
      expect(fetches).toBe(0);
      expect(adapter.credentialSource().login).toBeUndefined();
      await expect(adapter.login()).rejects.toThrow(/host login actions are disabled/i);
      expect(calls).toHaveLength(1);
    });
  }

  test('an adapter cannot weaken the supplied app-server existing-login policy', async () => {
    const { auth, calls } = fixture([null], { requireExistingLogin: true });
    const adapter = new CodexSubscriptionAdapter({ authProvider: auth, requireExistingLogin: false });
    adapters.push(adapter);
    expect(adapter.credentialSource().login).toBeUndefined();
    await expect(adapter.login()).rejects.toThrow(/host login actions are disabled/i);
    expect(calls).toEqual([]);
  });

  test('tightening a shared provider blocks an earlier saved login callback before logout and hides its action', async () => {
    const { adapter, auth, calls } = fixture([{ type: 'chatgpt' }]);
    const source = adapter.credentialSource(), savedLogin = source.login!;
    let logouts = 0;
    auth.logout = async () => { logouts++; };
    const restricted = new CodexSubscriptionAdapter({ authProvider: auth, requireExistingLogin: true });
    adapters.push(restricted);
    await expect(savedLogin()).rejects.toThrow(/existing ChatGPT login/i);
    expect(logouts).toBe(0);
    expect(calls).toEqual([]);
    expect(source.login).toBeUndefined();
    expect(source.loginDisabledReason).toContain('CODEX_HOME=');
  });

  test('tightening refuses an in-flight permissive login without cancelling or adopting it', async () => {
    const { auth, calls, loginEvents } = fixture([null, { type: 'chatgpt' }]);
    const request = auth.request.bind(auth);
    let started!: () => void, release!: () => void;
    const loginStarted = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    auth.request = async (method: string, params: Record<string, unknown>) => {
      if (method === 'account/login/start') { started(); await held; }
      return request(method, params);
    };
    const original = auth.getAccessToken();
    await loginStarted;
    let unexpected: CodexSubscriptionAdapter | undefined;
    try {
      expect(() => {
        unexpected = new CodexSubscriptionAdapter({ authProvider: auth, requireExistingLogin: true });
      }).toThrow(/authentication.*in progress/i);
      expect(auth.existingLoginRequired).toBe(false);
      expect(loginEvents).toEqual([]);
    } finally {
      if (unexpected) adapters.push(unexpected);
      release();
      expect(await original).toBe('fixture-token');
    }
    expect(calls.map((call) => call.method)).toEqual(['account/read', 'account/login/start', 'account/read']);
    expect(loginEvents).toHaveLength(1);
    const restricted = new CodexSubscriptionAdapter({ authProvider: auth, requireExistingLogin: true });
    adapters.push(restricted);
    expect(auth.existingLoginRequired).toBe(true);
    expect(restricted.credentialSource().login).toBeUndefined();
  });

  test('tightening waits for an owned logout without interrupting the original login action', async () => {
    const { adapter, auth, calls, loginEvents } = fixture([null, { type: 'chatgpt' }]);
    const request = auth.request.bind(auth);
    let started!: () => void, release!: () => void;
    const logoutStarted = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    auth.request = async (method: string, params: Record<string, unknown>) => {
      if (method === 'account/logout') { started(); await held; return {}; }
      return request(method, params);
    };
    const original = adapter.login();
    await logoutStarted;
    let unexpected: CodexSubscriptionAdapter | undefined;
    try {
      expect(() => {
        unexpected = new CodexSubscriptionAdapter({ authProvider: auth, requireExistingLogin: true });
      }).toThrow(/authentication.*in progress/i);
      expect(auth.existingLoginRequired).toBe(false);
    } finally {
      if (unexpected) adapters.push(unexpected);
      release();
      await original;
    }
    expect(calls.map((call) => call.method)).toEqual(['account/read', 'account/login/start', 'account/read']);
    expect(loginEvents).toHaveLength(1);
    const restricted = new CodexSubscriptionAdapter({ authProvider: auth, requireExistingLogin: true });
    adapters.push(restricted);
    expect(auth.existingLoginRequired).toBe(true);
  });

  test('the owned re-login keeps its policy boundary between logout completion and token acquisition', async () => {
    const { adapter, auth, calls, loginEvents } = fixture([null, { type: 'chatgpt' }]);
    const request = auth.request.bind(auth), logout = auth.logout.bind(auth);
    auth.request = async (method: string, params: Record<string, unknown>) =>
      method === 'account/logout' ? {} : request(method, params);
    let observedBoundary = false;
    auth.logout = async () => {
      await logout();
      let unexpected: CodexSubscriptionAdapter | undefined;
      try {
        expect(() => {
          unexpected = new CodexSubscriptionAdapter({ authProvider: auth, requireExistingLogin: true });
        }).toThrow(/authentication.*in progress/i);
        observedBoundary = true;
      } finally { if (unexpected) adapters.push(unexpected); }
    };
    await adapter.login();
    expect(observedBoundary).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(['account/read', 'account/login/start', 'account/read']);
    expect(loginEvents).toHaveLength(1);
    const restricted = new CodexSubscriptionAdapter({ authProvider: auth, requireExistingLogin: true });
    adapters.push(restricted);
    expect(auth.existingLoginRequired).toBe(true);
  });

  test('missing-login and disabled-login guidance name the configured executable, home and file storage', async () => {
    const { CredentialMonitor } = await import('../src/credential-state.js');
    const codexBinary = "/synthetic/tool dir/operator's-codex";
    const { adapter, codexHome, calls } = fixture([null], { requireExistingLogin: true, codexBinary });
    globalThis.fetch = Object.assign(async () => completed(), { preconnect: originalFetch.preconnect });
    let failure: Error | undefined;
    try { await adapter.complete(request); } catch (error) { failure = error as Error; }
    expect(failure?.message).toContain(`CODEX_HOME='${codexHome}'`);
    expect(failure?.message).toContain("'/synthetic/tool dir/operator'\\''s-codex'");
    expect(failure?.message).toContain('cli_auth_credentials_store="file"');
    expect(failure?.message).toContain(join(codexHome, 'auth.json'));
    expect(failure?.message).toContain('keyring-only');
    await expect(adapter.login()).rejects.toThrow(failure!.message);
    const monitor = new CredentialMonitor({ source: adapter.credentialSource(), alert: () => {} });
    try {
      monitor.observeError(failure);
      expect(monitor.snapshot().actions.map(action => action.id)).toEqual(['recheck']);
      const refused = await monitor.runAction('login');
      expect(refused.lastAction).toMatchObject({ ok: false, message: failure!.message });
      expect(calls).toHaveLength(1);
    } finally { monitor.dispose(); }
  });

  test('refresh is offered only after the app-server reads a refresh token, and disappears when the account is missing', async () => {
    const { adapter, auth, writeToken } = fixture([{ type: 'chatgpt' }, { type: 'chatgpt' }, { type: 'chatgpt' }, null], { requireExistingLogin: true });
    const source = adapter.credentialSource();
    expect(source.canRefresh()).toBe(false);
    await auth.getAccessToken();
    expect(source.canRefresh()).toBe(true);
    writeToken('access-only', 'fixture-account', null);
    await auth.getAccessToken();
    expect(source.canRefresh()).toBe(false);
    writeToken('restored');
    await auth.getAccessToken();
    expect(source.canRefresh()).toBe(true);
    await expect(auth.getAccessToken(true)).rejects.toMatchObject({ type: 'auth', retryable: false });
    expect(source.canRefresh()).toBe(false);
  });

  for (const [name, account] of [['absent', undefined], ['null', null], ['API-key', { type: 'apiKey' }]] as const) {
    for (const forceRefresh of [false, true]) {
      test(`refuses the ${name} account before login (refresh=${forceRefresh})`, async () => {
        const { auth, calls, loginEvents } = fixture([account], { requireExistingLogin: true });
        await expect(auth.getAccessToken(forceRefresh)).rejects.toThrow(/existing ChatGPT login/i);
        expect(calls).toEqual([{ method: 'account/read', params: { refreshToken: forceRefresh } }]);
        expect(loginEvents).toEqual([]);
        expect(auth.waiterCount).toBe(0);
        expect(await auth.cancelLogin()).toBe(false);
      });
    }
  }

  for (const requireExistingLogin of [undefined, false]) {
    test(`keeps device-code login when requireExistingLogin=${requireExistingLogin}`, async () => {
      const { auth, calls, loginEvents } = fixture([null, { type: 'chatgpt' }], { requireExistingLogin });
      expect(await auth.getAccessToken()).toBe('fixture-token');
      expect(calls).toEqual([
        { method: 'account/read', params: { refreshToken: false } },
        { method: 'account/login/start', params: { type: 'chatgptDeviceCode' } },
        { method: 'account/read', params: { refreshToken: true } },
      ]);
      expect(loginEvents).toEqual([{ verificationUrl: 'https://example.test/login', userCode: 'fixture-code' }]);
    });
  }

  test('uses an existing session and refreshes its token and account ID after a 401', async () => {
    const { adapter, auth, calls, loginEvents, writeToken } = fixture(
      [{ type: 'chatgpt' }, { type: 'chatgpt' }], { requireExistingLogin: true },
    );
    const headers: Headers[] = [];
    globalThis.fetch = Object.assign(async (_url: URL | RequestInfo, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      if (headers.length === 1) {
        writeToken('refreshed-token', 'refreshed-account');
        return new Response('expired', { status: 401 });
      }
      return completed();
    }, { preconnect: originalFetch.preconnect });
    await adapter.complete(request);
    expect(calls).toEqual([
      { method: 'account/read', params: { refreshToken: false } },
      { method: 'account/read', params: { refreshToken: true } },
    ]);
    expect(headers.map(h => h.get('authorization'))).toEqual(['Bearer fixture-token', 'Bearer refreshed-token']);
    expect(headers.map(h => h.get('chatgpt-account-id'))).toEqual(['fixture-account', 'refreshed-account']);
    expect(auth.getAccountId()).toBe('refreshed-account');
    expect(adapter.credentialSource().canRefresh()).toBe(true);
    expect(loginEvents).toEqual([]);
  });

  test('forwards the opt-in through the adapter before any inference request', async () => {
    const { adapter, calls, loginEvents } = fixture([null], { requireExistingLogin: true });
    let fetched = false;
    globalThis.fetch = Object.assign(async () => { fetched = true; return completed(); }, { preconnect: originalFetch.preconnect });
    await expect(adapter.complete(request)).rejects.toThrow(/existing ChatGPT login/i);
    expect(calls).toEqual([{ method: 'account/read', params: { refreshToken: false } }]);
    expect(fetched).toBe(false);
    expect(loginEvents).toEqual([]);
  });

  test('reports a missing existing login through the provider wrapper as an auth alert', async () => {
    const { CredentialMonitor } = await import('../src/credential-state.js');
    const { LoggingProviderAdapter } = await import('../src/logging-provider-wrapper.js');
    const { adapter, calls, loginEvents, writeToken } = fixture([null], { requireExistingLogin: true });
    const privateToken = 'fixture-private-credential';
    writeToken(privateToken);
    const alerts: Array<{ kind: string; message: string; data: Record<string, unknown> }> = [];
    const monitor = new CredentialMonitor({
      source: adapter.credentialSource(),
      alert: (kind, message, data) => { alerts.push({ kind, message, data }); },
    });
    const wrapped = new LoggingProviderAdapter(adapter, '/dev/null');
    let observedError: unknown;
    wrapped.onProviderError = error => { observedError = error; monitor.observeError(error); };
    let fetches = 0;
    globalThis.fetch = Object.assign(async () => { fetches++; return completed(); }, { preconnect: originalFetch.preconnect });
    let failure: unknown;
    try {
      await wrapped.complete(request);
    } catch (error) {
      failure = error;
    } finally {
      monitor.dispose();
    }
    expect(monitor.snapshot().kind).toBe('auth-rejected');
    expect(alerts.map(alert => alert.kind)).toEqual(['auth-rejected']);
    expect(alerts[0]!.message).toContain('existing ChatGPT login');
    expect(alerts[0]!.message).toContain('authentication unavailable');
    expect(alerts[0]!.message).not.toContain('rejected the credential');
    expect(monitor.snapshot().actions.map(action => action.id)).toEqual(['recheck']);
    expect(failure).toBe(observedError);
    expect(failure).toBeInstanceOf(MembraneError);
    expect(failure).toMatchObject({ type: 'auth', retryable: false });
    expect((failure as MembraneError).httpStatus).toBeUndefined();
    expect((failure as MembraneError).rawError).toBeUndefined();
    expect(inspect({ failure, state: monitor.snapshot(), alerts })).not.toContain(privateToken);
    expect(fetches).toBe(0);
    expect(calls).toEqual([{ method: 'account/read', params: { refreshToken: false } }]);
    expect(loginEvents).toEqual([]);
  });

  test('refuses a missing account on the supplied app-server 401 refresh as a nonretryable auth failure', async () => {
    const { adapter, calls, loginEvents } = fixture([{ type: 'chatgpt' }, null], { requireExistingLogin: true }, true);
    let fetches = 0;
    globalThis.fetch = Object.assign(async () => { fetches++; return new Response('expired', { status: 401 }); }, { preconnect: originalFetch.preconnect });
    await expect(adapter.complete(request)).rejects.toMatchObject({ type: 'auth', retryable: false });
    expect(calls).toEqual([
      { method: 'account/read', params: { refreshToken: false } },
      { method: 'account/read', params: { refreshToken: true } },
    ]);
    expect(fetches).toBe(1);
    expect(loginEvents).toEqual([]);
  });

  for (const phase of ['acquisition', '401 refresh'] as const) {
    for (const lane of ['complete', 'stream'] as const) {
      test(`host Membrane does not retry a wrapped existing-login refusal (${phase}/${lane})`, async () => {
        const { Membrane, OpenAIResponsesFormatter } = await import('@animalabs/membrane');
        const { LoggingProviderAdapter } = await import('../src/logging-provider-wrapper.js');
        const { CredentialMonitor } = await import('../src/credential-state.js');
        const { hostMembraneRetry } = await import('../src/membrane-retry.js');
        const { adapter, calls, loginEvents } = fixture(
          phase === 'acquisition' ? [null] : [{ type: 'chatgpt' }, null],
          { requireExistingLogin: true }, true,
        );
        const alerts: string[] = [];
        const monitor = new CredentialMonitor({ source: adapter.credentialSource(), alert: kind => alerts.push(kind) });
        const wrapped = new LoggingProviderAdapter(adapter, '/dev/null');
        const failures: unknown[] = [];
        wrapped.onProviderError = error => { failures.push(error); monitor.observeError(error); };
        const membrane = new Membrane(wrapped, {
          formatter: new OpenAIResponsesFormatter(),
          retry: hostMembraneRetry({ maxRetries: 3, retryDelayMs: 0 }),
        });
        let fetches = 0;
        globalThis.fetch = Object.assign(async () => { fetches++; return new Response('expired', { status: 401 }); }, { preconnect: originalFetch.preconnect });
        const normalized = { messages: [{ participant: 'user', content: [{ type: 'text' as const, text: 'hello' }] }], config: { model: 'gpt-5.4', maxTokens: 100 } };
        try {
          await expect(lane === 'complete'
            ? membrane.complete(normalized)
            : membrane.stream(normalized, { onChunk: () => {} }))
            .rejects.toMatchObject({ type: 'auth', retryable: false });
          expect(failures).toHaveLength(1);
          expect(failures[0]).toMatchObject({ type: 'auth', retryable: false });
          expect(calls).toEqual(phase === 'acquisition'
            ? [{ method: 'account/read', params: { refreshToken: false } }]
            : [
                { method: 'account/read', params: { refreshToken: false } },
                { method: 'account/read', params: { refreshToken: true } },
              ]);
          expect(fetches).toBe(phase === 'acquisition' ? 0 : 1);
          expect(loginEvents).toEqual([]);
          expect(alerts).toEqual(['auth-rejected']);
          expect(monitor.snapshot().message).toContain('authentication unavailable');
          expect(monitor.snapshot().actions.map(action => action.id)).toEqual(['recheck']);
        } finally { monitor.dispose(); }
      });
    }
  }

  for (const requireExistingLogin of [undefined, false]) {
    test(`keeps explicit login when requireExistingLogin=${requireExistingLogin}`, async () => {
      const calls: string[] = [];
      const adapter = new CodexSubscriptionAdapter({
        requireExistingLogin,
        authProvider: {
          getAccessToken: async forceRefresh => { calls.push(`token:${forceRefresh}`); return 'token'; },
          logout: async () => { calls.push('logout'); },
        },
      });
      adapters.push(adapter);
      await adapter.credentialSource().login!();
      expect(calls).toEqual(['logout', 'token:true']);
    });
  }

  test('refuses explicit login before logout and keeps refresh available', async () => {
    let logouts = 0;
    const refreshes: boolean[] = [];
    const adapter = new CodexSubscriptionAdapter({
      requireExistingLogin: true,
      authProvider: {
        getAccessToken: async (forceRefresh = false) => { refreshes.push(forceRefresh); return 'existing-token'; },
        logout: async () => { logouts++; },
      },
    });
    adapters.push(adapter);
    await expect(adapter.login()).rejects.toThrow(/existing ChatGPT login/i);
    expect(logouts).toBe(0);
    expect(refreshes).toEqual([]);
    const source = adapter.credentialSource();
    expect(source.login).toBeUndefined();
    expect(source.canRefresh()).toBe(true);
    await source.refresh!();
    expect(refreshes).toEqual([true]);
  });
});

describe("reading Codex's auth.json", () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true }); });
  const home = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-home-'));
    dirs.push(dir);
    return dir;
  };
  const thrown = async (auth: unknown): Promise<Error> => {
    try {
      await (auth as { readAccessToken(): Promise<string> }).readAccessToken();
    } catch (err) {
      return err as Error;
    }
    throw new Error('it read');
  };

  test("a file that isn't valid JSON is refused without the parser's error, as text or as its cause", async () => {
    const { CodexAppServerAuth } = await import('../src/codex-subscription-adapter.js');
    const codexHome = home();
    const SECRET = 's3cretTokenValue';
    writeFileSync(join(codexHome, 'auth.json'), `{ "tokens": { "access_token": ${SECRET} } }`);
    const err = await thrown(new CodexAppServerAuth({ codexHome }));
    expect(inspect(err)).not.toContain(SECRET);
    expect([err.message, err.cause]).toEqual([`Codex login succeeded but ${join(codexHome, 'auth.json')} isn't valid JSON.`, undefined]);
  });

  test('a file that can\'t be read keeps the read error as its cause', async () => {
    const { CodexAppServerAuth } = await import('../src/codex-subscription-adapter.js');
    const codexHome = home();
    const err = await thrown(new CodexAppServerAuth({ codexHome }));
    expect(err.message).toStartWith(`Codex login succeeded but ${join(codexHome, 'auth.json')} could not be read.`);
    expect((err.cause as NodeJS.ErrnoException).code).toBe('ENOENT');
  });
});
