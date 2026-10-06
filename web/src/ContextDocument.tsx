/**
 * ContextDocument — the agent's compiled context rendered in the MAIN pane, as
 * a readable, navigable document.
 *
 * Combines GET /debug/context (the flat compiled messages) with
 * /debug/context/makeup (segment token/message counts) to partition the flat
 * list into Head | Middle | Recent zones (render order is head, then the folded
 * middle, then the verbatim tail — the makeup counts give the boundaries). A
 * sticky timeline at the top is a clickable minimap: each zone is sized by its
 * token share and scrolls the document to that section. Summary recall-pairs in
 * the middle are styled distinctly.
 */

import { createEffect, createSignal, on, For, Show } from 'solid-js';
import { MediaView } from './Surgery';

/** One compiled message. `sourceMessageId` is the chronicle id when the
 *  entry is a raw message (strategies stamp it); summaries have none. */
interface Msg { participant?: string; role?: string; content: unknown; sourceMessageId?: string }
interface Seg { messages: number; tokens: number }
interface Stats {
  head: Seg; tail: Seg; middleRaw: Seg;
  summaries: { l1: { count: number; tokens: number }; l2: { count: number; tokens: number }; l3: { count: number; tokens: number } };
  total: Seg;
}

const fmt = (n: number) => n.toLocaleString();
const estTokens = (s: string) => Math.round(s.length / 3.6);
const SUMMARY_LABELS = ['What do you remember', 'Context Manager'];

type Block = { type?: string; text?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean; thinking?: string };

const TOOL_INPUT_PREVIEW = 600;

/** Render one content block as text. Every block type the API can put in a
 *  message gets a visible form — a box whose blocks all map to '' is what an
 *  operator reads as "empty context", which is never true. */
function blockText(b: unknown): string {
  if (!b || typeof b !== 'object') return String(b ?? '');
  const blk = b as Block;
  switch (blk.type) {
    case 'text': return blk.text ?? '';
    case 'image': return '[image]';
    case 'thinking': return `[thinking · ${fmt((blk.thinking ?? '').length)} chars]`;
    case 'redacted_thinking': return '[redacted thinking]';
    case 'tool_use': {
      let args = '';
      try { args = JSON.stringify(blk.input ?? {}); } catch { args = String(blk.input); }
      if (args.length > TOOL_INPUT_PREVIEW) args = `${args.slice(0, TOOL_INPUT_PREVIEW)}…`;
      return `⚙ ${blk.name ?? 'tool'}(${args})`;
    }
    case 'tool_result': {
      const inner = Array.isArray(blk.content) ? blk.content.map(blockText).join('') : String(blk.content ?? '');
      return `${blk.is_error ? '✗ tool error' : '↳ tool result'}${inner ? `\n${inner}` : ' (empty)'}`;
    }
    default: return `[${blk.type ?? 'block'}]`;
  }
}

function textOf(c: unknown): string {
  if (Array.isArray(c)) return c.map(blockText).join('\n');
  return String(c ?? '');
}

/** Inline images in the compiled message (the request ships them as base64
 *  — exactly what the model sees), including ones nested in tool results. */
function imagesOf(c: unknown): Array<{ mediaType: string; dataUrl: string }> {
  if (!Array.isArray(c)) return [];
  const out: Array<{ mediaType: string; dataUrl: string }> = [];
  const visit = (b: unknown): void => {
    if (!b || typeof b !== 'object') return;
    const blk = b as { type?: string; source?: { type?: string; data?: unknown; mediaType?: unknown; media_type?: unknown }; content?: unknown };
    if (blk.type === 'image' && blk.source?.type === 'base64' && typeof blk.source.data === 'string') {
      const mt = typeof blk.source.mediaType === 'string' ? blk.source.mediaType
        : typeof blk.source.media_type === 'string' ? blk.source.media_type : 'image/png';
      if (mt.startsWith('image/')) out.push({ mediaType: mt, dataUrl: `data:${mt};base64,${blk.source.data}` });
    } else if (blk.type === 'tool_result' && Array.isArray(blk.content)) {
      blk.content.forEach(visit);
    }
  };
  c.forEach(visit);
  return out;
}

