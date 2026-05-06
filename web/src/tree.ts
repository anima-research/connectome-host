/**
 * Client-side tree state — re-uses the AgentTreeReducer from conhost via the
 * @conhost/state path alias, fed by `trace` and `child-event` messages over
 * WS. Same reducer, four call sites now (parent-local, parent-per-child,
 * child-side describe handler, the browser).
 *
 * The browser presents a *single unified tree* mirroring the TUI's fleet
 * view: one synthetic parent-process root, with local framework agents and
 * subagents inline, plus each fleet child as a folder-like node containing
 * its own subtree. The per-scope reducers under the hood are an implementation
 * detail — `buildUiTree()` weaves their roots into one hierarchy.
 */

import { createSignal, type Accessor } from 'solid-js';
import { AgentTreeReducer, type AgentNode, type AgentTreeSnapshot } from '@conhost/state/agent-tree-reducer';
import type { WebUiServerMessage } from '@conhost/web/protocol';

export type ScopeId = 'local' | string;

/** Stream subscription strategy for a UI node. Decides what events are
 *  routed into the stream pane when the node is selected. */
export type StreamSource =
  | { kind: 'none' }                                                  // parent process / framework agent: main pane already covers it
  | { kind: 'peek'; scope: string }                                   // local subagent: open subscribe-peek
  | { kind: 'child-event-all'; childName: string }                    // fleet-child folder: every child-event for this child
  | { kind: 'child-event-agent'; childName: string; agentName: string }; // agent inside a fleet child: filter child-events by agentName

export type UiNodeKind = 'process' | 'framework' | 'subagent' | 'fleet-child';

export interface UiNode {
  /** Stable id used as expand/collapse key and React-style key. */
  id: string;
  kind: UiNodeKind;
  label: string;
  /** Underlying reducer node, when this UI node represents an agent. */
  agent?: AgentNode;
  /** For 'fleet-child', the child-process name (used by stop/restart). */
  fleetChildName?: string;
  streamSource: StreamSource;
  children: UiNode[];
}

export interface TreeStore {
  /** Reactive accessor — fires whenever any reducer's state changes. */
  build: Accessor<UiNode[]>;
  /** Apply a server message; idempotent for non-tree messages. */
  ingest(msg: WebUiServerMessage): void;
}

interface ScopeState {
  reducer: AgentTreeReducer;
  /** asOfTs of the last applied snapshot; events older than this are dropped. */
  lastSnapshotTs: number;
  /** True once we've ever applied a snapshot; gates stale-event filtering. */
  hasSnapshot: boolean;
}

export function createTreeStore(): TreeStore {
  const states = new Map<ScopeId, ScopeState>();
  const [version, setVersion] = createSignal(0);
  let parentLabel = 'parent';

  const ensureScope = (scope: ScopeId): ScopeState => {
    let s = states.get(scope);
    if (!s) {
      s = { reducer: new AgentTreeReducer(), lastSnapshotTs: 0, hasSnapshot: false };
      states.set(scope, s);
    }
    return s;
  };

  const applySnapshot = (scope: ScopeId, snap: AgentTreeSnapshot): void => {
    const s = ensureScope(scope);
    s.reducer.applySnapshot(snap);
    s.lastSnapshotTs = snap.asOfTs;
    s.hasSnapshot = true;
    bump();
  };

  const applyEvent = (scope: ScopeId, event: { type: string; [k: string]: unknown }): void => {
    const s = ensureScope(scope);
    // Drop stale events that pre-date the most recent snapshot — they're
    // already reflected in its state. Mirrors FleetTreeAggregator dedup logic.
    const ts = typeof event.timestamp === 'number' ? event.timestamp
             : typeof (event as { ts?: unknown }).ts === 'number' ? ((event as unknown) as { ts: number }).ts
             : undefined;
    if (s.hasSnapshot && typeof ts === 'number' && ts < s.lastSnapshotTs) return;
    s.reducer.applyEvent(event);
    bump();
  };

  const bump = (): void => { setVersion((v) => v + 1); };

  const build: Accessor<UiNode[]> = () => {
    void version();

    const childScopes = [...states.keys()]
      .filter(s => s !== 'local')
      .sort((a, b) => a.localeCompare(b));

    const localChildren: UiNode[] = [];
    const localState = states.get('local');
    if (localState) {
      const allLocal = localState.reducer.getNodes();
      const byName = indexByName(allLocal);
      for (const root of localState.reducer.getRoots()) {
        localChildren.push(buildAgentSubtree(root, byName, undefined));
      }
    }

    for (const scope of childScopes) {
      const s = states.get(scope)!;
      const childNodes = s.reducer.getNodes();
      const byName = indexByName(childNodes);
      const roots = s.reducer.getRoots();
      const subtree = roots.map(r => buildAgentSubtree(r, byName, scope));
      localChildren.push({
        id: `fleet:${scope}`,
        kind: 'fleet-child',
        label: scope,
        fleetChildName: scope,
        streamSource: { kind: 'child-event-all', childName: scope },
        children: subtree,
      });
    }

    const parent: UiNode = {
      id: 'process:local',
      kind: 'process',
      label: parentLabel,
      streamSource: { kind: 'none' },
      children: localChildren,
    };
    return [parent];
  };

  const ingest = (msg: WebUiServerMessage): void => {
    switch (msg.type) {
      case 'welcome': {
        states.clear();
        parentLabel = msg.recipe.name || 'parent';
        applySnapshot('local', {
          asOfTs: msg.localTree.asOfTs,
          nodes: msg.localTree.nodes as unknown as AgentNode[],
          callIdIndex: msg.localTree.callIdIndex,
        });
        for (const child of msg.childTrees) {
          applySnapshot(child.name, {
            asOfTs: child.asOfTs,
            nodes: child.nodes as unknown as AgentNode[],
            callIdIndex: child.callIdIndex,
          });
        }
        return;
      }
      case 'trace':
        applyEvent('local', msg.event);
        return;
      case 'child-event': {
        const e = msg.event;
        if (e.type === 'snapshot') {
          const tree = (e as unknown as { tree?: { nodes?: unknown[]; callIdIndex?: Record<string, string> }; asOfTs?: number }).tree;
          const asOfTs = (e as unknown as { asOfTs?: number }).asOfTs ?? Date.now();
          applySnapshot(msg.childName, {
            asOfTs,
            nodes: (tree?.nodes ?? []) as unknown as AgentNode[],
            callIdIndex: tree?.callIdIndex ?? {},
          });
          return;
        }
        applyEvent(msg.childName, e);
        return;
      }
      default:
        return;
    }
  };

  return { build, ingest };
}

