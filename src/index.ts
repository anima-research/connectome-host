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

import {
  Membrane,
  NativeFormatter,
  OpenAIResponsesAPIAdapter,
  OpenAIResponsesFormatter,
} from '@animalabs/membrane';
import { LoggingAnthropicAdapter } from './logging-adapter.js';
import { CallLedger } from './call-ledger.js';
import { SettingsModule } from './modules/settings-module.js';
import { AgentFramework, AutobiographicalStrategy, PassthroughStrategy, WorkspaceModule, resolveTimeZone, type Module, type MountConfig } from '@animalabs/agent-framework';
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
import { SubscriptionGcModule } from './modules/subscription-gc-module.js';
import { ChannelModeModule } from './modules/channel-mode-module.js';
import { WebUiModule } from './modules/web-ui-module.js';
import { ObserversModule } from './modules/observers-module.js';
import { McplAdminModule } from './modules/mcpl-admin-module.js';
import { loadMcplServers, applyAgentOverlay, DEFAULT_CONFIG_PATH, DEFAULT_AGENT_OVERLAY_PATH } from './mcpl-config.js';
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
  // OAuth/Bearer token (e.g. a Claude subscription token). When set, it takes
  // precedence over the API key so requests never carry both auth schemes.
  authToken: process.env.ANTHROPIC_AUTH_TOKEN,
  openaiApiKey: process.env.OPENAI_API_KEY,
  model: process.env.MODEL,
  dataDir: process.env.DATA_DIR || './data',
};

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
  settingsModule: SettingsModule,
  callLedger: CallLedger | null,
): Promise<AgentFramework> {
  const model = config.model || recipe.agent.model || 'claude-opus-4-6';
  const modules = recipe.modules ?? {};
  const timeZone = resolveTimeZone(recipe.agent.timezone);

  // -- Build module list --
  // SettingsModule is constructed in main() (before the adapter, so the
  // adapter can read its state for cross-cutting concerns like reasoning).
  const moduleInstances: Module[] = [new TuiModule(), new TimeModule(timeZone), settingsModule];

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
    moduleInstances.push(new FleetModule({ timeZone }));
  } else if (modules.fleet && typeof modules.fleet === 'object') {
    const fleetCfg = modules.fleet;
    const fleetModuleConfig: FleetModuleConfig = {};
    fleetModuleConfig.timeZone = timeZone;
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

  // Auto-unsubscribe noisy ambient channels — ON by default (opt out with
  // `modules.subscriptionGc: false`).
  if (modules.subscriptionGc !== false) {
    const gcConfig =
      typeof modules.subscriptionGc === 'object' ? modules.subscriptionGc : {};
    moduleInstances.push(
      new SubscriptionGcModule({
        defaultLimitChars: gcConfig.defaultLimitChars,
        serverId: gcConfig.serverId,
        toolPrefix: gcConfig.toolPrefix,
      }),
    );
  }

  // Channel attention modes (`set_channel_mode`). Needs the gate to add/remove
  // the per-channel debounce policy, so only when `wake` is enabled. On by
  // default there (opt out with `modules.channelMode: false`); it only adds a
  // tool, inert until called.
  let channelModeModule: ChannelModeModule | null = null;
  if (gateOptions && modules.channelMode !== false) {
    const cmConfig =
      typeof modules.channelMode === 'object' ? modules.channelMode : {};
    channelModeModule = new ChannelModeModule({
      serverId: cmConfig.serverId,
      toolPrefix: cmConfig.toolPrefix,
      gcModuleName: cmConfig.gcModuleName,
      defaultDebounceMs: cmConfig.defaultDebounceMs,
    });
    moduleInstances.push(channelModeModule);
  }

  // MCPL self-administration — opt-in per recipe (grants the agent the
  // ability to spawn arbitrary commands via mcpl_deploy; see recipe.ts).
  let mcplAdminModule: McplAdminModule | null = null;
  if (modules.mcplAdmin === true) {
    mcplAdminModule = new McplAdminModule({ timeZone });
    moduleInstances.push(mcplAdminModule);
  }

  // Web admin UI — opt-in per recipe
  let webUiModule: WebUiModule | null = null;
  if (modules.webui !== undefined && modules.webui !== false) {
    const webuiConfig = typeof modules.webui === 'object' ? modules.webui : {};
    // Observer grants (docs/observability.md): data/observers.json by
    // default, overridable via OBSERVERS_FILE. The feature is inert until
    // the file holds at least one grant. The companion ObserversModule
    // gives the agent grant/revoke tools over the same file — interiority
    // access is the agent's to give.
    const observersPath = process.env.OBSERVERS_FILE || resolve(config.dataDir, 'observers.json');
    webUiModule = new WebUiModule({
      port: webuiConfig.port,
      host: webuiConfig.host,
      basicAuth: webuiConfig.basicAuth,
      allowedOrigins: webuiConfig.allowedOrigins,
      observersPath,
      ...(callLedger ? { callLedger } : {}),
    });
    moduleInstances.push(webUiModule);
    moduleInstances.push(new ObserversModule({ path: observersPath }));
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

  // A server entry has EITHER a `command` (stdio) or a `url` (WebSocket); the
  // framework's McplServerConfig now carries both as optional, so this local
  // type must too. Previously the url-only branch forced `command: undefined!`,
  // which then reached `spawn(undefined, …)` and crashed a network-MCPL recipe.
  const allServers: Array<{ id: string; command?: string; url?: string; [k: string]: unknown }> = [];
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
      if (recipeEntry.reconnectMaxIntervalMs !== undefined) merged.reconnectMaxIntervalMs = recipeEntry.reconnectMaxIntervalMs;
      // Let a recipe override/adopt WebSocket transport for a file-defined server.
      if (recipeEntry.url !== undefined) merged.url = recipeEntry.url;
      if (recipeEntry.transport !== undefined) merged.transport = recipeEntry.transport;
      if (recipeEntry.token !== undefined) merged.token = recipeEntry.token;
      allServers.push(merged as { id: string; command?: string; url?: string; [k: string]: unknown });
    } else if (recipeEntry.command || recipeEntry.url) {
      // Recipe-defined server (not in the file config). Spread ALL recipe fields
      // (command OR url/transport/token, plus policy) verbatim — no fake command.
      allServers.push({ id, ...recipeEntry } as { id: string; command?: string; url?: string; [k: string]: unknown });
    }
  }

  // Apply the agent overlay (mcpl-servers.agent.json): servers the agent
  // deployed for itself load unconditionally (no recipe opt-in), and
  // tombstones suppress recipe/file servers the agent unloaded.
  const finalServers = applyAgentOverlay(allServers, DEFAULT_AGENT_OVERLAY_PATH).map((server) => ({
    ...server,
    // Stdio MCPL children inherit a single agent-facing wall clock. Protocol
    // timestamps remain UTC; only their rendered text uses this setting.
    env: { ...(server.env ?? {}), AGENT_TIMEZONE: timeZone },
  }));

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
    ...(strategyType === 'frontdesk' ? { timeZone } : {}),
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
    'adaptiveResolution',
    'kvStableReachTokens',
    'kvStableQualityGapRatio',
    'compressionSlackRatio',
    'overBudgetGraceRatio',
    'foldingStrategy',
    'speculativeProduction',
    'l1HoldbackChunks',
    'summaryParticipant',
    'summarySystemPrompt',
    'summaryUserPrompt',
    'summaryContextLabel',
  ];
  for (const key of passthroughKeys) {
    const v = strategyConfig?.[key];
    if (v !== undefined) autobiographicalOpts[key] = v;
  }
  // Adaptive resolution (document-based gradual compression) is the intended
  // default for autobiographical agents. Frontdesk keeps the hierarchical
  // renderer (its salience-biased L1 selection); it can still opt in via the
  // recipe. A recipe may set `adaptiveResolution: false` to opt back out.
  if (strategyType === 'autobiographical' && autobiographicalOpts.adaptiveResolution === undefined) {
    autobiographicalOpts.adaptiveResolution = true;
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
        maxStreamTokens: recipe.agent.maxStreamTokens ?? 150000,
        contextBudgetTokens: recipe.agent.contextBudgetTokens,
        ...(recipe.agent.cacheTtl && { cacheTtl: recipe.agent.cacheTtl }),
        ...(recipe.agent.provider === 'openai-responses' && {
          providerParams: {
            reasoning: {
              effort: recipe.agent.responses?.reasoningEffort ?? 'high',
              context: recipe.agent.responses?.reasoningContext ?? 'all_turns',
            },
            ...(recipe.agent.responses?.serviceTier ? {
              service_tier: recipe.agent.responses.serviceTier,
            } : {}),
            ...(recipe.agent.responses?.compactThreshold ? {
              context_management: [{
                type: 'compaction',
                compact_threshold: recipe.agent.responses.compactThreshold,
              }],
            } : {}),
          },
        }),
        strategy,
        ...(recipe.agent.thinking && { thinking: recipe.agent.thinking }),
        ...(recipe.agent.refusalHandling && { refusalHandling: recipe.agent.refusalHandling }),
      },
    ],
    modules: moduleInstances,
    mcplServers: finalServers,
    gate: gateOptions,
    timeZone,
  });

  // Wire post-creation hooks
  // Compression-quarantine klaxon → the framework's ops-alert channel
  // (failures.log + ops:alert trace + CONNECTOME_OPS_WEBHOOK). The strategy
  // re-fires this every alarm interval for as long as ANY chunk is
  // quarantined: quarantined spans stay raw, the fold floor creeps, and the
  // picker eventually cannot fit the window — a guaranteed future outage
  // that must never be a silent state.
  // Duck-typed on both sides so version skew in either dep degrades to a
  // no-op (the strategy's own stderr klaxon still fires) instead of a crash.
  {
    const alarmCapable = strategy as unknown as {
      setQuarantineAlarmHandler?: (fn: (status: { count: number; keys: string[] }) => void) => void;
    };
    const notify = (framework as unknown as {
      notifyOps?: (kind: string, agent: string, message: string, data?: Record<string, unknown>) => void;
    }).notifyOps?.bind(framework);
    if (alarmCapable.setQuarantineAlarmHandler && notify) {
      alarmCapable.setQuarantineAlarmHandler((status) => {
        notify(
          'compression-quarantine',
          agentName,
          `${status.count} chunk(s) in compression quarantine — spans stay raw and WILL eventually exhaust the context budget. Operator action required (inspect refusing content; branch, pin, or clear).`,
          { count: status.count, keys: status.keys },
        );
      });
    }
  }

  if (subagentModule) {
    subagentModule.setFramework(framework);
  }

  if (activityModule) {
    activityModule.setFramework(framework);
  }

  if (channelModeModule) {
    channelModeModule.setFramework(framework);
  }

  if (mcplAdminModule) {
    mcplAdminModule.setFramework(framework);
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

/** Render an mcpl:server-* connection-lifecycle trace as a log line, or null
 *  for trace types this sink doesn't record. Lifecycle lines are prefixed
 *  `[host]` to stand apart from the server's own stderr output. */
function formatMcplLifecycleLine(event: { type: string } & Record<string, unknown>): string | null {
  switch (event.type) {
    case 'mcpl:server-stderr':
      return String(event.line);
    case 'mcpl:server-connect-failed':
      return `[host] connect failed (attempt ${event.attempt}, ${event.willRetry ? 'will retry' : 'NO RETRY — server unavailable until restart'}): ${event.error}`;
    case 'mcpl:server-reconnected':
      return `[host] reconnected after ${event.attempts} attempt(s)`;
    case 'mcpl:server-closed':
      return `[host] connection closed (code=${event.code}, signal=${event.signal}${event.willReconnect ? ', reconnect scheduled' : ''})`;
    case 'mcpl:server-error':
      return `[host] connection error: ${event.error}`;
    default:
      return null;
  }
}

function setupMcplStderrLog(app: AppContext, storePath: string): void {
  const dir = join(storePath, 'mcpl-stderr');
  // Best-effort directory creation — if it fails, per-write attempts will too,
  // and we'll swallow those quietly. We don't want logging to be load-bearing.
  void mkdir(dir, { recursive: true }).catch(() => {});

  app.framework.onTrace((event) => {
    const e = event as unknown as { type: string; serverId?: string; timestamp: number } & Record<string, unknown>;
    if (typeof e.serverId !== 'string') return;
    const line = formatMcplLifecycleLine(e);
    if (line === null) return;
    const iso = new Date(e.timestamp).toISOString();
    // basename guards against a misconfigured serverId like "../foo" escaping dir.
    const path = join(dir, `${basename(e.serverId)}.log`);
    const entry = `${iso} ${line}\n`;
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
  const provider = recipe.agent.provider ?? 'anthropic';

  if (provider === 'openai-responses' && !config.openaiApiKey) {
    console.error('Missing OPENAI_API_KEY for recipe provider "openai-responses".');
    process.exit(1);
  }
  if (provider === 'anthropic' && !config.apiKey && !config.authToken) {
    console.error('Missing ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN). Set one in .env or environment.');
    process.exit(1);
  }

  // SettingsModule constructed early so the adapter can read its state for
  // cross-cutting concerns (currently: reasoning). It's wired into the
  // framework's module list inside createFramework().
  const settingsModule = new SettingsModule();

  // Append each LLM request/response/error to a JSONL log per process lifetime
  // (matches the Hermes-era `llm-calls.<iso>.jsonl` visibility). The adapter
  // also reads SettingsModule.getReasoning() per call to inject `thinking`
  // when the agent has toggled reasoning on.
  const llmLogPath = join(
    config.dataDir,
    `llm-calls.${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
  );
  const callLedger = provider === 'anthropic'
    ? new CallLedger({
        dataDir: config.dataDir,
        defaultTtl: recipe.agent.cacheTtl ?? '5m',
      })
    : null;
  // OAuth (subscription) auth wins over API-key auth when both are present.
  // Subscription tokens (sk-ant-oat…) additionally require the oauth beta
  // header on every request.
  const adapter = provider === 'openai-responses'
    ? new OpenAIResponsesAPIAdapter({
        apiKey: config.openaiApiKey!,
        baseURL: process.env.OPENAI_BASE_URL || undefined,
      })
    : new LoggingAnthropicAdapter(
        {
          ...(config.authToken
            ? {
                authToken: config.authToken,
                defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
              }
            : { apiKey: config.apiKey! }),
          baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
        },
        llmLogPath,
        () => settingsModule.getReasoning(),
        (record) => callLedger!.record(record),
      );

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
    formatter: provider === 'openai-responses'
      ? new OpenAIResponsesFormatter()
      : new NativeFormatter(),
    // Anchor the assistant role for internal callers that don't set
    // request.assistantParticipant themselves (autobio compression,
    // executeMerge). Mismatch here flips stored assistant turns to
    // role: 'user' and the API rejects tool_use blocks riding along.
    assistantParticipant: agentName,
  });

  const storePath = sessionManager.getStorePath(activeSession.id);
  const framework = await createFramework(membrane, storePath, recipe, agentName, settingsModule, callLedger);

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
      this.framework = await createFramework(membrane, newStorePath, recipe, this.agentName, settingsModule, callLedger);
      this.framework.start();
      this.userMessageCount = 0;
      resetBranchState(this.branchState);
      setupSynesthete(this);
      setupMcplStderrLog(this, newStorePath);
      getWebUiModule(this.framework)?.setApp(this);
    },
  };

  // Off-path refusal dragnet → ops alerts (observability M3): refusals on
  // non-streamed calls (compression/summarizer drains, maintenance) never
  // reach the framework's own noteRefusal — the 2026-07-15 mythos cascade
  // started exactly there, silently. Surface them through the same
  // opsAlert pipeline (failures.log + ops:alert trace + throttled webhook).
  // Reads app.framework (not the closure) so session switches stay wired;
  // feature-detects notifyOpsAlert for older framework versions.
  if (adapter instanceof LoggingAnthropicAdapter) {
    adapter.onRefusal = (info) => {
      const fw = app.framework as unknown as {
        notifyOpsAlert?: (kind: string, agent: string, msg: string, data?: Record<string, unknown>) => void;
      };
      fw.notifyOpsAlert?.(
        'refusal-offpath',
        app.agentName,
        `off-path refusal (category=${info.category ?? 'unknown'}) on a ${info.messages}-message ` +
          `complete() call (~${Math.round(info.inputTokens / 1000)}k tok) — likely compression/summarizer`,
        { ...info },
      );
    };
  }

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
