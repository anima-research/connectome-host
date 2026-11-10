/**
 * `<recovered_thinking>` text blocks: how scripts/import-claudeai-export.ts
 * carries a claude.ai export's thinking, which has no signatures, into the
 * assistant turns it imports.
 *
 * Some models refuse a request that carries one (`stop_reason: "refusal"`,
 * category `reasoning_extraction`, 0 output tokens): on 2026-11-10 Opus 5,
 * Opus 5.5 and the Fable models refused even an empty tag, and the same thought
 * under another label, while every Sonnet and Haiku and Opus 4.8 and older took
 * it. Rather than keep a list of models, the Anthropic adapter learns it: the
 * first such refusal of a request that carries these blocks marks the model,
 * the request is sent again without them, and from then on they are left out
 * of that model's requests. The store keeps them.
 */

const WRAPPED = /^\s*<recovered_thinking>([\s\S]*)<\/recovered_thinking>\s*$/;

export type RecoveredThinkingVerdict = 'remove' | 'keep' | 'mixed';

/** One content block: `remove` for a whole text block of the importer's shape,
 *  `mixed` for a text block that mentions the tag beside other text (left
 *  alone), `keep` for everything else. `emptyOnly` keeps non-empty ones. */
export function classifyRecoveredThinking(block: unknown, emptyOnly = false): RecoveredThinkingVerdict {
  const b = block as { type?: unknown; text?: unknown } | null;
  if (!b || b.type !== 'text' || typeof b.text !== 'string') return 'keep';
  if (!b.text.includes('<recovered_thinking>')) return 'keep';
  const m = WRAPPED.exec(b.text);
  if (!m || m[1]!.includes('<recovered_thinking>')) return 'mixed';
  if (emptyOnly && m[1]!.trim() !== '') return 'keep';
  return 'remove';
}

const LEFT_OUT = '[earlier thinking left out]';

/**
 * Anthropic-format messages without their recovered-thinking blocks, or the
 * same array when none has one. A removed block's `cache_control` moves to the
 * block before it (or after it), so the cache breakpoints stay where they were
 * counted; a message left with nothing keeps one short text block in its place.
 */
export function stripRecoveredThinking(messages: unknown[]): unknown[] {
  let changed = false;
  const out = messages.map((message) => {
    const m = message as { content?: unknown } | null;
    if (!m || !Array.isArray(m.content)) return message;
    if (!m.content.some((b) => classifyRecoveredThinking(b) === 'remove')) return message;
    changed = true;
    const kept: Array<Record<string, unknown>> = [];
    let pendingCache: unknown;
    for (const block of m.content as Array<Record<string, unknown>>) {
      if (classifyRecoveredThinking(block) !== 'remove') {
        kept.push(pendingCache !== undefined && block.cache_control === undefined
          ? { ...block, cache_control: pendingCache }
          : block);
        pendingCache = undefined;
        continue;
      }
      if (block.cache_control === undefined) continue;
      const prev = kept[kept.length - 1];
      if (prev) kept[kept.length - 1] = { ...prev, cache_control: block.cache_control };
      else pendingCache = block.cache_control;
    }
    if (kept.length === 0) {
      kept.push({ type: 'text', text: LEFT_OUT, ...(pendingCache !== undefined ? { cache_control: pendingCache } : {}) });
    }
    return { ...(message as object), content: kept };
  });
  return changed ? out : messages;
}

export function hasRecoveredThinking(messages: unknown[]): boolean {
  return stripRecoveredThinking(messages) !== messages;
}

/** Models found in this process to refuse requests that carry these blocks. */
const refusingModels = new Set<string>();

export function recoveredThinkingRefused(model: string): boolean {
  return refusingModels.has(model);
}

export function recordRecoveredThinkingRefused(model: string): void {
  refusingModels.add(model);
}

/** For tests. */
export function resetRecoveredThinkingRefusals(): void {
  refusingModels.clear();
}

/** A reasoning_extraction refusal before any output: the shape these blocks draw. */
export function isRecoveredThinkingRefusal(response: {
  stopReason?: string;
  providerStopReason?: string;
  refusalCategory?: string;
  usage?: { outputTokens?: number };
}): boolean {
  const refused = response.stopReason === 'refusal' || response.providerStopReason === 'refusal';
  return refused && response.refusalCategory === 'reasoning_extraction' && (response.usage?.outputTokens ?? 0) === 0;
}
