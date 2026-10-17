/**
 * The Web UI's interrupt: each agent's turn goes to the turn follower, which
 * aborts it through the framework at once, or as soon as it can be, and an
 * agent with no turn running is left as it is. The subagents' turns go
 * first, then their runs are stopped, then every other agent's turn.
 */
import { describe, expect, test } from 'bun:test';
import { interruptPage, interruptReply } from '../src/modules/web-ui-module.js';
import { TurnInterrupts, interruptAgents } from '../src/state/turn-interrupt.js';

describe('interruptAgents', () => {
  test("aborts each agent's turn with the reason, at once or once it can, and leaves an agent with no turn alone", async () => {
    const calls: string[] = [];
    const inFlight = new Set(['main']);
    const interrupts = new TurnInterrupts((agentName, reason) => {
      calls.push(`abortInference ${agentName} (${reason})`);
      return inFlight.has(agentName);
    });
    for (const agentName of ['main', 'compiling']) interrupts.onTrace({ type: 'inference:started', agentName });
    const result = interruptAgents(['main', 'compiling', 'idle'], interrupts, 'interrupted from the Web UI');
    expect(result).toEqual({ aborted: ['main'], deferred: ['compiling'] });
    expect(calls).toEqual([
      'abortInference main (interrupted from the Web UI)',
      'abortInference compiling (interrupted from the Web UI)',
      'abortInference idle (interrupted from the Web UI)',
    ]);
    // The compiling turn's call goes out: it's aborted at its next trace.
    inFlight.add('compiling');
    interrupts.onTrace({ type: 'inference:tokens', agentName: 'compiling' });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(calls.at(-1)).toBe('abortInference compiling (interrupted from the Web UI)');
    expect(interrupts.isPending('compiling')).toBe(false);
  });

  test("an agent whose abort throws doesn't stop the rest: the follower reads the throw as nothing aborted", () => {
    const calls: string[] = [];
    const interrupts = new TurnInterrupts((agentName) => {
      calls.push(agentName);
      if (agentName === 'helper') throw new Error('gone');
      return agentName === 'main';
    });
    interrupts.onTrace({ type: 'inference:started', agentName: 'helper' });
    const error = console.error;
    console.error = () => {};
    try {
      const result = interruptAgents(['main', 'helper', 'idle'], interrupts, 'r');
      expect(calls).toEqual(['main', 'helper', 'idle']);
      expect(result).toEqual({ aborted: ['main'], deferred: ['helper'] });
    } finally {
      console.error = error;
    }
  });
});

describe('interruptPage', () => {
  /** The page's agents: the root, a subagent whose stream is open, and one
   *  still compiling. stopRuns stands in for the subagent module's
   *  cancelAll, which cancels an open stream and leaves the agent idle. */
  function page() {
    const order: string[] = [];
    let runsStopped = false;
    const streaming = new Set(['main', 'spawn-streaming']);
    const interrupts = new TurnInterrupts((agentName) => {
      order.push(`abort ${agentName}`);
      return streaming.has(agentName) && !(runsStopped && agentName.startsWith('spawn-'));
    });
    for (const agentName of ['main', 'spawn-streaming', 'spawn-compiling']) interrupts.onTrace({ type: 'inference:started', agentName });
    const stopRuns = () => { order.push('stop runs'); runsStopped = true; return 2; };
    return { order, interrupts, stopRuns };
  }
  const isSubagent = (name: string) => name.startsWith('spawn-');

  test("takes the subagents' turns first, then stops their runs, then the rest, and names only the turns it kept", () => {
    const { order, interrupts, stopRuns } = page();
    const reply = interruptPage(['main', 'spawn-streaming', 'spawn-compiling'], isSubagent, interrupts, stopRuns);
    expect(order).toEqual(['abort spawn-streaming', 'abort spawn-compiling', 'stop runs', 'abort main']);
    expect(reply).toBe('interrupted — 2 subagent(s) stopped; spawn-compiling stopping as soon as its turn can be aborted');
    // The compiling subagent's turn goes on past its run's stop: it's aborted
    // once it can be.
    expect(interrupts.isPending('spawn-compiling')).toBe(true);
    expect(interrupts.isPending('spawn-streaming')).toBe(false);
  });

  test("a subagent whose stream was open isn't named as stopping later", () => {
    const { interrupts, stopRuns } = page();
    expect(interruptPage(['main', 'spawn-streaming'], isSubagent, interrupts, stopRuns)).toBe('interrupted — 2 subagent(s) stopped');
  });

  test('a subagent its runs\' stop lets go of at once is still taken once, before the stop', () => {
    const { order, interrupts } = page();
    let stopped = false;
    // A subagent module that drops its index at once when it stops the runs.
    const isLive = (name: string) => !stopped && name.startsWith('spawn-');
    const reply = interruptPage(['main', 'spawn-compiling'], isLive, interrupts, () => { order.push('stop runs'); stopped = true; return 1; });
    expect(order).toEqual(['abort spawn-compiling', 'stop runs', 'abort main']);
    expect(reply).toBe('interrupted — 1 subagent(s) stopped; spawn-compiling stopping as soon as its turn can be aborted');
  });

  test('with no follower, the subagent runs are still stopped', () => {
    const { order, stopRuns } = page();
    expect(interruptPage(['main', 'spawn-streaming'], isSubagent, undefined, stopRuns)).toBe('interrupted — 2 subagent(s) stopped');
    expect(order).toEqual(['stop runs']);
  });

  test("gives every abort the Web UI's reason, and names another agent's kept turn as well as a subagent's", () => {
    const calls: string[] = [];
    const interrupts = new TurnInterrupts((agentName, reason) => {
      calls.push(`${agentName}: ${reason}`);
      return agentName === 'main';
    });
    for (const agentName of ['main', 'subconscious', 'spawn-compiling']) interrupts.onTrace({ type: 'inference:started', agentName });
    const reply = interruptPage(['main', 'subconscious', 'spawn-compiling'], isSubagent, interrupts, () => 1);
    expect(calls).toEqual([
      'spawn-compiling: interrupted from the Web UI',
      'main: interrupted from the Web UI',
      'subconscious: interrupted from the Web UI',
    ]);
    expect(reply).toBe('interrupted — 1 subagent(s) stopped; spawn-compiling, subconscious stopping as soon as their turns can be aborted');
  });
});

describe('interruptReply', () => {
  test('says what the interrupt stopped, and which turns stop only once they can be aborted', () => {
    expect(interruptReply(0, ['main'], [])).toBe('interrupted');
    expect(interruptReply(2, [], [])).toBe('interrupted — 2 subagent(s) stopped');
    expect(interruptReply(0, [], ['main'])).toBe('interrupted — main stopping as soon as its turn can be aborted');
    expect(interruptReply(1, ['other'], ['main', 'helper'])).toBe('interrupted — 1 subagent(s) stopped; main, helper stopping as soon as their turns can be aborted');
  });

  test('says no turn was interrupted when it aborted, kept and stopped nothing', () => {
    expect(interruptReply(0, [], [])).toBe('no turn interrupted');
  });
});
