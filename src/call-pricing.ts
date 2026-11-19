/**
 * Provider-call pricing used by the operator ledger, and by `priceCall` for
 * a call on Anthropic's API or OpenAI's Responses API.
 *
 * Rates are USD per million tokens and are applied to the provider's
 * authoritative usage buckets. Cache creation MUST remain split by TTL:
 * Anthropic bills 5m writes at 1.25x input and 1h writes at 2x input.
 *
 * Anthropic bills cache READS at 0.1x input on every model but six: Claude
 * Fable 5.1 and Claude Mythos 5.1 read at 0.025x ($0.25/MTok), a quarter of
 * the 5 pair's rate, Claude Fable 5.2 and Claude Mythos 5.2 at 0.025x too
 * ($0.20/MTok), and Claude Opus 5.5 and Claude Sonnet 5.5 at 0.05x ($0.20
 * and $0.10/MTok). This table gives all but Sonnet 5.5 their rates, and
 * Sonnet 5.5 0.1x: see the Sonnet 5 entry.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 */

import type { CallCostBreakdown } from './web/protocol.js';

export const ANTHROPIC_PRICING_VERSION = 'anthropic-public-2026-10-19-5-2';

const DEFAULT_CACHE_READ_MULTIPLIER = 0.1;

interface BaseRate {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadMultiplier: number;
  context?: 'short' | 'long';
}

export interface PriceableCallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  unclassifiedCacheWriteTokens: number;
  inferenceGeo?: string;
  serviceTier?: string;
}

export function priceAnthropicCall(
  model: string,
  _timestamp: string,
  usage: PriceableCallUsage,
): CallCostBreakdown | undefined {
  const rate = anthropicBaseRate(model, anthropicPromptTokens(usage));
  if (!rate || usage.unclassifiedCacheWriteTokens > 0) return undefined;

  // Public list pricing covers standard service. Priority Tier is contract
  // priced.
  const tier = usage.serviceTier?.toLowerCase();
  if (tier && tier !== 'standard') return undefined;

  const geo = usage.inferenceGeo?.toLowerCase();
  const geoMultiplier = !geo || geo === 'global'
    ? 1
    : (geo === 'us' || geo === 'us-only' || geo === 'us_only') ? 1.1 : undefined;
  if (geoMultiplier === undefined) return undefined;

  const input = usage.inputTokens * rate.inputPerMillion / 1_000_000 * geoMultiplier;
  const cacheWrite5m = usage.cacheWrite5mTokens * rate.inputPerMillion * 1.25 / 1_000_000 * geoMultiplier;
  const cacheWrite1h = usage.cacheWrite1hTokens * rate.inputPerMillion * 2 / 1_000_000 * geoMultiplier;
  const cacheRead = usage.cacheReadTokens * rate.inputPerMillion * rate.cacheReadMultiplier / 1_000_000 * geoMultiplier;
  const output = usage.outputTokens * rate.outputPerMillion / 1_000_000 * geoMultiplier;

  return {
    input,
    cacheWrite5m,
    cacheWrite1h,
    cacheRead,
    output,
    total: input + cacheWrite5m + cacheWrite1h + cacheRead + output,
    currency: 'USD',
    grade: 'billing',
    pricingVersion: ANTHROPIC_PRICING_VERSION,
    rates: {
      inputPerMillion: rate.inputPerMillion * geoMultiplier,
      outputPerMillion: rate.outputPerMillion * geoMultiplier,
      cacheWrite5mPerMillion: rate.inputPerMillion * 1.25 * geoMultiplier,
      cacheWrite1hPerMillion: rate.inputPerMillion * 2 * geoMultiplier,
      cacheReadPerMillion: rate.inputPerMillion * rate.cacheReadMultiplier * geoMultiplier,
    },
  };
}

// A request's prompt length, which Claude Haiku 5.5's price depends on,
// counts all of its input tokens: uncached input, cache reads and writes.
function anthropicPromptTokens(usage: PriceableCallUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;
}

