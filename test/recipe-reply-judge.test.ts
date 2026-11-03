/**
 * `modules.wake.judge` (agent-framework's reply judge, `GateOptions.judge`):
 * recipe validation, and the gate options the host hands agent-framework
 * carrying it apart from the starting rules.
 */
import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';

import { validateRecipe } from '../src/recipe.js';
import { gateOptionsFor } from '../src/gate-options.js';

function recipe(wake: unknown) {
  return { name: 'reply-judge-test', agent: { systemPrompt: 'sys' }, modules: { wake } };
}

const RULES = { default: 'defer', policies: [{ name: 'mentions', match: { tagsAny: ['chat:mention'] }, behavior: 'always' }] };

describe('recipe: modules.wake.judge', () => {
  test('takes every key agent-framework reads, as written', () => {
    const judge = {
      enabled: true, model: 'anthropic/claude-haiku-5-5', maxInputTokens: 60000, timeoutMs: 15000,
      onError: 'skip', effort: 'none', cacheTtl: '1h',
    };
    expect(validateRecipe(recipe({ ...RULES, judge })).modules!.wake).toEqual({ ...RULES, judge });
    expect(validateRecipe(recipe({ judge: {} })).modules!.wake).toEqual({ judge: {} });
  });

  test('loads wake values without a judge as before', () => {
    for (const wake of [true, false, RULES]) {
      expect(validateRecipe(recipe(wake)).modules!.wake).toEqual(wake);
    }
  });

  test('refuses an unknown key, naming it and the keys it takes', () => {
    expect(() => validateRecipe(recipe({ judge: { modle: 'x' } }))).toThrow(
      'Recipe modules.wake.judge has unknown key "modle"; it takes enabled, model, maxInputTokens, timeoutMs, onError, effort and cacheTtl.',
    );
  });

  test('refuses a value agent-framework would read as its default, naming the key and what it must be', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ enabled: 'false' }, 'Recipe modules.wake.judge.enabled is "false"; it must be true or false.'],
      [{ model: '' }, 'Recipe modules.wake.judge.model is ""; it must be a non-empty string.'],
      [{ maxInputTokens: 3000 }, 'Recipe modules.wake.judge.maxInputTokens is 3000; it must be a whole number of tokens, 4000 or more.'],
      [{ maxInputTokens: 90000.5 }, 'Recipe modules.wake.judge.maxInputTokens is 90000.5; it must be a whole number of tokens, 4000 or more.'],
      [{ timeoutMs: 0 }, 'Recipe modules.wake.judge.timeoutMs is 0; it must be a whole number of milliseconds from 1 to 2147483647.'],
      [{ onError: 'quiet' }, 'Recipe modules.wake.judge.onError is "quiet"; it must be "wake" or "skip".'],
      [{ effort: 'max' }, 'Recipe modules.wake.judge.effort is "max"; it must be "low", "medium", "high" or "none".'],
      [{ cacheTtl: '10m' }, 'Recipe modules.wake.judge.cacheTtl is "10m"; it must be "5m" or "1h".'],
    ];
    for (const [judge, message] of cases) {
      expect(() => validateRecipe(recipe({ judge }))).toThrow(message);
    }
  });

  test('refuses a judge that is not an object', () => {
    for (const judge of [true, 'haiku', null, ['claude-haiku-5-5']]) {
      expect(() => validateRecipe(recipe({ judge }))).toThrow('Recipe modules.wake.judge must be an object');
    }
  });
});

describe('gate options for modules.wake', () => {
  const env = { SLEEP_PRIVILEGED_FILE: '/etc/privileged.json' } as NodeJS.ProcessEnv;

  test('false is no gate', () => {
    expect(gateOptionsFor(false, '/store', env)).toBeUndefined();
  });

  test('true or left out is the gate with no starting rules and no judge options', () => {
    for (const wake of [true, undefined]) {
      expect(gateOptionsFor(wake, '/store', env)).toEqual({
        configPath: join('/store', 'config', 'gate.json'),
        privilegedUsersPath: '/etc/privileged.json',
      });
    }
  });

  test('the starting rules go as config, without the judge, and the judge as judge', () => {
    const judge = { model: 'claude-haiku-5-5', onError: 'skip' as const };
    const options = gateOptionsFor({ ...(RULES as object), judge } as never, '/store', env)!;
    expect(options.config).toEqual(RULES as never);
    expect((options.config as unknown as Record<string, unknown>).judge).toBeUndefined();
    expect((options as unknown as { judge?: unknown }).judge).toEqual(judge);
  });

  test('a judge with no rules sets no starting rules', () => {
    const options = gateOptionsFor({ judge: { enabled: false } }, '/store', env)!;
    expect(options.config).toBeUndefined();
    expect((options as unknown as { judge?: unknown }).judge).toEqual({ enabled: false });
  });

  test('a default without policies still goes as the starting rules', () => {
    const options = gateOptionsFor({ default: 'defer', judge: { model: 'm' } }, '/store', env)!;
    expect(options.config).toEqual({ default: 'defer' } as never);
    expect((options as unknown as { judge?: unknown }).judge).toEqual({ model: 'm' });
  });

  test('the privileged-users file defaults to the install directory', () => {
    expect(gateOptionsFor(true, '/store', {})!.privilegedUsersPath).toBe(resolve('./sleep-privileged.json'));
  });
});
