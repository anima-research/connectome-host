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
import { DEFAULT_AUTOBIOGRAPHICAL_CONFIG, defaultTokenEstimator } from '@animalabs/context-manager';
import type { RecipeStrategy } from '../recipe.js';
import { USER_IMAGE_LIMITS, type UserImageLimits, type UserMessageImage } from './protocol.js';
import { imageDamage, imageSize, isAnimated, sniffImageType } from './image-bytes.js';

export type UserImageCheck =
  | { ok: true; blocks: ContentBlock[] }
  | { ok: false; error: string };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The most images a request may carry at the full side limit, by Anthropic's
 * vision docs: past it, every image in the request is held to 2000 px on a
 * side.
 */
const MANY_IMAGES = 20;
/** The side the docs give for a request past `MANY_IMAGES`. */
const MANY_IMAGES_SIDE_PX = 2000;

/**
 * How many images a recipe's strategy keeps live at once, or `undefined` where
 * the host knows no count: `passthrough`, `maxLiveImages: 0`, or a strategy an
 * extension registers.
 */
export function liveImageWindow(strategy: RecipeStrategy | undefined): number | undefined {
  const type = strategy?.type ?? 'autobiographical';
  if (type !== 'autobiographical' && type !== 'frontdesk') return undefined;
  const n = strategy?.maxLiveImages ?? DEFAULT_AUTOBIOGRAPHICAL_CONFIG.maxLiveImages;
  return typeof n === 'number' && n > 0 ? n : undefined;
}

/** Whether this host takes composer images: not under `passthrough`. */
export function takesUserImages(strategy: RecipeStrategy | undefined): boolean {
  return (strategy?.type ?? 'autobiographical') !== 'passthrough';
}

/**
 * The depth, in context-manager's token estimate, past which a recipe's
 * strategy replaces images with a placeholder (`imageStripDepthTokens`), or
 * `undefined` where the host knows none: a depth of 0, `passthrough`, or a
 * strategy an extension registers.
 */
export function liveImageDepth(strategy: RecipeStrategy | undefined): number | undefined {
  const type = strategy?.type ?? 'autobiographical';
  if (type !== 'autobiographical' && type !== 'frontdesk') return undefined;
  const n = strategy?.imageStripDepthTokens ?? DEFAULT_AUTOBIOGRAPHICAL_CONFIG.imageStripDepthTokens;
  return typeof n === 'number' && n > 0 ? n : undefined;
}

/** The share of `liveImageDepth` a send's own estimate may take. */
export const SEND_DEPTH_SHARE = 0.9;

/** context-manager 0.24.0's estimate for an image block with no `tokenEstimate`. */
const IMAGE_TOKENS = 1600;

/** The ingestion chunking a context-manager strategy may apply to a message. */
export interface IngressChunker {
  chunkIngressMessage?(participant: string, content: never[]): { shards: Array<{ content: unknown[] }> } | null;
}

/**
 * The depth context-manager counts for a send's images while it is the newest
 * message: its estimate of each shard `strategy` stores the send as, at the
 * calibration `multiplier`, priced block by block as
 * `MessageStore.estimateTokens` prices them.
 */
export function sendDepthTokens(content: ContentBlock[], strategy: IngressChunker, multiplier: number): number {
  const shards = strategy.chunkIngressMessage?.('user', content as never[])?.shards.map((s) => s.content) ?? [content];
  let tokens = 0;
  for (const shard of shards) {
    for (const block of shard as ContentBlock[]) {
      const raw = block.type === 'text' ? defaultTokenEstimator(block.text) : block.type === 'image' ? IMAGE_TOKENS : 0;
      tokens += Math.round(raw * multiplier);
    }
  }
  return tokens;
}

/**
 * The base64 a recipe's strategy keeps live across its images, where the
 * recipe sets it (`maxLiveImageBytes`) for a strategy `liveImageWindow` reads.
 */
export function liveImageBytes(strategy: RecipeStrategy | undefined): number | undefined {
  const type = strategy?.type ?? 'autobiographical';
  if (type !== 'autobiographical' && type !== 'frontdesk') return undefined;
  const n = strategy?.maxLiveImageBytes;
  return typeof n === 'number' && n > 0 ? n : undefined;
}

/**
 * The limits this host checks composer images against, from how many images
 * its recipe keeps live and how much of their base64 (`undefined` for either:
 * no limit of the recipe's own).
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
// OpenAI lists "non-animated GIF" among its image inputs, and says nothing of
// animation in other formats:
// https://developers.openai.com/api/docs/guides/images-vision?api-mode=responses
const STILL_IMAGES_ONLY = new Set(['openai-responses', 'openai-codex']);

export function userImageBlocks(
  images: ReadonlyArray<UserMessageImage>,
  L: UserImageLimits = USER_IMAGE_LIMITS,
  provider?: string,
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
    if (provider !== undefined && STILL_IMAGES_ONLY.has(provider) && isAnimated(bytes, mediaType)) {
      return { ok: false, error: `${which} is animated, and OpenAI's docs don't say ${provider} takes animated images; send a still image` };
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
