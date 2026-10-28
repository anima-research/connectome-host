/**
 * Each child is spawned as a detached subprocess running `bun src/index.ts
 * <recipe> --headless`, with its own DATA_DIR and Chronicle store.  The
 * parent connects to the child's Unix socket at {dataDir}/ipc.sock and
 * exchanges JSONL envelopes (see `fleet-types.ts`, `docs/fleet-protocol.md`).
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
import { type IncomingCommand, type WireEvent, type PanelResponseEvent, type UpdateResponseEvent, matchesSubscription } from './fleet-types.js';
import type { SwitchRequest } from '../update/quiesce.js';
import { loadRecipeDetailed } from '../recipe.js';
import { REDUCER_REQUIRED_EVENTS } from '../state/agent-tree-reducer.js';
import { parseCommand } from '../command-name.js';
import { AGENT_OVERLAY_FILE_ENV, AGENT_OVERLAY_FILE_NAME, CHILD_AGENT_OVERLAY_FILE_NAME, seedChildAgentOverlay } from '../mcpl-config.js';
import { unknownToolResult } from './unknown-tool.js';
import { INSTALL_ROOT_ENV, isChildEntry, readRecord, writeJsonAtomic, type ChildrenFile } from '../update/contract.js';
import { PRIVATE_DIR_MODE } from '../update/data-swap.js';
import { FLEET_BEGIN_ENV } from '../fleet-begin.js';

const HOST_FORCED_TELEMETRY_EVENTS: readonly string[] = ['usage:updated'];
export const CLOCK_SLACK_MS = 60_000;
const ADOPTION_UNRESOLVED = 'adoption unresolved;';

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
  filter: Set<string> | null;
}

export interface FleetModuleConfig {
  timeZone?: string;
  defaultSubscription?: string[];
  bufferSize?: number;
  socketWaitTimeoutMs?: number;
  readyTimeoutMs?: number;
  gracefulShutdownMs?: number;
  sigtermEscalationMs?: number;
  groupEndWaitMs?: number;
  childIndexPath?: string;
  childRuntimePath?: string;
  autoStart?: AutoStartChild[];
  allowedRecipes?: string[];
  childrenFile?: string;
}

export interface AutoStartChild {
  name: string;
  recipe: string;
  dataDir?: string;
  env?: Record<string, string>;
  subscription?: string[];
  autoStart?: boolean;
  autoRestart?: boolean;
}

interface LaunchInput {
  name: string;
  recipe: string;
  dataDir?: string;
  env?: Record<string, string>;
  subscription?: string[];
  autoRestart?: boolean;
}

type ChildStatus = 'starting' | 'ready' | 'exited' | 'crashed';

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
  groupEnded?: boolean;
}

interface PersistedFleetState {
  children: Record<string, PersistedChild>;
}

interface FleetChild {
  name: string;
  recipePath: string;
  dataDir: string;
  socketPath: string;
  ownedSocket?: { dev: bigint; ino: bigint; ctimeNs: bigint };
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
  events: WireEvent[];
  buffer: string;
  subscription: string[];
  autoRestart: boolean;
  bootId?: string;
  killRequested: boolean;
  restartAttempts: number[];
  restartTimer?: ReturnType<typeof setTimeout>;
  killAcks?: number;
  adopting?: boolean;
  autoRestartStopped?: string;
  launchFailure?: string;
  groupEnded?: boolean;
  groupSignal?: string;
  spawnError?: unknown;
  env?: Record<string, string>;
  lastCompletedSpeech: string;
}

function exitText(code: number | null, signal: NodeJS.Signals | string | null): string {
  return signal ?? (code === 0 ? 'clean' : `code=${code}`);
}

const CONNECT_ANSWER_MS = 3_000;

const KILL_ENDED_RESTARTS = 'fleet--kill ended automatic restarts; fleet--restart or fleet--launch starts it again';

function withLaunchFailure(failure: string, exit: string): string {
  return `${failure} (exit: ${exit})`;
}

/** Node's and Bun's ERR_INVALID_ARG_* messages end with the value they
 *  refused (" Received …"), which for an env value may be a secret, and
 *  exitReason is persisted, so the text stops before it, or is the code
 *  alone. */
export function spawnErrorText(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (typeof code === 'string' && code.startsWith('ERR_INVALID_ARG')) {
    const cut = message.indexOf(' Received');
    return cut >= 0 ? `${message.slice(0, cut)} (${code})` : code;
  }
  return typeof code === 'string' && !message.includes(code) ? `${message} (${code})` : message;
}

/** The codes a spawn gives for a runtime it can't start (Bun 1.3.14 and
 *  1.4.3, Linux): ENOENT and EACCES come as an 'error' after the spawn
 *  returns, and the others are thrown. */
const RUNTIME_SPAWN_CODES: ReadonlySet<string> = new Set(['ENOENT', 'EACCES', 'ELOOP', 'ENOTDIR', 'ENOEXEC']);

function spawnCause(err: unknown): 'runtime' | 'configuration' | 'other' {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  if (typeof code === 'string' && RUNTIME_SPAWN_CODES.has(code)) return 'runtime';
  if (typeof code === 'string' && code.startsWith('ERR_INVALID_ARG')) return 'configuration';
  return 'other';
}

export function fleetChildDataDir(child: { name: string; dataDir?: string }): string {
  return resolve(process.cwd(), child.dataDir || join('data', child.name));
}

export function fleetChildEnv(
  env: NodeJS.ProcessEnv,
  childEnv: Record<string, string> | undefined,
  timeZone: string,
  dataDir: string,
): NodeJS.ProcessEnv {
  const childsEnv: NodeJS.ProcessEnv = {
    ...env, ...childEnv, AGENT_TIMEZONE: timeZone, DATA_DIR: dataDir, CONNECTOME_UPDATE_CHECK: '0',
    [AGENT_OVERLAY_FILE_ENV]: join(dataDir, CHILD_AGENT_OVERLAY_FILE_NAME),
  };
  delete childsEnv[INSTALL_ROOT_ENV];
  delete childsEnv[FLEET_BEGIN_ENV];
  return childsEnv;
}

export class FleetModule implements Module {
  readonly name = 'fleet';

