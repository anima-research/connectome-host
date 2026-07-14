import { describe, expect, test } from 'bun:test';
import { ANTHROPIC_PRICING_VERSION, priceAnthropicCall } from '../src/call-pricing.js';

const timestamp = '2026-07-13T12:00:00.000Z';

function usage(overrides: Partial<Parameters<typeof priceAnthropicCall>[2]> = {}) {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    unclassifiedCacheWriteTokens: 0,
    serviceTier: 'standard',
    inferenceGeo: 'global',
    ...overrides,
  };
}

describe('Anthropic per-call pricing', () => {
  test('reproduces the ledger-dashboard Fable/Mythos 5m sample exactly', () => {
    const cost = priceAnthropicCall('claude-fable-5', timestamp, usage({
      inputTokens: 2,
      cacheWrite5mTokens: 336_010,
      outputTokens: 639,
    }));

    expect(cost?.total).toBeCloseTo(4.232095, 9);
    expect(cost).toMatchObject({
      cacheWrite5m: 4.200125,
      cacheWrite1h: 0,
      currency: 'USD',
      grade: 'billing',
      pricingVersion: ANTHROPIC_PRICING_VERSION,
    });
  });

  test('prices 1h writes at 2x base input and cache reads at 0.1x', () => {
    const write = priceAnthropicCall('claude-mythos-5', timestamp, usage({ cacheWrite1hTokens: 336_010 }));
    const read = priceAnthropicCall('claude-mythos-5', timestamp, usage({ cacheReadTokens: 336_010 }));
    expect(write?.cacheWrite1h).toBeCloseTo(6.7202, 9);
    expect(read?.cacheRead).toBeCloseTo(0.33601, 9);
  });

  test('applies the US-only inference multiplier to every token category', () => {
    const global = priceAnthropicCall('claude-fable-5', timestamp, usage({ inputTokens: 1_000_000 }));
    const us = priceAnthropicCall('claude-fable-5', timestamp, usage({
      inputTokens: 1_000_000,
      inferenceGeo: 'us',
    }));
    expect(global?.total).toBe(10);
    expect(us?.total).toBeCloseTo(11, 9);
  });

  test('leaves unknown rates, custom tiers, and unclassified writes unpriced', () => {
    expect(priceAnthropicCall('unknown-model', timestamp, usage())).toBeUndefined();
    expect(priceAnthropicCall('claude-fable-5', timestamp, usage({ serviceTier: 'priority' }))).toBeUndefined();
    expect(priceAnthropicCall('claude-fable-5', timestamp, usage({
      unclassifiedCacheWriteTokens: 1,
    }))).toBeUndefined();
  });

  test('honors the published Sonnet 5 promotional cutoff', () => {
    const promo = priceAnthropicCall('claude-sonnet-5', '2026-08-31T23:59:59Z', usage({ inputTokens: 1_000_000 }));
    const standard = priceAnthropicCall('claude-sonnet-5', '2026-09-01T00:00:00Z', usage({ inputTokens: 1_000_000 }));
    expect(promo?.total).toBe(2);
    expect(standard?.total).toBe(3);
  });
});
