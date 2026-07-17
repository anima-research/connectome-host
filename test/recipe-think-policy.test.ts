import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';

function recipe(agent: Record<string, unknown> = {}) {
  return { name: 'think-policy-test', agent: { systemPrompt: 'sys', ...agent } };
}

describe('recipe sameRoundThinkTextPolicy', () => {
  test('valid public/private values are preserved and passed through to Agent Framework config', () => {
    const publicRecipe = validateRecipe(recipe({ sameRoundThinkTextPolicy: 'public' }));
    expect(publicRecipe.agent.sameRoundThinkTextPolicy).toBe('public');
    expect(
      buildFrameworkAgentConfig(publicRecipe, 'agent', 'model', undefined).sameRoundThinkTextPolicy,
    ).toBe('public');

    const privateRecipe = validateRecipe(recipe({ sameRoundThinkTextPolicy: 'private' }));
    expect(privateRecipe.agent.sameRoundThinkTextPolicy).toBe('private');
    expect(
      buildFrameworkAgentConfig(privateRecipe, 'agent', 'model', undefined).sameRoundThinkTextPolicy,
    ).toBe('private');
  });

  test('omitted value stays omitted so Agent Framework can report the compatibility source', () => {
    const parsed = validateRecipe(recipe());
    expect(parsed.agent.sameRoundThinkTextPolicy).toBeUndefined();
    const config = buildFrameworkAgentConfig(parsed, 'agent', 'model', undefined);
    expect(Object.prototype.hasOwnProperty.call(config, 'sameRoundThinkTextPolicy')).toBe(false);
  });

  test('invalid strings and types are rejected', () => {
    expect(() => validateRecipe(recipe({ sameRoundThinkTextPolicy: 'secret' })))
      .toThrow(/sameRoundThinkTextPolicy/);
    expect(() => validateRecipe(recipe({ sameRoundThinkTextPolicy: true })))
      .toThrow(/sameRoundThinkTextPolicy/);
    expect(() => validateRecipe(recipe({ sameRoundThinkTextPolicy: { mode: 'public' } })))
      .toThrow(/sameRoundThinkTextPolicy/);
  });
});
