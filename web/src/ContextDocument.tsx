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

import { createSignal, onMount, For, Show } from 'solid-js';

interface Msg { participant?: string; role?: string; content: unknown }
interface Seg { messages: number; tokens: number }
interface Stats {
  head: Seg; tail: Seg; middleRaw: Seg;
  summaries: { l1: { count: number; tokens: number }; l2: { count: number; tokens: number }; l3: { count: number; tokens: number } };
  total: Seg;
}

const fmt = (n: number) => n.toLocaleString();
const estTokens = (s: string) => Math.round(s.length / 3.6);
const SUMMARY_LABELS = ['What do you remember', 'Context Manager'];

function textOf(c: unknown): string {
  if (Array.isArray(c)) return c.map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? (b as { text: string }).text : (b && (b as { type?: string }).type === 'image' ? '[image]' : ''))).join('');
  return String(c ?? '');
}

export function ContextDocument(props: { agent?: string; scrollRoot?: () => HTMLElement | undefined }) {
  const [msgs, setMsgs] = createSignal<Msg[]>([]);
  const [stats, setStats] = createSignal<Stats | null>(null);
  const [exact, setExact] = createSignal<number | null>(null);
  const [err, setErr] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const q = props.agent ? `?agent=${encodeURIComponent(props.agent)}` : '';
      const [ctxRes, mkRes] = await Promise.all([
        fetch(`/debug/context${q}`, { credentials: 'same-origin' }),
        fetch(`/debug/context/makeup${q}`, { credentials: 'same-origin' }),
      ]);
      if (!ctxRes.ok) throw new Error(`context HTTP ${ctxRes.status}`);
      const ctx = await ctxRes.json();
      setMsgs((ctx?.request?.messages ?? []) as Msg[]);
      if (mkRes.ok) { const mk = await mkRes.json(); setStats(mk.stats); setExact(mk.exactTotalTokens); }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  };
  onMount(load);

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
            return (
              <>
                <Show when={firstOfZone}>
                  <div id={`ctxseg-${zone}`} class="pt-3 pb-1 text-[10px] font-mono uppercase tracking-wider text-neutral-600 border-t border-neutral-800/60">
                    {zone === 'head' ? 'Head — oldest, verbatim' : zone === 'tail' ? 'Recent — verbatim tail' : 'Middle — summaries + raw'}
                  </div>
                </Show>
                <div class={`rounded border px-3 py-2 ${summary ? 'border-cyan-900/60 bg-cyan-950/20' : 'border-neutral-800 bg-neutral-900/30'}`}>
                  <div class="flex items-center justify-between text-[10px] font-mono mb-1">
                    <span class={summary ? 'text-cyan-400' : 'text-neutral-400'}>{summary ? '◆ summary' : who}</span>
                    <span class="text-neutral-600">~{fmt(estTokens(t))} tok</span>
                  </div>
                  <div class="whitespace-pre-wrap text-[13px] leading-relaxed text-neutral-300">{t.slice(0, 4000)}{t.length > 4000 ? '…' : ''}</div>
                </div>
              </>
            );
          }}
        </For>
      </div>
    </div>
  );
}
