import { describe, expect, test } from 'bun:test';
import { AgentPhases } from '../src/state/agent-phases.js';
import { AgentTreeReducer } from '../src/state/agent-tree-reducer.js';

const started = (agentName: string, timestamp: number) => ({ type: 'inference:started', agentName, timestamp });
const tokens = (agentName: string, timestamp: number) => ({ type: 'inference:tokens', agentName, timestamp });
const yielded = (agentName: string, id: string, timestamp: number) => ({
  type: 'inference:tool_calls_yielded', agentName, timestamp, calls: [{ id, name: 'a-tool' }],
});

describe('AgentPhases', () => {
  test('starts its agents idle, and reports each change once, with when it began', () => {
    const phases = new AgentPhases(['main'], 1);
    expect(phases.snapshot()).toEqual({ main: { phase: 'idle', since: 1 } });
    expect(phases.apply(started('main', 2))).toEqual([{ agentName: 'main', phase: 'sending', since: 2 }]);
    expect(phases.apply(tokens('main', 3))).toEqual([{ agentName: 'main', phase: 'streaming', since: 3 }]);
    expect(phases.apply(tokens('main', 4))).toEqual([]);
    expect(phases.apply(yielded('main', 'c1', 5))).toEqual([{ agentName: 'main', phase: 'invoking', since: 5 }]);
    expect(phases.apply({ type: 'tool:started', callId: 'c1', timestamp: 6 } as never)).toEqual([{ agentName: 'main', phase: 'executing', since: 6 }]);
    expect(phases.apply({ type: 'tool:completed', callId: 'c1', timestamp: 7 } as never)).toEqual([]);
    expect(phases.apply({ type: 'inference:completed', agentName: 'main', timestamp: 8 } as never)).toEqual([{ agentName: 'main', phase: 'done', since: 8 }]);
    expect(phases.snapshot()).toEqual({ main: { phase: 'done', since: 8 } });
  });

  test("reads every event as the web UI's tree does", () => {
    const events = [
      started('main', 2), tokens('main', 3), yielded('main', 'c1', 4),
      { type: 'tool:started', callId: 'c1', timestamp: 5 },
      { type: 'tool:completed', callId: 'c1', timestamp: 6 },
      { type: 'inference:failed', agentName: 'main', error: 'x', timestamp: 7 },
      started('main', 8),
      { type: 'inference:aborted', agentName: 'main', timestamp: 9 },
      { type: 'inference:exhausted', agentName: 'main', error: 'x', timestamp: 10 },
      started('main', 11),
      { type: 'inference:turn_ended', agentName: 'main', timestamp: 12 },
    ];
    const phases = new AgentPhases(['main']);
    const tree = new AgentTreeReducer();
    tree.seedFrameworkAgents(['main']);
    for (const event of events) {
      phases.apply(event as never);
      tree.applyEvent(event as never);
      expect(phases.snapshot().main!.phase).toBe(tree.getNode('main')!.phase);
    }
  });

  test('takes no notice of an event the tree has no use for', () => {
    const phases = new AgentPhases(['main'], 1);
    expect(phases.apply({ type: 'ops:alert', agentName: 'main' } as never)).toEqual([]);
    expect(phases.snapshot()).toEqual({ main: { phase: 'idle', since: 1 } });
  });

  test("forgets a finished call's route and an agent that ended, so a long-lived host doesn't grow", () => {
    const phases = new AgentPhases(['main'], 1);
    const tree = (phases as unknown as { tree: AgentTreeReducer }).tree;
    phases.apply(yielded('main', 'c1', 2));
    expect(tree.getSnapshot().callIdIndex).toEqual({ c1: 'main' });
    phases.apply({ type: 'tool:completed', callId: 'c1', timestamp: 3 } as never);
    expect(tree.getSnapshot().callIdIndex).toEqual({});

    expect(phases.apply(started('a-fork', 4))).toEqual([{ agentName: 'a-fork', phase: 'sending', since: 4 }]);
    expect(phases.apply({ type: 'dendrite:agent-ended', agentName: 'a-fork', reason: 'completed', timestamp: 5 } as never))
      .toEqual([{ agentName: 'a-fork', phase: 'done', since: 5 }]);
    expect(Object.keys(phases.snapshot())).toEqual(['main']);
    expect(tree.getNode('a-fork')).toBeUndefined();
  });
});
