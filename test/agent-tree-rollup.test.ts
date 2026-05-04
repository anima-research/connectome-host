/**
 * Phase rollup logic — picks the busiest active phase from a list of
 * AgentTreeReducer nodes, used by the TUI to colour fleet-child header rows
 * with what's *actually happening inside the child*, not just lifecycle
 * status. The helper itself lives inside tui.ts as a closure, so this test
 * mirrors its behaviour against canonical reducer state.
 */
import { describe, test, expect } from 'bun:test';
import { AgentTreeReducer } from '../src/state/agent-tree-reducer.js';
import type { AgentNode } from '../src/state/agent-tree-reducer.js';

type ActivePhase = 'sending' | 'streaming' | 'invoking' | 'executing';

/** Reference implementation of the rollup. Mirrors tui.ts:rollupActivePhase. */
function rollupActivePhase(nodes: AgentNode[]): ActivePhase | null {
  const PRIORITY: Record<ActivePhase, number> = {
    streaming: 5,
    invoking: 4,
    executing: 3,
    sending: 2,
  };
  let best: ActivePhase | null = null;
  let bestScore = -1;
  for (const n of nodes) {
    const phase = n.phase;
    if (phase === 'streaming' || phase === 'invoking' ||
        phase === 'executing' || phase === 'sending') {
      const score = PRIORITY[phase];
      if (score > bestScore) {
        best = phase;
        bestScore = score;
      }
    }
  }
  return best;
}

const t = (offset: number) => 1_700_000_000_000 + offset;

describe('phase rollup for fleet-child header status', () => {
  test('returns null when nothing is active', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: t(0) });
    r.applyEvent({ type: 'inference:completed', agentName: 'a', durationMs: 5, timestamp: t(1) });
    expect(rollupActivePhase(r.getNodes())).toBeNull();
  });

  test('returns the agent phase when one agent is mid-stream', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: t(0) });
    r.applyEvent({ type: 'inference:tokens', agentName: 'a', content: 'hi', timestamp: t(1) });
    expect(rollupActivePhase(r.getNodes())).toBe('streaming');
  });

  test('streaming wins over executing when multiple agents are busy', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: t(0) });
    r.applyEvent({
      type: 'inference:tool_calls_yielded',
      agentName: 'a',
      calls: [{ id: 'c1', name: 'x', input: {} }],
      timestamp: t(1),
    });
    r.applyEvent({ type: 'tool:started', callId: 'c1', tool: 'x', module: 'm', timestamp: t(2) });
    // Now agent 'a' is in 'executing'. Add agent 'b' that starts streaming.
    r.applyEvent({ type: 'inference:tokens', agentName: 'b', content: 'hi', timestamp: t(3) });
    expect(rollupActivePhase(r.getNodes())).toBe('streaming');
  });

  test('done and idle do not register as active', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: t(0) });
    r.applyEvent({ type: 'inference:completed', agentName: 'a', durationMs: 5, timestamp: t(1) });
    r.seedFrameworkAgents(['idle-agent']); // phase=idle by default
    expect(rollupActivePhase(r.getNodes())).toBeNull();
  });

  test('invoking and executing rank between sending and streaming', () => {
    const reduce = (phase: 'sending' | 'streaming' | 'invoking' | 'executing'): AgentTreeReducer => {
      const r = new AgentTreeReducer();
      r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: t(0) });
      if (phase === 'streaming') {
        r.applyEvent({ type: 'inference:tokens', agentName: 'a', content: 'x', timestamp: t(1) });
      } else if (phase === 'invoking' || phase === 'executing') {
        r.applyEvent({
          type: 'inference:tool_calls_yielded',
          agentName: 'a',
          calls: [{ id: 'c1', name: 'x', input: {} }],
          timestamp: t(1),
        });
        if (phase === 'executing') {
          r.applyEvent({ type: 'tool:started', callId: 'c1', tool: 'x', module: 'm', timestamp: t(2) });
        }
      }
      return r;
    };
    expect(rollupActivePhase(reduce('streaming').getNodes())).toBe('streaming');
    expect(rollupActivePhase(reduce('invoking').getNodes())).toBe('invoking');
    expect(rollupActivePhase(reduce('executing').getNodes())).toBe('executing');
    expect(rollupActivePhase(reduce('sending').getNodes())).toBe('sending');
  });

  test('failed agents do not count as active (the activity rolled up is *current* work, not historical state)', () => {
    const r = new AgentTreeReducer();
    r.applyEvent({ type: 'inference:started', agentName: 'a', timestamp: t(0) });
    r.applyEvent({ type: 'inference:failed', agentName: 'a', error: 'boom', timestamp: t(1) });
    expect(rollupActivePhase(r.getNodes())).toBeNull();
  });
});
