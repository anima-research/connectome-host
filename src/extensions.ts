/**
 * Recipe extensions — the loading seam for deployment-specific code.
 *
 * A recipe may declare an `extensions` block mapping a name to a local
 * TypeScript/JavaScript module that registers custom context strategies
 * and/or framework modules:
 *
 *   "extensions": {
 *     "zk-strategy": {
 *       "kind": "strategy",
 *       "path": "./extensions/zk-strategy/index.ts",
 *       "config": { "floodWindowMs": 250 }
 *     }
 *   }
 *
 * The entry module must export a `register` function (named or default):
 *
 *   export function register(api: ExtensionApi, config: Record<string, unknown>) {
 *     api.registerStrategy('zk', (ctx) => new ZkStrategy({ ...ctx.config }));
 *     api.registerModule((ctx) => new ZkFeederModule(config));
 *   }
 *
 * Design constraint: this loader is deliberately dumb. It resolves nothing,
 * fetches nothing, and negotiates no versions — it imports a local path and
 * calls `register`. The invariant "this path exists and is compatible with
 * the host's dependency tree" is established at install time by build
 * tooling (connectome-cook), not here. Extensions run in-process and share
 * the host's node_modules, so `extends AutobiographicalStrategy` resolves
 * against the exact @animalabs/* versions the host ships.
 *
 * `kind` declares the extension's primary purpose. It gates recipe
 * validation (a non-built-in `agent.strategy.type` is only accepted when at
 * least one `kind: "strategy"` extension is declared) and informs build
 * tooling; it does NOT restrict what `register` may call — a strategy
 * extension may also register a companion module.
 */

import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ContextStrategy, Module } from '@animalabs/agent-framework';
import type { Recipe, RecipeExtension, RecipeStrategy } from './recipe.js';

// ---------------------------------------------------------------------------
// Factory contexts
// ---------------------------------------------------------------------------

export interface StrategyFactoryContext {
  /** The recipe's `agent.strategy` block verbatim — including keys the
   *  built-in schema doesn't know about, so custom strategies can define
   *  their own knobs without upstream schema changes. */
  config: RecipeStrategy & Record<string, unknown>;
  /** Resolved agent model id (recipe/env fallback chain already applied). */
  model: string;
  /** Resolved IANA time zone for the session. */
  timeZone: string;
}

export type StrategyFactory = (ctx: StrategyFactoryContext) => ContextStrategy;

export interface ModuleFactoryContext {
  timeZone: string;
  /** Session store path (Chronicle data dir) — same value createFramework uses. */
  storePath: string;
  /** Resolved agent model id. */
  model: string;
  /** The declaring extension entry's `config` blob, verbatim. */
  config: Record<string, unknown>;
}

export type ModuleFactory = (ctx: ModuleFactoryContext) => Module;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ExtensionApi {
  /** Register a context-strategy factory under a `agent.strategy.type` name.
   *  Built-in names and duplicate registrations are rejected. */
  registerStrategy(type: string, factory: StrategyFactory): void;
  /** Register a framework-module factory. Instantiated after the built-in
   *  module list is assembled; if the instance has a `setFramework` method
   *  it is called after framework creation (same duck-typed contract the
   *  built-in modules use). */
  registerModule(factory: ModuleFactory): void;
}

export interface RegisteredModule {
  /** Name of the extension entry that registered this factory. */
  extensionName: string;
  factory: ModuleFactory;
  /** The extension entry's `config`, passed to the factory context. */
  config: Record<string, unknown>;
}

export interface ExtensionRegistry {
  strategies: Map<string, StrategyFactory>;
  modules: RegisteredModule[];
}

export const BUILTIN_STRATEGY_TYPES = ['autobiographical', 'passthrough', 'frontdesk'] as const;

export function isBuiltinStrategyType(type: string): boolean {
  return (BUILTIN_STRATEGY_TYPES as readonly string[]).includes(type);
}

/** An empty registry — used when a recipe declares no extensions. */
export function emptyExtensionRegistry(): ExtensionRegistry {
  return { strategies: new Map(), modules: [] };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Import every extension declared by the recipe and collect registrations.
 *
 * Paths must be absolute by the time this runs — `loadRecipe` resolves
 * relative extension paths against the recipe file's directory. Errors are
 * wrapped with the extension name + path so a broken deployment names the
 * component instead of surfacing a bare import stack.
 */
export async function loadExtensions(recipe: Recipe): Promise<ExtensionRegistry> {
  const registry = emptyExtensionRegistry();
  for (const [name, ext] of Object.entries(recipe.extensions ?? {})) {
    await loadOneExtension(name, ext, registry);
  }
  return registry;
}

async function loadOneExtension(
  name: string,
  ext: RecipeExtension,
  registry: ExtensionRegistry,
): Promise<void> {
  if (!isAbsolute(ext.path)) {
    throw new Error(
      `extension "${name}": path "${ext.path}" is not absolute. ` +
      `Relative paths are resolved by loadRecipe against the recipe file's directory; ` +
      `URL-loaded recipes must use absolute extension paths.`,
    );
  }

  let mod: Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(ext.path).href) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `extension "${name}": failed to import ${ext.path}: ` +
      `${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const register = (mod.register ?? mod.default) as unknown;
  if (typeof register !== 'function') {
    throw new Error(
      `extension "${name}" (${ext.path}) must export a "register" function ` +
      `(named export or default export); got ${typeof register}.`,
    );
  }

  const config = ext.config ?? {};
  const api: ExtensionApi = {
    registerStrategy(type, factory) {
      if (typeof type !== 'string' || !type) {
        throw new Error(`extension "${name}": registerStrategy requires a non-empty type name`);
      }
      if (isBuiltinStrategyType(type)) {
        throw new Error(
          `extension "${name}": strategy type "${type}" collides with a built-in strategy`,
        );
      }
      if (registry.strategies.has(type)) {
        throw new Error(
          `extension "${name}": strategy type "${type}" is already registered by another extension`,
        );
      }
      if (typeof factory !== 'function') {
        throw new Error(`extension "${name}": registerStrategy("${type}") requires a factory function`);
      }
      registry.strategies.set(type, factory);
    },
    registerModule(factory) {
      if (typeof factory !== 'function') {
        throw new Error(`extension "${name}": registerModule requires a factory function`);
      }
      registry.modules.push({ extensionName: name, factory, config });
    },
  };

  try {
    await Promise.resolve((register as (api: ExtensionApi, config: Record<string, unknown>) => unknown)(api, config));
  } catch (err) {
    throw new Error(
      `extension "${name}" (${ext.path}): register() threw: ` +
      `${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
