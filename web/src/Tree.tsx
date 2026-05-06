import { For, Show } from 'solid-js';
import type { AgentNode } from '@conhost/state/agent-tree-reducer';
import type { UiNode } from './tree';
import { aggregateTokens, flattenUiTree } from './tree';

export interface TreeSidebarProps {
  roots: UiNode[];
  /** Currently-selected node id (UiNode.id), if any. */
  selectedId: string | null;
  /** Set of node ids that are expanded; render contains caret state. */
  expanded: Set<string>;
  onToggleExpand(id: string): void;
  /** Open / focus the stream view for this node. */
  onSelectStream(node: UiNode): void;
  /** Open / focus the usage view for this node. */
  onSelectUsage(node: UiNode): void;
  /** Cancel an in-process subagent by display name. */
  onCancelSubagent(name: string): void;
  /** Stop a fleet child gracefully. */
  onFleetStop(name: string): void;
  /** Restart a fleet child. */
  onFleetRestart(name: string): void;
}

export function TreeSidebar(props: TreeSidebarProps) {
  return (
    <div class="h-full overflow-y-auto px-2 py-2 text-xs">
      <Show
        when={props.roots.length > 0}
        fallback={<div class="text-neutral-600 italic px-2">No agents registered yet.</div>}
      >
        <div class="space-y-0.5">
          <For each={flattenUiTree(props.roots, props.expanded)}>
            {(item) => (
              <NodeRow
                node={item.node}
                depth={item.depth}
                expanded={props.expanded.has(item.node.id)}
                selected={props.selectedId === item.node.id}
                onToggleExpand={() => props.onToggleExpand(item.node.id)}
                onSelectStream={() => props.onSelectStream(item.node)}
                onSelectUsage={() => props.onSelectUsage(item.node)}
                onCancelSubagent={props.onCancelSubagent}
                onFleetStop={props.onFleetStop}
                onFleetRestart={props.onFleetRestart}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function NodeRow(props: {
  node: UiNode;
  depth: number;
  expanded: boolean;
  selected: boolean;
  onToggleExpand(): void;
  onSelectStream(): void;
  onSelectUsage(): void;
  onCancelSubagent(name: string): void;
  onFleetStop(name: string): void;
  onFleetRestart(name: string): void;
}) {
  const hasChildren = (): boolean => props.node.children.length > 0;
  const canStream = (): boolean => props.node.streamSource.kind !== 'none';

  const isLiveSubagent = (): boolean =>
    props.node.kind === 'subagent' && props.node.agent?.status === 'running';

  const stopHandler = (): (() => void) | null => {
    if (isLiveSubagent()) return () => props.onCancelSubagent(props.node.label);
    if (props.node.kind === 'fleet-child' && props.node.fleetChildName)
      return () => props.onFleetStop(props.node.fleetChildName!);
    return null;
  };

  const restartHandler = (): (() => void) | null => {
    if (props.node.kind === 'fleet-child' && props.node.fleetChildName)
      return () => props.onFleetRestart(props.node.fleetChildName!);
    return null;
  };

  const selectedClass = (): string => props.selected ? 'bg-cyan-900/30' : 'hover:bg-neutral-900/40';

  const onLabelClick = (): void => {
    if (canStream()) props.onSelectStream();
    else if (hasChildren()) props.onToggleExpand();
  };

  return (
    <div
      class={`flex items-center gap-1 py-0.5 pr-1 rounded ${selectedClass()}`}
      style={{ 'padding-left': `${0.25 + props.depth * 0.75}rem` }}
    >
      {/* Expand caret. Always present so column widths line up; invisible for leaves. */}
      <button
        type="button"
        class={`w-4 text-center text-neutral-500 hover:text-neutral-200 ${hasChildren() ? '' : 'opacity-0 pointer-events-none'}`}
        onClick={props.onToggleExpand}
        title={props.expanded ? 'Collapse' : 'Expand'}
      >
        {props.expanded ? '▾' : '▸'}
      </button>

      {/* Label region — clicking opens the stream view. The token badge inside
       *  has its own onClick that stops propagation so it can target usage. */}
      <div
        role="button"
        tabIndex={0}
        class="flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
        onClick={onLabelClick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onLabelClick(); }}
      >
        <NodeLabel node={props.node} onUsageClick={() => props.onSelectUsage()} />
      </div>

      <NodeActions
        node={props.node}
        canStream={canStream()}
        onSelectStream={props.onSelectStream}
        onStop={stopHandler()}
        onRestart={restartHandler()}
      />
    </div>
  );
}

function NodeLabel(props: { node: UiNode; onUsageClick: () => void }) {
  const n = props.node;
  if (n.kind === 'process') {
    const agg = aggregateTokens(n);
    return (
      <>
        <span class="text-neutral-600">▣</span>
        <span class="font-mono text-neutral-200 truncate">{n.label}</span>
        <span class="text-[10px] text-neutral-600 uppercase tracking-wider">parent</span>
        <span class="ml-auto text-neutral-500 text-[10px] font-mono whitespace-nowrap">
          <UsageBadge label={`${fmtTokens(agg.output)}out`} hidden={agg.output === 0} onClick={props.onUsageClick} title="Show session usage" />
        </span>
      </>
    );
  }
  if (n.kind === 'fleet-child') {
    const agg = aggregateTokens(n);
    return (
      <>
        <span class="text-cyan-400">▢</span>
        <span class="font-mono text-neutral-200 truncate">{n.label}</span>
        <span class="text-[10px] text-cyan-500 uppercase tracking-wider">child</span>
        <span class="ml-auto text-neutral-500 text-[10px] font-mono whitespace-nowrap">
          <UsageBadge label={`${fmtTokens(agg.output)}out`} hidden={agg.output === 0} onClick={props.onUsageClick} title="Show child usage" />
        </span>
      </>
    );
  }
  // framework / subagent
  const a = n.agent!;
  return (
    <>
      <span class="font-mono text-neutral-300 truncate">{n.label}</span>
      <span class={`px-1 rounded text-[10px] ${phaseColor(a.phase)}`}>
        {a.phase}
      </span>
      <Show when={n.kind === 'subagent'}>
        <span class="text-neutral-600 text-[10px]">sub</span>
      </Show>
      <span class="ml-auto flex items-center gap-1 text-neutral-500 text-[10px] font-mono whitespace-nowrap">
        <UsageBadge
          label={`${fmtTokens(a.tokens.input)}cx`}
          hidden={a.tokens.input === 0}
          onClick={props.onUsageClick}
          title="Show agent usage"
        />
        <Show when={a.toolCallsCount > 0}>
          <span title="tool calls">·{a.toolCallsCount}</span>
        </Show>
      </span>
    </>
  );
}

function UsageBadge(props: { label: string; hidden: boolean; onClick: () => void; title: string }) {
  return (
    <Show when={!props.hidden}>
      <span
        role="button"
        tabIndex={0}
        class="px-1 rounded cursor-pointer hover:text-cyan-300 hover:bg-cyan-900/20"
        title={props.title}
        onClick={(e) => { e.stopPropagation(); props.onClick(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation();
            e.preventDefault();
            props.onClick();
          }
        }}
      >
        {props.label}
      </span>
    </Show>
  );
}

function NodeActions(props: {
  node: UiNode;
  canStream: boolean;
  onSelectStream: () => void;
  onStop: (() => void) | null;
  onRestart: (() => void) | null;
}) {
  return (
    <>
      <Show when={props.canStream}>
        <button
          type="button"
          class="text-[10px] px-1 py-0.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded font-mono"
          onClick={(e) => { e.stopPropagation(); props.onSelectStream(); }}
          title="Show this node's live stream"
        >
          stream
        </button>
      </Show>
      <Show when={props.onStop}>
        <button
          type="button"
          class="text-[10px] px-1 py-0.5 bg-rose-900/40 hover:bg-rose-900/60 text-rose-200 rounded font-mono"
          onClick={(e) => { e.stopPropagation(); props.onStop?.(); }}
          title="Stop"
        >
          stop
        </button>
      </Show>
      <Show when={props.onRestart}>
        <button
          type="button"
          class="text-[10px] px-1 py-0.5 bg-cyan-900/40 hover:bg-cyan-900/60 text-cyan-200 rounded font-mono"
          onClick={(e) => { e.stopPropagation(); props.onRestart?.(); }}
          title="Restart"
        >
          ↻
        </button>
      </Show>
    </>
  );
}

function phaseColor(phase: AgentNode['phase']): string {
  switch (phase) {
    case 'streaming': return 'bg-cyan-500/30 text-cyan-200';
    case 'sending': return 'bg-amber-500/30 text-amber-200';
    case 'invoking': return 'bg-fuchsia-500/30 text-fuchsia-200';
    case 'executing': return 'bg-amber-500/30 text-amber-200';
    case 'done': return 'bg-neutral-700 text-neutral-400';
    case 'failed': return 'bg-rose-500/40 text-rose-200';
    default: return 'bg-neutral-800 text-neutral-400';
  }
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}
