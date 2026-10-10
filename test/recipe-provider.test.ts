import { describe, expect, test } from 'bun:test';
import { resolveProvider, validateRecipe } from '../src/recipe.js';

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
    // What the host builds, and what subagent launches state.
    expect(resolveProvider(validateRecipe(recipe()))).toBe('anthropic');
    expect(resolveProvider(validateRecipe(recipe({ provider: 'openai-codex' })))).toBe('openai-codex');
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

  test('accepts the mock timing knobs and a response queue', () => {
    const mock = {
      completeDelayMs: 0,
      streamChunkDelayMs: 250.5,
      streamChunkSize: 1,
      responseQueue: ['first', 'second'],
    };
    expect(validateRecipe(recipe({ provider: 'mock', mock })).agent.mock).toEqual(mock);
  });

  test('rejects malformed mock timing knobs', () => {
    for (const key of ['completeDelayMs', 'streamChunkDelayMs']) {
      // JSON can carry Infinity: 1e999 parses to it.
      for (const bad of [-1, Number.NaN, JSON.parse('1e999'), '100', null]) {
        expect(() => validateRecipe(recipe({ mock: { [key]: bad } })))
          .toThrow(new RegExp(`agent.mock.${key} must be a non-negative finite number`));
      }
    }
    // 0 never advances MockAdapter's chunk loop; a fraction makes uneven or empty chunks.
    for (const bad of [0, -3, 2.5, Number.NaN, '10', null]) {
      expect(() => validateRecipe(recipe({ mock: { streamChunkSize: bad } })))
        .toThrow(/agent.mock.streamChunkSize must be a positive integer/);
    }
  });

  test('rejects a response queue that is not a list of non-empty strings', () => {
    for (const bad of ['first', { 0: 'first' }, [1], ['ok', null], ['ok', ''], ['  '], [{ text: 'x' }]]) {
      expect(() => validateRecipe(recipe({ mock: { responseQueue: bad } })))
        .toThrow(/agent.mock.responseQueue must be an array of non-empty strings/);
    }
    expect(validateRecipe(recipe({ mock: { responseQueue: [] } })).agent.mock).toEqual({ responseQueue: [] });
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
