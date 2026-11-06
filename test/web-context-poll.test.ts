/**
 * The Context panel's reads (web/src/Context.tsx): the makeup and the
 * coverage each through a LatestRead, the coverage also polled every five
 * seconds. No bun test mounts the panel, so this drives its reads' schedule.
 */
import { describe, expect, test } from 'bun:test';
import { LatestRead } from '../web/src/latest-read.js';

describe("the Context panel's coverage poll", () => {
  test('a tick with no read pending starts one', () => {
    const reads = new LatestRead();
    const read = reads.poll();
    expect(read).not.toBeNull();
    expect(reads.superseded(read!)).toBe(false);
  });

  // A coverage read that takes six seconds outlasts a tick: were the tick to
  // start a read, every response would be dropped before it landed.
  test('a read slower than the poll lands: the ticks while it is pending start none', () => {
    const reads = new LatestRead();
    const slow = reads.poll()!;
    expect(reads.poll()).toBeNull();
    expect(reads.poll()).toBeNull();
    expect(reads.superseded(slow)).toBe(false);
    reads.settled(slow);
    const next = reads.poll();
    expect(next).not.toBeNull();
    expect(reads.superseded(next!)).toBe(false);
  });

  test("a failed read doesn't stop the poll", () => {
    const reads = new LatestRead();
    const failed = reads.poll()!;
    reads.settled(failed);
    expect(reads.poll()).not.toBeNull();
  });
});

describe('a read asked for (a scope change, a refresh)', () => {
  test("supersedes a poll's read still pending", () => {
    const reads = new LatestRead();
    const polled = reads.poll()!;
    const asked = reads.begin();
    expect(reads.superseded(polled)).toBe(true);
    expect(reads.superseded(asked)).toBe(false);
  });

  test("is not cleared as pending by an older read's answer, so a tick still waits for it", () => {
    const reads = new LatestRead();
    const older = reads.begin();
    const newer = reads.begin();
    reads.settled(older);
    expect(reads.poll()).toBeNull();
    reads.settled(newer);
    expect(reads.poll()).not.toBeNull();
  });

  test('supersedes one asked for before it', () => {
    const reads = new LatestRead();
    const first = reads.begin();
    const second = reads.begin();
    expect(reads.superseded(first)).toBe(true);
    expect(reads.superseded(second)).toBe(false);
  });
});