/** Coarse message kind for the box header: tool traffic gets labelled so a
 *  tool-heavy stretch of context reads as what it is. */
function kindOf(c: unknown): 'tool_use' | 'tool_result' | null {
  if (!Array.isArray(c)) return null;
  const types = new Set(c.map((b) => (b && typeof b === 'object' ? (b as Block).type : undefined)));
  if (types.has('tool_result')) return 'tool_result';
  if (types.has('tool_use')) return 'tool_use';
  return null;
}

export function ContextDocument(props: {
  scope?: string;
  scrollRoot?: () => HTMLElement | undefined;
  /** Show "roll back to here" on raw-message boxes (host supports it, local scope, operator). */
  canRollback?: boolean;
  onRollback?: (messageId: string, preview: string) => void;
}) {
  const [msgs, setMsgs] = createSignal<Msg[]>([]);
  const [stats, setStats] = createSignal<Stats | null>(null);
  const [exact, setExact] = createSignal<number | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  /** Fleet-child scopes route through the host's ?scope= proxy. */
  const query = () => props.scope && props.scope !== 'local'
    ? `?scope=${encodeURIComponent(props.scope)}`
    : '';

  const load = async () => {
    const scopeAtStart = props.scope;
    setLoading(true); setErr(null);
    try {
      const q = query();
      const [ctxRes, mkRes] = await Promise.all([
        fetch(`/debug/context${q}`, { credentials: 'same-origin' }),
        fetch(`/debug/context/makeup${q}`, { credentials: 'same-origin' }),
      ]);
      if (!ctxRes.ok) {
        const body = (await ctxRes.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `context HTTP ${ctxRes.status}`);
      }
      const ctx = await ctxRes.json();
      if (props.scope !== scopeAtStart) return; // scope switched mid-flight
      setMsgs((ctx?.request?.messages ?? []) as Msg[]);
      if (mkRes.ok) { const mk = await mkRes.json(); setStats(mk.stats); setExact(mk.exactTotalTokens); }
    } catch (e) {
      if (props.scope !== scopeAtStart) return;
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  };
  // Initial load AND scope-switch refetch, clearing the stale document first.
  createEffect(on(() => props.scope, () => {
    setMsgs([]); setStats(null); setExact(null); setErr(null);
    void load();
  }));

  // Zone boundaries from the makeup counts (render order: head | middle | tail).
  const headN = () => stats()?.head.messages ?? 0;
  const tailN = () => stats()?.tail.messages ?? 0;
  const midStart = () => headN();
  const midEnd = () => Math.max(headN(), msgs().length - tailN());
  const zoneOf = (i: number): 'head' | 'middle' | 'tail' =>
    i < headN() ? 'head' : i >= midEnd() ? 'tail' : 'middle';

  const zones = () => {
    const s = stats(); if (!s) return [];
    const midTok = s.middleRaw.tokens + s.summaries.l1.tokens + s.summaries.l2.tokens + s.summaries.l3.tokens;
    const tot = Math.max(1, s.total.tokens);
    return [
      { key: 'head', label: 'Head', tokens: s.head.tokens, color: '#64748b', pct: (s.head.tokens / tot) * 100 },
      { key: 'middle', label: 'Middle (summaries + raw)', tokens: midTok, color: '#06b6d4', pct: (midTok / tot) * 100 },
      { key: 'tail', label: 'Recent', tokens: s.tail.tokens, color: '#10b981', pct: (s.tail.tokens / tot) * 100 },
    ];
  };

  const scrollTo = (zone: string) => {
    const el = document.getElementById(`ctxseg-${zone}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const isSummary = (m: Msg) => {
    const who = m.participant ?? '';
    const t = textOf(m.content);
    return SUMMARY_LABELS.some((l) => who.includes('Context Manager') || t.startsWith(l));
  };

  return (
    <div class="text-sm text-neutral-300">
      {/* sticky timeline minimap */}
      <div class="sticky top-0 z-10 bg-neutral-950/95 backdrop-blur border-b border-neutral-800 pb-2 mb-3 -mx-1 px-1">
        <div class="flex items-center justify-between text-[11px] font-mono text-neutral-500 mb-1">
          <span>
            context · {fmt(exact() ?? stats()?.total.tokens ?? 0)} tokens{exact() != null ? ' (exact)' : ''} · {fmt(msgs().length)} msgs
          </span>
          <button type="button" class="px-2 py-0.5 border border-neutral-700 rounded hover:text-neutral-200" onClick={load} disabled={loading()}>
            {loading() ? '…' : 'refresh'}
          </button>
        </div>
        <Show when={stats()}>
          <div class="flex h-5 w-full overflow-hidden rounded border border-neutral-800 cursor-pointer text-[10px] font-mono">
            <For each={zones()}>
              {(z) => (
                <div
                  class="flex items-center justify-center text-neutral-900 hover:brightness-125 transition"
                  style={{ width: `${Math.max(3, z.pct)}%`, background: z.color }}
                  title={`${z.label}: ${fmt(z.tokens)} tok — click to jump`}
                  onClick={() => scrollTo(z.key)}
                >
                  <Show when={z.pct > 8}>{z.label}</Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <Show when={err()}><div class="text-rose-400 font-mono text-xs px-1">error: {err()}</div></Show>

      {/* the document */}
      <div class="space-y-2 px-1">
        <For each={msgs()}>
          {(m, i) => {
            const zone = zoneOf(i());
            const firstOfZone = i() === 0 || zoneOf(i() - 1) !== zone;
            const summary = isSummary(m);
            const who = m.participant ?? m.role ?? '?';
            const t = textOf(m.content);
            const kind = kindOf(m.content);
            const images = imagesOf(m.content);
            const rollbackable = !summary && !!props.canRollback && typeof m.sourceMessageId === 'string' && i() < msgs().length - 1;
            return (
              <>
                <Show when={firstOfZone}>
                  <div id={`ctxseg-${zone}`} class="pt-3 pb-1 text-[10px] font-mono uppercase tracking-wider text-neutral-600 border-t border-neutral-800/60">
                    {zone === 'head' ? 'Head — oldest, verbatim' : zone === 'tail' ? 'Recent — verbatim tail' : 'Middle — summaries + raw'}
                  </div>
                </Show>
                <div class={`group rounded border px-3 py-2 ${summary ? 'border-cyan-900/60 bg-cyan-950/20' : 'border-neutral-800 bg-neutral-900/30'}`}>
                  <div class="flex items-center justify-between text-[10px] font-mono mb-1">
                    <span class={summary ? 'text-cyan-400' : 'text-neutral-400'}>
                      {summary ? '◆ summary' : who}
                      <Show when={!summary && kind}><span class="ml-2 text-neutral-600">{kind === 'tool_use' ? '⚙ tool call' : '↳ tool result'}</span></Show>
                      <Show when={images.length > 0}><span class="ml-2 text-sky-500/80">🖼 {images.length}</span></Show>
                    </span>
                    <span class="flex items-center gap-2">
                      <Show when={rollbackable}>
                        <button
                          type="button"
                          class="opacity-40 group-hover:opacity-100 focus:opacity-100 px-1.5 py-0.5 rounded border border-neutral-700 text-neutral-400 hover:border-amber-700 hover:text-amber-200 transition-opacity"
                          title="roll back: make this message the tail of the live branch"
                          onClick={() => props.onRollback?.(m.sourceMessageId!, `${who}: ${t.replace(/\s+/g, ' ').slice(0, 90)}`)}
                        >⏪ roll back to here</button>
                      </Show>
                      <span class="text-neutral-600">~{fmt(estTokens(t) + images.length * 1600)} tok</span>
                    </span>
                  </div>
                  <div class="whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-300">{t.slice(0, 4000)}{t.length > 4000 ? '…' : ''}</div>
                  <Show when={images.length > 0}>
                    <div class="mt-1 flex flex-wrap gap-1">
                      <For each={images}>{(img) => <MediaView mediaType={img.mediaType} dataUrl={img.dataUrl} compact />}</For>
                    </div>
                  </Show>
                </div>
              </>
            );
          }}
        </For>
      </div>
    </div>
  );
}
