/**
 * Anthropic OAuth (subscription) credential source.
 *
 * Membrane resolves the bearer per request through a CredentialResolver and
 * retries a 401 once with `forceRefresh`; what it never does is ACQUIRE a
 * credential (membrane's src/ has no node: imports). This is the host half:
 * where the token comes from, whether it can rotate, and how to check it
 * without spending inference.
 *
 * Two shapes of credential:
 *   - a bare token (`ANTHROPIC_AUTH_TOKEN`, typically `claude setup-token`):
 *     no refresh token, no expiry ⇒ not rotatable; the operator pastes a new
 *     one (`/auth token …`, WebUI "Paste new token").
 *   - a credentials FILE (`ANTHROPIC_OAUTH_CREDENTIALS_FILE`) in the shape
 *     Claude Code writes — `{ claudeAiOauth: { accessToken, refreshToken,
 *     expiresAt } }` — or the same three keys flat. With a refresh token the
 *     host can rotate at the vendor's token endpoint and writes the new pair
 *     back to the SAME file.
 *
 * Point the file variable at a COPY, never at `~/.claude/.credentials.json`
 * itself: refresh tokens may be single-use, so two processes refreshing from
 * one file invalidate each other.
 *
 * Rotation is operator-driven by default: `forceRefresh` from membrane's
 * 401 retry returns the same token unless `autoRefresh` is on, so an expired
 * credential becomes an alert with a "Refresh token" action rather than a
 * silent rotation (the operator asked for click-to-act first).
 */

import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import type { CredentialResolver, CredentialContext } from '@animalabs/membrane';
import type { CredentialSource } from './credential-state.js';

/** Claude Code's public OAuth client id (it ships in the CLI binary). */
export const CLAUDE_CODE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const ANTHROPIC_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

export interface AnthropicCredentialsConfig {
  /** Static bearer token. Ignored when `credentialsFile` loads. */
  token?: string;
  /** JSON file holding the token (+ refresh token + expiry). */
  credentialsFile?: string;
  tokenEndpoint?: string;
  clientId?: string;
  /** Honour membrane's 401 `forceRefresh` automatically. Default false. */
  autoRefresh?: boolean;
  /** Inference base URL; the probe reads `/api/oauth/usage` under it. */
  baseURL?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface StoredCredential {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
}

type FileShape = 'nested' | 'flat';

export class ProbeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ProbeError';
  }
}

export class AnthropicOAuthCredentials implements CredentialSource {
  readonly provider = 'anthropic';
  private accessToken: string;
  private refreshToken?: string;
  private expiresAtMs?: number;
  private readonly file?: string;
  private fileShape: FileShape = 'nested';
  private readonly tokenEndpoint: string;
  private readonly clientId: string;
  private readonly autoRefresh: boolean;
  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private refreshing: Promise<void> | null = null;

