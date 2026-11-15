import { describe, expect, test } from 'bun:test';
import { HealthReads, passedGrant } from '../web/src/health-reads.js';

describe("the page's /healthz reads", () => {
  test('a page starts out reading, with nothing refused', () => {
    const reads = new HealthReads();
    expect(reads.denied).toBe(false);
    expect(reads.takeLocal(reads.ask())).toBe(true);
  });

  test('a refusal stops the reads, and a later read that went through starts them again', () => {
    const reads = new HealthReads();
    const refused = reads.ask();
    const later = reads.ask();
    expect(reads.refused(refused)).toBe(true);
    expect(reads.denied).toBe(true);
    reads.answered(later);
    expect(reads.denied).toBe(false);
  });

  test("a refusal that answers after a later read went through isn't the word on the grant", () => {
    const reads = new HealthReads();
    const refused = reads.ask();
    const later = reads.ask();
    reads.answered(later);
    expect(reads.refused(refused)).toBe(false);
    expect(reads.denied).toBe(false);
  });

  test("a read that went through before a later refusal doesn't start the reads again", () => {
    const reads = new HealthReads();
    const earlier = reads.ask();
    const refused = reads.ask();
    expect(reads.refused(refused)).toBe(true);
    reads.answered(earlier);
    expect(reads.denied).toBe(true);
  });

  test('every answer but a refusal passed the grant, and a 503 counted after a refusal starts the reads again', () => {
    for (const status of [200, 404, 500, 502, 503]) expect(passedGrant(status)).toBe(true);
    for (const status of [401, 403]) expect(passedGrant(status)).toBe(false);
    const reads = new HealthReads();
    const refused = reads.ask();
    const forced = reads.ask();
    expect(reads.refused(refused)).toBe(true);
    if (passedGrant(503)) reads.answered(forced);
    expect(reads.denied).toBe(false);
  });

  test('the page takes the newest local snapshot, whatever order they answer in', () => {
    const reads = new HealthReads();
    const first = reads.ask();
    const second = reads.ask();
    const third = reads.ask();
    expect(reads.takeLocal(second)).toBe(true);
    expect(reads.takeLocal(first)).toBe(false);
    expect(reads.takeLocal(third)).toBe(true);
  });
});
