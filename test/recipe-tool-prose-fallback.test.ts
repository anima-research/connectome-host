import { describe, expect, test } from 'bun:test';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import { validateRecipe } from '../src/recipe.js';

function recipe(strategy: Record<string, unknown>) {
  return {
    name: 'tool-prose-test',
    agent: { name: 'Sill', systemPrompt: 'sys', strategy: { type: 'autobiographical', ...strategy } },
  };
}
const VALID = { intoTool: 'journal', fromTools: ['skip_reply', 'think'], minChars: 60 };

describe('compressionToolProseFallback', () => {
  test('valid value survives validation and reaches the Context Manager strategy config', () => {
    const parsed = validateRecipe(recipe({ compressionToolProseFallback: VALID }));
    expect(parsed.agent.strategy?.compressionToolProseFallback).toEqual(VALID);
    const strategy = buildFrameworkStrategy(parsed, 'some-model', 'America/Los_Angeles');
    const config = (strategy as unknown as { config: Record<string, unknown> }).config;
    expect(config.compressionToolProseFallback).toEqual(VALID);
  });

  test('omitted → absent from the strategy config (rung off, canonical bytes unchanged)', () => {
    const strategy = buildFrameworkStrategy(validateRecipe(recipe({})), 'some-model', 'America/Los_Angeles');
    const config = (strategy as unknown as { config: Record<string, unknown> }).config;
    expect(config.compressionToolProseFallback).toBeUndefined();
  });

  test('malformed values are rejected, never silently disabled', () => {
    const bad: unknown[] = [
      true, 'journal', [],
      { fromTools: ['skip_reply'] },
      { intoTool: '', fromTools: ['skip_reply'] },
      { intoTool: 'journal' },
      { intoTool: 'journal', fromTools: [] },
      { intoTool: 'journal', fromTools: [42] },
      { intoTool: 'journal', fromTools: ['journal'] },
      { ...VALID, minChars: -1 },
      { ...VALID, minChars: 1.5 },
      { ...VALID, field: '' },
      { ...VALID, tools: ['skip_reply'] },
    ];
    for (const value of bad) {
      expect(() => validateRecipe(recipe({ compressionToolProseFallback: value })))
        .toThrow(/compressionToolProseFallback/);
    }
  });
});
