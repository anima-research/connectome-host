/**
 * Recipe passthrough for the two AF release-train knobs:
 * - `toolResultInlineMaxChars` (top-level; AF #89 durable residence default
 *   for the tool-result inline cap) — the deploy lever for residences
 *   WITHOUT a writable workspace, where the AF 5k default would truncate
 *   instead of spilling;
 * - `agent.physicalWindowTokens` (per-agent; AF #92 provider hard cap) —
 *   enables the mid-turn physical-window projection restart.
 *
 * Both validate at recipe load (recipe-shaped errors, not framework-create
 * or wire errors) and pass through verbatim; omitted keys stay omitted so AF
 * defaults apply unchanged.
 */
import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';

function recipe(agent: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return { name: 'cap-window-test', agent: { systemPrompt: 'sys', ...agent }, ...top };
}

describe('recipe toolResultInlineMaxChars (AF #89)', () => {
  test('accepts a valid cap and preserves it', () => {
    expect(validateRecipe(recipe({}, { toolResultInlineMaxChars: 200_000 })).toolResultInlineMaxChars)
      .toBe(200_000);
  });

  test('omitted stays omitted — AF house default applies', () => {
    expect(validateRecipe(recipe()).toolResultInlineMaxChars).toBeUndefined();
  });

  test('rejects values below the AF minimum at load time', () => {
    expect(() => validateRecipe(recipe({}, { toolResultInlineMaxChars: 500 })))
      .toThrow(/toolResultInlineMaxChars must be a number >= 1000/);
    expect(() => validateRecipe(recipe({}, { toolResultInlineMaxChars: '5000' })))
      .toThrow(/toolResultInlineMaxChars/);
  });
});

describe('recipe agent.physicalWindowTokens (AF #92)', () => {
  test('accepts and passes through to the framework agent config', () => {
    const r = validateRecipe(recipe({ physicalWindowTokens: 200_000 }));
    expect(r.agent.physicalWindowTokens).toBe(200_000);
    const config = buildFrameworkAgentConfig(r, 'agent', 'model', undefined);
    expect(config.physicalWindowTokens).toBe(200_000);
  });

  test('omitted stays ABSENT in the agent config — AF projection stays off', () => {
    const config = buildFrameworkAgentConfig(validateRecipe(recipe()), 'agent', 'model', undefined);
    expect('physicalWindowTokens' in config).toBe(false);
  });

  test('rejects non-positive or non-numeric values at load time', () => {
    expect(() => validateRecipe(recipe({ physicalWindowTokens: 0 })))
      .toThrow(/physicalWindowTokens must be a positive number/);
    expect(() => validateRecipe(recipe({ physicalWindowTokens: '200000' })))
      .toThrow(/physicalWindowTokens/);
  });
});
