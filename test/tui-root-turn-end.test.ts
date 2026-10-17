/**
 * The TUI's status line at the end of the root agent's stream (rootTurnEnd):
 * every stream end returns it from "thinking", a turn a tool ended included,
 * an end that follows an end adds nothing, and a failure always shows.
 * rootTurnStep moves the flag that says a turn is showing. Escape's gate and
 * line are pinned here too; test/tui-turns.test.ts runs runTui itself.
 */
import { describe, expect, test } from 'bun:test';
import { escapeActs, escapeLine, peekEndLine, rootTurnEnd, rootTurnStep } from '../src/tui.js';
import { STREAM_END_TRACES } from '../src/state/turn-trace.js';

describe('rootTurnEnd', () => {
  test('every stream end ends a turn that is showing', () => {
    for (const type of STREAM_END_TRACES) {
      expect(rootTurnEnd({ type, error: 'x' }, true)).not.toBeNull();
    }
  });

  test('a normal end and a turn a tool ended both go idle and show a backgrounded turn', () => {
    expect(rootTurnEnd({ type: 'inference:completed' }, true)).toEqual({ status: 'idle', background: 'show' });
    expect(rootTurnEnd({ type: 'inference:turn_ended' }, true)).toEqual({ status: 'idle', background: 'show' });
  });

  test('a failure shows its error', () => {
    expect(rootTurnEnd({ type: 'inference:failed', error: 'overloaded' }, true)).toEqual({
      status: 'error', background: 'drop', line: { text: 'Error: overloaded', tone: 'error' },
    });
  });

  test("an end whose error is empty or missing says 'Unknown error'", () => {
    expect(rootTurnEnd({ type: 'inference:failed', error: '' }, true)?.line?.text).toBe('Error: Unknown error');
    expect(rootTurnEnd({ type: 'inference:exhausted' }, true)?.line?.text).toBe('(turn ended: Unknown error)');
  });

  test('an abort goes idle and names its reason when it has one', () => {
    expect(rootTurnEnd({ type: 'inference:aborted', reason: 'quiesce_abandoned' }, true)).toEqual({
      status: 'idle', background: 'drop', line: { text: '(turn aborted: quiesce_abandoned)', tone: 'note' },
    });
    expect(rootTurnEnd({ type: 'inference:aborted' }, true)?.line?.text).toBe('(turn aborted)');
  });

  test('an exhausted stream that nothing ended before goes idle with the framework\'s words', () => {
    expect(rootTurnEnd({ type: 'inference:exhausted', error: 'Stream aborted: user' }, true)).toEqual({
      status: 'idle', background: 'drop', line: { text: '(turn ended: Stream aborted: user)', tone: 'note' },
    });
  });

  test('an end while no turn is showing adds nothing, but a failure', () => {
    // `exhausted` after `failed` or `aborted`, or after the TUI's own interrupt.
    for (const type of STREAM_END_TRACES) {
      if (type !== 'inference:failed') expect(rootTurnEnd({ type, error: 'x' }, false)).toBeNull();
    }
    // agent-framework sends a failure only for an attempt it started, so it's
    // the end of a turn whose start the TUI didn't follow: it shows.
    expect(rootTurnEnd({ type: 'inference:failed', error: 'overloaded' }, false)).toEqual({
      status: 'error', background: 'drop', line: { text: 'Error: overloaded', tone: 'error' },
    });
  });

  test('a trace that is not a stream end changes nothing', () => {
    for (const type of ['inference:started', 'inference:stream_resumed', 'inference:tokens', 'inference:stream_restarted']) {
      expect(rootTurnEnd({ type }, true)).toBeNull();
    }
  });
});

