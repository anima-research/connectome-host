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
  const activeFleets: FleetModule[] = [];

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-no-subfleets-'));
  });

  afterAll(async () => {
    await Promise.all(activeFleets.map((f) => f.stop().catch(() => { })));
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { }
  }, 30_000);

  async function runLaunch(recipeBody: object): Promise<ToolResultLike> {
    const recipePath = join(tmpDir, `recipe-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(recipePath, JSON.stringify(recipeBody), 'utf-8');

    const fleet = new FleetModule({
      childRuntimePath: 'bun',
      childIndexPath: INDEX_PATH,
      gracefulShutdownMs: 1_000,
      sigtermEscalationMs: 500,
    });
    activeFleets.push(fleet);
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

  test('a recipe with a fleet module that fits its own model but not this host\'s MODEL is still rejected as a nested fleet', async () => {
    const model = process.env.MODEL;
    process.env.MODEL = 'claude-haiku-4-5';
    try {
      const result = await runLaunch({
        name: 'NestedFleetUnfit',
        agent: { name: 'inner', systemPrompt: 'x', model: 'claude-opus-4-6', maxTokens: 100_000 },
        modules: { fleet: true, subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('nested fleets are not supported');
    } finally {
      if (model === undefined) delete process.env.MODEL; else process.env.MODEL = model;
    }
  });

  test('a recipe with a fleet module whose system prompt can\'t be fetched is still rejected as a nested fleet', async () => {
    const result = await runLaunch({
      name: 'NestedFleetUnfetchable',
      agent: { name: 'inner', systemPrompt: 'http://127.0.0.1:9/prompt.txt' },
      modules: { fleet: true, subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
    });
    expect(result.success).toBe(false);
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
