import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import { emptyExtensionRegistry } from '../src/extensions.js';

const limits = {
  maxLiveImages: 3,
  imageStripDepthTokens: 12000,
  maxLiveImageBytes: 8 * 1024 * 1024,
};

function recipe(strategy: Record<string, unknown> = {}) {
  return validateRecipe({
    name: 'live-image-limits',
    agent: { systemPrompt: 'sys', strategy: { type: 'autobiographical', ...strategy } },
  });
}

function config(strategy: Record<string, unknown> = {}) {
  return (buildFrameworkStrategy(recipe(strategy), 'some-model', 'UTC') as unknown as {
    config: Record<string, unknown>;
  }).config;
}

describe('live-image recipe limits', () => {
  for (const type of ['autobiographical', 'frontdesk']) {
    test(`${type} forwards explicit limits to the constructed strategy`, () => {
      const parsed = recipe({ type, ...limits });
      const built = config({ type, ...limits });
      for (const [key, value] of Object.entries(limits)) {
        expect(parsed.agent.strategy?.[key as keyof typeof limits]).toBe(value);
        expect(built[key]).toBe(value);
      }
    });

    test(`${type} preserves zero to disable each limit`, () => {
      const built = config({
        type, maxLiveImages: 0, imageStripDepthTokens: 0, maxLiveImageBytes: 0,
      });
      for (const key of Object.keys(limits)) expect(built[key]).toBe(0);
    });
  }

  test('custom strategies receive their own image conventions unchanged', () => {
    const custom = {
      type: 'custom-images',
      maxLiveImages: -1,
      imageStripDepthTokens: 'all',
      maxLiveImageBytes: null,
    };
    const parsed = validateRecipe({
      name: 'custom-image-policy',
      agent: { systemPrompt: 'sys', strategy: custom },
      extensions: { images: { kind: 'strategy', path: './images.ts' } },
    });
    const registry = emptyExtensionRegistry();
    const received: Record<string, unknown>[] = [];
    const sentinel = buildFrameworkStrategy(recipe({ type: 'passthrough' }), 'some-model', 'UTC');
    registry.strategies.set('custom-images', ({ config }) => {
      received.push(config);
      return sentinel;
    });
    expect(buildFrameworkStrategy(parsed, 'some-model', 'UTC', registry)).toBe(sentinel);
    expect(received).toEqual([custom]);
  });

  test('passthrough does not impose limits it never consumes', () => {
    expect(() => recipe({
      type: 'passthrough', maxLiveImages: -1, imageStripDepthTokens: 'all', maxLiveImageBytes: null,
    })).not.toThrow();
  });

  test('omitted strategy type validates and forwards autobiographical limits', () => {
    expect(config({ type: undefined, ...limits }).maxLiveImages).toBe(limits.maxLiveImages);
    for (const key of Object.keys(limits)) {
      expect(() => recipe({ type: undefined, [key]: -1 })).toThrow(
        `Recipe agent.strategy.${key} must be a non-negative safe integer.`,
      );
    }
  });

  test('omitted limits stay absent from the recipe and use the library defaults', () => {
    const parsed = recipe();
    const built = config();
    for (const key of Object.keys(limits)) {
      expect(parsed.agent.strategy).not.toHaveProperty(key);
    }
    expect(built.maxLiveImages).toBe(6);
    expect(built.imageStripDepthTokens).toBe(30000);
    // CM applies its 20 MiB byte fallback during rendering, not construction.
    expect(built.maxLiveImageBytes).toBeUndefined();
  });

  for (const key of Object.keys(limits)) {
    test(`${key} accepts non-negative safe integers`, () => {
      for (const value of [0, 1, 23456, Number.MAX_SAFE_INTEGER]) {
        expect(() => recipe({ [key]: value })).not.toThrow();
      }
    });

    test(`${key} rejects malformed limits at recipe load`, () => {
      for (const value of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '6', true, null, {}, []]) {
        expect(() => recipe({ [key]: value })).toThrow(
          `Recipe agent.strategy.${key} must be a non-negative safe integer.`,
        );
      }
    });
  }
});
