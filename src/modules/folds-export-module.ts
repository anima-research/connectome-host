/**
 * folds.jsonl: a portable, labelled projection of the resident's fold
 * receipts (shelf-381; CONN-20's per-resident fold record).
 *
 * The context manager keeps the canonical journal (every branch, as rendered
 * when each receipt was written). This module projects the SELECTED branch's
 * newest receipts to one file, as an as-of snapshot: a header line naming the
 * branch, the store, the newest receipt and the window's first, whether older
 * receipts were left out and when it was written, then one receipt per line,
 * oldest first. The file
 * holds a window of the newest receipts (PROJECTION_WINDOW), read as one page
 * of the journal's query, which reads only the receipts it returns. So a
 * projection costs the window, not the branch's whole history, which a
 * long-lived resident would otherwise rewrite and re-read in full after every
 * fold. Older receipts stay in the journal, where history--folds reads them. It's rewritten (temp file, fsync, rename)
 * shortly after each new receipt (the next turn of the event loop, off the
 * round that accepted it), when the module binds (startup), and when it stops
 * (disposal, before the framework's store closes). The selected branch is
 * checked at roughly one-second intervals, so a branch switch reaches the
 * file at the next check, not at the switch itself. `history--folds` reads
 * the journal directly and is the exact query; the host never reads this
 * file back as input.
 *
 * Writer safety. The host overwrites the target only when it is absent, or
 * when it is the host's own unchanged projection. What the host wrote is
 * recorded in a HOST-level ownership ledger keyed by target path (not in the
 * store, because `/session` switches stores and a per-store record would make
 * the host's own projection from another session look foreign). Before every
 * write the file on disk is hashed. The write proceeds only if the file is
 * absent, matches the last committed hash, or matches a hash recorded as
 * pending (the host's own write, interrupted before it committed). The
 * pending hash is recorded durably before the file is replaced, and committed
 * after the rename. At first use nothing is recorded before the check, so a
 * planned hash can never adopt someone else's file. Anything else is an
 * export conflict: the file is preserved untouched, export to that target
 * stops, and the conflict is reported (history--folds, /folds, stderr).
 * Only configuring another target, or an explicit takeover (operator:
 * `/folds takeover`; resident: the `take_over_export` utility), resolves it;
 * a takeover first keeps the existing file beside the target under a
 * timestamped name. The check is not an atomic compare-and-swap: one writer
 * per target is the supported configuration.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '@animalabs/agent-framework';
import { FOLD_QUERY_MAX_LIMIT, type ContextManager } from '@animalabs/context-manager';

export interface FoldsExportOptions {
  /** The projection's path. */
  target: string;
  /** The host-level ownership ledger (JSON), shared by every session. */
  ledgerPath: string;
  /** Branch-change check interval; roughly one second by default. */
  checkIntervalMs?: number;
  now?: () => Date;
}

/**
 * The exporter's paths for a recipe's `modules.foldsExport`, or null when it
 * is off: on by default at `<dataDir>/memory/folds.jsonl`, `{ path }` moves
 * the target, and the ownership ledger stays in the data directory.
 */
export function foldsExportPaths(
  config: boolean | { path?: string } | undefined,
  dataDir: string,
): Pick<FoldsExportOptions, 'target' | 'ledgerPath'> | null {
  if (config === false) return null;
  const path = typeof config === 'object' ? config.path : undefined;
  return {
    target: path ? resolve(path) : resolve(dataDir, 'memory', 'folds.jsonl'),
    ledgerPath: resolve(dataDir, 'folds-export-ownership.json'),
  };
}

interface OwnershipEntry {
  /** Hash of the last projection the host wrote and committed. */
  committed?: string;
  /** Hash of a projection being written: recorded before the replace. */
  pending?: string;
  /** Set when export to this target stopped to preserve a file. */
  conflict?: { reason: string; at: string; foundHash: string };
}

interface OwnershipLedger {
  v: 1;
  targets: Record<string, OwnershipEntry>;
}

export interface FoldsExportStatus {
  target: string;
  state: 'exporting' | 'conflict' | 'error' | 'unbound';
  conflict?: OwnershipEntry['conflict'];
  error?: string;
  lastProjection?: {
    at: string;
    branch: { id: string; name: string };
    latestReceiptId: string | null;
    /** Receipts in the file: at most PROJECTION_WINDOW. */
    receipts: number;
    /** Older receipts exist on the branch than the window holds; history--folds reads them. */
    more: boolean;
  };
  freshness: string;
}

/**
 * How many receipts the file holds: the selected branch's newest, one page of
 * the journal's query.
 */
export const PROJECTION_WINDOW = FOLD_QUERY_MAX_LIMIT;

