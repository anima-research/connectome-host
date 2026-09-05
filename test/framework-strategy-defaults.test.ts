/**
 * Standard-recipe memory defaults (buildFrameworkStrategy).
 *
 * A recipe that omits strategy tuning must get the fleet-standard shape:
 * autobiographical + adaptiveResolution + kv-stable folding + same-model
 * compression + summaries voiced as the agent itself. Explicit recipe values
 * always win. DEFAULT_RECIPE must not enable the opt-in modules
 * (subagents/lessons/retrieval).
 */
import { describe, expect, test } from 'bun:test';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
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
  test('omitted strategy gets kv-stable folding, same-model compression, and agent-voiced summaries', () => {
    const strategy = buildFrameworkStrategy(
      recipe({ name: 'Mira' }),
      'some-model',
      'America/Los_Angeles',
    );
    const config = configView(strategy);
    expect(config.adaptiveResolution).toBe(true);
    expect(config.foldingStrategy).toBe('kv-stable');
    expect(config.compressionModel).toBe('some-model');
    expect(config.summaryParticipant).toBe('Mira');
  });

  test('frontdesk gets adaptive + kv-stable too (2026-08-03 clerk outage: hierarchical saturates)', () => {
    const strategy = buildFrameworkStrategy(
      recipe({ name: 'Desk', strategy: { type: 'frontdesk' } }),
      'some-model',
      'Europe/Kyiv',
    );
    const config = configView(strategy);
    expect(config.adaptiveResolution).toBe(true);
    expect(config.foldingStrategy).toBe('kv-stable');
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

  test('adaptiveResolution opt-out leaves foldingStrategy unset', () => {
    const strategy = buildFrameworkStrategy(
      recipe({ strategy: { type: 'autobiographical', adaptiveResolution: false } }),
      'some-model',
      'America/Los_Angeles',
    );
    const config = configView(strategy);
    expect(config.adaptiveResolution).toBe(false);
    expect(config.foldingStrategy).toBeUndefined();
  });

  test("without an agent name the summary voice falls back to the library's 'Claude' default", () => {
    const strategy = buildFrameworkStrategy(
      recipe(),
      'some-model',
      'America/Los_Angeles',
    );
    expect(configView(strategy).summaryParticipant).toBe('Claude');
  });

  test('DEFAULT_RECIPE does not enable the opt-in modules', () => {
    const modules = DEFAULT_RECIPE.modules ?? {};
    expect(modules).not.toHaveProperty('subagents');
    expect(modules).not.toHaveProperty('lessons');
    expect(modules).not.toHaveProperty('retrieval');
  });
});
