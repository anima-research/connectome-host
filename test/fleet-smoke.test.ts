/**
 * Phase 2 smoke test for FleetModule.
 *
 * Drives the module's tool surface directly (no full framework needed) and
 * exercises the end-to-end loop:
 *   spawn -> ready, list, status, command (/help, offline-safe), peek
 *   shows command-output events, kill exits the child cleanly.
 *
 * fleet--send is intentionally NOT tested here — it triggers inference and
 * needs a real ANTHROPIC_API_KEY.  That's manual-test territory.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetModule } from '../src/modules/fleet-module.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');
const INDEX_PATH = join(REPO_ROOT, 'src', 'index.ts');

const MINIMAL_RECIPE = {
  name: 'Fleet Smoke Test',
  agent: { name: 'leaf', systemPrompt: 'never asked to infer in this test' },
  modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
};

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
}

describe('FleetModule — Phase 2', () => {
  let tmpDir: string;
  let recipePath: string;
  let dataDir: string;
  let fleet: FleetModule;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-fleet-'));
    recipePath = join(tmpDir, 'recipe.json');
    dataDir = join(tmpDir, 'leaf');
    writeFileSync(recipePath, JSON.stringify(MINIMAL_RECIPE), 'utf-8');

    // Inject a dummy ANTHROPIC_API_KEY into the env that children inherit;
    // they validate it on startup but never call the API in this test.
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test-fleet-smoke';

    fleet = new FleetModule({
      childIndexPath: INDEX_PATH,
      // Snappier timeouts for a hermetic test.
      socketWaitTimeoutMs: 15_000,
      readyTimeoutMs: 10_000,
      gracefulShutdownMs: 5_000,
      sigtermEscalationMs: 2_000,
    });
  });

  afterAll(async () => {
    // Defensive cleanup — kill any children the test left behind.
    try { await fleet.stop(); } catch { /* noop */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('spawn → list → status → command/peek → kill round trip', async () => {
    // -- spawn --
    const spawnRes = await fleet.handleToolCall({
      id: 't-spawn',
      name: 'spawn',
      input: { name: 'leaf', recipe: recipePath, dataDir },
    });
    expect(spawnRes.success).toBe(true);
    const spawnData = spawnRes.data as { name: string; pid: number | null; status: string };
    expect(spawnData.name).toBe('leaf');
    expect(spawnData.status).toBe('ready');
    expect(typeof spawnData.pid).toBe('number');

    // -- list --
    const listRes = await fleet.handleToolCall({ id: 't-list', name: 'list', input: {} });
    expect(listRes.success).toBe(true);
    const listData = listRes.data as Array<{ name: string; status: string; eventCount: number }>;
    expect(listData).toHaveLength(1);
    expect(listData[0]!.name).toBe('leaf');
    expect(listData[0]!.status).toBe('ready');

    // -- status --
    const statusRes = await fleet.handleToolCall({ id: 't-status', name: 'status', input: { name: 'leaf' } });
    expect(statusRes.success).toBe(true);
    const statusData = statusRes.data as { name: string; status: string; subscription: string[] };
    expect(statusData.status).toBe('ready');
    expect(statusData.subscription).toContain('*');  // default subscription

    // -- command (/help is offline-safe — no LLM call) --
    const cmdRes = await fleet.handleToolCall({
      id: 't-cmd',
      name: 'command',
      input: { name: 'leaf', command: '/help' },
    });
    expect(cmdRes.success).toBe(true);

    // Wait for the command-output events to land in the buffer.
    await waitFor(
      () => {
        const child = fleet.getChildren().get('leaf');
        return !!child && child.events.filter((e) => e.type === 'command-output').length >= 5;
      },
      5_000,
      'command-output events from /help',
    );

    // -- peek --
    const peekRes = await fleet.handleToolCall({
      id: 't-peek',
      name: 'peek',
      input: { name: 'leaf', lines: 30 },
    });
    expect(peekRes.success).toBe(true);
    const peekData = peekRes.data as { name: string; count: number; events: Array<{ type: string }> };
    expect(peekData.name).toBe('leaf');
    expect(peekData.count).toBeGreaterThan(0);
    const cmdOutputs = peekData.events.filter((e) => e.type === 'command-output');
    expect(cmdOutputs.length).toBeGreaterThanOrEqual(5);

    // -- kill --
    const killRes = await fleet.handleToolCall({ id: 't-kill', name: 'kill', input: { name: 'leaf' } });
    expect(killRes.success).toBe(true);

    // Final status should be 'exited' (graceful shutdown via socket).
    const child = fleet.getChildren().get('leaf');
    expect(child?.status).toBe('exited');
    expect(child?.exitCode).toBe(0);

    // Socket file should be removed by the child's own cleanup path.
    expect(existsSync(join(dataDir, 'ipc.sock'))).toBe(false);
  }, 60_000);

  test('spawn rejects duplicate name while child is running', async () => {
    const dataDir2 = join(tmpDir, 'duplicate');
    const first = await fleet.handleToolCall({
      id: 't-dup-1',
      name: 'spawn',
      input: { name: 'dup', recipe: recipePath, dataDir: dataDir2 },
    });
    expect(first.success).toBe(true);

    const second = await fleet.handleToolCall({
      id: 't-dup-2',
      name: 'spawn',
      input: { name: 'dup', recipe: recipePath, dataDir: dataDir2 },
    });
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already/);

    // Cleanup: kill the running one.
    await fleet.handleToolCall({ id: 't-dup-kill', name: 'kill', input: { name: 'dup' } });
  }, 60_000);

  test('onChildEvent fans out wire events live (no buffer poll needed)', async () => {
    const dataDir3 = join(tmpDir, 'sub');
    const seen: Array<{ child: string; type: string }> = [];
    const unsub = fleet.onChildEvent('*', (childName, evt) => {
      seen.push({ child: childName, type: evt.type });
    });

    const spawnRes = await fleet.handleToolCall({
      id: 't-sub-spawn',
      name: 'spawn',
      input: { name: 'sub', recipe: recipePath, dataDir: dataDir3 },
    });
    expect(spawnRes.success).toBe(true);

    // The lifecycle:ready event should have been fanned out by the time
    // spawn returned (handleSpawn awaits waitForReady which polls status).
    expect(seen.some((e) => e.child === 'sub' && e.type === 'lifecycle')).toBe(true);

    await fleet.handleToolCall({ id: 't-sub-cmd', name: 'command', input: { name: 'sub', command: '/help' } });

    // Wait for command-output events to fan out.
    const start = Date.now();
    while (Date.now() - start < 5_000) {
      if (seen.filter((e) => e.type === 'command-output').length >= 5) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(seen.filter((e) => e.type === 'command-output').length).toBeGreaterThanOrEqual(5);

    unsub();
    await fleet.handleToolCall({ id: 't-sub-kill', name: 'kill', input: { name: 'sub' } });
  }, 60_000);

  test('handlers reject unknown child names', async () => {
    const send = await fleet.handleToolCall({ id: 't-u-send', name: 'send', input: { name: 'ghost', content: 'hi' } });
    expect(send.success).toBe(false);
    expect(send.error).toMatch(/Unknown child/);

    const peek = await fleet.handleToolCall({ id: 't-u-peek', name: 'peek', input: { name: 'ghost' } });
    expect(peek.success).toBe(false);

    const kill = await fleet.handleToolCall({ id: 't-u-kill', name: 'kill', input: { name: 'ghost' } });
    expect(kill.success).toBe(false);
  });
});

