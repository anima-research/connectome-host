/**
 * Recipe system — config-driven agent bootstrapping.
 *
 * A recipe defines everything domain-specific about an agent session:
 * system prompt, MCP servers, which modules to enable, and naming hints.
 *
 * Recipes can be loaded from:
 *   - HTTP(S) URLs
 *   - Local file paths
 *   - Saved state from a previous run (data/.recipe.json)
 *   - Built-in default (generic assistant)
 */

import { readFileSync, lstatSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ClockConfig } from '@animalabs/agent-framework';
import { ENV_REFERENCE, readRecipeDocument, substituteEnvVars, type RecipeDocument, type RecipeSourceBase } from './recipe-document.js';
export { readRecipeDocument, substituteEnvVars, type RecipeDocument } from './recipe-document.js';
import { recipeFit, type RecipeFit } from './recipe-fit.js';
import { validateRecipe, type Recipe, type RecipeAgent, type RecipeConversations, type RecipeModules, type RecipeOrigin } from './recipe-schema.js';
import { writeJsonWhole } from './write-json-whole.js';
export {
  unknownRecipeKeys, validateRecipe, type Recipe, type RecipeAgent, type RecipeAutoContinue, type RecipeCodeExecution,
  type RecipeConversations, type RecipeCredentialFile, type RecipeCredentialFileField, type RecipeDendrite, type RecipeExtension,
  type RecipeFleet, type RecipeFleetChild, type RecipeForkReader, type RecipeHeartbeat, type RecipeHeartbeatDefaults,
  type RecipeKvUnifiedConfig, type RecipeMcpServer, type RecipeMcpServerSource, type RecipeMockConfig, type RecipeModules,
  type RecipeOrigin, type RecipePersistentReader, type RecipeReplyJudge, type RecipeSpeech, type RecipeStrategy,
  type RecipeSubconscious, type RecipeToolLifecycle, type RecipeToolLifecycleNarrowing, type RecipeTtsRelay, type RecipeTuneOut,
  type RecipeWake, type RecipeWebUi, type RecipeWorkspaceMount,
} from './recipe-schema.js';

export function deprecatedSurfaceNotices(modules: RecipeModules | undefined): string[] {
  const notices: string[] = [];
  if (typeof modules?.mcplAdmin === 'object' && modules.mcplAdmin.surface !== undefined) {
    notices.push('modules.mcplAdmin.surface is no longer read: mcpl-admin\'s tools are in agent-framework\'s built-in ' +
      '"settings" toolset, or in the tool list of an agent that may not call both toolsets--open and toolsets--act.');
  }
  if (typeof modules?.webui === 'object' && modules.webui.observersSurface !== undefined) {
    notices.push('modules.webui.observersSurface is no longer read: the observer tools are in agent-framework\'s built-in ' +
      '"settings" toolset, or in the tool list of an agent that may not call both toolsets--open and toolsets--act.');
  }
  return notices;
}

export function deprecatedConversationsNotices(conversations: RecipeConversations | undefined): string[] {
  if (!conversations) return [];
  return [
    'conversations (per-channel conversation routing) is deprecated and not recommended for new ' +
      'recipes; it will be removed in a later release (agent-framework#235). Its \'mention\' ' +
      'bind/trigger rule reads metadata.mentioned, which discord-mcpl does not set, so on Discord ' +
      'channels an @-mention neither binds a fork nor triggers a bound one. Routing still works ' +
      'as before for now.',
  ];
}

export type RecipeProvider = NonNullable<RecipeAgent['provider']>;

export function resolveProvider(recipe: Recipe): RecipeProvider {
  return recipe.agent.provider ?? 'anthropic';
}

/** The model a recipe's agent runs: `envModel`, the environment's `MODEL`,
 *  when it's set, else the recipe's own, else its provider's default. */
export function recipeModel(recipe: Recipe, envModel: string | undefined): string {
  return envModel || recipe.agent.model ||
    (recipe.agent.provider === 'openai-codex' ? 'gpt-5.4' : 'claude-opus-4-6');
}

export const DEFAULT_RECIPE: Recipe = {
  name: 'Agent',
  description: 'General-purpose assistant with tool access',
  agent: {
    name: 'agent',
    cacheTtl: '1h',
    systemPrompt: '',
  },
  modules: {
    wake: true,
    workspace: true,
  },
};

export function envText(env: Readonly<Record<string, string | number | boolean>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([name, value]) => [name, String(value)]));
}

export function namesEnvReference(text: string): boolean {
  return new RegExp(ENV_REFERENCE).test(text);
}

export interface LoadedRecipe {
  recipe: Recipe;
  persistable: Record<string, unknown>;
}

export async function loadRecipe(source: string): Promise<Recipe> {
  return (await loadRecipeDetailed(source)).recipe;
}