describe('rootTurnStep', () => {
  test('a start shows a turn, and its first end ends it, once', () => {
    let step = rootTurnStep(false, { type: 'inference:started' });
    expect(step).toEqual({ showing: true, end: null });
    step = rootTurnStep(step.showing, { type: 'inference:failed', error: 'overloaded' });
    expect(step.showing).toBe(false);
    expect(step.end?.line?.text).toBe('Error: overloaded');
    step = rootTurnStep(step.showing, { type: 'inference:exhausted', error: 'overloaded' });
    expect(step).toEqual({ showing: false, end: null });
  });

  test('each of the five ends ends a turn that is showing', () => {
    for (const type of ['inference:completed', 'inference:turn_ended', 'inference:aborted', 'inference:failed', 'inference:exhausted']) {
      const step = rootTurnStep(true, { type, error: 'x' });
      expect(step.showing).toBe(false);
      expect(step.end).not.toBeNull();
    }
  });

  test('a retry\'s start shows the turn again after a failure', () => {
    const failed = rootTurnStep(true, { type: 'inference:failed', error: 'overloaded' });
    const retry = rootTurnStep(failed.showing, { type: 'inference:started' });
    expect(retry.showing).toBe(true);
    expect(rootTurnStep(retry.showing, { type: 'inference:completed' }).end).toEqual({ status: 'idle', background: 'show' });
  });

  test('a running turn\'s tool calls and resumed stream show it, so its own end shows', () => {
    for (const type of ['inference:tool_calls_yielded', 'inference:stream_resumed']) {
      const running = rootTurnStep(false, { type });
      expect(running).toEqual({ showing: true, end: null });
      expect(rootTurnStep(running.showing, { type: 'inference:completed' }).end).toEqual({ status: 'idle', background: 'show' });
    }
  });

  test('any other trace leaves the flag as it is', () => {
    for (const showing of [true, false]) {
      for (const type of ['inference:tokens', 'inference:content_block', 'inference:usage', 'tool:started']) {
        expect(rootTurnStep(showing, { type })).toEqual({ showing, end: null });
      }
    }
  });
});

describe('peekEndLine', () => {
  test("each of a subagent stream's ends but its completion shows its own line in the peek view", () => {
    expect(peekEndLine({ type: 'inference:turn_ended' })).toEqual({ text: '── turn ended by a tool ──', tone: 'dim' });
    expect(peekEndLine({ type: 'inference:aborted', reason: 'user' })).toEqual({ text: '✗ turn aborted: user', tone: 'warn' });
    expect(peekEndLine({ type: 'inference:aborted' })).toEqual({ text: '✗ turn aborted', tone: 'warn' });
    expect(peekEndLine({ type: 'inference:aborted', reason: '' })).toEqual({ text: '✗ turn aborted', tone: 'warn' });
    expect(peekEndLine({ type: 'inference:failed', error: 'overloaded' })).toEqual({ text: '✗ inference failed: overloaded', tone: 'error' });
    expect(peekEndLine({ type: 'inference:exhausted', error: 'Unknown error' })).toEqual({ text: '✗ turn ended: Unknown error', tone: 'error' });
    expect(peekEndLine({ type: 'inference:completed' })).toBeNull();
    expect(peekEndLine({ type: 'inference:tokens' })).toBeNull();
  });

  test("an end whose error is missing or empty says 'Unknown error'", () => {
    expect(peekEndLine({ type: 'inference:failed' })).toEqual({ text: '✗ inference failed: Unknown error', tone: 'error' });
    expect(peekEndLine({ type: 'inference:exhausted', error: '' })).toEqual({ text: '✗ turn ended: Unknown error', tone: 'error' });
  });
});

describe('escapeLine', () => {
  test("Escape's line for each outcome, and whether it shows the turn as ended itself", () => {
    expect(escapeLine('aborted', '')).toEqual({ text: null, endsTurn: false });
    expect(escapeLine('aborted', '2 subagents stopped')).toEqual({ text: '  (2 subagents stopped)', endsTurn: false });
    expect(escapeLine('deferred', '')).toEqual({ text: '  (interrupting: the turn stops as soon as it can be aborted)', endsTurn: false });
    expect(escapeLine('deferred', '1 subagent stopped'))
      .toEqual({ text: '  (interrupting: the turn stops as soon as it can be aborted; 1 subagent stopped)', endsTurn: false });
    expect(escapeLine('idle', '')).toEqual({ text: '  (no turn interrupted)', endsTurn: true });
    expect(escapeLine('idle', '1 subagent stopped')).toEqual({ text: '  (no turn interrupted — 1 subagent stopped)', endsTurn: true });
  });
});

describe('escapeActs', () => {
  test('Escape acts while the status line shows a turn, not when idle or while the host switches sessions', () => {
    for (const running of [false, true]) {
      expect(escapeActs('idle', running)).toBe(false);
      expect(escapeActs('switching', running)).toBe(false);
      for (const status of ['thinking', 'tools', 'background', 'queued']) expect(escapeActs(status, running)).toBe(true);
    }
  });

  test('on an error, only while the follower has the root\'s turn running, whatever set the error', () => {
    expect(escapeActs('error', true)).toBe(true);
    // An error shown with no turn running stands.
    expect(escapeActs('error', false)).toBe(false);
  });
});
