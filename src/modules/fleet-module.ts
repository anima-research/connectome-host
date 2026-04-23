/**
 * FleetModule — orchestrates child connectome-host processes.
 *
 * Each child is spawned as a detached subprocess running `bun src/index.ts
 * <recipe> --headless`, with its own DATA_DIR and Chronicle store.  The
 * parent connects to the child's Unix socket at {dataDir}/ipc.sock and
 * exchanges JSONL envelopes (see `fleet-types.ts`, `HEADLESS-FLEET-PLAN.md`).
 *
 * Tools: launch / list / status / send / command / peek / kill / restart / relay / await.
 *
 * Naming note: this module's `launch` is deliberately NOT `spawn` — the
 * agent framework's SubagentModule already owns `subagent--spawn` for an
 * in-process ephemeral agent with a different identity and lifecycle.
 * `fleet--launch` means "start a separate recipe-driven child process"
 * and should not be confused with it.
 * Features: autoStart on framework start, allowedRecipes enforcement,
 * autoRestart with flap cap, Chronicle persistence of fleet state, and
 * adopt-on-restart (reattach to living children after parent restart).
 * Shutdown supports detach mode (leave children alive for next parent).
 */

import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '@animalabs/agent-framework';
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { connect as netConnect, type Socket } from 'node:net';
import { existsSync, mkdirSync, unlinkSync, openSync, closeSync, appendFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { type IncomingCommand, type WireEvent, matchesSubscription } from './fleet-types.js';

export type FleetEventCallback = (childName: string, event: WireEvent) => void;

interface FleetEventSubscription {
  callback: FleetEventCallback;
  /** If null, subscriber receives every event.  Otherwise a subscription set (supports glob). */
  filter: Set<string> | null;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface FleetModuleConfig {
  /** Default subscription sent to children at handshake (default: ['*']). */
  defaultSubscription?: string[];
  /** Max events to retain per child for peek (default: 500). */
  bufferSize?: number;
  /** How long to wait for child socket file to appear after spawn (default: 15s). */
  socketWaitTimeoutMs?: number;
  /** How long to wait for child to emit lifecycle:ready after socket connect (default: 10s). */
  readyTimeoutMs?: number;
  /** How long to wait after sending shutdown before SIGTERM escalation (default: 10s). */
  gracefulShutdownMs?: number;
  /** How long after SIGTERM before SIGKILL escalation (default: 5s). */
  sigtermEscalationMs?: number;
  /**
   * Path to the connectome-host entry script that children execute.
   * Default: process.argv[1] (re-runs the parent's entry script).
   * Override for test harnesses or shipped distributions where the parent
   * was launched via a wrapper that obscures the real entry path.
   */
  childIndexPath?: string;
  /**
   * Path to the runtime binary used to spawn children.
   * Default: process.execPath (whatever bun the parent is running under).
   */
  childRuntimePath?: string;
  /**
   * Children to launch on start().  Each child spawns concurrently;
   * start() returns immediately (spawns are fire-and-forget so a slow
   * child doesn't block framework start).
   */
  autoStart?: AutoStartChild[];
  /**
   * Recipes the conductor may launch via fleet--launch, on top of whatever is
   * already listed in autoStart (those are implicitly allowed).  If BOTH
   * autoStart and allowedRecipes are absent, the allowlist is disabled and
   * any recipe is allowed (matches Phase 2/3 ad-hoc usage).
   *
   * Pattern syntax: literal exact match, trailing `"*"` for prefix match,
   * or a bare `"*"` for "allow everything".  Mid-string `*` is NOT a glob —
   * the validateRecipe schema check rejects it to keep the pattern intent
   * aligned with the matcher.
   */
  allowedRecipes?: string[];
}

export interface AutoStartChild {
  name: string;
  recipe: string;
  dataDir?: string;
  env?: Record<string, string>;
  subscription?: string[];
  /** Default true. Set false to register the child in the allowlist without launching it. */
  autoStart?: boolean;
  /** Phase 5 honours this; accepted now for forward-compat. */
  autoRestart?: boolean;
}

interface LaunchInput {
  name: string;
  recipe: string;
  dataDir?: string;
  env?: Record<string, string>;
  subscription?: string[];
  /** Respawn on crash. Default false. */
  autoRestart?: boolean;
}

type ChildStatus = 'starting' | 'ready' | 'exited' | 'crashed';

/**
 * Subset of FleetChild that is serializable to Chronicle.  Live handles
 * (process, socket) and ephemeral state (event buffer, line buffer) are
 * excluded.  Stored under the module's state namespace and re-hydrated
 * on module start() for adopt-on-restart.
 */
interface PersistedChild {
  name: string;
  recipePath: string;
  dataDir: string;
  socketPath: string;
  pid: number | null;
  status: ChildStatus;
  startedAt: number;
  exitedAt: number | null;
  lastEventAt: number | null;
  exitCode: number | null;
  exitReason: string | null;
  subscription: string[];
  autoRestart: boolean;
  env: Record<string, string> | null;
}

interface PersistedFleetState {
  children: Record<string, PersistedChild>;
}

interface FleetChild {
  name: string;
  recipePath: string;
  dataDir: string;
  socketPath: string;
  pid: number | null;
  process: ChildProcess | null;
  socket: Socket | null;
  status: ChildStatus;
  startedAt: number;
  exitedAt: number | null;
  lastEventAt: number | null;
  exitCode: number | null;
  exitReason: string | null;
  events: WireEvent[];   // ring buffer (up to bufferSize)
  buffer: string;        // socket line buffer
  subscription: string[];
  /** Whether autoRestart is enabled for this child. */
  autoRestart: boolean;
  /** True between kill request and process exit — suppresses autoRestart for intentional shutdowns. */
  killRequested: boolean;
  /** Timestamps of recent autoRestart attempts, for flap protection. */
  restartAttempts: number[];
  /** Env and optional envOverride persisted so autoRestart can respawn with the same config. */
  env?: Record<string, string>;
  /**
   * Most recent speech from a non-tool-ending inference round, as reported
   * by the child's synthetic `inference:speech` event.  Empty until the
   * child's primary agent has spoken at least once without ending in
   * tool calls.  Used by fleet--relay.
   */
  lastCompletedSpeech: string;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class FleetModule implements Module {
  readonly name = 'fleet';

  private ctx: ModuleContext | null = null;
  private children = new Map<string, FleetChild>();
  private config: Required<Omit<FleetModuleConfig, 'autoStart' | 'allowedRecipes'>>;
  private autoStartChildren: AutoStartChild[];
  /** Set when stop() has been called; suppresses autoRestart during shutdown. */
  private stopping = false;
  /** When true, stop() leaves children alive so a later parent can adopt them. */
  private detachMode = false;
  /** Window in ms and cap used for autoRestart flap detection. */
  private readonly restartFlapWindowMs = 60_000;
  private readonly restartFlapCap = 3;
  /**
   * Effective allowlist entries.  Only consulted when `allowlistEnabled` is
   * true; when false, every recipe is allowed.
   */
  private allowlist: string[];
  private allowlistEnabled: boolean;
  /**
   * Push subscribers keyed by child name; '*' receives every child's events.
   * Used by the TUI peek view to render live streams without polling the
   * rolling buffer.  Each subscription carries an optional filter so
   * different consumers (conductor context, TUI pane, peek view) can get
   * different slices of the same wire stream.
   */
  private eventSubscribers = new Map<string, Set<FleetEventSubscription>>();

  constructor(config: FleetModuleConfig = {}) {
    this.config = {
      defaultSubscription: config.defaultSubscription ?? ['*'],
      bufferSize: config.bufferSize ?? 500,
      socketWaitTimeoutMs: config.socketWaitTimeoutMs ?? 15_000,
      readyTimeoutMs: config.readyTimeoutMs ?? 10_000,
      gracefulShutdownMs: config.gracefulShutdownMs ?? 10_000,
      sigtermEscalationMs: config.sigtermEscalationMs ?? 5_000,
      childIndexPath: config.childIndexPath ?? process.argv[1] ?? '',
      childRuntimePath: config.childRuntimePath ?? process.execPath,
    };

    this.autoStartChildren = config.autoStart ?? [];

    const explicit = config.allowedRecipes;
    const implicit = this.autoStartChildren.map((c) => c.recipe);
    // Allowlist is active only when the user gave us something to work with —
    // either an explicit list or a set of declared children.  Otherwise we
    // stay in Phase 2/3 "open" mode so ad-hoc instantiation isn't broken.
    this.allowlistEnabled = explicit !== undefined || implicit.length > 0;
    this.allowlist = [...(explicit ?? []), ...implicit];
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    // First, try to adopt any still-alive children from a prior parent run.
    // Adoption is best-effort: for each persisted child we probe liveness
    // (PID + socket connect) and, if responsive, reattach without respawn.
    // Dead children get cleaned up and may be respawned below.
    const adoptedNames = await this.adoptPersistedChildren();

    // Kick off autoStart children concurrently; errors don't block framework
    // boot.  Skip any that were already adopted — re-spawning them would
    // create a duplicate alongside the still-running instance.
    for (const child of this.autoStartChildren) {
      if (child.autoStart === false) continue;
      if (adoptedNames.has(child.name)) continue;

      const input: LaunchInput = { name: child.name, recipe: child.recipe };
      if (child.dataDir !== undefined) input.dataDir = child.dataDir;
      if (child.env !== undefined) input.env = child.env;
      if (child.subscription !== undefined) input.subscription = child.subscription;
      if (child.autoRestart !== undefined) input.autoRestart = child.autoRestart;

      this.handleLaunch(input, { viaAutoStart: true })
        .then((res) => {
          if (!res.success) {
            console.error(`[fleet] autoStart "${child.name}" failed: ${res.error}`);
          }
        })
        .catch((err: unknown) => {
          console.error(`[fleet] autoStart "${child.name}" threw: ${String(err)}`);
        });
    }
  }

  /**
   * Persist the current children map to Chronicle (via ModuleContext).
   * Called after every lifecycle transition so a parent restart can see
   * the last known state.  Ephemeral fields (process handle, socket,
   * event buffer) are excluded.
   */
  private persistState(): void {
    if (!this.ctx) return;
    if (typeof this.ctx.setState !== 'function') return;
    const persisted: Record<string, PersistedChild> = {};
    for (const [name, c] of this.children) {
      persisted[name] = {
        name: c.name,
        recipePath: c.recipePath,
        dataDir: c.dataDir,
        socketPath: c.socketPath,
        pid: c.pid,
        status: c.status,
        startedAt: c.startedAt,
        exitedAt: c.exitedAt,
        lastEventAt: c.lastEventAt,
        exitCode: c.exitCode,
        exitReason: c.exitReason,
        subscription: [...c.subscription],
        autoRestart: c.autoRestart,
        env: c.env ?? null,
      };
    }
    this.ctx.setState<PersistedFleetState>({ children: persisted });
  }

  /**
   * Probe persisted children for liveness and reattach to the live ones.
   * Returns the set of names we successfully adopted so autoStart can
   * skip them.  For each dead orphan, we clean up the stale socket/pid
   * files so fresh spawns don't trip over them.
   */
  private async adoptPersistedChildren(): Promise<Set<string>> {
    const adopted = new Set<string>();
    if (!this.ctx) return adopted;
    if (typeof this.ctx.getState !== 'function') return adopted;

    let state: PersistedFleetState | null;
    try {
      state = this.ctx.getState<PersistedFleetState>();
    } catch {
      return adopted;
    }
    if (!state?.children) return adopted;

    for (const [name, p] of Object.entries(state.children)) {
      // Only living-ish statuses are worth probing.  Anything we previously
      // marked exited/crashed stays in the record so status/list show it,
      // but we don't try to adopt.
      if (p.status !== 'ready' && p.status !== 'starting') {
        // Copy the record back into our live map as historical context.
        this.children.set(name, this.reconstructOrphan(p));
        continue;
      }

      const alive = await this.probeLiveness(p);
      if (!alive) {
        this.cleanupStaleChildFiles(p);
        const orphan = this.reconstructOrphan(p);
        orphan.status = 'crashed';
        orphan.exitReason = 'orphaned (parent restarted; child not alive)';
        this.children.set(name, orphan);
        continue;
      }

      // Attempt to reattach to its socket.  If anything in this fails,
      // fall back to treating it as dead.
      try {
        const reattached = await this.reattachToLivingChild(p);
        this.children.set(name, reattached);
        adopted.add(name);
        console.error(`[fleet] adopted "${name}" (pid=${p.pid}, socket=${p.socketPath})`);
      } catch (err) {
        console.error(`[fleet] failed to adopt "${name}": ${String(err)}`);
        this.cleanupStaleChildFiles(p);
        const orphan = this.reconstructOrphan(p);
        orphan.status = 'crashed';
        orphan.exitReason = `adopt failed: ${err instanceof Error ? err.message : String(err)}`;
        this.children.set(name, orphan);
      }
    }

    this.persistState();
    return adopted;
  }

  /**
   * Build a live-map entry from a persisted record WITHOUT connecting to
   * the child.  Used for historical records (status = exited / crashed)
   * and as a scaffold for the adopt path.
   */
  private reconstructOrphan(p: PersistedChild): FleetChild {
    const child: FleetChild = {
      name: p.name,
      recipePath: p.recipePath,
      dataDir: p.dataDir,
      socketPath: p.socketPath,
      pid: p.pid,
      process: null,
      socket: null,
      status: p.status,
      startedAt: p.startedAt,
      exitedAt: p.exitedAt,
      lastEventAt: p.lastEventAt,
      exitCode: p.exitCode,
      exitReason: p.exitReason,
      events: [],
      buffer: '',
      subscription: [...p.subscription],
      autoRestart: p.autoRestart,
      killRequested: false,
      restartAttempts: [],
      lastCompletedSpeech: '',  // not persisted; rebuilt on next inference:speech
    };
    if (p.env) child.env = p.env;
    return child;
  }

  /**
   * Check whether a persisted child appears to be alive.
   * Criteria: PID is alive (process.kill(pid, 0) doesn't throw) AND the
   * socket file exists on disk.  A true probe of the socket happens in
   * reattachToLivingChild; this is the cheap pre-check.
   */
  private async probeLiveness(p: PersistedChild): Promise<boolean> {
    if (p.pid === null) return false;
    try {
      process.kill(p.pid, 0);
    } catch {
      return false;
    }
    if (!existsSync(p.socketPath)) return false;
    return true;
  }

  /**
   * Connect to the child's Unix socket and treat the adopted connection as
   * if we just spawned the child.  The child's headless runtime closes the
   * previous client (if any) and re-emits lifecycle:ready for us.
   *
   * PID-reuse guard: the process.kill(pid,0) pre-check in probeLiveness
   * only verifies *some* process owns the PID — on a stale socket after a
   * reboot, that can be an unrelated process.  We verify the first
   * lifecycle:ready event's pid matches the persisted pid; if it doesn't,
   * we've connected to a stranger and abort the adoption.
   */
  private async reattachToLivingChild(p: PersistedChild): Promise<FleetChild> {
    const child = this.reconstructOrphan(p);
    child.status = 'starting';  // transitions to 'ready' via the lifecycle event once reattached

    // Capture the first lifecycle:ready's pid.  We subscribe *before*
    // connecting so we can't miss the event (the child emits it
    // synchronously inside its connection handler).
    let observedPid: number | null | undefined;
    const unsubPidCheck = this.onChildEvent(child.name, (_, evt) => {
      if (observedPid !== undefined) return;
      if (evt.type === 'lifecycle' && (evt as { phase?: string }).phase === 'ready') {
        const pid = (evt as { pid?: number | null }).pid;
        observedPid = pid ?? null;
      }
    });

    try {
      await this.connectChildSocket(child);
      try {
        this.sendToChild(child, { type: 'subscribe', events: p.subscription });
      } catch { /* the ready-wait below will fail if the subscribe couldn't land */ }
      await this.waitForReady(child);

      if (observedPid !== p.pid) {
        throw new Error(
          `PID mismatch on adopt: expected pid=${p.pid}, got pid=${observedPid ?? 'undefined'}. ` +
          `Likely stale socket / PID reuse after reboot.`,
        );
      }
    } catch (err) {
      // Close the socket we might have opened so we don't leave a dangling
      // connection to a stranger's server.
      try { child.socket?.destroy(); } catch { /* noop */ }
      child.socket = null;
      throw err;
    } finally {
      unsubPidCheck();
    }

    return child;
  }

  /** Remove leftover PID / socket files for a dead child. */
  private cleanupStaleChildFiles(p: PersistedChild): void {
    try { if (existsSync(p.socketPath)) unlinkSync(p.socketPath); } catch { /* noop */ }
    const pidPath = p.socketPath.replace(/ipc\.sock$/, 'headless.pid');
    try { if (existsSync(pidPath)) unlinkSync(pidPath); } catch { /* noop */ }
  }

  /**
   * Attempt to restart a crashed child.  Tracks recent attempts per-child
   * and refuses further restarts once the flap cap is exceeded within the
   * flap window.  Delay grows exponentially per attempt so a deterministic
   * startup bug doesn't fire-hose the log before the flap cap kicks in.
   */
  private tryAutoRestart(child: FleetChild): void {
    const now = Date.now();
    child.restartAttempts = child.restartAttempts.filter((t) => now - t < this.restartFlapWindowMs);
    if (child.restartAttempts.length >= this.restartFlapCap) {
      console.error(
        `[fleet] autoRestart disabled for "${child.name}" — ${this.restartFlapCap} crashes in ${this.restartFlapWindowMs / 1000}s`,
      );
      return;
    }
    child.restartAttempts.push(now);
    const attempt = child.restartAttempts.length;

    // Exponential backoff with small jitter to de-sync sibling crashes:
    // attempt 1 -> ~1s, attempt 2 -> ~3s, attempt 3 -> ~10s.
    const baseMs = attempt === 1 ? 1_000 : attempt === 2 ? 3_000 : 10_000;
    const jitterMs = Math.floor(Math.random() * Math.min(500, baseMs / 4));
    const delayMs = baseMs + jitterMs;

    console.error(`[fleet] autoRestart "${child.name}" (attempt ${attempt}, in ${delayMs}ms)`);

    const input: LaunchInput = {
      name: child.name,
      recipe: child.recipePath,
      dataDir: child.dataDir,
      subscription: [...child.subscription],
      autoRestart: true,
    };
    if (child.env !== undefined) input.env = child.env;

    // Drop the crashed record so handleLaunch can register a fresh one.
    this.children.delete(child.name);

    setTimeout(() => {
      if (this.stopping) return;
      this.handleLaunch(input, { viaAutoStart: true })
        .then((res) => {
          if (!res.success) {
            console.error(`[fleet] autoRestart "${child.name}" failed: ${res.error}`);
          }
        })
        .catch((err: unknown) => {
          console.error(`[fleet] autoRestart "${child.name}" threw: ${String(err)}`);
        });
    }, delayMs);
  }

  async stop(): Promise<void> {
    // Mark shutdown so the process 'exit' handlers don't trigger autoRestart.
    this.stopping = true;

    if (this.detachMode) {
      // Detach: close socket references only; leave child processes alive so
      // a later parent can adopt them.  Children's own headless runtimes
      // keep running because they were spawned with detached: true.
      for (const c of this.children.values()) {
        try { c.socket?.destroy(); } catch { /* noop */ }
        c.socket = null;
      }
      this.ctx = null;
      return;
    }

    const tasks: Array<Promise<void>> = [];
    for (const child of this.children.values()) {
      tasks.push(this.killChild(child).catch(() => { /* swallow per-child errors */ }));
    }
    await Promise.all(tasks);
    this.ctx = null;
  }

  /**
   * Set detach mode: on parent shutdown, leave children running so the
   * next parent invocation can adopt them.  Normal shutdown (detachMode
   * false) kills all children gracefully.
   */
  setDetachMode(on: boolean): void {
    this.detachMode = on;
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  /** Read-only view of children, for tests / TUI integration. */
  getChildren(): ReadonlyMap<string, Readonly<FleetChild>> {
    return this.children;
  }

  /**
   * Subscribe to wire events from a child (or '*' for all children).
   * Returns an unsubscribe function.
   *
   * @param filter  Optional subscription set; if provided, the callback only
   *                fires for events matching it (same glob semantics as the
   *                wire-level subscription: '*', 'tool:*', 'inference:completed').
   *                Omit to receive every event.
   *
   * Note that this filter narrows *further* than the wire-level subscription
   * the FleetModule sent to the child — the child's subscription is the upper
   * bound (can't subscribe locally to events the child doesn't send).
   */
  onChildEvent(name: string | '*', callback: FleetEventCallback, filter?: string[]): () => void {
    let subs = this.eventSubscribers.get(name);
    if (!subs) {
      subs = new Set();
      this.eventSubscribers.set(name, subs);
    }
    const sub: FleetEventSubscription = {
      callback,
      filter: filter && filter.length > 0 ? new Set(filter) : null,
    };
    subs.add(sub);
    return (): void => {
      const set = this.eventSubscribers.get(name);
      if (!set) return;
      set.delete(sub);
      if (set.size === 0) this.eventSubscribers.delete(name);
    };
  }

  // =========================================================================
  // Tool definitions + dispatch
  // =========================================================================

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'launch',
        description:
          'Launch a child connectome-host process running the given recipe in headless mode. ' +
          'Distinct from subagent--spawn (which creates an in-process ephemeral agent): this starts a ' +
          'separate OS process with its own Chronicle store, MCPL servers, and lifecycle. ' +
          'Returns once the child reports ready, or fails. ' +
          'Environment is inherited from the parent and cannot be overridden via this tool — ' +
          'that belongs in the recipe (modules.fleet.children[].env) so it sits on the trusted side of the boundary.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Unique short name for the child.' },
            recipe: { type: 'string', description: 'Recipe path (relative to parent CWD or absolute) or http(s) URL.' },
            dataDir: { type: 'string', description: 'Data directory override (default: ./data/<name>).' },
            subscription: {
              type: 'array',
              items: { type: 'string' },
              description: 'Event types to subscribe to (supports glob like "tool:*"). Default: all events.',
            },
            autoRestart: {
              type: 'boolean',
              description: 'Respawn on crash (non-zero exit, not signal). Default false.',
            },
          },
          required: ['name', 'recipe'],
        },
      },
      {
        name: 'list',
        description: 'List all known children with their current status.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'status',
        description: 'Detailed status for one child (or all if name omitted).',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Child name; omit for all.' },
          },
        },
      },
      {
        name: 'send',
        description: 'Send a user-style text message to a child. Triggers inference in the child.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['name', 'content'],
        },
      },
      {
        name: 'command',
        description: 'Run a slash command in a child (e.g. "/status", "/help"). Output streams back as command-output events.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            command: { type: 'string', description: 'Slash command including leading "/".' },
          },
          required: ['name', 'command'],
        },
      },
      {
        name: 'peek',
        description: "Return the last N events from a child's rolling event buffer.",
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            lines: { type: 'number', description: 'How many recent events (default: 50, capped at buffer size).' },
          },
          required: ['name'],
        },
      },
      {
        name: 'kill',
        description: 'Stop a child gracefully (shutdown command), escalate to SIGTERM then SIGKILL if it does not exit.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          required: ['name'],
        },
      },
      {
        name: 'restart',
        description: 'Kill and respawn a child with the same recipe + dataDir + subscription it was originally launched with.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          required: ['name'],
        },
      },
      {
        name: 'relay',
        description:
          "Forward the source child's most recent completed speech to the target child as a text message. " +
          'Speech is the text from an inference round that did not end in tool calls (the child\'s "final answer" from its last turn). ' +
          'Source-child status is NOT checked: as long as the source spoke at least once before exiting, ' +
          'its last speech can still be relayed (useful for "pass on the dead child\'s last findings"). ' +
          'Target child must be running. ' +
          'Requires the source child\'s subscription to include `inference:speech`.',
        inputSchema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Source child name — whose speech to forward.' },
            to: { type: 'string', description: 'Target child name — recipient of the relayed message.' },
            prefix: {
              type: 'string',
              description: 'Optional text prepended to the relayed content (e.g. "Backend says:").',
            },
          },
          required: ['from', 'to'],
        },
      },
      {
        name: 'await',
        description:
          'Block until the named children go idle (framework quiescent for >=500ms). ' +
          'Returns when all (or any, if requireAll:false) are idle, or on timeout. ' +
          'Fails fast if a waited-for child crashes or exits before going idle. ' +
          'Requires each child\'s subscription to include `lifecycle` events.',
        inputSchema: {
          type: 'object',
          properties: {
            names: {
              type: 'array',
              items: { type: 'string' },
              description: 'Children to wait on.',
            },
            timeoutMs: {
              type: 'number',
              description: 'Give up after this many ms and return partial results. Default 300000 (5 min).',
            },
            requireAll: {
              type: 'boolean',
              description: 'Wait for every named child (true, default) or return as soon as any one goes idle (false).',
            },
          },
          required: ['names'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    try {
      switch (call.name) {
        case 'launch':  return await this.handleLaunch(call.input as LaunchInput, { viaAutoStart: false });
        case 'list':    return this.handleList();
        case 'status':  return this.handleStatus(call.input as { name?: string });
        case 'send':    return this.handleSend(call.input as { name: string; content: string });
        case 'command': return this.handleCommand(call.input as { name: string; command: string });
        case 'peek':    return this.handlePeek(call.input as { name: string; lines?: number });
        case 'kill':    return await this.handleKill(call.input as { name: string });
        case 'restart': return await this.handleRestart(call.input as { name: string });
        case 'relay':   return this.handleRelay(call.input as { from: string; to: string; prefix?: string });
        case 'await':   return await this.handleAwait(call.input as { names: string[]; timeoutMs?: number; requireAll?: boolean });
        default:
          return { success: false, isError: true, error: `Unknown fleet tool: ${call.name}` };
      }
    } catch (err) {
      return {
        success: false,
        isError: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // =========================================================================
  // Tool handlers
  // =========================================================================

  private async handleLaunch(
    input: LaunchInput,
    opts: { viaAutoStart: boolean } = { viaAutoStart: false },
  ): Promise<ToolResult> {
    if (!input.name || typeof input.name !== 'string') {
      return { success: false, isError: true, error: 'launch requires "name" string' };
    }
    if (!input.recipe || typeof input.recipe !== 'string') {
      return { success: false, isError: true, error: 'launch requires "recipe" string' };
    }

    // allowedRecipes enforcement — skip for autoStart (implicitly trusted).
    // Match against both the raw string (for explicit literal allowedRecipes
    // like `"recipes/*"`) and the CWD-resolved absolute form (for implicit
    // entries derived from `children[]`, which now carry absolute paths after
    // recipe-load-time resolution).
    if (!opts.viaAutoStart && this.allowlistEnabled) {
      const resolvedInput = isUrlOrAbsolute(input.recipe)
        ? input.recipe
        : resolve(process.cwd(), input.recipe);
      if (!this.matchesAllowlist(input.recipe, resolvedInput)) {
        return {
          success: false,
          isError: true,
          error:
            `Recipe "${input.recipe}" is not in the allowlist. ` +
            `Allowed: ${this.allowlist.join(', ') || '(none)'}. ` +
            `Ask the user to approve it (add to modules.fleet.allowedRecipes in the parent recipe) and retry.`,
        };
      }
    }

    // env may only be set on the recipe-trusted path (autoStart).  If an
    // agent smuggles it through the agent-facing fleet--launch tool (the
    // schema doesn't advertise it; this is belt-and-suspenders), strip it
    // here before it can reach child_process.spawn().  Prevents LD_PRELOAD /
    // NODE_OPTIONS / ANTHROPIC_BASE_URL and similar injection.
    //
    // Rebind to a local copy rather than mutating the caller's ToolCall.input
    // object — the framework may not reuse it today, but defensively copy
    // then strip is the safer pattern.
    if (!opts.viaAutoStart && input.env !== undefined) {
      input = { ...input, env: undefined };
    }

    const existing = this.children.get(input.name);
    if (existing && (existing.status === 'starting' || existing.status === 'ready')) {
      return {
        success: false,
        isError: true,
        error: `Child '${input.name}' is already ${existing.status}`,
      };
    }
    // Drop the old record if it had previously exited/crashed — re-spawn replaces.
    if (existing) this.children.delete(input.name);

    const recipePath = isUrlOrAbsolute(input.recipe)
      ? input.recipe
      : resolve(process.cwd(), input.recipe);

    const dataDir = input.dataDir
      ? (isAbsolute(input.dataDir) ? input.dataDir : resolve(process.cwd(), input.dataDir))
      : resolve(process.cwd(), 'data', input.name);

    mkdirSync(dataDir, { recursive: true });

    const socketPath = join(dataDir, 'ipc.sock');
    const subscription = input.subscription ?? this.config.defaultSubscription;

    const child: FleetChild = {
      name: input.name,
      recipePath,
      dataDir,
      socketPath,
      pid: null,
      process: null,
      socket: null,
      status: 'starting',
      startedAt: Date.now(),
      exitedAt: null,
      lastEventAt: null,
      exitCode: null,
      exitReason: null,
      events: [],
      buffer: '',
      subscription: [...subscription],
      autoRestart: input.autoRestart ?? false,
      killRequested: false,
      restartAttempts: [],
      lastCompletedSpeech: '',
    };
    if (input.env !== undefined) child.env = input.env;
    this.children.set(input.name, child);

    if (!this.config.childIndexPath) {
      this.children.delete(input.name);
      return {
        success: false,
        isError: true,
        error: 'cannot determine connectome-host script path (configure FleetModule with childIndexPath)',
      };
    }

    // Capture early-crash output on disk.  If the child dies before
    // headless.ts installs its runtime log redirect — missing bun, bad
    // shebang, ANTHROPIC_API_KEY validation exit, recipe parse failure,
    // import crash — this is the only place that output can land.  After
    // the runtime redirect runs, console output flows into headless.log
    // instead; startup.log just holds the pre-redirect bootstrap slice.
    const startupLogPath = join(dataDir, 'startup.log');
    try {
      appendFileSync(startupLogPath, `\n--- launch ${new Date().toISOString()} recipe=${recipePath} pid=parent:${process.pid} ---\n`);
    } catch { /* best-effort; directory existed from mkdirSync above */ }
    let startupFd: number | null = null;
    try {
      startupFd = openSync(startupLogPath, 'a');
    } catch {
      startupFd = null;  // fall back to stdio: 'ignore' if we can't open the file
    }

    const proc = spawnProcess(
      this.config.childRuntimePath,
      [this.config.childIndexPath, recipePath, '--headless'],
      {
        detached: true,
        stdio: startupFd !== null ? ['ignore', startupFd, startupFd] : 'ignore',
        env: { ...process.env, ...input.env, DATA_DIR: dataDir },
      },
    );
    proc.unref();

    // Parent doesn't need the fd once the child has inherited it.
    if (startupFd !== null) {
      try { closeSync(startupFd); } catch { /* noop */ }
    }

    child.process = proc;
    child.pid = proc.pid ?? null;

    proc.on('exit', (code, signal) => {
      child.exitedAt = Date.now();
      child.exitCode = code ?? null;
      child.exitReason = signal ?? (code === 0 ? 'clean' : `code=${code}`);
      child.status = code === 0 ? 'exited' : 'crashed';
      try { child.socket?.destroy(); } catch { /* noop */ }
      child.socket = null;

      this.persistState();

      // autoRestart: respawn on crash (non-zero non-null exit), skip if:
      //   - we asked the child to stop (killRequested)
      //   - parent framework is shutting down (this.stopping)
      //   - exit was via external signal (code null + signal set)
      //   - autoRestart is false or flap cap exceeded
      const crashed = code !== null && code !== 0;
      if (
        child.autoRestart &&
        crashed &&
        !child.killRequested &&
        !this.stopping
      ) {
        this.tryAutoRestart(child);
      }
    });

    try {
      await this.waitForSocket(child);
      await this.connectChildSocket(child);
    } catch (err) {
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
      child.status = 'crashed';
      child.exitReason = err instanceof Error ? err.message : String(err);
      return { success: false, isError: true, error: `launch failed: ${child.exitReason}` };
    }

    // Set the subscription filter on the child immediately.
    try {
      this.sendToChild(child, { type: 'subscribe', events: subscription });
    } catch (err) {
      return { success: false, isError: true, error: `subscribe failed: ${(err as Error).message}` };
    }

    try {
      await this.waitForReady(child);
    } catch (err) {
      return { success: false, isError: true, error: `child did not become ready: ${(err as Error).message}` };
    }

    this.persistState();

    return {
      success: true,
      data: {
        name: child.name,
        pid: child.pid,
        dataDir: child.dataDir,
        socketPath: child.socketPath,
        status: child.status,
      },
    };
  }

  private handleList(): ToolResult {
    const list = [...this.children.values()].map((c) => ({
      name: c.name,
      status: c.status,
      pid: c.pid,
      startedAt: c.startedAt,
      exitedAt: c.exitedAt,
      lastEventAt: c.lastEventAt,
      eventCount: c.events.length,
    }));
    return { success: true, data: list };
  }

  private handleStatus(input: { name?: string }): ToolResult {
    if (input.name) {
      const c = this.children.get(input.name);
      if (!c) return { success: false, isError: true, error: `Unknown child: ${input.name}` };
      return { success: true, data: this.statusOf(c) };
    }
    return { success: true, data: [...this.children.values()].map((c) => this.statusOf(c)) };
  }

  private statusOf(c: FleetChild): Record<string, unknown> {
    return {
      name: c.name,
      recipePath: c.recipePath,
      dataDir: c.dataDir,
      socketPath: c.socketPath,
      pid: c.pid,
      status: c.status,
      startedAt: c.startedAt,
      exitedAt: c.exitedAt,
      lastEventAt: c.lastEventAt,
      exitCode: c.exitCode,
      exitReason: c.exitReason,
      eventCount: c.events.length,
      subscription: [...c.subscription],
    };
  }

  private handleSend(input: { name: string; content: string }): ToolResult {
    const ok = this.requireRunning(input.name);
    if (!('child' in ok)) return ok;
    if (typeof input.content !== 'string') {
      return { success: false, isError: true, error: 'send requires "content" string' };
    }
    this.sendToChild(ok.child, { type: 'text', content: input.content });
    return { success: true, data: { name: input.name, sent: 'text' } };
  }

  private handleCommand(input: { name: string; command: string }): ToolResult {
    const ok = this.requireRunning(input.name);
    if (!('child' in ok)) return ok;
    if (typeof input.command !== 'string') {
      return { success: false, isError: true, error: 'command requires "command" string' };
    }
    this.sendToChild(ok.child, { type: 'command', command: input.command });
    return { success: true, data: { name: input.name, sent: 'command', command: input.command } };
  }

  private handlePeek(input: { name: string; lines?: number }): ToolResult {
    const c = this.children.get(input.name);
    if (!c) return { success: false, isError: true, error: `Unknown child: ${input.name}` };
    const requested = input.lines ?? 50;
    const n = Math.max(1, Math.min(requested, c.events.length || 1));
    const slice = c.events.length > 0 ? c.events.slice(-n) : [];
    return { success: true, data: { name: c.name, count: slice.length, events: slice } };
  }

  private async handleKill(input: { name: string }): Promise<ToolResult> {
    const c = this.children.get(input.name);
    if (!c) return { success: false, isError: true, error: `Unknown child: ${input.name}` };
    if (c.status === 'exited' || c.status === 'crashed') {
      return { success: true, data: { name: c.name, status: c.status, note: 'already stopped' } };
    }
    await this.killChild(c);
    return {
      success: true,
      data: { name: c.name, status: c.status, exitCode: c.exitCode, exitReason: c.exitReason },
    };
  }

  private async handleRestart(input: { name: string }): Promise<ToolResult> {
    const c = this.children.get(input.name);
    if (!c) return { success: false, isError: true, error: `Unknown child: ${input.name}` };
    const relaunch: LaunchInput = {
      name: c.name,
      recipe: c.recipePath,
      dataDir: c.dataDir,
      subscription: [...c.subscription],
    };
    if (c.status === 'starting' || c.status === 'ready') {
      await this.killChild(c);
    }
    this.children.delete(c.name);
    // Restart is implicitly allowed — we're using the exact recipe the child
    // was originally launched with (which already passed the allowlist check).
    return await this.handleLaunch(relaunch, { viaAutoStart: true });
  }

  /**
   * Check whether a recipe string is allowed by the configured allowlist.
   * Prefix-match-only: literal exact match, bare `"*"` for any, or trailing
   * `"*"` for prefix match.  Mid-string `*` is rejected at recipe
   * validation time so it can't silently fail here.
   *
   * Two forms of the input are tried against each entry: the raw string
   * (as the agent supplied it — matches explicit literal entries like
   * `"recipes/*"`) and a CWD-resolved absolute form (matches implicit
   * entries derived from `children[]`, which are absolute post-load).
   */
  private matchesAllowlist(recipe: string, resolved: string): boolean {
    for (const entry of this.allowlist) {
      if (entry === '*') return true;
      if (entry === recipe || entry === resolved) return true;
      if (entry.endsWith('*') && !entry.slice(0, -1).includes('*')) {
        const prefix = entry.slice(0, -1);
        if (recipe.startsWith(prefix) || resolved.startsWith(prefix)) return true;
      }
    }
    return false;
  }

  /**
   * Relay the source child's last completed speech to the target child.
   *
   * Source-child status is intentionally NOT enforced: a crashed or exited
   * child still has its `lastCompletedSpeech` in memory (until the parent
   * itself shuts down) and there are real workflows where you want to pass
   * the dying child's last words to a survivor.  The target, by contrast,
   * must be running — we can't deliver a message to a dead socket.
   */
  private handleRelay(input: { from: string; to: string; prefix?: string }): ToolResult {
    if (!input.from || !input.to) {
      return { success: false, isError: true, error: 'relay requires "from" and "to"' };
    }
    if (input.from === input.to) {
      return { success: false, isError: true, error: 'relay source and target must be different children' };
    }
    const fromChild = this.children.get(input.from);
    if (!fromChild) {
      return { success: false, isError: true, error: `Unknown source child: ${input.from}` };
    }
    const target = this.requireRunning(input.to);
    if (!('child' in target)) return target;

    const speech = fromChild.lastCompletedSpeech;
    if (!speech) {
      return {
        success: false,
        isError: true,
        error:
          `No completed speech available from '${input.from}'. ` +
          `The child needs to have produced at least one non-tool-ending inference, ` +
          `AND its subscription must include 'inference:speech'.`,
      };
    }

    const content = input.prefix ? `${input.prefix}\n\n${speech}` : speech;
    this.sendToChild(target.child, { type: 'text', content });
    return { success: true, data: { from: input.from, to: input.to, chars: content.length } };
  }

  private async handleAwait(input: {
    names: string[];
    timeoutMs?: number;
    requireAll?: boolean;
  }): Promise<ToolResult> {
    if (!Array.isArray(input.names) || input.names.length === 0) {
      return { success: false, isError: true, error: 'await requires a non-empty "names" array' };
    }
    // Dedupe so requireAll doesn't double-count the same child and wait forever.
    const names = [...new Set(input.names)];
    for (const name of names) {
      if (!this.children.has(name)) {
        return { success: false, isError: true, error: `Unknown child: ${name}` };
      }
    }

    // Pre-check terminal state — if any waited-for child is already crashed/exited,
    // there's no idle to wait for; short-circuit instead of paying the 200ms
    // crashPoll latency.  Same wording as the in-flight crash error below so
    // callers get a consistent shape.
    for (const name of names) {
      const c = this.children.get(name)!;
      if (c.status === 'crashed' || c.status === 'exited') {
        return {
          success: false,
          isError: true,
          error:
            `Child '${name}' ${c.status} before reaching idle ` +
            `(exitCode=${c.exitCode ?? '?'}, reason=${c.exitReason ?? '?'}). ` +
            `Completed so far: (none).`,
        };
      }
    }

    const requireAll = input.requireAll !== false;  // default true
    const timeoutMs = input.timeoutMs ?? 300_000;
    const startedAt = Date.now();

    // Children that are *already* idle when the call begins should count
    // as done — look at the most recent lifecycle event on each.
    const done = new Set<string>();
    for (const name of names) {
      if (this.isMostRecentLifecycleIdle(this.children.get(name)!)) done.add(name);
    }

    const metCriterion = (): boolean => requireAll
      ? done.size === names.length
      : done.size >= 1;

    if (metCriterion()) {
      return {
        success: true,
        data: { names: [...done], waitedMs: 0, completed: true },
      };
    }

    return new Promise<ToolResult>((resolve) => {
      const unsubs: Array<() => void> = [];
      let finished = false;

      const finish = (result: ToolResult): void => {
        if (finished) return;
        finished = true;
        for (const u of unsubs) u();
        clearTimeout(timeoutHandle);
        clearInterval(crashPoll);
        resolve(result);
      };

      // Subscribe to each child; count lifecycle:idle events toward done.
      for (const name of names) {
        const unsub = this.onChildEvent(name, (childName, evt) => {
          if (evt.type !== 'lifecycle') return;
          if ((evt as { phase?: string }).phase !== 'idle') return;
          done.add(childName);
          if (metCriterion()) {
            finish({
              success: true,
              data: { names: [...done], waitedMs: Date.now() - startedAt, completed: true },
            });
          }
        });
        unsubs.push(unsub);
      }

      // Poll for crash/exit — children leaving the running state before
      // reaching idle short-circuits the wait with an error.
      const crashPoll = setInterval(() => {
        for (const name of names) {
          if (done.has(name)) continue;
          const c = this.children.get(name);
          if (!c) continue;
          if (c.status === 'crashed' || c.status === 'exited') {
            finish({
              success: false,
              isError: true,
              error:
                `Child '${name}' ${c.status} before reaching idle ` +
                `(exitCode=${c.exitCode ?? '?'}, reason=${c.exitReason ?? '?'}). ` +
                `Completed so far: ${[...done].join(', ') || '(none)'}.`,
            });
            return;
          }
        }
      }, 200);

      const timeoutHandle = setTimeout(() => {
        finish({
          success: false,
          isError: true,
          error:
            `await timed out after ${timeoutMs}ms. ` +
            `Idle: ${[...done].join(', ') || '(none)'}. ` +
            `Still pending: ${names.filter((n) => !done.has(n)).join(', ')}.`,
        });
      }, timeoutMs);
    });
  }

  /** Walk a child's event history backwards to find the most recent lifecycle event. */
  private isMostRecentLifecycleIdle(child: FleetChild): boolean {
    for (let i = child.events.length - 1; i >= 0; i--) {
      const e = child.events[i]!;
      if (e.type === 'lifecycle') {
        return (e as { phase?: string }).phase === 'idle';
      }
    }
    return false;
  }

  private requireRunning(name: string): { child: FleetChild } | ToolResult {
    const c = this.children.get(name);
    if (!c) return { success: false, isError: true, error: `Unknown child: ${name}` };
    if (c.status !== 'ready' && c.status !== 'starting') {
      return { success: false, isError: true, error: `Child '${name}' is ${c.status}, not running` };
    }
    if (!c.socket) {
      return { success: false, isError: true, error: `Child '${name}' has no active socket` };
    }
    return { child: c };
  }

  // =========================================================================
  // Subprocess + socket plumbing
  // =========================================================================

  private async waitForSocket(child: FleetChild): Promise<void> {
    const timeout = this.config.socketWaitTimeoutMs;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (child.process && child.process.exitCode !== null) {
        throw new Error(`child exited (code=${child.process.exitCode}) before socket appeared`);
      }
      if (existsSync(child.socketPath)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`socket did not appear at ${child.socketPath} within ${timeout}ms`);
  }

  private async connectChildSocket(child: FleetChild): Promise<void> {
    return new Promise((resolveConn, rejectConn) => {
      const sock = netConnect(child.socketPath);
      const timer = setTimeout(() => {
        sock.destroy();
        rejectConn(new Error('socket connect timeout'));
      }, 3_000);

      sock.once('connect', () => {
        clearTimeout(timer);
        child.socket = sock;
        sock.on('data', (chunk: Buffer) => this.handleChildData(child, chunk));
        sock.on('end', () => {
          if (child.socket === sock) child.socket = null;
        });
        sock.on('error', () => {
          // Errors get reflected in status via process exit; don't crash parent.
        });
        resolveConn();
      });
      sock.once('error', (err) => {
        clearTimeout(timer);
        rejectConn(err);
      });
    });
  }

  private async waitForReady(child: FleetChild): Promise<void> {
    const timeout = this.config.readyTimeoutMs;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (child.status === 'ready') return;
      if (child.status === 'crashed' || child.status === 'exited') {
        throw new Error(`child ${child.status} before ready`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`child did not report ready within ${timeout}ms`);
  }

  private handleChildData(child: FleetChild, chunk: Buffer): void {
    child.buffer += chunk.toString('utf-8');
    let nl: number;
    while ((nl = child.buffer.indexOf('\n')) >= 0) {
      const line = child.buffer.slice(0, nl).trim();
      child.buffer = child.buffer.slice(nl + 1);
      if (!line) continue;
      let parsed: WireEvent;
      try {
        parsed = JSON.parse(line) as WireEvent;
      } catch {
        continue;  // drop malformed lines silently
      }
      this.recordEvent(child, parsed);
    }
  }

  private recordEvent(child: FleetChild, event: WireEvent): void {
    child.lastEventAt = Date.now();
    child.events.push(event);
    if (child.events.length > this.config.bufferSize) {
      child.events.splice(0, child.events.length - this.config.bufferSize);
    }
    let statusChanged = false;
    if (event.type === 'lifecycle') {
      const phase = (event as { phase?: string }).phase;
      if (phase === 'ready' && child.status !== 'ready') {
        child.status = 'ready';
        statusChanged = true;
      }
      // 'exiting' is informational; the real status transition happens on
      // the process 'exit' handler so we capture exit code + signal.
      // 'idle' is informational — fan-out lets fleet--await subscribers
      // resolve; no status field change.
    } else if (event.type === 'inference:speech') {
      const content = (event as { content?: string }).content;
      if (typeof content === 'string') {
        child.lastCompletedSpeech = content;
      }
    }
    this.fanOutEvent(child.name, event);
    if (statusChanged) this.persistState();
  }

  private fanOutEvent(childName: string, event: WireEvent): void {
    const type = typeof event.type === 'string' ? event.type : '';
    for (const key of [childName, '*']) {
      const subs = this.eventSubscribers.get(key);
      if (!subs) continue;
      for (const sub of subs) {
        if (sub.filter && !matchesSubscription(type, sub.filter)) continue;
        try { sub.callback(childName, event); } catch { /* don't let one subscriber kill the loop */ }
      }
    }
  }

  private sendToChild(child: FleetChild, cmd: IncomingCommand): void {
    if (!child.socket) {
      throw new Error(`Child '${child.name}' has no socket`);
    }
    child.socket.write(JSON.stringify(cmd) + '\n');
  }

  private async killChild(child: FleetChild): Promise<void> {
    const proc = child.process;
    if (!proc) return;
    if (child.status === 'exited' || child.status === 'crashed') return;

    // Mark intent so the exit handler doesn't trigger autoRestart.
    child.killRequested = true;

    if (child.socket) {
      try { this.sendToChild(child, { type: 'shutdown', graceful: true }); } catch { /* noop */ }
    }
    if (await this.waitForExit(proc, this.config.gracefulShutdownMs)) return;

    try { proc.kill('SIGTERM'); } catch { /* noop */ }
    if (await this.waitForExit(proc, this.config.sigtermEscalationMs)) return;

    try { proc.kill('SIGKILL'); } catch { /* noop */ }
    await this.waitForExit(proc, 2_000);
  }

  private waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (proc.exitCode !== null) return Promise.resolve(true);
    return new Promise((res) => {
      const timer = setTimeout(() => {
        proc.off('exit', onExit);
        res(false);
      }, timeoutMs);
      const onExit = (): void => {
        clearTimeout(timer);
        res(true);
      };
      proc.once('exit', onExit);
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isUrlOrAbsolute(p: string): boolean {
  return p.startsWith('http://') || p.startsWith('https://') || isAbsolute(p);
}

// ---------------------------------------------------------------------------
// Shared formatter — used by both the TUI process view and the /fleet list
// slash command so the two surfaces can't drift into different column sets.
// ---------------------------------------------------------------------------

/** Shape a row renderer needs from a FleetChild. */
export interface ChildRowView {
  name: string;
  status: ChildStatus;
  pid: number | null;
  startedAt: number;
  events: ReadonlyArray<unknown>;
}

/** Format a single child as a single-line status row (no color codes). */
export function formatChildRow(c: ChildRowView, now: number = Date.now()): string {
  const elapsed = Math.floor((now - c.startedAt) / 1000);
  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  const timeStr = min > 0 ? `${min}m${sec}s` : `${sec}s`;
  return `${c.name.padEnd(16)} ${c.status.padEnd(10)} pid=${(c.pid ?? '-').toString().padEnd(7)} ${timeStr.padEnd(6)} events=${c.events.length}`;
}
