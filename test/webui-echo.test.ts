/**
 * A message typed in the Web UI and the row shown for it when it was sent,
 * found again by its send's corrId (web/src/echo.ts).
 */
import { describe, test, expect } from 'bun:test';
import { newCorrId, rowsAfterWelcome, sentRowIndex, settleRefusal, type SentRow } from '../web/src/echo.js';

interface Row extends SentRow {
  participant: string;
  text: string;
  index?: number;
}

const sent = (id: string, corrId: string, text = 'hi'): Row => ({ id, participant: 'user', text, corrId });
const stored = (index: number, corrId?: string, text = 'hi'): Row =>
  ({ id: `stored-${index}`, participant: 'user', text, index, ...(corrId ? { corrId } : {}) });

describe('newCorrId', () => {
  test('is 32 hex digits, and new for each send', () => {
    const ids = Array.from({ length: 1000 }, newCorrId);
    expect(new Set(ids).size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('sentRowIndex', () => {
  test('an echo finds the row whose send it is, by its corrId alone', () => {
    // Two sends that look alike take their own echoes, in either order.
    const rows = [sent('m1', 'a'), sent('m2', 'b')];
    expect(sentRowIndex(rows, 'b')).toBe(1);
    expect(sentRowIndex(rows, 'a')).toBe(0);
  });

  test("an echo with no corrId, or another client's, finds no row", () => {
    // A routed message's row carries no corrId, and isn't an echo's either.
    const rows = [sent('m1', 'a'), { id: 'm2', participant: 'user', text: '→ @child: hi' }];
    expect(sentRowIndex(rows, undefined)).toBe(-1);
    expect(sentRowIndex(rows, 'c')).toBe(-1);
  });

  test('a row with many rows after it still takes its echo', () => {
    const rows = [sent('m1', 'a'), ...Array.from({ length: 40 }, (_, i) => stored(i))];
    expect(sentRowIndex(rows, 'a')).toBe(0);
  });

  test('a stored row carrying the corrId is the message already in place, so it is passed over', () => {
    expect(sentRowIndex([stored(3, 'a'), sent('m1', 'a')], 'a')).toBe(1);
    expect(sentRowIndex([stored(3, 'a')], 'a')).toBe(-1);
  });
});

describe('settleRefusal', () => {
  test('with the composer empty, the row comes out to go back into it', () => {
    const rows = [sent('m1', 'a'), sent('m2', 'b')];
    expect(settleRefusal(rows, 'a', true)).toBe(true);
    expect(rows.map((r) => r.id)).toEqual(['m2']);
  });

  test('with another draft in the composer, the row stays, marked refused', () => {
    const rows = [sent('m1', 'a'), sent('m2', 'b')];
    expect(settleRefusal(rows, 'a', false)).toBe(false);
    expect(rows.map((r) => [r.id, r.unsent])).toEqual([['m1', 'refused'], ['m2', undefined]]);
  });

  test('a refusal that names no row changes nothing', () => {
    const rows = [sent('m1', 'a')];
    expect(settleRefusal(rows, 'z', true)).toBe(false);
    expect(settleRefusal(rows, 'z', false)).toBe(false);
    expect(rows).toEqual([sent('m1', 'a')]);
  });
});

describe('rowsAfterWelcome', () => {
  test('keeps the scrollback before the window, then the window', () => {
    const rows = [stored(1), stored(2), stored(5)];
    const window = [stored(5), stored(6)];
    expect(rowsAfterWelcome(rows, window, 5).map((r) => r.id)).toEqual(['stored-1', 'stored-2', 'stored-5', 'stored-6']);
  });

  test('a row whose send the window holds gives way to the stored message', () => {
    const rows = [stored(4), sent('m1', 'a')];
    expect(rowsAfterWelcome(rows, [stored(5, 'a')], 5).map((r) => r.id)).toEqual(['stored-4', 'stored-5']);
  });

  test('a row the window lacks stays after it, marked unconfirmed, and a refused one keeps its mark', () => {
    const refused = { ...sent('m1', 'a'), unsent: 'refused' as const };
    const rows = [stored(4), refused, sent('m2', 'b')];
    const after = rowsAfterWelcome(rows, [stored(5)], 5);
    expect(after.map((r) => [r.id, r.unsent])).toEqual([
      ['stored-4', undefined],
      ['stored-5', undefined],
      ['m1', 'refused'],
      ['m2', 'unconfirmed'],
    ]);
    // A later echo still finds the unconfirmed row.
    expect(sentRowIndex(after, 'b')).toBe(3);
  });

  test('other rows this client made give way to the window', () => {
    const output: Row = { id: 'm7', participant: 'command', text: '/status output' };
    expect(rowsAfterWelcome([output], [stored(5)], 5).map((r) => r.id)).toEqual(['stored-5']);
  });
});
