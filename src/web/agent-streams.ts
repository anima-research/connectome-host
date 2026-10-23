/**
 * Where the Web UI page shows each agent's stream. The page imports it as
 * `@conhost/web/agent-streams`, which the server's tests can reach.
 *
 * The page's main view shows the conversation of the host's first agent:
 * the welcome's messages and the live `message-appended` frames both come
 * from `getAllAgents()[0]`'s context (web-ui-module's buildWelcome and its
 * message-store listener), and the welcome lists that agent first. So the
 * main view's streaming message follows that agent's traces alone. Each
 * other agent's stream has its own panel, opened from its node in the tree:
 * - a subagent's through the subagent module's peek stream;
 * - an agent of a fleet child through that child's events;
 * - another of the host's own framework agents, such as a subconscious or
 *   a conversation fork, through its own traces.
 * Another agent's tokens in the main view would join its streaming message
 * or start a row that no stored message replaces, and its end would end the
 * conversation agent's message mid-turn.
 *
 * The streaming message ends at any of the conversation agent's
 * STREAM_END_TRACES (state/turn-trace.ts), a turn a tool ended included.
 * The quiesce re-pull runs at any agent's end, since a quiesce drains when
 * the last turn in flight ends, whoever's it is.
 *
 * An observer's page gets only the frames its grant covers, so what the page
 * builds from frames follows the grant too: the tree only with the trees'
 * scopes (treesShownFor), and a tool call's state from its stored result once
 * that has loaded (toolCallState).
 */

import { STREAM_END_TRACES } from '../state/turn-trace.js';
import type { AgentNode } from '../state/agent-tree-reducer.js';
import { AGENT_TREE_SCOPES } from './protocol.js';

export interface TraceViewHooks {
  appendStreamToken(token: string, blockType?: string): void;
  /** Handle inference:content_block phases (auto-collapse finished blocks). */
  handleContentBlock(phase: string): void;
  /** Attach yielded tool calls to the streaming assistant message. */
  appendToolUseBlocks(calls: Array<{ id: string; name: string; input?: unknown }>): void;
  /** Flip a tool_use block's live status from tool:* traces. */
  updateToolStatus(callId: string, status: 'done' | 'failed', durationMs?: number): void;
  finishStream(): void;
  /** A turn ended: refresh host mode if a quiesce was still draining. */
  onTurnSettled(): void;
  /** Fold an ops:alert trace into the alert strip. */
  onOpsAlert(event: { [k: string]: unknown }): void;
  /** An operator:action trace landed: refresh the log if it's on screen. */
  onOperatorAction(): void;
  /** Ask the server for a fresh host-mode snapshot (after host:* traces). */
  requestHostMode(): void;
}

/** The agent whose conversation the main view shows: the welcome's first,
 *  since the welcome lists the host's agents in registration order and the
 *  view's messages are the first agent's (see above). Undefined before a
 *  welcome names one. */
export function conversationAgentOf(
  welcome: { agents: ReadonlyArray<{ name: string }> } | null | undefined,
): string | undefined {
  return welcome?.agents[0]?.name;
}

/** An agent's stream ended: from a stream-end trace, or from the
 *  `stream-ended` frame a client gets in place of one whose payload its
 *  scopes don't cover. The main view's streaming message ends when the
 *  agent is the conversation's, and the quiesce re-pull runs at any agent's
 *  end. */
export function applyStreamEnded(
  agentName: unknown,
  hooks: Pick<TraceViewHooks, 'finishStream' | 'onTurnSettled'>,
  conversationAgent: string | undefined,
): void {
  if (conversationAgent === undefined || typeof agentName !== 'string' || agentName === conversationAgent) {
    hooks.finishStream();
  }
  // The framework emits no trace for "drained", so re-pull the snapshot.
  hooks.onTurnSettled();
}

/** Apply one trace to the main view and the page's state. `conversationAgent`
 *  is the agent the main view shows (conversationAgentOf); before a welcome
 *  names one, every trace is the view's, as is one that names no agent. */
export function applyTrace(
  e: { type: string; [k: string]: unknown },
  hooks: TraceViewHooks,
  conversationAgent: string | undefined,
): void {
  const inView = conversationAgent === undefined
    || typeof e.agentName !== 'string'
    || e.agentName === conversationAgent;
  switch (e.type) {
    case 'inference:tokens': {
      if (inView && typeof e.content === 'string') {
        hooks.appendStreamToken(e.content, typeof e.blockType === 'string' ? e.blockType : undefined);
      }
      return;
    }
    case 'inference:content_block': {
      if (inView && typeof e.phase === 'string') hooks.handleContentBlock(e.phase);
      return;
    }
    case 'inference:tool_calls_yielded': {
      if (!inView) return;
      const calls = (e.calls as Array<{ id: string; name: string; input?: unknown }> | undefined) ?? [];
      if (calls.length > 0) hooks.appendToolUseBlocks(calls);
      return;
    }
    case 'tool:completed': {
      if (typeof e.callId === 'string') {
        hooks.updateToolStatus(e.callId, 'done', typeof e.durationMs === 'number' ? e.durationMs : undefined);
      }
      return;
    }
    case 'tool:failed': {
      if (typeof e.callId === 'string') {
        hooks.updateToolStatus(e.callId, 'failed', typeof e.durationMs === 'number' ? e.durationMs : undefined);
      }
      return;
    }
    case 'ops:alert':
      hooks.onOpsAlert(e);
      return;
    case 'operator:action':
      hooks.onOperatorAction();
      return;
  }
  if (STREAM_END_TRACES.has(e.type)) {
    applyStreamEnded(e.agentName, hooks, conversationAgent);
    return;
  }
  // Host serving-state transitions (host:quiesce / host:resume /
  // host:quiesced_boot) may originate elsewhere (Discord host command,
  // API), so pull a fresh snapshot rather than parsing them.
  if (e.type.startsWith('host:')) hooks.requestHostMode();
}

