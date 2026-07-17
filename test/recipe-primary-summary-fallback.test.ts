import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipe(primarySummaryFallback?: Record<string, unknown>) {
  return {
    name: 'primary-summary-fallback-test',
    agent: {
      systemPrompt: 'sys',
      refusalHandling: primarySummaryFallback
        ? { primarySummaryFallback }
        : undefined,
    },
  };
}

describe('recipe primary summary fallback validation', () => {
  test('preserves valid fallback settings', () => {
    const parsed = validateRecipe(recipe({
      enabled: true,
      maxNewSummaries: 4,
      requestBudgetTokens: 216_000,
    }));
    expect(parsed.agent.refusalHandling?.primarySummaryFallback).toEqual({
      enabled: true,
      maxNewSummaries: 4,
      requestBudgetTokens: 216_000,
    });
  });

  test('rejects malformed fallback settings', () => {
    expect(() => validateRecipe(recipe({ enabled: 'yes' }))).toThrow(/primarySummaryFallback\.enabled/);
    expect(() => validateRecipe(recipe({ maxNewSummaries: -1 }))).toThrow(/maxNewSummaries/);
    expect(() => validateRecipe(recipe({ requestBudgetTokens: 0 }))).toThrow(/requestBudgetTokens/);
  });
});
