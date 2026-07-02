import { describe, test, expect } from 'bun:test';
import { LoggingAnthropicAdapter } from '../src/logging-adapter.js';
import type { ProviderRequest } from '@animalabs/membrane';

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
