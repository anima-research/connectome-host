/**
 * modules.history: boolean or { semantic: { url, token?, namespace?, ... } } —
 * the object form turns on `history--semantic_search` against a shared
 * embed-service. Validation is loud: a typo'd url or a non-numeric cadence
 * must fail at recipe load, not at first search.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRecipe, validateRecipe } from '../src/recipe.js';

function recipeWith(history?: unknown): unknown {
  return {
    name: 't', version: '0.1.0',
    agent: { name: 'Linn', provider: 'anthropic', model: 'claude-fable-5-1', maxTokens: 1000, systemPrompt: 'x' },
    ...(history === undefined ? {} : { modules: { history } }),
  };
}

describe('recipe modules.history semantic validation', () => {
  test('boolean forms still work', () => {
    expect(validateRecipe(recipeWith()).modules?.history).toBeUndefined();
    expect(validateRecipe(recipeWith(true)).modules?.history).toBe(true);
    expect(validateRecipe(recipeWith(false)).modules?.history).toBe(false);
  });

  test('object form with semantic config passes through', () => {
    const r = validateRecipe(recipeWith({ semantic: { url: 'http://100.90.161.34:8804', token: 'abc', namespace: 'linn/9f9857cd', syncIntervalMs: 30000, includePrivateTools: false } }));
    const h = r.modules?.history as { semantic: { url: string; namespace: string; syncIntervalMs: number } };
    expect(h.semantic.url).toBe('http://100.90.161.34:8804');
    expect(h.semantic.namespace).toBe('linn/9f9857cd');
    expect(h.semantic.syncIntervalMs).toBe(30000);
  });

  test('token goes through ${ENV} substitution on load', async () => {
    process.env.EMBED_TOKEN_TEST = 'sekrit';
    const dir = mkdtempSync(join(tmpdir(), 'recipe-sem-'));
    const path = join(dir, 'r.json');
    writeFileSync(path, JSON.stringify(recipeWith({ semantic: { url: 'http://x:1', token: '${EMBED_TOKEN_TEST}' } })));
    const r = await loadRecipe(path);
    expect((r.modules?.history as { semantic: { token: string } }).semantic.token).toBe('sekrit');
  });

  test('rejects malformed configs loudly', () => {
    for (const bad of [
      'yes', [], { semantic: 'x' }, { semantic: [] }, { semantic: {} }, { semantic: { url: 'ftp://x' } }, { semantic: { url: 'http://x', token: '' } },
      { semantic: { url: 'http://x', namespace: 3 } }, { semantic: { url: 'http://x', syncIntervalMs: -1 } }, { semantic: { url: 'http://x', maxSyncPerTick: 'lots' } },
      { semantic: { url: 'http://x', includePrivateTools: 'no' } },
    ]) {
      expect(() => validateRecipe(recipeWith(bad))).toThrow();
    }
  });
});
