import { describe, expect, test } from 'bun:test';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { unknownRecipeKeys, validateRecipe } from '../src/recipe.js';

const recipe = (agent: Record<string, unknown> = {}) => ({
  name: 'skip-reply-text-policy',
  agent: { systemPrompt: 'sys', ...agent },
});
const policyOf = (agent: Record<string, unknown>) =>
  buildFrameworkAgentConfig(validateRecipe(recipe(agent)), 'a', 'm', { kind: 's' } as never).sameRoundSkipReplyTextPolicy;

describe('agent.sameRoundSkipReplyTextPolicy', () => {
  test('is left to the framework when omitted, and reaches it as given', () => {
    const absent = validateRecipe(recipe());
    expect(absent.agent.sameRoundSkipReplyTextPolicy).toBeUndefined();
    expect(buildFrameworkAgentConfig(absent, 'a', 'm', { kind: 's' } as never).sameRoundSkipReplyTextPolicy).toBeUndefined();

    expect(policyOf({ sameRoundSkipReplyTextPolicy: 'private' })).toBe('private');
    expect(policyOf({ sameRoundSkipReplyTextPolicy: 'ask' })).toBe('ask');

    expect(unknownRecipeKeys(recipe({ sameRoundSkipReplyTextPolicy: 'ask' }))).toEqual([]);
  });

  test('refuses any other value, saying which it takes', () => {
    for (const value of ['public', 'Ask', 'on', true, null, {}, 1]) {
      expect(() => validateRecipe(recipe({ sameRoundSkipReplyTextPolicy: value })))
        .toThrow(/agent\.sameRoundSkipReplyTextPolicy must be 'private' or 'ask'/);
    }
  });

  test("refuses 'ask' where the recipe runs the XML formatter, naming the formatter and the provider", () => {
    for (const provider of [undefined, 'anthropic', 'openrouter', 'bedrock']) {
      const agent = { sameRoundSkipReplyTextPolicy: 'ask', formatter: 'anthropic-xml', ...(provider ? { provider } : {}) };
      let message = '';
      try { validateRecipe(recipe(agent)); } catch (err) { message = (err as Error).message; }
      expect(message).toContain('sameRoundSkipReplyTextPolicy');
      expect(message).toContain("formatter 'anthropic-xml'");
      expect(message).toContain(`provider '${provider ?? 'anthropic'}'`);
      expect(message).toContain("thinking");
    }
  });

  test("loads 'ask' where the XML formatter doesn't run, and 'private' where it does", () => {
    expect(policyOf({ sameRoundSkipReplyTextPolicy: 'ask', formatter: 'anthropic-xml', provider: 'openai-responses', model: 'gpt-5.4' })).toBe('ask');
    expect(policyOf({ sameRoundSkipReplyTextPolicy: 'ask', formatter: 'anthropic-xml', provider: 'openai-codex', model: 'gpt-5.4' })).toBe('ask');
    expect(policyOf({ sameRoundSkipReplyTextPolicy: 'ask', formatter: 'native' })).toBe('ask');
    expect(policyOf({ sameRoundSkipReplyTextPolicy: 'private', formatter: 'anthropic-xml' })).toBe('private');
  });
});
