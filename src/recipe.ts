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
import { dirname, isAbsolute, resolve } from 'node:path';

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
  /**
   * Tool allow-list (bare tool names as the server exports them, no toolPrefix).
   * `*` is a substring wildcard (`read_*`, `*_file`, `*`).
   * If set, only matching tools are exposed to the model AND callable at dispatch.
   */
  enabledTools?: string[];
  /**
   * Tool deny-list (same syntax as enabledTools). Wins over enabledTools on overlap.
   * Denied tools are hidden from the model and rejected at dispatch — both, so a
   * model that imitates a prior call from message history can't sneak the call through.
   */
  disabledTools?: string[];
  reconnect?: boolean;
  reconnectIntervalMs?: number;
  /**
   * Channel auto-open policy. 'auto' (default) opens everything the server
   * registers; 'manual' opens nothing (agent calls channel_open as needed);
   * a string[] is an allow-list of channel ids.
   */
  channelSubscription?: 'auto' | 'manual' | string[];
  /**
   * Optional install metadata for build/deploy tooling (e.g. connectome-cook).
   * Ignored by the recipe loader at runtime — agents don't need this; only
   * tools that produce deployable artifacts (Docker images, etc.) do.
   */
  source?: RecipeMcpServerSource;
  /**
   * Auxiliary credential / config files this MCP server needs at runtime
   * (e.g. `.zuliprc` for the Zulip adapter, `~/.netrc` for HTTP-auth APIs,
   * a `gcloud.json` service-account key for Google APIs).  Build tooling
   * collects values from the operator (env vars or interactive prompts),
   * writes the file, and bind-mounts it into the container.  The recipe
   * loader itself does NOT touch these — the runtime reads the file via
   * whatever path the MCP server expects (typically declared in `env`).
   *
   * Like `source`, this is build-tooling metadata.  Ignored at runtime.
   */
  credentialFiles?: RecipeCredentialFile[];
}

/**
 * How to obtain and install an MCP server at deploy time.  Consumed by
 * build tooling like connectome-cook.  All fields optional-at-the-schema-
 * layer except `url`; tools may require more depending on the install
 * pattern they're generating.
 */
export interface RecipeMcpServerSource {
  /** Git URL to clone from. */
  url: string;
  /**
   * Git ref: branch, tag, or commit SHA.  Default: "main".
   * If the value starts with "refs/" (e.g. "refs/pull/3/head"), it's
   * treated as an explicit refspec — tools fetch it then check out
   * FETCH_HEAD.  Useful for tracking PR heads on GitHub/GitLab.
   */
  ref?: string;
  /**
   * How to install inside the cloned dir at build time.
   *   "npm"           runs `npm install && npm run build`; implies node runtime.
   *   "pip-editable"  creates a venv at `.venv/` and runs `pip install -e .`;
   *                   implies python3 runtime.
   *   { run, runtime } runs an arbitrary shell command from the cloned dir;
   *                   `runtime` tells the tool which base packages to install
   *                   in the image (node / python3 / custom = no defaults).
   * Omit entirely for sources that need no build step (e.g. the tool is
   * fetched at runtime by npx/uvx — the recipe's `command` is enough).
   */
  install?:
    | 'npm'
    | 'pip-editable'
    | { run: string; runtime: 'node' | 'python3' | 'custom' };
  /**
   * Build-arg name for an auth token if the URL is private.
   * Tools consuming `source` should mount this via BuildKit secrets
   * (so the token doesn't leak into image layers).  The same env var
   * name is typically already needed at runtime by the operator's
   * `.env`, so this field doesn't introduce new secret surface.
   */
  authSecret?: string;
  /**
   * True if the URL's TLS cert isn't in the container's trust store
   * (e.g. self-signed internal CAs on private GitLab/Gitea).  Tools
   * should add `-c http.sslVerify=false` to the git clone of this source.
   * Prefer installing a proper CA bundle in the image over using this flag.
   */
  sslBypass?: boolean;
  /**
   * Override the in-container path of the installed source.  Default:
   * `/<basename-of-url-without-.git-suffix>` (e.g. the URL
   * `https://github.com/x/zulip_mcp.git` places the source at `/zulip_mcp`).
   */
  inContainer?: { path: string };
}

