/**
 * Tests for the ${VAR} env substitution added to loadRecipe.
 * Exercises substituteEnvVars() directly (pure function) plus an end-to-end
 * loadRecipe flow via a temp recipe file.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRecipe, substituteEnvVars } from '../src/recipe.js';

describe('substituteEnvVars', () => {
  const originalEnv = process.env;
  beforeEach(() => { process.env = { ...originalEnv }; });
  afterEach(() => { process.env = originalEnv; });

  test('substitutes ${VAR} in a string', () => {
    process.env.FOO = 'hello';
    expect(substituteEnvVars('prefix ${FOO} suffix', 'test')).toBe('prefix hello suffix');
  });

  test('substitutes multiple vars in one string', () => {
    process.env.A = 'x'; process.env.B = 'y';
    expect(substituteEnvVars('${A}-${B}', 'test')).toBe('x-y');
  });

  test('leaves strings without patterns untouched', () => {
    expect(substituteEnvVars('no pattern here', 'test')).toBe('no pattern here');
  });

  test('walks nested objects', () => {
    process.env.TOKEN = 'abc123';
    const input = {
      mcpServers: {
        gitlab: {
          env: { TOKEN: '${TOKEN}' },
          args: ['--flag', 'value'],
        },
      },
    };
    const out = substituteEnvVars(input, 'test') as typeof input;
    expect(out.mcpServers.gitlab.env.TOKEN).toBe('abc123');
    expect(out.mcpServers.gitlab.args).toEqual(['--flag', 'value']);
  });

  test('walks arrays', () => {
    process.env.X = 'X-val';
    const out = substituteEnvVars(['a', '${X}', 'c'], 'test');
    expect(out).toEqual(['a', 'X-val', 'c']);
  });

  test('passes through non-string leaves', () => {
    const out = substituteEnvVars({ a: 1, b: true, c: null, d: 'literal' }, 'test');
    expect(out).toEqual({ a: 1, b: true, c: null, d: 'literal' });
  });

  test('throws on missing env var with actionable message', () => {
    delete process.env.MISSING_VAR;
    expect(() => substituteEnvVars('${MISSING_VAR}', 'recipes/foo.json'))
      .toThrow(/MISSING_VAR/);
    expect(() => substituteEnvVars('${MISSING_VAR}', 'recipes/foo.json'))
      .toThrow(/recipes\/foo\.json/);
    expect(() => substituteEnvVars('${MISSING_VAR}', 'recipes/foo.json'))
      .toThrow(/\.env|delete the section/);
  });

  test('does not touch literal $-without-braces', () => {
    expect(substituteEnvVars('price: $5 and $100', 'test')).toBe('price: $5 and $100');
  });

  test('pattern requires valid identifier (starts with letter or underscore)', () => {
    // ${1FOO} is not a valid var name and should be left alone.
    expect(substituteEnvVars('${1FOO}', 'test')).toBe('${1FOO}');
  });

  test('supports underscore-prefixed names', () => {
    process.env._PRIVATE = 'secret';
    expect(substituteEnvVars('${_PRIVATE}', 'test')).toBe('secret');
  });
});

describe('loadRecipe — end-to-end with env substitution', () => {
  const originalEnv = process.env;
  let tmpDir: string;
  let recipePath: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-recipe-env-'));
    recipePath = join(tmpDir, 'recipe.json');
  });

  afterEach(() => {
    process.env = originalEnv;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('substitution flows through loadRecipe to the validated recipe', async () => {
    process.env.FAKE_TOKEN = 'tok-abc';
    const recipe = {
      name: 'Env Test',
      agent: { systemPrompt: 'Your token is ${FAKE_TOKEN}.' },
    };
    writeFileSync(recipePath, JSON.stringify(recipe), 'utf-8');

    const loaded = await loadRecipe(recipePath);
    expect(loaded.agent.systemPrompt).toBe('Your token is tok-abc.');
  });

  test('missing env var surfaces a clear error from loadRecipe', async () => {
    delete process.env.NEVER_SET;
    const recipe = {
      name: 'Env Test',
      agent: { systemPrompt: 'placeholder' },
      mcpServers: {
        foo: { command: 'node', env: { SOME_KEY: '${NEVER_SET}' } },
      },
    };
    writeFileSync(recipePath, JSON.stringify(recipe), 'utf-8');

    await expect(loadRecipe(recipePath)).rejects.toThrow(/NEVER_SET/);
  });

  describe('${VAR:-default} syntax', () => {
    test('uses default when var unset', () => {
      delete process.env.LATER_SET;
      expect(substituteEnvVars('${LATER_SET:-fallback}', 't')).toBe('fallback');
    });

    test('uses default when var is empty string', () => {
      process.env.EMPTY_VAR = '';
      expect(substituteEnvVars('${EMPTY_VAR:-fallback}', 't')).toBe('fallback');
    });

    test('uses var value when set and non-empty', () => {
      process.env.SET_VAR = 'real-value';
      expect(substituteEnvVars('${SET_VAR:-fallback}', 't')).toBe('real-value');
    });

    test('empty default is allowed', () => {
      delete process.env.OPTIONAL_VAR;
      expect(substituteEnvVars('${OPTIONAL_VAR:-}', 't')).toBe('');
    });

    test('does NOT throw on unset var with default', () => {
      delete process.env.NEVER_SET;
      expect(() => substituteEnvVars('${NEVER_SET:-default}', 't')).not.toThrow();
    });

    test('mixed default + required in same string', () => {
      delete process.env.HOST;
      delete process.env.PORT;
      process.env.HOST = 'example.com';
      expect(substituteEnvVars('${HOST}:${PORT:-21}', 't')).toBe('example.com:21');
    });
  });
});
