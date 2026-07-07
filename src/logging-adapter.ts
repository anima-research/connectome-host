// AnthropicAdapter wrapper that appends each LLM call's RAW request, RAW
// response, and any error to a JSONL log file. Restores the Hermes-era
// `llm-calls.<iso>.jsonl` visibility we lose on the connectome stack by
// default.
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
//     rawRequest, rawResponse, normalizedRequest, normalizedResponse }

import { AnthropicAdapter } from '@animalabs/membrane';
import type {
  ProviderRequest,
  ProviderResponse,
  ProviderRequestOptions,
  StreamCallbacks,
} from '@animalabs/membrane';
import { appendFileSync, renameSync, statSync } from 'node:fs';

/** Live read of the current reasoning setting. The host wires this to
 *  `SettingsModule.getReasoning()` so toggles via the `settings--reasoning_*`
 *  tools take effect on the next call without restart. */
export type ReasoningGetter = () => { enabled: boolean; budgetTokens: number };

/** Default cap before the log rolls to `<path>.1` (matching the
 *  mcpl-stderr log's rotation in index.ts). Full request+response per call
 *  at ~100k-token contexts is multiple MB per line — without rotation a
 *  busy day is tens of GB (audit 6.4). */
export const LLM_LOG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Size-capped JSONL sink: appends one JSON object per line, rolling the
 * file to `<path>.1` (replacing any previous `.1`) when the next entry
 * would push it past `maxBytes`. Never throws — logging must not be
 * load-bearing.
 */
export class RotatingJsonlLog {
  /** Bytes currently in the file; -1 = not yet measured (lazy statSync). */
  private size = -1;

  constructor(
    private readonly path: string,
    private readonly maxBytes: number = LLM_LOG_MAX_BYTES,
  ) {}

  append(record: Record<string, unknown>): void {
    try {
      const entry = JSON.stringify(record) + '\n';
      if (this.size < 0) {
        try { this.size = statSync(this.path).size; } catch { this.size = 0; }
      }
      if (this.size + entry.length > this.maxBytes && this.size > 0) {
        try { renameSync(this.path, `${this.path}.1`); } catch { /* keep appending to the same file */ }
        this.size = 0;
      }
      appendFileSync(this.path, entry);
      this.size += entry.length;
    } catch {
      // never throw from logging
    }
  }
}

export class LoggingAnthropicAdapter extends AnthropicAdapter {
  private readonly sink: RotatingJsonlLog;
  private readonly getReasoning?: ReasoningGetter;

  constructor(
    config: ConstructorParameters<typeof AnthropicAdapter>[0],
    logPath: string,
    getReasoning?: ReasoningGetter,
    maxLogBytes: number = LLM_LOG_MAX_BYTES,
  ) {
    super(config);
    this.sink = new RotatingJsonlLog(logPath, maxLogBytes);
    this.getReasoning = getReasoning;
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
    this.sink.append(record);
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
    const effective = this.withReasoning(request);
    const sink: { rawRequest: unknown } = { rawRequest: null };
    const wrapped = this.captureRawRequest(options, sink);
    try {
      const response = await super.complete(effective, wrapped);
      this.log({
        type: 'call', kind: 'complete',
        timestamp: new Date().toISOString(), durationMs: Date.now() - t0,
        rawRequest: sink.rawRequest,
        rawResponse: (response as { raw?: unknown }).raw ?? null,
        normalizedRequest: request,
        normalizedResponse: response,
      });
      return response;
    } catch (err) {
      this.log({
        type: 'error', kind: 'complete',
        timestamp: new Date().toISOString(), durationMs: Date.now() - t0,
        rawRequest: sink.rawRequest,
        normalizedRequest: request,
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      });
      throw err;
    }
  }

  override async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const t0 = Date.now();
    const effective = this.withReasoning(request);
    const sink: { rawRequest: unknown } = { rawRequest: null };
    const wrapped = this.captureRawRequest(options, sink);
    try {
      const response = await super.stream(effective, callbacks, wrapped);
      this.log({
        type: 'call', kind: 'stream',
        timestamp: new Date().toISOString(), durationMs: Date.now() - t0,
        rawRequest: sink.rawRequest,
        rawResponse: (response as { raw?: unknown }).raw ?? null,
        normalizedRequest: request,
        normalizedResponse: response,
      });
      return response;
    } catch (err) {
      this.log({
        type: 'error', kind: 'stream',
        timestamp: new Date().toISOString(), durationMs: Date.now() - t0,
        rawRequest: sink.rawRequest,
        normalizedRequest: request,
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      });
      throw err;
    }
  }
}
