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

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecipeStrategy {
  type: 'autobiographical' | 'passthrough' | 'frontdesk';
  headWindowTokens?: number;
  recentWindowTokens?: number;
  compressionModel?: string;
  maxMessageTokens?: number;
}

export interface RecipeAgent {
  name?: string;
  model?: string;
  systemPrompt: string;
  maxTokens?: number;
  strategy?: RecipeStrategy;
}

export interface RecipeMcpServer {
  /** Command to spawn (stdio transport). Mutually exclusive with url. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** WebSocket URL (WebSocket transport). Mutually exclusive with command. */
  url?: string;
  transport?: 'stdio' | 'websocket';
  /** Bearer token for WebSocket auth (appended as ?token= query param). */
  token?: string;
  toolPrefix?: string;
  enabledFeatureSets?: string[];
  disabledFeatureSets?: string[];
  reconnect?: boolean;
  reconnectIntervalMs?: number;
  /**
   * Channel auto-open policy. 'auto' (default) opens everything the server
   * registers; 'manual' opens nothing (agent calls channel_open as needed);
   * a string[] is an allow-list of channel ids.
   */
  channelSubscription?: 'auto' | 'manual' | string[];
}

/**
 * Subset of MountConfig exposed to recipes.
 * Intentionally omits watchDebounceMs, followSymlinks, and maxFileSize —
 * these are implementation details best left to framework defaults.
 */
export interface RecipeWorkspaceMount {
  name: string;
  path: string;
  mode?: 'read-write' | 'read-only';
  watch?: 'always' | 'on-agent-action' | 'never';
  ignore?: string[];
  /**
   * Request inference when files in this mount change. Pair with
   * `watch: 'always'` so chokidar actually observes the mount.
   * - `true` — any of created | modified | deleted
   * - array — only the listed ops
   */
  wakeOnChange?: boolean | Array<'created' | 'modified' | 'deleted'>;
  /**
   * Persist every write/edit/delete to disk immediately. Required for mounts
   * shared across agents as a communication channel (tickets, reports, etc.)
   * so other agents' chokidar watchers actually see the change.
   */
  autoMaterialize?: boolean;
}

export interface RecipeModules {
  subagents?: boolean | { defaultModel?: string };
  lessons?: boolean;
  retrieval?: boolean | { model?: string; maxInjected?: number };
  wake?: boolean | import('@animalabs/agent-framework').GateConfig;
  workspace?: boolean | { mounts: RecipeWorkspaceMount[]; configMount?: boolean };
  /**
   * Cross-process child fleet.  When true (shorthand), FleetModule is attached
   * with no pre-configured children.  When an object, declares children the
   * conductor supervises (auto-started by default on framework start) and
   * optionally an allowlist of recipe paths the conductor may spawn at will.
   * Recipes outside the allowlist require user approval.
   *
   * Recipe path resolution: relative paths in `children[].recipe` are resolved
   * against the process CWD (same convention as workspace mounts).
   */
  fleet?: boolean | RecipeFleet;
}

export interface RecipeFleet {
  /** Children to manage. autoStart children launch when the framework starts. */
  children?: RecipeFleetChild[];
  /**
   * Allowlist for `fleet--launch`.  If omitted, the list is implicitly the
   * set of recipe paths named in `children`.  A launch call targeting a
   * recipe outside the allowlist fails with an error the agent should
   * relay to the user (who can then approve and re-issue).
   *
   * Pattern syntax (intentionally minimal to keep matcher and intent aligned):
   *   - Literal exact match: `"recipes/miner.json"`
   *   - Single `"*"`: allow everything
   *   - Trailing `"*"` only (prefix match): `"recipes/*"` matches any path
   *     under `recipes/`.  A mid-string `*` is rejected at validation time
   *     — it would look like a glob but behave only as a literal.
   */
  allowedRecipes?: string[];
  /** Default subscription sent to each child at handshake if they don't specify their own. */
  defaultSubscription?: string[];
}

export interface RecipeFleetChild {
  name: string;
  /** Recipe path (CWD-relative or absolute) or http(s) URL. */
  recipe: string;
  /** Data dir override; default `./data/<name>`. */
  dataDir?: string;
  /** Env overrides on top of parent env. */
  env?: Record<string, string>;
  /**
   * Event subscription at handshake (supports glob like `tool:*`).
   * Relevant synthetic events the parent may care about:
   *   - `lifecycle` (includes `ready` / `idle` / `exiting`) — required for fleet--await.
   *   - `inference:speech` — per-final-inference speech text, required for fleet--relay.
   *   - `inference:completed` / `inference:failed` / `tool:completed` / `tool:failed` — useful for status tracking.
   */
  subscription?: string[];
  /** Launch this child on framework start. Default: true. */
  autoStart?: boolean;
  /** Respawn on crash (Phase 5 honours this; schema accepts it now). */
  autoRestart?: boolean;
}

