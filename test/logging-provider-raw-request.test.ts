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

function answering(answer: ProviderResponse): ProviderAdapter {
  return {
    name: 'answer-fixture',
    usageCacheConvention: 'cache-excluded',
    requiresNativeResponsesInput: false,
    supportsModel: () => true,
    complete: async () => answer,
    stream: async () => answer,
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

  test('a refusal keeps the raw request without the opt-in: a Responses-shaped one, which reaches the wrapper only as the normalized stop reason', async () => {
    const path = logFile();
    // A Responses object has no stop_reason; the refusal is an output part.
    const refusal = {
      ...response,
      stopReason: 'refusal',
      raw: { id: 'resp_r', status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] },
    } as unknown as ProviderResponse;
    await new LoggingProviderAdapter(answering(refusal), path, { fullPayloads: false }).complete(request);
    const [record] = records(path);
    expect(record!.type).toBe('call');
    expect(record!.rawRequest).toEqual(request as unknown as Record<string, unknown>);
    expect('anomaly' in record!).toBe(false);
  });

  test('a refusal named only by the raw stop_reason keeps it too', async () => {
    const path = logFile();
    const refusal = { ...response, stopReason: 'end_turn', raw: { id: 'msg_r', stop_reason: 'refusal' } } as unknown as ProviderResponse;
    await new LoggingProviderAdapter(answering(refusal), path, { fullPayloads: false }).complete(request);
    const [record] = records(path);
    expect(record!.rawRequest).toEqual(request as unknown as Record<string, unknown>);
  });

  test('a Responses tool call the provider cut off keeps the raw request and carries anomaly, though membrane reports tool_use', async () => {
    const path = logFile();
    // membrane maps a function_call to stopReason 'tool_use' before it reads
    // status: 'incomplete'; the cut arguments may come back unparseable.
    const cut = {
      content: [{ type: 'tool_use', id: 'fc_1', name: 'zz_tool', input: {}, unparseableInput: '{"path": "/ro' }],
      stopReason: 'tool_use',
      providerStopReason: 'max_output_tokens',
      usage: { inputTokens: 3, outputTokens: 2 },
      raw: { id: 'resp_c', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'function_call', name: 'zz_tool', arguments: '{"path": "/ro' }] },
    } as unknown as ProviderResponse;
    await new LoggingProviderAdapter(answering(cut), path, { fullPayloads: false }).complete(request);
    const [record] = records(path);
    expect(record!.type).toBe('call');
    expect(record!.rawRequest).toEqual(request as unknown as Record<string, unknown>);
    expect(record!.anomaly).toEqual({
      kind: 'tool_use_cut_off', toolNames: ['zz_tool'], unparseableInput: ['zz_tool'],
      status: 'incomplete', reason: 'max_output_tokens', providerStopReason: 'max_output_tokens',
    });
    // Either sign alone counts.
    const path2 = logFile();
    const incompleteOnly = { ...cut, content: [{ type: 'tool_use', id: 'fc_2', name: 'zz_tool', input: { path: '/' } }] } as unknown as ProviderResponse;
    await new LoggingProviderAdapter(answering(incompleteOnly), path2, { fullPayloads: false }).complete(request);
    expect(records(path2)[0]!.anomaly).toMatchObject({ kind: 'tool_use_cut_off', status: 'incomplete' });
    // A completed tool round is not flagged.
    const path3 = logFile();
    const whole = { ...incompleteOnly, raw: { id: 'resp_w', status: 'completed', output: [] } } as unknown as ProviderResponse;
    await new LoggingProviderAdapter(answering(whole), path3, { fullPayloads: false }).complete(request);
    expect('anomaly' in records(path3)[0]!).toBe(false);
    expect('rawRequest' in records(path3)[0]!).toBe(false);
  });

  test('an anomalous response (a client tool_use under end_turn) keeps the raw request and carries anomaly', async () => {
    const path = logFile();
    const anomalous = {
      content: [{ type: 'tool_use', id: 'tu_1', name: 'zz_tool', input: {} }],
      stopReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 2 },
      raw: { id: 'resp_a' },
    } as unknown as ProviderResponse;
    await new LoggingProviderAdapter(answering(anomalous), path, { fullPayloads: false }).complete(request);
    const [record] = records(path);
    expect(record!.type).toBe('call');
    expect(record!.rawRequest).toEqual(request as unknown as Record<string, unknown>);
    expect(record!.anomaly).toMatchObject({ kind: 'tool_use_with_stop_reason', stopReason: 'end_turn', toolNames: ['zz_tool'] });
  });

  test('with the opt-in a cancelled call keeps its request too, as the Anthropic writer keeps it', async () => {
    const path = logFile();
    const aborted = Object.assign(new Error('zz aborted'), { name: 'MembraneError', type: 'abort', retryable: false });
    const wrapped = new LoggingProviderAdapter(failing(aborted), path, { fullPayloads: true });
    await expect(wrapped.complete(request)).rejects.toBe(aborted);
    const [record] = records(path);
    expect(record!.errorType).toBe('abort');
    expect(record!.rawRequest).toEqual(request as unknown as Record<string, unknown>);
  });

  test('a cancelled call keeps no raw request, as the Anthropic writer keeps none', async () => {
    const path = logFile();
    const aborted = Object.assign(new Error('zz aborted'), { name: 'MembraneError', type: 'abort', retryable: false });
    const wrapped = new LoggingProviderAdapter(failing(aborted), path, { fullPayloads: false });
    await expect(wrapped.complete(request)).rejects.toBe(aborted);
    const [record] = records(path);
    expect(record!.type).toBe('error');
    expect(record!.errorType).toBe('abort');
    expect('rawRequest' in record!).toBe(false);
  });

  test('the summary carries what the ledger reads without the raw request: messages, cache breakpoints and TTLs', async () => {
    const path = logFile();
    const marked = {
      ...request,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'zz-a', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
        { role: 'user', content: 'zz-b' },
      ],
    } as unknown as ProviderRequest;
    await new LoggingProviderAdapter(succeeding(), path, { fullPayloads: false }).complete(marked);
    const [record] = records(path);
    expect(record!.requestSummary).toMatchObject({ messageCount: 2, messages: 2, cacheBreakpoints: 1, cacheTtls: ['1h'] });
    const plain = logFile();
    await new LoggingProviderAdapter(succeeding(), plain, { fullPayloads: false }).complete(request);
    expect(records(plain)[0]!.requestSummary).toMatchObject({ messages: 1, cacheBreakpoints: 0, cacheTtls: [] });
    // A request the cache walk can't visit (a cycle) keeps the rest of its summary.
    const cyclic = { model: 'zz-model', maxTokens: 16, messages: [{ role: 'user', content: 'zz' }] } as Record<string, unknown>;
    cyclic.self = cyclic;
    const loop = logFile();
    await new LoggingProviderAdapter(succeeding(), loop, { fullPayloads: false }).complete(cyclic as unknown as ProviderRequest);
    const summary = records(loop)[0]!.requestSummary as Record<string, unknown>;
    expect(summary).toMatchObject({ model: 'zz-model', messages: 1 });
    expect('cacheBreakpoints' in summary).toBe(false);
  });

  test('the environment is read once, at construction', async () => {
    const saved = process.env.LLM_CALLS_FULL_PAYLOADS;
    try {
      delete process.env.LLM_CALLS_FULL_PAYLOADS;
      const path = logFile();
      const wrapped = new LoggingProviderAdapter(succeeding(), path);
      process.env.LLM_CALLS_FULL_PAYLOADS = '1';
      await wrapped.complete(request);
      expect('rawRequest' in records(path)[0]!).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.LLM_CALLS_FULL_PAYLOADS; else process.env.LLM_CALLS_FULL_PAYLOADS = saved;
    }
  });

  test('a false constructor override beats an enabled environment flag', async () => {
    const saved = process.env.LLM_CALLS_FULL_PAYLOADS;
    try {
      process.env.LLM_CALLS_FULL_PAYLOADS = '1';
      const path = logFile();
      await new LoggingProviderAdapter(succeeding(), path, { fullPayloads: false }).complete(request);
      expect('rawRequest' in records(path)[0]!).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.LLM_CALLS_FULL_PAYLOADS; else process.env.LLM_CALLS_FULL_PAYLOADS = saved;
    }
  });

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
