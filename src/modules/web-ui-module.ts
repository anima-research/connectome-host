import { CURVE_PAGE_HTML } from './web-ui-curve-page.js';
import { RETRIEVAL_TRACE_PAGE_HTML } from './retrieval-trace-page.js';
import type { RetrievalTraceSource } from './retrieval-trace.js';
import type {
  AgentFramework,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
  TraceEvent,
  SessionUsageSnapshot,
  WorkspaceModule,
} from '@animalabs/agent-framework';
import { WorkspaceReadError } from '@animalabs/agent-framework';
import { unknownToolResult } from './unknown-tool.js';
import { workspaceReadFields } from '../workspace-read-result.js';
import { storedInjectionMarkOf } from '@animalabs/agent-framework';
import { storedInjectionLabel } from '../stored-injection.js';
import { speakerOf } from '../speaker.js';
import type { ServerWebSocket } from 'bun';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, normalize, dirname, sep as pathSep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Recipe } from '../recipe.js';
import type { SessionManager } from '../session-manager.js';
import type { BranchState } from '../commands.js';
import type { CallLedger } from '../call-ledger.js';
import type { QuotaMeter } from '../quota-meter.js';
import type { CredentialMonitor } from '../credential-state.js';
import { handleCommand } from '../commands.js';
import {
  PANEL_OPS_THAT_CHANGE_THE_SESSION,
  refusedForAnotherSession,
  refusedWhileSwitching,
  switchLeftForStop,
  trackOperatorWork,
} from '../session-switch.js';
import { parseCommand } from '../command-name.js';
import { AgentTreeReducer, type AgentTreeSnapshot } from '../state/agent-tree-reducer.js';
import { FleetTreeAggregator } from '../state/fleet-tree-aggregator.js';
import { TurnInterrupts, interruptAgents, interruptSubagents } from '../state/turn-interrupt.js';
import type { FleetModule } from './fleet-module.js';
import type { WireEvent } from './fleet-types.js';
import {
  WEB_PROTOCOL_VERSION,
  isChildScope,
  isClientMessage,
  type WebUiServerMessage,
  type WebUiClientMessage,
  type WelcomeMessage,
  type WelcomeMessageEntry,
  type RequestHistoryMessage,
  type TokenUsage,
  type CallLedgerSnapshot,
  type McplListMessage,
  type SettingsStateMessage,
  type PinsListMessage,
  type BranchesListMessage,
  type LessonsListMessage,
  type HostModeSnapshot,
  type RollbackMessage,
  type SuppressMessage,
  type HostQuiesceMessage,
  type HostResumeMessage,
  type RequestOperatorLogMessage,
  type OperatorLogEntryWire,
} from '../web/protocol.js';
import {
  readMcplServersFile,
  saveMcplServers,
  DEFAULT_CONFIG_PATH,
} from '../mcpl-config.js';
import {
  resolveAgent,
  buildMediaBlock,
  buildMcplSnapshot,
  buildToolClassesSnapshot,
  buildSettingsState,
  buildPinsSnapshot,
  buildHealthSnapshot,
  buildQuotaSnapshot,
  buildCredentialSnapshot,
  applyCredentialAction,
  buildContextCoverage,
  buildContextMakeup,
  buildContextCurve,
  buildContextMaintenance,
  runContextPreview,
  buildDebugContext,
  notifyAgentOfSettingsChange,
  applySettingsUpdate,
  applySettingsReset,
  applySettingsCancelTransition,
  applyPinAdd,
  applyPinRemove,
  PanelError,
  type PanelAppRef,
  type McplLiveServer,
} from '../web/panel-data.js';
import { loadRecipeDetailed } from '../recipe.js';
import {
  ObserverRegistry,
  ObserverSessions,
  closeConnectionsWithoutGrant,
  sessionTokenFromRequest,
  clientHolds,
  frameScopes,
  filterEntryForScopes,
  frameWithoutFailureText,
  keepNamedStrings,
  scopeWelcome,
  CREDENTIAL_STRINGS,
  HEALTH_STRINGS,
  QUOTA_STRINGS,
  type KeptStrings,
  type ObserverScope,
  type ObserverHelloIdentity,
  streamEndedFor,
} from './web-ui-observers.js';

export interface WebUiAppRef {
  framework: AgentFramework;
  frameworkSessionId: string;
  sessionManager: SessionManager;
  recipe: Recipe;
  branchState: BranchState;
  switchSession(id: string): Promise<unknown>;
  switching?: boolean;
}

export interface WebUiModuleConfig {
  port?: number;
  host?: string;
  basicAuth?: { username: string; password: string };
  staticDir?: string;
  allowedOrigins?: string[];
  observersPath?: string;
  callLedger?: CallLedger;
  quotaMeter?: QuotaMeter;
  credentials?: CredentialMonitor;
  subscriptionUnmetered?: boolean;
}

interface WsData {
  id: number;
  authed: boolean;
  host: string;
}

interface ClientState {
  id: number;
  ws: ServerWebSocket<WsData>;
  welcomed: boolean;
  auth: 'full' | 'pending' | 'observer';
  scopes: Set<ObserverScope> | null;
  label?: string;
  observerKey?: string;
  authTimer?: ReturnType<typeof setTimeout>;
  peeks: Map<string, () => void>;
}

const DEFAULT_PORT = 7340;

const REPLY_FLUSH_BEFORE_SIGTERM_MS = 150;

const FLEET_REQUEST_TTL_MS = 30_000;

const BUNDLE_REMEDY =
  'In a clone, run `bun run build:web` in its root; an install from npm carries the bundle built, so there, install the package again.';

const HTTP_PANEL_OPS: Record<string, string> = {
  '/debug/context/makeup': 'context-makeup',
  '/debug/context/coverage': 'context-coverage',
  '/debug/context/curve': 'context-curve',
  '/debug/context/preview': 'context-preview',
  '/debug/context/maintenance': 'context-maintenance',
  '/debug/context': 'debug-context',
  '/debug/tool-classes': 'tool-classes',
  '/healthz': 'health',
  '/quota': 'quota',
  '/credential': 'credential',
};

const HEALTH_ROUTE_STRINGS: ReadonlyMap<string, KeptStrings> = new Map<string, KeptStrings>([
  ['/healthz', HEALTH_STRINGS],
  ['/quota', QUOTA_STRINGS],
  ['/credential', CREDENTIAL_STRINGS],
]);

function refusalReply(
  message: WebUiClientMessage,
  refusal: (what: string) => string | null,
): WebUiServerMessage | null {
  switch (message.type) {
    case 'rollback':
    case 'suppress': {
      const error = refusal(message.type);
      return error ? { type: 'surgery-result', corrId: message.corrId, op: message.type, ok: false, error } : null;
    }
    case 'fleet-stop':
    case 'fleet-restart':
    case 'cancel-subagent': {
      const text = refusal(`${message.type} ${message.name}`);
      return text ? { type: 'command-result', lines: [{ text, style: 'tool' }] } : null;
    }
    case 'host-quiesce':
    case 'host-resume': {
      const text = refusal(message.type);
      return text ? { type: 'error', corrId: message.corrId, message: text } : null;
    }
    default: {
      if (!PANEL_OPS_THAT_CHANGE_THE_SESSION.has(message.type)) return null;
      if (isChildScope((message as { scope?: string }).scope)) return null;
      const text = refusal(message.type);
      return text ? { type: 'error', message: text } : null;
    }
  }
}

export function switchRefusalFor(
  app: { switching?: boolean },
  message: WebUiClientMessage,
): WebUiServerMessage | null {
  if (message.type === 'cancel-subagent') return null;
  return refusalReply(message, (what) => refusedWhileSwitching(app, what));
}

const CHANGES_STAMPED_WITH_THEIR_SESSION: ReadonlySet<string> = new Set([
  'rollback',
  'suppress',
  'cancel-subagent',
  ...PANEL_OPS_THAT_CHANGE_THE_SESSION,
]);

export function sessionRefusalFor(
  app: Pick<WebUiAppRef, 'frameworkSessionId'> & { sessionManager: Pick<SessionManager, 'findSession'> },
  message: WebUiClientMessage,
): WebUiServerMessage | null {
  if (!CHANGES_STAMPED_WITH_THEIR_SESSION.has(message.type)) return null;
  const chosenIn = (message as { sessionId?: string }).sessionId;
  if (chosenIn === undefined) return null;
  return refusalReply(message, (what) => refusedForAnotherSession(app.frameworkSessionId, app.sessionManager, chosenIn, what));
}

function panelErrorResponse(err: unknown): Response {
  const status = err instanceof PanelError ? err.status : 500;
  return Response.json(
    { error: err instanceof Error ? err.message : String(err) },
    { status },
  );
}

function panelParamsFromUrl(url: URL): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const agent = url.searchParams.get('agent');
  if (agent) params.agent = agent;
  const budget = url.searchParams.get('budget');
  if (budget !== null) params.budget = Number(budget);
  const tail = url.searchParams.get('tail');
  if (tail !== null) params.tail = Number(tail);
  const render = url.searchParams.get('render');
  if (render !== null && render !== '0' && render !== 'false') params.render = true;
  const inj = url.searchParams.get('injections');
  if (inj !== null && inj !== '0' && inj !== 'false') params.injections = true;
  return params;
}

const WELCOME_HISTORY_LIMIT = 200;
const AUTOSTART_RECORD_WAIT_MS = 1_000;
const HISTORY_PAGE_DEFAULT = 200;
const HISTORY_PAGE_MAX = 500;
const HISTORY_READ_BACK_WINDOWS = 10;

export { buildContextCoverageSnapshot, type ContextCoverageSnapshot } from '../web/panel-data.js';

interface SurgeryCapableFramework {
  rollbackToMessage?: (
    agentName: string,
    opts: { messageId: string; requester?: { via: string; name?: string }; note?: string },
  ) => Promise<{
    sourceBranch: string;
    targetBranch: string;
    messagesRemoved: number;
    lastVisible?: { participant?: string; role?: string; preview?: string } | null;
  }>;
  suppressMessages?: (
    agentName: string,
    opts: { messageIds: string[]; requester?: { via: string; name?: string }; note?: string },
  ) => Promise<{
    sourceBranch: string;
    targetBranch: string;
    messagesRemoved: number;
    lastVisible?: { participant?: string; role?: string; preview?: string } | null;
  }>;
  quiesce?: (opts?: Record<string, unknown>) => Promise<unknown>;
  resume?: (opts?: Record<string, unknown>) => Promise<unknown>;
  getHostModeStatus?: () => unknown;
  recordOperatorAction?: (entry: Omit<OperatorLogEntryWire, 'at'>) => unknown;
  getOperatorLog?: (opts?: { limit?: number }) => OperatorLogEntryWire[];
  getOperatorLogPath?: () => string | undefined;
}

interface WindowCapableCm {
  getMessageCount(): number;
  getMessageWindow(
    offset: number,
    limit: number,
    opts?: { resolveBlobs?: boolean; alignToBodyGroups?: boolean },
  ): { messages: unknown[]; startIndex: number; totalCount: number };
  onMessage?(listener: (event: { type: string; message?: unknown }) => void): () => void;
}

const DEFAULT_HOST = '0.0.0.0';
const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost']);
const NOT_LOOPBACK = 'Forbidden: without basicAuth this Web UI answers only loopback\'s own names (127.0.0.1, ' +
  'localhost, [::1]). Set basicAuth to serve it under another name.';

const HOST_FORM = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d+)?$/i;

const unbracketed = (name: string) => name.replace(/^\[(.*)\]$/, '$1');

function namesLoopback(host: string | null): boolean {
  const name = host?.match(HOST_FORM)?.[1];
  return name !== undefined && LOOPBACK_NAMES.has(unbracketed(name.toLowerCase()));
}

function isOrigin(origin: unknown): origin is string {
  if (typeof origin !== 'string' || !URL.canParse(origin)) return false;
  const { protocol } = new URL(origin);
  return protocol === 'http:' || protocol === 'https:';
}

function isLoopbackOrigin(origin: unknown): boolean {
  return isOrigin(origin) && LOOPBACK_NAMES.has(unbracketed(new URL(origin).hostname));
}

interface SharedServerState {
  server: ReturnType<typeof Bun.serve>;
  interrupts?: TurnInterrupts;
  stopFollowing?: () => void;
  port: number;
  host: string;
  staticRoot: string;
  basicAuth?: { username: string; password: string };
  allowedOrigins: string[];
  clients: Map<number, ClientState>;
  nextClientId: number;
  observers: ObserverRegistry | null;
  observerSessions: ObserverSessions;
  latestUsage: TokenUsage;
  parentUsage: TokenUsage;
  childUsage: Map<string, TokenUsage>;
  latestPerAgentCost: import('../web/protocol.js').PerAgentCost[];
  latestCallLedger?: CallLedgerSnapshot;
  callLedgerDetacher: (() => void) | null;
  app: WebUiAppRef | null;
  treeAggregator: FleetTreeAggregator | null;
  fleetEventDetacher: (() => void) | null;
  messageListenerDetacher: (() => void) | null;
  childRecipeCache: Map<string, { name: string; description?: string; version?: string; agentModel?: string }>;
  autoStartRecords: Promise<void> | null;
  bindGeneration: number;
  pendingFleetRequests: Map<string, { clientId: number; kind: string; expiresAt: number }>;
}

let sharedServer: SharedServerState | null = null;

export function interruptPage(
  agentNames: readonly string[],
  isSubagent: (agentName: string) => boolean,
  interrupts: Pick<TurnInterrupts, 'interrupt'> | undefined,
  stopRuns: () => number,
): string {
  if (!interrupts) return interruptReply(stopRuns(), [], []);
  const reason = 'interrupted from the Web UI';
  const others = agentNames.filter((name) => !isSubagent(name));
  const subagents = interruptSubagents(agentNames, isSubagent, interrupts, stopRuns, reason);
  const rest = interruptAgents(others, interrupts, reason);
  return interruptReply(subagents.stopped, [...subagents.aborted, ...rest.aborted], [...subagents.deferred, ...rest.deferred]);
}

export function interruptReply(
  subagentsStopped: number,
  aborted: readonly string[],
  deferred: readonly string[],
): string {
  const parts = [
    ...(subagentsStopped > 0 ? [`${subagentsStopped} subagent(s) stopped`] : []),
    ...(deferred.length > 0 ? [`${deferred.join(', ')} stopping as soon as ${deferred.length === 1 ? 'its turn' : 'their turns'} can be aborted`] : []),
  ];
  if (parts.length > 0) return `interrupted — ${parts.join('; ')}`;
  return aborted.length > 0 ? 'interrupted' : 'no turn interrupted';
}

/** An openable URL for a bind address: IPv6 literals (the `::1` loopback
 *  bind, say) need brackets, or the port reads as part of the address. */
