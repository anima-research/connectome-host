// AnthropicAdapter wrapper that appends each LLM request, response, and error
// to a JSONL log file. Restores the Hermes-era `llm-calls.<iso>.jsonl`
// visibility we lose on the connectome stack by default.
//
// One file per process lifetime (timestamped at construction). Each line is a
// JSON object with shape:
//   {type:'request'|'response'|'error', kind:'complete'|'stream', timestamp, ...payload}

import { AnthropicAdapter } from '@animalabs/membrane';
import type {
  ProviderRequest,
  ProviderResponse,
  ProviderRequestOptions,
  StreamCallbacks,
} from '@animalabs/membrane';
import { appendFileSync } from 'node:fs';

export class LoggingAnthropicAdapter extends AnthropicAdapter {
  private readonly logPath: string;

  constructor(
    config: ConstructorParameters<typeof AnthropicAdapter>[0],
    logPath: string,
  ) {
    super(config);
    this.logPath = logPath;
  }

  private log(record: Record<string, unknown>): void {
    try {
      appendFileSync(this.logPath, JSON.stringify(record) + '\n');
    } catch {
      // never throw from logging
    }
  }

  override async complete(
    request: ProviderRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderResponse> {
    const t0 = Date.now();
    this.log({ type: 'request', kind: 'complete', timestamp: new Date().toISOString(), request });
    try {
      const response = await super.complete(request, options);
      this.log({ type: 'response', kind: 'complete', timestamp: new Date().toISOString(), durationMs: Date.now() - t0, response });
      return response;
    } catch (err) {
      this.log({
        type: 'error', kind: 'complete', timestamp: new Date().toISOString(), durationMs: Date.now() - t0,
        error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
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
    this.log({ type: 'request', kind: 'stream', timestamp: new Date().toISOString(), request });
    try {
      const response = await super.stream(request, callbacks, options);
      this.log({ type: 'response', kind: 'stream', timestamp: new Date().toISOString(), durationMs: Date.now() - t0, response });
      return response;
    } catch (err) {
      this.log({
        type: 'error', kind: 'stream', timestamp: new Date().toISOString(), durationMs: Date.now() - t0,
        error: err instanceof Error ? { name: err.name, message: err.message } : String(err),
      });
      throw err;
    }
  }
}
