import { describe, expect, test } from 'bun:test';
import { ANTHROPIC_AUXILIARY_MODEL, auxiliaryModel } from '../src/auxiliary-model.js';
import { validateRecipe } from '../src/recipe.js';

const recipe = (agent: Record<string, unknown>, top: Record<string, unknown> = {}) =>
  validateRecipe({ name: 'aux', agent: { systemPrompt: 'sys', ...agent }, ...top });

describe('auxiliaryModel: the host\'s own small calls go to a model the provider serves', () => {
  test('the anthropic route keeps Claude Haiku', () => {
    expect(auxiliaryModel(recipe({ provider: 'anthropic', model: 'claude-opus-5-5' }))).toBe(ANTHROPIC_AUXILIARY_MODEL);
    expect(auxiliaryModel(recipe({ model: 'claude-opus-5-5' }))).toBe(ANTHROPIC_AUXILIARY_MODEL); // provider unset resolves to anthropic
  });

  test('every other provider gets the resident\'s own model', () => {
    const saved = process.env.MODEL;
    delete process.env.MODEL;
    try {
      expect(auxiliaryModel(recipe({ provider: 'openai-codex', model: 'gpt-6.1-sol' }))).toBe('gpt-6.1-sol');
      expect(auxiliaryModel(recipe({ provider: 'openrouter', model: 'openai/gpt-5.6-sol' }))).toBe('openai/gpt-5.6-sol');
      expect(auxiliaryModel(recipe({ provider: 'bedrock', model: 'anthropic.claude-sonnet-4-5' }))).toBe('anthropic.claude-sonnet-4-5');
    } finally {
      if (saved !== undefined) process.env.MODEL = saved;
    }
  });

  test('a recipe\'s sessionNaming.model wins, and is validated', () => {
    const r = recipe({ provider: 'openai-codex', model: 'gpt-6.1-sol' }, { sessionNaming: { model: 'gpt-5.6-sol' } });
    expect(auxiliaryModel(r, r.sessionNaming?.model)).toBe('gpt-5.6-sol');
    expect(() => recipe({}, { sessionNaming: { model: '' } })).toThrow(/sessionNaming\.model must be a non-empty string/);
    expect(() => recipe({}, { sessionNaming: { examples: ['a', 1] } })).toThrow(/sessionNaming\.examples must be an array of strings/);
    expect(() => recipe({}, { sessionNaming: 'x' })).toThrow(/sessionNaming must be an object/);
  });
});
