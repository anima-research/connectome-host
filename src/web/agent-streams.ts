import { STREAM_END_TRACES } from '../state/turn-trace.js';
import type { AgentNode } from '../state/agent-tree-reducer.js';
import { AGENT_TREE_SCOPES, isChildScope, type UndoneMarksMessage } from './protocol.js';

export interface TraceViewHooks {
  appendStreamToken(token: string, blockType?: string): void;
  handleContentBlock(phase: string): void;
  appendToolUseBlocks(calls: Array<{ id: string; name: string; input?: unknown }>): void;
  updateToolStatus(callId: string, status: 'done' | 'failed', durationMs?: number): void;
  finishStream(): void;
  onTurnSettled(): void;
  onOpsAlert(event: { [k: string]: unknown }): void;
  onOperatorAction(): void;
  requestHostMode(): void;
}

export function conversationAgentOf(
  welcome: { agents: ReadonlyArray<{ name: string }> } | null | undefined,
): string | undefined {
  return welcome?.agents[0]?.name;
}

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
  if (e.type.startsWith('host:')) hooks.requestHostMode();
}

/** The panels the page shows: their scope ('local' or a fleet child's
 *  name), and the agent they answer for, which the page asks for by scope
 *  alone: the conversation agent locally, and for a fleet child the agent
 *  its latest pins or settings answer named, undefined before one has. */
export interface ShownPanels {
  scope: string;
  agent: string | undefined;
}

/** What WindowFrames does with a frame that moves an agent's window. */
export interface WindowFrameHooks {
  /** Mark the transcript's rows as an undone-marks frame says. */
  applyUndoneMarks(marks: UndoneMarksMessage): void;
  /** The panels built from the shown agent's window (Context's makeup and
   *  coverage, the compiled context, the pins, whose candidates leave an
   *  undone row out) read it again. */
  readPanels(): void;
  /** Ask a fleet child which agent its panels answer for (its pins and
   *  settings, which name it): one of its agents other than the one they
   *  named moved its window. */
  askPanelsAgent(): void;
}

/**
 * The frames that move an agent's window, agent-framework #291's undo, redo
 * and shed (DQ-4), each taken in order. The transcript shows the record,
 * which keeps the rows, and an `undone-marks` frame marks them. The shown
 * panels read the window again when the frame is for the agent they answer
 * for, in their scope, once:
 *
 * - locally, at the conversation agent's `window:undone` trace (an undo or a
 *   redo), and at an undone-marks frame for it that doesn't come right after
 *   that trace (a shed's, which has no trace): the host sends one after each
 *   such trace, and both reading them would read each twice (a makeup read
 *   posts the window to count_tokens). Nor does the one the host sends right
 *   after each welcome, which marks the rows the page kept and moved no
 *   window;
 * - in any scope, at the welcome of a socket that follows one that closed
 *   (disconnected): the frames sent while the page was away are missed, so
 *   a window moved then (another client's undo, say) is read again once.
 *   The page's first welcome reads nothing, as no panel has read yet, and
 *   nor does one sent again on the same socket;
 * - for a fleet child, at a `child-event` of its `window:undone` or its
 *   shed (`presentation:retracted`, reason `shed`): for the agent the child's
 *   panels named, or for any of its agents before they have named one. For
 *   another of its agents they ask which agent they answer for, since the
 *   child may have restarted under the same scope with that one, and read
 *   again once an answer names another than before (`named`).
 *
 * Another resident's window, a subagent's, and a scope the panels don't
 * show read nothing.
 */
export class WindowFrames {
  private tracedJustBefore: string | undefined;
  private welcomedJustBefore = false;
  private reconnecting = false;

  /** The page's socket closed, and the page will connect again. */
  disconnected(): void {
    this.reconnecting = true;
  }

  take(
    msg: { type: string; [k: string]: unknown },
    shown: ShownPanels,
    hooks: WindowFrameHooks,
  ): void {
    const traced = this.tracedJustBefore;
    const welcomed = this.welcomedJustBefore;
    this.tracedJustBefore = undefined;
    this.welcomedJustBefore = msg.type === 'welcome';
    const local = !isChildScope(shown.scope);
    if (msg.type === 'welcome') {
      if (this.reconnecting) hooks.readPanels();
      this.reconnecting = false;
      return;
    }
    if (msg.type === 'trace') {
      const event = msg.event as { type?: unknown; agentName?: unknown } | undefined;
      if (event?.type !== 'window:undone' || typeof event.agentName !== 'string') return;
      this.tracedJustBefore = event.agentName;
      if (local && event.agentName === shown.agent) hooks.readPanels();
      return;
    }
    if (msg.type === 'undone-marks') {
      const marks = msg as unknown as UndoneMarksMessage;
      hooks.applyUndoneMarks(marks);
      if (local && marks.agent === shown.agent && marks.agent !== traced && !welcomed) hooks.readPanels();
      return;
    }
    if (msg.type === 'child-event' && !local && msg.childName === shown.scope) {
      const event = msg.event as { type?: unknown; agentName?: unknown; reason?: unknown } | undefined;
      const moved = event?.type === 'window:undone' || (event?.type === 'presentation:retracted' && event.reason === 'shed');
      if (!moved) return;
      if (shown.agent === undefined || event.agentName === shown.agent) hooks.readPanels();
      else hooks.askPanelsAgent();
    }
  }

  /** An answer that names the panels' agent (pins, settings) came: `before`
   *  and `after` are the panels as it found and left them. When it names
   *  another agent than they named before, in the same scope, a fleet child
   *  that restarted with another agent say, they read again. */
  named(before: ShownPanels, after: ShownPanels, hooks: Pick<WindowFrameHooks, 'readPanels'>): void {
    if (before.scope !== after.scope || before.agent === undefined || after.agent === undefined) return;
    if (before.agent !== after.agent) hooks.readPanels();
  }
}

export type StreamSource =
  | { kind: 'none' }
  | { kind: 'trace-agent'; agentName: string }
  | { kind: 'peek'; scope: string }
  | { kind: 'child-event-all'; childName: string }
  | { kind: 'child-event-agent'; childName: string; agentName: string };

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

export function treesShownFor(state: string, scopes: readonly string[] | null): boolean {
  if (state === 'none') return true;
  if (state !== 'observer' && state !== 'authing') return false;
  return scopes !== null && AGENT_TREE_SCOPES.every((scope) => scopes.includes(scope));
}

export function toolCallState(
  status: 'running' | 'done' | 'failed' | undefined,
  result: { isError?: boolean } | undefined,
): 'running' | 'done' | 'failed' | 'unknown' {
  if (result) return result.isError ? 'failed' : 'done';
  return status ?? 'unknown';
}
