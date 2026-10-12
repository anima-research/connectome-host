/**
 * Unknown recipe keys (#167): a misspelled key used to load without a word and
 * simply not happen. Keys the host never reads at the top level, under `agent`
 * and under `modules` are now named in a warning (with the key they were
 * probably meant to be), and the recipe still loads; the shipped recipes carry
 * none. A retired key is named with what replaced it. Under `agent.strategy`,
 * whose keys are open, only a retired key is named, and only for a built-in
 * strategy type.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { takeRecipeWarnings, unknownRecipeKeys, validateRecipe } from '../src/recipe.js';

const base = (extra: Record<string, unknown> = {}, agent: Record<string, unknown> = {}) => ({
  name: 'Test',
  agent: { name: 'sherlock', systemPrompt: 'test', ...agent },
  ...extra,
});

describe('unknownRecipeKeys', () => {
  test('a recipe of known keys has none', () => {
    expect(unknownRecipeKeys(base({ mcpServers: {}, modules: { workspace: false, wake: true } }, { model: 'm', cacheTtl: '1h' }))).toEqual([]);
  });

  test('names unknown keys at the top level, under agent and under modules', () => {
    const found = unknownRecipeKeys(base({ bogusTop: 1, modules: { bogusModule: true } }, { bogusAgentKey: 2 }));
    expect(found).toEqual(['bogusTop', 'agent.bogusAgentKey', 'modules.bogusModule']);
  });

  test('suggests the key a typo probably meant', () => {
    expect(unknownRecipeKeys(base({ mcplServers: {} }))).toEqual(['mcplServers (did you mean mcpServers?)']);
    expect(unknownRecipeKeys(base({}, { sytemPrompt: 'x' }))).toEqual(['agent.sytemPrompt (did you mean agent.systemPrompt?)']);
    expect(unknownRecipeKeys(base({ modules: { worksapce: true } }))).toEqual(['modules.worksapce (did you mean modules.workspace?)']);
  });

  test('names unknown keys under agent.mock', () => {
    const mock = { echoMode: false, echomode: true, responseQue: ['x'], chunkDelay: 5 };
    expect(unknownRecipeKeys(base({ modules: { bogusModule: true } }, { provider: 'mock', mock }))).toEqual([
      'agent.mock.echomode (did you mean agent.mock.echoMode?)',
      'agent.mock.responseQue (did you mean agent.mock.responseQueue?)',
      'agent.mock.chunkDelay',
      'modules.bogusModule',
    ]);
    const known = {
      echoMode: true, defaultResponse: 'x', completeDelayMs: 1, streamChunkDelayMs: 1,
      streamChunkSize: 1, responseQueue: ['x'],
    };
    expect(unknownRecipeKeys(base({}, { mock: known }))).toEqual([]);
    // A mock that is not an object is the validator's to reject, not this walk's.
    expect(unknownRecipeKeys(base({}, { mock: 'echo' }))).toEqual([]);
    expect(unknownRecipeKeys({ name: 'T', agent: ['mock'] })).toEqual([]);
  });

  test('says what replaced a retired key', () => {
    expect(unknownRecipeKeys(base({ modules: { files: false } }))).toEqual(['modules.files (replaced by modules.workspace)']);
  });

  test('names a retired strategy key, and no other strategy key, since a strategy\'s keys are open', () => {
    const retired = 'agent.strategy.identityReminderSilent (replaced by a sentence asking for silence at the end of ' +
      'each reminder the recipe sets, agent.strategy.identityReminder and agent.strategy.witnessedIdentityReminder, ' +
      'if it was true; if it was false, nothing)';
    for (const type of ['autobiographical', 'frontdesk', 'passthrough']) {
      const strategy = { type, identityReminderSilent: true, anExtensionsOwnKey: 1 };
      expect(unknownRecipeKeys(base({}, { strategy }))).toEqual([retired]);
    }
    // With no type, the strategy is the built-in autobiographical one.
    expect(unknownRecipeKeys(base({}, { strategy: { identityReminderSilent: false } }))).toEqual([retired]);
    expect(unknownRecipeKeys(base({}, { strategy: { type: 'autobiographical', identityReminder: 'R' } }))).toEqual([]);
    expect(unknownRecipeKeys(base({}, { strategy: 'autobiographical' }))).toEqual([]);
  });

  test('names no strategy key for an extension strategy, whose factory gets the whole strategy config', () => {
    expect(unknownRecipeKeys(base({}, { strategy: { type: 'custom', identityReminderSilent: true } }))).toEqual([]);
  });

  test('a key named like an inherited property gets no false replacement', () => {
    const raw = JSON.parse('{"name":"T","agent":{"constructor":1},"__proto__":{"x":1},"constructor":1}');
    const found = unknownRecipeKeys(raw);
    expect(found).toContain('__proto__');
    expect(found).toContain('constructor');
    expect(found).toContain('agent.constructor');
    expect(found.some((k) => k.includes('replaced by'))).toBe(false);
  });

  test('ignores what it cannot walk', () => {
    expect(unknownRecipeKeys(null)).toEqual([]);
    expect(unknownRecipeKeys([])).toEqual([]);
    expect(unknownRecipeKeys(base({ modules: null }))).toEqual([]);
  });
});

describe('validateRecipe and unknown keys', () => {
  let warn: ReturnType<typeof spyOn> | undefined;
  afterEach(() => { warn?.mockRestore(); warn = undefined; });

  test('warns once, naming every unknown key, and still loads the recipe', () => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
    const recipe = validateRecipe(base({ bogusTop: 1, mcplServers: {}, modules: { files: false } }, { bogusAgentKey: 2 }));
    expect(recipe.name).toBe('Test');
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toContain('Recipe "Test" has keys the host does not read (ignored)');
    for (const key of ['bogusTop', 'mcplServers (did you mean mcpServers?)', 'agent.bogusAgentKey', 'modules.files (replaced by modules.workspace)']) {
      expect(message).toContain(key);
    }
  });

  test('warns about unknown agent.mock keys and still loads the recipe', () => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
    const recipe = validateRecipe(base({}, { provider: 'mock', mock: { streamChunkDelay: 50, streamChunkSize: 2 } }));
    expect(recipe.agent.mock?.streamChunkSize).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0]))
      .toContain('agent.mock.streamChunkDelay (did you mean agent.mock.streamChunkDelayMs?)');
  });

  test('says nothing about a recipe of known keys', () => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
    takeRecipeWarnings();
    validateRecipe(base({ mcpServers: {} }));
    expect(warn).not.toHaveBeenCalled();
    expect(takeRecipeWarnings()).toEqual([]);
  });

  test('keeps the warning for the runtime log, taken once', () => {
    // The TUI and headless redirect stderr after the recipe is validated: they write these into their logs.
    warn = spyOn(console, 'warn').mockImplementation(() => {});
    takeRecipeWarnings();
    validateRecipe(base({ mcplServers: {} }));
    const taken = takeRecipeWarnings();
    expect(taken).toHaveLength(1);
    expect(taken[0]).toContain('mcplServers (did you mean mcpServers?)');
    expect(takeRecipeWarnings()).toEqual([]);
  });
});

test('the shipped recipes carry no unknown keys', () => {
  const dir = new URL('../recipes/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const recipe = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    expect({ file, unknown: unknownRecipeKeys(recipe) }).toEqual({ file, unknown: [] });
  }
});
