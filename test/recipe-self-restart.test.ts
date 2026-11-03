import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipe(modules?: Record<string, unknown>) {
  return { name: 'self-restart-test', agent: { systemPrompt: 'test' }, ...(modules === undefined ? {} : { modules }) };
}

describe('recipe modules.selfRestart validation', () => {
  test('is off when omitted and accepts boolean shorthand', () => {
    expect(validateRecipe(recipe()).modules?.selfRestart).toBeUndefined();
    expect(validateRecipe(recipe({ selfRestart: true })).modules?.selfRestart).toBe(true);
    expect(validateRecipe(recipe({ selfRestart: false })).modules?.selfRestart).toBe(false);
  });

  test('accepts an object with a cooldown, including 0 and an empty object', () => {
    expect(validateRecipe(recipe({ selfRestart: { cooldownMinutes: 30 } })).modules?.selfRestart).toEqual({ cooldownMinutes: 30 });
    expect(validateRecipe(recipe({ selfRestart: { cooldownMinutes: 0 } })).modules?.selfRestart).toEqual({ cooldownMinutes: 0 });
    expect(validateRecipe(recipe({ selfRestart: {} })).modules?.selfRestart).toEqual({});
  });

  test('rejects malformed shapes with a path-naming error', () => {
    const bad: Array<[unknown, RegExp]> = [
      [null, /modules\.selfRestart must be true, false or an object/],
      [[], /modules\.selfRestart must be true, false or an object/],
      ['yes', /modules\.selfRestart must be true, false or an object/],
      [{ cooldown: 5 }, /modules\.selfRestart has unknown field "cooldown"/],
      [{ cooldownMinutes: -1 }, /cooldownMinutes must be a non-negative number/],
      [{ cooldownMinutes: '10' }, /cooldownMinutes must be a non-negative number/],
      [{ cooldownMinutes: Number.POSITIVE_INFINITY }, /cooldownMinutes must be a non-negative number/],
    ];
    for (const [selfRestart, re] of bad) {
      expect(() => validateRecipe(recipe({ selfRestart }))).toThrow(re);
    }
  });
});