  constructor(config: AnthropicCredentialsConfig) {
    this.tokenEndpoint = config.tokenEndpoint ?? ANTHROPIC_OAUTH_TOKEN_URL;
    this.clientId = config.clientId ?? CLAUDE_CODE_OAUTH_CLIENT_ID;
    this.autoRefresh = config.autoRefresh ?? false;
    this.baseURL = (config.baseURL ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
    this.file = config.credentialsFile;
    if (this.file) {
      const stored = this.readFile(this.file);
      this.accessToken = stored.accessToken;
      this.refreshToken = stored.refreshToken;
      this.expiresAtMs = stored.expiresAt;
    } else {
      const token = (config.token ?? '').trim();
      if (!token) throw new Error('Anthropic credentials need a token or a credentials file');
      this.accessToken = token;
    }
  }

  /** True when the credential came from a file (rotations persist there). */
  get fileBacked(): boolean {
    return this.file !== undefined;
  }

  currentToken(): string {
    return this.accessToken;
  }

  /** Membrane-facing resolver: per-request token, optional auto-rotation. */
  resolver(): CredentialResolver {
    return async (context: CredentialContext) => {
      if (context.forceRefresh && this.autoRefresh && this.canRefresh()) {
        try {
          await this.refresh();
        } catch (err) {
          console.error('[anthropic-credentials] automatic refresh failed:', err instanceof Error ? err.message : err);
        }
      }
      return { token: this.accessToken };
    };
  }

  /** Same thing shaped for AnthropicAdapter's `authToken` callback form,
   *  which keeps the host's OAuth-mode detection (`Boolean(authToken)`) true. */
  tokenResolver(): (context: CredentialContext) => Promise<string> {
    const resolve = this.resolver();
    return async (context) => (await resolve(context)).token;
  }

  canRefresh(): boolean {
    return typeof this.refreshToken === 'string' && this.refreshToken.length > 0;
  }

  expiresAt(): number | undefined {
    return this.expiresAtMs;
  }

  /** Rotate at the token endpoint. Coalesces concurrent callers. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    if (!this.canRefresh()) throw new Error('no refresh token on this credential');
    const res = await this.fetchImpl(this.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.clientId,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const detail = describeError(body);
      throw new Error(`token endpoint answered HTTP ${res.status}${detail ? ` (${detail})` : ''}`);
    }
    const doc = (body ?? {}) as Record<string, unknown>;
    const accessToken = doc.access_token;
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new Error('token endpoint answered without an access_token');
    }
    this.accessToken = accessToken;
    if (typeof doc.refresh_token === 'string' && doc.refresh_token) this.refreshToken = doc.refresh_token;
    const expiresIn = typeof doc.expires_in === 'number' && Number.isFinite(doc.expires_in) ? doc.expires_in : undefined;
    this.expiresAtMs = expiresIn !== undefined ? this.now() + expiresIn * 1000 : undefined;
    this.persist();
  }

  /** Operator-pasted replacement: no refresh token, no known expiry. */
  setToken(token: string): void {
    const trimmed = token.trim();
    if (!trimmed) throw new Error('empty token');
    this.accessToken = trimmed;
    this.refreshToken = undefined;
    this.expiresAtMs = undefined;
    this.persist();
  }

  /** Usage read: 401/403 is an auth verdict, anything else inconclusive. */
  async probe(): Promise<void> {
    const res = await this.fetchImpl(`${this.baseURL}/api/oauth/usage`, {
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      void res.body?.cancel().catch(() => {});
      return;
    }
    void res.body?.cancel().catch(() => {});
    throw new ProbeError(`usage endpoint answered HTTP ${res.status}`, res.status);
  }

  // ---------------------------------------------------------------------------
  // File I/O
  // ---------------------------------------------------------------------------

  private readFile(path: string): StoredCredential {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`cannot read Anthropic credentials file ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const root = (parsed ?? {}) as Record<string, unknown>;
    const nested = root.claudeAiOauth;
    const doc = nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : root;
    this.fileShape = nested && typeof nested === 'object' ? 'nested' : 'flat';
    const accessToken = doc.accessToken;
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new Error(`Anthropic credentials file ${path} has no accessToken`);
    }
    const expiresAt = typeof doc.expiresAt === 'number' && Number.isFinite(doc.expiresAt) && doc.expiresAt > 0
      ? doc.expiresAt
      : undefined;
    return {
      accessToken,
      ...(typeof doc.refreshToken === 'string' && doc.refreshToken ? { refreshToken: doc.refreshToken } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  }

  private persist(): void {
    if (!this.file) return;
    const stored: StoredCredential = {
      accessToken: this.accessToken,
      ...(this.refreshToken ? { refreshToken: this.refreshToken } : {}),
      ...(this.expiresAtMs !== undefined ? { expiresAt: this.expiresAtMs } : {}),
    };
    // Preserve the file's other keys (Claude Code keeps scopes etc. there)
    // but never the stale token triple.
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      if (!existing || typeof existing !== 'object') existing = {};
    } catch {
      existing = {};
    }
    const next = this.fileShape === 'nested'
      ? { ...existing, claudeAiOauth: { ...(existing.claudeAiOauth as object ?? {}), ...stored, ...(stored.refreshToken ? {} : { refreshToken: undefined }), ...(stored.expiresAt !== undefined ? {} : { expiresAt: undefined }) } }
      : { ...existing, ...stored, ...(stored.refreshToken ? {} : { refreshToken: undefined }), ...(stored.expiresAt !== undefined ? {} : { expiresAt: undefined }) };
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
    renameSync(tmp, this.file);
  }
}

function describeError(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const doc = body as Record<string, unknown>;
  const error = doc.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const msg = (error as Record<string, unknown>).message;
    if (typeof msg === 'string') return msg;
  }
  if (typeof doc.error_description === 'string') return doc.error_description;
  return undefined;
}
