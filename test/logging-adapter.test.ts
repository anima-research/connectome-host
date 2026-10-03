import { describe, test, expect } from 'bun:test';
import { LoggingAnthropicAdapter } from '../src/logging-adapter.js';
import type { ProviderCallRecord } from '../src/call-ledger.js';
import type { ProviderRequest, ProviderResponse } from '@animalabs/membrane';

// Regression guard for the reasoning passthrough. `withReasoning` injects
// adaptive `thinking` into `request.extra`, which the Anthropic adapter
// forwards to the API params verbatim. This is invisible to the type system
// (membrane's ProviderRequest doesn't type `thinking`), so it's exactly the
// kind of contract that silently rots on a dependency bump — pin it here so
// the next break is a red test with a name, not a tsc error blamed on the
// wrong package (see the git history of this file).

const baseRequest: ProviderRequest = {
  messages: [],
  model: 'claude-opus-4-6',
  maxTokens: 1024,
};

const enabled = () => ({ enabled: true, budgetTokens: 0 });
const disabled = () => ({ enabled: false, budgetTokens: 0 });

describe('LoggingAnthropicAdapter.withReasoning', () => {
  test('injects adaptive thinking into request.extra when reasoning enabled', () => {
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null', enabled);
    const out = (adapter as unknown as { withReasoning(r: ProviderRequest): ProviderRequest })
      .withReasoning(baseRequest);
    expect((out.extra as Record<string, { type?: string }> | undefined)?.thinking?.type).toBe('adaptive');
    // shallow clone — original request untouched
    expect((baseRequest as { extra?: unknown }).extra).toBeUndefined();
  });

  test('preserves pre-existing extra keys', () => {
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null', enabled);
    const req = { ...baseRequest, extra: { normalizedMessages: 'keep-me' } } as ProviderRequest;
    const out = (adapter as unknown as { withReasoning(r: ProviderRequest): ProviderRequest })
      .withReasoning(req);
    const extra = out.extra as Record<string, unknown>;
    expect(extra.normalizedMessages).toBe('keep-me');
    expect((extra.thinking as { type?: string }).type).toBe('adaptive');
  });

  test('no-op (same reference) when reasoning disabled', () => {
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null', disabled);
    const out = (adapter as unknown as { withReasoning(r: ProviderRequest): ProviderRequest })
      .withReasoning(baseRequest);
    expect(out).toBe(baseRequest);
  });

  test('no-op when no reasoning getter is wired', () => {
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null');
    const out = (adapter as unknown as { withReasoning(r: ProviderRequest): ProviderRequest })
      .withReasoning(baseRequest);
    expect(out).toBe(baseRequest);
  });
});

describe('LoggingAnthropicAdapter.withEffort', () => {
  type WithEffort = { withEffort(r: ProviderRequest): ProviderRequest };
  const fable: ProviderRequest = { ...baseRequest, model: 'claude-fable-5-1' };
  const withEffort = (effort: string | undefined, req: ProviderRequest = fable) => {
    const getter = () => ({ enabled: false, budgetTokens: 0, effort }) as ReturnType<
      NonNullable<ConstructorParameters<typeof LoggingAnthropicAdapter>[2]>
    >;
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null', getter);
    return (adapter as unknown as WithEffort).withEffort(req);
  };

  test('sends output_config.effort even with reasoning_enabled false', () => {
    const out = withEffort('low');
    expect((out.extra as { output_config?: unknown }).output_config).toEqual({ effort: 'low' });
    expect((fable as { extra?: unknown }).extra).toBeUndefined();
  });

  test("no-op (same reference) for 'default' and for unset", () => {
    expect(withEffort('default')).toBe(fable);
    expect(withEffort(undefined)).toBe(fable);
  });

  test('merges into an existing output_config instead of replacing it', () => {
    const req = { ...fable, extra: { output_config: { format: { type: 'json_schema' } }, keep: 1 } } as ProviderRequest;
    const extra = withEffort('max', req).extra as Record<string, unknown>;
    expect(extra.output_config).toEqual({ format: { type: 'json_schema' }, effort: 'max' });
    expect(extra.keep).toBe(1);
  });

  test('drops levels the model rejects rather than bricking its turns', () => {
    expect(withEffort('high', { ...baseRequest, model: 'claude-haiku-4-5' }).extra).toBeUndefined();
    expect(withEffort('xhigh', { ...baseRequest, model: 'claude-opus-4-6' }).extra).toBeUndefined();
    expect(withEffort('max', { ...baseRequest, model: 'claude-opus-4-5' }).extra).toBeUndefined();
    expect(withEffort('max', { ...baseRequest, model: 'claude-opus-4-6' }).extra).toBeDefined();
    expect(withEffort('xhigh', { ...baseRequest, model: 'claude-opus-5-5' }).extra).toBeDefined();
  });
});