/**
 * One auxiliary credential or config file the MCP server reads at runtime.
 * Build tooling (cook, etc.) prompts the operator for the field values,
 * serializes them in the declared format, and writes the file at the
 * declared path so the bind-mounted file appears in the container.
 *
 * Example for Zulip's `.zuliprc`:
 * ```json
 * {
 *   "path": "./.zuliprc",
 *   "format": "ini",
 *   "section": "api",
 *   "mode": "0600",
 *   "fields": [
 *     { "name": "email", "envOverride": "ZULIP_EMAIL", "placeholder": "bot@example.zulipchat.com" },
 *     { "name": "key",   "envOverride": "ZULIP_KEY",   "placeholder": "abc123...", "secret": true },
 *     { "name": "site",  "envOverride": "ZULIP_SITE",  "placeholder": "https://example.zulipchat.com" }
 *   ]
 * }
 * ```
 */
export interface RecipeCredentialFile {
  /** Where the runtime expects the file.  In a Docker context this also
   *  determines the bind-mount target; the host-side path is `<outDir>` +
   *  basename(path).  Relative paths resolve against the conductor's CWD
   *  (typically `/app`); absolute paths land verbatim. */
  path: string;
  /** Serialization format.  `ini` writes `key=value` lines under an
   *  optional `[section]` header; `json` writes `{ "field": "value", ... }`;
   *  `env` writes `KEY=value` (no quoting). */
  format: 'ini' | 'json' | 'env';
  /** Optional INI section header (`[<section>]`) preceding the fields.
   *  Ignored by `json` / `env` formats. */
  section?: string;
  /** Filesystem mode as an octal string.  Default `0600` (typical for
   *  credentials).  Build tooling sets this on the host file before bind-
   *  mounting; the container inherits the mode through the mount. */
  mode?: string;
  /** Fields the operator must supply. */
  fields: RecipeCredentialFileField[];
}

