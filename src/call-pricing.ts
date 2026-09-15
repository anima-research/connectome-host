/**
 * Provider-call pricing used by the operator ledger.
 *
 * Rates are USD per million tokens and are applied to the provider's
 * authoritative usage buckets. Cache creation MUST remain split by TTL:
 * Anthropic bills 5m writes at 1.25x input and 1h writes at 2x input.
 *
 * Cache READS are 0.1x input on every model but one: Claude Fable 5.1 reads
 * at 0.025x ($0.25/MTok), a quarter of Fable 5's rate. That exception is not
 * cosmetic for long-lived agents — a resident re-reading a 260k prefix on
 * every call spends most of its bill on cache reads, so charging them at 0.1x
 * overstates its total roughly fourfold.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 * Snapshot: 2026-09-10. Keep the version string/date auditable; silently
 * changing historical prices would make old JSONL replay disagree with bills.
 */

import type { CallCostBreakdown } from './web/protocol.js';

export const ANTHROPIC_PRICING_VERSION = 'anthropic-public-2026-09-10';

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
  timestamp: string,
  usage: PriceableCallUsage,
): CallCostBreakdown | undefined {
  const rate = anthropicBaseRate(model, timestamp);
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

function anthropicBaseRate(model: string, timestamp: string): BaseRate | undefined {
  // Fable 5.1 first: its prefix also matches the Fable 5 test below, and it is
  // the one model that reads from cache at 0.025x rather than 0.1x. Whether
  // Mythos 5.1 shares that rate is unconfirmed, so it keeps the default —
  // overcharging a figure we label "billing" is the safer direction to be
  // wrong in, and the exception is one line to add once it is confirmed.
  if (starts(model, 'claude-fable-5-1')) return rate(10, 50, 0.025);

  // Fable 5 and Mythos 5 share pricing.
  if (starts(model, 'claude-fable-5', 'claude-mythos-5')) return rate(10, 50);

  if (starts(model,
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-opus-4-5',
  )) return rate(5, 25);

  // Sonnet 5 launch pricing is promotional through 2026-08-31 inclusive.
  if (starts(model, 'claude-sonnet-5')) {
    const at = Date.parse(timestamp);
    const promoEnd = Date.parse('2026-09-01T00:00:00Z');
    return Number.isFinite(at) && at < promoEnd ? rate(2, 10) : rate(3, 15);
  }

  if (starts(model,
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'claude-sonnet-4-',
    'claude-3-7-sonnet',
    'claude-3-5-sonnet',
  )) return rate(3, 15);

  if (starts(model, 'claude-haiku-4-5')) return rate(1, 5);
  if (starts(model, 'claude-3-5-haiku')) return rate(0.8, 4);

  if (starts(model, 'claude-opus-4-1', 'claude-opus-4-')) return rate(15, 75);
  return undefined;
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
