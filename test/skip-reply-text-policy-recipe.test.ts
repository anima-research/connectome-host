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

  test("loads 'ask' with every provider and formatter, the XML formatter included", () => {
    const providers: Array<Record<string, string>> = [
      {}, { provider: 'anthropic' }, { provider: 'openrouter' }, { provider: 'bedrock' },
      { provider: 'openai-compatible', baseUrl: 'https://llm.example/v1' },
      { provider: 'openai-responses' }, { provider: 'openai-codex' },
    ];
    for (const extra of providers) {
      for (const formatter of [undefined, 'native', 'anthropic-xml']) {
        const agent = { model: 'm-1', sameRoundSkipReplyTextPolicy: 'ask', ...extra, ...(formatter ? { formatter } : {}) };
        expect({ ...extra, formatter, policy: policyOf(agent) }).toEqual({ ...extra, formatter, policy: 'ask' });
      }
    }
  });
});
