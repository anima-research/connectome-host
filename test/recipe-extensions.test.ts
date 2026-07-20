/**
 * Tests for the recipe `extensions` seam: schema validation, load-time path
 * resolution, the extension loader/registry, and custom strategy dispatch
 * through buildFrameworkStrategy.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRecipe, validateRecipe, type Recipe } from '../src/recipe.js';
import {
  loadExtensions,
  emptyExtensionRegistry,
  isBuiltinStrategyType,
} from '../src/extensions.js';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recipe-ext-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function baseRecipe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Ext Test',
    agent: { systemPrompt: 'x' },
    ...overrides,
  };
}

/** Write an extension module file and return its absolute path. */
function writeExtension(filename: string, body: string): string {
  const path = join(dir, filename);
  writeFileSync(path, body, 'utf-8');
  return path;
}

// ---------------------------------------------------------------------------
// validateRecipe
// ---------------------------------------------------------------------------

describe('validateRecipe extensions block', () => {
  test('accepts a well-formed extensions block', () => {
    const recipe = validateRecipe(baseRecipe({
      extensions: {
        zk: { kind: 'strategy', path: './ext.ts', config: { a: 1 } },
        feeder: { kind: 'module', path: '/abs/feeder.ts' },
      },
    }));
    expect(Object.keys(recipe.extensions!)).toEqual(['zk', 'feeder']);
  });

  test('rejects bad kind', () => {
    expect(() => validateRecipe(baseRecipe({
      extensions: { zk: { kind: 'plugin', path: './ext.ts' } },
    }))).toThrow(/kind must be "strategy" or "module"/);
  });

  test('rejects missing path', () => {
    expect(() => validateRecipe(baseRecipe({
      extensions: { zk: { kind: 'strategy' } },
    }))).toThrow(/path must be a non-empty string/);
  });

  test('rejects non-object config', () => {
    expect(() => validateRecipe(baseRecipe({
      extensions: { zk: { kind: 'strategy', path: './e.ts', config: [1] } },
    }))).toThrow(/config must be an object/);
  });

  test('rejects array extensions block', () => {
    expect(() => validateRecipe(baseRecipe({ extensions: [] })))
      .toThrow(/must be an object mapping names/);
  });

  test('custom strategy type without a strategy-kind extension is rejected', () => {
    expect(() => validateRecipe(baseRecipe({
      agent: { systemPrompt: 'x', strategy: { type: 'zk' } },
    }))).toThrow(/Invalid strategy type "zk"/);
  });

  test('custom strategy type with only module-kind extensions is rejected', () => {
    expect(() => validateRecipe(baseRecipe({
      agent: { systemPrompt: 'x', strategy: { type: 'zk' } },
      extensions: { feeder: { kind: 'module', path: './f.ts' } },
    }))).toThrow(/Invalid strategy type "zk"/);
  });

  test('custom strategy type with a strategy-kind extension is accepted', () => {
    const recipe = validateRecipe(baseRecipe({
      agent: { systemPrompt: 'x', strategy: { type: 'zk' } },
      extensions: { zk: { kind: 'strategy', path: './e.ts' } },
    }));
    expect(recipe.agent.strategy?.type).toBe('zk');
  });

  test('built-in strategy types still validate without extensions', () => {
    const recipe = validateRecipe(baseRecipe({
      agent: { systemPrompt: 'x', strategy: { type: 'frontdesk' } },
    }));
    expect(recipe.agent.strategy?.type).toBe('frontdesk');
  });
});

// ---------------------------------------------------------------------------
// loadRecipe path resolution
// ---------------------------------------------------------------------------

describe('loadRecipe extension path resolution', () => {
  test('relative extension paths resolve against the recipe dir', async () => {
    const recipePath = join(dir, 'r.json');
    writeFileSync(recipePath, JSON.stringify(baseRecipe({
      extensions: { zk: { kind: 'module', path: './exts/zk.ts' } },
    })), 'utf-8');
    const recipe = await loadRecipe(recipePath);
    expect(recipe.extensions!.zk!.path).toBe(join(dir, 'exts', 'zk.ts'));
  });

  test('absolute extension paths pass through', async () => {
    const recipePath = join(dir, 'r.json');
    writeFileSync(recipePath, JSON.stringify(baseRecipe({
      extensions: { zk: { kind: 'module', path: '/opt/zk/index.ts' } },
    })), 'utf-8');
    const recipe = await loadRecipe(recipePath);
    expect(recipe.extensions!.zk!.path).toBe('/opt/zk/index.ts');
  });
});

// ---------------------------------------------------------------------------
// loadExtensions
// ---------------------------------------------------------------------------

