import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { REASONING_EFFORTS } from '../src/modules/settings-module.js';

function recipe(agent: Record<string, unknown> = {}) {
  return { name: 'think-policy-test', agent: { systemPrompt: 'sys', ...agent } };
}

describe('recipe initial reasoning effort', () => {
  test('accepts supported efforts and keeps host effort out of Framework thinking', () => {
    const thinking = { enabled: true, budgetTokens: 4096, type: 'adaptive', display: 'omitted' };
    for (const effort of REASONING_EFFORTS) {
      const parsed = validateRecipe(recipe({ thinking: { ...thinking, effort } }));
      expect(parsed.agent.thinking).toEqual({ ...thinking, effort });
      expect(buildFrameworkAgentConfig(parsed, 'agent', 'model', undefined).thinking).toEqual(thinking);
      expect(parsed.agent.thinking?.effort).toBe(effort);
    }
  });

  test('omitted effort leaves existing thinking fields unchanged', () => {
    for (const thinking of [{ enabled: false }, { enabled: true, budgetTokens: 2048, type: 'enabled' }]) {
      const parsed = validateRecipe(recipe({ thinking }));
      expect(parsed.agent.thinking?.effort).toBeUndefined();
      expect(buildFrameworkAgentConfig(parsed, 'agent', 'model', undefined).thinking).toEqual(thinking);
    }
    const parsed = validateRecipe(recipe());
    expect(buildFrameworkAgentConfig(parsed, 'agent', 'model', undefined).thinking).toBeUndefined();
  });

  test('rejects invalid effort values and types', () => {
    for (const effort of ['ultra', '', 2, true, null, [], {}]) {
      expect(() => validateRecipe(recipe({ thinking: { enabled: false, effort } })))
        .toThrow(/agent\.thinking\.effort/);
    }
  });
});

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
