/**
 * Self-restart: an agent asks its own host to restart (`lifecycle--restart`,
 * src/modules/lifecycle-module.ts). The host exits with
 * SELF_RESTART_EXIT_CODE once the turn that asked has ended and nothing is
 * in flight: every agent idle, no turn, subagent run or background script
 * alive. Whatever supervises it starts it again: launchd KeepAlive, systemd
 * `Restart=`, a fleet parent's autoRestart. Only headless mode has that exit
 * path (runHeadless installs it), so the tool refuses anywhere else.
 *
 * The state here is per process, not per framework: a session switch
 * rebuilds the modules but keeps an armed request.
 *
 * Files in the data dir:
 * - `self-restart.json` — the pending request, written when it is armed and
 *   stamped with `exitedAt` as the host exits. The next process's lifecycle
 *   module reads it at start, tells the agent, and moves it to
 * - `self-restart.last.json` — the last completed self-restart, which the
 *   cooldown is measured from.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** EX_TEMPFAIL: nonzero, so `Restart=on-failure` and a fleet parent's
 *  autoRestart (which retries nonzero exits only) restart it too. */
export const SELF_RESTART_EXIT_CODE = 75;
export const SELF_RESTART_FILE = 'self-restart.json';
export const SELF_RESTART_LAST_FILE = 'self-restart.last.json';

/** A request, as `self-restart.json` holds it. */
export interface SelfRestartRequest {
  requestedAt: string;
  reason: string;
  /** The agent whose call armed it, when the call named one. */
  requestedBy?: string;
  pid: number;
  /** The process that armed it, so a later process knows the file isn't its own. */
  bootId: string;
  hostVersion?: string;
  /** Stamped as the host exits with the request armed. */
  exitedAt?: string;
  /** Why the host exited: `self-restart`, or another shutdown (`SIGTERM`, …)
   *  that came first. */
  exitReason?: string;
  exitCode?: number;
}

/** A completed self-restart, as `self-restart.last.json` holds it. */
export interface SelfRestartRecord extends SelfRestartRequest {
  backAt: string;
  /** Whether the previous process recorded its exit. */
  cleanExit: boolean;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export class SelfRestartState {
  /** Identifies this process across the files it writes. */
  readonly bootId: string;
  private headless = false;
  private armed: { dataDir: string; request: SelfRestartRequest } | null = null;

  constructor(bootId: string = randomUUID()) {
    this.bootId = bootId;
  }

  /** runHeadless calls this: the host now has an exit path a supervisor restarts. */
  attachHeadless(): void {
    this.headless = true;
  }

  isHeadless(): boolean {
    return this.headless;
  }

  isArmed(): boolean {
    return this.armed !== null;
  }

  armedRequest(): SelfRestartRequest | null {
    return this.armed ? { ...this.armed.request } : null;
  }

  /** Persist the request and arm the restart. */
  arm(dataDir: string, request: Omit<SelfRestartRequest, 'bootId' | 'pid'>): SelfRestartRequest {
    const full: SelfRestartRequest = { ...request, pid: process.pid, bootId: this.bootId };
    writeJsonAtomic(join(dataDir, SELF_RESTART_FILE), full);
    this.armed = { dataDir, request: full };
    return { ...full };
  }

  /** Disarm and remove the request. False when nothing was armed. Throws,
   *  still armed, when the request can't be removed: a file left behind
   *  would read as a completed restart at the next start. */
  cancel(): boolean {
    if (!this.armed) return false;
    try {
      unlinkSync(join(this.armed.dataDir, SELF_RESTART_FILE));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.armed = null;
    return true;
  }

  /**
   * The host is exiting: stamp the armed request (if any) with when and why,
   * so the next process can tell the agent. Called from every graceful
   * shutdown, not only the self-restart one, since another shutdown that
   * comes first ends the process the request was for.
   */
  recordExit(exitReason: string, exitCode: number, now: Date = new Date()): void {
    if (!this.armed) return;
    const request: SelfRestartRequest = {
      ...this.armed.request,
      exitedAt: now.toISOString(),
      exitReason,
      exitCode,
    };
    try {
      writeJsonAtomic(join(this.armed.dataDir, SELF_RESTART_FILE), request);
    } catch {
      // A request without exitedAt still tells the next process it was asked for.
    }
    this.armed = { ...this.armed, request };
  }

  /**
   * At start: a request left by an earlier process. Moves it to
   * `self-restart.last.json` stamped `backAt` and returns that record; null
   * when there is none, or when the file is this process's own (armed before
   * a session switch rebuilt the modules).
   */
  takeCompleted(dataDir: string, now: Date = new Date()): SelfRestartRecord | null {
    const path = join(dataDir, SELF_RESTART_FILE);
    if (!existsSync(path)) return null;
    const request = readJson<SelfRestartRequest>(path);
    if (!request || typeof request !== 'object') {
      try { unlinkSync(path); } catch { /* ignore */ }
      return null;
    }
    if (request.bootId === this.bootId) return null;
    const record: SelfRestartRecord = {
      ...request,
      backAt: now.toISOString(),
      cleanExit: typeof request.exitedAt === 'string',
    };
    try {
      writeJsonAtomic(join(dataDir, SELF_RESTART_LAST_FILE), record);
      unlinkSync(path);
    } catch {
      // Leave the request where it is; the agent is still told.
    }
    return record;
  }

  /** The last completed self-restart, or null. */
  lastCompleted(dataDir: string): SelfRestartRecord | null {
    return readJson<SelfRestartRecord>(join(dataDir, SELF_RESTART_LAST_FILE));
  }
}

/** The process's state: runHeadless attaches to it, the lifecycle module reads it. */
export const selfRestart = new SelfRestartState();
