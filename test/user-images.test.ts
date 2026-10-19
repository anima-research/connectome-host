/**
 * Images attached in the WebUI composer: the wire shape, the host's checks
 * before anything is stored, and the TUI module storing them as image blocks.
 *
 * Fixtures are real files PIL wrote at 3×2 (so a swapped width and height
 * shows), plus 8000×1 / 8001×1 PNGs either side of the model API's limit.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ProcessState } from '@animalabs/agent-framework';
import { imageLimitsFrom, isClientMessage, USER_IMAGE_LIMITS } from '../src/web/protocol.js';
import { hostImageLimits, liveImageBytes, liveImageWindow, userImageBlocks } from '../src/web/user-images.js';
import { imageDamage, imageSize, isAnimated, sniffImageType } from '../src/web/image-bytes.js';
import { TuiModule } from '../src/modules/tui-module.js';
import { coalesceAndFlatten, toWireEntry, withoutImageData } from '../src/modules/web-ui-module.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/user-images.json', import.meta.url), 'utf-8')) as Record<string, string>;
const bytes = (key: string): Buffer => Buffer.from(FIX[key]!, 'base64');

/** CRC-32 as PNG chunks carry it, so a test can build a chunk that passes. */
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of b) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG chunk: length, type, data and its checksum. */
function pngChunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

/** The fixture PNG with its IHDR replaced, checksum and all. */
function pngWithSize(width: number, height: number): Buffer {
  const png = bytes('png');
  const ihdr = Buffer.from(png.subarray(16, 29));
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', ihdr), png.subarray(33)]);
}

/** A GIF of `frames` 1x1 frames: header, screen, then each image's
 *  descriptor and one data sub-block, and the trailer. */
function gifOf(frames: number): Buffer {
  const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00];
  return Buffer.from([
    ...Buffer.from('GIF89a', 'latin1'), 1, 0, 1, 0, 0x00, 0, 0,
    ...Array.from({ length: frames }, () => frame).flat(),
    0x3b,
  ]);
}

describe('the wire shape', () => {
  test('a user message may carry images', () => {
    expect(isClientMessage({ type: 'user-message', content: '', images: [{ mediaType: 'image/png', data: FIX.png }] })).toBe(true);
    expect(isClientMessage({ type: 'user-message', content: 'hi', images: [] })).toBe(true);
    expect(isClientMessage({ type: 'user-message', content: 'hi' })).toBe(true);
    expect(isClientMessage({ type: 'user-message', content: 'hi', corrId: 'm3' })).toBe(true);
    expect(isClientMessage({ type: 'user-message', content: 'hi', corrId: 3 })).toBe(false);
  });

  test('images that are not a list of { mediaType, data } strings are refused', () => {
    for (const images of ['nope', {}, [null], ['x'], [{ mediaType: 'image/png' }], [{ data: 'AAAA' }], [{ mediaType: 1, data: 'AAAA' }]]) {
      expect(isClientMessage({ type: 'user-message', content: 'hi', images })).toBe(false);
    }
  });
});

