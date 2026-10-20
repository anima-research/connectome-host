/**
 * Provider-call pricing used by the operator ledger.
 *
 * Rates are USD per million tokens and are applied to the provider's
 * authoritative usage buckets. Cache creation MUST remain split by TTL:
 * Anthropic bills 5m writes at 1.25x input and 1h writes at 2x input.
 *
 * Anthropic bills cache READS at 0.1x input on every model but four: Claude
 * Fable 5.1 and Claude Mythos 5.1 read at 0.025x ($0.25/MTok), a quarter of
 * the 5 pair's rate, and Claude Opus 5.5 and Claude Sonnet 5.5 at 0.05x
 * ($0.20 and $0.10/MTok). Those exceptions are not cosmetic for long-lived
 * agents — a resident re-reading a 260k prefix on every call spends most of
 * its bill on cache reads, so charging them at 0.1x overstates its total two-
 * to fourfold. This table gives the first three their rates, and Sonnet 5.5
 * 0.1x: see the Sonnet 5 entry.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * Snapshot: 2026-10-19 (Haiku 5.5 added; it had matched no entry and went
 * unpriced). Keep the version string/date auditable; silently changing
 * historical prices would make old JSONL replay disagree with bills.
 */

import type { CallCostBreakdown } from './web/protocol.js';

export const ANTHROPIC_PRICING_VERSION = 'anthropic-public-2026-10-19';

/** Cache reads bill at this multiple of base input on every model that does
 *  not override it. */
const DEFAULT_CACHE_READ_MULTIPLIER = 0.1;

interface BaseRate {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Defaults to {@link DEFAULT_CACHE_READ_MULTIPLIER}. */
  cacheReadMultiplier: number;
}

export interface PriceableCallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  /** Non-zero means the provider reported creation tokens we could not place
   *  in an authoritative TTL bucket. Such a call is deliberately unpriced. */
  unclassifiedCacheWriteTokens: number;
  inferenceGeo?: string;
  serviceTier?: string;
}

export function priceAnthropicCall(
  model: string,
  // No rate in the current table is date-bounded; kept so a future dated
  // price change does not have to re-plumb every caller.
  _timestamp: string,
  usage: PriceableCallUsage,
): CallCostBreakdown | undefined {
  // A request's prompt length, which Claude Haiku 5.5's price depends on,
  // counts all of its input tokens: uncached input, cache reads and writes.
  const promptTokens = usage.inputTokens + usage.cacheReadTokens
    + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;
  const rate = anthropicBaseRate(model, promptTokens);
  if (!rate || usage.unclassifiedCacheWriteTokens > 0) return undefined;

  // Public list pricing covers standard service. Priority Tier is contract
  // priced; returning no figure is safer than presenting a plausible lie.
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

/** A model's rates, for a request whose prompt is `promptTokens` long. Only
 *  Claude Haiku 5.5's depend on it. */
function anthropicBaseRate(model: string, promptTokens: number): BaseRate | undefined {
  // The 5.1 pair first: their prefixes also match the Fable 5 / Mythos 5 test
  // below, and they are the two models that read from cache at 0.025x rather
  // than 0.1x. The pricing page's footnote on the cache-hit column: "Cache
  // hits and refreshes on Claude Fable 5.1 and Claude Mythos 5.1 are priced
  // at 0.025x the base input price. All other models use the standard 0.1x
  // multiplier." (platform.claude.com/docs/en/about-claude/pricing, read
  // 2026-09-16; the prompt-caching section repeats it.)
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

  // Sonnet 5 launched at $2/$10 as introductory pricing through 2026-08-31,
  // with a move to $3/$15 scheduled for 2026-09-01. That increase was
  // withdrawn: "The $2/$10 per million input/output token pricing for Claude
  // Sonnet 5 ... is now the standard price. The previously scheduled increase
  // to $3/$15 ... on September 1, 2026 will not occur." (pricing page, read
  // 2026-09-21.) So there is no cutoff; every call is $2/$10.
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
  if (starts(model, 'claude-haiku-5-5')) return promptTokens > 100_000 ? rate(0.5, 2.5) : rate(0.1, 0.5);

  if (starts(model, 'claude-haiku-4-5')) return rate(1, 5);
  if (starts(model, 'claude-3-5-haiku')) return rate(0.8, 4);

  if (starts(model, 'claude-opus-4-1', 'claude-opus-4-')) return rate(15, 75);
  return undefined;
}

/**
 * Cache-read price as a multiple of the model's base input price, for a
 * Claude model id as a recipe names it: a Bedrock region prefix
 * (`global.anthropic.`) or a gateway prefix (`anthropic/`) is stripped first.
 * Models this table doesn't know get the standard 0.1x. Claude Haiku 5.5's two
 * prompt-length tiers both read at 0.1x, so the multiple doesn't depend on a
 * prompt's length.
 */
export function anthropicCacheReadMultiplier(model: string): number {
  const bare = model.replace(/^(?:[a-z]+\.)?anthropic[./]/, '');
  return anthropicBaseRate(bare, 0)?.cacheReadMultiplier ?? DEFAULT_CACHE_READ_MULTIPLIER;
}

/**
 * OpenAI cache prices as multiples of a model's uncached input, for the
 * standard kv-unified block (the ledger doesn't price OpenAI calls).
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
 * https://learn.chatgpt.com/docs/pricing, read 2026-10-17. A gateway prefix
 * (`openai/`) is stripped first.
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

function starts(model: string, ...prefixes: string[]): boolean {
  return prefixes.some((prefix) => model.startsWith(prefix));
}

function rate(
  inputPerMillion: number,
  outputPerMillion: number,
  cacheReadMultiplier: number = DEFAULT_CACHE_READ_MULTIPLIER,
): BaseRate {
  return { inputPerMillion, outputPerMillion, cacheReadMultiplier };
}
