/**
 * A subagent's peek stream passes on each of its streams' ends
 * (state/turn-trace.ts), so the panel that follows it shows how each stream
 * ended: a turn a tool ended (its return, skip_reply, sleep), an abort and a
 * turn the framework gave up on, as well as a completed or failed one. The
 * in-flight flag the reaper reads stays as it was at those three.
 */
import { describe, expect, test } from 'bun:test';
import type { TraceEvent } from '@animalabs/agent-framework';
import { SubagentModule, type SubagentStreamEvent } from '../src/modules/subagent-module.js';

/** A live subagent the module's trace handler can find, and the events its
 *  peek stream sends. */
function setUp() {
  const mod = new SubagentModule();
  const live = {
    frameworkAgentName: 'fw-scout',
    displayName: 'scout',
    systemPrompt: 'test',
    contextManager: { compile: async () => ({ messages: [] }) },
    currentStream: '',
    pendingToolCalls: [] as Array<{ name: string; input?: unknown }>,
    activeCallIds: new Set<string>(),
    requestInFlightSince: undefined as number | undefined,
  };
  const privateView = mod as unknown as {
    liveSubagents: Map<string, typeof live>;
    frameworkNameIndex: Map<string, string>;
  };
  privateView.liveSubagents.set('scout', live);
  privateView.frameworkNameIndex.set('fw-scout', 'scout');
  let handler: ((e: TraceEvent) => void) | null = null;
  mod.setFramework({ onTrace: (cb: (e: TraceEvent) => void) => { handler = cb; } } as never);
  const events: SubagentStreamEvent[] = [];
  mod.onPeekStream('scout', (event) => { events.push(event); });
  const fire = (event: Record<string, unknown>) => handler!({ agentName: 'fw-scout', ...event } as unknown as TraceEvent);
  return { live, events, fire };
}

describe("a subagent's peek stream", () => {
  test('passes on a turn a tool ended, an abort with its reason, and a turn the framework gave up on', () => {
    const { events, fire } = setUp();
    fire({ type: 'inference:turn_ended' });
    fire({ type: 'inference:aborted', reason: 'user' });
    fire({ type: 'inference:aborted' });
    fire({ type: 'inference:aborted', reason: '' });
    fire({ type: 'inference:exhausted', error: 'Stream aborted: timeout' });
    expect(events).toEqual([
      { type: 'inference:turn_ended' },
      { type: 'inference:aborted', reason: 'user' },
      // No reason, or an empty one, sends none.
      { type: 'inference:aborted' },
      { type: 'inference:aborted' },
      { type: 'inference:exhausted', error: 'Stream aborted: timeout' },
    ]);
  });

  test('leaves the in-flight flag as it was at those ends', () => {
    const { live, fire } = setUp();
    fire({ type: 'inference:started' });
    const since = live.requestInFlightSince;
    expect(typeof since).toBe('number');
    for (const type of ['inference:turn_ended', 'inference:aborted', 'inference:exhausted']) {
      fire({ type, error: 'x' });
      expect(live.requestInFlightSince).toBe(since);
    }
  });

  test("a failed or exhausted trace without an error's text passes on 'Unknown error'", () => {
    const { events, fire } = setUp();
    fire({ type: 'inference:failed' });
    fire({ type: 'inference:failed', error: '' });
    fire({ type: 'inference:exhausted', error: '  ' });
    fire({ type: 'inference:exhausted', error: 5 });
    fire({ type: 'inference:failed', error: 'overloaded' });
    expect(events).toEqual([
      { type: 'inference:failed', error: 'Unknown error' },
      { type: 'inference:failed', error: 'Unknown error' },
      { type: 'inference:exhausted', error: 'Unknown error' },
      { type: 'inference:exhausted', error: 'Unknown error' },
      { type: 'inference:failed', error: 'overloaded' },
    ]);
  });

  test("another agent's ends send nothing", () => {
    const { events, fire } = setUp();
    for (const type of ['inference:turn_ended', 'inference:aborted', 'inference:exhausted']) {
      fire({ type, agentName: 'fw-other', error: 'x' });
    }
    expect(events).toEqual([]);
  });
});
