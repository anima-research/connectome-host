/**
 * A message typed in the Web UI and the row shown for it when it was sent,
 * found again by its send's corrId (web/src/echo.ts).
 */
import { describe, test, expect, spyOn } from 'bun:test';
import {
  newCorrId, rowsAfterReset, rowsAfterWelcome, sentRowIndex, settleByEntries, settleRefusal, unsentMark, type SentRow,
} from '../web/src/echo.js';

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

  test("is the hex of crypto.getRandomValues' bytes, and needs no crypto.randomUUID", () => {
    // A page served over plain http to a LAN or tailnet address has no
    // randomUUID; getRandomValues it has.
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    const random = spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
      (a as unknown as Uint8Array).set(Array.from({ length: 16 }, (_, i) => i * 17));
      return a;
    });
    try {
      expect(crypto.randomUUID).toBeUndefined();
      expect(newCorrId()).toBe('00112233445566778899aabbccddeeff');
      expect(random).toHaveBeenCalledTimes(1);
    } finally {
      random.mockRestore();
      delete (crypto as { randomUUID?: unknown }).randomUUID;
    }
    expect(typeof crypto.randomUUID).toBe('function');
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

  test("a row that stays keeps the host's reason", () => {
    const rows = [sent('m1', 'a')];
    settleRefusal(rows, 'a', false, 'host not ready');
    expect(rows[0]).toMatchObject({ unsent: 'refused', refusal: 'host not ready' });
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

  test('a kept row keeps the rest of itself, images included', () => {
    const withImage = { ...sent('m1', 'a'), sentImages: ['image'] };
    expect(rowsAfterWelcome([withImage], [], 0)[0]).toMatchObject({ id: 'm1', sentImages: ['image'], unsent: 'unconfirmed' });
  });
});

describe('rowsAfterReset', () => {
  test("the window replaces the old transcript's stored rows, and the sends it lacks stay after it", () => {
    const refused = { ...sent('m1', 'a'), unsent: 'refused' as const, refusal: 'host not ready' };
    const output: Row = { id: 'm3', participant: 'command', text: '/status output' };
    const rows = [stored(0), stored(1), refused, sent('m2', 'b'), output];
    expect(rowsAfterReset(rows, [stored(0, undefined, 'other')]).map((r) => [r.id, r.unsent, r.refusal])).toEqual([
      ['stored-0', undefined, undefined],
      ['m1', 'refused', 'host not ready'],
      ['m2', 'unconfirmed', undefined],
    ]);
  });

  test('after a change of session, a kept send names the one it was sent in, and keeps the first it named', () => {
    const named = { ...sent('m1', 'a'), unsent: 'refused' as const, earlier: 'session one' };
    const after = rowsAfterReset([named, sent('m2', 'b')], [], 'session two');
    expect(after.map((r) => [r.id, r.earlier])).toEqual([['m1', 'session one'], ['m2', 'session two']]);
  });

  test('a send the window holds gives way to it, as on a reconnect', () => {
    expect(rowsAfterReset([sent('m1', 'a')], [stored(4, 'a')]).map((r) => r.id)).toEqual(['stored-4']);
  });
});

describe('settleByEntries', () => {
  test("a page's stored copy of a kept send takes the row out, and nothing else moves", () => {
    const kept = { ...sent('m1', 'a'), unsent: 'unconfirmed' as const };
    const rows = [stored(0, 'a'), stored(3), kept, sent('m2', 'b')];
    settleByEntries(rows, [stored(0, 'a'), stored(1)]);
    expect(rows.map((r) => r.id)).toEqual(['stored-0', 'stored-3', 'm2']);
  });
});

describe('unsentMark', () => {
  test('says why a kept send is kept, and where it was sent when that was another session', () => {
    expect(unsentMark(sent('m1', 'a'))).toBeNull();
    expect(unsentMark({ ...sent('m1', 'a'), unsent: 'refused' })).toBe('not sent: the host refused it');
    expect(unsentMark({ ...sent('m1', 'a'), unsent: 'refused', refusal: 'host not ready' }))
      .toBe('not sent: the host refused it (host not ready)');
    expect(unsentMark({ ...sent('m1', 'a'), unsent: 'unconfirmed', earlier: 'session one' }))
      .toBe('not confirmed: it may not have reached the host; sent in session one');
  });
});
