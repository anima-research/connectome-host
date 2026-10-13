/**
 * Anthropic OAuth credential source: bare token vs credentials file, the
 * refresh exchange at the token endpoint, persistence back to the file, the
 * operator-driven (not automatic) rotation default, and the usage probe.
 */
import { describe, expect, test, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
const realOpenSync = fs.openSync;
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicOAuthCredentials, ProbeError, CLAUDE_CODE_OAUTH_CLIENT_ID } from '../src/anthropic-credentials.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (call: Call) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function tmpFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'anthropic-creds-'));
  const path = join(dir, 'creds.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

describe('bare token', () => {
  test('is not rotatable, has no expiry, and can be replaced', async () => {
    const creds = new AnthropicOAuthCredentials({ token: ' sk-ant-oat01-abc ' });
    expect(creds.currentToken()).toBe('sk-ant-oat01-abc');
    expect(creds.canRefresh()).toBe(false);
    expect(creds.expiresAt()).toBeUndefined();
    expect(creds.fileBacked).toBe(false);
    await expect(creds.refresh()).rejects.toThrow(/no refresh token/);
    creds.setToken('sk-ant-oat01-def');
    expect(creds.currentToken()).toBe('sk-ant-oat01-def');
    expect(await creds.resolver()({ forceRefresh: true })).toEqual({ token: 'sk-ant-oat01-def' });
  });

  test('an empty token is refused', () => {
    expect(() => new AnthropicOAuthCredentials({ token: '  ' })).toThrow(/need a token/);
  });
});

describe('credentials file', () => {
  test('loads Claude Code\'s nested shape, refreshes with a JSON grant, and writes the new pair back (mode 0600)', async () => {
    const path = tmpFile({ claudeAiOauth: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1_000, scopes: ['user:inference'] } });
    const { fetchImpl, calls } = fakeFetch(() => Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }));
    const creds = new AnthropicOAuthCredentials({ credentialsFile: path, fetchImpl, now: () => 50_000 });
    expect(creds.currentToken()).toBe('old-access');
    expect(creds.canRefresh()).toBe(true);
    expect(creds.expiresAt()).toBe(1_000);
    await creds.refresh();
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('https://platform.claude.com/v1/oauth/token');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: CLAUDE_CODE_OAUTH_CLIENT_ID,
    });
    expect(creds.currentToken()).toBe('new-access');
    expect(creds.expiresAt()).toBe(50_000 + 3_600_000);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.claudeAiOauth).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: 50_000 + 3_600_000, scopes: ['user:inference'] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('loads the flat shape and keeps it flat on write; a pasted token drops the refresh token', () => {
    const path = tmpFile({ accessToken: 'a', refreshToken: 'r', expiresAt: 5 });
    const creds = new AnthropicOAuthCredentials({ credentialsFile: path });
    expect(creds.canRefresh()).toBe(true);
    creds.setToken('pasted');
    expect(creds.canRefresh()).toBe(false);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written).toEqual({ accessToken: 'pasted' });
  });

  test('a refresh that lands after the operator pasted a replacement is discarded, in memory and on disk', async () => {
    const path = tmpFile({ accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1_000 });
    let release!: () => void;
    const { fetchImpl } = fakeFetch(async () => {
      await new Promise<void>((r) => { release = r; });
      return Response.json({ access_token: 'refreshed-old', refresh_token: 'refreshed-old-r', expires_in: 3600 });
    });
    const creds = new AnthropicOAuthCredentials({ credentialsFile: path, fetchImpl, now: () => 50_000 });
    const refresh = creds.refresh();
    await new Promise((r) => setTimeout(r, 0));
    creds.setToken('pasted-new');
    release();
    await expect(refresh).rejects.toThrow(/replaced while the refresh was in flight/);
    expect((await creds.resolver()({} as never)).token).toBe('pasted-new');
    expect(creds.canRefresh()).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ accessToken: 'pasted-new' });
    expect(readFileSync(path, 'utf8')).not.toContain('refreshed-old');
  });

  test('a token endpoint failure surfaces its error text and leaves the credential untouched', async () => {
    const path = tmpFile({ accessToken: 'a', refreshToken: 'r' });
    const { fetchImpl } = fakeFetch(() => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token revoked' }), { status: 400 }));
    const creds = new AnthropicOAuthCredentials({ credentialsFile: path, fetchImpl });
    await expect(creds.refresh()).rejects.toThrow(/HTTP 400 \(invalid_grant\)/);
    expect(creds.currentToken()).toBe('a');
    expect(creds.canRefresh()).toBe(true);
  });

  test('a planted temp path cannot capture the write: the rotation stays in memory and is reported', async () => {
    const path = tmpFile({ accessToken: 'a', refreshToken: 'r' });
    const { fetchImpl } = fakeFetch(() => Response.json({ access_token: 'b', refresh_token: 'r2', expires_in: 60 }));
    // Make the credentials file's directory unwritable for new entries by
    // pointing the file inside a directory that does not exist for the temp.
    const creds = new AnthropicOAuthCredentials({ credentialsFile: path, fetchImpl });
    (creds as unknown as { file: string }).file = join(path, 'nope', 'creds.json'); // path is a file ⇒ ENOTDIR on open
    await creds.refresh();
    expect(creds.currentToken()).toBe('b');
    expect(creds.canRefresh()).toBe(true);
    expect(creds.persistWarning()).toMatch(/rotated in memory but not written/);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ accessToken: 'a', refreshToken: 'r' });
  });

  test('the temp file is created exclusively (no following a pre-planted path)', async () => {
    const path = tmpFile({ accessToken: 'a' });
    const creds = new AnthropicOAuthCredentials({ credentialsFile: path });
    const opened: string[] = [];
    const spy = spyOn(fs, 'openSync').mockImplementation((p, flags, mode) => {
      opened.push(`${String(flags)}:${typeof mode === 'number' ? mode.toString(8) : '-'}`);
      return realOpenSync(p, flags, mode);
    });
    try {
      creds.setToken('z');
    } finally {
      spy.mockRestore();
    }
    expect(opened).toEqual(['wx:600']);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ accessToken: 'z' });
  });

  test('a file without an accessToken is refused at load', () => {
    const path = tmpFile({ claudeAiOauth: { refreshToken: 'r' } });
    expect(() => new AnthropicOAuthCredentials({ credentialsFile: path })).toThrow(/no accessToken/);
  });
});

