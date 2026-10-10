/**
 * folds.jsonl from the host's side: the recipe's `modules.foldsExport`, the
 * paths it maps to, the `/folds` command, and a batch run on membrane's mock
 * adapter that leaves the resident's first fold receipt in the file, labelled
 * with the host's source facts. The exporter itself is
 * folds-export-module.test.ts's.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentFramework } from '@animalabs/agent-framework';
import { handleCommand } from '../src/commands.js';
import { validateRecipe } from '../src/recipe.js';
import {
  foldsExportPaths,
  type FoldsExportStatus,
  type TakeOverResult,
} from '../src/modules/folds-export-module.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = join(REPO_ROOT, 'src', 'index.ts');

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('modules.foldsExport', () => {
  test('is on by default at <dataDir>/memory/folds.jsonl, off with false, and { path } moves the target', () => {
    const data = '/srv/linn/data';
    const defaults = { target: resolve(data, 'memory', 'folds.jsonl'), ledgerPath: resolve(data, 'folds-export-ownership.json') };
    expect(foldsExportPaths(undefined, data)).toEqual(defaults);
    expect(foldsExportPaths(true, data)).toEqual(defaults);
    expect(foldsExportPaths({}, data)).toEqual(defaults);
    expect(foldsExportPaths(false, data)).toBeNull();
    // The ledger stays with the data directory wherever the file goes.
    expect(foldsExportPaths({ path: 'exports/folds.jsonl' }, data)).toEqual({
      target: resolve('exports/folds.jsonl'),
      ledgerPath: defaults.ledgerPath,
    });
  });

  const recipe = (foldsExport: unknown) => ({
    name: 'Folds Recipe',
    agent: { name: 'linn', systemPrompt: 'x' },
    modules: { foldsExport },
  });

  test('a recipe may turn it off or move it', () => {
    for (const value of [true, false, {}, { path: '/srv/linn/folds.jsonl' }]) {
      expect(validateRecipe(recipe(value)).modules?.foldsExport).toEqual(value);
    }
  });

  test('a recipe that sets it to anything else fails to load, saying why', () => {
    for (const value of [null, [], 'yes', 1]) {
      expect(() => validateRecipe(recipe(value))).toThrow('modules.foldsExport must be a boolean or object');
    }
    expect(() => validateRecipe(recipe({ file: 'x' }))).toThrow('unknown key "file" (known: path)');
    for (const path of ['', '   ', 3]) {
      expect(() => validateRecipe(recipe({ path }))).toThrow('modules.foldsExport.path must be a non-empty string');
    }
  });
});

describe('/folds', () => {
  const target = '/srv/linn/data/memory/folds.jsonl';
  const base: FoldsExportStatus = { target, state: 'exporting', freshness: 'FRESHNESS' };

  function app(exporter: { status: () => FoldsExportStatus; takeOver?: () => TakeOverResult } | null) {
    const modules = exporter ? [{ name: 'folds', takeOver: () => ({ ok: false, error: 'unused' }), ...exporter }] : [];
    return {
      framework: { getAllModules: () => modules } as unknown as AgentFramework,
      sessionManager: {} as never,
      recipe: { name: 'test' } as never,
      branchState: {} as never,
      switchSession: async () => {},
    } as Parameters<typeof handleCommand>[1];
  }
  const text = (command: string, a: Parameters<typeof handleCommand>[1]) => handleCommand(command, a).lines.map((l) => l.text);

  test('says when the export is off', () => {
    expect(text('/folds', app(null))).toEqual(['folds.jsonl export is off (recipe modules.foldsExport: false).']);
  });

  test('shows the target, its state, the last projection and the freshness note', () => {
    const lines = text('/folds', app({
      status: () => ({
        ...base,
        lastProjection: { at: '2026-10-10T03:00:00.000Z', branch: { id: '1', name: 'main' }, latestReceiptId: '42', receipts: 100, more: true },
      }),
    }));
    expect(lines[0]).toBe(`folds.jsonl → ${target} (exporting)`);
    expect(lines).toContain('  last written 2026-10-10T03:00:00.000Z: branch main, 100 receipt(s), newest 42');
    expect(lines).toContain('  older receipts were left out of the file; history--folds reads them from the journal');
    expect(lines[lines.length - 1]).toBe('  FRESHNESS');
  });

  test('shows a conflict, how to resolve it, and a failed write', () => {
    const lines = text('/folds', app({
      status: () => ({
        ...base,
        state: 'conflict',
        conflict: { reason: 'the file differs from the last projection this host wrote, and from the one before it', at: '2026-10-10T03:00:00.000Z', foundHash: 'ab' },
        error: 'EACCES: permission denied',
      }),
    }));
    expect(lines[0]).toBe(`folds.jsonl → ${target} (conflict)`);
    expect(lines).toContain('  conflict since 2026-10-10T03:00:00.000Z: the file differs from the last projection this host wrote, and from the one before it');
    expect(lines).toContain('  The file is preserved. /folds takeover keeps it beside the target and resumes export.');
    expect(lines).toContain('  last write failed: EACCES: permission denied');
  });

  test('takeover reports where the existing file went, and a projection that then failed', () => {
    const kept = `${target}.kept-2026-10-10T03-00-00-000Z`;
    expect(text('/folds takeover', app({ status: () => base, takeOver: () => ({ ok: true, keptAs: kept, writeError: 'ENOSPC' }) }))).toEqual([
      `Took over ${target}; the existing file is kept as ${kept}.`,
      '  but writing the projection failed: ENOSPC. The next receipt or startup writes again.',
    ]);
    expect(text('/folds takeover', app({ status: () => base, takeOver: () => ({ ok: true, keptAs: null }) }))).toEqual([
      `Took over ${target}.`,
    ]);
  });

  test('takeover reports a failure as the exporter words it, and an unknown subcommand gets the usage', () => {
    const failed = app({ status: () => base, takeOver: () => ({ ok: false, error: 'Taking over failed: EROFS.' }) });
    expect(text('/folds takeover', failed)).toEqual(['Taking over failed: EROFS.']);
    expect(text('/folds status', failed)).toEqual(['Usage: /folds [takeover]']);
  });
});

/** A batch run on membrane's mock adapter: each stdin line, then the host stops. */
async function runBatch(input: string, prepare?: (data: string) => void): Promise<{ data: string; code: number | 'still running'; stdout: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'chost-folds-'));
  tmpDirs.push(dir);
  const data = join(dir, 'data');
  prepare?.(data);
  const recipePath = join(dir, 'recipe.json');
  writeFileSync(recipePath, JSON.stringify({
    name: 'Folds Host Test',
    agent: { name: 'agent', provider: 'mock', systemPrompt: 'folds host test' },
    modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
  }));
  const child = spawn(process.execPath, [INDEX_PATH, recipePath], {
    // cwd=dir keeps the developer's own mcpl-servers.json out of the run.
    cwd: dir,
    env: { ...process.env, DATA_DIR: data },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout!.on('data', (c: Buffer) => { stdout += c.toString('utf-8'); });
  child.stderr!.on('data', () => { /* drain */ });
  child.stdin!.end(input);
  const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    exited,
    new Promise<'still running'>((r) => { timer = setTimeout(() => r('still running'), 30_000); }),
  ]).finally(() => clearTimeout(timer));
  if (outcome === 'still running') {
    child.kill('SIGKILL');
    await exited;
  }
  return { data, code: outcome ?? -1, stdout };
}

