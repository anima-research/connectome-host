/**
 * Branch panel — Chronicle branch lineage as a navigable tree.
 *
 * Opens from the header's branch chip into the same middle panel slot the
 * stream/usage views use. Rows are indented by fork ancestry (parentId +
 * branchPoint from Chronicle's branch records); the current branch is
 * highlighted, and checkout routes through the existing `/checkout` command
 * so undo/redo bookkeeping and workspace re-materialization stay on the one
 * audited path. Read-only for key-authenticated observers.
 */

import { createMemo, For, Show } from 'solid-js';
import type { AwarenessEntryWire, BranchRow, OperatorLogEntryWire } from '@conhost/web/protocol';
import { AwarenessList, OperatorLogList } from './Surgery';

interface TreeRow {
  branch: BranchRow;
  depth: number;
}

/** Fold the flat branch list into depth-first display order. Children sort
 *  by fork point (earliest first), then creation time. Orphans (parentId
 *  pointing at a pruned branch) surface as roots rather than vanishing. */
function toTreeRows(branches: BranchRow[]): TreeRow[] {
  const byId = new Map(branches.map((b) => [b.id, b]));
  const children = new Map<string, BranchRow[]>();
  const roots: BranchRow[] = [];
  for (const b of branches) {
    if (b.parentId !== undefined && byId.has(b.parentId)) {
      const list = children.get(b.parentId) ?? [];
      list.push(b);
      children.set(b.parentId, list);
    } else {
      roots.push(b);
    }
  }
  const byFork = (a: BranchRow, b: BranchRow): number =>
    (a.branchPoint ?? 0) - (b.branchPoint ?? 0) || a.created - b.created;
  const out: TreeRow[] = [];
  // Healthy Chronicle lineage is a DAG, but this view must not hang the
  // page on a corrupt store — guard against parentId cycles.
  const seen = new Set<string>();
  const visit = (b: BranchRow, depth: number): void => {
    if (seen.has(b.id)) return;
    seen.add(b.id);
    out.push({ branch: b, depth });
    for (const c of (children.get(b.id) ?? []).sort(byFork)) visit(c, depth + 1);
  };
  for (const r of roots.sort(byFork)) visit(r, 0);
  return out;
}

