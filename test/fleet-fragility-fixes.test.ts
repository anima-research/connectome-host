/**
 * Fragility audit Jul 2026 — FleetModule fixes.
 *
 * 2.1  AutoRestart flap cap was dead code: tryAutoRestart accumulated
 *      timestamps on child.restartAttempts, then deleted the record;
 *      handleLaunch recreated it with restartAttempts: [] — so the
 *      3-in-60s cap never tripped. Now the module keeps a restartHistory
 *      map keyed by child NAME that survives the delete/recreate cycle.
 * 2.8  Adopted children (process === null) had no crash detection: no
 *      ChildProcess handle → no 'exit' event → a dead adopted child stayed
 *      'ready' forever. Now a PID-liveness poll marks them crashed and
 *      triggers autoRestart.
 * 2.9  handleLaunch TOCTOU: the duplicate-name check and children.set were
 *      separated by `await loadRecipe`, so two concurrent launches with the
 *      same name both passed the check and the second record overwrote the
 *      first, leaking an untracked child process. Now the name is reserved
 *      synchronously before the first await.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnProcess } from 'node:child_process';
import { FleetModule } from '../src/modules/fleet-module.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const MOCK_CHILD_PATH = join(TEST_DIR, 'mock-headless-child.ts');

/** Minimal FleetChild-shaped record for driving private methods directly. */
function makeRecord(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    recipePath: `/tmp/${name}-recipe.json`,
    dataDir: `/tmp/${name}-data`,
    socketPath: `/tmp/${name}-data/ipc.sock`,
    pid: null,
    process: null,
    socket: null,
    status: 'crashed',
    startedAt: Date.now() - 1_000,
    exitedAt: Date.now(),
    lastEventAt: null,
    exitCode: 1,
    exitReason: 'code=1',
    events: [],
    buffer: '',
    subscription: ['*'],
    autoRestart: true,
    killRequested: false,
    restartAttempts: [],
    lastCompletedSpeech: '',
    ...overrides,
  };
}

interface FleetInternals {
  children: Map<string, Record<string, unknown>>;
  restartHistory: Map<string, number[]>;
  restartFlapCap: number;
  tryAutoRestart: (child: unknown) => void;
  handleLaunch: (input: unknown, opts?: unknown) => Promise<{ success: boolean; error?: string }>;
  startAdoptedLivenessPoll: (child: unknown) => void;
  adoptedPollTimers: Map<string, unknown>;
  stopping: boolean;
  handleKill: (input: { name: string }) => Promise<{ success: boolean }>;
  stop: () => Promise<void>;
}

