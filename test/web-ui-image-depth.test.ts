import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModuleContext } from '@animalabs/agent-framework';
import { ContextManager } from '@animalabs/context-manager';
import { WebUiModule, __getSharedServerPortForTests, stopWebUiServer } from '../src/modules/web-ui-module.js';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import { validateRecipe } from '../src/recipe.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/user-images.json', import.meta.url), 'utf-8')) as Record<string, string>;
const AUTH = `Basic ${Buffer.from('admin:pw').toString('base64')}`;
const IMAGE = { mediaType: 'image/png', data: FIX.png };
const REFUSAL = 'message not sent: with this much text, its images could be dropped before the model sees them. '
  + 'Send the images in a message of their own first, then the text';
const TOGETHER = "these images together come within 10% of this host's image depth, the recipe's imageStripDepthTokens, "
  + 'or past it';
const IMAGES_REFUSAL = (fit: string) => `message not sent: ${TOGETHER}, where they could reach the model only as `
  + `placeholders. Send at most ${fit}; attach the rest again after it, in a message of their own`;
const BOTH_REFUSAL = (fit: string) => `message not sent: ${TOGETHER}, and so does the text with any one of them. `
  + `Send at most ${fit} at once first, then the text in a message of its own, then attach the rest again`;
const DEPTH_REFUSAL = "message not sent: this host's image depth, the recipe's imageStripDepthTokens, leaves too little room "
  + 'for an image: the host keeps images 10% clear of it, since past it they reach the model only as placeholders. '
  + 'Whoever runs this host can raise it';

// context-manager 0.24.0 estimates prose at 2.9 characters a token and an
// image at 1,600, and the default depth is 30,000, so a send's line is 90% of
// it, 27,000: 72,000 characters and an image come to about 26,400, and 76,000
// and an image to about 27,800.
const UNDER = 72_000;
const OVER = 76_000;
const SENTENCE = 'The quick brown fox jumps over the lazy dog, and then it rests by the river. ';
const prose = (n: number) => SENTENCE.repeat(Math.ceil(n / SENTENCE.length)).slice(0, n);

let webUiModule: WebUiModule;
let port: number;
const pushed: Array<Record<string, unknown>> = [];
const agents: Array<{ name: string; getContextManager: () => ContextManager }> = [];
const roots: string[] = [];
const AUTOBIOGRAPHICAL = { type: 'autobiographical' };
const recipeAgent: { strategy: Record<string, unknown> } = { strategy: AUTOBIOGRAPHICAL };

async function openAgent(
  strategyConfig: Record<string, unknown> = AUTOBIOGRAPHICAL,
  hostStrategy: Record<string, unknown> = strategyConfig,
): Promise<ContextManager> {
  const root = mkdtempSync(join(tmpdir(), 'webui-image-depth-'));
  roots.push(root);
  recipeAgent.strategy = hostStrategy;
  const recipe = validateRecipe({ name: 'depth', agent: { systemPrompt: 'sys', strategy: strategyConfig } });
  const strategy = buildFrameworkStrategy(recipe, 'claude-sonnet-4-5-20250929', 'UTC')!;
  const cm = await ContextManager.open({ path: join(root, 'store'), strategy });
  agents.splice(0, agents.length, { name: 'agent', getContextManager: () => cm });
  return cm;
}

beforeAll(async () => {
  webUiModule = new WebUiModule({ port: 0, host: '127.0.0.1', basicAuth: { username: 'admin', password: 'pw' } });
  await webUiModule.start({} as ModuleContext);
  port = __getSharedServerPortForTests()!;
  webUiModule.setApp({
    framework: {
      getAllAgents: () => agents,
      getAllModules: () => [],
      onTrace: () => {},
      pushEvent: (e: Record<string, unknown>) => { pushed.push(e); },
    },
    frameworkSessionId: 's',
    sessionManager: { findSession: () => null },
    recipe: { name: 'recipe', agent: recipeAgent },
  } as never);
});

afterEach(() => {
  for (const { getContextManager } of agents.splice(0)) {
    try { getContextManager().close(); } catch { /* closed by its test */ }
  }
  recipeAgent.strategy = AUTOBIOGRAPHICAL;
});

