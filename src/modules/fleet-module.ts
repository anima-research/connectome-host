/**
 * FleetModule — orchestrates child connectome-host processes.
 *
 * Each child is spawned as a detached subprocess running `bun src/index.ts
 * <recipe> --headless`, with its own DATA_DIR and Chronicle store.  The
 * parent connects to the child's Unix socket at {dataDir}/ipc.sock and
 * exchanges JSONL envelopes (see `fleet-types.ts`, `docs/fleet-protocol.md`).
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
import { formatZonedDateTime, resolveTimeZone } from '@animalabs/agent-framework';
import { execFile, spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { connect as netConnect, type Socket } from 'node:net';
import { existsSync, lstatSync, fstatSync, readSync, readFileSync, writeFileSync, constants, mkdirSync, unlinkSync, openSync, closeSync, realpathSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { uptime } from 'node:os';
import { type IncomingCommand, type WireEvent, type PanelResponseEvent, matchesSubscription } from './fleet-types.js';
import { loadRecipe } from '../recipe.js';
import { REDUCER_REQUIRED_EVENTS } from '../state/agent-tree-reducer.js';
import { parseCommand } from '../command-name.js';
import { unknownToolResult } from './unknown-tool.js';

/**
 * Cross-process telemetry the parent host needs from every child, on top of
 * what the unified-tree reducer needs. `usage:updated` is the cumulative
 * session-usage signal — the TUI status bar and the WebUI header roll it up
 * across children, so children that narrow their subscription (e.g. the
 * triumvirate recipe) shouldn't be allowed to silently turn it off. Kept
 * separate from REDUCER_REQUIRED_EVENTS because it isn't reducer-required;
 * the wire just needs it for host-level observability.
 */
const HOST_FORCED_TELEMETRY_EVENTS: readonly string[] = ['usage:updated'];

/**
 * Force the events the unified-tree reducer + host telemetry need into every
 * subscription sent to a fleet child. Recipes can still narrow chatty events
 * out of the wire stream; they just can't accidentally disable rendering by
 * omitting `inference:tool_calls_yielded` / `tool:started`, or starve the
 * host's session-usage roll-up by omitting `usage:updated`.
 *
 * If `'*'` is present we leave the subscription alone — everything already
 * flows. Otherwise each required event is added unless it's already covered
 * (literal match or prefix-glob like `tool:*`).
 */
export function unionWithReducerRequired(subscription: readonly string[]): string[] {
  if (subscription.includes('*')) return [...subscription];
  const set = new Set(subscription);
  for (const required of [...REDUCER_REQUIRED_EVENTS, ...HOST_FORCED_TELEMETRY_EVENTS]) {
    if (!matchesSubscription(required, set)) set.add(required);
  }
  return [...set];
}

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
  /** IANA zone for wall-clock timestamps returned by fleet tools. */
  timeZone?: string;
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
 * (process, socket), ephemeral state (event buffer, line buffer), and resolved
 * environment overrides (which may contain secrets) are excluded.  Stored under the module's state namespace and re-hydrated
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
  /** The machine's boot id when the child launched, where the host could
   *  read one (Linux's /proc/sys/kernel/random/boot_id). A restore that
   *  reads another knows no process of it can be running. Records an
   *  earlier version wrote have none. */
  bootId?: string;
}

interface PersistedFleetState {
  children: Record<string, PersistedChild>;
}

interface FleetChild {
  name: string;
  recipePath: string;
  dataDir: string;
  socketPath: string;
  /** Ephemeral filesystem identity observed for this spawned child's socket. */
  ownedSocket?: { dev: bigint; ino: bigint; ctimeNs: bigint };
  /** Ephemeral authority from a successful PID-validated adoption handshake. */
  adopted?: boolean;
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
  /** The boot id the child launched under, as persisted. */
  bootId?: string;
  /** True between kill request and process exit — suppresses autoRestart for intentional shutdowns. */
  killRequested: boolean;
  /** Host-local flap history; not persisted, so reconstructed children start with a fresh retry budget. */
  restartAttempts: number[];
  /** Pending replacement of this generation, cancelled by manual control. */
  restartTimer?: ReturnType<typeof setTimeout>;
  /** Kills acknowledged on this generation. A launch replacing it refuses if
   *  one lands during the launch's awaits. Not persisted. */
  killAcks?: number;
  /** A launch is adopting this generation's living process. Another launch
   *  of the name is refused meanwhile: the child keeps only its latest
   *  client, so two adoptions would leave one record holding a dead socket.
   *  Not persisted. */
  adopting?: boolean;
  /** Why automatic restarts stopped for this generation: the flap cap, a
   *  signal exit (never retried), a kill, a manual launch that took over, or
   *  a replacement that was refused. Shown by fleet--status until a launch or
   *  restart replaces the generation. Kept in memory, like the retry
   *  history, not persisted. */
  autoRestartStopped?: string;
  /** A failed launch's reason, kept so the exit, whenever it's recorded,
   *  carries it beside the exit itself. */
  launchFailure?: string;
  /** Runtime-only env overrides for restart. Recovered from current config on adoption. */
  env?: Record<string, string>;
  /**
   * Most recent speech from a non-tool-ending inference round, as reported
   * by the child's synthetic `inference:speech` event.  Empty until the
   * child's primary agent has spoken at least once without ending in
   * tool calls.  Used by fleet--relay.
   */
  lastCompletedSpeech: string;
}

/** How an exit reads in a record's exitReason: the signal, else "clean" or
 *  the code. */
function exitText(code: number | null, signal: NodeJS.Signals | string | null): string {
  return signal ?? (code === 0 ? 'clean' : `code=${code}`);
}

/** How long a connect to a child's socket waits for an answer. */
const CONNECT_ANSWER_MS = 3_000;

/** What a child's record says once a kill has ended its automatic restarts. */
const KILL_ENDED_RESTARTS = 'fleet--kill ended automatic restarts; fleet--restart or fleet--launch starts it again';

