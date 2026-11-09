import { describe, expect, test } from 'bun:test';
import { ANTHROPIC_PRICING_VERSION, OPENAI_PRICING_VERSION, anthropicCacheReadMultiplier, openaiCacheMultipliers, priceAnthropicCall, priceCall, type PriceCallInput } from '../src/call-pricing.js';

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
    const all = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
    };
    const global = priceAnthropicCall('claude-fable-5', timestamp, usage(all))!;
    const us = priceAnthropicCall('claude-fable-5', timestamp, usage({ ...all, inferenceGeo: 'us' }))!;
    expect(global.input).toBe(10);
    for (const category of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const) {
      expect(us[category]).toBeCloseTo(global[category] * 1.1, 9);
    }
    for (const rate of ['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWrite5mPerMillion', 'cacheWrite1hPerMillion'] as const) {
      expect(us.rates[rate]).toBeCloseTo(global.rates[rate] * 1.1, 9);
    }
    expect(us.total).toBeCloseTo(global.total * 1.1, 9);
  });

  test('leaves unknown rates, custom tiers, and unclassified writes unpriced', () => {
    expect(priceAnthropicCall('unknown-model', timestamp, usage())).toBeUndefined();
    expect(priceAnthropicCall('claude-fable-5', timestamp, usage({ serviceTier: 'priority' }))).toBeUndefined();
    expect(priceAnthropicCall('claude-fable-5', timestamp, usage({
      unclassifiedCacheWriteTokens: 1,
    }))).toBeUndefined();
  });

  test('prices Opus 5 at the Opus-tier rate rather than leaving it unpriced', () => {
    const cost = priceAnthropicCall('claude-opus-5', timestamp, usage({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }));
    expect(cost?.total).toBe(30);
    expect(cost?.rates.inputPerMillion).toBe(5);
    expect(cost?.rates.outputPerMillion).toBe(25);
  });

  test('prices Opus 5.5 at $4/$20 with 0.05x reads, not at the Opus 5 rate its prefix also matches', () => {
    const cost = priceAnthropicCall('claude-opus-5-5', timestamp, usage({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
    }));
    expect(cost?.rates.inputPerMillion).toBe(4);
    expect(cost?.rates.outputPerMillion).toBe(20);
    expect(cost?.cacheRead).toBeCloseTo(0.2, 9);
    expect(cost?.cacheWrite1h).toBeCloseTo(8, 9);
    expect(priceAnthropicCall('claude-opus-5', timestamp, usage({ inputTokens: 1_000_000 }))?.total).toBe(5);
  });

  test('prices Haiku 5.5 by prompt length, up to 100,000 tokens at $0.10/$0.50 and over that at $0.50/$2.50', () => {
    const prompt = { cacheReadTokens: 50_000, cacheWrite5mTokens: 5_000, cacheWrite1hTokens: 5_000, outputTokens: 1_000_000 };
    const at = priceAnthropicCall('claude-haiku-5-5', timestamp, usage({ ...prompt, inputTokens: 40_000 }));
    expect(at?.rates.inputPerMillion).toBe(0.1);
    expect(at?.rates.outputPerMillion).toBe(0.5);
    expect(at?.input).toBeCloseTo(0.004, 12);
    expect(at?.cacheRead).toBeCloseTo(0.0005, 12);
    expect(at?.cacheWrite5m).toBeCloseTo(0.000625, 12);
    expect(at?.cacheWrite1h).toBeCloseTo(0.001, 12);
    expect(at?.output).toBeCloseTo(0.5, 12);
    expect(at!.rates.cacheReadPerMillion / at!.rates.inputPerMillion).toBeCloseTo(anthropicCacheReadMultiplier('claude-haiku-5-5'), 12);

    const over = priceAnthropicCall('claude-haiku-5-5', timestamp, usage({ ...prompt, inputTokens: 40_001 }));
    expect(over?.rates.inputPerMillion).toBe(0.5);
    expect(over?.rates.outputPerMillion).toBe(2.5);
    expect(over?.rates.cacheReadPerMillion).toBeCloseTo(0.05, 12);
    expect(over?.input).toBeCloseTo(0.0200005, 12);
    expect(over?.cacheRead).toBeCloseTo(0.0025, 12);
    expect(over?.cacheWrite5m).toBeCloseTo(0.003125, 12);
    expect(over?.cacheWrite1h).toBeCloseTo(0.005, 12);
    expect(over?.output).toBeCloseTo(2.5, 12);
    expect(over!.rates.cacheReadPerMillion / over!.rates.inputPerMillion).toBeCloseTo(anthropicCacheReadMultiplier('claude-haiku-5-5'), 12);
  });

  test('each of a Haiku 5.5 prompt\'s input buckets counts toward its length on its own', () => {
    for (const bucket of ['inputTokens', 'cacheReadTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens'] as const) {
      expect(priceAnthropicCall('claude-haiku-5-5', timestamp, usage({ [bucket]: 100_000 }))?.rates.inputPerMillion).toBe(0.1);
      expect(priceAnthropicCall('claude-haiku-5-5', timestamp, usage({ [bucket]: 100_001 }))?.rates.inputPerMillion).toBe(0.5);
    }
  });

  test('anthropicCacheReadMultiplier strips Bedrock and gateway prefixes and defaults to 0.1x', () => {
    expect(anthropicCacheReadMultiplier('claude-fable-5-1')).toBe(0.025);
    expect(anthropicCacheReadMultiplier('claude-opus-5-5')).toBe(0.05);
    expect(anthropicCacheReadMultiplier('anthropic/claude-opus-5-5')).toBe(0.05);
    expect(anthropicCacheReadMultiplier('global.anthropic.claude-mythos-5-1')).toBe(0.025);
    expect(anthropicCacheReadMultiplier('claude-opus-4-6')).toBe(0.1);
    expect(anthropicCacheReadMultiplier('claude-haiku-5-5')).toBe(0.1);
    expect(anthropicCacheReadMultiplier('claude-sonnet-5-5')).toBe(0.1);
    expect(anthropicCacheReadMultiplier('some-unknown-model')).toBe(0.1);
  });

  test('openaiCacheMultipliers: API writes carry 1.25x only on the GPT-5.6 / GPT-6 families; Codex never charges writes', () => {
    expect(openaiCacheMultipliers('gpt-5.6-sol', 'api')).toEqual({ read: 0.1, write: 1.25 });
    expect(openaiCacheMultipliers('gpt-6-astra', 'api')).toEqual({ read: 0.1, write: 1.25 });
    expect(openaiCacheMultipliers('gpt-6.1-sol', 'api')).toEqual({ read: 0.05, write: 1.25 });
    expect(openaiCacheMultipliers('openai/gpt-5.6-luna', 'api')).toEqual({ read: 0.1, write: 1.25 });
    expect(openaiCacheMultipliers('gpt-5.4', 'api')).toEqual({ read: 0.1, write: 1 });
    expect(openaiCacheMultipliers('gpt-4.1-mini', 'api')).toEqual({ read: 0.25, write: 1 });
    expect(openaiCacheMultipliers('gpt-4o-mini', 'api')).toEqual({ read: 0.5, write: 1 });
    expect(openaiCacheMultipliers('o3-mini', 'api')).toEqual({ read: 0.5, write: 1 });
    expect(openaiCacheMultipliers('o3', 'api')).toEqual({ read: 0.25, write: 1 });
    expect(openaiCacheMultipliers('gpt-5.6-sol', 'codex')).toEqual({ read: 0.1, write: 1 });
    expect(openaiCacheMultipliers('gpt-6.1-sol', 'codex')).toEqual({ read: 0.05, write: 1 });
  });

  test('Fable 5.1 reads from cache at 0.025x, a quarter of the Fable 5 rate', () => {
    const fable51 = priceAnthropicCall('claude-fable-5-1', timestamp, usage({ cacheReadTokens: 1_000_000 }));
    const fable5 = priceAnthropicCall('claude-fable-5', timestamp, usage({ cacheReadTokens: 1_000_000 }));
    expect(fable51?.cacheRead).toBeCloseTo(0.25, 9);
    expect(fable5?.cacheRead).toBeCloseTo(1, 9);
    expect(fable51?.rates.cacheReadPerMillion).toBeCloseTo(0.25, 9);
  });

  test('Mythos 5.1 reads from cache at 0.025x too, and Mythos 5 still at 0.1x', () => {
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

function call(provider: string, model: string, overrides: Partial<PriceCallInput> = {}): PriceCallInput {
  return {
    provider,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheWrite30mTokens: 0,
    cacheWrite12hTokens: 0,
    unclassifiedCacheWriteTokens: 0,
    ...overrides,
  };
}

describe('priceCall', () => {
  test('prices an Anthropic call as priceAnthropicCall does, its two writes summed', () => {
    const parts = { inputTokens: 40_000, outputTokens: 3_000, cacheReadTokens: 50_000, cacheWrite5mTokens: 7_000, cacheWrite1hTokens: 9_000 };
    for (const model of ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']) {
      const ledger = priceAnthropicCall(model, timestamp, usage({ ...parts, serviceTier: undefined, inferenceGeo: undefined }))!;
      const price = priceCall(call('anthropic', model, parts))!;
      expect(price).toMatchObject({ input: ledger.input, cacheRead: ledger.cacheRead, output: ledger.output, total: ledger.total, tier: 'standard', pricingVersion: ANTHROPIC_PRICING_VERSION });
      expect(price.cacheWrite).toBeCloseTo(ledger.cacheWrite5m + ledger.cacheWrite1h, 12);
    }
  });

  test('gives no Anthropic price where priceAnthropicCall gives none, or for an OpenAI write lifetime', () => {
    expect(priceCall(call('anthropic', 'claude-opus-5-5', { inputTokens: 1_000, serviceTier: 'priority' }))).toBeUndefined();
    expect(priceCall(call('anthropic', 'claude-opus-5-5', { cacheWrite5mTokens: 1_000, unclassifiedCacheWriteTokens: 1 }))).toBeUndefined();
    expect(priceCall(call('anthropic', 'claude-unknown-9', { inputTokens: 1_000 }))).toBeUndefined();
    expect(priceCall(call('anthropic', 'claude-opus-5-5', { cacheWrite30mTokens: 1_000 }))).toBeUndefined();
  });

  test('says which side of Haiku 5.5\'s 100,000-token step an Anthropic call fell on', () => {
    expect(priceCall(call('anthropic', 'claude-haiku-5-5', { inputTokens: 100_000 }))?.context).toBe('short');
    expect(priceCall(call('anthropic', 'claude-haiku-5-5', { inputTokens: 1, cacheReadTokens: 100_000 }))?.context).toBe('long');
    expect(priceCall(call('anthropic', 'claude-opus-5-5', { inputTokens: 300_000 }))?.context).toBeUndefined();
  });

  const sol = { inputTokens: 100_000, cacheReadTokens: 100_000, cacheWrite30mTokens: 20_000, cacheWrite12hTokens: 10_000, outputTokens: 10_000 };

  test('prices each part of an OpenAI call at its Standard rate when the call reports default or no tier', () => {
    const none = priceCall(call('openai-responses', 'gpt-6.1-sol', sol))!;
    expect(none.input).toBeCloseTo(0.2, 12);
    expect(none.cacheRead).toBeCloseTo(0.01, 12);
    expect(none.cacheWrite).toBeCloseTo(0.05 + 0.05, 12);
    expect(none.output).toBeCloseTo(0.1, 12);
    expect(none.total).toBeCloseTo(0.41, 12);
    expect(none).toMatchObject({ tier: 'standard', context: 'short', currency: 'USD', pricingVersion: OPENAI_PRICING_VERSION });
    expect(priceCall(call('openai-responses', 'gpt-6.1-sol', { ...sol, serviceTier: 'default' }))).toEqual(none);
  });

  test('prices flex at Flex rates and priority at Fast rates', () => {
    const flex = priceCall(call('openai-responses', 'gpt-6.1-sol', { ...sol, serviceTier: 'flex' }))!;
    const fast = priceCall(call('openai-responses', 'gpt-6.1-sol', { ...sol, serviceTier: 'priority' }))!;
    expect(flex).toMatchObject({ tier: 'flex' });
    expect(flex.total).toBeCloseTo(0.205, 12);
    expect(fast).toMatchObject({ tier: 'fast' });
    expect(fast.total).toBeCloseTo(0.82, 12);
  });

  test('prices a request over 272,000 input tokens at long-context rates, cached and written tokens counted', () => {
    const at = priceCall(call('openai-responses', 'gpt-6.1-sol', { inputTokens: 200_000, cacheReadTokens: 62_000, cacheWrite30mTokens: 10_000, outputTokens: 1_000 }))!;
    const over = priceCall(call('openai-responses', 'gpt-6.1-sol', { inputTokens: 200_001, cacheReadTokens: 62_000, cacheWrite30mTokens: 10_000, outputTokens: 1_000 }))!;
    expect(at.context).toBe('short');
    expect(at.total).toBeCloseTo((200_000 * 2 + 62_000 * 0.1 + 10_000 * 2.5 + 1_000 * 10) / 1e6, 12);
    expect(over.context).toBe('long');
    expect(over.total).toBeCloseTo((200_001 * 4 + 62_000 * 0.2 + 10_000 * 5 + 1_000 * 15) / 1e6, 12);
  });

  test('prices a model with one listed rate the same at every size', () => {
    const small = priceCall(call('openai-responses', 'gpt-5.4-mini', { inputTokens: 1_000_000 }))!;
    const large = priceCall(call('openai-responses', 'gpt-5.4-mini', { inputTokens: 400_000 }))!;
    expect(small.input).toBeCloseTo(0.75, 12);
    expect(large.input).toBeCloseTo(0.3, 12);
    expect(large.context).toBeUndefined();
  });

  test('gives no OpenAI price where the page gives none for what the call used', () => {
    const priced = (model: string, overrides: Partial<PriceCallInput>) => priceCall(call('openai-responses', model, { inputTokens: 1_000, ...overrides }));
    expect(priced('gpt-6.1-sol', { serviceTier: 'scale' })).toBeUndefined();
    expect(priced('gpt-6.1-sol', { serviceTier: 'auto' })).toBeUndefined();
    expect(priced('gpt-5.2-pro', { serviceTier: 'flex' })).toBeUndefined();
    expect(priced('gpt-9', {})).toBeUndefined();
    expect(priced('gpt-6-cyber', { inputTokens: 300_000 })).toBeUndefined();
    expect(priced('gpt-6-cyber', { inputTokens: 200_000 })).toBeDefined();
    expect(priced('gpt-5.5-pro', { cacheReadTokens: 1_000 })).toBeUndefined();
    expect(priced('gpt-5.5', { cacheWrite12hTokens: 1_000 })).toBeUndefined();
    expect(priced('gpt-5.5', { cacheWrite5mTokens: 1_000 })).toBeUndefined();
  });

  test('gives no price on Codex, OpenRouter, an OpenAI-compatible server or Bedrock', () => {
    for (const provider of ['openai-codex', 'openrouter', 'openai-compatible', 'bedrock']) {
      expect(priceCall(call(provider, 'gpt-6.1-sol', { inputTokens: 1_000 }))).toBeUndefined();
      expect(priceCall(call(provider, 'claude-opus-5-5', { inputTokens: 1_000 }))).toBeUndefined();
    }
  });

  test('reads a dated snapshot or an openai/ prefix as the model it names, and nothing else', () => {
    const base = priceCall(call('openai-responses', 'gpt-6.1-sol', sol))!;
    expect(priceCall(call('openai-responses', 'gpt-6.1-sol-2026-10-01', sol))).toEqual(base);
    expect(priceCall(call('openai-responses', 'openai/gpt-6.1-sol', sol))).toEqual(base);
    expect(priceCall(call('openai-responses', 'gpt-6.1-sol-mini', sol))).toBeUndefined();
    expect(priceCall(call('openai-responses', 'gpt-5.4-mini', { inputTokens: 1_000_000 }))?.input).toBeCloseTo(0.75, 12);
  });
});
