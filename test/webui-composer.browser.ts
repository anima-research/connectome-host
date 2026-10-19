/**
 * The Web UI's composer in a real browser: the built SPA (dist/web) in
 * headless Chromium, against a scripted host on a local socket that speaks
 * the protocol. It checks the composer's wiring in App.tsx and
 * Attachments.tsx, which only a browser runs: a message is never lost, when
 * the host refuses it, when the socket is down, when a reconnect or a change
 * of session can't confirm it; an echo, or a history page, settles exactly
 * the row of its own send; and images are fitted to the limits the host
 * advertises and go out with their send. One check runs the real host
 * instead, headless on the mock provider, for what turns on the host's side
 * of an echo: a text past the 64 KiB of it the host sends.
 *
 * Not part of `npm test`, since it needs the Web UI built and Chromium:
 *
 *   npm run build:web
 *   npx playwright-core install --only-shell chromium
 *   npm run test:browser
 *
 * Each check opens its own page on its own host and waits on what the page
 * shows, not on time.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import {
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
  /** The limits its welcome advertises; by default a side of 2000, smaller
   *  than the default 8000, so a fitted image shows which it took. */
  limits?: Partial<UserImageLimits>;
}

/** A host that speaks just enough of the protocol: a welcome holding what its
 *  session and branch have stored, pages of older history, then whatever a
 *  check sends. */
function scriptedHost(opts: ScriptedHostOptions = {}) {
  const received: WebUiClientMessage[] = [];
  const sockets = new Set<ServerWebSocket<unknown>>();
  let accepting = true;
  let connections = 0;
  let session = { id: 's1', name: 'scripted', autoNamed: false };
  let branch = { id: 'b1', name: 'main' };
  /** Each session and branch's stored messages, and the slot its welcome's
   *  window starts at. */
  const places = new Map<string, { stored: WelcomeMessageEntry[]; windowFrom: number }>();
  const place = (): string => `${session.id}/${branch.id}`;
  const current = () => {
    let s = places.get(place());
    if (!s) places.set(place(), (s = { stored: [], windowFrom: 0 }));
    return s;
  };

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
        connections++;
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
            entries: stored.slice(start, end),
            startIndex: start,
            totalCount: stored.length,
          };
          ws.send(JSON.stringify(page));
        }
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });

  const toClients = (msg: WebUiServerMessage): void => {
    for (const ws of sockets) ws.send(JSON.stringify(msg));
  };

  /** Store a user message in the current session and branch without sending
   *  its entry, as while a client is away. */
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
    /** Sockets opened so far: a reconnect makes it 2. */
    connections: () => connections,
    store,
    /** Store a user message, as the host does with a send, and send its entry. */
    append(text: string, corrId: string): void {
      toClients({ type: 'message-appended', entry: store(text, corrId) });
    },
    refuse(corrId: string, message = 'message not sent: refused by the scripted host'): void {
      toClients({ type: 'error', corrId, message });
    },
    /** From the current session's next welcome on, its window starts at this
     *  slot, and older entries come in history pages. */
    showFrom(slot: number): void {
      current().windowFrom = slot;
    },
    /** From the next welcome on, it's for this session, with what it holds. */
    switchSession(id: string, name: string): void {
      session = { id, name, autoNamed: false };
    },
    /** Check out another branch, as the host does: branch-changed to every
     *  client, then a welcome for the new branch. */
    changeBranch(id: string, name: string): void {
      branch = { id, name };
      toClients({ type: 'branch-changed', branch });
      toClients(welcome());
    },
    /** Close every socket; `accept: false` refuses the client's reconnects. */
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

/** Poll `get` until `ok` holds of what it returns; throw, with the last value,
 *  after `ms`. The bound only stops a check that would otherwise hang. */
async function until<T>(what: string, get: () => T | Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = performance.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(v)}`);
    await Bun.sleep(25);
  }
}

/** A PNG a canvas draws: one red fill, or, with `noise`, pixels that don't
 *  compress, so its size is about four bytes a pixel. */
async function canvasPng(page: Page, w: number, h: number, noise = false): Promise<Buffer> {
  const b64 = await page.evaluate(([w, h, noise]) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    if (noise) {
      const img = ctx.createImageData(w, h);
      for (let i = 0; i < img.data.length; i++) img.data[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256);
      ctx.putImageData(img, 0, 0);
    } else {
      ctx.fillStyle = '#c33';
      ctx.fillRect(0, 0, w, h);
    }
    return canvas.toDataURL('image/png').split(',')[1]!;
  }, [w, h, noise] as const);
  return Buffer.from(b64, 'base64');
}

let browser: Browser;
let WIDE_PNG: Buffer;
let DOT_PNG: Buffer;
let NOISE_PNG: Buffer;

beforeAll(async () => {
  if (!existsSync(join(SPA, 'index.html'))) {
    throw new Error(`no Web UI build at ${SPA}: run \`npm run build:web\` first`);
  }
  browser = await chromium.launch();
  const page = await browser.newPage();
  WIDE_PNG = await canvasPng(page, 3000, 100);
  DOT_PNG = await canvasPng(page, 1, 1);
  NOISE_PNG = await canvasPng(page, 30, 30, true);
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

