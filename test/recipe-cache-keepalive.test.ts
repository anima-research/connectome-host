import { describe, test, expect } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipeWith(cacheKeepalive?: unknown, cacheTtl?: unknown) {
  return {
    name: 'keepalive-test',
    agent: {
      systemPrompt: 'sys',
      ...(cacheTtl !== undefined && { cacheTtl }),
      ...(cacheKeepalive !== undefined && { cacheKeepalive }),
    },
  };
}

describe('recipe agent.cacheKeepalive validation', () => {
  test('omitting it is valid, and leaves it unset', () => {
    expect(validateRecipe(recipeWith()).agent.cacheKeepalive).toBeUndefined();
  });

  test('accepts an explicit opt-out', () => {
    const r = validateRecipe(recipeWith({ enabled: false }));
    expect(r.agent.cacheKeepalive?.enabled).toBe(false);
  });

  test('accepts sane tuning', () => {
    const r = validateRecipe(recipeWith({ maxIdleHours: 12, refreshAfterMinutes: 50 }));
    expect(r.agent.cacheKeepalive?.maxIdleHours).toBe(12);
    expect(r.agent.cacheKeepalive?.refreshAfterMinutes).toBe(50);
  });

  test('rejects a refresh interval at or past the 1h TTL (every poke would be a cache WRITE)', () => {
    expect(() => validateRecipe(recipeWith({ refreshAfterMinutes: 60 }, '1h'))).toThrow(/less than the 1h cache TTL/);
    expect(() => validateRecipe(recipeWith({ refreshAfterMinutes: 90 }, '1h'))).toThrow(/less than the 1h cache TTL/);
  });

  test('rejects a refresh interval at or past the 5m TTL', () => {
    expect(() => validateRecipe(recipeWith({ refreshAfterMinutes: 45 }, '5m'))).toThrow(/less than the 5m cache TTL/);
    expect(validateRecipe(recipeWith({ refreshAfterMinutes: 4 }, '5m')).agent.cacheKeepalive?.refreshAfterMinutes).toBe(4);
  });

  test('rejects non-positive and non-numeric values', () => {
    expect(() => validateRecipe(recipeWith({ refreshAfterMinutes: 0 }))).toThrow(/positive number/);
    expect(() => validateRecipe(recipeWith({ refreshAfterMinutes: '45' }))).toThrow(/positive number/);
    expect(() => validateRecipe(recipeWith({ maxIdleHours: -1 }))).toThrow(/positive number/);
    expect(() => validateRecipe(recipeWith({ maxIdleHours: 'lots' }))).toThrow(/positive number/);
  });

  test('rejects a non-object', () => {
    expect(() => validateRecipe(recipeWith('yes'))).toThrow(/must be an object/);
  });
});
