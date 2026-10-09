/**
 * folds.jsonl: a portable, labelled projection of the resident's fold
 * receipts (shelf-381; CONN-20's per-resident fold record).
 *
 * The context manager keeps the canonical journal (every branch, as rendered
 * when each receipt was written). This module projects the SELECTED branch's
 * receipts to one file, as an as-of snapshot: a header line naming the
 * branch, the store, the newest receipt and when it was written, then one
 * receipt per line, oldest first. It's rewritten (temp file, fsync, rename)
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
import type { ContextManager, FoldReceipt } from '@animalabs/context-manager';

export interface FoldsExportOptions {
  /** The projection's path. */
  target: string;
  /** The host-level ownership ledger (JSON), shared by every session. */
  ledgerPath: string;
  /** Branch-change check interval; roughly one second by default. */
  checkIntervalMs?: number;
  now?: () => Date;
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
  lastProjection?: { at: string; branch: { id: string; name: string }; latestReceiptId: string | null; receipts: number };
  freshness: string;
}

const FRESHNESS =
  'A labelled as-of projection of the selected branch: rewritten shortly after each new receipt, at startup and ' +
  'at shutdown, and checked for branch changes at roughly one-second intervals. history--folds reads the ' +
  'journal itself and is the exact query.';

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
  let dirFd: number | null = null;
  try {
    dirFd = openSync(dirname(path), 'r');
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
 * is added), and only after the link exists is the original name removed.
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
    unlinkSync(path);
    return candidate;
  }
}

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
  takeOver(by: 'operator' | 'resident'): { ok: true; keptAs: string | null } | { ok: false; error: string } {
    const ledger = this.readLedger();
    const entry = ledger.targets[this.target];
    if (!entry?.conflict) return { ok: false, error: `No export conflict at ${this.target}; nothing to take over.` };
    let keptAs: string | null = null;
    if (existsSync(this.target)) {
      keptAs = keepAside(this.target, this.now().toISOString().replace(/[:.]/g, '-'));
    }
    ledger.targets[this.target] = {};
    this.writeLedger(ledger);
    console.error(`[folds-export] ${by} took over ${this.target}${keptAs ? `; the existing file is kept as ${keptAs}` : ''}`);
    this.project();
    return { ok: true, keptAs };
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

  /** Rewrite the projection if the target is ours to write. Never throws. */
  private project(): void {
    const cm = this.cm;
    if (!cm) return;
    try {
      const branch = cm.currentBranchRef();
      const receipts: FoldReceipt[] = cm.foldReceiptsFor(branch);
      const latestReceiptId = receipts.length > 0 ? receipts[receipts.length - 1]!.id : null;
      const at = this.now().toISOString();
      const header = {
        v: 1,
        kind: 'folds-projection',
        asOf: at,
        branch: { id: branch.id, name: branch.name, created: branch.created },
        storeId: cm.getStoreId(),
        latestReceiptId,
        receipts: receipts.length,
        freshness: FRESHNESS,
      };
      const body = receipts.map((r) => JSON.stringify(r)).join('\n');
      // The header's asOf changes every write; ownership is decided on the
      // whole file, and an unchanged receipt list is not rewritten at all.
      if (this.lastProjection && this.lastBranchKey === `${branch.id}@${branch.created}`
        && this.lastProjection.latestReceiptId === latestReceiptId && this.lastProjection.receipts === receipts.length
        && this.ownsCurrentFile()) {
        return;
      }
      const content = `${JSON.stringify(header)}\n${body}${body ? '\n' : ''}`;
      if (!this.write(content)) return;
      this.lastBranchKey = `${branch.id}@${branch.created}`;
      this.lastProjection = { at, branch: { id: branch.id, name: branch.name }, latestReceiptId, receipts: receipts.length };
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error(`[folds-export] projection to ${this.target} failed: ${this.lastError}`);
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