export interface RecipeCredentialFileField {
  /** Field name as written in the file (e.g. `email`, `key`, `site`).
   *  For `ini` / `env` formats this is the literal key.  For `json` it
   *  becomes the JSON property name. */
  name: string;
  /** Optional env var name that, when set in `process.env` (or supplied
   *  via cook's `--env-file`), substitutes for prompting.  Lets the
   *  operator pre-set values in CI / scripted contexts. */
  envOverride?: string;
  /** Operator-facing description of what to enter (one short line). */
  description?: string;
  /** Placeholder shown next to the prompt (e.g. `bot@example.zulipchat.com`). */
  placeholder?: string;
  /** When true, build tooling masks the input (no echo while typing).
   *  Default `false`. */
  secret?: boolean;
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
  subagents?: boolean | { defaultModel?: string; defaultMaxTokens?: number };
  lessons?: boolean;
  retrieval?: boolean | { model?: string; maxInjected?: number };
  wake?: boolean | import('@animalabs/agent-framework').GateConfig;
  workspace?: boolean | { mounts: RecipeWorkspaceMount[]; configMount?: boolean };
  /**
   * Surface agent composition activity (typing indicators) to one or more
   * MCPL channels while inference is active. Opt-in per recipe; channel IDs
   * use the MCPL format (e.g. `zulip:tracker-miner-f`). The agent can also
   * adjust the set at runtime via the `activity:show_in` / `activity:hide_in`
   * tools.
   */
  activity?: boolean | { channels?: string[] };
  /**
   * Cross-process child fleet.  When true (shorthand), FleetModule is attached
   * with no pre-configured children.  When an object, declares children the
   * conductor supervises (auto-started by default on framework start) and
   * optionally an allowlist of recipe paths the conductor may spawn at will.
   * Recipes outside the allowlist require user approval.
   *
   * Recipe path resolution: relative paths in `children[].recipe` are resolved
   * at load time against the directory of the parent recipe file (or URL
   * base), NOT the process CWD. This lets a recipe bundle live anywhere on
   * disk and reference its siblings portably. Absolute paths and http(s)
   * URLs pass through unchanged.
   *
   * Note: this differs from runtime paths (workspace mounts, `dataDir`),
   * which stay CWD-relative because they describe where the running process
   * puts its state.
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
  /**
   * Recipe path or http(s) URL.  Relative paths are resolved at `loadRecipe`
   * time against the directory of the parent recipe file (or URL base), so
   * a sibling recipe is referenced by its filename regardless of where the
   * parent is launched from.  Absolute paths and URLs pass through
   * unchanged.
   */
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
 * Patterns:
 *   - `${FOO}` — required.  Throws if FOO is unset (empty string OK).
 *   - `${FOO:-default}` — optional.  Uses FOO when set and non-empty,
 *     otherwise the literal default text.  Default may be empty
 *     (`${FOO:-}`) to mean "use FOO or just empty string, never throw".
 *   - VAR name: `[A-Za-z_][A-Za-z0-9_]*`.
 *   - Default text: any chars except `}`.  No nested `${...}` parsing
 *     and no escape syntax — keep recipes JSON-friendly.
 *   - Multiple occurrences in a single string are all substituted.
 *   - Non-string values (numbers, booleans, nulls) pass through unchanged.
 *   - Arrays and objects are walked recursively.
 *
 * No escape syntax yet — a literal `${...}` in recipe JSON is not a supported
 * case.  If that becomes needed, add `$$` → `$` unwrapping as a pre-pass.
 */
export function substituteEnvVars(value: unknown, source: string): unknown {
  if (typeof value === 'string') {
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (_match, name: string, defaultValue: string | undefined) => {
        const v = process.env[name];
        if (defaultValue !== undefined) {
          // ${VAR:-default} — use VAR if set + non-empty, else default.
          return v !== undefined && v !== '' ? v : defaultValue;
        }
        // ${VAR} — required; empty string is allowed if explicitly set.
        if (v === undefined) {
          throw new Error(
            `Recipe "${source}" references environment variable \${${name}} which is not set. ` +
            `Add it to your .env file, supply a default with \${${name}:-...}, ` +
            `or delete the section of the recipe that uses it ` +
            `(e.g. remove the mcpServers entry for a source you don't have).`,
          );
        }
        return v;
      },
    );
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
 * Base for resolving recipe-relative paths (currently: `children[].recipe`).
 * `file` sources use the recipe file's directory; `url` sources use the URL
 * base so a child like `"child.json"` on an `https://example.com/parent.json`
 * load resolves to `https://example.com/child.json`.
 */
type RecipeSourceBase = { kind: 'file'; dir: string } | { kind: 'url'; base: string };

/**
 * Load a recipe from a URL or local file path.
 * If the systemPrompt value is an HTTP(S) URL, fetches the text.
 * Recipe string values containing `${VAR}` patterns are substituted against
 * `process.env` before validation — see substituteEnvVars().
 * Relative `modules.fleet.children[].recipe` paths are resolved against the
 * parent recipe's directory (or URL base) so sibling recipes are portable.
 */
export async function loadRecipe(source: string): Promise<Recipe> {
  let raw: unknown;
  let sourceBase: RecipeSourceBase;

  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Failed to fetch recipe from ${source}: ${res.status} ${res.statusText}`);
    raw = await res.json();
    sourceBase = { kind: 'url', base: source };
  } else {
    const path = resolve(source);
    if (!existsSync(path)) throw new Error(`Recipe file not found: ${path}`);
    raw = JSON.parse(readFileSync(path, 'utf-8'));
    sourceBase = { kind: 'file', dir: dirname(path) };
  }

  raw = substituteEnvVars(raw, source);
  const recipe = validateRecipe(raw);
  resolveChildRecipePaths(recipe, sourceBase);
  return resolveSystemPrompt(recipe);
}

/**
 * Resolve a single `children[].recipe` value against the parent recipe's
 * source base.  Returns unchanged if absolute or http(s) URL.
 */
export function resolveRecipeRelative(child: string, base: RecipeSourceBase): string {
  if (child.startsWith('http://') || child.startsWith('https://')) return child;
  if (isAbsolute(child)) return child;
  if (base.kind === 'file') return resolve(base.dir, child);
  // URL base: resolve the child against the parent URL.
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
      if (server.source !== undefined) {
        if (typeof server.source !== 'object' || server.source === null) {
          throw new Error(`mcpServers.${id}.source must be an object`);
        }
        const src = server.source as Record<string, unknown>;
        if (typeof src.url !== 'string' || !src.url) {
          throw new Error(`mcpServers.${id}.source.url must be a non-empty string`);
        }
        if (src.ref !== undefined && typeof src.ref !== 'string') {
          throw new Error(`mcpServers.${id}.source.ref must be a string`);
        }
        if (src.install !== undefined) {
          const install = src.install;
          const isShorthand = install === 'npm' || install === 'pip-editable';
          const isCustom =
            typeof install === 'object' && install !== null
            && typeof (install as Record<string, unknown>).run === 'string'
            && ['node', 'python3', 'custom'].includes(
              (install as Record<string, unknown>).runtime as string,
            );
          if (!isShorthand && !isCustom) {
            throw new Error(
              `mcpServers.${id}.source.install must be 'npm', 'pip-editable', ` +
              `or { run: string, runtime: 'node' | 'python3' | 'custom' }`,
            );
          }
        }
        if (src.authSecret !== undefined && typeof src.authSecret !== 'string') {
          throw new Error(`mcpServers.${id}.source.authSecret must be a string`);
        }
        if (src.sslBypass !== undefined && typeof src.sslBypass !== 'boolean') {
          throw new Error(`mcpServers.${id}.source.sslBypass must be a boolean`);
        }
        if (src.inContainer !== undefined) {
          if (typeof src.inContainer !== 'object' || src.inContainer === null) {
            throw new Error(`mcpServers.${id}.source.inContainer must be an object`);
          }
          if (typeof (src.inContainer as Record<string, unknown>).path !== 'string') {
            throw new Error(`mcpServers.${id}.source.inContainer.path must be a string`);
          }
        }
      }
      for (const field of ['enabledTools', 'disabledTools'] as const) {
        if (server[field] === undefined) continue;
        if (!Array.isArray(server[field]) || !(server[field] as unknown[]).every((p) => typeof p === 'string' && p)) {
          throw new Error(`mcpServers.${id}.${field} must be an array of non-empty strings`);
        }
      }
      if (server.credentialFiles !== undefined) {
        if (!Array.isArray(server.credentialFiles)) {
          throw new Error(`mcpServers.${id}.credentialFiles must be an array`);
        }
        const seenPaths = new Set<string>();
        for (let i = 0; i < server.credentialFiles.length; i++) {
          const cf = server.credentialFiles[i] as Record<string, unknown>;
          if (!cf || typeof cf !== 'object') {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}] must be an object`);
          }
          if (typeof cf.path !== 'string' || !cf.path) {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}].path must be a non-empty string`);
          }
          if (seenPaths.has(cf.path)) {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}].path "${cf.path}" is duplicated within the same server`);
          }
          seenPaths.add(cf.path);
          if (cf.format !== 'ini' && cf.format !== 'json' && cf.format !== 'env') {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}].format must be 'ini', 'json', or 'env'`);
          }
          if (cf.section !== undefined && typeof cf.section !== 'string') {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}].section must be a string`);
          }
          if (cf.mode !== undefined && (typeof cf.mode !== 'string' || !/^0?[0-7]{3,4}$/.test(cf.mode))) {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}].mode must be an octal string like "0600"`);
          }
          if (!Array.isArray(cf.fields) || cf.fields.length === 0) {
            throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields must be a non-empty array`);
          }
          const seenFieldNames = new Set<string>();
          for (let j = 0; j < cf.fields.length; j++) {
            const f = cf.fields[j] as Record<string, unknown>;
            if (!f || typeof f !== 'object') {
              throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields[${j}] must be an object`);
            }
            if (typeof f.name !== 'string' || !f.name) {
              throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields[${j}].name must be a non-empty string`);
            }
            if (seenFieldNames.has(f.name)) {
              throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields[${j}].name "${f.name}" is duplicated`);
            }
            seenFieldNames.add(f.name);
            if (f.envOverride !== undefined && (typeof f.envOverride !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.envOverride))) {
              throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields[${j}].envOverride must be a valid env var name`);
            }
            for (const optStr of ['description', 'placeholder'] as const) {
              if (f[optStr] !== undefined && typeof f[optStr] !== 'string') {
                throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields[${j}].${optStr} must be a string`);
              }
            }
            if (f.secret !== undefined && typeof f.secret !== 'boolean') {
              throw new Error(`mcpServers.${id}.credentialFiles[${i}].fields[${j}].secret must be a boolean`);
            }
          }
        }
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
