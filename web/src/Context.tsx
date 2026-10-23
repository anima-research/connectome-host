/**
 * Context panel — two figures from GET /debug/context/makeup (transparent:
 * previewActivation + count_tokens, no inference or writes of its own): the exact
 * token count of the next request as a preview builds it, from the stored
 * history without what modules add at each turn, and the segment breakdown of the
 * agent's last live compile, which the autobiographical strategy records:
 * head window, raw middle, summaries by level (L1/L2/L3), and the recent
 * verbatim tail — as a proportional bar plus a per-segment table.
 */

import { createEffect, createSignal, on, onCleanup, onMount, For, Show } from 'solid-js';
import { contextPageView } from './composition-text';

interface Seg { messages: number; tokens: number }
interface Stats {
  head: Seg;
  tail: Seg;
  middleRaw: Seg;
  summaries: { l1: { count: number; tokens: number }; l2: { count: number; tokens: number }; l3: { count: number; tokens: number } };
  pending: { chunks: number; merges: number };
  total: Seg;
}
interface Makeup {
  agent: string;
  /** The render stats of the agent's last live compile: null until one has
   *  run since its context was loaded, or where its strategy keeps none. */
  stats: Stats | null;
  /** Whether the agent's strategy keeps render stats at all. */
  statsKept?: boolean;
  /** The next request's exact token count, from a preview, or null where it
   *  wasn't counted, as `countSource` says. */
  exactTotalTokens: number | null;
  countModel: string;
  countSource: string;
  error?: string;
}

interface CoverageLevel {
  level: number;
  summaries: number;
  frontier: number;
  tokens: number;
  coveredChunks: number;
  coveredMessages: number;
  coveredTokens: number;
}

interface CoverageChunk {
  index: number;
  messages: number;
  tokens: number;
  compressed: boolean;
  summaryId: string | null;
  maxLevel: number;
  selectedMin: number;
  selectedMax: number;
  queued: boolean;
}

interface Coverage {
  agent: string;
  branch: string;
  generatedAt: string;
  supported: boolean;
  totals: {
    chunks: number;
    compressedChunks: number;
    coveredMessages: number;
    coveredTokens: number;
    summaries: number;
  };
  levels: CoverageLevel[];
  chunks: CoverageChunk[];
  queue: {
    inFlight: boolean;
    pending: string | null;
    l1: number[];
    merges: Array<{ targetLevel: number; sourceCount: number; firstSource: string | null; lastSource: string | null }>;
  };
}

type Row = { key: string; label: string; messages: number; tokens: number; color: string };

const fmt = (n: number) => n.toLocaleString();
const levelColors = ['#52525b', '#06b6d4', '#10b981', '#f59e0b', '#f43f5e', '#a78bfa', '#60a5fa'];
const levelColor = (level: number) => levelColors[Math.min(level, levelColors.length - 1)];

function rowsOf(s: Stats): Row[] {
  return [
    { key: 'head', label: 'Head (oldest, verbatim)', messages: s.head.messages, tokens: s.head.tokens, color: '#64748b' },
    { key: 'l1', label: 'Summaries · L1', messages: s.summaries.l1.count, tokens: s.summaries.l1.tokens, color: '#06b6d4' },
    { key: 'l2', label: 'Summaries · L2', messages: s.summaries.l2.count, tokens: s.summaries.l2.tokens, color: '#3b82f6' },
    { key: 'l3', label: 'Summaries · L3', messages: s.summaries.l3.count, tokens: s.summaries.l3.tokens, color: '#6366f1' },
    { key: 'middleRaw', label: 'Middle (raw, verbatim)', messages: s.middleRaw.messages, tokens: s.middleRaw.tokens, color: '#f59e0b' },
    { key: 'tail', label: 'Recent tail (verbatim)', messages: s.tail.messages, tokens: s.tail.tokens, color: '#10b981' },
  ].filter((r) => r.tokens > 0 || r.messages > 0);
}

