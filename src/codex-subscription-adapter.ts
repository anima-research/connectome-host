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
import {
  MembraneError,
  authError,
  contextLengthError,
  networkError,
  rateLimitError,
  serverError,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderRequestOptions,
  type ProviderResponse,
  type StreamCallbacks,
} from '@animalabs/membrane';

type JsonObject = Record<string, unknown>;

interface CodexOutputItem extends JsonObject {
  type: string;
  id?: string;
}

interface CodexResponse extends JsonObject {
  model?: string;
  status?: string;
  output?: CodexOutputItem[];
  incomplete_details?: { reason?: string | null } | null;
  error?: { code?: string | null; message?: string | null } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number } | null;
  } | null;
}

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
    if (this.authPromise) return this.authPromise;
    this.authPromise = this.authenticate(forceRefresh).finally(() => {
      this.authPromise = null;
    });
    return this.authPromise;
  }

  getAccountId(): string | undefined {
    return this.accountId;
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

export class CodexSubscriptionAdapter implements ProviderAdapter {
  readonly name = 'openai-codex';
  private readonly auth: CodexAuthProvider;
  private readonly baseURL: string;
  private fastMode: boolean;
  private warnedFastFallback = false;

  constructor(config: CodexSubscriptionAdapterConfig = {}) {
    this.auth = config.authProvider ?? new CodexAppServerAuth(config);
    this.baseURL = (config.baseURL ?? process.env.CODEX_BASE_URL ?? 'https://chatgpt.com/backend-api/codex')
      .replace(/\/$/, '');
    this.fastMode = config.fastMode ?? false;
  }

  supportsModel(modelId: string): boolean {
    return modelId.startsWith('gpt-') || modelId.includes('codex');
  }

  isFastMode(): boolean {
    return this.fastMode;
  }

  setFastMode(enabled: boolean): void {
    this.fastMode = enabled;
  }

  dispose(): void {
    this.auth.dispose?.();
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    // The subscription endpoint requires SSE even for callers that want one
    // final response, so consume the stream silently and return its result.
    return this.stream(request, { onChunk: () => {} }, options);
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    let emitted = false;
    const wrappedCallbacks: StreamCallbacks = {
      ...callbacks,
      onChunk: (chunk) => {
        emitted = true;
        callbacks.onChunk(chunk);
      },
    };
    return this.withAuthRetry(
      (token) => this.streamWithToken(token, this.prepareRequest(request), wrappedCallbacks, options),
      () => !emitted,
    );
  }

  /** Codex subscription transport rejects API-only sampling/output controls. */
  private prepareRequest(request: ProviderRequest): ProviderRequest {
    return {
      ...request,
      temperature: undefined,
      topP: undefined,
      topK: undefined,
      extra: {
        ...request.extra,
        max_output_tokens: undefined,
        ...(this.fastMode ? { service_tier: 'priority' } : { service_tier: undefined }),
      },
    };
  }

  private async streamWithToken(
    accessToken: string,
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const rawRequest = this.buildRequest(request);
    options?.onRequest?.(rawRequest);
    const { signal, cleanup } = combinedSignal(options?.signal, options?.timeoutMs);

    try {
      const response = await fetch(`${this.baseURL}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...(this.auth.getAccountId?.() ? {
            'ChatGPT-Account-Id': this.auth.getAccountId!(),
          } : {}),
        },
        body: JSON.stringify(rawRequest),
        signal,
      });
      if (!response.ok) {
        const detail = await response.text();
        throw this.httpError(response.status, detail, rawRequest);
      }
      if (!response.body) throw networkError('Codex subscription response had no body', undefined, rawRequest);

      const output: CodexOutputItem[] = [];
      let terminal: CodexResponse | undefined;
      const parser = new CodexSseParser((event) => {
        const type = asString(event.type);
        const outputIndex = Number(event.output_index);
        if (type === 'response.output_text.delta') {
          const delta = asString(event.delta);
          if (delta) callbacks.onChunk(delta);
          applyTextDelta(output, outputIndex, event, delta);
        } else if (type === 'response.function_call_arguments.delta') {
          applyArgumentsDelta(output, outputIndex, asString(event.delta));
        } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
          if (Number.isInteger(outputIndex) && isObject(event.item)) {
            output[outputIndex] = event.item as CodexOutputItem;
          }
        } else if (type === 'response.completed' || type === 'response.incomplete') {
          if (isObject(event.response)) terminal = event.response as CodexResponse;
        } else if (type === 'response.failed') {
          const failed = isObject(event.response) ? event.response as CodexResponse : undefined;
          throw new Error(
            `Codex subscription response failed: ${failed?.error?.code ?? 'response_failed'} ` +
            `${failed?.error?.message ?? 'unknown error'}`,
          );
        } else if (type === 'error') {
          // The Codex backend uses both top-level `{ message, code }` errors
          // and Responses-style `{ error: { message, code, type } }` events.
          // Preserve the nested form so production failures remain actionable.
          const nested = isObject(event.error) ? event.error : undefined;
          const code = asString(event.code) || asString(nested?.code) || asString(nested?.type);
          const message = asString(event.message) || asString(nested?.message) || 'unknown error';
          throw new Error(`Codex subscription stream error${code ? ` (${code})` : ''}: ${message}`);
        }
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
      parser.finish();

      if (!terminal) {
        throw networkError('Codex subscription stream ended before a terminal event', undefined, rawRequest);
      }
      if (terminal.error) {
        throw new Error(
          `Codex subscription response error: ${terminal.error.code ?? 'api_error'} ` +
          `${terminal.error.message ?? 'unknown error'}`,
        );
      }

      // Codex commonly sends the authoritative items through
      // response.output_item.done and leaves response.completed.output empty.
      const terminalOutput = Array.isArray(terminal.output) && terminal.output.length > 0
        ? terminal.output
        : output.filter(Boolean);
      const content = outputToContent(terminalOutput);
      content.forEach((block, index) => callbacks.onContentBlock?.(index, block));
      const cachedTokens = terminal.usage?.input_tokens_details?.cached_tokens ?? 0;
      const returnedTier = asString(terminal.service_tier);
      if (rawRequest.service_tier === 'priority' && returnedTier && returnedTier !== 'priority' &&
          !this.warnedFastFallback) {
        this.warnedFastFallback = true;
        console.warn(
          `[openai-codex] Fast mode requested, but the service returned tier "${returnedTier}". ` +
          'The current account or backend did not apply Fast mode.',
        );
      }
      const stopReason = terminalOutput.some((item) => item.type === 'function_call')
        ? 'tool_use'
        : terminal.status === 'incomplete' && terminal.incomplete_details?.reason?.includes('max_output_tokens')
          ? 'max_tokens'
          : 'end_turn';
      const raw = { ...terminal, output: terminalOutput };

      return {
        content,
        stopReason,
        stopSequence: undefined,
        usage: {
          inputTokens: terminal.usage?.input_tokens ?? 0,
          outputTokens: terminal.usage?.output_tokens ?? 0,
          cacheReadTokens: cachedTokens > 0 ? cachedTokens : undefined,
        },
        model: terminal.model ?? request.model,
        rawRequest,
        raw,
      };
    } catch (error) {
      if (error instanceof MembraneError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw networkError('Codex subscription request aborted', error, rawRequest);
      }
      throw networkError(
        error instanceof Error ? error.message : 'Codex subscription request failed',
        error,
        rawRequest,
      );
    } finally {
      cleanup();
    }
  }

  private buildRequest(request: ProviderRequest): JsonObject {
    const include = Array.isArray(request.extra?.include)
      ? request.extra.include.filter((item): item is string => typeof item === 'string')
      : [];
    const raw: JsonObject = {
      model: request.model,
      input: request.messages,
      store: false,
      stream: true,
      include: include.includes('reasoning.encrypted_content')
        ? include
        : [...include, 'reasoning.encrypted_content'],
    };
    const instructions = flattenInstructions(request.system);
    if (instructions) raw.instructions = instructions;
    if (request.tools?.length) raw.tools = request.tools.map(convertTool);
    if (request.extra) {
      const {
        normalizedMessages,
        prompt,
        messages,
        input,
        store,
        stream,
        include: ignoredInclude,
        ...extra
      } = request.extra;
      void normalizedMessages;
      void prompt;
      void messages;
      void input;
      void store;
      void stream;
      void ignoredInclude;
      Object.assign(raw, extra);
    }
    raw.input = normalizeResponsesInput(request.messages);
    raw.store = false;
    raw.stream = true;
    raw.include = include.includes('reasoning.encrypted_content')
      ? include
      : [...include, 'reasoning.encrypted_content'];
    return raw;
  }

  private httpError(status: number, detail: string, rawRequest: unknown): MembraneError {
    const message = `Codex subscription API error: ${status} ${detail}`;
    if (status === 401 || status === 403) return authError(message, undefined, rawRequest);
    if (status === 429) return rateLimitError(message, undefined, undefined, rawRequest);
    if (status === 400 && /context|token limit|too long/i.test(detail)) {
      return contextLengthError(message, undefined, rawRequest);
    }
    if (status >= 500) return serverError(message, status, undefined, rawRequest);
    return new MembraneError({
      type: 'invalid_request',
      message,
      retryable: false,
      httpStatus: status,
      rawError: detail,
      rawRequest,
    });
  }

  private async withAuthRetry<T>(
    operation: (token: string) => Promise<T>,
    mayRetry: () => boolean = () => true,
  ): Promise<T> {
    const token = await this.auth.getAccessToken(false);
    try {
      return await operation(token);
    } catch (error) {
      if (!(error instanceof MembraneError) || error.type !== 'auth' || !mayRetry()) throw error;
      const refreshed = await this.auth.getAccessToken(true);
      return operation(refreshed);
    }
  }
}

/**
 * Most agent turns arrive already formatted as provider-native Responses
 * items. Internal maintenance calls, however, can bypass that formatter and
 * carry Membrane's normalized `text`/`image`/tool blocks. Normalize at the
 * final transport boundary so every call shape accepted by ProviderAdapter is
 * valid on the Codex Responses endpoint.
 */
function normalizeResponsesInput(messages: ProviderRequest['messages']): unknown[] {
  const output: unknown[] = [];

  for (const rawMessage of messages as unknown[]) {
    if (!isObject(rawMessage)) {
      output.push(rawMessage);
      continue;
    }
    if (rawMessage.type !== 'message' && rawMessage.role === undefined) {
      output.push(normalizeStandaloneItem(rawMessage));
      continue;
    }

    const role = rawMessage.role === 'assistant' ? 'assistant' : 'user';
    const blocks = Array.isArray(rawMessage.content)
      ? rawMessage.content
      : typeof rawMessage.content === 'string'
        ? [{ type: 'text', text: rawMessage.content }]
        : [];
    let parts: unknown[] = [];
    const flush = () => {
      if (parts.length === 0) return;
      output.push({
        type: 'message',
        ...(typeof rawMessage.id === 'string' ? { id: rawMessage.id } : {}),
        role,
        content: parts,
      });
      parts = [];
    };

    for (const rawBlock of blocks) {
      if (!isObject(rawBlock)) continue;
      if (rawBlock.type === 'text') {
        parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: asString(rawBlock.text) });
      } else if (rawBlock.type === 'image') {
        const imageUrl = responsesImageUrl(rawBlock);
        if (imageUrl && role !== 'assistant') parts.push({ type: 'input_image', image_url: imageUrl });
      } else if (rawBlock.type === 'tool_use') {
        flush();
        output.push(normalizeStandaloneItem(rawBlock));
      } else if (rawBlock.type === 'tool_result') {
        flush();
        output.push(normalizeStandaloneItem(rawBlock));
      } else if (rawBlock.type === 'redacted_thinking') {
        flush();
        output.push(reasoningInputItem(rawBlock));
      } else {
        // Already-native input_text/output_text/input_image/refusal parts.
        parts.push(rawBlock);
      }
    }
    flush();
  }

  return output;
}

function normalizeStandaloneItem(item: JsonObject): unknown {
  if (item.type === 'tool_use') {
    return {
      type: 'function_call',
      call_id: asString(item.id),
      name: asString(item.name),
      arguments: JSON.stringify(isObject(item.input) ? item.input : {}),
    };
  }
  if (item.type === 'tool_result') {
    const content = item.content;
    return {
      type: 'function_call_output',
      call_id: asString(item.toolUseId) || asString(item.tool_use_id),
      output: typeof content === 'string' ? content : JSON.stringify(content ?? null),
    };
  }
  if (item.type === 'redacted_thinking') {
    return reasoningInputItem(item);
  }
  return item;
}

/** Replay a captured reasoning carrier as a Responses input item.
 *
 * Prefer the provider-native item verbatim when the block still carries it
 * (`rawItem` from response parsing). Otherwise reconstruct the minimum the
 * Responses API accepts: `summary` is a REQUIRED field on reasoning input
 * items (empty array = "no summaries") — omitting it 400s with
 * "Missing required parameter: 'input[N].summary'". */
function reasoningInputItem(block: JsonObject): unknown {
  const raw = block.rawItem;
  if (isObject(raw) && raw.type === 'reasoning') return raw;
  return { type: 'reasoning', summary: [], encrypted_content: asString(block.data) };
}

function responsesImageUrl(block: JsonObject): string | undefined {
  const source = isObject(block.source) ? block.source : undefined;
  if (!source) return typeof block.image_url === 'string' ? block.image_url : undefined;
  if (source.type === 'url') return asString(source.url) || undefined;
  if (source.type !== 'base64') return undefined;
  const mediaType = asString(source.mediaType) || asString(source.media_type) || 'image/png';
  const data = asString(source.data);
  return data ? `data:${mediaType};base64,${data}` : undefined;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function flattenInstructions(system: ProviderRequest['system']): string | undefined {
  if (typeof system === 'string') return system || undefined;
  if (!Array.isArray(system)) return undefined;
  const text = system
    .map((block) => isObject(block) &&
      (block.type === 'text' || block.type === 'input_text') ? asString(block.text) : '')
    .filter(Boolean)
    .join('\n');
  return text || undefined;
}

function convertTool(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  if (raw.type === 'function' && typeof raw.name === 'string') return raw;
  if (raw.type === 'function' && isObject(raw.function)) {
    return { type: 'function', ...raw.function };
  }
  return {
    type: 'function',
    name: raw.name,
    description: raw.description,
    parameters: raw.parameters ?? raw.inputSchema ?? raw.input_schema ?? {
      type: 'object',
      properties: {},
    },
    ...(raw.strict !== undefined ? { strict: raw.strict } : {}),
  };
}

function applyTextDelta(
  output: CodexOutputItem[],
  outputIndex: number,
  event: JsonObject,
  delta: string,
): void {
  if (!Number.isInteger(outputIndex) || !delta) return;
  const contentIndex = Number.isInteger(Number(event.content_index)) ? Number(event.content_index) : 0;
  const existing = output[outputIndex];
  const message: CodexOutputItem = existing?.type === 'message'
    ? existing
    : {
        type: 'message',
        id: asString(event.item_id) || undefined,
        role: 'assistant',
        status: 'in_progress',
        content: [],
      };
  const content = Array.isArray(message.content) ? message.content as JsonObject[] : [];
  const part = isObject(content[contentIndex])
    ? content[contentIndex]
    : { type: 'output_text', text: '', annotations: [] };
  part.text = `${asString(part.text)}${delta}`;
  content[contentIndex] = part;
  message.content = content;
  output[outputIndex] = message;
}

function applyArgumentsDelta(output: CodexOutputItem[], outputIndex: number, delta: string): void {
  if (!Number.isInteger(outputIndex) || !delta) return;
  const item = output[outputIndex];
  if (item?.type === 'function_call') item.arguments = `${asString(item.arguments)}${delta}`;
}

function outputToContent(items: CodexOutputItem[]): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  items.forEach((item, outputIndex) => {
    if (item.type === 'message') {
      const parts = Array.isArray(item.content) ? item.content : [];
      parts.forEach((part, contentIndex) => {
        if (!isObject(part)) return;
        if (part.type === 'output_text' && typeof part.text === 'string') {
          content.push({
            type: 'text', text: part.text, itemId: item.id, outputIndex, contentIndex, rawItem: item,
          });
        } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
          content.push({
            type: 'text', text: part.refusal, itemId: item.id, outputIndex, contentIndex, rawItem: item,
          });
        }
      });
    } else if (item.type === 'reasoning') {
      if (typeof item.encrypted_content === 'string') {
        content.push({
          type: 'redacted_thinking', data: item.encrypted_content, itemId: item.id, outputIndex, rawItem: item,
        });
      } else {
        content.push({ type: 'thinking', thinking: '', itemId: item.id, outputIndex, rawItem: item });
      }
    } else if (item.type === 'function_call') {
      content.push({
        type: 'tool_use',
        id: typeof item.call_id === 'string' ? item.call_id : item.id ?? '',
        name: asString(item.name),
        input: safeJson(asString(item.arguments) || '{}'),
        itemId: item.id,
        outputIndex,
        rawItem: item,
      });
    } else if (item.type === 'function_call_output') {
      content.push({
        type: 'tool_result',
        toolUseId: asString(item.call_id),
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? null),
        itemId: item.id,
        outputIndex,
        rawItem: item,
      });
    } else {
      content.push({
        type: 'openai_response_item', itemId: item.id, itemType: item.type, outputIndex, rawItem: item,
      });
    }
  });
  return content;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function combinedSignal(
  external?: AbortSignal,
  timeoutMs?: number,
): { signal: AbortSignal | undefined; cleanup(): void } {
  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = controller && timeoutMs
    ? setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)
    : undefined;
  const signals = [external, controller?.signal].filter((signal): signal is AbortSignal => Boolean(signal));
  return {
    signal: signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    cleanup: () => { if (timer) clearTimeout(timer); },
  };
}

class CodexSseParser {
  private buffer = '';
  private data: string[] = [];

  constructor(private readonly onEvent: (event: JsonObject) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.processLine(line);
    }
  }

  finish(): void {
    if (this.buffer) this.processLine(this.buffer.replace(/\r$/, ''));
    this.buffer = '';
    this.emit();
  }

  private processLine(line: string): void {
    if (line === '') {
      this.emit();
    } else if (line.startsWith('data:')) {
      this.data.push(line.slice(5).replace(/^ /, ''));
    }
  }

  private emit(): void {
    if (this.data.length === 0) return;
    const raw = this.data.join('\n');
    this.data = [];
    if (raw === '[DONE]') return;
    const parsed = safeJson(raw);
    if (isObject(parsed)) this.onEvent(parsed);
  }
}