/** A page (withPage) on a fresh scripted host. */
async function withComposer(body: (c: Composer) => Promise<void>, opts: ScriptedHostOptions & { init?: string } = {}): Promise<void> {
  const host = scriptedHost(opts);
  try {
    await withPage(host.url, (page, box) => body({ host, page, box }), opts.init);
  } finally {
    host.stop();
  }
}

/** A page at `url`, once the welcome has reached the composer, which then
 *  offers images; `init` runs in it before the SPA does. Uncaught page
 *  errors fail the check. */
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

/** The last lines of a file, or a word that there's none. */
const tail = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').slice(-20).join('\n') : '(none)');

/** The real host, headless, on the mock provider (no provider is called),
 *  with its Web UI on a free local port and its own data directory. */
async function withRealHost(body: (url: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'webui-composer-'));
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  const recipe = join(dir, 'recipe.json');
  writeFileSync(recipe, JSON.stringify({
    name: 'Browser check',
    agent: {
      name: 'agent',
      provider: 'mock',
      systemPrompt: 'A mock agent for the browser check.',
      mock: { echoMode: false, defaultResponse: 'noted' },
    },
    modules: {
      subagents: false,
      lessons: false,
      retrieval: false,
      wake: false,
      workspace: false,
      webui: { host: '127.0.0.1', port },
    },
  }));
  // The Bun running this check runs the host too. What the host writes
  // before its headless log takes over goes to a file beside it.
  const stderrPath = join(dir, 'host-stderr.log');
  const host = Bun.spawn([process.execPath, join(REPO, 'src', 'index.ts'), recipe, '--headless'], {
    cwd: dir,
    env: { ...process.env, DATA_DIR: join(dir, 'data') },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: Bun.file(stderrPath),
  });
  try {
    const url = `http://127.0.0.1:${port}/`;
    const status = await until(
      "the host's Web UI",
      () => (host.exitCode !== null ? -1 : fetch(url).then((r) => r.status, () => 0)),
      (s) => s === 200 || s === -1,
      30_000,
    );
    if (status === -1) {
      throw new Error(`the host exited (${host.exitCode}) before its Web UI answered.\n`
        + `stderr:\n${tail(stderrPath)}\nheadless.log:\n${tail(join(dir, 'data', 'headless.log'))}`);
    }
    await body(url);
  } finally {
    host.kill();
    const exited = await Promise.race([host.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
    if (!exited) host.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Type `text` and press Enter; the user-message frame the host received. */
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

/** Attach files through the composer's file input. */
const attach = (c: Composer, files: Array<{ name: string; buffer: Buffer }>): Promise<void> =>
  c.page.locator('input[type="file"]').setInputFiles(files.map((f) => ({ ...f, mimeType: 'image/png' })));

/** The transcript's rows of the user's messages whose text is `text`. */
const rowsOf = (page: Page, text: string): Locator =>
  page.getByTestId('user-message').filter({ has: page.getByText(text, { exact: true }) });

const REFUSED = 'not sent: the host refused it';
const UNCONFIRMED = 'not confirmed: it may not have reached the host';
/** The title of the control that loads older history. */
const OLDER = 'scroll to the top or click to load 200 older messages';

/** Send `text`, then refuse it while the composer holds another draft, so its
 *  row stays, marked refused. */
async function refusedWithDraft(c: Composer, text: string): Promise<UserMessageMessage> {
  const frame = await send(c, text);
  await c.box.fill('a second draft');
  c.host.refuse(frame.corrId!);
  await until('the refused mark', () => rowsOf(c.page, text).getByText(REFUSED).count(), (n) => n === 1);
  return frame;
}

describe('a message is never lost', () => {
  test('a refused send stays in the transcript, marked not sent with the reason, while the composer holds another draft', async () => {
    await withComposer(async (c) => {
      await refusedWithDraft(c, 'apple');
      expect(await rowsOf(c.page, 'apple').count()).toBe(1);
      expect(await rowsOf(c.page, 'apple').getByText('refused by the scripted host').count()).toBe(1);
      expect(await c.box.inputValue()).toBe('a second draft');
    });
  });

  test('a refused send goes back into an empty composer, and its row comes out', async () => {
    await withComposer(async (c) => {
      const damson = await send(c, 'damson');
      await until('the composer emptied', () => c.box.inputValue(), (v) => v === '');
      expect(await rowsOf(c.page, 'damson').count()).toBe(1);
      c.host.refuse(damson.corrId!);
      await until('the message back in the composer', () => c.box.inputValue(), (v) => v === 'damson');
      expect(await rowsOf(c.page, 'damson').count()).toBe(0);
    });
  });

  test('a message sent while the socket is down stays in the composer, with a note', async () => {
    await withComposer(async (c) => {
      c.host.drop({ accept: false });
      await c.page.getByText('Disconnected — retrying').waitFor();
      const from = c.host.received.length;
      await c.box.fill('cherry');
      await c.box.press('Enter');
      await c.page.getByText('not connected to the host').waitFor();
      expect(await c.box.inputValue()).toBe('cherry');
      expect(await rowsOf(c.page, 'cherry').count()).toBe(0);
      expect(c.host.received.length).toBe(from);
    });
  });

  test('after a reconnect, a send the welcome lacks stays, marked not confirmed, until its echo; a refused row keeps its mark and reason', async () => {
    await withComposer(async (c) => {
      await refusedWithDraft(c, 'apple');
      const banana = await send(c, 'banana');
      c.host.drop({ accept: true });
      await until('the reconnect', () => c.host.connections(), (n) => n === 2);
      await until('the unconfirmed mark', () => rowsOf(c.page, 'banana').getByText(UNCONFIRMED).count(), (n) => n === 1);
      expect(await rowsOf(c.page, 'apple').getByText(REFUSED).count()).toBe(1);
      expect(await rowsOf(c.page, 'apple').getByText('refused by the scripted host').count()).toBe(1);
      c.host.append('banana', banana.corrId!);
      await until('the late echo in place of the row', () => c.page.getByText(UNCONFIRMED).count(), (n) => n === 0);
      expect(await rowsOf(c.page, 'banana').count()).toBe(1);
      expect(await rowsOf(c.page, 'apple').getByText(REFUSED).count()).toBe(1);
    });
  });

  test('a refused send survives a change of session, naming the session it was sent in', async () => {
    await withComposer(async (c) => {
      await refusedWithDraft(c, 'kiwi');
      c.host.switchSession('s2', 'another');
      c.host.drop({ accept: true });
      await until('the reconnect', () => c.host.connections(), (n) => n === 2);
      await until('the mark naming the session', () => rowsOf(c.page, 'kiwi').getByText('sent in session scripted').count(), (n) => n === 1);
      expect(await rowsOf(c.page, 'kiwi').getByText(REFUSED).count()).toBe(1);
    });
  });

  test('a refused send survives a change of branch, naming the branch it was sent in', async () => {
    await withComposer(async (c) => {
      await refusedWithDraft(c, 'lime');
      c.host.changeBranch('b2', 'side');
      const mark = rowsOf(c.page, 'lime').getByText(/; sent in branch /);
      await until('a mark naming a branch', () => mark.count(), (n) => n === 1);
      expect(await mark.textContent()).toBe(`${REFUSED} (message not sent: refused by the scripted host); sent in branch main`);
    });
  });

  test("a history page holding a kept send's stored copy settles it, as after leaving its session and coming back", async () => {
    await withComposer(async (c) => {
      const fig = await send(c, 'fig');
      c.host.drop({ accept: false });
      await c.page.getByText('Disconnected — retrying').waitFor();
      c.host.switchSession('s2', 'another');
      c.host.drop({ accept: true });
      await until('the send kept in the other session', () => rowsOf(c.page, 'fig').getByText('sent in session scripted').count(), (n) => n === 1);
      // Back in the first session, which stored "fig" and moved on: its
      // window holds only "grape", so "fig" is kept again, marked unconfirmed,
      // and its stored copy is one history page up.
      c.host.drop({ accept: false });
      await c.page.getByText('Disconnected — retrying').waitFor();
      c.host.switchSession('s1', 'scripted');
      c.host.store('fig', fig.corrId);
      c.host.store('grape');
      c.host.showFrom(1);
      c.host.drop({ accept: true });
      await until('the first session again', () => c.page.getByText('grape', { exact: true }).count(), (n) => n === 1);
      // A pane near its top asks for older history itself, as this short one
      // may; if it hasn't, ask as a person would.
      const asked = (): boolean => c.host.received.some((f) => f.type === 'request-history');
      await until('the older-history control', async () => asked() || (await c.page.getByTitle(OLDER).count()) > 0, (v) => v);
      if (!asked()) await c.page.getByTitle(OLDER).click({ timeout: 5_000 }).catch(() => {});
      await until('the history request', asked, (a) => a);
      // Unsettled, the kept row would stay marked beside the stored copy.
      await until('the page settling the row', async () => [
        await c.page.getByText(UNCONFIRMED).count(),
        await rowsOf(c.page, 'fig').count(),
      ], ([marks, rows]) => marks === 0 && rows === 1);
    });
  });
});

describe('echoes', () => {
  test("an echo replaces its own send's row, by corrId, and another client's look-alike doesn't take it", async () => {
    await withComposer(async (c) => {
      const plum = await send(c, 'plum');
      c.host.append('plum', 'a corrId from another client');
      c.host.append('plum, as the host stored it', plum.corrId!);
      const rows = c.page.getByTestId('user-message');
      await until('both entries', () => rows.count(), (n) => n === 2);
      await until('the echo in place', () => rows.nth(0).getByText('plum, as the host stored it', { exact: true }).count(), (n) => n === 1);
      expect(await rows.nth(1).getByText('plum', { exact: true }).count()).toBe(1);
    });
  });
});

describe('images', () => {
  test('a send carries its image, and a refusal puts the text and the image back into an empty composer', async () => {
    await withComposer(async (c) => {
      await attach(c, [{ name: 'dot.png', buffer: DOT_PNG }]);
      await c.page.getByTitle(/^dot\.png/).waitFor();
      const frame = await send(c, 'with a picture');
      expect(frame.images?.map((i) => [i.mediaType, i.data])).toEqual([['image/png', DOT_PNG.toString('base64')]]);
      expect(await c.page.getByTitle(/^dot\.png/).count()).toBe(0);
      c.host.refuse(frame.corrId!);
      await until('the message back in the composer', () => c.box.inputValue(), (v) => v === 'with a picture');
      await c.page.getByTitle(/^dot\.png/).waitFor();
    });
  });

  test('a refusal while an image is still being read keeps the row, so the message stays out of the draft being made', async () => {
    await withComposer(async (c) => {
      const elder = await send(c, 'elder');
      await attach(c, [{ name: 'dot.png', buffer: DOT_PNG }]);
      await c.page.getByText('reading 1 image').waitFor();
      c.host.refuse(elder.corrId!);
      await until('the refused mark', () => rowsOf(c.page, 'elder').getByText(REFUSED).count(), (n) => n === 1);
      expect(await c.box.inputValue()).toBe('');
      await c.page.evaluate(() => (window as unknown as { releaseFileReads: () => void }).releaseFileReads());
      await c.page.getByTitle(/^dot\.png/).waitFor();
      expect(await c.box.inputValue()).toBe('');
    }, { init: HOLD_FILE_READS });
  });

  test('an image is fitted to the side the welcome advertises, and its thumbnail says so', async () => {
    await withComposer(async (c) => {
      await attach(c, [{ name: 'wide.png', buffer: WIDE_PNG }]);
      const tile = c.page.getByTitle(/^wide\.png/);
      await tile.waitFor();
      expect(await tile.getAttribute('title')).toBe('wide.png — shrunk from 3000×100 to 2000×67 to fit');
      expect(await tile.getByText('shrunk', { exact: true }).count()).toBe(1);
      // The image itself, not only its note.
      expect(await tile.locator('img').evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([2000, 67]);
    });
  });

  test('where the canvas draws nothing at a size, or writes no WebP, the fit goes smaller and flattens onto white', async () => {
    await withComposer(async (c) => {
      await attach(c, [{ name: 'wide.png', buffer: WIDE_PNG }]);
      const tile = c.page.getByTitle(/^wide\.png/);
      await tile.waitFor();
      expect(await tile.getAttribute('title'))
        .toBe('wide.png — shrunk from 3000×100 to 1400×47 to fit, as a JPEG on white, which flattens any transparency');
      expect(await tile.locator('img').evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([1400, 47]);
    }, { init: CANVAS_LIKE_A_SMALLER_SAFARI });
  });

  test("an image past the count the welcome advertises isn't attached, and the note says why", async () => {
    await withComposer(async (c) => {
      await attach(c, [1, 2, 3].map((n) => ({ name: `dot${n}.png`, buffer: DOT_PNG })));
      await c.page.getByText('1 image(s) not attached: a message takes at most 2').waitFor();
      expect(await c.page.getByTitle(/^dot\d\.png/).count()).toBe(2);
    }, { limits: { maxCount: 2 } });
  });

  test("an image past the total the welcome advertises isn't attached, and the note says why", async () => {
    // Each image is over half the total, and under all of it.
    const each = Math.ceil(NOISE_PNG.length / 3) * 4;
    expect(each > 3_000 && each <= 6_000).toBe(true);
    await withComposer(async (c) => {
      await attach(c, [1, 2].map((n) => ({ name: `noise${n}.png`, buffer: NOISE_PNG })));
      await c.page.getByText('noise2.png not attached: the images would come to more than 6,000 characters of base64').waitFor();
      expect(await c.page.getByTitle(/^noise\d\.png/).count()).toBe(1);
    }, { limits: { maxTotalBase64Chars: 6_000 } });
  });

  test('an animated GIF attached as picked is marked first frame', async () => {
    await withComposer(async (c) => {
      await c.page.locator('input[type="file"]').setInputFiles({ name: 'blink.gif', mimeType: 'image/gif', buffer: TWO_FRAME_GIF });
      const tile = c.page.getByTitle(/^blink\.gif/);
      await tile.waitFor();
      expect(await tile.getAttribute('title')).toBe('blink.gif — animated: the model sees only its first frame');
      expect(await tile.getByText('first frame', { exact: true }).count()).toBe(1);
    });
  });
});

describe('with the real host', () => {
  // Its waits can take up to 85 s between them, so a slow one reports by name.
  test("a text past the host's 64 KiB shows once, as the host's copy", async () => {
    await withRealHost((url) =>
      withPage(url, async (page, box) => {
        // The host may store messages of its own at the start of a session,
        // such as the local time, so count the rows this send adds.
        const rows = page.getByTestId('user-message');
        const before = await rows.count();
        const text = `long-echo-probe ${'c'.repeat(70_000)}`;
        await box.fill(text);
        await box.press('Enter');
        // The mock agent answers after the host has stored the message and
        // sent its entry.
        await page.getByText('noted', { exact: true }).waitFor({ timeout: 30_000 });
        expect(await rows.count()).toBe(before + 1);
        // The host's copy, cut at 64 KiB of UTF-8: for this ASCII text, the
        // first 65,536 characters, and not one more.
        const shown = await rows.last().evaluate((el) => el.textContent ?? '');
        expect(shown.includes(text.slice(0, 65_536))).toBe(true);
        expect(shown.includes(text.slice(0, 65_537))).toBe(false);
      }),
    );
  }, 120_000);
});

/** In the page, before the SPA runs: a canvas wider than 1500 px gives no 2D
 *  context, as a browser does past its limits, and a WebP asked of toBlob
 *  comes back as PNG, as Safari's does. */
const CANVAS_LIKE_A_SMALLER_SAFARI = `(() => {
  const proto = HTMLCanvasElement.prototype;
  const getContext = proto.getContext;
  proto.getContext = function (type, ...rest) {
    return this.width > 1500 ? null : getContext.call(this, type, ...rest);
  };
  const toBlob = proto.toBlob;
  proto.toBlob = function (callback, type, quality) {
    return toBlob.call(this, callback, type === 'image/webp' ? 'image/png' : type, quality);
  };
})();`;

/** In the page, before the SPA runs: a picked file's bytes are held until
 *  the check calls releaseFileReads(), so a check can act while an image is
 *  still being read. */
const HOLD_FILE_READS = `(() => {
  const read = Blob.prototype.arrayBuffer;
  const held = [];
  Blob.prototype.arrayBuffer = function () {
    if (!(this instanceof File)) return read.call(this);
    return new Promise((resolve) => held.push(() => resolve(read.call(this))));
  };
  window.releaseFileReads = () => { for (const go of held.splice(0)) go(); };
})();`;

/** A 1×1 GIF of two frames, black then white. */
const TWO_FRAME_GIF = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xff, 0xff, 0xff,
  0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00,
  0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x4c, 0x01, 0x00,
  0x3b,
]);
