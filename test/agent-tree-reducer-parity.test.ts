/**
 * Parity test: AgentTreeReducer's output matches what tui.ts currently builds
 * from the same event stream.
 *
 * Approach: replicate the TUI's per-event fold inline (mirror of the
 * subagentPhase, agentContextTokens, agentParent maps in tui.ts) and feed both
 * folds the same canonical event stream. Assert they produce equivalent state.
 *
 * This test exists to prevent silent drift during Phase 2's extraction. Once
 * the TUI is migrated to the reducer (Phase 4), the inline fold here can stay
 * as a frozen reference of the pre-extraction behavior.
 */
import { describe, test, expect } from 'bun:test';
import { AgentTreeReducer } from '../src/state/agent-tree-reducer.js';

type Phase = 'sending' | 'streaming' | 'invoking' | 'executing' | 'done' | 'failed' | 'idle';

interface InlineFold {
  phaseByAgent: Map<string, Phase>;
  inputTokensByAgent: Map<string, number>;
  parentByChild: Map<string, string>;
  toolCountByAgent: Map<string, number>;
}

function inlineFold(events: Array<Record<string, unknown>>): InlineFold {
  const phaseByAgent = new Map<string, Phase>();
  const inputTokensByAgent = new Map<string, number>();
  const parentByChild = new Map<string, string>();
  const toolCountByAgent = new Map<string, number>();
  // Mirror SubagentModule's callIdIndex so tool events route to the correct agent.
  const callIdIndex = new Map<string, string>();

  for (const e of events) {
    const agent = e.agentName as string | undefined;
    switch (e.type) {
      case 'inference:started':
        if (agent) phaseByAgent.set(agent, 'sending');
        break;
      case 'inference:tokens':
        if (agent) phaseByAgent.set(agent, 'streaming');
        break;
      case 'inference:tool_calls_yielded': {
        if (agent) phaseByAgent.set(agent, 'invoking');
        const calls = (e.calls as Array<{ id: string; name: string; input?: unknown }>) ?? [];
        for (const call of calls) {
          if (agent) callIdIndex.set(call.id, agent);
          if (call.name === 'subagent--spawn' || call.name === 'subagent--fork') {
            const child = (call.input as { name?: string } | undefined)?.name;
            if (child && agent) parentByChild.set(child, agent);
          }
        }
        break;
      }
      case 'inference:usage': {
        if (agent) {
          const usage = e.tokenUsage as { input?: number } | undefined;
          if (usage?.input) inputTokensByAgent.set(agent, usage.input);
        }
        break;
      }
      case 'inference:completed': {
        if (agent) {
          phaseByAgent.set(agent, 'done');
          const usage = e.tokenUsage as { input?: number } | undefined;
          if (usage?.input) inputTokensByAgent.set(agent, usage.input);
        }
        break;
      }
      case 'inference:failed':
        if (agent) phaseByAgent.set(agent, 'failed');
        break;
      case 'tool:started': {
        const callId = e.callId as string | undefined;
        if (callId) {
          const owner = callIdIndex.get(callId);
          if (owner) {
            phaseByAgent.set(owner, 'executing');
            toolCountByAgent.set(owner, (toolCountByAgent.get(owner) ?? 0) + 1);
          }
        }
        break;
      }
    }
  }

  return { phaseByAgent, inputTokensByAgent, parentByChild, toolCountByAgent };
}

function reducerFold(events: Array<Record<string, unknown>>): InlineFold {
  const r = new AgentTreeReducer();
  for (const e of events) r.applyEvent(e as never);
  const phaseByAgent = new Map<string, Phase>();
  const inputTokensByAgent = new Map<string, number>();
  const parentByChild = new Map<string, string>();
  const toolCountByAgent = new Map<string, number>();
  for (const node of r.getNodes()) {
    phaseByAgent.set(node.name, node.phase as Phase);
    if (node.tokens.input > 0) inputTokensByAgent.set(node.name, node.tokens.input);
    if (node.parent) parentByChild.set(node.name, node.parent);
    if (node.toolCallsCount > 0) toolCountByAgent.set(node.name, node.toolCallsCount);
  }
  return { phaseByAgent, inputTokensByAgent, parentByChild, toolCountByAgent };
}

