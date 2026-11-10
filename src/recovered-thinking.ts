/**
 * `<recovered_thinking>` text blocks: how scripts/import-claudeai-export.ts
 * carries a claude.ai export's thinking, which has no signatures, into the
 * assistant turns it imports.
 *
 * Some models refuse a request that carries one (`stop_reason: "refusal"`,
 * category `reasoning_extraction`, 0 output tokens): on 2026-11-10 Opus 5,
 * Opus 5.5 and the Fable models refused even an empty tag, and the same thought
 * under another label, while every Sonnet and Haiku and Opus 4.8 and older took
 * it. Rather than keep a list of models, the provider adapters learn it: a
 * refusal of a request that went out carrying these blocks marks the model,
 * that request is sent again without them, and from then on they are left out
 * of that model's requests. The store keeps them.
 *
 * What is left out: a whole text block of the importer's shape, and each
 * complete `<recovered_thinking>…</recovered_thinking>` span inside other text
 * (a transcript rendered into one block, as compression requests do, or
 * string content), replaced by a short marker. A lone mention of the tag with
 * no closing tag is ordinary prose and is left alone. System prompts and tool
 * definitions are operator text and are not rewritten.
 */

import type { ProviderRequest, ProviderResponse, StreamCallbacks } from '@animalabs/membrane';

const WRAPPED = /^\s*<recovered_thinking>([\s\S]*)<\/recovered_thinking>\s*$/;
const SPAN = /<recovered_thinking>[\s\S]*?<\/recovered_thinking>/g;

/** What a left-out block or span is replaced by. */
export const LEFT_OUT = '[earlier thinking left out]';

export type RecoveredThinkingVerdict = 'remove' | 'keep' | 'mixed';

/** One content block: `remove` for a whole text block of the importer's shape,
 *  `mixed` for a text block that mentions the tag beside other text, `keep`
 *  for everything else. `emptyOnly` keeps non-empty ones. */
export function classifyRecoveredThinking(block: unknown, emptyOnly = false): RecoveredThinkingVerdict {
  const b = block as { type?: unknown; text?: unknown } | null;
  if (!b || b.type !== 'text' || typeof b.text !== 'string') return 'keep';
  if (!b.text.includes('<recovered_thinking>')) return 'keep';
  const m = WRAPPED.exec(b.text);
  if (!m || m[1]!.includes('<recovered_thinking>')) return 'mixed';
  if (emptyOnly && m[1]!.trim() !== '') return 'keep';
  return 'remove';
}

/** Text with each complete span replaced by the marker, or the same string when it has none. */
function withoutSpans(text: string): string {
  if (!text.includes('<recovered_thinking>')) return text;
  return text.replace(SPAN, LEFT_OUT);
}

/**
 * Anthropic-format messages without their recovered thinking, or the same
 * array when none has any. A removed block's `cache_control` moves to the
 * block before it (or after it), so the cache breakpoints stay where they were
 * counted; a message left with nothing keeps one short text block in its
 * place. Spans inside other text, and string content, are replaced by the
 * marker in place.
 */
