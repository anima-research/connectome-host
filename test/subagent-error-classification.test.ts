/**
 * Fragility audit Jul 2026 — error classification in SubagentModule.
 *
 * 2.3  isTransientError / isRateLimitError used bare substring checks:
 *      '502' matched digits inside token counts ("~195023 tokens"), 'rate'
 *      matched "generate"/"moderate". Deterministic failures (oversized
 *      prompts) were retried at full cost, and unrelated messages tripped
 *      the rate-limit halving logic.
 * 2.11 The module's own withTimeout rejection ("timed out") was classified
 *      transient, so a work-budget exceedance restarted the whole task up
 *      to maxRetries times — timeout amplification.
 * 2.12 The reaper and the peek predicate each had their own
 *      ZOMBIE_THRESHOLD_MS = 120_000 copy; now single-sourced as an export.
 *
 * The classifiers are private; tests reach them via the same cast-around-
 * visibility pattern the peek/reaper tests use.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module, ToolCall } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import {
  SubagentModule,
  SubagentExecutionTimeout,
  ZOMBIE_THRESHOLD_MS,
  type ActiveSubagent,
} from '../src/modules/subagent-module.js';

type ClassifierView = {
  isTransientError: (err: Error) => boolean;
  isRateLimitError: (err: unknown) => boolean;
};

function classifiers(): ClassifierView {
  return new SubagentModule() as unknown as ClassifierView;
}

describe('isTransientError (audit 2.3)', () => {
  test('"Prompt too large … ~195023 tokens" is NOT transient (old code matched the 502 inside 195023)', () => {
    const c = classifiers();
    const err = new Error(
      'Prompt too large for subagent scout: ~195023 tokens (limit: 190000). Reduce context or task size.',
    );
    expect(c.isTransientError(err)).toBe(false);
  });

  test('genuine HTTP 5xx messages are still transient', () => {
    const c = classifiers();
    expect(c.isTransientError(new Error('HTTP 502 Bad Gateway'))).toBe(true);
    expect(c.isTransientError(new Error('Error: 503 Service Unavailable'))).toBe(true);
    expect(c.isTransientError(new Error('upstream returned status 529'))).toBe(true);
    expect(c.isTransientError(new Error('overloaded_error: Overloaded'))).toBe(true);
  });

  test('5xx digits embedded in longer numbers do not classify', () => {
    const c = classifiers();
    expect(c.isTransientError(new Error('processed 15023 records'))).toBe(false);
    expect(c.isTransientError(new Error('sequence 190000529123 rejected'))).toBe(false);
  });

  test('network-shaped errors are still transient', () => {
    const c = classifiers();
    expect(c.isTransientError(new Error('read ECONNRESET'))).toBe(true);
    expect(c.isTransientError(new Error('socket hang up'))).toBe(true);
    expect(c.isTransientError(new Error('stream aborted mid-flight'))).toBe(true);
    expect(c.isTransientError(new Error('request timed out waiting for headers'))).toBe(true);
  });

  test('typed status field wins over message sniffing', () => {
    const c = classifiers();
    const retryable = Object.assign(new Error('opaque provider failure'), { status: 529 });
    expect(c.isTransientError(retryable)).toBe(true);
    const permanent = Object.assign(new Error('network-ish wording but a 400'), { status: 400 });
    expect(c.isTransientError(permanent)).toBe(false);
  });

  test('plain application errors are not transient', () => {
    const c = classifiers();
    expect(c.isTransientError(new Error('Unknown tool: files--write'))).toBe(false);
    expect(c.isTransientError(new Error('Max subagent depth 3 reached'))).toBe(false);
  });
});

describe('isRateLimitError (audit 2.3)', () => {
  test('"failed to generate summary" is NOT a rate limit (old code matched "rate" in "generate")', () => {
    const c = classifiers();
    expect(c.isRateLimitError(new Error('failed to generate summary'))).toBe(false);
    expect(c.isRateLimitError(new Error('moderate load on server'))).toBe(false);
  });

  test('genuine rate-limit shapes still classify', () => {
    const c = classifiers();
    expect(c.isRateLimitError(new Error('rate_limit_error: Number of requests exceeded'))).toBe(true);
    expect(c.isRateLimitError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
    expect(c.isRateLimitError(new Error('Rate limit exceeded, retry later'))).toBe(true);
    expect(c.isRateLimitError(Object.assign(new Error('throttled'), { status: 429 }))).toBe(true);
  });

  test('429 embedded in a longer number does not classify', () => {
    const c = classifiers();
    expect(c.isRateLimitError(new Error('processed 14290 rows'))).toBe(false);
  });
});

describe('SubagentExecutionTimeout is never transient (audit 2.11)', () => {
  test('classifier returns false even though the message says "timed out"', () => {
    const c = classifiers();
    const err = new SubagentExecutionTimeout('scout', 50);
    expect(err.message).toMatch(/timed out/i);
    expect(c.isTransientError(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2.11 behavioural: a sync spawn that exceeds maxExecutionMs must fail once,
// not restart the whole task maxRetries times. Harness pattern mirrors
// test/subagent-async-timeout.test.ts (stub runEphemeralToCompletion, count
// createEphemeralAgent calls).
// ---------------------------------------------------------------------------

async function makeRetryCountHarness(opts: {
  maxExecutionMs: number;
  subagentRunMs: number;
  maxRetries: number;
}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sub-retrycount-'));
  const adapter = new MockAdapter({ defaultResponse: 'ok' });
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
  const subagent = new SubagentModule({
    parentAgentName: 'parent',
    defaultModel: 'mock',
    defaultMaxTokens: 256,
    maxExecutionMs: opts.maxExecutionMs,
    maxRetries: opts.maxRetries,
  });
  const framework = await AgentFramework.create({
    storePath: join(tmpDir, 'store'),
    membrane,
    agents: [{ name: 'parent', model: 'mock', systemPrompt: 'parent', maxTokens: 256 }],
    modules: [subagent as unknown as Module],
  });

  let ephemeralCreations = 0;
  const fw = framework as unknown as {
    createEphemeralAgent: (config: { name: string; [k: string]: unknown }) => Promise<unknown>;
    runEphemeralToCompletion: (agent: unknown, cm: unknown) => Promise<{ speech: string; toolCallsCount: number }>;
    agents: Map<string, unknown>;
  };
  const originalCreate = fw.createEphemeralAgent.bind(fw);
  fw.createEphemeralAgent = async (config) => {
    ephemeralCreations++;
    return originalCreate(config);
  };
  fw.runEphemeralToCompletion = (agent: unknown) => {
    const a = agent as { name: string };
    fw.agents.set(a.name, agent);
    return new Promise((resolve) => setTimeout(() => {
      fw.agents.delete(a.name);
      resolve({ speech: 'ok', toolCallsCount: 0 });
    }, opts.subagentRunMs));
  };

  subagent.setFramework(framework);
  framework.start();

  return {
    subagent,
    getCreations: () => ephemeralCreations,
    cleanup: async () => {
      try { await framework.stop(); } catch { /* noop */ }
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    },
  };
}

