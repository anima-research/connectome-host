import { describe, test, expect } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';
const recipe = (extra: Record<string, unknown>) => ({
  name: 'Test', agent: { name: 'prime', systemPrompt: 'test' },
  codeExecution: { enabled: true, ...extra },
});

describe('codeExecution recipe', () => {
  test('accepts all execution, observation and watcher controls', () => {
    expect(() => validateRecipe(recipe({
      foregroundWaitMs: 0, toolCallTimeoutMs: 50, scriptTimeoutMs: 600_000,
      idleReclaimMs: 0, maxBackgroundScripts: 0, backgroundMaxLifetimeMs: 86_400_000,
      wakeMinIntervalMs: 0, maxWakesPerScript: 0,
    }))).not.toThrow();
  });
  for (const key of ['toolCallTimeoutMs', 'scriptTimeoutMs', 'idleReclaimMs',
    'foregroundWaitMs', 'backgroundMaxLifetimeMs', 'wakeMinIntervalMs',
    'maxBackgroundScripts', 'maxWakesPerScript']) {
    test(`rejects invalid ${key}`, () => {
      for (const value of [-1, NaN, Infinity, 0.5, '100']) {
        expect(() => validateRecipe(recipe({ [key]: value }))).toThrow(key);
      }
    });
  }
  test('rejects timer overflow, excessive observation and zero execution deadlines', () => {
    expect(() => validateRecipe(recipe({ wakeMinIntervalMs: 2_147_483_648 }))).toThrow('wakeMinIntervalMs');
    expect(() => validateRecipe(recipe({ foregroundWaitMs: 60_001 }))).toThrow('foregroundWaitMs');
    for (const key of ['toolCallTimeoutMs', 'scriptTimeoutMs', 'backgroundMaxLifetimeMs']) {
      expect(() => validateRecipe(recipe({ [key]: 0 }))).toThrow(key);
    }
  });
});