export async function loadRecipeDetailed(source: string, options: { fetchSystemPrompt?: boolean } = {}): Promise<LoadedRecipe> {
  return loadRecipeDocument(await readRecipeDocument(source), source, options);
}


export async function loadRecipeDocument(document: RecipeDocument, source: string,
  options: { fetchSystemPrompt?: boolean; env?: Record<string, string | undefined> } = {}): Promise<LoadedRecipe> {
  let raw = document.raw;
  const sourceBase = document.sourceBase;

  const persistable = structuredClone(raw) as Record<string, unknown>;

  raw = substituteEnvVars(raw, source, options.env);
  const recipe = validateRecipe(raw, { kind: 'authored', document: persistable });
  resolveChildRecipePaths(recipe, sourceBase);
  resolveExtensionPaths(recipe, sourceBase);
  const resolved = options.fetchSystemPrompt === false ? recipe : refuseUnfit(await resolveSystemPrompt(recipe), options.env);
  copyResolvedPathsIntoRaw(persistable, resolved);
  return { recipe: resolved, persistable };
}

function copyResolvedPathsIntoRaw(raw: Record<string, unknown>, recipe: Recipe): void {
  const fleet = recipe.modules?.fleet;
  const resolvedChildren = (typeof fleet === 'object' && fleet !== null) ? fleet.children : undefined;
  if (Array.isArray(resolvedChildren)) {
    const rawModules = raw.modules as Record<string, unknown> | undefined;
    const rawFleet = rawModules?.fleet as Record<string, unknown> | undefined;
    const rawChildren = (typeof rawFleet === 'object' && rawFleet !== null) ? rawFleet.children : undefined;
    if (Array.isArray(rawChildren)) {
      for (let i = 0; i < rawChildren.length && i < resolvedChildren.length; i++) {
        const rawChild = rawChildren[i] as Record<string, unknown> | null;
        if (rawChild && typeof rawChild === 'object' && typeof resolvedChildren[i]?.recipe === 'string') {
          rawChild.recipe = resolvedChildren[i].recipe;
        }
      }
    }
  }

  const rawExtensions = raw.extensions as Record<string, unknown> | undefined;
  for (const [name, ext] of Object.entries(recipe.extensions ?? {})) {
    const rawExt = rawExtensions?.[name] as Record<string, unknown> | undefined;
    if (rawExt && typeof rawExt === 'object') {
      rawExt.path = ext.path;
    }
  }
}

export function resolveRecipeRelative(child: string, base: RecipeSourceBase): string {
  if (child.startsWith('http://') || child.startsWith('https://')) return child;
  if (isAbsolute(child)) return child;
  if (base.kind === 'file') return resolve(base.dir, child);
  return new URL(child, base.base).href;
}

function resolveChildRecipePaths(recipe: Recipe, base: RecipeSourceBase): void {
  const fleet = recipe.modules?.fleet;
  if (!fleet || typeof fleet !== 'object') return;
  if (!fleet.children) return;
  for (const child of fleet.children) {
    child.recipe = resolveRecipeRelative(child.recipe, base);
  }
}

function resolveExtensionPaths(recipe: Recipe, base: RecipeSourceBase): void {
  for (const [name, ext] of Object.entries(recipe.extensions ?? {})) {
    if (isAbsolute(ext.path)) continue;
    if (base.kind === 'url') {
      throw new Error(
        `extensions.${name}.path "${ext.path}" is relative, but the recipe was loaded from a URL. ` +
        `Extension code is never fetched remotely — use an absolute path to a local install.`,
      );
    }
    ext.path = resolve(base.dir, ext.path);
  }
}

async function resolveSystemPrompt(recipe: Recipe): Promise<Recipe> {
  const prompt = recipe.agent.systemPrompt;
  const isUrl = (prompt.startsWith('http://') || prompt.startsWith('https://'))
    && !prompt.includes(' ') && !prompt.includes('\n');
  if (isUrl) {
    const res = await fetch(prompt);
    if (!res.ok) throw new Error(`Failed to fetch system prompt from ${prompt}: ${res.status} ${res.statusText}`);
    return {
      ...recipe,
      agent: { ...recipe.agent, systemPrompt: await res.text() },
    };
  }
  return recipe;
}

export function runningFit(recipe: Recipe, envModel: string | undefined): RecipeFit {
  const fit = recipeFit(recipe, recipeModel(recipe, envModel));
  const own = recipeModel(recipe, undefined);
  if (!envModel || envModel === own || !fit.checked || fit.fits) return fit;
  const replaced = recipe.agent.model ? 'agent.model' : `its default, ${own}`;
  return {
    ...fit,
    refusal: `${fit.refusal} ${envModel} is MODEL in the environment, which the host runs in place of ${replaced}.`,
  };
}

