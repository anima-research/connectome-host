/**
 * Unit tests for AgentTreeReducer.
 *
 * Strategy: feed representative trace event sequences and assert the resulting
 * tree state matches the canonical fold currently scattered across tui.ts and
 * subagent-module.ts. These streams are hand-built rather than recorded so the
 * test stays stable across framework changes — but the event shapes mirror
 * agent-framework/src/types/trace.ts exactly.
 */
import { describe, test, expect } from 'bun:test';
import { AgentTreeReducer } from '../src/state/agent-tree-reducer.js';

function ts(offset: number): number {
  return 1_700_000_000_000 + offset;
}

describe('AgentTreeReducer', () => {
  test('seed creates framework nodes with zero state', () => {
    const r = new AgentTreeReducer();
    r.seedFrameworkAgents(['commander', 'observer']);
    const nodes = r.getNodes();
    expect(nodes.length).toBe(2);
    const commander = r.getNode('commander');
    expect(commander).toBeDefined();
    expect(commander!.kind).toBe('framework');
    expect(commander!.phase).toBe('idle');
    expect(commander!.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(commander!.toolCallsCount).toBe(0);
    expect(commander!.parent).toBeUndefined();
  });

  test('phase transitions follow the canonical mapping', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: ts(0) });
    expect(r.getNode('a')!.phase).toBe('sending');

    r.applyEvent({ type: 'inference:tokens', agentName: 'a', content: 'hi', timestamp: ts(1) });
    expect(r.getNode('a')!.phase).toBe('streaming');

    r.applyEvent({
      type: 'inference:tool_calls_yielded',
      agentName: 'a',
      calls: [{ id: 'c1', name: 'files--read', input: {} }],
      timestamp: ts(2),
    });
    expect(r.getNode('a')!.phase).toBe('invoking');

    r.applyEvent({ type: 'tool:started', callId: 'c1', tool: 'files--read', module: 'files', timestamp: ts(3) });
    expect(r.getNode('a')!.phase).toBe('executing');
    expect(r.getNode('a')!.toolCallsCount).toBe(1);

    r.applyEvent({ type: 'tool:completed', callId: 'c1', tool: 'files--read', module: 'files', durationMs: 5, timestamp: ts(4) });
    // tool:completed does NOT transition phase (matches tui.ts behavior)
    expect(r.getNode('a')!.phase).toBe('executing');

    r.applyEvent({ type: 'inference:completed', agentName: 'a', durationMs: 10, timestamp: ts(5) });
    expect(r.getNode('a')!.phase).toBe('done');
  });

  test('inference:failed sets phase=failed and status=failed', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: ts(0) });
    r.applyEvent({ type: 'inference:failed', agentName: 'a', error: 'boom', timestamp: ts(1) });
    const node = r.getNode('a')!;
    expect(node.phase).toBe('failed');
    expect(node.status).toBe('failed');
    expect(node.completedAt).toBe(ts(1));
  });

  test('input tokens overwrite (current context size); output/cache accumulate', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({
      type: 'inference:usage',
      agentName: 'a',
      tokenUsage: { input: 1000, output: 50, cacheRead: 200, cacheCreation: 100 },
      timestamp: ts(0),
    });
    r.applyEvent({
      type: 'inference:usage',
      agentName: 'a',
      tokenUsage: { input: 1500, output: 80, cacheRead: 300, cacheCreation: 50 },
      timestamp: ts(1),
    });
    const tokens = r.getNode('a')!.tokens;
    expect(tokens.input).toBe(1500);          // overwrite (current context size)
    expect(tokens.output).toBe(130);          // accumulated
    expect(tokens.cacheRead).toBe(500);       // accumulated
    expect(tokens.cacheWrite).toBe(150);      // accumulated
  });

  test('inference:completed final tokenUsage applies same accumulation rules', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({
      type: 'inference:usage',
      agentName: 'a',
      tokenUsage: { input: 500, output: 20, cacheRead: 0, cacheCreation: 0 },
      timestamp: ts(0),
    });
    r.applyEvent({
      type: 'inference:completed',
      agentName: 'a',
      durationMs: 100,
      tokenUsage: { input: 700, output: 30, cacheRead: 50, cacheCreation: 10 },
      timestamp: ts(1),
    });
    const tokens = r.getNode('a')!.tokens;
    expect(tokens.input).toBe(700);
    expect(tokens.output).toBe(50);
    expect(tokens.cacheRead).toBe(50);
    expect(tokens.cacheWrite).toBe(10);
  });

  test('subagent--spawn tool call creates a child node with parent edge', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({
      type: 'inference:tool_calls_yielded',
      agentName: 'commander',
      calls: [{
        id: 'c1',
        name: 'subagent--spawn',
        input: { name: 'researcher', task: 'investigate X' },
      }],
      timestamp: ts(0),
    });
    const child = r.getNode('researcher');
    expect(child).toBeDefined();
    expect(child!.kind).toBe('subagent');
    expect(child!.subagentType).toBe('spawn');
    expect(child!.task).toBe('investigate X');
    expect(child!.parent).toBe('commander');
    expect(r.getChildren('commander').map(n => n.name)).toContain('researcher');
  });

  test('subagent--fork tool call records type=fork', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({
      type: 'inference:tool_calls_yielded',
      agentName: 'commander',
      calls: [{
        id: 'c1',
        name: 'subagent--fork',
        input: { name: 'side-quest', task: 'try a different approach' },
      }],
      timestamp: ts(0),
    });
    expect(r.getNode('side-quest')!.subagentType).toBe('fork');
  });

  test('fleet--spawn tool call creates a framework-kind child', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({
      type: 'inference:tool_calls_yielded',
      agentName: 'conductor',
      calls: [{
        id: 'c1',
        name: 'fleet--spawn',
        input: { name: 'miner-1', recipe: 'knowledge-miner.json' },
      }],
      timestamp: ts(0),
    });
    const child = r.getNode('miner-1');
    expect(child).toBeDefined();
    expect(child!.kind).toBe('framework');
    expect(child!.parent).toBe('conductor');
  });

  test('tool events without a known callId are dropped silently', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'tool:started', callId: 'unknown-id', tool: 'x', module: 'y', timestamp: ts(0) });
    expect(r.getNodes().length).toBe(0);
  });

  test('tool events route to the agent that yielded the call', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({
      type: 'inference:tool_calls_yielded',
      agentName: 'a',
      calls: [{ id: 'c1', name: 'x', input: {} }],
      timestamp: ts(0),
    });
    r.applyEvent({
      type: 'inference:tool_calls_yielded',
      agentName: 'b',
      calls: [{ id: 'c2', name: 'y', input: {} }],
      timestamp: ts(1),
    });
    r.applyEvent({ type: 'tool:started', callId: 'c1', tool: 'x', module: 'm', timestamp: ts(2) });
    r.applyEvent({ type: 'tool:started', callId: 'c2', tool: 'y', module: 'm', timestamp: ts(3) });
    r.applyEvent({ type: 'tool:started', callId: 'c2', tool: 'y', module: 'm', timestamp: ts(4) });
    expect(r.getNode('a')!.toolCallsCount).toBe(1);
    expect(r.getNode('b')!.toolCallsCount).toBe(2);
  });

  test('applySnapshot replaces all state', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'old-agent', timestamp: ts(0) });
    expect(r.getNode('old-agent')).toBeDefined();

    r.applySnapshot({
      asOfTs: ts(100),
      nodes: [{
        name: 'new-agent',
        kind: 'framework',
        status: 'running',
        phase: 'streaming',
        tokens: { input: 5000, output: 200, cacheRead: 100, cacheWrite: 50 },
        toolCallsCount: 3,
        findingsCount: 0,
      }],
      callIdIndex: { 'pre-existing-call': 'new-agent' },
    });
    expect(r.getNode('old-agent')).toBeUndefined();
    const recovered = r.getNode('new-agent')!;
    expect(recovered.tokens.input).toBe(5000);
    expect(recovered.toolCallsCount).toBe(3);

    // Tool events for callIds in the snapshot's callIdIndex should still route correctly.
    r.applyEvent({ type: 'tool:started', callId: 'pre-existing-call', tool: 'x', module: 'm', timestamp: ts(101) });
    expect(r.getNode('new-agent')!.toolCallsCount).toBe(4);
  });

  test('applySnapshot is deep-copy safe (mutating returned nodes does not affect reducer)', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: ts(0) });
    r.applyEvent({
      type: 'inference:usage',
      agentName: 'a',
      tokenUsage: { input: 100, output: 10 },
      timestamp: ts(1),
    });
    const snap = r.getSnapshot();
    snap.nodes[0]!.tokens.input = 999;
    snap.nodes[0]!.toolCallsCount = 999;
    expect(r.getNode('a')!.tokens.input).toBe(100);
    expect(r.getNode('a')!.toolCallsCount).toBe(0);
  });

  test('reset clears everything', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: ts(0) });
    r.reset();
    expect(r.getNodes().length).toBe(0);
  });

  test('getRoots returns parentless nodes only', () => {
    const r = new AgentTreeReducer();
    r.seedFrameworkAgents(['commander']);
    r.applyEvent({
      type: 'inference:tool_calls_yielded',
      agentName: 'commander',
      calls: [{
        id: 'c1',
        name: 'subagent--spawn',
        input: { name: 'child', task: 't' },
      }],
      timestamp: ts(0),
    });
    const roots = r.getRoots();
    expect(roots.map(n => n.name)).toEqual(['commander']);
  });

  test('lazy node creation on first event for an unseen agent', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'lazy-agent', timestamp: ts(0) });
    const node = r.getNode('lazy-agent');
    expect(node).toBeDefined();
    expect(node!.kind).toBe('framework');
    expect(node!.startedAt).toBe(ts(0));
  });

  test('startedAt is set on first inference, not overwritten on subsequent', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: ts(0) });
    r.applyEvent({ type: 'inference:completed', agentName: 'a', durationMs: 5, timestamp: ts(10) });
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: ts(20) });
    expect(r.getNode('a')!.startedAt).toBe(ts(0));
  });

  test('lastEventAt tracks the most recent event timestamp', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: ts(0) });
    r.applyEvent({ type: 'inference:tokens', agentName: 'a', content: 'x', timestamp: ts(50) });
    expect(r.getNode('a')!.lastEventAt).toBe(ts(50));
  });

  test('unknown event types are ignored without affecting state', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: ts(0) });
    const before = r.getNode('a')!;
    r.applyEvent({ type: 'gate:decision', eventType: 'foo', matchedPolicy: null, trigger: false, behavior: 'allow' } as never);
    r.applyEvent({ type: 'process:received', processEvent: { type: 'whatever' } } as never);
    r.applyEvent({ type: 'message:added', messageId: 'm1', source: 's' } as never);
    const after = r.getNode('a')!;
    expect(after).toEqual(before);
  });
});
