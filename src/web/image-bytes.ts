/**
 * What an image's bytes say about it: its format, its pixel size, and whether
 * the file is whole. Plain Uint8Array code with no Node or DOM APIs, so the
 * host (`user-images.ts`) and the Web UI's composer read images the same way.
 */

/** Unsigned 32-bit reads. Built by multiplying, not shifting: `<<` and `|`
 *  work in signed 32 bits, so a length with its top bit set would come out
 *  negative and walk a cursor backwards (a 20-byte WebP hung the host). */
const u32be = (b: Uint8Array, o: number): number =>
  b[o]! * 0x1000000 + b[o + 1]! * 0x10000 + b[o + 2]! * 0x100 + b[o + 3]!;
const u32le = (b: Uint8Array, o: number): number =>
  b[o]! + b[o + 1]! * 0x100 + b[o + 2]! * 0x10000 + b[o + 3]! * 0x1000000;

/** The image format the leading bytes show, among those the model APIs take. */
export function sniffImageType(b: Uint8Array): string | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (
    b.length >= 12
    && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return 'image/webp';
  return undefined;
}

/** Pixel dimensions from the image header; null when the header is cut short
 *  or isn't the layout its format promises. */
export function imageSize(b: Uint8Array, mediaType: string): { width: number; height: number } | null {
  const be16 = (o: number) => (b[o]! << 8) | b[o + 1]!;
  const le16 = (o: number) => b[o]! | (b[o + 1]! << 8);
  const le24 = (o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
  const tag = (o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
  switch (mediaType) {
    case 'image/png':
      // 8-byte signature, then the IHDR chunk: length, 'IHDR', width, height.
      if (b.length < 24 || tag(12) !== 'IHDR') return null;
      return { width: u32be(b, 16), height: u32be(b, 20) };
    case 'image/gif':
      if (b.length < 10) return null;
      return { width: le16(6), height: le16(8) };
    case 'image/webp': {
      if (b.length < 30) return null;
      const chunk = tag(12);
      if (chunk === 'VP8 ') {
        // Lossy: frame tag (3 bytes), start code 9d 01 2a, then 14-bit sizes.
        if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
        return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
      }
      if (chunk === 'VP8L') {
        // Lossless: signature 0x2f, then width-1 and height-1 as 14 bits each.
        if (b[20] !== 0x2f) return null;
        const bits = u32le(b, 21);
        return { width: (bits % 0x4000) + 1, height: (Math.floor(bits / 0x4000) % 0x4000) + 1 };
      }
      if (chunk === 'VP8X') {
        // Extended: canvas width-1 and height-1 as 24 bits each.
        return { width: le24(24) + 1, height: le24(27) + 1 };
      }
      return null;
    }
    case 'image/jpeg': {
      // Walk the marker segments to the first start-of-frame.
      let o = 2;
      while (o + 4 <= b.length) {
        if (b[o] !== 0xff) return null;
        const marker = b[o + 1]!;
        if (marker === 0xff) { o++; continue; } // fill byte
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { o += 2; continue; } // no length
        if (marker === 0xd9 || marker === 0xda) return null; // end of image / scan before any frame
        const len = be16(o + 2);
        if (len < 2) return null;
        const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame) {
          if (o + 9 > b.length) return null;
          return { width: be16(o + 7), height: be16(o + 5) };
        }
        o += 2 + len;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Why the file isn't a whole image of its format, as a phrase that follows
 * "the image" ("is cut short"), or null when it is whole. Each format is
 * walked to its end marker, so a file cut off anywhere is caught; PNG chunks
 * also carry checksums, so damage inside one is caught too. A JPEG's, GIF's or
 * WebP's compressed data has no checksum, and damage there takes a decoder to
 * see. Bytes after the end marker are allowed: some writers append them.
 */
export function imageDamage(b: Uint8Array, mediaType: string): string | null {
  switch (mediaType) {
    case 'image/png': return pngDamage(b);
    case 'image/jpeg': return jpegDamage(b);
    case 'image/gif': return gifDamage(b);
    case 'image/webp': return webpDamage(b);
    default: return `is not a format whose ending can be checked (${mediaType})`;
  }
}

const CUT_SHORT = 'is cut short: the file ends before the image does';

function pngDamage(b: Uint8Array): string | null {
  let o = 8;
  let sawData = false;
  while (o + 12 <= b.length) {
    const len = u32be(b, o);
    const type = String.fromCharCode(b[o + 4]!, b[o + 5]!, b[o + 6]!, b[o + 7]!);
    const end = o + 12 + len;
    if (end > b.length) return CUT_SHORT;
    const stored = u32be(b, end - 4);
    if (crc32(b, o + 4, end - 4) !== stored) return `is damaged: its ${type} chunk fails its checksum`;
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') return sawData ? null : 'has no image data';
    o = end;
  }
  return CUT_SHORT;
}

function jpegDamage(b: Uint8Array): string | null {
  // Segments to the first start-of-scan; the frame header must come before it.
  let o = 2;
  let sawFrame = false;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return 'is damaged: its segments are out of step';
    const marker = b[o + 1]!;
    if (marker === 0xff) { o++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { o += 2; continue; }
    if (marker === 0xd9) return 'has no image data';
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) sawFrame = true;
    if (marker === 0xda) {
      if (!sawFrame) return 'is damaged: its image data comes before its frame header';
      // Scan data stuffs every 0xff byte (ff 00) or follows it with a restart
      // marker, so ff d9 after the first scan is the end-of-image marker.
      for (let i = o + 2; i + 1 < b.length; i++) {
        if (b[i] === 0xff && b[i + 1] === 0xd9) return null;
      }
      return CUT_SHORT;
    }
    o += 2 + ((b[o + 2]! << 8) | b[o + 3]!);
  }
  return CUT_SHORT;
}

function gifDamage(b: Uint8Array): string | null {
  if (b.length < 13) return CUT_SHORT;
  const tableSize = (flags: number) => (flags & 0x80 ? 3 * (1 << ((flags & 0x07) + 1)) : 0);
  /** Past a run of data sub-blocks (each a length byte, then that many
   *  bytes; a zero length ends the run), or -1 when the file ends first. */
  const skipSubBlocks = (from: number): number => {
    let o = from;
    while (o < b.length) {
      const n = b[o]!;
      o += 1 + n;
      if (n === 0) return o;
    }
    return -1;
  };
  let o = 13 + tableSize(b[10]!);
  let sawImage = false;
  while (o < b.length) {
    const block = b[o]!;
    if (block === 0x3b) return sawImage ? null : 'has no image data';
    if (block === 0x21) {
      o = skipSubBlocks(o + 2);
    } else if (block === 0x2c) {
      if (o + 10 > b.length) return CUT_SHORT;
      o = skipSubBlocks(o + 10 + tableSize(b[o + 9]!) + 1);
      sawImage = true;
    } else {
      return 'is damaged: it has a block of unknown kind';
    }
    if (o < 0) return CUT_SHORT;
  }
  return CUT_SHORT;
}

function webpDamage(b: Uint8Array): string | null {
  if (b.length < 12) return CUT_SHORT;
  const riffEnd = 8 + u32le(b, 4);
  if (riffEnd > b.length) return CUT_SHORT;
  let o = 12;
  let sawImage = false;
  while (o + 8 <= riffEnd) {
    const type = String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
    const size = u32le(b, o + 4);
    if (o + 8 + size > riffEnd) return CUT_SHORT;
    if (type === 'VP8 ' || type === 'VP8L' || type === 'ANMF') sawImage = true;
    o += 8 + size + (size & 1);
  }
  return sawImage ? null : 'has no image data';
}

let crcTable: Uint32Array | undefined;

/** CRC-32 (the PNG / zlib polynomial) of b[from, to). */
function crc32(b: Uint8Array, from: number, to: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = crcTable[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
