import { describe, expect, test } from 'bun:test';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import { validateRecipe, type RecipeKvUnifiedConfig } from '../src/recipe.js';

function config(): RecipeKvUnifiedConfig {
  return {
    policy: {
      alpha: 0.7,
      budgetLowRatio: 0.7,
      budgetHighRatio: 0.935,
      budgetUnderLambda: 1_000,
      budgetOverLambda: 4_000,
      cacheLambda: 1,
      cacheScale: 100_000,
      cacheReadPrice: 0.1,
      cacheWritePrice: 1.25,
      continuityLambda: 1,
      continuityScale: 100_000,
      continuityRecencyHalfLifeTokens: 100_000,
      continuityRecencyFloor: 0.2,
      continuityStableHalfLife: 16,
      continuityStableFloor: 0.25,
    },
    tokenBucketSize: 10_000,
    continuityBucketSize: 50_000,
    fidelityBucketSize: 100_000,
    labelCeiling: 100_000,
    adoptEpsilon: 2_000,
    treeifyNonContiguousSummaries: false,
  };
}

function recipe(kvUnified: unknown = config()) {
  return {
    name: 'kv-unified-test',
    agent: {
      name: 'fable',
      systemPrompt: 'system',
      strategy: {
        type: 'autobiographical',
        foldingStrategy: 'kv-unified',
        kvUnified,
      },
    },
  };
}

describe('kv-unified recipe plumbing', () => {
  test('forwards the complete fail-closed policy unchanged', () => {
    const validated = validateRecipe(recipe());
    const strategy = buildFrameworkStrategy(validated, 'model', 'UTC') as unknown as {
      config: { foldingStrategy?: string; kvUnified?: RecipeKvUnifiedConfig };
    };
    expect(strategy.config.foldingStrategy).toBe('kv-unified');
    expect(strategy.config.kvUnified).toEqual(config());
  });

  test('rejects selecting kv-unified without a complete policy', () => {
    const missing = recipe() as ReturnType<typeof recipe>;
    delete (missing.agent.strategy as { kvUnified?: unknown }).kvUnified;
    expect(() => validateRecipe(missing)).toThrow(/complete.*kvUnified/i);
    const incomplete = config() as unknown as Record<string, unknown>;
    incomplete.policy = { ...(incomplete.policy as object) };
    delete (incomplete.policy as Record<string, unknown>).cacheLambda;
    expect(() => validateRecipe(recipe(incomplete))).toThrow(/cacheLambda/);
  });

  test('rejects invalid bands, grids, and implicit treeification', () => {
    const badBand = config();
    badBand.policy.budgetLowRatio = 0.95;
    expect(() => validateRecipe(recipe(badBand))).toThrow(/budget ratios/);

    const badGrid = config();
    badGrid.tokenBucketSize = 0;
    expect(() => validateRecipe(recipe(badGrid))).toThrow(/tokenBucketSize/);

    const missingTreeification = config() as unknown as Record<string, unknown>;
    delete missingTreeification.treeifyNonContiguousSummaries;
    expect(() => validateRecipe(recipe(missingTreeification))).toThrow(/explicit boolean/);
  });

  test('rejects a kvUnified object when another solver is selected', () => {
    const raw = recipe() as ReturnType<typeof recipe>;
    raw.agent.strategy.foldingStrategy = 'kv-stable';
    expect(() => validateRecipe(raw)).toThrow(/requires foldingStrategy/);
  });
});
