import { For, Show } from 'solid-js';
import type { AgentNode } from '@conhost/state/agent-tree-reducer';
import type { TreeScope } from './tree';
import { flattenTree } from './tree';

export interface TreeSidebarProps {
  scopes: TreeScope[];
  selectedScope: string | null;
  /** Called when the operator clicks a node. The scope is `local` for parent
   *  agents or the child name for fleet children / their agents. */
  onSelect(scope: string): void;
}

export function TreeSidebar(props: TreeSidebarProps) {
  return (
    <div class="h-full overflow-y-auto px-3 py-3 text-xs space-y-3">
      <Show
        when={props.scopes.length > 0 && props.scopes.some(s => s.roots.length > 0)}
        fallback={<div class="text-neutral-600 italic">No agents registered yet.</div>}
      >
        <For each={props.scopes}>{(scope) => (
          <ScopeBlock
            scope={scope}
            selectedScope={props.selectedScope}
            onSelect={props.onSelect}
          />
        )}</For>
      </Show>
    </div>
  );
}

function ScopeBlock(props: {
  scope: TreeScope;
  selectedScope: string | null;
  onSelect(scope: string): void;
}) {
  const allByName = (): Map<string, AgentNode> => {
    const m = new Map<string, AgentNode>();
    for (const n of props.scope.roots) m.set(n.name, n);
    return m;
  };
  const flat = (): ReturnType<typeof flattenTree> => flattenTree(props.scope.roots, allByName());

  // Scope ID used for peek subscriptions. For `local`, the parent process —
  // we use the scope label; for fleet children, the scope name *is* the
  // child name, which is also the peek scope.
  const peekScopeFor = (node: AgentNode): string => {
    if (props.scope.scope === 'local') {
      // Top-level parent agent: no peek (the trace stream is the data).
      // Subagent: use its name. The reducer marks subagents with kind='subagent'.
      return node.kind === 'subagent' ? node.name : props.scope.scope;
    }
    return props.scope.scope; // fleet child name
  };

  return (
    <div>
      <div class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold mb-1">
        {props.scope.label}
      </div>
      <div class="space-y-0.5">
        <For each={flat()} fallback={<div class="text-neutral-600 italic pl-2">empty</div>}>
          {(item) => (
            <NodeRow
              node={item.node}
              depth={item.depth}
              selected={props.selectedScope === peekScopeFor(item.node)}
              onSelect={() => props.onSelect(peekScopeFor(item.node))}
            />
          )}
        </For>
      </div>
    </div>
  );
}

function NodeRow(props: {
  node: AgentNode;
  depth: number;
  selected: boolean;
  onSelect(): void;
}) {
  const phaseColor = (): string => {
    switch (props.node.phase) {
      case 'streaming': return 'bg-cyan-500/30 text-cyan-200';
      case 'sending': return 'bg-amber-500/30 text-amber-200';
      case 'invoking': return 'bg-fuchsia-500/30 text-fuchsia-200';
      case 'executing': return 'bg-amber-500/30 text-amber-200';
      case 'done': return 'bg-neutral-700 text-neutral-400';
      case 'failed': return 'bg-rose-500/40 text-rose-200';
      default: return 'bg-neutral-800 text-neutral-400';
    }
  };

  const fmtTokens = (n: number): string => {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k';
    return (n / 1_000_000).toFixed(1) + 'M';
  };

  const selectedClass = (): string => props.selected ? 'bg-cyan-900/30' : 'hover:bg-neutral-900/40';

  return (
    <button
      type="button"
      class={`flex items-center gap-2 py-0.5 pr-1 rounded w-full text-left ${selectedClass()}`}
      style={{ 'padding-left': `${0.25 + props.depth * 0.75}rem` }}
      onClick={() => props.onSelect()}
    >
      <span class="font-mono text-neutral-300 truncate">{props.node.name}</span>
      <span class={`px-1 rounded text-[10px] ${phaseColor()}`}>
        {props.node.phase}
      </span>
      <Show when={props.node.kind === 'subagent'}>
        <span class="text-neutral-600 text-[10px]">sub</span>
      </Show>
      <span class="ml-auto text-neutral-500 text-[10px] font-mono whitespace-nowrap">
        <Show when={props.node.tokens.input > 0}>
          <span title="context tokens">{fmtTokens(props.node.tokens.input)}cx</span>
        </Show>
        <Show when={props.node.toolCallsCount > 0}>
          <span class="ml-1" title="tool calls">·{props.node.toolCallsCount}</span>
        </Show>
      </span>
    </button>
  );
}
