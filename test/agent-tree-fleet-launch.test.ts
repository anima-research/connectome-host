import { describe, test, expect } from 'bun:test';
import { AgentTreeReducer } from '../src/state/agent-tree-reducer.js';

describe('AgentTreeReducer fleet--launch edge inference', () => {
  test('local conductor calling fleet--launch records parent edge', () => {
    const r = new AgentTreeReducer();
    r.seedFrameworkAgents(['conductor']);
    r.applyEvent({
      type: 'inference:tool_calls_yielded',
      agentName: 'conductor',
      calls: [{
        id: 'c1',
        name: 'fleet--launch',
        input: { name: 'miner-1', recipe: 'recipes/knowledge-miner.json' },
      }],
      timestamp: 1_000,
    });
    const child = r.getNode('miner-1');
    expect(child).toBeDefined();
    expect(child!.parent).toBe('conductor');
    expect(r.getChildren('conductor').map(n => n.name)).toContain('miner-1');
  });

  test('multiple fleet--launch calls in one round all create edges', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({
      type: 'inference:tool_calls_yielded',
      agentName: 'conductor',
      calls: [
        { id: 'c1', name: 'fleet--launch', input: { name: 'miner', recipe: 'm.json' } },
        { id: 'c2', name: 'fleet--launch', input: { name: 'reviewer', recipe: 'r.json' } },
      ],
      timestamp: 1_000,
    });
    expect(r.getChildren('conductor').map(n => n.name).sort()).toEqual(['miner', 'reviewer']);
  });

  test('fleet--launch and subagent--spawn coexist in one tree', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({
      type: 'inference:tool_calls_yielded',
      agentName: 'conductor',
      calls: [
        { id: 'c1', name: 'fleet--launch', input: { name: 'miner', recipe: 'm.json' } },
        { id: 'c2', name: 'subagent--spawn', input: { name: 'side-quest', task: 'audit something' } },
      ],
      timestamp: 1_000,
    });
    const miner = r.getNode('miner')!;
    const side = r.getNode('side-quest')!;
    expect(miner.kind).toBe('framework');
    expect(side.kind).toBe('subagent');
    expect(miner.parent).toBe('conductor');
    expect(side.parent).toBe('conductor');
  });
});