const FRESHNESS =
  `A labelled as-of projection of the selected branch's newest ${PROJECTION_WINDOW} fold receipts: rewritten ` +
  'shortly after each new receipt, at startup and at shutdown, and checked for branch changes at roughly ' +
  'one-second intervals. When "more" is true, older receipts than firstReceiptId were left out of this file; ' +
  'they stay in the journal. history--folds reads the journal itself and is the exact query; with afterId "0" ' +
  'it pages through every receipt from the start.';

const TAKE_OVER_UTILITY: ToolDefinition = {
  name: 'take_over_export',
  description:
    'Resolve a folds.jsonl export conflict by taking the target over: the file found there is kept beside ' +
    'it under a timestamped name, and the host then writes its projection. Only for a target in conflict ' +
    '(see history--folds export status); the host never overwrites a file it did not write without this.',
  inputSchema: { type: 'object' as const, properties: {} },
};

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Errors meaning this platform can't fsync a directory, not that it failed. */
const DIR_SYNC_UNSUPPORTED = new Set(['EISDIR', 'EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);

/**
 * Write `content` to `path` durably: temp file written in full and fsynced,
 * renamed over the target, then the directory fsynced. Throws if any step
 * fails, including a directory sync that genuinely failed (only a platform
 * that cannot sync directories is tolerated). A caller that recorded intent
 * before calling must leave it pending on a throw.
 */
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const bytes = Buffer.from(content, 'utf8');
  const fd = openSync(temp, 'w', 0o644);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const n = writeSync(fd, bytes, offset, bytes.length - offset);
      if (n <= 0) throw new Error(`short write to ${temp}: ${offset} of ${bytes.length} bytes`);
      offset += n;
    }
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(temp, path);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw err;
  }
  syncDirectory(dirname(path));
}

/**
 * Make a directory's entries durable (a rename or link in it), where the
 * platform supports syncing a directory; any other failure throws.
 */
function syncDirectory(dir: string): void {
  let dirFd: number | null = null;
  try {
    dirFd = openSync(dir, 'r');
    fsyncSync(dirFd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!code || !DIR_SYNC_UNSUPPORTED.has(code)) throw err;
  } finally {
    if (dirFd !== null) closeSync(dirFd);
  }
}

/**
 * Move `path` aside to `<path>.kept-<stamp>` without ever overwriting an
 * earlier kept file: a hard link fails on an existing name (then a counter
 * is added). The original name is removed only after the kept name is
 * durable, its directory synced, so a crash can't persist the removal
 * without the link. If that sync fails, the new name is removed again (best
 * effort; one left behind is only a second name for the same file) and this
 * throws, with the file still at `path`: the takeover stops.
 */