describe('image headers', () => {
  test('each format is told by its bytes, and its size read from its header', () => {
    const cases: Array<[string, string]> = [
      ['png', 'image/png'],
      ['jpeg', 'image/jpeg'],
      ['jpegProgressive', 'image/jpeg'],
      ['gif', 'image/gif'],
      ['webpLossy', 'image/webp'],
      ['webpLossless', 'image/webp'],
      ['webpExtended', 'image/webp'],
    ];
    for (const [key, type] of cases) {
      const b = bytes(key);
      expect({ key, type: sniffImageType(b) }).toEqual({ key, type });
      expect({ key, size: imageSize(b, type) }).toEqual({ key, size: { width: 3, height: 2 } });
    }
  });

  test('a JPEG whose metadata comes before the frame is walked past it', () => {
    // The fixture carries an EXIF (APP1) segment ahead of its frame header.
    const b = bytes('jpeg');
    expect(b[2]).toBe(0xff);
    expect(b.indexOf(Buffer.from('Exif'))).toBeGreaterThan(0);
    expect(imageSize(b, 'image/jpeg')).toEqual({ width: 3, height: 2 });
  });

  test('a cut-short header has no size, and anything else no type', () => {
    expect(imageSize(bytes('png').subarray(0, 20), 'image/png')).toBeNull();
    expect(imageSize(bytes('jpeg').subarray(0, 40), 'image/jpeg')).toBeNull();
    expect(imageSize(bytes('webpLossy').subarray(0, 24), 'image/webp')).toBeNull();
    // Lossy and extended headers need 30 bytes, one more than these have.
    expect(imageSize(bytes('webpLossy').subarray(0, 29), 'image/webp')).toBeNull();
    expect(imageSize(bytes('webpExtended').subarray(0, 29), 'image/webp')).toBeNull();
    expect(sniffImageType(Buffer.from('%PDF-1.7 not an image'))).toBeUndefined();
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
  });

  test("a signature counts only when it's whole: PNG's eight bytes, GIF87a or GIF89a", () => {
    for (const at of [4, 5, 6, 7]) {
      const b = Buffer.from(bytes('png'));
      b[at]! ^= 0xff;
      expect({ at, type: sniffImageType(b) }).toEqual({ at, type: undefined });
    }
    const gif = Buffer.from(bytes('gif'));
    gif.write('88a', 3, 'latin1');
    expect(sniffImageType(gif)).toBeUndefined();
    gif.write('89b', 3, 'latin1');
    expect(sniffImageType(gif)).toBeUndefined();
    gif.write('87a', 3, 'latin1');
    expect(sniffImageType(gif)).toBe('image/gif');
  });

  test("a lossless WebP is read at its own header's length, under 30 bytes", () => {
    // RIFF, WEBP, a VP8L chunk of 6: signature 0x2f, then width-1 and
    // height-1 (both 0, so 1x1), and a byte of data. 26 bytes in all.
    const tiny = Buffer.from([
      ...Buffer.from('RIFF', 'latin1'), 18, 0, 0, 0, ...Buffer.from('WEBPVP8L', 'latin1'), 6, 0, 0, 0,
      0x2f, 0, 0, 0, 0, 0,
    ]);
    expect(tiny.length).toBe(26);
    expect(imageSize(tiny, 'image/webp')).toEqual({ width: 1, height: 1 });
    expect(imageDamage(tiny, 'image/webp')).toBeNull();
    expect(imageSize(tiny.subarray(0, 24), 'image/webp')).toBeNull();
  });

  test('a header whose layout is wrong for its format has no size', () => {
    const lossy = Buffer.from(bytes('webpLossy'));
    lossy[23] = 0x00; // the VP8 start code, 9d 01 2a
    expect(imageSize(lossy, 'image/webp')).toBeNull();
    const lossless = Buffer.from(bytes('webpLossless'));
    lossless[20] = 0x00; // the VP8L signature, 2f
    expect(imageSize(lossless, 'image/webp')).toBeNull();
    const png = Buffer.from(bytes('png'));
    png.write('IHDX', 12, 'latin1');
    expect(imageSize(png, 'image/png')).toBeNull();
  });
});

describe('a whole image', () => {
  const FORMATS: Record<string, string> = {
    png: 'image/png',
    jpeg: 'image/jpeg',
    jpegProgressive: 'image/jpeg',
    gif: 'image/gif',
    webpLossy: 'image/webp',
    webpLossless: 'image/webp',
    webpExtended: 'image/webp',
  };

  test('every fixture is whole, and stays whole with bytes after its end', () => {
    for (const [key, type] of Object.entries(FORMATS)) {
      expect({ key, damage: imageDamage(bytes(key), type) }).toEqual({ key, damage: null });
      const trailed = Buffer.concat([bytes(key), Buffer.from('trailing bytes some writers append')]);
      expect({ key, damage: imageDamage(trailed, type) }).toEqual({ key, damage: null });
    }
  });

  test('every fixture cut short, at any byte, is refused', () => {
    for (const [key, type] of Object.entries(FORMATS)) {
      const b = bytes(key);
      for (let cut = 1; cut < b.length; cut++) {
        const damage = imageDamage(b.subarray(0, cut), type);
        if (damage === null) throw new Error(`${key} cut to ${cut} of ${b.length} bytes passed as whole`);
      }
    }
  });

  test('a PNG cut to its first 24 bytes, dimensions intact, is refused before it is stored', () => {
    const head = bytes('png').subarray(0, 24);
    expect(imageSize(head, 'image/png')).toEqual({ width: 3, height: 2 });
    expect(userImageBlocks([{ mediaType: 'image/png', data: head.toString('base64') }])).toEqual({
      ok: false, error: 'the image is cut short: the file ends before the image does',
    });
  });

  test('a damaged byte inside a PNG chunk fails its checksum', () => {
    const b = Buffer.from(bytes('png'));
    b[b.indexOf(Buffer.from('IDAT')) + 5]! ^= 0xff;
    expect(imageDamage(b, 'image/png')).toBe('is damaged: its IDAT chunk fails its checksum');
  });

  test('a file whose structure is whole but holds no image data is refused', () => {
    const png = bytes('png');
    const noData = Buffer.concat([png.subarray(0, 33), pngChunk('IEND', new Uint8Array())]);
    expect(imageDamage(noData, 'image/png')).toBe('has no image data');
    expect(imageDamage(gifOf(0), 'image/gif')).toBe('has no image data');
    // RIFF, WEBP and one empty EXIF chunk: whole, with no image chunk.
    const webp = Buffer.from([
      ...Buffer.from('RIFF', 'latin1'), 12, 0, 0, 0, ...Buffer.from('WEBPEXIF', 'latin1'), 0, 0, 0, 0,
    ]);
    expect(imageDamage(webp, 'image/webp')).toBe('has no image data');
  });
});