describe('LoggingAnthropicAdapter request logging', () => {
  const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null');
  const internals = adapter as unknown as {
    requestSummary(r: ProviderRequest, raw?: unknown): Record<string, unknown>;
    refusalRawRequest(r: ProviderResponse, raw: unknown): unknown;
  };

  test('summarizes requests without retaining message content', () => {
    const request = {
      ...baseRequest,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'large context' }] }],
      tools: [{ name: 'shell', description: 'run a command', inputSchema: {} }],
    } as ProviderRequest;

    expect(internals.requestSummary(request)).toEqual({
      model: 'claude-opus-4-6',
      maxTokens: 1024,
      messages: 1,
      tools: 1,
    });
  });

  test('summarizes provider cache markers without retaining prompt content', () => {
    const raw = {
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'do not log me', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      }],
    };
    expect(internals.requestSummary(baseRequest, raw)).toMatchObject({
      cacheBreakpoints: 1,
      cacheTtls: ['1h'],
    });
    expect(JSON.stringify(internals.requestSummary(baseRequest, raw))).not.toContain('do not log me');
  });

  test('retains the raw request only for refusals', () => {
    const rawRequest = { messages: ['forensic context'] };
    const success = { raw: { stop_reason: 'end_turn' } } as unknown as ProviderResponse;
    const refusal = { raw: { stop_reason: 'refusal' } } as unknown as ProviderResponse;

    expect(internals.refusalRawRequest(success, rawRequest)).toBeUndefined();
    expect(internals.refusalRawRequest(refusal, rawRequest)).toBe(rawRequest);
  });

  test('LLM_CALLS_FULL_PAYLOADS=1 retains the raw request on every call', () => {
    const prev = process.env.LLM_CALLS_FULL_PAYLOADS;
    process.env.LLM_CALLS_FULL_PAYLOADS = '1';
    try {
      const full = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null');
      const fi = full as unknown as typeof internals;
      const rawRequest = { messages: ['forensic context'] };
      const success = { raw: { stop_reason: 'end_turn' } } as unknown as ProviderResponse;
      const refusal = { raw: { stop_reason: 'refusal' } } as unknown as ProviderResponse;
      expect(fi.refusalRawRequest(success, rawRequest)).toBe(rawRequest);
      expect(fi.refusalRawRequest(refusal, rawRequest)).toBe(rawRequest);
    } finally {
      if (prev === undefined) delete process.env.LLM_CALLS_FULL_PAYLOADS;
      else process.env.LLM_CALLS_FULL_PAYLOADS = prev;
    }
  });

  test('LLM_CALLS_FULL_PAYLOADS off-values keep refusal-only behavior', () => {
    const prev = process.env.LLM_CALLS_FULL_PAYLOADS;
    try {
      for (const off of ['', '0', 'false', 'FALSE']) {
        process.env.LLM_CALLS_FULL_PAYLOADS = off;
        const a = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null');
        const ai = a as unknown as typeof internals;
        const success = { raw: { stop_reason: 'end_turn' } } as unknown as ProviderResponse;
        expect(ai.refusalRawRequest(success, { m: 1 })).toBeUndefined();
      }
    } finally {
      if (prev === undefined) delete process.env.LLM_CALLS_FULL_PAYLOADS;
      else process.env.LLM_CALLS_FULL_PAYLOADS = prev;
    }
  });

  test('forwards authoritative billing buckets from the provider response', () => {
    const calls: ProviderCallRecord[] = [];
    const observed = new LoggingAnthropicAdapter(
      { apiKey: 'test' },
      '/dev/null',
      undefined,
      (call) => calls.push(call),
    ) as unknown as {
      observeCall(
        kind: 'complete' | 'stream',
        timestamp: string,
        durationMs: number,
        request: ProviderRequest,
        rawRequest: unknown,
        response: ProviderResponse,
      ): void;
    };
    const response = {
      usage: { inputTokens: 2, outputTokens: 10, cacheCreationTokens: 100, cacheReadTokens: 50 },
      raw: {
        usage: {
          cache_creation: {
            ephemeral_5m_input_tokens: 25,
            ephemeral_1h_input_tokens: 75,
          },
          service_tier: 'standard',
          inference_geo: 'global',
        },
      },
    } as unknown as ProviderResponse;

    observed.observeCall('stream', '2026-07-13T00:00:00Z', 10, baseRequest, {}, response);
    expect(calls[0]).toMatchObject({
      cacheWriteTokens: 100,
      cacheWrite5mTokens: 25,
      cacheWrite1hTokens: 75,
      cacheWriteBucketsAuthoritative: true,
      serviceTier: 'standard',
      inferenceGeo: 'global',
    });
  });
});