function refuseUnfit(recipe: Recipe, env: Record<string, string | undefined> = process.env): Recipe {
  const fit = runningFit(recipe, env.MODEL || undefined);
  if (fit.checked && !fit.fits) throw new Error(fit.refusal);
  return recipe;
}

export const DEFAULT_RECIPE_CLOCK: ClockConfig = Object.freeze({ intervalMinutes: 10 }) as ClockConfig;

export function savedRecipePath(dataDir: string): string {
  return resolve(dataDir, '.recipe.json');
}

/**
 * Marker key stamped into saved `.recipe.json` snapshots that were written
 * in unresolved form. Its presence tells loadSavedRecipe to run the full
 * substitute-and-validate pipeline on read; its absence means a legacy
 * snapshot saved fully resolved, which must be loaded verbatim.
 */
export const SAVED_RECIPE_UNRESOLVED_KEY = '$unresolved';

export function saveRecipe(dataDir: string, unresolvedRecipe: Record<string, unknown>): void {
  mkdirSync(dataDir, { recursive: true });
  const path = savedRecipePath(dataDir);
  const withMarker = { [SAVED_RECIPE_UNRESOLVED_KEY]: true, ...unresolvedRecipe };
  // Whole, and 0600 on overwrite too: the renamed file is new (#740).
  writeJsonWhole(path, withMarker, { mode: 0o600 });
}

/**
 * A Docker bind mount makes a directory at a source path that doesn't exist
 * yet, such as a recipe file the host didn't have.
 */
export class SavedRecipeDirectoryError extends Error {}

/** A directory the host can't read fails a read with EACCES, not EISDIR. */
export function savedRecipeDirectory(dataDir: string): string | null {
  const path = savedRecipePath(dataDir);
  try {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry?.isDirectory()) return "it's a directory";
    if (entry?.isSymbolicLink() && statSync(path, { throwIfNoEntry: false })?.isDirectory()) return "it's a link to a directory";
  } catch {
  }
  return null;
}

export async function loadSavedRecipe(dataDir: string, options: { fetchSystemPrompt?: boolean } = {}): Promise<Recipe | null> {
  return (await loadSavedRecipeDetailed(dataDir, options))?.recipe ?? null;
}

/** The saved recipe with the origin of its values: its author's document, or a legacy snapshot's. */
export async function loadSavedRecipeDetailed(dataDir: string, options: { fetchSystemPrompt?: boolean } = {}):
  Promise<{ recipe: Recipe; origin: RecipeOrigin } | null> {
  const path = savedRecipePath(dataDir);
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Only nothing at the path is no saved recipe: a link to nothing is one
    // that can't be read.
    if (code === 'ENOENT' && lstatSync(path, { throwIfNoEntry: false }) === undefined) return null;
    const directory = savedRecipeDirectory(dataDir);
    if (directory !== null) throw new SavedRecipeDirectoryError(directory);
    throw new Error(`it can't be read (${code ?? (err instanceof Error ? err.message : String(err))})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The parser's message can quote the file's text, and a snapshot can
    // hold a key inline, so it isn't passed on.
    throw new Error("it isn't JSON");
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const holds = raw === null ? 'null' : Array.isArray(raw) ? 'an array' : `a ${typeof raw}`;
    throw new Error(`it holds ${holds}, not a JSON object`);
  }

  if (!(SAVED_RECIPE_UNRESOLVED_KEY in raw)) {
    const origin: RecipeOrigin = { kind: 'resolved' };
    const legacy = validateRecipe(raw, origin);
    return { recipe: options.fetchSystemPrompt === false ? legacy : refuseUnfit(legacy), origin };
  }

  const { [SAVED_RECIPE_UNRESOLVED_KEY]: _marker, ...unresolved } = raw as Record<string, unknown>;
  const substituted = substituteEnvVars(unresolved, path);
  const origin: RecipeOrigin = { kind: 'authored', document: unresolved };
  const recipe = validateRecipe(substituted, origin);
  return { recipe: options.fetchSystemPrompt === false ? recipe : refuseUnfit(await resolveSystemPrompt(recipe)), origin };
}

/**
 * rmSync removes a link, one to nothing included, never its target, and
 * refuses a directory, naming the path.
 */
export function clearSavedRecipe(dataDir: string): void {
  rmSync(savedRecipePath(dataDir), { force: true });
}

/**
 * Parse argv to find a recipe source: the first argument after argv's first
 * two that doesn't start with `--`, or a `source` of null when there is none.
 * `noRecipe` says whether `--no-recipe` was given.
 */
export function parseRecipeArg(argv: string[]): { source: string | null; noRecipe: boolean } {
  const noRecipe = argv.includes('--no-recipe');
  let source: string | null = null;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--')) continue;
    source = arg;
    break;
  }

  return { source, noRecipe };
}
