/**
 * connectome-host — General-purpose agent TUI host with recipe-based configuration.
 *
 * Usage:
 *   bun src/index.ts                           # Start with saved/default recipe
 *   bun src/index.ts <recipe-url-or-path>      # Load recipe from URL or file
 *   bun src/index.ts --no-recipe               # Start fresh with default recipe
 *   bun src/index.ts --no-tui                  # Readline mode (works in pipes/CI)
 *   bun src/index.ts --headless                # Daemon mode: JSONL over Unix socket at $DATA_DIR/ipc.sock
 *   bun src/index.ts --headless --exit-when-idle   # One-shot: exit when agents go idle after first inference
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY   - Required
 *   MODEL               - Override model (default: from recipe or claude-opus-4-6)
 *   DATA_DIR            - Data directory for sessions (default: ./data)
 */

import { Membrane, AnthropicAdapter, NativeFormatter } from '@animalabs/membrane';
import { AgentFramework, AutobiographicalStrategy, PassthroughStrategy, WorkspaceModule, type Module, type MountConfig } from '@animalabs/agent-framework';
import { resolve, join, basename } from 'node:path';
import { appendFile, mkdir, stat, rename } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { FrontdeskStrategy } from './strategies/frontdesk-strategy.js';
import { SubagentModule } from './modules/subagent-module.js';
import { LessonsModule } from './modules/lessons-module.js';
import { RetrievalModule } from './modules/retrieval-module.js';
import type { RecipeWorkspaceMount, RecipeStrategy } from './recipe.js';
import { TuiModule } from './modules/tui-module.js';
import { TimeModule } from './modules/time-module.js';
import { FleetModule, type FleetModuleConfig } from './modules/fleet-module.js';
import { ActivityModule } from './modules/activity-module.js';
import { WebUiModule } from './modules/web-ui-module.js';
import { loadMcplServers, DEFAULT_CONFIG_PATH } from './mcpl-config.js';
import { SessionManager } from './session-manager.js';
import { resolveAgentName } from './agent-name.js';
import { generateSessionName } from './synesthete.js';
import {
  type Recipe,
  DEFAULT_RECIPE,
  loadRecipe,
  saveRecipe,
  loadSavedRecipe,
  clearSavedRecipe,
  parseRecipeArg,
} from './recipe.js';
import { createBranchState, resetBranchState, handleExport, type BranchState } from './commands.js';

export type { AppContext };

const headless = process.argv.includes('--headless');
const noTui = !headless && (process.argv.includes('--no-tui') || !process.stdin.isTTY);

const config = {
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.MODEL,
  dataDir: process.env.DATA_DIR || './data',
};

