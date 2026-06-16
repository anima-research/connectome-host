/**
 * Context panel — the makeup of the agent's current compiled context.
 *
 * Reads GET /debug/context/makeup (transparent: previewActivation +
 * count_tokens, no inference / no writes) and shows the segment breakdown the
 * autobiographical strategy produced: head window, raw middle, summaries by
 * level (L1/L2/L3), and the recent verbatim tail — as a proportional bar plus
 * a per-segment table, with an exact total token count.
 */

import { createSignal, onMount, For, Show } from 'solid-js';

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

type Row = { key: string; label: string; messages: number; tokens: number; color: string };

const fmt = (n: number) => n.toLocaleString();

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
  const [loading, setLoading] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const q = props.agent ? `?agent=${encodeURIComponent(props.agent)}` : '';
      const res = await fetch(`/debug/context/makeup${q}`, { credentials: 'same-origin' });
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

  onMount(load);

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
          onClick={load}
          disabled={loading()}
        >
          {loading() ? '…' : 'refresh'}
        </button>
      </div>

      <Show when={err()}>
        <div class="text-rose-400">error: {err()}</div>
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
