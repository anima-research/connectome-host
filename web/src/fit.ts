import type { UserImageLimits } from '@conhost/web/protocol';

export const base64Length = (bytes: number): number => 4 * Math.ceil(bytes / 3);

export const base64Chars = (n: number): string => `${n.toLocaleString('en-US')} characters of base64`;

export type Redraw = (w: number, h: number) => Promise<{ blob: Blob; flattened: boolean } | null>;

export type Fit =
  | { ok: true; blob: Blob; w: number; h: number; flattened: boolean }
  | { ok: false; tooBig: boolean };

const TRIES = 6;

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

export function fitNote(fit: { w: number; h: number; flattened: boolean }, from: { width: number; height: number; type: string; to: string }): string {
  const what = fit.w !== from.width || fit.h !== from.height
    ? `shrunk from ${from.width}×${from.height} to ${fit.w}×${fit.h} to fit`
    : `converted from ${from.type || 'an unknown type'} to ${from.to}`;
  return fit.flattened ? `${what}, as a JPEG on white, which flattens any transparency` : what;
}

export const ANIMATED_REDRAWN_NOTE = 'an animation, redrawn as one still frame';

export function noFitReason(name: string, fit: { tooBig: boolean }, limits: UserImageLimits): string {
  return fit.tooBig
    ? `${name} is still over ${base64Chars(limits.maxBase64Chars)} after shrinking; crop it, or attach a smaller copy`
    : `${name} couldn't be redrawn to fit: the browser drew no image at any size tried`;
}
