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
      const expected = new DefaultErrorPolicy(ownSettings(retry));
      expect(observed.settings).toEqual(Reflect.get(expected, 'settings'));
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
      deadline: sequence([1000, 2000, 4000]),
    };
    // Each slot is failure number i+1 (framework attempt i). Deadline is
    // deliberately mapped to retryable by the pinned DefaultErrorPolicy.
    for (const cls of ['retryable', 'rate_limited', 'overloaded', 'final'] as const) {
      expect(expected[cls]).toEqual(Array.from({ length: 8 }, (_, i) => retryDecision(cls, i + 1, undefined, settings, () => 0)));
    }
    expect(retryDecision('deadline', 1, undefined, settings)).toEqual({ retry: false });
    expect(observed.decisions).toEqual(expected);
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
      final: sequence([]), deadline: sequence([]),
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
