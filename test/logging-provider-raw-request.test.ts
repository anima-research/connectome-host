import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from '@animalabs/membrane';
import { LoggingProviderAdapter } from '../src/logging-provider-wrapper.js';

// #341: the generic wrapper kept the raw request on every call. On the OpenAI
// Responses path that is the whole compiled context (about 3 MB per call on a
// Codex host), so a success now keeps it only with LLM_CALLS_FULL_PAYLOADS=1,
// as the Anthropic writer does; a failure keeps the request that was refused.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function logFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'logging-provider-raw-request-'));
  dirs.push(dir);
  return join(dir, 'llm-calls.jsonl');
}

const request = { model: 'zz-model', maxTokens: 16, messages: [{ role: 'user', content: 'zz-prompt' }] } as unknown as ProviderRequest;
const response = {
  content: [{ type: 'text', text: 'zz-answer' }],
  stopReason: 'end_turn',
  usage: { inputTokens: 3, outputTokens: 2 },
  raw: { id: 'resp_zz', usage: { input_tokens: 3, output_tokens: 2 } },
} as unknown as ProviderResponse;

function succeeding(): ProviderAdapter {
  return {
    name: 'success-fixture',
    usageCacheConvention: 'cache-excluded',
    requiresNativeResponsesInput: false,
    supportsModel: () => true,
    complete: async () => response,
    stream: async () => response,
  } as ProviderAdapter;
}

function failing(error: unknown): ProviderAdapter {
  return {
    name: 'error-fixture',
    usageCacheConvention: 'cache-excluded',
    requiresNativeResponsesInput: false,
    supportsModel: () => true,
    complete: async () => { throw error; },
    stream: async () => { throw error; },
  } as ProviderAdapter;
}

function records(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
}

describe('LoggingProviderAdapter and the raw request', () => {
  for (const kind of ['complete', 'stream'] as const) {
    test(`${kind}: a success keeps the summary and the raw response, not the raw request`, async () => {
      const path = logFile();
      const wrapped = new LoggingProviderAdapter(succeeding(), path, { fullPayloads: false });
      if (kind === 'complete') await wrapped.complete(request); else await wrapped.stream(request, {} as never);
      const [record] = records(path);
      expect(record!.type).toBe('call');
      expect(record!.kind).toBe(kind);
      expect('rawRequest' in record!).toBe(false);
      expect(record!.requestSummary).toMatchObject({ model: 'zz-model', maxTokens: 16, messageCount: 1 });
      expect(record!.rawResponse).toEqual({ id: 'resp_zz', usage: { input_tokens: 3, output_tokens: 2 } });
      expect(record!.response).toBeDefined();
    });

    test(`${kind}: with the opt-in a success keeps the raw request as before`, async () => {
      const path = logFile();
      const wrapped = new LoggingProviderAdapter(succeeding(), path, { fullPayloads: true });
      if (kind === 'complete') await wrapped.complete(request); else await wrapped.stream(request, {} as never);
      const [record] = records(path);
      expect(record!.type).toBe('call');
      expect(record!.rawRequest).toEqual(request as unknown as Record<string, unknown>);
    });

    test(`${kind}: a failure keeps the refused request without the opt-in`, async () => {
      const path = logFile();
      const error = new Error('zz refused');
      const wrapped = new LoggingProviderAdapter(failing(error), path, { fullPayloads: false });
      const call = kind === 'complete' ? wrapped.complete(request) : wrapped.stream(request, {} as never);
      await expect(call).rejects.toBe(error);
      const [record] = records(path);
      expect(record!.type).toBe('error');
      expect(record!.rawRequest).toEqual(request as unknown as Record<string, unknown>);
    });
  }

  test('the default reads LLM_CALLS_FULL_PAYLOADS, off when unset', async () => {
    const saved = process.env.LLM_CALLS_FULL_PAYLOADS;
    try {
      delete process.env.LLM_CALLS_FULL_PAYLOADS;
      const off = logFile();
      await new LoggingProviderAdapter(succeeding(), off).complete(request);
      expect('rawRequest' in records(off)[0]!).toBe(false);
      process.env.LLM_CALLS_FULL_PAYLOADS = '1';
      const on = logFile();
      await new LoggingProviderAdapter(succeeding(), on).complete(request);
      expect(records(on)[0]!.rawRequest).toEqual(request as unknown as Record<string, unknown>);
    } finally {
      if (saved === undefined) delete process.env.LLM_CALLS_FULL_PAYLOADS; else process.env.LLM_CALLS_FULL_PAYLOADS = saved;
    }
  });
});
