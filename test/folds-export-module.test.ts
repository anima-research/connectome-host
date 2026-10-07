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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ContextManager } from '@animalabs/context-manager';
import type {
  ContextEntry,
  ContextLogView,
  ContextStrategy,
  MessageStoreView,
  ReadinessState,
  RenderedSummaryInfo,
  TokenBudget,
} from '@animalabs/context-manager';
import { FoldsExportModule } from '../src/modules/folds-export-module.js';

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

async function accept(cm: ContextManager): Promise<void> {
  const result = await cm.compile(BUDGET);
  cm.acceptRound({ provenance: result.provenance! });
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
  test('preserves a foreign file found at first use, and resumes after a new target or an explicit takeover', async () => {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '{"written":"by another runtime"}\n');
    const before = sha(target);
    const { cm } = await openStore();
    cm.addMessage('user', [{ type: 'text', text: 'hello' }]);
    const m = exporter();
    m.bind(cm);
    await accept(cm);
    expect(sha(target)).toBe(before);
    const status = m.status();
    expect(status.state).toBe('conflict');
    expect(status.target).toBe(target);
    expect(status.conflict?.reason).toContain('never written');

    // Another target resumes export there; the conflicted file stays untouched.
    const other = join(dataDir, 'memory', 'folds-elsewhere.jsonl');
    exporter(other).bind(cm);
    expect(lines(other)[0]!.receipts).toBe(1);
    expect(sha(target)).toBe(before);

    // An explicit takeover keeps the existing file beside the target.
    const result = m.takeOver('operator');
    expect(result.ok).toBe(true);
    const kept = readdirSync(dirname(target)).filter((f) => f.startsWith('folds.jsonl.kept-'));
    expect(kept.length).toBe(1);
    expect(readFileSync(join(dirname(target), kept[0]!), 'utf8')).toContain('by another runtime');
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
    const res = await m.handleToolCall({ id: 't', name: 'take_over_export', input: {} } as never);
    expect(res.success).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(lines()[0]!.kind).toBe('folds-projection');
    const again = await m.handleToolCall({ id: 't2', name: 'take_over_export', input: {} } as never);
    expect(again.success).toBe(false);
  });
});
