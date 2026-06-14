/**
 * Postmortem 2026-05-28 F2: dual-clock zombie bug in SubagentModule.
 *
 * The reaper (reclaimZombieSlots) was correctly updated to use `lastActivityAt`
 * — the merciful clock that distinguishes "long-running but progressing" from
 * "silently stuck." The peek observability surface (peekOne / isZombie field)
 * still uses `startedAt`, which flags ANY subagent older than 30s as a zombie
 * the moment it's between tokens.
 *
 * This false positive saturates orchestrator context: scouts narrate about
 * peer zombies, the orchestrator re-spawns them as -retryN, abandoned
 * originals get aborted, the admin UI paints them red. The reap doesn't even
 * have to happen for the symptom to manifest.
 *
 * These tests assert the merciful (lastActivityAt-based) semantics from peek's
 * point of view. Each test seeds the module's private maps directly to keep
 * the surface small — `peek()` does not need a full framework / context-manager
 * stack to exercise the predicate.
 */
import { describe, test, expect } from 'bun:test';
import { SubagentModule, type ActiveSubagent } from '../src/modules/subagent-module.js';

interface FakeLiveState {
  frameworkAgentName: string;
  displayName: string;
  systemPrompt: string;
  contextManager: { compile: () => Promise<{ messages: unknown[] }> };
  currentStream: string;
  pendingToolCalls: Array<{ name: string; input?: unknown }>;
  activeCallIds: Set<string>;
}

/** Build a peek-ready SubagentModule with one synthetic subagent installed. */
function makeModuleWithSubagent(opts: {
  displayName: string;
  startedAt: number;
  lastActivityAt: number;
  currentStream?: string;
  pendingToolCalls?: Array<{ name: string; input?: unknown }>;
  status?: 'running' | 'completed' | 'failed';
}): SubagentModule {
  const mod = new SubagentModule();
  const live: FakeLiveState = {
    frameworkAgentName: `fw-${opts.displayName}`,
    displayName: opts.displayName,
    systemPrompt: 'test',
    // Minimal stub — peekOne wraps compile() in try/catch and treats failures as
    // "context manager mid-modification, return what we have," so this is fine.
    contextManager: { compile: async () => ({ messages: [] }) },
    currentStream: opts.currentStream ?? '',
    pendingToolCalls: opts.pendingToolCalls ?? [],
    activeCallIds: new Set(),
  };
  const entry: ActiveSubagent = {
    name: opts.displayName,
    type: 'spawn',
    task: 'test-task',
    status: opts.status ?? 'running',
    startedAt: opts.startedAt,
    lastActivityAt: opts.lastActivityAt,
    toolCallsCount: 0,
    findingsCount: 0,
  };

  // `liveSubagents` is private — go around the visibility modifier. The map is
  // the canonical source for peek; we keep the test's surface minimal by
  // skipping the spawn/fork wiring.
  (mod as unknown as { liveSubagents: Map<string, FakeLiveState> }).liveSubagents.set(
    opts.displayName,
    live,
  );
  // activeSubagents is `readonly` (re-binding the Map is what's forbidden), so
  // mutating it directly is fine.
  mod.activeSubagents.set(`entry-${opts.displayName}`, entry);
  return mod;
}

describe('SubagentModule.peek — F2 dual-clock zombie predicate', () => {
  test('healthy long-running scout is NOT zombie (lastActivityAt fresh)', async () => {
    // Productive scout 5 minutes in, last bumped activity 5s ago, currently
    // between an inference round and its first token. Pre-fix: peek reports
    // isZombie=true because elapsedMs from startedAt is 5min > 30s. Post-fix:
    // peek consults lastActivityAt, sees fresh activity, reports isZombie=false.
    const now = Date.now();
    const mod = makeModuleWithSubagent({
      displayName: 'scout',
      startedAt: now - 5 * 60_000,
      lastActivityAt: now - 5_000,
    });
    const [snap] = await mod.peek('scout');
    expect(snap).toBeDefined();
    expect(snap!.isZombie).toBe(false);
  });

  test('genuinely stuck subagent IS zombie (lastActivityAt stale, no stream/tools)', async () => {
    // Activity stopped 5 minutes ago with no current stream and no pending
    // tools — the case the reaper exists to catch. Silence picked well above
    // both 30s (old) and 120s (post-F3) thresholds so the test stays valid
    // regardless of future threshold tuning.
    const now = Date.now();
    const mod = makeModuleWithSubagent({
      displayName: 'stuck',
      startedAt: now - 10 * 60_000,
      lastActivityAt: now - 5 * 60_000,
    });
    const [snap] = await mod.peek('stuck');
    expect(snap!.isZombie).toBe(true);
  });

  test('subagent currently streaming is NOT zombie even with old lastActivityAt', async () => {
    // currentStream non-empty short-circuits the predicate regardless of clocks.
    const now = Date.now();
    const mod = makeModuleWithSubagent({
      displayName: 'streaming',
      startedAt: now - 10 * 60_000,
      lastActivityAt: now - 5 * 60_000,
      currentStream: 'tokens flowing',
    });
    const [snap] = await mod.peek('streaming');
    expect(snap!.isZombie).toBe(false);
  });

  test('subagent with pending tool calls is NOT zombie', async () => {
    // pendingToolCalls non-empty also short-circuits — agent is awaiting tool
    // results, not stuck.
    const now = Date.now();
    const mod = makeModuleWithSubagent({
      displayName: 'awaiting-tools',
      startedAt: now - 10 * 60_000,
      lastActivityAt: now - 5 * 60_000,
      pendingToolCalls: [{ name: 'files--read', input: { path: '/x' } }],
    });
    const [snap] = await mod.peek('awaiting-tools');
    expect(snap!.isZombie).toBe(false);
  });

  test('completed subagent is never reported as zombie', async () => {
    const now = Date.now();
    const mod = makeModuleWithSubagent({
      displayName: 'done',
      startedAt: now - 10 * 60_000,
      lastActivityAt: now - 5 * 60_000,
      status: 'completed',
    });
    const [snap] = await mod.peek('done');
    expect(snap!.isZombie).toBe(false);
  });
});
