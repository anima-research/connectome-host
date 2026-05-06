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
import type { TokenUsage, PerAgentCost } from '@conhost/web/protocol';

export function UsagePanel(props: {
  node: UiNode;
  /** Session-wide cumulative usage from welcome/usage messages. Only
   *  consulted when the focused node is the parent process. */
  sessionUsage: TokenUsage;
  /** Per-agent cost slice (parent-process agents only). Used to label
   *  per-agent cost in process / per-agent breakdown views. */
  perAgentCost: PerAgentCost[];
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
    <div class="border-l border-neutral-800 w-96 shrink-0 bg-neutral-950 flex flex-col h-full">
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
