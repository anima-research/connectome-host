/**
 * folds.jsonl (FoldsExportModule): a labelled as-of projection of the selected
 * branch's fold receipts, and the host-level ownership ledger that keeps the
 * host from overwriting a file it did not write.
 *
 * Receipts come from a real ContextManager with a scripted strategy whose
 * rendered layout each test controls, accepted through the public API.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ContextManager } from '@animalabs/context-manager';
import { JsStore } from '@animalabs/chronicle';
import type {
  ContextEntry,
  ContextLogView,
  ContextStrategy,
  MessageStoreView,
  ReadinessState,
  RenderedSummaryInfo,
  TokenBudget,
} from '@animalabs/context-manager';
import {
  FoldsExportModule,
  PROJECTION_WINDOW,
  type FoldsExportStatus,
  type TakeOverResult,
} from '../src/modules/folds-export-module.js';

const BUDGET: TokenBudget = { maxTokens: 1_000_000, reserveForResponse: 0 };

/** Renders each message raw unless the plan omits it. */
class PlanStrategy implements ContextStrategy {
  readonly name = 'plan';
  readonly renderedForms = ['raw', 'omitted'] as const;
  omit = new Set<string>();
  checkReadiness(): ReadinessState { return { ready: true }; }
  select(store: MessageStoreView, _log: ContextLogView, _budget: TokenBudget): ContextEntry[] {
    return store.getAll()
      .filter((m) => !this.omit.has(m.id))
      .map((m, index) => ({ index, sourceMessageId: m.id, sourceRelation: 'copy' as const, participant: m.participant, content: m.content }));
  }
  describeRenderedSummaries(): ReadonlyMap<string, RenderedSummaryInfo> { return new Map(); }
}

let dir: string;
let dataDir: string;
let target: string;
let ledgerPath: string;
const opened: ContextManager[] = [];
const modules: FoldsExportModule[] = [];

async function openStore(name = 'store'): Promise<{ cm: ContextManager; strategy: PlanStrategy }> {
  const strategy = new PlanStrategy();
  const cm = await ContextManager.open({ path: join(dir, name), strategy, namespace: 'agents/linn' });
  // What the host sets in createFramework, independently of the exporter.
  cm.setReceiptSource({ runtime: 'connectome-host', dataDirectory: dataDir, agent: 'linn' });
  opened.push(cm);
  return { cm, strategy };
}

/** One turn of the event loop: the projection a receipt schedules has run. */
const projected = () => new Promise<void>((r) => setImmediate(r));

/** Accept a compile; its receipt's projection runs on the next turn, which this awaits. */
async function accept(cm: ContextManager): Promise<void> {
  const result = await cm.compile(BUDGET);
  cm.acceptRound({ provenance: result.provenance! });
  await projected();
}

function exporter(path = target, checkIntervalMs = 20): FoldsExportModule {
  const m = new FoldsExportModule({ target: path, ledgerPath, checkIntervalMs });
  modules.push(m);
  return m;
}

function lines(path = target): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
}

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** What `fn` writes to stderr (console.error), one entry per call. */
async function stderrOf(fn: () => unknown): Promise<string[]> {
  const written: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { written.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.error = error;
  }
  return written;
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'folds-export-'));
  dataDir = join(dir, 'data');
  target = join(dataDir, 'memory', 'folds.jsonl');
  ledgerPath = join(dataDir, 'folds-export-ownership.json');
});

afterEach(async () => {
  for (const m of modules.splice(0)) await m.stop();
  for (const cm of opened.splice(0)) { try { cm.close(); } catch { /* closed */ } }
  rmSync(dir, { recursive: true, force: true });
});

