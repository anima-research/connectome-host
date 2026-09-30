/**
 * Recipe surface for focus mode (agent-framework FrameworkConfig.focus):
 * schema validation of the `focus` block, which passes through verbatim.
 */
import { describe, test, expect } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function baseRecipe(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Test',
    agent: { name: 'sherlock', systemPrompt: 'test' },
    ...extra,
  };
}

describe('validateRecipe — focus schema', () => {
  test('absent block is accepted', () => {
    expect(validateRecipe(baseRecipe()).focus).toBeUndefined();
  });

  test('full valid block passes through verbatim', () => {
    const block = {
      enabled: true,
      defaultDurationSeconds: 900,
      maxDurationSeconds: 7200,
      defaultBacklogCap: 10,
      maxBacklogCap: 100,
      autoReply: true,
      autoReplyTemplate: '[auto] {name} is focused until {until}.',
    };
    expect(validateRecipe(baseRecipe({ focus: block })).focus).toEqual(block);
  });

  test('minimal block: enabled only', () => {
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true } }))).not.toThrow();
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: false } }))).not.toThrow();
  });

  test('non-object block is refused', () => {
    expect(() => validateRecipe(baseRecipe({ focus: true }))).toThrow(/focus must be an object/);
    expect(() => validateRecipe(baseRecipe({ focus: [] }))).toThrow(/focus must be an object/);
  });

  test('enabled must be a boolean', () => {
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: 'yes' } }))).toThrow(/focus\.enabled must be a boolean/);
    expect(() => validateRecipe(baseRecipe({ focus: {} }))).toThrow(/focus\.enabled must be a boolean/);
  });

  test('unknown keys are refused by name', () => {
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true, durationSeconds: 5 } })))
      .toThrow(/focus has unknown field "durationSeconds"/);
  });

  test('numeric fields must be non-negative finite numbers', () => {
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true, maxDurationSeconds: -1 } })))
      .toThrow(/focus\.maxDurationSeconds must be a non-negative number/);
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true, defaultBacklogCap: '20' } })))
      .toThrow(/focus\.defaultBacklogCap must be a non-negative number/);
  });

  test('autoReply is a boolean; autoReplyTemplate a non-empty string', () => {
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true, autoReply: 'no' } })))
      .toThrow(/focus\.autoReply must be a boolean/);
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true, autoReplyTemplate: ' ' } })))
      .toThrow(/focus\.autoReplyTemplate must be a non-empty string/);
  });
});