function assertParity(events: Array<Record<string, unknown>>): void {
  const inline = inlineFold(events);
  const reducer = reducerFold(events);
  // The reducer creates nodes for agents the inline fold never explicitly
  // tracked (e.g. it preserves them after seeing only spawn-call events without
  // an inference:started). We only assert that the inline fold's keys are a
  // subset and agree on values.
  for (const [agent, phase] of inline.phaseByAgent) {
    expect(reducer.phaseByAgent.get(agent)).toBe(phase);
  }
  for (const [agent, tokens] of inline.inputTokensByAgent) {
    expect(reducer.inputTokensByAgent.get(agent)).toBe(tokens);
  }
  for (const [child, parent] of inline.parentByChild) {
    expect(reducer.parentByChild.get(child)).toBe(parent);
  }
  for (const [agent, count] of inline.toolCountByAgent) {
    expect(reducer.toolCountByAgent.get(agent)).toBe(count);
  }
}

const t = (offset: number) => 1_700_000_000_000 + offset;

describe('AgentTreeReducer parity with inline fold', () => {
  test('simple inference round', () => {
    assertParity([
      { type: 'inference:started', agentName: 'commander', timestamp: t(0) },
      { type: 'inference:tokens', agentName: 'commander', content: 'hello', timestamp: t(1) },
      { type: 'inference:usage', agentName: 'commander', tokenUsage: { input: 1234, output: 50 }, timestamp: t(2) },
      { type: 'inference:completed', agentName: 'commander', durationMs: 100, tokenUsage: { input: 1234, output: 50 }, timestamp: t(3) },
    ]);
  });

  test('tool round with two tool calls', () => {
    assertParity([
      { type: 'inference:started', agentName: 'commander', timestamp: t(0) },
      {
        type: 'inference:tool_calls_yielded',
        agentName: 'commander',
        calls: [
          { id: 'c1', name: 'files--read', input: { path: '/x' } },
          { id: 'c2', name: 'files--read', input: { path: '/y' } },
        ],
        timestamp: t(1),
      },
      { type: 'tool:started', callId: 'c1', tool: 'files--read', module: 'files', timestamp: t(2) },
      { type: 'tool:started', callId: 'c2', tool: 'files--read', module: 'files', timestamp: t(3) },
      { type: 'tool:completed', callId: 'c1', tool: 'files--read', module: 'files', durationMs: 5, timestamp: t(4) },
      { type: 'tool:completed', callId: 'c2', tool: 'files--read', module: 'files', durationMs: 5, timestamp: t(5) },
    ]);
  });

  test('subagent spawn with nested inference', () => {
    assertParity([
      { type: 'inference:started', agentName: 'commander', timestamp: t(0) },
      {
        type: 'inference:tool_calls_yielded',
        agentName: 'commander',
        calls: [{
          id: 'c1',
          name: 'subagent--spawn',
          input: { name: 'researcher', task: 'investigate X' },
        }],
        timestamp: t(1),
      },
      { type: 'tool:started', callId: 'c1', tool: 'subagent--spawn', module: 'subagent', timestamp: t(2) },
      { type: 'inference:started', agentName: 'researcher', timestamp: t(3) },
      { type: 'inference:tokens', agentName: 'researcher', content: 'thinking', timestamp: t(4) },
      { type: 'inference:usage', agentName: 'researcher', tokenUsage: { input: 5000, output: 100 }, timestamp: t(5) },
      { type: 'inference:completed', agentName: 'researcher', durationMs: 200, tokenUsage: { input: 5000, output: 100 }, timestamp: t(6) },
      { type: 'tool:completed', callId: 'c1', tool: 'subagent--spawn', module: 'subagent', durationMs: 250, timestamp: t(7) },
    ]);
  });

  test('failed inference', () => {
    assertParity([
      { type: 'inference:started', agentName: 'a', timestamp: t(0) },
      { type: 'inference:failed', agentName: 'a', error: 'rate limited', timestamp: t(1) },
    ]);
  });

  test('multiple usage events accumulate context size correctly', () => {
    // Last input tokens wins (= current context window).
    assertParity([
      { type: 'inference:usage', agentName: 'a', tokenUsage: { input: 1000, output: 50 }, timestamp: t(0) },
      { type: 'inference:usage', agentName: 'a', tokenUsage: { input: 2000, output: 80 }, timestamp: t(1) },
      { type: 'inference:usage', agentName: 'a', tokenUsage: { input: 3500, output: 120 }, timestamp: t(2) },
    ]);
  });
});