/** Stream subscription strategy for a node of the agent tree: what the
 *  stream panel shows when the node is selected. */
export type StreamSource =
  | { kind: 'none' }                                                  // the process, and the conversation agent: the main view shows it
  | { kind: 'trace-agent'; agentName: string }                        // another of the host's framework agents: its own traces
  | { kind: 'peek'; scope: string }                                   // local subagent: open subscribe-peek
  | { kind: 'child-event-all'; childName: string }                    // fleet-child folder: every child-event for this child
  | { kind: 'child-event-agent'; childName: string; agentName: string }; // agent inside a fleet child: filter child-events by agentName

/** The panel for an agent's node. `conversationAgent` is the agent whose
 *  stream the main view shows (conversationAgentOf). A trace-agent panel
 *  shows its agent's traces from when it opens. */
export function pickStreamSource(
  node: Pick<AgentNode, 'name' | 'kind'>,
  fleetChildName: string | undefined,
  conversationAgent: string | undefined,
): StreamSource {
  if (fleetChildName) {
    return { kind: 'child-event-agent', childName: fleetChildName, agentName: node.name };
  }
  if (node.kind === 'subagent') {
    return { kind: 'peek', scope: node.name };
  }
  if (conversationAgent === undefined || node.name === conversationAgent) return { kind: 'none' };
  return { kind: 'trace-agent', agentName: node.name };
}

/** The event a server message carries for the stream panel showing `src`,
 *  or null when the message isn't that panel's. A `stream-ended` frame, which
 *  a client gets in place of a host agent's stream-end trace its scopes don't
 *  cover, is that agent's panel's, as the trace would be; a child's comes as
 *  a `child-event`. */
export function streamEventFor(
  src: StreamSource,
  msg: { type: string; scope?: unknown; childName?: unknown; agentName?: unknown; event?: { type: string; [k: string]: unknown } },
): { type: string; [k: string]: unknown } | null {
  if (msg.type === 'stream-ended') {
    return src.kind === 'trace-agent' && msg.agentName === src.agentName
      ? { type: 'stream-ended', agentName: src.agentName }
      : null;
  }
  const event = msg.event;
  if (!event) return null;
  switch (src.kind) {
    case 'none':
      return null;
    case 'trace-agent':
      return msg.type === 'trace' && event.agentName === src.agentName ? event : null;
    case 'peek':
      return msg.type === 'peek' && msg.scope === src.scope ? event : null;
    case 'child-event-all':
      return msg.type === 'child-event' && msg.childName === src.childName ? event : null;
    case 'child-event-agent':
      return msg.type === 'child-event' && msg.childName === src.childName && event.agentName === src.agentName
        ? event
        : null;
  }
}

/** Whether the page builds and shows the agent trees, given its observer
 *  sign-in state on this connection and the scopes its grant's observer-ack
 *  gave, or null before any. An operator's connection ('none': not signed in
 *  as an observer, either never asked to or welcomed as a full client since)
 *  does. An observer's does when its grant holds what a
 *  tree carries (AGENT_TREE_SCOPES), and keeps that answer while it signs in
 *  again after a reconnect. Before its first grant, and once it can't sign
 *  in ('denied', 'unavailable', where the page shows its sign-in screen), it
 *  doesn't. Otherwise its traces would build nodes whose failed or exhausted
 *  end (ops) or completion (health) it never gets, and an empty tree would
 *  read as no agents running. */
export function treesShownFor(state: string, scopes: readonly string[] | null): boolean {
  if (state === 'none') return true;
  if (state !== 'observer' && state !== 'authing') return false;
  return scopes !== null && AGENT_TREE_SCOPES.every((scope) => scopes.includes(scope));
}

/** How a tool call shows. A loaded result says how the call ended, whatever
 *  status traces the page got: a page without 'ops' never gets tool:failed.
 *  Until it loads, the stream's status says. */
export function toolCallState(
  status: 'running' | 'done' | 'failed' | undefined,
  result: { isError?: boolean } | undefined,
): 'running' | 'done' | 'failed' | 'unknown' {
  if (result) return result.isError ? 'failed' : 'done';
  return status ?? 'unknown';
}