function internals(fleet: FleetModule): FleetInternals {
  return fleet as unknown as FleetInternals;
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

describe('autoRestart flap cap survives the delete/recreate cycle (audit 2.1)', () => {
  test('cap trips after 3 attempts in the window even though each cycle recreates the record', () => {
    const fleet = new FleetModule({ childIndexPath: '/nonexistent-index.ts' });
    const iv = internals(fleet);

    // Neutralise the scheduled relaunches — we only exercise the accounting.
    const scheduledLaunches: string[] = [];
    iv.handleLaunch = async (input: unknown) => {
      scheduledLaunches.push((input as { name: string }).name);
      return { success: true };
    };

    let child = makeRecord('flappy');
    iv.children.set('flappy', child);

    // Three crash → restart cycles. Each cycle mimics production exactly:
    // tryAutoRestart deletes the record, and the subsequent handleLaunch
    // recreates it with a FRESH restartAttempts: [] (which is why the
    // per-record accounting could never accumulate).
    for (let i = 0; i < 3; i++) {
      iv.tryAutoRestart(child);
      // Attempt recorded and restart scheduled → record was dropped.
      expect(iv.children.has('flappy')).toBe(false);
      expect(iv.restartHistory.get('flappy')!.length).toBe(i + 1);
      // Simulate the relaunch recreating a pristine record.
      child = makeRecord('flappy');
      iv.children.set('flappy', child);
    }

    // 4th crash inside the window: the cap must refuse.
    iv.tryAutoRestart(child);
    // Refused → record NOT deleted, no new attempt recorded.
    expect(iv.children.get('flappy')).toBe(child);
    expect(iv.restartHistory.get('flappy')!.length).toBe(3);

    // Suppress the pending backoff timers from the first three attempts.
    iv.stopping = true;
  });

  test('attempts outside the flap window are pruned, re-enabling restart', () => {
    const fleet = new FleetModule({ childIndexPath: '/nonexistent-index.ts' });
    const iv = internals(fleet);
    iv.handleLaunch = async () => ({ success: true });

    const now = Date.now();
    // Three attempts, all older than the 60s window.
    iv.restartHistory.set('lazarus', [now - 120_000, now - 110_000, now - 100_000]);

    const child = makeRecord('lazarus');
    iv.children.set('lazarus', child);

    iv.tryAutoRestart(child);
    // Old attempts pruned; this one recorded; restart scheduled (record dropped).
    expect(iv.children.has('lazarus')).toBe(false);
    expect(iv.restartHistory.get('lazarus')!.length).toBe(1);

    iv.stopping = true;
  });
});

describe('restartHistory is cleaned up on permanent removal (growth-caps residue)', () => {
  test('operator kill drops the flap history for that child', async () => {
    const fleet = new FleetModule({ childIndexPath: '/nonexistent-index.ts' });
    const iv = internals(fleet);

    // A crashed child with an accumulated flap history.
    iv.children.set('gone', makeRecord('gone', { status: 'crashed' }));
    iv.restartHistory.set('gone', [Date.now(), Date.now()]);
    iv.restartHistory.set('other', [Date.now()]);

    await iv.handleKill({ name: 'gone' });

    // This child's history is gone; unrelated children are untouched.
    expect(iv.restartHistory.has('gone')).toBe(false);
    expect(iv.restartHistory.has('other')).toBe(true);
  });

  test('stop() clears all flap history (nothing auto-restarts after a clean stop)', async () => {
    const fleet = new FleetModule({ childIndexPath: '/nonexistent-index.ts' });
    const iv = internals(fleet);

    // Records with no process/pid so killChild is a no-op during stop().
    iv.children.set('a', makeRecord('a', { status: 'crashed' }));
    iv.children.set('b', makeRecord('b', { status: 'crashed' }));
    iv.restartHistory.set('a', [Date.now()]);
    iv.restartHistory.set('b', [Date.now(), Date.now()]);

    await iv.stop();

    expect(iv.restartHistory.size).toBe(0);
  });
});

describe('adopted children get PID-liveness crash detection (audit 2.8)', () => {
  test('killing the adopted process transitions status to crashed within the poll bound', async () => {
    const fleet = new FleetModule({
      childIndexPath: '/unused.ts',
      adoptedPollIntervalMs: 40,
    });
    const iv = internals(fleet);

    // A real short-lived process stands in for the adopted child.
    const proc = spawnProcess('sleep', ['30'], { stdio: 'ignore' });
    await waitFor(() => typeof proc.pid === 'number', 1_000, 'sleep process pid');

    const child = makeRecord('adoptee', {
      pid: proc.pid,
      process: null,       // adopted: no ChildProcess handle
      status: 'ready',
      exitCode: null,
      exitReason: null,
      exitedAt: null,
      autoRestart: false,
    });
    iv.children.set('adoptee', child);
    iv.startAdoptedLivenessPoll(child);

    // Alive: several poll ticks pass without a false positive.
    await new Promise(r => setTimeout(r, 130));
    expect(child.status).toBe('ready');

    proc.kill('SIGKILL');
    await waitFor(() => child.status === 'crashed', 3_000, 'poll detects death');
    expect(String(child.exitReason)).toMatch(/pid poll/);
    // Poll timer cleaned up after detection.
    expect(iv.adoptedPollTimers.has('adoptee')).toBe(false);
  }, 10_000);

  test('death of an adopted child with autoRestart triggers the restart path', async () => {
    const fleet = new FleetModule({
      childIndexPath: '/unused.ts',
      adoptedPollIntervalMs: 40,
    });
    const iv = internals(fleet);
    const restartRequests: string[] = [];
    iv.tryAutoRestart = (c: unknown) => {
      restartRequests.push((c as { name: string }).name);
    };

    const proc = spawnProcess('sleep', ['30'], { stdio: 'ignore' });
    await waitFor(() => typeof proc.pid === 'number', 1_000, 'sleep process pid');

    const child = makeRecord('phoenix', {
      pid: proc.pid,
      process: null,
      status: 'ready',
      exitCode: null,
      exitReason: null,
      exitedAt: null,
      autoRestart: true,
    });
    iv.children.set('phoenix', child);
    iv.startAdoptedLivenessPoll(child);

    proc.kill('SIGKILL');
    await waitFor(() => restartRequests.includes('phoenix'), 3_000, 'autoRestart path invoked');
    expect(child.status).toBe('crashed');
  }, 10_000);
});

describe('handleLaunch reserves the name before awaiting (audit 2.9)', () => {
  test('two concurrent launches with the same name: exactly one wins, one duplicate error', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'fkm-toctou-'));
    const fleet = new FleetModule({
      childIndexPath: MOCK_CHILD_PATH,
      socketWaitTimeoutMs: 10_000,
      readyTimeoutMs: 5_000,
      gracefulShutdownMs: 3_000,
      sigtermEscalationMs: 1_000,
    });
    try {
      const [r1, r2] = await Promise.all([
        fleet.handleToolCall({
          id: 'launch-a',
          name: 'launch',
          input: { name: 'dup', recipe: 'mock-recipe', dataDir: join(tmpDir, 'a') },
        }),
        fleet.handleToolCall({
          id: 'launch-b',
          name: 'launch',
          input: { name: 'dup', recipe: 'mock-recipe', dataDir: join(tmpDir, 'b') },
        }),
      ]);

      const successes = [r1, r2].filter(r => r.success);
      const failures = [r1, r2].filter(r => !r.success);
      // Pre-fix: both passed the duplicate check while parked on
      // `await loadRecipe`, both spawned, and the second record silently
      // overwrote the first (one process leaked, untracked).
      expect(successes.length).toBe(1);
      expect(failures.length).toBe(1);
      expect(String(failures[0]!.error)).toMatch(/already (starting|ready)/);

      // Exactly one live child record.
      expect(fleet.getChildren().size).toBe(1);
      expect(fleet.getChildren().get('dup')!.status).toBe('ready');
    } finally {
      try { await fleet.stop(); } catch { /* noop */ }
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }, 20_000);
});
