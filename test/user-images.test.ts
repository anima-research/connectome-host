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
import { isClientMessage, USER_IMAGE_LIMITS } from '../src/web/protocol.js';
import { userImageBlocks } from '../src/web/user-images.js';
import { imageDamage, imageSize, sniffImageType } from '../src/web/image-bytes.js';
import { TuiModule } from '../src/modules/tui-module.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/user-images.json', import.meta.url), 'utf-8')) as Record<string, string>;
const bytes = (key: string): Buffer => Buffer.from(FIX[key]!, 'base64');

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
    expect(sniffImageType(Buffer.from('%PDF-1.7 not an image'))).toBeUndefined();
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
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
    expect(r).toEqual({ ok: false, error: 'the image is 8001×1; the model API takes at most 8000 px on a side' });
  });

  test('what is not an image is refused, naming which one', () => {
    const pdf = Buffer.from('%PDF-1.7\n' + 'x'.repeat(60)).toString('base64');
    const r = userImageBlocks([{ mediaType: 'image/png', data: FIX.png! }, { mediaType: 'image/png', data: pdf }]);
    expect(r).toEqual({ ok: false, error: 'image 2 is not a PNG, JPEG, GIF or WebP image' });
  });

  test('base64 that is not base64 is refused rather than decoded leniently', () => {
    // Buffer.from(…, 'base64') skips characters outside the alphabet, so
    // this would otherwise decode to a PNG and be stored with the junk in it.
    const junk = FIX.png!.slice(0, 40) + '!!!!' + FIX.png!.slice(40);
    expect(userImageBlocks([{ mediaType: 'image/png', data: junk }])).toEqual({ ok: false, error: 'the image is not valid base64' });
    expect(userImageBlocks([{ mediaType: 'image/png', data: '' }])).toEqual({ ok: false, error: 'the image is not valid base64' });
  });

  test('the count, per-image and per-message limits hold', () => {
    const L = USER_IMAGE_LIMITS;
    const many = Array.from({ length: L.maxCount + 1 }, () => ({ mediaType: 'image/png', data: FIX.png! }));
    expect(userImageBlocks(many)).toEqual({ ok: false, error: `${L.maxCount + 1} images attached; a message takes at most ${L.maxCount}` });
    expect(userImageBlocks(many.slice(0, L.maxCount)).ok).toBe(true);

    // A real PNG header padded out: the checks read headers, not pixels.
    const padded = (chars: number) => {
      const raw = Buffer.concat([bytes('png'), Buffer.alloc(chars * 3 / 4 - bytes('png').length)]);
      return raw.toString('base64');
    };
    const atCap = padded(L.maxBase64Chars);
    expect(atCap.length).toBe(L.maxBase64Chars);
    expect(userImageBlocks([{ mediaType: 'image/png', data: atCap }]).ok).toBe(true);
    expect(userImageBlocks([{ mediaType: 'image/png', data: padded(L.maxBase64Chars + 4) }]).ok).toBe(false);
    expect(userImageBlocks([{ mediaType: 'image/png', data: padded(7_200_000) }])).toEqual({
      ok: false, error: 'the image is 7.2 MB as base64, over the 5.0 MB limit',
    });
    const three = [atCap, atCap, atCap].map((data) => ({ mediaType: 'image/png', data }));
    expect(userImageBlocks(three)).toEqual({
      ok: false, error: 'the images come to more than 12.6 MB as base64, the most one message carries',
    });
  });
});

describe('walking hostile bytes', () => {
  // The walkers run synchronously in the host's WebSocket handler, so one
  // that never ends freezes the host. These run in a child process with a
  // deadline: a regression fails the test instead of hanging the suite.
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
    `, 5000);
    expect(r).toEqual({ exitCode: 0, out: 'is cut short: the file ends before the image does', err: '' });
  });

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
    `, 30000);
    expect(r).toEqual({ exitCode: 0, out: String(7 * 3000), err: '' });
  }, 40000);
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
});