export function webUiHttpUrl(host: string, port: number): string {
  const literal = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${literal}:${port}`;
}

export class WebUiModule implements Module {
  readonly name = 'webui';

  private readonly config: WebUiModuleConfig;

  private readonly staticRoot: string;

  private observerPollMs: number | undefined;

  constructor(config: WebUiModuleConfig = {}) {
    this.config = {
      ...config,
      basicAuth: config.basicAuth || undefined,
      allowedOrigins: config.allowedOrigins ?? undefined,
    };
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const packageRoot = resolve(moduleDir, '..', '..');
    this.staticRoot = resolve(config.staticDir ?? join(packageRoot, 'dist', 'web'));
  }

  async start(_ctx: ModuleContext): Promise<void> {
    if (sharedServer) {
      return;
    }

    const port = this.config.port ?? DEFAULT_PORT;
    const host = this.config.host ?? DEFAULT_HOST;
    this.assertCredentials();
    this.assertSafeBind(host);
    this.assertOriginCheck();

    const state: SharedServerState = {
      server: undefined as unknown as ReturnType<typeof Bun.serve>,
      port,
      host,
      staticRoot: this.staticRoot,
      basicAuth: this.config.basicAuth,
      allowedOrigins: this.config.allowedOrigins ?? defaultAllowedOrigins(port),
      clients: new Map(),
      nextClientId: 1,
      observers: this.config.observersPath ? new ObserverRegistry(this.config.observersPath, this.observerPollMs) : null,
      observerSessions: new ObserverSessions(),
      latestUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      parentUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      childUsage: new Map(),
      latestPerAgentCost: [],
      latestCallLedger: this.config.callLedger?.snapshot(),
      callLedgerDetacher: null,
      pendingFleetRequests: new Map(),
      childRecipeCache: new Map(),
      autoStartRecords: null,
      bindGeneration: 0,
      app: null,
      treeAggregator: null,
      fleetEventDetacher: null,
      messageListenerDetacher: null,
    };
    const observers = state.observers;
    observers?.start(() => {
      const ended = state.observerSessions.narrowToGrants((key) => observers.liveScopes(key));
      const closed = closeConnectionsWithoutGrant(state.clients.values(), observers);
      if (closed > 0 || ended > 0) {
        console.error(`[webui-observers] closed ${closed} observer connection(s) whose grant is gone, expired or narrowed, and ended ${ended} observer session(s) whose grant is gone, expired or keeps none of their scopes`);
      }
    });
    state.server = Bun.serve({
      port,
      hostname: host,
      fetch: (req, server) => this.handleHttp(req, server),
      websocket: {
        open: (ws) => this.onWsOpen(ws as ServerWebSocket<WsData>),
        message: (ws, msg) => this.onWsMessage(ws as ServerWebSocket<WsData>, msg),
        close: (ws) => this.onWsClose(ws as ServerWebSocket<WsData>),
      },
    });
    // With port 0 the OS picks the port, and Bun.serve gives it as `.port`,
    // which Bun's types make optional (undefined on a unix socket).
    const boundPort = state.server.port ?? port;
    state.port = boundPort;
    if (this.config.allowedOrigins === undefined) {
      state.allowedOrigins = defaultAllowedOrigins(boundPort);
    }
    sharedServer = state;
    if (!existsSync(join(state.staticRoot, 'index.html'))) {
      console.warn(
        `[webui] bundle not found at ${state.staticRoot}: the Web UI will answer 503 until it's there. ` +
        BUNDLE_REMEDY,
      );
    }

    // agent-framework traces usage only for agents' turns, not for the other
    // calls through the adapter, such as compression's, so the panel follows
    // the adapter's ledger.
    state.callLedgerDetacher = this.config.callLedger?.onUpdate((ledger) => {
      state.latestCallLedger = ledger;
      this.broadcast({ type: 'call-ledger', ledger });
    }) ?? null;

    console.log(`[webui] listening on ${webUiHttpUrl(host, boundPort)}`);
  }

  async stop(): Promise<void> {
    if (!sharedServer) return;
    sharedServer.fleetEventDetacher?.();
    sharedServer.fleetEventDetacher = null;
    sharedServer.messageListenerDetacher?.();
    sharedServer.messageListenerDetacher = null;
    sharedServer.treeAggregator?.dispose();
    sharedServer.treeAggregator = null;
    sharedServer.app = null;
  }

  listeningUrl(): string | null {
    if (!sharedServer) return null;
    return webUiHttpUrl(sharedServer.host, sharedServer.port);
  }

  getTools(): ToolDefinition[] { return []; }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return unknownToolResult(this, call.name);
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  setApp(app: WebUiAppRef): void {
    if (!sharedServer) return;
    const ss = sharedServer;
    ss.app = app;
    ss.interrupts = new TurnInterrupts((agentName, reason) => app.framework.abortInference(agentName, reason));

    ss.fleetEventDetacher?.();
    ss.fleetEventDetacher = null;
    ss.messageListenerDetacher?.();
    ss.messageListenerDetacher = null;
    ss.treeAggregator?.dispose();
    ss.treeAggregator = null;
    ss.autoStartRecords = null;
    ss.bindGeneration++;

    // agent-framework traces `message:added` only for messages added from
    // outside a turn, never for an agent's turns or its tool results, so the
    // pushes follow the message store, which hears every message.
    const cm0 = app.framework.getAllAgents()[0]?.getContextManager() as unknown as WindowCapableCm | undefined;
    if (cm0 && typeof cm0.onMessage === 'function' && typeof cm0.getMessageCount === 'function') {
      ss.messageListenerDetacher = cm0.onMessage((ev) => {
        if (ev.type !== 'add' || !ev.message) return;
        try {
          const entry = toWireEntry(ev.message as MessageLike, cm0.getMessageCount() - 1);
          const push: WebUiServerMessage = { type: 'message-appended', entry };
          for (const c of ss.clients.values()) {
            if (!c.welcomed) continue;
            if (c.scopes === null) { this.send(c, push); continue; }
            const filtered = filterEntryForScopes(entry, c.scopes);
            if (filtered) this.send(c, { type: 'message-appended', entry: filtered });
          }
        } catch (err) {
          console.error('[webui] message-appended projection failed:', err);
        }
      });
    }

    ss.latestPerAgentCost = this.collectPerAgentCost();

    ss.parentUsage = this.snapshotParentUsage();
    ss.childUsage.clear();
    ss.latestUsage = aggregateFleetUsage(ss);

    // A stopped agent-framework keeps its trace listeners, so the
    // subscription to the framework followed before a session switch ends
    // here.
    ss.stopFollowing?.();
    ss.stopFollowing = app.framework.onTrace((event: TraceEvent) => this.fanOutTrace(event));

    const fleetMod = app.framework
      .getAllModules()
      .find((m) => m.name === 'fleet') as FleetModule | undefined;

    if (fleetMod) {
      const agg = new FleetTreeAggregator(fleetMod);
      ss.treeAggregator = agg;
      const launching = fleetMod.autoStartLaunching();
      for (const childName of new Set([...fleetMod.getChildren().keys(), ...launching])) {
        agg.registerChild(childName);
      }
      if (launching.size > 0) ss.autoStartRecords = within(fleetMod.autoStartRecorded(), AUTOSTART_RECORD_WAIT_MS);

      ss.fleetEventDetacher = fleetMod.onChildEvent('*', (childName, event) =>
        this.handleFleetEvent(childName, event),
      );
    }

    for (const client of sharedServer!.clients.values()) {
      client.welcomed = false;
      void this.sendWelcome(client);
    }
  }

  private handleFleetEvent(childName: string, event: WireEvent): void {
    if (sharedServer?.treeAggregator) {
      const known = new Set(sharedServer?.treeAggregator.getAllChildNames());
      if (!known.has(childName)) {
        sharedServer?.treeAggregator.registerChild(childName);
      }
    }

    const eType = (event as { type?: unknown }).type;
    const corrId = (event as { corrId?: unknown }).corrId;
    if (
      typeof eType === 'string'
      && typeof corrId === 'string'
      && (eType === 'lessons-snapshot'
        || eType === 'workspace-mounts-snapshot'
        || eType === 'workspace-tree-snapshot'
        || eType === 'workspace-file-snapshot'
        || eType === 'cancel-subagent-result')
    ) {
      this.routeChildSnapshotResponse(eType, corrId, childName, event as Record<string, unknown>);
      return;
    }

    if (eType === 'panel-response' || eType === 'update-response') return;

    let usageChanged = false;
    if (eType === 'usage:updated') {
      const totalsObj = (event as unknown as { totals?: unknown }).totals;
      const parsed = parseUsageTotals(totalsObj);
      if (parsed) {
        sharedServer!.childUsage.set(childName, parsed);
        usageChanged = true;
      }
    } else if (eType === 'lifecycle') {
      const phase = (event as { phase?: unknown }).phase;
      if (phase === 'exiting' || phase === 'exited') {
        if (sharedServer!.childUsage.delete(childName)) usageChanged = true;
      }
    }

    let usageMsg: WebUiServerMessage | null = null;
    if (usageChanged) {
      sharedServer!.latestUsage = aggregateFleetUsage(sharedServer!);
      usageMsg = {
        type: 'usage',
        usage: sharedServer!.latestUsage,
        ...(sharedServer!.latestPerAgentCost.length > 0
          ? { perAgentCost: sharedServer!.latestPerAgentCost }
          : {}),
      };
    }

    if (sharedServer!.clients.size === 0) return;
    const ended = streamEndedFor(event as unknown as { type: string; agentName?: unknown });
    this.broadcast({
      type: 'child-event',
      childName,
      event: event as unknown as { type: string; [k: string]: unknown },
    }, ended ? { type: 'child-event', childName, event: { ...ended } } : null);
    if (usageMsg) this.broadcast(usageMsg);
  }

  private routeChildSnapshotResponse(
    eType: string,
    corrId: string,
    childName: string,
    event: Record<string, unknown>,
  ): void {
    if (!sharedServer) return;
    const entry = sharedServer.pendingFleetRequests.get(corrId);
    if (!entry) return;
    sharedServer.pendingFleetRequests.delete(corrId);
    const client = sharedServer.clients.get(entry.clientId);
    if (!client) return;

    if (eType === 'lessons-snapshot') {
      this.send(client, {
        type: 'lessons-list',
        scope: childName,
        loaded: Boolean(event.loaded),
        lessons: (event.lessons as LessonsListMessage['lessons']) ?? [],
      });
      return;
    }
    if (eType === 'workspace-mounts-snapshot') {
      this.send(client, {
        type: 'workspace-mounts',
        scope: childName,
        loaded: Boolean(event.loaded),
        mounts: (event.mounts as Array<{ name: string; path: string; mode: string }>) ?? [],
      });
      return;
    }
    if (eType === 'workspace-tree-snapshot') {
      this.send(client, {
        type: 'workspace-tree',
        scope: childName,
        mount: String(event.mount ?? ''),
        entries: (event.entries as Array<{ path: string; size: number }>) ?? [],
      });
      return;
    }
    if (eType === 'workspace-file-snapshot') {
      const errStr = typeof event.error === 'string' ? event.error : undefined;
      if (errStr) {
        this.send(client, { type: 'error', message: `read failed: ${errStr}` });
        return;
      }
      this.send(client, {
        type: 'workspace-file',
        scope: childName,
        path: String(event.path ?? ''),
        totalLines: Number(event.totalLines ?? 0),
        fromLine: Number(event.fromLine ?? 1),
        toLine: Number(event.toLine ?? 0),
        content: String(event.content ?? ''),
        truncated: Boolean(event.truncated),
      });
      return;
    }
    if (eType === 'cancel-subagent-result') {
      const name = String(event.name ?? '');
      const cancelled = Boolean(event.cancelled);
      const reason = typeof event.reason === 'string' ? event.reason : undefined;
      this.send(client, {
        type: 'command-result',
        lines: [{
          text: cancelled
            ? `cancelled subagent ${name}`
            : `subagent ${name} not cancelled${reason ? ` (${reason})` : ''}`,
          style: cancelled ? 'system' : 'tool',
        }],
      });
      return;
    }
  }

  private broadcast(frame: WebUiServerMessage, standIn?: WebUiServerMessage | null): void {
    if (!sharedServer) return;
    const scopes = frameScopes(frame);
    const fallback = standIn ? { frame: standIn, scopes: frameScopes(standIn) } : null;
    let withoutText: WebUiServerMessage | undefined;
    for (const client of sharedServer.clients.values()) {
      if (!client.welcomed) continue;
      if (clientHolds(client, scopes)) {
        this.send(client, clientHolds(client, ['ops']) ? frame : (withoutText ??= frameWithoutFailureText(frame)));
      } else if (fallback && clientHolds(client, fallback.scopes)) this.send(client, fallback.frame);
    }
  }

  private sendScoped(client: ClientState, frame: WebUiServerMessage): void {
    this.send(client, clientHolds(client, ['ops']) ? frame : frameWithoutFailureText(frame));
  }

  private fanOutTrace(event: TraceEvent): void {
    sharedServer!.interrupts?.onTrace(event as unknown as { type: string; agentName?: unknown });
    if (event.type === 'usage:updated') {
      const totalsObj = (event as unknown as { totals?: unknown }).totals;
      const parsed = parseUsageTotals(totalsObj);
      if (parsed) sharedServer!.parentUsage = parsed;
      sharedServer!.latestUsage = aggregateFleetUsage(sharedServer!);
      sharedServer!.latestPerAgentCost = this.collectPerAgentCost();
    }

    if (event.type === 'message:added') {
      const e = event as unknown as { messageId: string; source: string };
      void this.maybeEmitTrigger(e.messageId, e.source);
    }

    if (sharedServer!.clients.size === 0) return;
    this.broadcast({
      type: 'trace',
      event: event as unknown as { type: string; [k: string]: unknown },
    }, streamEndedFor(event as unknown as { type: string; agentName?: unknown }));
    if (event.type === 'usage:updated') {
      this.broadcast({
        type: 'usage',
        usage: sharedServer!.latestUsage,
        ...(sharedServer!.latestPerAgentCost.length > 0
          ? { perAgentCost: sharedServer!.latestPerAgentCost }
          : {}),
      });
    }
  }

  private async loadChildRecipeInfo(
    fleet: FleetModule,
    childName: string,
  ): Promise<{ name: string; description?: string; version?: string; agentModel?: string } | undefined> {
    const child = fleet.getChildren().get(childName);
    if (!child) return undefined;
    const path = child.recipePath;
    if (!path) return undefined;
    const cache = sharedServer?.childRecipeCache;
    if (cache?.has(path)) return cache.get(path);
    try {
      const recipe = (await loadRecipeDetailed(path, { fetchSystemPrompt: false })).recipe;
      const info = {
        name: recipe.name,
        ...(recipe.description ? { description: recipe.description } : {}),
        ...(recipe.version ? { version: recipe.version } : {}),
        ...(recipe.agent?.model ? { agentModel: recipe.agent.model } : {}),
      };
      cache?.set(path, info);
      return info;
    } catch {
      return undefined;
    }
  }

  private collectPerAgentCost(): import('../web/protocol.js').PerAgentCost[] {
    const snap = this.readSessionUsage();
    if (!snap) return [];
    const out: import('../web/protocol.js').PerAgentCost[] = [];
    for (const agent of snap.byAgent) {
      const c = agent.usage.estimatedCost;
      if (!c) continue;
      out.push({ name: agent.agentName, cost: { total: c.total, currency: c.currency }, inferenceCount: agent.inferenceCount });
    }
    return out;
  }

  private snapshotParentUsage(): TokenUsage {
    const empty: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const snap = this.readSessionUsage();
    return snap ? (parseUsageTotals(snap.totals) ?? empty) : empty;
  }

  private readSessionUsage(): SessionUsageSnapshot | null {
    if (!sharedServer?.app) return null;
    try {
      return sharedServer.app.framework.getSessionUsage();
    } catch {
      return null;
    }
  }

  private async maybeEmitTrigger(messageId: string, source: string): Promise<void> {
    if (!source.startsWith('mcpl:')) return;
    if (!sharedServer?.app) return;
    type Stored = { participant: string; content: ReadonlyArray<unknown>; metadata?: Record<string, unknown>; timestamp: Date };
    let storedMsg: Stored | null;
    try {
      const cm = sharedServer.app.framework.getAllAgents()[0]?.getContextManager();
      if (!cm) return;
      storedMsg = (cm.getMessage(messageId) as Stored | null) ?? null;
    } catch {
      return;
    }
    if (!storedMsg) return;
    if (storedMsg.participant !== 'user') return;

    const md = storedMsg.metadata ?? {};
    const origin = describeTriggerOrigin(source, md);
    const author = extractAuthorName(md);
    const text = extractText(storedMsg.content).slice(0, 500);
    const triggered = Boolean(md.triggered);

    const msg: WebUiServerMessage = {
      type: 'inbound-trigger',
      source,
      origin,
      triggered,
      ...(author ? { author } : {}),
      text,
      timestamp: storedMsg.timestamp.getTime(),
    };
    this.broadcast(msg);
  }

  private async handleHttp(req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> {
    // A page whose own name an attacker resolves to 127.0.0.1 (DNS rebinding)
    // sends that name as its Host, so without basic auth only loopback's are served.
    if (!this.config.basicAuth && !namesLoopback(req.headers.get('host'))) {
      return new Response(NOT_LOOPBACK, { status: 403 });
    }
    const url = new URL(req.url);

    // Every route answers GET and HEAD only; anything else is a 405.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }

    const isRetrievalTraceRoute = url.pathname === '/debug/retrieval'
      || url.pathname === '/debug/retrieval/view';

    const observersActive = sharedServer!.observers?.active() ?? false;

    if (url.pathname === '/ws') {
      // Browsers don't enforce same-origin on `new WebSocket(...)` as they do
      // on fetch, so the Origin check comes first.
      if (!this.checkOrigin(req)) return new Response('Forbidden', { status: 403 });
      // Full authority: basic auth, or the full session cookie /auth/basic
      // mints.
      const wsSession = sharedServer!.observerSessions.lookup(sessionTokenFromRequest(req));
      const basicOk = this.checkAuth(req) || (wsSession?.full ?? false);
      if (!basicOk && !observersActive) return this.unauthorized();
      const id = sharedServer!.nextClientId++;
      const ok = server.upgrade(req, {
        data: { id, authed: basicOk, host: req.headers.get('host') ?? '' } satisfies WsData,
      });
      if (!ok) return new Response('Upgrade failed', { status: 400 });
      // Once upgrade() returns true, Bun has answered with its own 101, and
      // this Response is never sent.
      return new Response(null, { status: 101 });
    }

    // Basic auth, or a full session cookie, opens every route. An observer's
    // session cookie opens routes by its grant's scopes. While observers are
    // active the static app shell is public, since it carries no data.
    const session = sharedServer!.observerSessions.lookup(sessionTokenFromRequest(req));
    const basicOk = this.checkAuth(req) || (session?.full ?? false);
    const operatorAuthenticated = this.config.basicAuth !== undefined && basicOk;
    const sessionScopes = basicOk ? null : session?.scopes ?? null;
    const httpAllowed = (scope: ObserverScope): boolean =>
      basicOk || (sessionScopes?.has(scope) ?? false);
    if (url.pathname === '/auth/basic') {
      if (basicOk) {
        const token = sharedServer!.observerSessions.mint(new Set(), { full: true });
        return new Response(null, {
          status: 302,
          headers: {
            location: '/',
            'set-cookie': `fkm_obs=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 3600}`,
          },
        });
      }
      return this.unauthorized();
    }
    const isStatic = !url.pathname.startsWith('/debug/')
      && url.pathname !== '/curve'
      && url.pathname !== '/healthz'
      && url.pathname !== '/quota'
      && url.pathname !== '/credential'
      && !url.pathname.startsWith('/files/')
      && !url.pathname.startsWith('/media/');
    if (!basicOk && !(observersActive && isStatic) && !sessionScopes) {
      return this.unauthorized(isRetrievalTraceRoute);
    }

    // An observer session's scope for each route: 'debug' for /debug/* and
    // /curve, 'health' for /healthz, /quota and /credential.
    if ((url.pathname.startsWith('/debug/') || url.pathname === '/curve') && !httpAllowed('debug')) {
      return this.unauthorized(isRetrievalTraceRoute);
    }
    if ((url.pathname === '/healthz' || url.pathname === '/quota' || url.pathname === '/credential') && !httpAllowed('health')) {
      return this.unauthorized();
    }
    const keptStrings = httpAllowed('ops') ? undefined : HEALTH_ROUTE_STRINGS.get(url.pathname);
    if (url.pathname.startsWith('/files/') && !basicOk) {
      return this.unauthorized();
    }

    // /debug/retrieval and its view are operator-only: basic auth, or the full
    // session it mints; an observer's 'debug' scope isn't enough.
    if (isRetrievalTraceRoute && !operatorAuthenticated) return this.unauthorized(true);

    if (url.pathname === '/debug/retrieval/view') {
      return new Response(RETRIEVAL_TRACE_PAGE_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        },
      });
    }
    if (url.pathname === '/debug/retrieval') {
      return this.handleRetrievalTraces(url);
    }

    // Every debug and health route takes ?scope=<child>: the request goes to
    // that fleet child, and its JSON comes back as it sent it, with the same
    // URLs and payloads; an observer without 'ops' gets a health route's
    // answer without its failure text from either.
    const scopeParam = url.searchParams.get('scope');
    if (scopeParam && scopeParam !== 'local') {
      const op = HTTP_PANEL_OPS[url.pathname];
      if (op) return this.proxyPanelToChild(scopeParam, op, panelParamsFromUrl(url), keptStrings);
    }

    if (url.pathname === '/debug/context/makeup') {
      return this.handleContextMakeup(url);
    }

    // The context curve: JSON at /debug/context/curve, its page at /curve.
    if (url.pathname === '/debug/context/curve') {
      return this.handleContextCurve(url);
    }
    if (url.pathname === '/debug/context/coverage') {
      return this.handleContextCoverage(url);
    }
    if (url.pathname === '/debug/context/maintenance') {
      return this.handleContextMaintenance();
    }
    if (url.pathname === '/debug/context/preview') {
      return this.handleContextPreview(url);
    }
    if (url.pathname === '/curve') {
      return new Response(CURVE_PAGE_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (url.pathname === '/debug/context') {
      return this.handleDebugContext(url);
    }

    // Each tool's effective MCPL class (RFC-008) and the source that decided
    // it. Every tool offered, or one agent's surface with ?agent=<name>.
    if (url.pathname === '/debug/tool-classes') {
      return this.handleToolClasses(url);
    }

    // A message's own image, at a top-level block path (`<n>`), needs the
    // 'messages' scope; any other path, such as a tool result's image
    // (`<n>.<m>`), needs 'tools' as well.
    if (url.pathname.startsWith('/media/')) {
      if (!httpAllowed('messages')) return this.unauthorized();
      const blockPath = url.pathname.slice('/media/'.length).split('/').slice(1).join('/');
      if (!/^\d+$/.test(blockPath) && !httpAllowed('tools')) return this.unauthorized();
      return this.serveMedia(url);
    }

    // Liveness and health JSON for connectome-doctor and the fleet hub.
    if (url.pathname === '/healthz') {
      const app = this.panelApp();
      if (!app) return Response.json({ error: 'app not bound yet' }, { status: 503 });
      try {
        const snapshot = buildHealthSnapshot(app);
        return Response.json(keptStrings ? keepNamedStrings(snapshot, keptStrings) : snapshot);
      } catch (err) {
        const status = err instanceof PanelError ? err.status : 500;
        const failed = { error: err instanceof Error ? err.message : String(err) };
        return Response.json(keptStrings ? keepNamedStrings(failed, keptStrings) : failed, { status });
      }
    }

    if (url.pathname === '/quota') {
      const app = this.panelApp();
      if (!app) return Response.json({ error: 'app not bound yet' }, { status: 503 });
      const quota = await buildQuotaSnapshot(app);
      return Response.json(keptStrings ? keepNamedStrings(quota, keptStrings) : quota);
    }

    if (url.pathname === '/credential') {
      const app = this.panelApp();
      if (!app) return Response.json({ error: 'app not bound yet' }, { status: 503 });
      const credential = buildCredentialSnapshot(app);
      return Response.json(keptStrings ? keepNamedStrings(credential, keptStrings) : credential);
    }

    // readFileFromDisk keeps the route inside the mount: it refuses a link the
    // mount doesn't follow, and a file whose real path lies outside it.
    if (url.pathname.startsWith('/files/')) {
      return this.serveWorkspaceFile(url.pathname.slice('/files/'.length));
    }

    // Anything still unmatched under /debug/ is a JSON 404, not the app shell.
    if (url.pathname.startsWith('/debug/')) {
      return Response.json({ error: `Unknown debug route: ${url.pathname}` }, { status: 404 });
    }

    // Bundle assets get real 404s: a browser refuses an HTML page served
    // where it expects a module script.
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    return this.serveStatic(requested, { spaFallback: !url.pathname.startsWith('/assets/') });
  }

  private panelApp(): PanelAppRef | null {
    const app = sharedServer?.app;
    if (!app) return null;
    return {
      framework: app.framework,
      recipe: app.recipe,
      callLedger: this.config.callLedger ?? null,
      quotaMeter: this.config.quotaMeter ?? null,
      credentials: this.config.credentials ?? null,
      subscriptionUnmetered: this.config.subscriptionUnmetered === true,
    };
  }

  private fleetModule(): FleetModule | undefined {
    return sharedServer?.app?.framework.getAllModules().find((m) => m.name === 'fleet') as
      | FleetModule | undefined;
  }

  private async proxyPanelToChild(
    childName: string,
    op: string,
    params: Record<string, unknown>,
    keptStrings?: KeptStrings,
  ): Promise<Response> {
    const fleet = this.fleetModule();
    if (!fleet) {
      return Response.json(
        { error: `scope '${childName}' requested but the fleet module is not loaded` },
        { status: 404 },
      );
    }
    const result = await fleet.requestPanel(childName, op, params);
    if (!result.ok) {
      const failed = { error: result.error ?? 'panel request failed' };
      return Response.json(keptStrings ? keepNamedStrings(failed, keptStrings) : failed, { status: result.status ?? 502 });
    }
    return Response.json(keptStrings ? keepNamedStrings(result.data, keptStrings) : result.data);
  }

  /** GET /debug/context/maintenance: counts-only state and bounded history
   *  of periodic context maintenance, with no message or summary text. */
  private handleContextMaintenance(): Response {
    const app = this.panelApp();
    if (!app) return Response.json({ error: 'app not bound yet' }, { status: 503 });
    try {
      return Response.json(buildContextMaintenance(app));
    } catch (err) {
      return panelErrorResponse(err);
    }
  }

  /** Tool names, classes and class sources — no arguments or results. */
  private handleToolClasses(url: URL): Response {
    const app = this.panelApp();
    if (!app) return Response.json({ error: 'app not bound yet' }, { status: 503 });
    try {
      return Response.json(buildToolClassesSnapshot(app, url.searchParams.get('agent') || undefined));
    } catch (err) {
      return panelErrorResponse(err);
    }
  }

  /** Summary-tree coverage and queued work, with no message or summary text. */
  private handleContextCoverage(url: URL): Response {
    const app = this.panelApp();
    if (!app) return Response.json({ error: 'app not bound yet' }, { status: 503 });
    try {
      return Response.json(buildContextCoverage(app, resolveAgent(app, url.searchParams.get('agent') ?? undefined)));
    } catch (err) {
      return panelErrorResponse(err);
    }
  }

  /**
   * A preview of the fold plan at a hypothetical budget and tail, applying
   * nothing:
   *
   *   GET /debug/context/preview?budget=<tokens>[&tail=<tokens>][&agent=<name>][&render=1]
   *
   * A preview is a synchronous compile, which pauses the agent while it
   * runs, so previews run one at a time, with a cooldown after each: a 429
   * is that guard, not a failure.
   */
  private handleContextPreview(url: URL): Response {
    const app = this.panelApp();
    if (!app) return Response.json({ error: 'app not bound yet' }, { status: 503 });
    try {
      const params = panelParamsFromUrl(url);
      return Response.json(runContextPreview(app, resolveAgent(app, params.agent), params));
    } catch (err) {
      return panelErrorResponse(err);
    }
  }

  /**
   * The membrane-normalized request the framework would hand the model if the
   * agent were activated now:
   *
   *   GET /debug/context[?agent=<name>][&injections=1][&pretty=1]
   *
   * By default it commits nothing of its own: no inference, no MCPL calls,
   * and, as any compile does, it releases only a compression hold whose
   * deadline has passed. `?injections=1` gathers the dynamic injections too
   * (lessons, retrieval, MCPL context), which can run inference and fire MCPL
   * `beforeInference` hooks.
   */
  private async handleDebugContext(url: URL): Promise<Response> {
    const app = this.panelApp();
    if (!app) return new Response('Not ready', { status: 503 });
    const params = panelParamsFromUrl(url);
    const pretty = url.searchParams.get('pretty') !== null && url.searchParams.get('pretty') !== '0';
    try {
      const sessionId = sharedServer!.app!.frameworkSessionId;
      const payload = { sessionId, ...await buildDebugContext(app, resolveAgent(app, params.agent), params) };
      return new Response(
        JSON.stringify(payload, null, pretty ? 2 : undefined),
        { headers: { 'content-type': 'application/json' } },
      );
    } catch (err) {
      return panelErrorResponse(err);
    }
  }

  /**
   * GET /debug/context/curve[?agent=<name>]: per-entry provenance of the
   * live compiled window, with a feasibility verdict. The compile is a dry
   * run: it commits no fold resolutions and queues no compression, and, as
   * any compile does, it releases a compression hold whose deadline has
   * passed. No inference of its own, no message writes.
   */
  private async handleContextCurve(url: URL): Promise<Response> {
    const app = this.panelApp();
    if (!app) return new Response('Not ready', { status: 503 });
    try {
      return Response.json(await buildContextCurve(app, resolveAgent(app, url.searchParams.get('agent') ?? undefined)));
    } catch (err) {
      return panelErrorResponse(err);
    }
  }

  private handleRetrievalTraces(url: URL): Response {
    try {
      const app = sharedServer?.app;
      if (!app) return this.retrievalJson({ error: 'app not bound yet' }, { status: 503 });

      const module = app.framework.getAllModules().find(candidate => candidate.name === 'retrieval') as
        | (RetrievalTraceSource & { name: string })
        | undefined;
      if (!module || typeof module.getRetrievalTraces !== 'function') {
        return this.retrievalJson(
          { schemaVersion: 1, enabled: false, includeInputs: false, traces: [] },
        );
      }

      const requestedLimit = Number(url.searchParams.get('limit') ?? '20');
      const limit = Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 20;
      const includeInputs = url.searchParams.get('includeInputs') === '1';
      const traces = module.getRetrievalTraces({ limit, includeInputs });
      return this.retrievalJson({ schemaVersion: 1, enabled: true, includeInputs, traces });
    } catch (error) {
      let message = 'unavailable error';
      try {
        message = error instanceof Error ? error.message : String(error);
      } catch { }
      return this.retrievalJson({ error: message }, { status: 500 });
    }
  }

  private retrievalJson(value: unknown, init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    headers.set('cache-control', 'no-store');
    return Response.json(value, { ...init, headers });
  }

  /**
   * The segment breakdown of the agent's last live compile, beside an exact
   * count of the next request as a preview builds it:
   *
   *   GET /debug/context/makeup[?agent=<name>]
   *
   * The preview commits nothing of its own and, as any compile does,
   * releases a compression hold whose deadline has passed; the count is one
   * count_tokens call.
   */
  private async handleContextMakeup(url: URL): Promise<Response> {
    const app = this.panelApp();
    if (!app) return new Response('Not ready', { status: 503 });
    try {
      const payload = await buildContextMakeup(app, resolveAgent(app, url.searchParams.get('agent') ?? undefined));
      return new Response(
        JSON.stringify(payload, null, 2),
        { headers: { 'content-type': 'application/json' } },
      );
    } catch (err) {
      return panelErrorResponse(err);
    }
  }

  private async serveWorkspaceFile(rest: string): Promise<Response> {
    if (!sharedServer?.app) return new Response('Not ready', { status: 503 });
    const decoded = decodeURIComponent(rest);
    const slash = decoded.indexOf('/');
    if (slash < 0) return new Response('Bad request', { status: 400 });
    const mount = decoded.slice(0, slash);
    const inMountPath = decoded.slice(slash + 1);
    const mountPrefixed = `${mount}/${inMountPath}`;

    const ws = sharedServer.app.framework.getModule('workspace') as WorkspaceModule | undefined;
    if (!ws) return new Response('Workspace not mounted', { status: 503 });
    try {
      const { bytes, realPath } = await ws.readFileFromDisk(mountPrefixed);
      return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'content-type': mimeFor(realPath) } });
    } catch (err) {
      const read = err instanceof WorkspaceReadError ? err : null;
      if (read && ['unknown_mount', 'traversal', 'outside_include', 'other_mount', 'symlink', 'parent_symlink', 'escape'].includes(read.code)) {
        return new Response(read.message, { status: 403 });
      }
      if (read?.code === 'mount_unavailable') return new Response(read.message, { status: 503 });
      return new Response(read?.message ?? 'Not found', { status: 404 });
    }
  }

  private async serveStatic(
    requestedPath: string,
    opts: { spaFallback?: boolean } = {},
  ): Promise<Response> {
    const spaFallback = opts.spaFallback ?? true;
    const root = sharedServer!.staticRoot;
    const safePath = normalize(join(root, requestedPath));
    if (safePath !== root && !safePath.startsWith(root + pathSep)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const s = await stat(safePath);
      if (s.isDirectory()) {
        return this.serveStatic(join(requestedPath, 'index.html'), opts);
      }
      const data = await readFile(safePath);
      return new Response(data, { headers: { 'content-type': mimeFor(safePath), 'cache-control': cacheControlFor(safePath) } });
    } catch {
      if (!spaFallback) {
        return new Response('Not Found', { status: 404 });
      }
      try {
        const indexPath = join(sharedServer!.staticRoot, 'index.html');
        const data = await readFile(indexPath);
        return new Response(data, { headers: { 'content-type': 'text/html', 'cache-control': cacheControlFor(indexPath) } });
      } catch {
        return new Response(
          `WebUI bundle not found at ${sharedServer!.staticRoot}. ${BUNDLE_REMEDY}`,
          { status: 503, headers: { 'content-type': 'text/plain' } },
        );
      }
    }
  }

  private onWsOpen(ws: ServerWebSocket<WsData>): void {
    const id = ws.data.id;
    const client: ClientState = {
      id, ws, welcomed: false, peeks: new Map(),
      auth: ws.data.authed ? 'full' : 'pending',
      scopes: null,
    };
    sharedServer!.clients.set(id, client);

    if (client.auth === 'pending') {
      // The client has 15 s to present a verifiable hello, or the connection
      // closes with 4401; nothing else flows on it until then.
      this.send(client, { type: 'observer-auth-required', host: ws.data.host });
      client.authTimer = setTimeout(() => {
        if (client.auth === 'pending') ws.close(4401, 'observer auth timeout');
      }, 15_000);
      return;
    }

    if (sharedServer?.app) void this.sendWelcome(client);
  }

  private handleObserverHello(client: ClientState, identity: ObserverHelloIdentity): void {
    const registry = sharedServer!.observers;
    const result = registry?.verifyHello(identity, client.ws.data.host) ?? null;
    if (!result) {
      this.send(client, { type: 'error', message: 'observer auth failed' });
      client.ws.close(4401, 'observer auth failed');
      return;
    }
    if (client.authTimer) clearTimeout(client.authTimer);
    client.auth = 'observer';
    client.scopes = result.scopes;
    client.label = result.grant.label;
    client.observerKey = result.grant.key;
    this.send(client, {
      type: 'observer-ack',
      scopes: [...result.scopes],
      sessionToken: sharedServer!.observerSessions.mint(result.scopes, { key: result.grant.key }),
      label: result.grant.label,
    });
    console.error(`[webui-observers] observer connected: ${result.grant.label} scopes=[${[...result.scopes].join(',')}]`);
    if (sharedServer?.app) void this.sendWelcome(client);
  }

  /** Client message types a scoped (non-full) observer may send. */
  private observerMaySend(client: ClientState, type: string): boolean {
    if (client.auth !== 'observer') return false;
    if (type === 'ping') return true;
    if (type === 'request-history') return client.scopes?.has('messages') ?? false;
    if (type === 'request-branches') return client.scopes?.has('messages') ?? false;
    if (type === 'request-host-mode') return client.scopes?.has('health') ?? false;
    if (type === 'request-credential') return client.scopes?.has('health') ?? false;
    if (type === 'request-operator-log') return client.scopes?.has('ops') ?? false;
    return false; // observers are read-only: no user-message/command/mcpl/fleet/surgery
  }

  private requesterFor(client: ClientState): { via: string; name?: string } {
    if (client.auth === 'observer') {
      return { via: 'webui-observer', ...(client.label ? { name: client.label } : {}) };
    }
    return { via: 'webui', name: this.config.basicAuth?.username ?? 'operator' };
  }

  private hostFeatures(): string[] {
    const fw = sharedServer?.app?.framework as unknown as SurgeryCapableFramework | undefined;
    const features = ['media'];
    if (!fw) return features;
    if (typeof fw.rollbackToMessage === 'function') features.push('rollback');
    if (typeof fw.suppressMessages === 'function') features.push('suppress');
    if (typeof fw.quiesce === 'function' && typeof fw.resume === 'function'
      && typeof fw.getHostModeStatus === 'function') features.push('quiesce');
    if (typeof fw.getOperatorLog === 'function') features.push('operator-log');
    return features;
  }

  private hostModeSnapshot(): HostModeSnapshot | null {
    const fw = sharedServer?.app?.framework as unknown as SurgeryCapableFramework | undefined;
    if (!fw || typeof fw.getHostModeStatus !== 'function') return null;
    try {
      const s = (fw.getHostModeStatus() ?? {}) as Record<string, unknown>;
      const mode = typeof s.mode === 'string' ? s.mode
        : s.quiesced === true ? (s.drained === false ? 'quiescing' : 'quiesced')
        : 'serving';
      return {
        mode,
        ...(typeof s.since === 'number' ? { since: s.since } : {}),
        ...(typeof s.reason === 'string' ? { reason: s.reason } : {}),
        ...(typeof s.activeTurns === 'number' ? { activeTurns: s.activeTurns } : {}),
        detail: s,
      };
    } catch {
      return null;
    }
  }

  private broadcastHostMode(): void {
    const hostMode = this.hostModeSnapshot();
    if (!hostMode) return;
    this.broadcast({ type: 'host-mode', hostMode });
  }

  private async handleSurgery(
    client: ClientState,
    op: 'rollback' | 'suppress',
    req: RollbackMessage | SuppressMessage,
  ): Promise<void> {
    const app = sharedServer?.app;
    const panel = this.panelApp();
    if (!app || !panel) return;
    const fw = app.framework as unknown as SurgeryCapableFramework;
    const fn = op === 'rollback' ? fw.rollbackToMessage : fw.suppressMessages;
    if (typeof fn !== 'function') {
      this.send(client, {
        type: 'surgery-result', corrId: req.corrId, op, ok: false,
        error: `this host's agent-framework has no live ${op} — upgrade @animalabs/agent-framework`,
      });
      return;
    }
    let agentName: string;
    try {
      agentName = resolveAgent(panel, req.agent);
    } catch (err) {
      this.send(client, {
        type: 'surgery-result', corrId: req.corrId, op, ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const requester = this.requesterFor(client);
    const note = req.note?.trim() || undefined;
    try {
      const r = op === 'rollback'
        ? await fw.rollbackToMessage!(agentName, {
            messageId: (req as RollbackMessage).messageId,
            requester,
            ...(note ? { note } : {}),
          })
        : await fw.suppressMessages!(agentName, {
            messageIds: (req as SuppressMessage).messageIds,
            requester,
            ...(note ? { note } : {}),
          });
      this.send(client, {
        type: 'surgery-result', corrId: req.corrId, op, ok: true, agent: agentName,
        sourceBranch: r.sourceBranch, targetBranch: r.targetBranch,
        messagesRemoved: r.messagesRemoved, lastVisible: r.lastVisible ?? null,
      });
      await this.materializeConfigMount();
      this.broadcastBranchChanged();
      this.refreshAllWelcomes();
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      this.send(client, {
        type: 'surgery-result', corrId: req.corrId, op, ok: false, agent: agentName,
        error: err instanceof Error ? err.message : String(err),
        ...(typeof code === 'string' ? { code } : {}),
      });
    }
  }

  private async handleHostMode(
    client: ClientState,
    verb: 'quiesce' | 'resume',
    req: HostQuiesceMessage | HostResumeMessage,
  ): Promise<void> {
    const app = sharedServer?.app;
    if (!app) return;
    const fw = app.framework as unknown as SurgeryCapableFramework;
    const fn = verb === 'quiesce' ? fw.quiesce : fw.resume;
    if (typeof fn !== 'function') {
      this.send(client, {
        type: 'error', corrId: req.corrId,
        message: `this host's agent-framework has no ${verb} support — upgrade @animalabs/agent-framework`,
      });
      return;
    }
    const requester = this.requesterFor(client);
    const reason = verb === 'quiesce' ? (req as HostQuiesceMessage).reason?.trim() || undefined : undefined;
    try {
      if (verb === 'quiesce') await fw.quiesce!(reason ? { reason } : {});
      else await fw.resume!({});
      const hostMode = this.hostModeSnapshot();
      fw.recordOperatorAction?.({
        kind: verb,
        requester,
        ...(reason ? { note: reason } : {}),
        ...(hostMode ? { result: { mode: hostMode.mode } } : {}),
      });
      if (hostMode) this.send(client, { type: 'host-mode', corrId: req.corrId, hostMode });
      this.broadcastHostMode();
    } catch (err) {
      let message = err instanceof Error ? err.message : String(err);
      // agent-framework's resume() refuses with ResumeBlockedError, whose
      // verdicts name each agent whose context wouldn't fit.
      const verdicts = (err as { verdicts?: unknown } | null)?.verdicts;
      if (Array.isArray(verdicts) && verdicts.length > 0) {
        const lines = verdicts.map((v) => {
          const vv = v as { agentName?: string; preview?: { reason?: string; transitionReason?: string; transition?: string } };
          const why = vv.preview?.reason ?? vv.preview?.transitionReason ?? vv.preview?.transition ?? 'not feasible';
          return `${vv.agentName ?? '?'}: ${why}`;
        });
        message = `${message} — ${lines.join('; ')}`;
      }
      fw.recordOperatorAction?.({ kind: verb, requester, ...(reason ? { note: reason } : {}), error: message });
      this.send(client, { type: 'error', corrId: req.corrId, message: `${verb} failed: ${message}` });
      this.broadcastHostMode();
    }
  }

  private sendOperatorLog(client: ClientState, req: RequestOperatorLogMessage): void {
    const fw = sharedServer?.app?.framework as unknown as SurgeryCapableFramework | undefined;
    if (!fw || typeof fw.getOperatorLog !== 'function') {
      this.send(client, { type: 'operator-log', corrId: req.corrId, entries: [] });
      return;
    }
    const limit = Math.max(1, Math.min(1000, Math.floor(req.limit ?? 100)));
    try {
      const path = typeof fw.getOperatorLogPath === 'function' ? fw.getOperatorLogPath() : undefined;
      this.send(client, {
        type: 'operator-log', corrId: req.corrId,
        entries: fw.getOperatorLog({ limit }),
        ...(path ? { path } : {}),
      });
    } catch (err) {
      this.send(client, {
        type: 'error', corrId: req.corrId,
        message: `operator log unavailable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** `/media/<messageId>/<blockPath>`: one inline image of a stored message,
   *  as bytes. */
  private async serveMedia(url: URL): Promise<Response> {
    const rest = url.pathname.slice('/media/'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) {
      return Response.json({ error: 'expected /media/<messageId>/<blockPath>' }, { status: 400 });
    }
    let messageId: string;
    try {
      messageId = decodeURIComponent(rest.slice(0, slash));
    } catch {
      return Response.json({ error: 'malformed message id' }, { status: 400 });
    }
    const path = rest.slice(slash + 1);
    const scope = url.searchParams.get('scope') ?? undefined;
    const agent = url.searchParams.get('agent') ?? undefined;
    let data: { mediaType: string; base64: string };
    try {
      if (isChildScope(scope)) {
        const fleet = this.fleetModule();
        if (!fleet) {
          return Response.json({ error: `scope '${scope}' requested but the fleet module is not loaded` }, { status: 404 });
        }
        const r = await fleet.requestPanel(scope, 'media', { messageId, path, ...(agent ? { agent } : {}) });
        if (!r.ok) return Response.json({ error: r.error ?? 'media request failed' }, { status: r.status ?? 502 });
        data = r.data as { mediaType: string; base64: string };
      } else {
        const app = this.panelApp();
        if (!app) return Response.json({ error: 'app not bound yet' }, { status: 503 });
        data = buildMediaBlock(app, resolveAgent(app, agent), { messageId, path });
      }
    } catch (err) {
      return panelErrorResponse(err);
    }
    if (typeof data?.base64 !== 'string' || typeof data?.mediaType !== 'string' || !data.mediaType.startsWith('image/')) {
      return Response.json({ error: 'media payload malformed' }, { status: 502 });
    }
    const bytes = Buffer.from(data.base64, 'base64');
    return new Response(bytes, {
      headers: {
        'content-type': data.mediaType,
        'content-length': String(bytes.length),
        'cache-control': 'private, max-age=86400',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  }

  private onWsMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
    const id = ws.data.id;
    const client = sharedServer!.clients.get(id);
    if (!client) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'));
    } catch {
      this.send(client, { type: 'error', message: 'invalid JSON' });
      return;
    }
    if (!isClientMessage(parsed)) {
      this.send(client, { type: 'error', message: 'unknown message shape' });
      return;
    }

    // A pending connection may send only observer-hello, and a
    // key-authenticated observer only what observerMaySend allows; full
    // clients skip both gates.
    if (parsed.type === 'observer-hello') {
      if (client.auth === 'pending') this.handleObserverHello(client, parsed.identity);
      // hello on an already-authenticated connection is a no-op
      return;
    }
    if (client.auth === 'pending') return;
    if (client.auth === 'observer' && !this.observerMaySend(client, parsed.type)) {
      this.send(client, { type: 'error', message: `forbidden for observer scope (${parsed.type})` });
      return;
    }

    if (!sharedServer?.app) {
      this.send(client, { type: 'error', message: 'host not ready' });
      return;
    }
    const app = sharedServer.app;
    const refused = switchRefusalFor(app, parsed) ?? sessionRefusalFor(app, parsed);
    if (refused) {
      this.send(client, refused);
      if (parsed.type === 'host-quiesce' || parsed.type === 'host-resume') this.broadcastHostMode();
      return;
    }

    switch (parsed.type) {
      case 'ping':
        return;

      case 'user-message':
        sharedServer?.app.framework.pushEvent({
          type: 'external-message',
          source: 'tui',
          content: parsed.content,
          metadata: {},
          triggerInference: true,
        });
        return;

      case 'command': {
        void this.dispatchCommand(client, parsed.command, parsed.corrId);
        return;
      }

      case 'request-history': {
        this.handleRequestHistory(client, parsed);
        return;
      }

      case 'route-to-child': {
        void this.handleRouteToChild(client, parsed.childName, parsed.content);
        return;
      }

      case 'interrupt': {
        if (!sharedServer?.app) return;
        const fw = sharedServer.app.framework;
        const subMod = fw.getAllModules().find((m) => m.name === 'subagent') as
          | { cancelAll(): number; isSubagentAgent(frameworkAgentName: string): boolean }
          | undefined;
        const reply = interruptPage(
          fw.getAllAgents().map((a) => a.name),
          (name) => subMod?.isSubagentAgent(name) ?? false,
          sharedServer.interrupts,
          () => subMod?.cancelAll() ?? 0,
        );
        this.send(client, { type: 'command-result', lines: [{ text: reply, style: 'system' }] });
        return;
      }

      case 'rollback':
        void trackOperatorWork(app, 'rollback', this.handleSurgery(client, 'rollback', parsed));
        return;

      case 'suppress':
        void trackOperatorWork(app, 'suppress', this.handleSurgery(client, 'suppress', parsed));
        return;

      case 'host-quiesce':
        void trackOperatorWork(app, 'host-quiesce', this.handleHostMode(client, 'quiesce', parsed));
        return;

      case 'host-resume':
        void trackOperatorWork(app, 'host-resume', this.handleHostMode(client, 'resume', parsed));
        return;

      case 'request-host-mode': {
        const hostMode = this.hostModeSnapshot();
        this.send(client, {
          type: 'host-mode', corrId: parsed.corrId,
          hostMode: hostMode ?? { mode: 'unsupported' },
        });
        return;
      }

      case 'request-operator-log':
        this.sendOperatorLog(client, parsed);
        return;

      case 'subscribe-peek':
        this.handleSubscribePeek(client, parsed.scope, parsed.active);
        return;

      case 'cancel-subagent': {
        if (!sharedServer?.app) return;
        if (parsed.childName) {
          this.routeFleetRequest(client, parsed.childName, 'cancel-subagent',
            (corrId, fleet) => fleet.cancelSubagentOnChild(parsed.childName!, parsed.name, corrId));
          return;
        }
        const subMod = sharedServer.app.framework
          .getAllModules()
          .find((m) => m.name === 'subagent') as
          | { cancelSubagent(name: string): boolean }
          | undefined;
        if (!subMod) {
          this.send(client, { type: 'error', message: 'subagent module not loaded' });
          return;
        }
        const ok = subMod.cancelSubagent(parsed.name);
        this.send(client, {
          type: 'command-result',
          lines: [{
            text: ok ? `cancelled subagent ${parsed.name}` : `subagent ${parsed.name} not running`,
            style: ok ? 'system' : 'tool',
          }],
        });
        return;
      }

      case 'fleet-stop':
      case 'fleet-restart': {
        void trackOperatorWork(app, `${parsed.type} ${parsed.name}`, this.handleFleetControl(client, parsed.type, parsed.name));
        return;
      }

      case 'quit-confirm': {
        void this.handleQuitConfirm(parsed.action);
        return;
      }

      case 'request-lessons': {
        if (parsed.scope && parsed.scope !== 'local') {
          this.routeFleetRequest(client, parsed.scope, 'lessons',
            (corrId, fleet) => fleet.requestLessons(parsed.scope!, corrId));
        } else {
          this.sendLessonsList(client);
        }
        return;
      }

      case 'request-mcpl': {
        if (isChildScope(parsed.scope)) {
          void this.sendScopedMcpl(client, parsed.scope!);
        } else {
          this.sendMcplList(client);
        }
        return;
      }

      case 'request-branches': {
        this.sendBranchesList(client);
        return;
      }

      case 'mcpl-add': {
        try {
          const servers = readMcplServersFile(DEFAULT_CONFIG_PATH);
          servers[parsed.id] = {
            command: parsed.command,
            ...(parsed.args && parsed.args.length > 0 ? { args: parsed.args } : {}),
            ...(parsed.env && Object.keys(parsed.env).length > 0 ? { env: parsed.env } : {}),
            ...(parsed.toolPrefix ? { toolPrefix: parsed.toolPrefix } : {}),
          };
          saveMcplServers(DEFAULT_CONFIG_PATH, servers);
        } catch (err) {
          this.send(client, { type: 'error', message: `mcpl-add failed: ${err instanceof Error ? err.message : String(err)}` });
          return;
        }
        this.sendMcplList(client);
        return;
      }

      case 'mcpl-remove': {
        try {
          const servers = readMcplServersFile(DEFAULT_CONFIG_PATH);
          if (!(parsed.id in servers)) {
            this.send(client, { type: 'error', message: `server '${parsed.id}' not found` });
            return;
          }
          delete servers[parsed.id];
          saveMcplServers(DEFAULT_CONFIG_PATH, servers);
        } catch (err) {
          this.send(client, { type: 'error', message: `mcpl-remove failed: ${err instanceof Error ? err.message : String(err)}` });
          return;
        }
        this.sendMcplList(client);
        return;
      }

      case 'mcpl-set-env': {
        try {
          const servers = readMcplServersFile(DEFAULT_CONFIG_PATH);
          const entry = servers[parsed.id];
          if (!entry) {
            this.send(client, { type: 'error', message: `server '${parsed.id}' not found` });
            return;
          }
          if (Object.keys(parsed.env).length === 0) delete entry.env;
          else entry.env = parsed.env;
          saveMcplServers(DEFAULT_CONFIG_PATH, servers);
        } catch (err) {
          this.send(client, { type: 'error', message: `mcpl-set-env failed: ${err instanceof Error ? err.message : String(err)}` });
          return;
        }
        this.sendMcplList(client);
        return;
      }

      case 'request-pins': {
        if (isChildScope(parsed.scope)) {
          void this.sendScopedPins(client, parsed.scope!, parsed.agent);
        } else {
          this.sendPinsList(client, parsed.agent);
        }
        return;
      }

      case 'pin-add': {
        if (isChildScope(parsed.scope)) {
          void this.applyScopedPinMutation(client, parsed.scope!, 'pin-add', {
            ...(parsed.agent ? { agent: parsed.agent } : {}),
            ...(parsed.kind ? { kind: parsed.kind } : {}),
            firstMessageId: parsed.firstMessageId,
            ...(parsed.lastMessageId ? { lastMessageId: parsed.lastMessageId } : {}),
            ...(parsed.level !== undefined ? { level: parsed.level } : {}),
            ...(parsed.maxLevel !== undefined ? { maxLevel: parsed.maxLevel } : {}),
            ...(parsed.name ? { name: parsed.name } : {}),
          });
          return;
        }
        const app = this.panelApp()!;
        const agentName = resolveAgent(app, parsed.agent);
        try {
          applyPinAdd(app, agentName, parsed as unknown as Record<string, unknown>);
        } catch (err) {
          this.send(client, {
            type: 'error',
            message: `pin-add failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
        this.broadcastPinsList(agentName);
        return;
      }

      case 'pin-remove': {
        if (isChildScope(parsed.scope)) {
          void this.applyScopedPinMutation(client, parsed.scope!, 'pin-remove', {
            ...(parsed.agent ? { agent: parsed.agent } : {}),
            pinId: parsed.pinId,
          });
          return;
        }
        const app = this.panelApp()!;
        const agentName = resolveAgent(app, parsed.agent);
        try {
          const ok = applyPinRemove(app, agentName, parsed.pinId);
          if (!ok) {
            this.send(client, { type: 'error', message: `no such pin: ${parsed.pinId}` });
          }
        } catch (err) {
          this.send(client, {
            type: 'error',
            message: `pin-remove failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
        this.broadcastPinsList(agentName);
        return;
      }

      case 'request-settings': {
        if (isChildScope(parsed.scope)) {
          void this.sendScopedSettings(client, parsed.scope!, parsed.agent);
        } else {
          this.sendSettingsState(client, parsed.agent);
        }
        return;
      }

      case 'settings-update': {
        if (isChildScope(parsed.scope)) {
          void this.applyScopedSettingsMutation(client, parsed.scope!, 'settings-update', {
            ...(parsed.agent ? { agent: parsed.agent } : {}),
            ...(parsed.contextBudgetTokens !== undefined ? { contextBudgetTokens: parsed.contextBudgetTokens } : {}),
            ...(parsed.tailTokens !== undefined ? { tailTokens: parsed.tailTokens } : {}),
            ...(parsed.transitionPaceTokens !== undefined ? { transitionPaceTokens: parsed.transitionPaceTokens } : {}),
            ...(parsed.immediate !== undefined ? { immediate: parsed.immediate } : {}),
            ...(parsed.persist !== undefined ? { persist: parsed.persist } : {}),
            ...(parsed.notify !== undefined ? { notify: parsed.notify } : {}),
          });
          return;
        }
        const app = this.panelApp()!;
        const agentName = resolveAgent(app, parsed.agent);
        try {
          applySettingsUpdate(app, agentName, parsed as unknown as Record<string, unknown>);
        } catch (err) {
          this.send(client, {
            type: 'error',
            message: `settings-update failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
        if (parsed.notify === true) notifyAgentOfSettingsChange(app, agentName, 'update');
        this.broadcastSettingsState(agentName);
        return;
      }

      case 'request-credential': {
        if (isChildScope(parsed.scope)) {
          void this.requestChildPanel(client, parsed.scope!, 'credential', {}).then((data) => {
            if (data !== null) this.sendScoped(client, { type: 'credential-state', scope: parsed.scope, ...(data as object) } as WebUiServerMessage);
          });
          return;
        }
        const app = this.panelApp();
        if (!app) return;
        this.sendScoped(client, { type: 'credential-state', scope: 'local', ...buildCredentialSnapshot(app) } as WebUiServerMessage);
        return;
      }

      case 'credential-action': {
        const params = { action: parsed.action, ...(parsed.token !== undefined ? { token: parsed.token } : {}) };
        if (isChildScope(parsed.scope)) {
          void this.requestChildPanel(client, parsed.scope!, 'credential-action', params).then((data) => {
            if (data !== null) this.broadcast({ type: 'credential-state', scope: parsed.scope, ...(data as object) } as WebUiServerMessage);
          });
          return;
        }
        const app = this.panelApp();
        if (!app) return;
        void applyCredentialAction(app, params)
          .then((data) => this.broadcast({ type: 'credential-state', scope: 'local', ...data } as WebUiServerMessage))
          .catch((err) => this.send(client, {
            type: 'error',
            message: `credential-action failed: ${err instanceof Error ? err.message : String(err)}`,
          }));
        return;
      }

      case 'settings-reset': {
        if (isChildScope(parsed.scope)) {
          void this.applyScopedSettingsMutation(client, parsed.scope!, 'settings-reset', {
            ...(parsed.agent ? { agent: parsed.agent } : {}),
            ...(parsed.keys ? { keys: parsed.keys } : {}),
            ...(parsed.persist !== undefined ? { persist: parsed.persist } : {}),
            ...(parsed.notify !== undefined ? { notify: parsed.notify } : {}),
          });
          return;
        }
        const app = this.panelApp()!;
        const agentName = resolveAgent(app, parsed.agent);
        try {
          applySettingsReset(app, agentName, parsed as unknown as Record<string, unknown>);
        } catch (err) {
          this.send(client, {
            type: 'error',
            message: `settings-reset failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
        if (parsed.notify === true) notifyAgentOfSettingsChange(app, agentName, 'reset');
        this.broadcastSettingsState(agentName);
        return;
      }

      case 'settings-cancel-transition': {
        if (isChildScope(parsed.scope)) {
          void this.applyScopedSettingsMutation(client, parsed.scope!, 'settings-cancel-transition', {
            ...(parsed.agent ? { agent: parsed.agent } : {}),
          });
          return;
        }
        const app = this.panelApp()!;
        const agentName = resolveAgent(app, parsed.agent);
        try {
          applySettingsCancelTransition(app, agentName);
        } catch (err) {
          this.send(client, {
            type: 'error',
            message: `settings-cancel-transition failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
        this.broadcastSettingsState(agentName);
        return;
      }

      case 'request-workspace-mounts': {
        if (parsed.scope && parsed.scope !== 'local') {
          this.routeFleetRequest(client, parsed.scope, 'workspace-mounts',
            (corrId, fleet) => fleet.requestWorkspaceMounts(parsed.scope!, corrId));
        } else {
          void this.sendWorkspaceMounts(client);
        }
        return;
      }

      case 'request-workspace-tree': {
        if (parsed.scope && parsed.scope !== 'local') {
          this.routeFleetRequest(client, parsed.scope, 'workspace-tree',
            (corrId, fleet) => fleet.requestWorkspaceTree(parsed.scope!, parsed.mount, corrId));
        } else {
          void this.sendWorkspaceTree(client, parsed.mount);
        }
        return;
      }

      case 'request-workspace-file': {
        if (parsed.scope && parsed.scope !== 'local') {
          this.routeFleetRequest(client, parsed.scope, 'workspace-file',
            (corrId, fleet) => fleet.requestWorkspaceFile(parsed.scope!, parsed.path, corrId));
        } else {
          void this.sendWorkspaceFileRead(client, parsed.path);
        }
        return;
      }
    }
  }

  private routeFleetRequest(
    client: ClientState,
    childName: string,
    kind: string,
    dispatch: (corrId: string, fleet: FleetModule) => boolean,
  ): void {
    if (!sharedServer?.app) return;
    this.pruneExpiredFleetRequests();
    const fleet = sharedServer.app.framework.getAllModules().find((m) => m.name === 'fleet') as
      | FleetModule | undefined;
    if (!fleet) {
      this.send(client, { type: 'error', message: `fleet module not loaded` });
      return;
    }
    const corrId = `webui-${kind}-${client.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sharedServer.pendingFleetRequests.set(corrId, {
      clientId: client.id,
      kind,
      expiresAt: Date.now() + FLEET_REQUEST_TTL_MS,
    });
    const ok = dispatch(corrId, fleet);
    if (!ok) {
      sharedServer.pendingFleetRequests.delete(corrId);
      this.send(client, { type: 'error', message: `child '${childName}' is not available` });
    }
  }

  private pruneExpiredFleetRequests(): void {
    if (!sharedServer) return;
    const now = Date.now();
    for (const [corrId, entry] of sharedServer.pendingFleetRequests) {
      if (entry.expiresAt > now) continue;
      sharedServer.pendingFleetRequests.delete(corrId);
      const client = sharedServer.clients.get(entry.clientId);
      if (!client) continue;
      this.send(client, {
        type: 'error',
        message: `${entry.kind} request timed out (child unresponsive after ${FLEET_REQUEST_TTL_MS / 1000}s)`,
      });
    }
  }

  private async workspaceMod(): Promise<
    | { handleToolCall(call: { name: string; input: unknown; id?: string }): Promise<{ success: boolean; data?: unknown; structured?: unknown; error?: string }> }
    | undefined
  > {
    if (!sharedServer?.app) return undefined;
    return sharedServer.app.framework.getAllModules().find((m) => m.name === 'workspace') as
      | { handleToolCall(call: { name: string; input: unknown; id?: string }): Promise<{ success: boolean; data?: unknown; structured?: unknown; error?: string }> }
      | undefined;
  }

  private async sendWorkspaceMounts(client: ClientState): Promise<void> {
    const mod = await this.workspaceMod();
    if (!mod) {
      this.send(client, { type: 'workspace-mounts', scope: 'local', loaded: false, mounts: [] });
      return;
    }
    try {
      const result = await mod.handleToolCall({ name: 'ls', input: {}, id: `webui-ls-${Date.now()}` });
      const data = (result.data ?? {}) as { mounts?: Array<{ name: string; path: string; mode: string }> };
      this.send(client, {
        type: 'workspace-mounts',
        scope: 'local',
        loaded: true,
        mounts: data.mounts ?? [],
      });
    } catch (err) {
      this.send(client, { type: 'error', message: `workspace mounts failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private async sendWorkspaceTree(client: ClientState, mount: string): Promise<void> {
    const mod = await this.workspaceMod();
    if (!mod) {
      this.send(client, { type: 'error', message: 'workspace module not loaded' });
      return;
    }
    try {
      const result = await mod.handleToolCall({
        name: 'ls',
        input: { path: mount, recursive: true },
        id: `webui-tree-${Date.now()}`,
      });
      if (!result.success) {
        this.send(client, { type: 'error', message: `workspace ls failed: ${result.error ?? 'unknown'}` });
        return;
      }
      const data = (result.data ?? {}) as { entries?: Array<{ path: string; size: number }> };
      this.send(client, {
        type: 'workspace-tree',
        scope: 'local',
        mount,
        entries: data.entries ?? [],
      });
    } catch (err) {
      this.send(client, { type: 'error', message: `workspace ls failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private async sendWorkspaceFileRead(client: ClientState, path: string): Promise<void> {
    const mod = await this.workspaceMod();
    if (!mod) {
      this.send(client, { type: 'error', message: 'workspace module not loaded' });
      return;
    }
    const LINE_LIMIT = 5000;
    const BYTE_LIMIT = 256 * 1024;
    try {
      const result = await mod.handleToolCall({
        name: 'read',
        input: { path, limit: LINE_LIMIT },
        id: `webui-read-${Date.now()}`,
      });
      if (!result.success) {
        this.send(client, { type: 'error', message: `read ${path} failed: ${result.error ?? 'unknown'}` });
        return;
      }
      const data = workspaceReadFields(result);
      const totalLines = data.totalLines ?? 0;
      const reportedToLine = data.toLine ?? totalLines;
      let content = data.content ?? '';
      let toLine = reportedToLine;
      let truncatedByBytes = false;
      if (Buffer.byteLength(content, 'utf-8') > BYTE_LIMIT) {
        const truncated = sliceUtf8(content, BYTE_LIMIT);
        const lastNl = truncated.lastIndexOf('\n');
        content = lastNl >= 0 ? truncated.slice(0, lastNl) : truncated;
        const fromLine = data.fromLine ?? 1;
        toLine = fromLine + content.split('\n').length - 1;
        truncatedByBytes = true;
      }
      this.send(client, {
        type: 'workspace-file',
        scope: 'local',
        path: data.path ?? path,
        totalLines,
        fromLine: data.fromLine ?? 1,
        toLine,
        content,
        truncated: truncatedByBytes || toLine < totalLines,
      });
    } catch (err) {
      this.send(client, { type: 'error', message: `read ${path} failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private sendMcplList(client: ClientState): void {
    const app = this.panelApp();
    if (!app) return;
    const snap = buildMcplSnapshot(app) as {
      configPath: string;
      servers: McplListMessage['servers'];
      live: McplLiveServer[];
      toolClasses?: McplListMessage['toolClasses'];
    };
    const out: McplListMessage = { type: 'mcpl-list', scope: 'local', ...snap };
    this.send(client, out);
  }

  private async sendScopedMcpl(client: ClientState, scope: string): Promise<void> {
    const data = await this.requestChildPanel(client, scope, 'mcpl', {});
    if (data === null) return;
    this.send(client, { type: 'mcpl-list', scope, ...(data as object) } as WebUiServerMessage);
  }

  private sendBranchesList(client: ClientState): void {
    if (!sharedServer?.app) return;
    const cm = sharedServer.app.framework.getAllAgents()[0]?.getContextManager();
    if (!cm) {
      this.send(client, { type: 'error', message: 'no agent context manager' });
      return;
    }
    try {
      const branches = cm.listBranches();
      const current = cm.currentBranch();
      const out: BranchesListMessage = {
        type: 'branches-list',
        branches: branches.map((b) => ({
          id: b.id,
          name: b.name,
          head: b.head,
          ...(b.parentId !== undefined ? { parentId: b.parentId } : {}),
          ...(b.branchPoint !== undefined ? { branchPoint: b.branchPoint } : {}),
          created: b.created instanceof Date ? b.created.getTime() : Number(b.created),
        })),
        currentId: current.id,
      };
      this.send(client, out);
    } catch (err) {
      this.send(client, {
        type: 'error',
        message: `branch listing failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private sendLessonsList(client: ClientState): void {
    if (!sharedServer?.app) return;
    const lessonsMod = sharedServer.app.framework.getAllModules().find((m) => m.name === 'lessons') as
      | { getLessons(): Array<{ id: string; content: string; confidence: number; tags: string[]; deprecated: boolean; deprecationReason?: string; created?: number; updated?: number }> }
      | undefined;
    if (!lessonsMod) {
      this.send(client, { type: 'lessons-list', scope: 'local', loaded: false, lessons: [] });
      return;
    }
    const lessons = lessonsMod.getLessons().map(l => ({
      id: l.id,
      content: l.content,
      confidence: l.confidence,
      tags: l.tags,
      deprecated: l.deprecated,
      ...(l.deprecationReason ? { deprecationReason: l.deprecationReason } : {}),
      ...(typeof l.created === 'number' ? { created: l.created } : {}),
      ...(typeof l.updated === 'number' ? { updated: l.updated } : {}),
    }));
    this.send(client, { type: 'lessons-list', scope: 'local', loaded: true, lessons });
  }

  private runningFleetChildren(): string[] {
    if (!sharedServer?.app) return [];
    const fleetMod = sharedServer.app.framework.getAllModules().find((m) => m.name === 'fleet') as
      | { getChildren(): ReadonlyMap<string, { status: string }> }
      | undefined;
    if (!fleetMod) return [];
    const out: string[] = [];
    for (const [name, child] of fleetMod.getChildren()) {
      if (child.status === 'ready' || child.status === 'starting') out.push(name);
    }
    return out;
  }

  /** In TUI mode OpenTUI ends the TUI on SIGTERM, one of its default exit
   *  signals. */
  private scheduleShutdown(): void {
    setTimeout(() => {
      try { process.kill(process.pid, 'SIGTERM'); }
      catch { process.exit(0); }
    }, REPLY_FLUSH_BEFORE_SIGTERM_MS);
  }

  private async handleQuitConfirm(action: 'kill-children' | 'detach' | 'cancel'): Promise<void> {
    if (action === 'cancel') return;
    if (action === 'detach') {
      this.fleetModule()?.setDetachMode(true);
      this.scheduleShutdown();
      return;
    }
    const running = this.runningFleetChildren();
    const fleetMod = sharedServer?.app?.framework.getAllModules().find((m) => m.name === 'fleet') as
      | { handleToolCall(call: { name: string; input: unknown; id?: string }): Promise<{ success: boolean; error?: string }> }
      | undefined;
    if (fleetMod) {
      await Promise.allSettled(running.map(name => fleetMod.handleToolCall({
        name: 'kill',
        input: { name },
        id: `webui-quit-${Date.now()}-${name}`,
      })));
    }
    this.scheduleShutdown();
  }

  private async handleFleetControl(client: ClientState, op: 'fleet-stop' | 'fleet-restart', name: string): Promise<void> {
    if (!sharedServer?.app) return;
    const fleetMod = sharedServer.app.framework
      .getAllModules()
      .find((m) => m.name === 'fleet') as
      | { handleToolCall(call: { name: string; input: unknown; id?: string }): Promise<{ success: boolean; data?: unknown; error?: string }> }
      | undefined;
    if (!fleetMod) {
      this.send(client, { type: 'error', message: 'fleet module not loaded' });
      return;
    }
    const tool = op === 'fleet-stop' ? 'kill' : 'restart';
    try {
      const result = await fleetMod.handleToolCall({
        name: tool,
        input: { name },
        id: `webui-${op}-${Date.now()}`,
      });
      const text = result.success
        ? `${op === 'fleet-stop' ? 'stopped' : 'restarted'} ${name}`
        : `${op} ${name} failed: ${result.error ?? 'unknown'}`;
      this.send(client, {
        type: 'command-result',
        lines: [{ text, style: result.success ? 'system' : 'tool' }],
      });
    } catch (err) {
      this.send(client, {
        type: 'error',
        message: `${op} ${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private handleSubscribePeek(client: ClientState, scope: string, active: boolean): void {
    if (!active) {
      const detach = client.peeks.get(scope);
      if (detach) {
        try { detach(); } catch { }
        client.peeks.delete(scope);
      }
      return;
    }

    if (client.peeks.has(scope)) return;

    if (!sharedServer?.app) return;

    const fleetMod = sharedServer.app.framework
      .getAllModules()
      .find((m) => m.name === 'fleet') as { getChildren(): ReadonlyMap<string, unknown> } | undefined;
    if (fleetMod && fleetMod.getChildren().has(scope)) {
      client.peeks.set(scope, () => { });
      return;
    }

    const subMod = sharedServer.app.framework
      .getAllModules()
      .find((m) => m.name === 'subagent') as
      | {
          onPeekStream(name: string, cb: (ev: { type: string; [k: string]: unknown }) => void): () => void;
          peek(name?: string): Promise<Array<{
            name: string;
            status: string;
            messageCount: number;
            lastMessageSnippet: string;
            currentStream: string;
            pendingToolCalls: Array<{ name: string; input?: unknown }>;
            elapsedMs: number;
            isZombie: boolean;
          }>>;
        }
      | undefined;
    if (!subMod) {
      this.send(client, { type: 'error', message: `subscribe-peek: scope '${scope}' not found` });
      return;
    }
    void this.sendPeekBackfill(client, subMod, scope);
    const detach = subMod.onPeekStream(scope, (event) => {
      this.send(client, {
        type: 'peek',
        scope,
        event: event as { type: string; [k: string]: unknown },
      });
    });
    client.peeks.set(scope, detach);
  }

  private async sendPeekBackfill(
    client: ClientState,
    subMod: {
      peek(name?: string): Promise<Array<{
        name: string;
        status: string;
        messageCount: number;
        lastMessageSnippet: string;
        currentStream: string;
        pendingToolCalls: Array<{ name: string; input?: unknown }>;
        elapsedMs: number;
        isZombie: boolean;
      }>>;
    },
    scope: string,
  ): Promise<void> {
    let snap: Awaited<ReturnType<typeof subMod.peek>>[number] | undefined;
    try {
      const snaps = await subMod.peek(scope);
      snap = snaps[0];
    } catch {
      return;
    }
    if (!snap) return;

    const headerBits: string[] = [
      `status=${snap.status}`,
      `msgs=${snap.messageCount}`,
      `elapsed=${Math.round(snap.elapsedMs / 1000)}s`,
    ];
    if (snap.isZombie) headerBits.push('zombie');
    this.send(client, {
      type: 'peek',
      scope,
      event: { type: 'lifecycle', phase: `peek opened — ${headerBits.join(' ')}` },
    });

    if (snap.lastMessageSnippet) {
      this.send(client, {
        type: 'peek',
        scope,
        event: { type: 'lifecycle', phase: `last: ${snap.lastMessageSnippet.slice(-200)}` },
      });
    }

    if (snap.currentStream) {
      this.send(client, {
        type: 'peek',
        scope,
        event: { type: 'tokens', content: snap.currentStream },
      });
    }

    for (const call of snap.pendingToolCalls) {
      this.send(client, {
        type: 'peek',
        scope,
        event: { type: 'tool:started', tool: call.name },
      });
    }
  }

  private async handleRouteToChild(client: ClientState, childName: string, content: string): Promise<void> {
    if (!sharedServer?.app) return;
    const fleetMod = sharedServer.app.framework
      .getAllModules()
      .find((m) => m.name === 'fleet') as
      | { handleToolCall(call: { name: string; input: unknown; id?: string }): Promise<{ success: boolean; data?: unknown; error?: string }> }
      | undefined;
    if (!fleetMod) {
      this.send(client, { type: 'error', message: 'fleet module not loaded' });
      return;
    }
    try {
      const result = await fleetMod.handleToolCall({
        name: 'send',
        input: { name: childName, content },
        id: `webui-route-${Date.now()}`,
      });
      const text = result.success
        ? `→ @${childName}: ${content}`
        : `route failed: ${result.error ?? 'unknown'}`;
      this.send(client, {
        type: 'command-result',
        lines: [{ text, style: result.success ? 'system' : 'tool' }],
      });
    } catch (err) {
      this.send(client, {
        type: 'error',
        message: `route to ${childName} failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private onWsClose(ws: ServerWebSocket<WsData>): void {
    const id = ws.data.id;
    const client = sharedServer?.clients.get(id);
    if (client) {
      if (client.authTimer) clearTimeout(client.authTimer);
      for (const detach of client.peeks.values()) {
        try { detach(); } catch { }
      }
      client.peeks.clear();
    }
    sharedServer?.clients.delete(id);
  }

  private async dispatchCommand(client: ClientState, command: string, corrId?: string): Promise<void> {
    if (!sharedServer?.app) return;
    const app = sharedServer.app;
    let result;
    try {
      result = handleCommand(command, app);
    } catch (err) {
      this.send(client, {
        type: 'error',
        corrId,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    this.send(client, {
      type: 'command-result',
      corrId,
      lines: result.lines,
      quit: result.quit,
      branchChanged: result.branchChanged,
      switchToSessionId: result.switchToSessionId,
      pending: result.asyncWork !== undefined,
    });

    if (result.quit) {
      const running = this.runningFleetChildren();
      if (running.length > 0) {
        this.send(client, { type: 'quit-confirm-required', children: running });
        return;
      }
      this.scheduleShutdown();
    }

    const commandName = `/${parseCommand(command).name}`;
    if (result.branchChanged) {
      await trackOperatorWork(app, commandName, this.materializeConfigMount());
      this.broadcastBranchChanged();
      this.refreshAllWelcomes();
    }

    if (result.switchToSessionId) {
      try {
        if (await app.switchSession(result.switchToSessionId) === false) {
          this.send(client, { type: 'error', corrId, message: switchLeftForStop(app.sessionManager.getActiveSession()) });
        }
      } catch (err) {
        this.send(client, {
          type: 'error',
          corrId,
          message: `session switch failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    if (result.asyncWork) {
      try {
        const follow = await result.asyncWork;
        this.send(client, {
          type: 'command-result',
          corrId,
          lines: follow.lines,
          quit: follow.quit,
          branchChanged: follow.branchChanged,
          switchToSessionId: follow.switchToSessionId,
        });
        if (follow.branchChanged) {
          await trackOperatorWork(app, commandName, this.materializeConfigMount());
          this.broadcastBranchChanged();
          this.refreshAllWelcomes();
        }
      } catch (err) {
        this.send(client, {
          type: 'error',
          corrId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async materializeConfigMount(): Promise<void> {
    if (!sharedServer?.app) return;
    const ws = sharedServer?.app.framework.getModule('workspace');
    if (!ws || !('materializeMount' in ws)) return;
    try {
      await (ws as { materializeMount: (name: string) => Promise<unknown> }).materializeMount('_config');
    } catch {
    }
  }

  private sendPinsList(client: ClientState, agentName?: string): void {
    const app = this.panelApp();
    if (!app) return;
    try {
      const sessionId = sharedServer!.app!.frameworkSessionId;
      const snap = buildPinsSnapshot(app, resolveAgent(app, agentName));
      this.send(client, { type: 'pins-list', scope: 'local', sessionId, ...snap });
    } catch (err) {
      this.send(client, {
        type: 'error',
        message: `pins unavailable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async sendScopedPins(client: ClientState, scope: string, agentName?: string): Promise<void> {
    const data = await this.requestChildPanel(client, scope, 'pins', {
      ...(agentName ? { agent: agentName } : {}),
      withCandidates: true,
    });
    if (data === null) return;
    this.send(client, { type: 'pins-list', scope, ...(data as object) } as WebUiServerMessage);
  }

  private async applyScopedPinMutation(
    client: ClientState,
    scope: string,
    op: 'pin-add' | 'pin-remove',
    params: Record<string, unknown>,
  ): Promise<void> {
    const data = await this.requestChildPanel(client, scope, op, { ...params, withCandidates: true });
    if (data === null) return;
    const warning = (data as { warning?: unknown }).warning;
    if (typeof warning === 'string') {
      this.send(client, { type: 'error', message: warning });
    }
    this.broadcast({ type: 'pins-list', scope, ...(data as object) } as WebUiServerMessage);
  }

  private broadcastPinsList(agentName: string): void {
    const app = this.panelApp();
    if (!app) return;
    try {
      const sessionId = sharedServer!.app!.frameworkSessionId;
      const snap = buildPinsSnapshot(app, agentName);
      this.broadcast({ type: 'pins-list', scope: 'local', sessionId, ...snap });
    } catch { }
  }

  private sendSettingsState(client: ClientState, agentName?: string): void {
    const app = this.panelApp();
    if (!app) return;
    const sessionId = sharedServer!.app!.frameworkSessionId;
    const msg = buildSettingsState(app, resolveAgent(app, agentName));
    if (!msg) {
      this.send(client, { type: 'error', message: 'runtime settings unavailable on this build' });
      return;
    }
    this.send(client, { type: 'settings-state', scope: 'local', sessionId, ...msg } as WebUiServerMessage);
  }

  private async sendScopedSettings(client: ClientState, scope: string, agentName?: string): Promise<void> {
    const data = await this.requestChildPanel(client, scope, 'settings',
      agentName ? { agent: agentName } : {});
    if (data === null) return;
    this.send(client, { type: 'settings-state', scope, ...(data as object) } as WebUiServerMessage);
  }

  private async applyScopedSettingsMutation(
    client: ClientState,
    scope: string,
    op: 'settings-update' | 'settings-reset' | 'settings-cancel-transition',
    params: Record<string, unknown>,
  ): Promise<void> {
    const data = await this.requestChildPanel(client, scope, op, params);
    if (data === null) return;
    this.broadcast({ type: 'settings-state', scope, ...(data as object) } as WebUiServerMessage);
  }

  private broadcastSettingsState(agentName: string): void {
    const app = this.panelApp();
    if (!app) return;
    const sessionId = sharedServer!.app!.frameworkSessionId;
    const msg = buildSettingsState(app, agentName);
    if (!msg) return;
    this.broadcast({ type: 'settings-state', scope: 'local', sessionId, ...msg } as WebUiServerMessage);
  }

  private async requestChildPanel(
    client: ClientState,
    childName: string,
    op: string,
    params: Record<string, unknown>,
  ): Promise<unknown | null> {
    const fleet = this.fleetModule();
    if (!fleet) {
      this.send(client, { type: 'error', message: 'fleet module not loaded' });
      return null;
    }
    const result = await fleet.requestPanel(childName, op, params);
    if (!result.ok) {
      this.send(client, {
        type: 'error',
        message: `${op} on '${childName}' failed` + (clientHolds(client, ['ops']) ? `: ${result.error ?? 'unknown error'}` : ''),
      });
      return null;
    }
    return result.data ?? {};
  }

  private broadcastBranchChanged(): void {
    if (!sharedServer?.app) return;
    const cm = sharedServer?.app.framework.getAllAgents()[0]?.getContextManager();
    if (!cm) return;
    const branch = cm.currentBranch();
    this.broadcast({
      type: 'branch-changed',
      branch: { id: branch.id, name: branch.name },
    });
  }

  private refreshAllWelcomes(): void {
    for (const c of sharedServer!.clients.values()) {
      c.welcomed = false;
      void this.sendWelcome(c);
    }
  }

  private async sendWelcome(client: ClientState): Promise<void> {
    if (!sharedServer?.app) return;
    if (client.auth === 'pending') return;

    const generation = sharedServer.bindGeneration;
    const current = (): boolean => !!sharedServer?.app && sharedServer.bindGeneration === generation;
    const autoStartRecords = sharedServer.autoStartRecords;
    if (autoStartRecords) await autoStartRecords;
    if (!current()) return;
    const childRecipes = await this.loadWelcomeRecipes();
    if (!current()) return;
    this.welcomeAndJoinStream(client, childRecipes);
  }

  private welcomeAndJoinStream(
    client: ClientState,
    childRecipes: Parameters<WebUiModule['buildWelcome']>[0],
  ): void {
    const welcome = this.buildWelcome(childRecipes);
    this.send(client, client.scopes === null ? welcome : this.observerWelcome(welcome, client.scopes));
    client.welcomed = true;
  }

  private observerWelcome(welcome: WelcomeMessage, scopes: Set<ObserverScope>): WelcomeMessage {
    const scoped = scopeWelcome(welcome, scopes);
    if (scoped.messages.length > 0 || !scopes.has('messages')) return scoped;
    const cmw = sharedServer?.app?.framework.getAllAgents()[0]?.getContextManager() as unknown as WindowCapableCm | undefined;
    if (typeof cmw?.getMessageWindow !== 'function') return scoped;
    const { entries, startIndex } = readHistory(cmw, scoped.history.startIndex, WELCOME_HISTORY_LIMIT, scopes);
    return { ...scoped, messages: entries, history: { ...scoped.history, startIndex } };
  }

  private handleRequestHistory(client: ClientState, req: RequestHistoryMessage): void {
    const app = sharedServer?.app;
    const cm = app?.framework.getAllAgents()[0]?.getContextManager();
    if (!app || !cm) {
      this.send(client, { type: 'error', corrId: req.corrId, message: 'no context manager' });
      return;
    }
    const cmw = cm as unknown as WindowCapableCm;
    if (typeof cmw.getMessageWindow !== 'function') {
      this.send(client, {
        type: 'error', corrId: req.corrId,
        message: 'history paging unavailable (context-manager without windowed reads)',
      });
      return;
    }
    const limit = Math.min(req.limit ?? HISTORY_PAGE_DEFAULT, HISTORY_PAGE_MAX);
    const beforeIndex = Math.min(req.beforeIndex, cmw.getMessageCount());
    this.send(client, { type: 'history-page', corrId: req.corrId, sessionId: app.frameworkSessionId, ...readHistory(cmw, beforeIndex, limit, client.scopes) });
  }

  private async loadWelcomeRecipes(): Promise<Map<string, Awaited<ReturnType<WebUiModule['loadChildRecipeInfo']>>>> {
    const recipes = new Map<string, Awaited<ReturnType<WebUiModule['loadChildRecipeInfo']>>>();
    const aggregator = sharedServer?.treeAggregator;
    const fleetMod = aggregator
      ? sharedServer?.app?.framework.getAllModules().find((m) => m.name === 'fleet') as FleetModule | undefined
      : undefined;
    if (aggregator && fleetMod) {
      for (const name of aggregator.getAllChildNames()) {
        recipes.set(name, await this.loadChildRecipeInfo(fleetMod, name));
      }
    }
    return recipes;
  }

  private buildWelcome(
    childRecipes: Map<string, Awaited<ReturnType<WebUiModule['loadChildRecipeInfo']>>>,
  ): WelcomeMessage {
    const app = sharedServer?.app!;
    const fw = app.framework;
    const agents = fw.getAllAgents();
    const sessionId = app.frameworkSessionId;
    let indexed: ReturnType<SessionManager['findSession']> = null;
    try {
      indexed = app.sessionManager.findSession(sessionId);
    } catch { }
    const session = indexed?.id === sessionId
      ? indexed
      : { id: sessionId, name: sessionId, manuallyNamed: false };

    const cm = agents[0]?.getContextManager();
    let messages: WelcomeMessageEntry[] = [];
    let history = { startIndex: 0, totalCount: 0 };
    if (cm) {
      const cmw = cm as unknown as WindowCapableCm;
      if (typeof cmw.getMessageWindow === 'function' && typeof cmw.getMessageCount === 'function') {
        const total = cmw.getMessageCount();
        const start = Math.max(0, total - WELCOME_HISTORY_LIMIT);
        const win = cmw.getMessageWindow(start, total - start, {
          resolveBlobs: false,
          alignToBodyGroups: true,
        });
        messages = coalesceAndFlatten(win.messages as unknown as MessageLike[], win.startIndex);
        history = { startIndex: win.startIndex, totalCount: win.totalCount };
      } else {
        const all = cm.getAllMessages() as unknown as MessageLike[];
        const start = Math.max(0, all.length - WELCOME_HISTORY_LIMIT);
        messages = coalesceAndFlatten(all.slice(start), start);
        history = { startIndex: start, totalCount: all.length };
      }
    }

    const localReducer = new AgentTreeReducer();
    localReducer.seedFrameworkAgents(agents.map(a => a.name));
    const localSnap: AgentTreeSnapshot = localReducer.getSnapshot();

    const childTrees: WelcomeMessage['childTrees'] = [];
    if (sharedServer?.treeAggregator) {
      const fleetMod = fw.getAllModules().find((m) => m.name === 'fleet') as FleetModule | undefined;
      for (const name of sharedServer.treeAggregator.getAllChildNames()) {
        if (fleetMod && !fleetMod.getChildren().has(name) && !fleetMod.autoStartLaunching().has(name)) continue;
        const nodes = sharedServer.treeAggregator.getChildNodes(name);
        const recipeInfo = childRecipes.get(name);
        childTrees.push({
          name,
          asOfTs: Date.now(),
          nodes: nodes as unknown as Array<Record<string, unknown>>,
          callIdIndex: {},
          ...(recipeInfo ? { recipe: recipeInfo } : {}),
        });
      }
    }

    const branch = cm?.currentBranch();
    const hostMode = this.hostModeSnapshot();

    return {
      type: 'welcome',
      protocolVersion: WEB_PROTOCOL_VERSION,
      recipe: {
        name: app.recipe.name,
        description: app.recipe.description,
        version: app.recipe.version,
      },
      agents: agents.map(a => ({ name: a.name, model: a.model })),
      session: {
        id: session.id,
        name: session.name,
        autoNamed: !session.manuallyNamed,
      },
      branch: {
        id: branch?.id ?? '',
        name: branch?.name ?? '',
      },
      messages,
      history,
      localTree: {
        asOfTs: localSnap.asOfTs,
        nodes: localSnap.nodes as unknown as Array<Record<string, unknown>>,
        callIdIndex: localSnap.callIdIndex,
      },
      childTrees,
      features: this.hostFeatures(),
      ...(hostMode ? { hostMode } : {}),
      usage: sharedServer!.latestUsage,
      ...(sharedServer!.latestPerAgentCost.length > 0
        ? { perAgentCost: sharedServer!.latestPerAgentCost }
        : {}),
      ...(sharedServer!.latestCallLedger
        ? { callLedger: sharedServer!.latestCallLedger }
        : {}),
    };
  }

  private send(client: ClientState, msg: WebUiServerMessage): void {
    try {
      client.ws.send(JSON.stringify(msg));
    } catch {
    }
  }

  private assertSafeBind(host: string): void {
    const isLoopback = LOOPBACK_NAMES.has(host);
    if (isLoopback) return;
    if (this.config.basicAuth) return;
    throw new Error(
      `WebUiModule refuses to bind ${host} without auth. The default bind is ` +
      `0.0.0.0, so any recipe that enables webui must supply basicAuth ` +
      `(username/password, ideally via \${ENV_VAR} substitution). Set ` +
      `host: '127.0.0.1' to bind loopback-only for local development, which ` +
      `skips the auth requirement.`,
    );
  }

  private assertCredentials(): void {
    const auth = this.config.basicAuth;
    const filled = (value: unknown) => typeof value === 'string' && value !== '';
    if (!auth || (filled(auth.username) && filled(auth.password))) return;
    throw new Error(
      'WebUiModule refuses basicAuth whose username or password is empty, missing or not a string. Set both. A ' +
      '${VAR} reference that .env sets to nothing, such as WEBUI_PASS=, gives an empty value.',
    );
  }

  private assertOriginCheck(): void {
    const origins = this.config.allowedOrigins;
    if (origins === undefined) return;
    const fits = this.config.basicAuth ? isOrigin : isLoopbackOrigin;
    let named: string;
    if (!Array.isArray(origins)) named = `allowedOrigins ${JSON.stringify(origins)}, which isn't a list,`;
    else if (origins.length === 0) named = 'allowedOrigins: []';
    else {
      const at = origins.findIndex((o) => !fits(o));
      if (at === -1) return;
      named = `the allowedOrigins entry ${JSON.stringify(origins[at])}`;
    }
    if (this.config.basicAuth) {
      throw new Error(
        `WebUiModule refuses ${named} with basicAuth: with credentials, allowedOrigins is absent, or a non-empty ` +
        'list whose every entry is an http or https URL. List the origins to accept, or remove allowedOrigins so ' +
        'the /ws upgrade checks Origin against the default list.',
      );
    }
    throw new Error(
      `WebUiModule refuses ${named} without basicAuth:` +
      ' without credentials, allowedOrigins is absent, or a non-empty list whose every entry is an http or https ' +
      'URL on 127.0.0.1, localhost or [::1]. Set basicAuth and make allowedOrigins a non-empty list of http or ' +
      'https origins, or remove allowedOrigins so the /ws upgrade checks Origin against the default list again.',
    );
  }

  /**
   * Checks the upgrade's Origin against the allowlist. A request with no
   * Origin is accepted: browsers send one on every WebSocket upgrade, and
   * other clients usually don't.
   */
  private checkOrigin(req: Request): boolean {
    if (!sharedServer) return false;
    const allow = sharedServer.allowedOrigins;
    const origin = req.headers.get('origin');
    if (!origin) return true;
    if (allow.includes(origin)) return true;
    // An Origin whose host and port are the request's Host is accepted: a page
    // this server served under a name the default list can't predict, such as
    // a Tailscale or LAN name.
    try {
      const originHost = new URL(origin).host;
      const host = req.headers.get('host');
      if (host && originHost === host) return true;
    } catch {
    }
    return false;
  }

  private checkAuth(req: Request): boolean {
    if (!this.config.basicAuth) return true;
    const header = req.headers.get('authorization');
    if (!header || !header.toLowerCase().startsWith('basic ')) return false;
    let decoded: string;
    try {
      decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf-8');
    } catch {
      return false;
    }
    const idx = decoded.indexOf(':');
    if (idx < 0) return false;
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    const userOk = constantTimeStringEq(user, this.config.basicAuth.username);
    const passOk = constantTimeStringEq(pass, this.config.basicAuth.password);
    return userOk && passOk;
  }

  private unauthorized(noStore = false): Response {
    const headers = new Headers({ 'www-authenticate': 'Basic realm="connectome-host"' });
    if (noStore) headers.set('cache-control', 'no-store');
    return new Response('Unauthorized', {
      status: 401,
      headers,
    });
  }
}

function within(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<void>((done) => { timer = setTimeout(done, ms); })])
    .finally(() => clearTimeout(timer));
}

function defaultAllowedOrigins(port: number): string[] {
  return [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `https://127.0.0.1:${port}`,
    `https://localhost:${port}`,
  ];
}

/**
 * Constant-time string equality: timingSafeEqual throws on unequal
 * lengths, which would leak the length, so both inputs are hashed to
 * 32-byte SHA-256 digests first.
 */
function constantTimeStringEq(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf-8').digest();
  const hb = createHash('sha256').update(b, 'utf-8').digest();
  return timingSafeEqual(ha, hb);
}

function sliceUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf-8');
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  // Continuation bytes match 10xxxxxx (0x80..0xbf). Step back until we land
  // on either ASCII (0x00..0x7f) or a lead byte (0xc0..0xff).
  while (end > 0 && (buf[end] !== undefined && (buf[end]! & 0xc0) === 0x80)) end--;
  return buf.subarray(0, end).toString('utf-8');
}

interface MessageLike {
  id?: string;
  participant: string;
  content: ReadonlyArray<unknown>;
  metadata?: unknown;
  timestamp?: number | Date;
  bodyGroupId?: string;
  shardIndex?: number;
}

const TEXT_CAP = 64 * 1024;
const THINKING_CAP = 32 * 1024;
const TOOL_INPUT_CAP = 16 * 1024;
const TOOL_RESULT_CAP = 16 * 1024;

function capText(s: string, cap: number): { text: string; truncated?: boolean } {
  const sliced = sliceUtf8(s, cap);
  return sliced === s ? { text: s } : { text: sliced, truncated: true };
}

export function toWireEntry(
  msg: MessageLike,
  index: number,
  opts: { storedBlockIndices?: boolean } = {},
): WelcomeMessageEntry {
  const blocks: import('../web/protocol.js').MessageBlock[] = [];
  const textParts: string[] = [];
  let toolResults = 0;
  let conversational = 0;
  const mediaRef = (blockPath: string, mediaType: string): string | undefined =>
    opts.storedBlockIndices !== false && typeof msg.id === 'string' && msg.id.length > 0 && mediaType.startsWith('image/')
      ? `${encodeURIComponent(msg.id)}/${blockPath}`
      : undefined;

  for (const [bi, block] of msg.content.entries()) {
    const b = block as {
      type?: string; text?: unknown; thinking?: unknown; data?: unknown;
      id?: unknown; name?: unknown; input?: unknown;
      toolUseId?: unknown; content?: unknown; isError?: unknown;
      source?: { mediaType?: unknown }; mediaType?: unknown;
      ref?: { mediaType?: unknown };
    };
    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string') {
          const capped = capText(b.text, TEXT_CAP);
          blocks.push({ kind: 'text', ...capped });
          textParts.push(capped.text);
          conversational++;
        }
        break;
      case 'thinking':
        if (typeof b.thinking === 'string') {
          blocks.push({ kind: 'thinking', ...capText(b.thinking, THINKING_CAP) });
          conversational++;
        }
        break;
      case 'redacted_thinking':
        blocks.push({
          kind: 'redacted_thinking',
          bytes: typeof b.data === 'string' ? b.data.length : 0,
        });
        conversational++;
        break;
      case 'tool_use':
        if (typeof b.id === 'string' && typeof b.name === 'string') {
          let inputJson: string;
          try {
            inputJson = JSON.stringify(b.input, null, 2) ?? 'null';
          } catch {
            inputJson = '[unserializable input]';
          }
          const capped = capText(inputJson, TOOL_INPUT_CAP);
          blocks.push({
            kind: 'tool_use', id: b.id, name: b.name,
            inputJson: capped.text,
            ...(capped.truncated ? { truncated: true } : {}),
          });
        }
        break;
      case 'tool_result':
        if (typeof b.toolUseId === 'string') {
          blocks.push({
            kind: 'tool_result',
            toolUseId: b.toolUseId,
            ...capText(flattenToolResultContent(b.content), TOOL_RESULT_CAP),
            ...(b.isError === true ? { isError: true } : {}),
          });
          toolResults++;
          if (Array.isArray(b.content)) {
            for (const [ii, inner] of b.content.entries()) {
              const ib = inner as { type?: string; source?: { mediaType?: unknown }; ref?: { mediaType?: unknown } } | null;
              const mt = ib?.type === 'image' && typeof ib.source?.mediaType === 'string' ? ib.source.mediaType
                : ib?.type === 'blob_ref' && typeof ib.ref?.mediaType === 'string' ? ib.ref.mediaType
                : null;
              if (!mt || !mt.startsWith('image/')) continue;
              const ref = mediaRef(`${bi}.${ii}`, mt);
              blocks.push({ kind: 'media', mediaType: mt, ...(ref ? { ref } : {}), toolUseId: b.toolUseId });
            }
          }
        }
        break;
      case 'image':
      case 'document':
      case 'audio':
      case 'video': {
        const mediaType =
          typeof b.source?.mediaType === 'string' ? b.source.mediaType
          : typeof b.mediaType === 'string' ? b.mediaType
          : b.type;
        const ref = b.type === 'image' ? mediaRef(String(bi), mediaType) : undefined;
        blocks.push({ kind: 'media', mediaType, ...(ref ? { ref } : {}) });
        break;
      }
      case 'blob_ref': {
        const mediaType = typeof b.ref?.mediaType === 'string' ? b.ref.mediaType : 'blob';
        const ref = mediaRef(String(bi), mediaType);
        blocks.push({ kind: 'media', mediaType, ...(ref ? { ref } : {}) });
        break;
      }
      default:
        break;
    }
  }

  const injection = storedInjectionMarkOf(msg.metadata);
  if (injection) {
    const label = storedInjectionLabel(injection);
    blocks.unshift({ kind: 'text', text: label });
    textParts.unshift(label);
  }

  const participant = injection ? 'system'
    : toolResults > 0 && conversational === 0 ? 'tool'
    : normalizeParticipant(msg.participant);

  const entry: WelcomeMessageEntry = {
    index,
    participant,
    blocks,
    text: textParts.join('\n'),
  };
  if (participant === 'user') entry.speaker = speakerOf(msg.participant, msg.metadata).label;
  if (msg.id) entry.id = msg.id;
  const ts = msg.timestamp instanceof Date ? msg.timestamp.getTime() : msg.timestamp;
  if (ts) entry.timestamp = ts;
  return entry;
}

function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'image') parts.push('[image]');
    else if (typeof b.type === 'string') parts.push(`[${b.type}]`);
  }
  return parts.join('\n');
}

function coalesceAndFlatten(messages: readonly MessageLike[], startIndex: number): WelcomeMessageEntry[] {
  const out: WelcomeMessageEntry[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    if (!m.bodyGroupId) {
      out.push(toWireEntry(m, startIndex + i));
      i++;
      continue;
    }
    const runStart = i;
    while (i < messages.length && messages[i]!.bodyGroupId === m.bodyGroupId) i++;
    const shards = messages.slice(runStart, i)
      .map((shard, k) => ({ shard, k }))
      .sort((a, b) => (a.shard.shardIndex ?? a.k) - (b.shard.shardIndex ?? b.k))
      .map(({ shard }) => shard);
    // context-manager's shards are substrings of one body that join back with
    // no separator, so their text is merged without one.
    const mergedContent: unknown[] = [];
    for (const blk of shards.flatMap((s) => [...s.content])) {
      const prev = mergedContent[mergedContent.length - 1] as { type?: string; text?: string } | undefined;
      const cur = blk as { type?: string; text?: unknown };
      if (prev?.type === 'text' && cur.type === 'text'
          && typeof prev.text === 'string' && typeof cur.text === 'string') {
        mergedContent[mergedContent.length - 1] = { type: 'text', text: prev.text + cur.text };
      } else {
        mergedContent.push(blk);
      }
    }
    const merged: MessageLike = { ...shards[0]!, content: mergedContent };
    out.push(toWireEntry(merged, startIndex + runStart, { storedBlockIndices: false }));
  }
  return out;
}

function readHistory(
  cmw: WindowCapableCm,
  beforeIndex: number,
  limit: number,
  scopes: Set<ObserverScope> | null,
): { entries: WelcomeMessageEntry[]; startIndex: number; totalCount: number } {
  for (let windows = 1; ; windows++) {
    const offset = Math.max(0, beforeIndex - limit);
    const win = cmw.getMessageWindow(offset, beforeIndex - offset, {
      resolveBlobs: false,
      alignToBodyGroups: true,
    });
    let entries = coalesceAndFlatten(win.messages as unknown as MessageLike[], win.startIndex);
    if (scopes !== null) {
      entries = entries
        .map((e) => filterEntryForScopes(e, scopes))
        .filter((e): e is WelcomeMessageEntry => e !== null);
    }
    if (entries.length > 0 || win.startIndex === 0 || windows === HISTORY_READ_BACK_WINDOWS) {
      return { entries, startIndex: win.startIndex, totalCount: win.totalCount };
    }
    beforeIndex = win.startIndex;
  }
}

/** agent-framework stores an agent's turns under the agent's name, not
 *  'assistant'. */
function normalizeParticipant(raw: string): WelcomeMessageEntry['participant'] {
  if (raw === 'user' || raw === 'system' || raw === 'tool') return raw;
  return 'assistant';
}

/** MCPL channel-incoming metadata carries channelId, and push-event
 *  metadata serverId and featureSet. */
function describeTriggerOrigin(source: string, md: Record<string, unknown>): string {
  const serverId = typeof md.serverId === 'string' ? md.serverId : '?';
  if (source === 'mcpl:channel-incoming') {
    const channelId = typeof md.channelId === 'string' ? md.channelId : '';
    return channelId ? `${serverId}#${channelId}` : serverId;
  }
  if (source === 'mcpl:push-event') {
    const featureSet = typeof md.featureSet === 'string' ? md.featureSet : '';
    return featureSet ? `${serverId}/${featureSet}` : serverId;
  }
  return source;
}

/** MCPL channel-incoming metadata carries `author: { id, name }`; a push
 *  event's carries one only where its origin does. */
function extractAuthorName(md: Record<string, unknown>): string | undefined {
  const author = md.author;
  if (author && typeof author === 'object' && 'name' in author) {
    const name = (author as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return undefined;
}

function extractText(content: ReadonlyArray<unknown>): string {
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

function parseUsageTotals(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as {
    inputTokens?: unknown;
    outputTokens?: unknown;
    cacheReadTokens?: unknown;
    cacheCreationTokens?: unknown;
    estimatedCost?: unknown;
  };
  const usage: TokenUsage = {
    input: typeof t.inputTokens === 'number' ? t.inputTokens : 0,
    output: typeof t.outputTokens === 'number' ? t.outputTokens : 0,
    cacheRead: typeof t.cacheReadTokens === 'number' ? t.cacheReadTokens : 0,
    cacheWrite: typeof t.cacheCreationTokens === 'number' ? t.cacheCreationTokens : 0,
  };
  const cost = t.estimatedCost as { total?: unknown; currency?: unknown } | undefined;
  if (cost && typeof cost.total === 'number' && typeof cost.currency === 'string') {
    usage.cost = { total: cost.total, currency: cost.currency };
  }
  return usage;
}

function aggregateFleetUsage(ss: SharedServerState): TokenUsage {
  const out: TokenUsage = {
    input: ss.parentUsage.input,
    output: ss.parentUsage.output,
    cacheRead: ss.parentUsage.cacheRead,
    cacheWrite: ss.parentUsage.cacheWrite,
  };
  let costTotal = 0;
  let costCurrency: string | null = null;
  let costAbandoned = false;
  const accumulateCost = (c: { total: number; currency: string } | undefined): void => {
    if (costAbandoned) return;
    if (!c) return;
    if (costCurrency === null) { costCurrency = c.currency; costTotal = c.total; return; }
    if (costCurrency !== c.currency) { costAbandoned = true; return; }
    costTotal += c.total;
  };
  accumulateCost(ss.parentUsage.cost);
  for (const u of ss.childUsage.values()) {
    out.input += u.input;
    out.output += u.output;
    out.cacheRead += u.cacheRead;
    out.cacheWrite += u.cacheWrite;
    accumulateCost(u.cost);
  }
  if (!costAbandoned && costCurrency !== null) {
    out.cost = { total: costTotal, currency: costCurrency };
  }
  return out;
}

/**
 * Vite names the files under `assets/` by their content, so they're
 * cached for good, while `index.html` is revalidated every time: with no
 * header a browser caches it heuristically.
 */
function cacheControlFor(path: string): string {
  if (/[\\/]assets[\\/][^\\/]+-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/.test(path)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

function mimeFor(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.ico')) return 'image/x-icon';
  if (path.endsWith('.woff2')) return 'font/woff2';
  if (path.endsWith('.woff')) return 'font/woff';
  return 'application/octet-stream';
}

export function __getSharedServerPortForTests(): number | null {
  return sharedServer?.port ?? null;
}

export async function stopWebUiServer(): Promise<void> {
  if (!sharedServer) return;
  try { sharedServer.server.stop(true); } catch { }
  sharedServer.observers?.stop();
  sharedServer.fleetEventDetacher?.();
  sharedServer.treeAggregator?.dispose();
  sharedServer.stopFollowing?.();
  sharedServer = null;
}
