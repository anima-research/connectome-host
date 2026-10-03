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
    writeFileSync(path, JSON.stringify(recipeWith({ semantic: { url: 'http://localhost:1', token: '${EMBED_TOKEN_TEST}' } })));
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

// PR #144 review round (Anarchid #4–#6, Greptile 2–4).
describe('recipe modules.history semantic — review findings', () => {
  const ok = 'https://embed.example.com';
  const rejects = (history: unknown, msg: RegExp) =>
    expect(() => validateRecipe(recipeWith(history))).toThrow(msg);

  test('unknown keys under modules.history are rejected (typo of `semantic`)', () => {
    rejects({ sematic: { url: ok } }, /modules\.history.*unknown key.*sematic/);
    rejects({ semantics: { url: ok } }, /modules\.history.*unknown key.*semantics/);
  });

  test('unknown keys under semantic are rejected (miscased or AF-internal knobs)', () => {
    rejects({ semantic: { url: ok, syncIntervalMS: 1 } }, /semantic.*unknown key.*syncIntervalMS/);
    for (const k of ['syncBatch', 'overlapMs', 'requestTimeoutMs', 'maxChars']) {
      rejects({ semantic: { url: ok, [k]: 1 } }, new RegExp(`unknown key.*${k}`));
    }
  });

  test('url must parse and carry a host; no credentials, query or fragment', () => {
    for (const url of ['http://', 'https://', 'http:///v1', 'not a url', 'https://user:pw@embed.example.com',
      'https://embed.example.com/?x=1', 'https://embed.example.com/#f', 'ws://embed.example.com']) {
      rejects({ semantic: { url } }, /modules\.history\.semantic\.url/);
    }
    for (const url of [ok, 'https://embed.example.com:8804/base/', 'http://127.0.0.1:8804', 'http://localhost:8804',
      'http://[::1]:8804', 'http://100.90.161.34:8804', 'http://embed.tail1234.ts.net:8804']) {
      expect(() => validateRecipe(recipeWith({ semantic: { url } }))).not.toThrow();
    }
  });

  test('plaintext http off loopback/tailnet needs allowInsecureHttp: true', () => {
    for (const url of ['http://embed.example.com', 'http://10.0.0.5:8804', 'http://192.168.1.2:8804', 'http://100.128.0.1:8804']) {
      rejects({ semantic: { url } }, /plaintext http.*allowInsecureHttp/);
      expect(() => validateRecipe(recipeWith({ semantic: { url, allowInsecureHttp: true } }))).not.toThrow();
    }
    rejects({ semantic: { url: ok, allowInsecureHttp: 'yes' } }, /allowInsecureHttp must be a boolean/);
  });

  test('budgets are integers >= 1; syncIntervalMs is 0 or an integer >= 5000', () => {
    for (const k of ['maxSyncPerTick', 'maxSyncBeforeSearch']) {
      rejects({ semantic: { url: ok, [k]: 0 } }, new RegExp(k));
      rejects({ semantic: { url: ok, [k]: 1.5 } }, new RegExp(k));
      expect(() => validateRecipe(recipeWith({ semantic: { url: ok, [k]: 1 } }))).not.toThrow();
    }
    for (const v of [1, 4999, 6000.5]) rejects({ semantic: { url: ok, syncIntervalMs: v } }, /syncIntervalMs/);
    for (const v of [0, 5000, 60000]) {
      expect(() => validateRecipe(recipeWith({ semantic: { url: ok, syncIntervalMs: v } }))).not.toThrow();
    }
  });
});
