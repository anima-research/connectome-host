/**
 * WebUiModule — serves a single-page web admin UI plus a JSON-over-WebSocket
 * control plane. Mirrors what TuiModule provides for the terminal: a way to
 * see the conversation, the agent tree, and to issue user messages and slash
 * commands. Designed for remote admin over a VPN, fronted by a reverse proxy
 * for TLS and outer auth.
 *
 * Lifecycle:
 *   - Module's `start()` opens a Bun.serve HTTP+WS server.
 *   - `setApp()` (called from index.ts after framework creation) plugs in the
 *     full AppContext so slash commands, sessions, and branch state work.
 *   - `start()` is intentionally tolerant of `setApp` being called late: WS
 *     clients that connect before app-binding are parked until binding lands.
 *
 * Decoupled transport: the module speaks plain HTTP. TLS / external auth /
 * fan-out across many VMs are the reverse-proxy's job; an optional Basic-Auth
 * check is available as defense-in-depth.
 *
 * See WEBUI-PLAN.md and src/web/protocol.ts for the wire shape.
 */

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
} from '@animalabs/agent-framework';
import type { ServerWebSocket } from 'bun';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, normalize, dirname, sep as pathSep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Recipe } from '../recipe.js';
import type { SessionManager } from '../session-manager.js';
import type { BranchState } from '../commands.js';
import { handleCommand } from '../commands.js';
import { AgentTreeReducer, type AgentTreeSnapshot } from '../state/agent-tree-reducer.js';
import { FleetTreeAggregator } from '../state/fleet-tree-aggregator.js';
import type { FleetModule } from './fleet-module.js';
import type { WireEvent } from './fleet-types.js';
import {
  WEB_PROTOCOL_VERSION,
  isClientMessage,
  type WebUiServerMessage,
  type WelcomeMessage,
  type WelcomeMessageEntry,
  type TokenUsage,
  type McplListMessage,
  type LessonsListMessage,
} from '../web/protocol.js';
import {
  readMcplServersFile,
  saveMcplServers,
  DEFAULT_CONFIG_PATH,
} from '../mcpl-config.js';
import { loadRecipe } from '../recipe.js';

/**
 * Minimal slice of AppContext the module needs. Defined locally to avoid
 * importing the full type from index.ts (which would create a cycle).
 */
export interface WebUiAppRef {
  framework: AgentFramework;
  sessionManager: SessionManager;
  recipe: Recipe;
  branchState: BranchState;
  switchSession(id: string): Promise<void>;
}

export interface WebUiModuleConfig {
  /** TCP port to bind. Default: 7340. */
  port?: number;
  /** Host to bind. Default: 127.0.0.1 — refuses non-loopback without auth. */
  host?: string;
  /** Optional Basic-Auth credentials. Sourced from `${VAR}` substitution at recipe load time. */
  basicAuth?: { username: string; password: string };
  /** Acknowledge non-loopback bind without auth. False by default; setting true is the explicit footgun lever. */
  acknowledgeNoAuth?: boolean;
  /** Path to the SPA build output. Default: `<cwd>/dist/web`. */
  staticDir?: string;
  /**
   * Origin allowlist for the WebSocket upgrade. Browsers do not enforce
   * same-origin on `new WebSocket(...)` the way they do on fetch, so without
   * an explicit Origin check any page the operator opens in another tab
   * could connect to a localhost-bound /ws and drive the host. Default:
   * `http://127.0.0.1:<port>`, `http://localhost:<port>`, plus the matching
   * `https://` forms. Override when fronted by a reverse proxy that rewrites
   * Origin (e.g. `["https://admin.example.com"]`).
   *
   * Set explicitly to `[]` to allow any Origin (or none) — only sensible
   * when the host is behind a proxy that already enforces Origin or when
   * the entire host is firewalled off from browsers.
   */
  allowedOrigins?: string[];
}

/** Per-connection state. */
interface ClientState {
  /** Stable id matching ws.data.id; used for routing fleet IPC responses. */
  id: number;
  ws: ServerWebSocket<{ id: number }>;
  /** True after we've sent the welcome message. */
  welcomed: boolean;
  /** Open peek subscriptions for this client, keyed by scope. Each entry
   *  carries its detacher so unsubscribe and disconnect both clean up
   *  without the framework leaking listeners. */
  peeks: Map<string, () => void>;
}

/** Default port — picked to be memorable and unlikely to collide. */
const DEFAULT_PORT = 7340;

/**
 * Process-level singleton state. The HTTP server, WS clients, and accumulated
 * usage snapshot must outlive any single framework instance — session-switch
 * rebuilds the framework (and thus the WebUiModule), but the open WebSocket
 * connections need to stay up. Module instances bind to the singleton on
 * `start()` and rebind their AppContext on `setApp()`; the server itself
 * never restarts within a process lifetime.
 */
interface SharedServerState {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  host: string;
  staticRoot: string;
  basicAuth?: { username: string; password: string };
  /** Resolved origin allowlist. Empty array means "no Origin check". */
  allowedOrigins: string[];
  clients: Map<number, ClientState>;
  nextClientId: number;
  latestUsage: TokenUsage;
  /** Per-agent cost breakdown captured alongside latestUsage. Re-derived on
   *  every usage:updated event so the welcome and live UsageMessage frames
   *  carry consistent values. */
  latestPerAgentCost: import('../web/protocol.js').PerAgentCost[];
  /** Currently-bound app, refreshed on every setApp() call. WS handlers read
   *  from here so the singleton always points at the live framework regardless
   *  of which WebUiModule instance is "active". */
  app: WebUiAppRef | null;
  /** Per-bind aggregator and fleet detacher. Re-created in setApp; cleared
   *  in stop(). Lives on the singleton so old WebUiModule instances don't
   *  retain handles to dead frameworks. */
  treeAggregator: FleetTreeAggregator | null;
  fleetEventDetacher: (() => void) | null;
  /** Cached child recipe summaries keyed by recipe path. Recipes are
   *  static-ish per host run (re-spawn doesn't change the file), so we
   *  parse once and reuse on every welcome. Cleared on session switch. */
  childRecipeCache: Map<string, { name: string; description?: string; version?: string; agentModel?: string }>;
  /** corrId → originating client + request kind, for routing scoped panel
   *  query responses (lessons / workspace) back to the requesting client.
   *  Entries are deleted on response or pruned by TTL. */
  pendingFleetRequests: Map<string, { clientId: number; kind: string; expiresAt: number }>;
}

