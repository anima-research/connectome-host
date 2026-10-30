/**
 * connectome-host — General-purpose agent TUI host with recipe-based configuration.
 *
 * Usage:
 *   bun src/index.ts                           # Start with saved/default recipe
 *   bun src/index.ts <recipe-url-or-path>      # Load recipe from URL or file
 *   bun src/index.ts --no-recipe               # Start fresh with default recipe
 *   bun src/index.ts --no-tui                  # Readline mode on a terminal
 *   echo "hi" | bun src/index.ts <recipe>      # Batch mode (any non-TTY stdin): run lines, stop at EOF
 *   bun src/index.ts --headless                # Daemon mode: JSONL over Unix socket at $DATA_DIR/ipc.sock
 *   bun src/index.ts --headless --exit-when-idle   # One-shot: exit when, after the first inference or text, agents are idle with nothing in flight
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY   - Recipe provider "anthropic" needs this or one of
 *                         the next two
 *   ANTHROPIC_AUTH_TOKEN - Subscription (OAuth) bearer instead of the API key
 *   ANTHROPIC_OAUTH_CREDENTIALS_FILE - JSON credentials file (accessToken +
 *                         refreshToken + expiresAt, Claude Code's shape or flat);
 *                         a refresh token makes the credential host-rotatable.
 *                         Point it at a COPY, never at ~/.claude/.credentials.json.
 *   ANTHROPIC_OAUTH_AUTO_REFRESH - 1/true: rotate on a 401 without asking
 *                         (default: alert + operator action)
 *   MODEL               - Override model (default: from recipe, else
 *                         claude-opus-4-6, or gpt-5.4 for openai-codex)
 *   DATA_DIR            - Data directory for sessions (default: ./data)
 */

// First, so its warning about an old Bun prints before the modules below run.
import './bun-floor-check.js';
import { hostMembraneRetry } from './membrane-retry.js';
import {
  BedrockAdapter,
  Membrane,
  MockAdapter,
  OpenAIResponsesAPIAdapter,
  OpenAICompatibleAdapter,
  OpenRouterAdapter,
} from '@animalabs/membrane';
import { LoggingAnthropicAdapter, offPathRefusalAlert } from './logging-adapter.js';
import { recipeFormatter } from './recipe-formatter.js';
import { gateOptionsFor } from './gate-options.js';
import { heartbeatOptionsFor, withoutHeartbeatMcpl } from './heartbeat-options.js';
import { CredentialMonitor } from './credential-state.js';
import { AnthropicOAuthCredentials } from './anthropic-credentials.js';
import { LoggingProviderAdapter } from './logging-provider-wrapper.js';
import { mockAdapterConfig } from './mock-provider.js';
import { gateTelemetryHeaders, stampedTrigger, type TurnTrigger } from './gate-telemetry.js';
import { LoggingBedrockAdapter } from './logging-bedrock-adapter.js';
import { CodexSubscriptionAdapter, codexGateAuth } from './codex-subscription-adapter.js';
import { CallLedger } from './call-ledger.js';
import { SettingsModule } from './modules/settings-module.js';
import { AgentFramework, WorkspaceModule, resolveTimeZone, HistoryModule, type Module } from '@animalabs/agent-framework';
import { resolve, join, basename } from 'node:path';
import { appendFile, mkdir, stat, rename } from 'node:fs/promises';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { SubagentModule } from './modules/subagent-module.js';
import { historyModuleOptions, assertSemanticSearchRegistered } from './history-semantic.js';
import { LessonsModule } from './modules/lessons-module.js';
import { RetrievalModule } from './modules/retrieval-module.js';
import { retrievalModuleConfig } from './retrieval-config.js';
import { TuiModule } from './modules/tui-module.js';
import { TimeModule } from './modules/time-module.js';
import { waitToBeListed } from './fleet-begin.js';
import { FleetModule, type FleetModuleConfig } from './modules/fleet-module.js';
import { ActivityModule } from './modules/activity-module.js';
import { NoticesModule } from './modules/notices-module.js';
import { SubscriptionGcModule } from './modules/subscription-gc-module.js';
import { ChannelModeModule } from './modules/channel-mode-module.js';
import { WebUiModule, stopWebUiServer } from './modules/web-ui-module.js';
import { ObserversModule } from './modules/observers-module.js';
import { IdentityModule } from './modules/identity-module.js';
import { McplAdminModule } from './modules/mcpl-admin-module.js';
import { LifecycleModule } from './modules/lifecycle-module.js';
import { TtsRelayModule } from './modules/tts-relay-module.js';
import { InstructionsModule } from './modules/instructions-module.js';
import { loadMcplServers, applyAgentOverlay, mergeRecipeServers, composeMcplChildEnv, overlayWarnings, DEFAULT_CONFIG_PATH, DEFAULT_AGENT_OVERLAY_PATH } from './mcpl-config.js';
import { toolClassConfig } from './tool-lifecycle-config.js';
import { batchModeStartNotice, batchTeardownNotice, batchWebUiNotice, batchEchoLine, BATCH_MCPL_LOG_NOTE } from './batch-mode.js';
import { createPipedTurns, switchFollowing, traceFollower } from './piped-turns.js';
import { openReadlineTerminal } from './readline-terminal.js';
import { opsAlertLine, opsAlertOf, type OpsAlertEntry } from './state/ops-alerts.js';
import { setCallLogPath } from './bug-report.js';
import { SessionManager } from './session-manager.js';
import { startFramework } from './start-framework.js';
import { StartRefusal, currentForStart, releaseHere, type ReleaseHere } from './update/host.js';
import { childrenFilePath, trialPlaces } from './update/contract.js';
import { hostUpdate, hostVersionOf } from './update/update.js';
import { armTrialLog } from './update/trial-log.js';
import { PRIVATE_DIR_MODE } from './update/data-swap.js';
import { HOST_PACKAGE_JSON } from './bun-floor-check.js';
import { switchLeftForStop, switchSessionSteps } from './session-switch.js';
import { resolveAgentName } from './agent-name.js';
import { generateSessionName, namingSummary } from './synesthete.js';
import {
  type Recipe,
  DEFAULT_RECIPE,
  loadRecipeDetailed,
  saveRecipe,
  loadSavedRecipe,
  SavedRecipeDirectoryError,
  savedRecipeDirectory,
  savedRecipePath,
  clearSavedRecipe,
  parseRecipeArg,
  deprecatedConversationsNotices,
  deprecatedSurfaceNotices,
  resolveProvider,
  recipeModel,
  runningFit,
} from './recipe.js';
import { createBranchState, resetBranchState, handleExport, type BranchState } from './commands.js';
import { buildFrameworkAgentConfig, membraneCachingOverride, autoContinueSupportWarning } from './framework-agent-config.js';
import { buildFrameworkStrategy, buildConversationsConfig, dendriteCreateOptions } from './framework-strategy.js';
import { holdBootTraces, type BootTraceHold } from './boot-traces.js';
import { AUDIT_STORES_FLAG, auditStoresFromEntry, checkActiveStore, placesOnTrial } from './update/audit-stores.js';
import { buildWorkspaceMounts } from './workspace-mounts.js';
import { quarantineAlarm, type QuarantineStatus } from './web/quarantine-alert.js';
import { wireLoadRepairAlert } from './web/load-repair-alert.js';
import { logKeepaliveEvent } from './cache-keepalive-log.js';
import { loadExtensions, type ExtensionRegistry } from './extensions.js';
import { QuotaMeter, AnthropicOAuthQuotaSource, CodexQuotaSource, quotaProviderHold } from './quota-meter.js';
import { stopForSessionSwitch } from './session-switch-stop.js';
import { failureHint } from './failure-hint.js';