afterAll(async () => {
  await webUiModule.stop();
  await stopWebUiServer();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function calibrate(cm: ContextManager, multiplier: number): Promise<void> {
  cm.addMessage('user', [{ type: 'text', text: prose(5_000) }]);
  await cm.compile();
  const strategy = cm.getStrategy() as unknown as {
    reportRealInputTokens(real: number): void;
    _lastCompileEstimate: number;
  };
  strategy.reportRealInputTokens(Math.round(strategy._lastCompileEstimate * multiplier));
  await cm.compile();
  expect(cm.getRenderStats()?.calibration?.multiplier).toBeCloseTo(multiplier, 2);
}

async function send(msg: Record<string, unknown>, afterWelcome?: () => void) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { origin: `http://127.0.0.1:${port}`, authorization: AUTH },
  } as unknown as undefined);
  const frames: Array<Record<string, unknown>> = [];
  ws.addEventListener('message', (ev) => frames.push(JSON.parse(String(ev.data))));
  const until = async <T>(pick: () => T | undefined, what: string): Promise<T> => {
    const deadline = performance.now() + 5000;
    for (;;) {
      const v = pick();
      if (v !== undefined) return v;
      if (performance.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  await until(() => frames.find((f) => f.type === 'welcome'), 'welcome');
  afterWelcome?.();
  const before = pushed.length;
  ws.send(JSON.stringify({ type: 'user-message', ...msg }));
  const result = await until(
    () => pushed.length > before ? { pushed: pushed[before]! }
      : frames.find((f) => f.type === 'error') ? { error: frames.find((f) => f.type === 'error')! }
      : undefined,
    'the message to be pushed or refused',
  );
  ws.close();
  return result;
}

describe("a send whose images the strategy would strip at once", () => {
  test('is refused past the line, naming what to do, with its corrId', async () => {
    await openAgent();
    const result = await send({ content: prose(OVER), images: [IMAGE], corrId: 'c-over' });
    expect(result.error).toEqual({ type: 'error', corrId: 'c-over', message: REFUSAL });
  });

  test('goes through under the line', async () => {
    await openAgent();
    const result = await send({ content: prose(UNDER), images: [IMAGE], corrId: 'c-under' });
    expect(result.pushed?.type).toBe('external-message');
  });

  test('goes through past the line without images', async () => {
    await openAgent();
    const result = await send({ content: prose(OVER) });
    expect(result.pushed?.type).toBe('external-message');
  });

  test('is refused one token past the line, and taken at it', async () => {
    await openAgent({ type: 'autobiographical', imageStripDepthTokens: 2_000 });
    expect((await send({ content: 'a'.repeat(579), images: [IMAGE], corrId: 'c-at' })).pushed?.type).toBe('external-message');
    expect((await send({ content: 'a'.repeat(582), images: [IMAGE], corrId: 'c-past' })).error)
      .toEqual({ type: 'error', corrId: 'c-past', message: REFUSAL });
  });

  test('says the depth leaves too little room for an image when one image alone passes the line', async () => {
    await openAgent({ type: 'autobiographical', imageStripDepthTokens: 1_700 });
    expect((await send({ content: '', images: [IMAGE], corrId: 'c-one' })).error)
      .toEqual({ type: 'error', corrId: 'c-one', message: DEPTH_REFUSAL });
    expect((await send({ content: 'hello', images: [IMAGE, IMAGE], corrId: 'c-one-text' })).error)
      .toEqual({ type: 'error', corrId: 'c-one-text', message: DEPTH_REFUSAL });
  });

  test('says how many images fit when it is their number that passes the line', async () => {
    await openAgent({ type: 'autobiographical', imageStripDepthTokens: 4_000 });
    expect((await send({ content: '', images: [IMAGE, IMAGE, IMAGE], corrId: 'c-together' })).error)
      .toEqual({ type: 'error', corrId: 'c-together', message: IMAGES_REFUSAL('2 images at once') });
    expect((await send({ content: 'a'.repeat(1_000), images: [IMAGE, IMAGE, IMAGE], corrId: 'c-together-short' })).error)
      .toEqual({ type: 'error', corrId: 'c-together-short', message: IMAGES_REFUSAL('2 images with this text') });
    expect((await send({ content: 'a'.repeat(5_500), images: [IMAGE, IMAGE, IMAGE], corrId: 'c-together-text' })).error)
      .toEqual({ type: 'error', corrId: 'c-together-text', message: IMAGES_REFUSAL('1 image with this text') });
  });

  test('asks about the text alone when the images together are under the line, even if the text leaves no room for one', async () => {
    await openAgent({ type: 'autobiographical', imageStripDepthTokens: 4_000 });
    expect((await send({ content: 'a'.repeat(5_900), images: [IMAGE, IMAGE], corrId: 'c-no-room' })).error)
      .toEqual({ type: 'error', corrId: 'c-no-room', message: REFUSAL });
  });

  test('asks for both when the images together pass the line and the text leaves no room for even one', async () => {
    await openAgent({ type: 'autobiographical', imageStripDepthTokens: 4_000 });
    expect((await send({ content: 'a'.repeat(5_900), images: [IMAGE, IMAGE, IMAGE], corrId: 'c-both' })).error)
      .toEqual({ type: 'error', corrId: 'c-both', message: BOTH_REFUSAL('2 images') });
  });

  test('is refused for its text when the images alone are under the line', async () => {
    await openAgent({ type: 'autobiographical', imageStripDepthTokens: 4_000 });
    expect((await send({ content: 'a'.repeat(1_300), images: [IMAGE, IMAGE], corrId: 'c-text' })).error)
      .toEqual({ type: 'error', corrId: 'c-text', message: REFUSAL });
  });

  test("goes through where the host knows no depth: a depth of 0, or a strategy an extension registers", async () => {
    await openAgent({ type: 'autobiographical', imageStripDepthTokens: 0 });
    expect((await send({ content: prose(OVER), images: [IMAGE], corrId: 'c-zero' })).pushed?.type).toBe('external-message');
    await openAgent(AUTOBIOGRAPHICAL, { type: 'custom-images' });
    expect((await send({ content: prose(OVER), images: [IMAGE], corrId: 'c-custom' })).pushed?.type).toBe('external-message');
  });

  test('is judged at a multiplier of 1 by a manager closed after the welcome, whatever its calibration was', async () => {
    await calibrate(await openAgent(), 1.2);
    expect((await send(
      { content: prose(UNDER), images: [IMAGE], corrId: 'c-closed-under' },
      () => agents[0]!.getContextManager().close(),
    )).pushed?.type).toBe('external-message');
    await calibrate(await openAgent(), 0.8);
    expect((await send(
      { content: prose(OVER), images: [IMAGE], corrId: 'c-closed-over' },
      () => agents[0]!.getContextManager().close(),
    )).error).toEqual({ type: 'error', corrId: 'c-closed-over', message: REFUSAL });
  });

  test("is priced at a multiplier of 1 by a manager that won't answer for its calibration", async () => {
    const cm = await openAgent();
    const refusing = new Proxy(cm, {
      get(target, key, receiver) {
        if (key === 'getRenderStats') return () => { throw new Error('ContextManager: not initialized'); };
        const v = Reflect.get(target, key, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    agents.splice(0, agents.length, { name: 'agent', getContextManager: () => refusing });
    expect((await send({ content: prose(UNDER), images: [IMAGE], corrId: 'c-unready-under' })).pushed?.type).toBe('external-message');
    expect((await send({ content: prose(OVER), images: [IMAGE], corrId: 'c-unready-over' })).error)
      .toEqual({ type: 'error', corrId: 'c-unready-over', message: REFUSAL });
  });

  test("is judged at the store's calibration: a sample at 1.2 puts the send under the line past it", async () => {
    await calibrate(await openAgent(), 1.2);
    const result = await send({ content: prose(UNDER), images: [IMAGE], corrId: 'c-moved' });
    expect(result.error).toEqual({ type: 'error', corrId: 'c-moved', message: REFUSAL });
  });
});