const fmtDate = (ts: number): string => {
  const d = new Date(ts);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

export function BranchPanel(props: {
  branches: BranchRow[];
  currentId: string | null;
  loading: boolean;
  /** True for key-authenticated observers — checkout affordances hidden. */
  readOnly: boolean;
  onCheckout(name: string): void;
  onRefresh(): void;
  onClose(): void;
  /** Durable operator-actions record; null when the host does not keep one. */
  operatorLog?: OperatorLogEntryWire[] | null;
  operatorLogPath?: string;
  operatorLogLoading?: boolean;
  onRefreshLog?(): void;
  /** The framework's awareness-marks journal; null when it has none. */
  awareness?: AwarenessEntryWire[] | null;
  awarenessLoading?: boolean;
  awarenessResult?: { action?: string; target?: string; receipt?: Record<string, unknown>; error?: string } | null;
  onRefreshAwareness?(): void;
  onAwarenessAction?(action: 'cancel' | 'retract' | 'release', target: string): void;
}) {
  const rows = createMemo(() => toTreeRows(props.branches));
  /** Branch names created by live surgery / undo carry their purpose as a prefix. */
  const kindOf = (name: string): string | null => {
    const prefix = name.split('/')[0];
    return prefix === 'rollback' || prefix === 'suppress' || prefix === 'undo' || prefix === 'undo-msgs'
      || prefix === 'recovery' || prefix === 'surgery' || prefix === 'treatment' ? prefix : null;
  };

  return (
    <div class="border-l border-neutral-800 w-96 shrink-0 bg-neutral-950 flex flex-col h-full">
      <div class="border-b border-neutral-800 px-3 py-2 flex items-center gap-2">
        <span class="text-[10px] uppercase tracking-wider text-neutral-500 font-semibold">branches</span>
        <span class="text-neutral-500 text-xs">{props.branches.length || ''}</span>
        <div class="ml-auto flex gap-1">
          {/* Not disabled while loading: a server-side listing error leaves
              `loading` latched, and re-clicking is the recovery path. */}
          <button
            type="button"
            class="px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded text-xs"
            onClick={() => props.onRefresh()}
          >
            {props.loading ? '…' : 'refresh'}
          </button>
          <button
            type="button"
            class="px-2 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded text-xs"
            onClick={() => props.onClose()}
          >
            close
          </button>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto px-2 py-2 font-mono text-[11px]">
        <Show when={rows().length > 0} fallback={
          <div class="text-neutral-600 italic px-1">
            {props.loading ? 'loading…' : 'No branches.'}
          </div>
        }>
          <For each={rows()}>{(row) => {
            const b = row.branch;
            const current = (): boolean => b.id === props.currentId;
            return (
              <div
                class={`group flex items-center gap-2 rounded px-1.5 py-1 ${
                  current() ? 'bg-cyan-950/40 border border-cyan-900/50' : 'hover:bg-neutral-900'
                }`}
                style={{ 'margin-left': `${row.depth * 14}px` }}
              >
                <span class={current() ? 'text-cyan-300' : 'text-neutral-600'}>
                  {row.depth > 0 ? '⑂' : '●'}
                </span>
                <span
                  class={`truncate ${current() ? 'text-cyan-100' : 'text-neutral-200'}`}
                  title={`${b.name} · head @${b.head}${b.branchPoint !== undefined ? ` · forked @${b.branchPoint}` : ''}`}
                >
                  {b.name}
                </span>
                <Show when={b.branchPoint !== undefined}>
                  <span class="text-neutral-600 shrink-0">@{b.branchPoint}</span>
                </Show>
                <Show when={kindOf(b.name)}>
                  <span class={`shrink-0 text-[9px] uppercase tracking-wider ${kindOf(b.name) === 'suppress' ? 'text-rose-400/80' : 'text-amber-400/80'}`}>{kindOf(b.name)}</span>
                </Show>
                <span class="ml-auto shrink-0 text-neutral-600">{fmtDate(b.created)}</span>
                <Show when={current()}>
                  <span class="shrink-0 text-[10px] uppercase tracking-wider text-cyan-400">current</span>
                </Show>
                <Show when={!current() && !props.readOnly}>
                  <button
                    type="button"
                    class="shrink-0 opacity-0 group-hover:opacity-100 px-1.5 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded text-[10px]"
                    title={`/checkout ${b.name}`}
                    onClick={() => props.onCheckout(b.name)}
                  >
                    checkout
                  </button>
                </Show>
              </div>
            );
          }}</For>
        </Show>
        <div class="mt-3 px-1 text-neutral-600 leading-relaxed">
          Branches fork from <span class="text-neutral-500">@sequence</span> in their parent.
          /undo, /checkpoint, /branchto and live rollback/suppress create them; checkout switches the live context.
          To undo a rollback or suppression, checkout its parent.
        </div>
        <Show when={props.operatorLog}>
          <OperatorLogList
            entries={props.operatorLog!}
            path={props.operatorLogPath}
            loading={props.operatorLogLoading ?? false}
            onRefresh={() => props.onRefreshLog?.()}
          />
        </Show>
        <Show when={props.awareness}>
          <AwarenessList
            entries={props.awareness!}
            loading={props.awarenessLoading ?? false}
            readOnly={props.readOnly}
            result={props.awarenessResult ?? null}
            onRefresh={() => props.onRefreshAwareness?.()}
            onAction={(action, target) => props.onAwarenessAction?.(action, target)}
          />
        </Show>
      </div>
    </div>
  );
}