export type { AppContext };

const headless = process.argv.includes('--headless');
const noTui = !headless && (process.argv.includes('--no-tui') || !process.stdin.isTTY);
const batch = noTui && !process.stdin.isTTY;

const config = {
  apiKey: process.env.ANTHROPIC_API_KEY,
  // OAuth/Bearer token (e.g. a Claude subscription token). When set, it takes
  // precedence over the API key so requests never carry both auth schemes.
  authToken: process.env.ANTHROPIC_AUTH_TOKEN,
  // Refreshable OAuth credential file (see header). Wins over the bare token.
  anthropicCredentialsFile: process.env.ANTHROPIC_OAUTH_CREDENTIALS_FILE,
  anthropicAutoRefresh: ['1', 'true'].includes((process.env.ANTHROPIC_OAUTH_AUTO_REFRESH ?? '').trim().toLowerCase()),
  openaiApiKey: process.env.OPENAI_API_KEY,
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  // The key for recipe provider "openai-compatible"; OPENAI_API_KEY is never
  // used in its place, since the recipe names the endpoint.
  openaiCompatibleApiKey: process.env.OPENAI_COMPATIBLE_API_KEY,
  codexBinary: process.env.CODEX_BINARY,
  model: process.env.MODEL,
  dataDir: process.env.DATA_DIR || './data',
};

interface AppContext {
  framework: AgentFramework;
  frameworkSessionId: string;
  membrane: Membrane;
  sessionManager: SessionManager;
  recipe: Recipe;
  agentName: string;
  branchState: BranchState;
  userMessageCount: number;
  codexAdapter?: CodexSubscriptionAdapter;
  callLedger: CallLedger | null;
  quotaMeter: QuotaMeter | null;
  credentials: CredentialMonitor | null;
  subscriptionUnmetered: boolean;
  /**
   * Headless only: the framework's traces from create() on, held until
   * runHeadless attaches the sink that feeds the agent tree, the socket and
   * the host's idle. create() replays its early traces (registry restore,
   * work a stop cut off, resumed tune-out epochs) only to a listener
   * attached before start(), and runHeadless runs after start(); this is
   * that listener (src/boot-traces.ts).
   */
  bootTraces?: BootTraceHold;
  stopping?: boolean;
  switching?: boolean;
  switchSettled?: Promise<{ madeStopFailed: boolean }>;
  onFrameworkReplaced?: () => void;

  switchSession(id: string): Promise<boolean>;
}

async function resolveRecipe(): Promise<Recipe> {
  const { source, noRecipe } = parseRecipeArg(process.argv);

  if (noRecipe) {
    try {
      clearSavedRecipe(config.dataDir);
    } catch (err) {
      stopAtSavedRecipe('clear the saved recipe', err);
    }
    console.log('Starting with default recipe.');
    return DEFAULT_RECIPE;
  }

  if (source) {
    let loaded: Awaited<ReturnType<typeof loadRecipeDetailed>>;
    try {
      loaded = await loadRecipeDetailed(source);
    } catch (err) {
      console.error(`Failed to load recipe from ${source}:`, err instanceof Error ? err.message : err);
      process.exit(1);
    }
    try {
      saveRecipe(config.dataDir, loaded.persistable);
    } catch (err) {
      stopAtSavedRecipe('save the recipe to', err);
    }
    const { recipe } = loaded;
    console.log(`Loaded recipe: ${recipe.name}${recipe.description ? ` — ${recipe.description}` : ''}`);
    return recipe;
  }

  try {
    const saved = await loadSavedRecipe(config.dataDir);
    if (saved) {
      console.log(`Resuming recipe: ${saved.name}`);
      return saved;
    }
  } catch (err) {
    console.error(
      `Failed to resume the saved recipe ${savedRecipePath(config.dataDir)}:`,
      err instanceof Error ? err.message : err,
    );
    console.error(err instanceof SavedRecipeDirectoryError
      ? SAVED_RECIPE_DIRECTORY_LINE
      : 'Fix what it names (the file, a variable missing from the environment, a number the recipe sets, or MODEL in the environment), start with a recipe file to replace it, or start with --no-recipe to clear it.');
    process.exit(1);
  }

  return DEFAULT_RECIPE;
}

const SAVED_RECIPE_DIRECTORY_LINE =
  'Move or remove it, then start again: the host saves its recipe there as a file, so the source of a bind mount there has to be a file that exists before the container starts.';

/** A save that a directory stops fails with EISDIR, and a clear with
 *  ERR_FS_EISDIR. */
