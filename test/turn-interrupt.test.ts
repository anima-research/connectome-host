/**
 * TurnInterrupts: an operator's interrupt aborts a turn at once when the
 * framework can abort it, and otherwise is kept until the turn's first trace
 * that comes once it can be, or forgotten when the turn settles.
 */
import { describe, expect, test } from 'bun:test';
import { TurnInterrupts, interruptSubagents } from '../src/state/turn-interrupt.js';

/** A framework stand-in: abortInference succeeds for the agents in
 *  `abortable`, as agent-framework 0.22.2's does once a turn's model call is
 *  in flight, and records each call. */
function harness() {
  const abortable = new Set<string>();
  const calls: string[] = [];
  const interrupts = new TurnInterrupts((agentName, reason) => {
    calls.push(`abort ${agentName} (${reason})`);
    return abortable.has(agentName);
  });
  const trace = (type: string, agentName = 'main') => interrupts.onTrace({ type, agentName });
  return { abortable, calls, interrupts, trace };
}

/** A kept interrupt's abort runs on a microtask, after the trace. */
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('TurnInterrupts', () => {
  test('a turn whose model call is in flight is aborted at once', () => {
    const { abortable, calls, interrupts, trace } = harness();
    trace('inference:started');
    abortable.add('main');
    expect(interrupts.interrupt('main', 'interrupted')).toBe('aborted');
    expect(calls).toEqual(['abort main (interrupted)']);
    expect(interrupts.isPending('main')).toBe(false);
  });

  test('a running turn that compiles is aborted at its first trace once it can be, and only then', async () => {
    const { abortable, calls, interrupts, trace } = harness();
    trace('inference:started');
    expect(interrupts.interrupt('main', 'interrupted')).toBe('deferred');
    expect(interrupts.isPending('main')).toBe(true);
    // Still compiling: a trace that comes then tries again, and keeps it.
    trace('inference:usage');
    await settle();
    expect(interrupts.isPending('main')).toBe(true);
    abortable.add('main');
    trace('inference:tokens');
    await settle();
    expect(interrupts.isPending('main')).toBe(false);
    trace('inference:tokens');
    await settle();
    expect(calls).toEqual(['abort main (interrupted)', 'abort main (interrupted)', 'abort main (interrupted)']);
  });

  test("a kept interrupt's abort comes after the trace that prompted it has been handled", async () => {
    const order: string[] = [];
    let inFlight = false;
    const interrupts = new TurnInterrupts((agentName) => { order.push(`abort ${agentName} (${inFlight ? 'aborted' : 'nothing in flight'})`); return inFlight; });
    interrupts.onTrace({ type: 'inference:started', agentName: 'main' });
    expect(interrupts.interrupt('main', 'r')).toBe('deferred');
    inFlight = true;
    interrupts.onTrace({ type: 'inference:tokens', agentName: 'main' });
    order.push('the rest of the tokens trace');
    await settle();
    expect(order).toEqual(['abort main (nothing in flight)', 'the rest of the tokens trace', 'abort main (aborted)']);
  });

  test('a kept interrupt is forgotten when its turn settles, and the next turn runs', async () => {
    for (const end of ['inference:completed', 'inference:turn_ended', 'inference:aborted', 'inference:exhausted']) {
      const { abortable, calls, interrupts, trace } = harness();
      trace('inference:started');
      expect(interrupts.interrupt('main', 'r')).toBe('deferred');
      trace(end);
      expect(interrupts.isPending('main')).toBe(false);
      abortable.add('main');
      trace('inference:started');
      trace('inference:tokens');
      await settle();
      expect({ end, calls }).toEqual({ end, calls: ['abort main (r)'] });
    }
  });

  test('with no turn running, an interrupt keeps nothing', () => {
    const { calls, interrupts, trace } = harness();
    expect(interrupts.interrupt('main', 'r')).toBe('idle');
    expect(interrupts.isPending('main')).toBe(false);
    trace('inference:started');
    trace('inference:completed');
    expect(interrupts.interrupt('main', 'r')).toBe('idle');
    expect(calls).toEqual(['abort main (r)', 'abort main (r)']);
  });

  test("a failed attempt's retry is the same turn: an interrupt kept across the failure aborts it", async () => {
    const { abortable, interrupts, trace } = harness();
    trace('inference:started');
    trace('inference:failed');
    // Held for the retry: nothing in flight to abort.
    expect(interrupts.interrupt('main', 'r')).toBe('deferred');
    trace('inference:started');
    await settle();
    expect(interrupts.isPending('main')).toBe(true);
    abortable.add('main');
    trace('inference:tokens');
    await settle();
    expect(interrupts.isPending('main')).toBe(false);
  });

  test('a budget restart or guard retry, a start with no end before it, keeps the interrupt for the same turn', async () => {
    const { abortable, calls, interrupts, trace } = harness();
    trace('inference:started');
    expect(interrupts.interrupt('main', 'r')).toBe('deferred');
    trace('inference:started');
    await settle();
    expect(interrupts.isPending('main')).toBe(true);
    abortable.add('main');
    trace('inference:tokens');
    await settle();
    expect(interrupts.isPending('main')).toBe(false);
    expect(calls.at(-1)).toBe('abort main (r)');
  });

  test("a tool wait with no stream: the kept interrupt waits through the tools' traces, which name no agent, for the next agent trace", async () => {
    const { abortable, calls, interrupts } = harness();
    interrupts.onTrace({ type: 'inference:started', agentName: 'main' });
    expect(interrupts.interrupt('main', 'r')).toBe('deferred');
    for (const type of ['tool:started', 'tool:completed']) interrupts.onTrace({ type });
    await settle();
    expect(calls).toEqual(['abort main (r)']);
    abortable.add('main');
    interrupts.onTrace({ type: 'inference:tokens', agentName: 'main' });
    await settle();
    expect(calls).toEqual(['abort main (r)', 'abort main (r)']);
    expect(interrupts.isPending('main')).toBe(false);
  });

  test('a second interrupt that aborts at once takes the kept one with it: the turn is aborted once', async () => {
    const { abortable, calls, interrupts, trace } = harness();
    trace('inference:started');
    expect(interrupts.interrupt('main', 'first')).toBe('deferred');
    abortable.add('main');
    expect(interrupts.interrupt('main', 'second')).toBe('aborted');
    expect(interrupts.isPending('main')).toBe(false);
    trace('inference:tokens');
    await settle();
    expect(calls).toEqual(['abort main (first)', 'abort main (second)']);
  });

  test("each agent's interrupt is its own", async () => {
    const { abortable, calls, interrupts, trace } = harness();
    trace('inference:started', 'main');
    trace('inference:started', 'helper');
    expect(interrupts.interrupt('main', 'r')).toBe('deferred');
    abortable.add('main');
    abortable.add('helper');
    trace('inference:tokens', 'helper');
    await settle();
    expect(interrupts.isPending('main')).toBe(true);
    trace('inference:tokens', 'main');
    await settle();
    expect(interrupts.isPending('main')).toBe(false);
    expect(calls).toEqual(['abort main (r)', 'abort main (r)']);
  });

  test("a kept interrupt's abort that throws is caught and logged once, and the interrupt stays for the next trace", async () => {
    let throws = true;
    let inFlight = false;
    const calls: string[] = [];
    const interrupts = new TurnInterrupts((agentName) => {
      calls.push(`abort ${agentName}`);
      if (inFlight && throws) throw new Error('cancel failed');
      return inFlight;
    });
    const logged: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      interrupts.onTrace({ type: 'inference:started', agentName: 'main' });
      expect(interrupts.interrupt('main', 'r')).toBe('deferred');
      inFlight = true;
      // Two traces whose aborts throw: tried at each, logged once.
      interrupts.onTrace({ type: 'inference:tokens', agentName: 'main' });
      await settle();
      interrupts.onTrace({ type: 'inference:tokens', agentName: 'main' });
      await settle();
      expect(logged).toEqual(["[interrupt] aborting main's turn failed: cancel failed"]);
      expect(interrupts.isPending('main')).toBe(true);
      throws = false;
      interrupts.onTrace({ type: 'inference:tokens', agentName: 'main' });
      await settle();
      expect(interrupts.isPending('main')).toBe(false);
      expect(calls).toEqual(['abort main', 'abort main', 'abort main', 'abort main']);
      // A later interrupt whose abort throws is logged again.
      throws = true;
      interrupts.onTrace({ type: 'inference:started', agentName: 'main' });
      expect(interrupts.interrupt('main', 'r')).toBe('deferred');
      expect(logged).toHaveLength(2);
    } finally {
      console.error = error;
    }
  });

  test('an immediate abort that throws is read as nothing aborted: kept while a turn runs, idle otherwise, and logged once per interrupt', () => {
    const interrupts = new TurnInterrupts(() => { throw new Error('cancel failed'); });
    const logged: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      expect(interrupts.interrupt('main', 'r')).toBe('idle');
      expect(interrupts.isPending('main')).toBe(false);
      interrupts.onTrace({ type: 'inference:started', agentName: 'main' });
      expect(interrupts.interrupt('main', 'r')).toBe('deferred');
      expect(interrupts.isPending('main')).toBe(true);
      expect(logged).toEqual([
        "[interrupt] aborting main's turn failed: cancel failed",
        "[interrupt] aborting main's turn failed: cancel failed",
      ]);
    } finally {
      console.error = error;
    }
  });

  test('a turn that settles before the queued abort runs is not aborted', async () => {
    const { abortable, calls, interrupts, trace } = harness();
    trace('inference:started');
    expect(interrupts.interrupt('main', 'r')).toBe('deferred');
    abortable.add('main');
    // The trace queues the abort; the turn ends before it runs.
    trace('inference:tokens');
    trace('inference:completed');
    await settle();
    expect(calls).toEqual(['abort main (r)']);
  });

  test('reset forgets every running turn and kept interrupt', () => {
    const { calls, interrupts, trace } = harness();
    trace('inference:started');
    expect(interrupts.interrupt('main', 'r')).toBe('deferred');
    interrupts.reset();
    expect(interrupts.isPending('main')).toBe(false);
    expect(interrupts.isRunning('main')).toBe(false);
    expect(interrupts.interrupt('main', 'r')).toBe('idle');
    expect(calls).toEqual(['abort main (r)', 'abort main (r)']);
  });

  test('a turn runs from its start until it settles, through a failed attempt', () => {
    const { interrupts, trace } = harness();
    expect(interrupts.isRunning('main')).toBe(false);
    trace('inference:started');
    expect(interrupts.isRunning('main')).toBe(true);
    // A failed attempt may be tried again: the turn is still running.
    trace('inference:failed');
    expect(interrupts.isRunning('main')).toBe(true);
    expect(interrupts.isRunning('other')).toBe(false);
    for (const end of ['inference:completed', 'inference:turn_ended', 'inference:aborted', 'inference:exhausted']) {
      trace('inference:started');
      trace(end);
      expect(interrupts.isRunning('main')).toBe(false);
    }
  });

  test("a turn whose start the follower missed runs from its tool call or resumed stream, and an interrupt is kept for it", async () => {
    for (const shown of ['inference:tool_calls_yielded', 'inference:stream_resumed']) {
      const { abortable, interrupts, trace } = harness();
      trace(shown);
      expect(interrupts.isRunning('main')).toBe(true);
      expect(interrupts.interrupt('main', 'interrupted')).toBe('deferred');
      abortable.add('main');
      trace('inference:tokens');
      await settle();
      expect(interrupts.isPending('main')).toBe(false);
    }
  });

  test("a turn whose start the follower missed, failing before a tool call or a resumed stream, doesn't count as running", () => {
    const { interrupts, trace } = harness();
    trace('inference:tokens');
    trace('inference:failed');
    expect(interrupts.isRunning('main')).toBe(false);
    expect(interrupts.interrupt('main', 'interrupted')).toBe('idle');
  });
});

