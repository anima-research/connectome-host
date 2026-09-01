/**
 * Two recipe knobs that expose configuration the stack already had underneath
 * but the host never surfaced:
 *
 * - `agent.retry` → Membrane's retry policy. Membrane's default retries
 *   generic retryable errors zero times (only 529/overloaded_error gets the
 *   patient schedule), so a gateway 502 killed the turn on first failure with
 *   no recipe-side remedy.
 * - `mcpServers.<id>.requestTimeoutMs` → the framework's per-server JSON-RPC
 *   timeout (default 60s), which slow tools such as image generation exceed.
 *
 * Both must validate at recipe-load time — a typo should fail loudly there,
 * not as a silently-ignored field at first inference.
 */
import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function recipe(overrides: { agent?: Record<string, unknown>; mcpServers?: Record<string, unknown> } = {}) {
  return {
    name: 'knobs-test',
    agent: { systemPrompt: 'sys', ...(overrides.agent ?? {}) },
    ...(overrides.mcpServers ? { mcpServers: overrides.mcpServers } : {}),
  };
}

describe('recipe agent.retry', () => {
  test('is optional and absent by default', () => {
    expect(validateRecipe(recipe()).agent.retry).toBeUndefined();
  });

  test('accepts a partial retry config and preserves it verbatim', () => {
    const r = validateRecipe(recipe({ agent: { retry: { maxRetries: 4 } } }));
    expect(r.agent.retry).toEqual({ maxRetries: 4 });
  });

  test('accepts the full shape including the overloaded sub-policy', () => {
    const retry = {
      maxRetries: 3,
      retryDelayMs: 500,
      backoffMultiplier: 2,
      maxRetryDelayMs: 10_000,
      overloaded: { maxRetries: 2 },
    };
    expect(validateRecipe(recipe({ agent: { retry } })).agent.retry).toEqual(retry);
  });

  test('rejects non-object values at load time', () => {
    expect(() => validateRecipe(recipe({ agent: { retry: 4 } }))).toThrow(/agent\.retry must be an object/);
    expect(() => validateRecipe(recipe({ agent: { retry: [4] } }))).toThrow(/agent\.retry must be an object/);
    expect(() => validateRecipe(recipe({ agent: { retry: null } }))).toThrow(/agent\.retry must be an object/);
  });

  test('rejects unknown keys — a typo must not silently leave the agent at zero retries', () => {
    expect(() => validateRecipe(recipe({ agent: { retry: { maxRetires: 4 } } }))).toThrow(/unknown key "maxRetires"/);
    expect(() => validateRecipe(recipe({ agent: { retry: { overloaded: { maxRetires: 2 } } } }))).toThrow(/overloaded has unknown key "maxRetires"/);
  });

  test('validates overloaded fields numerically', () => {
    expect(() => validateRecipe(recipe({ agent: { retry: { overloaded: { maxRetries: -2 } } } }))).toThrow(/overloaded\.maxRetries/);
  });

  test('rejects negative or non-numeric counts and delays', () => {
    expect(() => validateRecipe(recipe({ agent: { retry: { maxRetries: -1 } } }))).toThrow(/agent\.retry\.maxRetries/);
    expect(() => validateRecipe(recipe({ agent: { retry: { retryDelayMs: '1s' } } }))).toThrow(/agent\.retry\.retryDelayMs/);
    expect(() => validateRecipe(recipe({ agent: { retry: { overloaded: 7 } } }))).toThrow(/agent\.retry\.overloaded must be an object/);
  });
});

describe('recipe mcpServers.<id>.requestTimeoutMs', () => {
  const server = (extra: Record<string, unknown> = {}) => ({
    imagen: { command: 'node', args: ['server.mjs'], ...extra },
  });

  test('is optional', () => {
    const r = validateRecipe(recipe({ mcpServers: server() }));
    expect(r.mcpServers?.imagen.requestTimeoutMs).toBeUndefined();
  });

  test('accepts a positive timeout and 0 (disable), preserving the value for the framework passthrough', () => {
    expect(validateRecipe(recipe({ mcpServers: server({ requestTimeoutMs: 180_000 }) })).mcpServers?.imagen.requestTimeoutMs).toBe(180_000);
    expect(validateRecipe(recipe({ mcpServers: server({ requestTimeoutMs: 0 }) })).mcpServers?.imagen.requestTimeoutMs).toBe(0);
  });

  test('rejects negative, non-finite and non-numeric timeouts at load time', () => {
    expect(() => validateRecipe(recipe({ mcpServers: server({ requestTimeoutMs: -1 }) }))).toThrow(/mcpServers\.imagen\.requestTimeoutMs/);
    expect(() => validateRecipe(recipe({ mcpServers: server({ requestTimeoutMs: '3m' }) }))).toThrow(/mcpServers\.imagen\.requestTimeoutMs/);
    expect(() => validateRecipe(recipe({ mcpServers: server({ requestTimeoutMs: Infinity }) }))).toThrow(/mcpServers\.imagen\.requestTimeoutMs/);
  });
});
