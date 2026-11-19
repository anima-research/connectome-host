import { describe, expect, test } from 'bun:test';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { validateRecipe } from '../src/recipe.js';

const base = (value?: unknown) => ({
  name: 'primary-waits-for-auxiliary',
  agent: {
    systemPrompt: 'sys',
    ...(value === undefined ? {} : { primaryWaitsForAuxiliary: value }),
  },
});

describe('primaryWaitsForAuxiliary recipe wiring', () => {
  test('is left out by omission and passes true and false into AgentConfig', () => {
    const absent = validateRecipe(base());
    expect(buildFrameworkAgentConfig(absent, 'a', 'm', { kind: 's' } as never).primaryWaitsForAuxiliary).toBeUndefined();

    const enabled = validateRecipe(base(true));
    expect(buildFrameworkAgentConfig(enabled, 'b', 'm', { kind: 's' } as never).primaryWaitsForAuxiliary).toBe(true);

    const disabled = validateRecipe(base(false));
    expect(buildFrameworkAgentConfig(disabled, 'c', 'm', { kind: 's' } as never).primaryWaitsForAuxiliary).toBe(false);
  });

  test('rejects a value that is not a boolean', () => {
    for (const value of ['true', 1, null, {}]) {
      expect(() => validateRecipe(base(value))).toThrow(/primaryWaitsForAuxiliary/);
    }
  });
});
