import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipe(agent: Record<string, unknown> = {}) {
  return { name: 'provider-test', agent: { systemPrompt: 'sys', ...agent } };
}

describe('recipe provider validation', () => {
  test('preserves Anthropic as the omitted provider and accepts OpenAI providers', () => {
    expect(validateRecipe(recipe()).agent.provider).toBeUndefined();
    expect(validateRecipe(recipe({ provider: 'openai-responses' })).agent.provider)
      .toBe('openai-responses');
    expect(validateRecipe(recipe({ provider: 'openai-codex' })).agent.provider)
      .toBe('openai-codex');
  });

  test('accepts Codex subscription settings', () => {
    expect(validateRecipe(recipe({
      provider: 'openai-codex',
      codex: { fastMode: true },
    })).agent.codex).toEqual({ fastMode: true });
  });

  test('accepts Responses reasoning and compaction settings', () => {
    expect(validateRecipe(recipe({
      provider: 'openai-responses',
      responses: {
        reasoningEffort: 'xhigh',
        reasoningContext: 'all_turns',
        compactThreshold: 100_000,
        serviceTier: 'priority',
      },
    })).agent.responses).toEqual({
      reasoningEffort: 'xhigh',
      reasoningContext: 'all_turns',
      compactThreshold: 100_000,
      serviceTier: 'priority',
    });
  });

  test('rejects unknown providers and malformed Responses settings', () => {
    expect(() => validateRecipe(recipe({ provider: 'openai-chat' }))).toThrow(/agent.provider/);
    expect(() => validateRecipe(recipe({ responses: { reasoningEffort: 'ultra' } }))).toThrow(/reasoningEffort/);
    expect(() => validateRecipe(recipe({ responses: { reasoningContext: 'previous_turn' } }))).toThrow(/reasoningContext/);
    expect(() => validateRecipe(recipe({ responses: { compactThreshold: 0 } }))).toThrow(/compactThreshold/);
    expect(() => validateRecipe(recipe({ responses: { serviceTier: 'fast' } }))).toThrow(/serviceTier/);
    expect(() => validateRecipe(recipe({ codex: { fastMode: 'yes' } }))).toThrow(/fastMode/);
  });
});
