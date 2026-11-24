import { describe, expect, spyOn, test } from 'bun:test';
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

  test('a block that is off still has its numbers checked, and a retired key in it is a warning, not a refusal', () => {
    expect(() => validateRecipe(recipe({ enabled: false, yieldMs: -1 })))
      .toThrow('Recipe codeExecution.yieldMs must be a whole number of 0 or more, got -1.');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => validateRecipe(recipe({ enabled: false, pythonPath: 'python3' }))).not.toThrow();
      expect(warn).toHaveBeenCalledWith('Recipe has keys the host does not read (ignored): codeExecution.pythonPath.');
    } finally {
      warn.mockRestore();
    }
    expect(() => validateRecipe(recipe({ enabled: 'true' }))).toThrow('Recipe codeExecution.enabled must be true or false, got "true".');
  });
});
