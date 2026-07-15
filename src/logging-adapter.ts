// AnthropicAdapter wrapper that appends each LLM call's RAW request, RAW
// response, and any error to a JSONL log file. Restores the Hermes-era
// `llm-calls.<iso>.jsonl` visibility we lose on the connectome stack by
// default. Successful calls keep a compact request summary; the full raw
// request is retained only for refusals and errors, where forensic inspection
// matters. Serializing the full raw + normalized request on every tool-loop
// turn previously created several simultaneous copies of a large context and
// contributed to production OOMs.
//
// "Raw" means the actual Anthropic API payload (post-buildRequest, including
// `thinking`, tool definitions in Anthropic shape, etc.) and the raw provider
// response — not the membrane-normalized intermediate. We hook the membrane's
// `options.onRequest` callback (called inside anthropic.ts with the built
// request) and read `ProviderResponse.raw` for the response. Normalized
// representations are kept under separate keys for occasional cross-reference.
//
// One file per process lifetime (timestamped at construction). Each line is a
// JSON object with shape:
//   { type: 'call'|'error', kind: 'complete'|'stream', timestamp, durationMs,
//     requestSummary, rawRequest?, rawResponse, error? }

import { AnthropicAdapter } from '@animalabs/membrane';
import type {
  ProviderRequest,
  ProviderResponse,
  ProviderRequestOptions,
  StreamCallbacks,
} from '@animalabs/membrane';
import { appendFileSync } from 'node:fs';
import { summarizeCacheControls, type ProviderCallRecord } from './call-ledger.js';

/** Live read of the current reasoning setting. The host wires this to
 *  `SettingsModule.getReasoning()` so toggles via the `settings--reasoning_*`
 *  tools take effect on the next call without restart. */
export type ReasoningGetter = () => { enabled: boolean; budgetTokens: number };
export type ProviderCallObserver = (record: ProviderCallRecord) => void;

/** Exact first-system-block identity Anthropic requires on subscription
 *  (sk-ant-oat…) OAuth traffic. Verified 2026-07-09: any other first block —
 *  including this text with a suffix appended in the SAME block — is rejected
 *  with a masked 429 rate_limit_error; this block followed by arbitrary
 *  persona blocks is accepted (the mechanism the Agent SDK's
 *  system-prompt-append uses). */
