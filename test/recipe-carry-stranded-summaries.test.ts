import { describe, expect, test } from 'bun:test';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import { validateRecipe } from '../src/recipe.js';

function recipe(strategy: Record<string, unknown>) {
  return {
    name: 'carry-stranded-test',
    agent: { name: 'Mira', systemPrompt: 'sys', strategy: { type: 'autobiographical', ...strategy } },
  };
}
const configOf = (strategy: object) => (strategy as unknown as { config: Record<string, unknown> }).config;

describe('carryStrandedSummaries', () => {
  test('true survives validation and reaches the Context Manager strategy config', () => {
    const parsed = validateRecipe(recipe({ carryStrandedSummaries: true }));
    expect(parsed.agent.strategy?.carryStrandedSummaries).toBe(true);
    const config = configOf(buildFrameworkStrategy(parsed, 'some-model', 'America/Los_Angeles'));
    expect(config.carryStrandedSummaries).toBe(true);
  });

  test('omitted: absent from the strategy config', () => {
    const config = configOf(buildFrameworkStrategy(validateRecipe(recipe({})), 'some-model', 'America/Los_Angeles'));
    expect('carryStrandedSummaries' in config).toBe(false);
  });

  test('anything but a boolean is refused at load', () => {
    for (const value of ['true', 1, 0, null, [], {}]) {
      expect(() => validateRecipe(recipe({ carryStrandedSummaries: value })))
        .toThrow(/carryStrandedSummaries must be a boolean/);
    }
  });
});
