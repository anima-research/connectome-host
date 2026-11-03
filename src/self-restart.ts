import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** EX_TEMPFAIL: nonzero, so `Restart=on-failure` and a fleet parent's
 *  autoRestart (which retries nonzero exits only) restart it too. */
export const SELF_RESTART_EXIT_CODE = 75;
export const SELF_RESTART_FILE = 'self-restart.json';
export const SELF_RESTART_LAST_FILE = 'self-restart.last.json';

export interface SelfRestartRequest {
  requestedAt: string;
  reason: string;
  requestedBy?: string;
  pid: number;
  bootId: string;
  hostVersion?: string;
  exitedAt?: string;
  exitReason?: string;
  exitCode?: number;
}

export interface SelfRestartRecord extends SelfRestartRequest {
  backAt: string;
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
  readonly bootId: string;
  private headless = false;
  private armed: { dataDir: string; request: SelfRestartRequest } | null = null;

  constructor(bootId: string = randomUUID()) {
    this.bootId = bootId;
  }

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

  arm(dataDir: string, request: Omit<SelfRestartRequest, 'bootId' | 'pid'>): SelfRestartRequest {
    const full: SelfRestartRequest = { ...request, pid: process.pid, bootId: this.bootId };
    writeJsonAtomic(join(dataDir, SELF_RESTART_FILE), full);
    this.armed = { dataDir, request: full };
    return { ...full };
  }

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
    }
    this.armed = { ...this.armed, request };
  }

  takeCompleted(dataDir: string, now: Date = new Date()): SelfRestartRecord | null {
    const path = join(dataDir, SELF_RESTART_FILE);
    if (!existsSync(path)) return null;
    const request = readJson<SelfRestartRequest>(path);
    if (!request || typeof request !== 'object') {
      try { unlinkSync(path); } catch { }
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
    }
    return record;
  }

  lastCompleted(dataDir: string): SelfRestartRecord | null {
    return readJson<SelfRestartRecord>(join(dataDir, SELF_RESTART_LAST_FILE));
  }
}

export const selfRestart = new SelfRestartState();
