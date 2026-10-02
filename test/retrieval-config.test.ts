import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';
import { buildRetrievalModuleConfig } from '../src/retrieval-config.js';
import type { RetrievalModels } from '../src/modules/retrieval-models.js';

const models = {} as RetrievalModels;

function recipe(retrieval: unknown) {
  return {
    name: 'retrieval-config-test',
    agent: { systemPrompt: 'sys' },
    modules: { retrieval },
  };
}

describe('retrieval recipe config', () => {
  test('accepts and maps the local-retrieval settings', () => {
    const parsed = validateRecipe(recipe({ maxInjected: 7, maxCandidates: 24, relevanceThreshold: 0.4 }));

    expect(buildRetrievalModuleConfig(models, parsed.modules!.retrieval!)).toEqual({
      models,
      maxInjectedLessons: 7,
      maxCandidates: 24,
      relevanceThreshold: 0.4,
    });
  });

  test('boolean shorthand leaves every knob at its default', () => {
    expect(validateRecipe(recipe(true)).modules?.retrieval).toBe(true);
    expect(validateRecipe(recipe(false)).modules?.retrieval).toBe(false);
    expect(buildRetrievalModuleConfig(models, true)).toEqual({ models });
  });

  test('rejects the removed LLM-retrieval keys with a migration message', () => {
    for (const key of ['model', 'reasoningEffort', 'reasoningContext']) {
      expect(() => validateRecipe(recipe({ [key]: 'x' }))).toThrow(
        new RegExp(`modules\\.retrieval\\.${key} was removed: retrieval now runs local`),
      );
    }
  });

  test('rejects malformed values', () => {
    expect(() => validateRecipe(recipe(null))).toThrow(/modules\.retrieval must be a boolean or object/);
    expect(() => validateRecipe(recipe([]))).toThrow(/modules\.retrieval must be a boolean or object/);
    expect(() => validateRecipe(recipe({ maxCandidates: 0 }))).toThrow(/maxCandidates must be a positive integer/);
    expect(() => validateRecipe(recipe({ maxInjected: 2.5 }))).toThrow(/maxInjected must be a positive integer/);
    expect(() => validateRecipe(recipe({ relevanceThreshold: 1.5 }))).toThrow(/relevanceThreshold must be a number in \[0, 1\]/);
    expect(() => validateRecipe(recipe({ relevanceThreshold: '0.5' }))).toThrow(/relevanceThreshold/);
  });
});
