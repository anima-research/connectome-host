/**
 * Fitting a composer image to a host's limits by redrawing it smaller
 * (web/src/fit.ts), with the browser's redraw stood in for.
 */
import { describe, test, expect } from 'bun:test';
import { USER_IMAGE_LIMITS, imageLimitsFrom } from '../src/web/protocol.js';
import { base64Chars, fitByRedraw, fitNote, noFitReason, type Redraw } from '../web/src/fit.js';

/** A redraw that records each size asked for, and answers with what `answer`
 *  gives for it. */
function recording(answer: (w: number, h: number) => { bytes: number; flattened?: boolean } | null) {
  const asked: Array<[number, number]> = [];
  const redraw: Redraw = async (w, h) => {
    asked.push([w, h]);
    const a = answer(w, h);
    return a ? { blob: new Blob([new Uint8Array(a.bytes)], { type: 'image/webp' }), flattened: a.flattened ?? false } : null;
  };
  return { asked, redraw };
}

describe('fitByRedraw', () => {
  test('starts at the largest size the side limit allows', async () => {
    const r = recording(() => ({ bytes: 1000 }));
    const fit = await fitByRedraw(10000, 5000, USER_IMAGE_LIMITS, r.redraw);
    expect(r.asked).toEqual([[8000, 4000]]);
    expect(fit).toMatchObject({ ok: true, w: 8000, h: 4000 });
  });

  test("a host's smaller side limit is the one fitted to", async () => {
    const r = recording(() => ({ bytes: 1000 }));
    await fitByRedraw(10000, 5000, imageLimitsFrom({ maxSidePx: 2000 }), r.redraw);
    expect(r.asked).toEqual([[2000, 1000]]);
  });

  test('a size the browser draws no image at is tried again smaller', async () => {
    // No 2D context, or a null blob, past the browser's canvas limits.
    const r = recording((w) => (w > 3000 ? null : { bytes: 1000 }));
    const fit = await fitByRedraw(8000, 8000, USER_IMAGE_LIMITS, r.redraw);
    expect(r.asked.map(([w]) => w)).toEqual([8000, 5600, 3920, 2744]);
    expect(fit).toMatchObject({ ok: true, w: 2744, h: 2744 });
  });

  test('a redraw over the base64 limit is tried again smaller', async () => {
    const limits = imageLimitsFrom({ maxBase64Chars: 4000 });
    const r = recording((w) => ({ bytes: w > 500 ? 4000 : 2000 }));
    const fit = await fitByRedraw(1000, 1000, limits, r.redraw);
    expect(r.asked.map(([w]) => w)).toEqual([1000, 700, 490]);
    expect(fit).toMatchObject({ ok: true, w: 490 });
  });

  test('gives up after six sizes, saying whether any came out too big', async () => {
    const none = recording(() => null);
    expect(await fitByRedraw(1000, 1000, USER_IMAGE_LIMITS, none.redraw)).toEqual({ ok: false, tooBig: false });
    expect(none.asked.length).toBe(6);
    const big = recording(() => ({ bytes: 5_000_000 }));
    expect(await fitByRedraw(1000, 1000, USER_IMAGE_LIMITS, big.redraw)).toEqual({ ok: false, tooBig: true });
  });
});

describe('the notes', () => {
  test('a shrunk or converted image says so, and that a JPEG on white flattens transparency', () => {
    const from = { width: 4000, height: 3000, type: 'image/png', to: 'image/webp' };
    expect(fitNote({ w: 2000, h: 1500, flattened: false }, from)).toBe('shrunk from 4000×3000 to 2000×1500 to fit');
    expect(fitNote({ w: 2000, h: 1500, flattened: true }, { ...from, to: 'image/jpeg' }))
      .toBe('shrunk from 4000×3000 to 2000×1500 to fit, as a JPEG on white, which flattens any transparency');
    expect(fitNote({ w: 4000, h: 3000, flattened: false }, { ...from, type: 'image/bmp' })).toBe('converted from image/bmp to image/webp');
  });

  test('a limit is given in base64 characters, exactly', () => {
    expect(base64Chars(USER_IMAGE_LIMITS.maxTotalBase64Chars)).toBe('12,582,912 characters of base64');
    expect(noFitReason('cat.png', { tooBig: true }, USER_IMAGE_LIMITS)).toBe('cat.png is still over 5,000,000 characters of base64 after shrinking');
    expect(noFitReason('cat.png', { tooBig: false }, USER_IMAGE_LIMITS))
      .toBe("cat.png couldn't be redrawn to fit: the browser drew no image at any size tried");
  });
});
