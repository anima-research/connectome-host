/**
 * The compression quarantine's count, in the words the ops alert, the Web
 * UI's alert row and its Health tab use: spans when context-manager lists
 * them, and otherwise records, never records called spans or chunks. And
 * what the host's ops alert sends for each call of context-manager's alarm.
 */
import { describe, expect, test } from 'bun:test';
import { quarantineAlarm, quarantineHeld, quarantineSpans, type QuarantineStatus } from '../src/web/quarantine-alert.js';

/** A span as context-manager#138, unreleased, lists it in its status (its
 *  CompressionQuarantineSpan); the installed context-manager lists none.
 *  The module reads only the list's length. */
function span(n: number, records: number) {
  return {
    chunkSourceHash: `hash-${n}`,
    firstMessageId: `m${n}a`,
    lastMessageId: `m${n}z`,
    closedAgeMs: 60_000 * n,
    quarantinedAt: 1_760_000_000_000 + n,
    records,
    answeredAttempts: records,
    latestOutcome: 'refused',
  };
}

describe('quarantineHeld', () => {
  test('a status that lists spans is counted in spans, with its records beside them', () => {
    expect(quarantineHeld({ count: 6, spans: [span(1, 4), span(2, 2)] }))
      .toBe('2 span(s) in compression quarantine (6 record(s))');
  });

  test("a status without spans, from a context-manager that doesn't list them, is counted in records", () => {
    expect(quarantineHeld({ count: 6 })).toBe('6 quarantine record(s) in compression quarantine (one span can hold several)');
  });

  test('a spans value that is not a list is ignored, so the records are named', () => {
    for (const spans of [2, 'two', { length: 2 }, null]) {
      const q = { count: 3, spans } as unknown as { count: number; spans: unknown[] };
      expect(quarantineSpans(q)).toBeUndefined();
      expect(quarantineHeld(q)).toStartWith('3 quarantine record(s)');
    }
  });

  // A list fits when its length could be the spans among the records.
  test("a list whose length can't fit the records is ignored, so the records are named", () => {
    for (const spans of [[], [span(1, 1), span(2, 1), span(3, 1), span(4, 1)]]) {
      expect(quarantineSpans({ count: 3, spans })).toBeUndefined();
      expect(quarantineHeld({ count: 3, spans })).toStartWith('3 quarantine record(s)');
    }
    expect(quarantineSpans({ count: 3, spans: [span(1, 3)] })).toBe(1);
    expect(quarantineSpans({ count: 3, spans: [span(1, 1), span(2, 1), span(3, 1)] })).toBe(3);
    expect(quarantineSpans({ count: 0, spans: [] })).toBe(0);
    expect(quarantineSpans({ count: 0, spans: [span(1, 1)] })).toBeUndefined();
  });
});

describe('quarantineAlarm', () => {
  const keys = ['k1', 'k2', 'k3'];
  const tail = ' — spans stay raw and WILL eventually exhaust the context budget. Operator action required (inspect refusing content; branch, pin, or clear).';

  test('records held, with spans listed: the alarm counts the spans, and its data is the count and keys', () => {
    expect(quarantineAlarm({ count: 3, keys, spans: [span(1, 2), span(2, 1)] })).toEqual({
      kind: 'compression-quarantine',
      message: `2 span(s) in compression quarantine (3 record(s))${tail}`,
      data: { count: 3, keys },
    });
  });

  test('records held, without spans: the alarm counts the records', () => {
    expect(quarantineAlarm({ count: 3, keys })).toEqual({
      kind: 'compression-quarantine',
      message: `3 quarantine record(s) in compression quarantine (one span can hold several)${tail}`,
      data: { count: 3, keys },
    });
  });

  // agent-framework bounds each data field to 2,000 characters of JSON, and
  // nothing reads a spans list there: the words carry the span count.
  test("the data never carries context-manager's spans, whatever they hold", () => {
    const lists = [[span(1, 2), span(2, 1)], [], [span(1, 1), span(2, 1), span(3, 1), span(4, 1)], null, 'two'];
    for (const spans of lists) {
      const alert = quarantineAlarm({ count: 3, keys, spans } as unknown as QuarantineStatus);
      expect(alert.data).toEqual({ count: 3, keys });
    }
  });

  test('none held: the all-clear, under its own kind', () => {
    expect(quarantineAlarm({ count: 0, keys: [] })).toEqual({
      kind: 'compression-quarantine-clear',
      message: 'compression quarantine EMPTY — all debt paid; alarm stands down.',
      data: { count: 0 },
    });
    expect(quarantineAlarm({ count: 0, keys: [], spans: [] }).kind).toBe('compression-quarantine-clear');
  });
});
