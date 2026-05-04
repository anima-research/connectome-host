/**
 * Verifies FleetModule's reducer-required event union.
 *
 * Recipe authors can specify a narrow per-child subscription (to keep the
 * wire lean), but the unified-tree rendering needs a specific set of events
 * to avoid drifting. The framework forces those into every subscribe sent
 * to a child — recipes can extend the set, never narrow it below rendering's
 * floor.
 */
import { describe, test, expect } from 'bun:test';
import { unionWithReducerRequired } from '../src/modules/fleet-module.js';
import { REDUCER_REQUIRED_EVENTS } from '../src/state/agent-tree-reducer.js';

describe('unionWithReducerRequired', () => {
  test('adds all reducer-required events when none are present', () => {
    const result = new Set(unionWithReducerRequired(['lifecycle']));
    expect(result.has('lifecycle')).toBe(true);
    for (const required of REDUCER_REQUIRED_EVENTS) {
      expect(result.has(required)).toBe(true);
    }
  });

  test('leaves subscription unchanged when * is already present', () => {
    const result = unionWithReducerRequired(['*']);
    expect(result).toEqual(['*']);
  });

  test('does not duplicate events already present', () => {
    const subscription = ['lifecycle', 'inference:tool_calls_yielded', 'inference:completed'];
    const result = unionWithReducerRequired(subscription);
    const counts = new Map<string, number>();
    for (const e of result) counts.set(e, (counts.get(e) ?? 0) + 1);
    for (const [event, count] of counts) {
      expect(count).toBe(1);
    }
    expect(result).toContain('lifecycle');
  });

  test('honours prefix-glob coverage (tool:* covers tool:started, tool:completed, tool:failed)', () => {
    const result = unionWithReducerRequired(['lifecycle', 'tool:*']);
    expect(result).not.toContain('tool:started');
    expect(result).not.toContain('tool:completed');
    expect(result).not.toContain('tool:failed');
    // But inference:* events still need to be added
    expect(result).toContain('inference:tool_calls_yielded');
  });

  test('honours inference:* glob coverage', () => {
    const result = unionWithReducerRequired(['inference:*', 'lifecycle']);
    expect(result).not.toContain('inference:tool_calls_yielded');
    expect(result).not.toContain('inference:tokens');
    // tool:* still needed
    expect(result).toContain('tool:started');
  });

  test('the postmortem-broken triumvirate subscription gets the missing events back', () => {
    // Exact subscription from triumvirate.json that caused the rendering gap.
    const recipeSubscription = [
      'lifecycle',
      'inference:completed',
      'inference:speech',
      'tool:completed',
      'tool:failed',
      'inference:failed',
    ];
    const result = new Set(unionWithReducerRequired(recipeSubscription));
    // Recipe-specified events still present:
    expect(result.has('lifecycle')).toBe(true);
    expect(result.has('inference:speech')).toBe(true);
    // Reducer-required events that were missing get added:
    expect(result.has('inference:tool_calls_yielded')).toBe(true);
    expect(result.has('inference:started')).toBe(true);
    expect(result.has('inference:tokens')).toBe(true);
    expect(result.has('inference:usage')).toBe(true);
    expect(result.has('tool:started')).toBe(true);
  });

  test('returns a fresh array (caller can mutate without affecting input)', () => {
    const input = ['lifecycle'];
    const result = unionWithReducerRequired(input);
    expect(result).not.toBe(input);
    result.push('extra');
    expect(input).toEqual(['lifecycle']);
  });
});