if (!config.apiKey) {
  console.error('Missing ANTHROPIC_API_KEY. Set it in .env or environment.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// AppContext — mutable container for session switching
// ---------------------------------------------------------------------------

interface AppContext {
  framework: AgentFramework;
  membrane: Membrane;
  sessionManager: SessionManager;
  recipe: Recipe;
  /**
   * Resolved at startup from recipe + active session's import sidecar +
   * default. Used downstream by createFramework, setupSynesthete, etc. so
   * the priority chain isn't recomputed (and potentially drifted) at each
   * call site. Stays stable across `switchSession` — see note in main().
   */
  agentName: string;
  branchState: BranchState;
  userMessageCount: number;

  /** Stop current framework, switch to a different session, start new framework. */
  switchSession(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Recipe resolution
// ---------------------------------------------------------------------------

async function resolveRecipe(): Promise<Recipe> {
  const { source, noRecipe } = parseRecipeArg(process.argv);

  if (noRecipe) {
    clearSavedRecipe(config.dataDir);
    console.log('Starting with default recipe.');
    return DEFAULT_RECIPE;
  }

  if (source) {
    try {
      const recipe = await loadRecipe(source);
      saveRecipe(config.dataDir, recipe);
      console.log(`Loaded recipe: ${recipe.name}${recipe.description ? ` — ${recipe.description}` : ''}`);
      return recipe;
    } catch (err) {
      console.error(`Failed to load recipe from ${source}:`, err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }

  // Try saved recipe
  const saved = loadSavedRecipe(config.dataDir);
  if (saved) {
    console.log(`Resuming recipe: ${saved.name}`);
    return saved;
  }

  return DEFAULT_RECIPE;
}

// ---------------------------------------------------------------------------
// Framework factory
// ---------------------------------------------------------------------------

async function createFramework(
  membrane: Membrane,
  storePath: string,
  recipe: Recipe,
  agentName: string,
): Promise<AgentFramework> {
  const model = config.model || recipe.agent.model || 'claude-opus-4-6';
  const modules = recipe.modules ?? {};

  // -- Build module list --
  const moduleInstances: Module[] = [new TuiModule(), new TimeModule()];

  // Subagents
  let subagentModule: SubagentModule | null = null;
  if (modules.subagents !== false) {
    const subagentConfig = typeof modules.subagents === 'object' ? modules.subagents : {};
    subagentModule = new SubagentModule({
      parentAgentName: agentName,
      defaultModel: subagentConfig.defaultModel || model,
      defaultMaxTokens: subagentConfig.defaultMaxTokens,
    });
    moduleInstances.push(subagentModule);
  }

  // Lessons
  let lessonsModule: LessonsModule | null = null;
  if (modules.lessons !== false) {
    const globalLessonsPath = resolve(join(storePath, '..', '..', 'lessons.json'));
    lessonsModule = new LessonsModule({ globalPath: globalLessonsPath });
    moduleInstances.push(lessonsModule);
  }

  // Fleet (cross-process child orchestration). Opt-in via recipe.
  if (modules.fleet === true) {
    moduleInstances.push(new FleetModule());
  } else if (modules.fleet && typeof modules.fleet === 'object') {
    const fleetCfg = modules.fleet;
    const fleetModuleConfig: FleetModuleConfig = {};
    if (fleetCfg.children) {
      fleetModuleConfig.autoStart = fleetCfg.children.map((c) => {
        const entry: NonNullable<FleetModuleConfig['autoStart']>[number] = {
          name: c.name,
          recipe: c.recipe,
          autoStart: c.autoStart !== false,  // default true
        };
        if (c.dataDir !== undefined) entry.dataDir = c.dataDir;
        if (c.env !== undefined) entry.env = c.env;
        if (c.subscription !== undefined) entry.subscription = c.subscription;
        if (c.autoRestart !== undefined) entry.autoRestart = c.autoRestart;
        return entry;
      });
    }
    if (fleetCfg.allowedRecipes !== undefined) fleetModuleConfig.allowedRecipes = fleetCfg.allowedRecipes;
    if (fleetCfg.defaultSubscription !== undefined) fleetModuleConfig.defaultSubscription = fleetCfg.defaultSubscription;
    if (fleetCfg.socketWaitTimeoutMs !== undefined) fleetModuleConfig.socketWaitTimeoutMs = fleetCfg.socketWaitTimeoutMs;
    if (fleetCfg.readyTimeoutMs !== undefined) fleetModuleConfig.readyTimeoutMs = fleetCfg.readyTimeoutMs;
    if (fleetCfg.gracefulShutdownMs !== undefined) fleetModuleConfig.gracefulShutdownMs = fleetCfg.gracefulShutdownMs;
    if (fleetCfg.sigtermEscalationMs !== undefined) fleetModuleConfig.sigtermEscalationMs = fleetCfg.sigtermEscalationMs;
    moduleInstances.push(new FleetModule(fleetModuleConfig));
  }

  // Retrieval (requires lessons)
  if (modules.retrieval !== false && lessonsModule) {
    const retrievalConfig = typeof modules.retrieval === 'object' ? modules.retrieval : {};
    moduleInstances.push(new RetrievalModule({
      membrane,
      retrievalModel: retrievalConfig.model,
      maxInjectedLessons: retrievalConfig.maxInjected,
    }));
  }

  // Gate config — core AF EventGate feature.
  // Path is per-session: {storePath}/config/gate.json
  let gateOptions: import('@animalabs/agent-framework').GateOptions | undefined;
  if (modules.wake !== false) {
    gateOptions = { configPath: join(storePath, 'config', 'gate.json') };
    if (typeof modules.wake === 'object' && 'policies' in modules.wake) {
      gateOptions.config = modules.wake as import('@animalabs/agent-framework').GateConfig;
    }
    // Privileged-users file for the `sleep` tool — users who may wake the agent
    // through a sleep window. Stable across sessions (install-dir relative);
    // override with SLEEP_PRIVILEGED_FILE. Edit the file to change the list.
    gateOptions.privilegedUsersPath =
      process.env.SLEEP_PRIVILEGED_FILE || resolve('./sleep-privileged.json');
  }

  // Workspace (replaces FilesModule + LocalFilesModule)
  // Note: workspace: false disables ALL filesystem access (both read and write).
  // Previously LocalFilesModule was always-on; this is an intentional change —
  // recipes that need read-only access should keep workspace enabled (the default).
  let workspaceModule: WorkspaceModule | null = null;
  if (modules.workspace !== false) {
    let mounts: MountConfig[];
    if (typeof modules.workspace === 'object' && modules.workspace.mounts) {
      // Only pass fields the recipe explicitly provides; let WorkspaceModule default the rest.
      // We override watch to 'never' since FKM doesn't need chokidar filesystem watchers.
      mounts = modules.workspace.mounts.map((m: RecipeWorkspaceMount) => {
        const mount: MountConfig = {
          name: m.name,
          path: resolve(m.path),
          mode: m.mode ?? 'read-write',
          watch: m.watch ?? 'never', // FKM: no chokidar watchers by default
        };
        if (m.ignore) mount.ignore = m.ignore;
        if (m.wakeOnChange !== undefined) mount.wakeOnChange = m.wakeOnChange;
        if (m.autoMaterialize !== undefined) mount.autoMaterialize = m.autoMaterialize;
        return mount;
      });
    } else {
      // Default: read-only input mount + read-write products mount
      mounts = [
        { name: 'input', path: resolve('./input'), mode: 'read-only', watch: 'never' },
        { name: 'products', path: resolve('./output'), mode: 'read-write', watch: 'never' },
      ];
    }

    // Config mount: version-controls gate.json (and future config files) via Chronicle.
    // Opt-in via recipe: workspace.configMount = true
    const wantConfigMount = typeof modules.workspace === 'object' && modules.workspace.configMount;
    if (wantConfigMount) {
      mounts.push({
        name: '_config',
        path: resolve(join(storePath, 'config')),
        mode: 'read-write',
        watch: 'always',
      });
    }

    workspaceModule = new WorkspaceModule({ mounts });
    moduleInstances.push(workspaceModule);
  }

  // Activity (typing indicators) — opt-in per recipe
  let activityModule: ActivityModule | null = null;
  if (modules.activity !== undefined && modules.activity !== false) {
    const activityConfig = typeof modules.activity === 'object' ? modules.activity : {};
    activityModule = new ActivityModule({ initialChannels: activityConfig.channels });
    moduleInstances.push(activityModule);
  }

  // Web admin UI — opt-in per recipe
  let webUiModule: WebUiModule | null = null;
  if (modules.webui !== undefined && modules.webui !== false) {
    const webuiConfig = typeof modules.webui === 'object' ? modules.webui : {};
    webUiModule = new WebUiModule({
      port: webuiConfig.port,
      host: webuiConfig.host,
      basicAuth: webuiConfig.basicAuth,
      acknowledgeNoAuth: webuiConfig.acknowledgeNoAuth,
      allowedOrigins: webuiConfig.allowedOrigins,
    });
    moduleInstances.push(webUiModule);
  }

  // -- Build MCP server list --
  //
  // Recipes are opt-in: a file entry from mcpl-servers.json is loaded only
  // when the recipe references its id under `mcpServers`. Credentials and
  // the spawn command come from the file; the recipe entry can override
  // policy fields (channelSubscription, toolPrefix, feature-set toggles,
  // reconnect). Recipes can also define new servers the file doesn't have
  // by supplying `command` or `url` themselves.
  //
  // The previous behavior loaded every file server for every recipe, which
  // silently flooded focused recipes (conductor, reviewer) with traffic
  // from channels the agent never asked to listen to.
  const recipeServers = recipe.mcpServers ?? {};
  const fileServers = loadMcplServers(DEFAULT_CONFIG_PATH);
  const fileServersById = new Map(fileServers.map(s => [s.id, s]));

  const allServers: Array<{ id: string; command: string; [k: string]: unknown }> = [];
  for (const [id, recipeEntry] of Object.entries(recipeServers)) {
    const fileEntry = fileServersById.get(id);
    if (fileEntry) {
      const merged: Record<string, unknown> = { ...fileEntry };
      if (recipeEntry.channelSubscription !== undefined) merged.channelSubscription = recipeEntry.channelSubscription;
      if (recipeEntry.toolPrefix !== undefined) merged.toolPrefix = recipeEntry.toolPrefix;
      if (recipeEntry.enabledFeatureSets !== undefined) merged.enabledFeatureSets = recipeEntry.enabledFeatureSets;
      if (recipeEntry.disabledFeatureSets !== undefined) merged.disabledFeatureSets = recipeEntry.disabledFeatureSets;
      if (recipeEntry.enabledTools !== undefined) merged.enabledTools = recipeEntry.enabledTools;
      if (recipeEntry.disabledTools !== undefined) merged.disabledTools = recipeEntry.disabledTools;
      if (recipeEntry.reconnect !== undefined) merged.reconnect = recipeEntry.reconnect;
      if (recipeEntry.reconnectIntervalMs !== undefined) merged.reconnectIntervalMs = recipeEntry.reconnectIntervalMs;
      allServers.push(merged as { id: string; command: string; [k: string]: unknown });
    } else if (recipeEntry.command || recipeEntry.url) {
      allServers.push({ id, ...recipeEntry, command: recipeEntry.command! } as { id: string; command: string; [k: string]: unknown });
    }
  }

  // No server augmentation needed — gate is wired via FrameworkConfig.gate

  // -- Build strategy --
  //
  // Build the options object with typed property access — no
  // `Record<string, unknown>` cast on `strategyConfig`. Every field we
  // forward is declared on `RecipeStrategy` (see recipe.ts); a typo in a
  // recipe (e.g. `l1BudgetTokes`) now fails at recipe validation rather
  // than silently being a no-op at strategy construction. AutobiographicalStrategy
  // and FrontdeskStrategy share this option bag today; if strategy-specific
  // fields are ever added, this should split into per-strategy types.
  const strategyConfig = recipe.agent.strategy;
  const strategyType = strategyConfig?.type ?? 'autobiographical';
  const autobiographicalOpts: Record<string, unknown> = {
    headWindowTokens: strategyConfig?.headWindowTokens ?? 4000,
    recentWindowTokens: strategyConfig?.recentWindowTokens ?? 30000,
    compressionModel: strategyConfig?.compressionModel ?? model,
    autoTickOnNewMessage: true,
    maxMessageTokens: strategyConfig?.maxMessageTokens ?? 10000,
  };
  // Forward optional tuning fields when set. The key list is typed
  // against `RecipeStrategy`, so an unknown field name is a compile
  // error here rather than a silent no-op at runtime.
  const passthroughKeys: ReadonlyArray<keyof RecipeStrategy> = [
    'enforceBudget',
    'maxSpeculativeL1s',
    'positionedRecallPairs',
    'recallHeaderTemplate',
    'targetChunkTokens',
    'mergeThreshold',
    'summaryTargetTokens',
    'l1BudgetTokens',
    'l2BudgetTokens',
    'l3BudgetTokens',
    'toolResultMaxLastN',
    'toolUseInputMaxTokens',
  ];
  for (const key of passthroughKeys) {
    const v = strategyConfig?.[key];
    if (v !== undefined) autobiographicalOpts[key] = v;
  }
  const strategy = strategyType === 'passthrough'
    ? new PassthroughStrategy()
    : strategyType === 'frontdesk'
      ? new FrontdeskStrategy(autobiographicalOpts)
      : new AutobiographicalStrategy(autobiographicalOpts);

  // -- Create framework --
  const framework = await AgentFramework.create({
    storePath,
    membrane,
    agents: [
      {
        name: agentName,
        model,
        systemPrompt: recipe.agent.systemPrompt,
        maxTokens: recipe.agent.maxTokens ?? 16384,
        strategy,
        ...(recipe.agent.thinking && { thinking: recipe.agent.thinking }),
      },
    ],
    modules: moduleInstances,
    mcplServers: allServers,
    gate: gateOptions,
  });

  // Wire post-creation hooks
  if (subagentModule) {
    subagentModule.setFramework(framework);
  }

  if (activityModule) {
    activityModule.setFramework(framework);
  }

  if (workspaceModule) {
    workspaceModule.initStore(framework.getStore());
  }

  // Stash the WebUiModule reference on the framework so main() can call
  // setApp() once the AppContext is built. Using a symbol-keyed property to
  // avoid polluting the public framework API for the sake of one module.
  if (webUiModule) {
    (framework as unknown as Record<symbol, WebUiModule>)[webUiModuleSymbol] = webUiModule;
  }

  return framework;
}

const webUiModuleSymbol = Symbol.for('connectome-host:web-ui-module');

function getWebUiModule(framework: AgentFramework): WebUiModule | null {
  const sym = (framework as unknown as Record<symbol, WebUiModule | undefined>)[webUiModuleSymbol];
  return sym ?? null;
}

// ---------------------------------------------------------------------------
// Synesthete auto-naming hook
// ---------------------------------------------------------------------------

function setupSynesthete(app: AppContext): void {
  const agentName = app.agentName;
  const namingExamples = app.recipe.sessionNaming?.examples;

  app.framework.onTrace((event) => {
    if (event.type !== 'message:added') return;
    const e = event as unknown as { source: string };
    if (e.source !== 'external-message') return;

    app.userMessageCount++;
    if (app.userMessageCount !== 3) return;

    const session = app.sessionManager.getActiveSession();
    if (!session || session.manuallyNamed) return;

    const agent = app.framework.getAgent(agentName);
    const cm = agent?.getContextManager();
    if (!cm) return;

    const { messages } = cm.queryMessages({});
    const summary = messages
      .filter(m => m.content.some((b: { type: string }) => b.type === 'text'))
      .slice(0, 6)
      .map(m => {
        const text = m.content
          .filter((b: { type: string }): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b: { text: string }) => b.text)
          .join(' ');
        return `${m.participant}: ${text.slice(0, 200)}`;
      })
      .join('\n');

    generateSessionName(app.membrane, summary, namingExamples).then(name => {
      if (name) {
        app.sessionManager.renameSession(session.id, name, false);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// MCPL subprocess stderr log — receipts for "why did that MCPL server break"
// ---------------------------------------------------------------------------

const MCPL_STDERR_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB; rolls to .1 on overflow.

function setupMcplStderrLog(app: AppContext, storePath: string): void {
  const dir = join(storePath, 'mcpl-stderr');
  // Best-effort directory creation — if it fails, per-write attempts will too,
  // and we'll swallow those quietly. We don't want logging to be load-bearing.
  void mkdir(dir, { recursive: true }).catch(() => {});

  app.framework.onTrace((event) => {
    if (event.type !== 'mcpl:server-stderr') return;
    const e = event as unknown as { serverId: string; line: string; timestamp: number };
    const iso = new Date(e.timestamp).toISOString();
    // basename guards against a misconfigured serverId like "../foo" escaping dir.
    const path = join(dir, `${basename(e.serverId)}.log`);
    const entry = `${iso} ${e.line}\n`;
    void rotateIfNeeded(path, entry.length)
      .then(() => appendFile(path, entry))
      .catch(() => {
        // If logging itself fails, don't cascade.
      });
  });
}

async function rotateIfNeeded(path: string, incomingBytes: number): Promise<void> {
  try {
    const s = await stat(path);
    if (s.size + incomingBytes > MCPL_STDERR_LOG_MAX_BYTES) {
      await rename(path, `${path}.1`);
    }
  } catch {
    // No existing file (or stat failed) — nothing to rotate.
  }
}

// ---------------------------------------------------------------------------
// Piped/headless mode (--no-tui or non-TTY stdin)
// ---------------------------------------------------------------------------

async function runPiped(app: AppContext) {
  const { createInterface } = await import('node:readline');
  const { handleCommand } = await import('./commands.js');

  let inferenceResolve: (() => void) | null = null;

  app.framework.onTrace((event) => {
    const e = event as unknown as Record<string, unknown>;
    switch (event.type) {
      case 'inference:started':
        process.stdout.write('\n');
        break;
      case 'inference:tokens': {
        const content = e.content as string;
        if (content) process.stdout.write(content);
        break;
      }
      case 'inference:completed':
        process.stdout.write('\n');
        inferenceResolve?.();
        inferenceResolve = null;
        break;
      case 'inference:failed':
        console.error(`\nError: ${e.error}`);
        inferenceResolve?.();
        inferenceResolve = null;
        break;
      case 'inference:tool_calls_yielded': {
        const calls = e.calls as Array<{ name: string }>;
        console.log(`\n[tools] ${calls.map(c => c.name).join(', ')}`);
        break;
      }
      case 'tool:started': {
        const toolInput = e.input ? JSON.stringify(e.input) : '';
        const truncated = toolInput.length > 120 ? toolInput.slice(0, 120) + '...' : toolInput;
        console.log(`[tool] ${e.tool}${truncated ? ' ' + truncated : ''}`);
        break;
      }
    }
  });

  function waitForInference(): Promise<void> {
    return new Promise(resolve => {
      inferenceResolve = resolve;
      setTimeout(() => {
        if (inferenceResolve === resolve) { inferenceResolve = null; resolve(); }
      }, 120_000);
    });
  }

  async function processLine(line: string): Promise<boolean> {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('/')) {
      const result = handleCommand(trimmed, app);
      if (result.quit) return true;
      for (const l of result.lines) console.log(l.text);
      if (result.branchChanged) {
        const ws = app.framework.getModule('workspace');
        if (ws && 'materializeMount' in ws) {
          await (ws as any).materializeMount('_config');
        }
      }
      if (result.switchToSessionId) {
        await app.switchSession(result.switchToSessionId);
        console.log('Session switched.');
      }
    } else {
      app.framework.pushEvent({
        type: 'external-message', source: 'cli',
        content: trimmed, metadata: {}, triggerInference: true,
      });
      await waitForInference();
    }
    return false;
  }

  // Piped: read all then process
  if (!process.stdin.isTTY) {
    const lines: string[] = [];
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) lines.push(line);
    console.log(`Processing ${lines.length} commands...`);
    for (const line of lines) {
      console.log(`> ${line}`);
      if (await processLine(line)) break;
    }
    console.log('Done.');
    await app.framework.stop();
    return;
  }

  // Interactive TTY readline (fallback if --no-tui is explicit on a TTY)
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  console.log('connectome-host (readline mode). Type /help for commands.');
  rl.prompt();
  rl.on('line', async (line: string) => {
    if (await processLine(line)) { rl.close(); return; }
    rl.prompt();
  });
  await new Promise<void>(r => rl.on('close', r));
  console.log('\nShutting down...');
  await app.framework.stop();
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Count non-empty lines in a file. Returns 0 if the file doesn't exist. */
function countLines(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const buf = readFileSync(path, 'utf8');
    if (buf.length === 0) return 0;
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf.charCodeAt(i) === 10) n++;
    // If the last byte isn't a newline, there's a partial trailing line that counts too.
    if (buf.charCodeAt(buf.length - 1) !== 10) n++;
    return n;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const recipe = await resolveRecipe();

  const adapter = new AnthropicAdapter({ apiKey: config.apiKey! });

  // LLM call log: appends one JSON line per request to {dataDir}/llm-calls.jsonl.
  // Useful for post-mortem debugging when the TUI/headless flashes errors past.
  // The `beforeRequest` hook receives the NormalizedRequest plus the raw
  // provider-format request (the literal body that's about to hit the API),
  // so we capture the exact shape the provider sees including model + temperature.
  //
  // Rotation: every LLM_CALL_LOG_ROTATE_AT entries (default 50), the active
  // file `llm-calls.jsonl` is renamed to `llm-calls.<ISO-timestamp>.jsonl`
  // and the next request opens a fresh one. Old files are kept (no auto-
  // prune) so post-mortem of any historical session is possible.
  //
  // Note: the log captures rawRequest bodies, which contain full message
  // content — secrets, user input, etc. Treat `llm-calls.jsonl*` like a
  // secrets-bearing file (chmod 600 if needed; exclude from tarballs).
  const llmCallLogPath = join(config.dataDir, 'llm-calls.jsonl');
  // Parse ROTATE_AT explicitly so `LLM_CALL_LOG_ROTATE_AT=0` doesn't
  // silently fall back to 50 via `||`'s falsy-zero footgun. We require a
  // positive integer; anything else (NaN, 0, negative) keeps the default.
  const rotateAtRaw = Number.parseInt(process.env.LLM_CALL_LOG_ROTATE_AT ?? '', 10);
  const ROTATE_AT = Number.isFinite(rotateAtRaw) && rotateAtRaw > 0 ? rotateAtRaw : 50;
  let llmCallCount = countLines(llmCallLogPath);
  const rotateLlmCallLog = async (): Promise<void> => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const rotated = llmCallLogPath.replace(/\.jsonl$/, `.${ts}.jsonl`);
    try {
      await rename(llmCallLogPath, rotated);
    } catch (err) {
      // ENOENT is expected on the very first rotation when the file
      // doesn't exist yet. Anything else (EPERM, EBUSY, ENOSPC, EXDEV
      // when dataDir is on tmpfs / a different device) should be visible
      // to the operator so they know the post-mortem log is fiction.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        console.warn('[llm-call-log] rotation failed:', code ?? String(err));
      }
    }
    llmCallCount = 0;
  };
  // If the existing log is already at/over threshold from a prior run,
  // rotate it on startup so the next request lands in a fresh file. This
  // is async at module level, so a brief startup race is possible: a
  // request fired in the first ~ms could append to the file that's about
  // to be renamed. Acceptable trade — alternative is awaiting at the top
  // of main(), which blocks all other module init for no real benefit.
  if (llmCallCount >= ROTATE_AT) void rotateLlmCallLog();

  // Session management — resolved before Membrane construction so the
  // active session's import-source sidecar can contribute to agent-name
  // resolution. Without that, a custom recipe that omits agent.name
  // combined with a claudeai-imported session falls back to 'agent' on
  // the live side while the importer + warmup default to 'Claude',
  // re-creating the namespace fork this branch exists to close.
  const sessionManager = new SessionManager(config.dataDir);
  sessionManager.migrateIfNeeded();

  let activeSession = sessionManager.getActiveSession();
  if (!activeSession) {
    activeSession = sessionManager.createSession();
  }

  const resolved = resolveAgentName({
    explicit: recipe.agent.name,
    sidecar: sessionManager.getImportSource(activeSession.id)?.agentName,
    default: 'agent',
  });
  if (resolved.mismatch) {
    console.warn(
      `[recipe vs sidecar] agent name disagreement: recipe says ` +
      `"${resolved.mismatch.explicit}", session ${activeSession.id}'s ` +
      `import sidecar says "${resolved.mismatch.sidecar}". Using the ` +
      `recipe value; warmup output under "${resolved.mismatch.sidecar}" ` +
      `will be orphaned at agents/${resolved.mismatch.sidecar}/...`,
    );
  }
  const agentName = resolved.name;

  const membrane = new Membrane(adapter, {
    formatter: new NativeFormatter(),
    // Anchor the assistant role for internal callers that don't set
    // request.assistantParticipant themselves (autobio compression,
    // executeMerge). Mismatch here flips stored assistant turns to
    // role: 'user' and the API rejects tool_use blocks riding along.
    assistantParticipant: agentName,
    hooks: {
      beforeRequest: (normalizedRequest, rawRequest) => {
        const entry = {
          ts: new Date().toISOString(),
          normalizedConfig: normalizedRequest.config,
          rawRequest,
        };
        // Async, fire-and-forget — the hook is allowed to be synchronous,
        // and we explicitly don't want to block the request on disk I/O.
        // Pre-fix this was appendFileSync, which would stall the event
        // loop on every inference (and on every rotation flush). Best-
        // effort semantics: a swallowed error keeps the request going.
        appendFile(llmCallLogPath, JSON.stringify(entry) + '\n').catch(() => {
          // Logging is best-effort; never break inference because the disk is full.
        });
        llmCallCount++;
        if (llmCallCount >= ROTATE_AT) void rotateLlmCallLog();
        return rawRequest;
      },
    },
  });

  const storePath = sessionManager.getStorePath(activeSession.id);
  const framework = await createFramework(membrane, storePath, recipe, agentName);

  // Build app context
  const app: AppContext = {
    framework,
    membrane,
    sessionManager,
    recipe,
    agentName,
    branchState: createBranchState(),
    userMessageCount: 0,

    async switchSession(id: string) {
      handleExport(this);
      await this.framework.stop();
      sessionManager.setActiveSession(id);
      const newStorePath = sessionManager.getStorePath(id);
      // Note: agentName stays as resolved at startup. A per-session
      // re-resolution would matter only if recipe.agent.name is absent
      // AND the user switches between imports that used different
      // --agent values; not the canonical flow.
      this.framework = await createFramework(membrane, newStorePath, recipe, this.agentName);
      this.framework.start();
      this.userMessageCount = 0;
      resetBranchState(this.branchState);
      setupSynesthete(this);
      setupMcplStderrLog(this, newStorePath);
      getWebUiModule(this.framework)?.setApp(this);
    },
  };

  framework.start();
  setupSynesthete(app);
  setupMcplStderrLog(app, storePath);
  getWebUiModule(framework)?.setApp(app);

  if (headless) {
    const { runHeadless } = await import('./headless.js');
    await runHeadless(app, process.argv.slice(2));
  } else if (noTui) {
    await runPiped(app);
  } else {
    const { runTui } = await import('./tui.js');
    await runTui(app);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