function anthropicBaseRate(model: string, promptTokens: number): BaseRate | undefined {
  // The 5.2 and 5.1 pairs first: their prefixes also match the Fable 5 /
  // Mythos 5 test below, and they read from cache at 0.025x. The 5.2 pair is
  // $8/$40 (pricing page, read 2026-11-09).
  if (starts(model, 'claude-fable-5-2', 'claude-mythos-5-2')) return rate(8, 40, 0.025);
  if (starts(model, 'claude-fable-5-1', 'claude-mythos-5-1')) return rate(10, 50, 0.025);

  // Fable 5 and Mythos 5 share pricing.
  if (starts(model, 'claude-fable-5', 'claude-mythos-5')) return rate(10, 50);

  // Opus 5.5 before the Opus 5 group, whose 'claude-opus-5' prefix also
  // matches it: $4/$20, cache reads $0.20 (0.05x).
  if (starts(model, 'claude-opus-5-5')) return rate(4, 20, 0.05);

  if (starts(model,
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-opus-4-5',
  )) return rate(5, 25);

  // Sonnet 5 is $2/$10: "The $2/$10 per million input/output token pricing for
  // Claude Sonnet 5 ... is now the standard price." (pricing page)
  //
  // Sonnet 5.5 matches this prefix too, so it's priced at $2/$10 with 0.1x
  // reads, where the pricing page gives its cache reads 0.05x ($0.10/MTok),
  // and the ledger overstates them twofold. The same multiple is the
  // kv-unified solver's cache-read price (anthropicCacheReadMultiplier, read
  // by standardKvUnifiedConfig), so giving Sonnet 5.5 0.05x here also changes
  // what the solver weighs for a Sonnet 5.5 agent, which can change the layout
  // it picks and rewrite that agent's prompt cache.
  if (starts(model, 'claude-sonnet-5')) return rate(2, 10);

  if (starts(model,
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-sonnet-4-',
    'claude-3-7-sonnet',
    'claude-3-5-sonnet',
  )) return rate(3, 15);

  // Haiku 5.5 is priced by prompt length, cache reads and writes included:
  // up to 100,000 tokens $0.10/$0.50, over that $0.50/$2.50. Both tiers read
  // from cache at 0.1x.
  if (starts(model, 'claude-haiku-5-5')) {
    return promptTokens > 100_000 ? { ...rate(0.5, 2.5), context: 'long' } : { ...rate(0.1, 0.5), context: 'short' };
  }

  if (starts(model, 'claude-haiku-4-5')) return rate(1, 5);
  if (starts(model, 'claude-3-5-haiku')) return rate(0.8, 4);

  if (starts(model, 'claude-opus-4-1', 'claude-opus-4-')) return rate(15, 75);
  return undefined;
}

export function anthropicCacheReadMultiplier(model: string): number {
  const bare = model.replace(/^(?:[a-z]+\.)?anthropic[./]/, '');
  return anthropicBaseRate(bare, 0)?.cacheReadMultiplier ?? DEFAULT_CACHE_READ_MULTIPLIER;
}

/**
 * OpenAI cache prices as multiples of a model's uncached input.
 *
 * - Writes: the API bills them at 1.25x for the GPT-5.6 and GPT-6 families
 *   (the models its pricing table gives a cache-write price) and charges
 *   nothing extra for the rest. Codex credit billing has no cache-write
 *   charge on any model.
 * - Reads: the cached-input rate, the same ratio on the API and in Codex
 *   credits: 0.05x GPT-6.1 Sol, 0.25x gpt-4.1 / o3 / o4-mini, 0.5x gpt-4o /
 *   o1 / o3-mini, 0.1x everything else.
 *
 * Sources: https://developers.openai.com/api/docs/pricing and
 * https://learn.chatgpt.com/docs/pricing.
 */