function makeToolCall(name: string, input: Record<string, unknown>): ToolCall {
  return {
    id: `test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    input,
    callerAgentName: 'parent',
  };
}

describe('execution timeout does not amplify into whole-task retries (audit 2.11)', () => {
  test('sync spawn with maxExecutionMs=50, work=200ms, maxRetries=2 → exactly one attempt', async () => {
    const { subagent, getCreations, cleanup } = await makeRetryCountHarness({
      maxExecutionMs: 50,
      subagentRunMs: 200,
      maxRetries: 2,
    });
    try {
      const res = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'budget-blower',
        systemPrompt: 'sp',
        task: 'work',
        sync: true,
      }));
      expect(res.success).toBe(false);
      expect(res.error ?? '').toMatch(/timed out/i);
      // Pre-fix: 3 attempts (1 + 2 retries). Post-fix: the budget timeout is
      // non-transient, so exactly one ephemeral agent is ever created.
      expect(getCreations()).toBe(1);
      // Let the orphaned stub work finish before teardown.
      await new Promise(r => setTimeout(r, 300));
    } finally {
      await cleanup();
    }
  }, 10_000);
});

// ---------------------------------------------------------------------------
// 2.12: reaper and peek share one exported ZOMBIE_THRESHOLD_MS.
// ---------------------------------------------------------------------------

interface FakeLiveState {
  frameworkAgentName: string;
  displayName: string;
  systemPrompt: string;
  contextManager: { compile: () => Promise<{ messages: unknown[] }> };
  currentStream: string;
  pendingToolCalls: Array<{ name: string; input?: unknown }>;
  activeCallIds: Set<string>;
}

function installSyntheticSubagent(mod: SubagentModule, displayName: string, silentMs: number): void {
  const now = Date.now();
  const live: FakeLiveState = {
    frameworkAgentName: `fw-${displayName}`,
    displayName,
    systemPrompt: 'test',
    contextManager: { compile: async () => ({ messages: [] }) },
    currentStream: '',
    pendingToolCalls: [],
    activeCallIds: new Set(),
  };
  const entry: ActiveSubagent = {
    name: displayName,
    type: 'spawn',
    task: 't',
    status: 'running',
    startedAt: now - silentMs - 60_000,
    lastActivityAt: now - silentMs,
    toolCallsCount: 0,
    findingsCount: 0,
  };
  (mod as unknown as { liveSubagents: Map<string, FakeLiveState> }).liveSubagents.set(displayName, live);
  mod.activeSubagents.set(`entry-${displayName}`, entry);
}

describe('ZOMBIE_THRESHOLD_MS is single-sourced (audit 2.12)', () => {
  test('exported constant exists and both predicates agree just above / below it', async () => {
    expect(typeof ZOMBIE_THRESHOLD_MS).toBe('number');
    expect(ZOMBIE_THRESHOLD_MS).toBeGreaterThan(0);

    // Just above threshold: peek says zombie, reaper reclaims.
    const above = new SubagentModule();
    installSyntheticSubagent(above, 'stale', ZOMBIE_THRESHOLD_MS + 5_000);
    const [staleSnap] = await above.peek('stale');
    expect(staleSnap!.isZombie).toBe(true);
    const reclaimedAbove = (above as unknown as { reclaimZombieSlots: () => number }).reclaimZombieSlots();
    expect(reclaimedAbove).toBe(1);

    // Comfortably below threshold: both predicates negative.
    const below = new SubagentModule();
    installSyntheticSubagent(below, 'fresh', Math.floor(ZOMBIE_THRESHOLD_MS / 2));
    const [freshSnap] = await below.peek('fresh');
    expect(freshSnap!.isZombie).toBe(false);
    const reclaimedBelow = (below as unknown as { reclaimZombieSlots: () => number }).reclaimZombieSlots();
    expect(reclaimedBelow).toBe(0);
  });
});