describe('isAnimated', () => {
  test('a GIF of two frames is animated, and of one is not', () => {
    expect(imageDamage(gifOf(2), 'image/gif')).toBeNull();
    expect(isAnimated(gifOf(2), 'image/gif')).toBe(true);
    expect(isAnimated(gifOf(1), 'image/gif')).toBe(false);
    expect(isAnimated(bytes('gif'), 'image/gif')).toBe(false);
  });

  test('a PNG with an acTL chunk ahead of its data is animated (APNG)', () => {
    const png = bytes('png');
    const actl = pngChunk('acTL', new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]));
    const apng = Buffer.concat([png.subarray(0, 33), actl, png.subarray(33)]);
    expect(imageDamage(apng, 'image/png')).toBeNull();
    expect(isAnimated(apng, 'image/png')).toBe(true);
    expect(isAnimated(png, 'image/png')).toBe(false);
    // acTL counts only ahead of the image data, as APNG places it.
    const iend = png.length - 12;
    const late = Buffer.concat([png.subarray(0, iend), actl, png.subarray(iend)]);
    expect(isAnimated(late, 'image/png')).toBe(false);
  });

  test("a WebP is animated when its VP8X header sets the animation flag", () => {
    const vp8x = (flags: number) => Buffer.from([
      ...Buffer.from('RIFF', 'latin1'), 22, 0, 0, 0, ...Buffer.from('WEBPVP8X', 'latin1'), 10, 0, 0, 0,
      flags, 0, 0, 0, 2, 0, 0, 1, 0, 0,
    ]);
    expect(isAnimated(vp8x(0x02), 'image/webp')).toBe(true);
    expect(isAnimated(vp8x(0x10), 'image/webp')).toBe(false);
    expect(isAnimated(bytes('webpExtended'), 'image/webp')).toBe(false);
    expect(isAnimated(bytes('webpLossy'), 'image/webp')).toBe(false);
    // Only a VP8X header has the flag: byte 20 of a lossless file is its
    // signature, 0x2f, which has that bit set.
    expect(bytes('webpLossless')[20]! & 0x02).toBe(0x02);
    expect(isAnimated(bytes('webpLossless'), 'image/webp')).toBe(false);
  });
});

