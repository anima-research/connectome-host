import { describe, expect, it } from 'bun:test';
import { validateRecipe, type Recipe } from '../src/recipe.js';
import { assertProseOutboxSupport } from '../src/prose-outbox-support.js';

const base = (proseOutbox?: unknown) => ({
  name: 'test',
  agent: { systemPrompt: '' },
  ...(proseOutbox === undefined ? {} : { proseOutbox }),
});

describe('proseOutbox recipe', () => {
  it('accepts omission, a bare switch, and every field', () => {
    expect(validateRecipe(base()).proseOutbox).toBeUndefined();
    expect(validateRecipe(base({ enabled: true })).proseOutbox).toEqual({ enabled: true });
    const full = { enabled: true, maxAgeMs: 3_600_000, maxEntriesPerAgent: 10, maxEntries: 40, tools: ['send_message', 'reply_message'] };
    expect(validateRecipe(base(full)).proseOutbox).toEqual(full);
  });

  it('rejects malformed values and unknown fields', () => {
    for (const bad of [
      [], 'on', { enabled: 'yes' }, { enabled: true, maxAgeMs: 0 },
      { enabled: true, maxAgeMs: 8 * 24 * 3_600_000 }, { enabled: true, maxEntries: 1.5 },
      { enabled: true, maxEntriesPerAgent: 0 }, { enabled: true, path: '/tmp/x' },
      { enabled: true, tools: 'send_message' }, { enabled: true, tools: ['mcpl--discord--send_message'] },
      { enabled: true, tools: [''] },
    ]) {
      expect(() => validateRecipe(base(bad))).toThrow(/proseOutbox/);
    }
  });
});

describe('assertProseOutboxSupport (fail closed across a staged release)', () => {
  const recipe = (enabled: boolean) => validateRecipe(base({ enabled })) as Recipe;

  it('throws when enabled and the framework lacks the outbox', () => {
    expect(() => assertProseOutboxSupport(recipe(true), {})).toThrow(/does not support it/);
  });

  it('passes when the framework exports it, and is a no-op when disabled', () => {
    expect(() => assertProseOutboxSupport(recipe(true), { ProseOutbox: class {} })).not.toThrow();
    expect(() => assertProseOutboxSupport(recipe(false), {})).not.toThrow();
    expect(() => assertProseOutboxSupport(validateRecipe(base()) as Recipe, {})).not.toThrow();
  });

  it('against the installed framework: matches whether it exports ProseOutbox', async () => {
    const installed = await import('@animalabs/agent-framework') as Record<string, unknown>;
    const run = () => assertProseOutboxSupport(recipe(true));
    if (typeof installed.ProseOutbox === 'function') expect(run).not.toThrow();
    else expect(run).toThrow(/does not support it/);
  });
});
