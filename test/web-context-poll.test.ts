/**
 * The Context panel's reads (web/src/Context.tsx): the makeup and the
 * coverage each through a LatestRead, the coverage also polled every five
 * seconds. No bun test mounts the panel, so this drives its reads' schedule,
 * and reads the panel's source for the two calls that wire it: the tick's
 * read is a poll, and the coverage read has a timeout.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { LatestRead, readFigure } from '../web/src/latest-read.js';

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

// Host #485 bot review wave 3, finding 17: a tick starts no read while one is
// pending, so a coverage read that never answered stopped the poll until a
// scope change or a refresh. The read fails at its timeout instead.
describe('a coverage read that never answers', () => {
  test('fails at its timeout, so the next tick starts a read', async () => {
    const host = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Promise<Response>(() => {}) });
    try {
      const reads = new LatestRead();
      const hung = reads.poll()!;
      const failed = await readFigure(`http://127.0.0.1:${host.port}/debug/context/coverage`, 50)
        .then(() => null, (e: unknown) => e as Error);
      reads.settled(hung);
      expect(failed?.message).toBe("The host didn't answer in 0.05 s.");
      expect(reads.poll()).not.toBeNull();
    } finally {
      host.stop(true);
    }
  }, 2_000);
});

// Host #485 bot review wave 3, finding 27: the tests above drive LatestRead
// alone, so a tick that asked for a read (`loadCoverage()`, which supersedes
// the pending one) would pass them, and so would a coverage read with no
// timeout. The panel's source is read for both.
describe("the panel's wiring", () => {
  const panel = readFileSync(new URL('../web/src/Context.tsx', import.meta.url), 'utf8');

  test("the five-second tick's read is a poll", () => {
    expect(panel).toMatch(/setInterval\(\(\) => void loadCoverage\(true\), 5_000\)/);
  });

  test('the coverage read has the timeout', () => {
    expect(panel).toMatch(/readFigure<Coverage>\([^;]*, READ_TIMEOUT_MS\)/);
  });
});
