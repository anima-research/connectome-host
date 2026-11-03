import type { FleetModule, FleetEventCallback } from '../modules/fleet-module.js';
import type { WireEvent } from '../modules/fleet-types.js';
import { AgentTreeReducer, type AgentTreeSnapshot, type AgentNode } from './agent-tree-reducer.js';

interface ChildState {
  reducer: AgentTreeReducer;
  lastSnapshotTs: number;
  hasInitialSnapshot: boolean;
  unsubscribe: () => void;
}

export type TreeUpdateListener = (childName: string | 'local') => void;

export class FleetTreeAggregator {
  private fleet: FleetModule;
  private childStates = new Map<string, ChildState>();
  private listeners = new Set<TreeUpdateListener>();
  private corrIdSeq = 0;

  constructor(fleet: FleetModule) {
    this.fleet = fleet;
  }

  registerChild(name: string): void {
    if (this.childStates.has(name)) return;

    const reducer = new AgentTreeReducer();
    const callback: FleetEventCallback = (childName, event) => {
      if (childName !== name) return;
      this.handleChildEvent(name, event);
    };
    const unsubscribe = this.fleet.onChildEvent(name, callback);

    this.childStates.set(name, {
      reducer,
      lastSnapshotTs: 0,
      hasInitialSnapshot: false,
      unsubscribe,
    });

    const fleetChild = this.fleet.getChildren().get(name);
    if (fleetChild?.status === 'ready') {
      this.requestDescribe(name);
    }
  }

  unregisterChild(name: string): void {
    const state = this.childStates.get(name);
    if (!state) return;
    state.unsubscribe();
    this.childStates.delete(name);
  }

  getChildNodes(name: string): AgentNode[] {
    const state = this.childStates.get(name);
    return state ? state.reducer.getNodes() : [];
  }

  getAllChildNames(): string[] {
    return [...this.childStates.keys()];
  }

  onTreeUpdate(listener: TreeUpdateListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    for (const [, state] of this.childStates) {
      state.unsubscribe();
    }
    this.childStates.clear();
    this.listeners.clear();
  }

  private handleChildEvent(name: string, event: WireEvent): void {
    const state = this.childStates.get(name);
    if (!state) return;

    const eventTs = event.ts;

    if (event.type === 'snapshot') {
      const snapshotEvent = event as unknown as {
        asOfTs?: number;
        tree?: { nodes?: unknown[]; callIdIndex?: Record<string, string> };
      };
      const asOfTs = snapshotEvent.asOfTs ?? Date.now();
      const treeNodes = (snapshotEvent.tree?.nodes ?? []) as AgentNode[];
      const callIdIndex = snapshotEvent.tree?.callIdIndex ?? {};
      const snap: AgentTreeSnapshot = {
        asOfTs,
        nodes: treeNodes,
        callIdIndex,
      };
      state.reducer.applySnapshot(snap);
      state.lastSnapshotTs = asOfTs;
      state.hasInitialSnapshot = true;
      this.notify(name);
      return;
    }

    if (event.type === 'lifecycle') {
      const phase = (event as { phase?: string }).phase;
      if (phase === 'ready') {
        this.requestDescribe(name);
        return;
      }
    }

    if (state.hasInitialSnapshot && typeof eventTs === 'number' && eventTs < state.lastSnapshotTs) {
      return;
    }

    state.reducer.applyEvent(event);
    this.notify(name);
  }

  private requestDescribe(name: string): void {
    if (!this.childStates.has(name)) return;
    this.fleet.requestDescribe(name, `agg-${++this.corrIdSeq}`);
  }

  private notify(scope: string | 'local'): void {
    for (const l of this.listeners) {
      try { l(scope); } catch { }
    }
  }
}
