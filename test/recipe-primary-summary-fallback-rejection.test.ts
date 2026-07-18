import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipe(refusalHandling?: Record<string, unknown>) {
  return {
    name: 'primary-summary-fallback-rejection-test',
    agent: {
      systemPrompt: 'sys',
      refusalHandling,
    },
  };
}

describe('recipe primarySummaryFallback removal', () => {
  test('rejects the removed primarySummaryFallback setting', () => {
    expect(() => validateRecipe(recipe({
      primarySummaryFallback: {
        enabled: true,
        maxNewSummaries: 4,
        requestBudgetTokens: 216_000,
      },
    }))).toThrow(/primarySummaryFallback was removed and is unsupported/);
  });
});
