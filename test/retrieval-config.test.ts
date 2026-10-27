import { describe, expect, test } from 'bun:test';
import type { Membrane } from '@animalabs/membrane';
import { validateRecipe } from '../src/recipe.js';
import { buildRetrievalModuleConfig, retrievalMessageCap, retrievalModuleConfig } from '../src/retrieval-config.js';
import { SUBAGENT_MESSAGE_CAP } from '../src/modules/subagent-module.js';

const membrane = {} as Membrane;

function recipe(retrieval: unknown, provider: string = 'openai-codex') {
  return {
    name: 'retrieval-config-test',
    agent: { systemPrompt: 'sys', provider },
    modules: { retrieval },
  };
}

describe('retrieval recipe config', () => {
  test('accepts and maps provider reasoning settings', () => {
    const parsed = validateRecipe(recipe({
      model: 'test-model',
      maxInjected: 7,
      reasoningEffort: 'minimal',
    }));

    expect(parsed.modules?.retrieval).toEqual({
      model: 'test-model',
      maxInjected: 7,
      reasoningEffort: 'minimal',
    });
    expect(buildRetrievalModuleConfig(membrane, parsed.modules!.retrieval!, 'openai-codex')).toEqual({
      membrane,
      retrievalModel: 'test-model',
      maxInjectedLessons: 7,
      retrievalReasoning: { effort: 'minimal' },
    });
  });

  test('preserves boolean shorthand and omits unconfigured reasoning', () => {
    expect(validateRecipe(recipe(true)).modules?.retrieval).toBe(true);
    expect(validateRecipe(recipe(false)).modules?.retrieval).toBe(false);
    expect(buildRetrievalModuleConfig(membrane, { model: 'test-model' }, 'anthropic')).toEqual({
      membrane,
      retrievalModel: 'test-model',
    });
  });

  test('rejects malformed retrieval reasoning settings', () => {
    expect(() => validateRecipe(recipe(null))).toThrow(/modules\.retrieval must be a boolean or object/);
    expect(() => validateRecipe(recipe([]))).toThrow(/modules\.retrieval must be a boolean or object/);
    expect(() => validateRecipe(recipe({ reasoningEffort: 'ultra' }))).toThrow(/reasoningEffort/);
    expect(() => validateRecipe(recipe({ reasoningEffort: ['high'] }))).toThrow(/reasoningEffort/);
    expect(() => validateRecipe(recipe({ reasoningContext: 'current_turn' }))).toThrow(
      /independent one-shot requests/,
    );
    expect(() => validateRecipe(recipe({ reasoningEffort: 'high' }, 'anthropic'))).toThrow(
      /requires agent\.provider/,
    );
    expect(() => buildRetrievalModuleConfig(
      membrane,
      { reasoningEffort: 'high' },
      'anthropic',
    )).toThrow(/requires agent\.provider/);
    expect(() => validateRecipe(recipe({ reasoningEffort: 'high' }))).toThrow(
      /model must be a non-empty string/,
    );
    expect(() => validateRecipe(recipe({ model: '  ', reasoningEffort: 'high' }))).toThrow(
      /model must be a non-empty string/,
    );
    expect(() => buildRetrievalModuleConfig(
      membrane,
      { reasoningEffort: 'high' },
      'openai-codex',
    )).toThrow(/model must be a non-empty string/);
  });
});

describe('the cap retrieval fits its block under', () => {
  const capOf = (agent: Record<string, unknown>, modules: Record<string, unknown> = {}) =>
    retrievalMessageCap({ name: 'x', agent: { systemPrompt: 'sys', ...agent }, modules } as never);

  test('is the strategy\'s cap, with no subagents', () => {
    expect(capOf({})).toBe(10_000);
    expect(capOf({ strategy: { type: 'autobiographical', maxMessageTokens: 20_000 } })).toBe(20_000);
    expect(capOf({ strategy: { type: 'passthrough' } })).toBeUndefined();
  });

  test('is the smaller of it and a subagent\'s window\'s, with the subagent module on', () => {
    expect(SUBAGENT_MESSAGE_CAP).toBe(10_000);
    expect(capOf({ strategy: { type: 'autobiographical', maxMessageTokens: 20_000 } }, { subagents: true })).toBe(10_000);
    expect(capOf({ strategy: { type: 'frontdesk', maxMessageTokens: 4_000 } }, { subagents: {} })).toBe(4_000);
    expect(capOf({ strategy: { type: 'passthrough' } }, { subagents: true })).toBe(10_000);
  });

  test('takes a cap that isn\'t a positive number as none, as the strategy does', () => {
    expect(capOf({ strategy: { type: 'autobiographical', maxMessageTokens: 0 } })).toBeUndefined();
    expect(capOf({ strategy: { type: 'autobiographical', maxMessageTokens: 0 } }, { subagents: true })).toBe(10_000);
    expect(capOf({ strategy: { type: 'autobiographical', maxMessageTokens: -5 } })).toBeUndefined();
    expect(capOf({ strategy: { type: 'my-strategy', maxMessageTokens: 3_000 } }, { subagents: true })).toBe(3_000);
    expect(capOf({ strategy: { type: 'my-strategy' } })).toBeUndefined();
  });
});

describe('the config a host builds its retrieval module from', () => {
  const host = (modules: Record<string, unknown>) => validateRecipe({
    name: 'x',
    agent: { systemPrompt: 'sys', provider: 'anthropic', strategy: { type: 'autobiographical', maxMessageTokens: 20_000 } },
    modules: { lessons: true, retrieval: { model: 'test-model', maxInjected: 3 }, ...modules },
  });

  test('carries the cap the block is fitted under beside the recipe\'s retrieval settings', () => {
    expect(retrievalModuleConfig(membrane, host({ subagents: true }))).toEqual({
      membrane,
      retrievalModel: 'test-model',
      retrievalReasoning: undefined,
      maxInjectedLessons: 3,
      maxMessageTokens: 10_000,
    });
    expect(retrievalModuleConfig(membrane, host({})).maxMessageTokens).toBe(20_000);
  });
});
