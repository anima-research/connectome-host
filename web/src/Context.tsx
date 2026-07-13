/**
 * Context panel — the makeup of the agent's current compiled context.
 *
 * Reads GET /debug/context/makeup (transparent: previewActivation +
 * count_tokens, no inference / no writes) and shows the segment breakdown the
 * autobiographical strategy produced: head window, raw middle, summaries by
 * level (L1/L2/L3), and the recent verbatim tail — as a proportional bar plus
 * a per-segment table, with an exact total token count.
 */

import { createSignal, onCleanup, onMount, For, Show } from 'solid-js';

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
  stats: Stats | null;
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

export function ContextPanel(props: { agent?: string }) {
  const [data, setData] = createSignal<Makeup | null>(null);
  const [coverage, setCoverage] = createSignal<Coverage | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [coverageLoading, setCoverageLoading] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [coverageErr, setCoverageErr] = createSignal<string | null>(null);

  const query = () => props.agent ? `?agent=${encodeURIComponent(props.agent)}` : '';

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/debug/context/makeup${query()}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as Makeup;
      if (j.error) throw new Error(j.error);
      setData(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const loadCoverage = async () => {
    setCoverageLoading(true);
    setCoverageErr(null);
    try {
      const res = await fetch(`/debug/context/coverage${query()}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setCoverage((await res.json()) as Coverage);
    } catch (e) {
      setCoverageErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCoverageLoading(false);
    }
  };

  const refreshAll = () => {
    void load();
    void loadCoverage();
  };

  onMount(() => {
    refreshAll();
    const timer = window.setInterval(() => void loadCoverage(), 5_000);
    onCleanup(() => window.clearInterval(timer));
  });

  const estTotal = () => data()?.stats?.total.tokens ?? 0;
  const rows = () => {
    const s = data()?.stats;
    return s ? rowsOf(s) : [];
  };

  return (
    <div class="p-2 text-[11px] font-mono text-neutral-300 space-y-3">
      <div class="flex items-center justify-between">
        <span class="text-neutral-400">Context makeup{data()?.agent ? ` · ${data()!.agent}` : ''}</span>
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

          <div class="flex items-center justify-between gap-2 text-neutral-600">
            <span class="min-w-0 truncate" title={coverage()!.branch}>{coverage()!.branch}</span>
            <a class="shrink-0 text-cyan-500 hover:text-cyan-300" href="/curve" target="_blank" rel="noreferrer">curve ↗</a>
          </div>
        </section>
      </Show>

      <Show when={data()?.stats} fallback={<Show when={!err()}><div class="text-neutral-500">loading…</div></Show>}>
        {/* headline totals */}
        <div class="flex gap-4">
          <div>
            <div class="text-2xl text-neutral-100">{fmt(data()!.exactTotalTokens ?? estTotal())}</div>
            <div class="text-neutral-500">
              {data()!.exactTotalTokens != null ? 'tokens (exact)' : 'tokens (est)'}
            </div>
          </div>
          <div class="self-end text-neutral-500">
            {fmt(data()!.stats!.total.messages)} msgs · est {fmt(estTotal())}
          </div>
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
            pending compression: {data()!.stats!.pending.chunks} chunk(s), {data()!.stats!.pending.merges} merge(s)
          </div>
          <div>
            exact via count_tokens ({data()!.countModel}; same tokenizer) · per-segment tokens are strategy estimates
          </div>
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
