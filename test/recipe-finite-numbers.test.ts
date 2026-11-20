import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRecipe, validateRecipe } from '../src/recipe.js';

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
    ['agent.cacheKeepalive.maxIdleHours', (v) => recipe({ cacheKeepalive: { maxIdleHours: v } }), /maxIdleHours must be a positive number/, (r) => r.agent.cacheKeepalive.maxIdleHours],
    ['modules.fleet.socketWaitTimeoutMs', (v) => recipe({}, { modules: { fleet: { socketWaitTimeoutMs: v } } }), /socketWaitTimeoutMs must be a non-negative number/, (r) => r.modules.fleet.socketWaitTimeoutMs],
    ['modules.fleet.readyTimeoutMs', (v) => recipe({}, { modules: { fleet: { readyTimeoutMs: v } } }), /readyTimeoutMs must be a whole number of milliseconds from 0 to 2147483647/, (r) => r.modules.fleet.readyTimeoutMs],
    ['modules.fleet.gracefulShutdownMs', (v) => recipe({}, { modules: { fleet: { gracefulShutdownMs: v } } }), /gracefulShutdownMs must be a whole number of milliseconds from 0 to 2147483647/, (r) => r.modules.fleet.gracefulShutdownMs],
    ['modules.fleet.sigtermEscalationMs', (v) => recipe({}, { modules: { fleet: { sigtermEscalationMs: v } } }), /sigtermEscalationMs must be a whole number of milliseconds from 0 to 2147483647/, (r) => r.modules.fleet.sigtermEscalationMs],
  ];

  cases.push(
    // 0, a fraction or a string in these two is the fit check's to name (recipe-fit.ts); only a non-finite number is refused here.
    ['agent.maxTokens', (v) => recipe({ maxTokens: v }), /maxTokens must be a finite number of tokens/, (r) => r.agent.maxTokens],
    ['agent.contextBudgetTokens', (v) => recipe({ contextBudgetTokens: v }), /contextBudgetTokens must be a finite number of tokens/, (r) => r.agent.contextBudgetTokens],
    ['modules.subagents.defaultMaxTokens', (v) => recipe({}, { modules: { subagents: { defaultMaxTokens: v } } }), /subagents\.defaultMaxTokens must be a finite number of tokens/, (r) => r.modules.subagents.defaultMaxTokens],
  );

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

  test('a recipe file with a literal 1e309 in each field is refused by loadRecipe, whose own parser reads it as Infinity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'finite-literal-'));
    try {
      for (const [field, text] of [
        ['agent.maxTokens', '{"name":"f","agent":{"systemPrompt":"s","maxTokens":1e309}}'],
        ['agent.contextBudgetTokens', '{"name":"f","agent":{"systemPrompt":"s","contextBudgetTokens":-1e309}}'],
        ['modules.subagents.defaultMaxTokens', '{"name":"f","agent":{"systemPrompt":"s"},"modules":{"subagents":{"defaultMaxTokens":1e309}}}'],
      ]) {
        const path = join(dir, `${field}.json`);
        writeFileSync(path, text);
        await expect(loadRecipe(path)).rejects.toThrow(`${field} must be a finite number of tokens`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
