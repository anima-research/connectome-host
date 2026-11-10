/**
 * `agent.strategy.mergeHoldSummaryIds` reaches the context manager, and a
 * malformed value fails at load. Before this, the key was dropped by the
 * passthrough allowlist: an operator hold that silently didn't hold.
 */
import { describe, expect, test } from 'bun:test';
import { buildConversationsConfig, buildFrameworkStrategy, buildSubconsciousConfig, mergeHoldWarning } from '../src/framework-strategy.js';
import { validateRecipe } from '../src/recipe.js';

function recipe(strategy: Record<string, unknown>, rest: Record<string, unknown> = {}) {
  return { name: 'merge-holds-test', agent: { systemPrompt: 'sys', strategy: { type: 'autobiographical', ...strategy } }, ...rest };
}

const configOf = (strategy: unknown): Record<string, unknown> =>
  (strategy as { config?: Record<string, unknown> }).config ?? {};

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

describe('which strategies a recipe hold reaches', () => {
  const parsed = validateRecipe(recipe(
    { mergeHoldSummaryIds: ['L1-154'] },
    { conversations: {}, subconscious: { enabled: true, reader: 'forks', model: 'claude-test', voice: 'Hold your thoughts.' } },
  ));

  test("the primary's strategy and a subconscious fork's carry the hold, since a fork there inherits the primary's summaries", () => {
    expect(configOf(buildFrameworkStrategy(parsed, 'claude-test', 'UTC')).mergeHoldSummaryIds).toEqual(['L1-154']);
    const sub = buildSubconsciousConfig(parsed, 'claude-test', 'UTC') as { strategyFactory?: () => unknown };
    expect(configOf(sub.strategyFactory!()).mergeHoldSummaryIds).toEqual(['L1-154']);
  });

  test("a conversation fork's strategy carries no hold, since its own summaries' ids name other summaries", () => {
    const conv = buildConversationsConfig(parsed, 'agent', 'claude-test', 'UTC')!;
    const config = configOf(conv.strategyFactory!());
    expect('mergeHoldSummaryIds' in config).toBe(false);
    expect(config.compressionModel).toBe('claude-test');
  });
});

describe('the warning at start for holds that hold nothing', () => {
  const store = new Map<string, { mergedInto?: string }>([['L1-3', {}], ['L1-1', { mergedInto: 'L2-1' }]]);
  const getSummary = (id: string) => store.get(id) ?? null;

  test('names a held id the store has no summary for, and one already merged, saying a hold does not undo a merge', () => {
    const parsed = validateRecipe(recipe({ mergeHoldSummaryIds: ['L1-3', 'L1-99', 'L1-1'] }));
    expect(mergeHoldWarning(parsed, getSummary)).toBe(
      "[merge holds] agent.strategy.mergeHoldSummaryIds: L1-99 names no summary in this agent's store, so it holds nothing; " +
        "L1-1 is already merged into L2-1, and a hold doesn't undo a merge.",
    );
  });

  test('says nothing when every held id names an unmerged summary, or there are no holds', () => {
    expect(mergeHoldWarning(validateRecipe(recipe({ mergeHoldSummaryIds: ['L1-3'] })), getSummary)).toBeNull();
    expect(mergeHoldWarning(validateRecipe(recipe({})), getSummary)).toBeNull();
  });
});