describe('folds.jsonl projection', () => {
  test('writes a labelled as-of snapshot at startup and after each new receipt', async () => {
    const { cm, strategy } = await openStore();
    const ids = [cm.addMessage('user', [{ type: 'text', text: 'one' }]), cm.addMessage('user', [{ type: 'text', text: 'two' }])];
    const m = exporter();
    m.bind(cm);
    let file = lines();
    expect(file[0]!.kind).toBe('folds-projection');
    expect(file[0]!.receipts).toBe(0);
    expect(file[0]!.storeId).toBe(cm.getStoreId());
    expect(String(file[0]!.freshness)).toContain('roughly one-second intervals');

    await accept(cm); // baseline
    strategy.omit.add(ids[0]!);
    await accept(cm); // raw -> omitted
    file = lines();
    expect(file[0]!.receipts).toBe(2);
    expect(file.slice(1).map((r) => r.kind)).toEqual(['baseline', 'change']);
    expect(file[0]!.latestReceiptId).toBe(file[2]!.id);
    expect(file[0]!.firstReceiptId).toBe(file[1]!.id);
    expect(file[0]!.more).toBe(false);
    const source = file[1]!.source as Record<string, unknown>;
    expect(source.runtime).toBe('connectome-host');
    expect(source.agent).toBe('linn');
    expect(m.status().state).toBe('exporting');
  });

  test('follows a branch switch at the next check, while other branches stay in the journal', async () => {
    const { cm } = await openStore();
    cm.addMessage('user', [{ type: 'text', text: 'hello' }]);
    await accept(cm);
    const main = cm.currentBranchRef();
    await cm.fork('side');
    const m = exporter();
    m.bind(cm);
    expect((lines()[0]!.branch as { name: string }).name).toBe('side');
    expect(lines()[0]!.receipts).toBe(0);
    await cm.switchBranch(main.name);
    await waitFor(() => (lines()[0]!.branch as { name: string }).name === main.name, 'projection follows the switch');
    expect(lines()[0]!.receipts).toBe(1);
    expect(cm.listFoldReceipts({ branch: 'side' }).branch?.name).toBe('side');
  });

  test('follows a switch between two branches that have no receipts', async () => {
    const { cm } = await openStore();
    cm.addMessage('user', [{ type: 'text', text: 'hello' }]);
    const m = exporter();
    m.bind(cm);
    const first = (lines()[0]!.branch as { name: string }).name;
    await cm.fork('quiet');
    await waitFor(() => (lines()[0]!.branch as { name: string }).name === 'quiet', 'projection follows the switch');
    expect(lines()[0]!.receipts).toBe(0);
    expect(lines()[0]!.latestReceiptId).toBeNull();
    expect(first).not.toBe('quiet');
  });

  test('projects off the round that accepted the receipt, once per turn however many receipts arrive', async () => {
    const { cm, strategy } = await openStore();
    const ids = ['one', 'two', 'three'].map((t) => cm.addMessage('user', [{ type: 'text', text: t }]));
    const m = exporter();
    m.bind(cm);
    const before = sha(target);
    let projections = 0;
    const query = cm.listFoldReceipts.bind(cm);
    cm.listFoldReceipts = (q) => { projections++; return query(q); };
    const first = await cm.compile(BUDGET);
    cm.acceptRound({ provenance: first.provenance! }); // baseline
    strategy.omit.add(ids[0]!);
    const second = await cm.compile(BUDGET);
    cm.acceptRound({ provenance: second.provenance! }); // a change, before the loop turns
    expect(sha(target)).toBe(before);
    await projected();
    expect(projections).toBe(1);
    expect(lines()[0]!.receipts).toBe(2);
    expect(lines().slice(1).map((r) => r.kind)).toEqual(['baseline', 'change']);
  });

  test('holds the newest window of receipts, says older ones were left out, and leaves them in the journal', async () => {
    const { cm, strategy } = await openStore();
    const id = cm.addMessage('user', [{ type: 'text', text: 'hello' }]);
    cm.addMessage('user', [{ type: 'text', text: 'world' }]);
    const m = exporter();
    m.bind(cm);
    // A baseline, then a change on every round: a full window first.
    const round = async (i: number) => {
      if (i > 0) {
        if (strategy.omit.has(id)) strategy.omit.delete(id);
        else strategy.omit.add(id);
      }
      const result = await cm.compile(BUDGET);
      cm.acceptRound({ provenance: result.provenance! });
    };
    for (let i = 0; i < PROJECTION_WINDOW; i++) await round(i);
    await projected();
    const full = lines();
    expect(full[0]!.receipts).toBe(PROJECTION_WINDOW);
    expect(full[0]!.more).toBe(false);
    // One receipt more than the window, projected on its own: the count stays
    // the same, and the file still moves to the newest receipt.
    await round(PROJECTION_WINDOW);
    await projected();
    const all: string[] = [];
    for (let after = '0'; ;) {
      const page = cm.listFoldReceipts({ afterId: after, limit: 100 });
      all.push(...page.receipts.map((r) => r.id));
      if (!page.more) break;
      after = page.receipts[page.receipts.length - 1]!.id;
    }
    expect(all).toHaveLength(PROJECTION_WINDOW + 1);
    const file = lines();
    expect(file[0]!.receipts).toBe(PROJECTION_WINDOW);
    expect(file[0]!.more).toBe(true);
    expect(file.slice(1).map((r) => r.id)).toEqual(all.slice(1));
    expect(file[0]!.firstReceiptId).toBe(all[1]);
    expect(file[0]!.latestReceiptId).toBe(all[all.length - 1]);
    expect(String(file[0]!.freshness)).toContain('afterId "0"');
    expect(m.status().lastProjection?.more).toBe(true);
  }, 60_000); // a hundred and one durable acceptances

  test('stopping writes a receipt accepted in the same turn, before the store closes', async () => {
    const { cm } = await openStore();
    cm.addMessage('user', [{ type: 'text', text: 'hello' }]);
    const m = exporter();
    m.bind(cm);
    const compiled = await cm.compile(BUDGET);
    cm.acceptRound({ provenance: compiled.provenance! }); // its projection waits for the next turn
    await m.stop(); // ...which finds the module stopped; stopping wrote it already
    expect(lines()[0]!.receipts).toBe(1);
  });

  test('status is unbound before binding and after stopping', async () => {
    const { cm } = await openStore();
    const m = exporter();
    expect(m.status().state).toBe('unbound');
    m.bind(cm);
    expect(m.status().state).toBe('exporting');
    await m.stop();
    expect(m.status().state).toBe('unbound');
  });

  test('heals a crash between a receipt and its projection at the next startup', async () => {
    const { cm } = await openStore();
    cm.addMessage('user', [{ type: 'text', text: 'hello' }]);
    exporter().bind(cm);
    await modules[0]!.stop();
    await accept(cm); // the receipt lands while no projection is written
    expect(lines()[0]!.receipts).toBe(0);
    exporter().bind(cm);
    expect(lines()[0]!.receipts).toBe(1);
  });

  test('converges on a receipt whose commit landed but reported failure, once it is recovered', async () => {
    let landThenThrow = false;
    const real = JsStore.openOrCreate({ path: join(dir, 'flaky-store') });
    const flaky = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'appendJson') {
          return (type: string, payload: unknown) => {
            const written = target.appendJson(type, payload);
            if (landThenThrow && type === 'context-manager/accepted-layout') {
              landThenThrow = false;
              throw new Error('write reported failure after landing');
            }
            return written;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as JsStore;
    const strategy = new PlanStrategy();
    const cm = await ContextManager.open({ store: flaky, strategy, namespace: 'agents/linn' });
    opened.push(cm);
    cm.addMessage('user', [{ type: 'text', text: 'hello' }]);
    const m = exporter();
    m.bind(cm);
    const compiled = await cm.compile(BUDGET);
    landThenThrow = true;
    expect(() => cm.acceptRound({ provenance: compiled.provenance! })).toThrow(/after landing/);
    expect(lines()[0]!.receipts).toBe(0);
    // The stream retries acceptance at its next round: the record is found, and announced.
    cm.acceptRound({ provenance: compiled.provenance! });
    await projected();
    expect(lines()[0]!.receipts).toBe(1);
    expect(lines()[1]!.kind).toBe('baseline');
  });

  test('adopts its own interrupted write (crash between rename and the ledger commit)', async () => {
    const { cm } = await openStore();
    cm.addMessage('user', [{ type: 'text', text: 'hello' }]);
    const m = exporter();
    m.bind(cm);
    await m.stop();
    // Simulate: the next projection was renamed into place, but the ledger
    // still shows it as pending, never committed.
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    const entry = ledger.targets[Object.keys(ledger.targets)[0]!];
    writeFileSync(target, `${readFileSync(target, 'utf8')}{"id":"ours-in-flight"}\n`);
    ledger.targets[Object.keys(ledger.targets)[0]!] = { committed: entry.committed, pending: sha(target) };
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    await accept(cm);
    exporter().bind(cm);
    expect(modules[1]!.status().state).toBe('exporting');
    expect(lines()[0]!.receipts).toBe(1);
  });
});

describe('writer safety', () => {
  test('a crash between the replace and the ledger commit leaves the file recognized at the next startup', async () => {
    const { cm, strategy } = await openStore();
    const id = cm.addMessage('user', [{ type: 'text', text: 'hello' }]);
    const m = exporter();
    m.bind(cm);
    await accept(cm);
    // From here on the host "dies" after each replace: every commit is
    // refused, and only what was recorded before the replace is on disk.
    const internals = m as unknown as { writeLedger(ledger: { targets: Record<string, { pending?: string }> }): void };
    const writeLedger = internals.writeLedger.bind(m);
    internals.writeLedger = (ledger) => {
      if (!ledger.targets[target]?.pending) throw new Error('the host died before the commit (simulated)');
      writeLedger(ledger);
    };
    strategy.omit.add(id);
    await accept(cm);
    expect(lines()[0]!.receipts).toBe(2); // the replace landed
    await m.stop();
    const next = exporter();
    next.bind(cm);
    expect(next.status().state).toBe('exporting');
    expect(lines()[0]!.receipts).toBe(2);
  });

  test('an older projection of the host\'s own, put back, is a conflict: only the last one written is recognized', async () => {
    const { cm, strategy } = await openStore();
    const id = cm.addMessage('user', [{ type: 'text', text: 'hello' }]);
    const m = exporter();
    m.bind(cm);
    await accept(cm);
    const older = readFileSync(target);
    strategy.omit.add(id);
    await accept(cm);
    writeFileSync(target, older); // say, restored from a backup
    strategy.omit.delete(id);
    await accept(cm);
    expect(readFileSync(target).equals(older)).toBe(true);
    expect(m.status().state).toBe('conflict');
  });

  test('an ownership ledger it doesn\'t recognize stops the export, and status reports it instead of throwing', async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify({ v: 2, targets: {} }));
    const { cm } = await openStore();
    const m = exporter();
    m.bind(cm);
    expect(existsSync(target)).toBe(false);
    const status = m.status();
    expect(status.state).toBe('error');
    expect(status.error).toContain('unrecognized folds export ownership ledger');
  });

  test('recovers its own file across two interrupted replacements without a false conflict', async () => {
    const { cm, strategy } = await openStore();
    const ids = [cm.addMessage('user', [{ type: 'text', text: 'one' }]), cm.addMessage('user', [{ type: 'text', text: 'two' }])];
    const m = exporter();
    m.bind(cm);
    await accept(cm); // committed: A (with the baseline)
    // First interruption: our replacement B landed on disk, but its commit did not.
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    const key = Object.keys(ledger.targets)[0]!;
    writeFileSync(target, `${readFileSync(target, 'utf8')}{"id":"ours-b"}\n`);
    ledger.targets[key] = { committed: ledger.targets[key].committed, pending: sha(target) };
    writeFileSync(ledgerPath, JSON.stringify(ledger));
    // Second interruption: the next intent is recorded, then the replace fails.
    const { chmodSync } = await import('node:fs');
    chmodSync(dirname(target), 0o555);
    strategy.omit.add(ids[0]!);
    try {
      await accept(cm);
    } finally {
      chmodSync(dirname(target), 0o755);
    }
    expect(m.status().state).toBe('error');
    // Recovery: the file is still recognized as ours.
    strategy.omit.add(ids[1]!);
    await accept(cm);
    expect(m.status().state).toBe('exporting');
    expect(lines()[0]!.receipts).toBe(3);
  });

  test('preserves a foreign file found at first use, and resumes after a new target or an explicit takeover', async () => {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '{"written":"by another runtime"}\n');
    const before = sha(target);
    const { cm } = await openStore();
    cm.addMessage('user', [{ type: 'text', text: 'hello' }]);
    const m = exporter();
    const conflictLog = await stderrOf(async () => {
      m.bind(cm);
      await accept(cm);
    });
    expect(sha(target)).toBe(before);
    const status = m.status();
    expect(status.state).toBe('conflict');
    expect(status.target).toBe(target);
    expect(status.conflict?.reason).toContain('never written');
    // What the resident reads in history--folds: how to take it over.
    expect(status.resolve).toContain('utils with action "run" and name "folds--take_over_export"');
    expect(status.resolve).toContain("the operator's /folds takeover");
    expect(conflictLog).toHaveLength(1);
    expect(conflictLog[0]).toStartWith(
      `[folds-export] EXPORT CONFLICT at ${target}: a file already exists at the target, and this host has never written it. ` +
      'The file is preserved untouched and export to it has stopped.',
    );

    // Another target resumes export there; the conflicted file stays untouched.
    const other = join(dataDir, 'memory', 'folds-elsewhere.jsonl');
    exporter(other).bind(cm);
    expect(lines(other)[0]!.receipts).toBe(1);
    expect(sha(target)).toBe(before);

    // An explicit takeover keeps the existing file beside the target.
    let result!: TakeOverResult;
    const takeoverLog = await stderrOf(() => { result = m.takeOver('operator'); });
    expect(result.ok).toBe(true);
    const kept = readdirSync(dirname(target)).filter((f) => f.startsWith('folds.jsonl.kept-'));
    expect(kept.length).toBe(1);
    expect(takeoverLog).toEqual([`[folds-export] operator took over ${target}; the existing file is kept as ${join(dirname(target), kept[0]!)}`]);
    expect(readFileSync(join(dirname(target), kept[0]!), 'utf8')).toContain('by another runtime');
    expect(lines()[0]!.kind).toBe('folds-projection');
    expect(m.status().state).toBe('exporting');
    expect(m.status().resolve).toBeUndefined();
  });

  /** A conflicted target: a foreign file found at first use. */
  async function conflicted(): Promise<{ cm: ContextManager; strategy: PlanStrategy; id: string; m: FoldsExportModule; before: string }> {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '{"written":"by another runtime"}\n');
    const before = sha(target);
    const { cm, strategy } = await openStore();
    const id = cm.addMessage('user', [{ type: 'text', text: 'hello' }]);
    const m = exporter();
    m.bind(cm);
    await accept(cm);
    expect(m.status().state).toBe('conflict');
    return { cm, strategy, id, m, before };
  }

  // Directory permissions don't bind root, so these run unprivileged only.
  const unprivileged = process.getuid?.() !== 0;

  test.skipIf(!unprivileged)('a takeover that cannot move the file reports a failure instead of throwing, and moves nothing', async () => {
    const { m, before } = await conflicted();
    chmodSync(dirname(target), 0o555); // read-only: the kept link can't be made
    let result: ReturnType<FoldsExportModule['takeOver']>;
    try {
      result = m.takeOver('operator');
    } finally {
      chmodSync(dirname(target), 0o755);
    }
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('still at the target');
      expect(result.error).toContain('the conflict is still recorded');
      expect(result.keptAs).toBeUndefined();
    }
    expect(sha(target)).toBe(before);
    expect(readdirSync(dirname(target)).filter((f) => f.includes('.kept-'))).toEqual([]);
    expect(m.status().state).toBe('conflict');
  });

  test.skipIf(!unprivileged)('a takeover removes the original name only after the kept name is synced, and stops if it cannot be', async () => {
    const { m, before } = await conflicted();
    // Writable and searchable but unreadable: the kept link can be made, but
    // the directory can't be opened to sync it.
    chmodSync(dirname(target), 0o333);
    let result: ReturnType<FoldsExportModule['takeOver']>;
    try {
      result = m.takeOver('operator');
    } finally {
      chmodSync(dirname(target), 0o755);
    }
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('still at the target');
      expect(result.keptAs).toBeUndefined();
    }
    // The new name was removed again: the file is where it was, under its one
    // name, and the conflict stands for a later takeover.
    expect(readdirSync(dirname(target)).filter((f) => f.includes('.kept-'))).toEqual([]);
    expect(sha(target)).toBe(before);
    expect(m.status().state).toBe('conflict');
    // Once the directory can be synced, the takeover goes through.
    const again = m.takeOver('operator');
    expect(again.ok).toBe(true);
    expect(m.status().state).toBe('exporting');
  });

  test.skipIf(!unprivileged)('a takeover whose ledger write lands but fails its sync says the conflict was cleared', async () => {
    const { cm, strategy, id, m } = await conflicted();
    // The data directory is writable and searchable but unreadable: the
    // ledger's rename lands, then its directory sync fails.
    chmodSync(dataDir, 0o333);
    let result: ReturnType<FoldsExportModule['takeOver']>;
    try {
      result = m.takeOver('operator');
    } finally {
      chmodSync(dataDir, 0o755);
    }
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.keptAs).toBeDefined();
      expect(result.error).toContain(`The existing file was already kept as ${result.keptAs}`);
      expect(result.error).toContain('the conflict was cleared');
    }
    expect(m.status().state).not.toBe('conflict');
    // The next receipt writes to the target.
    strategy.omit.add(id);
    await accept(cm);
    expect(lines()[0]!.kind).toBe('folds-projection');
  });

  test('a takeover after the conflicted file was removed keeps nothing aside and resumes export', async () => {
    const { m } = await conflicted();
    rmSync(target);
    expect(m.takeOver('operator')).toEqual({ ok: true, keptAs: null });
    expect(readdirSync(dirname(target)).filter((f) => f.includes('.kept-'))).toEqual([]);
    expect(lines()[0]!.kind).toBe('folds-projection');
    expect(m.status().state).toBe('exporting');
  });

  test.skipIf(!unprivileged)('a failed takeover after the conflicted file was removed says nothing is at the target', async () => {
    const { m } = await conflicted();
    rmSync(target);
    chmodSync(dataDir, 0o333); // the ledger's rename lands, then its sync fails
    let result!: TakeOverResult;
    try {
      result = m.takeOver('operator');
    } finally {
      chmodSync(dataDir, 0o755);
    }
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.keptAs).toBeUndefined();
      expect(result.error).toContain('Nothing is at the target');
    }
  });

  test.skipIf(!unprivileged)('a takeover whose ledger can\'t be read fails and points to /folds, and status reports the ledger', async () => {
    const { m, before } = await conflicted();
    chmodSync(ledgerPath, 0o000);
    let result!: TakeOverResult;
    let status!: FoldsExportStatus;
    try {
      result = m.takeOver('operator');
      status = m.status();
    } finally {
      chmodSync(ledgerPath, 0o644);
    }
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('The file is still at the target');
      expect(result.error).toContain("the ledger can't be read; /folds shows the export's state");
    }
    expect(status.state).toBe('error');
    expect(status.error).toContain('ownership ledger unreadable');
    expect(sha(target)).toBe(before);
  });

  test('a target in conflict is not projected again at every branch check, only at a branch change', async () => {
    const { cm, m } = await conflicted();
    let projections = 0;
    const query = cm.listFoldReceipts.bind(cm);
    cm.listFoldReceipts = (q) => { projections++; return query(q); };
    await new Promise((r) => setTimeout(r, 200)); // about ten checks at 20 ms
    expect(projections).toBe(0);
    expect(m.status().state).toBe('conflict');
    await cm.fork('side'); // still followed, and still refused
    await waitFor(() => projections === 1, 'the branch check follows the switch');
    await new Promise((r) => setTimeout(r, 100));
    expect(projections).toBe(1);
    expect(m.status().state).toBe('conflict');
  });

  test.skipIf(!unprivileged)('a target that cannot be written is tried again at the next receipt, not at every branch check', async () => {
    const { cm } = await openStore();
    cm.addMessage('user', [{ type: 'text', text: 'hello' }]);
    mkdirSync(dirname(target), { recursive: true });
    chmodSync(dirname(target), 0o555);
    const failures: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { failures.push(String(args[0])); };
    const m = exporter();
    try {
      m.bind(cm);
      await new Promise((r) => setTimeout(r, 200)); // about ten checks at 20 ms
    } finally {
      console.error = error;
      chmodSync(dirname(target), 0o755);
    }
    expect(failures.filter((line) => line.includes(`projection to ${target} failed`))).toHaveLength(1);
    expect(m.status().state).toBe('error');
    expect(m.status().error).toContain('EACCES');
    await accept(cm);
    expect(lines()[0]!.receipts).toBe(1);
    expect(m.status().state).toBe('exporting');
  });

  test('a projection that fails right after a takeover is reported with its result', async () => {
    const { cm, strategy, id, m } = await conflicted();
    const query = cm.listFoldReceipts.bind(cm);
    cm.listFoldReceipts = () => { throw new Error('no space left on device (simulated)'); };
    const result = m.takeOver('resident');
    cm.listFoldReceipts = query;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keptAs).not.toBeNull();
      expect(result.writeError).toContain('no space left on device');
    }
    expect(existsSync(target)).toBe(false);
    expect(m.status().state).toBe('error');
    // The next receipt writes again, now that the target is ours.
    strategy.omit.add(id);
    await accept(cm);
    expect(lines()[0]!.kind).toBe('folds-projection');
    expect(m.status().state).toBe('exporting');
  });

  test('never overwrites a projection modified since, at the next receipt or at startup', async () => {
    const { cm, strategy } = await openStore();
    const id = cm.addMessage('user', [{ type: 'text', text: 'hello' }]);
    const m = exporter();
    m.bind(cm);
    await accept(cm);
    writeFileSync(target, `${readFileSync(target, 'utf8')}{"note":"the resident's own line"}\n`);
    const edited = sha(target);
    strategy.omit.add(id);
    await accept(cm); // a new receipt
    expect(sha(target)).toBe(edited);
    expect(m.status().state).toBe('conflict');
    await m.stop(); // disposal does not write either
    exporter().bind(cm); // nor does startup
    expect(sha(target)).toBe(edited);
    expect(modules[1]!.status().conflict?.reason).toContain('differs');
  });

  test('a session switch rewrites the projection for the new store without a false conflict', async () => {
    const first = await openStore('session-a');
    first.cm.addMessage('user', [{ type: 'text', text: 'a' }]);
    await accept(first.cm);
    const a = exporter();
    a.bind(first.cm);
    expect(lines()[0]!.storeId).toBe(first.cm.getStoreId());

    // /session: the old framework (and its exporter) stops before the new one attaches.
    await a.stop();
    const second = await openStore('session-b');
    second.cm.addMessage('user', [{ type: 'text', text: 'b' }]);
    const b = exporter();
    b.bind(second.cm);
    expect(b.status().state).toBe('exporting');
    expect(lines()[0]!.storeId).toBe(second.cm.getStoreId());

    // The stopped exporter is detached: a receipt in the old store writes nothing.
    const afterSwitch = sha(target);
    await accept(first.cm);
    expect(sha(target)).toBe(afterSwitch);
  });

  test('a second takeover at the same instant never overwrites the first kept file', async () => {
    const fixed = new Date('2026-10-07T12:00:00.000Z');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'foreign one\n');
    const { cm } = await openStore();
    const m = new FoldsExportModule({ target, ledgerPath, checkIntervalMs: 20, now: () => fixed });
    modules.push(m);
    m.bind(cm);
    expect(m.takeOver('operator').ok).toBe(true);
    await m.stop();
    writeFileSync(target, 'foreign two\n'); // someone replaces the projection
    const again = new FoldsExportModule({ target, ledgerPath, checkIntervalMs: 20, now: () => fixed });
    modules.push(again);
    again.bind(cm);
    expect(again.status().state).toBe('conflict');
    expect(again.takeOver('operator').ok).toBe(true);
    const kept = readdirSync(dirname(target)).filter((f) => f.startsWith('folds.jsonl.kept-')).sort();
    expect(kept.length).toBe(2);
    const contents = kept.map((f) => readFileSync(join(dirname(target), f), 'utf8'));
    expect(contents).toContain('foreign one\n');
    expect(contents).toContain('foreign two\n');
  });

  test('the resident can take a conflicted target over through its utility', async () => {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, 'not ours\n');
    const { cm } = await openStore();
    const m = exporter();
    m.bind(cm);
    expect(m.getUtilities().map((u) => u.name)).toEqual(['take_over_export']);
    const unknown = await m.handleToolCall({ id: 't0', name: 'status', input: {} } as never);
    expect(unknown).toEqual({ success: false, isError: true, error: 'Unknown tool: status' });
    expect(m.status().state).toBe('conflict');
    const res = await m.handleToolCall({ id: 't', name: 'take_over_export', input: {} } as never);
    expect(res.success).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(lines()[0]!.kind).toBe('folds-projection');
    const again = await m.handleToolCall({ id: 't2', name: 'take_over_export', input: {} } as never);
    expect(again.success).toBe(false);
  });
});
