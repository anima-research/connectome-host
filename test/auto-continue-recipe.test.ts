import { describe, expect, test } from 'bun:test';
import { autoContinueSupportWarning, buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { validateRecipe } from '../src/recipe.js';

const base = (value?: unknown) => ({
  name: 'auto-continue',
  agent: {
    systemPrompt: 'sys',
    ...(value === undefined ? {} : { autoContinue: value }),
  },
});

const built = (value?: unknown) =>
  buildFrameworkAgentConfig(validateRecipe(base(value)), 'a', 'm', { kind: 's' } as never).autoContinue;

describe('autoContinue recipe wiring', () => {
  test('is off by omission and passes true, false and a cap through to AgentConfig', () => {
    expect(built()).toBeUndefined();
    expect(built(true)).toBe(true);
    expect(built(false)).toBe(false);
    expect(built({})).toEqual({});
    expect(built({ maxConsecutive: 5 })).toEqual({ maxConsecutive: 5 });
    // The bounds themselves are accepted.
    expect(built({ maxConsecutive: 1 })).toEqual({ maxConsecutive: 1 });
    expect(built({ maxConsecutive: 20 })).toEqual({ maxConsecutive: 20 });
    const reloaded = validateRecipe(JSON.parse(JSON.stringify(validateRecipe(base({ maxConsecutive: 2 })))));
    expect(buildFrameworkAgentConfig(reloaded, 'b', 'm', { kind: 's' } as never).autoContinue)
      .toEqual({ maxConsecutive: 2 });
  });

  test('refuses anything else at load, rather than at boot or silently', () => {
    for (const value of ['true', 1, null, []]) {
      expect(() => validateRecipe(base(value))).toThrow(/agent\.autoContinue must be true, false, or an object/);
    }
    for (const value of [{ maxConsecutive: 0 }, { maxConsecutive: 21 }, { maxConsecutive: 1.5 }, { maxConsecutive: '3' }]) {
      expect(() => validateRecipe(base(value))).toThrow(/agent\.autoContinue\.maxConsecutive must be a whole number from 1 to 20/);
    }
    expect(() => validateRecipe(base({ maxConsecutve: 3 }))).toThrow(/unknown key "maxConsecutve"; it takes maxConsecutive\./);
    expect(() => validateRecipe(base({ max: 3, cap: 2 }))).toThrow(/unknown keys "max", "cap"; it takes maxConsecutive\./);
  });

  test('warns at startup when the installed framework predates the setting', () => {
    const on = validateRecipe(base({ maxConsecutive: 2 }));
    // A framework without the setting builds an agent with no autoContinue.
    expect(autoContinueSupportWarning(on, {})).toMatch(/^\[agent-settings\] agent\.autoContinue is set, but the installed agent-framework predates it/);
    // One that has it stores it resolved.
    expect(autoContinueSupportWarning(on, { autoContinue: { maxConsecutive: 2 } })).toBeUndefined();
    // Off, or no agent built: nothing to say.
    expect(autoContinueSupportWarning(validateRecipe(base(false)), {})).toBeUndefined();
    expect(autoContinueSupportWarning(validateRecipe(base()), {})).toBeUndefined();
    expect(autoContinueSupportWarning(on, undefined)).toBeUndefined();
  });
});
