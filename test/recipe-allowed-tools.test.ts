import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';

function config(value?: unknown) {
  const recipe = validateRecipe({
    name: 'allowed-tools-test',
    agent: { systemPrompt: '', ...(value === undefined ? {} : { allowedTools: value }) },
  });
  return buildFrameworkAgentConfig(recipe, 'agent', 'model', undefined);
}

describe('recipe allowedTools', () => {
  test('omission leaves the framework compatibility default unchanged', () => {
    expect(Object.hasOwn(config(), 'allowedTools')).toBe(false);
  });

  test('passes explicit all, empty and exact lists through JSON recipe loading', () => {
    for (const allowedTools of ['all', [], ['workspace--grep'], ['workspace--grep', 'workspace--write', 'workspace--edit']]) {
      const restored = JSON.parse(JSON.stringify(allowedTools));
      expect(config(restored).allowedTools).toEqual(allowedTools);
    }
  });

  test('preserves framework exact-name semantics without expanding names', () => {
    expect(config(['workspace--grep', 'workspace--grep']).allowedTools)
      .toEqual(['workspace--grep', 'workspace--grep']);
  });

  test('rejects invalid types and non-string or missing array entries', () => {
    for (const value of [null, true, 1, 'workspace--grep', {}, ['workspace--grep', 1], [null], [undefined], Array(1)]) {
      expect(() => config(value)).toThrow(/allowedTools/);
    }
  });
});
