import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';

function recipe(strategy: Record<string, unknown>) {
  return {
    name: 'source-only-test',
    agent: { systemPrompt: 'sys', strategy: { type: 'autobiographical', ...strategy } },
  };
}

describe('compressionSourceOnly recipe flag', () => {
  test('preserves the flag through validation', () => {
    expect(validateRecipe(recipe({ compressionSourceOnly: true }))
      .agent.strategy?.compressionSourceOnly).toBe(true);
    expect(validateRecipe(recipe({ compressionSourceOnly: false }))
      .agent.strategy?.compressionSourceOnly).toBe(false);
    // absent stays undefined — every other resident is unaffected
    expect(validateRecipe(recipe({})).agent.strategy?.compressionSourceOnly).toBeUndefined();
  });

  test('rejects a non-boolean value', () => {
    expect(() => validateRecipe(recipe({ compressionSourceOnly: 'yes' })))
      .toThrow(/compressionSourceOnly/);
    expect(() => validateRecipe(recipe({ compressionSourceOnly: 1 })))
      .toThrow(/compressionSourceOnly/);
  });

  test('plumbs through PASSTHROUGH_KEYS into the built strategy config', () => {
    const parsed = validateRecipe(recipe({ compressionSourceOnly: true, summaryParticipant: 'mythos' }));
    const built = buildFrameworkStrategy(parsed, 'claude-fable-5', 'UTC');
    // buildFrameworkStrategy copies PASSTHROUGH_KEYS onto the strategy options;
    // the flag must reach the AutobiographicalStrategy config.
    const cfg = (built as unknown as { config?: Record<string, unknown> }).config
      ?? (built as unknown as Record<string, unknown>);
    expect(cfg.compressionSourceOnly).toBe(true);
  });
});
