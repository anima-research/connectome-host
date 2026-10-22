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
    preserveGapBearingSummaries: false,
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
    // An omitted block is allowed (the host supplies its standard one); a
    // written block must be complete, with no per-field merging.
    const missing = recipe() as ReturnType<typeof recipe>;
    delete (missing.agent.strategy as { kvUnified?: unknown }).kvUnified;
    expect(() => validateRecipe(missing)).not.toThrow();
    for (const bad of [null, 'standard', [], 0]) {
      expect(() => validateRecipe(recipe(bad))).toThrow(/complete object/);
    }
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

  test('requires an explicit preserveGapBearingSummaries boolean', () => {
    const missing = config() as unknown as Record<string, unknown>;
    delete missing.preserveGapBearingSummaries;
    expect(() => validateRecipe(recipe(missing))).toThrow(/preserveGapBearingSummaries.*explicit boolean/);

    for (const value of [null, 0, 1, 'true', 'false', {}, []]) {
      expect(() => validateRecipe(recipe({ ...config(), preserveGapBearingSummaries: value })))
        .toThrow(/preserveGapBearingSummaries.*explicit boolean/);
    }
  });

  test('rejects simultaneous treeification and gap preservation', () => {
    expect(() => validateRecipe(recipe({
      ...config(),
      treeifyNonContiguousSummaries: true,
      preserveGapBearingSummaries: true,
    }))).toThrow(/treeifyNonContiguousSummaries.*preserveGapBearingSummaries.*mutually exclusive/);
  });

  for (const type of ['autobiographical', 'frontdesk']) {
    test(`${type} preserves all valid explicit topology policies`, () => {
      for (const [treeify, preserve] of [[false, false], [true, false], [false, true]]) {
        const kvUnified = {
          ...config(),
          treeifyNonContiguousSummaries: treeify,
          preserveGapBearingSummaries: preserve,
        };
        const raw = recipe(kvUnified);
        raw.agent.strategy.type = type;
        const built = buildFrameworkStrategy(validateRecipe(raw), 'model', 'UTC') as unknown as {
          config: { kvUnified: RecipeKvUnifiedConfig };
        };
        expect(built.config.kvUnified).toEqual(kvUnified);
      }
    });
  }

  test('forwards an optional hysteresisCertificate and rejects a non-boolean one', () => {
    const withCertificate = { ...config(), hysteresisCertificate: true };
    const built = buildFrameworkStrategy(validateRecipe(recipe(withCertificate)), 'model', 'UTC') as unknown as {
      config: { kvUnified: RecipeKvUnifiedConfig };
    };
    expect(built.config.kvUnified).toEqual(withCertificate);

    for (const value of [null, 0, 1, 'true', {}, []]) {
      expect(() => validateRecipe(recipe({ ...config(), hysteresisCertificate: value })))
        .toThrow(/hysteresisCertificate must be a boolean/);
    }
  });

  test('forwards the context-manager 0.17 keys and rejects values it would read as something else (#346)', () => {
    const withKeys = {
      ...config(),
      policy: { ...config().policy, ageBandSteps: 0 },
      engine: 'dag' as const,
      latentDemandMode: 'individual' as const,
    };
    const built = buildFrameworkStrategy(validateRecipe(recipe(withKeys)), 'model', 'UTC') as unknown as {
      config: { kvUnified: RecipeKvUnifiedConfig };
    };
    expect(built.config.kvUnified).toEqual(withKeys);
    for (const steps of [0, 4, 64]) {
      expect(() => validateRecipe(recipe({ ...config(), policy: { ...config().policy, ageBandSteps: steps } }))).not.toThrow();
    }
    for (const engine of ['auto', 'subtree', 'dag']) {
      expect(() => validateRecipe(recipe({ ...config(), engine }))).not.toThrow();
    }
    for (const latentDemandMode of ['individual', 'joint']) {
      expect(() => validateRecipe(recipe({ ...config(), latentDemandMode }))).not.toThrow();
    }

    for (const steps of [-1, 65, 1.5, Number.NaN, '4', null]) {
      expect(() => validateRecipe(recipe({ ...config(), policy: { ...config().policy, ageBandSteps: steps } })))
        .toThrow(/ageBandSteps must be an integer from 0 to 64/);
    }
    for (const engine of ['leaf', 'DAG', 'subtree ', null, 0]) {
      expect(() => validateRecipe(recipe({ ...config(), engine }))).toThrow(/engine must be "auto", "subtree" or "dag"/);
    }
    for (const mode of ['joint ', 'Joint', 'both', null, true]) {
      expect(() => validateRecipe(recipe({ ...config(), latentDemandMode: mode })))
        .toThrow(/latentDemandMode must be "individual" or "joint"/);
    }
  });

  test('rejects a kvUnified object when another solver is selected', () => {
    const raw = recipe() as ReturnType<typeof recipe>;
    raw.agent.strategy.foldingStrategy = 'kv-stable';
    expect(() => validateRecipe(raw)).toThrow(/requires foldingStrategy/);
  });

  test('a kvUnified block with foldingStrategy omitted is in use (kv-unified is the default) unless adaptive resolution is off', () => {
    const raw = recipe() as ReturnType<typeof recipe>;
    delete (raw.agent.strategy as { foldingStrategy?: string }).foldingStrategy;
    expect(() => validateRecipe(raw)).not.toThrow();
    (raw.agent.strategy as Record<string, unknown>).adaptiveResolution = false;
    expect(() => validateRecipe(raw)).toThrow(/requires foldingStrategy/);
  });
});