describe('resolver', () => {
  test('forceRefresh does NOT rotate by default (operator-driven), and does with autoRefresh', async () => {
    const path = tmpFile({ accessToken: 'a', refreshToken: 'r' });
    const { fetchImpl, calls } = fakeFetch(() => Response.json({ access_token: 'b', expires_in: 10 }));
    const manual = new AnthropicOAuthCredentials({ credentialsFile: path, fetchImpl });
    expect(await manual.resolver()({ forceRefresh: true })).toEqual({ token: 'a' });
    expect(calls.length).toBe(0);
    const auto = new AnthropicOAuthCredentials({ credentialsFile: path, fetchImpl, autoRefresh: true });
    expect(await auto.tokenResolver()({ forceRefresh: false })).toBe('a');
    expect(await auto.tokenResolver()({ forceRefresh: true })).toBe('b');
    expect(calls.length).toBe(1);
  });
});

describe('probe', () => {
  test('reads the usage endpoint with the current bearer; 401 is a ProbeError with status', async () => {
    let status = 200;
    const { fetchImpl, calls } = fakeFetch(() => new Response('{}', { status }));
    const creds = new AnthropicOAuthCredentials({ token: 'tok', fetchImpl, baseURL: 'https://gw.example/' });
    await creds.probe();
    expect(calls[0]!.url).toBe('https://gw.example/api/oauth/usage');
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer tok');
    status = 401;
    const err = await creds.probe().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProbeError);
    expect((err as ProbeError).status).toBe(401);
  });
});
