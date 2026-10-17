import { describe, expect, test } from 'bun:test';
import { applyAwarenessMessage, emptyAwarenessView } from '../web/src/awareness-state.js';

const batch = { kind: 'batch' as const, id: 'b1', status: 'active' };

describe("the branch panel's awareness journal view", () => {
  test("a listing that succeeds after one failed clears the failure, and lists the live journal", () => {
    const failed = applyAwarenessMessage(emptyAwarenessView, { type: 'awareness', batches: [], error: 'temporary journal read failure' });
    expect(failed).toEqual({ entries: [], instance: null, result: { error: 'temporary journal read failure' } });
    const recovered = applyAwarenessMessage(failed, { type: 'awareness', batches: [batch], frameworkInstanceId: 'fw-1' });
    expect(recovered).toEqual({ entries: [batch], instance: 'fw-1', result: null });
  });

  test("an action's outcome stays on screen through later listings, until the next action or a failed listing", () => {
    const acted = applyAwarenessMessage(emptyAwarenessView, {
      type: 'awareness', batches: [batch], frameworkInstanceId: 'fw-1', action: 'cancel', target: 'b1', receipt: { cancelled: 2 },
    });
    const outcome = { action: 'cancel', target: 'b1', receipt: { cancelled: 2 }, error: undefined };
    expect(acted.result).toEqual(outcome);
    // The broadcast after a surgery, or a refresh, lists the journal again.
    const listed = applyAwarenessMessage(acted, { type: 'awareness', batches: [batch], frameworkInstanceId: 'fw-1' });
    expect(listed.result).toEqual(outcome);
    const refused = applyAwarenessMessage(listed, {
      type: 'awareness', batches: [batch], frameworkInstanceId: 'fw-2', action: 'retract', target: 'all', error: 'chosen from another journal', code: 'stale',
    });
    expect(refused).toEqual({ entries: [batch], instance: 'fw-2', result: { action: 'retract', target: 'all', receipt: undefined, error: 'chosen from another journal' } });
    const failed = applyAwarenessMessage(refused, { type: 'awareness', batches: [], error: 'journal unavailable' });
    expect(failed).toEqual({ entries: [], instance: null, result: { error: 'journal unavailable' } });
  });
});
