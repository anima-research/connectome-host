/**
 * Every recipe number that must be positive or non-negative must also be
 * finite. JSON has no Infinity, but `1e309` parses to it, and such a value
 * passed the sign checks; saveRecipe() then wrote it back as `null`, and the
 * next load, from the saved recipe the host resumes with, refused the field
 * that had been accepted the day before. Refuse it at the first load.
 */
import { describe, test, expect } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

const OVERFLOW = JSON.parse('1e309') as number; // Infinity, as JSON gives it

function recipe(agent: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return { name: 'finite-test', agent: { systemPrompt: 'sys', ...agent }, ...top };
}

describe('recipe numbers must be finite', () => {
  const cases: Array<[string, (value: number) => Record<string, unknown>, RegExp]> = [
    ['agent.maxStreamTokens', (v) => recipe({ maxStreamTokens: v }), /maxStreamTokens must be a positive number/],
    ['agent.thinking.budgetTokens', (v) => recipe({ thinking: { enabled: true, budgetTokens: v } }), /budgetTokens must be a positive number/],
    ['agent.responses.compactThreshold', (v) => recipe({ responses: { compactThreshold: v } }), /compactThreshold must be a positive number/],
    // refreshAfterMinutes was never open: the TTL bound right after its sign check refuses Infinity. Pinned anyway.
    ['agent.cacheKeepalive.refreshAfterMinutes', (v) => recipe({ cacheKeepalive: { refreshAfterMinutes: v } }), /refreshAfterMinutes/],
    ['agent.cacheKeepalive.maxIdleHours', (v) => recipe({ cacheKeepalive: { maxIdleHours: v } }), /maxIdleHours must be a positive number/],
    ['modules.fleet.socketWaitTimeoutMs', (v) => recipe({}, { modules: { fleet: { socketWaitTimeoutMs: v } } }), /socketWaitTimeoutMs must be a non-negative number/],
    ['modules.fleet.readyTimeoutMs', (v) => recipe({}, { modules: { fleet: { readyTimeoutMs: v } } }), /readyTimeoutMs must be a non-negative number/],
    ['modules.fleet.gracefulShutdownMs', (v) => recipe({}, { modules: { fleet: { gracefulShutdownMs: v } } }), /gracefulShutdownMs must be a number of milliseconds from 0 to 2147483647/],
    ['modules.fleet.sigtermEscalationMs', (v) => recipe({}, { modules: { fleet: { sigtermEscalationMs: v } } }), /sigtermEscalationMs must be a number of milliseconds from 0 to 2147483647/],
    ['codeExecution.toolCallTimeoutMs', (v) => recipe({}, { codeExecution: { enabled: true, toolCallTimeoutMs: v } }), /toolCallTimeoutMs must be a non-negative number/],
    ['codeExecution.scriptTimeoutMs', (v) => recipe({}, { codeExecution: { enabled: true, scriptTimeoutMs: v } }), /scriptTimeoutMs must be a non-negative number/],
    ['codeExecution.idleReclaimMs', (v) => recipe({}, { codeExecution: { enabled: true, idleReclaimMs: v } }), /idleReclaimMs must be a non-negative number/],
  ];

  for (const [field, build, message] of cases) {
    test(`${field}: Infinity and an overflowing JSON number are refused by name; a finite value is kept`, () => {
      for (const bad of [Infinity, OVERFLOW, Number.NaN]) {
        expect(() => validateRecipe(build(bad))).toThrow(message);
      }
      expect(() => validateRecipe(build(1))).not.toThrow();
    });
  }

  test('the two fleet timeouts that reach setTimeout are bounded by the longest delay a timer keeps', () => {
    for (const k of ['gracefulShutdownMs', 'sigtermEscalationMs']) {
      expect(() => validateRecipe(recipe({}, { modules: { fleet: { [k]: 2 ** 31 } } }))).toThrow(/from 0 to 2147483647/);
      expect(() => validateRecipe(recipe({}, { modules: { fleet: { [k]: 2 ** 31 - 1 } } }))).not.toThrow();
    }
    // The two compared between attempts take any finite value.
    expect(() => validateRecipe(recipe({}, { modules: { fleet: { readyTimeoutMs: 2 ** 31 } } }))).not.toThrow();
  });

  test('a refused Infinity is named as such, not as the null it would be saved as', () => {
    expect(() => validateRecipe(recipe({ cacheKeepalive: { maxIdleHours: Infinity } }))).toThrow(/got Infinity/);
  });

  test('what passes validation survives the save-and-resume round trip', () => {
    // The failure this guards against: a value accepted once, written as null
    // by JSON.stringify, refused on resume. With Infinity refused up front,
    // every accepted recipe re-parses to the same numbers.
    const accepted = validateRecipe(recipe({ maxStreamTokens: 80_000, thinking: { enabled: true, budgetTokens: 1024 } }));
    const resumed = JSON.parse(JSON.stringify(accepted)) as Record<string, unknown>;
    expect(() => validateRecipe(resumed)).not.toThrow();
    expect(JSON.stringify(Infinity)).toBe('null'); // why the round trip would otherwise refuse
  });
});
