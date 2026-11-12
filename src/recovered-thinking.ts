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
 * request that went out carrying these blocks and was refused that way is
 * sent again once without them, and only when that resend is not refused the
 * same way is the model marked (R1-1: a refusal for some other reason marks
 * nothing). From then on, for the life of the process, the blocks are left
 * out of that model's requests. The store keeps them.
 *
 * What is left out: a whole text block of the importer's shape, and each
 * complete `<recovered_thinking>…</recovered_thinking>` span inside other text
 * (a transcript rendered into one block, as compression requests do, string
 * content, or the text of a `tool_result`), replaced by a short marker. A lone
 * mention of the tag with no closing tag is ordinary prose and is left alone.
 * System prompts and tool definitions are operator text and are not rewritten.
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

const isThinkingBlock = (block: Record<string, unknown> | undefined): boolean =>
  block?.type === 'thinking' || block?.type === 'redacted_thinking';

/** Of two cache markers, the one that keeps the cache longer: a 1h TTL
 *  outlasts the default. */
function longerCache(a: unknown, b: unknown): unknown {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const ttl = (c: unknown) => (c as { ttl?: unknown } | null)?.ttl;
  return ttl(b) === '1h' && ttl(a) !== '1h' ? b : a;
}

/** A `tool_result` with its spans replaced, or the same block when it has none. */
function toolResultWithoutSpans(block: Record<string, unknown>): Record<string, unknown> {
  const content = block.content;
  if (typeof content === 'string') {
    const text = withoutSpans(content);
    return text === content ? block : { ...block, content: text };
  }
  if (!Array.isArray(content)) return block;
  let touched = false;
  const out = (content as Array<Record<string, unknown>>).map((inner) => {
    if (inner?.type !== 'text' || typeof inner.text !== 'string') return inner;
    const text = withoutSpans(inner.text);
    if (text === inner.text) return inner;
    touched = true;
    return { ...inner, text };
  });
  return touched ? { ...block, content: out } : block;
}

/**
 * Anthropic-format messages without their recovered thinking, or the same
 * array when none has any. A removed block's `cache_control` moves to the
 * nearest block before it (or after it) that isn't a thinking block, keeping
 * the longer TTL where that block already has one, so the cache breakpoints
 * stay where they were counted; a message left with nothing keeps one short
 * text block in its place. Spans inside other text, string content and
 * `tool_result` text are replaced by the marker in place.
 */
export function stripRecoveredThinking(messages: unknown[]): unknown[] {
  let changed = false;
  const out = messages.map((message) => {
    const m = message as { content?: unknown } | null;
    if (!m) return message;
    if (typeof m.content === 'string') {
      const text = withoutSpans(m.content);
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
        } else if (block?.type === 'tool_result') {
          next = toolResultWithoutSpans(block);
          if (next !== block) touched = true;
        }
        if (pendingCache !== undefined && !isThinkingBlock(next)) {
          next = { ...next, cache_control: longerCache(next.cache_control, pendingCache) };
          pendingCache = undefined;
        }
        kept.push(next);
        continue;
      }
      touched = true;
      if (block.cache_control === undefined) continue;
      let i = kept.length - 1;
      while (i >= 0 && isThinkingBlock(kept[i])) i--;
      if (i >= 0) kept[i] = { ...kept[i]!, cache_control: longerCache(kept[i]!.cache_control, block.cache_control) };
      else pendingCache = longerCache(pendingCache, block.cache_control);
    }
    if (!touched) return message;
    changed = true;
    if (kept.length === 0 || kept.every(isThinkingBlock)) {
      kept.push({ type: 'text', text: LEFT_OUT, ...(pendingCache !== undefined ? { cache_control: pendingCache } : {}) });
    } else if (pendingCache !== undefined) {
      // Only thinking blocks followed the removed one: the marker goes on the
      // last block that can carry it.
      let i = kept.length - 1;
      while (i >= 0 && isThinkingBlock(kept[i])) i--;
      if (i >= 0) kept[i] = { ...kept[i]!, cache_control: longerCache(kept[i]!.cache_control, pendingCache) };
    }
    return { ...(message as object), content: kept };
  });
  return changed ? out : messages;
}

export function hasRecoveredThinking(messages: unknown[]): boolean {
  return stripRecoveredThinking(messages) !== messages;
}

/**
 * One key per model, so a dated snapshot, a Bedrock or routing prefix, a
 * Bedrock version suffix or a `[1m]` suffix shares its model's mark (R1-10).
 */
export function recoveredThinkingModelKey(model: string): string {
  let id = model.toLowerCase().trim().replace(/\[[^\]]*\]$/, '');
  const claude = id.indexOf('claude-');
  if (claude > 0) id = id.slice(claude);
  return id
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/(\d)\.(\d)/g, '$1-$2');
}

