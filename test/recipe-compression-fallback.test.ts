import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipe(strategy: Record<string, unknown>) {
  return {
    name: 'compression-fallback-test',
    agent: { systemPrompt: 'sys', strategy: { type: 'autobiographical', ...strategy } },
  };
}

describe('compression recall-curve recipe settings', () => {
  test('preserves valid fallback count and complete-request budget', () => {
    const parsed = validateRecipe(recipe({
      compressionRefusalCurveFallbacks: 3,
      compressionContextBudgetTokens: 200_000,
    }));
    expect(parsed.agent.strategy?.compressionRefusalCurveFallbacks).toBe(3);
    expect(parsed.agent.strategy?.compressionContextBudgetTokens).toBe(200_000);
  });

  test('accepts zero as an explicit fallback disable', () => {
    expect(validateRecipe(recipe({ compressionRefusalCurveFallbacks: 0 }))
      .agent.strategy?.compressionRefusalCurveFallbacks).toBe(0);
  });

  test('rejects malformed fallback settings', () => {
    expect(() => validateRecipe(recipe({ compressionRefusalCurveFallbacks: -1 })))
      .toThrow(/compressionRefusalCurveFallbacks/);
    expect(() => validateRecipe(recipe({ compressionRefusalCurveFallbacks: 1.5 })))
      .toThrow(/compressionRefusalCurveFallbacks/);
    expect(() => validateRecipe(recipe({ compressionContextBudgetTokens: 0 })))
      .toThrow(/compressionContextBudgetTokens/);
    expect(() => validateRecipe(recipe({ compressionContextBudgetTokens: '200000' })))
      .toThrow(/compressionContextBudgetTokens/);
  });
});
