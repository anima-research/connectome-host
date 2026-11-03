/** A model's window and maximum output, in tokens, as its provider's API enforces them. */
export interface ModelLimits {
  maxContextTokens: number;
  maxOutputTokens: number;
}

interface LimitsRow extends ModelLimits {
  id: string;
}

const ONE_M: ModelLimits = { maxContextTokens: 1_000_000, maxOutputTokens: 128_000 };
const TWO_HUNDRED_K: ModelLimits = { maxContextTokens: 200_000, maxOutputTokens: 64_000 };

// From Anthropic's docs, read 2026-10-26 (claude-mythos-preview's row 2026-10-27):
// https://platform.claude.com/docs/en/build-with-claude/context-windows names
// the 1M-window models and their 128k output, and puts every other model at
// 200k; https://platform.claude.com/docs/en/models/sonnet-4-5/overview gives
// Sonnet 4.5's 64k output. The API refuses a prompt over the window, and a
// max_tokens over the maximum output. Anthropic retired Sonnet 4.5's 1M beta,
// `context-1m-2025-08-07`, on 2026-04-30: the header has no effect, and a
// request past 200k is refused
// (https://platform.claude.com/docs/en/release-notes/overview), so its row is
// 200k whatever betas a recipe sends.
export const LIMITS_TABLE: readonly LimitsRow[] = [
  { id: 'claude-fable-5-1', ...ONE_M },
  { id: 'claude-fable-5', ...ONE_M },
  { id: 'claude-mythos-5-1', ...ONE_M },
  { id: 'claude-mythos-5', ...ONE_M },
  { id: 'claude-mythos-preview', ...ONE_M },
  { id: 'claude-opus-5-5', ...ONE_M },
  { id: 'claude-opus-5', ...ONE_M },
  { id: 'claude-sonnet-5-5', ...ONE_M },
  { id: 'claude-sonnet-5', ...ONE_M },
  { id: 'claude-haiku-5-5', ...ONE_M },
  { id: 'claude-opus-4-8', ...ONE_M },
  { id: 'claude-opus-4-7', ...ONE_M },
  { id: 'claude-opus-4-6', ...ONE_M },
  { id: 'claude-sonnet-4-6', ...ONE_M },
  { id: 'claude-opus-4-5', ...TWO_HUNDRED_K },
  { id: 'claude-sonnet-4-5', ...TWO_HUNDRED_K },
  { id: 'claude-haiku-4-5', ...TWO_HUNDRED_K },
];

/**
 * The window and maximum output Anthropic's API enforces for `modelId`, from
 * the row whose id it is, alone or followed by a snapshot date (`-YYYYMMDD`);
 * undefined for any other id. The table holds Claude models on Anthropic's
 * own API: other providers' limits for the same id can differ.
 */
export function getDefaultModelLimits(modelId: string): ModelLimits | undefined {
  const row = LIMITS_TABLE.find((r) =>
    modelId === r.id || (modelId.startsWith(`${r.id}-`) && /^\d{8}$/.test(modelId.slice(r.id.length + 1))));
  return row && { maxContextTokens: row.maxContextTokens, maxOutputTokens: row.maxOutputTokens };
}
