import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetModule } from '../src/modules/fleet-module.js';
import { REDUCER_REQUIRED_EVENTS } from '../src/state/agent-tree-reducer.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

const NARROW_RECIPE = {
  name: 'NarrowSubscriptionTest',
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

describe('FleetModule subscribe union e2e', () => {
  let tmpDir: string;
  let recipePath: string;
  let fleet: FleetModule;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-sub-union-'));
    recipePath = join(tmpDir, 'recipe.json');
    writeFileSync(recipePath, JSON.stringify(NARROW_RECIPE), 'utf-8');

    fleet = new FleetModule({
      childRuntimePath: 'bun',
      childIndexPath: join(TEST_DIR, 'mock-runheadless-child.ts'),
      readyTimeoutMs: 15_000,
    });
  });

  afterAll(async () => {
    try {
      await fleet.handleToolCall({
        id: 'cleanup',
        name: 'kill',
        input: { name: 'narrow-child' },
      });
    } catch { }
    await new Promise((r) => setTimeout(r, 500));
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { }
  });

  test('narrow recipe subscription gets reducer-required events forced in by FleetModule', async () => {
    const dataDir = join(tmpDir, 'narrow-child-data');
    const narrowSubscription = [
      'lifecycle',
      'inference:completed',
      'inference:speech',
      'tool:completed',
      'tool:failed',
      'inference:failed',
    ];
    const result = await fleet.handleToolCall({
      id: 'launch-narrow',
      name: 'launch',
      input: {
        name: 'narrow-child',
        recipe: recipePath,
        dataDir,
        subscription: narrowSubscription,
      },
    });
    expect((result as { success?: boolean }).success).toBe(true);

    const logPath = join(dataDir, 'headless.log');
    await waitFor(
      () => existsSync(logPath) && readFileSync(logPath, 'utf-8').includes('subscription set:'),
      4_000,
      'child logs the subscription it applied',
    );

    const lastSet = readFileSync(logPath, 'utf-8').split('\n').filter(l => l.includes('subscription set: ')).at(-1)!;
    const applied = lastSet.slice(lastSet.indexOf('subscription set: ') + 'subscription set: '.length).split(', ');
    const expected = [...new Set([...narrowSubscription, ...REDUCER_REQUIRED_EVENTS, 'usage:updated'])];
    expect(applied.sort()).toEqual(expected.sort());
  });
});
