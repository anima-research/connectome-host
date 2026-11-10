// Provider-agnostic ProviderAdapter decorator that appends each LLM call's
// request, response, usage, timing, and any error to the same
// `llm-calls.<iso>.jsonl` file the Anthropic and Bedrock paths use.
//
// Contents: a request summary and a summarized-but-complete response record
// (stop reason, usage, per-block shape, full text) on every call, plus the
// raw provider response. The raw request is kept:
//   - on every failure that isn't a cancellation (membrane's `abort`), each
//     retry attempt included: unlike the Anthropic writer, this wrapper
//     keeps no run of failures per lineage, dedups nothing by hash and has
//     no copy budget, so a host whose calls fail repeatedly writes the full
//     request once per attempt (#341 keeps the shared policy as a follow-up);
//   - on a refusal, and on an anomalous response (responseAnomaly, and on
//     the Responses path a tool call the provider cut off: cutOffToolCall);
//   - on every call, cancellations included, with LLM_CALLS_FULL_PAYLOADS=1.
// On the OpenAI Responses path a request carries the whole compiled context,
// so keeping it on every success put ~3 MB per call into the file whose last
// ~64 MiB /bug reads on these hosts (#341); the call ledger reads the file
// only on an Anthropic host, so these rows reach it only if the data
// directory is later served by one.
//
// Each line: { type: 'call'|'error', provider, kind: 'complete'|'stream',
//   timestamp, durationMs, requestSummary?, response?, rawRequest?,
//   rawResponse?, error?, errorType?, httpStatus?, providerErrorCode?,
//   retryable?, errorChars?, truncated?, summaryUnavailable? }
// A record whose request or response couldn't be summarized keeps only the
// head fields and, for a failure, the error (summaryUnavailable: true).
//
// The error text is bounded: a provider can echo the whole rejected request
// in its error body.

import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  ProviderRequestOptions,
  StreamCallbacks,
} from '@animalabs/membrane';
import { appendFileSync } from 'node:fs';
import { summarizeCacheControls } from './call-ledger.js';
import { envFlag, responseAnomaly } from './logging-adapter.js';
import { describeError } from './logging-error-fields.js';
import { serializeRecord } from './logging-record.js';

function summarizeRequest(request: ProviderRequest): Record<string, unknown> {
  const msgs = (request.messages ?? []) as Array<{ role?: string; content?: unknown }>;
  const last = msgs[msgs.length - 1];
  const lastPreview = typeof last?.content === 'string'
    ? last.content.slice(0, 200)
    : Array.isArray(last?.content)
      ? (last.content as Array<{ type?: string; text?: string } | null>)
          .map((b) => (b?.type === 'text' ? (b.text ?? '').slice(0, 120) : `[${b?.type}]`))
          .join(' | ').slice(0, 300)
      : undefined;
  // The ledger reads cache flags from the summary first and from the raw
  // request only as a fallback, and counts `messages`; both are here so a
  // record without its raw request restores as it did with it. The cache
  // walk visits the whole request, so a request it can't walk (a cycle)
  // keeps the rest of its summary and no cache fields.
  let cache: { count: number; ttls: string[] } | undefined;
  try { cache = summarizeCacheControls(request); } catch { cache = undefined; }
  return {
    model: request.model,
    maxTokens: request.maxTokens,
    messageCount: msgs.length,
    messages: msgs.length,
    ...(cache ? { cacheBreakpoints: cache.count, cacheTtls: cache.ttls } : {}),
    systemChars: typeof request.system === 'string'
      ? request.system.length
      : Array.isArray(request.system)
        ? JSON.stringify(request.system).length
        : 0,
    toolNames: (request.tools as Array<{ name?: string } | null> | undefined)?.map((t) => t?.name) ?? null,
    toolCount: (request.tools as unknown[] | undefined)?.length ?? 0,
    lastMessageRole: last?.role,
    lastMessagePreview: lastPreview,
  };
}

function summarizeResponse(response: ProviderResponse, convention: ProviderAdapter['usageCacheConvention']): Record<string, unknown> {
  const content = (response.content ?? []) as Array<{ type?: string; text?: string; name?: string } | null>;
  return {
    stopReason: response.stopReason
      ?? (response.raw as { stop_reason?: string } | undefined)?.stop_reason
      ?? null,
    usage: response.usage ? { ...response.usage, cacheConvention: response.usage.cacheConvention ?? convention ?? 'unknown' } : null,
    blocks: content.map((b) => ({
      type: b?.type,
      ...(b?.type === 'text' ? { chars: (b.text ?? '').length, text: b.text } : {}),
      ...(b?.type === 'tool_use' ? { name: b.name } : {}),
    })),
  };
}

/** A response the provider ended as a refusal, by membrane's stop reason or the raw one. */
function isRefusal(response: ProviderResponse): boolean {
  const raw = (response as { raw?: { stop_reason?: unknown } | null }).raw;
  return response.stopReason === 'refusal' || raw?.stop_reason === 'refusal';
}

/**
 * A tool call the provider cut off, which responseAnomaly can't see on the
 * Responses path: membrane reports `tool_use` whenever the output holds a
 * function_call, before it reads `status: 'incomplete'`, so the cut
 * survives only as the response's `status` (and `incomplete_details`) or
 * as a tool_use block whose arguments didn't parse (`unparseableInput`).
 * Provider-agnostic: either sign counts, on any adapter.
 */
