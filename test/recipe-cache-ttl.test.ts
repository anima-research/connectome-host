/**
 * Tests for recipe.agent.cacheTtl: accepted values pass validation and an
 * invalid TTL fails at recipe-load time (not as a provider 400 at first
 * inference).
 */
import { describe, test, expect } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipeWithCacheTtl(cacheTtl?: unknown) {
  return {
    name: 'ttl-test',
    agent: {
      systemPrompt: 'sys',
      ...(cacheTtl !== undefined && { cacheTtl }),
    },
  };
}

describe('recipe agent.cacheTtl validation', () => {
  test('accepts "5m"', () => {
    expect(validateRecipe(recipeWithCacheTtl('5m')).agent.cacheTtl).toBe('5m');
  });

  test('accepts "1h"', () => {
    expect(validateRecipe(recipeWithCacheTtl('1h')).agent.cacheTtl).toBe('1h');
  });

  test('accepts unset (provider default applies)', () => {
    expect(validateRecipe(recipeWithCacheTtl()).agent.cacheTtl).toBeUndefined();
  });

  test('rejects a typo\'d TTL at load time', () => {
    expect(() => validateRecipe(recipeWithCacheTtl('1hr'))).toThrow(/cacheTtl must be '5m' or '1h'/);
    expect(() => validateRecipe(recipeWithCacheTtl('60m'))).toThrow(/cacheTtl/);
    expect(() => validateRecipe(recipeWithCacheTtl(3600))).toThrow(/cacheTtl/);
  });
});
