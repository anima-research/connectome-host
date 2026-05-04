/**
 * AgentTreeReducer — folds framework TraceEvents into a tree of agent nodes
 * with phase / token / tool-count / parent-edge state.
 *
 * Single fold logic, three call sites:
 *   1. Parent process, against local `framework.onTrace()` — drives local TUI.
 *   2. Parent process, against `fleetModule.onChildEvent(name, ...)` — one
 *      reducer per fleet child, drives that child's subtree in the TUI.
 *   3. Inside each headless child, against its own `framework.onTrace()` —
 *      `describe` IPC handler returns `reducer.getTree()` over the wire.
 *
 * Mirrors the canonical fold currently scattered across:
 *   - tui.ts:1019-1037     (token aggregation on inference:usage / completed)
 *   - tui.ts:1280-1341     (phase transitions)
 *   - tui.ts:1100-1107     (parent-edge inference from subagent--spawn calls)
 *   - subagent-module.ts:262-340 (callId routing, live state tracking)
 *
 * The dispatch table EVENT_HANDLERS is the canonical source of truth: each
 * key is an event type the reducer acts on, and `REDUCER_REQUIRED_EVENTS`
 * is derived from `Object.keys(EVENT_HANDLERS)`. Adding a new case requires
 * adding to the table; the wire-level subscription floor enforced by
 * FleetModule picks up the addition automatically. There is no parallel
 * "list of events the reducer needs" to keep in sync by hand.
 */

import type { TraceEvent } from '@animalabs/agent-framework';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AgentPhase =
  | 'idle'
  | 'sending'
  | 'streaming'
  | 'invoking'
  | 'executing'
  | 'done'
  | 'failed';

export type AgentKind = 'framework' | 'subagent';

export type AgentStatus = 'running' | 'completed' | 'failed';

export interface AgentTokens {
  /** Last-seen input tokens. Represents *current context window size*, not cumulative. */
  input: number;
  /** Cumulative output tokens across all rounds. */
  output: number;
  /** Cumulative cache-read tokens. */
  cacheRead: number;
  /** Cumulative cache-write (creation) tokens. */
  cacheWrite: number;
}

export interface AgentNode {
  /** Stable identifier within this reducer's scope. For framework agents this is
   *  the framework's agent name. For subagents it's the spawn/fork display name. */
  name: string;
  kind: AgentKind;
  /** Subagent-only: spawn vs. fork (fork inherits parent context). */
  subagentType?: 'spawn' | 'fork';
  /** Subagent-only: the task string from the spawning tool call. */
  task?: string;
  /** Parent agent name (the agent that spawned this one), if any. */
  parent?: string;
  status: AgentStatus;
  phase: AgentPhase;
  tokens: AgentTokens;
  toolCallsCount: number;
  findingsCount: number;
  startedAt?: number;
  completedAt?: number;
  lastEventAt?: number;
}

