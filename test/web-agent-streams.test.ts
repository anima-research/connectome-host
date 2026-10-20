/**
 * Where the Web UI page shows each agent's stream (src/web/agent-streams.ts):
 * the main view's streaming message follows the conversation agent alone and
 * ends at every stream end, a turn a tool ended included, while the quiesce
 * re-pull runs at any agent's end. Each other agent's stream has a panel of
 * its own, the host's other framework agents' included.
 */
import { describe, expect, test } from 'bun:test';
import { applyTrace, conversationAgentOf, pickStreamSource, streamEventFor, type TraceViewHooks } from '../src/web/agent-streams.js';
import { STREAM_END_TRACES } from '../src/state/turn-trace.js';

function recorder() {
  const calls: string[] = [];
  const hooks: TraceViewHooks = {
    appendStreamToken: (token, blockType) => { calls.push(`token:${token}:${blockType ?? '-'}`); },
    handleContentBlock: (phase) => { calls.push(`block:${phase}`); },
    appendToolUseBlocks: (list) => { calls.push(`tools:${list.map((c) => c.name).join(',')}`); },
    updateToolStatus: (callId, status) => { calls.push(`tool:${callId}:${status}`); },
    finishStream: () => { calls.push('finish'); },
    onTurnSettled: () => { calls.push('settled'); },
    onOpsAlert: () => { calls.push('alert'); },
    onOperatorAction: () => { calls.push('operator'); },
    requestHostMode: () => { calls.push('host-mode'); },
  };
  return { calls, hooks };
}

describe('the conversation agent', () => {
  test('is the welcome\'s first agent, and none before a welcome names one', () => {
    expect(conversationAgentOf({ agents: [{ name: 'clerk' }, { name: 'subconscious' }] })).toBe('clerk');
    expect(conversationAgentOf({ agents: [] })).toBeUndefined();
    expect(conversationAgentOf(null)).toBeUndefined();
    expect(conversationAgentOf(undefined)).toBeUndefined();
  });
});

describe('the main view', () => {
  for (const end of STREAM_END_TRACES) {
    test(`${end} from the conversation agent ends its streaming message and re-pulls`, () => {
      const { calls, hooks } = recorder();
      applyTrace({ type: end, agentName: 'clerk' }, hooks, 'clerk');
      expect(calls).toEqual(['finish', 'settled']);
    });

    test(`${end} from another agent re-pulls only`, () => {
      const { calls, hooks } = recorder();
      applyTrace({ type: end, agentName: 'spawn-research-1' }, hooks, 'clerk');
      expect(calls).toEqual(['settled']);
    });
  }

  test('another agent\'s stream stays out of the conversation\'s message', () => {
    const { calls, hooks } = recorder();
    const other = { agentName: 'spawn-research-1' };
    applyTrace({ type: 'inference:tokens', content: 'found it', blockType: 'text', ...other }, hooks, 'clerk');
    applyTrace({ type: 'inference:content_block', phase: 'block_complete', ...other }, hooks, 'clerk');
    applyTrace({ type: 'inference:tool_calls_yielded', calls: [{ id: 't9', name: 'web_search' }], ...other }, hooks, 'clerk');
    expect(calls).toEqual([]);
  });

  test('the conversation agent\'s stream goes into it', () => {
    const { calls, hooks } = recorder();
    applyTrace({ type: 'inference:tokens', content: 'hi', blockType: 'text', agentName: 'clerk' }, hooks, 'clerk');
    applyTrace({ type: 'inference:content_block', phase: 'block_complete', agentName: 'clerk' }, hooks, 'clerk');
    applyTrace({ type: 'inference:tool_calls_yielded', calls: [{ id: 't1', name: 'skip_reply' }], agentName: 'clerk' }, hooks, 'clerk');
    applyTrace({ type: 'inference:tool_calls_yielded', calls: [], agentName: 'clerk' }, hooks, 'clerk');
    expect(calls).toEqual(['token:hi:text', 'block:block_complete', 'tools:skip_reply']);
  });

  test('before a welcome names the agent, and for a trace naming none, everything is the view\'s', () => {
    const { calls, hooks } = recorder();
    applyTrace({ type: 'inference:tokens', content: 'a', agentName: 'spawn-research-1' }, hooks, undefined);
    applyTrace({ type: 'inference:tokens', content: 'b' }, hooks, 'clerk');
    applyTrace({ type: 'inference:turn_ended', agentName: 'spawn-research-1' }, hooks, undefined);
    expect(calls).toEqual(['token:a:-', 'token:b:-', 'finish', 'settled']);
  });
});

