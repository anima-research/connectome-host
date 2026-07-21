import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipe(agent: Record<string, unknown> = {}) {
  return { name: 'provider-test', agent: { systemPrompt: 'sys', ...agent } };
}

describe('recipe provider validation', () => {
  test('preserves Anthropic as the omitted provider and accepts Responses', () => {
    expect(validateRecipe(recipe()).agent.provider).toBeUndefined();
    expect(validateRecipe(recipe({ provider: 'openai-responses' })).agent.provider)
      .toBe('openai-responses');
  });

  test('accepts Responses reasoning and compaction settings', () => {
    expect(validateRecipe(recipe({
      provider: 'openai-responses',
      responses: {
        reasoningEffort: 'xhigh',
        reasoningContext: 'all_turns',
        compactThreshold: 100_000,
      },
    })).agent.responses).toEqual({
      reasoningEffort: 'xhigh',
      reasoningContext: 'all_turns',
      compactThreshold: 100_000,
    });
  });

  test('rejects unknown providers and malformed Responses settings', () => {
    expect(() => validateRecipe(recipe({ provider: 'openai-chat' }))).toThrow(/agent.provider/);
    expect(() => validateRecipe(recipe({ responses: { reasoningEffort: 'ultra' } }))).toThrow(/reasoningEffort/);
    expect(() => validateRecipe(recipe({ responses: { reasoningContext: 'previous_turn' } }))).toThrow(/reasoningContext/);
    expect(() => validateRecipe(recipe({ responses: { compactThreshold: 0 } }))).toThrow(/compactThreshold/);
  });
});