const OAUTH_SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export class LoggingAnthropicAdapter extends AnthropicAdapter {
  private readonly logPath: string;
  private readonly getReasoning?: ReasoningGetter;
  private readonly onCall?: ProviderCallObserver;
  /** True when authenticated with an OAuth/Bearer token instead of an API
   *  key; requests then need the identity block prepended (see above). */
  private readonly oauthMode: boolean;

  constructor(
    config: ConstructorParameters<typeof AnthropicAdapter>[0],
    logPath: string,
    getReasoning?: ReasoningGetter,
    onCall?: ProviderCallObserver,
  ) {
    super(config);
    this.logPath = logPath;
    this.getReasoning = getReasoning;
    this.onCall = onCall;
    this.oauthMode = Boolean(config?.authToken);
  }

  /** Under OAuth subscription auth, prepend the required identity block to the
   *  system prompt (converting a string system to blocks). No-op under API-key
   *  auth or when the identity block is already first. The block is plain
   *  (no cache_control) and a stable prefix, so caching is unaffected. */
  private withOAuthIdentity(request: ProviderRequest): ProviderRequest {
    if (!this.oauthMode) return request;
    const sys = request.system;
    const blocks: unknown[] =
      typeof sys === 'string' && sys.length > 0
        ? [{ type: 'text', text: sys }]
        : Array.isArray(sys) ? sys : [];
    const first = blocks[0] as { type?: string; text?: string } | undefined;
    if (first?.type === 'text' && first.text === OAUTH_SYSTEM_IDENTITY) return request;
    return {
      ...request,
      system: [{ type: 'text', text: OAUTH_SYSTEM_IDENTITY }, ...blocks],
    };
  }

  /** If reasoning is enabled, inject `thinking` into the request before the
   *  adapter builds the Anthropic payload. The Anthropic adapter forwards
   *  provider-specific params carried in `request.extra`, so that's the hook
   *  point. We return a shallow clone to avoid surprising callers. */
  private withReasoning(request: ProviderRequest): ProviderRequest {
    const r = this.getReasoning?.();
    if (!r || !r.enabled) return request;
    // Use ADAPTIVE thinking, not the legacy { type:'enabled', budget_tokens }
    // form. Current Anthropic models (opus-4-6/4-7/4-8, …) reject the legacy
    // form with: `"thinking.type.enabled" is not supported for this model.
    // Use "thinking.type.adaptive"`. Under adaptive the model sizes its own
    // thinking, so `budgetTokens` is no longer sent (it still shows in
    // reasoning_status as an informational hint).
    //
    // membrane's `ProviderRequest` doesn't type a top-level `thinking` field
    // (membrane is 0.5.68 — agent-framework is the package that went 0.6.0;
    // the old `as … ProviderRequest['thinking']` cast only ever compiled via a
    // stale nested membrane copy that lockfile dedup removed). But the Anthropic
    // adapter applies `request.extra` to the API params verbatim
    // (`complete()`: `const { normalizedMessages, prompt, ...rest } =
    // request.extra; Object.assign(params, rest)`), so we route thinking
    // through the typed `extra` bag — no type assertion, and it survives the
    // next dependency reshuffle instead of hiding it from the compiler.
    return {
      ...request,
      extra: { ...request.extra, thinking: { type: 'adaptive' } },
    };
  }

  private log(record: Record<string, unknown>): void {
    try {
      appendFileSync(this.logPath, JSON.stringify(record) + '\n');
    } catch {
      // never throw from logging
    }
  }

  private requestSummary(request: ProviderRequest, rawRequest?: unknown): Record<string, unknown> {
    const cache = rawRequest ? summarizeCacheControls(rawRequest) : undefined;
    return {
      model: request.model,
      maxTokens: request.maxTokens,
      messages: request.messages.length,
      tools: request.tools?.length ?? 0,
      ...(cache ? { cacheBreakpoints: cache.count, cacheTtls: cache.ttls } : {}),
    };
  }

  /**
   * Off-path refusal dragnet (observability M3). The main inference driver
   * instruments its own refusals (agent-framework noteRefusal), but that
   * covers ONLY streamed agent turns. Every other model call in the process
   * — compression/summarizer drains, maintenance — flows through this
   * adapter's complete() and previously refused in silence; the 2026-07-15
   * mythos cascade STARTED there and alerted nowhere. Fired for
   * kind==='complete' only: agent turns stream, so this never double-reports
   * a refusal the main driver already escalated.
   */
  onRefusal?: (info: {
    kind: 'complete' | 'stream';
    category?: string;
    model: string;
    messages: number;
    inputTokens: number;
  }) => void;

  private observeCall(
    kind: 'complete' | 'stream',
    timestamp: string,
    durationMs: number,
    request: ProviderRequest,
    rawRequest: unknown,
    response?: ProviderResponse,
    error?: unknown,
  ): void {
    const raw0 = (response as { raw?: { stop_reason?: string; stop_details?: { category?: string } } } | undefined)?.raw;
    if (kind === 'complete' && raw0?.stop_reason === 'refusal' && this.onRefusal) {
      try {
        this.onRefusal({
          kind,
          category: raw0.stop_details?.category,
          model: request.model,
          messages: request.messages.length,
          inputTokens: response?.usage.inputTokens ?? 0,
        });
      } catch { /* observers never affect provider traffic */ }
    }
    if (!this.onCall) return;
    const cache = summarizeCacheControls(rawRequest);
    const raw = (response as { raw?: Record<string, unknown> } | undefined)?.raw;
    const rawUsage = raw?.usage as Record<string, unknown> | undefined;
    const cacheCreation = rawUsage?.cache_creation as Record<string, unknown> | undefined;
    const finite = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    const text = (value: unknown): string | undefined =>
      typeof value === 'string' && value.length > 0 ? value : undefined;
    try {
      this.onCall({
        timestamp,
        kind,
        durationMs,
        model: request.model,
        messages: request.messages.length,
        inputTokens: response?.usage.inputTokens ?? 0,
        outputTokens: response?.usage.outputTokens ?? 0,
        cacheReadTokens: response?.usage.cacheReadTokens ?? 0,
        cacheWriteTokens: response?.usage.cacheCreationTokens ?? 0,
        cacheWrite5mTokens: finite(cacheCreation?.ephemeral_5m_input_tokens),
        cacheWrite1hTokens: finite(cacheCreation?.ephemeral_1h_input_tokens),
        cacheWriteBucketsAuthoritative: cacheCreation !== undefined,
        inferenceGeo: text(rawUsage?.inference_geo) ?? text(raw?.inference_geo),
        serviceTier: text(rawUsage?.service_tier) ?? text(raw?.service_tier),
        cacheBreakpoints: cache.count,
        cacheTtls: cache.ttls,
        stopReason: response?.stopReason,
        error: error instanceof Error ? error.message : error ? String(error) : undefined,
      });
    } catch {
      // A dashboard observer is never allowed to affect provider traffic.
    }
  }

  private refusalRawRequest(response: ProviderResponse, rawRequest: unknown): unknown {
    const raw = (response as { raw?: { stop_reason?: string } }).raw;
    return raw?.stop_reason === 'refusal' ? rawRequest : undefined;
  }

  /** Wrap options to capture the raw provider request via the membrane
   *  onRequest hook, then chain to any caller-supplied onRequest. */
  private captureRawRequest(
    options: ProviderRequestOptions | undefined,
    sink: { rawRequest: unknown },
  ): ProviderRequestOptions {
    const callerOnRequest = options?.onRequest;
    return {
      ...options,
      onRequest: (req: unknown) => {
        sink.rawRequest = req;
        try { callerOnRequest?.(req as never); } catch { /* never block on caller hook */ }
      },
    } as ProviderRequestOptions;
  }

  override async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const t0 = Date.now();
    const effective = this.withOAuthIdentity(this.withReasoning(request));
    const sink: { rawRequest: unknown } = { rawRequest: null };
    const wrapped = this.captureRawRequest(options, sink);
    try {
      const response = await super.complete(effective, wrapped);
      const timestamp = new Date().toISOString();
      const durationMs = Date.now() - t0;
      this.log({
        type: 'call', kind: 'complete',
        timestamp, durationMs,
        requestSummary: this.requestSummary(request, sink.rawRequest),
        rawRequest: this.refusalRawRequest(response, sink.rawRequest),
        rawResponse: (response as { raw?: unknown }).raw ?? null,
      });
      this.observeCall('complete', timestamp, durationMs, request, sink.rawRequest, response);
      return response;
    } catch (err) {
      const timestamp = new Date().toISOString();
      const durationMs = Date.now() - t0;
      this.log({
        type: 'error', kind: 'complete',
        timestamp, durationMs,
        requestSummary: this.requestSummary(request, sink.rawRequest),
        rawRequest: sink.rawRequest,
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      });
      this.observeCall('complete', timestamp, durationMs, request, sink.rawRequest, undefined, err);
      throw err;
    }
  }

  override async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const t0 = Date.now();
    const effective = this.withOAuthIdentity(this.withReasoning(request));
    const sink: { rawRequest: unknown } = { rawRequest: null };
    const wrapped = this.captureRawRequest(options, sink);
    try {
      const response = await super.stream(effective, callbacks, wrapped);
      const timestamp = new Date().toISOString();
      const durationMs = Date.now() - t0;
      this.log({
        type: 'call', kind: 'stream',
        timestamp, durationMs,
        requestSummary: this.requestSummary(request, sink.rawRequest),
        rawRequest: this.refusalRawRequest(response, sink.rawRequest),
        rawResponse: (response as { raw?: unknown }).raw ?? null,
      });
      this.observeCall('stream', timestamp, durationMs, request, sink.rawRequest, response);
      return response;
    } catch (err) {
      const timestamp = new Date().toISOString();
      const durationMs = Date.now() - t0;
      this.log({
        type: 'error', kind: 'stream',
        timestamp, durationMs,
        requestSummary: this.requestSummary(request, sink.rawRequest),
        rawRequest: sink.rawRequest,
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      });
      this.observeCall('stream', timestamp, durationMs, request, sink.rawRequest, undefined, err);
      throw err;
    }
  }
}
