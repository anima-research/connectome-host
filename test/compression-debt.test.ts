/**
 * One agent's compression debt in the Health tab's words and tone. Since
 * anima-research/context-manager#272, a report that couldn't read something
 * names which read failed (`failure`), says in `error` what happened, what it
 * means and what to do, and gives `null` for each count it couldn't compute.
 * A report from a context-manager before #272 reads as the tab wrote it, but
 * for an age past two hours, now in hours.
 */
import { describe, expect, test } from 'bun:test';
import { debtAge, debtNextStep, debtSummary, debtTone, type CompressionDebt } from '../src/web/compression-debt.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** context-manager #272's message for a ledger the store couldn't read. */
const ledgerError = [
  'Compression of new conversation has stalled.',
  "Cause: the store couldn't read this agent's compression quarantine ledger (EACCES: permission denied).",
  'Effect: chunks that need the model go unsummarized, so in time its context fills and its turns fail until compression catches up.',
  'Fix: fix what the cause names; compression then resumes by itself.',
].join('\n');

/** A report that failed outright, as the new getCompressionDebt() gives it. */
const failed: CompressionDebt = {
  state: 'unknown',
  error: [
    'The compression debt report failed.',
    'Cause: store closed',
    "Effect: the report can't say whether compression is keeping up. Compression itself may be running normally.",
    'Fix: this points to a fault in context-manager or in the options it was given. Report it.',
  ].join('\n'),
  failure: 'report',
  pendingChunks: null,
  oldestPendingAgeMs: null,
  mergeQueueDepth: null,
  mergeQuarantineCount: null,
  compressionQuarantineCount: null,
};

/** A report that couldn't read only the quarantine ledger. */
const ledger = (over: Partial<CompressionDebt>): CompressionDebt => ({
  state: 'unknown',
  error: ledgerError,
  failure: 'quarantine-ledger',
  pendingChunks: 1,
  oldestPendingAgeMs: 20 * MINUTE,
  mergeQueueDepth: 0,
  mergeQuarantineCount: 0,
  compressionQuarantineCount: null,
  ...over,
});

describe('debtSummary', () => {
  test("a report from today's context-manager reads as the tab wrote it, an age past two hours in hours", () => {
    expect(debtSummary({ state: 'healthy', pendingChunks: 0, oldestPendingAgeMs: null, mergeQueueDepth: 0 }))
      .toBe('compression debt: healthy · 0 chunk(s) pending');
    expect(debtSummary({ state: 'degraded', pendingChunks: 3, oldestPendingAgeMs: 2 * HOUR + 24_000, mergeQueueDepth: 2 }))
      .toBe('compression debt: degraded · 3 chunk(s) pending · oldest 2h · merge queue 2');
    expect(debtSummary({ state: 'degraded', pendingChunks: 2, oldestPendingAgeMs: 90 * MINUTE + 36_000, mergeQueueDepth: 0 }))
      .toBe('compression debt: degraded · 2 chunk(s) pending · oldest 91m');
    expect(debtSummary({ state: 'degraded', pendingChunks: 1, oldestPendingAgeMs: null, mergeQueueDepth: 0 }))
      .toBe('compression debt: degraded · 1 chunk(s) pending · age unknown');
    expect(debtSummary({ state: 'healthy' })).toBe('compression debt: healthy');
    expect(debtSummary({})).toBe('compression debt: ?');
  });

  test('an age shows only while chunks are pending', () => {
    expect(debtSummary({ state: 'healthy', pendingChunks: 0, oldestPendingAgeMs: 45 * MINUTE, mergeQueueDepth: 0 }))
      .toBe('compression debt: healthy · 0 chunk(s) pending');
  });

  test("a value the report didn't give as a number or text isn't shown as one", () => {
    expect(debtSummary({ state: 'degraded', pendingChunks: 1, oldestPendingAgeMs: 'soon' as never, mergeQueueDepth: '2' as never }))
      .toBe('compression debt: degraded · 1 chunk(s) pending · age unknown');
    expect(debtSummary({ state: 'degraded', pendingChunks: 1, oldestPendingAgeMs: false as never }))
      .toBe('compression debt: degraded · 1 chunk(s) pending · age unknown');
    expect(debtSummary({ state: {} as never })).toBe('compression debt: ?');
  });

  test("when the ledger compression needs can't be read, the head says compression has stalled, with the counts it read", () => {
    expect(debtSummary(ledger({}))).toBe('compression has stalled · 1 chunk(s) pending · oldest 20m');
    expect(debtSummary(ledger({ state: 'degraded', pendingChunks: 4, oldestPendingAgeMs: 3 * HOUR })))
      .toBe('compression has stalled · 4 chunk(s) pending · oldest 3h');
    expect(debtSummary(ledger({ state: 'critical', pendingChunks: 5, oldestPendingAgeMs: 7 * HOUR })))
      .toBe('compression has stalled · critical · 5 chunk(s) pending · oldest 7h');
  });

  test("when the report itself failed, the head says the debt can't be checked, and no count it couldn't compute is shown", () => {
    expect(debtSummary(failed)).toBe("compression debt can't be checked");
    expect(debtSummary({ failure: 'report', error: failed.error })).toBe("compression debt can't be checked");
    expect(debtSummary({ state: 'unknown' })).toBe("compression debt can't be checked");
  });
});

describe('debtAge', () => {
  test('rounded: minutes under two hours, hours from there', () => {
    expect(debtAge(119 * MINUTE + 29_000)).toBe('119m');
    expect(debtAge(119 * MINUTE + 31_000)).toBe('2h');
    expect(debtAge(150 * MINUTE)).toBe('3h');
    expect(debtAge(149 * MINUTE)).toBe('2h');
  });
});

describe('debtNextStep', () => {
  test("the host's own next step under a message: /bug for a fault in the report, and, as a condition the reader judges, for any ledger failure", () => {
    expect(debtNextStep(failed)).toBe('To report it, run /bug, saying in your own words what this message shows.');
    expect(debtNextStep(ledger({})))
      .toBe("If the store's error says its data is damaged, nothing here repairs it: run /bug, saying in your own words what this message shows.");
    expect(debtNextStep({ state: 'unknown', failure: 'report' })).toBeUndefined();
    expect(debtNextStep({ state: 'unknown' })).toBeUndefined();
    expect(debtNextStep({ state: 'critical', pendingChunks: 5 })).toBeUndefined();
  });
});

describe('debtTone', () => {
  test("critical is an alarm, a report that couldn't read something is toned as a read that failed, and degraded warns", () => {
    expect(debtTone({ state: 'critical' })).toBe('alarm');
    expect(debtTone(ledger({ state: 'critical' }))).toBe('alarm');
    expect(debtTone(failed)).toBe('unread');
    expect(debtTone(ledger({ state: 'degraded' }))).toBe('unread');
    expect(debtTone({ state: 'unknown' })).toBe('unread');
    expect(debtTone({ state: 'degraded' })).toBe('warn');
    expect(debtTone({ state: 'healthy' })).toBe('quiet');
    expect(debtTone({ state: 'healthy', failure: null as never })).toBe('quiet');
    expect(debtTone({})).toBe('quiet');
  });
});
