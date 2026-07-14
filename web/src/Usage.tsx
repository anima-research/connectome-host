/**
 * Usage panel — token-spend breakdown for the focused tree node.
 *
 * Strategy by node kind:
 *  - 'process' (parent root): show session-wide UsageMessage as the
 *    authoritative total, plus a breakdown of direct children.
 *  - 'fleet-child' folder: aggregate over its agents, plus per-agent rows.
 *  - 'framework' / 'subagent' (leaf-ish): show that one agent's numbers.
 *
 * The panel is intentionally read-only — there's no per-node billing knob to
 * twiddle here yet. Most operators want the same answer: "where's the burn?"
 */

import { For, Show } from 'solid-js';
import type { UiNode } from './tree';
import { aggregateTokens } from './tree';
import type {
  TokenUsage,
  PerAgentCost,
  CallLedgerSnapshot,
  CallLedgerRow,
  CallLedgerVerdict,
} from '@conhost/web/protocol';

export function UsagePanel(props: {
  node: UiNode;
  /** Session-wide cumulative usage from welcome/usage messages. Only
   *  consulted when the focused node is the parent process. */
  sessionUsage: TokenUsage;
  /** Per-agent cost slice (parent-process agents only). Used to label
   *  per-agent cost in process / per-agent breakdown views. */
  perAgentCost: PerAgentCost[];
  /** Recent provider calls. The ledger is process-local, so it is shown on
   *  the process usage view rather than pretending it can be split across
   *  fleet children. */
  callLedger: CallLedgerSnapshot | null;
  onClose(): void;
}) {
  const costFor = (agentName: string): { total: number; currency: string } | undefined => {
    return props.perAgentCost.find(c => c.name === agentName)?.cost;
  };
  const totals = (): { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number; currency: string } } => {
    if (props.node.kind === 'process') {
      return {
        input: props.sessionUsage.input,
        output: props.sessionUsage.output,
        cacheRead: props.sessionUsage.cacheRead,
        cacheWrite: props.sessionUsage.cacheWrite,
        cost: props.sessionUsage.cost,
      };
    }
    const t = aggregateTokens(props.node);
    // For an agent-leaf, attach the matching per-agent cost so the panel
    // shows $X.XX next to its tokens. Aggregates (fleet-child folders) do
    // not show cost — the framework's UsageTracker is per-process and we
    // don't aggregate cross-process costs here.
    if (props.node.agent) {
      const c = costFor(props.node.label);
      return c ? { ...t, cost: c } : t;
    }
    return t;
  };

  const breakdown = (): UiNode[] => {
    // Parent process and fleet-child folders break down by direct children;
    // leaf agent nodes don't (they ARE the breakdown).
    if (props.node.kind === 'process' || props.node.kind === 'fleet-child') {
      return props.node.children;
    }
    return [];
  };

  const headline = (): string => {
    switch (props.node.kind) {
      case 'process': return 'session total';
      case 'fleet-child': return `child: ${props.node.label}`;
      case 'framework': return `agent: ${props.node.label}`;
      case 'subagent': return `subagent: ${props.node.label}`;
    }
  };

  return (
    <div class="border-l border-neutral-800 w-[52rem] max-w-[68vw] shrink-0 bg-neutral-950 flex flex-col h-full">
      <div class="border-b border-neutral-800 px-3 py-2 flex items-center gap-2">
        <span class="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">usage</span>
        <span class="font-mono text-sm text-neutral-200 truncate">{props.node.label}</span>
        <button
          type="button"
          class="ml-auto px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded text-xs"
          onClick={() => props.onClose()}
        >
          close
        </button>
      </div>

      <div class="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] space-y-3">
        <section>
          <div class="text-neutral-500 uppercase tracking-wider text-[10px] mb-1">{headline()}</div>
          <TotalsBlock totals={totals()} />
        </section>

        <Show when={breakdown().length > 0}>
          <section>
            <div class="text-neutral-500 uppercase tracking-wider text-[10px] mb-1">by node</div>
            <div class="space-y-1">
              <For each={breakdown()}>{(child) => <BreakdownRow node={child} perAgentCost={props.perAgentCost} />}</For>
            </div>
          </section>
        </Show>

        <Show when={props.node.kind === 'process'}>
          <CallLedgerSection ledger={props.callLedger} />

          <section class="text-[10px] text-neutral-600 italic leading-snug">
            Session total comes from the membrane's per-call usage stream.
            "By node" is the per-agent ledger from the tree reducer; the two
            should converge but small drift is normal during streaming.
          </section>
        </Show>
      </div>
    </div>
  );
}

