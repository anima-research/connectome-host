import { STREAM_END_TRACES } from '../state/turn-trace.js';
import type { AgentNode } from '../state/agent-tree-reducer.js';
import { AGENT_TREE_SCOPES } from './protocol.js';

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