describe('the panel for an agent\'s node', () => {
  test('the conversation agent\'s stream is the main view\'s, and another framework agent\'s has its own', () => {
    expect(pickStreamSource({ name: 'clerk', kind: 'framework' }, undefined, 'clerk')).toEqual({ kind: 'none' });
    expect(pickStreamSource({ name: 'clerk-subconscious', kind: 'framework' }, undefined, 'clerk'))
      .toEqual({ kind: 'trace-agent', agentName: 'clerk-subconscious' });
  });

  test('a subagent, a fleet child\'s agent, and a page that has no welcome yet keep their panels', () => {
    expect(pickStreamSource({ name: 'research', kind: 'subagent' }, undefined, 'clerk')).toEqual({ kind: 'peek', scope: 'research' });
    expect(pickStreamSource({ name: 'clerk', kind: 'framework' }, 'miner', 'clerk'))
      .toEqual({ kind: 'child-event-agent', childName: 'miner', agentName: 'clerk' });
    expect(pickStreamSource({ name: 'other', kind: 'framework' }, undefined, undefined)).toEqual({ kind: 'none' });
  });

  test('each panel takes only its own events', () => {
    const tokens = { type: 'inference:tokens', agentName: 'clerk-subconscious', content: 'hm' };
    const trace = { type: 'trace', event: tokens };
    expect(streamEventFor({ kind: 'trace-agent', agentName: 'clerk-subconscious' }, trace)).toBe(tokens);
    expect(streamEventFor({ kind: 'trace-agent', agentName: 'clerk' }, trace)).toBeNull();
    expect(streamEventFor({ kind: 'trace-agent', agentName: 'clerk-subconscious' }, { type: 'child-event', childName: 'x', event: tokens })).toBeNull();
    expect(streamEventFor({ kind: 'none' }, trace)).toBeNull();
    const peek = { type: 'peek', scope: 'research', event: { type: 'tokens', content: 'a' } };
    expect(streamEventFor({ kind: 'peek', scope: 'research' }, peek)).toBe(peek.event);
    expect(streamEventFor({ kind: 'peek', scope: 'other' }, peek)).toBeNull();
    const child = { type: 'child-event', childName: 'miner', event: { type: 'inference:tokens', agentName: 'clerk', content: 'b' } };
    expect(streamEventFor({ kind: 'child-event-all', childName: 'miner' }, child)).toBe(child.event);
    expect(streamEventFor({ kind: 'child-event-agent', childName: 'miner', agentName: 'clerk' }, child)).toBe(child.event);
    expect(streamEventFor({ kind: 'child-event-agent', childName: 'miner', agentName: 'other' }, child)).toBeNull();
    expect(streamEventFor({ kind: 'child-event-all', childName: 'other' }, child)).toBeNull();
  });
});

describe('the other traces the page reads', () => {
  test('tool status by call id, for any agent', () => {
    const { calls, hooks } = recorder();
    applyTrace({ type: 'tool:completed', callId: 't9', durationMs: 4 }, hooks, 'clerk');
    applyTrace({ type: 'tool:failed', callId: 't8' }, hooks, 'clerk');
    expect(calls).toEqual(['tool:t9:done', 'tool:t8:failed']);
  });

  test('alerts, operator actions and host serving state', () => {
    const { calls, hooks } = recorder();
    applyTrace({ type: 'ops:alert', kind: 'hard-down' }, hooks, 'clerk');
    applyTrace({ type: 'operator:action' }, hooks, 'clerk');
    applyTrace({ type: 'host:quiesce' }, hooks, 'clerk');
    applyTrace({ type: 'inference:started', agentName: 'clerk' }, hooks, 'clerk');
    expect(calls).toEqual(['alert', 'operator', 'host-mode']);
  });
});
