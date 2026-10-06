/**
 * ChatGPT-subscription-backed OpenAI Responses adapter.
 *
 * Authentication is deliberately delegated to `codex app-server`: it owns
 * ChatGPT OAuth, refresh-token rotation, and the device-code login ceremony.
 * The resulting access token and account id are read from CODEX_HOME/auth.json
 * and used only for the Codex subscription Responses transport.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface as ReadLineInterface } from 'node:readline';
import { OpenAIResponsesAPIAdapter, type CredentialResolver } from '@animalabs/membrane';

type JsonObject = Record<string, unknown>;

interface RpcResponse {
  id?: number;
  method?: string;
  params?: JsonObject;
  result?: JsonObject;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve(value: JsonObject): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface NotificationWaiter {
  method: string;
  predicate?: (params: JsonObject) => boolean;
  resolve(params: JsonObject): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexAuthProvider {
  getAccessToken(forceRefresh?: boolean): Promise<string>;
  getAccountId?(): string | undefined;
  readRateLimits?(): Promise<unknown>;
  dispose?(): void;
}

export interface CodexAppServerAuthConfig {
  codexBinary?: string;
  codexHome?: string;
  loginTimeoutMs?: number;
  onLoginRequired?: (details: { verificationUrl: string; userCode: string }) => void;
}

/**
 * Minimal JSON-RPC client for the documented Codex app-server auth surface.
 * It forces file credential storage because the inference adapter needs to
 * read the refreshed access token; permissions on auth.json remain Codex's.
 */
export class CodexAppServerAuth implements CodexAuthProvider {
  private readonly codexBinary: string;
  private readonly codexHome: string;
  private readonly loginTimeoutMs: number;
  private readonly onLoginRequired: (details: { verificationUrl: string; userCode: string }) => void;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadLineInterface | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private waiters = new Set<NotificationWaiter>();
  private startPromise: Promise<void> | null = null;
  private authPromise: Promise<string> | null = null;
  private authIsRefresh = false;
  private stderrTail = '';
  private accountId: string | undefined;