describe('interruptSubagents', () => {
  test("each subagent's turn goes to the follower before the runs are stopped: a streaming one is aborted, a compiling one kept", async () => {
    const order: string[] = [];
    let runsStopped = false;
    // A streaming turn can be aborted until the module's stop has cancelled
    // its stream and left the agent idle.
    const streaming = new Set(['sub-streaming']);
    const interrupts = new TurnInterrupts((agentName) => {
      order.push(`abort ${agentName}`);
      return !runsStopped && streaming.has(agentName);
    });
    for (const agentName of ['main', 'sub-streaming', 'sub-compiling']) interrupts.onTrace({ type: 'inference:started', agentName });
    const result = interruptSubagents(
      ['main', 'sub-streaming', 'sub-compiling'],
      (name) => name.startsWith('sub-'),
      interrupts,
      () => { order.push('stop runs'); runsStopped = true; return 2; },
      'interrupted',
    );
    expect(order).toEqual(['abort sub-streaming', 'abort sub-compiling', 'stop runs']);
    expect(result).toEqual({ stopped: 2, aborted: ['sub-streaming'], deferred: ['sub-compiling'] });
    expect(interrupts.isPending('sub-compiling')).toBe(true);
    expect(interrupts.isPending('main')).toBe(false);
  });
});
