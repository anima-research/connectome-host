/**
 * `agent.strategy.mergeHoldSummaryIds` reaches the context manager, and a
 * malformed value fails at load. Before this, the key was dropped by the
 * passthrough allowlist: an operator hold that silently didn't hold.
 */
import { describe, expect, test } from 'bun:test';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import { validateRecipe } from '../src/recipe.js';

function recipe(strategy: Record<string, unknown>) {
  return { name: 'merge-holds-test', agent: { systemPrompt: 'sys', strategy: { type: 'autobiographical', ...strategy } } };
}

describe('mergeHoldSummaryIds recipe setting', () => {
  test('is passed through to the strategy config', () => {
    const parsed = validateRecipe(recipe({ mergeHoldSummaryIds: ['L1-154', 'L1-155'] }));
    const strategy = buildFrameworkStrategy(parsed, 'claude-test', 'UTC');
    const config = (strategy as unknown as { config?: Record<string, unknown> }).config ?? {};
    expect(config.mergeHoldSummaryIds).toEqual(['L1-154', 'L1-155']);
  });

  test('rejects malformed values at load', () => {
    // A padded id comes second in its list, so every entry is checked, not only the first.
    for (const bad of ['L1-154', [''], ['  '], [42], {}, ['L1-154', ' L1-155'], ['L1-154', 'L1-155 ']]) {
      expect(() => validateRecipe(recipe({ mergeHoldSummaryIds: bad }))).toThrow(
        /mergeHoldSummaryIds must be an array of summary ids, each non-empty with no spaces around it/,
      );
    }
  });

  test('an empty list is allowed (no holds)', () => {
    expect(validateRecipe(recipe({ mergeHoldSummaryIds: [] })).agent.strategy?.mergeHoldSummaryIds).toEqual([]);
  });
});
