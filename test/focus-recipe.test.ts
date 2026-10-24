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

  test('numeric fields must be non-negative integers', () => {
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true, maxDurationSeconds: -1 } })))
      .toThrow(/focus\.maxDurationSeconds must be a non-negative integer/);
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true, defaultBacklogCap: '20' } })))
      .toThrow(/focus\.defaultBacklogCap must be a non-negative integer/);
    // slice(-0.5) would deliver the whole backlog.
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true, maxBacklogCap: 0.5 } })))
      .toThrow(/focus\.maxBacklogCap must be a non-negative integer/);
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true, maxDurationSeconds: 1e308 } })))
      .toThrow(/must be a non-negative integer|between 60 and 604800/);
  });

  test('maxima stay inside the framework\'s own range; defaults fit under maxima', () => {
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true, maxDurationSeconds: 10 } })))
      .toThrow(/focus\.maxDurationSeconds must be between 60 and 604800/);
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true, maxDurationSeconds: 604801 } })))
      .toThrow(/between 60 and 604800/);
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true, defaultDurationSeconds: 30 } })))
      .toThrow(/focus\.defaultDurationSeconds must be at least 60/);
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true, defaultDurationSeconds: 7200, maxDurationSeconds: 3600 } })))
      .toThrow(/defaultDurationSeconds must not exceed focus\.maxDurationSeconds/);
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true, defaultBacklogCap: 50, maxBacklogCap: 10 } })))
      .toThrow(/defaultBacklogCap must not exceed focus\.maxBacklogCap/);
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true, defaultDurationSeconds: 3600, maxDurationSeconds: 3600, defaultBacklogCap: 10, maxBacklogCap: 10 } })))
      .not.toThrow();
  });

  test('focus.enabled is refused alongside conversations (the framework refuses every enter under a router)', () => {
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true }, conversations: {} })))
      .toThrow(/focus\.enabled cannot be combined with conversations/);
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: false }, conversations: {} })))
      .not.toThrow();
  });

  test('autoReply is a boolean; autoReplyTemplate a non-empty string', () => {
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true, autoReply: 'no' } })))
      .toThrow(/focus\.autoReply must be a boolean/);
    expect(() => validateRecipe(baseRecipe({ focus: { enabled: true, autoReplyTemplate: ' ' } })))
      .toThrow(/focus\.autoReplyTemplate must be a non-empty string/);
  });
});
