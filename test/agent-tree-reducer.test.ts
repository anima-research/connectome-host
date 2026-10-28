import { describe, test, expect } from 'bun:test';
import { AgentTreeReducer, REDUCER_REQUIRED_EVENTS } from '../src/state/agent-tree-reducer.js';

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

  test('dendrite:agent-created hangs a derived agent under the agent it was made from, as a framework node', () => {
    const r = new AgentTreeReducer();
    r.seedFrameworkAgents(['scout', 'Subconscious']);
    r.applyEvent({
      type: 'dendrite:agent-created', agentName: 'scout.reader-3', kind: 'task-fork', model: 'm', incarnation: 1,
      lifetime: { kind: 'task', idleTimeoutMs: 600_000 }, spawnedBy: 'scout',
      inherit: { from: 'scout', mode: 'shared' }, timestamp: ts(0),
    });
    const fork = r.getNode('scout.reader-3')!;
    // Not a SubagentModule subagent: the panel streams its own traces and offers no subagent stop.
    expect(fork.kind).toBe('framework');
    expect(fork.subagentType).toBeUndefined();
    expect(fork.parent).toBe('scout');
    expect(fork.startedAt).toBe(ts(0));
    expect(r.getChildren('scout').map(n => n.name)).toEqual(['scout.reader-3']);

    // The persistent reader is spawned by the resident it serves, and was seeded already: it nests, keeping its node.
    r.applyEvent({
      type: 'dendrite:agent-created', agentName: 'Subconscious', kind: 'subconscious', incarnation: 1,
      lifetime: { kind: 'persistent' }, spawnedBy: 'scout', timestamp: ts(1),
    });
    expect(r.getNode('Subconscious')!.parent).toBe('scout');
    expect(r.getNodes()).toHaveLength(3);

    // A resident announces itself with no parent: top-level, as seeded.
    r.applyEvent({
      type: 'dendrite:agent-created', agentName: 'scout', kind: 'resident', incarnation: 2,
      lifetime: { kind: 'persistent' }, timestamp: ts(2),
    });
    expect(r.getNode('scout')!.parent).toBeUndefined();
    expect(r.getRoots().map(n => n.name)).toEqual(['scout']);
    for (const type of ['dendrite:agent-created', 'dendrite:agent-orphaned', 'dendrite:agent-reparented', 'dendrite:agent-ended', 'dendrite:agent-interrupted']) {
      expect(REDUCER_REQUIRED_EVENTS).toContain(type);
    }
  });

  test('an orphaned agent is parentless until reparented; reparenting moves it', () => {
    const r = new AgentTreeReducer();
    r.seedFrameworkAgents(['scout', 'archivist']);
    r.applyEvent({
      type: 'dendrite:agent-created', agentName: 'scout.worker-1', kind: 'worker', incarnation: 1,
      lifetime: { kind: 'task', deadlineMs: 60_000 }, spawnedBy: 'scout', timestamp: ts(0),
    });
    r.applyEvent({ type: 'dendrite:agent-orphaned', agentName: 'scout.worker-1', formerParent: 'scout', reason: 'parent ended', candidates: ['archivist'], timestamp: ts(1) });
    expect(r.getNode('scout.worker-1')!.parent).toBeUndefined();
    expect(r.getRoots().map(n => n.name).sort()).toEqual(['archivist', 'scout', 'scout.worker-1']);
    r.applyEvent({ type: 'dendrite:agent-reparented', agentName: 'scout.worker-1', parent: 'archivist', by: 'archivist', timestamp: ts(2) });
    expect(r.getNode('scout.worker-1')!.parent).toBe('archivist');
    expect(r.getChildren('archivist').map(n => n.name)).toEqual(['scout.worker-1']);
  });

  test('a Dendrite agent\'s end ends its node: completed and failed as they say, every other reason as cancelled', () => {
    const ended = (reason: string) => {
      const r = new AgentTreeReducer();
      r.applyEvent({
        type: 'dendrite:agent-created', agentName: 'scout.worker-1', kind: 'worker', incarnation: 1,
        lifetime: { kind: 'task', deadlineMs: 60_000 }, spawnedBy: 'scout', timestamp: ts(0),
      });
      r.applyEvent({ type: 'inference:started', agentName: 'scout.worker-1', timestamp: ts(1) });
      r.applyEvent({ type: 'dendrite:agent-ended', agentName: 'scout.worker-1', kind: 'worker', incarnation: 1, reason, timestamp: ts(2) });
      const node = r.getNode('scout.worker-1')!;
      return { status: node.status, phase: node.phase, completedAt: node.completedAt, parent: node.parent };
    };
    expect(ended('completed')).toEqual({ status: 'completed', phase: 'done', completedAt: ts(2), parent: 'scout' });
    expect(ended('failed')).toEqual({ status: 'failed', phase: 'failed', completedAt: ts(2), parent: 'scout' });
    for (const reason of ['stopped', 'deadline', 'idle-ttl', 'parent-ended', 'host-restart', 'not-configured', 'a reason added later']) {
      expect(ended(reason)).toEqual({ status: 'cancelled', phase: 'cancelled', completedAt: ts(2), parent: 'scout' });
    }
  });

  test('an end the tree saw no creation for, as a restart ends a job a stop cut off, makes the node, ended', () => {
    const r = new AgentTreeReducer();
    r.seedFrameworkAgents(['scout']);
    r.applyEvent({ type: 'dendrite:agent-ended', agentName: 'scout.reader-7', kind: 'task-fork', incarnation: 1, reason: 'host-restart', timestamp: ts(0) });
    expect(r.getNode('scout.reader-7')).toMatchObject({ kind: 'framework', status: 'cancelled', phase: 'cancelled' });
  });

  test('an agent created again after its end, as a resume makes it, reads as a new run until its first inference', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({
      type: 'dendrite:agent-created', agentName: 'scout.worker-1', kind: 'worker', incarnation: 1,
      lifetime: { kind: 'task', deadlineMs: 60_000 }, spawnedBy: 'scout', timestamp: ts(0),
    });
    r.applyEvent({ type: 'dendrite:agent-ended', agentName: 'scout.worker-1', kind: 'worker', incarnation: 1, reason: 'host-restart', timestamp: ts(1) });
    r.applyEvent({
      type: 'dendrite:agent-created', agentName: 'scout.worker-1', kind: 'worker', incarnation: 2,
      lifetime: { kind: 'task', deadlineMs: 60_000 }, spawnedBy: 'scout', timestamp: ts(2),
    });
    const node = r.getNode('scout.worker-1')!;
    expect({ status: node.status, phase: node.phase, startedAt: node.startedAt, completedAt: node.completedAt, parent: node.parent })
      .toEqual({ status: 'running', phase: 'idle', startedAt: ts(2), completedAt: undefined, parent: 'scout' });
  });

  test('an end the tree saw no creation for hangs the node under the spawner the end names', () => {
    const r = new AgentTreeReducer();
    r.seedFrameworkAgents(['scout']);
    r.applyEvent({ type: 'dendrite:agent-ended', agentName: 'scout.reader-7', kind: 'task-fork', incarnation: 1, reason: 'host-restart', spawnedBy: 'scout', timestamp: ts(0) });
    expect(r.getNode('scout.reader-7')).toMatchObject({ parent: 'scout', status: 'cancelled' });
    expect(r.getChildren('scout').map(n => n.name)).toEqual(['scout.reader-7']);
  });

  test('an orphan that ends stays parentless, though its end names the spawner it lost', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({
      type: 'dendrite:agent-created', agentName: 'scout.worker-1', kind: 'worker', incarnation: 1,
      lifetime: { kind: 'task', deadlineMs: 60_000 }, spawnedBy: 'scout', timestamp: ts(0),
    });
    r.applyEvent({ type: 'dendrite:agent-orphaned', agentName: 'scout.worker-1', formerParent: 'scout', reason: 'parent ended', candidates: [], timestamp: ts(1) });
    r.applyEvent({ type: 'dendrite:agent-ended', agentName: 'scout.worker-1', kind: 'worker', incarnation: 1, reason: 'deadline', spawnedBy: 'scout', timestamp: ts(2) });
    expect(r.getNode('scout.worker-1')!.parent).toBeUndefined();
  });

  test('an agent a stop cut off reads as cancelled, not running', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'scout.worker-1', timestamp: ts(0) });
    r.applyEvent({ type: 'dendrite:agent-interrupted', agentName: 'scout.worker-1', kind: 'worker', incarnation: 1, reason: 'host-stop', timestamp: ts(1) });
    expect(r.getNode('scout.worker-1')).toMatchObject({ status: 'cancelled', phase: 'cancelled', completedAt: ts(1) });
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

  test('inference:aborted produces terminal cancelled state (P1 #3 — distinct from failed)', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: ts(0) });
    r.applyEvent({ type: 'inference:aborted', agentName: 'a', reason: 'user', timestamp: ts(1) });
    const node = r.getNode('a')!;
    expect(node.phase).toBe('cancelled');
    expect(node.status).toBe('cancelled');
    expect(node.completedAt).toBe(ts(1));
  });

  test('inference:exhausted ends a node as failed, after a failure and alone', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: ts(0) });
    r.applyEvent({ type: 'inference:failed', agentName: 'a', error: 'overloaded', timestamp: ts(1) });
    r.applyEvent({ type: 'inference:exhausted', agentName: 'a', error: 'overloaded', timestamp: ts(2) });
    r.applyEvent({ type: 'inference:started', agentName: 'b', timestamp: ts(0) });
    r.applyEvent({ type: 'inference:exhausted', agentName: 'b', error: 'Stream aborted: timeout', timestamp: ts(1) });
    for (const name of ['a', 'b']) {
      const node = r.getNode(name)!;
      expect(node.phase).toBe('failed');
      expect(node.status).toBe('failed');
    }
    expect(r.getNode('a')!.completedAt).toBe(ts(2));
  });

  test('an inference:exhausted after inference:aborted leaves the stop cancelled until the next start', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: ts(0) });
    r.applyEvent({ type: 'inference:aborted', agentName: 'a', reason: 'user', timestamp: ts(1) });
    r.applyEvent({ type: 'inference:exhausted', agentName: 'a', error: 'stream cancelled', timestamp: ts(2) });
    let node = r.getNode('a')!;
    expect(node.phase).toBe('cancelled');
    expect(node.status).toBe('cancelled');
    expect(node.completedAt).toBe(ts(1));
    expect(node.lastEventAt).toBe(ts(2));
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: ts(3) });
    r.applyEvent({ type: 'inference:exhausted', agentName: 'a', error: 'overloaded', timestamp: ts(4) });
    node = r.getNode('a')!;
    expect(node.phase).toBe('failed');
    expect(node.status).toBe('failed');
    expect(node.completedAt).toBe(ts(4));
  });

  test('inference:turn_ended is terminal in its own right (AF PR #55: no trailing exhausted)', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: ts(0) });
    r.applyEvent({ type: 'inference:turn_ended', agentName: 'a', timestamp: ts(1) });
    const node = r.getNode('a')!;
    expect(node.phase).toBe('done');
    expect(node.status).toBe('completed');
    expect(node.completedAt).toBe(ts(1));
  });

  test('inference:completed sets status=completed (F1 — closes one-way failed latch)', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: ts(0) });
    r.applyEvent({
      type: 'inference:completed',
      agentName: 'a',
      durationMs: 5,
      timestamp: ts(1),
    });
    const node = r.getNode('a')!;
    expect(node.phase).toBe('done');
    expect(node.status).toBe('completed');
  });

  test('inference:completed after a prior aborted clears the cancelled status (F1 — recovery un-latches)', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: ts(0) });
    r.applyEvent({ type: 'inference:aborted', agentName: 'a', reason: 'cancel', timestamp: ts(1) });
    expect(r.getNode('a')!.status).toBe('cancelled');

    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: ts(2) });
    r.applyEvent({
      type: 'inference:completed',
      agentName: 'a',
      durationMs: 5,
      timestamp: ts(3),
    });
    expect(r.getNode('a')!.status).toBe('completed');
  });

  test('REDUCER_REQUIRED_EVENTS is derived from the dispatch table — every entry actually does something', () => {
    for (const eventType of REDUCER_REQUIRED_EVENTS) {
      const r = new AgentTreeReducer();
      const event = makeRepresentativeEvent(eventType);
      r.applyEvent(event as never);
      const nodes = r.getNodes();
      const observable = nodes.length > 0 || hasCallIdSideEffect(eventType);
      expect(observable).toBe(true);
    }
  });
});