describe('userImageBlocks', () => {
  test('images become base64 image blocks, typed by their bytes', () => {
    const r = userImageBlocks([
      { mediaType: 'image/png', data: FIX.png! },
      // A JPEG saved under a .png name: corrected, not refused, because the
      // API refuses a declared type its bytes contradict.
      { mediaType: 'image/png', data: FIX.jpeg! },
    ]);
    expect(r).toEqual({
      ok: true,
      blocks: [
        { type: 'image', source: { type: 'base64', data: FIX.png!, mediaType: 'image/png' } },
        { type: 'image', source: { type: 'base64', data: FIX.jpeg!, mediaType: 'image/jpeg' } },
      ],
    });
  });

  test('8000 px on a side is taken, 8001 is refused with the size', () => {
    expect(userImageBlocks([{ mediaType: 'image/png', data: FIX.png8000x1! }]).ok).toBe(true);
    const r = userImageBlocks([{ mediaType: 'image/png', data: FIX.png8001x1! }]);
    expect(r).toEqual({ ok: false, error: 'the image is 8001×1; the model API takes at most 8000 px on a side. Shrink it to 8000 px or less on its longer side.' });
  });

  test('what is not an image is refused, naming which one', () => {
    const pdf = Buffer.from('%PDF-1.7\n' + 'x'.repeat(60)).toString('base64');
    const r = userImageBlocks([{ mediaType: 'image/png', data: FIX.png! }, { mediaType: 'image/png', data: pdf }]);
    expect(r).toEqual({ ok: false, error: 'image 2 is not a PNG, JPEG, GIF or WebP image' });
  });

  test('a PNG whose signature was changed in transit is refused as a damaged PNG', () => {
    // A copy that turns \r\n into \n drops the signature's byte 4.
    const png = Buffer.from(FIX.png!, 'base64');
    const copied = Buffer.concat([png.subarray(0, 4), png.subarray(5)]);
    const r = userImageBlocks([{ mediaType: 'image/png', data: copied.toString('base64') }]);
    expect(r).toEqual({ ok: false, error: "the image is a damaged PNG: its 8-byte signature isn't whole" });
  });

  test('base64 that is not base64 is refused rather than decoded leniently', () => {
    // Buffer.from(…, 'base64') skips characters outside the alphabet, so
    // this would otherwise decode to a PNG and be stored with the junk in it.
    const junk = FIX.png!.slice(0, 40) + '!!!!' + FIX.png!.slice(40);
    expect(userImageBlocks([{ mediaType: 'image/png', data: junk }])).toEqual({ ok: false, error: 'the image is not valid base64' });
    expect(userImageBlocks([{ mediaType: 'image/png', data: '' }])).toEqual({ ok: false, error: 'the image is not valid base64' });
  });

  test('the count, per-image and per-message limits hold at their edges', () => {
    const L = USER_IMAGE_LIMITS;
    const many = Array.from({ length: L.maxCount + 1 }, () => ({ mediaType: 'image/png', data: FIX.png! }));
    expect(userImageBlocks(many)).toEqual({ ok: false, error: `${L.maxCount + 1} images attached; a message takes at most ${L.maxCount} here` });
    expect(userImageBlocks(many.slice(0, L.maxCount)).ok).toBe(true);

    // A whole PNG padded out after its end: the checks read headers, not
    // pixels, and bytes after the end are allowed, so only a size limit can
    // refuse these.
    const padded = (chars: number) => {
      const raw = Buffer.concat([bytes('png'), Buffer.alloc(chars * 3 / 4 - bytes('png').length)]);
      return raw.toString('base64');
    };
    const image = (data: string) => ({ mediaType: 'image/png', data });
    const atCap = padded(L.maxBase64Chars);
    expect(atCap.length).toBe(L.maxBase64Chars);
    expect(userImageBlocks([image(atCap)]).ok).toBe(true);
    expect(userImageBlocks([image(padded(L.maxBase64Chars + 4))])).toEqual({
      ok: false, error: 'the image is 5,000,004 characters of base64, over the 5,000,000 one image may carry',
    });

    // The total, exactly at it and one base64 quantum past it.
    const rest = L.maxTotalBase64Chars - 2 * L.maxBase64Chars;
    expect(userImageBlocks([image(atCap), image(atCap), image(padded(rest))]).ok).toBe(true);
    expect(userImageBlocks([image(atCap), image(atCap), image(padded(rest + 4))])).toEqual({
      ok: false, error: 'the images come to more than 12,582,912 characters of base64, the most one message carries',
    });
  });

  test('an image with no width or no height is refused', () => {
    expect(imageSize(pngWithSize(0, 2), 'image/png')).toEqual({ width: 0, height: 2 });
    expect(imageDamage(pngWithSize(0, 2), 'image/png')).toBeNull();
    expect(userImageBlocks([{ mediaType: 'image/png', data: pngWithSize(0, 2).toString('base64') }])).toEqual({
      ok: false, error: 'the image is 0×2; an image needs a width and a height',
    });
    expect(userImageBlocks([{ mediaType: 'image/png', data: pngWithSize(3, 0).toString('base64') }]).ok).toBe(false);
  });

  test("a host's own limits, from its recipe, are the ones checked", () => {
    const six = hostImageLimits(liveImageWindow(undefined));
    expect(six).toEqual({ ...USER_IMAGE_LIMITS, maxCount: 6 });
    const seven = Array.from({ length: 7 }, () => ({ mediaType: 'image/png', data: FIX.png! }));
    expect(userImageBlocks(seven, six)).toEqual({ ok: false, error: '7 images attached; a message takes at most 6 here' });
    expect(userImageBlocks(seven.slice(0, 6), six).ok).toBe(true);

    const many = hostImageLimits(liveImageWindow({ type: 'autobiographical', maxLiveImages: 24 }));
    expect(many).toEqual({ ...USER_IMAGE_LIMITS, maxSidePx: 2000 });
    expect(userImageBlocks([{ mediaType: 'image/png', data: pngWithSize(2000, 1).toString('base64') }], many).ok).toBe(true);
    expect(userImageBlocks([{ mediaType: 'image/png', data: pngWithSize(2001, 1).toString('base64') }], many)).toEqual({
      ok: false,
      error: 'the image is 2001×1; this host can carry more than 20 images in one request, where the model APIs hold every image to a stricter limit, and 2000 px on a side stays under it. Shrink it to 2000 px or less on its longer side.',
    });
  });
});

