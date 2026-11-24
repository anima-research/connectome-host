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
      [[], /^Recipe modules\.notices must be true, false or an object, got a list\.$/],
      [null, /^Recipe modules\.notices must be true, false or an object, got null; give it a value, or leave the key out\.$/],
      [{ bogus: 1 }, /modules\.notices has unknown key "bogus"/],
      [{ statusChannels: 'zulip:ops' }, /statusChannels must be a list of non-empty strings, got "zulip:ops"/],
      [{ statusChannels: [''] }, /statusChannels\[0\] must be a non-empty string, got ""/],
      [{ reply: ['zulip:*'] }, /reply must be an object/],
      [{ reply: { on: ['zulip:*'] } }, /reply has unknown key "on"/],
      [{ reply: { in: [1] } }, /reply\.in\[0\] must be a non-empty string, got 1/],
      [{ kinds: ['hard-down'] }, /kinds must be an object/],
      [{ kinds: { 'hard-down': 'loud' } }, /kinds\.hard-down must be "silent", "status" or "reply", got "loud"/],
      [{ quietMs: -1 }, /quietMs must be a non-negative number/],
      [{ renotifyMs: 'soon' }, /renotifyMs must be a non-negative number/],
    ];
    for (const [notices, re] of bad) {
      expect(() => validateRecipe(recipe({ notices }))).toThrow(re);
    }
  });
});