function makeRepresentativeEvent(eventType: string): Record<string, unknown> {
  switch (eventType) {
    case 'inference:tool_calls_yielded':
      return {
        type: eventType,
        agentName: 'agent',
        calls: [{ id: 'c1', name: 'x', input: {} }],
        timestamp: 1000,
      };
    case 'tool:started':
    case 'tool:completed':
    case 'tool:failed':
      return { type: eventType, callId: 'c1', tool: 'x', module: 'm', timestamp: 1000, durationMs: 1, error: '' };
    case 'inference:usage':
      return {
        type: eventType,
        agentName: 'agent',
        tokenUsage: { input: 100, output: 10 },
        timestamp: 1000,
      };
    case 'inference:completed':
      return {
        type: eventType,
        agentName: 'agent',
        durationMs: 5,
        tokenUsage: { input: 100, output: 10 },
        timestamp: 1000,
      };
    case 'inference:failed':
    case 'inference:exhausted':
    case 'inference:aborted':
      return { type: eventType, agentName: 'agent', error: 'x', reason: 'x', timestamp: 1000 };
    case 'inference:stream_restarted':
      return { type: eventType, agentName: 'agent', reason: 'x', inputTokens: 0, budget: 0, timestamp: 1000 };
    case 'dendrite:agent-created':
      return { type: eventType, agentName: 'agent.fork-1', kind: 'task-fork', incarnation: 1, lifetime: { kind: 'task', idleTimeoutMs: 1 }, spawnedBy: 'agent', timestamp: 1000 };
    case 'dendrite:agent-orphaned':
      return { type: eventType, agentName: 'agent.fork-1', formerParent: 'agent', reason: 'parent ended', candidates: [], timestamp: 1000 };
    case 'dendrite:agent-reparented':
      return { type: eventType, agentName: 'agent.fork-1', parent: 'agent', timestamp: 1000 };
    case 'dendrite:agent-ended':
      return { type: eventType, agentName: 'agent.fork-1', kind: 'task-fork', incarnation: 1, reason: 'stopped', timestamp: 1000 };
    case 'dendrite:agent-interrupted':
      return { type: eventType, agentName: 'agent.fork-1', kind: 'task-fork', incarnation: 1, reason: 'host-stop', timestamp: 1000 };
    default:
      return { type: eventType, agentName: 'agent', content: '', timestamp: 1000 };
  }
}

