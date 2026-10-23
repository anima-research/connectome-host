/**
 * Where the Web UI page shows each agent's stream (src/web/agent-streams.ts):
 * the main view's streaming message follows the conversation agent alone and
 * ends at every stream end, a turn a tool ended included, while the quiesce
 * re-pull runs at any agent's end. Each other agent's stream has a panel of
 * its own, the host's other framework agents' included. What a page builds
 * from frames follows its grant: the tree, and a tool call's state.
 */
import { describe, expect, test } from 'bun:test';
import {
  applyStreamEnded, applyTrace, conversationAgentOf, pickStreamSource, streamEventFor, toolCallState, treesShownFor,
  type TraceViewHooks,
} from '../src/web/agent-streams.js';
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

  // The frame an observer without the scopes a stream-end trace needs gets
  // in its place (src/modules/web-ui-observers.ts, streamEndedFor).
  test('a stream-ended frame ends the stream as its trace would: the conversation agent\'s message, another agent\'s re-pull only, and one naming no agent the view\'s', () => {
    const { calls, hooks } = recorder();
    applyStreamEnded('clerk', hooks, 'clerk');
    applyStreamEnded('spawn-research-1', hooks, 'clerk');
    applyStreamEnded(undefined, hooks, 'clerk');
    expect(calls).toEqual(['finish', 'settled', 'settled', 'finish', 'settled']);
  });

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

  // What a client without the scopes of a host agent's stream-end trace
  // gets in its place (streamEndedFor), so the panel's last line shows.
  test("a stream-ended frame is its agent's panel's, as the stream-end trace would be", () => {
    const ended = { type: 'stream-ended', agentName: 'clerk-subconscious' };
    expect(streamEventFor({ kind: 'trace-agent', agentName: 'clerk-subconscious' }, ended)).toEqual(ended);
    expect(streamEventFor({ kind: 'trace-agent', agentName: 'clerk' }, ended)).toBeNull();
    expect(streamEventFor({ kind: 'child-event-all', childName: 'miner' }, ended)).toBeNull();
    expect(streamEventFor({ kind: 'peek', scope: 'research' }, ended)).toBeNull();
    // A child's comes as a child-event, which its panels take like any other.
    const child = { type: 'child-event', childName: 'miner', event: { type: 'stream-ended', agentName: 'clerk' } };
    expect(streamEventFor({ kind: 'child-event-agent', childName: 'miner', agentName: 'clerk' }, child)).toBe(child.event);
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

describe('what a page builds from frames follows its grant', () => {
  const trees = ['messages', 'thinking', 'tools', 'health', 'ops'];

  test("an operator's page shows the trees, and an observer's only when its grant holds every scope a tree needs", () => {
    expect(treesShownFor('none', null)).toBe(true);
    expect(treesShownFor('observer', trees)).toBe(true);
    expect(treesShownFor('observer', [...trees, 'debug'])).toBe(true);
    for (const missing of trees) {
      expect(treesShownFor('observer', trees.filter((scope) => scope !== missing))).toBe(false);
    }
    expect(treesShownFor('observer', ['messages'])).toBe(false);
  });

  test('a page signing in as an observer shows no trees before its grant is known, and keeps its grant\'s answer while it signs in again', () => {
    for (const state of ['authing', 'denied', 'unavailable']) expect(treesShownFor(state, null)).toBe(false);
    expect(treesShownFor('authing', ['messages'])).toBe(false);
    expect(treesShownFor('authing', trees)).toBe(true);
  });

  test("a page that can't sign in shows no trees, whatever grant it held before", () => {
    for (const state of ['denied', 'unavailable']) expect(treesShownFor(state, trees)).toBe(false);
  });

  test("a tool call shows how its loaded result ended, whatever status the stream gave it, and the stream's status until then", () => {
    for (const status of ['running', 'done', 'failed', undefined] as const) {
      expect(toolCallState(status, { isError: true })).toBe('failed');
      expect(toolCallState(status, {})).toBe('done');
      expect(toolCallState(status, { isError: false })).toBe('done');
    }
    expect(toolCallState('running', undefined)).toBe('running');
    expect(toolCallState('failed', undefined)).toBe('failed');
    expect(toolCallState('done', undefined)).toBe('done');
    expect(toolCallState(undefined, undefined)).toBe('unknown');
  });
});
