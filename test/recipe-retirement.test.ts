import { describe, expect, test } from 'bun:test';
import {
  assertResidentRetirementSupport,
  buildFrameworkAgentConfig,
} from '../src/framework-agent-config.js';
import { validateRecipe } from '../src/recipe.js';

const recipe = (retirement?: unknown) => ({
  name: 'retirement-test',
  agent: {
    systemPrompt: '',
    ...(retirement === undefined ? {} : { retirement }),
  },
});

describe('resident retirement recipe', () => {
  test('is opt-in and passes validated configuration to Agent Framework', () => {
    const absent = validateRecipe(recipe());
    expect(buildFrameworkAgentConfig(absent, 'resident', 'model', undefined).retirement)
      .toBeUndefined();

    const parsed = validateRecipe(recipe({ enabled: true, confirmationTtlMs: 60_000 }));
    expect(buildFrameworkAgentConfig(parsed, 'resident', 'model', undefined).retirement)
      .toEqual({ enabled: true, confirmationTtlMs: 60_000 });
  });

  test('rejects malformed or unsafe confirmation configuration', () => {
    expect(() => validateRecipe(recipe(true))).toThrow(/retirement must be an object/);
    expect(() => validateRecipe(recipe({}))).toThrow(/enabled must be a boolean/);
    expect(() => validateRecipe(recipe({ enabled: true, confirmationTtlMs: 9_999 })))
      .toThrow(/confirmationTtlMs/);
    expect(() => validateRecipe(recipe({ enabled: true, confirmationTtlMs: 3_600_001 })))
      .toThrow(/confirmationTtlMs/);
    expect(() => validateRecipe(recipe({ enabled: true, surprise: true })))
      .toThrow(/unknown field/);
  });

  test('fails closed when the installed framework lacks retirement support', () => {
    const parsed = validateRecipe(recipe({ enabled: true }));
    expect(() => assertResidentRetirementSupport(parsed, {})).toThrow(/does not support/);
    expect(() => assertResidentRetirementSupport(parsed, {
      getResidentLifecycleStatus() {},
    })).not.toThrow();

    const disabled = validateRecipe(recipe({ enabled: false }));
    expect(() => assertResidentRetirementSupport(disabled, {})).not.toThrow();
  });
});
