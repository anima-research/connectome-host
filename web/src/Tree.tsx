import { For, Show } from 'solid-js';
import type { AgentNode } from '@conhost/state/agent-tree-reducer';
import type { TreeScope } from './tree';
import { flattenTree } from './tree';

export function TreeSidebar(props: { scopes: TreeScope[] }) {
  return (
    <div class="h-full overflow-y-auto px-3 py-3 text-xs space-y-3">
      <Show
        when={props.scopes.length > 0 && props.scopes.some(s => s.roots.length > 0)}
        fallback={<div class="text-neutral-600 italic">No agents registered yet.</div>}
      >
        <For each={props.scopes}>{(scope) => <ScopeBlock scope={scope} />}</For>
      </Show>
    </div>
  );
}

function ScopeBlock(props: { scope: TreeScope }) {
  // Build a name → node map for child lookup (same shape across scope).
  // Walks all nodes once per render — fine at admin-UI scale.
  const allByName = (): Map<string, AgentNode> => {
    const m = new Map<string, AgentNode>();
    const visit = (nodes: AgentNode[]): void => {
      for (const n of nodes) m.set(n.name, n);
    };
    visit(props.scope.roots);
    // Also collect any non-root nodes that the reducer knows about by walking
    // children. We expose `roots` only, so children aren't directly visible —
    // but `flattenTree` re-derives them from the parent edge, so the map needs
    // to include nodes that are *parented* to a root. The simplest path is to
    // pass an empty map and let flattenTree only walk roots — which means
    // subtrees won't render. For Phase 3 we accept roots-only display; the
    // FleetTreeAggregator already returns flat nodes per child anyway.
    return m;
  };

  const flat = (): ReturnType<typeof flattenTree> => {
    return flattenTree(props.scope.roots, allByName());
  };

  return (
    <div>
      <div class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold mb-1">
        {props.scope.label}
      </div>
      <div class="space-y-0.5">
        <For each={flat()} fallback={<div class="text-neutral-600 italic pl-2">empty</div>}>
          {(item) => <NodeRow node={item.node} depth={item.depth} />}
        </For>
      </div>
    </div>
  );
}

function NodeRow(props: { node: AgentNode; depth: number }) {
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

  return (
    <div
      class="flex items-center gap-2 py-0.5 pr-1 hover:bg-neutral-900/40 rounded"
      style={{ 'padding-left': `${0.25 + props.depth * 0.75}rem` }}
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
    </div>
  );
}
