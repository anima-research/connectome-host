/**
 * Fitting a composer image to a host's limits by redrawing it smaller: the
 * sizes to try, and what to say about the result. The drawing itself is the
 * caller's (Attachments.tsx), so this runs without a browser.
 */
import type { UserImageLimits } from '@conhost/web/protocol';

/** The base64 length of `bytes` bytes, which the host's limits count. */
export const base64Length = (bytes: number): number => 4 * Math.ceil(bytes / 3);

/** A limit in base64 characters, as the composer's notes give it. */
export const base64Chars = (n: number): string => `${n.toLocaleString('en-US')} characters of base64`;

/** One redraw at w×h: the encoded image, and whether it was flattened onto
 *  white (a JPEG, where the browser can't write WebP). Null when the browser
 *  couldn't draw or encode at that size, as it can't past its canvas limits. */
export type Redraw = (w: number, h: number) => Promise<{ blob: Blob; flattened: boolean } | null>;

export type Fit =
  | { ok: true; blob: Blob; w: number; h: number; flattened: boolean }
  /** `tooBig`: some redraw came out, but none small enough to send. */
  | { ok: false; tooBig: boolean };

/** How many sizes to try, each 0.7 of the one before. */
const TRIES = 6;

/**
 * Redraw a width×height image to fit `limits`: first at the largest size the
 * side limit allows, then smaller each time a redraw is over the per-image
 * base64 limit or the browser couldn't make one.
 */
export async function fitByRedraw(width: number, height: number, limits: UserImageLimits, redraw: Redraw): Promise<Fit> {
  let scale = Math.min(1, limits.maxSidePx / Math.max(width, height));
  let tooBig = false;
  for (let attempt = 0; attempt < TRIES; attempt++, scale *= 0.7) {
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const made = await redraw(w, h);
    if (!made) continue;
    if (base64Length(made.blob.size) > limits.maxBase64Chars) {
      tooBig = true;
      continue;
    }
    return { ok: true, blob: made.blob, w, h, flattened: made.flattened };
  }
  return { ok: false, tooBig };
}

/** What a redraw did, for the thumbnail's tooltip. */
export function fitNote(fit: { w: number; h: number; flattened: boolean }, from: { width: number; height: number; type: string; to: string }): string {
  const what = fit.w !== from.width || fit.h !== from.height
    ? `shrunk from ${from.width}×${from.height} to ${fit.w}×${fit.h} to fit`
    : `converted from ${from.type || 'an unknown type'} to ${from.to}`;
  return fit.flattened ? `${what}, as a JPEG on white, which flattens any transparency` : what;
}

/** Why an image couldn't be fitted, for the composer's notice. */
export function noFitReason(name: string, fit: { tooBig: boolean }, limits: UserImageLimits): string {
  return fit.tooBig
    ? `${name} is still over ${base64Chars(limits.maxBase64Chars)} after shrinking`
    : `${name} couldn't be redrawn to fit: the browser drew no image at any size tried`;
}