  constructor(config: CodexAppServerAuthConfig = {}) {
    this.codexBinary = config.codexBinary ?? process.env.CODEX_BINARY ?? 'codex';
    this.codexHome = expandHome(config.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
    this.loginTimeoutMs = config.loginTimeoutMs ?? 10 * 60_000;
    this.onLoginRequired = config.onLoginRequired ?? (({ verificationUrl, userCode }) => {
      console.error('\nOpenAI Codex subscription login required.');
      console.error(`Open ${verificationUrl} and enter code: ${userCode}\n`);
    });
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    if (this.authPromise) {
      if (!forceRefresh || this.authIsRefresh) return this.authPromise;
      // A 401 refresh cannot be satisfied by an unrelated stale disk read.
      // Wait for it, then coalesce concurrent refresh callers onto one refresh.
      await this.authPromise.catch(() => {});
      return this.getAccessToken(true);
    }
    this.authIsRefresh = forceRefresh;
    this.authPromise = this.authenticate(forceRefresh).finally(() => {
      this.authPromise = null;
    });
    return this.authPromise;
  }

  getAccountId(): string | undefined {
    return this.accountId;
  }

  /** Raw `account/rateLimits/read` result — the subscription's utilization
   *  windows. Costs no inference; parsed by the quota meter. */
  async readRateLimits(): Promise<JsonObject> {
    await this.ensureStarted();
    return this.request('account/rateLimits/read', {});
  }

  dispose(): void {
    this.lines?.close();
    this.lines = null;
    this.child?.kill();
    this.child = null;
    const error = new Error('Codex app-server stopped');
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private async authenticate(forceRefresh: boolean): Promise<string> {
    await this.ensureStarted();
    let account = await this.readAccount(forceRefresh);

    if (account?.type !== 'chatgpt') {
      const login = await this.request('account/login/start', { type: 'chatgptDeviceCode' });
      const loginId = asString(login.loginId);
      const verificationUrl = asString(login.verificationUrl);
      const userCode = asString(login.userCode);
      if (!loginId || !verificationUrl || !userCode) {
        throw new Error('Codex app-server returned an incomplete device-code login response');
      }

      this.onLoginRequired({ verificationUrl, userCode });
      const completed = await this.waitForNotification(
        'account/login/completed',
        (params) => params.loginId === loginId,
        this.loginTimeoutMs,
      );
      if (completed.success !== true) {
        throw new Error(`OpenAI Codex login failed: ${asString(completed.error) || 'unknown error'}`);
      }
      account = await this.readAccount(true);
    }

    if (account?.type !== 'chatgpt') {
      throw new Error('OpenAI Codex subscription login did not produce a ChatGPT account');
    }
    return this.readAccessToken();
  }

  private async readAccount(refreshToken: boolean): Promise<JsonObject | null> {
    const result = await this.request('account/read', { refreshToken });
    const account = result.account;
    return account && typeof account === 'object' && !Array.isArray(account)
      ? account as JsonObject
      : null;
  }

  private async readAccessToken(): Promise<string> {
    const path = join(this.codexHome, 'auth.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      throw new Error(
        `Codex login succeeded but ${path} could not be read. ` +
        `Ensure cli_auth_credentials_store is set to \"file\".`,
        { cause: error },
      );
    }
    const root = parsed as { tokens?: { access_token?: unknown; account_id?: unknown } };
    const token = root?.tokens?.access_token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error(`Codex credential file ${path} does not contain tokens.access_token`);
    }
    this.accountId = typeof root.tokens?.account_id === 'string'
      ? root.tokens.account_id
      : undefined;
    return token;
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async start(): Promise<void> {
    const child = spawn(this.codexBinary, [
      'app-server',
      '--listen',
      'stdio://',
      '-c',
      'cli_auth_credentials_store="file"',
    ], {
      env: { ...process.env, CODEX_HOME: this.codexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    child.once('error', (error) => this.failAll(error));
    child.once('exit', (code, signal) => {
      const suffix = this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : '';
      this.failAll(new Error(`Codex app-server exited (${signal ?? code ?? 'unknown'})${suffix}`));
    });

    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', (line) => this.handleLine(line));

    await this.request('initialize', {
      clientInfo: {
        name: 'connectome_host',
        title: 'Connectome Host',
        version: '0.3.7',
      },
    });
    this.notify('initialized', {});
  }

  private request(method: string, params: JsonObject, timeoutMs = 30_000): Promise<JsonObject> {
    if (!this.child?.stdin.writable) {
      return Promise.reject(new Error('Codex app-server stdin is unavailable'));
    }
    const id = this.nextId++;
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  private notify(method: string, params: JsonObject): void {
    this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private waitForNotification(
    method: string,
    predicate?: (params: JsonObject) => boolean,
    timeoutMs = 30_000,
  ): Promise<JsonObject> {
    return new Promise<JsonObject>((resolve, reject) => {
      const waiter: NotificationWaiter = {
        method,
        predicate,
        resolve: (params) => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          resolve(params);
        },
        reject: (error) => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          reject(error);
        },
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Timed out waiting for Codex app-server notification: ${method}`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  private handleLine(line: string): void {
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(
          `Codex app-server error ${message.error.code ?? ''}: ${message.error.message ?? 'unknown error'}`,
        ));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (!message.method) return;
    const params = message.params ?? {};
    for (const waiter of [...this.waiters]) {
      if (waiter.method === message.method && (!waiter.predicate || waiter.predicate(params))) {
        waiter.resolve(params);
      }
    }
  }

  private failAll(error: Error): void {
    this.child = null;
    this.lines?.close();
    this.lines = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }
}

export interface CodexSubscriptionAdapterConfig extends CodexAppServerAuthConfig {
  authProvider?: CodexAuthProvider;
  baseURL?: string;
  fastMode?: boolean;
}

/** Host-owned login and disposal; all Responses transport behavior lives in Membrane. */
export class CodexSubscriptionAdapter extends OpenAIResponsesAPIAdapter {
  override readonly name = 'openai-codex';
  private readonly auth: CodexAuthProvider;

  constructor(config: CodexSubscriptionAdapterConfig = {}) {
    const auth = config.authProvider ?? new CodexAppServerAuth(config);
    const credentials: CredentialResolver = async ({ forceRefresh }) => {
      const token = await auth.getAccessToken(forceRefresh);
      const accountId = auth.getAccountId?.();
      return { token, headers: accountId ? { 'ChatGPT-Account-Id': accountId } : undefined };
    };
    super({
      mode: 'subscription',
      credentials,
      baseURL: config.baseURL ?? process.env.CODEX_BASE_URL,
      fastMode: config.fastMode,
      onFastModeFallback: (tier) => console.warn(
        `[openai-codex] Fast mode requested, but the service returned tier "${tier}". ` +
        'The current account or backend did not apply Fast mode.',
      ),
    });
    this.auth = auth;
  }

  /** Subscription utilization windows, or null when the auth provider has no
   *  such surface (tests inject bare token providers). */
  async readRateLimits(): Promise<unknown> {
    return this.auth.readRateLimits ? this.auth.readRateLimits() : null;
  }

  dispose(): void {
    this.auth.dispose?.();
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}
