// BedrockAdapter wrapper that appends each LLM call's request summary, stop
// reason, and any error to the same `llm-calls.<iso>.jsonl` file the
// Anthropic path uses. Request summaries always include tool NAMES,
// message/system sizes, and the stop sequences; the full raw request is
// retained only on errors. Responses log stop_reason, usage, and
// content-block shape (type + size per block) on every call.
//
// Each line: { type: 'call'|'error', kind: 'complete'|'stream', timestamp,
//   durationMs, requestSummary, response?, rawRequest?, error?, errorType?,
//   httpStatus?, providerErrorCode?, retryable?, errorChars?, truncated? }
// A failure's `error` is { name, message } with its text bounded, or a
// non-Error's text. A record whose request or response couldn't be
// summarized keeps only the head fields and, for a failure, the error
// (summaryUnavailable: true). Every line, newline included, stays within the
// shared 16 MiB UTF-8 cap: an oversized or unserializable record drops the
// raw request first, then its summaries (`truncated` says what was dropped).

import { BedrockAdapter } from '@animalabs/membrane';
import type {
  ProviderRequest,
  ProviderResponse,
  ProviderRequestOptions,
  StreamCallbacks,
} from '@animalabs/membrane';
import { appendFileSync } from 'node:fs';
import { describeErrorObject } from './logging-error-fields.js';
import { serializeRecord } from './logging-record.js';

type BedrockConfig = ConstructorParameters<typeof BedrockAdapter>[0];

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
    stopSequences: request.stopSequences ?? null,
    lastMessageRole: last?.role,
    lastMessagePreview: lastPreview,
  };
}

function summarizeResponse(response: ProviderResponse): Record<string, unknown> {
  const content = (response.content ?? []) as Array<{ type?: string; text?: string; name?: string }>;
  return {
    stopReason: response.stopReason ?? (response.raw as { stop_reason?: string } | undefined)?.stop_reason ?? null,
    usage: response.usage ?? null,
    blocks: content.map((b) => ({
      type: b.type,
      ...(b.type === 'text' ? { chars: (b.text ?? '').length } : {}),
      ...(b.type === 'tool_use' ? { name: b.name } : {}),
    })),
  };
}

export class LoggingBedrockAdapter extends BedrockAdapter {
  private readonly logPath: string;

  constructor(config: BedrockConfig, logPath: string) {
    super(config);
    this.logPath = logPath;
  }

  private log(record: Record<string, unknown>): void {
    try {
      appendFileSync(this.logPath, serializeRecord(record));
    } catch {
    }
  }

  private recordCall(
    kind: 'complete' | 'stream',
    request: ProviderRequest,
    started: number,
    rawRequest: unknown,
    outcome: { response: ProviderResponse } | { error: unknown },
  ): void {
    try {
      const errorFields = 'error' in outcome ? describeErrorObject(outcome.error, false) : undefined;
      const head = {
        type: errorFields ? 'error' : 'call', kind,
        timestamp: new Date(started).toISOString(),
        durationMs: Date.now() - started,
      };
      let record: Record<string, unknown>;
      try {
        record = 'response' in outcome
          ? { ...head, requestSummary: summarizeRequest(request), response: summarizeResponse(outcome.response) }
          : { ...head, requestSummary: summarizeRequest(request), rawRequest, ...errorFields };
      } catch {
        record = { ...head, summaryUnavailable: true, ...errorFields };
      }
      this.log(record);
    } catch {
    }
  }

  override async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const started = Date.now();
    let rawRequest: unknown;
    const opts: ProviderRequestOptions = {
      ...options,
      onRequest: (req) => { rawRequest = req; options?.onRequest?.(req); },
    };
    let response: ProviderResponse;
    try {
      response = await super.complete(request, opts);
    } catch (error) {
      this.recordCall('complete', request, started, rawRequest, { error });
      throw error;
    }
    this.recordCall('complete', request, started, rawRequest, { response });
    return response;
  }

  override async stream(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const started = Date.now();
    let rawRequest: unknown;
    const opts: ProviderRequestOptions = {
      ...options,
      onRequest: (req) => { rawRequest = req; options?.onRequest?.(req); },
    };
    let response: ProviderResponse;
    try {
      response = await super.stream(request, callbacks, opts);
    } catch (error) {
      this.recordCall('stream', request, started, rawRequest, { error });
      throw error;
    }
    this.recordCall('stream', request, started, rawRequest, { response });
    return response;
  }
}