describe("a host's image limits, from its recipe's live window", () => {
  test('the window: the strategy default, a set count, or none', () => {
    expect(liveImageWindow(undefined)).toBe(6);
    expect(liveImageWindow({ type: 'frontdesk' })).toBe(6);
    expect(liveImageWindow({ type: 'autobiographical', maxLiveImages: 3 })).toBe(3);
    expect(liveImageWindow({ type: 'autobiographical', maxLiveImages: 0 })).toBeUndefined();
    expect(liveImageWindow({ type: 'passthrough' })).toBeUndefined();
    expect(liveImageWindow({ type: 'from-an-extension' })).toBeUndefined();
  });

  test('a message takes no more images than the window keeps, and past 20 each side is held to 2000 px', () => {
    expect(hostImageLimits(3)).toEqual({ ...USER_IMAGE_LIMITS, maxCount: 3 });
    expect(hostImageLimits(20)).toEqual(USER_IMAGE_LIMITS);
    expect(hostImageLimits(21)).toEqual({ ...USER_IMAGE_LIMITS, maxSidePx: 2000 });
    expect(hostImageLimits(undefined)).toEqual({ ...USER_IMAGE_LIMITS, maxSidePx: 2000 });
  });

  test('a message takes no more base64 than the window keeps, where the recipe sets that', () => {
    expect(liveImageBytes(undefined)).toBeUndefined();
    expect(liveImageBytes({ type: 'autobiographical', maxLiveImageBytes: 4_000_000 })).toBe(4_000_000);
    expect(liveImageBytes({ type: 'frontdesk', maxLiveImageBytes: 4_000_000 })).toBe(4_000_000);
    expect(liveImageBytes({ type: 'autobiographical', maxLiveImageBytes: 0 })).toBeUndefined();
    expect(liveImageBytes({ type: 'passthrough', maxLiveImageBytes: 4_000_000 })).toBeUndefined();
    // A recipe that names no strategy type gets the host's default, autobiographical.
    expect(liveImageBytes({ maxLiveImageBytes: 4_000_000 } as Parameters<typeof liveImageBytes>[0])).toBe(4_000_000);
    expect(hostImageLimits(6, 4_000_000)).toEqual({
      ...USER_IMAGE_LIMITS, maxCount: 6, maxBase64Chars: 4_000_000, maxTotalBase64Chars: 4_000_000,
    });
    // A byte window above the defaults leaves them as they are.
    expect(hostImageLimits(6, 64 * 1024 * 1024)).toEqual({ ...USER_IMAGE_LIMITS, maxCount: 6 });
  });

  test("the composer takes a host's limits where they're sound, and the defaults otherwise", () => {
    expect(imageLimitsFrom(undefined)).toEqual(USER_IMAGE_LIMITS);
    expect(imageLimitsFrom({ maxCount: 6, maxSidePx: 2000 })).toEqual({ ...USER_IMAGE_LIMITS, maxCount: 6, maxSidePx: 2000 });
    // Looser than the defaults, not whole, or not a number: the default.
    expect(imageLimitsFrom({ maxCount: 9, maxSidePx: 2000.5, maxBase64Chars: -1 })).toEqual(USER_IMAGE_LIMITS);
    expect(imageLimitsFrom({ maxCount: '6' as unknown as number })).toEqual(USER_IMAGE_LIMITS);
  });
});

describe('stored messages as the WebUI is sent them', () => {
  const image = { type: 'image', source: { type: 'base64', data: FIX.png, mediaType: 'image/png' } };

  test("a stored user message carries its send's corrId, and nothing else does", () => {
    const user = { id: 'u1', participant: 'user', content: [{ type: 'text', text: 'hi' }], metadata: { webuiCorrId: 'c-9' } };
    expect(toWireEntry(user, 0).corrId).toBe('c-9');
    expect(toWireEntry({ ...user, metadata: {} }, 0).corrId).toBeUndefined();
    expect(toWireEntry({ ...user, participant: 'Claude' }, 0).corrId).toBeUndefined();
    // Another producer's `corrId` in a message's metadata isn't a send's.
    expect(toWireEntry({ ...user, metadata: { corrId: 'c-9' } }, 0).corrId).toBeUndefined();
  });

  test("a coalesced shard run's images name the shard each is stored in", () => {
    const entries = coalesceAndFlatten([
      { id: 's0', participant: 'user', bodyGroupId: 'g', shardIndex: 0, content: [{ type: 'text', text: 'one ' }, image] },
      { id: 's1', participant: 'user', bodyGroupId: 'g', shardIndex: 1, content: [{ type: 'text', text: 'two' }, image] },
      { id: 'm2', participant: 'user', content: [image] },
    ], 10);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.blocks).toEqual([
      { kind: 'text', text: 'one ' },
      { kind: 'media', mediaType: 'image/png', ref: 's0/1' },
      { kind: 'text', text: 'two' },
      { kind: 'media', mediaType: 'image/png', ref: 's1/1' },
    ]);
    expect(entries[0]!.index).toBe(10);
    expect(entries[1]!.blocks).toEqual([{ kind: 'media', mediaType: 'image/png', ref: 'm2/0' }]);
  });

  test("a run's blob refs and a tool result's images name their shard too", () => {
    const blob = { type: 'blob_ref', ref: { mediaType: 'image/png' } };
    const toolImage = { type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'shot' }, image] };
    const entries = coalesceAndFlatten([
      { id: 's0', participant: 'user', bodyGroupId: 'g', shardIndex: 0, content: [{ type: 'text', text: 'a' }, blob] },
      { id: 's1', participant: 'user', bodyGroupId: 'g', shardIndex: 1, content: [toolImage] },
    ], 0);
    expect(entries).toHaveLength(1);
    const media = entries[0]!.blocks.filter((b) => b.kind === 'media');
    expect(media).toEqual([
      { kind: 'media', mediaType: 'image/png', ref: 's0/1' },
      { kind: 'media', mediaType: 'image/png', ref: 's1/0.1' },
    ]);
  });

  test('two ingestions of the same text are two entries, since a body is what continuesBody says', () => {
    const shard = (id: string, shardIndex: number, text: string) =>
      ({ id, participant: 'user', bodyGroupId: 'same-text', shardIndex, content: [{ type: 'text', text }] });
    const entries = coalesceAndFlatten([
      shard('a0', 0, 'x1 '), shard('a1', 1, 'x2'),
      shard('b0', 0, 'x1 '), shard('b1', 1, 'x2'),
    ], 4);
    expect(entries.map((e) => [e.id, e.index, e.blocks])).toEqual([
      ['a0', 4, [{ kind: 'text', text: 'x1 x2' }]],
      ['b0', 6, [{ kind: 'text', text: 'x1 x2' }]],
    ]);
  });
});

