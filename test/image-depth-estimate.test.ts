import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/agent-framework';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import { validateRecipe } from '../src/recipe.js';
import { liveImageDepth, sendDepthTokens } from '../src/web/user-images.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/user-images.json', import.meta.url), 'utf-8')) as Record<string, string>;
const image = (): ContentBlock => ({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: FIX.png } } as ContentBlock);
const SENTENCE = 'The quick brown fox jumps over the lazy dog, and then it rests by the river. ';
const LOG_LINE = '{"level":"info","path":"/api/v1/items","status":200,"ms":12}\n';
const repeat = (unit: string, n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);

/** The store's own estimate of a send once stored: every message it adds. */
async function storedEstimate(content: ContentBlock[]): Promise<number> {
  const root = mkdtempSync(join(tmpdir(), 'image-depth-estimate-'));
  try {
    const recipe = validateRecipe({ name: 'depth', agent: { systemPrompt: 'sys', strategy: { type: 'autobiographical' } } });
    const cm = await ContextManager.open({ path: join(root, 'store'), strategy: buildFrameworkStrategy(recipe, 'claude-sonnet-4-5-20250929', 'UTC')! });
    const before = cm.getMessageCount();
    cm.addMessage('user', content as never);
    const store = (cm as unknown as { messageStore: { getAll(): unknown[]; estimateTokens(m: unknown): number } }).messageStore;
    const total = store.getAll().slice(before).reduce((sum: number, m) => sum + store.estimateTokens(m), 0);
    cm.close();
    return total;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the host's estimate of a send's image depth", () => {
  const strategy = buildFrameworkStrategy(
    validateRecipe({ name: 'depth', agent: { systemPrompt: 'sys', strategy: { type: 'autobiographical' } } }),
    'claude-sonnet-4-5-20250929',
    'UTC',
  )!;

  const sends: Array<[string, ContentBlock[]]> = [
    ['a short message and an image', [image(), { type: 'text', text: 'hello' } as ContentBlock]],
    ['long prose and an image', [image(), { type: 'text', text: repeat(SENTENCE, 80_000) } as ContentBlock]],
    ['prose that goes on as a log, and two images', [image(), image(), {
      type: 'text', text: repeat(SENTENCE, 3_000) + repeat(LOG_LINE, 60_000),
    } as ContentBlock]],
  ];
  for (const [name, content] of sends) {
    test(`is the store's own, for ${name}`, async () => {
      expect(sendDepthTokens(content, strategy, 1)).toBe(await storedEstimate(content));
    });
  }

  test('scales with the calibration multiplier, block by block', () => {
    const content = [image(), { type: 'text', text: repeat(SENTENCE, 80_000) } as ContentBlock];
    expect(sendDepthTokens(content, strategy, 1.2)).toBeGreaterThan(sendDepthTokens(content, strategy, 1) * 1.19);
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
