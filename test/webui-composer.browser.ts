/**
 * The Web UI's composer in a real browser: the built SPA (dist/web) in
 * headless Chromium, against a scripted host on a local socket that speaks
 * the protocol. It checks the composer's wiring in App.tsx and
 * Attachments.tsx, which only a browser runs: a message is never lost, when
 * the host refuses it, when the socket is down, or when a reconnect can't
 * confirm it; an echo replaces exactly the row of its own send; and images
 * are fitted to the limits the host advertises. One check runs the real
 * host instead, headless on the mock provider, for what turns on the host's
 * side of an echo: a text longer than the host sends whole.
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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import {
  WEB_PROTOCOL_VERSION,
  type UserMessageMessage,
  type WebUiClientMessage,
  type WebUiServerMessage,
  type WelcomeMessage,
  type WelcomeMessageEntry,
} from '../src/web/protocol.js';

setDefaultTimeout(60_000);

const REPO = join(import.meta.dir, '..');
const SPA = join(REPO, 'dist', 'web');

/** A host that speaks just enough of the protocol: a welcome holding what it
 *  has stored, then whatever a check sends. */
function scriptedHost() {
  const received: WebUiClientMessage[] = [];
  const stored: WelcomeMessageEntry[] = [];
  const sockets = new Set<ServerWebSocket<unknown>>();
  let accepting = true;
  let connections = 0;

  const welcome = (): WelcomeMessage => ({
    type: 'welcome',
    protocolVersion: WEB_PROTOCOL_VERSION,
    recipe: { name: 'scripted' },
    agents: [{ name: 'agent', model: 'scripted' }],
    session: { id: 's1', name: 'scripted', autoNamed: false },
    branch: { id: 'b1', name: 'main' },
    messages: [...stored],
    history: { startIndex: 0, totalCount: stored.length },
    localTree: { asOfTs: Date.now(), nodes: [], callIdIndex: {} },
    childTrees: [],
    features: ['user-images'],
    // Smaller than the default 8000, so a fitted image shows which it took.
    userImageLimits: { maxSidePx: 2000 },
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
      message(_ws, data) {
        received.push(JSON.parse(String(data)) as WebUiClientMessage);
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });

  const toClients = (msg: WebUiServerMessage): void => {
    for (const ws of sockets) ws.send(JSON.stringify(msg));
  };

  return {
    url: `http://127.0.0.1:${server.port}/`,
    received,
    /** Sockets opened so far: a reconnect makes it 2. */
    connections: () => connections,
    /** Store a user message, as the host does with a send, and send its entry. */
    append(text: string, corrId: string): void {
      const entry: WelcomeMessageEntry = {
        id: `stored-${stored.length}`,
        index: stored.length,
        participant: 'user',
        blocks: [],
        text,
        timestamp: Date.now(),
        corrId,
      };
      stored.push(entry);
      toClients({ type: 'message-appended', entry });
    },
    refuse(corrId: string): void {
      toClients({ type: 'error', corrId, message: 'message not sent: refused by the scripted host' });
    },
    /** Close every socket; `accept: false` refuses the client's reconnects. */
    drop(opts: { accept: boolean }): void {
      accepting = opts.accept;
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
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(v)}`);
    await Bun.sleep(25);
  }
}

let browser: Browser;

beforeAll(async () => {
  if (!existsSync(join(SPA, 'index.html'))) {
    throw new Error(`no Web UI build at ${SPA}: run \`npm run build:web\` first`);
  }
  browser = await chromium.launch();
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
async function withComposer(body: (c: Composer) => Promise<void>): Promise<void> {
  const host = scriptedHost();
  try {
    await withPage(host.url, (page, box) => body({ host, page, box }));
  } finally {
    host.stop();
  }
}

/** A page at `url`, once the welcome has reached the composer, which then
 *  offers images. Uncaught page errors fail the check. */
async function withPage(url: string, body: (page: Page, box: Locator) => Promise<void>): Promise<void> {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  try {
    await page.goto(url);
    const box = page.getByRole('textbox', { name: 'Message' });
    await until('the welcome', () => box.getAttribute('placeholder'), (p) => (p ?? '').includes('paste or drop images'));
    await body(page, box);
    expect(pageErrors).toEqual([]);
  } finally {
    await page.close();
  }
}

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
  const host = Bun.spawn(['bun', join(REPO, 'src', 'index.ts'), recipe, '--headless'], {
    cwd: dir,
    env: { ...process.env, DATA_DIR: join(dir, 'data') },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  try {
    const url = `http://127.0.0.1:${port}/`;
    await until(
      "the host's Web UI",
      () => (host.exitCode !== null ? -1 : fetch(url).then((r) => r.status, () => 0)),
      (s) => s === 200 || s === -1,
      30_000,
    ).then((s) => {
      if (s === -1) throw new Error(`the host exited (${host.exitCode}); its log is ${join(dir, 'data', 'headless.log')}`);
    });
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

/** The transcript's rows of the user's messages whose text is `text`. */
const rowsOf = (page: Page, text: string): Locator =>
  page.getByTestId('user-message').filter({ has: page.getByText(text, { exact: true }) });

const REFUSED = 'not sent: the host refused it';
const UNCONFIRMED = 'not confirmed: it may not have reached the host';

describe('a message is never lost', () => {
  test('a refused send stays in the transcript, marked not sent, while the composer holds another draft', async () => {
    await withComposer(async (c) => {
      const apple = await send(c, 'apple');
      await c.box.fill('a second draft');
      c.host.refuse(apple.corrId!);
      await until('the refused mark', () => rowsOf(c.page, 'apple').getByText(REFUSED).count(), (n) => n === 1);
      expect(await rowsOf(c.page, 'apple').count()).toBe(1);
      expect(await c.box.inputValue()).toBe('a second draft');
    });
  });

  test('a refused send goes back into an empty composer, and its row comes out', async () => {
    await withComposer(async (c) => {
      const damson = await send(c, 'damson');
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

  test('after a reconnect, a send the welcome lacks stays, marked not confirmed, until its echo; a refused row keeps its mark', async () => {
    await withComposer(async (c) => {
      const apple = await send(c, 'apple');
      await c.box.fill('a second draft');
      c.host.refuse(apple.corrId!);
      await until('the refused mark', () => rowsOf(c.page, 'apple').getByText(REFUSED).count(), (n) => n === 1);
      const banana = await send(c, 'banana');
      c.host.drop({ accept: true });
      await until('the reconnect', () => c.host.connections(), (n) => n === 2);
      await until('the unconfirmed mark', () => rowsOf(c.page, 'banana').getByText(UNCONFIRMED).count(), (n) => n === 1);
      expect(await rowsOf(c.page, 'apple').getByText(REFUSED).count()).toBe(1);
      c.host.append('banana', banana.corrId!);
      await until('the late echo in place of the row', () => c.page.getByText(UNCONFIRMED).count(), (n) => n === 0);
      expect(await rowsOf(c.page, 'banana').count()).toBe(1);
      expect(await rowsOf(c.page, 'apple').getByText(REFUSED).count()).toBe(1);
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
  test('an image is fitted to the side the welcome advertises, and its thumbnail says so', async () => {
    await withComposer(async (c) => {
      const png = await c.page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 3000;
        canvas.height = 100;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#c33';
        ctx.fillRect(0, 0, 3000, 100);
        return canvas.toDataURL('image/png').split(',')[1]!;
      });
      await c.page.locator('input[type="file"]').setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
      const tile = c.page.getByTitle(/^wide\.png/);
      await tile.waitFor();
      expect(await tile.getAttribute('title')).toBe('wide.png — shrunk from 3000×100 to 2000×67 to fit');
      expect(await tile.getByText('shrunk', { exact: true }).count()).toBe(1);
    });
  });

  test('an animated GIF sent as picked is marked first frame', async () => {
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
  test("a text longer than the host's 64 KiB cap shows once, as the host's copy", async () => {
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
        // The host's copy, cut at 64 KiB, not the 70,016 characters sent.
        const shown = await rows.last().evaluate((el) => el.textContent ?? '');
        expect(shown.includes(text.slice(0, 64 * 1024))).toBe(true);
        expect(shown.includes(text)).toBe(false);
      }),
    );
  });
});

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
