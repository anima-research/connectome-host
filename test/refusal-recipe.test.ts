import { expect, test } from 'bun:test';
import { validateRecipe, unknownRecipeKeys } from '../src/recipe.js';
import { DISCORD_SOURCE, prepareRefusalReactions } from '../src/refusal-reactions.js';

const config = () => ({ ownership: 'whole-framework', servers: [{ serverId: 'discord', kind: 'discord', sourceRevision: DISCORD_SOURCE }] });
const recipe = (mainRefusalReactions: unknown) => ({ name: 'test', agent: { model: 'mock' }, mainRefusalReactions });
for (const value of [null, false, [], 'yes', {}, { ownership: 'whole-framework', servers: null },
  { ...config(), servers: [null] }, { ...config(), servers: ['discord'] },
  { ...config(), servers: [{ ...config().servers[0], serverId: '' }] },
  { ...config(), servers: [{ ...config().servers[0], kind: 'typo' }] },
  { ...config(), servers: [{ ...config().servers[0], sourceRevision: 4 }] },
  { ...config(), servers: [...config().servers, ...config().servers] },
  { ...config(), servers: [{ ...config().servers[0], kind: 'zulip', emojis: null }] },
]) {
  test(`invalid refusal shape fails at recipe load and runtime: ${JSON.stringify(value)}`, () => {
    expect(() => validateRecipe(recipe(value))).toThrow('mainRefusalReactions');
    expect(() => prepareRefusalReactions(value as any, [])).toThrow('mainRefusalReactions');
  });
}
test('omission and well-shaped Discord config load without requiring unreleased AF', () => {
  expect(validateRecipe(recipe(undefined)).mainRefusalReactions).toBeUndefined();
  expect(validateRecipe(recipe(config())).mainRefusalReactions).toEqual(config());
});
test('nested typo hints use the full refusal recipe path', () => {
  const c = { ...config(), ownershp: 'whole-framework', servers: [{ ...config().servers[0], serverID: 'typo' }] };
  expect(unknownRecipeKeys(recipe(c))).toEqual([
    'mainRefusalReactions.ownershp (did you mean mainRefusalReactions.ownership?)',
    'mainRefusalReactions.servers[0].serverID (did you mean mainRefusalReactions.servers[0].serverId?)',
  ]);
});
