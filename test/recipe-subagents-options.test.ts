import { describe, test, expect } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipe(subagents: unknown): Record<string, unknown> {
  return { name: 'Test', agent: { name: 'sherlock', systemPrompt: 'test' }, modules: { subagents } };
}

describe('modules.subagents: orientation and lifecycleReach', () => {
  test('each value the module reads is accepted, and so is leaving them out', () => {
    for (const orientation of ['full', 'none', undefined]) {
      for (const lifecycleReach of ['subtree', 'all', undefined]) {
        expect(() => validateRecipe(recipe({ orientation, lifecycleReach }))).not.toThrow();
      }
    }
    expect(() => validateRecipe(recipe(true))).not.toThrow();
  });

  test('a value the module would read as its default is refused, naming the key and the values it takes', () => {
    expect(() => validateRecipe(recipe({ orientation: 'None' })))
      .toThrow('Recipe modules.subagents.orientation is "None"; it must be "full" or "none".');
    expect(() => validateRecipe(recipe({ lifecycleReach: 'every' })))
      .toThrow('Recipe modules.subagents.lifecycleReach is "every"; it must be "subtree" or "all".');
  });
});
