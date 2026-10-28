import { describe, expect, test } from 'bun:test';
import { defaultTokenEstimator } from '@animalabs/context-manager';
import { buildFrameworkStrategy, standardKvUnifiedConfig, strategyMessageCap } from '../src/framework-strategy.js';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { DEFAULT_RECIPE, validateRecipe } from '../src/recipe.js';

function recipe(agent: Record<string, unknown> = {}) {
  return validateRecipe({
    name: 'framework-strategy-defaults',
    agent: {
      systemPrompt: 'sys',
      ...agent,
    },
  });
}

function configView(strategy: object): Record<string, unknown> {
  return (strategy as { config?: Record<string, unknown> }).config ?? {};
}

describe('standard-recipe memory defaults', () => {
  test('omitted strategy gets kv-unified with the standard block, a 120k tail, same-model compression, and agent-voiced summaries', () => {
    const r = recipe({ name: 'Mira' });
    const strategy = buildFrameworkStrategy(r, 'some-model', 'America/Los_Angeles');
    const config = configView(strategy);
    expect(config.adaptiveResolution).toBe(true);
    expect(config.foldingStrategy).toBe('kv-unified');
    expect(config.kvUnified).toEqual(standardKvUnifiedConfig(r, 'some-model'));
    expect(config.recentWindowTokens).toBe(120_000);
    expect(config.compressionModel).toBe('some-model');
    expect(config.summaryParticipant).toBe('Mira');
  });

  test('the standard block prices the cache as the provider bills it', () => {
    const prices = (agent: Record<string, unknown>, model: string) => {
      const block = standardKvUnifiedConfig(recipe(agent), model);
      return [block.policy.cacheReadPrice, block.policy.cacheWritePrice];
    };
    expect(prices({}, 'claude-opus-4-6')).toEqual([0.1, 2]);
    expect(prices({}, 'claude-opus-5-5')).toEqual([0.05, 2]);
    expect(prices({}, 'claude-fable-5-1')).toEqual([0.025, 2]);
    expect(prices({ cacheTtl: '5m' }, 'claude-opus-4-6')).toEqual([0.1, 1.25]);
    expect(prices({ provider: 'bedrock', cacheTtl: '1h' }, 'global.anthropic.claude-opus-4-6')).toEqual([0.1, 1.25]);
    expect(prices({ provider: 'openai-responses' }, 'gpt-5.6-sol')).toEqual([0.1, 1.25]);
    expect(prices({ provider: 'openai-responses' }, 'gpt-6.1-sol')).toEqual([0.05, 1.25]);
    expect(prices({ provider: 'openai-responses' }, 'gpt-4o')).toEqual([0.5, 1]);
    expect(prices({ provider: 'openai-codex' }, 'gpt-5.6-sol')).toEqual([0.1, 1]);
    expect(prices({ provider: 'openai-codex' }, 'gpt-6.1-sol')).toEqual([0.05, 1]);
    expect(prices({ promptCaching: false }, 'claude-opus-4-6')).toEqual([1, 1]);
    expect(prices({ promptCaching: false, provider: 'openai-codex' }, 'gpt-5.6-sol')).toEqual([1, 1]);
    expect(prices({ provider: 'bedrock' }, 'apac.anthropic.claude-3-5-sonnet-20241022-v2:0')).toEqual([1, 1]);
  });

  test('the standard block is otherwise the production policy', () => {
    const block = standardKvUnifiedConfig(recipe(), 'claude-opus-4-6');
    expect(block).toMatchObject({
      policy: { alpha: 0.7, budgetLowRatio: 0.6, budgetHighRatio: 0.85, cacheScale: 100_000, continuityScale: 100_000 },
      tokenBucketSize: 50_000,
      continuityBucketSize: 50_000,
      fidelityBucketSize: 100_000,
      labelCeiling: 100_000,
      adoptEpsilon: 3_000,
      treeifyNonContiguousSummaries: false,
      preserveGapBearingSummaries: false,
      hysteresisCertificate: true,
    });
  });

  test('explicit kv-unified without a block gets the standard block; a written block passes through whole', () => {
    const r = recipe({ name: 'Mira', strategy: { type: 'autobiographical', foldingStrategy: 'kv-unified' } });
    expect(configView(buildFrameworkStrategy(r, 'claude-opus-5-5', 'UTC')).kvUnified)
      .toEqual(standardKvUnifiedConfig(r, 'claude-opus-5-5'));
    const own = { ...standardKvUnifiedConfig(r, 'claude-opus-5-5'), adoptEpsilon: 1_234 };
    const pinned = recipe({ name: 'Mira', strategy: { type: 'autobiographical', kvUnified: own } });
    const config = configView(buildFrameworkStrategy(pinned, 'claude-opus-5-5', 'UTC'));
    expect(config.foldingStrategy).toBe('kv-unified');
    expect(config.kvUnified).toEqual(own);
  });

  test('a pinned kv-stable resident stays on kv-stable with no kvUnified block', () => {
    const config = configView(buildFrameworkStrategy(
      recipe({ name: 'Mira', strategy: { type: 'autobiographical', foldingStrategy: 'kv-stable' } }),
      'some-model',
      'UTC',
    ));
    expect(config.foldingStrategy).toBe('kv-stable');
    expect(config.kvUnified).toBeUndefined();
  });

  test('the default tail is 40% of the budget; an explicit tail wins', () => {
    const tail = (agent: Record<string, unknown>) =>
      configView(buildFrameworkStrategy(recipe(agent), 'some-model', 'UTC')).recentWindowTokens;
    expect(tail({ contextBudgetTokens: 160_000 })).toBe(64_000);
    expect(tail({ contextBudgetTokens: 600_000 })).toBe(240_000);
    expect(tail({ strategy: { type: 'autobiographical', recentWindowTokens: 30_000 } })).toBe(30_000);
    const haiku = recipe({ maxTokens: 16_000 });
    const budget = buildFrameworkAgentConfig(haiku, 'agent', 'claude-haiku-4-5', buildFrameworkStrategy(haiku, 'claude-haiku-4-5', 'UTC')).contextBudgetTokens as number;
    expect(budget).toBe(200_000 - 32_000 - defaultTokenEstimator('sys'));
    expect(configView(buildFrameworkStrategy(haiku, 'claude-haiku-4-5', 'UTC')).recentWindowTokens).toBe(Math.round(budget * 0.4));
  });

  test('on a model with no window row the budget defaults to 300k; maxStreamTokens follows it only when the budget is defaulted too', () => {
    const agentConfig = (agent: Record<string, unknown>) => {
      const r = recipe(agent);
      return buildFrameworkAgentConfig(r, 'agent', 'some-model', buildFrameworkStrategy(r, 'some-model', 'UTC'));
    };
    expect(agentConfig({})).toMatchObject({ contextBudgetTokens: 300_000, maxStreamTokens: 320_000 });
    expect(agentConfig({ contextBudgetTokens: 195_000 })).toMatchObject({ contextBudgetTokens: 195_000, maxStreamTokens: 150_000 });
    expect(agentConfig({ maxStreamTokens: 90_000 })).toMatchObject({ contextBudgetTokens: 300_000, maxStreamTokens: 90_000 });
  });

  test('frontdesk gets adaptive + kv-unified too (2026-08-03 clerk outage: hierarchical saturates)', () => {
    const strategy = buildFrameworkStrategy(
      recipe({ name: 'Desk', strategy: { type: 'frontdesk' } }),
      'some-model',
      'Europe/Kyiv',
    );
    const config = configView(strategy);
    expect(config.adaptiveResolution).toBe(true);
    expect(config.foldingStrategy).toBe('kv-unified');
  });

  test('frontdesk adaptiveResolution: false is the hierarchical rollback lever', () => {
    const strategy = buildFrameworkStrategy(
      recipe({ name: 'Desk', strategy: { type: 'frontdesk', adaptiveResolution: false } }),
      'some-model',
      'Europe/Kyiv',
    );
    const config = configView(strategy);
    expect(config.adaptiveResolution).toBe(false);
    expect(config.foldingStrategy).toBeUndefined();
  });

  test('compressionSplitFallback / compressionSplitPlaceholder pass through and stay omitted when omitted', () => {
    const on = buildFrameworkStrategy(
      recipe({ name: 'Mira', strategy: { type: 'autobiographical', compressionSplitFallback: true, compressionSplitPlaceholder: true } }),
      'some-model',
      'America/Los_Angeles',
    );
    expect(configView(on).compressionSplitFallback).toBe(true);
    expect(configView(on).compressionSplitPlaceholder).toBe(true);
    const omitted = buildFrameworkStrategy(recipe({ name: 'Mira' }), 'some-model', 'America/Los_Angeles');
    expect(configView(omitted).compressionSplitFallback).toBeUndefined();
    expect(configView(omitted).compressionSplitPlaceholder).toBeUndefined();
    expect(() => recipe({ name: 'Mira', strategy: { type: 'autobiographical', compressionSplitFallback: 'yes' } })).toThrow();
  });

  test('split-stitch cap knobs pass through and are validated as positive integers', () => {
    const on = buildFrameworkStrategy(
      recipe({ name: 'Mira', strategy: { type: 'autobiographical', compressionSplitFallback: true, compressionSplitMaxCallsPerChunk: 12, compressionSplitMaxCallsPer10Min: 30 } }),
      'some-model',
      'America/Los_Angeles',
    );
    expect(configView(on).compressionSplitMaxCallsPerChunk).toBe(12);
    expect(configView(on).compressionSplitMaxCallsPer10Min).toBe(30);
    expect(() => recipe({ name: 'Mira', strategy: { type: 'autobiographical', compressionSplitMaxCallsPerChunk: 0 } })).toThrow();
    expect(() => recipe({ name: 'Mira', strategy: { type: 'autobiographical', compressionSplitMaxCallsPer10Min: 1.5 } })).toThrow();
  });

  test('mergeMaxSourceSpanMessages is passed through exactly and omission stays omitted (princess 2026-09-05: silently dropped, span guard stuck at the CM default)', () => {
    const configured = buildFrameworkStrategy(
      recipe({
        name: 'Mira',
        strategy: { type: 'autobiographical', mergeMaxSourceSpanMessages: 3000, mergeThreshold: 3 },
      }),
      'some-model',
      'America/Los_Angeles',
    );
    expect(configView(configured).mergeMaxSourceSpanMessages).toBe(3000);
    expect(configView(configured).mergeThreshold).toBe(3);
    const omitted = buildFrameworkStrategy(recipe({ name: 'Mira' }), 'some-model', 'America/Los_Angeles');
    expect(configView(omitted).mergeMaxSourceSpanMessages).toBeUndefined();
  });

  test('productionBudgetTokens is passed through exactly and omission stays omitted', () => {
    const configured = buildFrameworkStrategy(
      recipe({
        name: 'Mira',
        strategy: { type: 'autobiographical', productionBudgetTokens: 123_456 },
      }),
      'some-model',
      'America/Los_Angeles',
    );
    expect(configView(configured).productionBudgetTokens).toBe(123_456);

    const omitted = buildFrameworkStrategy(
      recipe({ name: 'Mira', strategy: { type: 'autobiographical' } }),
      'some-model',
      'America/Los_Angeles',
    );
    expect(configView(omitted).productionBudgetTokens).toBeUndefined();
  });

  test('literal thinking-wrapper compression recovery is explicit opt-in and passed through', () => {
    const configured = buildFrameworkStrategy(
      recipe({
        name: 'Mira',
        strategy: { type: 'autobiographical', recoverLiteralThinkingWrappedCompression: true },
      }),
      'claude-3-opus-20240229',
      'America/Los_Angeles',
    );
    expect(configView(configured).recoverLiteralThinkingWrappedCompression).toBe(true);

    const omitted = buildFrameworkStrategy(
      recipe({ name: 'Mira', strategy: { type: 'autobiographical' } }),
      'claude-3-opus-20240229',
      'America/Los_Angeles',
    );
    expect(configView(omitted).recoverLiteralThinkingWrappedCompression).toBeUndefined();

    for (const bad of ['false', 1, 'no', null]) {
      expect(() => recipe({
        name: 'Mira',
        strategy: { type: 'autobiographical', recoverLiteralThinkingWrappedCompression: bad as never },
      })).toThrow('recoverLiteralThinkingWrappedCompression must be a boolean');
    }
  });

  test('explicit recipe values override the defaults', () => {
    const strategy = buildFrameworkStrategy(
      recipe({
        name: 'Mira',
        strategy: {
          type: 'autobiographical',
          foldingStrategy: 'flat-profile',
          compressionModel: 'pinned-model',
          summaryParticipant: 'Someone Else',
        },
      }),
      'some-model',
      'America/Los_Angeles',
    );
    const config = configView(strategy);
    expect(config.foldingStrategy).toBe('flat-profile');
    expect(config.compressionModel).toBe('pinned-model');
    expect(config.summaryParticipant).toBe('Someone Else');
  });

  test('adaptiveResolution opt-out leaves foldingStrategy and kvUnified unset', () => {
    const strategy = buildFrameworkStrategy(
      recipe({ strategy: { type: 'autobiographical', adaptiveResolution: false } }),
      'some-model',
      'America/Los_Angeles',
    );
    const config = configView(strategy);
    expect(config.adaptiveResolution).toBe(false);
    expect(config.foldingStrategy).toBeUndefined();
    expect(config.kvUnified).toBeUndefined();
  });

  test("every recipe that sets no summary label gets the host's, and a recipe's own label is kept", () => {
    const label = "A summary follows, standing in for earlier conversation, tool calls and results included. The exact text it replaces isn't shown.";
    const built = (agent: Record<string, unknown>) =>
      configView(buildFrameworkStrategy(recipe(agent), 'some-model', 'America/Los_Angeles')).summaryContextLabel;
    expect(built({ name: 'Mira' })).toBe(label);
    expect(built({})).toBe(label);
    expect(built({ name: 'Mira', strategy: { type: 'autobiographical', witnessedBeforeSequence: 12 } })).toBe(label);
    expect(built({ name: 'Mira', strategy: { type: 'frontdesk' } })).toBe(label);
    expect(built({ name: 'Mira', strategy: { type: 'autobiographical', adaptiveResolution: false, positionedRecallPairs: false } })).toBe(label);
    expect(built({ name: 'Mira', strategy: { type: 'autobiographical', summaryContextLabel: 'Earlier:' } })).toBe('Earlier:');
  });

  test('without agent.name, summaries are voiced by the name the agent runs under, not the library\'s "Claude"', () => {
    const strategy = buildFrameworkStrategy(recipe(), 'some-model', 'America/Los_Angeles', undefined, 'agent');
    expect(configView(strategy).summaryParticipant).toBe('agent');
    const named = buildFrameworkStrategy(recipe({ name: 'Mira' }), 'some-model', 'America/Los_Angeles', undefined, 'Mira');
    expect(configView(named).summaryParticipant).toBe('Mira');
  });

  test('DEFAULT_RECIPE does not enable the opt-in modules', () => {
    const modules = DEFAULT_RECIPE.modules ?? {};
    expect(modules).not.toHaveProperty('subagents');
    expect(modules).not.toHaveProperty('lessons');
    expect(modules).not.toHaveProperty('retrieval');
  });

  test('DEFAULT_RECIPE: empty system prompt, kv-unified at 300k / 120k tail / 320k stream, 1-hour cache priced at 2x', () => {
    const validated = validateRecipe(structuredClone(DEFAULT_RECIPE));
    expect(validated.agent.systemPrompt).toBe('');
    expect(validated.agent.cacheTtl).toBe('1h');
    const strategy = buildFrameworkStrategy(validated, 'claude-opus-4-6', 'UTC');
    const config = configView(strategy);
    expect(config.adaptiveResolution).toBe(true);
    expect(config.foldingStrategy).toBe('kv-unified');
    expect(config.recentWindowTokens).toBe(120_000);
    expect(config.kvUnified).toMatchObject({ policy: { cacheReadPrice: 0.1, cacheWritePrice: 2 } });
    expect(config.summaryParticipant).toBe('agent');
    expect(buildFrameworkAgentConfig(validated, 'agent', 'claude-opus-4-6', strategy))
      .toMatchObject({ contextBudgetTokens: 300_000, maxStreamTokens: 320_000 });
  });
});

