/**
 * Composer images over the real WebSocket: what reaches the framework as the
 * operator's message, what is refused before it does, and that a host which
 * takes images says so in its welcome.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  __getSharedServerPortForTests,
  __resetSharedServerForTests,
} from '../src/modules/web-ui-module.js';
import { USER_IMAGE_LIMITS } from '../src/web/protocol.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/user-images.json', import.meta.url), 'utf-8')) as Record<string, string>;
const AUTH = `Basic ${Buffer.from('admin:pw').toString('base64')}`;

let webUiModule: WebUiModule;
let port: number;
const pushed: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  webUiModule = new WebUiModule({ port: 0, host: '127.0.0.1', basicAuth: { username: 'admin', password: 'pw' } });
  await webUiModule.start({} as ModuleContext);
  port = __getSharedServerPortForTests()!;
  webUiModule.setApp({
    framework: {
      getAllAgents: () => [],
      getAllModules: () => [],
      onTrace: () => {},
      pushEvent: (e: Record<string, unknown>) => { pushed.push(e); },
    },
    sessionManager: { getActiveSession: () => ({ id: 's', name: 's', manuallyNamed: true }) },
    recipe: { name: 'recipe', agent: {} },
  } as never);
});

afterAll(async () => {
  await webUiModule.stop();
  await __resetSharedServerForTests();
});

/** An operator connection, with every frame it has been sent. */
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { origin: `http://127.0.0.1:${port}`, authorization: AUTH },
  } as unknown as undefined);
  const frames: Array<Record<string, unknown>> = [];
  ws.addEventListener('message', (ev) => frames.push(JSON.parse(String(ev.data))));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws never opened')), 5000);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
    ws.addEventListener('error', (e) => { clearTimeout(t); reject(e as unknown as Error); });
  });
  const until = async <T>(pick: () => T | undefined, what: string): Promise<T> => {
    for (let i = 0; i < 200; i++) {
      const v = pick();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  return { ws, frames, until };
}

/** Send one user message and return what the framework was handed, or the
 *  error frame the host answered with instead. */
async function send(msg: Record<string, unknown>) {
  const c = await connect();
  await c.until(() => c.frames.find((f) => f.type === 'welcome'), 'welcome');
  const before = pushed.length;
  c.ws.send(JSON.stringify({ type: 'user-message', ...msg }));
  const result = await c.until(
    () => pushed.length > before ? { pushed: pushed[before]! }
      : c.frames.find((f) => f.type === 'error') ? { error: String(c.frames.find((f) => f.type === 'error')!.message) }
      : undefined,
    'the message to be pushed or refused',
  );
  c.ws.close();
  return result;
}

describe('composer images over the WebSocket', () => {
  test("the welcome says this host takes images", async () => {
    const c = await connect();
    const welcome = await c.until(() => c.frames.find((f) => f.type === 'welcome'), 'welcome');
    expect(welcome.features).toContain('user-images');
    c.ws.close();
  });

  test('images and text reach the framework as one message, images first', async () => {
    const r = await send({
      content: 'what is in these?',
      images: [{ mediaType: 'image/png', data: FIX.png }, { mediaType: 'image/webp', data: FIX.webpLossy }],
    });
    expect(r.pushed).toMatchObject({ type: 'external-message', source: 'tui', triggerInference: true });
    expect(r.pushed!.content).toEqual([
      { type: 'image', source: { type: 'base64', data: FIX.png, mediaType: 'image/png' } },
      { type: 'image', source: { type: 'base64', data: FIX.webpLossy, mediaType: 'image/webp' } },
      { type: 'text', text: 'what is in these?' },
    ]);
  });

  test('images alone carry no empty text block', async () => {
    const r = await send({ content: '', images: [{ mediaType: 'image/gif', data: FIX.gif }] });
    expect(r.pushed!.content).toEqual([{ type: 'image', source: { type: 'base64', data: FIX.gif, mediaType: 'image/gif' } }]);
  });

  test('a message without images is pushed as before', async () => {
    expect((await send({ content: 'plain' })).pushed!.content).toBe('plain');
    expect((await send({ content: 'plain', images: [] })).pushed!.content).toBe('plain');
  });

  test('an image the model API would refuse is answered with the reason, and nothing is pushed', async () => {
    const before = pushed.length;
    const r = await send({ content: 'big', images: [{ mediaType: 'image/png', data: FIX.png8001x1 }] });
    expect(r.error).toBe('message not sent: the image is 8001×1; the model API takes at most 8000 px on a side');
    expect(pushed.length).toBe(before);
  });

  test("a refusal names the send's corrId, so the client can take its row back", async () => {
    const c = await connect();
    await c.until(() => c.frames.find((f) => f.type === 'welcome'), 'welcome');
    c.ws.send(JSON.stringify({ type: 'user-message', content: '', corrId: 'm7', images: [{ mediaType: 'image/png', data: FIX.png8001x1 }] }));
    const err = await c.until(() => c.frames.find((f) => f.type === 'error'), 'the refusal');
    expect(err.corrId).toBe('m7');
    c.ws.close();
  });

  const atCap = (): string => {
    const png = Buffer.from(FIX.png!, 'base64');
    return Buffer.concat([png, Buffer.alloc(USER_IMAGE_LIMITS.maxBase64Chars * 3 / 4 - png.length)]).toString('base64');
  };

  test('an image at the per-image cap fits in one frame', async () => {
    const r = await send({ content: '', images: [{ mediaType: 'image/png', data: atCap() }] });
    expect((r.pushed!.content as Array<{ source: { data: string } }>)[0]!.source.data.length).toBe(USER_IMAGE_LIMITS.maxBase64Chars);
  });

  test('a frame over the per-message total still arrives, and is refused by the host, not the socket', async () => {
    // 15 MB of images: over the 12 MiB total, under Bun's 16 MiB frame limit.
    const data = atCap();
    const r = await send({ content: '', images: [data, data, data].map((d) => ({ mediaType: 'image/png', data: d })) });
    expect(r.error).toBe('message not sent: the images come to more than 12.6 MB as base64, the most one message carries');
  });
});
