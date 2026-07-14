import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipe(timezone?: unknown) {
  return { name: 'tz', agent: { systemPrompt: 'test', ...(timezone === undefined ? {} : { timezone }) } };
}

describe('recipe agent.timezone validation', () => {
  test('accepts an IANA timezone', () => {
    expect(validateRecipe(recipe('America/Los_Angeles')).agent.timezone).toBe('America/Los_Angeles');
  });

  test('allows the setting to be omitted', () => {
    expect(validateRecipe(recipe()).agent.timezone).toBeUndefined();
  });

  test('rejects invalid timezone names', () => {
    expect(() => validateRecipe(recipe('Pacific/Definitely_Not'))).toThrow(/valid IANA time zone/);
  });
});
