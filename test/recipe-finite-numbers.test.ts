/**
 * Every recipe number that must be positive or non-negative must also be
 * finite. JSON has no Infinity, but `1e309` parses to it, and such a value
 * passed the sign checks; saveRecipe() then wrote it back as `null`, and the
 * next load, from the saved recipe the host resumes with, refused the field
 * that had been accepted the day before. Refuse it at the first load.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRecipe, saveRecipe, loadSavedRecipe } from '../src/recipe.js';

const OVERFLOW = JSON.parse('1e309') as number; // Infinity, as JSON gives it

function recipe(agent: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return { name: 'finite-test', agent: { systemPrompt: 'sys', ...agent }, ...top };
}

describe('recipe numbers must be finite', () => {
  type Read = (recipe: any) => unknown;
  const cases: Array<[string, (value: number) => Record<string, unknown>, RegExp, Read]> = [
    ['agent.maxStreamTokens', (v) => recipe({ maxStreamTokens: v }), /maxStreamTokens must be a positive number/, (r) => r.agent.maxStreamTokens],
    ['agent.thinking.budgetTokens', (v) => recipe({ thinking: { enabled: true, budgetTokens: v } }), /budgetTokens must be a positive number/, (r) => r.agent.thinking.budgetTokens],
    ['agent.responses.compactThreshold', (v) => recipe({ responses: { compactThreshold: v } }), /compactThreshold must be a positive number/, (r) => r.agent.responses.compactThreshold],
    // refreshAfterMinutes was never open: the TTL bound right after its sign check refuses Infinity. Pinned anyway.
    ['agent.cacheKeepalive.refreshAfterMinutes', (v) => recipe({ cacheKeepalive: { refreshAfterMinutes: v } }), /refreshAfterMinutes/, (r) => r.agent.cacheKeepalive.refreshAfterMinutes],
    ['agent.cacheKeepalive.maxIdleHours', (v) => recipe({ cacheKeepalive: { maxIdleHours: v } }), /maxIdleHours must be a positive number/, (r) => r.agent.cacheKeepalive.maxIdleHours],
    ['modules.fleet.socketWaitTimeoutMs', (v) => recipe({}, { modules: { fleet: { socketWaitTimeoutMs: v } } }), /socketWaitTimeoutMs must be a non-negative number/, (r) => r.modules.fleet.socketWaitTimeoutMs],
    ['modules.fleet.readyTimeoutMs', (v) => recipe({}, { modules: { fleet: { readyTimeoutMs: v } } }), /readyTimeoutMs must be a whole number of milliseconds from 0 to 2147483647/, (r) => r.modules.fleet.readyTimeoutMs],
    ['modules.fleet.gracefulShutdownMs', (v) => recipe({}, { modules: { fleet: { gracefulShutdownMs: v } } }), /gracefulShutdownMs must be a whole number of milliseconds from 0 to 2147483647/, (r) => r.modules.fleet.gracefulShutdownMs],
    ['modules.fleet.sigtermEscalationMs', (v) => recipe({}, { modules: { fleet: { sigtermEscalationMs: v } } }), /sigtermEscalationMs must be a whole number of milliseconds from 0 to 2147483647/, (r) => r.modules.fleet.sigtermEscalationMs],
  ];

  for (const [field, build, message, read] of cases) {
    test(`${field}: Infinity, an overflowing JSON number and NaN are refused, naming the field and the value; a finite value is kept`, () => {
      for (const bad of [Infinity, OVERFLOW, Number.NaN]) {
        expect(() => validateRecipe(build(bad))).toThrow(message);
        expect(() => validateRecipe(build(bad))).toThrow(`got ${String(bad)}`);
      }
      expect(read(validateRecipe(build(1)))).toBe(1);
    });
  }

  test('the three fleet timeouts that reach setTimeout take a whole number of milliseconds up to the longest delay a timer keeps', () => {
    for (const k of ['readyTimeoutMs', 'gracefulShutdownMs', 'sigtermEscalationMs']) {
      expect(() => validateRecipe(recipe({}, { modules: { fleet: { [k]: 2 ** 31 } } }))).toThrow(`fleet.${k} must be a whole number of milliseconds from 0 to 2147483647, got 2147483648`);
      expect(() => validateRecipe(recipe({}, { modules: { fleet: { [k]: 1.5 } } }))).toThrow(`fleet.${k} must be a whole number of milliseconds from 0 to 2147483647, got 1.5`);
      expect(() => validateRecipe(recipe({}, { modules: { fleet: { [k]: 2 ** 31 - 1 } } }))).not.toThrow();
    }
    expect(() => validateRecipe(recipe({}, { modules: { fleet: { socketWaitTimeoutMs: 2 ** 31 } } }))).not.toThrow();
  });

  test('a refused Infinity is named as such, not as the null it would be saved as', () => {
    expect(() => validateRecipe(recipe({ cacheKeepalive: { maxIdleHours: Infinity } }))).toThrow(/got Infinity/);
  });

  describe('saved and resumed', () => {
    let dataDir: string;
    beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'conhost-finite-')); });
    afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

    for (const [field, build] of cases) {
      test(`${field}: a recipe the first load accepts loads again from its saved copy`, async () => {
        for (const value of [1, OVERFLOW]) {
          let accepted = true;
          try { validateRecipe(build(value)); } catch { accepted = false; }
          if (!accepted) continue;
          saveRecipe(dataDir, build(value));
          const resumed = await loadSavedRecipe(dataDir, { fetchSystemPrompt: false }).then((r) => r === null ? 'nothing saved' : 'loaded', (err: Error) => err.message);
          expect(`${field} = ${value}: ${resumed}`).toBe(`${field} = ${value}: loaded`);
        }
      });
    }
  });
});
