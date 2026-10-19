/**
 * Images an operator attaches to a WebUI message, checked before they reach
 * the store.
 *
 * A stored image the model API refuses is not a one-off failure: it rides in
 * every later request on the branch, so each inference fails until the image
 * leaves the context manager's live window (by count, depth or size) or
 * someone rolls the message back. So the host checks what the API checks —
 * format by the bytes, that the file is whole, size, and pixel dimensions —
 * and refuses the message with a reason instead of storing it. The limits are
 * the ones this host advertises in its welcome, from its own recipe
 * (`hostImageLimits`); the SPA fits images to the same limits before sending,
 * and this is the check for every client.
 */

import type { ContentBlock } from '@animalabs/agent-framework';
import { DEFAULT_AUTOBIOGRAPHICAL_CONFIG } from '@animalabs/context-manager';
import type { RecipeStrategy } from '../recipe.js';
import { USER_IMAGE_LIMITS, type UserImageLimits, type UserMessageImage } from './protocol.js';
import { imageDamage, imageSize, sniffImageType } from './image-bytes.js';

export type UserImageCheck =
  | { ok: true; blocks: ContentBlock[] }
  | { ok: false; error: string };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The most images a request may carry at the full side limit, by Anthropic's
 * vision docs: past it, every image in the request is held to 2000 px on a
 * side. Probes of the API on 2026-10-13 and 2026-10-19 found it not enforcing
 * this (21 and 101 images, one of them 2100 px, were accepted). The cap
 * follows the docs anyway: a stored image the API refuses fails every later
 * request until it leaves the live window, while the cap costs at most the
 * band between 2000 px and the size the models downscale to themselves.
 */
const MANY_IMAGES = 20;
/** The side the docs give for a request past `MANY_IMAGES`. */
const MANY_IMAGES_SIDE_PX = 2000;

/**
 * How many images a recipe's strategy keeps live at once, or `undefined` when
 * nothing caps the count: `passthrough` keeps every image, `maxLiveImages: 0`
 * turns the count limit off, and a strategy an extension registers is read
 * the same way, since the host can't know its window. The autobiographical
 * and frontdesk strategies default to context-manager's own default (6).
 */
export function liveImageWindow(strategy: RecipeStrategy | undefined): number | undefined {
  const type = strategy?.type ?? 'autobiographical';
  if (type !== 'autobiographical' && type !== 'frontdesk') return undefined;
  const n = strategy?.maxLiveImages ?? DEFAULT_AUTOBIOGRAPHICAL_CONFIG.maxLiveImages;
  return typeof n === 'number' && n > 0 ? n : undefined;
}

/**
 * The base64 a recipe's strategy keeps live across its images, where the
 * recipe sets it (`maxLiveImageBytes`); `undefined` leaves context-manager's
 * default, 20 MiB at 0.14.0, which is above what one message may carry
 * anyway. Read for the strategies `liveImageWindow` reads.
 */
export function liveImageBytes(strategy: RecipeStrategy | undefined): number | undefined {
  const type = strategy?.type ?? 'autobiographical';
  if (type !== 'autobiographical' && type !== 'frontdesk') return undefined;
  const n = strategy?.maxLiveImageBytes;
  return typeof n === 'number' && n > 0 ? n : undefined;
}

/**
 * The limits this host checks composer images against, from what its recipe
 * keeps live: how many images (`undefined`: no limit, as under passthrough or
 * `maxLiveImages: 0`) and how much of their base64 (`undefined`: the default).
 * A message takes no more images than the window keeps by count, and no more
 * base64 than it keeps by bytes, since images past either are stripped before
 * they reach the model. When more than 20 images can be live, each side is
 * held to 2000 px, which every platform takes in a request that many images
 * ride in.
 */
export function hostImageLimits(liveImages: number | undefined, liveBytes?: number): UserImageLimits {
  const L = USER_IMAGE_LIMITS;
  const unbounded = liveImages === undefined || liveImages <= 0;
  return {
    maxCount: unbounded ? L.maxCount : Math.min(L.maxCount, liveImages),
    maxBase64Chars: liveBytes ? Math.min(L.maxBase64Chars, liveBytes) : L.maxBase64Chars,
    maxTotalBase64Chars: liveBytes ? Math.min(L.maxTotalBase64Chars, liveBytes) : L.maxTotalBase64Chars,
    maxSidePx: unbounded || liveImages > MANY_IMAGES ? Math.min(L.maxSidePx, MANY_IMAGES_SIDE_PX) : L.maxSidePx,
  };
}

/**
 * Turn composer images into image content blocks, or say why not. Each
 * block's media type is the one its bytes show; a declared type that
 * disagrees (a JPEG saved as .png) is corrected rather than refused.
 */
export function userImageBlocks(
  images: ReadonlyArray<UserMessageImage>,
  L: UserImageLimits = USER_IMAGE_LIMITS,
): UserImageCheck {
  if (images.length > L.maxCount) {
    return { ok: false, error: `${images.length} images attached; a message takes at most ${L.maxCount} here` };
  }
  let total = 0;
  const blocks: ContentBlock[] = [];
  for (const [i, img] of images.entries()) {
    const which = images.length === 1 ? 'the image' : `image ${i + 1}`;
    const data = img.data;
    if (data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) {
      return { ok: false, error: `${which} is not valid base64` };
    }
    if (data.length > L.maxBase64Chars) {
      return { ok: false, error: `${which} is ${chars(data.length)} of base64, over the ${count(L.maxBase64Chars)} one image may carry` };
    }
    total += data.length;
    if (total > L.maxTotalBase64Chars) {
      return { ok: false, error: `the images come to more than ${chars(L.maxTotalBase64Chars)} of base64, the most one message carries` };
    }
    const bytes = Buffer.from(data, 'base64');
    const mediaType = sniffImageType(bytes);
    if (!mediaType) {
      // "\x89PNG" with the rest of the signature changed is a PNG damaged in
      // transit, as a text-mode copy that rewrites \r\n does.
      const damagedPng = bytes.length >= 4 && bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG';
      return {
        ok: false,
        error: damagedPng
          ? `${which} is a damaged PNG: its 8-byte signature isn't whole`
          : `${which} is not a PNG, JPEG, GIF or WebP image`,
      };
    }
    const damage = imageDamage(bytes, mediaType);
    if (damage) {
      return { ok: false, error: `${which} ${damage}` };
    }
    const size = imageSize(bytes, mediaType);
    if (!size) {
      return { ok: false, error: `${which} looks like ${mediaType} but its dimensions can't be read` };
    }
    if (size.width === 0 || size.height === 0) {
      return { ok: false, error: `${which} is ${size.width}×${size.height}; an image needs a width and a height` };
    }
    if (size.width > L.maxSidePx || size.height > L.maxSidePx) {
      const why = L.maxSidePx < USER_IMAGE_LIMITS.maxSidePx
        ? `this host can carry more than ${MANY_IMAGES} images in one request, where the model APIs hold every image to a stricter limit, and ${L.maxSidePx} px on a side stays under it`
        : `the model API takes at most ${L.maxSidePx} px on a side`;
      return { ok: false, error: `${which} is ${size.width}×${size.height}; ${why}. Shrink it to ${L.maxSidePx} px or less on its longer side.` };
    }
    blocks.push({ type: 'image', source: { type: 'base64', data, mediaType } });
  }
  return { ok: true, blocks };
}

function count(n: number): string {
  return n.toLocaleString('en-US');
}

function chars(n: number): string {
  return `${count(n)} characters`;
}
