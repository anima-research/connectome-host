/**
 * Phase 6 — no-subfleets invariant.
 *
 * A fleet child recipe may not itself declare a `modules.fleet` entry.
 * Validation happens before subprocess spawn so the failure surfaces as a
 * clean synchronous tool error.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetModule } from '../src/modules/fleet-module.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');
const INDEX_PATH = join(REPO_ROOT, 'src', 'index.ts');

interface ToolResultLike {
  success?: boolean;
  isError?: boolean;
  error?: string;
}

describe('FleetModule — no-subfleets invariant', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-no-subfleets-'));
  });

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  async function runLaunch(recipeBody: object): Promise<ToolResultLike> {
    const recipePath = join(tmpDir, `recipe-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(recipePath, JSON.stringify(recipeBody), 'utf-8');

    const fleet = new FleetModule({
      childRuntimePath: 'bun',
      childIndexPath: INDEX_PATH,
    });
    // FleetModule.start() reads/writes Chronicle state; for a pure validation
    // test we drive handleToolCall directly without start(). The launch path
    // we exercise here checks the recipe before any subprocess spawn.
    const result = await fleet.handleToolCall({
      id: 'test-call',
      name: 'launch',
      input: {
        name: 'subfleet-child',
        recipe: recipePath,
        dataDir: join(tmpDir, 'subfleet-child'),
      },
    }) as ToolResultLike;

    return result;
  }

  test('recipe with modules.fleet=true is rejected', async () => {
    const result = await runLaunch({
      name: 'NestedFleetTrue',
      agent: { name: 'inner', systemPrompt: 'x' },
      modules: {
        fleet: true,
        subagents: false,
        lessons: false,
        retrieval: false,
        wake: false,
        workspace: false,
      },
    });
    expect(result.success).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain('nested fleets are not supported');
  });

  test('recipe with modules.fleet object is rejected', async () => {
    const result = await runLaunch({
      name: 'NestedFleetObject',
      agent: { name: 'inner', systemPrompt: 'x' },
      modules: {
        fleet: { children: [] },
        subagents: false,
        lessons: false,
        retrieval: false,
        wake: false,
        workspace: false,
      },
    });
    expect(result.success).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain('nested fleets are not supported');
  });

  test('recipe without fleet module is accepted (passes validation, may fail later in spawn path)', async () => {
    const result = await runLaunch({
      name: 'PlainChild',
      agent: { name: 'inner', systemPrompt: 'x' },
      modules: {
        subagents: false,
        lessons: false,
        retrieval: false,
        wake: false,
        workspace: false,
      },
    });
    // We don't care if the spawn itself succeeds in this test environment —
    // we care that the *invariant validation* doesn't reject it. Any rejection
    // here would be from a different code path (spawn-time errors), not the
    // no-subfleets check we just added.
    if (result.success === false && result.error) {
      expect(result.error).not.toContain('nested fleets');
    }
  });

  test('recipe with modules.fleet=false is accepted (explicit opt-out is fine)', async () => {
    const result = await runLaunch({
      name: 'ExplicitlyDisabledFleet',
      agent: { name: 'inner', systemPrompt: 'x' },
      modules: {
        fleet: false,
        subagents: false,
        lessons: false,
        retrieval: false,
        wake: false,
        workspace: false,
      },
    });
    if (result.success === false && result.error) {
      expect(result.error).not.toContain('nested fleets');
    }
  });
});
