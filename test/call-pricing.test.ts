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

  test('prices Opus 5 at the Opus-tier rate rather than leaving it unpriced', () => {
    // 'claude-opus-5' matches no 'claude-opus-4-*' prefix, so before this it
    // fell through to undefined and every diver call showed no cost at all.
    const cost = priceAnthropicCall('claude-opus-5', timestamp, usage({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }));
    expect(cost?.total).toBe(30);
    expect(cost?.rates.inputPerMillion).toBe(5);
    expect(cost?.rates.outputPerMillion).toBe(25);
  });

  test('Fable 5.1 reads from cache at 0.025x, a quarter of the Fable 5 rate', () => {
    const fable51 = priceAnthropicCall('claude-fable-5-1', timestamp, usage({ cacheReadTokens: 1_000_000 }));
    const fable5 = priceAnthropicCall('claude-fable-5', timestamp, usage({ cacheReadTokens: 1_000_000 }));
    expect(fable51?.cacheRead).toBeCloseTo(0.25, 9);
    expect(fable5?.cacheRead).toBeCloseTo(1, 9);
    expect(fable51?.rates.cacheReadPerMillion).toBeCloseTo(0.25, 9);
  });

  test('Mythos 5.1 reads from cache at 0.025x too, and Mythos 5 still at 0.1x', () => {
    // the pricing page's footnote names both 5.1 models; the prefix order is
    // pinned the same way the Fable pair is, so 'claude-mythos-5' cannot
    // swallow 'claude-mythos-5-1' first
    const mythos51 = priceAnthropicCall('claude-mythos-5-1', timestamp, usage({ cacheReadTokens: 1_000_000 }));
    const mythos5 = priceAnthropicCall('claude-mythos-5', timestamp, usage({ cacheReadTokens: 1_000_000 }));
    expect(mythos51?.cacheRead).toBeCloseTo(0.25, 9);
    expect(mythos51?.rates.cacheReadPerMillion).toBeCloseTo(0.25, 9);
    expect(mythos5?.cacheRead).toBeCloseTo(1, 9);
    expect(mythos51?.rates.inputPerMillion).toBe(10);
    expect(mythos51?.rates.outputPerMillion).toBe(50);
  });

  test('the Fable 5.1 discount applies to reads only, not to input or writes', () => {
    const cost = priceAnthropicCall('claude-fable-5-1', timestamp, usage({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
    }));
    expect(cost?.input).toBe(10);
    expect(cost?.output).toBe(50);
    expect(cost?.cacheWrite5m).toBeCloseTo(12.5, 9);
    expect(cost?.cacheWrite1h).toBeCloseTo(20, 9);
  });

  test('the geo multiplier still applies on top of the Fable 5.1 read rate', () => {
    const us = priceAnthropicCall('claude-fable-5-1', timestamp, usage({
      cacheReadTokens: 1_000_000,
      inferenceGeo: 'us',
    }));
    expect(us?.cacheRead).toBeCloseTo(0.275, 9);
  });

  test('prices Sonnet 5 at $2/$10 after September 1, the withdrawn increase date', () => {
    // the introductory rate became the standard one; the scheduled move to
    // $3/$15 on 2026-09-01 never happened, so no call is priced at it
    const all = usage({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
    });
    const after = priceAnthropicCall('claude-sonnet-5', '2026-09-19T12:00:00Z', all);
    expect(after?.input).toBe(2);
    expect(after?.output).toBe(10);
    expect(after?.cacheRead).toBeCloseTo(0.2, 9);
    expect(after?.cacheWrite5m).toBeCloseTo(2.5, 9);
    expect(after?.cacheWrite1h).toBeCloseTo(4, 9);
    expect(after?.total).toBeCloseTo(18.7, 9);

    const before = priceAnthropicCall('claude-sonnet-5', '2026-08-31T23:59:59Z', all);
    expect(before?.total).toBeCloseTo(18.7, 9);
  });
});
