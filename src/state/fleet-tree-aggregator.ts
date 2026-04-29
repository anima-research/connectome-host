/**
 * FleetTreeAggregator — owns one AgentTreeReducer per fleet child plus one for
 * the local process, and orchestrates `describe` requests at sync points
 * (cold start, lifecycle:ready, post-restart).
 *
 * Lockstep model (see UNIFIED-TREE-PLAN.md §3):
 *   - Live event stream is the primary path. Each child's events are folded
 *     into its reducer as they arrive.
 *   - `describe` is a *recovery* verb, requested rarely:
 *       * once per child on first lifecycle:ready (cold start / reattach)
 *       * once per child after a restart (process:exited → new lifecycle:ready)
 *   - When a `snapshot` arrives, applySnapshot wipes the child's reducer and
 *     reseeds from ground truth. Subsequent events resume the fold.
 *   - Events with `ts < asOfTs` are dropped after a snapshot — they're already
 *     reflected in the snapshot's state (no double-application).
 *
 * The aggregator exposes a clean read API for the TUI (Phase 5) without the
 * TUI needing to know about IPC, describe handshakes, or stale-event dedup.
 */

import type { FleetModule, FleetEventCallback } from '../modules/fleet-module.js';
import type { WireEvent } from '../modules/fleet-types.js';
import { AgentTreeReducer, type AgentTreeSnapshot, type AgentNode } from './agent-tree-reducer.js';

interface ChildState {
  reducer: AgentTreeReducer;
  /** asOfTs of the last applied snapshot; events older than this are dropped. */
  lastSnapshotTs: number;
  /** True once we've requested a describe and are awaiting a snapshot. */
  describeInFlight: boolean;
  /** Set once we've ever received a snapshot — used to detect post-restart. */
  hasInitialSnapshot: boolean;
  /** Unsubscribe handle for the per-child event subscription. */
  unsubscribe: () => void;
}

export type TreeUpdateListener = (childName: string | 'local') => void;

export class FleetTreeAggregator {
  private fleet: FleetModule;
  private localReducer: AgentTreeReducer;
  private childStates = new Map<string, ChildState>();
  private listeners = new Set<TreeUpdateListener>();
  /** Generation counter for corrIds; debugging convenience. */
  private corrIdSeq = 0;

  constructor(fleet: FleetModule) {
    this.fleet = fleet;
    this.localReducer = new AgentTreeReducer();
  }

  /** Register a child. Idempotent — re-registering with the same name is a noop
   *  unless the prior subscription was torn down (in which case it re-subscribes). */
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
      describeInFlight: false,
      hasInitialSnapshot: false,
      unsubscribe,
    });

    // If the child is already ready when we register, request describe right away.
    // (lifecycle:ready already fired before we subscribed.)
    const fleetChild = this.fleet.getChildren().get(name);
    if (fleetChild?.status === 'ready') {
      this.requestDescribe(name);
    }
  }

  /** Stop tracking a child and tear down its subscription. */
  unregisterChild(name: string): void {
    const state = this.childStates.get(name);
    if (!state) return;
    state.unsubscribe();
    this.childStates.delete(name);
  }

  /** Apply a local trace event (from this process's framework.onTrace). */
  applyLocalEvent(event: { type: string; [k: string]: unknown }): void {
    this.localReducer.applyEvent(event as never);
    this.notify('local');
  }

  /** Seed the local reducer with framework agents (call once on init). */
  seedLocalAgents(names: string[]): void {
    this.localReducer.seedFrameworkAgents(names);
  }

  // ----- read API ---------------------------------------------------------

  getLocalNodes(): AgentNode[] {
    return this.localReducer.getNodes();
  }

  getChildNodes(name: string): AgentNode[] {
    const state = this.childStates.get(name);
    return state ? state.reducer.getNodes() : [];
  }

  getAllChildNames(): string[] {
    return [...this.childStates.keys()];
  }

  /** Subscribe to tree-updated notifications. Returns an unsubscribe function.
   *  Listener fires for any change to local or any child's tree. */
  onTreeUpdate(listener: TreeUpdateListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Tear down all subscriptions. Call on TUI shutdown. */
  dispose(): void {
    for (const [, state] of this.childStates) {
      state.unsubscribe();
    }
    this.childStates.clear();
    this.listeners.clear();
  }

  // ----- internals --------------------------------------------------------

  private handleChildEvent(name: string, event: WireEvent): void {
    const state = this.childStates.get(name);
    if (!state) return;

    const eventTs = (event as { ts?: number }).ts;

    // Snapshot response: reseed from ground truth.
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
      state.describeInFlight = false;
      state.hasInitialSnapshot = true;
      this.notify(name);
      return;
    }

    // Lifecycle: ready fires on initial connect AND after parent reconnect to
    // a still-running child AND when adopt-on-restart re-establishes a socket
    // post-spawn-restart. Request describe in all those cases.
    if (event.type === 'lifecycle') {
      const phase = (event as { phase?: string }).phase;
      if (phase === 'ready') {
        // Always request describe on ready — covers cold-start, reconnect, restart.
        // The reducer's applySnapshot wipes prior state, so re-requesting is safe
        // even if we have current data.
        this.requestDescribe(name);
        return;
      }
      // 'exiting' is informational; the actual reset happens on process:exit.
      // The fleet-module marks status='exited' on proc.exit; we detect that via
      // status polling on next ready, or via an explicit reset below.
    }

    // Drop events older than the most recent snapshot — they're already
    // reflected in the snapshot's state. This handles the in-flight window
    // between describe-send and snapshot-receive.
    if (state.hasInitialSnapshot && typeof eventTs === 'number' && eventTs < state.lastSnapshotTs) {
      return;
    }

    state.reducer.applyEvent(event as never);
    this.notify(name);
  }

  private requestDescribe(name: string): void {
    const state = this.childStates.get(name);
    if (!state) return;
    if (state.describeInFlight) return;
    const corrId = `agg-${++this.corrIdSeq}`;
    const ok = this.fleet.requestDescribe(name, corrId);
    if (ok) state.describeInFlight = true;
  }

  private notify(scope: string | 'local'): void {
    for (const l of this.listeners) {
      try { l(scope); } catch { /* one bad listener doesn't kill the others */ }
    }
  }
}
