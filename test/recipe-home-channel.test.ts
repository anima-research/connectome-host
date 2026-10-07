/**
 * recipe.agent.homeChannel: where heartbeat / no-trigger speech goes. Validated
 * at load time and recognised as a known key (no "keys the host does not read"
 * warning).
 */
import { describe, test, expect } from 'bun:test';
import { validateRecipe, unknownRecipeKeys } from '../src/recipe.js';

function recipeWithHomeChannel(homeChannel?: unknown) {
  return {
    name: 'home-channel-test',
    agent: {
      systemPrompt: 'sys',
      ...(homeChannel !== undefined && { homeChannel }),
    },
  };
}

describe('recipe agent.homeChannel', () => {
  test('accepts a channel id and keeps it', () => {
    const recipe = validateRecipe(recipeWithHomeChannel('discord:123:456'));
    expect(recipe.agent.homeChannel).toBe('discord:123:456');
  });

  test('is optional', () => {
    expect(validateRecipe(recipeWithHomeChannel()).agent.homeChannel).toBeUndefined();
  });

  test('rejects empty and non-string values at load time', () => {
    expect(() => validateRecipe(recipeWithHomeChannel(''))).toThrow(/homeChannel/);
    expect(() => validateRecipe(recipeWithHomeChannel('  '))).toThrow(/homeChannel/);
    expect(() => validateRecipe(recipeWithHomeChannel(42))).toThrow(/homeChannel/);
  });

  test('is a known agent key', () => {
    expect(unknownRecipeKeys(recipeWithHomeChannel('discord:123:456'))).toEqual([]);
  });
});