export function ContextPanel(props: { scope?: string }) {
  const [data, setData] = createSignal<Makeup | null>(null);
  const [coverage, setCoverage] = createSignal<Coverage | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [coverageLoading, setCoverageLoading] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [coverageErr, setCoverageErr] = createSignal<string | null>(null);

  /** Fleet-child scopes route through the host's ?scope= proxy; the child's
   *  primary agent answers. Local scope needs no params. */
  const query = () => props.scope && props.scope !== 'local'
    ? `?scope=${encodeURIComponent(props.scope)}`
    : '';

  const load = async () => {
    const scopeAtStart = props.scope;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/debug/context/makeup${query()}`, { credentials: 'same-origin' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as Makeup;
      if (j.error) throw new Error(j.error);
      if (props.scope !== scopeAtStart) return; // scope switched mid-flight
      setData(j);
    } catch (e) {
      if (props.scope !== scopeAtStart) return;
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const loadCoverage = async () => {
    const scopeAtStart = props.scope;
    setCoverageLoading(true);
    setCoverageErr(null);
    try {
      const res = await fetch(`/debug/context/coverage${query()}`, { credentials: 'same-origin' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const cov = (await res.json()) as Coverage;
      if (props.scope !== scopeAtStart) return;
      setCoverage(cov);
    } catch (e) {
      if (props.scope !== scopeAtStart) return;
      setCoverageErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCoverageLoading(false);
    }
  };

  const refreshAll = () => {
    void load();
    void loadCoverage();
  };

  // Initial load AND scope-switch refetch: the effect re-runs whenever the
  // shared scope selector changes, clearing the previous scope's data so a
  // slow child never renders under the wrong header.
  createEffect(on(() => props.scope, () => {
    setData(null);
    setCoverage(null);
    setErr(null);
    setCoverageErr(null);
    refreshAll();
  }));

  onMount(() => {
    const timer = window.setInterval(() => void loadCoverage(), 5_000);
    onCleanup(() => window.clearInterval(timer));
  });

  // What the page shows of the response (contextPageView): the next
  // request's count or why there's none, and the composition or the line in
  // its place.
  const view = () => {
    const d = data();
    return d ? contextPageView(d) : null;
  };
  const counted = () => {
    const count = view()?.count;
    return count && 'tokens' in count ? count : undefined;
  };
  const notCountedReason = () => {
    const count = view()?.count;
    return count && 'reason' in count ? count.reason : undefined;
  };
  const compositionStats = () => {
    const composition = view()?.composition;
    return composition && 'stats' in composition ? composition.stats : undefined;
  };
  const compositionLine = () => {
    const composition = view()?.composition;
    return composition && 'line' in composition ? composition.line : undefined;
  };
  const estTotal = () => compositionStats()?.total.tokens ?? 0;
  const rows = () => {
    const s = compositionStats();
    return s ? rowsOf(s) : [];
  };

  return (
    <div class="p-2 text-[11px] font-mono text-neutral-300 space-y-3">
      <div class="flex items-center justify-between">
        <span class="text-neutral-400">Context makeup{data()?.agent ? ` · ${data()!.agent}` : ''}</span>
        <div class="flex items-center gap-2">
          <a
            class="text-cyan-500 hover:text-cyan-300"
            href={`/curve${query()}`}
            target="_blank"
            rel="noreferrer"
            title="Compression curve — raw vs rendered tokens per compiled entry"
          >
            curve ↗
          </a>
          <button
            type="button"
            class="px-2 py-0.5 text-neutral-400 hover:text-neutral-100 border border-neutral-700 rounded"
            onClick={refreshAll}
            disabled={loading() || coverageLoading()}
            title="Refresh context diagnostics"
          >
            {loading() || coverageLoading() ? '…' : 'refresh'}
          </button>
        </div>
      </div>

      <Show when={err()}>
        <div class="text-rose-400">error: {err()}</div>
      </Show>

      <Show when={coverageErr()}>
        <div class="text-rose-400">coverage: {coverageErr()}</div>
      </Show>

      <Show when={coverage()?.supported}>
        <section class="border-y border-neutral-800 py-3 space-y-2.5">
          <div class="flex items-center justify-between">
            <span class="text-neutral-300">Summary coverage</span>
            <span class="text-neutral-600">
              {coverage()!.queue.inFlight || coverage()!.queue.l1.length > 0 || coverage()!.queue.merges.length > 0
                ? 'active'
                : 'idle'}
            </span>
          </div>

          <div class="grid grid-cols-3 gap-2 text-neutral-500">
            <div>
              <div class="text-base text-neutral-200">{coverage()!.totals.compressedChunks}/{coverage()!.totals.chunks}</div>
              <div>chunks</div>
            </div>
            <div>
              <div class="text-base text-neutral-200">{fmt(coverage()!.totals.coveredMessages)}</div>
              <div>msgs covered</div>
            </div>
            <div>
              <div class="text-base text-neutral-200">{fmt(coverage()!.totals.summaries)}</div>
              <div>summaries</div>
            </div>
          </div>

          <div class="space-y-1.5">
            <div class="flex justify-between text-neutral-500"><span>available depth</span><span>oldest → newest</span></div>
            <CoverageStrip chunks={coverage()!.chunks} field="available" />
            <div class="flex justify-between text-neutral-500"><span>selected depth</span><span>{fmt(coverage()!.totals.coveredTokens)} tok covered</span></div>
            <CoverageStrip chunks={coverage()!.chunks} field="selected" />
          </div>

          <div class="flex flex-wrap gap-x-2.5 gap-y-1 text-neutral-500">
            <For each={[0, ...coverage()!.levels.map(level => level.level)]}>
              {(level) => (
                <span><span class="inline-block w-2 h-2 rounded-sm mr-1" style={{ background: levelColor(level) }} />L{level}</span>
              )}
            </For>
          </div>

          <table class="w-full">
            <thead>
              <tr class="text-neutral-500 text-left">
                <th class="font-normal py-1">level</th>
                <th class="font-normal text-right">frontier</th>
                <th class="font-normal text-right">total</th>
                <th class="font-normal text-right">coverage</th>
              </tr>
            </thead>
            <tbody>
              <For each={coverage()!.levels}>
                {(level) => (
                  <tr class="border-t border-neutral-900">
                    <td class="py-1 text-neutral-200">L{level.level}</td>
                    <td class="text-right text-neutral-300">{level.frontier}</td>
                    <td class="text-right text-neutral-500">{level.summaries}</td>
                    <td class="text-right text-neutral-400">{fmt(level.coveredMessages)} msg</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>

          <div class="border-t border-neutral-900 pt-2 space-y-1">
            <div class="flex items-center justify-between">
              <span class="text-neutral-400">Queue</span>
              <span class={coverage()!.queue.inFlight ? 'text-amber-300' : 'text-neutral-600'}>
                {coverage()!.queue.inFlight ? 'in flight' : 'waiting'}
              </span>
            </div>
            <Show when={coverage()!.queue.pending}>
              <div class="text-amber-200 truncate" title={coverage()!.queue.pending ?? ''}>{coverage()!.queue.pending}</div>
            </Show>
            <For each={coverage()!.queue.l1}>
              {(index) => <div class="text-neutral-400">L1 · chunk {index}</div>}
            </For>
            <For each={coverage()!.queue.merges}>
              {(merge) => (
                <div class="text-neutral-400" title={`${merge.firstSource ?? ''} → ${merge.lastSource ?? ''}`}>
                  L{merge.targetLevel} · {merge.sourceCount} source summaries
                </div>
              )}
            </For>
            <Show when={!coverage()!.queue.inFlight && coverage()!.queue.l1.length === 0 && coverage()!.queue.merges.length === 0}>
              <div class="text-neutral-600">No queued work</div>
            </Show>
          </div>

          <div class="text-neutral-600 min-w-0 truncate" title={coverage()!.branch}>{coverage()!.branch}</div>
        </section>
      </Show>

      <Show when={!data() && !err()}><div class="text-neutral-500">loading…</div></Show>

      {/* The next request, as a preview builds it, counted exactly, or why
          it wasn't counted. */}
      <Show when={counted()}>
        {(count) => (
          <div>
            <div class="text-2xl text-neutral-100">{fmt(count().tokens)}</div>
            <div class="text-neutral-500">tokens (exact): the next request as a preview builds it, without what modules add at each turn</div>
            <div class="text-neutral-600">counted by count_tokens for {count().model}</div>
          </div>
        )}
      </Show>
      <Show when={notCountedReason()}>
        {(reason) => <div class="text-neutral-500">next request: {reason()}</div>}
      </Show>

      {/* The last live compile's render stats, or which of the two reasons
          there are none. */}
      <Show when={compositionLine()}>
        {(line) => <div class="text-neutral-500">{line()}</div>}
      </Show>

      <Show when={compositionStats()}>
        <div class="text-neutral-500">
          last live compile: {fmt(compositionStats()!.total.messages)} msgs · est {fmt(estTotal())} tokens
        </div>

        {/* proportional bar */}
        <div class="flex h-4 w-full overflow-hidden rounded border border-neutral-800">
          <For each={rows()}>
            {(r) => (
              <div
                style={{ width: `${(r.tokens / Math.max(1, estTotal())) * 100}%`, background: r.color }}
                title={`${r.label}: ${fmt(r.tokens)} tok`}
              />
            )}
          </For>
        </div>

        {/* per-segment table */}
        <table class="w-full">
          <thead>
            <tr class="text-neutral-500 text-left">
              <th class="font-normal py-1">segment</th>
              <th class="font-normal text-right">msgs</th>
              <th class="font-normal text-right">tokens</th>
              <th class="font-normal text-right">%</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(r) => (
                <tr class="border-t border-neutral-900">
                  <td class="py-1">
                    <span class="inline-block w-2 h-2 mr-2 rounded-sm align-middle" style={{ background: r.color }} />
                    {r.label}
                  </td>
                  <td class="text-right text-neutral-400">{fmt(r.messages)}</td>
                  <td class="text-right text-neutral-200">{fmt(r.tokens)}</td>
                  <td class="text-right text-neutral-500">{((r.tokens / Math.max(1, estTotal())) * 100).toFixed(1)}%</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>

        <div class="text-neutral-500 space-y-0.5">
          <div>
            pending compression: {compositionStats()!.pending.chunks} chunk(s), {compositionStats()!.pending.merges} merge(s)
          </div>
          <div>per-segment tokens are strategy estimates</div>
        </div>
      </Show>
    </div>
  );
}

function CoverageStrip(props: { chunks: CoverageChunk[]; field: 'available' | 'selected' }) {
  const total = () => props.chunks.reduce((sum, chunk) => sum + Math.max(1, chunk.tokens), 0);
  return (
    <div class="flex h-4 w-full overflow-hidden rounded border border-neutral-800 bg-neutral-900">
      <For each={props.chunks}>
        {(chunk) => {
          const level = () => props.field === 'available' ? chunk.maxLevel : chunk.selectedMax;
          const title = () => {
            const selected = chunk.selectedMin === chunk.selectedMax
              ? `L${chunk.selectedMax}`
              : `L${chunk.selectedMin}–L${chunk.selectedMax}`;
            return `chunk ${chunk.index} · ${chunk.messages} msg · ${fmt(chunk.tokens)} tok · available L${chunk.maxLevel} · selected ${selected}${chunk.queued ? ' · queued' : ''}`;
          };
          return (
            <div
              class={`h-full min-w-px ${chunk.queued ? 'ring-1 ring-inset ring-amber-200' : ''}`}
              style={{ width: `${(Math.max(1, chunk.tokens) / Math.max(1, total())) * 100}%`, background: levelColor(level()) }}
              title={title()}
            />
          );
        }}
      </For>
    </div>
  );
}
