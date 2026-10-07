// Provider-agnostic ProviderAdapter decorator that appends each LLM call's
// request, response, usage, timing, and any error to the same
// `llm-calls.<iso>.jsonl` file the Anthropic and Bedrock paths use.
//
// Exists because llm-call logging grew adapter-by-adapter (Anthropic subclass,
// Bedrock wrapper) and the remaining providers — openai-codex (Mica),
// openrouter (K3) — had NO wire visibility at all: a post-deploy "did her
// requests actually work?" check on Mica (2026-07-26) found zero llm-calls
// files because the codex path never logged. This decorator wraps ANY
// ProviderAdapter, so a new provider gets logging by construction rather than
// by remembering to build a logging twin.
//
// Contents: full raw request and a summarized-but-complete response record
// (stop reason, usage, per-block shape, full text) on every call, plus the
// raw provider response. Retention/rotation/S3 shipping is the host box's
// llm-logs sync job's problem — this file just writes lines.
//
// OOM note (learned on the Anthropic path, which once logged raw+normalized+
// summary and contributed to production OOMs): we serialize the record ONCE,
// and a size guard drops the raw bodies for pathological payloads (giant
// image batches) rather than buffering multi-hundred-MB lines.
//
// Decorator safety: adapters whose complete() internally delegates to their
// own stream() (codex does) self-call the INNER method, not the wrapper —
// each membrane-level call logs exactly once.
//
// Each line: { type: 'call'|'error', provider, kind: 'complete'|'stream',
//   timestamp, durationMs, requestSummary, response?, rawRequest?,
//   rawResponse?, error?, truncated? }

import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  ProviderRequestOptions,
  StreamCallbacks,
} from '@animalabs/membrane';
import { appendFileSync } from 'node:fs';

/** Above this many serialized bytes, drop raw bodies and keep summaries. */
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

function summarizeRequest(request: ProviderRequest): Record<string, unknown> {
  const msgs = (request.messages ?? []) as Array<{ role?: string; content?: unknown }>;
  const last = msgs[msgs.length - 1];
  const lastPreview = typeof last?.content === 'string'
    ? last.content.slice(0, 200)
    : Array.isArray(last?.content)
      ? (last.content as Array<{ type?: string; text?: string }>)
          .map((b) => (b.type === 'text' ? (b.text ?? '').slice(0, 120) : `[${b.type}]`))
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
    toolNames: (request.tools as Array<{ name?: string }> | undefined)?.map((t) => t.name) ?? null,
    toolCount: (request.tools as unknown[] | undefined)?.length ?? 0,
    lastMessageRole: last?.role,
    lastMessagePreview: lastPreview,
  };
}

function summarizeResponse(response: ProviderResponse, convention: ProviderAdapter['usageCacheConvention']): Record<string, unknown> {
  const content = (response.content ?? []) as Array<{ type?: string; text?: string; name?: string }>;
  return {
    stopReason: response.stopReason
      ?? (response.raw as { stop_reason?: string } | undefined)?.stop_reason
      ?? null,
    usage: response.usage ? { ...response.usage, cacheConvention: response.usage.cacheConvention ?? convention ?? 'unknown' } : null,
    blocks: content.map((b) => ({
      type: b.type,
      ...(b.type === 'text' ? { chars: (b.text ?? '').length, text: b.text } : {}),
      ...(b.type === 'tool_use' ? { name: b.name } : {}),
    })),
  };
}

export class LoggingProviderAdapter implements ProviderAdapter {
  readonly name: string;

  /** Credential-monitor taps (see LoggingAnthropicAdapter). */
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

  // Optional in newer membrane releases. Membrane's round reports rely on it:
  // a wrapper that dropped it would make every round's fidelity 'unknown'.
  // ProviderRequestOptions (with onContentAltered) pass through unchanged.
  get reportsContentAlterations(): boolean | undefined {
    return (this.inner as ProviderAdapter & {
      readonly reportsContentAlterations?: boolean;
    }).reportsContentAlterations;
  }

  // Optional in newer membrane releases; preserve the inner provider's media
  // policy without imposing it on older adapters that do not advertise one.
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
      let line = JSON.stringify(record);
      if (line.length > MAX_RECORD_BYTES) {
        const { rawRequest: _rq, rawResponse: _rr, ...rest } = record;
        line = JSON.stringify({ ...rest, truncated: 'raw bodies dropped (record exceeded size guard)' });
      }
      appendFileSync(this.logPath, line + '\n');
    } catch {
      // Logging must never break inference.
    }
  }

  private record(
    kind: 'complete' | 'stream',
    request: ProviderRequest,
    started: number,
    response?: ProviderResponse,
    error?: unknown,
  ): void {
    try {
      if (error !== undefined) this.onProviderError?.(error, kind);
      else this.onProviderSuccess?.(kind);
    } catch { /* observers never affect provider traffic */ }
    this.log({
      type: error === undefined ? 'call' : 'error',
      provider: this.name,
      kind,
      timestamp: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      requestSummary: summarizeRequest(request),
      rawRequest: request,
      ...(response !== undefined
        ? { response: summarizeResponse(response, this.usageCacheConvention), rawResponse: response.raw ?? null }
        : {}),
      ...(error !== undefined
        ? { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
        : {}),
    });
  }

  async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const started = Date.now();
    try {
      const response = await this.inner.complete(request, options);
      this.record('complete', request, started, response);
      return response;
    } catch (error) {
      this.record('complete', request, started, undefined, error);
      throw error;
    }
  }

  async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const started = Date.now();
    try {
      const response = await this.inner.stream(request, callbacks, options);
      this.record('stream', request, started, response);
      return response;
    } catch (error) {
      this.record('stream', request, started, undefined, error);
      throw error;
    }
  }
}
