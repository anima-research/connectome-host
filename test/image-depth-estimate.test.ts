import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, ContextManager } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/agent-framework';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import { validateRecipe } from '../src/recipe.js';
import { liveImageDepth, sendDepthTokens } from '../src/web/user-images.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/user-images.json', import.meta.url), 'utf-8')) as Record<string, string>;
const image = (): ContentBlock => ({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: FIX.png } } as ContentBlock);
const SENTENCE = 'The quick brown fox jumps over the lazy dog, and then it rests by the river. ';
const LOG_LINE = '{"level":"info","path":"/api/v1/items","status":200,"ms":12}\n';
const repeat = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

/** The host's figure for a send, and the store's own estimate of it once
 *  stored, on a store a provider sample has calibrated to `calibration`. */
async function figures(
  content: ContentBlock[],
  strategyConfig: Record<string, unknown> = { type: 'autobiographical' },
  calibration?: number,
): Promise<{ host: number; store: number; multiplier: number; stored: number }> {
  const root = mkdtempSync(join(tmpdir(), 'image-depth-estimate-'));
  try {
    const recipe = validateRecipe({ name: 'depth', agent: { systemPrompt: 'sys', strategy: strategyConfig } });
    const cm = await ContextManager.open({ path: join(root, 'store'), strategy: buildFrameworkStrategy(recipe, 'claude-sonnet-4-5-20250929', 'UTC')! });
    if (calibration !== undefined) {
      cm.addMessage('user', [{ type: 'text', text: repeat(SENTENCE, 5_000) }]);
      await cm.compile();
      const strategy = cm.getStrategy() as unknown as { reportRealInputTokens(real: number): void; _lastCompileEstimate: number };
      strategy.reportRealInputTokens(Math.round(strategy._lastCompileEstimate * calibration));
      await cm.compile();
    }
    const multiplier = cm.getRenderStats()?.calibration?.multiplier ?? 1;
    const host = sendDepthTokens(content, cm.getStrategy(), multiplier);
    const before = cm.getMessageCount();
    cm.addMessage('user', content as never);
    const store = (cm as unknown as { messageStore: { getAll(): unknown[]; estimateTokens(m: unknown): number } }).messageStore;
    const added = store.getAll().slice(before);
    const total = added.reduce((sum: number, m) => sum + store.estimateTokens(m), 0);
    cm.close();
    return { host, store: total, multiplier, stored: added.length };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the host's estimate of a send's image depth", () => {
  const longProse = (): ContentBlock[] => [image(), { type: 'text', text: repeat(SENTENCE, 80_000) } as ContentBlock];
  const proseThenLog = (): ContentBlock[] => [image(), image(), {
    type: 'text', text: repeat(SENTENCE, 3_000) + repeat(LOG_LINE, 60_000),
  } as ContentBlock];
  const sends: Array<[string, () => ContentBlock[]]> = [
    ['a short message and an image', () => [image(), { type: 'text', text: 'hello' } as ContentBlock]],
    ['long prose and an image', longProse],
    ['prose that goes on as a log, and two images', proseThenLog],
  ];
  for (const [name, content] of sends) {
    test(`is the store's own, for ${name}`, async () => {
      const f = await figures(content());
      expect(f.host).toBe(f.store);
    });
  }

  for (const calibration of [1.2, 0.8]) {
    test(`is the store's own on a store calibrated to ${calibration}`, async () => {
      for (const content of [longProse, proseThenLog]) {
        const f = await figures(content(), { type: 'autobiographical' }, calibration);
        expect(f.multiplier).toBeCloseTo(calibration, 2);
        expect(f.host).toBe(f.store);
      }
    });
  }

  test("is the store's own when the recipe turns adaptive resolution off, and the send is stored whole", async () => {
    const f = await figures(longProse(), { type: 'autobiographical', adaptiveResolution: false });
    expect(f.stored).toBe(1);
    expect(f.host).toBe(f.store);
  });
});

describe("context-manager's own strip, at the measure the host prices", () => {
  const PLACEHOLDER = (AutobiographicalStrategy as unknown as { IMAGE_PLACEHOLDER: string }).IMAGE_PLACEHOLDER;

  async function compiledImages(
    content: ContentBlock[],
  ): Promise<{ host: number; store: number; images: number; placeholders: number }> {
    const root = mkdtempSync(join(tmpdir(), 'image-depth-strip-'));
    try {
      const recipe = validateRecipe({ name: 'depth', agent: { systemPrompt: 'sys', strategy: { type: 'autobiographical', imageStripDepthTokens: 2_000 } } });
      const cm = await ContextManager.open({ path: join(root, 'store'), strategy: buildFrameworkStrategy(recipe, 'claude-sonnet-4-5-20250929', 'UTC')! });
      const host = sendDepthTokens(content, cm.getStrategy(), 1);
      const before = cm.getMessageCount();
      cm.addMessage('user', content as never);
      const messageStore = (cm as unknown as { messageStore: { getAll(): unknown[]; estimateTokens(m: unknown): number } }).messageStore;
      const store = messageStore.getAll().slice(before).reduce((sum: number, m) => sum + messageStore.estimateTokens(m), 0);
      const { messages } = await cm.compile();
      cm.close();
      const blocks = messages.flatMap((m) => m.content as Array<{ type: string; text?: string }>);
      return {
        host,
        store,
        images: blocks.filter((b) => b.type === 'image').length,
        placeholders: blocks.filter((b) => b.type === 'text' && b.text === PLACEHOLDER).length,
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test('keeps the image of a send at the depth, and replaces it one token past', async () => {
    expect(PLACEHOLDER).toEqual(expect.any(String));
    expect(await compiledImages([image(), { type: 'text', text: 'a'.repeat(1_159) } as ContentBlock]))
      .toEqual({ host: 2_000, store: 2_000, images: 1, placeholders: 0 });
    expect(await compiledImages([image(), { type: 'text', text: 'a'.repeat(1_161) } as ContentBlock]))
      .toEqual({ host: 2_001, store: 2_001, images: 0, placeholders: 1 });
  });
});

describe('the depth the host checks a send against', () => {
  test("is the recipe's, or context-manager's default, for the strategies the host builds", () => {
    expect(liveImageDepth(undefined)).toBe(30_000);
    expect(liveImageDepth({ type: 'frontdesk', imageStripDepthTokens: 12_000 } as never)).toBe(12_000);
  });

  test('is none where 0 turns the depth off, under passthrough, or for a strategy the host can\'t know', () => {
    expect(liveImageDepth({ type: 'autobiographical', imageStripDepthTokens: 0 } as never)).toBeUndefined();
    expect(liveImageDepth({ type: 'passthrough' } as never)).toBeUndefined();
    expect(liveImageDepth({ type: 'custom-images', imageStripDepthTokens: 12_000 } as never)).toBeUndefined();
  });
});
