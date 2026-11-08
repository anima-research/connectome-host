import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  applyStreamEnded, applyTrace, conversationAgentOf, pickStreamSource, streamEventFor, toolCallState, treesShownFor,
  WindowFrames, type ShownPanels, type TraceViewHooks,
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

  test("a stream-ended frame is its agent's panel's, as the stream-end trace would be", () => {
    const ended = { type: 'stream-ended', agentName: 'clerk-subconscious' };
    expect(streamEventFor({ kind: 'trace-agent', agentName: 'clerk-subconscious' }, ended)).toEqual(ended);
    expect(streamEventFor({ kind: 'trace-agent', agentName: 'clerk' }, ended)).toBeNull();
    expect(streamEventFor({ kind: 'child-event-all', childName: 'miner' }, ended)).toBeNull();
    expect(streamEventFor({ kind: 'peek', scope: 'research' }, ended)).toBeNull();
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

  test("an undo's or a redo's trace is no stream's and no host state's", () => {
    const { calls, hooks } = recorder();
    applyTrace({ type: 'window:undone', agentName: 'clerk', retracted: 2 }, hooks, 'clerk');
    expect(calls).toEqual([]);
  });
});

// DQ-4: an undo, a redo or a shed on a window reads the panels built from it
// again. The page's handleServerMessage hands WindowFrames every frame.
describe("the frames that move a window, and the panels' reads", () => {
  const undone = (agentName: string) => ({ type: 'trace', event: { type: 'window:undone', agentName, retracted: 1 } });
  const marks = (agent: string, ids: string[] = []) => ({ type: 'undone-marks', agent, fromIndex: 0, undone: ids });
  const child = (childName: string, event: Record<string, unknown>) => ({ type: 'child-event', childName, event });
  const local: ShownPanels = { scope: 'local', agent: 'clerk' };
  function frames() {
    const calls: string[] = [];
    const taker = new WindowFrames();
    const hooks = {
      applyUndoneMarks: (m: { agent: string; undone: string[] }) => { calls.push(`marks:${m.agent}:${m.undone.join(',')}`); },
      readPanels: () => { calls.push('read'); },
      askPanelsAgent: () => { calls.push('ask'); },
    };
    const take = (msg: { type: string; [k: string]: unknown }, shown: ShownPanels = local) => taker.take(msg, shown, hooks);
    const named = (before: ShownPanels, after: ShownPanels) => taker.named(before, after, hooks);
    const disconnected = () => taker.disconnected();
    return { calls, take, named, disconnected };
  }

  // Host #485 bot review wave 2, finding 20: the host sends an undone-marks
  // frame right after the conversation agent's window:undone trace, and both
  // read the window's panels again, so an undo read each twice.
  test("an undo reads them once: at its trace, and not at the marks frame right after it, which marks the transcript", () => {
    const { calls, take } = frames();
    take(undone('clerk'));
    take(marks('clerk', ['a1']));
    expect(calls).toEqual(['read', 'marks:clerk:a1']);
  });

  test("a shed's marks frame, which has no trace, reads them, and so does a later one after an undo's", () => {
    const { calls, take } = frames();
    take(marks('clerk', ['x3']));
    take(undone('clerk'));
    take(marks('clerk'));
    take(marks('clerk', ['x4']));
    expect(calls).toEqual(['marks:clerk:x3', 'read', 'read', 'marks:clerk:', 'marks:clerk:x4', 'read']);
  });

  // The host sends the record's marks after each welcome (#485 bot review
  // 5, finding 20): they mark the transcript and read nothing, since nothing
  // moved the window then.
  test("the marks frame right after a welcome marks the transcript and reads nothing, and a later one still reads", () => {
    const { calls, take } = frames();
    take({ type: 'welcome' });
    take(marks('clerk', ['a1']));
    expect(calls).toEqual(['marks:clerk:a1']);
    take(marks('clerk', ['x3']));
    expect(calls).toEqual(['marks:clerk:a1', 'marks:clerk:x3', 'read']);
  });

  // Host #485 bot review wave 6, finding 26: neither the welcome nor the
  // marks frame after it read the panels, so a window moved while the page
  // was disconnected (another client's undo) left them stale once it
  // reconnected: the frames that would have read them were missed.
  test("a reconnect's welcome reads them once, in any scope, and the marks frame right after it doesn't; the page's first welcome and another on the same socket read nothing", () => {
    const { calls, take, disconnected } = frames();
    take({ type: 'welcome' });
    take(marks('clerk'));
    expect(calls).toEqual(['marks:clerk:']);
    disconnected();
    disconnected();
    take({ type: 'welcome' });
    take(marks('clerk', ['a1']));
    expect(calls).toEqual(['marks:clerk:', 'read', 'marks:clerk:a1']);
    take({ type: 'welcome' });
    take(marks('clerk', ['a1']));
    expect(calls).toEqual(['marks:clerk:', 'read', 'marks:clerk:a1', 'marks:clerk:a1']);
    disconnected();
    take({ type: 'welcome' }, { scope: 'miner', agent: 'digger' });
    expect(calls.at(-1)).toBe('read');
    const page = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8');
    expect(page).toMatch(/if \(wire\.status\(\) === 'reconnecting'\) windowFrames\.disconnected\(\)/);
  });

  test("a marks frame with another frame between its agent's trace and it reads them", () => {
    const { calls, take } = frames();
    take(undone('clerk'));
    take({ type: 'usage' });
    take(marks('clerk'));
    expect(calls).toEqual(['read', 'marks:clerk:', 'read']);
  });

  // nissa's second reading of the #485 wave-2 answer, point 2: the panels ask
  // by scope alone, so they show the conversation agent's window locally,
  // and another resident's undo read them again for nothing.
  test("another resident's or a subagent's undo reads nothing", () => {
    const { calls, take } = frames();
    take(undone('mira'));
    take(undone('spawn-research-1'));
    expect(calls).toEqual([]);
  });

  // Host #485 bot review wave 3, finding 18: a fleet child's undo or shed
  // reached the page only as a child-event, which read nothing, so the
  // child's panels stayed stale.
  test("a fleet child's undo or shed reads its panels, for the agent they answer for", () => {
    const { calls, take } = frames();
    const miner: ShownPanels = { scope: 'miner', agent: 'digger' };
    take(child('miner', { type: 'window:undone', agentName: 'digger', retracted: 1 }), miner);
    take(child('miner', { type: 'presentation:retracted', agentName: 'digger', messageIds: ['r1'], reason: 'shed' }), miner);
    expect(calls).toEqual(['read', 'read']);
    take(child('miner', { type: 'presentation:retracted', agentName: 'digger', messageIds: ['r2'], reason: 'hide' }), miner);
    take(child('smelter', { type: 'window:undone', agentName: 'digger', retracted: 1 }), miner);
    take(child('miner', { type: 'inference:started', agentName: 'digger' }), miner);
    expect(calls).toEqual(['read', 'read']);
  });

  // Host #485 bot review wave 4, finding 15: the child's panels named the
  // agent of their last pins or settings answer, so once the child restarted
  // under the same scope with another agent, that agent's undo or shed read
  // nothing until the panels were fetched again.
  test("a fleet child's undo or shed for another agent than its panels named asks which agent they answer for, and reads them only once an answer names another", () => {
    const { calls, take, named } = frames();
    const miner: ShownPanels = { scope: 'miner', agent: 'digger' };
    take(child('miner', { type: 'window:undone', agentName: 'sifter', retracted: 1 }), miner);
    take(child('miner', { type: 'presentation:retracted', agentName: 'sifter', messageIds: ['r1'], reason: 'shed' }), miner);
    expect(calls).toEqual(['ask', 'ask']);
    // The child still answers for digger (sifter is another of its agents):
    named(miner, miner);
    expect(calls).toEqual(['ask', 'ask']);
    // It restarted with sifter:
    named(miner, { scope: 'miner', agent: 'sifter' });
    expect(calls).toEqual(['ask', 'ask', 'read']);
  });

  test("an answer that names the panels' first agent, or another scope's, reads nothing", () => {
    const { calls, named } = frames();
    named({ scope: 'miner', agent: undefined }, { scope: 'miner', agent: 'digger' });
    named({ scope: 'miner', agent: 'digger' }, { scope: 'smelter', agent: 'sifter' });
    named({ scope: 'miner', agent: 'digger' }, { scope: 'miner', agent: undefined });
    expect(calls).toEqual([]);
  });

  test("before a fleet child's panels name their agent, any of its agents' undo reads them", () => {
    const { calls, take } = frames();
    take(child('miner', { type: 'window:undone', agentName: 'sifter', retracted: 1 }), { scope: 'miner', agent: undefined });
    expect(calls).toEqual(['read']);
  });

  test("a frame for a scope the panels don't show reads nothing, and still marks the transcript", () => {
    const { calls, take } = frames();
    const miner: ShownPanels = { scope: 'miner', agent: 'clerk' };
    take(undone('clerk'), miner);
    take(marks('clerk', ['a1']), miner);
    take(child('miner', { type: 'window:undone', agentName: 'clerk', retracted: 1 }), local);
    expect(calls).toEqual(['marks:clerk:a1']);
  });

  test('and no other frame does anything', () => {
    const { calls, take } = frames();
    take({ type: 'trace', event: { type: 'inference:started', agentName: 'clerk' } });
    take({ type: 'trace', event: { type: 'presentation:retracted', agentName: 'clerk', reason: 'shed' } });
    take({ type: 'welcome' });
    expect(calls).toEqual([]);
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
