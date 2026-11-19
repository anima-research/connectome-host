import { describe, expect, test } from 'bun:test';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import { validateRecipe } from '../src/recipe.js';

function recipe(strategy: Record<string, unknown>) {
  return {
    name: 'fallback-model-test',
    agent: { name: 'Mira', systemPrompt: 'sys', strategy: { type: 'autobiographical', ...strategy } },
  };
}
const configOf = (strategy: object) => (strategy as unknown as { config: Record<string, unknown> }).config;

describe('compressionFallbackModel', () => {
  test('a model name survives validation and reaches the Context Manager strategy config', () => {
    const parsed = validateRecipe(recipe({ compressionFallbackModel: 'other-model' }));
    expect(parsed.agent.strategy?.compressionFallbackModel).toBe('other-model');
    const config = configOf(buildFrameworkStrategy(parsed, 'some-model', 'America/Los_Angeles'));
    expect(config.compressionFallbackModel).toBe('other-model');
    expect(config.compressionModel).toBe('some-model');
  });

  test('omitted: absent from the strategy config', () => {
    const config = configOf(buildFrameworkStrategy(validateRecipe(recipe({})), 'some-model', 'America/Los_Angeles'));
    expect('compressionFallbackModel' in config).toBe(false);
  });

  test('anything but a non-empty string is refused at load', () => {
    for (const value of ['', true, 0, 7, null, ['other-model'], { model: 'other-model' }]) {
      expect(() => validateRecipe(recipe({ compressionFallbackModel: value })))
        .toThrow(/compressionFallbackModel must be a non-empty string/);
    }
  });
});