function indexByName(nodes: AgentNode[]): Map<string, AgentNode> {
  const m = new Map<string, AgentNode>();
  for (const n of nodes) m.set(n.name, n);
  return m;
}

function buildAgentSubtree(
  node: AgentNode,
  byName: Map<string, AgentNode>,
  fleetChildName: string | undefined,
): UiNode {
  const children: UiNode[] = [];
  for (const candidate of byName.values()) {
    if (candidate.parent === node.name) {
      children.push(buildAgentSubtree(candidate, byName, fleetChildName));
    }
  }
  const kind: UiNodeKind = node.kind === 'subagent' ? 'subagent' : 'framework';
  return {
    id: fleetChildName ? `fleet:${fleetChildName}:${node.name}` : `local:${node.name}`,
    kind,
    label: node.name,
    agent: node,
    streamSource: pickStreamSource(node, fleetChildName),
    children,
  };
}

function pickStreamSource(node: AgentNode, fleetChildName: string | undefined): StreamSource {
  if (fleetChildName) {
    return { kind: 'child-event-agent', childName: fleetChildName, agentName: node.name };
  }
  if (node.kind === 'subagent') {
    return { kind: 'peek', scope: node.name };
  }
  // Local framework agent: the main pane already shows its activity.
  return { kind: 'none' };
}

/** Walk a UiNode tree depth-first, honoring an expanded-id set, and produce a
 *  flat list with depth info for rendering. The tree is small enough that
 *  flattening per render is fine. */
export interface FlatUiNode {
  node: UiNode;
  depth: number;
}

export function flattenUiTree(roots: UiNode[], expanded: Set<string>): FlatUiNode[] {
  const out: FlatUiNode[] = [];
  const visit = (node: UiNode, depth: number): void => {
    out.push({ node, depth });
    if (expanded.has(node.id)) {
      for (const child of node.children) visit(child, depth + 1);
    }
  };
  for (const r of roots) visit(r, 0);
  return out;
}

export interface AggregateTokens {
  /** Sum of current context window sizes across descendants. Useful as a
   *  "total active memory burden" indicator for aggregate nodes; for a single
   *  agent it equals that agent's current input. */
  input: number;
  /** Cumulative output across descendants. */
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Walk a UiNode subtree and aggregate token counts. Cumulative fields
 *  (output / cache) sum across descendants; input also sums since each
 *  agent's input is its own current ctx and they don't overlap. */
export function aggregateTokens(node: UiNode): AggregateTokens {
  const agg: AggregateTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const visit = (n: UiNode): void => {
    if (n.agent) {
      agg.input += n.agent.tokens.input;
      agg.output += n.agent.tokens.output;
      agg.cacheRead += n.agent.tokens.cacheRead;
      agg.cacheWrite += n.agent.tokens.cacheWrite;
    }
    for (const c of n.children) visit(c);
  };
  visit(node);
  return agg;
}