let sharedServer: SharedServerState | null = null;

export class WebUiModule implements Module {
  readonly name = 'webui';

  private readonly config: WebUiModuleConfig;

  /** Serialized SPA bundle path resolved from staticDir at construction. */
  private readonly staticRoot: string;

  constructor(config: WebUiModuleConfig = {}) {
    this.config = config;
    // Default static root: <package-root>/dist/web. Derived from the module's
    // own file location so the resolution is stable regardless of process cwd.
    // This file lives at <package>/src/modules/web-ui-module.ts, so going up
    // two levels from its directory gets us the package root.
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const packageRoot = resolve(moduleDir, '..', '..');
    this.staticRoot = resolve(config.staticDir ?? join(packageRoot, 'dist', 'web'));
  }

  // -------------------------------------------------------------------------
  // Module interface
  // -------------------------------------------------------------------------

  async start(_ctx: ModuleContext): Promise<void> {
    if (sharedServer) {
      // Server already up from a previous framework lifetime. Reuse it. Config
      // collisions (e.g. a different port across recipes) are out of scope —
      // recipes within one process should declare consistent webui config.
      return;
    }

    const port = this.config.port ?? DEFAULT_PORT;
    const host = this.config.host ?? '127.0.0.1';
    this.assertSafeBind(host);

    const state: SharedServerState = {
      server: undefined as unknown as ReturnType<typeof Bun.serve>,
      port,
      host,
      staticRoot: this.staticRoot,
      basicAuth: this.config.basicAuth,
      allowedOrigins: this.config.allowedOrigins ?? defaultAllowedOrigins(port),
      clients: new Map(),
      nextClientId: 1,
      latestUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      latestPerAgentCost: [],
      pendingFleetRequests: new Map(),
      childRecipeCache: new Map(),
      app: null,
      treeAggregator: null,
      fleetEventDetacher: null,
    };
    state.server = Bun.serve({
      port,
      hostname: host,
      fetch: (req, server) => this.handleHttp(req, server),
      websocket: {
        open: (ws) => this.onWsOpen(ws as ServerWebSocket<{ id: number }>),
        message: (ws, msg) => this.onWsMessage(ws as ServerWebSocket<{ id: number }>, msg),
        close: (ws) => this.onWsClose(ws as ServerWebSocket<{ id: number }>),
      },
    });
    // When port=0 is passed (test setups, ephemeral binds), the OS picks a
    // free port and Bun.serve exposes it via `.port`. Re-read so the cached
    // port and the default Origin allowlist match the actual listener.
    // Bun's typings widen `port` to `number | undefined` for some socket
    // listener types; fall back to the requested port if the runtime didn't
    // expose one.
    const boundPort = state.server.port ?? port;
    state.port = boundPort;
    if (this.config.allowedOrigins === undefined) {
      state.allowedOrigins = defaultAllowedOrigins(boundPort);
    }
    sharedServer = state;

    console.log(`[webui] listening on http://${host}:${boundPort}`);
  }

  async stop(): Promise<void> {
    // Tear down framework-bound state only. The HTTP server and WS clients
    // belong to the process-level singleton and survive across session
    // switches; closing them here would drop active admin connections every
    // time the operator switches sessions or the framework restarts.
    if (!sharedServer) return;
    sharedServer.fleetEventDetacher?.();
    sharedServer.fleetEventDetacher = null;
    sharedServer.treeAggregator?.dispose();
    sharedServer.treeAggregator = null;
    sharedServer.app = null;
  }

