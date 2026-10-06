/**
 * Unknown recipe keys (#167): a misspelled key used to load without a word and
 * simply not happen. Keys the host never reads at the top level, under `agent`
 * and under `modules` are now named in a warning (with the key they were
 * probably meant to be), and the recipe still loads; the shipped recipes carry
 * none.
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

  test('says what replaced a retired key', () => {
    expect(unknownRecipeKeys(base({ modules: { files: false } }))).toEqual(['modules.files (replaced by modules.workspace)']);
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