function CallLedgerSection(props: { ledger: CallLedgerSnapshot | null }) {
  const rows = (): CallLedgerRow[] => [...(props.ledger?.rows ?? [])].slice(-30).reverse();
  return (
    <section>
      <div class="flex items-baseline gap-2 mb-1">
        <div class="text-neutral-500 uppercase tracking-wider text-[10px]">recent calls · cache ledger</div>
        <Show when={props.ledger}>
          {(ledger) => (
            <span class="ml-auto text-[10px] text-neutral-500">
              ${fmtCost(ledger().summary.cost?.total ?? 0)} retained · {Math.round(ledger().summary.cacheHitRatio * 100)}% cached
              <Show when={(ledger().summary.cost?.unpricedCalls ?? 0) > 0}>
                {' '}· <span class="text-amber-400">{ledger().summary.cost!.unpricedCalls} unpriced</span>
              </Show>
            </span>
          )}
        </Show>
      </div>

      <Show
        when={rows().length > 0}
        fallback={<div class="border border-neutral-800 rounded px-2 py-2 text-neutral-600">No provider calls recorded yet.</div>}
      >
        <div class="border border-neutral-800 rounded overflow-hidden">
          <div class="grid grid-cols-[4.7rem_3.5rem_3rem_4rem_4rem_4rem_4rem_4.7rem_minmax(8rem,1fr)] gap-x-2 px-2 py-1 bg-neutral-900 text-[9px] uppercase tracking-wider text-neutral-600">
            <span>time</span><span>origin</span><span>msgs</span><span class="text-right">in</span>
            <span class="text-right">read</span><span class="text-right">write</span><span class="text-right">out</span>
            <span class="text-right">cost</span><span>verdict / cause</span>
          </div>
          <div class="max-h-80 overflow-y-auto divide-y divide-neutral-900">
            <For each={rows()}>{(row) => <CallLedgerRowView row={row} />}</For>
          </div>
        </div>
        <div class="mt-1 text-[9px] text-neutral-600">
          Costs marked in USD use provider-reported token buckets and the versioned public rate card. Calls missing an exact cache-write split or known rate stay explicitly unpriced. origin~ remains an estimated call class.
        </div>
      </Show>
    </section>
  );
}

function CallLedgerRowView(props: { row: CallLedgerRow }) {
  const time = (): string => {
    const d = new Date(props.row.timestamp);
    return Number.isNaN(d.getTime()) ? '?' : d.toLocaleTimeString([], { hour12: false });
  };
  const flags = (): string => {
    const bp = props.row.cache.breakpoints;
    if (bp === undefined) return 'flags unknown';
    if (bp === 0) return 'no cache flags';
    return `${bp}bp:${props.row.cache.effectiveTtl}`;
  };
  const costTitle = (): string => {
    const c = props.row.cost;
    if (!c) return 'Unpriced: an authoritative usage bucket or public rate was unavailable';
    return [
      `billing-grade ${c.currency} · ${c.pricingVersion}`,
      `input $${c.input.toFixed(6)}`,
      `read $${c.cacheRead.toFixed(6)}`,
      `write 5m $${c.cacheWrite5m.toFixed(6)}`,
      `write 1h $${c.cacheWrite1h.toFixed(6)}`,
      `output $${c.output.toFixed(6)}`,
    ].join(' · ');
  };
  return (
    <div class="grid grid-cols-[4.7rem_3.5rem_3rem_4rem_4rem_4rem_4rem_4.7rem_minmax(8rem,1fr)] gap-x-2 px-2 py-1.5 items-start hover:bg-neutral-900/60">
      <span class="text-neutral-400" title={`${props.row.timestamp} · ${Math.round(props.row.durationMs / 1000)}s`}>{time()}</span>
      <span class="text-neutral-500">{props.row.originEstimate}</span>
      <span class="text-neutral-400">{props.row.messages}</span>
      <span class="text-right text-neutral-400">{fmt(props.row.tokens.input)}</span>
      <span class="text-right text-sky-300">{fmt(props.row.tokens.cacheRead)}</span>
      <span class="text-right text-amber-300">{fmt(props.row.tokens.cacheWrite)}</span>
      <span class="text-right text-neutral-400">{fmt(props.row.tokens.output)}</span>
      <span
        class={`text-right ${props.row.cost ? 'text-emerald-300' : 'text-amber-500'}`}
        title={costTitle()}
      >
        {props.row.cost ? `$${fmtCost(props.row.cost.total)}` : 'unpriced'}
      </span>
      <span class="min-w-0">
        <span class={`font-semibold ${verdictColor(props.row.verdict)}`}>{props.row.verdict}</span>
        <span class="ml-1 text-[9px] text-neutral-600">{flags()}</span>
        <span class="block text-[9px] leading-snug text-neutral-500 break-words">{props.row.cause}</span>
      </span>
    </div>
  );
}