function keepAside(path: string, stamp: string): string {
  for (let n = 0; ; n++) {
    const candidate = n === 0 ? `${path}.kept-${stamp}` : `${path}.kept-${stamp}-${n}`;
    try {
      linkSync(path, candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    try {
      syncDirectory(dirname(path));
    } catch (err) {
      try { unlinkSync(candidate); } catch { /* a second name for the same file */ }
      throw err;
    }
    unlinkSync(path);
    return candidate;
  }
}

/**
 * What a takeover did. `writeError`: the takeover stands (the conflict is
 * cleared, the existing file kept), but writing the projection then failed;
 * the next receipt or startup writes again.
 */
export type TakeOverResult =
  | { ok: true; keptAs: string | null; writeError?: string }
  | { ok: false; error: string; keptAs?: string };

export class FoldsExportModule implements Module {
  readonly name = 'folds';
  private cm: ContextManager | null = null;
  private detach: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBranchKey: string | null = null;
  /** A projection is scheduled for the next turn of the event loop. */
  private projectionPending = false;
  private lastError: string | null = null;
  private lastProjection: FoldsExportStatus['lastProjection'];
  private readonly target: string;
  private readonly ledgerPath: string;

  constructor(private readonly opts: FoldsExportOptions) {
    this.target = resolve(opts.target);
    this.ledgerPath = resolve(opts.ledgerPath);
  }

  /**
   * Attach to the resident's context manager and write the startup
   * projection. The receipts' source facts are the host's to set, whether or
   * not this export is enabled (index.ts), so binding doesn't touch them.
   */
  bind(cm: ContextManager): void {
    this.cm = cm;
    // The journal calls its listeners synchronously inside acceptRound, so a
    // projection run there would hold the round for a re-read of the branch's
    // record, a hash of the file and three durable writes. It's scheduled for
    // the next turn of the event loop instead, and receipts that arrive before
    // it runs share one projection. A crash in that gap is the case the startup
    // projection already heals.
    this.detach = cm.onFoldReceipt(() => this.scheduleProjection());
    this.project();
    this.timer = setInterval(() => this.checkBranch(), this.opts.checkIntervalMs ?? 1_000);
    this.timer.unref?.();
  }

  async start(_ctx: ModuleContext): Promise<void> {}

  /** Disposal: the final projection, then detach. Runs before the store closes. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Synchronous, so the last receipt reaches the file before the store
    // closes; a projection still scheduled finds the module unbound and does
    // nothing.
    if (this.cm) this.project();
    this.detach?.();
    this.detach = null;
    this.cm = null;
  }

  getTools(): ToolDefinition[] {
    return [];
  }

  getUtilities(): ToolDefinition[] {
    return [TAKE_OVER_UTILITY];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    if (call.name !== TAKE_OVER_UTILITY.name) {
      return { success: false, isError: true, error: `Unknown tool: ${call.name}` };
    }
    const result = this.takeOver('resident');
    return result.ok
      ? { success: true, data: result }
      : { success: false, isError: true, error: result.error };
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  status(): FoldsExportStatus {
    let entry: OwnershipEntry | undefined;
    let ledgerError: string | null = null;
    try {
      entry = this.readLedger().targets[this.target];
    } catch (err) {
      ledgerError = `ownership ledger unreadable: ${err instanceof Error ? err.message : String(err)}`;
    }
    const error = ledgerError ?? this.lastError;
    const state: FoldsExportStatus['state'] = !this.cm
      ? 'unbound'
      : entry?.conflict ? 'conflict' : error ? 'error' : 'exporting';
    return {
      target: this.target,
      state,
      ...(entry?.conflict ? { conflict: entry.conflict } : {}),
      ...(error ? { error } : {}),
      ...(this.lastProjection ? { lastProjection: this.lastProjection } : {}),
      freshness: FRESHNESS,
    };
  }

  /**
   * An explicit decision to take a conflicted target over: keep the file
   * found there beside it under a timestamped name, forget the conflict, and
   * write the projection.
   */
  takeOver(by: 'operator' | 'resident'): TakeOverResult {
    // File errors (a read-only directory, an unreadable ledger, a failed
    // sync) come back as a failure for the operator's command or the
    // resident's utility to report, never as a throw out of either.
    let keptAs: string | null = null;
    try {
      const ledger = this.readLedger();
      const entry = ledger.targets[this.target];
      if (!entry?.conflict) return { ok: false, error: `No export conflict at ${this.target}; nothing to take over.` };
      if (existsSync(this.target)) {
        keptAs = keepAside(this.target, this.now().toISOString().replace(/[:.]/g, '-'));
      }
      ledger.targets[this.target] = {};
      this.writeLedger(ledger);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Say where things stand. The ledger write can fail after its rename
      // landed (its directory sync), and then the conflict is already cleared.
      let conflict: string;
      try {
        conflict = this.readLedger().targets[this.target]?.conflict
          ? 'the conflict is still recorded'
          : 'the conflict was cleared, so the next projection writes to the target';
      } catch {
        conflict = "the ledger can't be read; /folds shows the export's state";
      }
      return {
        ok: false,
        error: `Taking over ${this.target} failed: ${message}. ` +
          (keptAs
            ? `The existing file was already kept as ${keptAs}`
            : existsSync(this.target) ? 'The file is still at the target' : 'Nothing is at the target') +
          `, and ${conflict}.`,
        ...(keptAs ? { keptAs } : {}),
      };
    }
    console.error(`[folds-export] ${by} took over ${this.target}${keptAs ? `; the existing file is kept as ${keptAs}` : ''}`);
    // The takeover stands; a projection that fails now is reported with it,
    // and the next receipt or startup writes again.
    const writeError = this.project();
    return { ok: true, keptAs, ...(writeError ? { writeError } : {}) };
  }

  // --------------------------------------------------------------------------

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** Coalesce: one projection per turn of the event loop, however many receipts arrived. */
  private scheduleProjection(): void {
    if (this.projectionPending) return;
    this.projectionPending = true;
    setImmediate(() => {
      this.projectionPending = false;
      this.project();
    });
  }

  private checkBranch(): void {
    if (!this.cm) return;
    const ref = this.cm.currentBranchRef();
    if (`${ref.id}@${ref.created}` !== this.lastBranchKey) this.project();
  }

  /**
   * Rewrite the projection if the target is ours to write. Never throws: a
   * failure is logged, kept for status(), and returned.
   */
  private project(): string | null {
    const cm = this.cm;
    if (!cm) return null;
    try {
      // The selected branch, and its newest receipts as one page (newest first,
      // reading only those): the window, written oldest first.
      const branch = cm.currentBranchRef();
      const page = cm.listFoldReceipts({ limit: PROJECTION_WINDOW });
      const receipts = [...page.receipts].reverse();
      const latestReceiptId = page.latestId;
      const at = this.now().toISOString();
      const header = {
        v: 1,
        kind: 'folds-projection',
        asOf: at,
        branch: { id: branch.id, name: branch.name, created: branch.created },
        storeId: cm.getStoreId(),
        latestReceiptId,
        firstReceiptId: receipts.length > 0 ? receipts[0]!.id : null,
        receipts: receipts.length,
        more: page.more,
        freshness: FRESHNESS,
      };
      const body = receipts.map((r) => JSON.stringify(r)).join('\n');
      // The header's asOf changes every write; ownership is decided on the
      // whole file, and an unchanged receipt list is not rewritten at all.
      if (this.lastProjection && this.lastBranchKey === `${branch.id}@${branch.created}`
        && this.lastProjection.latestReceiptId === latestReceiptId && this.lastProjection.receipts === receipts.length
        && this.ownsCurrentFile()) {
        return null;
      }
      const content = `${JSON.stringify(header)}\n${body}${body ? '\n' : ''}`;
      // Not ours to write (an export conflict): status() and stderr report it.
      if (!this.write(content)) return null;
      this.lastBranchKey = `${branch.id}@${branch.created}`;
      this.lastProjection = {
        at, branch: { id: branch.id, name: branch.name }, latestReceiptId, receipts: receipts.length, more: page.more,
      };
      this.lastError = null;
      return null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error(`[folds-export] projection to ${this.target} failed: ${this.lastError}`);
      return this.lastError;
    }
  }

  /** Whether the file on disk is still exactly what the host last committed. */
  private ownsCurrentFile(): boolean {
    const entry = this.readLedger().targets[this.target];
    if (!entry?.committed || !existsSync(this.target)) return false;
    return sha256(readFileSync(this.target)) === entry.committed;
  }

  /** The ownership protocol around one write. Returns false when it did not write. */
  private write(content: string): boolean {
    const ledger = this.readLedger();
    const entry = ledger.targets[this.target];
    if (entry?.conflict) return false;
    const onDisk = existsSync(this.target) ? sha256(readFileSync(this.target)) : null;
    if (onDisk !== null) {
      if (!entry) {
        this.recordConflict(ledger, 'a file already exists at the target, and this host has never written it', onDisk);
        return false;
      }
      if (onDisk !== entry.committed && onDisk !== entry.pending) {
        this.recordConflict(ledger, 'the file differs from the last projection this host wrote', onDisk);
        return false;
      }
    }
    const hash = sha256(content);
    if (onDisk === hash) {
      ledger.targets[this.target] = { committed: hash };
      if (entry?.committed !== hash || entry.pending !== undefined) this.writeLedger(ledger);
      return true;
    }
    // The file on disk, when present, has just been recognized as ours (the
    // committed projection, or a pending one whose replace landed): it is the
    // recovery base. Keeping it as `committed` means a further interrupted
    // attempt still leaves the file recognizable, instead of a false conflict.
    const base = onDisk ?? entry?.committed;
    ledger.targets[this.target] = { ...(base ? { committed: base } : {}), pending: hash };
    this.writeLedger(ledger);
    atomicWrite(this.target, content);
    ledger.targets[this.target] = { committed: hash };
    this.writeLedger(ledger);
    return true;
  }

  private recordConflict(ledger: OwnershipLedger, reason: string, foundHash: string): void {
    const entry = ledger.targets[this.target] ?? {};
    entry.conflict = { reason, at: this.now().toISOString(), foundHash };
    delete entry.pending;
    ledger.targets[this.target] = entry;
    this.writeLedger(ledger);
    console.error(
      `[folds-export] EXPORT CONFLICT at ${this.target}: ${reason}. The file is preserved untouched and ` +
      'export to it has stopped. Configure another target, or take it over explicitly (/folds takeover, or ' +
      'the take_over_export utility), which keeps the existing file beside it.',
    );
  }

  private readLedger(): OwnershipLedger {
    if (!existsSync(this.ledgerPath)) return { v: 1, targets: {} };
    const parsed = JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as OwnershipLedger;
    if (parsed.v !== 1 || typeof parsed.targets !== 'object' || parsed.targets === null) {
      throw new Error(`unrecognized folds export ownership ledger at ${this.ledgerPath}`);
    }
    return parsed;
  }

  private writeLedger(ledger: OwnershipLedger): void {
    atomicWrite(this.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  }
}
