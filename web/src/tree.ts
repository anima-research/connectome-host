/**
 * Client-side tree state — re-uses the AgentTreeReducer from conhost via the
 * @conhost/state path alias, fed by `trace` and `child-event` messages over
 * WS. Same reducer, four call sites now (parent-local, parent-per-child,
 * child-side describe handler, the browser).
 *
 * One reducer per scope: 'local' for the parent process plus one per fleet
 * child by name. Each scope produces its own roots via getRoots(), and the
 * sidebar component flattens them into a single hierarchy.
 */

import { createSignal, type Accessor } from 'solid-js';
import { AgentTreeReducer, type AgentNode, type AgentTreeSnapshot } from '@conhost/state/agent-tree-reducer';
import type { WebUiServerMessage } from '@conhost/web/protocol';

export type Scope = 'local' | string;

export interface TreeScope {
  scope: Scope;
  /** Display label — 'local' for parent, child-name otherwise. */
  label: string;
  roots: AgentNode[];
}

export interface TreeStore {
  /** Reactive accessor — fires whenever any reducer's state changes. */
  scopes: Accessor<TreeScope[]>;
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
  const states = new Map<Scope, ScopeState>();
  const [version, setVersion] = createSignal(0);

  const ensureScope = (scope: Scope): ScopeState => {
    let s = states.get(scope);
    if (!s) {
      s = { reducer: new AgentTreeReducer(), lastSnapshotTs: 0, hasSnapshot: false };
      states.set(scope, s);
    }
    return s;
  };

  const applySnapshot = (scope: Scope, snap: AgentTreeSnapshot): void => {
    const s = ensureScope(scope);
    s.reducer.applySnapshot(snap);
    s.lastSnapshotTs = snap.asOfTs;
    s.hasSnapshot = true;
    bump();
  };

  const applyEvent = (scope: Scope, event: { type: string; [k: string]: unknown }): void => {
    const s = ensureScope(scope);
    // Drop stale events that pre-date the most recent snapshot — they're
    // already reflected in its state. Mirrors FleetTreeAggregator dedup logic.
    const ts = typeof event.timestamp === 'number' ? event.timestamp
             : typeof (event as { ts?: unknown }).ts === 'number' ? (event as { ts: number }).ts
             : undefined;
    if (s.hasSnapshot && typeof ts === 'number' && ts < s.lastSnapshotTs) return;
    s.reducer.applyEvent(event);
    bump();
  };

  const bump = (): void => setVersion((v) => v + 1);

  const scopes: Accessor<TreeScope[]> = () => {
    // version() read here so Solid re-evaluates this list on each bump.
    void version();
    const out: TreeScope[] = [];
    for (const [scope, state] of states) {
      out.push({
        scope,
        label: scope === 'local' ? 'parent' : scope,
        roots: state.reducer.getRoots(),
      });
    }
    // Stable ordering: local first, then children alphabetical.
    out.sort((a, b) => {
      if (a.scope === 'local') return -1;
      if (b.scope === 'local') return 1;
      return a.scope.localeCompare(b.scope);
    });
    return out;
  };

  const ingest = (msg: WebUiServerMessage): void => {
    switch (msg.type) {
      case 'welcome': {
        // Reset all scopes — a fresh welcome means a fresh state.
        states.clear();
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
        // Snapshot events come through here too — distinguish by inner type.
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

  return { scopes, ingest };
}

/** Walk a single root and produce a flattened depth-tagged list for rendering. */
export interface FlatNode {
  node: AgentNode;
  depth: number;
}

export function flattenTree(roots: AgentNode[], allByName: Map<string, AgentNode>): FlatNode[] {
  const out: FlatNode[] = [];
  const visit = (node: AgentNode, depth: number): void => {
    out.push({ node, depth });
    for (const child of allByName.values()) {
      if (child.parent === node.name) visit(child, depth + 1);
    }
  };
  for (const r of roots) visit(r, 0);
  return out;
}
