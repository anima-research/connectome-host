import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipe(modules?: Record<string, unknown>) {
  return { name: 'notices-test', agent: { systemPrompt: 'test' }, ...(modules === undefined ? {} : { modules }) };
}

describe('recipe modules.notices validation', () => {
  test('allows the field to be omitted and accepts boolean shorthand', () => {
    expect(validateRecipe(recipe()).modules?.notices).toBeUndefined();
    expect(validateRecipe(recipe({ notices: true })).modules?.notices).toBe(true);
    expect(validateRecipe(recipe({ notices: false })).modules?.notices).toBe(false);
  });

  test('accepts a full object config', () => {
    const notices = {
      statusChannels: ['zulip:ops'],
      reply: { in: ['zulip:*'], not: ['zulip:general'] },
      kinds: { 'hard-down': 'reply', 'auth-*': 'reply', refusal: 'silent' },
      quietMs: 0,
      renotifyMs: 600000,
    };
    expect(validateRecipe(recipe({ notices })).modules?.notices).toEqual(notices);
  });

  test('rejects malformed shapes with a path-naming error', () => {
    const bad: Array<[unknown, RegExp]> = [
      [[], /must be a boolean or object/],
      [null, /must be a boolean or object/],
      [{ bogus: 1 }, /unknown field "bogus"/],
      [{ statusChannels: 'zulip:ops' }, /statusChannels must be an array/],
      [{ statusChannels: [''] }, /statusChannels must be an array of non-empty strings/],
      [{ reply: ['zulip:*'] }, /reply must be an object/],
      [{ reply: { on: ['zulip:*'] } }, /reply has unknown field "on"/],
      [{ reply: { in: [1] } }, /reply\.in must be an array/],
      [{ kinds: ['hard-down'] }, /kinds must be an object/],
      [{ kinds: { 'hard-down': 'loud' } }, /kinds\["hard-down"\] must be 'silent', 'status', or 'reply'/],
      [{ quietMs: -1 }, /quietMs must be a non-negative number/],
      [{ renotifyMs: 'soon' }, /renotifyMs must be a non-negative number/],
    ];
    for (const [notices, re] of bad) {
      expect(() => validateRecipe(recipe({ notices }))).toThrow(re);
    }
  });
});