describe('FleetModule — Phase 4 autoStart + allowlist', () => {
  let tmpDir: string;
  let recipePath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fkm-fleet-as-'));
    recipePath = join(tmpDir, 'recipe.json');
    writeFileSync(recipePath, JSON.stringify(MINIMAL_RECIPE), 'utf-8');
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test-fleet-smoke';
  });

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('autoStart children launch during start() and reach ready', async () => {
    const fleet = new FleetModule({
      childIndexPath: INDEX_PATH,
      autoStart: [
        { name: 'a', recipe: recipePath, dataDir: join(tmpDir, 'a') },
        { name: 'b', recipe: recipePath, dataDir: join(tmpDir, 'b') },
      ],
      socketWaitTimeoutMs: 15_000,
      readyTimeoutMs: 10_000,
      gracefulShutdownMs: 5_000,
      sigtermEscalationMs: 2_000,
    });

    // Minimal ModuleContext stub — start() only uses ctx for .setState which we don't exercise here.
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);

    // autoStart is fire-and-forget, so wait for both to reach ready.
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const ready = [...fleet.getChildren().values()].filter((c) => c.status === 'ready').length;
      if (ready === 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const children = [...fleet.getChildren().values()];
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.status === 'ready')).toBe(true);

    await fleet.stop();
  }, 60_000);

  test('allowlist rejects recipes outside the list (children recipes are implicitly allowed)', async () => {
    const fleet = new FleetModule({
      childIndexPath: INDEX_PATH,
      autoStart: [],
      allowedRecipes: [recipePath],  // only this one path
      socketWaitTimeoutMs: 15_000,
      readyTimeoutMs: 10_000,
      gracefulShutdownMs: 5_000,
      sigtermEscalationMs: 2_000,
    });
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);

    const bogus = join(tmpDir, 'bogus-recipe.json');
    const res = await fleet.handleToolCall({
      id: 't-allow-deny',
      name: 'spawn',
      input: { name: 'nope', recipe: bogus, dataDir: join(tmpDir, 'nope') },
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/allowlist/i);

    // Listed path should be accepted.
    const ok = await fleet.handleToolCall({
      id: 't-allow-ok',
      name: 'spawn',
      input: { name: 'ok', recipe: recipePath, dataDir: join(tmpDir, 'ok') },
    });
    expect(ok.success).toBe(true);

    await fleet.stop();
  }, 60_000);

  test('subscription filter narrows per-subscriber event stream', async () => {
    const fleet = new FleetModule({
      childIndexPath: INDEX_PATH,
      autoStart: [],
      socketWaitTimeoutMs: 15_000,
      readyTimeoutMs: 10_000,
      gracefulShutdownMs: 5_000,
      sigtermEscalationMs: 2_000,
    });
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);

    const allEvents: string[] = [];
    const filteredEvents: string[] = [];
    const unsubAll = fleet.onChildEvent('*', (_n, e) => { allEvents.push(e.type); });
    const unsubFiltered = fleet.onChildEvent('*', (_n, e) => { filteredEvents.push(e.type); }, ['lifecycle']);

    const dataDir = join(tmpDir, 'filter');
    const res = await fleet.handleToolCall({
      id: 't-filt-spawn',
      name: 'spawn',
      input: { name: 'filt', recipe: recipePath, dataDir },
    });
    expect(res.success).toBe(true);

    await fleet.handleToolCall({ id: 't-filt-cmd', name: 'command', input: { name: 'filt', command: '/help' } });

    await new Promise((r) => setTimeout(r, 500));

    // Unfiltered should include both lifecycle and command-output.
    expect(allEvents.some((t) => t === 'lifecycle')).toBe(true);
    expect(allEvents.some((t) => t === 'command-output')).toBe(true);
    // Filtered should include ONLY lifecycle — no command-output leak-through.
    expect(filteredEvents.some((t) => t === 'lifecycle')).toBe(true);
    expect(filteredEvents.every((t) => t === 'lifecycle')).toBe(true);

    unsubAll();
    unsubFiltered();
    await fleet.handleToolCall({ id: 't-filt-kill', name: 'kill', input: { name: 'filt' } });
    await fleet.stop();
  }, 60_000);

  test('adopt-on-restart: second FleetModule with shared state reattaches to running child', async () => {
    // A minimal in-memory ctx that survives across FleetModule instances.
    const store: { fleet?: unknown } = {};
    const stubCtx = {
      setState: <T>(s: T): void => { store.fleet = s; },
      getState: <T>(): T | null => (store.fleet as T | null) ?? null,
      pushEvent: (): void => {},
      getModule: (): null => null,
    } as unknown as Parameters<FleetModule['start']>[0];

    // First parent: spawn, detach (child keeps running).
    const fleet1 = new FleetModule({
      childIndexPath: INDEX_PATH,
      socketWaitTimeoutMs: 15_000,
      readyTimeoutMs: 10_000,
    });
    await fleet1.start(stubCtx);
    const dataDir = join(tmpDir, 'adopt');
    const res1 = await fleet1.handleToolCall({
      id: 't-adopt-spawn',
      name: 'spawn',
      input: { name: 'adoptee', recipe: recipePath, dataDir },
    });
    expect(res1.success).toBe(true);
    const pidBefore = (res1.data as { pid: number }).pid;

    fleet1.setDetachMode(true);
    await fleet1.stop();

    // Brief gap to simulate parent restart.
    await new Promise((r) => setTimeout(r, 200));

    // Second parent: same shared state; should adopt rather than respawn.
    const fleet2 = new FleetModule({
      childIndexPath: INDEX_PATH,
      socketWaitTimeoutMs: 15_000,
      readyTimeoutMs: 10_000,
    });
    await fleet2.start(stubCtx);

    // The adopted child should be in the new fleet's map, ready, with the SAME pid.
    const adopted = fleet2.getChildren().get('adoptee');
    expect(adopted).toBeDefined();
    expect(adopted?.status).toBe('ready');
    expect(adopted?.pid).toBe(pidBefore);

    // Send a command to confirm the socket works end-to-end.
    const cmd = await fleet2.handleToolCall({
      id: 't-adopt-cmd',
      name: 'command',
      input: { name: 'adoptee', command: '/help' },
    });
    expect(cmd.success).toBe(true);

    await fleet2.handleToolCall({ id: 't-adopt-kill', name: 'kill', input: { name: 'adoptee' } });
    await fleet2.stop();
  }, 60_000);

  test('allowlist prefix wildcard works', async () => {
    const fleet = new FleetModule({
      childIndexPath: INDEX_PATH,
      autoStart: [],
      allowedRecipes: [`${tmpDir}/*`],
      socketWaitTimeoutMs: 15_000,
      readyTimeoutMs: 10_000,
      gracefulShutdownMs: 5_000,
      sigtermEscalationMs: 2_000,
    });
    await fleet.start({} as unknown as Parameters<typeof fleet.start>[0]);

    // Any recipe under tmpDir/ should match.
    const ok = await fleet.handleToolCall({
      id: 't-glob-ok',
      name: 'spawn',
      input: { name: 'glob', recipe: recipePath, dataDir: join(tmpDir, 'glob') },
    });
    expect(ok.success).toBe(true);

    // Something outside tmpDir should not.
    const bad = await fleet.handleToolCall({
      id: 't-glob-bad',
      name: 'spawn',
      input: { name: 'bad', recipe: '/somewhere/else.json', dataDir: join(tmpDir, 'bad') },
    });
    expect(bad.success).toBe(false);

    await fleet.stop();
  }, 60_000);
});