  private ctx: ModuleContext | null = null;
  private children = new Map<string, FleetChild>();
  private config: Required<Omit<FleetModuleConfig, 'autoStart' | 'allowedRecipes' | 'childrenFile'>>;
  private readonly childrenFile: string | null;
  private autoStartChildren: AutoStartChild[];
  private stopping = false;
  private started = false;
  private adopting = false;
  private storeSync: (() => void) | null = null;
  private autoStartLaunched = false;
  private launchingAutoStart = new Map<string, { recorded: Promise<void>; end: () => void }>();
  private detachMode = false;
  private readonly restartFlapWindowMs = 60_000;
  private readonly restartFlapCap = 3;
  private allowlist: string[];
  private allowlistEnabled: boolean;
  private eventSubscribers = new Map<string, Set<FleetEventSubscription>>();
  private exitHandler: (() => void) | null = null;

  constructor(config: FleetModuleConfig = {}) {
    this.config = {
      defaultSubscription: config.defaultSubscription ?? ['*'],
      bufferSize: config.bufferSize ?? 500,
      socketWaitTimeoutMs: config.socketWaitTimeoutMs ?? 15_000,
      readyTimeoutMs: config.readyTimeoutMs ?? 10_000,
      gracefulShutdownMs: config.gracefulShutdownMs ?? 10_000,
      sigtermEscalationMs: config.sigtermEscalationMs ?? 5_000,
      groupEndWaitMs: config.groupEndWaitMs ?? 2_000,
      childIndexPath: config.childIndexPath ?? process.argv[1] ?? '',
      childRuntimePath: config.childRuntimePath ?? process.execPath,
      timeZone: resolveTimeZone(config.timeZone),
    };

    this.autoStartChildren = config.autoStart ?? [];
    this.childrenFile = config.childrenFile ?? null;

    const explicit = config.allowedRecipes;
    const implicit = this.autoStartChildren.map((c) => c.recipe);
    this.allowlistEnabled = explicit !== undefined || implicit.length > 0;
    this.allowlist = [...(explicit ?? []), ...implicit];
  }

  /** The 'exit' listener doesn't fire on a hard crash or a SIGKILL of the parent,
   *  and detached children then orphan to PID 1. */
  private killAllOnExitSync(): void {
    if (this.detachMode) return;
    const endGroup = (pid: number | undefined | null): boolean => {
      if (pid === undefined || pid === null || !Number.isSafeInteger(pid) || pid <= 0) return false;
      try {
        process.kill(-pid, 'SIGKILL');
        return true;
      } catch {
        return false;
      }
    };
    for (const c of this.children.values()) {
      const proc = c.process;
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        if (!endGroup(proc.pid)) {
          try { proc.kill('SIGKILL'); } catch { }
        }
      } else if (!proc && c.adopted && c.pid !== null && (c.status === 'ready' || c.status === 'starting')) {
        if (c.socket !== null && endGroup(c.pid)) continue;
        try { process.kill(c.pid, 'SIGKILL'); } catch { }
      }
    }
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;

    if (!this.exitHandler) {
      this.exitHandler = (): void => this.killAllOnExitSync();
      process.on('exit', this.exitHandler);
    }

