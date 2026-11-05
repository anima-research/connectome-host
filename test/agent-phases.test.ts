import { describe, expect, test } from 'bun:test';
import { AgentPhases } from '../src/state/agent-phases.js';
import { AgentTreeReducer, REDUCER_REQUIRED_EVENTS } from '../src/state/agent-tree-reducer.js';

const started = (agentName: string, timestamp: number) => ({ type: 'inference:started', agentName, timestamp });
const tokens = (agentName: string, timestamp: number) => ({ type: 'inference:tokens', agentName, timestamp });
const yielded = (agentName: string, id: string, timestamp: number, extra: Record<string, unknown> = {}) => ({
  type: 'inference:tool_calls_yielded', agentName, timestamp, calls: [{ id, name: 'a-tool', ...extra }],
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

  test("agrees with the web UI's tree on every event it handles, in any order", () => {
    // Types the tree handles that move nothing here, or are this tracker's own:
    // an agent's end removes it, which the next test covers.
    const types = REDUCER_REQUIRED_EVENTS.filter((type) => type !== 'dendrite:agent-ended');
    let seed = 42;
    // A small LCG's low bits repeat quickly, so this reads its high ones.
    const next = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return Math.floor((seed / 0x80000000) * n);
    };
    for (let run = 0; run < 200; run++) {
      const phases = new AgentPhases(['main']);
      const tree = new AgentTreeReducer();
      tree.seedFrameworkAgents(['main']);
      // A call's id is unique and it finishes once, so its events only follow its yield.
      const open: string[] = [];
      for (let i = 1; i <= 40; i++) {
        const type = types[next(types.length)]!;
        const event: Record<string, unknown> = { type, agentName: 'main', timestamp: i, error: 'x', callId: 'never-yielded' };
        if (type === 'inference:tool_calls_yielded') {
          const id = `c${run}-${i}`;
          open.push(id);
          event.calls = [{ id, name: 'a-tool' }];
        } else if (type.startsWith('tool:') && open.length > 0) {
          const at = next(open.length);
          event.callId = open[at];
          if (type !== 'tool:started') open.splice(at, 1);
        }
        phases.apply(event as never);
        tree.applyEvent(event as never);
        expect(`${run}/${i} ${type}: ${phases.snapshot().main!.phase}`).toBe(`${run}/${i} ${type}: ${tree.getNode('main')!.phase}`);
      }
    }
  });

  test('takes no notice of an event with no bearing on a phase', () => {
    const phases = new AgentPhases(['main'], 1);
    expect(phases.apply({ type: 'ops:alert', agentName: 'main' } as never)).toEqual([]);
    expect(phases.apply({ type: 'inference:usage', agentName: 'main', timestamp: 2 } as never)).toEqual([]);
    expect(phases.snapshot()).toEqual({ main: { phase: 'idle', since: 1 } });
  });

  test("never takes an agent from a tool call's input", () => {
    const phases = new AgentPhases(['main'], 1);
    for (const name of ['subagent--spawn', 'subagent--fork', 'fleet--launch']) {
      phases.apply(yielded('main', `c-${name}`, 2, { name, input: { name: 'words-the-agent-wrote', task: 'more of them' } }) as never);
    }
    expect(Object.keys(phases.snapshot())).toEqual(['main']);
  });

  test('an agent arrives with its first turn and leaves when it ends, with one last change', () => {
    const phases = new AgentPhases(['main'], 1);
    expect(phases.apply({ type: 'inference:tokens', agentName: 'a-fork', timestamp: 2 } as never)).toEqual([]);
    expect(phases.apply(started('a-fork', 3))).toEqual([{ agentName: 'a-fork', phase: 'sending', since: 3 }]);
    phases.apply(yielded('a-fork', 'c1', 4));
    expect(phases.apply({ type: 'dendrite:agent-ended', agentName: 'a-fork', reason: 'completed', timestamp: 5 } as never))
      .toEqual([{ agentName: 'a-fork', phase: 'done', since: 5 }]);
    expect(Object.keys(phases.snapshot())).toEqual(['main']);

    // Late events don't bring it back.
    for (const late of [
      { type: 'tool:started', callId: 'c1', timestamp: 6 },
      { type: 'inference:exhausted', agentName: 'a-fork', error: 'x', timestamp: 7 },
      { type: 'inference:aborted', agentName: 'a-fork', timestamp: 8 },
    ]) {
      expect(phases.apply(late as never)).toEqual([]);
    }
    expect(Object.keys(phases.snapshot())).toEqual(['main']);
  });

  test("drops a finished call's owner", () => {
    const phases = new AgentPhases(['main'], 1);
    const owners = (phases as unknown as { callOwners: Map<string, string> }).callOwners;
    phases.apply(yielded('main', 'c1', 2));
    phases.apply(yielded('main', 'c2', 3));
    expect([...owners.keys()]).toEqual(['c1', 'c2']);
    phases.apply({ type: 'tool:completed', callId: 'c1', timestamp: 4 } as never);
    phases.apply({ type: 'tool:failed', callId: 'c2', timestamp: 5 } as never);
    expect(owners.size).toBe(0);
  });
});
