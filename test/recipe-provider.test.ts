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

  test('accepts the mock provider and its settings', () => {
    expect(validateRecipe(recipe({ provider: 'mock' })).agent.provider).toBe('mock');
    expect(validateRecipe(recipe({
      provider: 'mock',
      mock: { echoMode: false, defaultResponse: 'canned' },
    })).agent.mock).toEqual({ echoMode: false, defaultResponse: 'canned' });
  });

  test('rejects malformed mock settings', () => {
    expect(() => validateRecipe(recipe({ mock: 'echo' }))).toThrow(/agent.mock/);
    expect(() => validateRecipe(recipe({ mock: { echoMode: 'yes' } }))).toThrow(/echoMode/);
    expect(() => validateRecipe(recipe({ mock: { defaultResponse: '' } }))).toThrow(/defaultResponse/);
  });

  test('accepts mock timing knobs', () => {
    expect(validateRecipe(recipe({
      provider: 'mock',
      mock: { echoMode: false, defaultResponse: 'x'.repeat(40), completeDelayMs: 10, streamChunkDelayMs: 1000, streamChunkSize: 10 },
    })).agent.mock).toEqual({
      echoMode: false, defaultResponse: 'x'.repeat(40), completeDelayMs: 10, streamChunkDelayMs: 1000, streamChunkSize: 10,
    });
    expect(validateRecipe(recipe({ mock: { streamChunkDelayMs: 0 } })).agent.mock)
      .toEqual({ streamChunkDelayMs: 0 });
  });

  test('rejects malformed mock timing knobs', () => {
    // A string here coerces through arithmetic today and breaks silently
    // the day someone compares it — same class as the cacheTtl validator.
    expect(() => validateRecipe(recipe({ mock: { streamChunkDelayMs: '1000' } }))).toThrow(/streamChunkDelayMs/);
    // JSON can't carry NaN, but JS callers of validateRecipe can.
    expect(() => validateRecipe(recipe({ mock: { completeDelayMs: NaN } }))).toThrow(/completeDelayMs/);
    expect(() => validateRecipe(recipe({ mock: { completeDelayMs: -5 } }))).toThrow(/completeDelayMs/);
    expect(() => validateRecipe(recipe({ mock: { streamChunkDelayMs: Infinity } }))).toThrow(/streamChunkDelayMs/);
    expect(() => validateRecipe(recipe({ mock: { streamChunkSize: 0 } }))).toThrow(/streamChunkSize/);
    expect(() => validateRecipe(recipe({ mock: { streamChunkSize: 2.5 } }))).toThrow(/streamChunkSize/);
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