    await this.adoptPersistedChildren();
    this.started = true;
  }

  autoStartLaunching(): ReadonlySet<string> {
    return new Set(this.launchingAutoStart.keys());
  }

  autoStartRecorded(): Promise<void> {
    return Promise.all([...this.launchingAutoStart.values()].map(({ recorded }) => recorded)).then(() => undefined);
  }

  private endAutoStartWait(name: string): void {
    this.launchingAutoStart.get(name)?.end();
    this.launchingAutoStart.delete(name);
  }

  launchAutoStart(): void {
    if (!this.started || this.stopping || this.autoStartLaunched) return;
    this.autoStartLaunched = true;
    for (const child of this.autoStartChildren) {
      if (child.autoStart === false) continue;
      if (this.children.get(child.name)?.adopted) continue;

      const input: LaunchInput = { name: child.name, recipe: child.recipe };
      if (child.dataDir !== undefined) input.dataDir = child.dataDir;
      if (child.env !== undefined) input.env = child.env;
      if (child.subscription !== undefined) input.subscription = child.subscription;
      if (child.autoRestart !== undefined) input.autoRestart = child.autoRestart;

      let end!: () => void;
      const recorded = new Promise<void>((done) => { end = done; });
      this.launchingAutoStart.set(child.name, { recorded, end });
      this.handleLaunch(input, { viaAutoStart: true })
        .then((res) => {
          if (!res.success) {
            console.error(`[fleet] autoStart "${child.name}" failed: ${res.error}`);
          }
        })
        .catch((err: unknown) => {
          console.error(`[fleet] autoStart "${child.name}" threw: ${String(err)}`);
        })
        .finally(() => { this.endAutoStartWait(child.name); });
    }
  }

  /** A Chronicle store write is durable only at the store's next sync or close,
   *  so the record of a child's spawn is synced at once. */
  setStoreSync(sync: () => void): void {
    this.storeSync = sync;
  }

  private persistState(sync = false, list = false): string | null {
    for (const c of this.children.values()) {
      if (c.groupEnded || c.status === 'starting' || c.status === 'ready') continue;
      if (!this.fromThisBoot(c) || !this.groupLeftBy(c.pid)) c.groupEnded = true;
    }
    if (!this.ctx || typeof this.ctx.setState !== 'function' || this.adopting) {
      return list ? this.writeChildrenFile() : null;
    }
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
        ...(c.groupEnded === true ? { groupEnded: true } : {}),
      };
    }
    this.ctx.setState<PersistedFleetState>({ children: persisted });
    if (sync) this.storeSync?.();
    return this.writeChildrenFile();
  }

  private writeChildrenFile(): string | null {
    if (this.childrenFile === null) return null;
    const failed = (why: string): string => {
      console.error(
        `[fleet] couldn't write ${this.childrenFile}, which an update reads to see which children are running: ` +
        `${why}. Until a write succeeds, it may list this host's children as an earlier write left them.`,
      );
      return why;
    };
    const earlier = this.childrenFileEntries();
    if (typeof earlier === 'string') return failed(earlier);
    const children: unknown[] = [];
    const listedDirs = new Set<string>();
    const knownPids = new Set<number>();
    const thisBoot = this.bootId() ?? null;
    const mayBeSameBoot = (bootId: string | null): boolean => bootId === null || thisBoot === null || bootId === thisBoot;
    for (const c of this.children.values()) {
      listedDirs.add(resolve(c.dataDir));
      const pid = c.status === 'starting' || c.status === 'ready' || !c.groupEnded ? c.pid : null;
      if (pid !== null) knownPids.add(pid);
      children.push({ name: c.name, pid, bootId: c.bootId ?? null, dataDir: c.dataDir });
    }
    for (const entry of earlier) {
      if (!isChildEntry(entry)) {
        children.push(entry);
        continue;
      }
      const child = entry;
      const running = child.pid !== null && (this.pidInUse(child.pid) || this.groupInUse(child.pid)) &&
        mayBeSameBoot(child.bootId);
      if (listedDirs.has(resolve(child.dataDir))) {
        if (running && !knownPids.has(child.pid!)) children.push(child);
      } else {
        children.push(running || child.pid === null ? child : { ...child, pid: null });
      }
    }
    try {
      writeJsonAtomic(this.childrenFile, { v: 1, children });
      return null;
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    }
  }

  private childrenFileEntries(): unknown[] | string {
    if (this.childrenFile === null) return [];
    let file: ChildrenFile | null;
    const fix = 'Replacing it would drop the children it lists, which an update reads to see which may still be ' +
      'running, so every launch that spawns a child fails this way until whoever runs this host fixes it, or ' +
      'removes it once no child ' +
      'it lists is running';
    try {
      file = readRecord<ChildrenFile>(this.childrenFile, 'file');
    } catch (err) {
      return `${err instanceof Error ? err.message : String(err)} ${fix}`;
    }
    if (file === null) return [];
    if (!Array.isArray(file.children)) return `The file at ${this.childrenFile} holds no list of children. ${fix}`;
    return file.children;
  }

  private async adoptPersistedChildren(): Promise<void> {
    if (!this.ctx) return;
    if (typeof this.ctx.getState !== 'function') return;

    let state: PersistedFleetState | null;
    try {
      state = this.ctx.getState<PersistedFleetState>();
    } catch {
      return;
    }
    if (!state?.children) return;

    this.adopting = true;
    try {
      for (const [name, p] of Object.entries(state.children)) {
        if (name !== p.name || p.socketPath !== join(p.dataDir, 'ipc.sock')) continue;

        if (!this.canRetryAdoption(p)) {
          this.children.set(name, this.reconstructOrphan(p));
          continue;
        }
        const alive = await this.probeLiveness(p);
        if (!alive) {
          const orphan = this.reconstructOrphan(p);
          const inUse = this.fromThisBoot(p) && this.pidInUse(p.pid);
          orphan.status = inUse ? 'starting' : 'crashed';
          orphan.exitReason = inUse
            ? `${ADOPTION_UNRESOLVED} its pid (${p.pid}) is still in use, so this host starts no other copy of it, and ` +
              'fleet--restart of it reattaches once it answers on its socket'
            : `${ADOPTION_UNRESOLVED} fleet--restart of it, or fleet--launch with its recipe and ` +
              'dataDir, probes it again';
          this.children.set(name, orphan);
          continue;
        }

        try {
          const reattached = await this.reattachToLivingChild(p);
          this.children.set(name, reattached);
          console.error(`[fleet] adopted "${name}" (pid=${p.pid}, socket=${p.socketPath})`);
        } catch (err) {
          console.error(`[fleet] failed to adopt "${name}": ${String(err)}`);
          const orphan = this.reconstructOrphan(p);
          orphan.status = this.fromThisBoot(p) && this.pidInUse(p.pid) ? 'starting' : 'crashed';
          orphan.exitReason = `adopt failed: ${err instanceof Error ? err.message : String(err)}`;
          this.children.set(name, orphan);
        }
      }
    } finally {
      this.adopting = false;
    }

    this.persistState();
  }

  private reconstructOrphan(p: PersistedChild): FleetChild {
    const child: FleetChild = {
      name: p.name,
      recipePath: p.recipePath,
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
      ...(p.groupEnded === true ? { groupEnded: true } : {}),
      killRequested: false,
      restartAttempts: [],
      lastCompletedSpeech: '',
    };
    // Resolved env values may contain secrets. Chronicle stores historical
    // snapshots, so env is runtime-only and legacy persisted env is ignored.
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

  private canRetryAdoption(p: PersistedChild | FleetChild): boolean {
    if (p.exitedAt !== null || p.groupEnded === true) return false;
    if (p.status === 'ready' || p.status === 'starting') return true;
    return p.status === 'crashed' && (
      p.exitReason?.startsWith('adopt failed:') === true ||
      p.exitReason === 'orphaned (parent restarted; child not alive)' ||
      p.exitReason?.startsWith(ADOPTION_UNRESOLVED) === true
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

  /** process.kill(pid, 0) shows only that some process holds the pid, which
   *  after a reboot can be an unrelated one, so the first lifecycle:ready's pid
   *  must match the persisted pid. */
  private async reattachToLivingChild(p: PersistedChild): Promise<FleetChild> {
    const child = this.reconstructOrphan(p);
    child.status = 'starting';
    child.exitedAt = null;
    child.exitCode = null;
    child.exitReason = null;

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
      try { child.socket?.destroy(); } catch { }
      child.socket = null;
      throw err;
    } finally {
      unsubPidCheck();
    }

    child.adopted = true;
    child.bootId = this.bootId() ?? child.bootId;
    return child;
  }

  /**
   * A child leads a process group of its own, since it's spawned detached, and
   * the group's id is its pid, which isn't reused while the group has a member.
   * A pid freed with the group's last member can be taken by another process's
   * group, so the signal goes as soon as the leader's end is seen, and once for
   * each generation.
   */
  private endGroupOf(child: FleetChild, pid: number | null): void {
    if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) return;
    if (child.groupSignal !== undefined || child.groupEnded) return;
    try {
      process.kill(-pid, 'SIGKILL');
      child.groupSignal = 'sent';
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        child.groupEnded = true;
        return;
      }
      child.groupSignal = code ?? String(err);
      console.error(`[fleet] couldn't end what's left of child "${child.name}"'s process group (${pid}): ` +
        `${child.groupSignal}` + (this.childrenFile !== null
        ? ', so the children file lists the child while that group may have a process.'
        : '.'));
    }
  }

  private async settleGroup(child: FleetChild): Promise<void> {
    if (child.groupSignal !== 'sent' || child.groupEnded) return;
    const deadline = Date.now() + this.config.groupEndWaitMs;
    while (this.groupInUse(child.pid)) {
      if (Date.now() >= deadline) return;
      await new Promise((wait) => setTimeout(wait, 50));
    }
    try {
      this.persistState();
    } catch (err) {
      console.error(`[fleet] couldn't record that child "${child.name}"'s process group has ended: ` +
        `${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A pid isn't handed out while a group with that id has a member, so a
   *  process holding it now is another's, and the child's group has ended,
   *  whatever group that process leads. */
  private groupLeftBy(pid: number | null): boolean {
    return this.groupInUse(pid) && !this.pidInUse(pid);
  }

  private groupInUse(pid: number | null): boolean {
    if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(-pid, 0); } catch (err) {
      return (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
    return true;
  }

  private pidIsGone(pid: number | null): boolean {
    if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
    return false;
  }

  /** No process outlives a boot, so a record from an earlier boot has none,
   *  whatever holds its pid now. */
  private fromThisBoot(c: { bootId?: string | null; startedAt: number }): boolean {
    const thisBoot = this.bootId();
    if (typeof c.bootId === 'string' && thisBoot !== undefined) return c.bootId === thisBoot;
    return c.startedAt >= Date.now() - uptime() * 1000 - CLOCK_SLACK_MS;
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

  private pidInUse(pid: number | null): boolean {
    return pid !== null && Number.isSafeInteger(pid) && pid > 0 && !this.pidIsGone(pid);
  }

  private mayBeRunning(c: FleetChild): boolean {
    return (c.status === 'starting' || c.status === 'ready') && this.pidInUse(c.pid);
  }

  private sharersIn(dataDir: string, name: string): FleetChild[] {
    return [...this.children.values()].filter((c) => c.name !== name && c.dataDir === dataDir && this.mayBeRunning(c));
  }

  /** Bun 1.3 reports ENOENT for Unix refusals; 1.4 also maps EMFILE to
   *  ECONNREFUSED. The already-required Node runtime preserves the
   *  actual error. */
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
      if (!recordMatches() || inspectSocket() !== null ||
          !same(metadata, lstatSync(pidPath, { bigint: true }))) return;
      unlinkSync(pidPath);
    } catch { }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  private cancelAutoRestart(child: FleetChild): void {
    if (child.restartTimer !== undefined) {
      clearTimeout(child.restartTimer);
      child.restartTimer = undefined;
    }
  }

  private retriesExit(child: FleetChild, code: number | null): boolean {
    return child.autoRestart && code !== null && code !== 0 && !child.killRequested && !this.stopping;
  }

  private tryAutoRestart(child: FleetChild): void {
    if (this.stopping || child.killRequested || this.children.get(child.name) !== child) return;
    const now = Date.now();
    child.restartAttempts = child.restartAttempts.filter((t) => now - t < this.restartFlapWindowMs);
    if (child.restartAttempts.length >= this.restartFlapCap) {
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

    child.restartTimer = setTimeout(() => {
      child.restartTimer = undefined;
      if (this.stopping || child.killRequested || this.children.get(child.name) !== child) return;
      this.handleLaunch(input, { viaAutoStart: true, autoRestartOf: child })
        .then((res) => {
          if (!res.success) {
            console.error(`[fleet] autoRestart "${child.name}" failed: ${res.error}`);
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
    this.stopping = true;
    for (const child of this.children.values()) this.cancelAutoRestart(child);

    if (this.detachMode) {
      // Children's own headless runtimes keep running, since they were spawned
      // with detached: true.
      for (const c of this.children.values()) {
        try { c.socket?.destroy(); } catch { }
        c.socket = null;
      }
    } else {
      const owned = [...this.children.values()].filter(child => child.process || child.adopted);
      const results = await Promise.allSettled(owned.map(child => this.killChild(child)));
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'Fleet child shutdown failed');
    }

    if (this.exitHandler) {
      process.off('exit', this.exitHandler);
      this.exitHandler = null;
    }
    this.ctx = null;
  }

  setDetachMode(on: boolean): void {
    this.detachMode = on;
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  getChildren(): ReadonlyMap<string, Readonly<FleetChild>> {
    return this.children;
  }

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
    if (input.dataDir != null && typeof input.dataDir !== 'string') {
      return {
        success: false, isError: true,
        error: `Nothing was launched: fleet--launch's "dataDir", when given, is the child's data directory as a ` +
          `string, absolute or relative to this host's working directory, such as "data/reviewer"; ` +
          `${got(input.dataDir)}.`,
      };
    }
    for (const [field, what] of [
      ['name', 'the child\'s short name'],
      ['recipe', 'the recipe\'s path or URL'],
      ['dataDir', 'the child\'s data directory'],
    ] as const) {
      const value = input[field];
      if (typeof value === 'string' && value.includes('\0')) {
        return {
          success: false, isError: true,
          error: `Nothing was launched: fleet--launch's "${field}" is ${what}, which can't hold a NUL byte; ` +
            `${got(value)}.`,
        };
      }
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

    if (!opts.viaAutoStart && this.allowlistEnabled) {
      const resolvedInput = isUrlOrAbsolute(input.recipe)
        ? input.recipe
        : resolve(process.cwd(), input.recipe);
      if (!this.matchesAllowlist(input.recipe, resolvedInput)) {
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
    const killsAtStart = opts.killsAtStart ?? existing?.killAcks ?? 0;
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

    try {
      const childRecipe = (await loadRecipeDetailed(recipePath, { fetchSystemPrompt: false })).recipe;
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
    }

    const dataDir = fleetChildDataDir(input);

    const socketPath = join(dataDir, 'ipc.sock');
    const subscription = input.subscription ?? this.config.defaultSubscription;
    const staleAtLaunch = staleReason();
    if (staleAtLaunch) return staleRefusal('loaded the recipe', staleAtLaunch);
    if (existing && existing.dataDir === dataDir && existing.socketPath === socketPath &&
        existing.recipePath === recipePath) {
      if (existing.adopting) {
        return {
          success: false, isError: true,
          error: `Nothing was launched: another launch is reattaching to the running process of child '${name}' ` +
            `right now. Once it returns, fleet--status for '${name}' shows whether the child is running.`,
        };
      }
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
            } catch { }
          }
        } finally {
          existing.adopting = false;
        }
      }
      await this.cleanupStaleChildFiles(existing);
    }
    const staleAtReconciliation = staleReason();
    if (staleAtReconciliation) return staleRefusal('checked the files an earlier run left', staleAtReconciliation);
    const others = [...this.children.values()].filter((c) => c.name !== name && c.dataDir === dataDir);
    const sharer = this.sharersIn(dataDir, name)[0];
    if (sharer) {
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

    if (!this.config.childIndexPath) {
      return {
        success: false,
        isError: true,
        error: 'Nothing was launched: this host doesn\'t know where its own entry script is (its fleet module ' +
          'has no childIndexPath), so it can\'t start any fleet child, and calling again won\'t change that. ' +
          'If you need one, ask whoever runs this host.',
      };
    }

    try {
      mkdirSync(dataDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    } catch (err) {
      return {
        success: false, isError: true,
        error: `Nothing was launched: this host couldn't create the data directory ${dataDir} ` +
          `(${(err as NodeJS.ErrnoException).code ?? String(err)}). Give fleet--launch another dataDir, or ask ` +
          'whoever runs this host to check that path.',
      };
    }

    const ranHere = existsSync(join(dataDir, 'startup.log'));
    const overlayPath = join(dataDir, CHILD_AGENT_OVERLAY_FILE_NAME);
    const workingOverlay = resolve(process.cwd(), AGENT_OVERLAY_FILE_NAME);
    try {
      seedChildAgentOverlay(overlayPath, workingOverlay, ranHere);
    } catch (err) {
      const copying = ranHere && existsSync(workingOverlay);
      return {
        success: false, isError: true,
        error: `Nothing was launched: this host couldn't write the agent overlay of child '${input.name}', ${overlayPath}` +
          `${copying ? `, as a copy of ${workingOverlay}` : ''} (${(err as NodeJS.ErrnoException).code ?? String(err)}). ` +
          `Ask whoever runs this host to check ${copying ? 'those paths' : 'that path'}, or give fleet--launch another dataDir.`,
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
      restartAttempts: [...(opts.autoRestartOf?.restartAttempts ?? [])],
      lastCompletedSpeech: '',
    };
    if (input.env !== undefined) child.env = { ...input.env };
    if (existing) this.cancelAutoRestart(existing);
    this.children.set(input.name, child);
    this.endAutoStartWait(input.name);

    // The child's stdout and stderr go to startup.log for its whole life, or
    // nowhere if the parent can't open it as a regular file. headless.ts
    // redirects process.stdout.write and process.stderr.write to headless.log
    // until its shutdown ends that log, but Bun's console.* writes to the
    // file descriptors directly (Bun 1.3.14 and 1.4.3), so every console line
    // the child prints lands here: a recipe error, a missing API key, an
    // import crash, and a fatal error after the redirect, such as a failed
    // listen.
    const { fd: startupFd, log: startupLog } = openStartupLog(join(dataDir, 'startup.log'),
      `\n--- launch ${new Date().toISOString()} recipe=${recipePath} pid=parent:${process.pid} ---\n`);

    const gated = this.childrenFile !== null;
    const env = fleetChildEnv(process.env, input.env, this.config.timeZone, dataDir);
    if (gated) env[FLEET_BEGIN_ENV] = 'line';
    let proc: ChildProcess | undefined;
    try {
      proc = spawnProcess(
        this.config.childRuntimePath,
        [this.config.childIndexPath, recipePath, '--headless'],
        {
          detached: true,
          stdio: [gated ? 'pipe' : 'ignore', startupFd ?? 'ignore', startupFd ?? 'ignore'],
          env,
        },
      );
    } catch (err) {
      // Bun's spawn throws for a NUL byte in an argument or an env value, a
      // runtime the system can't execute (ELOOP, ENOTDIR, ENOEXEC), an
      // environment too large (E2BIG) and a bad stdio descriptor (Bun 1.3.14
      // and 1.4.3, Linux). No process started.
      child.spawnError = err;
    } finally {
      if (startupFd !== null) {
        try { closeSync(startupFd); } catch { }
      }
    }
    if (proc === undefined) {
      return await this.failLaunch(child, `launch failed: ${this.spawnFailure(child)}`, startupLog);
    }
    // A spawn that can't start the runtime, such as one that isn't there,
    // reports it here on a later tick, with no pid and no exit to follow, and
    // the socket wait then ends at once.
    proc.on('error', (err) => {
      if (proc.pid === undefined) child.spawnError ??= err;
      else console.error(`[fleet] child "${child.name}" (pid ${proc.pid}): ${spawnErrorText(err)}`);
    });
    proc.unref();
    if ('problem' in startupLog) {
      console.error(`[fleet] launch of "${input.name}": ${startupLog.path} ${startupLog.problem}.`);
    }

    child.process = proc;
    child.pid = proc.pid ?? null;

    let launching = true;
    proc.on('exit', (code, signal) => {
      this.endGroupOf(child, proc.pid ?? null);
      if (launching) startupLog.quote = quoteStartupOutput(startupLog);
      child.exitedAt = Date.now();
      child.exitCode = code ?? null;
      const exit = exitText(code, signal);
      child.exitReason = child.launchFailure !== undefined ? withLaunchFailure(child.launchFailure, exit) : exit;
      child.status = code === 0 ? 'exited' : 'crashed';
      try { child.socket?.destroy(); } catch { }
      child.socket = null;

      try {
        this.persistState();
      } catch (err) {
        console.error(`[fleet] couldn't record that child "${child.name}" exited: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!child.groupEnded) {
        setTimeout(() => {
          try {
            this.persistState();
          } catch (err) {
            console.error(`[fleet] couldn't record child "${child.name}"'s state after its exit: ` +
              `${err instanceof Error ? err.message : String(err)}`);
          }
        }, this.config.groupEndWaitMs).unref();
      }

      if (this.retriesExit(child, code)) {
        this.tryAutoRestart(child);
      } else if (child.autoRestart && code === null && !child.killRequested && !this.stopping) {
        child.autoRestartStopped ??= `${child.launchFailure !== undefined ? 'its start failed and ' : ''}` +
          `it was ended by ${signal ?? 'a signal'}, which is not retried; fleet--restart or fleet--launch starts it again`;
      }
    });

    let failureStage = 'its record couldn\'t be kept';
    try {
      const unlisted = this.persistState(true, true);
      if (unlisted !== null) {
        failureStage = `it couldn't be listed in ${this.childrenFile}, which an update reads to see which children ` +
          'are running';
        throw new Error(unlisted);
      }
      if (gated) {
        // A write to a child that has ended fails, which its exit says.
        proc.stdin?.on('error', () => {});
        proc.stdin?.end('\n');
      }
      failureStage = 'launch failed';
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
    if (c.status === 'exited' || c.status === 'crashed') {
      c.killAcks = (c.killAcks ?? 0) + 1;
      if (c.autoRestart) c.autoRestartStopped ??= KILL_ENDED_RESTARTS;
      await this.settleGroup(c);
      const left = this.groupLeftNote(c);
      return { success: true, data: { name: c.name, status: c.status, note: left === undefined ? 'already stopped' : `already stopped. ${left}` } };
    }
    await this.killChild(c);
    c.killAcks = (c.killAcks ?? 0) + 1;
    if (c.autoRestart) c.autoRestartStopped ??= KILL_ENDED_RESTARTS;
    const left = this.groupLeftNote(c);
    return {
      success: true,
      data: { name: c.name, status: c.status, exitCode: c.exitCode, exitReason: c.exitReason, ...(left ? { note: left } : {}) },
    };
  }

  private groupLeftNote(c: FleetChild): string | undefined {
    if (c.groupEnded || !this.fromThisBoot(c) || !this.groupLeftBy(c.pid)) return undefined;
    const why = c.groupSignal === 'sent'
      ? 'though this host sent it SIGKILL'
      : c.groupSignal !== undefined
        ? `which this host's SIGKILL couldn't reach (${c.groupSignal})`
        : "which this host didn't signal, since nothing showed that group was still the child's when its process " +
          "ended, and its id may since have been taken by another";
    return `Its process has ended, but process group ${c.pid}, which it led, still has a process, ${why}. ` +
      `${this.childrenFile !== null ? 'The children file lists the child while that group has a process, so no ' +
        'update goes ahead while it does. ' : ''}Once sure that group is still the child's, whoever runs this host ` +
      `can end it, as a user allowed to signal it, with \`kill -KILL -- -${c.pid}\`; a process held in the kernel ends ` +
      'only once the kernel lets it go.';
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
    const killsAtStart = c.killAcks ?? 0;
    this.cancelAutoRestart(c);
    c.killRequested = true;
    if ((c.process || c.adopted) && (c.status === 'starting' || c.status === 'ready')) {
      await this.killChild(c);
    }
    return await this.handleLaunch(relaunch, { viaAutoStart: true, killsAtStart });
  }

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
      const heard = matchesSubscription('inference:speech', new Set(fromChild.subscription));
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
    const names = [...new Set(input.names)];
    for (const name of names) {
      if (!this.children.has(name)) return this.unknownChild(name, 'nothing was waited on');
    }

    const done = new Set<string>();
    for (const name of names) {
      if (this.isMostRecentLifecycleIdle(this.children.get(name)!)) done.add(name);
    }

    for (const name of names) {
      const c = this.children.get(name)!;
      if (c.status === 'crashed' || c.status === 'exited') {
        return { success: false, isError: true, error: this.awaitedChildStopped(c, [...done]) };
      }
    }

    const requireAll = input.requireAll !== false;
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

  private awaitedChildStopped(c: FleetChild, idle: string[]): string {
    const running = idle.filter((n) => {
      const status = this.children.get(n)?.status;
      return status !== 'crashed' && status !== 'exited';
    });
    return `Child '${c.name}' has ${c.status}${stoppedHow(c)}, so there's no idle to wait for. Idle so far: ` +
      `${listed(running)}. fleet--peek for '${c.name}' shows its last events, and ` +
      `fleet--restart for '${c.name}' starts it again.`;
  }

  private isMostRecentLifecycleIdle(child: FleetChild): boolean {
    for (let i = child.events.length - 1; i >= 0; i--) {
      const e = child.events[i]!;
      if (e.type === 'lifecycle') {
        return (e as { phase?: string }).phase === 'idle';
      }
    }
    return false;
  }

  private requireRunning(name: string, outcome: string): { child: FleetChild } | ToolResult {
    const c = this.children.get(name);
    if (!c) return this.unknownChild(name, outcome);
    const state = this.unreachable(c);
    if (state === null) return { child: c };
    return { success: false, isError: true, error: `${capitalized(outcome)}: child '${c.name}' ${state}.` };
  }

  private unreachable(c: FleetChild): string | null {
    const name = c.name;
    if (c.status !== 'ready' && c.status !== 'starting') {
      return `has ${c.status}${stoppedHow(c)}, so it isn't running. fleet--restart for '${name}' starts it again`;
    }
    if (c.socket) return null;
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

  private async waitForSocket(
    child: FleetChild,
    deadline = Date.now() + this.config.socketWaitTimeoutMs,
    lastRefusal?: unknown,
  ): Promise<void> {
    const timeout = this.config.socketWaitTimeoutMs;
    while (Date.now() < deadline) {
      if (child.spawnError !== undefined) throw new Error(this.spawnFailure(child));
      if (child.process && (child.process.exitCode !== null || child.process.signalCode !== null)) {
        const { exitCode, signalCode } = child.process;
        const exited = signalCode !== null ? `was ended by ${signalCode}` : `exited with code ${exitCode}`;
        // A socket file, or a refused connect, doesn't show this child
        // bound: the file may be one a killed predecessor left.
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

  /** A killed child can leave its pathname behind. */
  private async connectStartingChild(child: FleetChild): Promise<void> {
    const deadline = Date.now() + this.config.socketWaitTimeoutMs;
    let lastRefusal: unknown;
    do {
      await this.waitForSocket(child, deadline, lastRefusal);
      try {
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
          // An 'error' event with no listener would throw in the parent.
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
        continue;
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
        try { sub.callback(childName, event); } catch { }
      }
    }
  }

  private sendToChild(child: FleetChild, cmd: IncomingCommand): void {
    if (!child.socket) {
      throw new Error(`child '${child.name}' has no open connection to this host`);
    }
    let outgoing = cmd;
    if (cmd.type === 'subscribe') {
      const requested = cmd.events;
      const augmented = unionWithReducerRequired(requested);
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

  requestLessons(childName: string, corrId?: string): boolean {
    const child = this.children.get(childName);
    if (!child || !child.socket) return false;
    try { this.sendToChild(child, { type: 'request-lessons', corrId }); return true; }
    catch { return false; }
  }

  requestWorkspaceMounts(childName: string, corrId?: string): boolean {
    const child = this.children.get(childName);
    if (!child || !child.socket) return false;
    try { this.sendToChild(child, { type: 'request-workspace-mounts', corrId }); return true; }
    catch { return false; }
  }

  requestWorkspaceTree(childName: string, mount: string, corrId?: string): boolean {
    const child = this.children.get(childName);
    if (!child || !child.socket) return false;
    try { this.sendToChild(child, { type: 'request-workspace-tree', mount, corrId }); return true; }
    catch { return false; }
  }

  requestWorkspaceFile(childName: string, path: string, corrId?: string): boolean {
    const child = this.children.get(childName);
    if (!child || !child.socket) return false;
    try { this.sendToChild(child, { type: 'request-workspace-file', path, corrId }); return true; }
    catch { return false; }
  }

  cancelSubagentOnChild(childName: string, name: string, corrId?: string): boolean {
    const child = this.children.get(childName);
    if (!child || !child.socket) return false;
    try { this.sendToChild(child, { type: 'cancel-subagent', name, corrId }); return true; }
    catch { return false; }
  }

  private panelSeq = 0;
  private readonly waitingOn = new WeakMap<Socket, Set<() => void>>();

  requestPanel(
    childName: string,
    op: string,
    params?: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<{ ok: boolean; data?: unknown; error?: string; status?: number }> {
    return this.requestAnswer(childName, `panel-${op}`, 'panel-response', `panel op '${op}'`, timeoutMs,
      (corrId) => ({ type: 'panel-request', op, ...(params ? { params } : {}), corrId }));
  }

  runningChildren(): Array<{ name: string }> {
    return [...this.children.values()].filter((child) => child.status === 'starting' || child.status === 'ready')
      .map((child) => ({ name: child.name }));
  }

  requestSwitch(childName: string, request: SwitchRequest, timeoutMs: number): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    return this.requestAnswer(childName, `update-${request.op}`, 'update-response', `the switch's ${request.op}`, timeoutMs,
      (corrId) => ({ type: 'update-request', request, corrId }));
  }

  private requestAnswer(
    childName: string,
    corrPrefix: string,
    responseType: 'panel-response' | 'update-response',
    what: string,
    timeoutMs: number,
    command: (corrId: string) => IncomingCommand,
  ): Promise<{ ok: boolean; data?: unknown; error?: string; status?: number }> {
    const child = this.children.get(childName);
    if (!child || !child.socket) {
      return Promise.resolve({
        ok: false,
        error: child ? `child '${childName}' ${this.unreachable(child)}` : `unknown child: ${childName}`,
        status: child ? 502 : 404,
      });
    }
    const corrId = `${corrPrefix}-${++this.panelSeq}-${Date.now().toString(36)}`;
    const socket = child.socket;
    let waiting = this.waitingOn.get(socket);
    if (!waiting) {
      const onSocket = new Set<() => void>();
      socket.once('close', () => { for (const end of [...onSocket]) end(); });
      this.waitingOn.set(socket, onSocket);
      waiting = onSocket;
    }
    const waitingHere = waiting;
    return new Promise((resolveAnswer) => {
      let settled = false;
      const finish = (result: { ok: boolean; data?: unknown; error?: string; status?: number }): void => {
        if (settled) return;
        settled = true;
        unsub();
        clearTimeout(timer);
        waitingHere.delete(closed);
        resolveAnswer(result);
      };
      const closed = (): void => {
        finish({
          ok: false,
          error: `${what} got no answer, since the connection to child '${childName}' closed before one came, so it may or ` +
            'may not have taken effect',
          status: 502,
        });
      };
      waitingHere.add(closed);
      const unsub = this.onChildEvent(childName, (_name, evt) => {
        if (evt.type !== responseType) return;
        const e = evt as unknown as PanelResponseEvent | UpdateResponseEvent;
        if (e.corrId !== corrId) return;
        finish({
          ok: e.ok === true,
          ...(e.data !== undefined ? { data: e.data } : {}),
          ...(typeof e.error === 'string' ? { error: e.error } : {}),
          ...('status' in e && typeof e.status === 'number' ? { status: e.status } : {}),
        });
      });
      const timer = setTimeout(() => {
        finish({ ok: false, error: `${what} timed out after ${timeoutMs}ms: child '${childName}' sent no answer in that time`, status: 504 });
      }, timeoutMs);
      try {
        this.sendToChild(child, command(corrId));
      } catch (err) {
        finish({ ok: false, error: `send to child failed: ${err instanceof Error ? err.message : String(err)}`, status: 502 });
      }
    });
  }

  private spawnFailure(child: FleetChild): string {
    const text = spawnErrorText(child.spawnError);
    switch (spawnCause(child.spawnError)) {
      case 'runtime': return `its runtime couldn't be started: ${text}`;
      case 'configuration': return `its spawn refused a value from this host's configuration: ${text}`;
      default: return `its spawn failed: ${text}`;
    }
  }

  private async failLaunch(child: FleetChild, reason: string, startupLog?: StartupLog): Promise<ToolResult> {
    const proc = child.process;
    child.launchFailure = reason;
    const failed = `Child '${child.name}' didn't start (${reason})`;
    if (!proc || (proc.pid === undefined && proc.exitCode === null && proc.signalCode === null)) {
      const known = child.spawnError !== undefined;
      const cause = spawnCause(child.spawnError);
      child.exitedAt = Date.now();
      child.status = 'crashed';
      child.exitReason = `${reason}; no process started for this launch`;
      if (child.autoRestart) {
        child.autoRestartStopped ??= cause === 'runtime'
          ? 'its runtime couldn\'t be started, which is not retried; once whoever runs this host fixes it, ' +
            'fleet--restart starts it again'
          : cause === 'configuration'
            ? 'its spawn refused a value from this host\'s configuration, which is not retried; it can start ' +
              'again once whoever runs this host changes that value and restarts the host'
            : 'no process started for its launch, which is not retried; fleet--restart tries again, and if ' +
              'that fails the same way, ask whoever runs this host';
      }
      this.persistState();
      return {
        success: false, isError: true,
        error: `${failed}: no process started for it, ${known ? '' : 'as when the child\'s runtime can\'t be found, '}` +
          'so there\'s nothing to stop and no output to quote. ' +
          (cause === 'runtime'
            ? 'Nothing is running, and calling fleet--launch again fails the same way until whoever runs this host ' +
              'fixes its child runtime, so ask them.'
            : cause === 'configuration'
              ? 'Nothing is running, and only whoever runs this host can change that value and restart the host, ' +
                'so ask them.'
              : 'Nothing is running; if fleet--restart fails the same way, ask whoever runs this host.'),
      };
    }
    const output = (): string => (startupLog ? startupLog.quote ?? quoteStartupOutput(startupLog) : '');
    if (this.stopping && this.detachMode) {
      return {
        success: false, isError: true,
        error: proc && (proc.exitCode !== null || proc.signalCode !== null)
          ? `${failed} and has exited, and this host is shutting down, so there is nothing to retry here.${output()}`
          : proc?.stdin && !proc.stdin.writableEnded
            // Never told to begin, it ends when this host's pipe to it closes.
            ? `${failed}: this host is shutting down before it told the child to begin, so the child ends with ` +
              'this host, having done nothing, and there is nothing to retry here.'
            : `${failed}: this host is shutting down and leaves it running for the next host to adopt, ` +
              'so there is nothing to retry here.',
      };
    }
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      // A natural nonzero exit may be pending even while ChildProcess still
      // exposes null exit fields.
      try { child.socket?.destroy(); } catch { }
      child.socket = null;
      try { proc.kill('SIGKILL'); } catch { }
      if (!await this.waitForExit(proc, 2_000)) {
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
      this.endGroupOf(child, proc.pid ?? null);
      child.exitedAt = Date.now();
      child.exitCode = proc.exitCode;
      child.status = proc.exitCode === 0 ? 'exited' : 'crashed';
      child.exitReason = withLaunchFailure(reason, exitText(proc.exitCode, proc.signalCode));
      this.persistState();
    } else if (proc && child.exitReason !== null && !child.exitReason.startsWith(reason)) {
      child.exitReason = withLaunchFailure(reason, child.exitReason);
      this.persistState();
    }
    const mayRetry = proc !== null && child.autoRestartStopped === undefined && this.retriesExit(child, proc.exitCode);
    const left = this.groupLeftNote(child);
    const nothing = left === undefined ? 'Nothing is running' : `${left} Otherwise nothing of it is running`;
    return {
      success: false, isError: true,
      error: `${failed} and has exited. ` +
        (this.stopping
          ? `${nothing}, and this host is shutting down, so there is nothing to retry here.`
          : mayRetry
            ? `${nothing} now, though its autoRestart may start it again by itself; fleet--kill for ` +
              `'${child.name}' stops that. Once the cause is fixed, call fleet--launch again.`
            : `${nothing}, so call fleet--launch again once the cause is fixed.`) +
        output(),
    };
  }

  private async killChild(child: FleetChild): Promise<void> {
    if (child.status === 'exited' || child.status === 'crashed') {
      await this.settleGroup(child);
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

    child.killRequested = true;

    const leaderThere = proc === null && child.socket !== null;
    if (child.socket) {
      try { this.sendToChild(child, { type: 'shutdown', graceful: true }); } catch { }
    }

    const waitExit = (ms: number): Promise<boolean> =>
      proc !== null ? this.waitForExit(proc, ms) : this.waitForExitByPid(pid!, ms);
    const sendSignal = (sig: NodeJS.Signals): void => {
      if (proc) { try { proc.kill(sig); } catch { } }
      else if (pid !== null) { try { process.kill(pid, sig); } catch { } }
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
      if (leaderThere) this.endGroupOf(child, pid);
      child.status = 'exited';
      child.exitedAt = Date.now();
      child.exitCode = null; // signal-0 cannot recover the adopted process's exit code.
      child.exitReason = 'shutdown requested; death confirmed (ESRCH)';
      child.socket?.destroy();
      child.socket = null;
      this.persistState();
    }
    await this.settleGroup(child);
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

function isUrlOrAbsolute(p: string): boolean {
  return p.startsWith('http://') || p.startsWith('https://') || isAbsolute(p);
}

function got(value: unknown): string {
  if (value === undefined) return 'none was given';
  if (value === '') return 'it got an empty string';
  if (value === null) return 'it got null';
  if (Array.isArray(value)) return value.length === 0 ? 'it got an empty list' : 'it got a list';
  return `it got ${typeof value === 'object' ? 'an object' : `the ${typeof value} ${JSON.stringify(value)}`}`;
}

function stoppedHow(c: FleetChild): string {
  if (c.exitReason !== null) return ` (${c.exitReason})`;
  return c.exitCode !== null ? ` (exit code ${c.exitCode})` : '';
}

function listed(names: string[]): string {
  return names.length === 0 ? 'none' : names.map((n) => `'${n}'`).join(', ');
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

type StartupLog = (
  | { path: string; offset: number; dev: bigint; ino: bigint }
  | { path: string; problem: string }
) & { quote?: string };

/**
 * One open, which doesn't wait for a FIFO's reader: a FIFO left at the path
 * would otherwise stop the host's event loop at the open.
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
  try { closeSync(fd); } catch { }
  return { fd: null, log: { path, problem: `${problem}, so the child's console output wasn't kept` } };
}

const STARTUP_QUOTE_LINES = 20;
const STARTUP_QUOTE_CHARS = 2_000;
const STARTUP_READ_BYTES = 64 * 1024;
const STARTUP_QUOTE_INDENT = '  ';

function errnoCode(err: unknown): string {
  return (err as NodeJS.ErrnoException | null)?.code ?? String(err);
}

/**
 * Another file at that path, such as one a link there names now, isn't the
 * file the child was given, which it goes on writing to through the
 * descriptor it inherited, so whatever it holds can't be told to be this
 * launch's output, and it isn't read.
 */
function quoteStartupOutput(log: StartupLog): string {
  if ('problem' in log) return `\n${log.path} ${log.problem}.`;
  let text = '';
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
    // tail then isn't one.
    unread = from > start;
  } catch (err) {
    return `\n${log.path} couldn't be read (${errnoCode(err)}), so the child's output isn't quoted.`;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { }
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
  // control characters but tab and newline: OpenTUI 0.1.107 writes a bell
  // or a backspace to the terminal as it is, and breaks the line at a
  // carriage return, so a progress line's pieces are joined. Each line is
  // stripped on its own: Bun.stripANSI drops everything after a sequence it
  // finds no end for, which would hide an error printed after a stray one.
  // A sequence that really spans lines, such as sixel graphics, leaves its
  // later lines as printable noise.
  let lines = text.split('\n')
    .map((line) => Bun.stripANSI(line).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''));
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === '') end--;
  lines = lines.slice(0, Math.max(end, 1));
  let cut = unread;
  if (lines.length > STARTUP_QUOTE_LINES) {
    lines = lines.slice(-STARTUP_QUOTE_LINES);
    cut = true;
  }
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

export interface ChildRowView {
  name: string;
  status: ChildStatus;
  pid: number | null;
  startedAt: number;
  events: ReadonlyArray<unknown>;
}

export function formatChildRow(c: ChildRowView, now: number = Date.now()): string {
  const elapsed = Math.floor((now - c.startedAt) / 1000);
  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  const timeStr = min > 0 ? `${min}m${sec}s` : `${sec}s`;
  return `${c.name.padEnd(16)} ${c.status.padEnd(10)} pid=${(c.pid ?? '-').toString().padEnd(7)} ${timeStr.padEnd(6)} events=${c.events.length}`;
}