  getTools(): ToolDefinition[] { return []; }

  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: false, error: 'WebUiModule has no tools', isError: true };
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  // -------------------------------------------------------------------------
  // Post-creation wiring (called from index.ts, mirrors ActivityModule.setFramework)
  // -------------------------------------------------------------------------

  setApp(app: WebUiAppRef): void {
    if (!sharedServer) return;
    const ss = sharedServer;
    ss.app = app;

    // Tear down any previous aggregator (session-switch path).
    ss.fleetEventDetacher?.();
    ss.fleetEventDetacher = null;
    ss.treeAggregator?.dispose();
    ss.treeAggregator = null;

    // Re-derive cost snapshot for the new framework. Without this the
    // welcome of the first connecting client (or all clients after a
    // session switch) would carry stale or empty per-agent costs until the
    // next inference completes.
    ss.latestPerAgentCost = this.collectPerAgentCost();
    // Recipe cache is keyed by file path; on session switch the framework
    // is fresh but children may carry over, so the cache is still valid.
    // Only clear if the entire app reference changed in a way that matters —
    // for now, retain across setApp (keeps welcome fast).

    // Single fan-out listener. The framework's `onTrace` does not return a
    // detacher, so per-client subscriptions would leak across reconnects.
    // Instead, one listener iterates the live client set and the WS lifecycle
    // owns membership. Cheap as long as the client count stays small (admin UI).
    app.framework.onTrace((event: TraceEvent) => this.fanOutTrace(event));

    // Fleet integration: if FleetModule is mounted, spin up a private
    // FleetTreeAggregator and start forwarding child events to clients. The
    // aggregator's per-child reducers are populated via the `describe`/snapshot
    // protocol, exactly as the TUI uses them — see UNIFIED-TREE-PLAN.md §3.
    const fleetMod = app.framework
      .getAllModules()
      .find((m) => m.name === 'fleet') as FleetModule | undefined;

    if (fleetMod) {
      const agg = new FleetTreeAggregator(fleetMod);
      ss.treeAggregator = agg;
      // Register existing children up front. autoStart launches finish before
      // setApp() runs, so this catches everything currently up.
      for (const childName of fleetMod.getChildren().keys()) {
        agg.registerChild(childName);
      }

      // One subscription on '*' — fan out to clients AND register newly-seen
      // children with the aggregator. This avoids a polling loop and keeps the
      // late-attach path correct.
      ss.fleetEventDetacher = fleetMod.onChildEvent('*', (childName, event) =>
        this.handleFleetEvent(childName, event),
      );
    }

    // Welcome any client that's currently connected. Two cases land here:
    //   - First setApp(): fresh page-loads parked at onWsOpen are flushed.
    //   - Post-session-switch: every previously-welcomed client gets a fresh
    //     welcome reflecting the new framework / messages / agents / branch.
    for (const client of sharedServer!.clients.values()) {
      // Force a re-welcome by clearing the flag and resending.
      client.welcomed = false;
      void this.sendWelcome(client);
    }
  }

  private handleFleetEvent(childName: string, event: WireEvent): void {
    // Auto-register on first sight so the aggregator picks up children that
    // launched after setApp() ran.
    if (sharedServer?.treeAggregator) {
      const known = new Set(sharedServer?.treeAggregator.getAllChildNames());
      if (!known.has(childName)) {
        sharedServer?.treeAggregator.registerChild(childName);
      }
    }

    // Snapshot responses to scoped panel queries — route to the requesting
    // client only. The corrId came from us; we know which client to send
    // back to without leaking child-internal data to every connected client.
    const eType = (event as { type?: unknown }).type;
    const corrId = (event as { corrId?: unknown }).corrId;
    if (
      typeof eType === 'string'
      && typeof corrId === 'string'
      && (eType === 'lessons-snapshot'
        || eType === 'workspace-mounts-snapshot'
        || eType === 'workspace-tree-snapshot'
        || eType === 'workspace-file-snapshot')
    ) {
      this.routeChildSnapshotResponse(eType, corrId, event as Record<string, unknown>);
      return; // don't fan out — these are private replies, not telemetry
    }

    if (sharedServer!.clients.size === 0) return;
    // Forward the verbatim event so the SPA can fold it into its own
    // per-child AgentTreeReducer for live updates.
    const msg: WebUiServerMessage = {
      type: 'child-event',
      childName,
      event: event as unknown as { type: string; [k: string]: unknown },
    };
    for (const client of sharedServer!.clients.values()) {
      if (!client.welcomed) continue;
      this.send(client, msg);
    }
  }

  /** Translate a child snapshot event back into the matching wire message
   *  type and forward to the originating client. The pendingFleetRequests
   *  map is the source of truth for which client asked. */
  private routeChildSnapshotResponse(
    eType: string,
    corrId: string,
    event: Record<string, unknown>,
  ): void {
    if (!sharedServer) return;
    const entry = sharedServer.pendingFleetRequests.get(corrId);
    if (!entry) return; // stale or foreign corrId; ignore
    sharedServer.pendingFleetRequests.delete(corrId);
    const client = sharedServer.clients.get(entry.clientId);
    if (!client) return;

    if (eType === 'lessons-snapshot') {
      this.send(client, {
        type: 'lessons-list',
        loaded: Boolean(event.loaded),
        lessons: (event.lessons as LessonsListMessage['lessons']) ?? [],
      });
      return;
    }
    if (eType === 'workspace-mounts-snapshot') {
      this.send(client, {
        type: 'workspace-mounts',
        loaded: Boolean(event.loaded),
        mounts: (event.mounts as Array<{ name: string; path: string; mode: string }>) ?? [],
      });
      return;
    }
    if (eType === 'workspace-tree-snapshot') {
      this.send(client, {
        type: 'workspace-tree',
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
        path: String(event.path ?? ''),
        totalLines: Number(event.totalLines ?? 0),
        fromLine: Number(event.fromLine ?? 1),
        toLine: Number(event.toLine ?? 0),
        content: String(event.content ?? ''),
        truncated: Boolean(event.truncated),
      });
      return;
    }
  }

  private fanOutTrace(event: TraceEvent): void {
    // Update cached usage snapshot first so welcomes for late-connecting
    // clients get a current value.
    if (event.type === 'usage:updated') {
      const e = event as unknown as { totals?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number; estimatedCost?: { total: number; currency: string } } };
      const t = e.totals;
      if (t) {
        sharedServer!.latestUsage = {
          input: t.inputTokens ?? 0,
          output: t.outputTokens ?? 0,
          cacheRead: t.cacheReadTokens ?? 0,
          cacheWrite: t.cacheCreationTokens ?? 0,
          ...(t.estimatedCost ? { cost: { total: t.estimatedCost.total, currency: t.estimatedCost.currency } } : {}),
        };
      }
      // Re-derive the per-agent slice from the framework's snapshot. This
      // is the only place we reach into framework internals on the trace
      // hot path; the call is O(agents) and guarded by the cached snapshot.
      sharedServer!.latestPerAgentCost = this.collectPerAgentCost();
    }

    // External-trigger surfacing — turn `message:added` traces from MCPL
    // sources into a typed wire message so the SPA can show an attribution
    // box. Fire-and-forget; lookup may fail mid-modification.
    if (event.type === 'message:added') {
      const e = event as unknown as { messageId: string; source: string };
      void this.maybeEmitTrigger(e.messageId, e.source);
    }

    if (sharedServer!.clients.size === 0) return;
    const traceMsg: WebUiServerMessage = {
      type: 'trace',
      event: event as unknown as { type: string; [k: string]: unknown },
    };
    const usageMsg: WebUiServerMessage | null = event.type === 'usage:updated'
      ? {
          type: 'usage',
          usage: sharedServer!.latestUsage,
          ...(sharedServer!.latestPerAgentCost.length > 0
            ? { perAgentCost: sharedServer!.latestPerAgentCost }
            : {}),
        }
      : null;
    for (const client of sharedServer!.clients.values()) {
      if (!client.welcomed) continue;
      this.send(client, traceMsg);
      if (usageMsg) this.send(client, usageMsg);
    }
  }

  // -------------------------------------------------------------------------
  /** Surface MCPL-sourced `message:added` traces as `inbound-trigger`
   *  envelopes so the SPA can show "incoming from zulip#X" boxes. WebUI-typed
   *  user messages are excluded — those are already optimistically rendered
   *  on the originating client. */
  /** Load a child's recipe metadata (name, description, agent model) from
   *  its recipe file path. Cached per-path on the singleton; failures
   *  resolve to undefined so the SPA can fall back to displaying the child
   *  name only. */
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
      const recipe = await loadRecipe(path);
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

  /** Pull a per-agent cost snapshot from the framework's UsageTracker.
   *  Returns [] if the framework isn't bound or no agents have been billed
   *  yet. Used by both the welcome payload and live UsageMessage frames. */
  private collectPerAgentCost(): import('../web/protocol.js').PerAgentCost[] {
    if (!sharedServer?.app) return [];
    const fw = sharedServer.app.framework as unknown as {
      getSessionUsage?(): {
        byAgent: Array<{
          agentName: string;
          usage: { estimatedCost?: { total: number; currency: string } };
          inferenceCount: number;
        }>;
      };
    };
    if (typeof fw.getSessionUsage !== 'function') return [];
    let snap;
    try { snap = fw.getSessionUsage(); }
    catch { return []; }
    const out: import('../web/protocol.js').PerAgentCost[] = [];
    for (const agent of snap.byAgent) {
      const c = agent.usage.estimatedCost;
      if (!c) continue;
      out.push({ name: agent.agentName, cost: { total: c.total, currency: c.currency }, inferenceCount: agent.inferenceCount });
    }
    return out;
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
    for (const client of sharedServer.clients.values()) {
      if (!client.welcomed) continue;
      this.send(client, msg);
    }
  }

  // -------------------------------------------------------------------------
  // HTTP — static SPA + WS upgrade
  // -------------------------------------------------------------------------

  private async handleHttp(req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      // Origin check FIRST — drive-by CSRF on a localhost-bound WS is the
      // failure mode this guards. Browsers do not enforce same-origin on
      // `new WebSocket(...)` the way they do on fetch, so without an
      // explicit check, any tab the operator opens could connect here.
      if (!this.checkOrigin(req)) return new Response('Forbidden', { status: 403 });
      if (!this.checkAuth(req)) return this.unauthorized();
      const id = sharedServer!.nextClientId++;
      const ok = server.upgrade(req, { data: { id } });
      if (!ok) return new Response('Upgrade failed', { status: 400 });
      // Bun returns undefined on success; the response is taken over by the upgrade.
      return new Response(null, { status: 101 });
    }

    if (!this.checkAuth(req)) return this.unauthorized();

    // Workspace file passthrough: /files/<mount>/<path...>
    // Resolves through WorkspaceModule.resolveAbsolutePath, which enforces
    // mount-relative containment and the mount's read-permission. We never
    // serve a path the agent framework's mount layer wouldn't itself serve.
    if (url.pathname.startsWith('/files/')) {
      return this.serveWorkspaceFile(url.pathname.slice('/files/'.length));
    }

    // Static SPA
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    return this.serveStatic(requested);
  }

  private async serveWorkspaceFile(rest: string): Promise<Response> {
    if (!sharedServer?.app) return new Response('Not ready', { status: 503 });
    const decoded = decodeURIComponent(rest);
    const slash = decoded.indexOf('/');
    if (slash < 0) return new Response('Bad request', { status: 400 });
    const mount = decoded.slice(0, slash);
    const inMountPath = decoded.slice(slash + 1);
    const mountPrefixed = `${mount}/${inMountPath}`;

    const ws = sharedServer.app.framework.getModule('workspace');
    if (!ws || !('resolveAbsolutePath' in ws)) {
      return new Response('Workspace not mounted', { status: 503 });
    }
    const abs = (ws as { resolveAbsolutePath: (p: string) => string | null }).resolveAbsolutePath(mountPrefixed);
    if (!abs) return new Response('Forbidden', { status: 403 });

    try {
      const data = await readFile(abs);
      return new Response(data, { headers: { 'content-type': mimeFor(abs) } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  }

  private async serveStatic(requestedPath: string): Promise<Response> {
    // Path containment: resolve and verify the result is still under staticRoot.
    // Plain startsWith without a separator is unsafe — both `<root>` and
    // `<root>-evil/...` pass `startsWith('<root>')`. The current callers
    // pass relative paths so this is unreachable today, but a future
    // refactor that lets absolute paths slip through would turn it into a
    // real escape; require either an exact match or a trailing separator.
    const root = sharedServer!.staticRoot;
    const safePath = normalize(join(root, requestedPath));
    if (safePath !== root && !safePath.startsWith(root + pathSep)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const s = await stat(safePath);
      if (s.isDirectory()) {
        return this.serveStatic(join(requestedPath, 'index.html'));
      }
      const data = await readFile(safePath);
      return new Response(data, { headers: { 'content-type': mimeFor(safePath) } });
    } catch {
      // Fall back to index.html so the SPA can handle client-side routing.
      try {
        const indexPath = join(sharedServer!.staticRoot, 'index.html');
        const data = await readFile(indexPath);
        return new Response(data, { headers: { 'content-type': 'text/html' } });
      } catch {
        return new Response(
          `WebUI bundle not found at ${sharedServer!.staticRoot}. Run \`npm run build:web\` (or postinstall) to produce it.`,
          { status: 503, headers: { 'content-type': 'text/plain' } },
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket lifecycle
  // -------------------------------------------------------------------------

  private onWsOpen(ws: ServerWebSocket<{ id: number }>): void {
    const id = ws.data.id;
    const client: ClientState = { id, ws, welcomed: false, peeks: new Map() };
    sharedServer!.clients.set(id, client);

    if (sharedServer?.app) void this.sendWelcome(client);
    // Else: park until setApp() flushes welcomes.
  }

  private onWsMessage(ws: ServerWebSocket<{ id: number }>, raw: string | Buffer): void {
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

    if (!sharedServer?.app) {
      this.send(client, { type: 'error', message: 'host not ready' });
      return;
    }

    switch (parsed.type) {
      case 'ping':
        // No reply — round-trip already confirmed by the message arriving.
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

      case 'route-to-child': {
        void this.handleRouteToChild(client, parsed.childName, parsed.content);
        return;
      }

      case 'interrupt': {
        if (!sharedServer?.app) return;
        const fw = sharedServer.app.framework;
        // Cancel any in-process subagents so their results propagate.
        const subMod = fw.getAllModules().find((m) => m.name === 'subagent') as
          | { cancelAll(): number }
          | undefined;
        const cancelled = subMod?.cancelAll() ?? 0;
        for (const agent of fw.getAllAgents()) {
          try { agent.cancelStream(); } catch { /* idempotent */ }
        }
        this.send(client, {
          type: 'command-result',
          lines: [{
            text: cancelled > 0 ? `interrupted — ${cancelled} subagent(s) stopped` : 'interrupted',
            style: 'system',
          }],
        });
        return;
      }

      case 'subscribe-peek':
        this.handleSubscribePeek(client, parsed.scope, parsed.active);
        return;

      case 'cancel-subagent': {
        if (!sharedServer?.app) return;
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
        void this.handleFleetControl(client, parsed.type, parsed.name);
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
        this.sendMcplList(client);
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
          // Replace env wholesale; empty object clears it.
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

  /** Generate a corrId, register the requesting client, and dispatch a
   *  request to the fleet child. The reply lands in handleFleetEvent which
   *  looks the corrId up in pendingFleetRequests to find the client. */
  private routeFleetRequest(
    client: ClientState,
    childName: string,
    kind: string,
    dispatch: (corrId: string, fleet: FleetModule) => boolean,
  ): void {
    if (!sharedServer?.app) return;
    // Sweep expired entries before we add a new one. Without this the map
    // grows unbounded whenever a child is wedged — every "refresh files"
    // click pins another corrId until process exit. The sweep notifies the
    // originating client of the timeout instead of swallowing it.
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
      // 30s TTL — lessons/workspace queries are quick; if the child is wedged,
      // we don't want pending entries piling up forever.
      expiresAt: Date.now() + 30_000,
    });
    const ok = dispatch(corrId, fleet);
    if (!ok) {
      sharedServer.pendingFleetRequests.delete(corrId);
      this.send(client, { type: 'error', message: `child '${childName}' is not available` });
    }
  }

  /** Drop expired entries from `pendingFleetRequests` and notify the
   *  originating client of each one. Idempotent — handlers tolerate the
   *  late-arriving real reply (entry just won't be in the map anymore). */
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
        message: `${entry.kind} request timed out (child unresponsive after 30s)`,
      });
    }
  }

  /** Workspace surface — three small wrappers over the WorkspaceModule's
   *  public tools (`ls`, `read`). Going through tools instead of internals
   *  keeps the SPA decoupled from module implementation details. */

  private async workspaceMod(): Promise<
    | { handleToolCall(call: { name: string; input: unknown; id?: string }): Promise<{ success: boolean; data?: unknown; error?: string }> }
    | undefined
  > {
    if (!sharedServer?.app) return undefined;
    return sharedServer.app.framework.getAllModules().find((m) => m.name === 'workspace') as
      | { handleToolCall(call: { name: string; input: unknown; id?: string }): Promise<{ success: boolean; data?: unknown; error?: string }> }
      | undefined;
  }

  private async sendWorkspaceMounts(client: ClientState): Promise<void> {
    const mod = await this.workspaceMod();
    if (!mod) {
      this.send(client, { type: 'workspace-mounts', loaded: false, mounts: [] });
      return;
    }
    try {
      const result = await mod.handleToolCall({ name: 'ls', input: {}, id: `webui-ls-${Date.now()}` });
      const data = (result.data ?? {}) as { mounts?: Array<{ name: string; path: string; mode: string }> };
      this.send(client, {
        type: 'workspace-mounts',
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
    // Cap responses by both lines AND bytes. Lines alone don't bound the
    // wire frame: a minified bundle, JSON-on-one-line, or infolog.txt with
    // embedded base64 can run 5k lines and still be hundreds of MB. The
    // byte cap (256 KB) is the actual safety net — operators reading
    // larger files should drop into a shell on the host.
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
      const data = (result.data ?? {}) as {
        path?: string;
        totalLines?: number;
        fromLine?: number;
        toLine?: number;
        content?: string;
      };
      const totalLines = data.totalLines ?? 0;
      const reportedToLine = data.toLine ?? totalLines;
      let content = data.content ?? '';
      let toLine = reportedToLine;
      let truncatedByBytes = false;
      if (Buffer.byteLength(content, 'utf-8') > BYTE_LIMIT) {
        // Truncate at a UTF-8 boundary at-or-before BYTE_LIMIT bytes, then
        // adjust toLine to the last full line in the truncated content so
        // the SPA doesn't draw a half-line at the bottom.
        const truncated = sliceUtf8(content, BYTE_LIMIT);
        const lastNl = truncated.lastIndexOf('\n');
        content = lastNl >= 0 ? truncated.slice(0, lastNl) : truncated;
        const fromLine = data.fromLine ?? 1;
        toLine = fromLine + content.split('\n').length - 1;
        truncatedByBytes = true;
      }
      this.send(client, {
        type: 'workspace-file',
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

  /** Read mcpl-servers.json and ship the list to a single client. The bound
   *  config path is whatever the host's mcpl-config module resolves at
   *  module-load time — usually `<cwd>/mcpl-servers.json`. */
  private sendMcplList(client: ClientState): void {
    let servers: ReturnType<typeof readMcplServersFile> = {};
    try { servers = readMcplServersFile(DEFAULT_CONFIG_PATH); }
    catch { /* missing or malformed file → empty list */ }
    const out: McplListMessage = {
      type: 'mcpl-list',
      configPath: DEFAULT_CONFIG_PATH,
      servers: Object.entries(servers).map(([id, entry]) => ({
        id,
        command: entry.command,
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.env ? { env: entry.env } : {}),
        ...(entry.toolPrefix ? { toolPrefix: entry.toolPrefix } : {}),
        ...(entry.reconnect !== undefined ? { reconnect: entry.reconnect } : {}),
        ...(entry.enabledFeatureSets ? { enabledFeatureSets: entry.enabledFeatureSets } : {}),
        ...(entry.disabledFeatureSets ? { disabledFeatureSets: entry.disabledFeatureSets } : {}),
      })),
    };
    this.send(client, out);
  }

  /** Build a LessonsListMessage from the bound LessonsModule, if present. */
  private sendLessonsList(client: ClientState): void {
    if (!sharedServer?.app) return;
    const lessonsMod = sharedServer.app.framework.getAllModules().find((m) => m.name === 'lessons') as
      | { getLessons(): Array<{ id: string; content: string; confidence: number; tags: string[]; deprecated: boolean; deprecationReason?: string; created?: number; updated?: number }> }
      | undefined;
    if (!lessonsMod) {
      this.send(client, { type: 'lessons-list', loaded: false, lessons: [] });
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
    this.send(client, { type: 'lessons-list', loaded: true, lessons });
  }

  /** Names of fleet children currently running. Empty when no fleet module
   *  is mounted or every child has stopped. */
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

  /** Defer SIGTERM so the WS frame flushes, then trigger the existing
   *  graceful-shutdown handler. process.exit fallback covers the case where
   *  no SIGTERM listener is registered (e.g. TUI mode). */
  private scheduleShutdown(): void {
    setTimeout(() => {
      try { process.kill(process.pid, 'SIGTERM'); }
      catch { process.exit(0); }
    }, 150);
  }

  /** Honor the operator's response to a quit-confirm-required prompt.
   *  kill-children: stop them gracefully, then SIGTERM. Detach: SIGTERM
   *  immediately and let them orphan. Cancel: keep the host running. */
  private async handleQuitConfirm(action: 'kill-children' | 'detach' | 'cancel'): Promise<void> {
    if (action === 'cancel') return;
    if (action === 'detach') {
      this.scheduleShutdown();
      return;
    }
    // kill-children: dispatch fleet kills in parallel and wait briefly.
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

  /**
   * Open or close a peek window for a subagent or fleet child.
   *
   * For in-process subagents we hook SubagentModule.onPeekStream(name) and
   * forward each event as a `peek` message scoped to the subagent name.
   *
   * For fleet children we don't need a separate subscription — child events
   * already flow to all welcomed clients via handleFleetEvent. Returning
   * "fleet child" here is enough to confirm the panel can rely on the
   * existing stream.
   */
  private handleSubscribePeek(client: ClientState, scope: string, active: boolean): void {
    if (!active) {
      const detach = client.peeks.get(scope);
      if (detach) {
        try { detach(); } catch { /* ignore */ }
        client.peeks.delete(scope);
      }
      return;
    }

    // Idempotent: re-subscribing to an already-open scope is a no-op.
    if (client.peeks.has(scope)) return;

    if (!sharedServer?.app) return;

    // Fleet child path — events already arrive via child-event; no separate
    // subscription is needed. Mark the slot so unsubscribe-peek symmetry
    // works without special-casing.
    const fleetMod = sharedServer.app.framework
      .getAllModules()
      .find((m) => m.name === 'fleet') as { getChildren(): ReadonlyMap<string, unknown> } | undefined;
    if (fleetMod && fleetMod.getChildren().has(scope)) {
      client.peeks.set(scope, () => { /* no-op detach */ });
      return;
    }

    // In-process subagent path — register on SubagentModule.onPeekStream.
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
    // Backfill: send a one-shot summary derived from the subagent's current
    // peek snapshot before live events start. Operators opening a peek panel
    // shouldn't see "Waiting for events…" when the agent is mid-task — the
    // peek already knows what's in flight.
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

  /** Push a synthetic backfill bundle for a subagent peek subscription so the
   *  client renders something meaningful immediately rather than waiting for
   *  the next live event. Best-effort — peek may fail mid-modification. */
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

    // Header line — gives operators an at-a-glance read on what they're
    // looking at without scrolling for context.
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
      // Replay accumulated stream tokens as a single tokens event; the
      // client folds tokens by newline so this renders as the most recent
      // few stream lines in cyan.
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

  private onWsClose(ws: ServerWebSocket<{ id: number }>): void {
    const id = ws.data.id;
    const client = sharedServer?.clients.get(id);
    if (client) {
      for (const detach of client.peeks.values()) {
        try { detach(); } catch { /* ignore */ }
      }
      client.peeks.clear();
    }
    sharedServer?.clients.delete(id);
  }

  /**
   * Run a slash command and surface its CommandResult plus any side effects
   * (workspace materialization on branch change, session switch on
   * switchToSessionId, async follow-up). All clients see fresh welcomes after
   * branch / session changes since those affect framework-wide state, not
   * just the issuing client.
   */
  private async dispatchCommand(client: ClientState, command: string, corrId?: string): Promise<void> {
    if (!sharedServer?.app) return;
    let result;
    try {
      result = handleCommand(command, sharedServer?.app);
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

    // /quit handling. If the recipe has running fleet children, hold the
    // shutdown and ask the operator how to handle them — same three-way
    // prompt as the TUI. Otherwise fall through to immediate SIGTERM.
    if (result.quit) {
      const running = this.runningFleetChildren();
      if (running.length > 0) {
        this.send(client, { type: 'quit-confirm-required', children: running });
        return;
      }
      this.scheduleShutdown();
    }

    // Branch-change side effects parity with TUI / runPiped: materialize the
    // _config mount so gate.json etc. stay in sync, then refresh every
    // welcomed client by re-sending welcome with the new branch's messages.
    if (result.branchChanged) {
      await this.materializeConfigMount();
      this.broadcastBranchChanged();
      this.refreshAllWelcomes();
    }

    // Session switch — destroys + recreates the framework. setApp() is called
    // by index.ts after the switch lands, which re-welcomes everyone.
    if (result.switchToSessionId) {
      try {
        await sharedServer?.app.switchSession(result.switchToSessionId);
        // setApp() re-flushes welcomes; nothing more to do here.
      } catch (err) {
        this.send(client, {
          type: 'error',
          corrId,
          message: `session switch failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Async follow-up (e.g. /newtopic Haiku summarization).
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
          await this.materializeConfigMount();
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
      // Materialization is best-effort; failures here shouldn't break the UI.
    }
  }

  private broadcastBranchChanged(): void {
    if (!sharedServer?.app) return;
    const cm = sharedServer?.app.framework.getAllAgents()[0]?.getContextManager();
    if (!cm) return;
    const branch = cm.currentBranch();
    const msg: WebUiServerMessage = {
      type: 'branch-changed',
      branch: { id: branch.id, name: branch.name },
    };
    for (const c of sharedServer!.clients.values()) {
      if (c.welcomed) this.send(c, msg);
    }
  }

  private refreshAllWelcomes(): void {
    for (const c of sharedServer!.clients.values()) {
      c.welcomed = false;
      void this.sendWelcome(c);
    }
  }

  // -------------------------------------------------------------------------
  // Outgoing — welcome, traces, etc.
  // -------------------------------------------------------------------------

  private async sendWelcome(client: ClientState): Promise<void> {
    if (!sharedServer?.app) return;

    const welcome = await this.buildWelcome();
    this.send(client, welcome);
    client.welcomed = true;
    // Live trace forwarding is driven by the single fan-out listener
    // installed in setApp(); membership is implicit in `sharedServer!.clients`.
  }

  private async buildWelcome(): Promise<WelcomeMessage> {
    const app = sharedServer?.app!;
    const fw = app.framework;
    const agents = fw.getAllAgents();
    const session = app.sessionManager.getActiveSession();
    if (!session) {
      throw new Error('cannot build welcome: no active session');
    }

    // Conversation snapshot via the first agent's context manager; matches
    // tui.ts loadSessionHistory.
    const cm = agents[0]?.getContextManager();
    const messages: WelcomeMessageEntry[] = [];
    if (cm) {
      for (const msg of cm.getAllMessages()) {
        const entry = flattenMessage(msg as unknown as MessageLike);
        messages.push(entry);
      }
    }

    // Parent-local snapshot via a transient reducer fed by the framework's
    // current trace history. We have no replayable past traces, so the
    // initial snapshot just registers the agents — the live trace stream
    // takes over from there. Future: persist a parent-local reducer if
    // cold-attach state recovery becomes important.
    const localReducer = new AgentTreeReducer();
    localReducer.seedFrameworkAgents(agents.map(a => a.name));
    const localSnap: AgentTreeSnapshot = localReducer.getSnapshot();

    // Per-child snapshots from the FleetTreeAggregator (if mounted). Each
    // child's reducer was either freshly seeded by `describe` on the most
    // recent lifecycle:ready, or empty if the child hasn't responded yet —
    // either way the live event stream keeps it current.
    const childTrees: WelcomeMessage['childTrees'] = [];
    if (sharedServer?.treeAggregator) {
      const fleetMod = sharedServer.app?.framework.getAllModules().find((m) => m.name === 'fleet') as
        | FleetModule | undefined;
      for (const name of sharedServer?.treeAggregator.getAllChildNames()) {
        const nodes = sharedServer?.treeAggregator.getChildNodes(name);
        const recipeInfo = fleetMod ? await this.loadChildRecipeInfo(fleetMod, name) : undefined;
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
      localTree: {
        asOfTs: localSnap.asOfTs,
        nodes: localSnap.nodes as unknown as Array<Record<string, unknown>>,
        callIdIndex: localSnap.callIdIndex,
      },
      childTrees,
      usage: sharedServer!.latestUsage,
      ...(sharedServer!.latestPerAgentCost.length > 0
        ? { perAgentCost: sharedServer!.latestPerAgentCost }
        : {}),
    };
  }

  private send(client: ClientState, msg: WebUiServerMessage): void {
    try {
      client.ws.send(JSON.stringify(msg));
    } catch {
      // Connection dropped between send attempts; close handler will clean up.
    }
  }

  // -------------------------------------------------------------------------
  // Auth / safety
  // -------------------------------------------------------------------------

  private assertSafeBind(host: string): void {
    const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
    if (isLoopback) return;
    if (this.config.basicAuth) return;
    if (this.config.acknowledgeNoAuth) return;
    throw new Error(
      `WebUiModule refuses to bind ${host} without auth. Set basicAuth, ` +
      `or set acknowledgeNoAuth: true if you've fronted this with a reverse proxy ` +
      `that handles authentication. (Localhost binding skips this check.)`,
    );
  }

  /**
   * Validate the Origin header against the configured allowlist. An empty
   * allowlist means "no Origin check" — only sensible behind a proxy that
   * enforces it for us. Same-origin native clients (curl, custom MCP
   * tooling) typically send no Origin at all; we accept those as well, since
   * the threat model here is browsers cross-origin connecting from another
   * tab. Auth still gates anything sensitive.
   */
  private checkOrigin(req: Request): boolean {
    if (!sharedServer) return false;
    const allow = sharedServer.allowedOrigins;
    if (allow.length === 0) return true;
    const origin = req.headers.get('origin');
    // No Origin header → not a browser cross-origin attempt. (Browsers
    // always set Origin on WebSocket upgrades; non-browser clients usually
    // don't.)
    if (!origin) return true;
    return allow.includes(origin);
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
    // Use SHA-256 digests so the timing-safe compare runs over fixed-length
    // buffers regardless of credential length, and a wrong-length input
    // doesn't bail early via the length-mismatch path. Both halves are
    // always compared so a mismatch in `user` doesn't short-circuit `pass`.
    const userOk = constantTimeStringEq(user, this.config.basicAuth.username);
    const passOk = constantTimeStringEq(pass, this.config.basicAuth.password);
    return userOk && passOk;
  }

  private unauthorized(): Response {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'www-authenticate': 'Basic realm="connectome-host"' },
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Default Origin allowlist for the WebSocket upgrade. Covers the recommended
 * deployment (loopback bind, page served from the same Bun.serve), plus the
 * `https://` form so a Caddy/nginx terminating TLS in front of this still
 * works without overriding `allowedOrigins` explicitly.
 */
function defaultAllowedOrigins(port: number): string[] {
  return [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `https://127.0.0.1:${port}`,
    `https://localhost:${port}`,
  ];
}

/**
 * Constant-time string equality. Hashes both inputs with SHA-256 first so the
 * underlying compare runs on fixed-length 32-byte buffers — `timingSafeEqual`
 * itself throws on length mismatch, which leaks length, and direct buffer
 * compares of the raw strings would leak length too. Two HMAC-style
 * comparisons (same input through SHA-256 twice) is a standard pattern.
 */
function constantTimeStringEq(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf-8').digest();
  const hb = createHash('sha256').update(b, 'utf-8').digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Slice a string to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte sequence. Buffer.from + slice + toString is the standard idiom;
 * if the cut would land mid-codepoint, walk back to the last lead byte.
 */
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
  timestamp?: number;
}

function flattenMessage(msg: MessageLike): WelcomeMessageEntry {
  const textParts: string[] = [];
  const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];

  for (const block of msg.content) {
    const b = block as unknown as { type: string; text?: unknown; id?: string; name?: string; input?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') {
      textParts.push(b.text);
    } else if (b.type === 'tool_use') {
      if (typeof b.id === 'string' && typeof b.name === 'string') {
        toolCalls.push({ id: b.id, name: b.name, input: b.input });
      }
    }
    // tool_result blocks are dropped; the assistant message that owns them
    // already conveys the conversation flow.
  }

  const entry: WelcomeMessageEntry = {
    participant: normalizeParticipant(msg.participant),
    text: textParts.join('\n'),
  };
  if (msg.id) entry.id = msg.id;
  if (toolCalls.length > 0) entry.toolCalls = toolCalls;
  if (msg.timestamp) entry.timestamp = msg.timestamp;
  return entry;
}

/** The framework stores assistant turns under the agent's name (e.g.
 *  "commander", "miner") rather than the literal "assistant" string. The TUI
 *  treats anything not 'user' as agent output; mirror that here so the WebUI
 *  doesn't render restored agent turns as user messages on session resume. */
function normalizeParticipant(raw: string): WelcomeMessageEntry['participant'] {
  if (raw === 'user' || raw === 'system' || raw === 'tool') return raw;
  return 'assistant';
}

/** Build a human label for an MCPL trigger origin. The exact metadata shape
 *  varies by MCPL flavor (channel-incoming carries channelId; push-event has
 *  serverId + featureSet) — surface what's most informative without
 *  over-fitting to one server's schema. */
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

/** MCPL channel-incoming carries `author: { id, name }` in metadata; push
 *  events sometimes do via origin spread. Best-effort extraction. */
function extractAuthorName(md: Record<string, unknown>): string | undefined {
  const author = md.author;
  if (author && typeof author === 'object' && 'name' in author) {
    const name = (author as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return undefined;
}

/** Pull a flat-text excerpt out of a content-block array. Mirrors what
 *  flattenMessage does for assistant turns, scoped down to a single string. */
function extractText(content: ReadonlyArray<unknown>): string {
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
//
// The HTTP server lives at module scope (process-level singleton). Tests need
// to read the actual bound port when they pass `port: 0`, and they need to
// shut the server down between files even though normal lifecycle keeps it
// running across session switches. These helpers exist solely for tests; they
// are not part of the public module API.

/** Return the bound listener port, or null if the singleton hasn't started. */
export function __getSharedServerPortForTests(): number | null {
  return sharedServer?.port ?? null;
}

/** Forcibly tear down the shared HTTP server and clear the singleton, so a
 *  subsequent `start()` boots a fresh one. Tests only. */
export async function __resetSharedServerForTests(): Promise<void> {
  if (!sharedServer) return;
  try { sharedServer.server.stop(true); } catch { /* ignore */ }
  // Detach any fleet listener / aggregator so the next start runs clean.
  sharedServer.fleetEventDetacher?.();
  sharedServer.treeAggregator?.dispose();
  sharedServer = null;
}