function hasCallIdSideEffect(eventType: string): boolean {
  return eventType === 'tool:started' || eventType === 'tool:completed' || eventType === 'tool:failed';
}

describe('AgentTreeReducer (continued)', () => {

  test('usage samples are running totals: each call counts once, and input is its prompt', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: ts(0) });
    r.applyEvent({
      type: 'inference:usage',
      agentName: 'a',
      tokenUsage: { input: 1000, output: 50, cacheRead: 200, cacheCreation: 100 },
      timestamp: ts(1),
    });
    r.applyEvent({
      type: 'inference:usage',
      agentName: 'a',
      tokenUsage: { input: 1500, output: 80, cacheRead: 300, cacheCreation: 150 },
      timestamp: ts(2),
    });
    const tokens = r.getNode('a')!.tokens;
    expect(tokens.input).toBe(500 + 100 + 50);
    expect(tokens.output).toBe(80);
    expect(tokens.cacheRead).toBe(300);
    expect(tokens.cacheWrite).toBe(150);
  });

  test('inference:completed adds only what its usage holds beyond the last sample', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: ts(0) });
    r.applyEvent({
      type: 'inference:usage',
      agentName: 'a',
      tokenUsage: { input: 500, output: 20, cacheRead: 0, cacheCreation: 0 },
      timestamp: ts(1),
    });
    r.applyEvent({
      type: 'inference:completed',
      agentName: 'a',
      durationMs: 100,
      tokenUsage: { input: 700, output: 30, cacheRead: 50, cacheCreation: 10 },
      timestamp: ts(2),
    });
    const tokens = r.getNode('a')!.tokens;
    expect(tokens.input).toBe(200 + 50 + 10);
    expect(tokens.output).toBe(30);
    expect(tokens.cacheRead).toBe(50);
    expect(tokens.cacheWrite).toBe(10);
    // agent-framework's completion repeats the last sample.
    r.applyEvent({ type: 'inference:completed', agentName: 'a', durationMs: 100, tokenUsage: { input: 700, output: 30, cacheRead: 50, cacheCreation: 10 }, timestamp: ts(3) });
    expect(r.getNode('a')!.tokens).toEqual(tokens);
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

  test('fleet--launch tool call creates a framework-kind child', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({
      type: 'inference:tool_calls_yielded',
      agentName: 'conductor',
      calls: [{
        id: 'c1',
        name: 'fleet--launch',
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
    snap.nodes[0]!.streamUsage!.output = 999;
    expect(r.getNode('a')!.tokens.input).toBe(100);
    expect(r.getNode('a')!.toolCallsCount).toBe(0);
    expect(r.getNode('a')!.streamUsage!.output).toBe(10);
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
