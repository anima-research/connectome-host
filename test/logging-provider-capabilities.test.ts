import { describe, expect, test } from 'bun:test';
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from '@animalabs/membrane';
import { LoggingProviderAdapter } from '../src/logging-provider-wrapper.js';

type ImageCapableAdapter = ProviderAdapter & {
  readonly toolResultImageMediaTypes?: ReadonlySet<string>;
};

function adapter(capability?: ReadonlySet<string>): ImageCapableAdapter {
  return {
    name: 'capability-fixture',
    usageCacheConvention: 'cache-excluded',
    requiresNativeResponsesInput: false,
    ...(capability !== undefined ? { toolResultImageMediaTypes: capability } : {}),
    supportsModel: () => true,
    complete: async (_request: ProviderRequest) => ({
      content: [], stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    } as ProviderResponse),
    stream: async () => { throw new Error('unused'); },
  };
}

describe('LoggingProviderAdapter image capability', () => {
  test('older adapters keep an absent capability undefined', () => {
    const inner = adapter();
    const wrapped = new LoggingProviderAdapter(inner, '/dev/null');
    expect(wrapped.toolResultImageMediaTypes).toBeUndefined();
    expect(wrapped.usageCacheConvention).toBe(inner.usageCacheConvention);
    expect(wrapped.requiresNativeResponsesInput).toBe(inner.requiresNativeResponsesInput);
  });

  test('advertised media types are forwarded as the exact set', () => {
    const types = new Set(['image/png', 'image/heic', 'image/heif']);
    const wrapped = new LoggingProviderAdapter(adapter(types), '/dev/null');
    expect(wrapped.toolResultImageMediaTypes).toBe(types);
    expect(wrapped.toolResultImageMediaTypes?.has('image/heic')).toBe(true);
    expect(wrapped.toolResultImageMediaTypes?.has('image/gif')).toBe(false);
  });

  test('an explicit empty set stays distinct from an absent capability', () => {
    const types = new Set<string>();
    expect(new LoggingProviderAdapter(adapter(types), '/dev/null').toolResultImageMediaTypes).toBe(types);
  });

  test('the getter observes the inner adapter rather than snapshotting capability at construction', () => {
    let types: ReadonlySet<string> = new Set(['image/png']);
    const inner = adapter();
    Object.defineProperty(inner, 'toolResultImageMediaTypes', { get: () => types });
    const wrapped = new LoggingProviderAdapter(inner, '/dev/null');
    expect(wrapped.toolResultImageMediaTypes).toBe(types);
    types = new Set(['image/heif']);
    expect(wrapped.toolResultImageMediaTypes).toBe(types);
  });
});