function verdictColor(verdict: CallLedgerVerdict): string {
  switch (verdict) {
    case 'HIT': return 'text-emerald-300';
    case 'hit+extend': return 'text-lime-300';
    case 'rewrite:expired': return 'text-orange-300';
    case 'rewrite:prefix-mutated':
    case 'rewrite:prefix-truncated': return 'text-red-300';
    case 'rewrite:unexplained': return 'text-violet-300';
    case 'ERROR': return 'text-red-400';
    case 'first-write': return 'text-slate-300';
    case 'uncached': return 'text-stone-400';
    default: return 'text-neutral-400';
  }
}

function TotalsBlock(props: { totals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number; currency: string } } }) {
  const t = props.totals;
  return (
    <div class="grid grid-cols-2 gap-x-3 gap-y-0.5">
      <div class="text-neutral-500">input</div>
      <div class="text-neutral-200 text-right">{fmt(t.input)}</div>
      <div class="text-neutral-500">output</div>
      <div class="text-neutral-200 text-right">{fmt(t.output)}</div>
      <Show when={t.cacheRead > 0 || t.cacheWrite > 0}>
        <div class="text-neutral-500">cache read</div>
        <div class="text-neutral-200 text-right">{fmt(t.cacheRead)}</div>
        <div class="text-neutral-500">cache write</div>
        <div class="text-neutral-200 text-right">{fmt(t.cacheWrite)}</div>
      </Show>
      <Show when={t.cost && t.cost.total > 0}>
        <div class="text-neutral-500 mt-1">cost</div>
        <div class="text-emerald-300 text-right mt-1" title={t.cost!.currency}>
          ${fmtCost(t.cost!.total)}
        </div>
      </Show>
    </div>
  );
}

function BreakdownRow(props: { node: UiNode; perAgentCost: PerAgentCost[] }) {
  const agg = aggregateTokens(props.node);
  const cost = (): { total: number; currency: string } | undefined => {
    if (!props.node.agent) return undefined;
    return props.perAgentCost.find(c => c.name === props.node.label)?.cost;
  };
  const kindHint = (): string => {
    switch (props.node.kind) {
      case 'fleet-child': return 'child';
      case 'subagent': return 'sub';
      case 'framework': return 'agent';
      default: return '';
    }
  };
  return (
    <div class="border-l-2 border-neutral-800 pl-2 py-0.5">
      <div class="flex items-baseline gap-2">
        <span class="font-mono text-neutral-300 truncate">{props.node.label}</span>
        <span class="text-[10px] text-neutral-600 uppercase tracking-wider">{kindHint()}</span>
        <Show when={cost() && cost()!.total > 0}>
          <span class="ml-auto text-emerald-300 text-[10px]" title={cost()!.currency}>
            ${fmtCost(cost()!.total)}
          </span>
        </Show>
      </div>
      <div class="flex gap-3 text-neutral-500 text-[10px]">
        <span>in {fmt(agg.input)}</span>
        <span>out {fmt(agg.output)}</span>
        <Show when={agg.cacheRead > 0}><span>cR {fmt(agg.cacheRead)}</span></Show>
        <Show when={agg.cacheWrite > 0}><span>cW {fmt(agg.cacheWrite)}</span></Show>
      </div>
    </div>
  );
}

function fmt(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k';
  return (n / 1_000_000).toFixed(2) + 'M';
}

/** Format a cost figure: 4 decimals when sub-dollar (so cents are visible),
 *  2 otherwise — matches the TUI's /usage formatter. */
function fmtCost(total: number): string {
  return total.toFixed(total < 1 ? 4 : 2);
}
