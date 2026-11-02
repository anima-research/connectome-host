import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DefaultErrorPolicy } from '@animalabs/agent-framework';
import { DEFAULT_RETRY_CONFIG, Membrane, MockAdapter, type MembraneConfig } from '@animalabs/membrane';
import { membraneRetrySettings, retryDecision, type RetrySettings } from '@animalabs/membrane/retry';
import { hostMembraneRetry } from '../src/membrane-retry.js';
import { DEFAULT_RECIPE, validateRecipe } from '../src/recipe.js';

type Retry = MembraneConfig['retry'];
function capture(retry?: Retry) {
  const dir = mkdtempSync(join(tmpdir(), 'turn-retry-'));
  try {
    const recipe = structuredClone(DEFAULT_RECIPE);
    recipe.agent.provider = 'mock';
    recipe.agent.retry = retry;
    recipe.modules = {};
    recipe.mcpServers = {};
    const path = join(dir, 'recipe.json');
    writeFileSync(path, JSON.stringify(recipe));
    const result = Bun.spawnSync([
      process.execPath, '--preload', resolve(import.meta.dir, 'capture-retry-create.preload.ts'),
      resolve(import.meta.dir, '../src/index.ts'), path,
    ], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir, DATA_DIR: join(dir, 'data'), CONNECTOME_UPDATE_CHECK: '0' },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    const line = result.stdout.toString().split('\n').find(line => line.startsWith('RETRY_CAPTURE='));
    if (!line) throw new Error(`create() not reached: ${result.stderr}`);
    return JSON.parse(line.slice('RETRY_CAPTURE='.length));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Reflection is intentional: membrane 0.8.0 has no public partial-config
// resolver or settings getter. Its constructor is the independent oracle;
// no provider method is invoked. This fails if our completion diverges.
function ownSettings(retry?: Retry): RetrySettings {
  return Reflect.get(new Membrane(new MockAdapter(), { retry }), 'retrySettings');
}
function sequence(delays: number[]) {
  return Array.from({ length: 8 }, (_, i) => i < delays.length ? { retry: true, delayMs: delays[i] } : { retry: false });
}

describe('recipe retry at the real AgentFramework.create call', () => {
  test('control: a silent recipe omits errorPolicy entirely', () => {
    expect(capture().hasErrorPolicy).toBe(false);
  });
  for (const retry of [undefined, { maxRetries: 4 }, { overloaded: { maxRetries: 9, retryDelayMs: 123 } }]) {
    test(`control: Membrane-side settings unchanged for ${JSON.stringify(retry)}`, () => {
      const observed = capture(retry);
      expect(observed.membraneRetry).toEqual(hostMembraneRetry(retry));
      expect(observed.membraneSettings).toEqual(ownSettings(hostMembraneRetry(retry)));
    });
  }
  test('control: an empty object counts as unset, omitting errorPolicy', () => {
    expect(capture({}).hasErrorPolicy).toBe(false);
  });
  for (const retry of [
    { maxRetries: 4 },
    { maxRetries: 0 },
    { retryDelayMs: 23, backoffMultiplier: 1.5, maxRetryDelayMs: 40 },
    { overloaded: {} },
    { maxRetries: 9, overloaded: { maxRetries: 2 } },
    { overloaded: { maxRetries: 0 } },
    { overloaded: { maxRetries: 4, retryDelayMs: 80, backoffMultiplier: 3, maxRetryDelayMs: 100 } },
  ]) {
    test(`turn settings match Membrane completion for ${JSON.stringify(retry)}`, () => {
      const observed = capture(retry);
      expect(observed.hasErrorPolicy).toBe(true);
      expect(observed.isDefaultErrorPolicy).toBe(true);
      const expected = new DefaultErrorPolicy({ ...ownSettings(retry), deadline: Reflect.get(new DefaultErrorPolicy(), 'settings').deadline });
      expect(observed.settings).toEqual(Reflect.get(expected, 'settings'));
    });
  }
  for (const retry of [{ retryDelayMs: 500 }, { maxRetries: 4 }, { maxRetries: 8 }, { maxRetries: 0 }]) {
    test(`R1-1: deadline keeps one fresh call regardless of ${JSON.stringify(retry)}`, () => {
      const observed = capture(retry);
      expect(observed.settings.deadline).toEqual(Reflect.get(new DefaultErrorPolicy(), 'settings').deadline);
      expect(observed.decisions.deadline).toEqual(sequence([1000]));
    });
  }
  test('maxRetries:4 has explicit failure-number decisions for every error class', () => {
    const observed = capture({ maxRetries: 4 });
    const settings = membraneRetrySettings({ ...DEFAULT_RETRY_CONFIG, maxRetries: 4 });
    const expected = {
      retryable: sequence([1000, 2000, 4000]),
      rate_limited: sequence([1000, 2000, 4000, 8000]),
      overloaded: sequence([5000, 10000, 20000, 40000, 80000, 150000]),
      final: sequence([]),
      deadline: sequence([1000]),
    };
    // Each slot is failure number i+1 (framework attempt i). A deadline
    // counts consecutive cuts separately, on the framework's own schedule.
    for (const cls of ['retryable', 'rate_limited', 'overloaded', 'final'] as const) {
      expect(expected[cls]).toEqual(Array.from({ length: 8 }, (_, i) => retryDecision(cls, i + 1, undefined, settings, () => 0)));
    }
    expect(retryDecision('deadline', 1, undefined, settings)).toEqual({ retry: false });
    expect(observed.decisions).toEqual(expected);
  });
  for (const { name, retry, baseCeiling, overloadedCeiling, overloadedBackoff = 5000 } of [
    { name: 'omitted retry', retry: undefined, baseCeiling: 600_000, overloadedCeiling: 600_000 },
    { name: 'empty retry', retry: {}, baseCeiling: 600_000, overloadedCeiling: 600_000 },
    { name: 'partial recipe', retry: { maxRetries: 4 }, baseCeiling: 60_000, overloadedCeiling: 300_000 },
    {
      name: 'recipe with larger maximum delays',
      retry: { maxRetries: 4, maxRetryDelayMs: 90_000, overloaded: { maxRetryDelayMs: 120_000 } },
      baseCeiling: 90_000, overloadedCeiling: 120_000,
    },
    {
      name: 'recipe with overloaded schedule disabled', retry: { maxRetries: 4, overloaded: { maxRetries: 0 } },
      baseCeiling: 60_000, overloadedCeiling: 60_000, overloadedBackoff: 1000,
    },
  ]) {
    test(`stated-wait boundaries at the create call: ${name}`, () => {
      const observed = capture(retry);
      for (const [cls, ceiling, backoff] of [
        ['retryable', baseCeiling, 1000],
        ['rate_limited', baseCeiling, 1000],
        ['overloaded', overloadedCeiling, overloadedBackoff],
      ] as const) {
        const decisions = observed.statedWaitDecisions[cls];
        // A stated wait is a lower bound, never a backoff replacement.
        expect(decisions[500]).toEqual({ retry: true, delayMs: backoff });
        expect(decisions[ceiling - 1]).toEqual({ retry: true, delayMs: ceiling - 1 });
        expect(decisions[ceiling]).toEqual({ retry: true, delayMs: ceiling });
        // Both probes use the first failure: accepting the ceiling above
        // proves that the next refusal is not attempt exhaustion.
        expect(decisions[ceiling + 1]).toEqual({ retry: false });
        expect(decisions[ceiling + 1]).not.toHaveProperty('statedWaitMs');
        if (observed.settings) {
          // Explicit policies expose their settings in the existing capture.
          // Membrane distinguishes a ceiling refusal from exhaustion; the
          // framework deliberately drops the statedWaitMs refusal metadata.
          expect(retryDecision(cls, 1, ceiling + 1, observed.settings, () => 0))
            .toEqual({ retry: false, statedWaitMs: ceiling + 1 });
          const schedule = observed.settings[cls] ?? observed.settings.retryable;
          expect(schedule.maxAttempts).toBeGreaterThan(1);
          expect(retryDecision(cls, schedule.maxAttempts, ceiling + 1, observed.settings, () => 0))
            .toEqual({ retry: false });
        }
      }
    });
  }
  test('the longer-wait recipe also raises non-turn caps and enables its overloaded schedule', () => {
    const retry = { maxRetryDelayMs: 600_000, overloaded: { maxRetries: 13, maxRetryDelayMs: 600_000 } };
    const observed = capture(retry);
    expect(observed.membraneRetry).toEqual(retry);
    expect({ ...observed.membraneSettings, deadline: observed.settings.deadline }).toEqual(observed.settings);
    expect(observed.membraneSettings.retryable.maxDelayMs).toBe(600_000);
    expect(observed.membraneSettings.overloaded).toMatchObject({ maxAttempts: 13, maxDelayMs: 600_000 });
    const defaults = ownSettings(hostMembraneRetry());
    expect(defaults.retryable?.maxDelayMs).toBe(30_000);
    expect(defaults.overloaded).toBeUndefined();
    // The same provider failure now takes the special jittered schedule
    // on non-turn calls too, rather than the host's ordinary base schedule.
    expect(retryDecision('overloaded', 1, undefined, observed.membraneSettings, () => 0))
      .toEqual({ retry: true, delayMs: 5000 });
    expect(retryDecision('overloaded', 1, undefined, defaults, () => 0))
      .toEqual({ retry: true, delayMs: 1000 });
  });
  test('explicit overloaded values replace the default turn schedule', () => {
    const observed = capture({ maxRetries: 4, overloaded: { maxRetries: 3, retryDelayMs: 20, backoffMultiplier: 2, maxRetryDelayMs: 50 } });
    expect(observed.decisions.overloaded).toEqual(sequence([10, 20, 25]));
  });
  test('overloaded maxRetries:0 falls back to the base turn schedule without jitter', () => {
    expect(capture({ maxRetries: 4, overloaded: { maxRetries: 0 } }).decisions?.overloaded).toEqual(sequence([1000, 2000, 4000]));
  });
  test('maxRetries:0 stops ordinary retries but retains rate-limit and overloaded floors', () => {
    const observed = capture({ maxRetries: 0 });
    expect(observed.decisions).toEqual({
      retryable: sequence([]), rate_limited: sequence([1000, 2000, 4000, 8000]),
      overloaded: sequence([5000, 10000, 20000, 40000, 80000, 150000]),
      final: sequence([]), deadline: sequence([1000]),
    });
  });
  for (const retry of [null, [], { maxRetires: 4 }, { maxRetries: -1 }, { maxRetries: Infinity }, { retryDelayMs: '100' }, { overloaded: null }, { overloaded: { typo: 1 } }, { overloaded: { maxRetries: -1 } }]) {
    test(`control: existing recipe validation rejects ${JSON.stringify(retry)}`, () => {
      const recipe = structuredClone(DEFAULT_RECIPE);
      (recipe.agent as any).retry = retry;
      expect(() => validateRecipe(recipe)).toThrow('Recipe agent.retry');
    });
  }
});
