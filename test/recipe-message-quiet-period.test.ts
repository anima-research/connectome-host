/**
 * `messageQuietPeriod` at the recipe's top level reaches the framework as
 * written (agent-framework#856), and a malformed value fails at load, as
 * `inferenceBounds` does: a key the framework would ignore, or a value its
 * create would refuse, is caught by the recipe instead.
 */
import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

const RECIPE = {
  name: 'Quiet Period Test',
  agent: { name: 'commander', provider: 'anthropic', model: 'claude-sonnet-4-5-20250929', systemPrompt: 'You are a test.' },
  modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
};

describe('messageQuietPeriod at load', () => {
  test('is kept as written', () => {
    expect(validateRecipe({ ...RECIPE, messageQuietPeriod: { quietMs: 1500 } }).messageQuietPeriod).toEqual({ quietMs: 1500 });
    const both = { quietMs: 1500, maxWaitMs: 10_000 };
    expect(validateRecipe({ ...RECIPE, messageQuietPeriod: both }).messageQuietPeriod).toEqual(both);
    expect(validateRecipe({ ...RECIPE, messageQuietPeriod: { quietMs: 0 } }).messageQuietPeriod).toEqual({ quietMs: 0 });
    expect(validateRecipe(RECIPE).messageQuietPeriod).toBeUndefined();
  });

  test('refuses what the framework would refuse or ignore, naming it', () => {
    for (const [value, message] of [
      [1500, 'messageQuietPeriod must be an object'],
      ['1500', 'messageQuietPeriod must be an object'],
      [null, 'messageQuietPeriod must be an object'],
      [[1500], 'messageQuietPeriod must be an object'],
      [{}, 'messageQuietPeriod.quietMs is required'],
      [{ maxWaitMs: 5000 }, 'messageQuietPeriod.quietMs is required'],
      [{ quietMs: -1 }, 'messageQuietPeriod.quietMs must be a finite number of ms, 0 or more, got -1'],
      [{ quietMs: Number.NaN }, 'messageQuietPeriod.quietMs must be a finite number'],
      [{ quietMs: '1500' }, 'messageQuietPeriod.quietMs must be a finite number'],
      [{ quietMs: 1500, maxWaitMs: 'soon' }, 'messageQuietPeriod.maxWaitMs must be a finite number'],
      [{ quietMs: 1500, maxWiatMs: 5000 }, 'maxWiatMs'],
    ] as const) {
      expect(() => validateRecipe({ ...RECIPE, messageQuietPeriod: value })).toThrow(message);
    }
  });

  test("refuses the option with speech.locus 'latest-inbound', as agent-framework's create does", () => {
    expect(() => validateRecipe({ ...RECIPE, messageQuietPeriod: { quietMs: 1500 }, speech: { locus: 'latest-inbound' } }))
      .toThrow("messageQuietPeriod can't be used with speech.locus \"latest-inbound\"");
    expect(validateRecipe({ ...RECIPE, messageQuietPeriod: { quietMs: 1500 }, speech: { locus: 'delivery' } }).messageQuietPeriod).toEqual({ quietMs: 1500 });
  });
});