function cutOffToolCall(response: ProviderResponse): Record<string, unknown> | undefined {
  const r = response as {
    content?: unknown;
    providerStopReason?: unknown;
    raw?: { status?: unknown; incomplete_details?: { reason?: unknown } | null } | null;
  };
  const blocks = Array.isArray(r.content) ? r.content as Array<{ type?: unknown; name?: unknown; unparseableInput?: unknown } | null> : [];
  const tools = blocks.filter((b) => !!b && typeof b === 'object' && b.type === 'tool_use');
  if (tools.length === 0) return undefined;
  const unparseable = tools.filter((b) => b!.unparseableInput !== undefined).map((b) => (typeof b!.name === 'string' ? b!.name : '?'));
  const raw = r.raw && typeof r.raw === 'object' ? r.raw : undefined;
  const incomplete = raw?.status === 'incomplete';
  if (unparseable.length === 0 && !incomplete) return undefined;
  return {
    kind: 'tool_use_cut_off',
    toolNames: tools.map((b) => (typeof b!.name === 'string' ? b!.name : '?')),
    ...(unparseable.length > 0 ? { unparseableInput: unparseable } : {}),
    ...(incomplete ? { status: 'incomplete', reason: typeof raw?.incomplete_details?.reason === 'string' ? raw.incomplete_details.reason : null } : {}),
    ...('providerStopReason' in r ? { providerStopReason: typeof r.providerStopReason === 'string' ? r.providerStopReason : null } : {}),
  };
}

export class LoggingProviderAdapter implements ProviderAdapter {
  readonly name: string;

  onProviderError?: (error: unknown, kind: 'complete' | 'stream') => void;
  onProviderSuccess?: (kind: 'complete' | 'stream') => void;

  /** Keep the raw request on successful calls too. Off unless the constructor
   *  says otherwise or LLM_CALLS_FULL_PAYLOADS is set to 1/true; read once. */
  private readonly fullPayloads: boolean;

  constructor(
    private readonly inner: ProviderAdapter,
    private readonly logPath: string,
    options: { fullPayloads?: boolean } = {},
  ) {
    this.name = inner.name;
    this.fullPayloads = options.fullPayloads ?? envFlag(process.env.LLM_CALLS_FULL_PAYLOADS);
  }

  get usageCacheConvention(): ProviderAdapter['usageCacheConvention'] {
    return this.inner.usageCacheConvention;
  }

  get requiresNativeResponsesInput(): ProviderAdapter['requiresNativeResponsesInput'] {
    return this.inner.requiresNativeResponsesInput;
  }

  get toolResultImageMediaTypes(): ReadonlySet<string> | undefined {
    return (this.inner as ProviderAdapter & {
      readonly toolResultImageMediaTypes?: ReadonlySet<string>;
    }).toolResultImageMediaTypes;
  }

  supportsModel(modelId: string): boolean {
    return this.inner.supportsModel(modelId);
  }

  private log(record: Record<string, unknown>): void {
    try {
      appendFileSync(this.logPath, serializeRecord(record));
    } catch {
    }
  }

  private record(
    kind: 'complete' | 'stream',
    request: ProviderRequest,
    started: number,
    outcome: { response: ProviderResponse } | { error: unknown },
  ): void {
    const failed = 'error' in outcome;
    try {
      if (failed) this.onProviderError?.(outcome.error, kind);
      else this.onProviderSuccess?.(kind);
    } catch { }
    const head = {
      type: failed ? 'error' : 'call',
      provider: this.name,
      kind,
      timestamp: new Date(started).toISOString(),
      durationMs: Date.now() - started,
    };
    let record: Record<string, unknown>;
    try {
      const errorFields = failed ? describeError(outcome.error) : undefined;
      const anomaly = failed ? undefined : (responseAnomaly(outcome.response) ?? cutOffToolCall(outcome.response));
      // Which calls keep the raw request (the header has the rule): every
      // failure except a cancellation (membrane types it `abort`), which is
      // never the request's doing; a refusal; an anomalous response; and,
      // with the opt-in, every call, cancellations included, as the
      // Anthropic writer's opt-in keeps them.
      const keepRaw = this.fullPayloads
        || (failed ? errorFields?.errorType !== 'abort' : anomaly !== undefined || isRefusal(outcome.response));
      record = {
        ...head,
        requestSummary: summarizeRequest(request),
        ...(keepRaw ? { rawRequest: request } : {}),
        ...('response' in outcome
          ? { response: summarizeResponse(outcome.response, this.usageCacheConvention), rawResponse: outcome.response.raw ?? null }
          : {}),
        ...(anomaly ? { anomaly } : {}),
        ...(errorFields ?? {}),
      };
    } catch {
      record = { ...head, summaryUnavailable: true, ...(failed ? describeError(outcome.error) : {}) };
    }
    this.log(record);
  }

  private recordSafely(
    kind: 'complete' | 'stream',
    request: ProviderRequest,
    started: number,
    outcome: { response: ProviderResponse } | { error: unknown },
  ): void {
    try {
      this.record(kind, request, started, outcome);
    } catch {
    }
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const started = Date.now();
    let response: ProviderResponse;
    try {
      response = await this.inner.complete(request, options);
    } catch (error) {
      this.recordSafely('complete', request, started, { error });
      throw error;
    }
    this.recordSafely('complete', request, started, { response });
    return response;
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const started = Date.now();
    let response: ProviderResponse;
    try {
      response = await this.inner.stream(request, callbacks, options);
    } catch (error) {
      this.recordSafely('stream', request, started, { error });
      throw error;
    }
    this.recordSafely('stream', request, started, { response });
    return response;
  }
}
