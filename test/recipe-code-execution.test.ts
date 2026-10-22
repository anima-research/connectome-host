/**
 * The recipe's codeExecution block against agent-framework 0.24's JavaScript
 * runner: the Python runner's settings are refused at recipe load with what
 * to set instead, as the framework refuses them at create(), and the
 * runner's numeric settings are whole numbers of 0 or more. A block that
 * isn't on has nothing else read, as in the framework.
 */
import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

const recipe = (codeExecution: unknown) => ({
  name: 'code-execution-test',
  agent: { name: 'fable', systemPrompt: 'system' },
  codeExecution,
});

describe('recipe codeExecution (agent-framework 0.24)', () => {
  test('takes the runner settings as whole numbers of 0 or more', () => {
    const settings = {
      enabled: true, yieldMs: 30_000, maxYieldMs: 600_000, scriptLifetimeMs: 86_400_000,
      maxRunningScripts: 3, maxScriptChildren: 16, toolCallTimeoutMs: 270_000,
      wakeMinIntervalMs: 0, maxWakesPerScript: 100, memoryMaxBytes: 128 * 1024 * 1024,
    };
    expect(validateRecipe(recipe(settings)).codeExecution).toEqual(settings);
    for (const value of [-1, 1.5, Number.NaN, '30000']) {
      expect(() => validateRecipe(recipe({ enabled: true, yieldMs: value })))
        .toThrow(/codeExecution\.yieldMs must be a whole number of 0 or more/);
    }
  });

  test("refuses the Python runner's settings, naming what to set instead", () => {
    const instead: Record<string, RegExp> = {
      pythonPath: /no interpreter to name/,
      idleReclaimMs: /nothing to reclaim/,
      env: /no environment/,
      inheritEnv: /no environment/,
      scriptTimeoutMs: /set yieldMs/,
      maxScriptTimeoutMs: /set maxYieldMs/,
      backgroundMaxLifetimeMs: /set scriptLifetimeMs/,
      maxBackgroundScripts: /set maxRunningScripts/,
    };
    for (const [key, why] of Object.entries(instead)) {
      expect(() => validateRecipe(recipe({ enabled: true, [key]: key === 'pythonPath' ? 'python3' : 1 })))
        .toThrow(new RegExp(`codeExecution\\.${key} is no longer read`));
      expect(() => validateRecipe(recipe({ enabled: true, [key]: 1 }))).toThrow(why);
    }
  });

  test('reads nothing else of a block that is off', () => {
    expect(() => validateRecipe(recipe({ enabled: false, pythonPath: 'python3', yieldMs: -1 }))).not.toThrow();
    expect(() => validateRecipe(recipe({ enabled: 'true' }))).toThrow(/codeExecution\.enabled must be a boolean/);
  });
});
