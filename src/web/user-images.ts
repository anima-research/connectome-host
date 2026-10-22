/**
 * Images an operator attaches to a WebUI message, checked before they reach
 * the store.
 *
 * A stored image the model API refuses is not a one-off failure: it rides in
 * every later request on the branch, so each inference fails until someone
 * rolls the message back. So the host checks what the API checks — format by
 * the bytes, that the file is whole, size, and pixel dimensions — and refuses
 * the message with a reason instead of storing it. The SPA fits images to the same limits before
 * sending; this is the check for every other client.
 */

import type { ContentBlock } from '@animalabs/agent-framework';
import { USER_IMAGE_LIMITS, type UserMessageImage } from './protocol.js';
import { imageDamage, imageSize, sniffImageType } from './image-bytes.js';

export type UserImageCheck =
  | { ok: true; blocks: ContentBlock[] }
  | { ok: false; error: string };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Turn composer images into image content blocks, or say why not. Each
 * block's media type is the one its bytes show; a declared type that
 * disagrees (a JPEG saved as .png) is corrected rather than refused.
 */
export function userImageBlocks(images: ReadonlyArray<UserMessageImage>): UserImageCheck {
  const L = USER_IMAGE_LIMITS;
  if (images.length > L.maxCount) {
    return { ok: false, error: `${images.length} images attached; a message takes at most ${L.maxCount}` };
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
      return { ok: false, error: `${which} is ${mb(data.length)} as base64, over the ${mb(L.maxBase64Chars)} limit` };
    }
    total += data.length;
    if (total > L.maxTotalBase64Chars) {
      return { ok: false, error: `the images come to more than ${mb(L.maxTotalBase64Chars)} as base64, the most one message carries` };
    }
    const bytes = Buffer.from(data, 'base64');
    const mediaType = sniffImageType(bytes);
    if (!mediaType) {
      return { ok: false, error: `${which} is not a PNG, JPEG, GIF or WebP image` };
    }
    const damage = imageDamage(bytes, mediaType);
    if (damage) {
      return { ok: false, error: `${which} ${damage}` };
    }
    const size = imageSize(bytes, mediaType);
    if (!size) {
      return { ok: false, error: `${which} looks like ${mediaType} but its dimensions can't be read` };
    }
    if (size.width > L.maxSidePx || size.height > L.maxSidePx) {
      return { ok: false, error: `${which} is ${size.width}×${size.height}; the model API takes at most ${L.maxSidePx} px on a side` };
    }
    blocks.push({ type: 'image', source: { type: 'base64', data, mediaType } });
  }
  return { ok: true, blocks };
}

function mb(chars: number): string {
  return `${(chars / 1_000_000).toFixed(1)} MB`;
}