export function stripRecoveredThinking(messages: unknown[]): unknown[] {
  let changed = false;
  const out = messages.map((message) => {
    const m = message as { content?: unknown } | null;
    if (!m) return message;
    if (typeof m.content === 'string') {
      const text = WRAPPED.test(m.content) ? LEFT_OUT : withoutSpans(m.content);
      if (text === m.content) return message;
      changed = true;
      return { ...(message as object), content: text };
    }
    if (!Array.isArray(m.content)) return message;
    let touched = false;
    const kept: Array<Record<string, unknown>> = [];
    let pendingCache: unknown;
    for (const block of m.content as Array<Record<string, unknown>>) {
      const verdict = classifyRecoveredThinking(block);
      if (verdict !== 'remove') {
        let next = block;
        if (verdict === 'mixed') {
          const text = withoutSpans(block.text as string);
          if (text !== block.text) { next = { ...block, text }; touched = true; }
        }
        kept.push(pendingCache !== undefined && next.cache_control === undefined
          ? { ...next, cache_control: pendingCache }
          : next);
        pendingCache = undefined;
        continue;
      }
      touched = true;
      if (block.cache_control === undefined) continue;
      const prev = kept[kept.length - 1];
      if (prev) kept[kept.length - 1] = { ...prev, cache_control: block.cache_control };
      else pendingCache = block.cache_control;
    }
    if (!touched) return message;
    changed = true;
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

/**
 * A reasoning_extraction refusal before any output: the shape these blocks
 * draw. Reads membrane's normalized fields and falls back to the raw
 * Anthropic message (`stop_reason`, `stop_details.category`,
 * `usage.output_tokens`), for an adapter or decorator that leaves the
 * normalized ones out.
 */
export function isRecoveredThinkingRefusal(response: unknown): boolean {
  const r = (response ?? {}) as {
    stopReason?: unknown;
    providerStopReason?: unknown;
    refusalCategory?: unknown;
    usage?: { outputTokens?: unknown };
    raw?: unknown;
  };
  const raw = (r.raw && typeof r.raw === 'object' ? r.raw : {}) as {
    stop_reason?: unknown;
    stop_details?: { category?: unknown } | null;
    usage?: { output_tokens?: unknown } | null;
  };
  const refused = r.stopReason === 'refusal' || r.providerStopReason === 'refusal' || raw.stop_reason === 'refusal';
  if (!refused) return false;
  const category = typeof r.refusalCategory === 'string' ? r.refusalCategory : raw.stop_details?.category;
  if (category !== 'reasoning_extraction') return false;
  const outputTokens = typeof r.usage?.outputTokens === 'number' ? r.usage.outputTokens : raw.usage?.output_tokens;
  return (typeof outputTokens === 'number' ? outputTokens : 0) === 0;
}

/**
 * The request as it should go out, and whether it still carries recovered
 * thinking: true only while the model isn't marked yet. Decided per request,
 * when it is sent, so a refusal is answered from what that request carried,
 * not from a mark another request's refusal set while this one was out.
 */
export function prepareRecoveredThinking(request: ProviderRequest): { request: ProviderRequest; carried: boolean } {
  // Never in the way of a call: a request this can't read goes out as it is,
  // for the provider to answer.
  try {
    const messages = request.messages;
    if (!Array.isArray(messages)) return { request, carried: false };
    if (!recoveredThinkingRefused(request.model)) {
      return { request, carried: hasRecoveredThinking(messages) };
    }
    const stripped = stripRecoveredThinking(messages);
    return { request: stripped === messages ? request : { ...request, messages: stripped }, carried: false };
  } catch {
    return { request, carried: false };
  }
}

/**
 * True when the caller should send the request again without the blocks: it
 * went out carrying them, was refused for them, and nothing of it reached the
 * caller. Such a refusal marks the model (logging once, the first time) even
 * when something did reach the caller, so the model's later requests leave
 * the blocks out.
 */
export function resendWithoutRecoveredThinking(
  model: string,
  carried: boolean,
  response: unknown,
  delivered = false,
): boolean {
  if (!carried) return false;
  try {
    if (!isRecoveredThinkingRefusal(response)) return false;
  } catch {
    return false;
  }
  if (!recoveredThinkingRefused(model)) {
    recordRecoveredThinkingRefused(model);
    console.error(
      `[recovered-thinking] ${model} refused a request carrying <recovered_thinking> blocks ` +
      '(reasoning_extraction); they are left out of its requests from now on (the store keeps them).',
    );
  }
  return !delivered;
}

/** Callbacks that note whether anything of the response reached the caller. */
export function watchDelivery(callbacks: StreamCallbacks): { callbacks: StreamCallbacks; delivered: () => boolean } {
  let delivered = false;
  return {
    delivered: () => delivered,
    callbacks: {
      ...callbacks,
      onChunk: (chunk) => { delivered = true; callbacks.onChunk(chunk); },
      ...(callbacks.onContentBlock
        ? { onContentBlock: (i: number, b: unknown) => { delivered = true; callbacks.onContentBlock!(i, b); } }
        : {}),
      ...(callbacks.onThinkingSignature
        ? { onThinkingSignature: (i: number, s: string) => { delivered = true; callbacks.onThinkingSignature!(i, s); } }
        : {}),
    },
  };
}

/**
 * The whole guard for an adapter with no other resend logic of its own
 * (Bedrock, and the provider-agnostic decorator): prepares the request, sends
 * it, and sends it again once without the blocks when it was refused for
 * them. `send` gets watched callbacks on a stream, and undefined on complete().
 */
export async function sendWithRecoveredThinkingGuard(
  request: ProviderRequest,
  callbacks: StreamCallbacks | undefined,
  send: (request: ProviderRequest, callbacks: StreamCallbacks | undefined) => Promise<ProviderResponse>,
): Promise<ProviderResponse> {
  const prepared = prepareRecoveredThinking(request);
  const watched = prepared.carried && callbacks ? watchDelivery(callbacks) : undefined;
  const response = await send(prepared.request, watched?.callbacks ?? callbacks);
  if (resendWithoutRecoveredThinking(request.model, prepared.carried, response, watched?.delivered() ?? false)) {
    return sendWithRecoveredThinkingGuard(request, callbacks, send);
  }
  return response;
}
