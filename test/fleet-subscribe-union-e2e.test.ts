import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetModule } from '../src/modules/fleet-module.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');
const INDEX_PATH = join(REPO_ROOT, 'src', 'index.ts');

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
  let previousApiKey: string | undefined;

  beforeAll(async () => {
    previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = previousApiKey || 'sk-test-fleet-subscribe-union';
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-sub-union-'));
    recipePath = join(tmpDir, 'recipe.json');
    writeFileSync(recipePath, JSON.stringify(NARROW_RECIPE), 'utf-8');

    fleet = new FleetModule({
      childRuntimePath: 'bun',
      childIndexPath: INDEX_PATH,
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
    if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousApiKey;
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
    await waitFor(() => existsSync(logPath), 15_000, 'headless.log appears');
    await waitFor(
      () => existsSync(logPath) && /subscription set: .*inference:tool_calls_yielded/.test(readFileSync(logPath, 'utf-8')),
      15_000,
      'subscribe with reducer events applied',
    );

    const log = readFileSync(logPath, 'utf-8');
    const subLines = log.split('\n').filter(l => l.includes('subscription set:'));
    expect(subLines.length).toBeGreaterThan(0);
    const lastSet = subLines[subLines.length - 1]!;
    expect(lastSet).toContain('lifecycle');
    expect(lastSet).toContain('inference:speech');
    expect(lastSet).toContain('inference:tool_calls_yielded');
    expect(lastSet).toContain('inference:started');
    expect(lastSet).toContain('inference:tokens');
    expect(lastSet).toContain('inference:usage');
    expect(lastSet).toContain('tool:started');
  });
});