/** The tools the run's first model request carried, from the host's llm-calls log. */
function firstRequestTools(data: string): string[] {
  const log = readdirSync(data).find((f) => f.startsWith('llm-calls.') && f.endsWith('.jsonl'));
  expect(log).toBeDefined();
  const first = JSON.parse(readFileSync(join(data, log!), 'utf8').split('\n')[0]!) as { requestSummary: { toolNames: string[] } };
  return first.requestSummary.toolNames;
}

describe('the host writes folds.jsonl', () => {
  test('a batch run leaves the resident\'s first receipt in the file, labelled with the host\'s source facts', async () => {
    const { data, code, stdout } = await runBatch('hello\n/folds\n');
    expect(code).toBe(0);

    // On by default, at the default path, and reachable by /folds.
    const target = join(data, 'memory', 'folds.jsonl');
    expect(stdout).toContain(`folds.jsonl → ${target} (exporting)`);

    // The round's compile was accepted, and the file holds its receipt, which
    // names this host.
    const lines = readFileSync(target, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]!.kind).toBe('folds-projection');
    expect(lines[0]!.receipts).toBe(1);
    expect(lines[1]!.kind).toBe('baseline');
    const source = lines[1]!.source as Record<string, unknown>;
    expect(source.runtime).toBe('connectome-host');
    expect(source.agent).toBe('agent');
    expect(source.dataDirectory).toBe(resolve(data));

    // The ownership ledger sits in the data directory and recognizes the file.
    const ledgerPath = join(data, 'folds-export-ownership.json');
    expect(existsSync(ledgerPath)).toBe(true);
    const entry = (JSON.parse(readFileSync(ledgerPath, 'utf8')) as { targets: Record<string, { latest?: string }> }).targets[target]!;
    expect(entry.latest).toBe(createHash('sha256').update(readFileSync(target)).digest('hex'));

    // With no conflict, the resident's takeover isn't offered, so a recipe
    // with no other utility sends no `utils` tool.
    expect(firstRequestTools(data)).not.toContain('utils');
  }, 60_000);

  test('a conflict found at startup preserves the file and offers the takeover from the first request', async () => {
    const foreign = '{"written":"by the resident itself"}\n';
    const { data, code, stdout } = await runBatch('hello\n/folds\n', (d) => {
      mkdirSync(join(d, 'memory'), { recursive: true });
      writeFileSync(join(d, 'memory', 'folds.jsonl'), foreign);
    });
    expect(code).toBe(0);
    const target = join(data, 'memory', 'folds.jsonl');
    expect(readFileSync(target, 'utf8')).toBe(foreign);
    expect(stdout).toContain(`folds.jsonl → ${target} (conflict)`);
    expect(firstRequestTools(data)).toContain('utils');
  }, 60_000);
});
