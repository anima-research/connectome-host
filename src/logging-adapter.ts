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
import { appendFileSync } from 'node:fs';

/** Live read of the current reasoning setting. The host wires this to
 *  `SettingsModule.getReasoning()` so toggles via the `settings--reasoning_*`
 *  tools take effect on the next call without restart. */
export type ReasoningGetter = () => { enabled: boolean; budgetTokens: number };

export class LoggingAnthropicAdapter extends AnthropicAdapter {
  private readonly logPath: string;
  private readonly getReasoning?: ReasoningGetter;

  constructor(
    config: ConstructorParameters<typeof AnthropicAdapter>[0],
    logPath: string,
    getReasoning?: ReasoningGetter,
  ) {
    super(config);
    this.logPath = logPath;
    this.getReasoning = getReasoning;
  }

  /** If reasoning is enabled, inject `thinking` into the request before the
   *  adapter builds the Anthropic payload. AnthropicAdapter.buildRequest only
   *  sets `params.thinking` if `request.thinking` is truthy, so this is the
   *  hook point. We mutate a shallow clone to avoid surprising callers. */
  private withReasoning(request: ProviderRequest): ProviderRequest {
    const r = this.getReasoning?.();
    if (!r || !r.enabled) return request;
    return {
      ...request,
      thinking: { type: 'enabled', budget_tokens: r.budgetTokens },
    } as ProviderRequest;
  }

  private log(record: Record<string, unknown>): void {
    try {
      appendFileSync(this.logPath, JSON.stringify(record) + '\n');
    } catch {
      // never throw from logging
    }
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
