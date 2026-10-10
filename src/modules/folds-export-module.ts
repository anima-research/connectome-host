/**
 * folds.jsonl: a portable, labelled projection of the resident's fold
 * receipts (shelf-381; CONN-20's per-resident fold record).
 *
 * The context manager keeps the canonical journal (every branch, as rendered
 * when each receipt was written). This module projects the SELECTED branch's
 * newest receipts to one file, as an as-of snapshot: a header line naming the
 * branch, the store, the newest receipt and the window's first, whether older
 * receipts were left out and when it was written, then one receipt per line,
 * oldest first. The file holds a window of the newest receipts
 * (PROJECTION_WINDOW), read as one page of the journal's query, which reads
 * only the receipts it returns. So a projection costs the window, not the
 * branch's whole history, which a long-lived resident would otherwise
 * rewrite and re-read in full after every fold. Older receipts stay in the
 * journal, where history--folds reads them. The file is rewritten (temp
 * file, fsync, rename) shortly after each new receipt (the next turn of the
 * event loop, off the round that accepted it), when the module binds
 * (startup), and when it stops (disposal, before the framework's store
 * closes). The selected branch is checked at roughly one-second intervals,
 * so a branch switch reaches the file at the next check, not at the switch
 * itself. A write that a conflict refuses, or one that fails, is tried again
 * at the next receipt, startup or takeover. `history--folds` reads the
 * journal directly and is the exact query; the host never reads this file
 * back as input.
 *
 * Writer safety. The host overwrites the target only when it is absent, or
 * when it holds one of the host's own projections: the one it last began
 * writing, or the one that write replaced. These are recorded in a
 * HOST-level ownership ledger keyed by target path (not in the store,
 * because `/session` switches stores and a per-store record would make the
 * host's own projection from another session look foreign). Before every
 * write the file on disk is hashed, and the write proceeds only if it is
 * absent or matches either recorded hash. Then the new projection's hash
 * (`latest`) is recorded durably beside the file it replaces (`previous`),
 * before the replace: a crash before or after the rename leaves a file the
 * host recognizes. At first use nothing is recorded before the check, so a
 * planned hash can never adopt someone else's file. Anything else is an
 * export conflict: the file is preserved untouched, export to that target
 * stops, and the conflict is reported (history--folds, /folds, stderr),
 * with how to resolve it. Only configuring another target, or an explicit
 * takeover (operator: `/folds takeover`; resident: the `take_over_export`
 * utility, offered once a conflict is found), resolves it; a takeover first
 * keeps the existing file beside the target under a timestamped name. The
 * check is not an atomic compare-and-swap: one writer per target is the
 * supported configuration.
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
  /** Hash of the projection the host last began writing, recorded durably before its replace. */
  latest?: string;
  /** Hash of the host's own file that write replaced, if one was there: what stays on disk if the replace didn't land. */
  previous?: string;
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
  /** In a conflict: how the resident, or the operator, takes the target over. */
  resolve?: string;
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
 * that cannot sync directories is tolerated). Its caller records the new
 * content's hash first, so a throw at any step leaves a file it recognizes.
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
  /** This session has found the target in conflict; kept until the host restarts. */
  private conflictFound = false;
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

  /**
   * The resident's takeover, offered once this session has found the target
   * in conflict. Unlike other modules' utilities, this list depends on the
   * export's state, not only on config. Agent-framework reads it for each
   * request (getAllUtilities, behind its `utils` meta-tool), so a recipe with
   * no other utility sends `utils` only from then on, and a conflict found at
   * startup is there from the first request. It stays offered after a
   * takeover, until the host restarts: a resident that saw it gets this
   * module's own answer ("No export conflict … nothing to take over"), not an
   * unknown name.
   */
  getUtilities(): ToolDefinition[] {
    return this.conflictFound ? [TAKE_OVER_UTILITY] : [];
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
      ...(entry?.conflict
        ? {
          conflict: entry.conflict,
          resolve: 'The file at the target is preserved. To export here again, take the target over, which keeps that file ' +
            `beside it under a timestamped name: utils with action "run" and name "${this.name}--${TAKE_OVER_UTILITY.name}", ` +
            "or the operator's /folds takeover. Configuring another target resumes export there instead.",
        }
        : {}),
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
      // The branch check compares against the branch last projected, whether
      // or not its write went through: a write refused by a conflict, or one
      // that failed, is tried again at the next receipt, startup or takeover,
      // not at every check.
      this.lastBranchKey = `${branch.id}@${branch.created}`;
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
      const content = `${JSON.stringify(header)}\n${body}${body ? '\n' : ''}`;
      // Not ours to write (an export conflict): status() and stderr report it.
      if (!this.write(content)) return null;
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

  /** The ownership protocol around one write. Returns false when it did not write. */
  private write(content: string): boolean {
    const ledger = this.readLedger();
    const entry = ledger.targets[this.target];
    if (entry?.conflict) {
      this.conflictFound = true;
      return false;
    }
    const onDisk = existsSync(this.target) ? sha256(readFileSync(this.target)) : null;
    if (onDisk !== null) {
      if (!entry) {
        this.recordConflict(ledger, 'a file already exists at the target, and this host has never written it', onDisk);
        return false;
      }
      if (onDisk !== entry.latest && onDisk !== entry.previous) {
        this.recordConflict(ledger, 'the file differs from the last projection this host wrote', onDisk);
        return false;
      }
    }
    // Record the new projection before replacing the file, beside the file it
    // replaces (just recognized as the host's own): whether or not the replace
    // lands, a crash or a failed rename included, what's on disk is one of the
    // two. Nothing is recorded after the replace.
    ledger.targets[this.target] = { latest: sha256(content), ...(onDisk ? { previous: onDisk } : {}) };
    this.writeLedger(ledger);
    atomicWrite(this.target, content);
    return true;
  }

  private recordConflict(ledger: OwnershipLedger, reason: string, foundHash: string): void {
    const entry = ledger.targets[this.target] ?? {};
    entry.conflict = { reason, at: this.now().toISOString(), foundHash };
    this.conflictFound = true;
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