describe('traces sent to WebUI clients', () => {
  test("a process trace's base64 images are replaced by their length, and nothing else changes", () => {
    const when = new Date('2026-10-19T12:00:00Z');
    const event = {
      type: 'process:completed',
      at: when,
      processEvent: { type: 'external-message', content: [
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA'.repeat(10) } },
        { type: 'text', text: 'hi' },
        // Only an image block's data is elided: a document's base64 goes as it is.
        { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: 'JVBERi0x' } },
      ] },
      responses: [{ addMessages: [{ participant: 'user', content: [{ type: 'image', source: { type: 'url', url: 'u' } }] }] }],
    };
    const out = withoutImageData(event) as typeof event;
    expect(out.processEvent.content[0]).toEqual({
      type: 'image', source: { type: 'base64', mediaType: 'image/png', data: '[40 base64 characters, not sent in traces]' },
    });
    expect(out.processEvent.content[1]).toEqual({ type: 'text', text: 'hi' });
    expect(out.processEvent.content[2]).toEqual(event.processEvent.content[2]!);
    expect(out.responses).toEqual(event.responses);
    // A client gets the Date as JSON.stringify renders it.
    expect(out.at as unknown).toBe(when.toISOString());
    expect(event.processEvent.content[0]!.source).toMatchObject({ data: 'AAAA'.repeat(10) });
  });

  test("a tool result's image, with its data at the top level, is elided too, in a copy", () => {
    const event = {
      type: 'tool:result_dropped',
      result: { content: [{ type: 'image', data: 'AAAA'.repeat(5), mimeType: 'image/png' }] },
    };
    const out = withoutImageData(event);
    expect(out).toEqual({
      type: 'tool:result_dropped',
      result: { content: [{ type: 'image', data: '[20 base64 characters, not sent in traces]', mimeType: 'image/png' }] },
    });
    expect(event.result.content[0]!.data).toBe('AAAA'.repeat(5));
  });

  test('an image block is elided at any depth', () => {
    let deep: unknown = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA'.repeat(5) } };
    for (let i = 0; i < 40; i++) deep = { inner: deep };
    const out = JSON.stringify(withoutImageData({ type: 'tool:completed', input: deep }));
    expect(out).not.toContain('AAAA');
    expect(out).toContain('"data":"[20 base64 characters, not sent in traces]"');
  });

  test('a value without images comes out as it went in, at any depth', () => {
    let deep: unknown = { leaf: ['x', 1, null, true] };
    for (let i = 0; i < 40; i++) deep = { inner: deep, n: i };
    expect(withoutImageData({ type: 'tool:completed', input: deep })).toEqual({ type: 'tool:completed', input: deep });
  });

  test('an image inside a class instance is elided too, and a Date still goes as JSON sends it', () => {
    class Holder {
      block: unknown;
      constructor(block: unknown) { this.block = block; }
      describe(): string { return 'holder'; }
    }
    const image = () => ({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA'.repeat(5) } });
    const event = {
      type: 'tool:completed',
      at: new Date('2026-10-19T19:00:00Z'),
      result: new Holder(image()),
    };
    const out = JSON.stringify(withoutImageData(event));
    expect(out).not.toContain('AAAA');
    const noted = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: '[20 base64 characters, not sent in traces]' } };
    expect(out).toBe(JSON.stringify({
      type: 'tool:completed',
      at: '2026-10-19T19:00:00.000Z',
      result: { block: noted },
    }));
  });

  test('a key named __proto__ stays a key of the copy, an image block\'s own included', () => {
    const event = JSON.parse('{"type":"tool:completed","input":{"__proto__":{"kept":1},"other":2}}');
    expect(JSON.stringify(withoutImageData(event))).toBe(JSON.stringify(event));
    const image = JSON.parse('{"type":"image","__proto__":{"kept":2},"source":{"type":"base64","mediaType":"image/png","data":"AAAA"}}');
    expect(JSON.stringify(withoutImageData({ type: 'tool:completed', image }))).toBe(
      '{"type":"tool:completed","image":{"type":"image","__proto__":{"kept":2},'
        + '"source":{"type":"base64","mediaType":"image/png","data":"[4 base64 characters, not sent in traces]"}}}',
    );
  });

  const noted = (n: number) => `[${n} base64 characters, not sent in traces]`;

  test('what a toJSON gives is walked too, so an image it renders is elided', () => {
    class Rendered {
      toJSON(): unknown {
        return { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA'.repeat(5) } };
      }
    }
    const out = JSON.stringify(withoutImageData({ type: 'tool:completed', result: new Rendered() }));
    expect(out).not.toContain('AAAA');
    expect(out).toBe(JSON.stringify({
      type: 'tool:completed',
      result: { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: noted(20) } },
    }));
  });

  test("an image nested inside an image block is elided too, and a block's data at both levels", () => {
    const out = withoutImageData({
      type: 'tool:completed',
      result: {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' },
        data: 'BBBBBBBB',
        rawItem: { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'CCCCCCCCCCCC' } },
      },
    });
    expect(out).toEqual({
      type: 'tool:completed',
      result: {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: noted(4) },
        data: noted(8),
        rawItem: { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: noted(12) } },
      },
    });
  });

  test("a generated image's data is elided, in a copy", () => {
    const event = {
      type: 'process:completed',
      responses: [{ content: [{ type: 'generated_image', data: 'AAAA'.repeat(3), mimeType: 'image/png' }] }],
    };
    const out = withoutImageData(event);
    expect(out).toEqual({
      type: 'process:completed',
      responses: [{ content: [{ type: 'generated_image', data: noted(12), mimeType: 'image/png' }] }],
    });
    expect(event.responses[0]!.content[0]!.data).toBe('AAAA'.repeat(3));
  });

  test("an image's source given by its own toJSON, and data in a boxed String, are elided as a client gets them", () => {
    const source = { toJSON: () => ({ type: 'base64', mediaType: 'image/png', data: 'AAAA'.repeat(4) }) };
    const out = withoutImageData({
      type: 'tool:completed',
      rendered: { type: 'image', source },
      boxed: { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: new String('BBBB') } },
      top: { type: 'image', data: new String('CCCCCCCC'), mimeType: 'image/png' },
    });
    expect(JSON.stringify(out)).not.toMatch(/AAAA|BBBB|CCCC/);
    expect(out).toEqual({
      type: 'tool:completed',
      rendered: { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: noted(16) } },
      boxed: { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: noted(4) } },
      top: { type: 'image', data: noted(8), mimeType: 'image/png' },
    });
  });

  test('an image block with a null source keeps it, and its own data is still elided', () => {
    expect(withoutImageData({ type: 'tool:completed', image: { type: 'image', source: null, data: 'AAAA' } }))
      .toEqual({ type: 'tool:completed', image: { type: 'image', source: null, data: noted(4) } });
  });

  test("boxed primitives and an array's own toJSON go as JSON.stringify sends them", () => {
    const list = Object.assign([1, 2], { toJSON: () => 'summary' });
    const event = { type: 'tool:completed', n: new Number(7), b: new Boolean(false), s: new String('abc'), list };
    expect(JSON.stringify(withoutImageData(event))).toBe(JSON.stringify(event));
    expect(withoutImageData(event)).toEqual({ type: 'tool:completed', n: 7, b: false, s: 'abc', list: 'summary' });
  });

  test("a payload JSON can't carry, a cycle or a BigInt, gives undefined, so its frame goes to no client, and so does one with nothing to send", () => {
    const cyclic: Record<string, unknown> = { type: 'tool:completed' };
    cyclic.self = cyclic;
    expect(withoutImageData(cyclic)).toBeUndefined();
    expect(withoutImageData({ type: 'tool:completed', n: 10n })).toBeUndefined();
    expect(withoutImageData({ type: 'tool:completed', toJSON: () => undefined })).toBeUndefined();
  });
});