/** A failed launch's reason beside the exit that ended it. */
function withLaunchFailure(failure: string, exit: string): string {
  return `${failure} (exit: ${exit})`;
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
  /** Installed by start(), removed by stop(); see killAllOnExitSync(). */
  private exitHandler: (() => void) | null = null;

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
      timeZone: resolveTimeZone(config.timeZone),
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

  /**
   * Synchronous SIGKILL of every live child this fleet owns. Invoked from
   * the 'exit' listener installed in start(); also safe to call directly.
   *
   * Coverage and limits:
   *  - Spawned children (proc handle present): killed via proc.kill.
   *  - Adopted children (proc null, pid populated): killed via
   *    process.kill(pid). Without this, adopt-on-restart cleanup is a no-op.
   *  - Detach mode: skipped — those children are *meant* to survive for
   *    the next parent to adopt.
   *  - Hard-crash / SIGKILL of the parent: 'exit' does not fire, so this
   *    cannot help. Detached children orphan to PID 1 in that path.
   */
  private killAllOnExitSync(): void {
    if (this.detachMode) return;
    for (const c of this.children.values()) {
      const proc = c.process;
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        try { proc.kill('SIGKILL'); } catch { /* noop */ }
      } else if (!proc && c.adopted && c.pid !== null && (c.status === 'ready' || c.status === 'starting')) {
        try { process.kill(c.pid, 'SIGKILL'); } catch { /* noop */ }
      }
    }
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    // Defensive cleanup if the parent exits without stop() running: synchronously
    // SIGKILL any live children. See killAllOnExitSync() for coverage/limits.
    // Installed here (not in the constructor) so listeners don't leak and a
    // stopped FleetModule can be GC'd; we remove it in stop().
    if (!this.exitHandler) {
      this.exitHandler = (): void => this.killAllOnExitSync();
      process.on('exit', this.exitHandler);
    }

    // First, try to adopt any still-alive children from a prior parent run.
    // Adoption is best-effort: for each persisted child we probe liveness
    // (PID + socket connect) and, if responsive, reattach without respawn.
    // Unresolved orphan artifacts are preserved; the launch guard below refuses them.
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
        ...(c.bootId !== undefined ? { bootId: c.bootId } : {}),
      };
    }
    this.ctx.setState<PersistedFleetState>({ children: persisted });
  }

  /**
   * Probe persisted children for liveness and reattach to the live ones.
   * Returns the set of names we successfully adopted so autoStart can
   * skip them. Historical state does not authenticate the current socket/PID
   * artifacts; preserve them for ownership reconciliation if adoption fails.
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

    // No process outlives a boot, so a record from an earlier boot has none,
    // whatever holds its pid now. The boot id tells, where the record and
    // this host both have one, whatever the clock has done since. Otherwise
    // the record's start time is read against the machine's uptime, with a
    // minute of slack for a clock that moved a little.
    const thisBoot = this.bootId();
    const bootedAt = Date.now() - uptime() * 1000 - 60_000;
    const fromThisBoot = (p: PersistedChild): boolean =>
      typeof p.bootId === 'string' && thisBoot !== undefined ? p.bootId === thisBoot : p.startedAt >= bootedAt;
    for (const [name, p] of Object.entries(state.children)) {
      if (name !== p.name || p.socketPath !== join(p.dataDir, 'ipc.sock')) continue;

      if (!this.canRetryAdoption(p)) {
        this.children.set(name, this.reconstructOrphan(p));
        continue;
      }
      const alive = await this.probeLiveness(p);
      if (!alive) {
        // Persisted records and failed probes cannot authorize artifact deletion.
        const orphan = this.reconstructOrphan(p);
        // A pid that's gone or unusable, or a record from an earlier boot,
        // leaves no process of it running. A pid in use may be a child still
        // starting, which no launch replaces (handleLaunch), so the record
        // says why none starts; fleet--restart uses the record's own recipe
        // and dataDir. canRetryAdoption reads the text up to and including
        // the semicolon.
        const inUse = fromThisBoot(p) && this.pidInUse(p.pid);
        orphan.status = inUse ? 'starting' : 'crashed';
        orphan.exitReason = inUse
          ? `adoption unresolved; its pid (${p.pid}) is still in use, so this host starts no other copy of it, and ` +
            'fleet--restart of it reattaches once it answers on its socket'
          : 'adoption unresolved; fleet--restart of it, or fleet--launch with its recipe and ' +
            'dataDir, probes it again';
        this.children.set(name, orphan);
        continue;
      }

      // Attempt to reattach. Failure leaves a blocked historical record;
      // it does not prove that the socket belongs to a dead process.
      try {
        const reattached = await this.reattachToLivingChild(p);
        this.children.set(name, reattached);
        adopted.add(name);
        console.error(`[fleet] adopted "${name}" (pid=${p.pid}, socket=${p.socketPath})`);
      } catch (err) {
        console.error(`[fleet] failed to adopt "${name}": ${String(err)}`);
        // Persisted records and failed probes cannot authorize artifact deletion.
        // As above, a record from an earlier boot, or one whose pid has gone,
        // has no process to wait on.
        const orphan = this.reconstructOrphan(p);
        orphan.status = fromThisBoot(p) && this.pidInUse(p.pid) ? 'starting' : 'crashed';
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
      // Resolved as a launch resolves it: an earlier version kept an absolute
      // dataDir as it was given, such as with a trailing slash.
      dataDir: resolve(p.dataDir),
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
      bootId: typeof p.bootId === 'string' ? p.bootId : undefined,
      killRequested: false,
      restartAttempts: [],
      lastCompletedSpeech: '',  // not persisted; rebuilt on next inference:speech
    };
    // Resolved env values may contain secrets. Chronicle stores historical
    // snapshots, so env is runtime-only and legacy persisted env is ignored.
    // Re-read the current configuration for the same child, including entries
    // with autoStart:false. Name alone must not transfer secrets to a different
    // recipe or data directory that happens to reuse the name.
    const recipeIdentity = (recipe: string): string =>
      /^https?:\/\//.test(recipe) ? recipe : resolve(recipe);
    const configured = this.autoStartChildren.find((c) =>
      c.name === p.name &&
      recipeIdentity(c.recipe) === recipeIdentity(p.recipePath) &&
      resolve(c.dataDir ?? join('data', c.name)) === resolve(p.dataDir),
    );
    if (configured?.env !== undefined) child.env = { ...configured.env };
    if (!configured) {
      const sameName = this.autoStartChildren.find((c) => c.name === p.name);
      if (sameName) {
        const mismatches = [
          recipeIdentity(sameName.recipe) !== recipeIdentity(p.recipePath) ? 'recipe' : null,
          resolve(sameName.dataDir ?? join('data', sameName.name)) !== resolve(p.dataDir) ? 'dataDir' : null,
        ].filter(Boolean);
        console.error(`[fleet] child ${JSON.stringify(p.name)}: configured identity mismatch (${mismatches.join(', ')}); environment overrides withheld for restarts. Check child configuration and host working directory.`);
      }
    }
    return child;
  }

  /**
   * Check whether a persisted child appears to be alive.
   * Criteria: PID is alive (process.kill(pid, 0) doesn't throw) AND the
   * socket file exists on disk.  A true probe of the socket happens in
   * reattachToLivingChild; this is the cheap pre-check.
   */
  /** Confirmed terminal records cannot authorize a connection to a reused PID. */
  private canRetryAdoption(p: PersistedChild | FleetChild): boolean {
    if (p.exitedAt !== null) return false;
    if (p.status === 'ready' || p.status === 'starting') return true;
    return p.status === 'crashed' && (
      p.exitReason?.startsWith('adopt failed:') === true ||
      p.exitReason === 'orphaned (parent restarted; child not alive)' ||
      p.exitReason?.startsWith('adoption unresolved;') === true
    );
  }

  private async probeLiveness(p: PersistedChild): Promise<boolean> {
    if (p.pid === null || !Number.isSafeInteger(p.pid) || p.pid <= 0) return false;
    try {
      process.kill(p.pid, 0);
    } catch {
      return false;
    }
    try { if (!lstatSync(p.socketPath).isSocket()) return false; } catch { return false; }
    return true;
  }

  /**
   * Connect to the child's Unix socket and treat the adopted connection as
   * if we just spawned the child.  The child's headless runtime closes the
   * previous client (if any) and re-emits lifecycle:ready for us.
   *
   * PID-reuse guard: the process.kill(pid,0) pre-check in probeLiveness
   * only verifies *some* process owns the PID, which after a reboot can be
   * an unrelated process.  We verify the first lifecycle:ready event's pid
   * matches the persisted pid; if it doesn't, another process serves the
   * socket, and we abort the adoption.
   */
  private async reattachToLivingChild(p: PersistedChild): Promise<FleetChild> {
    const child = this.reconstructOrphan(p);
    child.status = 'starting';  // transitions to 'ready' via the lifecycle event once reattached
    child.exitedAt = null;
    child.exitCode = null;
    child.exitReason = null;

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
      this.sendToChild(child, { type: 'subscribe', events: p.subscription });
      await this.waitForReady(child);

      if (observedPid !== p.pid) {
        // A stale socket refuses connections, so an answer means a live
        // process serves this data directory, and it isn't the recorded one.
        throw new Error(
          `the process answering on its socket reported pid ${observedPid ?? 'none'}, not the recorded pid ` +
          `${p.pid}, so a process other than the recorded child now serves its data directory`,
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

    child.adopted = true;
    // A child that answers runs in this boot, whatever its record said.
    child.bootId = this.bootId() ?? child.bootId;
    return child;
  }

  private pidIsGone(pid: number | null): boolean {
    if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
    return false;
  }

  /** This machine's boot id, where Linux gives one. It changes at every
   *  boot, whatever the clock does. */
  private bootId(): string | undefined {
    try {
      return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** Whether a pid may belong to a running process: a usable pid that no
   *  signal has shown gone. A record with no usable pid, such as one whose
   *  spawn threw or started no process, has no process this host could know
   *  of. */
  private pidInUse(pid: number | null): boolean {
    return pid !== null && Number.isSafeInteger(pid) && pid > 0 && !this.pidIsGone(pid);
  }

  /** Whether a record's process may still be running in its data directory:
   *  its status says starting or ready, and its pid is still in use. For a
   *  record this host isn't attached to, such as one restored at its start,
   *  the status is what an earlier host saw, so the pid is what tells. */
  private mayBeRunning(c: FleetChild): boolean {
    return (c.status === 'starting' || c.status === 'ready') && this.pidInUse(c.pid);
  }

  /** This host's other children whose processes may still be running in
   *  dataDir, which a launch of `name` there would share. */
  private sharersIn(dataDir: string, name: string): FleetChild[] {
    return [...this.children.values()].filter((c) => c.name !== name && c.dataDir === dataDir && this.mayBeRunning(c));
  }

  /** Bun 1.3 reports ENOENT for Unix refusals; 1.4 also maps EMFILE to
   * ECONNREFUSED. The already-required Node runtime preserves the actual error.
   * Missing Node, spawn failure, timeout, live or unknown endpoints fail closed. */
  private socketRefusesConnection(socketPath: string): Promise<boolean> {
    const probe = `const {connect}=require('node:net');
      const socket=connect(process.argv[1]);
      socket.once('connect',()=>{socket.destroy();process.exitCode=1;});
      socket.once('error',error=>{socket.destroy();process.exitCode=error.code==='ECONNREFUSED'?0:1;});`;
    return new Promise((resolve) => {
      execFile('node', ['--input-type=commonjs', '-e', probe, socketPath], {
        env: { PATH: process.env.PATH ?? '' }, timeout: 3_000,
        killSignal: 'SIGKILL', maxBuffer: 1_024,
      }, error => resolve(error === null));
    });
  }

  /** Reconcile only the matching tracked generation. Identity checks narrow
   * check/unlink races; they do not provide cross-process locking. */
  private async cleanupStaleChildFiles(child: FleetChild): Promise<void> {
    const { name, pid, dataDir, socketPath, startedAt, recipePath } = child;
    if (socketPath !== join(dataDir, 'ipc.sock') || !this.pidIsGone(pid)) return;
    if (child.process && (child.exitedAt === null ||
        (child.process.exitCode === null && child.process.signalCode === null))) return;
    const pidPath = join(dataDir, 'headless.pid');
    let fd: number | undefined;
    try {
      const metadata = lstatSync(pidPath, { bigint: true });
      if (!metadata.isFile() || metadata.size <= 0n || metadata.size > 32n) return;
      fd = openSync(pidPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const same = (a: typeof metadata, b: typeof metadata): boolean =>
        a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs &&
        a.mode === b.mode && a.size === b.size;
      if (!same(metadata, fstatSync(fd, { bigint: true }))) return;
      const buffer = Buffer.alloc(33);
      const size = readSync(fd, buffer, 0, buffer.length, 0);
      if (size !== Number(metadata.size) || buffer.subarray(0, size).toString('utf8').trim() !== String(pid)) return;
      const inspectSocket = (): typeof metadata | null => {
        try { return lstatSync(socketPath, { bigint: true }); }
        catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
      };
      const socket = inspectSocket();
      if (socket) {
        if (!socket.isSocket()) return;
        if (child.process && (!child.ownedSocket || socket.dev !== child.ownedSocket.dev ||
            socket.ino !== child.ownedSocket.ino || socket.ctimeNs !== child.ownedSocket.ctimeNs)) return;
        if (!await this.socketRefusesConnection(socketPath)) return;
      }
      const recordMatches = (): boolean => this.children.get(name) === child && child.name === name &&
        child.pid === pid && child.dataDir === dataDir && child.socketPath === socketPath &&
        child.startedAt === startedAt && child.recipePath === recipePath && this.pidIsGone(pid);
      const socketMatches = (): boolean => {
        const current = inspectSocket();
        return socket === null ? current === null : current !== null && same(socket, current);
      };
      if (!recordMatches() || !same(metadata, lstatSync(pidPath, { bigint: true })) || !socketMatches()) return;
      if (socket) unlinkSync(socketPath);
      // Recheck the remaining metadata immediately before its own unlink.
      if (!recordMatches() || inspectSocket() !== null ||
          !same(metadata, lstatSync(pidPath, { bigint: true }))) return;
      unlinkSync(pidPath);
    } catch { /* Unknown, replaced or inaccessible evidence is preserved. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  private cancelAutoRestart(child: FleetChild): void {
    if (child.restartTimer !== undefined) {
      clearTimeout(child.restartTimer);
      child.restartTimer = undefined;
    }
  }

  /** Whether the exit handler retries an exit with this code: autoRestart is
   *  on, the code is nonzero, no kill was asked for, and the host isn't
   *  stopping. tryAutoRestart can still refuse the retry at the flap cap. */
  private retriesExit(child: FleetChild, code: number | null): boolean {
    return child.autoRestart && code !== null && code !== 0 && !child.killRequested && !this.stopping;
  }

  /**
   * Attempt to restart a crashed child. Track attempts across replacements and
   * stop at the flap cap. Backoff keeps startup failures from flooding the log.
   */
  private tryAutoRestart(child: FleetChild): void {
    if (this.stopping || child.killRequested || this.children.get(child.name) !== child) return;
    const now = Date.now();
    child.restartAttempts = child.restartAttempts.filter((t) => now - t < this.restartFlapWindowMs);
    if (child.restartAttempts.length >= this.restartFlapCap) {
      // Recorded on the generation, so fleet--status shows it until a manual
      // launch or restart replaces it.
      child.autoRestartStopped =
        `${this.restartFlapCap} restarts within ${this.restartFlapWindowMs / 1000}s; ` +
        'fleet--restart or fleet--launch starts it again, with a fresh retry budget';
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

    // Keep this generation visible through backoff, including its retry history
    // and process handle. A replacement may also need it to reconcile artifacts.
    child.restartTimer = setTimeout(() => {
      child.restartTimer = undefined;
      if (this.stopping || child.killRequested || this.children.get(child.name) !== child) return;
      this.handleLaunch(input, { viaAutoStart: true, autoRestartOf: child })
        .then((res) => {
          if (!res.success) {
            console.error(`[fleet] autoRestart "${child.name}" failed: ${res.error}`);
            // Refused before spawning, the replacement left this generation
            // in place, and nothing will restart it: the record says why.
            if (this.children.get(child.name) === child) {
              child.autoRestartStopped ??= `the replacement was refused: ${res.error}`;
            }
          }
        })
        .catch((err: unknown) => {
          console.error(`[fleet] autoRestart "${child.name}" threw: ${String(err)}`);
          if (this.children.get(child.name) === child) {
            child.autoRestartStopped ??= `the replacement failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        });
    }, delayMs);
  }

  async stop(): Promise<void> {
    // Mark shutdown so the process 'exit' handlers don't trigger autoRestart.
    this.stopping = true;
    for (const child of this.children.values()) this.cancelAutoRestart(child);

    if (this.detachMode) {
      // Detach: close socket references only; leave child processes alive so
      // a later parent can adopt them.  Children's own headless runtimes
      // keep running because they were spawned with detached: true.
      for (const c of this.children.values()) {
        try { c.socket?.destroy(); } catch { /* noop */ }
        c.socket = null;
      }
    } else {
      // Keep the exit safety net and original context while cleanup is pending
      // or failed, including unconfirmed child death. A caller's explicit
      // deadline can also expire before escalation; a parent error exit
      // must still terminate detached children we own.
      // Unvalidated restored records confer no authority to signal their PIDs.
      const owned = [...this.children.values()].filter(child => child.process || child.adopted);
      const results = await Promise.allSettled(owned.map(child => this.killChild(child)));
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Fleet child shutdown failed');
    }

    // Release the listener only after successful cleanup or intentional detach.
    if (this.exitHandler) {
      process.off('exit', this.exitHandler);
      this.exitHandler = null;
    }
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
          return unknownToolResult(this, call.name);
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
    opts: { viaAutoStart: boolean; autoRestartOf?: FleetChild; killsAtStart?: number } = { viaAutoStart: false },
  ): Promise<ToolResult> {
    if (!input.name || typeof input.name !== 'string') {
      return {
        success: false, isError: true,
        error: `Nothing was launched: fleet--launch needs "name", a short name for the child, unique among this host's ` +
          `children, such as "reviewer"; ${got(input.name)}.`,
      };
    }
    if (!input.recipe || typeof input.recipe !== 'string') {
      return {
        success: false, isError: true,
        error: `Nothing was launched: fleet--launch needs "recipe", the recipe's path (absolute, or relative to this ` +
          `host's working directory) or an http(s) URL; ${got(input.recipe)}.`,
      };
    }
    // dataDir is read as a path and subscription spread as a list, so another
    // type throws, or, for a string subscription, is split into characters.
    // null for either, or an empty dataDir, means none was given, as it
    // always has.
    if (input.dataDir != null && typeof input.dataDir !== 'string') {
      return {
        success: false, isError: true,
        error: `Nothing was launched: fleet--launch's "dataDir", when given, is the child's data directory as a ` +
          `string, absolute or relative to this host's working directory, such as "data/reviewer"; ` +
          `${got(input.dataDir)}.`,
      };
    }
    if (input.subscription != null &&
        (!Array.isArray(input.subscription) || input.subscription.some((event) => typeof event !== 'string'))) {
      const bad = Array.isArray(input.subscription)
        ? input.subscription.findIndex((event) => typeof event !== 'string') : -1;
      return {
        success: false, isError: true,
        error: `Nothing was launched: fleet--launch's "subscription", when given, is a list of event names, ` +
          `such as ["lifecycle", "inference:speech"]; ` +
          (bad >= 0
            ? `it got a list whose entry ${bad + 1} isn't a string: ` +
              got((input.subscription as unknown[])[bad]).replace(/^it got /, '')
            : got(input.subscription)) +
          '.',
      };
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
        // A trailing `*` is a prefix, not a recipe the agent can pass.
        const allowed = this.allowlist.map((entry) =>
          entry.endsWith('*') ? `any recipe whose path starts with "${entry.slice(0, -1)}"` : entry);
        return {
          success: false,
          isError: true,
          error:
            `Nothing was launched: recipe "${input.recipe}" isn't one this host lets its agent launch, so ` +
            `calling again with it won't change that. ` +
            (this.allowlist.length > 0
              ? `The allowed recipes are ${allowed.join(', ')}. Launch one of those, or ask`
              : 'It allows none, so ask') +
            ` the user to add this one to modules.fleet.allowedRecipes in this host's recipe.`,
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

    if (this.stopping) {
      return {
        success: false, isError: true,
        error: `Nothing was launched: this host is shutting down, so it starts no new children, ` +
          `and calling fleet--launch again won't change that.`,
      };
    }
    const existing = this.children.get(input.name);
    // A restart counts kills from its own start, before its kill wait, so a
    // kill acknowledged during that wait still refuses the relaunch.
    const killsAtStart = opts.killsAtStart ?? existing?.killAcks ?? 0;
    // Recipe loading and ownership reconciliation both yield. Afterward every
    // launch, manual or automatic, must still replace the generation it began
    // from, the host must not have begun stopping, and no kill may have been
    // acknowledged on that generation meanwhile. An automatic retry must also
    // find its generation uncancelled. The refusal names which.
    // `stage` completes "while this launch …".
    const name = input.name;
    type Stale = { cause: 'stopping' | 'replaced' | 'killed' | 'cancelled'; why: (stage: string) => string };
    const staleReason = (): Stale | null => {
      if (this.stopping) {
        return { cause: 'stopping', why: (stage) => `this host began shutting down while this launch ${stage}, ` +
          `so it starts no new children, and calling fleet--launch again won't change that` };
      }
      if (this.children.get(name) !== existing) {
        return { cause: 'replaced', why: (stage) => `another launch of '${name}' took its place while this launch ${stage}. ` +
          `fleet--status for '${name}' shows the child that launch started` };
      }
      if ((existing?.killAcks ?? 0) !== killsAtStart) {
        return { cause: 'killed', why: (stage) => `a fleet--kill of '${name}' was acknowledged while this launch ${stage}. ` +
          `fleet--status for '${name}' shows its state now; call fleet--launch again if you still want it running` };
      }
      if (opts.autoRestartOf && (existing !== opts.autoRestartOf || existing.killRequested)) {
        return { cause: 'cancelled', why: (stage) => `the automatic restart of '${name}' was cancelled, by a kill, launch ` +
          `or restart of it, while this launch ${stage}` };
      }
      return null;
    };
    const staleRefusal = (stage: string, stale: Stale, after = ''): ToolResult => ({
      success: false, isError: true, error: `Nothing was launched: ${stale.why(stage)}.${after}`,
    });
    if (existing && (existing.process || existing.adopted) &&
        (existing.status === 'starting' || existing.status === 'ready')) {
      return {
        success: false,
        isError: true,
        error: `Nothing was launched: child '${name}' is already ${existing.status}. fleet--status for '${name}' ` +
          `shows it, and fleet--restart stops it and starts it again; to run another, give it another name.`,
      };
    }
    // A manual launch or restart takes over from automatic replacement now,
    // before its own awaits: a pending timer is cancelled, and an automatic
    // launch already past its timer finds its generation cancelled at its
    // next check, as it does for a restart. On a stopped generation the flag
    // only ends automatic restarts, and the record says so, so a launch
    // refused later leaves a record that tells the truth; a launch that
    // succeeds replaces the record.
    if (existing && !opts.autoRestartOf) {
      if (existing.autoRestart && existing.status === 'crashed') {
        existing.autoRestartStopped ??= 'a manual launch or restart took over; ' +
          'until one succeeds, nothing restarts this child';
      }
      this.cancelAutoRestart(existing);
      existing.killRequested = true;
    }

    const recipePath = isUrlOrAbsolute(input.recipe)
      ? input.recipe
      : resolve(process.cwd(), input.recipe);

    // No-subfleets invariant: a fleet child may not itself declare a fleet
    // module. Enforced before subprocess spawn so the failure mode is a clean
    // synchronous tool error rather than a child crashing mid-startup. See
    // docs/history/UNIFIED-TREE-PLAN.md §6 for the design rationale (depth-1 keeps the
    // unified tree's cross-process visibility tractable).
    //
    // We only fail on a *confirmed* nested-fleet declaration. If the recipe
    // can't be loaded for any other reason (file missing, unfetchable URL,
    // malformed JSON, mock-test recipes), let the existing spawn path surface
    // that failure naturally — pre-empting it here would mask test fixtures
    // and unrelated misconfigurations.
    try {
      const childRecipe = await loadRecipe(recipePath);
      const fleetField = childRecipe.modules?.fleet;
      const declaresFleet = fleetField === true ||
        (typeof fleetField === 'object' && fleetField !== null);
      if (declaresFleet) {
        return {
          success: false,
          isError: true,
          error:
            `Nothing was launched: the recipe at ${recipePath} declares a 'fleet' module of its own, and a fleet ` +
            `child can't run one, since nested fleets are not supported. Remove 'fleet' from that recipe's ` +
            `modules, then call fleet--launch again.`,
        };
      }
    } catch {
      // Recipe couldn't be loaded — defer to the natural spawn-time failure.
    }

    // Resolved, so two spellings of one path, such as one with a trailing
    // slash or a `..`, are recorded and compared as one. Resolving is
    // lexical: a path through a symlink is another path.
    const dataDir = resolve(process.cwd(), input.dataDir || join('data', input.name));

    const socketPath = join(dataDir, 'ipc.sock');
    const subscription = input.subscription ?? this.config.defaultSubscription;
    const staleAtLaunch = staleReason();
    if (staleAtLaunch) return staleRefusal('loaded the recipe', staleAtLaunch);
    if (existing && existing.dataDir === dataDir && existing.socketPath === socketPath &&
        existing.recipePath === recipePath) {
      // One adoption at a time: the child keeps only its latest client.
      if (existing.adopting) {
        return {
          success: false, isError: true,
          error: `Nothing was launched: another launch is reattaching to the running process of child '${name}' ` +
            `right now. Once it returns, fleet--status for '${name}' shows whether the child is running.`,
        };
      }
      // Not while a child this host is attached to may be running there: a
      // child closes its client when another connects (headless.ts), so
      // reattaching through that socket would cut it off from this host
      // before the refusal below.
      if (this.canRetryAdoption(existing) && !existing.process && !existing.socket &&
          !this.sharersIn(dataDir, name).some((c) => c.process || c.adopted)) {
        existing.adopting = true;
        try {
          if (await this.probeLiveness(existing)) {
            try {
              const adopted = await this.reattachToLivingChild({
                ...existing, subscription: [...subscription],
              });
              const staleAtAdoption = staleReason();
              if (staleAtAdoption) {
                // The process was just confirmed as this child, and nothing
                // else owns it, since no other launch adopts while this one
                // does. So stop it rather than leave it running unowned,
                // unless the host is detaching to leave its children for a
                // later parent. The refusal says what became of it: stopped
                // means this host saw it exit, which killChild confirms before
                // it returns.
                let after = ' This host leaves that process running for the next host to adopt.';
                if (staleAtAdoption.cause !== 'stopping' || !this.detachMode) {
                  try {
                    await this.killChild(adopted);
                    after = ` This launch stopped the process it had reattached to (pid ${adopted.pid}).`;
                  } catch (err) {
                    console.error(`[fleet] could not stop "${input.name}" after its refused adoption: ${String(err)}`);
                    after = ` This launch couldn't confirm that the process it had reattached to stopped (pid ` +
                      `${adopted.pid}), so it may still be running; fleet--status for '${name}' shows its record.`;
                  }
                }
                adopted.socket?.destroy();
                return staleRefusal('reattached to the child\'s running process', staleAtAdoption, after);
              }
              this.children.set(input.name, adopted);
              this.persistState();
              return { success: true, data: { name: adopted.name, pid: adopted.pid, status: adopted.status,
                dataDir: adopted.dataDir, socketPath: adopted.socketPath } };
            } catch { /* Preserve artifacts and let the refusal explain recovery. */ }
          }
        } finally {
          existing.adopting = false;
        }
      }
      await this.cleanupStaleChildFiles(existing);
    }
    const staleAtReconciliation = staleReason();
    if (staleAtReconciliation) return staleRefusal('checked the files an earlier run left', staleAtReconciliation);
    // One child per data directory: a child takes its socket and pid file
    // there, and unlinks any socket it finds as it starts. While another
    // child's record says starting or ready and its pid is in use, that
    // child may be running there before its files show it, so the launch is
    // refused. From here to the new record nothing awaits, so of two
    // launches into one directory, the second sees the first's record.
    const others = [...this.children.values()].filter((c) => c.name !== name && c.dataDir === dataDir);
    const sharer = this.sharersIn(dataDir, name)[0];
    if (sharer) {
      // fleet--kill refuses a child this host isn't attached to, and
      // fleet--restart reattaches to it once it answers.
      return {
        success: false, isError: true,
        error: `Nothing was launched: this host's child '${sharer.name}' is ${sharer.status} in ${dataDir}, and ` +
          `two children can't share a data directory. Give fleet--launch another dataDir, or ` +
          (sharer.process || sharer.adopted
            ? `fleet--kill '${sharer.name}' first.`
            : `stop '${sharer.name}' first: this host isn't attached to it, so fleet--kill can stop it only once ` +
              `fleet--restart for '${sharer.name}' has reattached to it, which it does once '${sharer.name}' ` +
              'answers on its socket.'),
      };
    }
    const pidPath = join(dataDir, 'headless.pid');
    for (const artifact of [socketPath, pidPath]) {
      try {
        lstatSync(artifact); // Includes dangling symlinks and special files; never read/connect.
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        return {
          success: false, isError: true,
          error: `Nothing was launched: this host couldn't check ${artifact} (${code ?? String(err)}), so it can't ` +
            `tell whether a child from an earlier run still owns the data directory ${dataDir}. Give ` +
            'fleet--launch another dataDir, or ask whoever runs this host to check that path.',
        };
      }
      // A record of this name in this directory is one a later launch with
      // its recipe can reattach to, or clear up after once its stop can be
      // confirmed, which a record that says stopped may still not allow;
      // another child's record there names whose directory it is; with
      // neither, calling again can't help.
      const other = others[0];
      return {
        success: false, isError: true,
        error: existing?.dataDir === dataDir
          ? `Nothing was launched: ${artifact} is still there from an earlier run of '${name}', and this host ` +
            `couldn't reattach to a child there or confirm that those files are a stopped child's. ` +
            `fleet--status for '${name}' shows its record. Calling fleet--launch again with the recipe it ` +
            `names retries: it reattaches once that child has finished starting, and clears the files once this ` +
            `host can confirm they're a stopped child's. If it keeps refusing, ask whoever runs this host to ` +
            `check ${socketPath} and ${pidPath}, or give fleet--launch another dataDir.`
          : other
            ? `Nothing was launched: ${artifact} is there, and ${dataDir} is the data directory of this host's ` +
              `child '${other.name}', whose record says ${other.status}. fleet--status for '${other.name}' shows ` +
              `it; give fleet--launch another dataDir.`
            : `Nothing was launched: ${artifact} is there, and this host has no record of a child in ${dataDir}, ` +
              `so it can't tell whether a process it didn't start owns it, and calling again refuses the same way ` +
              `while it's there. Give fleet--launch another dataDir, or ask whoever runs this host to check ` +
              `${socketPath} and ${pidPath}.`,
      };
    }

    // The rule of the gate at the top of handleLaunch, which refuses a
    // running record of this name that the host is attached to, here for one
    // it isn't attached to; files in the directory got their own refusal
    // above. A host that comes back while a child it left running is still
    // starting restores it as starting, and can't reattach until the child
    // answers on its socket. While its pid is in use, this launch would start
    // a second process beside it, or, in another dataDir, leave this host no
    // record of it.
    if (existing && !existing.process && !existing.adopted && this.mayBeRunning(existing)) {
      return {
        success: false, isError: true,
        error: `Nothing was launched: child '${name}' is recorded as ${existing.status} in ${existing.dataDir}, and ` +
          `its pid (${existing.pid}) is still in use, but this host isn't attached to it, so its process may still ` +
          `be running there, and a launch now would leave that process running untracked. fleet--restart for ` +
          `'${name}' reattaches to it once it answers on its socket, and fleet--kill can stop it then. If it keeps ` +
          `refusing, pid ${existing.pid} may belong to another process: ask whoever runs this host to check it.`,
      };
    }

    // Before the new record replaces the generation this launch began from,
    // so a host that can't start children keeps that record.
    if (!this.config.childIndexPath) {
      return {
        success: false,
        isError: true,
        error: 'Nothing was launched: this host doesn\'t know where its own entry script is (its fleet module ' +
          'has no childIndexPath), so it can\'t start any fleet child, and calling again won\'t change that. ' +
          'If you need one, ask whoever runs this host.',
      };
    }

    // dataDir is the agent's own argument, so a directory this host can't
    // create is the agent's to choose again.
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch (err) {
      return {
        success: false, isError: true,
        error: `Nothing was launched: this host couldn't create the data directory ${dataDir} ` +
          `(${(err as NodeJS.ErrnoException).code ?? String(err)}). Give fleet--launch another dataDir, or ask ` +
          'whoever runs this host to check that path.',
      };
    }

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
      bootId: this.bootId(),
      killRequested: false,
      // Install history before spawning: an early crash must consume the next
      // retry attempt even if this launch promise has not settled yet.
      restartAttempts: [...(opts.autoRestartOf?.restartAttempts ?? [])],
      lastCompletedSpeech: '',
    };
    if (input.env !== undefined) child.env = { ...input.env };
    if (existing) this.cancelAutoRestart(existing);
    this.children.set(input.name, child);

    // The child's stdout and stderr go to startup.log for its whole life, or
    // nowhere if the parent can't open it as a regular file. headless.ts
    // redirects process.stdout.write and process.stderr.write to headless.log
    // until its shutdown ends that log, but Bun's console.* writes to the file
    // descriptors directly (Bun 1.3.14 and 1.4.3), so every console line the
    // child prints lands here: a recipe error, a missing API key, an import
    // crash, and a fatal error after the redirect, such as a failed listen. So
    // does what the child writes once its shutdown has ended headless.log. A
    // failed launch quotes the end of what the child wrote here after its
    // header, or says why it can't.
    const { fd: startupFd, log: startupLog } = openStartupLog(join(dataDir, 'startup.log'),
      `\n--- launch ${new Date().toISOString()} recipe=${recipePath} pid=parent:${process.pid} ---\n`);

    let proc: ChildProcess;
    try {
      proc = spawnProcess(
        this.config.childRuntimePath,
        [this.config.childIndexPath, recipePath, '--headless'],
        {
          detached: true,
          stdio: startupFd !== null ? ['ignore', startupFd, startupFd] : 'ignore',
          env: {
            ...process.env,
            ...input.env,
            AGENT_TIMEZONE: this.config.timeZone,
            DATA_DIR: dataDir,
          },
        },
      );
    } finally {
      // The parent doesn't need the fd once the child has inherited it, nor
      // if spawn threw, as Bun's does for a NUL byte in an argument or env.
      if (startupFd !== null) {
        try { closeSync(startupFd); } catch { /* noop */ }
      }
    }
    proc.unref();
    // A launch without the file can still succeed, so the host says so now,
    // not only if the launch fails.
    if ('problem' in startupLog) {
      console.error(`[fleet] launch of "${input.name}": ${startupLog.path} ${startupLog.problem}.`);
    }

    child.process = proc;
    child.pid = proc.pid ?? null;

    // While the launch is unsettled, the child's exit ends the output a failed
    // launch quotes, and once the record shows the exit it allows another
    // launch of the name, whose header and output come after. So the exit
    // handler reads the quote first, synchronously, before any listener can
    // start one. An exit after the launch has settled reads nothing.
    let launching = true;
    proc.on('exit', (code, signal) => {
      if (launching) startupLog.quote = quoteStartupOutput(startupLog);
      child.exitedAt = Date.now();
      child.exitCode = code ?? null;
      const exit = exitText(code, signal);
      child.exitReason = child.launchFailure !== undefined ? withLaunchFailure(child.launchFailure, exit) : exit;
      child.status = code === 0 ? 'exited' : 'crashed';
      try { child.socket?.destroy(); } catch { /* noop */ }
      child.socket = null;

      this.persistState();

      // autoRestart: respawn on crash (non-zero non-null exit), skip if:
      //   - we asked the child to stop (killRequested)
      //   - parent framework is shutting down (this.stopping)
      //   - exit was via external signal (code null + signal set)
      //   - autoRestart is false or flap cap exceeded
      if (this.retriesExit(child, code)) {
        this.tryAutoRestart(child);
      } else if (child.autoRestart && code === null && !child.killRequested && !this.stopping) {
        // A signal exit is never retried, whoever sent it: the parent, after
        // a failed start, or anything else, such as the OOM killer. Say so,
        // naming the signal rather than who sent it, since a child can also
        // die on its own after its launch has failed.
        child.autoRestartStopped ??= `${child.launchFailure !== undefined ? 'its start failed and ' : ''}` +
          `it was ended by ${signal ?? 'a signal'}, which is not retried; fleet--restart or fleet--launch starts it again`;
      }
    });

    let failureStage = 'launch failed';
    try {
      await this.connectStartingChild(child);
      failureStage = 'subscribe failed';
      this.sendToChild(child, { type: 'subscribe', events: subscription });
      failureStage = 'child did not become ready';
      await this.waitForReady(child);
    } catch (err) {
      const reason = `${failureStage}: ${err instanceof Error ? err.message : String(err)}`;
      return await this.failLaunch(child, reason, startupLog);
    } finally {
      launching = false;
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
      startedAt: formatZonedDateTime(c.startedAt, this.config.timeZone),
      exitedAt: c.exitedAt === null ? null : formatZonedDateTime(c.exitedAt, this.config.timeZone),
      lastEventAt: c.lastEventAt === null ? null : formatZonedDateTime(c.lastEventAt, this.config.timeZone),
      eventCount: c.events.length,
    }));
    return { success: true, data: list };
  }

  private handleStatus(input: { name?: string }): ToolResult {
    if (input.name) {
      const c = this.children.get(input.name);
      if (!c) return this.unknownChild(input.name, 'there is no status to show');
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
      startedAt: formatZonedDateTime(c.startedAt, this.config.timeZone),
      exitedAt: c.exitedAt === null ? null : formatZonedDateTime(c.exitedAt, this.config.timeZone),
      lastEventAt: c.lastEventAt === null ? null : formatZonedDateTime(c.lastEventAt, this.config.timeZone),
      timeZone: this.config.timeZone,
      exitCode: c.exitCode,
      exitReason: c.exitReason,
      autoRestart: c.autoRestart,
      autoRestartStopped: c.autoRestartStopped ?? null,
      eventCount: c.events.length,
      subscription: [...c.subscription],
    };
  }

  private handleSend(input: { name: string; content: string }): ToolResult {
    const ok = this.requireRunning(input.name, 'nothing was sent');
    if (!('child' in ok)) return ok;
    if (typeof input.content !== 'string') {
      return {
        success: false, isError: true,
        error: `Nothing was sent: fleet--send needs "content", the text to send to '${input.name}', as a string; ` +
          `${got(input.content)}.`,
      };
    }
    this.sendToChild(ok.child, { type: 'text', content: input.content });
    return { success: true, data: { name: input.name, sent: 'text' } };
  }

  private handleCommand(input: { name: string; command: string }): ToolResult {
    if (typeof input.command === 'string' && parseCommand(input.command).name === 'bug') {
      // A /bug report's only free text is the words of the person filing it
      // (bug-report.ts), so a session never runs it, here or in a child. The
      // name is read as the child's handleCommand reads it, so whatever would
      // run /bug there is refused here.
      return {
        success: false,
        isError: true,
        error: 'Nothing was sent: /bug is for a person to run in a console, since its report carries their own ' +
          'words, never a session\'s, so calling it again won\'t change that. Ask the user to run /bug themselves.',
      };
    }
    const ok = this.requireRunning(input.name, 'nothing was sent');
    if (!('child' in ok)) return ok;
    if (typeof input.command !== 'string') {
      return {
        success: false, isError: true,
        error: `Nothing was sent: fleet--command needs "command", a slash command such as "/status", as a ` +
          `string; ${got(input.command)}.`,
      };
    }
    this.sendToChild(ok.child, { type: 'command', command: input.command });
    return { success: true, data: { name: input.name, sent: 'command', command: input.command } };
  }

  private handlePeek(input: { name: string; lines?: number }): ToolResult {
    const c = this.children.get(input.name);
    if (!c) return this.unknownChild(input.name, 'there are no events to show');
    const requested = input.lines ?? 50;
    const n = Math.max(1, Math.min(requested, c.events.length || 1));
    const slice = c.events.length > 0 ? c.events.slice(-n) : [];
    return { success: true, data: { name: c.name, count: slice.length, events: slice } };
  }

  private async handleKill(input: { name: string }): Promise<ToolResult> {
    const c = this.children.get(input.name);
    if (!c) return this.unknownChild(input.name, 'nothing was stopped');
    this.cancelAutoRestart(c);
    c.killRequested = true;
    // A launch replacing this generation, still in its awaits, sees each
    // acknowledged kill and doesn't start. Only an acknowledged kill counts:
    // one that throws (not attached, death unconfirmed) reports an error and
    // refuses nothing. The count only grows, so a launch can never see a kill
    // appear and then vanish.
    if (c.status === 'exited' || c.status === 'crashed') {
      c.killAcks = (c.killAcks ?? 0) + 1;
      if (c.autoRestart) c.autoRestartStopped ??= KILL_ENDED_RESTARTS;
      return { success: true, data: { name: c.name, status: c.status, note: 'already stopped' } };
    }
    await this.killChild(c);
    c.killAcks = (c.killAcks ?? 0) + 1;
    if (c.autoRestart) c.autoRestartStopped ??= KILL_ENDED_RESTARTS;
    return {
      success: true,
      data: { name: c.name, status: c.status, exitCode: c.exitCode, exitReason: c.exitReason },
    };
  }

  private async handleRestart(input: { name: string }): Promise<ToolResult> {
    const c = this.children.get(input.name);
    if (!c) return this.unknownChild(input.name, 'nothing was restarted');
    const relaunch: LaunchInput = {
      name: c.name,
      recipe: c.recipePath,
      dataDir: c.dataDir,
      subscription: [...c.subscription],
      autoRestart: c.autoRestart,
    };
    if (c.env !== undefined) relaunch.env = { ...c.env };
    // Kills are counted from the restart's start, so one acknowledged while
    // the restart waits for its own kill still refuses the relaunch.
    const killsAtStart = c.killAcks ?? 0;
    this.cancelAutoRestart(c);
    c.killRequested = true;
    if ((c.process || c.adopted) && (c.status === 'starting' || c.status === 'ready')) {
      await this.killChild(c);
    }
    // Restart is implicitly allowed — we're using the exact recipe the child
    // was originally launched with (which already passed the allowlist check).
    return await this.handleLaunch(relaunch, { viaAutoStart: true, killsAtStart });
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
    const canonicalResolved = existsSync(resolved) ? realpathSync(resolved) : resolved;
    for (const entry of this.allowlist) {
      if (entry === '*') return true;
      const canonicalEntry = !entry.includes('*') && existsSync(entry) ? realpathSync(entry) : entry;
      if (entry === recipe || entry === resolved || canonicalEntry === canonicalResolved) return true;
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
      return {
        success: false, isError: true,
        error: `Nothing was relayed: fleet--relay needs "from", the child whose last reply to pass on, and "to", ` +
          `the child to send it to, both as child names; for "from", ${got(input.from)}, and for "to", ` +
          `${got(input.to)}.`,
      };
    }
    if (input.from === input.to) {
      return {
        success: false, isError: true,
        error: `Nothing was relayed: "from" and "to" are both '${input.from}', and a relay passes one child's ` +
          `reply to another. Give two different children's names.`,
      };
    }
    const fromChild = this.children.get(input.from);
    if (!fromChild) return this.unknownChild(input.from, 'nothing was relayed');
    const target = this.requireRunning(input.to, 'nothing was relayed');
    if (!('child' in target)) return target;

    const speech = fromChild.lastCompletedSpeech;
    if (!speech) {
      // The child sends only what its subscription names, and the floor the
      // host forces into it leaves inference:speech out.
      const heard = matchesSubscription('inference:speech', new Set(fromChild.subscription));
      // A reply can come only from a running child this host can reach. For
      // one it can, nothing marks the start of a child's work, so the host
      // can't tell whether it's busy, and fleet--await, which reads the
      // latest lifecycle event, returns at once after a send to a child that
      // had gone idle; so the error names no wait.
      const unreachable = this.unreachable(fromChild);
      return {
        success: false,
        isError: true,
        error: heard
          ? `Nothing was relayed: '${input.from}' hasn't finished a reply since this host began tracking it` +
            (unreachable !== null
              ? `, and it ${unreachable}.`
              : `. A reply counts once one of its inference rounds ends without tool calls, and fleet--relay ` +
                `passes it on then; if '${input.from}' has nothing to answer, fleet--send gives it something.`)
          : `Nothing was relayed: '${input.from}' has no finished reply on record, since its subscription ` +
            `(${fromChild.subscription.join(', ') || 'empty'}) leaves out inference:speech, so its replies never ` +
            `reach this host. fleet--restart keeps that subscription, ` +
            // env reaches a child only from this host's recipe (autoStart),
            // never through fleet--launch, and a child adopted at a host's
            // start keeps the subscription it had. A restored record takes env
            // from its recipe entry even when that entry's autoStart is false,
            // and start() launches only entries whose autoStart isn't.
            (fromChild.env !== undefined
              ? `and fleet--launch can't pass the env '${input.from}' was started with, so a relaunch would lose ` +
                `it. Ask the user to add inference:speech to its subscription in this host's recipe, and to turn ` +
                `its autoStart on there if it's set to false; this host then starts it with that subscription at ` +
                `its next start, if '${input.from}' isn't running then.`
              : `so fleet--kill '${input.from}', then fleet--launch it again with the recipe, dataDir and ` +
                `autoRestart that fleet--status shows for it, and a subscription that includes inference:speech.`),
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
      return {
        success: false, isError: true,
        error: `Nothing was waited on: fleet--await needs "names", a list of one or more child names; ` +
          `${got(input.names)}.`,
      };
    }
    // Dedupe so requireAll doesn't double-count the same child and wait forever.
    const names = [...new Set(input.names)];
    for (const name of names) {
      if (!this.children.has(name)) return this.unknownChild(name, 'nothing was waited on');
    }

    // Children that are *already* idle when the call begins should count
    // as done — look at the most recent lifecycle event on each.
    const done = new Set<string>();
    for (const name of names) {
      if (this.isMostRecentLifecycleIdle(this.children.get(name)!)) done.add(name);
    }

    // Pre-check terminal state — if any waited-for child is already crashed/exited,
    // there's no idle to wait for; short-circuit instead of paying the 200ms
    // crashPoll latency.  The same shape as the in-flight crash error below,
    // naming the children already idle.
    for (const name of names) {
      const c = this.children.get(name)!;
      if (c.status === 'crashed' || c.status === 'exited') {
        return { success: false, isError: true, error: this.awaitedChildStopped(c, [...done]) };
      }
    }

    const requireAll = input.requireAll !== false;  // default true
    const timeoutMs = input.timeoutMs ?? 300_000;
    const startedAt = Date.now();

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
            finish({ success: false, isError: true, error: this.awaitedChildStopped(c, [...done]) });
            return;
          }
        }
      }, 200);

      const timeoutHandle = setTimeout(() => {
        finish({
          success: false,
          isError: true,
          error:
            `fleet--await timed out after ${timeoutMs} ms. Idle: ${listed([...done])}. Not yet idle: ` +
            `${listed(names.filter((n) => !done.has(n)))}. The wait changed nothing in the children: to keep ` +
            `waiting, call fleet--await again with the names not yet idle, and a larger timeoutMs if needed.`,
        });
      }, timeoutMs);
    });
  }

  /** fleet--await's answer when a child it waits on has stopped, whether
   *  before the wait or during it. The idle children it names leave out
   *  every child that has stopped, that one included, since each may have
   *  gone idle before it stopped. */
  private awaitedChildStopped(c: FleetChild, idle: string[]): string {
    const running = idle.filter((n) => {
      const status = this.children.get(n)?.status;
      return status !== 'crashed' && status !== 'exited';
    });
    return `Child '${c.name}' has ${c.status}${stoppedHow(c)}, so there's no idle to wait for. Idle so far: ` +
      `${listed(running)}. fleet--peek for '${c.name}' shows its last events, and ` +
      `fleet--restart for '${c.name}' starts it again.`;
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

  /** `outcome` says what didn't happen, such as "nothing was sent". */
  private requireRunning(name: string, outcome: string): { child: FleetChild } | ToolResult {
    const c = this.children.get(name);
    if (!c) return this.unknownChild(name, outcome);
    const state = this.unreachable(c);
    if (state === null) return { child: c };
    return { success: false, isError: true, error: `${capitalized(outcome)}: child '${c.name}' ${state}.` };
  }

  /** Why a call can't reach a child, finishing a sentence that begins with
   *  the child, with the step that helps; null for a running child this
   *  host has a connection to. */
  private unreachable(c: FleetChild): string | null {
    const name = c.name;
    if (c.status !== 'ready' && c.status !== 'starting') {
      return `has ${c.status}${stoppedHow(c)}, so it isn't running. fleet--restart for '${name}' starts it again`;
    }
    if (c.socket) return null;
    // A restored record this host isn't attached to; a ready child whose
    // connection closed before its exit was seen; or one still starting,
    // which may carry a failed launch's unconfirmed stop.
    return !c.process && !c.adopted
      ? `is recorded as ${c.status}, but this host isn't attached to it` +
        `${c.exitReason !== null ? ` (${c.exitReason})` : ''}. fleet--restart for '${name}' reattaches to it ` +
        'once it answers on its socket, or starts it again if its process is gone'
      : c.status === 'ready'
        ? `is ready, but its connection to this host has closed and its exit hasn't been seen yet, so it may ` +
          `be exiting. fleet--status for '${name}' shows its state; if it still shows ready, fleet--restart ` +
          `for '${name}' stops it and starts it again`
        : c.exitReason !== null
          ? `is recorded as starting (${c.exitReason}), and this host has no connection to it. fleet--status ` +
            `for '${name}' shows its state`
          : `is still starting, and this host has no connection to it. fleet--status for '${name}' shows ` +
            'its state';
  }

  /** A name no child has, with the names this host's children do have. */
  private unknownChild(name: unknown, outcome: string): ToolResult {
    const names = [...this.children.keys()].map((n) => `'${n}'`);
    const known = names.length === 0
      ? 'This host has no children; fleet--launch starts one.'
      : names.length === 1
        ? `This host's one child is ${names[0]}.`
        : `This host's children are ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}.`;
    return {
      success: false, isError: true,
      error: typeof name === 'string'
        ? `There's no child named '${name}', so ${outcome}. ${known}`
        : `${capitalized(outcome)}: it needs a child's name, as a string; ${got(name)}. ${known}`,
    };
  }

  // =========================================================================
  // Subprocess + socket plumbing
  // =========================================================================

  private async waitForSocket(
    child: FleetChild,
    deadline = Date.now() + this.config.socketWaitTimeoutMs,
    lastRefusal?: unknown,
  ): Promise<void> {
    const timeout = this.config.socketWaitTimeoutMs;
    while (Date.now() < deadline) {
      if (child.process && (child.process.exitCode !== null || child.process.signalCode !== null)) {
        const { exitCode, signalCode } = child.process;
        const exited = signalCode !== null ? `was ended by ${signalCode}` : `exited with code ${exitCode}`;
        // A socket file, or a refused connect, doesn't show this child bound:
        // the file may be one a killed predecessor left. So the message says
        // only what is known, with the refusal when there was one.
        if (lastRefusal !== undefined || existsSync(child.socketPath)) {
          const refusal = lastRefusal === undefined ? ''
            : `; the last connect failed: ${lastRefusal instanceof Error ? lastRefusal.message : String(lastRefusal)}`;
          throw new Error(`the child ${exited} before this host could connect to its socket${refusal}`);
        }
        throw new Error(`the child ${exited} before its socket appeared`);
      }
      if (existsSync(child.socketPath)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`its socket didn't appear within ${timeout} ms`);
  }

  /** A killed child can leave its pathname behind. Wait for the replacement
   * runtime to bind, without deleting files whose ownership may have changed. */
  private async connectStartingChild(child: FleetChild): Promise<void> {
    const deadline = Date.now() + this.config.socketWaitTimeoutMs;
    let lastRefusal: unknown;
    do {
      await this.waitForSocket(child, deadline, lastRefusal);
      try {
        // Retain the socket identity observed for this owned generation, so
        // later cleanup cannot remove a replacement endpoint (#170).
        const socketStat = lstatSync(child.socketPath, { bigint: true });
        if (socketStat.isSocket()) child.ownedSocket = {
          dev: socketStat.dev, ino: socketStat.ino, ctimeNs: socketStat.ctimeNs,
        };
        await this.connectChildSocket(child);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw err;
        lastRefusal = err;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    const refusal = lastRefusal instanceof Error ? lastRefusal.message : String(lastRefusal);
    throw new Error(`its socket refused connections for ${this.config.socketWaitTimeoutMs} ms; the last connect failed: ${refusal}`);
  }

  private async connectChildSocket(child: FleetChild): Promise<void> {
    return new Promise((resolveConn, rejectConn) => {
      const sock = netConnect(child.socketPath);
      // Socket decoding retains incomplete UTF-8 characters across chunks.
      sock.setEncoding('utf8');
      const timer = setTimeout(() => {
        sock.destroy();
        rejectConn(new Error(`a connect to its socket got no answer within ${CONNECT_ANSWER_MS} ms`));
      }, CONNECT_ANSWER_MS);

      sock.once('connect', () => {
        clearTimeout(timer);
        child.socket = sock;
        child.buffer = '';
        sock.on('data', (chunk: string) => {
          if (child.socket === sock) this.handleChildData(child, chunk);
        });
        // A reset may emit only close; stale callbacks must not release a new socket.
        const release = (): void => {
          if (child.socket === sock) child.socket = null;
        };
        sock.on('end', release);
        sock.on('close', release);
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
        throw new Error(`the child ${child.status} before it reported ready`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`the child didn't report ready within ${timeout} ms`);
  }

  private handleChildData(child: FleetChild, chunk: string): void {
    child.buffer += chunk;
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
      throw new Error(`child '${child.name}' has no open connection to this host`);
    }
    // Single chokepoint for outgoing commands. We force the reducer-required
    // events into every subscribe so recipe authors (or agents calling the
    // subscribe tool) can't accidentally disable the unified-tree rendering
    // by omitting events like `inference:tool_calls_yielded` — the reducer
    // would drift into showing fleet children with empty subtrees and stale
    // 'ready' status. The wire is fatter by ~10 event types but they're tiny
    // relative to inference token streams.
    let outgoing = cmd;
    if (cmd.type === 'subscribe') {
      const requested = cmd.events;
      const augmented = unionWithReducerRequired(requested);
      // Log when we expanded the caller's intent so operators tailing logs
      // can see *why* a child is receiving events its recipe didn't list.
      // Silent rewriting of caller intent is its own postmortem-in-waiting.
      if (augmented.length !== requested.length) {
        const requestedSet = new Set(requested);
        const added = augmented.filter(e => !requestedSet.has(e));
        if (added.length > 0) {
          console.error(
            `[fleet] subscribe for "${child.name}": forced reducer-required events: ${added.join(', ')}`,
          );
        }
      }
      outgoing = { type: 'subscribe', events: augmented };
    }
    child.socket.write(JSON.stringify(outgoing) + '\n');
  }

  /**
   * Request a state snapshot from a fleet child. The child responds with a
   * single `snapshot` event over its event stream (received via onChildEvent).
   * Used as a recovery verb at sync points — TUI cold start, child reconnect,
   * after restart. See docs/history/UNIFIED-TREE-PLAN.md §3.
   *
   * Returns true if the request was sent, false if the child has no socket
   * (e.g. exited or not yet ready).
   */
  requestDescribe(childName: string, corrId?: string): boolean {
    const child = this.children.get(childName);
    if (!child || !child.socket) return false;
    try {
      this.sendToChild(child, { type: 'describe', corrId });
      return true;
    } catch {
      return false;
    }
  }

  /** Request the child's lesson library. Response arrives as a
   *  `lessons-snapshot` event on the child's event stream — subscribers
   *  match on `corrId` to correlate. */
  requestLessons(childName: string, corrId?: string): boolean {
    const child = this.children.get(childName);
    if (!child || !child.socket) return false;
    try { this.sendToChild(child, { type: 'request-lessons', corrId }); return true; }
    catch { return false; }
  }

  /** Request the child's workspace mount list. Response is a
   *  `workspace-mounts-snapshot` event. */
  requestWorkspaceMounts(childName: string, corrId?: string): boolean {
    const child = this.children.get(childName);
    if (!child || !child.socket) return false;
    try { this.sendToChild(child, { type: 'request-workspace-mounts', corrId }); return true; }
    catch { return false; }
  }

  /** Request a recursive listing of one mount in the child. Response is a
   *  `workspace-tree-snapshot` event. */
  requestWorkspaceTree(childName: string, mount: string, corrId?: string): boolean {
    const child = this.children.get(childName);
    if (!child || !child.socket) return false;
    try { this.sendToChild(child, { type: 'request-workspace-tree', mount, corrId }); return true; }
    catch { return false; }
  }

  /** Request a workspace file read from the child. Response is a
   *  `workspace-file-snapshot` event (with `error` set on failure). */
  requestWorkspaceFile(childName: string, path: string, corrId?: string): boolean {
    const child = this.children.get(childName);
    if (!child || !child.socket) return false;
    try { this.sendToChild(child, { type: 'request-workspace-file', path, corrId }); return true; }
    catch { return false; }
  }

  /** Cancel a specific in-process subagent inside a fleet child. Response
   *  arrives as a `cancel-subagent-result` event on the child's event stream;
   *  the WUI handler matches on corrId to route the result back to the
   *  originating browser client. Returns false if the named child isn't
   *  running. */
  cancelSubagentOnChild(childName: string, name: string, corrId?: string): boolean {
    const child = this.children.get(childName);
    if (!child || !child.socket) return false;
    try { this.sendToChild(child, { type: 'cancel-subagent', name, corrId }); return true; }
    catch { return false; }
  }

  /** Monotonic corrId source for requestPanel. */
  private panelSeq = 0;

  /**
   * Run one operator-panel op (see src/web/panel-data.ts) in a fleet child
   * and await its `panel-response`. Promise-based counterpart to the
   * fire-and-forget request* verbs above: HTTP proxy routes need to await a
   * body, and the WS handlers are simpler for it too.
   *
   * Never rejects — a dead child, send failure, or timeout resolves as
   * `{ok:false, error, status}` (502 unreachable, 504 timeout), so callers
   * translate straight into a response without try/catch.
   */
  requestPanel(
    childName: string,
    op: string,
    params?: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<{ ok: boolean; data?: unknown; error?: string; status?: number }> {
    const child = this.children.get(childName);
    if (!child || !child.socket) {
      return Promise.resolve({
        ok: false,
        error: child ? `child '${childName}' is ${child.status}, not running` : `unknown child: ${childName}`,
        status: child ? 502 : 404,
      });
    }
    const corrId = `panel-${op}-${++this.panelSeq}-${Date.now().toString(36)}`;
    return new Promise((resolvePanel) => {
      let settled = false;
      const finish = (result: { ok: boolean; data?: unknown; error?: string; status?: number }): void => {
        if (settled) return;
        settled = true;
        unsub();
        clearTimeout(timer);
        resolvePanel(result);
      };
      const unsub = this.onChildEvent(childName, (_name, evt) => {
        if (evt.type !== 'panel-response') return;
        const e = evt as unknown as PanelResponseEvent;
        if (e.corrId !== corrId) return;
        finish({
          ok: e.ok === true,
          ...(e.data !== undefined ? { data: e.data } : {}),
          ...(typeof e.error === 'string' ? { error: e.error } : {}),
          ...(typeof e.status === 'number' ? { status: e.status } : {}),
        });
      });
      const timer = setTimeout(() => {
        finish({ ok: false, error: `panel op '${op}' timed out after ${timeoutMs}ms (child '${childName}' unresponsive)`, status: 504 });
      }, timeoutMs);
      try {
        this.sendToChild(child, { type: 'panel-request', op, ...(params ? { params } : {}), corrId });
      } catch (err) {
        finish({ ok: false, error: `send to child failed: ${err instanceof Error ? err.message : String(err)}`, status: 502 });
      }
    });
  }

  /** Abort only the subprocess owned by this launch, never an adopted child.
   * Natural nonzero exits keep their retry even when notification races cleanup.
   * The error quotes the end of the child's own output during the launch,
   * which names the cause when the stage alone can't, such as a recipe
   * error; the record's exitReason stays one line. A child left running for
   * a later host to adopt is still writing, so its error has no quote. */
  private async failLaunch(child: FleetChild, reason: string, startupLog?: StartupLog): Promise<ToolResult> {
    const proc = child.process;
    // The exit handler records the failure beside the exit, whenever the exit
    // is observed.
    child.launchFailure = reason;
    const failed = `Child '${child.name}' didn't start (${reason})`;
    if (proc && proc.pid === undefined && proc.exitCode === null && proc.signalCode === null) {
      // The spawn started no process, such as for a runtime that isn't there:
      // it has no pid and no exit. There's nothing to stop or wait for,
      // nothing it could have written, and no exit to come, so the record
      // doesn't block another launch.
      child.exitedAt = Date.now();
      child.status = 'crashed';
      child.exitReason = `${reason}; no process started for this launch`;
      if (child.autoRestart) {
        child.autoRestartStopped ??=
          'no process started for its launch, which is not retried; fleet--restart or fleet--launch starts it again';
      }
      this.persistState();
      return {
        success: false, isError: true,
        error: `${failed}: no process started for it, as when the child's runtime can't be found, so there's ` +
          'nothing to stop and no output to quote. Nothing is running; if calling fleet--launch again fails the ' +
          'same way, ask whoever runs this host.',
      };
    }
    // Read as the child exited, or now if the exit hasn't been seen: its stop
    // is unconfirmed, or its exit's event hasn't run.
    const output = (): string => (startupLog ? startupLog.quote ?? quoteStartupOutput(startupLog) : '');
    if (this.stopping && this.detachMode) {
      // The shutdown closed the connection the launch was waiting on, and a
      // detaching parent leaves its children for a later parent to adopt,
      // unless the child has already exited.
      return {
        success: false, isError: true,
        error: proc && (proc.exitCode !== null || proc.signalCode !== null)
          ? `${failed} and has exited, and this host is shutting down, so there is nothing to retry here.${output()}`
          : `${failed}: this host is shutting down and leaves it running for the next host to adopt, ` +
            'so there is nothing to retry here.',
      };
    }
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      // SIGKILL exits are already excluded from autoRestart. Leave the manual
      // cancellation flag alone: a natural nonzero exit may be pending even
      // while ChildProcess still exposes null exit fields.
      try { child.socket?.destroy(); } catch { /* noop */ }
      child.socket = null;
      try { proc.kill('SIGKILL'); } catch { /* exit confirmation below is authoritative */ }
      if (!await this.waitForExit(proc, 2_000)) {
        // Keep launches blocked until the exit handler observes actual death.
        child.status = 'starting';
        child.exitReason = `${reason}; its stop is unconfirmed (pid ${child.pid})`;
        this.persistState();
        return {
          success: false, isError: true,
          error: `${failed}, and this host couldn't confirm that its process stopped (pid ${child.pid}). ` +
            `Launches and restarts of '${child.name}' are refused until its exit is seen; fleet--status for ` +
            `'${child.name}' shows its state.${output()}`,
        };
      }
    } else if (proc && child.exitedAt === null) {
      // The process shows its exit, but its 'exit' event hasn't run: record
      // the exit now, so the launch can't stay 'starting'. The event, when it
      // comes, records the same and may still retry. The quote is read below
      // with no await in between, so it ends where the file stands now, before
      // the record lets another launch of the name begin.
      child.exitedAt = Date.now();
      child.exitCode = proc.exitCode;
      child.status = proc.exitCode === 0 ? 'exited' : 'crashed';
      child.exitReason = withLaunchFailure(reason, exitText(proc.exitCode, proc.signalCode));
      this.persistState();
    } else if (proc && child.exitReason !== null && !child.exitReason.startsWith(reason)) {
      // The exit was recorded before the failure was known: add the failure.
      child.exitReason = withLaunchFailure(reason, child.exitReason);
      this.persistState();
    }
    // The exit handler retries this exit unless retries have ended. It may
    // not have run yet, so the error can only say a retry may come.
    const mayRetry = proc !== null && child.autoRestartStopped === undefined && this.retriesExit(child, proc.exitCode);
    return {
      success: false, isError: true,
      error: `${failed} and has exited. ` +
        // A host shutting down without detaching refuses every launch.
        (this.stopping
          ? 'Nothing is running, and this host is shutting down, so there is nothing to retry here.'
          : mayRetry
            ? `Nothing is running now, though its autoRestart may start it again by itself; fleet--kill for ` +
              `'${child.name}' stops that. Once the cause is fixed, call fleet--launch again.`
            : 'Nothing is running, so call fleet--launch again once the cause is fixed.') +
        output(),
    };
  }

  /**
   * Stop a tracked child. Only confirmed death of this tracked generation
   * (a reaped spawned handle, or ESRCH for a validated adoption) reuses the
   * existing guarded cleanupStaleChildFiles reconciliation. Unconfirmed
   * death throws first; detach never reaches here; killAllOnExitSync stays
   * synchronous and does not reconcile.
   */

  private async killChild(child: FleetChild): Promise<void> {
    if (child.status === 'exited' || child.status === 'crashed') {
      // Reaped spawned handles and validated adoptions confirmed this generation's death.
      // Unvalidated historical records keep launch-only reconciliation.
      if ((child.process || child.adopted) && existsSync(join(child.dataDir, 'headless.pid'))) await this.cleanupStaleChildFiles(child);
      return;
    }
    const proc = child.process;
    const pid = child.pid;
    if (!proc && !child.adopted) {
      throw new Error(
        `Nothing was stopped: this host isn't attached to child '${child.name}', whose record says ` +
        `${child.status}, so its process may still be running. fleet--restart for '${child.name}' reattaches to it ` +
        'once it answers on its socket, or starts it again if its process is gone; then fleet--kill can stop it.',
      );
    }
    if (!proc && (pid === null || !Number.isSafeInteger(pid) || pid <= 0)) {
      throw new Error(
        `Nothing was stopped: the record of child '${child.name}' has no usable process ID, so this host can't ` +
        `signal it, and it may still be running. fleet--status for '${child.name}' shows the record; if it's ` +
        `still running, ask whoever runs this host to stop it.`,
      );
    }

    // Mark intent so the exit handler doesn't trigger autoRestart.
    child.killRequested = true;

    if (child.socket) {
      try { this.sendToChild(child, { type: 'shutdown', graceful: true }); } catch { /* noop */ }
    }

    // Adopted children have no ChildProcess handle; we can still send signals
    // via the recorded pid and poll liveness with signal 0.
    const waitExit = (ms: number): Promise<boolean> =>
      proc !== null ? this.waitForExit(proc, ms) : this.waitForExitByPid(pid!, ms);
    const sendSignal = (sig: NodeJS.Signals): void => {
      if (proc) { try { proc.kill(sig); } catch { /* noop */ } }
      else if (pid !== null) { try { process.kill(pid, sig); } catch { /* noop */ } }
    };

    let confirmed = await waitExit(this.config.gracefulShutdownMs);
    if (!confirmed) {
      sendSignal('SIGTERM');
      confirmed = await waitExit(this.config.sigtermEscalationMs);
    }
    if (!confirmed) {
      sendSignal('SIGKILL');
      confirmed = await waitExit(2_000);
    }
    if (!confirmed) {
      throw new Error(
        `Child '${child.name}' may still be running: this host signalled it to stop, up to SIGKILL, and ` +
        `couldn't confirm that it stopped (pid ${pid}), so whether the kill took effect is unknown. fleet--status ` +
        `for '${child.name}' shows its state; if it still shows ready or starting, ask whoever runs this host ` +
        `to check pid ${pid}.`,
      );
    }
    if (!proc) {
      // Adopted children have no process exit handler to update their record.
      child.status = 'exited';
      child.exitedAt = Date.now();
      child.exitCode = null; // signal-0 cannot recover the adopted process's exit code.
      child.exitReason = 'shutdown requested; death confirmed (ESRCH)';
      child.socket?.destroy();
      child.socket = null;
      this.persistState();
    }
    // Confirmed death of the tracked generation: reuse the existing guarded
    // reconciliation; live, replaced, unknown or inaccessible evidence stays.
    // Without the PID file the ownership reconciler is a no-op. Avoid its
    // asynchronous boundary once the child already removed its own artifacts.
    if (existsSync(join(child.dataDir, 'headless.pid'))) await this.cleanupStaleChildFiles(child);
  }

  private waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
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

  /** Poll-based liveness for adopted children (no ChildProcess handle).
   *  `kill(pid, 0)` throws ESRCH once the process is gone. */
  private waitForExitByPid(pid: number, timeoutMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(false);
    const deadline = Date.now() + timeoutMs;
    return new Promise((res) => {
      const tick = (): void => {
        try {
          process.kill(pid, 0);
          if (Date.now() >= deadline) return res(false);
          setTimeout(tick, 100);
        } catch (err) {
          res((err as NodeJS.ErrnoException).code === 'ESRCH');
        }
      };
      tick();
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isUrlOrAbsolute(p: string): boolean {
  return p.startsWith('http://') || p.startsWith('https://') || isAbsolute(p);
}

/** What a call gave for an argument it needs, for its refusal. */
function got(value: unknown): string {
  if (value === undefined) return 'none was given';
  if (value === '') return 'it got an empty string';
  if (value === null) return 'it got null';
  if (Array.isArray(value)) return value.length === 0 ? 'it got an empty list' : 'it got a list';
  return `it got ${typeof value === 'object' ? 'an object' : `the ${typeof value} ${JSON.stringify(value)}`}`;
}

/** How a stopped child stopped, as its record says: the exit, or what ended
 *  it, such as a failed launch. Only the exit code when there's no reason. */
function stoppedHow(c: FleetChild): string {
  if (c.exitReason !== null) return ` (${c.exitReason})`;
  return c.exitCode !== null ? ` (exit code ${c.exitCode})` : '';
}

/** Child names as a message lists them. */
function listed(names: string[]): string {
  return names.length === 0 ? 'none' : names.map((n) => `'${n}'`).join(', ');
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Where a launch's output begins: the startup.log the parent opened for the
 *  child, and its size, device and inode once the launch's header was
 *  written. Or, when the parent couldn't open the file as a regular file as
 *  the child started, the file and why there's no quote, completing a
 *  sentence whose subject is the file. Once the parent has seen the child
 *  exit during the launch, the quote read then. */
type StartupLog = (
  | { path: string; offset: number; dev: bigint; ino: bigint }
  | { path: string; problem: string }
) & { quote?: string };

/**
 * Opens a child's startup.log for its stdout and stderr, writes the launch's
 * header, and says where the launch's output begins. One open, which doesn't
 * wait for a FIFO's reader: a FIFO left at the path would otherwise stop the
 * host's event loop at the open. The child gets the file only if it's a
 * regular file that took the header; otherwise its stdio goes nowhere, and
 * the log says why. A child whose writes fail as the header's did would
 * otherwise be said to have written nothing.
 */
function openStartupLog(path: string, header: string): { fd: number | null; log: StartupLog } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK, 0o666);
  } catch (err) {
    return { fd: null, log: { path, problem: `couldn't be opened when the child started (${errnoCode(err)}), ` +
      'so the child\'s console output wasn\'t kept' } };
  }
  let problem: string;
  let step = 'checked';
  try {
    if (fstatSync(fd).isFile()) {
      step = 'written to';
      // writeFileSync writes the whole header or throws: a short write, as on
      // a nearly full disk, is followed by one that fails (EFBIG under a
      // file-size limit, on Bun 1.3.14 and 1.4.3).
      writeFileSync(fd, header);
      step = 'checked';
      const opened = fstatSync(fd, { bigint: true });
      return { fd, log: { path, offset: Number(opened.size), dev: opened.dev, ino: opened.ino } };
    }
    problem = 'isn\'t a regular file';
  } catch (err) {
    problem = `couldn't be ${step} when the child started (${errnoCode(err)})`;
  }
  try { closeSync(fd); } catch { /* not handed on either way */ }
  return { fd: null, log: { path, problem: `${problem}, so the child's console output wasn't kept` } };
}

/** The most of a child's startup output a failed launch quotes: its last
 *  lines, read from the file's last bytes, at most so many characters as
 *  printed, each line's indent and newline included. */
const STARTUP_QUOTE_LINES = 20;
const STARTUP_QUOTE_CHARS = 2_000;
const STARTUP_READ_BYTES = 64 * 1024;
const STARTUP_QUOTE_INDENT = '  ';

function errnoCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? String(err);
}

/** Bun.stripANSI, reached through globalThis: the web UI's typecheck reads
 *  this module (through commands.ts) without Bun's types. */
function stripANSI(text: string): string {
  return (globalThis as unknown as { Bun: { stripANSI(text: string): string } }).Bun.stripANSI(text);
}

/**
 * The end of what the child wrote to startup.log during this launch, under a
 * line that says where it's from, for a failed launch's error, or a line that
 * says why there's none. Another file at that path, such as one a link there
 * names now, isn't the file the child was given, which it goes on writing to
 * through the descriptor it inherited, so whatever it holds can't be told to
 * be this launch's output, and it isn't read. A file now shorter than where
 * this launch began was truncated since: what it holds now, or its end, is quoted and
 * said to be that. A truncation isn't detected if the file is back at or past
 * that point when it's read, or if it comes between the size check and the
 * read. Anything that isn't a regular file isn't read.
 */
function quoteStartupOutput(log: StartupLog): string {
  if ('problem' in log) return `\n${log.path} ${log.problem}.`;
  let text = '';
  // Whether the file was truncated since the launch began, so what it holds
  // may not be this launch's output.
  let truncated = false;
  let unread = false;
  let fd: number | undefined;
  try {
    fd = openSync(log.path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) return `\n${log.path} isn't a regular file now, so it isn't read.`;
    if (stat.dev !== log.dev || stat.ino !== log.ino) {
      return `\n${log.path} was replaced during this launch, so it isn't the file the child was given, and isn't read.`;
    }
    const size = Number(stat.size);
    truncated = size < log.offset;
    const start = truncated ? 0 : log.offset;
    const from = Math.max(start, size - STARTUP_READ_BYTES);
    const buffer = Buffer.alloc(size - from);
    text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, from)).toString('utf8');
    // A read that starts after the output's start can start mid-line,
    // mid-character (decoded as U+FFFD), or inside an escape sequence, whose
    // tail then isn't one. The caps below usually cut that first line, since
    // 64 KiB is far past the character cap, though blank lines dropped from
    // the end can leave it short enough to stay. Either way the lead says the
    // rest is in the file.
    unread = from > start;
  } catch (err) {
    return `\n${log.path} couldn't be read (${errnoCode(err)}), so the child's output isn't quoted.`;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* the read is done */ }
    }
  }
  if (text === '') {
    return truncated
      ? `\n${log.path} was truncated during this launch, and is empty now.`
      : `\nThe child wrote nothing to ${log.path} during this launch.`;
  }
  // The quote is read as text, and the operator's terminal may show it, so
  // escape sequences go: the colour Bun writes even to a file under
  // FORCE_COLOR, and any other a child prints, such as OSC. So do the other
  // control characters but tab and newline: OpenTUI 0.1.107 writes a bell or
  // a backspace to the terminal as it is, and breaks the line at a carriage
  // return, so a progress line's pieces are joined. startup.log keeps them.
  // Each line is stripped on its own: Bun.stripANSI drops everything after a
  // sequence it finds no end for, which would hide an error printed after a
  // stray one. A sequence that really spans lines, such as sixel graphics,
  // leaves its later lines as printable noise.
  let lines = text.split('\n')
    .map((line) => stripANSI(line).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''));
  // Blank lines at the end go, unless they're all there is.
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === '') end--;
  lines = lines.slice(0, Math.max(end, 1));
  let cut = unread;
  if (lines.length > STARTUP_QUOTE_LINES) {
    lines = lines.slice(-STARTUP_QUOTE_LINES);
    cut = true;
  }
  // Each line counts as printed, with its indent and a newline, less the
  // newline the last line doesn't have.
  const printed = (line: string): number => STARTUP_QUOTE_INDENT.length + line.length + 1;
  let chars = lines.reduce((n, line) => n + printed(line), -1);
  while (lines.length > 1 && chars > STARTUP_QUOTE_CHARS) {
    chars -= printed(lines.shift()!);
    cut = true;
  }
  const room = STARTUP_QUOTE_CHARS - STARTUP_QUOTE_INDENT.length;
  if (lines[0]!.length > room) {
    // A cut through a character outside the BMP would leave half of it.
    lines[0] = lines[0]!.slice(-room).replace(/^[\uDC00-\uDFFF]/, '');
    cut = true;
  }
  const lead = truncated
    ? `${log.path} was truncated during this launch, so this is ` +
      `${cut ? 'the end of what it holds now (the rest is in the file)' : 'what it holds now'}, ` +
      'which may not be this launch\'s output:'
    : cut
      ? `The end of the child's output during this launch (the rest is in ${log.path}):`
      : `The child's output during this launch, from ${log.path}:`;
  return `\n${lead}\n${lines.map((line) => `${STARTUP_QUOTE_INDENT}${line}`).join('\n')}`;
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