describe('loadExtensions', () => {
  test('empty when no extensions declared', async () => {
    const recipe = validateRecipe(baseRecipe());
    const registry = await loadExtensions(recipe);
    expect(registry.strategies.size).toBe(0);
    expect(registry.modules.length).toBe(0);
  });

  test('collects strategy and module registrations, passing config', async () => {
    const path = writeExtension('combo.mjs', `
      export function register(api, config) {
        api.registerStrategy('zk', (ctx) => ({ kind: 'zk-strategy', opts: ctx }));
        api.registerModule((ctx) => ({ name: 'zk-feeder', ctx }));
        if (config.marker !== 'hello') throw new Error('config not passed');
      }
    `);
    const recipe = validateRecipe(baseRecipe({
      extensions: { zk: { kind: 'strategy', path, config: { marker: 'hello' } } },
    }));
    const registry = await loadExtensions(recipe);
    expect(registry.strategies.has('zk')).toBe(true);
    expect(registry.modules.length).toBe(1);
    expect(registry.modules[0]!.extensionName).toBe('zk');
    expect(registry.modules[0]!.config).toEqual({ marker: 'hello' });
  });

  test('accepts a default-export register function', async () => {
    const path = writeExtension('default.mjs', `
      export default function (api) {
        api.registerStrategy('dflt', () => ({ kind: 'dflt' }));
      }
    `);
    const recipe = validateRecipe(baseRecipe({
      extensions: { d: { kind: 'strategy', path } },
    }));
    const registry = await loadExtensions(recipe);
    expect(registry.strategies.has('dflt')).toBe(true);
  });

  test('supports async register', async () => {
    const path = writeExtension('async.mjs', `
      export async function register(api) {
        await Promise.resolve();
        api.registerModule(() => ({ name: 'late' }));
      }
    `);
    const recipe = validateRecipe(baseRecipe({
      extensions: { a: { kind: 'module', path } },
    }));
    const registry = await loadExtensions(recipe);
    expect(registry.modules.length).toBe(1);
  });

  test('rejects a module without a register function', async () => {
    const path = writeExtension('bad.mjs', `export const nothing = 1;`);
    const recipe = validateRecipe(baseRecipe({
      extensions: { bad: { kind: 'module', path } },
    }));
    await expect(loadExtensions(recipe)).rejects.toThrow(/must export a "register" function/);
  });

  test('rejects relative paths at load time', async () => {
    const recipe = validateRecipe(baseRecipe({
      extensions: { rel: { kind: 'module', path: './never-resolved.ts' } },
    }));
    await expect(loadExtensions(recipe)).rejects.toThrow(/not absolute/);
  });

  test('rejects registering a built-in strategy name', async () => {
    const path = writeExtension('builtin-clash.mjs', `
      export function register(api) {
        api.registerStrategy('autobiographical', () => ({}));
      }
    `);
    const recipe = validateRecipe(baseRecipe({
      extensions: { clash: { kind: 'strategy', path } },
    }));
    await expect(loadExtensions(recipe)).rejects.toThrow(/collides with a built-in/);
  });

  test('rejects duplicate strategy registrations across extensions', async () => {
    const p1 = writeExtension('one.mjs', `
      export function register(api) { api.registerStrategy('zk', () => ({})); }
    `);
    const p2 = writeExtension('two.mjs', `
      export function register(api) { api.registerStrategy('zk', () => ({})); }
    `);
    const recipe = validateRecipe(baseRecipe({
      extensions: {
        one: { kind: 'strategy', path: p1 },
        two: { kind: 'strategy', path: p2 },
      },
    }));
    await expect(loadExtensions(recipe)).rejects.toThrow(/already registered/);
  });

  test('wraps import failures with the extension name', async () => {
    const path = writeExtension('boom.mjs', `throw new Error('kaboom at import');`);
    const recipe = validateRecipe(baseRecipe({
      extensions: { boom: { kind: 'module', path } },
    }));
    await expect(loadExtensions(recipe)).rejects.toThrow(/extension "boom".*failed to import/);
  });
});

// ---------------------------------------------------------------------------
// buildFrameworkStrategy custom dispatch
// ---------------------------------------------------------------------------

describe('buildFrameworkStrategy with extensions', () => {
  test('dispatches a custom type through the registry with full config', async () => {
    const path = writeExtension('strat.mjs', `
      export function register(api) {
        api.registerStrategy('zk', (ctx) => ({
          kind: 'zk',
          model: ctx.model,
          timeZone: ctx.timeZone,
          customKnob: ctx.config.customKnob,
        }));
      }
    `);
    const recipe = validateRecipe(baseRecipe({
      agent: {
        systemPrompt: 'x',
        strategy: { type: 'zk', customKnob: 42 },
      },
      extensions: { zk: { kind: 'strategy', path } },
    })) as Recipe;
    const registry = await loadExtensions(recipe);
    const strategy = buildFrameworkStrategy(recipe, 'test-model', 'UTC', registry) as unknown as Record<string, unknown>;
    expect(strategy.kind).toBe('zk');
    expect(strategy.model).toBe('test-model');
    expect(strategy.timeZone).toBe('UTC');
    expect(strategy.customKnob).toBe(42);
  });

  test('throws a precise error when a declared type was never registered', () => {
    const recipe = validateRecipe(baseRecipe({
      agent: { systemPrompt: 'x', strategy: { type: 'ghost' } },
      extensions: { zk: { kind: 'strategy', path: '/tmp/unused.ts' } },
    })) as Recipe;
    expect(() => buildFrameworkStrategy(recipe, 'm', 'UTC', emptyExtensionRegistry()))
      .toThrow(/"ghost" is not built-in and no loaded extension registered it/);
  });

  test('built-in dispatch is unaffected by an empty registry', () => {
    const recipe = validateRecipe(baseRecipe()) as Recipe;
    const strategy = buildFrameworkStrategy(recipe, 'm', 'UTC', emptyExtensionRegistry());
    expect(strategy).toBeDefined();
  });
});

describe('isBuiltinStrategyType', () => {
  test('recognizes the three built-ins and nothing else', () => {
    expect(isBuiltinStrategyType('autobiographical')).toBe(true);
    expect(isBuiltinStrategyType('passthrough')).toBe(true);
    expect(isBuiltinStrategyType('frontdesk')).toBe(true);
    expect(isBuiltinStrategyType('zk')).toBe(false);
  });
});