export interface Recipe {
  name: string;
  description?: string;
  version?: string;
  agent: RecipeAgent;
  mcpServers?: Record<string, RecipeMcpServer>;
  modules?: RecipeModules;
  sessionNaming?: { examples?: string[] };
}

// ---------------------------------------------------------------------------
// Default recipe
// ---------------------------------------------------------------------------

export const DEFAULT_RECIPE: Recipe = {
  name: 'Agent',
  description: 'General-purpose assistant with tool access',
  agent: {
    name: 'agent',
    systemPrompt: [
      'You are a helpful assistant. You have access to tools provided by connected MCP servers.',
      'Use them to help the user with their tasks.',
      '',
      'You can fork subagents for parallel work, create persistent notes, and write files to `products/` as outputs of your work.',
    ].join('\n'),
  },
  modules: {
    subagents: true,
    lessons: true,
    retrieval: true,
    wake: true,
    workspace: true,
  },
};

// ---------------------------------------------------------------------------
// Environment variable substitution
// ---------------------------------------------------------------------------

/**
 * Walk a parsed-JSON value tree and substitute `${VAR_NAME}` patterns in
 * string values with `process.env.VAR_NAME`.  Applied at recipe-load time,
 * before schema validation, so secrets can live in `.env` (gitignored) while
 * the recipe itself stays commit-safe.
 *
 * Pattern:
 *   - `${FOO}` where `FOO` is `[A-Za-z_][A-Za-z0-9_]*`.
 *   - Multiple occurrences in a single string are all substituted.
 *   - Non-string values (numbers, booleans, nulls) pass through unchanged.
 *   - Arrays and objects are walked recursively.
 *   - A missing env var throws with a message that names the variable and
 *     the recipe source, plus the advice to either set it or delete the
 *     section of the recipe that references it.
 *
 * No escape syntax yet — a literal `${...}` in recipe JSON is not a supported
 * case.  If that becomes needed, add `$$` → `$` unwrapping as a pre-pass.
 */
export function substituteEnvVars(value: unknown, source: string): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const v = process.env[name];
      if (v === undefined) {
        throw new Error(
          `Recipe "${source}" references environment variable \${${name}} which is not set. ` +
          `Add it to your .env file, or delete the section of the recipe that uses it ` +
          `(e.g. remove the mcpServers entry for a source you don't have).`,
        );
      }
      return v;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteEnvVars(v, source));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteEnvVars(v, source);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load a recipe from a URL or local file path.
 * If the systemPrompt value is an HTTP(S) URL, fetches the text.
 * Recipe string values containing `${VAR}` patterns are substituted against
 * `process.env` before validation — see substituteEnvVars().
 */
