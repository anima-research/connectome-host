/**
 * The Web UI adopting the host's echo of a message into the row it showed
 * when the message was sent (web/src/echo.ts).
 */
import { describe, test, expect } from 'bun:test';
import { pendingEchoIndex } from '../web/src/echo.js';

const media = { kind: 'media' };
const text = { kind: 'text' };
const sent = (id: string, words: string, images = 0) =>
  ({ id, participant: 'user', text: words, blocks: Array.from({ length: images }, () => media) });
const echo = (id: string, words: string, images = 0) =>
  ({ id, participant: 'user', text: words, blocks: [...Array.from({ length: images }, () => media), ...(words ? [text] : [])] });

describe('pendingEchoIndex', () => {
  test('two image-only sends take their echoes in the order they were sent', () => {
    const rows = [sent('m1', '', 1), sent('m2', '', 1)];
    // Echoes arrive in send order; each adopts the oldest row still waiting.
    const first = pendingEchoIndex(rows, echo('a', '', 1));
    expect(first).toBe(0);
    const after = [echo('a', '', 1), rows[1]!];
    expect(pendingEchoIndex(after, echo('b', '', 1))).toBe(1);
  });

  test('an echo matches on its text and its number of images', () => {
    const rows = [sent('m1', 'look', 2), sent('m2', 'look'), sent('m3', 'look', 1)];
    expect(pendingEchoIndex(rows, echo('x', 'look', 1))).toBe(2);
    expect(pendingEchoIndex(rows, echo('x', 'look'))).toBe(1);
    expect(pendingEchoIndex(rows, echo('x', 'look', 3))).toBe(-1);
    expect(pendingEchoIndex(rows, echo('x', 'other', 2))).toBe(-1);
  });

  test("rows the host stored, other speakers' rows, and rows outside the window are passed over", () => {
    const rows = [
      sent('m1', 'hi'),
      ...Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, participant: 'assistant', text: 'hi' })),
      { id: 'stored-1', participant: 'user', text: 'hi' },
    ];
    expect(pendingEchoIndex(rows, echo('x', 'hi'))).toBe(-1);
    expect(pendingEchoIndex(rows, echo('x', 'hi'), 20)).toBe(0);
  });
});
