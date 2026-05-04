/**
 * End-to-end test for FleetTreeAggregator + FleetModule + headless child.
 *
 * Spawns a real headless child via FleetModule.handleLaunch, registers it
 * with the aggregator, and asserts the snapshot round-trips through the
 * IPC and ends up populating the per-child reducer.
 *
 * This is the integration check that Phase 1 + 2 + 3 + 6 actually compose:
 *   - Phase 6 lets the child recipe pass validation
 *   - Phase 1's describe verb returns a snapshot event
 *   - Phase 2's reducer accepts applySnapshot from that event's tree
 *   - Phase 3's aggregator orchestrates the describe handshake
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetModule } from '../src/modules/fleet-module.js';
import { FleetTreeAggregator } from '../src/state/fleet-tree-aggregator.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');
const INDEX_PATH = join(REPO_ROOT, 'src', 'index.ts');

const CHILD_RECIPE = {
  name: 'AggregatorChildRecipe',
  agent: { name: 'commander', systemPrompt: 'never inferred in this test' },
  modules: {
    subagents: false,
    lessons: false,
    retrieval: false,
    wake: false,
    workspace: false,
  },
};

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
}

describe('FleetTreeAggregator — e2e against headless child', () => {
  let tmpDir: string;
  let recipePath: string;
  let fleet: FleetModule;
  let aggregator: FleetTreeAggregator;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-agg-e2e-'));
    recipePath = join(tmpDir, 'recipe.json');
    writeFileSync(recipePath, JSON.stringify(CHILD_RECIPE), 'utf-8');

    fleet = new FleetModule({
      childRuntimePath: 'bun',
      childIndexPath: INDEX_PATH,
      readyTimeoutMs: 15_000,
    });
    aggregator = new FleetTreeAggregator(fleet);
  });

  afterAll(async () => {
    aggregator.dispose();
    // Best-effort cleanup of the spawned child.
    try {
      await fleet.handleToolCall({
        id: 'cleanup',
        name: 'kill',
        input: { name: 'aggregated-child' },
      });
    } catch { /* noop */ }
    await new Promise((r) => setTimeout(r, 500));
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('snapshot round-trips through aggregator after launch', async () => {
    // Register the child name BEFORE launch so we don't miss lifecycle:ready.
    aggregator.registerChild('aggregated-child');

    const launch = await fleet.handleToolCall({
      id: 'launch-1',
      name: 'launch',
      input: {
        name: 'aggregated-child',
        recipe: recipePath,
        dataDir: join(tmpDir, 'aggregated-child-data'),
      },
    });
    expect((launch as { success?: boolean }).success).toBe(true);

    // Wait for the snapshot to arrive and populate the reducer.
    // The aggregator requests describe on lifecycle:ready, the child responds
    // with a snapshot event carrying the seeded 'commander' framework agent.
    await waitFor(
      () => aggregator.getChildNodes('aggregated-child').some(n => n.name === 'commander'),
      15_000,
      'commander node populated from snapshot',
    );

    const nodes = aggregator.getChildNodes('aggregated-child');
    const commander = nodes.find(n => n.name === 'commander');
    expect(commander).toBeDefined();
    expect(commander!.kind).toBe('framework');
    expect(commander!.phase).toBe('idle');
  });
});