export async function loadRecipe(source: string): Promise<Recipe> {
  let raw: unknown;

  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Failed to fetch recipe from ${source}: ${res.status} ${res.statusText}`);
    raw = await res.json();
  } else {
    const path = resolve(source);
    if (!existsSync(path)) throw new Error(`Recipe file not found: ${path}`);
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  }

  raw = substituteEnvVars(raw, source);
  const recipe = validateRecipe(raw);
  return resolveSystemPrompt(recipe);
}

/**
 * If systemPrompt is an HTTP(S) URL, fetch its contents as plain text.
 * Only treated as a URL if it looks like a single URL (no spaces/newlines).
 */
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

/**
 * Validate raw JSON and fill defaults.
 */
export function validateRecipe(raw: unknown): Recipe {
  if (!raw || typeof raw !== 'object') throw new Error('Recipe must be a JSON object');
  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== 'string' || !obj.name) {
    throw new Error('Recipe must have a "name" string');
  }
  if (!obj.agent || typeof obj.agent !== 'object') {
    throw new Error('Recipe must have an "agent" object');
  }

  const agent = obj.agent as Record<string, unknown>;
  if (typeof agent.systemPrompt !== 'string' || !agent.systemPrompt) {
    throw new Error('Recipe agent must have a "systemPrompt" string');
  }

  // Validate strategy type if present
  if (agent.strategy) {
    const strategy = agent.strategy as Record<string, unknown>;
    if (
      strategy.type &&
      strategy.type !== 'autobiographical' &&
      strategy.type !== 'passthrough' &&
      strategy.type !== 'frontdesk'
    ) {
      throw new Error(
        `Invalid strategy type "${strategy.type}". Must be "autobiographical", "passthrough", or "frontdesk".`,
      );
    }
  }

  // Validate mcpServers entries if present
  if (obj.mcpServers && typeof obj.mcpServers === 'object') {
    for (const [id, entry] of Object.entries(obj.mcpServers as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`mcpServers.${id} must be an object`);
      }
      const server = entry as Record<string, unknown>;
      const hasCommand = typeof server.command === 'string' && server.command;
      const hasUrl = typeof server.url === 'string' && server.url;
      if (!hasCommand && !hasUrl) {
        throw new Error(`mcpServers.${id} must have a "command" string (stdio) or "url" string (websocket)`);
      }
      if (server.args !== undefined && !Array.isArray(server.args)) {
        throw new Error(`mcpServers.${id}.args must be an array`);
      }
    }
  }

  // Validate workspace mounts if present
  if (obj.modules && typeof obj.modules === 'object') {
    const mods = obj.modules as Record<string, unknown>;
    if (mods.workspace && typeof mods.workspace === 'object') {
      const ws = mods.workspace as Record<string, unknown>;
      if (!Array.isArray(ws.mounts) || ws.mounts.length === 0) {
        throw new Error('workspace.mounts must be a non-empty array');
      }
      for (let i = 0; i < ws.mounts.length; i++) {
        const m = ws.mounts[i] as Record<string, unknown>;
        if (!m || typeof m !== 'object') {
          throw new Error(`workspace.mounts[${i}] must be an object`);
        }
        if (typeof m.name !== 'string' || !m.name) {
          throw new Error(`workspace.mounts[${i}].name must be a non-empty string`);
        }
        if (typeof m.path !== 'string' || !m.path) {
          throw new Error(`workspace.mounts[${i}].path must be a non-empty string`);
        }
        if (m.mode !== undefined && m.mode !== 'read-write' && m.mode !== 'read-only') {
          throw new Error(`workspace.mounts[${i}].mode must be "read-write" or "read-only"`);
        }
      }
    }

    // Validate fleet if present (object form only — boolean is trivially valid).
    if (mods.fleet && typeof mods.fleet === 'object') {
      const fleet = mods.fleet as Record<string, unknown>;
      if (fleet.children !== undefined) {
        if (!Array.isArray(fleet.children)) {
          throw new Error('fleet.children must be an array');
        }
        const seenNames = new Set<string>();
        for (let i = 0; i < fleet.children.length; i++) {
          const c = fleet.children[i] as Record<string, unknown>;
          if (!c || typeof c !== 'object') {
            throw new Error(`fleet.children[${i}] must be an object`);
          }
          if (typeof c.name !== 'string' || !c.name) {
            throw new Error(`fleet.children[${i}].name must be a non-empty string`);
          }
          if (seenNames.has(c.name)) {
            throw new Error(`fleet.children[${i}].name "${c.name}" is duplicated`);
          }
          seenNames.add(c.name);
          if (typeof c.recipe !== 'string' || !c.recipe) {
            throw new Error(`fleet.children[${i}].recipe must be a non-empty string`);
          }
          if (c.subscription !== undefined && !Array.isArray(c.subscription)) {
            throw new Error(`fleet.children[${i}].subscription must be an array of strings`);
          }
          if (c.autoStart !== undefined && typeof c.autoStart !== 'boolean') {
            throw new Error(`fleet.children[${i}].autoStart must be a boolean`);
          }
        }
      }
      if (fleet.allowedRecipes !== undefined) {
        if (!Array.isArray(fleet.allowedRecipes) || !fleet.allowedRecipes.every((r) => typeof r === 'string')) {
          throw new Error('fleet.allowedRecipes must be an array of strings');
        }
        // Prefix-match-only: reject mid-string `*` so the pattern can't look
        // like a glob while silently behaving as a literal.
        for (const pattern of fleet.allowedRecipes as string[]) {
          if (pattern === '*' || !pattern.includes('*')) continue;
          if (pattern.indexOf('*') !== pattern.length - 1) {
            throw new Error(
              `fleet.allowedRecipes entry "${pattern}" has a mid-string "*". ` +
              `Only trailing "*" (prefix match) or a bare "*" (allow all) are supported.`,
            );
          }
        }
      }
      if (fleet.defaultSubscription !== undefined) {
        if (!Array.isArray(fleet.defaultSubscription) || !fleet.defaultSubscription.every((s) => typeof s === 'string')) {
          throw new Error('fleet.defaultSubscription must be an array of strings');
        }
      }
    }
  }

  return obj as unknown as Recipe;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function savedRecipePath(dataDir: string): string {
  return resolve(dataDir, '.recipe.json');
}

export function saveRecipe(dataDir: string, recipe: Recipe): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(savedRecipePath(dataDir), JSON.stringify(recipe, null, 2) + '\n', 'utf-8');
}

export function loadSavedRecipe(dataDir: string): Recipe | null {
  const path = savedRecipePath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return validateRecipe(raw);
  } catch {
    return null;
  }
}

export function clearSavedRecipe(dataDir: string): void {
  const path = savedRecipePath(dataDir);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

/**
 * Parse argv to find a recipe source. Returns null if none provided.
 * Skips known flags (--no-tui, --no-recipe).
 */
export function parseRecipeArg(argv: string[]): { source: string | null; noRecipe: boolean } {
  const noRecipe = argv.includes('--no-recipe');
  let source: string | null = null;

  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--')) continue;
    // First positional arg is the recipe source
    source = arg;
    break;
  }

  return { source, noRecipe };
}
