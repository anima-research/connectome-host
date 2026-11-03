// Provider-agnostic ProviderAdapter decorator that appends each LLM call's
// request, response, usage, timing, and any error to the same
// `llm-calls.<iso>.jsonl` file the Anthropic and Bedrock paths use.
//
// Contents: full raw request and a summarized-but-complete response record
// (stop reason, usage, per-block shape, full text) on every call, plus the
// raw provider response.
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
  return {
    model: request.model,
    maxTokens: request.maxTokens,
    messageCount: msgs.length,
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

export class LoggingProviderAdapter implements ProviderAdapter {
  readonly name: string;

  onProviderError?: (error: unknown, kind: 'complete' | 'stream') => void;
  onProviderSuccess?: (kind: 'complete' | 'stream') => void;

  constructor(
    private readonly inner: ProviderAdapter,
    private readonly logPath: string,
  ) {
    this.name = inner.name;
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
      record = {
        ...head,
        requestSummary: summarizeRequest(request),
        rawRequest: request,
        ...('response' in outcome
          ? { response: summarizeResponse(outcome.response, this.usageCacheConvention), rawResponse: outcome.response.raw ?? null }
          : {}),
        ...(failed ? describeError(outcome.error) : {}),
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
