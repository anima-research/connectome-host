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
import { MAX_WS_FRAME_BYTES, USER_IMAGE_LIMITS, frameLimitNote, wsFrameBytes } from '../src/web/protocol.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/user-images.json', import.meta.url), 'utf-8')) as Record<string, string>;
const AUTH = `Basic ${Buffer.from('admin:pw').toString('base64')}`;

let webUiModule: WebUiModule;
let port: number;
const pushed: Array<Record<string, unknown>> = [];
/** The listener the module gave the framework for its traces. */
let emitTrace: ((event: Record<string, unknown>) => void) | undefined;
/** The bound app's recipe agent, which the module reads its image limits from
 *  at each welcome and each send. */
const agent: { strategy?: Record<string, unknown> } = {};

beforeAll(async () => {
  webUiModule = new WebUiModule({ port: 0, host: '127.0.0.1', basicAuth: { username: 'admin', password: 'pw' } });
  await webUiModule.start({} as ModuleContext);
  port = __getSharedServerPortForTests()!;
  webUiModule.setApp({
    framework: {
      getAllAgents: () => [],
      getAllModules: () => [],
      onTrace: (listener: (event: Record<string, unknown>) => void) => { emitTrace = listener; },
      pushEvent: (e: Record<string, unknown>) => { pushed.push(e); },
    },
    sessionManager: { getActiveSession: () => ({ id: 's', name: 's', manuallyNamed: true }) },
    recipe: { name: 'recipe', agent },
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
  const until = async <T>(pick: () => T | undefined, what: string, waitMs = 5000): Promise<T> => {
    const deadline = performance.now() + waitMs;
    for (;;) {
      const v = pick();
      if (v !== undefined) return v;
      if (performance.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { ws, frames, until };
}

/** Send one user message and return what the framework was handed, or the
 *  error frame the host answered with instead. */
async function send(msg: Record<string, unknown>, waitMs?: number) {
  const c = await connect();
  await c.until(() => c.frames.find((f) => f.type === 'welcome'), 'welcome');
  const before = pushed.length;
  c.ws.send(JSON.stringify({ type: 'user-message', ...msg }));
  const result = await c.until(
    () => pushed.length > before ? { pushed: pushed[before]! }
      : c.frames.find((f) => f.type === 'error') ? { error: String(c.frames.find((f) => f.type === 'error')!.message) }
      : undefined,
    'the message to be pushed or refused',
    waitMs,
  );
  c.ws.close();
  return result;
}

describe('composer images over the WebSocket', () => {
  test("the welcome says this host takes images, and the limits its recipe sets", async () => {
    const c = await connect();
    const welcome = await c.until(() => c.frames.find((f) => f.type === 'welcome'), 'welcome');
    expect(welcome.features).toContain('user-images');
    // This recipe names no strategy: the autobiographical default keeps 6
    // images live, so a message takes at most 6.
    expect(welcome.userImageLimits).toEqual({ ...USER_IMAGE_LIMITS, maxCount: 6 });
    c.ws.close();
  });

  test("a process trace reaches clients without its images' base64", async () => {
    const c = await connect();
    await c.until(() => c.frames.find((f) => f.type === 'welcome'), 'welcome');
    const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: FIX.png } };
    emitTrace!({ type: 'process:received', processEvent: { type: 'external-message', content: [image] } });
    const trace = await c.until(() => c.frames.find((f) => f.type === 'trace'), 'the trace');
    expect(trace.event).toEqual({
      type: 'process:received',
      processEvent: { type: 'external-message', content: [
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: `[${FIX.png!.length} base64 characters, not sent in traces]` } },
      ] },
    });
    c.ws.close();
  });

  test("a dropped tool result's images reach clients as notes too", async () => {
    const c = await connect();
    await c.until(() => c.frames.find((f) => f.type === 'welcome'), 'welcome');
    // agent-framework 0.22.1's shape: the result whole, its image's data at
    // the block's top level as a tool result carries it.
    emitTrace!({
      type: 'tool:result_dropped', agentName: 'agent', callId: 't1', agentStatus: 'idle',
      result: { content: [{ type: 'image', data: FIX.png, mimeType: 'image/png' }] },
    });
    const trace = await c.until(() => c.frames.find((f) => f.type === 'trace'), 'the trace');
    expect(trace.event).toEqual({
      type: 'tool:result_dropped', agentName: 'agent', callId: 't1', agentStatus: 'idle',
      result: { content: [{ type: 'image', data: `[${FIX.png!.length} base64 characters, not sent in traces]`, mimeType: 'image/png' }] },
    });
    c.ws.close();
  });

  test("a fleet child's traces reach clients without their images' base64", async () => {
    const c = await connect();
    await c.until(() => c.frames.find((f) => f.type === 'welcome'), 'welcome');
    const image = { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: FIX.png } };
    // As FleetModule's child-event subscription calls it.
    (webUiModule as unknown as { handleFleetEvent(name: string, event: unknown): void })
      .handleFleetEvent('kid', { type: 'process:received', processEvent: { type: 'external-message', content: [image] } });
    const frame = await c.until(() => c.frames.find((f) => f.type === 'child-event'), 'the child event');
    expect(frame).toEqual({
      type: 'child-event',
      childName: 'kid',
      event: { type: 'process:received', processEvent: { type: 'external-message', content: [
        { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: `[${FIX.png!.length} base64 characters, not sent in traces]` } },
      ] } },
    });
    c.ws.close();
  });

  test("a trace or a child's event JSON can't carry reaches no client, and the next one does", async () => {
    const c = await connect();
    await c.until(() => c.frames.find((f) => f.type === 'welcome'), 'welcome');
    const cyclic: Record<string, unknown> = { type: 'tool:completed' };
    cyclic.self = cyclic;
    const fleet = webUiModule as unknown as { handleFleetEvent(name: string, event: unknown): void };
    emitTrace!(cyclic);
    fleet.handleFleetEvent('kid', cyclic);
    emitTrace!({ type: 'tool:completed', callId: 'after' });
    fleet.handleFleetEvent('kid', { type: 'tool:completed', callId: 'after' });
    await c.until(() => c.frames.find((f) => f.type === 'child-event'), 'the child event');
    await c.until(() => c.frames.find((f) => f.type === 'trace'), 'the trace');
    const sent = c.frames.filter((f) => f.type === 'trace' || f.type === 'child-event');
    expect(sent.map((f) => [f.type, (f.event as { callId?: string }).callId])).toEqual([
      ['trace', 'after'],
      ['child-event', 'after'],
    ]);
    c.ws.close();
  });

  test("a child's usage reaches clients even when the event that brought it can't be sent", async () => {
    const c = await connect();
    await c.until(() => c.frames.find((f) => f.type === 'welcome'), 'welcome');
    (webUiModule as unknown as { handleFleetEvent(name: string, event: unknown): void })
      .handleFleetEvent('counted', { type: 'usage:updated', totals: { inputTokens: 5, outputTokens: 7 }, n: 10n });
    const usage = await c.until(() => c.frames.find((f) => f.type === 'usage'), 'the usage');
    expect(usage.usage).toMatchObject({ input: 5, output: 7 });
    expect(c.frames.filter((f) => f.type === 'child-event')).toEqual([]);
    c.ws.close();
  });

  test("a usage trace's usage reaches clients even when the trace itself can't be sent", async () => {
    const c = await connect();
    await c.until(() => c.frames.find((f) => f.type === 'welcome'), 'welcome');
    emitTrace!({ type: 'usage:updated', totals: { inputTokens: 11, outputTokens: 13 }, n: 10n });
    await c.until(() => c.frames.find((f) => f.type === 'usage'), 'the usage');
    expect(c.frames.filter((f) => f.type === 'trace')).toEqual([]);
    c.ws.close();
  });

  test("the recipe's own image window reaches both the welcome and the check", async () => {
    agent.strategy = { type: 'autobiographical', maxLiveImages: 3, maxLiveImageBytes: 4_000_000 };
    try {
      const c = await connect();
      const welcome = await c.until(() => c.frames.find((f) => f.type === 'welcome'), 'welcome');
      expect(welcome.userImageLimits).toEqual({
        ...USER_IMAGE_LIMITS, maxCount: 3, maxBase64Chars: 4_000_000, maxTotalBase64Chars: 4_000_000,
      });
      c.ws.close();
      const four = Array.from({ length: 4 }, () => ({ mediaType: 'image/png', data: FIX.png }));
      expect((await send({ content: '', images: four })).error).toBe('message not sent: 4 images attached; a message takes at most 3 here');
      expect((await send({ content: '', images: four.slice(0, 3) })).pushed).toBeDefined();
    } finally {
      delete agent.strategy;
    }
  });

  test("the recipe's byte window holds the check to its base64, one image and the message's total", async () => {
    const one = { mediaType: 'image/png', data: FIX.png! };
    try {
      // One image's base64 exactly: one fits, and two come to more.
      agent.strategy = { type: 'autobiographical', maxLiveImageBytes: FIX.png!.length };
      expect((await send({ content: '', images: [one] })).pushed).toBeDefined();
      const two = await send({ content: '', images: [one, one] });
      expect(two.pushed).toBeUndefined();
      expect(two.error).toStartWith('message not sent: the images come to more than ');
      // A little less than one image: the image alone is over.
      agent.strategy = { type: 'autobiographical', maxLiveImageBytes: FIX.png!.length - 4 };
      const over = await send({ content: '', images: [one] });
      expect(over.pushed).toBeUndefined();
      expect(over.error).toStartWith(`message not sent: the image is ${FIX.png!.length.toLocaleString('en-US')} characters of base64, over the `);
    } finally {
      delete agent.strategy;
    }
  });

  test("a send's corrId goes to the framework with its message", async () => {
    const r = await send({ content: 'hello', corrId: 'c-42' });
    expect(r.pushed!.metadata).toEqual({ corrId: 'c-42' });
    expect((await send({ content: 'hello' })).pushed!.metadata).toEqual({});
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

  test('images alone carry no empty text block, whitespace included', async () => {
    const r = await send({ content: '', images: [{ mediaType: 'image/gif', data: FIX.gif }] });
    expect(r.pushed!.content).toEqual([{ type: 'image', source: { type: 'base64', data: FIX.gif, mediaType: 'image/gif' } }]);
    const spaced = await send({ content: ' \n\t ', images: [{ mediaType: 'image/gif', data: FIX.gif }] });
    expect(spaced.pushed!.content).toEqual([{ type: 'image', source: { type: 'base64', data: FIX.gif, mediaType: 'image/gif' } }]);
  });

  test('more images than the live window keeps are refused with the limit', async () => {
    const seven = Array.from({ length: 7 }, () => ({ mediaType: 'image/png', data: FIX.png }));
    expect((await send({ content: '', images: seven })).error).toBe('message not sent: 7 images attached; a message takes at most 6 here');
    expect((await send({ content: '', images: seven.slice(0, 6) })).pushed).toBeDefined();
  });

  test('a message without images is pushed as before', async () => {
    expect((await send({ content: 'plain' })).pushed!.content).toBe('plain');
    expect((await send({ content: 'plain', images: [] })).pushed!.content).toBe('plain');
  });

  test('an image the model API would refuse is answered with the reason, and nothing is pushed', async () => {
    const before = pushed.length;
    const r = await send({ content: 'big', images: [{ mediaType: 'image/png', data: FIX.png8001x1 }] });
    expect(r.error).toBe('message not sent: the image is 8001×1; the model API takes at most 8000 px on a side. Shrink it to 8000 px or less on its longer side.');
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
    // 15 MB of images: over the 12 MiB total, under the host's 16 MiB frame
    // limit (MAX_WS_FRAME_BYTES, which its server sets).
    const data = atCap();
    const r = await send({ content: '', images: [data, data, data].map((d) => ({ mediaType: 'image/png', data: d })) });
    expect(r.error).toBe('message not sent: the images come to more than 12,582,912 characters of base64, the most one message carries');
  });
});

describe("the host's frame limit, which the composer measures against", () => {
  /** A user message whose frame is exactly `bytes` long, padded with text. */
  const frameOf = (bytes: number) => {
    const base = wsFrameBytes({ type: 'user-message', content: '' });
    return { type: 'user-message' as const, content: 'x'.repeat(bytes - base) };
  };

  test('wsFrameBytes counts the frame as UTF-8, as the socket carries it', () => {
    const msg = { type: 'user-message' as const, content: 'héllo — 日本' };
    expect(wsFrameBytes(msg)).toBe(Buffer.byteLength(JSON.stringify(msg), 'utf8'));
    expect(wsFrameBytes(msg)).toBeGreaterThan(JSON.stringify(msg).length);
    expect(wsFrameBytes(frameOf(1000))).toBe(1000);
  });

  test('frameLimitNote lets a frame at the limit through and says how far over one past it is', () => {
    expect(frameLimitNote(frameOf(MAX_WS_FRAME_BYTES))).toBeNull();
    const over = (bytes: number) => frameLimitNote(frameOf(MAX_WS_FRAME_BYTES + bytes))!.replace(/^not sent: this message is (.+) over the 16 MiB one message can carry; shorten the text$/, '$1');
    expect(over(1)).toBe('1 byte');
    expect(over(1_023)).toBe('1023 bytes');
    expect(over(1_024)).toBe('1.0 KiB');
    expect(over(2_800)).toBe('2.8 KiB');
    // The unit follows the rounded figure: just under a MiB reads 1.0 MiB.
    expect(over(1_048_575)).toBe('1.0 MiB');
    expect(over(1_048_576)).toBe('1.0 MiB');
    expect(over(3 * 1_048_576 + 56)).toBe('3.1 MiB');
    expect(over(MAX_WS_FRAME_BYTES)).toBe('16.0 MiB');
    // Counted as UTF-8: two bytes a character, though the text's length is
    // under the limit.
    const accented = { type: 'user-message' as const, content: 'é'.repeat(MAX_WS_FRAME_BYTES / 2) };
    expect(accented.content.length).toBeLessThan(MAX_WS_FRAME_BYTES);
    expect(frameLimitNote(accented)).toMatch(/^not sent: this message is \d+ bytes over the 16 MiB/);
    // Only a message carrying images is told to remove one; a command or a
    // route carries none.
    const withImage = { ...frameOf(MAX_WS_FRAME_BYTES + 3 * 1024 * 1024), images: [{ mediaType: 'image/png', data: 'AAAA' }] };
    expect(frameLimitNote(withImage)).toMatch(/MiB over the 16 MiB one message can carry; shorten the text or remove an image$/);
    expect(frameLimitNote({ type: 'command', command: '/' + 'x'.repeat(MAX_WS_FRAME_BYTES) })).toMatch(/; shorten the text$/);
  });

  test('a frame at the limit reaches the framework', async () => {
    const r = await send({ content: frameOf(MAX_WS_FRAME_BYTES).content }, 18_000);
    expect(String(r.pushed!.content).length).toBe(frameOf(MAX_WS_FRAME_BYTES).content.length);
  }, 20_000);

  test('a frame one byte over the limit closes the socket, and nothing is pushed', async () => {
    const c = await connect();
    await c.until(() => c.frames.find((f) => f.type === 'welcome'), 'welcome');
    const before = pushed.length;
    const closed = new Promise<number>((resolve) => c.ws.addEventListener('close', (ev) => resolve(ev.code)));
    c.ws.send(JSON.stringify(frameOf(MAX_WS_FRAME_BYTES + 1)));
    // 1006: the socket closed without a close frame, before the module's
    // message handler saw the frame.
    expect(await closed).toBe(1006);
    expect(pushed.length).toBe(before);
    expect(c.frames.some((f) => f.type === 'error')).toBe(false);
  }, 20_000);
});