function stopAtSavedRecipe(failedTo: string, err: unknown): never {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const directory = code === 'EISDIR' || code === 'ERR_FS_EISDIR' ? savedRecipeDirectory(config.dataDir) : null;
  console.error(`Failed to ${failedTo} ${savedRecipePath(config.dataDir)}:`, directory ?? (err instanceof Error ? err.message : err));
  if (directory !== null) console.error(SAVED_RECIPE_DIRECTORY_LINE);
  process.exit(1);
}

function resolveModel(recipe: Recipe): string {
  return recipeModel(recipe, config.model);
}

let noticesRef: NoticesModule | null = null;
let instructionsRef: InstructionsModule | null = null;
let installHere: ReleaseHere | null = null;

async function createFramework(
  membrane: Membrane,
  storePath: string,
  recipe: Recipe,
  agentName: string,
  settingsModule: SettingsModule,
  callLedger: CallLedger | null,
  quotaMeter: QuotaMeter | null,
  credentials: CredentialMonitor | null,
  subscriptionUnmetered = false,
  extensions?: ExtensionRegistry,
): Promise<AgentFramework> {
  const model = resolveModel(recipe);
  const modules = recipe.modules ?? {};
  const timeZone = resolveTimeZone(recipe.agent.timezone);

  const extensionRegistry = extensions ?? await loadExtensions(recipe);

  const moduleInstances: Module[] = [new TuiModule(), new TimeModule(timeZone), settingsModule];

  let subagentModule: SubagentModule | null = null;
  if (modules.subagents) {
    const subagentConfig = typeof modules.subagents === 'object' ? modules.subagents : {};
    subagentModule = new SubagentModule({
      parentAgentName: agentName,
      provider: resolveProvider(recipe),
      formatter: recipe.agent.formatter,
      defaultModel: subagentConfig.defaultModel || model,
      defaultMaxTokens: subagentConfig.defaultMaxTokens,
      ...(subagentConfig.orientation ? { orientation: subagentConfig.orientation } : {}),
      ...(subagentConfig.lifecycleReach ? { lifecycleReach: subagentConfig.lifecycleReach } : {}),
      timeZone,
    });
    moduleInstances.push(subagentModule);
  }

  let lessonsModule: LessonsModule | null = null;
  if (modules.lessons) {
    const globalLessonsPath = resolve(join(storePath, '..', '..', 'lessons.json'));
    lessonsModule = new LessonsModule({ globalPath: globalLessonsPath });
    moduleInstances.push(lessonsModule);
  }

  let fleetModule: FleetModule | null = null;
  if (modules.fleet === true || (modules.fleet && typeof modules.fleet === 'object')) {
    const fleetCfg = modules.fleet === true ? {} : modules.fleet;
    const fleetModuleConfig: FleetModuleConfig = {
      timeZone,
      childrenFile: installHere ? childrenFilePath(resolve(config.dataDir)) : undefined,
    };
    if (fleetCfg.children) {
      fleetModuleConfig.autoStart = fleetCfg.children.map((c) => {
        const entry: NonNullable<FleetModuleConfig['autoStart']>[number] = {
          name: c.name,
          recipe: c.recipe,
          autoStart: c.autoStart !== false,
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
    fleetModule = new FleetModule(fleetModuleConfig);
    moduleInstances.push(fleetModule);
  }

  if (modules.retrieval && lessonsModule) {
    moduleInstances.push(new RetrievalModule(retrievalModuleConfig(membrane, recipe)));
  }

  let historyModule: HistoryModule | null = null;
  if (modules.history) {
    const sessionId = basename(storePath);
    const historyOpts = historyModuleOptions(modules.history, agentName, sessionId);
    historyModule = new HistoryModule(historyOpts);
    assertSemanticSearchRegistered(historyModule, historyOpts.semantic !== undefined);
    moduleInstances.push(historyModule);
  }

  // Gate config — core AF EventGate feature, with the reply judge
  // (gate-options.ts). Path is per-session: {storePath}/config/gate.json
  const gateOptions = gateOptionsFor(modules.wake, storePath);

  let workspaceModule: WorkspaceModule | null = null;
  const workspaceMounts = buildWorkspaceMounts(modules.workspace, storePath);
  if (workspaceMounts) {
    workspaceModule = new WorkspaceModule({ mounts: workspaceMounts });
    moduleInstances.push(workspaceModule);
  }

  if (modules.instructions) {
    const instructionsConfig =
      typeof modules.instructions === 'object' ? modules.instructions : {};
    instructionsRef ??= new InstructionsModule({ ...instructionsConfig, agentName });
    if (workspaceModule) instructionsRef.setWorkspace(workspaceModule);
    moduleInstances.push(instructionsRef);
  }

  let activityModule: ActivityModule | null = null;
  if (modules.activity !== undefined && modules.activity !== false) {
    const activityConfig = typeof modules.activity === 'object' ? modules.activity : {};
    activityModule = new ActivityModule({
      initialChannels: activityConfig.channels,
    });
    moduleInstances.push(activityModule);
  }

  let noticesModule: NoticesModule | null = null;
  if (modules.notices !== undefined && modules.notices !== false) {
    if (!noticesRef) {
      const noticesConfig = typeof modules.notices === 'object' ? modules.notices : {};
      noticesRef = new NoticesModule({
        agentName,
        statusChannels: noticesConfig.statusChannels,
        replyIn: noticesConfig.reply?.in,
        replyNot: noticesConfig.reply?.not,
        kinds: noticesConfig.kinds,
        quietMs: noticesConfig.quietMs,
        renotifyMs: noticesConfig.renotifyMs,
      });
    }
    noticesModule = noticesRef;
    moduleInstances.push(noticesModule);
  }

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

  let mcplAdminModule: McplAdminModule | null = null;
  if (modules.mcplAdmin === true || typeof modules.mcplAdmin === 'object') {
    mcplAdminModule = new McplAdminModule({ timeZone });
    moduleInstances.push(mcplAdminModule);
  }

  if (modules.selfRestart !== undefined && modules.selfRestart !== false) {
    const srCfg = typeof modules.selfRestart === 'object' ? modules.selfRestart : {};
    moduleInstances.push(new LifecycleModule({
      dataDir: resolve(config.dataDir),
      timeZone,
      ...(srCfg.cooldownMinutes !== undefined ? { cooldownMinutes: srCfg.cooldownMinutes } : {}),
    }));
  }

  let identityModule: IdentityModule | null = null;
  if (modules.identity !== undefined && modules.identity !== false) {
    const idCfg = typeof modules.identity === 'object' ? modules.identity : {};
    identityModule = new IdentityModule({
      keyPath: process.env.IDENTITY_KEY_FILE || resolve(config.dataDir, 'identity-key.pem'),
      home: idCfg.home ?? process.env.IDENTITY_HOME ?? 'id.animalabs.ai',
      ...(idCfg.audience ? { defaultAudience: idCfg.audience } : {}),
    });
    moduleInstances.push(identityModule);
  }

  let webUiModule: WebUiModule | null = null;
  if (modules.webui !== undefined && modules.webui !== false) {
    const webuiConfig = typeof modules.webui === 'object' ? modules.webui : {};
    // The Web UI's observer grants: $DATA_DIR/observers.json unless
    // OBSERVERS_FILE names another; with no grant in it, no observer is
    // admitted.
    const observersPath = process.env.OBSERVERS_FILE || resolve(config.dataDir, 'observers.json');
    webUiModule = new WebUiModule({
      port: webuiConfig.port,
      host: webuiConfig.host,
      basicAuth: webuiConfig.basicAuth,
      allowedOrigins: webuiConfig.allowedOrigins,
      observersPath,
      ...(callLedger ? { callLedger } : {}),
      ...(quotaMeter ? { quotaMeter } : {}),
      ...(credentials ? { credentials } : {}),
      ...(subscriptionUnmetered ? { subscriptionUnmetered } : {}),
    });
    moduleInstances.push(webUiModule);
    moduleInstances.push(new ObserversModule({ path: observersPath }));
  }

  if (modules.ttsRelay) {
    moduleInstances.push(new TtsRelayModule(modules.ttsRelay));
  }

  const extensionModules: Module[] = [];
  for (const entry of extensionRegistry.modules) {
    const instance = entry.factory({ timeZone, storePath, model, config: entry.config });
    extensionModules.push(instance);
    moduleInstances.push(instance);
  }

  const recipeServers = recipe.mcpServers ?? {};
  const fileServers = loadMcplServers(DEFAULT_CONFIG_PATH);

  const allServers = mergeRecipeServers(
    recipeServers as unknown as Record<string, Record<string, unknown>>,
    fileServers as unknown as Array<{ id: string } & Record<string, unknown>>,
  );

  for (const line of overlayWarnings(allServers, DEFAULT_AGENT_OVERLAY_PATH)) console.warn(line);
  const finalServers = applyAgentOverlay(allServers, DEFAULT_AGENT_OVERLAY_PATH).map((server) => {
    const withEnv: { id: string; command?: string; url?: string; [k: string]: unknown } = {
      ...server,
      env: composeMcplChildEnv(server.env as Record<string, string> | undefined, timeZone),
    };
    if (typeof withEnv.access === 'string' && withEnv.access) {
      if (identityModule) {
        const identity = identityModule;
        const audience = withEnv.access as string;
        withEnv.accessProvider = () => identity.accessFor(audience);
      } else {
        console.error(
          `[mcpl] server "${server.id}": access "${withEnv.access}" declared but the recipe has no identity module — connecting without credentials`,
        );
      }
    }
    return withEnv;
  });

  const strategy = buildFrameworkStrategy(recipe, model, timeZone, extensionRegistry, agentName);
  const agentConfig = buildFrameworkAgentConfig(recipe, agentName, model, strategy);

  for (const notice of deprecatedConversationsNotices(recipe.conversations)) console.warn(`[deprecated] ${notice}`);
  for (const notice of deprecatedSurfaceNotices(recipe.modules)) console.warn(`[deprecated] ${notice}`);
  const conversations = buildConversationsConfig(recipe, agentName, model, timeZone, extensionRegistry);

  // The framework's heartbeat (heartbeat-options.ts), with heartbeat-mcpl
  // left out beside it.
  const heartbeatOptions = heartbeatOptionsFor(modules.heartbeat, config.dataDir);
  const mcplServers = heartbeatOptions ? withoutHeartbeatMcpl(finalServers, (line) => console.warn(line)) : finalServers;

  const framework = await AgentFramework.create({
    storePath,
    membrane,
agents: [agentConfig],
    modules: moduleInstances,
    mcplServers,
    gate: gateOptions,
    // Passed by spread, so an agent-framework without it reads nothing it
    // doesn't know (and the line after create says so).
    ...(heartbeatOptions !== undefined ? { heartbeat: heartbeatOptions } : {}),
    timeZone,
    // A 429 while a subscription window is spent is a quota, not a throttle:
    // park until it resets instead of retrying into it.
    ...(quotaMeter ? { providerHold: quotaProviderHold(quotaMeter, () => model) } : {}),
    ...(recipe.codeExecution ? { codeExecution: recipe.codeExecution } : {}),
    ...(conversations ? { conversations } : {}),
    // Tune-out's reader (agent-framework#77, #232) and the Dendrite options
    // (`speech`, `tuneOut`, `dendrite`) — recipe opt-ins, typed against the
    // framework's own config (agent-framework#546); the reader mapping adds
    // the one field a recipe cannot state.
    ...dendriteCreateOptions(recipe, model, timeZone, extensionRegistry),
    ...(toolClassConfig(recipe) as object),
    maintenanceIntervalMs: recipe.maintenanceIntervalMs,
  });

  // An agent-framework without the heartbeat ignores modules.heartbeat: the
  // agent then has no heartbeat or reminders at all, which is said here.
  if (heartbeatOptions && !framework.getAllTools().some((tool) => tool.name.startsWith('heartbeat--'))) {
    console.warn('[heartbeat] modules.heartbeat is on, but this agent-framework has no heartbeat (it came after 0.27.0), so the '
      + 'agent has no heartbeat or reminders. Update agent-framework, or turn modules.heartbeat off and run heartbeat-mcpl '
      + 'under mcpServers.heartbeat.');
  }

  if (historyModule) {
    const cm = framework.getAgent(agentName)?.getContextManager();
    if (cm) {
      historyModule.bind(cm, framework.channels ?? undefined);
    }
  }

  const autoContinueWarning = autoContinueSupportWarning(recipe, framework.getAgent(agentName) ?? undefined);
  if (autoContinueWarning) console.warn(autoContinueWarning);

  {
    const alarmCapable = strategy as unknown as {
      setQuarantineAlarmHandler?: (fn: (status: QuarantineStatus) => void) => void;
    };
    const notify = (framework as unknown as {
      notifyOps?: (kind: string, agent: string, message: string, data?: Record<string, unknown>) => void;
    }).notifyOps?.bind(framework);
    if (alarmCapable.setQuarantineAlarmHandler && notify) {
      alarmCapable.setQuarantineAlarmHandler((status) => {
        const alert = quarantineAlarm(status);
        notify(alert.kind, agentName, alert.message, alert.data);
      });
    }

    wireLoadRepairAlert(strategy, framework, agentName, storePath);
  }

  if (subagentModule) {
    subagentModule.setFramework(framework);
  }

  if (noticesModule) {
    noticesModule.setKnownServers(finalServers.map((server) => server.id));
    noticesModule.setFramework(framework);
  }
  if (activityModule) {
    activityModule.setFramework(framework);
  }

  if (channelModeModule) {
    channelModeModule.setFramework(framework);
  }

  for (const instance of extensionModules) {
    const hooked = instance as unknown as { setFramework?: (f: AgentFramework) => void };
    hooked.setFramework?.(framework);
  }

  if (mcplAdminModule) {
    mcplAdminModule.setFramework(framework);
    mcplAdminModule.setOperatorServers(allServers);
    if (identityModule) mcplAdminModule.setIdentity(identityModule);
  }

  if (workspaceModule) {
    workspaceModule.initStore(framework.getStore());
  }

  if (fleetModule) {
    fleetModule.setStoreSync(() => framework.getStore().sync());
  }

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
    const summary = namingSummary(messages);

    generateSessionName(app.membrane, summary, namingExamples).then(name => {
      if (name) {
        app.sessionManager.renameSession(session.id, name, false);
      }
    });
  });
}

const MCPL_STDERR_LOG_MAX_BYTES = 10 * 1024 * 1024;

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

function mcplStderrLogDir(storePath: string): string {
  return join(storePath, 'mcpl-stderr');
}

async function appendMcplLogLine(dir: string, serverId: string, timestamp: number, line: string): Promise<void> {
  const path = join(dir, `${basename(serverId)}.log`);
  const entry = `${new Date(timestamp).toISOString()} ${line}\n`;
  try {
    await rotateIfNeeded(path, entry.length);
    await appendFile(path, entry);
  } catch {
  }
}

function setupMcplStderrLog(app: AppContext, storePath: string): void {
  const dir = mcplStderrLogDir(storePath);
  void mkdir(dir, { recursive: true }).catch(() => {});

  app.framework.onTrace((event) => {
    const e = event as unknown as { type: string; serverId?: string; timestamp: number } & Record<string, unknown>;
    if (typeof e.serverId !== 'string') return;
    const line = formatMcplLifecycleLine(e);
    if (line === null) return;
    void appendMcplLogLine(dir, e.serverId, e.timestamp, line);
  });
}

async function rotateIfNeeded(path: string, incomingBytes: number): Promise<void> {
  try {
    const s = await stat(path);
    if (s.size + incomingBytes > MCPL_STDERR_LOG_MAX_BYTES) {
      await rename(path, `${path}.1`);
    }
  } catch {
  }
}

async function runPiped(app: AppContext) {
  const { createInterface } = await import('node:readline');
  const { handleCommand } = await import('./commands.js');

  let say = (line: string): void => { console.error(line); };
  let atPrompt = false;
  let onAlert: ((event: Record<string, unknown>) => void) | null = null;
  const turns = createPipedTurns(app.agentName, {
    write: (text) => { atPrompt = false; process.stdout.write(text); },
    log: (line) => { atPrompt = false; console.log(line); },
    error: (line) => { say(line); },
  }, failureHint(app.recipe, process.env, app.credentials));
  const traces = traceFollower((event) => {
    const e = event as { type: string; [key: string]: unknown };
    turns.onTrace(e);
    if (e.type === 'ops:alert') onAlert?.(e);
  });
  traces.follow(app.framework);
  let afterSwitch = (): void => {};

  async function processLine(line: string): Promise<boolean> {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('/')) {
      const result = handleCommand(trimmed, app);
      if (result.quit) return true;
      for (const l of result.lines) console.log(l.text);
      if (result.asyncWork) {
        try {
          for (const l of (await result.asyncWork).lines) console.log(l.text);
        } catch (error) {
          say(`${trimmed.split(/\s/)[0]} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (result.branchChanged) {
        const ws = app.framework.getModule('workspace');
        if (ws && 'materializeMount' in ws) {
          await (ws as any).materializeMount('_config');
        }
      }
      if (result.switchToSessionId) {
        const sessionId = result.switchToSessionId;
        turns.switched();
        const switched = await switchFollowing(traces, () => app.switchSession(sessionId), () => app.framework);
        afterSwitch();
        console.log(switched ? 'Session switched.' : switchLeftForStop(app.sessionManager.getActiveSession()));
      }
    } else {
      app.framework.pushEvent({
        type: 'external-message', source: 'cli',
        content: trimmed, metadata: {}, triggerInference: true,
      });
      await turns.waitForTurn();
    }
    return false;
  }

  if (batch) {
    console.log(batchModeStartNotice());
    const lines: string[] = [];
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) lines.push(line);
    console.log(`Processing ${lines.length} commands...`);
    for (const line of lines) {
      console.log(`> ${batchEchoLine(line)}`);
      if (await processLine(line)) break;
    }
    app.stopping = true;
    console.log('Done.');
    const serverIds = app.framework.listMcplServers().map((s) => s.id);
    console.log(batchTeardownNotice(serverIds));
    const session = app.sessionManager.getActiveSession();
    if (session) {
      const dir = mcplStderrLogDir(app.sessionManager.getStorePath(session.id));
      const now = Date.now();
      await mkdir(dir, { recursive: true }).catch(() => {});
      await Promise.all(serverIds.map((id) => appendMcplLogLine(dir, id, now, BATCH_MCPL_LOG_NOTE)));
    }
    await app.framework.stop();
    const webUiUrl = getWebUiModule(app.framework)?.listeningUrl();
    if (webUiUrl) console.log(batchWebUiNotice(webUiUrl));
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  const terminal = openReadlineTerminal(config.dataDir, { showing: () => atPrompt, redraw: () => { rl.prompt(true); } });
  try {
    say = terminal.say;
    hostUpdate.attachNotices(terminal.say);
    const alerts = new Map<string, OpsAlertEntry>();
    const showAlert = (alert: { kind: string; agent: string; message: string }): void => {
      const line = opsAlertLine(alerts, alert.kind, alert.agent, alert.message);
      if (line !== null) terminal.say(line.text);
    };
    onAlert = (event) => { showAlert(opsAlertOf(event)); };
    afterSwitch = () => { alerts.clear(); };
    let restarting = false;
    hostUpdate.attachStop({ supervised: false, stop: () => { restarting = true; setTimeout(() => { rl.close(); }, 0); } });
    console.log('connectome-host (readline mode). Type /help for commands.');
    if (terminal.logging()) terminal.say(`Error log: ${terminal.logPath}`);
    let closed = false;
    rl.on('close', () => { closed = true; atPrompt = false; });
    rl.prompt();
    atPrompt = true;
    rl.on('line', async (line: string) => {
      atPrompt = false;
      if (await processLine(line)) { rl.close(); return; }
      if (closed) return;
      rl.prompt();
      atPrompt = true;
    });
    await new Promise<void>(r => rl.on('close', r));
    app.stopping = true;
    console.log('\nShutting down...');
    await app.framework.stop();
    if (restarting) {
      await stopWebUiServer().catch((error: unknown) => {
        terminal.say(`[webui] closing the Web UI's server for the restart failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  } finally {
    onAlert = null;
    terminal.end();
  }
}

function countLines(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const buf = readFileSync(path, 'utf8');
    if (buf.length === 0) return 0;
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf.charCodeAt(i) === 10) n++;
    if (buf.charCodeAt(buf.length - 1) !== 10) n++;
    return n;
  } catch {
    return 0;
  }
}

let beforeFatalExit: (() => Promise<void>) | undefined;

async function main() {
  // It exits as soon as what it wrote has gone out, since an extension the
  // saved recipe names can keep the process alive, as a timer can.
  if (process.argv[2] === AUDIT_STORES_FLAG) {
    process.exit(await auditStoresFromEntry(process.argv.slice(3)));
  }
  await waitToBeListed();
  installHere = releaseHere();
  if (installHere !== null) armTrialLog(installHere);
  try {
    // mkdirSync's mode applies only to the directories it creates.
    mkdirSync(config.dataDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch (err) {
    console.error(`The host can't make its data directory ${resolve(config.dataDir)}, so it stops: ${err instanceof Error ? err.message : String(err)}`);
    console.error('Set DATA_DIR to a path where this user has or can make a directory, or fix what the error names.');
    process.exit(1);
  }
  const recipe = await resolveRecipe();
  const provider = resolveProvider(recipe);
  const fit = runningFit(recipe, config.model);
  if (!fit.checked) console.log(fit.line);

  if (provider === 'openrouter' && !config.openrouterApiKey) {
    console.error('Missing OPENROUTER_API_KEY for recipe provider "openrouter".');
    process.exit(1);
  }
  if (provider === 'openai-responses' && !config.openaiApiKey) {
    console.error('Missing OPENAI_API_KEY for recipe provider "openai-responses".');
    process.exit(1);
  }
  if (provider === 'bedrock' && !(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)) {
    console.error('Missing AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY for recipe provider "bedrock".');
    process.exit(1);
  }
  if (provider === 'anthropic' && !config.apiKey && !config.authToken && !config.anthropicCredentialsFile) {
    console.error('Missing ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / ANTHROPIC_OAUTH_CREDENTIALS_FILE). Set one in .env or environment.');
    process.exit(1);
  }

  const settingsModule = new SettingsModule(recipe.agent.thinking?.effort);

  // One JSONL call log per process lifetime.
  const llmLogPath = join(
    config.dataDir,
    `llm-calls.${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`,
  );
  setCallLogPath(llmLogPath);
  const callLedger = provider === 'anthropic'
    ? new CallLedger({
        dataDir: config.dataDir,
        defaultTtl: recipe.agent.cacheTtl ?? '5m',
      })
    : null;
  let credentialsRef: CredentialMonitor | null = null;
  // With CODEX_GATE_TOKEN and CODEX_BASE_URL set, an inference gate holds the
  // Codex logins and no Codex CLI runs.
  const codexGate = provider === 'openai-codex' ? codexGateAuth(process.env) : undefined;
  const codexAdapter = provider === 'openai-codex'
    ? new CodexSubscriptionAdapter({
        codexBinary: config.codexBinary,
        fastMode: recipe.agent.codex?.fastMode ?? false,
        onLoginRequired: ({ verificationUrl, userCode }) => {
          console.error('\nOpenAI Codex subscription login required.');
          console.error(`Open ${verificationUrl} and enter code: ${userCode}\n`);
          credentialsRef?.loginRequired({ verificationUrl, userCode });
        },
        ...(codexGate ? { authProvider: codexGate } : {}),
      })
    : undefined;
  const anthropicCredentials = provider === 'anthropic' && (config.anthropicCredentialsFile || config.authToken)
    ? new AnthropicOAuthCredentials({
        ...(config.anthropicCredentialsFile
          ? { credentialsFile: config.anthropicCredentialsFile }
          : { token: config.authToken }),
        autoRefresh: config.anthropicAutoRefresh,
        baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
        onWriteBack: (file, error) => credentialsRef?.observeWriteBack(file, error),
      })
    : null;
  // Subscription credentials draw down utilization windows instead of being
  // billed per token; the meter reads them out-of-band (no inference spend).
  const quotaMeter = anthropicCredentials
    ? new QuotaMeter(new AnthropicOAuthQuotaSource({
        authToken: () => anthropicCredentials.currentToken(),
        baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
      }))
    : codexAdapter && !codexGate
      ? new QuotaMeter(new CodexQuotaSource(() => codexAdapter.readRateLimits()))
      : null;
  const openaiCompatibleAdapter = provider === 'openai-compatible'
    ? new OpenAICompatibleAdapter({
        baseURL: recipe.agent.baseUrl!,
        apiKey: config.openaiCompatibleApiKey || undefined,
        providerName: 'openai-compatible',
      })
    : undefined;
  const openrouterAdapter = provider === 'openrouter'
    ? new OpenRouterAdapter({
        apiKey: config.openrouterApiKey!,
        xTitle: recipe.agent.name ?? recipe.name,
      })
    : undefined;
  // The Bedrock adapter reads the AWS_* variables (AWS_REGION defaults to
  // us-west-2). BEDROCK_BASE_URL routes its bedrock-runtime calls through an
  // inference gateway.
  const bedrockAdapter = provider === 'bedrock'
    ? new LoggingBedrockAdapter(
        { baseURL: process.env.BEDROCK_BASE_URL || undefined },
        llmLogPath,
      )
    : undefined;
  const mockAdapter = provider === 'mock'
    ? new MockAdapter(mockAdapterConfig(recipe.agent.mock))
    : undefined;
  let appRefForDebt: AppContext | null = null;
  const primaryAgent = (): { name: string; agent: unknown } | null => {
    const fw = appRefForDebt?.framework;
    const agents = fw?.getAllAgents() ?? [];
    const name = (fw as unknown as { primaryAgentName?: string } | undefined)?.primaryAgentName
      ?? (agents.length === 1 ? agents[0]!.name : undefined);
    if (!name) return null;
    const agent = agents.find((a) => a.name === name);
    return agent ? { name, agent } : null;
  };
  const pendingDebtChunks = (): number | null => {
    try {
      const p = primaryAgent();
      if (!p) return null;
      const strategy = (p.agent as unknown as {
        getContextManager?: () => { getStrategy?: () => { getCompressionDebt?: () => unknown } };
      }).getContextManager?.()?.getStrategy?.();
      const d = strategy?.getCompressionDebt?.() as { pendingChunks?: unknown } | undefined;
      const n = d?.pendingChunks;
      return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    } catch {
      return null;
    }
  };

  const activeTurnTrigger = (): TurnTrigger | null => {
    try {
      const fw = appRefForDebt?.framework;
      if (!fw) return null;
      const agents = fw.getAllAgents();
      // membrane's dynamicHeaders callback is told only the request's lane, and
      // one adapter serves every agent in this process, so it can't tell whose
      // request it stamps: the primary's trigger is stamped only while no other
      // agent has a turn in flight.
      const t = stampedTrigger({
        agents: agents.map((a) => a.name),
        primary: primaryAgent()?.name,
        triggerOf: (name) => {
          const r = fw.getActiveTurnTrigger(name) as
            (ReturnType<typeof fw.getActiveTurnTrigger> & { wakeChannelId?: string }) | undefined;
          return r ? { reason: r.reason, source: r.source, channelId: r.channelId, wakeChannelId: r.wakeChannelId, counterparty: r.counterparty } : null;
        },
      });
      return t;
    } catch {
      return null;
    }
  };

  const gateTelemetryDynamicHeaders = gateTelemetryHeaders(process.env, pendingDebtChunks, activeTurnTrigger);

  const adapter = provider === 'openai-responses'
    ? new LoggingProviderAdapter(
        new OpenAIResponsesAPIAdapter({
          apiKey: config.openaiApiKey!,
          baseURL: process.env.OPENAI_BASE_URL || undefined,
        }),
        llmLogPath,
      )
    : bedrockAdapter
      ?? (mockAdapter ? new LoggingProviderAdapter(mockAdapter, llmLogPath) : undefined)
      ?? (openrouterAdapter ? new LoggingProviderAdapter(openrouterAdapter, llmLogPath) : undefined)
      ?? (openaiCompatibleAdapter ? new LoggingProviderAdapter(openaiCompatibleAdapter, llmLogPath) : undefined)
      ?? (codexAdapter ? new LoggingProviderAdapter(codexAdapter, llmLogPath) : undefined)
      ?? new LoggingAnthropicAdapter(
        {
          ...(anthropicCredentials
            ? {
                authToken: anthropicCredentials.tokenResolver(),
                defaultHeaders: {
                  'anthropic-beta': ['oauth-2025-04-20', ...(recipe.agent.anthropicBetas ?? [])].join(','),
                },
              }
            : {
                apiKey: config.apiKey!,
                ...(recipe.agent.anthropicBetas?.length
                  ? { defaultHeaders: { 'anthropic-beta': recipe.agent.anthropicBetas.join(',') } }
                  : {}),
              }),
          baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
          // Only with GATE_TELEMETRY=1 and ANTHROPIC_BASE_URL set, so the stamp
          // goes only to a gateway the operator has named, never to the
          // vendor's default endpoint.
          ...(gateTelemetryDynamicHeaders ? { dynamicHeaders: gateTelemetryDynamicHeaders } : {}),
          // membrane refreshes the cached prefix once it has gone
          // refreshAfterMs (45 minutes by default) untouched, so a busy agent
          // costs nothing, and only on the primary lane.
          cacheKeepalive: {
            enabled: recipe.agent.cacheKeepalive?.enabled !== false,
            ...(recipe.agent.cacheKeepalive?.maxIdleHours !== undefined
              ? { maxIdleMs: recipe.agent.cacheKeepalive.maxIdleHours * 60 * 60_000 }
              : {}),
            ...(recipe.agent.cacheKeepalive?.refreshAfterMinutes !== undefined
              ? { refreshAfterMs: recipe.agent.cacheKeepalive.refreshAfterMinutes * 60_000 }
              : {}),
            onEvent: logKeepaliveEvent,
          },
        },
        llmLogPath,
        () => settingsModule.getReasoning(),
        (record) => callLedger!.record(record),
      );

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
    retry: hostMembraneRetry(recipe.agent.retry),
    formatter: recipeFormatter(recipe, provider, resolveModel(recipe)),
    ...membraneCachingOverride(recipe, resolveModel(recipe)),
    // membrane sends this participant's messages as assistant turns for a
    // request that names no assistant participant ('Claude' otherwise), and the
    // API refuses a tool_use block in a user turn.
    assistantParticipant: agentName,
  });

  const storePath = sessionManager.getStorePath(activeSession.id);
  let placesForTrial: string[] | null = null;
  if (installHere !== null) {
    const install = installHere;
    const current = currentForStart(install.root);
    if (current !== null && current !== install.release) {
      placesForTrial = placesOnTrial(current, () => trialPlaces(install.root));
      checkActiveStore(storePath, current, placesForTrial);
    }
  }
  let appForAlerts: AppContext | null = null;
  const queuedAlerts: Array<[string, string, Record<string, unknown>]> = [];
  const credentialSource = anthropicCredentials ?? codexAdapter?.credentialSource() ?? null;
  const credentials = credentialSource
    ? new CredentialMonitor({
        source: credentialSource,
        quotaMeter,
        modelFor: () => resolveModel(recipe),
        alert: (kind, message, data) => {
          if (!appForAlerts) {
            queuedAlerts.push([kind, message, data]);
            return;
          }
          const fw = appForAlerts.framework as unknown as {
            notifyOpsAlert?: (kind: string, agent: string, msg: string, data?: Record<string, unknown>) => void;
          };
          if (typeof fw.notifyOpsAlert !== 'function') {
            console.error(`[credential] ${kind}: ${message}`);
            return;
          }
          fw.notifyOpsAlert(kind, appForAlerts.agentName, message, data);
        },
      })
    : null;
  credentialsRef = credentials;
  if (credentials && (adapter instanceof LoggingAnthropicAdapter || adapter instanceof LoggingProviderAdapter)) {
    adapter.onProviderError = (error: unknown) => credentials.observeError(error);
    adapter.onProviderSuccess = () => credentials.observeSuccess();
  }

  const extensions = await loadExtensions(recipe);
  const framework = await createFramework(membrane, storePath, recipe, agentName, settingsModule, callLedger, quotaMeter, credentials, !!codexGate, extensions);

  const app: AppContext = {
    framework,
    frameworkSessionId: activeSession.id,
    membrane,
    sessionManager,
    recipe,
    agentName,
    branchState: createBranchState(),
    userMessageCount: 0,
    codexAdapter,
    callLedger,
    quotaMeter,
    credentials,
    subscriptionUnmetered: !!codexGate,

    async switchSession(id: string) {
      const newStorePath = sessionManager.getStorePath(id);
      return switchSessionSteps(this, {
        stopOld: async () => {
          handleExport(this);
          await stopForSessionSwitch(this.framework, id);
        },
        make: () => {
          sessionManager.setActiveSession(id);
          return createFramework(membrane, newStorePath, recipe, this.agentName, settingsModule, callLedger, quotaMeter, credentials, !!codexGate);
        },
        install: async (next) => {
          this.framework = next;
          this.frameworkSessionId = id;
          this.onFrameworkReplaced?.();
          await startFramework(next, null);
          this.userMessageCount = 0;
          resetBranchState(this.branchState);
          setupSynesthete(this);
          setupMcplStderrLog(this, newStorePath);
          getWebUiModule(next)?.setApp(this);
        },
        stopServer: stopWebUiServer,
      }, (line) => console.error(`${line} (switching to session ${id})`));
    },
  };

  appRefForDebt = app;
  appForAlerts = app;

  if (adapter instanceof LoggingAnthropicAdapter) {
    adapter.onRefusal = (info) => {
      const fw = app.framework as unknown as {
        notifyOpsAlert?: (kind: string, agent: string, msg: string, data?: Record<string, unknown>) => void;
      };
      const alert = offPathRefusalAlert(info);
      fw.notifyOpsAlert?.(alert.kind, app.agentName, alert.message, alert.data);
    };
  }

  // The headless sink attaches inside runHeadless, after start() has
  // dropped the traces create() replays; hold them from here (see
  // AppContext.bootTraces), before startFramework calls start().
  if (headless) app.bootTraces = holdBootTraces(framework);
  await startFramework(framework, installHere, {
    dataDir: config.dataDir,
    activeStore: storePath,
    extensions,
    places: () => placesForTrial ?? (installHere === null ? null : trialPlaces(installHere.root)),
  });
  setupSynesthete(app);
  setupMcplStderrLog(app, storePath);
  hostUpdate.configure({
    here: installHere,
    running: hostVersionOf(HOST_PACKAGE_JSON),
    host: {
      framework: () => app.framework,
      fleet: () => {
        const fleet = app.framework.getModule('fleet');
        return fleet instanceof FleetModule ? fleet : null;
      },
    },
  });
  if (!batch) hostUpdate.startChecks();
  const serve = (): void => { getWebUiModule(app.framework)?.setApp(app); };
  if (batch) serve();
  else hostUpdate.whenStopAttached(serve);
  for (const [kind, message, data] of queuedAlerts.splice(0)) {
    (framework as unknown as { notifyOpsAlert?: (k: string, a: string, m: string, d?: Record<string, unknown>) => void })
      .notifyOpsAlert?.(kind, agentName, message, data);
  }

  try {
    if (headless) {
      const { runHeadless, endHeadlessLog } = await import('./headless.js');
      beforeFatalExit = endHeadlessLog;
      await runHeadless(app, process.argv.slice(2));
    } else if (noTui) {
      await runPiped(app);
    } else {
      const { runTui } = await import('./tui.js');
      try {
        await runTui(app);
      } finally {
        await stopWebUiServer().catch((error: unknown) => {
          console.error(`[webui] the TUI has ended, and closing the Web UI's server failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  } finally {
    credentials?.dispose();
    codexAdapter?.dispose();
  }
}

main().catch(async (err) => {
  if (err instanceof StartRefusal) console.error(err.message);
  else console.error('Fatal error:', err);
  // Headless, headless.log may still hold lines written just before the
  // failure, such as the server's error; exiting at once would drop them.
  await beforeFatalExit?.();
  process.exit(1);
});