export function openaiCacheMultipliers(
  model: string,
  transport: 'api' | 'codex',
): { read: number; write: number } {
  const bare = model.replace(/^openai\//, '');
  const writePremium = transport === 'api' && starts(bare, 'gpt-6', 'gpt-5.6');
  return { read: openaiCacheReadMultiplier(bare), write: writePremium ? 1.25 : 1 };
}

function openaiCacheReadMultiplier(model: string): number {
  if (starts(model, 'gpt-6.1-sol')) return 0.05;
  if (starts(model, 'gpt-4.1', 'o4-mini')) return 0.25;
  if (starts(model, 'gpt-4o', 'o1', 'o3-mini')) return 0.5;
  if (starts(model, 'o3')) return 0.25;
  return DEFAULT_CACHE_READ_MULTIPLIER;
}

/** A call's usage, its `inputTokens` the uncached input alone: an OpenAI
 *  usage's `input_tokens` less its cached and written tokens. */
export interface PriceCallInput extends PriceableCallUsage {
  provider: string;
  model: string;
  cacheWrite30mTokens: number;
  cacheWrite12hTokens: number;
}

export interface CallPrice {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  total: number;
  currency: 'USD';
  pricingVersion: string;
  tier: string;
  /** For a model whose price steps with the request's input: which side of
   *  the step this one fell on. */
  context?: 'short' | 'long';
}

/**
 * A call's list price on `anthropic` or `openai-responses`, or `undefined`
 * where its provider, model, tier or usage has no list price: `openai-codex`
 * bills in credits, `openrouter` and `openai-compatible` carry a third
 * party's prices, and `bedrock` AWS's. Anthropic's is `priceAnthropicCall`'s,
 * its two cache writes summed, but a Claude Sonnet 5.5 call that reads from
 * the cache gets none, since that table's read rate for it isn't the page's.
 * OpenAI's 10% uplift for regional-processing and FedRAMP endpoints isn't
 * priced.
 */
export function priceCall(call: PriceCallInput): CallPrice | undefined {
  if (call.provider === 'anthropic') return priceAnthropic(call);
  if (call.provider === 'openai-responses') return priceOpenAI(call);
  return undefined;
}

function priceAnthropic(call: PriceCallInput): CallPrice | undefined {
  if (call.cacheWrite30mTokens > 0 || call.cacheWrite12hTokens > 0) return undefined;
  // The table reads Claude Sonnet 5.5's cache at 0.1x where the pricing page
  // gives 0.05x (see its Sonnet 5 entry), so those reads have no list price here.
  if (starts(call.model, 'claude-sonnet-5-5') && call.cacheReadTokens > 0) return undefined;
  const cost = priceAnthropicCall(call.model, '', call);
  if (!cost) return undefined;
  const context = anthropicBaseRate(call.model, anthropicPromptTokens(call))?.context;
  return {
    input: cost.input,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite5m + cost.cacheWrite1h,
    output: cost.output,
    total: cost.total,
    currency: 'USD',
    pricingVersion: cost.pricingVersion,
    tier: 'standard',
    ...(context ? { context } : {}),
  };
}

export const OPENAI_PRICING_VERSION = 'openai-public-2026-11-09';

const OPENAI_LONG_CONTEXT_TOKENS = 272_000;

interface OpenAIRates {
  input: number;
  output: number;
  cached?: number;
  write30m?: number;
  write12h?: number;
}

type OpenAIRow = { short: OpenAIRates; long?: OpenAIRates } | { flat: OpenAIRates };

/**
 * OpenAI's list prices in USD per million tokens, by tier, as
 * https://developers.openai.com/api/docs/pricing gives them on 2026-11-09:
 * "Short context: ≤272K input tokens. Long context: >272K input tokens."
 * A model the page prices in its short and long columns has `short` and,
 * where the page gives one, `long`; a model it prices in one column has
 * `flat`. A rate the page shows as "-" is left out, and so is its legal
 * model configuration, gpt-6-astra-law. "Priority processing was renamed
 * Fast mode on July 30, 2026", and a call names it `fast` or `priority`
 * (https://developers.openai.com/api/docs/guides/fast-mode). "GPT-5.6 Sol’s
 * promotional pricing is available until November 30, 2026".
 */
const OPENAI_RATES: Record<'standard' | 'flex' | 'fast' | 'ultrafast', Record<string, OpenAIRow>> = {
  standard: {
    'gpt-6-astra': { short: { input: 10, output: 50, cached: 1, write30m: 12.5, write12h: 25 }, long: { input: 20, output: 75, cached: 2, write30m: 25, write12h: 50 } },
    'gpt-6.1-sol': { short: { input: 2, output: 10, cached: 0.1, write30m: 2.5, write12h: 5 }, long: { input: 4, output: 15, cached: 0.2, write30m: 5, write12h: 10 } },
    'gpt-6.1-terra': { short: { input: 1, output: 5, cached: 0.05, write30m: 1.25, write12h: 2.5 }, long: { input: 2, output: 7.5, cached: 0.1, write30m: 2.5, write12h: 5 } },
    'gpt-6-luna': { short: { input: 0.1, output: 0.5, cached: 0.01, write30m: 0.125, write12h: 0.25 }, long: { input: 0.2, output: 0.75, cached: 0.02, write30m: 0.25, write12h: 0.5 } },
    'gpt-6-sol': { short: { input: 2, output: 10, cached: 0.2, write30m: 2.5, write12h: 5 }, long: { input: 4, output: 15, cached: 0.4, write30m: 5, write12h: 10 } },
    'gpt-5.6-sol': { short: { input: 4, output: 20, cached: 0.4, write30m: 5, write12h: 10 }, long: { input: 8, output: 30, cached: 0.8, write30m: 10, write12h: 20 } },
    'gpt-5.6-terra': { short: { input: 2, output: 12, cached: 0.2, write30m: 2.5, write12h: 5 }, long: { input: 4, output: 18, cached: 0.4, write30m: 5, write12h: 10 } },
    'gpt-5.6-luna': { short: { input: 0.2, output: 1.2, cached: 0.02, write30m: 0.25, write12h: 0.5 }, long: { input: 0.4, output: 1.8, cached: 0.04, write30m: 0.5, write12h: 1 } },
    'gpt-5.5': { short: { input: 5, output: 30, cached: 0.5 }, long: { input: 10, output: 45, cached: 1 } },
    'gpt-5.5-pro': { short: { input: 30, output: 180 }, long: { input: 60, output: 270 } },
    'gpt-5.4': { short: { input: 2.5, output: 15, cached: 0.25 }, long: { input: 5, output: 22.5, cached: 0.5 } },
    'gpt-5.4-pro': { short: { input: 30, output: 180 }, long: { input: 60, output: 270 } },
    'gpt-5.4-mini': { flat: { input: 0.75, output: 4.5, cached: 0.075 } },
    'gpt-5.4-nano': { flat: { input: 0.2, output: 1.25, cached: 0.02 } },
    'gpt-5.2': { flat: { input: 1.75, output: 14, cached: 0.175 } },
    'gpt-5.2-pro': { flat: { input: 21, output: 168 } },
    'gpt-5.1': { flat: { input: 1.25, output: 10, cached: 0.125 } },
    'gpt-5': { flat: { input: 1.25, output: 10, cached: 0.125 } },
    'gpt-5-mini': { flat: { input: 0.25, output: 2, cached: 0.025 } },
    'gpt-5-nano': { flat: { input: 0.05, output: 0.4, cached: 0.005 } },
    'gpt-5-pro': { flat: { input: 15, output: 120 } },
    'gpt-4.1': { flat: { input: 2, output: 8, cached: 0.5 } },
    'gpt-4.1-mini': { flat: { input: 0.4, output: 1.6, cached: 0.1 } },
    'gpt-4o': { flat: { input: 2.5, output: 10, cached: 1.25 } },
    'gpt-4o-mini': { flat: { input: 0.15, output: 0.6, cached: 0.075 } },
    'o3-pro': { flat: { input: 20, output: 80 } },
    'o3': { flat: { input: 2, output: 8, cached: 0.5 } },
    'gpt-6-cyber': { short: { input: 20, output: 100, cached: 2, write30m: 25, write12h: 50 } },
    'gpt-5.6-cyber': { short: { input: 12.5, output: 75, cached: 1.25, write30m: 15.625, write12h: 31.25 } },
    'gpt-5.5-cyber': { short: { input: 12.5, output: 75, cached: 1.25 } },
    'gpt-6-rosalind': { short: { input: 15, output: 75, cached: 1.5, write30m: 18.75, write12h: 37.5 }, long: { input: 30, output: 112.5, cached: 3, write30m: 37.5, write12h: 75 } },
    'gpt-rosalind-research': { short: { input: 5, output: 25, cached: 0.5 } },
    'gpt-rosalind-discovery': { short: { input: 5, output: 25, cached: 0.5 } },
  },
  flex: {
    'gpt-6-astra': { short: { input: 5, output: 25, cached: 0.5, write30m: 6.25, write12h: 12.5 }, long: { input: 10, output: 37.5, cached: 1, write30m: 12.5, write12h: 25 } },
    'gpt-6.1-sol': { short: { input: 1, output: 5, cached: 0.05, write30m: 1.25, write12h: 2.5 }, long: { input: 2, output: 7.5, cached: 0.1, write30m: 2.5, write12h: 5 } },
    'gpt-6.1-terra': { short: { input: 0.5, output: 2.5, cached: 0.025, write30m: 0.625, write12h: 1.25 }, long: { input: 1, output: 3.75, cached: 0.05, write30m: 1.25, write12h: 2.5 } },
    'gpt-6-luna': { short: { input: 0.05, output: 0.25, cached: 0.005, write30m: 0.0625, write12h: 0.125 }, long: { input: 0.1, output: 0.375, cached: 0.01, write30m: 0.125, write12h: 0.25 } },
    'gpt-6-sol': { short: { input: 1, output: 5, cached: 0.1, write30m: 1.25, write12h: 2.5 }, long: { input: 2, output: 7.5, cached: 0.2, write30m: 2.5, write12h: 5 } },
    'gpt-5.6-sol': { short: { input: 2, output: 10, cached: 0.2, write30m: 2.5, write12h: 5 }, long: { input: 4, output: 15, cached: 0.4, write30m: 5, write12h: 10 } },
    'gpt-5.6-terra': { short: { input: 1, output: 6, cached: 0.1, write30m: 1.25, write12h: 2.5 }, long: { input: 2, output: 9, cached: 0.2, write30m: 2.5, write12h: 5 } },
    'gpt-5.6-luna': { short: { input: 0.1, output: 0.6, cached: 0.01, write30m: 0.125, write12h: 0.25 }, long: { input: 0.2, output: 0.9, cached: 0.02, write30m: 0.25, write12h: 0.5 } },
    'gpt-5.5': { short: { input: 2.5, output: 15, cached: 0.25 }, long: { input: 5, output: 22.5, cached: 0.5 } },
    'gpt-5.5-pro': { short: { input: 15, output: 90 } },
    'gpt-5.4': { short: { input: 1.25, output: 7.5, cached: 0.13 }, long: { input: 2.5, output: 11.25, cached: 0.25 } },
    'gpt-5.4-pro': { short: { input: 15, output: 90 }, long: { input: 30, output: 135 } },
    'gpt-5.4-mini': { flat: { input: 0.375, output: 2.25, cached: 0.0375 } },
    'gpt-5.4-nano': { flat: { input: 0.1, output: 0.625, cached: 0.01 } },
    'gpt-5.2': { flat: { input: 0.875, output: 7, cached: 0.0875 } },
    'gpt-5.1': { flat: { input: 0.625, output: 5, cached: 0.0625 } },
    'gpt-5': { flat: { input: 0.625, output: 5, cached: 0.0625 } },
    'gpt-5-mini': { flat: { input: 0.125, output: 1, cached: 0.0125 } },
    'gpt-5-nano': { flat: { input: 0.025, output: 0.2, cached: 0.0025 } },
    'o3': { flat: { input: 1, output: 4, cached: 0.25 } },
  },
  fast: {
    'gpt-6-astra': { short: { input: 20, output: 100, cached: 2, write30m: 25, write12h: 50 }, long: { input: 40, output: 150, cached: 4, write30m: 50, write12h: 100 } },
    'gpt-6.1-sol': { short: { input: 4, output: 20, cached: 0.2, write30m: 5, write12h: 10 }, long: { input: 8, output: 30, cached: 0.4, write30m: 10, write12h: 20 } },
    'gpt-6.1-terra': { short: { input: 2, output: 10, cached: 0.1, write30m: 2.5, write12h: 5 }, long: { input: 4, output: 15, cached: 0.2, write30m: 5, write12h: 10 } },
    'gpt-6-luna': { short: { input: 0.2, output: 1, cached: 0.02, write30m: 0.25, write12h: 0.5 }, long: { input: 0.4, output: 1.5, cached: 0.04, write30m: 0.5, write12h: 1 } },
    'gpt-6-sol': { short: { input: 4, output: 20, cached: 0.4, write30m: 5, write12h: 10 }, long: { input: 8, output: 30, cached: 0.8, write30m: 10, write12h: 20 } },
    'gpt-5.6-sol': { short: { input: 8, output: 40, cached: 0.8, write30m: 10, write12h: 20 }, long: { input: 16, output: 60, cached: 1.6, write30m: 20, write12h: 40 } },
    'gpt-5.6-terra': { short: { input: 4, output: 24, cached: 0.4, write30m: 5, write12h: 10 }, long: { input: 8, output: 36, cached: 0.8, write30m: 10, write12h: 20 } },
    'gpt-5.6-luna': { short: { input: 0.4, output: 2.4, cached: 0.04, write30m: 0.5, write12h: 1 }, long: { input: 0.8, output: 3.6, cached: 0.08, write30m: 1, write12h: 2 } },
    'gpt-5.5': { short: { input: 12.5, output: 75, cached: 1.25 } },
    'gpt-5.4': { short: { input: 5, output: 30, cached: 0.5 } },
    'gpt-5.4-mini': { flat: { input: 1.5, output: 9, cached: 0.15 } },
    'gpt-5.2': { flat: { input: 3.5, output: 28, cached: 0.35 } },
    'gpt-5.1': { flat: { input: 2.5, output: 20, cached: 0.25 } },
    'gpt-5': { flat: { input: 2.5, output: 20, cached: 0.25 } },
    'gpt-5-mini': { flat: { input: 0.45, output: 3.6, cached: 0.045 } },
    'gpt-4.1': { flat: { input: 3.5, output: 14, cached: 0.875 } },
    'gpt-4.1-mini': { flat: { input: 0.7, output: 2.8, cached: 0.175 } },
    'gpt-4o': { flat: { input: 4.25, output: 17, cached: 2.125 } },
    'gpt-4o-mini': { flat: { input: 0.25, output: 1, cached: 0.125 } },
    'o3': { flat: { input: 3.5, output: 14, cached: 0.875 } },
  },
  ultrafast: {
    'gpt-6-astra': { short: { input: 60, output: 300, cached: 6, write30m: 75, write12h: 150 }, long: { input: 120, output: 450, cached: 12, write30m: 150, write12h: 300 } },
    'gpt-6.1-sol': { short: { input: 12, output: 60, cached: 0.6, write30m: 15, write12h: 30 }, long: { input: 24, output: 90, cached: 1.2, write30m: 30, write12h: 60 } },
  },
};

function openaiTier(serviceTier: string | undefined): keyof typeof OPENAI_RATES | undefined {
  const tier = serviceTier?.toLowerCase();
  if (tier === undefined || tier === 'default') return 'standard';
  if (tier === 'flex') return 'flex';
  if (tier === 'fast' || tier === 'priority') return 'fast';
  if (tier === 'ultrafast') return 'ultrafast';
  return undefined;
}

function priceOpenAI(call: PriceCallInput): CallPrice | undefined {
  const tier = openaiTier(call.serviceTier);
  if (!tier) return undefined;
  const name = call.model.replace(/^openai\//, '');
  const row = Object.hasOwn(OPENAI_RATES[tier], name) ? OPENAI_RATES[tier][name] : undefined;
  if (!row) return undefined;
  if (call.cacheWrite5mTokens > 0 || call.cacheWrite1hTokens > 0 || call.unclassifiedCacheWriteTokens > 0) return undefined;

  const promptTokens = call.inputTokens + call.cacheReadTokens + call.cacheWrite30mTokens + call.cacheWrite12hTokens;
  const context = 'flat' in row ? undefined : promptTokens > OPENAI_LONG_CONTEXT_TOKENS ? 'long' : 'short';
  const rates = 'flat' in row ? row.flat : row[context!];
  if (!rates) return undefined;
  if ((call.cacheReadTokens > 0 && rates.cached === undefined)
    || (call.cacheWrite30mTokens > 0 && rates.write30m === undefined)
    || (call.cacheWrite12hTokens > 0 && rates.write12h === undefined)) return undefined;

  const priced = (tokens: number, perMillion = 0) => tokens * perMillion / 1_000_000;
  const input = priced(call.inputTokens, rates.input);
  const cacheRead = priced(call.cacheReadTokens, rates.cached);
  const cacheWrite = priced(call.cacheWrite30mTokens, rates.write30m) + priced(call.cacheWrite12hTokens, rates.write12h);
  const output = priced(call.outputTokens, rates.output);
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    total: input + cacheRead + cacheWrite + output,
    currency: 'USD',
    pricingVersion: OPENAI_PRICING_VERSION,
    tier,
    ...(context ? { context } : {}),
  };
}

/** Whether one of `prefixes` names `model`: the model is the prefix, or goes
 *  on from it with anything but a digit, unless the prefix itself ends in
 *  `-`. So 'claude-fable-5' names 'claude-fable-5-20260301', and
 *  'claude-fable-5-2' doesn't. */
function starts(model: string, ...prefixes: string[]): boolean {
  return prefixes.some((prefix) =>
    model.startsWith(prefix) && (prefix.endsWith('-') || !/^\d/.test(model.slice(prefix.length))));
}

function rate(
  inputPerMillion: number,
  outputPerMillion: number,
  cacheReadMultiplier: number = DEFAULT_CACHE_READ_MULTIPLIER,
): BaseRate {
  return { inputPerMillion, outputPerMillion, cacheReadMultiplier };
}