/** Models found in this process to refuse requests that carry these blocks. */
const refusingModels = new Set<string>();

export function recoveredThinkingRefused(model: string): boolean {
  return refusingModels.has(recoveredThinkingModelKey(model));
}

export function recordRecoveredThinkingRefused(model: string): void {
  refusingModels.add(recoveredThinkingModelKey(model));
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
 * thinking. `withoutBlocks` is the confirming resend: the blocks are left out
 * though the model isn't marked. Decided per request, when it is sent, so a
 * refusal is answered from what that request carried, not from a mark another
 * request's resend set while this one was out.
 */
export function prepareRecoveredThinking(
  request: ProviderRequest,
  withoutBlocks = false,
): { request: ProviderRequest; carried: boolean } {
  // Never in the way of a call: a request this can't read goes out as it is,
  // for the provider to answer.
  try {
    const messages = request.messages;
    if (!Array.isArray(messages)) return { request, carried: false };
    if (!withoutBlocks && !recoveredThinkingRefused(request.model)) {
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
 * went out carrying them, was refused the way they draw, and nothing of it
 * reached the caller. Marks nothing: the resend's outcome decides that
 * (`confirmRecoveredThinkingRefusal`).
 */
export function resendWithoutRecoveredThinking(
  carried: boolean,
  response: unknown,
  delivered = false,
): boolean {
  if (!carried || delivered) return false;
  try {
    return isRecoveredThinkingRefusal(response);
  } catch {
    return false;
  }
}

/**
 * The resend's outcome: when it was not refused the same way, the blocks were
 * the cause, and the model is marked (logging once). When it was, the refusal
 * had another cause, and nothing is marked: the model keeps getting the blocks.
 */
export function confirmRecoveredThinkingRefusal(model: string, resendResponse: unknown): void {
  let refusedAgain: boolean;
  try {
    refusedAgain = isRecoveredThinkingRefusal(resendResponse);
  } catch {
    return;
  }
  if (refusedAgain) {
    console.error(
      `[recovered-thinking] ${model} refused a request carrying <recovered_thinking> blocks (reasoning_extraction), ` +
      'and refused it again without them: not the blocks, so they stay in its requests.',
    );
    return;
  }
  if (recoveredThinkingRefused(model)) return;
  recordRecoveredThinkingRefused(model);
  console.error(
    `[recovered-thinking] ${model} refused a request carrying <recovered_thinking> blocks (reasoning_extraction) ` +
    'and answered it without them; they are left out of its requests for the life of this process (the store keeps them).',
  );
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
 * (Bedrock, the provider-agnostic decorator, and warmup's bare adapter):
 * prepares the request, sends it, and sends it once more without the blocks
 * when it was refused for them, marking the model only if that resend isn't
 * refused too. `send` gets watched callbacks on a stream, and undefined on
 * complete().
 */
export async function sendWithRecoveredThinkingGuard(
  request: ProviderRequest,
  callbacks: StreamCallbacks | undefined,
  send: (request: ProviderRequest, callbacks: StreamCallbacks | undefined) => Promise<ProviderResponse>,
): Promise<ProviderResponse> {
  const prepared = prepareRecoveredThinking(request);
  const watched = prepared.carried && callbacks ? watchDelivery(callbacks) : undefined;
  const response = await send(prepared.request, watched?.callbacks ?? callbacks);
  if (!resendWithoutRecoveredThinking(prepared.carried, response, watched?.delivered() ?? false)) return response;
  const resend = await send(prepareRecoveredThinking(request, true).request, callbacks);
  confirmRecoveredThinkingRefusal(request.model, resend);
  return resend;
}

/**
 * An adapter with the guard in front of its complete() and stream(), every
 * other member forwarded as it is: for a caller that builds a bare membrane
 * adapter, such as scripts/warmup-session.ts.
 */
export function withRecoveredThinkingGuard<A extends object>(adapter: A): A {
  return new Proxy(adapter, {
    get(target, prop) {
      const t = target as unknown as {
        complete: (r: ProviderRequest, o?: unknown) => Promise<ProviderResponse>;
        stream: (r: ProviderRequest, c: StreamCallbacks, o?: unknown) => Promise<ProviderResponse>;
      };
      if (prop === 'complete') {
        return (request: ProviderRequest, options?: unknown) =>
          sendWithRecoveredThinkingGuard(request, undefined, (req) => t.complete(req, options));
      }
      if (prop === 'stream') {
        return (request: ProviderRequest, callbacks: StreamCallbacks, options?: unknown) =>
          sendWithRecoveredThinkingGuard(request, callbacks, (req, cb) => t.stream(req, cb!, options));
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
