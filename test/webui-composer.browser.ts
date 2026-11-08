import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import {
  MAX_WS_FRAME_BYTES,
  WEB_PROTOCOL_VERSION,
  type HistoryPageMessage,
  type UserImageLimits,
  type UserMessageMessage,
  type WebUiClientMessage,
  type WebUiServerMessage,
  type WelcomeMessage,
  type WelcomeMessageEntry,
} from '../src/web/protocol.js';

setDefaultTimeout(60_000);

const REPO = join(import.meta.dir, '..');
const SPA = join(REPO, 'dist', 'web');

interface ScriptedHostOptions {
  limits?: Partial<UserImageLimits>;
}

function scriptedHost(opts: ScriptedHostOptions = {}) {
  const received: WebUiClientMessage[] = [];
  const sockets = new Set<ServerWebSocket<unknown>>();
  let accepting = true;
  const session = { id: 's1', name: 'scripted', autoNamed: false };
  let branch = { id: 'b1', name: 'main' };
  const places = new Map<string, { stored: WelcomeMessageEntry[]; windowFrom: number }>();
  const place = (): string => `${session.id}/${branch.id}`;
  const current = () => {
    let s = places.get(place());
    if (!s) places.set(place(), (s = { stored: [], windowFrom: 0 }));
    return s;
  };
  let holding = false;
  const heldPages: Array<() => void> = [];

  const welcome = (): WelcomeMessage => ({
    type: 'welcome',
    protocolVersion: WEB_PROTOCOL_VERSION,
    recipe: { name: 'scripted' },
    agents: [{ name: 'agent', model: 'scripted' }],
    session,
    branch,
    messages: current().stored.slice(current().windowFrom),
    history: { startIndex: current().windowFrom, totalCount: current().stored.length },
    localTree: { asOfTs: Date.now(), nodes: [], callIdIndex: {} },
    childTrees: [],
    features: ['user-images'],
    userImageLimits: opts.limits ?? { maxSidePx: 2000 },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, srv) {
      const { pathname } = new URL(req.url);
      if (pathname === '/ws') {
        if (!accepting) return new Response('the scripted host is down', { status: 503 });
        return srv.upgrade(req) ? undefined : new Response('not a WebSocket request', { status: 400 });
      }
      const file = Bun.file(join(SPA, pathname === '/' ? 'index.html' : pathname));
      return (await file.exists()) ? new Response(file) : new Response('not found', { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify(welcome()));
      },
      message(ws, data) {
        const frame = JSON.parse(String(data)) as WebUiClientMessage;
        received.push(frame);
        if (frame.type === 'request-history') {
          const { stored } = current();
          const end = Math.min(frame.beforeIndex, stored.length);
          const start = Math.max(0, end - (frame.limit ?? 200));
          const page: HistoryPageMessage = {
            type: 'history-page',
            corrId: frame.corrId,
            sessionId: session.id,
            entries: stored.slice(start, end),
            startIndex: start,
            totalCount: stored.length,
          };
          if (holding) heldPages.push(() => { if (ws.readyState === 1) ws.send(JSON.stringify(page)); });
          else ws.send(JSON.stringify(page));
        }
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });

  const toClients = (msg: WebUiServerMessage): void => {
    for (const ws of sockets) if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  const store = (text: string, corrId?: string): WelcomeMessageEntry => {
    const { stored } = current();
    const entry: WelcomeMessageEntry = {
      id: `${place()}-stored-${stored.length}`,
      index: stored.length,
      participant: 'user',
      blocks: [],
      text,
      timestamp: Date.now(),
      ...(corrId ? { corrId } : {}),
    };
    stored.push(entry);
    return entry;
  };

  return {
    url: `http://127.0.0.1:${server.port}/`,
    received,
    store,
    append(text: string, corrId: string): void {
      toClients({ type: 'message-appended', entry: store(text, corrId) });
    },
    refuse(corrId: string, message = 'message not sent: refused by the scripted host'): void {
      toClients({ type: 'error', corrId, message });
    },
    showFrom(slot: number): void {
      current().windowFrom = slot;
    },
    announceBranch(id: string, name: string): void {
      branch = { id, name };
      toClients({ type: 'branch-changed', branch });
    },
    welcomeAgain(): void {
      toClients(welcome());
    },
    holdHistory(): void {
      holding = true;
    },
    releaseHistory(): void {
      holding = false;
      for (const send of heldPages.splice(0)) send();
    },
    historyAsked: (): number => received.filter((f) => f.type === 'request-history').length,
    drop(o: { accept: boolean }): void {
      accepting = o.accept;
      for (const ws of sockets) ws.close();
    },
    stop: (): void => {
      server.stop(true);
    },
  };
}

type Host = ReturnType<typeof scriptedHost>;

const NO_ANSWER = Symbol('no answer');

async function until<T>(what: string, get: () => T | Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof NO_ANSWER>((resolve) => { timer = setTimeout(() => resolve(NO_ANSWER), ms); });
  let last = 'no answer';
  try {
    for (;;) {
      const v = await Promise.race([get(), deadline]);
      if (v !== NO_ANSWER) {
        if (ok(v as T)) return v as T;
        last = JSON.stringify(v);
      }
      if (v === NO_ANSWER || (await Promise.race([Bun.sleep(25), deadline])) === NO_ANSWER) {
        throw new Error(`timed out waiting for ${what}; last saw ${last}`);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

async function canvasPng(page: Page, w: number, h: number, look: 'red' | 'red-blue' = 'red'): Promise<Buffer> {
  const b64 = await page.evaluate(([w, h, look]) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const red = look === 'red' ? w : Math.round(w / 3);
    ctx.fillStyle = '#c33';
    ctx.fillRect(0, 0, red, h);
    if (look === 'red-blue') {
      ctx.fillStyle = '#33c';
      ctx.fillRect(red, 0, w - red, h);
      const band = Math.round(h * 0.75);
      ctx.fillStyle = '#3c3';
      ctx.fillRect(0, band, w, h - band);
    }
    return canvas.toDataURL('image/png').split(',')[1]!;
  }, [w, h, look] as const);
  return Buffer.from(b64, 'base64');
}

const tileImage = (tile: Locator, fx = 0.5, fy = 0.5): Promise<{ size: number[]; rgba: number[] }> =>
  until("the thumbnail's image", () => tile.locator('img').evaluate(async (img: HTMLImageElement, [fx, fy]) => {
    await img.decode().catch(() => {});
    if (img.naturalWidth === 0) return null;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const at = ctx.getImageData(Math.floor(fx * img.naturalWidth), Math.floor(fy * img.naturalHeight), 1, 1).data;
    return { size: [img.naturalWidth, img.naturalHeight], rgba: [...at] };
  }, [fx, fy] as const), (v) => v !== null) as Promise<{ size: number[]; rgba: number[] }>;

const sentImage = (page: Page, image: { mediaType: string; data: string }, fx = 0.5, fy = 0.5): Promise<{ size: number[]; rgba: number[] }> =>
  page.evaluate(async ({ mediaType, data, fx, fy }) => {
    const img = new Image();
    img.src = `data:${mediaType};base64,${data}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const at = ctx.getImageData(Math.floor(fx * img.naturalWidth), Math.floor(fy * img.naturalHeight), 1, 1).data;
    return { size: [img.naturalWidth, img.naturalHeight], rgba: [...at] };
  }, { ...image, fx, fy });

const isRed = (rgba: number[]): boolean => rgba[0]! > 150 && rgba[1]! < 100 && rgba[2]! < 100 && rgba[3]! > 200;
const isBlue = (rgba: number[]): boolean => rgba[0]! < 100 && rgba[1]! < 100 && rgba[2]! > 150 && rgba[3]! > 200;
const isGreen = (rgba: number[]): boolean => rgba[0]! < 100 && rgba[1]! > 150 && rgba[2]! < 100 && rgba[3]! > 200;
const RED_BLUE_READS: Array<[number, number, (rgba: number[]) => boolean]> = [
  [0.03, 0.5, isRed], [0.28, 0.5, isRed], [0.38, 0.5, isBlue], [0.97, 0.5, isBlue],
  [0.5, 0.03, isBlue], [0.5, 0.7, isBlue], [0.5, 0.8, isGreen], [0.5, 0.97, isGreen],
];

let browser: Browser;
let WIDE_PNG: Buffer;
let DOT_PNG: Buffer;

beforeAll(async () => {
  if (!existsSync(join(SPA, 'index.html'))) {
    throw new Error(`no Web UI build at ${SPA}: run \`npm run build:web\` first`);
  }
  browser = await chromium.launch();
  const page = await browser.newPage();
  WIDE_PNG = await canvasPng(page, 3000, 300, 'red-blue');
  DOT_PNG = await canvasPng(page, 1, 1);
  await page.close();
});

afterAll(async () => {
  await browser?.close();
});

interface Composer {
  host: Host;
  page: Page;
  box: Locator;
}

async function withComposer(body: (c: Composer) => Promise<void>, opts: ScriptedHostOptions & { init?: string } = {}): Promise<void> {
  const host = scriptedHost(opts);
  try {
    await withPage(host.url, (page, box) => body({ host, page, box }), opts.init);
  } finally {
    host.stop();
  }
}

async function withPage(url: string, body: (page: Page, box: Locator) => Promise<void>, init?: string): Promise<void> {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  try {
    if (init) await page.addInitScript(init);
    await page.goto(url);
    const box = page.getByRole('textbox', { name: 'Message' });
    await until('the welcome', () => box.getAttribute('placeholder'), (p) => (p ?? '').includes('paste or drop images'));
    await body(page, box);
    expect(pageErrors).toEqual([]);
  } finally {
    await page.close();
  }
}

async function send(c: Composer, text: string): Promise<UserMessageMessage> {
  const from = c.host.received.length;
  await c.box.fill(text);
  await c.box.press('Enter');
  const frame = await until(
    `the frame for "${text}"`,
    () => c.host.received.slice(from).find((f): f is UserMessageMessage => f.type === 'user-message' && f.content === text),
    (f) => f !== undefined,
  );
  return frame!;
}

const attach = (c: Composer, files: Array<{ name: string; buffer: Buffer }>): Promise<void> =>
  c.page.locator('input[type="file"]').setInputFiles(files.map((f) => ({ ...f, mimeType: 'image/png' })));

const rowsOf = (page: Page, text: string): Locator =>
  page.getByTestId('user-message').filter({ has: page.getByText(text, { exact: true }) });

const REFUSED = 'not sent: the host refused it';
const OLDER = 'scroll to the top or click to load 200 older messages';

const BRANCH_CHIP = 'Chronicle branches — click to browse lineage';

async function refusedWithDraft(c: Composer, text: string): Promise<UserMessageMessage> {
  const frame = await send(c, text);
  await c.box.fill('a second draft');
  c.host.refuse(frame.corrId!);
  await until('the refused mark', () => rowsOf(c.page, text).getByText(REFUSED).count(), (n) => n === 1);
  return frame;
}

async function olderReadyOrAsked(c: Composer): Promise<void> {
  await until('the older-history control enabled, or a request of the pane\'s own',
    async () => c.host.historyAsked() > 1 || await c.page.getByTitle(OLDER).isEnabled().catch(() => false), (v) => v, 3_000);
}

async function pageInOlder(c: Composer, texts: string[]): Promise<boolean> {
  const counts = await Promise.all(texts.map((t) => c.page.getByText(t, { exact: true }).count()));
  if (counts.every((n) => n === 1)) return true;
  if (c.host.historyAsked() === 1) await c.page.getByTitle(OLDER).click({ timeout: 500 }).catch(() => {});
  return false;
}


describe('a message is never lost', () => {
  test('a message sent while the socket is down stays in the composer, with a note', async () => {
    await withComposer(async (c) => {
      c.host.drop({ accept: false });
      await c.page.getByText('Disconnected — retrying').waitFor();
      const from = c.host.received.length;
      await attach(c, [{ name: 'dot.png', buffer: DOT_PNG }]);
      await c.page.getByTitle(/^dot\.png/).waitFor();
      await c.box.fill('cherry');
      await c.box.press('Enter');
      await c.page.getByText('not connected to the host').waitFor();
      expect(await c.box.inputValue()).toBe('cherry');
      expect(await c.page.getByTitle(/^dot\.png/).count()).toBe(1);
      expect(await rowsOf(c.page, 'cherry').count()).toBe(0);
      expect(c.host.received.length).toBe(from);
    });
  });

  test('a refused send survives a change of branch, naming the branch it was sent in, and one sent after branch-changed names none', async () => {
    await withComposer(async (c) => {
      await refusedWithDraft(c, 'lime');
      c.host.announceBranch('b2', 'side');
      await until('the header on the new branch', () => c.page.getByTitle(BRANCH_CHIP).textContent(), (t) => (t ?? '').includes('side'));
      await refusedWithDraft(c, 'pear');
      c.host.welcomeAgain();
      const lime = rowsOf(c.page, 'lime').getByText(/; sent in branch /);
      await until('a mark naming a branch', () => lime.count(), (n) => n === 1);
      expect(await lime.textContent()).toBe(`${REFUSED} (refused by the scripted host); sent in branch main`);
      expect(await rowsOf(c.page, 'pear').getByText(REFUSED).textContent()).toBe(`${REFUSED} (refused by the scripted host)`);
    });
  });

  test("a history page asked for before a change of branch isn't shown after it, and the new branch pages its own", async () => {
    await withComposer(async (c) => {
      c.host.announceBranch('b0', 'long');
      c.host.store('older on long');
      c.host.store('newer on long');
      c.host.showFrom(1);
      c.host.holdHistory();
      c.host.welcomeAgain();
      await until('the welcome with older history', () => c.page.getByText('newer on long', { exact: true }).count(), (n) => n === 1);
      await c.page.getByTitle(/^load ALL/).click();
      const bulk = await until('the bulk request', () => c.host.received.find((f) => f.type === 'request-history'), (f) => f !== undefined);
      expect(bulk?.type === 'request-history' && bulk.limit).toBe(1);
      c.host.announceBranch('b2', 'side');
      c.host.store('oldest on side');
      c.host.store('older on side');
      c.host.store('newer on side');
      c.host.showFrom(2);
      c.host.welcomeAgain();
      await until('the new branch', () => c.page.getByText('newer on side', { exact: true }).count(), (n) => n === 1);
      expect(await c.page.getByText('newer on long', { exact: true }).count()).toBe(0);
      expect(await c.page.getByTitle('stop after the current page').count()).toBe(0);
      await olderReadyOrAsked(c);
      c.host.releaseHistory();
      c.host.append('after the page', 'a corrId of its own');
      await c.page.getByText('after the page', { exact: true }).waitFor();
      expect(await c.page.getByText('older on long', { exact: true }).count()).toBe(0);
      await until("the new branch's own history", () => pageInOlder(c, ['oldest on side', 'older on side']), (v) => v, 5_000);
    });
  });
});

describe('images', () => {
  test('a send carries its image; a refusal puts the text, the image and its notes back into an empty composer, and one that finds another draft there leaves the row marked', async () => {
    await withComposer(async (c) => {
      const cut = 'cut.png is cut short: the file ends before the image does; attach a whole copy';
      await attach(c, [{ name: 'dot.png', buffer: DOT_PNG }, { name: 'cut.png', buffer: DOT_PNG.subarray(0, DOT_PNG.length - 4) }]);
      await c.page.getByTitle(/^dot\.png/).waitFor();
      await c.page.getByText(cut).waitFor();
      const frame = await send(c, 'with a picture');
      expect(frame.images?.map((i) => [i.mediaType, i.data])).toEqual([['image/png', DOT_PNG.toString('base64')]]);
      expect(await c.page.getByTitle(/^dot\.png/).count()).toBe(0);
      await until('the notes cleared by the send', () => c.page.getByText(cut).count(), (n) => n === 0);
      const later = 'later.png is cut short: the file ends before the image does; attach a whole copy';
      await attach(c, [{ name: 'later.png', buffer: DOT_PNG.subarray(0, DOT_PNG.length - 4) }]);
      await c.page.getByText(later).waitFor();
      c.host.refuse(frame.corrId!);
      await until('the message back in the composer', () => c.box.inputValue(), (v) => v === 'with a picture');
      await c.page.getByTitle(/^dot\.png/).waitFor();
      await c.page.getByText(cut).waitFor();
      const notice = (await c.page.getByText(later).textContent()) ?? '';
      expect([notice.indexOf(cut) >= 0, notice.indexOf(cut) < notice.indexOf(later), notice.includes('not sent: the host refused it (refused by the scripted host); the message is back here')])
        .toEqual([true, true, true]);
      expect(await rowsOf(c.page, 'with a picture').count()).toBe(0);
      c.host.welcomeAgain();
      c.host.append('after the welcome', 'a corrId of its own');
      await c.page.getByText('after the welcome', { exact: true }).waitFor();
      expect(await c.page.getByText('not sent: the host refused it (refused by the scripted host); the message is back here').count()).toBe(1);
      const again = await send(c, 'with a picture');
      expect(again.images?.map((i) => [i.mediaType, i.data])).toEqual([['image/png', DOT_PNG.toString('base64')]]);
      await c.box.fill('a second draft');
      c.host.refuse(again.corrId!);
      await until('the refused mark', () => rowsOf(c.page, 'with a picture').getByText(REFUSED).count(), (n) => n === 1);
      expect(await rowsOf(c.page, 'with a picture').getByText('refused by the scripted host').count()).toBe(1);
      expect(await c.box.inputValue()).toBe('a second draft');
      expect(await c.page.getByTitle(/^dot\.png/).count()).toBe(0);
    });
  });

  test('a message over the 16 MiB one message can carry stays in the composer, image and all, with a note, and nothing is sent', async () => {
    await withComposer(async (c) => {
      const from = c.host.received.length;
      await attach(c, [{ name: 'dot.png', buffer: DOT_PNG }]);
      await c.page.getByTitle(/^dot\.png/).waitFor();
      await c.box.fill('x'.repeat(MAX_WS_FRAME_BYTES));
      await c.box.press('Enter');
      await c.page.getByText(/not sent: this message is \d+ bytes over the 16 MiB one message can carry; shorten the text or remove an image/).waitFor();
      expect(await c.box.evaluate((box: HTMLTextAreaElement) => box.value.length)).toBe(MAX_WS_FRAME_BYTES);
      expect(await c.page.getByTitle(/^dot\.png/).count()).toBe(1);
      expect(c.host.received.length).toBe(from);
    });
  });

  test("a send's refusal, and removing an image, leave the notes about files not attached", async () => {
    await withComposer(async (c) => {
      const cut = 'cut.png is cut short: the file ends before the image does; attach a whole copy';
      const slash = 'a slash command takes no images: remove them, or send the images as a message';
      await attach(c, [{ name: 'dot.png', buffer: DOT_PNG }, { name: 'cut.png', buffer: DOT_PNG.subarray(0, DOT_PNG.length - 4) }]);
      await c.page.getByTitle(/^dot\.png/).waitFor();
      await c.page.getByText(cut).waitFor();
      await c.box.fill('/help');
      await c.box.press('Enter');
      await c.page.getByText(slash).waitFor();
      expect(await c.page.getByText(cut).count()).toBe(1);
      await c.page.getByTitle(/^dot\.png/).getByTitle('remove').click();
      await until('the send note cleared', () => c.page.getByText(slash).count(), (n) => n === 0);
      expect(await c.page.getByText(cut).count()).toBe(1);
      await attach(c, [{ name: 'third.png', buffer: DOT_PNG }]);
      await c.page.getByTitle(/^third\.png/).waitFor();
      await c.box.press('Enter');
      await c.page.getByText(slash).waitFor();
      await c.box.fill('an ordinary message');
      expect(await c.page.getByText(slash).count()).toBe(1);
      await attach(c, [{ name: 'second.png', buffer: DOT_PNG }]);
      await until('the send note cleared by a new batch', () => c.page.getByText(slash).count(), (n) => n === 0);
    });
  });

  test("a file dropped or pasted with a type the browser doesn't recognise is read by its bytes, and one that isn't an image is skipped", async () => {
    await withComposer(async (c) => {
      const untyped = (how: 'drop' | 'paste', files: Array<[string, string]>): Promise<void> => c.box.evaluate((box, [files, how]) => {
        const dt = new DataTransfer();
        for (const [name, b64] of files) dt.items.add(new File([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], name, { type: '' }));
        box.dispatchEvent(how === 'drop'
          ? new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
          : new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }, [files, how] as const);
      const png = DOT_PNG.toString('base64');
      await untyped('drop', [['dot.unknown', png], ['notes.unknown', Buffer.from('not an image at all').toString('base64')]]);
      await c.page.getByTitle(/^dot\.unknown/).waitFor();
      await c.page.getByText('1 file(s) skipped: only images can be attached').waitFor();
      expect(await c.page.getByText(/notes\.unknown/).count()).toBe(0);
      await untyped('paste', [['pasted.unknown', png]]);
      await c.page.getByTitle(/^pasted\.unknown/).waitFor();
      const frame = await send(c, 'by its bytes');
      expect(frame.images?.map((i) => i.mediaType)).toEqual(['image/png', 'image/png']);
    });
  });

  test('an image is fitted to the side the welcome advertises, its thumbnail says so, and the fitted image is what is sent', async () => {
    await withComposer(async (c) => {
      await attach(c, [{ name: 'wide.png', buffer: WIDE_PNG }]);
      const tile = c.page.getByTitle(/^wide\.png/);
      await tile.waitFor();
      expect(await tile.getAttribute('title')).toBe('wide.png — shrunk from 3000×300 to 2000×200 and converted from image/png to image/webp to fit');
      expect(await tile.getByText('shrunk', { exact: true }).count()).toBe(1);
      for (const [fx, fy, colour] of RED_BLUE_READS) {
        const shown = await tileImage(tile, fx, fy);
        expect(shown.size).toEqual([2000, 200]);
        expect([fx, fy, colour(shown.rgba)]).toEqual([fx, fy, true]);
      }
      const frame = await send(c, 'a wide picture');
      expect(frame.images?.map((i) => i.mediaType)).toEqual(['image/webp']);
      for (const [fx, fy, colour] of RED_BLUE_READS) {
        const sent = await sentImage(c.page, frame.images![0]!, fx, fy);
        expect(sent.size).toEqual([2000, 200]);
        expect([fx, fy, colour(sent.rgba)]).toEqual([fx, fy, true]);
      }
    });
  });
});
