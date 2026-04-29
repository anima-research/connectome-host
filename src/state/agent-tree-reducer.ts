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
// Reducer
// ---------------------------------------------------------------------------

const ZERO_TOKENS: AgentTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function freshTokens(): AgentTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

interface SpawnCallInput {
  name?: string;
  task?: string;
  prompt?: string;
}

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

  applyEvent(event: TraceEvent | { type: string; [k: string]: unknown }): void {
    const e = event as { type: string; agentName?: string; callId?: string; timestamp?: number; [k: string]: unknown };
    const ts = typeof e.timestamp === 'number' ? e.timestamp : Date.now();

    switch (e.type) {
      case 'inference:started': {
        if (!e.agentName) return;
        const node = this.ensureNode(e.agentName);
        node.phase = 'sending';
        node.status = 'running';
        node.lastEventAt = ts;
        if (node.startedAt === undefined) node.startedAt = ts;
        return;
      }

      case 'inference:tokens': {
        if (!e.agentName) return;
        const node = this.ensureNode(e.agentName);
        node.phase = 'streaming';
        node.lastEventAt = ts;
        return;
      }

      case 'inference:tool_calls_yielded': {
        if (!e.agentName) return;
        const node = this.ensureNode(e.agentName);
        node.phase = 'invoking';
        node.lastEventAt = ts;
        const calls = (e.calls as Array<{ id: string; name: string; input?: unknown }> | undefined) ?? [];
        for (const call of calls) {
          this.callIdIndex.set(call.id, e.agentName);
          // Edge inference: subagent--spawn / subagent--fork / fleet--spawn tool calls
          // create a parent edge from the calling agent to the child.
          if (call.name === 'subagent--spawn' || call.name === 'subagent--fork') {
            const childName = (call.input as SpawnCallInput | undefined)?.name;
            if (childName) {
              const child = this.ensureNode(childName, 'subagent');
              child.parent = e.agentName;
              child.subagentType = call.name === 'subagent--fork' ? 'fork' : 'spawn';
              const inp = call.input as SpawnCallInput | undefined;
              if (inp?.task) child.task = inp.task;
              else if (inp?.prompt) child.task = inp.prompt;
              if (child.startedAt === undefined) child.startedAt = ts;
            }
          } else if (call.name === 'fleet--spawn') {
            const childName = (call.input as SpawnCallInput | undefined)?.name;
            if (childName) {
              const child = this.ensureNode(childName, 'framework');
              child.parent = e.agentName;
            }
          }
        }
        return;
      }

      case 'inference:usage': {
        if (!e.agentName) return;
        const node = this.ensureNode(e.agentName);
        const usage = e.tokenUsage as { input?: number; output?: number; cacheRead?: number; cacheCreation?: number } | undefined;
        if (usage) this.applyTokenUsage(node, usage);
        node.lastEventAt = ts;
        return;
      }

      case 'inference:completed': {
        if (!e.agentName) return;
        const node = this.ensureNode(e.agentName);
        node.phase = 'done';
        node.lastEventAt = ts;
        const usage = e.tokenUsage as { input?: number; output?: number; cacheRead?: number; cacheCreation?: number } | undefined;
        if (usage) this.applyTokenUsage(node, usage);
        return;
      }

      case 'inference:failed':
      case 'inference:exhausted': {
        if (!e.agentName) return;
        const node = this.ensureNode(e.agentName);
        node.phase = 'failed';
        node.status = 'failed';
        node.completedAt = ts;
        node.lastEventAt = ts;
        return;
      }

      case 'inference:aborted': {
        if (!e.agentName) return;
        const node = this.ensureNode(e.agentName);
        node.phase = 'failed';
        node.completedAt = ts;
        node.lastEventAt = ts;
        return;
      }

      case 'inference:stream_resumed':
      case 'inference:stream_restarted':
      case 'inference:turn_ended': {
        if (!e.agentName) return;
        const node = this.ensureNode(e.agentName);
        node.lastEventAt = ts;
        return;
      }

      case 'tool:started': {
        const callId = e.callId as string | undefined;
        if (!callId) return;
        const agentName = this.callIdIndex.get(callId);
        if (!agentName) return;
        const node = this.ensureNode(agentName);
        node.phase = 'executing';
        node.toolCallsCount += 1;
        node.lastEventAt = ts;
        return;
      }

      case 'tool:completed':
      case 'tool:failed': {
        const callId = e.callId as string | undefined;
        if (!callId) return;
        const agentName = this.callIdIndex.get(callId);
        if (!agentName) return;
        const node = this.ensureNode(agentName);
        node.lastEventAt = ts;
        // Phase stays 'executing' until the next inference:* event re-binds it.
        // Mirrors tui.ts behavior where tool:completed only clears the per-agent
        // current-tool indicator without changing the high-level phase.
        return;
      }

      // Other event types (process:*, gate:*, message:*, usage:updated, etc.)
      // are not part of the per-agent fold. Ignore.
      default:
        return;
    }
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

  /** Returns the children of a given agent (one level deep). */
  getChildren(parentName: string): AgentNode[] {
    return this.getNodes().filter(n => n.parent === parentName);
  }

  /** Returns top-level (parent-less) nodes. */
  getRoots(): AgentNode[] {
    return this.getNodes().filter(n => n.parent === undefined);
  }

  // ----- internals --------------------------------------------------------

  private ensureNode(name: string, kindHint: AgentKind = 'framework'): AgentNode {
    let node = this.nodes.get(name);
    if (!node) {
      node = this.makeNode(name, kindHint);
      this.nodes.set(name, node);
    }
    return node;
  }

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

  private applyTokenUsage(
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
}

// Avoid an unused-import lint by exporting the constant (callers may want a
// shared "no usage" sentinel for tests / display code).
export { ZERO_TOKENS };