describe('carrierPolicy passthrough', () => {
  test("'live-strip' and 'full' reach the constructed strategy config; omission resolves to the library default", () => {
    for (const value of ['live-strip', 'full'] as const) {
      const strategy = buildFrameworkStrategy(
        recipe({ name: 'Mira', strategy: { type: 'autobiographical', carrierPolicy: value } }),
        'some-model',
        'America/Los_Angeles',
      );
      expect(configView(strategy).carrierPolicy).toBe(value);
    }
    // context-manager's own default carrierPolicy is 'full'.
    const omitted = buildFrameworkStrategy(recipe({ name: 'Mira' }), 'some-model', 'America/Los_Angeles');
    expect(configView(omitted).carrierPolicy).toBe('full');
  });

  test('malformed values fail at recipe load instead of silently meaning full', () => {
    for (const bad of ['live_strp', 'strip', 'FULL', '', 1, true, null, {}] as unknown[]) {
      expect(() => recipe({ name: 'Mira', strategy: { type: 'autobiographical', carrierPolicy: bad } }))
        .toThrow(/carrierPolicy/);
    }
  });
});

describe('the per-message cap retrieval fits under', () => {
  test('is the one the strategy applies, 10,000 unless the recipe sets it, and none for passthrough', () => {
    const autobiographical = recipe();
    expect(strategyMessageCap(autobiographical)).toBe(10_000);
    expect(configView(buildFrameworkStrategy(autobiographical, 'some-model', 'UTC')).maxMessageTokens).toBe(10_000);
    const set = recipe({ strategy: { type: 'frontdesk', maxMessageTokens: 4_000 } });
    expect(strategyMessageCap(set)).toBe(4_000);
    expect(configView(buildFrameworkStrategy(set, 'some-model', 'UTC')).maxMessageTokens).toBe(4_000);
    expect(strategyMessageCap(recipe({ strategy: { type: 'passthrough' } }))).toBeUndefined();
  });

  test('for an extension strategy, is the recipe\'s value it is told, and none when the recipe sets none', () => {
    const extension = (strategy: Record<string, unknown>) => ({ name: 'x', agent: { systemPrompt: 'sys', strategy } }) as never;
    expect(strategyMessageCap(extension({ type: 'my-strategy', maxMessageTokens: 3_000 }))).toBe(3_000);
    expect(strategyMessageCap(extension({ type: 'my-strategy' }))).toBeUndefined();
  });
});

