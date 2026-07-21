// BedrockAdapter wrapper that appends each LLM call's request summary, stop
// reason, and any error to the same `llm-calls.<iso>.jsonl` file the
// Anthropic path uses. Purpose-built during the Aria bring-up (2026-07-21)
// when a 0-token assistant turn proved undiagnosable: the bedrock transport
// had no wire visibility at all.
//
// Kept deliberately lighter than LoggingAnthropicAdapter: request summaries
// always include tool NAMES (were tools attached at all? — the question that
// motivated this file), message/system sizes, and the stop sequences; the
// full raw request is retained only on errors. Responses log stop_reason,
// usage, and content-block shape (type + size per block) on every call.
//
// Each line: { type: 'call'|'error', kind: 'complete'|'stream', timestamp,
//   durationMs, requestSummary, response?, rawRequest?, error? }

import { BedrockAdapter } from '@animalabs/membrane';
import type {
  ProviderRequest,
  ProviderResponse,
  ProviderRequestOptions,
  StreamCallbacks,
} from '@animalabs/membrane';
import { appendFileSync } from 'node:fs';

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
      appendFileSync(this.logPath, JSON.stringify(record) + '\n');
    } catch {
      // Logging must never break inference.
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
    try {
      const response = await super.complete(request, opts);
      this.log({
        type: 'call', kind: 'complete', timestamp: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        requestSummary: summarizeRequest(request),
        response: summarizeResponse(response),
      });
      return response;
    } catch (error) {
      this.log({
        type: 'error', kind: 'complete', timestamp: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        requestSummary: summarizeRequest(request),
        rawRequest,
        error: error instanceof Error ? { message: error.message, name: error.name } : String(error),
      });
      throw error;
    }
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
    try {
      const response = await super.stream(request, callbacks, opts);
      this.log({
        type: 'call', kind: 'stream', timestamp: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        requestSummary: summarizeRequest(request),
        response: summarizeResponse(response),
      });
      return response;
    } catch (error) {
      this.log({
        type: 'error', kind: 'stream', timestamp: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        requestSummary: summarizeRequest(request),
        rawRequest,
        error: error instanceof Error ? { message: error.message, name: error.name } : String(error),
      });
      throw error;
    }
  }
}
