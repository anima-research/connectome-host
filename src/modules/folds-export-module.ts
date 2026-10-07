/**
 * folds.jsonl: a portable, labelled projection of the resident's fold
 * receipts (shelf-381; CONN-20's per-resident fold record).
 *
 * The context manager keeps the canonical journal (every branch, as rendered
 * when each receipt was written). This module projects the SELECTED branch's
 * receipts to one file, as an as-of snapshot: a header line naming the
 * branch, the store, the newest receipt and when it was written, then one
 * receipt per line, oldest first. It's rewritten (temp file, fsync, rename)
 * after each new receipt, when the module binds (startup), and when it stops
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
  /** Recorded in every receipt's source. */
  runtime: string;
  dataDir: string;
  agent: string;
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
  'A labelled as-of projection of the selected branch: rewritten after each new receipt, at startup and ' +
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

/** Write `content` to `path` durably: temp file, fsync, rename, fsync dir. */
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const fd = openSync(temp, 'w', 0o644);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw err;
  }
  try {
    const dirFd = openSync(dirname(path), 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch { /* directory fsync is not supported everywhere */ }
}

export class FoldsExportModule implements Module {
  readonly name = 'folds';
  private cm: ContextManager | null = null;
  private detach: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBranchKey: string | null = null;
  private lastError: string | null = null;
  private lastProjection: FoldsExportStatus['lastProjection'];
  private readonly target: string;
  private readonly ledgerPath: string;

  constructor(private readonly opts: FoldsExportOptions) {
    this.target = resolve(opts.target);
    this.ledgerPath = resolve(opts.ledgerPath);
  }

  /** Attach to the resident's context manager and write the startup projection. */
  bind(cm: ContextManager): void {
    this.cm = cm;
    cm.setReceiptSource({ runtime: this.opts.runtime, dataDirectory: resolve(this.opts.dataDir), agent: this.opts.agent });
    this.detach = cm.onFoldReceipt(() => this.project());
    this.project();
    this.timer = setInterval(() => this.checkBranch(), this.opts.checkIntervalMs ?? 1_000);
    this.timer.unref?.();
  }

  async start(_ctx: ModuleContext): Promise<void> {}

  /** Disposal: the final projection, then detach. Runs before the store closes. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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
    const entry = this.readLedger().targets[this.target];
    const state: FoldsExportStatus['state'] = !this.cm
      ? 'unbound'
      : entry?.conflict ? 'conflict' : this.lastError ? 'error' : 'exporting';
    return {
      target: this.target,
      state,
      ...(entry?.conflict ? { conflict: entry.conflict } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
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
      const stamp = this.now().toISOString().replace(/[:.]/g, '-');
      keptAs = `${this.target}.kept-${stamp}`;
      renameSync(this.target, keptAs);
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
    ledger.targets[this.target] = { ...(entry?.committed ? { committed: entry.committed } : {}), pending: hash };
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