describe('walking hostile bytes', () => {
  // The walkers run synchronously in the host's WebSocket handler, so one
  // that never ends freezes the host. These run in a child process with a
  // deadline: a regression fails the test instead of hanging the suite. The
  // deadlines are what only a walk that never ends reaches: the work takes
  // well under a second, so a loaded machine slowing it many times over
  // still finishes inside them.
  const MOD = JSON.stringify(new URL('../src/web/image-bytes.ts', import.meta.url).pathname);
  const FIXTURES = JSON.stringify(new URL('./fixtures/user-images.json', import.meta.url).pathname);
  const bounded = (code: string, ms: number) => {
    const r = Bun.spawnSync({ cmd: [process.execPath, '-e', code], timeout: ms, stdout: 'pipe', stderr: 'pipe' });
    return { exitCode: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
  };

  test('a WebP chunk length with its top bit set does not walk the cursor backwards', () => {
    // Review on #280: RIFF length 12, chunk length f8 ff ff ff — read signed,
    // that is -8, and the walk stood still.
    const r = bounded(`
      import { imageDamage } from ${MOD};
      const b = new Uint8Array([0x52,0x49,0x46,0x46, 12,0,0,0, 0x57,0x45,0x42,0x50, 0x56,0x50,0x38,0x20, 0xf8,0xff,0xff,0xff]);
      console.log(imageDamage(b, 'image/webp'));
    `, 60_000);
    expect(r).toEqual({ exitCode: 0, out: 'is cut short: the file ends before the image does', err: '' });
  }, 65_000);

  test('every fixture, damaged at random, is read to an answer', () => {
    // Seeded, so a failure reproduces: overwrite one to four bytes (often
    // with 00 or ff, the values that make lengths extreme) and sometimes cut
    // the file short, then read it every way the host does.
    const r = bounded(`
      import { readFileSync } from 'node:fs';
      import { imageDamage, imageSize, sniffImageType } from ${MOD};
      const fix = JSON.parse(readFileSync(${FIXTURES}, 'utf-8'));
      let seed = 280;
      const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const types = { png: 'image/png', jpeg: 'image/jpeg', jpegProgressive: 'image/jpeg', gif: 'image/gif', webpLossy: 'image/webp', webpLossless: 'image/webp', webpExtended: 'image/webp' };
      let runs = 0;
      for (const [key, type] of Object.entries(types)) {
        const whole = Buffer.from(fix[key], 'base64');
        for (let i = 0; i < 3000; i++) {
          let b = Uint8Array.from(whole);
          for (let k = 1 + Math.floor(rand() * 4); k > 0; k--) {
            const v = rand();
            b[Math.floor(rand() * b.length)] = v < 0.25 ? 0xff : v < 0.5 ? 0x00 : Math.floor(rand() * 256);
          }
          if (rand() < 0.3) b = b.subarray(0, Math.floor(rand() * b.length));
          imageDamage(b, type);
          imageSize(b, type);
          const sniffed = sniffImageType(b);
          if (sniffed) imageDamage(b, sniffed);
          runs++;
        }
      }
      console.log(runs);
    `, 120_000);
    // The answers aren't checked here, only that every read ends; the
    // tests above pin what each read answers.
    expect(r).toEqual({ exitCode: 0, out: String(7 * 3000), err: '' });
  }, 130_000);
});

describe('TuiModule', () => {
  const state = {} as ProcessState;
  const event = (content: unknown, source = 'tui') => ({
    type: 'external-message' as const, source, content, metadata: {}, triggerInference: true,
  });

  test('text and image blocks are stored as they are', async () => {
    const blocks = [
      { type: 'image', source: { type: 'base64', data: FIX.png, mediaType: 'image/png' } },
      { type: 'text', text: 'what is this?' },
    ];
    const r = await new TuiModule().onProcess(event(blocks), state);
    expect(r.addMessages).toEqual([{ participant: 'user', content: blocks }]);
    expect(r.requestInference).toBe(true);
  });

  test("the headless note is added to a copy, not the event's own blocks", async () => {
    const blocks = [{ type: 'image', source: { type: 'base64', data: FIX.png, mediaType: 'image/png' } }];
    const r = await new TuiModule().onProcess(event(blocks, 'headless'), state);
    expect(r.addMessages?.[0]?.content).toHaveLength(2);
    expect(blocks).toHaveLength(1);
  });

  test('a string is a text block, and any other shape is still stored as JSON text', async () => {
    const m = new TuiModule();
    expect((await m.onProcess(event('hello'), state)).addMessages?.[0]?.content).toEqual([{ type: 'text', text: 'hello' }]);
    const odd = [{ type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } }];
    expect((await m.onProcess(event(odd), state)).addMessages?.[0]?.content).toEqual([{ type: 'text', text: JSON.stringify(odd) }]);
    expect((await m.onProcess(event([]), state)).addMessages?.[0]?.content).toEqual([{ type: 'text', text: '[]' }]);
  });

  test('one block that is not a whole text or base64 image block makes the whole array JSON text', async () => {
    const m = new TuiModule();
    const image = { type: 'image', source: { type: 'base64', data: FIX.png, mediaType: 'image/png' } };
    for (const bad of [
      null,
      'text',
      { type: 'text', text: 3 },
      { type: 'image', source: { type: 'base64', mediaType: 'image/png' } },
      { type: 'image', source: { type: 'base64', data: FIX.png } },
      { type: 'image', source: { type: 'base64', data: 7, mediaType: 'image/png' } },
    ]) {
      const content = [image, bad];
      expect({ bad, stored: (await m.onProcess(event(content), state)).addMessages?.[0]?.content })
        .toEqual({ bad, stored: [{ type: 'text', text: JSON.stringify(content) }] });
    }
  });

  test("a send's corrId is stored with its message, and nothing else is", async () => {
    const m = new TuiModule();
    const withCorr = { ...event('hello'), metadata: { corrId: 'c-1', other: 'x' } };
    expect((await m.onProcess(withCorr, state)).addMessages).toEqual([
      { participant: 'user', content: [{ type: 'text', text: 'hello' }], metadata: { webuiCorrId: 'c-1' } },
    ]);
    const empty = { ...event('hello'), metadata: { corrId: '' } };
    expect((await m.onProcess(empty, state)).addMessages).toEqual([
      { participant: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });
});
