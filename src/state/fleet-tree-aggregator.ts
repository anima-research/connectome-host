/**
 * FleetTreeAggregator — owns one AgentTreeReducer per fleet child and
 * orchestrates `describe` requests at sync points (cold start,
 * lifecycle:ready, post-restart).
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
 *
 * Local-process state is NOT mirrored here. The TUI's existing inline fold
 * (subagentPhase / agentContextTokens / agentParent in tui.ts) is the
 * canonical local store; running a parallel local reducer that nothing reads
 * from would be paid-for-but-unused complexity. If a future pass migrates
 * local rendering off those inline maps, instantiate a local reducer at
 * that point.
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
  /** When the in-flight describe was issued. Lets the latch time out: if the
   *  snapshot never arrives (child crashed mid-describe, message lost), the
   *  latch used to stick forever and no describe could ever be issued again
   *  (fragility audit 2.10). */
  describeInFlightSince: number;
  /** Set once we've ever received a snapshot — used to detect post-restart. */
  hasInitialSnapshot: boolean;
  /** pid carried by the most recent lifecycle:ready. A later ready with a
   *  DIFFERENT pid means the child process was restarted — a hard crash
   *  emits no 'exiting', so the pid change is the only reliable signal to
   *  reset the subtree (fragility audit 2.10: post-restart events folded
   *  onto the pre-crash tree). */
  lastReadyPid: number | null;
  /** Unsubscribe handle for the per-child event subscription. */
  unsubscribe: () => void;
}

export type TreeUpdateListener = (childName: string | 'local') => void;

/** Default timeout for the describe-in-flight latch (see ChildState). */
const DEFAULT_DESCRIBE_TIMEOUT_MS = 30_000;

export class FleetTreeAggregator {
  private fleet: FleetModule;
  private childStates = new Map<string, ChildState>();
  private listeners = new Set<TreeUpdateListener>();
  /** Generation counter for corrIds; debugging convenience. */
  private corrIdSeq = 0;
  private describeTimeoutMs: number;

  constructor(fleet: FleetModule, opts: { describeTimeoutMs?: number } = {}) {
    this.fleet = fleet;
    this.describeTimeoutMs = opts.describeTimeoutMs ?? DEFAULT_DESCRIBE_TIMEOUT_MS;
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
      describeInFlightSince: 0,
      hasInitialSnapshot: false,
      lastReadyPid: null,
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

  // ----- read API ---------------------------------------------------------

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

    const eventTs = event.ts;

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
        const pid = (event as { pid?: number | null }).pid ?? null;
        // Restart detection (fragility audit 2.10): a hard crash emits no
        // 'exiting', so a later ready with a DIFFERENT pid is the only
        // signal this is a new incarnation. Reset the subtree so
        // post-restart events don't fold onto the pre-crash tree, and clear
        // the describe latch so a fresh describe actually goes out.
        if (pid !== null && state.lastReadyPid !== null && pid !== state.lastReadyPid) {
          this.resetChildState(name, state);
        }
        if (pid !== null) state.lastReadyPid = pid;
        // Always request describe on ready — covers cold-start, reconnect, restart.
        // The reducer's applySnapshot wipes prior state, so re-requesting is safe
        // even if we have current data.
        this.requestDescribe(name);
        return;
      }
      if (phase === 'exiting') {
        // Graceful exit: drop the subtree now so a dead child doesn't keep
        // rendering stale nodes, and clear the describe latch. When the
        // child restarts, its fresh lifecycle:ready re-describes
        // (fragility audit 2.10).
        this.resetChildState(name, state);
        return;
      }
    }

    // Drop events older than the most recent snapshot — they're already
    // reflected in the snapshot's state. This handles the in-flight window
    // between describe-send and snapshot-receive.
    if (state.hasInitialSnapshot && typeof eventTs === 'number' && eventTs < state.lastSnapshotTs) {
      return;
    }

    state.reducer.applyEvent(event);
    this.notify(name);
  }

  /** Reset a child's subtree to pristine (new reducer, no snapshot, latch
   *  cleared) and notify listeners that the tree changed. */
  private resetChildState(name: string, state: ChildState): void {
    state.reducer = new AgentTreeReducer();
    state.lastSnapshotTs = 0;
    state.describeInFlight = false;
    state.describeInFlightSince = 0;
    state.hasInitialSnapshot = false;
    this.notify(name);
  }

  private requestDescribe(name: string): void {
    const state = this.childStates.get(name);
    if (!state) return;
    if (state.describeInFlight) {
      // Honour the latch only while it's fresh — see describeInFlightSince
      // (fragility audit 2.10).
      const age = Date.now() - state.describeInFlightSince;
      if (age < this.describeTimeoutMs) return;
    }
    const corrId = `agg-${++this.corrIdSeq}`;
    const ok = this.fleet.requestDescribe(name, corrId);
    if (ok) {
      state.describeInFlight = true;
      state.describeInFlightSince = Date.now();
    }
  }

  private notify(scope: string | 'local'): void {
    for (const l of this.listeners) {
      try { l(scope); } catch { /* one bad listener doesn't kill the others */ }
    }
  }
}
