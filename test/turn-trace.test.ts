/**
 * The shared end sets (state/turn-trace.ts), pinned to agent-framework
 * 0.22.3's five stream ends. Other tests loop over these sets, so a member
 * taken out or added has to fail here.
 */
import { describe, expect, test } from 'bun:test';
import { STREAM_END_TRACES, TURN_SETTLED_TRACES, traceError } from '../src/state/turn-trace.js';

describe('the end sets', () => {
  test('every stream end', () => {
    expect([...STREAM_END_TRACES].sort()).toEqual([
      'inference:aborted',
      'inference:completed',
      'inference:exhausted',
      'inference:failed',
      'inference:turn_ended',
    ]);
  });

  test('the ends after which nothing of the turn runs: every end but failed', () => {
    expect([...TURN_SETTLED_TRACES].sort()).toEqual([
      'inference:aborted',
      'inference:completed',
      'inference:exhausted',
      'inference:turn_ended',
    ]);
  });
});

describe('traceError', () => {
  test("a failed or exhausted trace's error, or 'Unknown error' when it's missing, empty or not text", () => {
    expect(traceError({ error: 'overloaded' })).toBe('overloaded');
    expect(traceError({})).toBe('Unknown error');
    for (const error of [undefined, null, '', '  \n', 42, { message: 'overloaded' }]) {
      expect({ error, said: traceError({ error }) }).toEqual({ error, said: 'Unknown error' });
    }
  });
});