export interface AgentTreeSnapshot {
  /** Wall-clock at which this snapshot was produced. Receivers should drop
   *  events with `timestamp < asOfTs` after applying. */
  asOfTs: number;
  nodes: AgentNode[];
  /** callId → agentName, for routing tool:* events that arrive after the snapshot. */
  callIdIndex: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function freshTokens(): AgentTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

interface SpawnCallInput {
  name?: string;
  task?: string;
  prompt?: string;
}

interface AnyEvent {
  type: string;
  agentName?: string;
  callId?: string;
  timestamp?: number;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Event handler table — single source of truth for "which events does the
// reducer act on" and (by extension) "which events must the wire deliver."
// ---------------------------------------------------------------------------

type EventHandler = (r: AgentTreeReducer, e: AnyEvent, ts: number) => void;

/** The dispatch table. `applyEvent` is just a Map lookup over this; recipes
 *  can't accidentally turn off rendering because `REDUCER_REQUIRED_EVENTS`
 *  (below) is derived from the keys here. */
const EVENT_HANDLERS: Record<string, EventHandler> = {
  'inference:started': (r, e, ts) => {
    if (!e.agentName) return;
    const node = r._ensureNode(e.agentName);
    node.phase = 'sending';
    node.status = 'running';
    node.lastEventAt = ts;
    if (node.startedAt === undefined) node.startedAt = ts;
  },

  'inference:tokens': (r, e, ts) => {
    if (!e.agentName) return;
    const node = r._ensureNode(e.agentName);
    node.phase = 'streaming';
    node.lastEventAt = ts;
  },

  'inference:tool_calls_yielded': (r, e, ts) => {
    if (!e.agentName) return;
    const node = r._ensureNode(e.agentName);
    node.phase = 'invoking';
    node.lastEventAt = ts;
    const calls = (e.calls as Array<{ id: string; name: string; input?: unknown }> | undefined) ?? [];
    for (const call of calls) {
      r._setCallIdAgent(call.id, e.agentName);
      // Edge inference: subagent--spawn / subagent--fork / fleet--launch
      // tool calls create a parent edge from the calling agent to the child.
      if (call.name === 'subagent--spawn' || call.name === 'subagent--fork') {
        const childName = (call.input as SpawnCallInput | undefined)?.name;
        if (childName) {
          const child = r._ensureNode(childName, 'subagent');
          child.parent = e.agentName;
          child.subagentType = call.name === 'subagent--fork' ? 'fork' : 'spawn';
          const inp = call.input as SpawnCallInput | undefined;
          if (inp?.task) child.task = inp.task;
          else if (inp?.prompt) child.task = inp.prompt;
          if (child.startedAt === undefined) child.startedAt = ts;
        }
      } else if (call.name === 'fleet--launch') {
        const childName = (call.input as SpawnCallInput | undefined)?.name;
        if (childName) {
          const child = r._ensureNode(childName, 'framework');
          child.parent = e.agentName;
        }
      }
    }
  },

  'inference:usage': (r, e, ts) => {
    if (!e.agentName) return;
    const node = r._ensureNode(e.agentName);
    const usage = e.tokenUsage as { input?: number; output?: number; cacheRead?: number; cacheCreation?: number } | undefined;
    if (usage) r._applyTokenUsage(node, usage);
    node.lastEventAt = ts;
  },

  'inference:completed': (r, e, ts) => {
    if (!e.agentName) return;
    const node = r._ensureNode(e.agentName);
    node.phase = 'done';
    node.lastEventAt = ts;
    const usage = e.tokenUsage as { input?: number; output?: number; cacheRead?: number; cacheCreation?: number } | undefined;
    if (usage) r._applyTokenUsage(node, usage);
  },

  'inference:failed': (r, e, ts) => {
    if (!e.agentName) return;
    const node = r._ensureNode(e.agentName);
    node.phase = 'failed';
    node.status = 'failed';
    node.completedAt = ts;
    node.lastEventAt = ts;
  },

  'inference:exhausted': (r, e, ts) => {
    if (!e.agentName) return;
    const node = r._ensureNode(e.agentName);
    node.phase = 'failed';
    node.status = 'failed';
    node.completedAt = ts;
    node.lastEventAt = ts;
  },

  // Aborted = user-initiated cancel. Not strictly a fault, but for tree
  // rendering the terminal-state semantics match :failed/:exhausted: status
  // must flip to 'failed' so the renderer's status-keyed RED colouring
  // doesn't show an aborted agent as still 'running'.
  'inference:aborted': (r, e, ts) => {
    if (!e.agentName) return;
    const node = r._ensureNode(e.agentName);
    node.phase = 'failed';
    node.status = 'failed';
    node.completedAt = ts;
    node.lastEventAt = ts;
  },

  'inference:stream_resumed': (r, e, ts) => {
    if (!e.agentName) return;
    r._ensureNode(e.agentName).lastEventAt = ts;
  },

  'inference:stream_restarted': (r, e, ts) => {
    if (!e.agentName) return;
    r._ensureNode(e.agentName).lastEventAt = ts;
  },

  'inference:turn_ended': (r, e, ts) => {
    if (!e.agentName) return;
    r._ensureNode(e.agentName).lastEventAt = ts;
  },

  'tool:started': (r, e, ts) => {
    if (typeof e.callId !== 'string') return;
    const agentName = r._getCallIdAgent(e.callId);
    if (!agentName) return;
    const node = r._ensureNode(agentName);
    node.phase = 'executing';
    node.toolCallsCount += 1;
    node.lastEventAt = ts;
  },

  'tool:completed': (r, e, ts) => {
    if (typeof e.callId !== 'string') return;
    const agentName = r._getCallIdAgent(e.callId);
    if (!agentName) return;
    r._ensureNode(agentName).lastEventAt = ts;
    // Phase stays 'executing' until the next inference:* event re-binds it.
    // Mirrors tui.ts behavior where tool:completed only clears the per-agent
    // current-tool indicator without changing the high-level phase.
  },

  'tool:failed': (r, e, ts) => {
    if (typeof e.callId !== 'string') return;
    const agentName = r._getCallIdAgent(e.callId);
    if (!agentName) return;
    r._ensureNode(agentName).lastEventAt = ts;
  },
};

/**
 * The minimum set of framework TraceEvent types this reducer needs to fold an
 * accurate per-agent tree. **Derived** from `EVENT_HANDLERS` at module load —
 * adding a new case to the table automatically propagates here, so the wire-
 * subscription floor in FleetModule (`unionWithReducerRequired`) self-extends
 * with no manual constant maintenance.
 *
 * If a new event type is wired into the reducer, no other file needs to
 * change for the wire to start delivering it.
 */
export const REDUCER_REQUIRED_EVENTS: readonly string[] = Object.freeze(Object.keys(EVENT_HANDLERS));

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export class AgentTreeReducer {
  private nodes = new Map<string, AgentNode>();
  /** callId → agentName, populated from inference:tool_calls_yielded. Tool events
   *  carry only callId, no agentName, so we route them through here. */
  private callIdIndex = new Map<string, string>();

  /** Pre-register top-level framework agents so the tree shows them before
   *  they emit any events. Lazy creation also works on first event. */
  seedFrameworkAgents(names: string[]): void {
    for (const name of names) {
      if (!this.nodes.has(name)) {
        this.nodes.set(name, this.makeNode(name, 'framework'));
      }
    }
  }

  applyEvent(event: TraceEvent | { type: string }): void {
    // We only branch on event.type and read fields the handler table expects;
    // fields outside the type's static shape are accessed dynamically. Widen
    // here so callers can pass any tagged event object (TraceEvent, WireEvent,
    // synthetic test events) without an `as never` escape hatch.
    const e = event as AnyEvent;
    const ts = typeof e.timestamp === 'number' ? e.timestamp : Date.now();
    const handler = EVENT_HANDLERS[e.type];
    if (!handler) return;
    handler(this, e, ts);
  }

  applySnapshot(snapshot: AgentTreeSnapshot): void {
    this.nodes.clear();
    this.callIdIndex.clear();
    for (const node of snapshot.nodes) {
      // Defensive copy so subsequent mutations don't escape into caller's data.
      this.nodes.set(node.name, {
        ...node,
        tokens: { ...node.tokens },
      });
    }
    for (const [callId, agentName] of Object.entries(snapshot.callIdIndex)) {
      this.callIdIndex.set(callId, agentName);
    }
  }

  reset(): void {
    this.nodes.clear();
    this.callIdIndex.clear();
  }

  /** Returns a deep copy of the current tree state plus the asOfTs marker
   *  needed for receivers to dedupe events. */
  getSnapshot(): AgentTreeSnapshot {
    return {
      asOfTs: Date.now(),
      nodes: this.getNodes(),
      callIdIndex: Object.fromEntries(this.callIdIndex),
    };
  }

  /** Returns a deep copy of all current nodes. */
  getNodes(): AgentNode[] {
    return [...this.nodes.values()].map(n => ({
      ...n,
      tokens: { ...n.tokens },
    }));
  }

  getNode(name: string): AgentNode | undefined {
    const n = this.nodes.get(name);
    if (!n) return undefined;
    return { ...n, tokens: { ...n.tokens } };
  }

  /** Returns the children of a given agent (one level deep).
   *  Iterates the live map directly — no full tree clone. */
  getChildren(parentName: string): AgentNode[] {
    const out: AgentNode[] = [];
    for (const n of this.nodes.values()) {
      if (n.parent === parentName) out.push({ ...n, tokens: { ...n.tokens } });
    }
    return out;
  }

  /** Returns top-level (parent-less) nodes. */
  getRoots(): AgentNode[] {
    const out: AgentNode[] = [];
    for (const n of this.nodes.values()) {
      if (n.parent === undefined) out.push({ ...n, tokens: { ...n.tokens } });
    }
    return out;
  }

  // ----- @internal: exposed for the module-scope EVENT_HANDLERS table. ----
  // Underscore-prefixed by convention; not part of the public API.
  // External callers should use the public read methods (getNode, getNodes,
  // getChildren, getRoots) and applyEvent / applySnapshot for mutation.

  /** @internal */
  _ensureNode(name: string, kindHint: AgentKind = 'framework'): AgentNode {
    let node = this.nodes.get(name);
    if (!node) {
      node = this.makeNode(name, kindHint);
      this.nodes.set(name, node);
    }
    return node;
  }

  /** @internal */
  _setCallIdAgent(callId: string, agentName: string): void {
    this.callIdIndex.set(callId, agentName);
  }

  /** @internal */
  _getCallIdAgent(callId: string): string | undefined {
    return this.callIdIndex.get(callId);
  }

  /** @internal */
  _applyTokenUsage(
    node: AgentNode,
    usage: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number },
  ): void {
    // Input represents context window size at this round; overwrite, don't sum
    // (summing inputs would double-count history that's already in the next round's input).
    if (typeof usage.input === 'number') node.tokens.input = usage.input;
    // Output / cache are per-round costs; accumulate.
    if (typeof usage.output === 'number') node.tokens.output += usage.output;
    if (typeof usage.cacheRead === 'number') node.tokens.cacheRead += usage.cacheRead;
    if (typeof usage.cacheCreation === 'number') node.tokens.cacheWrite += usage.cacheCreation;
  }

  // ----- private --------------------------------------------------------

  private makeNode(name: string, kind: AgentKind): AgentNode {
    return {
      name,
      kind,
      status: 'running',
      phase: 'idle',
      tokens: freshTokens(),
      toolCallsCount: 0,
      findingsCount: 0,
    };
  }
}
