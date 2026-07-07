/**
 * Fragility audit Jul 2026 — SubagentModule slot accounting, result-stash
 * hygiene, duplicate-name tracking, and dead-parent delivery.
 *
 * 2.4  Zombie reclaim decremented activeConcurrent directly AND the
 *      reclaimed run's finally called releaseSlot again → counter drifted
 *      one below the true active count → over-admission.
 * 2.5  returnedResults was keyed by display name and only deleted on the
 *      success path → leaks + cross-contamination between same-named runs.
 * 2.6  liveSubagents & friends are keyed by unprotected display name; an
 *      older completing run destroyed a newer same-named run's tracking.
 * 2.7  deliverAsyncResult pushed into the PRIMARY agent's store and fired
 *      an inference-request even when the spawning (ephemeral) parent was
 *      already gone — polluting the root context.
 *
 * Harness pattern mirrors test/subagent-async-timeout.test.ts: stub
 * runEphemeralToCompletion so each run's completion is test-controlled.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module, ToolCall } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { SubagentModule, type SubagentResult } from '../src/modules/subagent-module.js';

interface LiveView {
  frameworkAgentName: string;
  currentStream: string;
  pendingToolCalls: unknown[];
  requestInFlightSince?: number;
}

type InternalSubagent = SubagentModule & {
  asyncHandles: Map<string, { promise: Promise<SubagentResult> }>;
  liveSubagents: Map<string, LiveView>;
  frameworkNameIndex: Map<string, string>;
  returnedResults: Map<string, string>;
  reclaimZombieSlots: () => number;
};

/**
 * Harness where each ephemeral run's completion is resolved manually via
 * `controllers` (keyed by framework agent name). Never-completed runs model
 * long-running/stuck subagents.
 */
async function makeControlledHarness(opts: { maxConcurrent?: number } = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sub-slots-'));
  const adapter = new MockAdapter({ defaultResponse: 'ok' });
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
  const subagent = new SubagentModule({
    parentAgentName: 'parent',
    defaultModel: 'mock',
    defaultMaxTokens: 256,
    maxConcurrent: opts.maxConcurrent ?? 5,
    maxRetries: 0,
  });
  const framework = await AgentFramework.create({
    storePath: join(tmpDir, 'store'),
    membrane,
    agents: [{ name: 'parent', model: 'mock', systemPrompt: 'parent', maxTokens: 256 }],
    modules: [subagent as unknown as Module],
  });

  const controllers = new Map<string, (r: { speech: string; toolCallsCount: number }) => void>();
  const fw = framework as unknown as {
    runEphemeralToCompletion: (agent: unknown, cm: unknown) => Promise<{ speech: string; toolCallsCount: number }>;
    agents: Map<string, unknown>;
  };
  fw.runEphemeralToCompletion = (agent: unknown) => {
    const a = agent as { name: string };
    fw.agents.set(a.name, agent);
    return new Promise((resolve) => {
      controllers.set(a.name, (r) => {
        fw.agents.delete(a.name);
        resolve(r);
      });
    });
  };

  subagent.setFramework(framework);
  framework.start();

  return {
    framework,
    subagent,
    internal: subagent as unknown as InternalSubagent,
    controllers,
    cleanup: async () => {
      try { subagent.cancelAll(); } catch { /* noop */ }
      await new Promise(r => setTimeout(r, 50));
      try { await framework.stop(); } catch { /* noop */ }
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    },
  };
}

function makeToolCall(name: string, input: Record<string, unknown>, caller = 'parent'): ToolCall {
  return {
    id: `test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    input,
    callerAgentName: caller,
  };
}

async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/** Make a running subagent look like a zombie to the reaper. */
function zombify(internal: InternalSubagent, displayName: string, entryKey: string): void {
  const entry = internal.activeSubagents.get(entryKey);
  if (!entry) throw new Error(`no activeSubagents entry ${entryKey}`);
  entry.lastActivityAt = Date.now() - 10 * 60_000;
  const live = internal.liveSubagents.get(displayName) as LiveView | undefined;
  if (!live) throw new Error(`no live state for ${displayName}`);
  live.currentStream = '';
  live.pendingToolCalls = [];
  live.requestInFlightSince = undefined;
}

describe('zombie reclaim does not double-release the concurrency slot (audit 2.4)', () => {
  test('after reclaiming A while B still runs, active count equals the real running count', async () => {
    const { subagent, internal, cleanup } = await makeControlledHarness({ maxConcurrent: 5 });
    try {
      // Two async spawns, neither completes on its own.
      const ackA = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'zombie-a', systemPrompt: 'sp', task: 't',
      }));
      const ackB = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'healthy-b', systemPrompt: 'sp', task: 't',
      }));
      expect(ackA.success).toBe(true);
      expect(ackB.success).toBe(true);
      await waitFor(
        () => subagent.getConcurrencyStatus().active === 2,
        2_000,
        'both spawns holding slots',
      );
      const promiseA = internal.asyncHandles.get('zombie-a')!.promise;

      // A goes silent; B stays fresh (its lastActivityAt is recent).
      zombify(internal, 'zombie-a', 'spawn-zombie-a');

      const reclaimed = internal.reclaimZombieSlots();
      expect(reclaimed).toBe(1);

      // Let A's run settle (SubagentTerminated path) so its finally fires.
      await promiseA;
      await new Promise(r => setTimeout(r, 50));

      // B is still genuinely running: the counter must say exactly 1.
      // Pre-fix: reclaim decremented once and A's finally decremented again
      // → 0 while B still held a real slot (over-admission by one).
      expect(subagent.getConcurrencyStatus().active).toBe(1);
    } finally {
      await cleanup();
    }
  }, 10_000);
});

describe('returnedResults stash hygiene (audit 2.5)', () => {
  test('stash is dropped when a run is cancelled, and a later same-named run gets its own result', async () => {
    const { subagent, internal, controllers, cleanup } = await makeControlledHarness();
    try {
      // Run 1: spawn "x", stash "OLD" via subagent--return, then cancel.
      const ack1 = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'x', systemPrompt: 'sp', task: 't',
      }));
      expect(ack1.success).toBe(true);
      await waitFor(() => internal.liveSubagents.has('x'), 2_000, 'run 1 live');
      const fw1 = internal.liveSubagents.get('x')!.frameworkAgentName;
      const promise1 = internal.asyncHandles.get('x')!.promise;

      const ret1 = await subagent.handleToolCall(makeToolCall('return', { result: 'OLD' }, fw1));
      expect(ret1.success).toBe(true);
      expect(internal.returnedResults.get(fw1)).toBe('OLD');

      subagent.cancelSubagent('x');
      const result1 = await promise1;
      expect(result1.summary).toMatch(/Stopped by user/);

      // Pre-fix: the "OLD" stash survived the cancel forever.
      expect(internal.returnedResults.size).toBe(0);

      // Run 2: spawn "x" again, stash "NEW", complete normally.
      const ack2 = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'x', systemPrompt: 'sp', task: 't2',
      }));
      expect(ack2.success).toBe(true);
      await waitFor(() => internal.liveSubagents.has('x'), 2_000, 'run 2 live');
      const fw2 = internal.liveSubagents.get('x')!.frameworkAgentName;
      expect(fw2).not.toBe(fw1);
      const promise2 = internal.asyncHandles.get('x')!.promise;

      const ret2 = await subagent.handleToolCall(makeToolCall('return', { result: 'NEW' }, fw2));
      expect(ret2.success).toBe(true);

      controllers.get(fw2)!({ speech: '', toolCallsCount: 1 });
      const result2 = await promise2;
      expect(result2.summary).toContain('NEW');
      expect(result2.summary).not.toContain('OLD');
      expect(internal.returnedResults.size).toBe(0);
    } finally {
      await cleanup();
    }
  }, 10_000);
});

describe('duplicate display names (audit 2.6)', () => {
  test('completing the first same-named run does not destroy the second run\'s live tracking', async () => {
    const { subagent, internal, controllers, cleanup } = await makeControlledHarness();
    try {
      // Run 1.
      await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'dup', systemPrompt: 'sp', task: 'first',
      }));
      await waitFor(() => internal.liveSubagents.has('dup'), 2_000, 'run 1 live');
      const fw1 = internal.liveSubagents.get('dup')!.frameworkAgentName;
      const promise1 = internal.asyncHandles.get('dup')!.promise;

      // Run 2, same display name, registered while run 1 is still going.
      await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'dup', systemPrompt: 'sp', task: 'second',
      }));
      await waitFor(
        () => internal.liveSubagents.get('dup')?.frameworkAgentName !== fw1,
        2_000,
        'run 2 replaced the live entry',
      );
      const fw2 = internal.liveSubagents.get('dup')!.frameworkAgentName;
      const promise2 = internal.asyncHandles.get('dup')!.promise;

      // Complete run 1. Pre-fix its unregisterLive deleted liveSubagents['dup']
      // outright, destroying run 2's tracking (peek, lastActivityAt bumps).
      controllers.get(fw1)!({ speech: 'first done', toolCallsCount: 0 });
      await promise1;
      await new Promise(r => setTimeout(r, 50));

      expect(internal.liveSubagents.has('dup')).toBe(true);
      expect(internal.liveSubagents.get('dup')!.frameworkAgentName).toBe(fw2);
      expect(internal.frameworkNameIndex.get(fw2)).toBe('dup');
      // Run 1's own framework index entry is gone.
      expect(internal.frameworkNameIndex.has(fw1)).toBe(false);

      // peek still sees the second run.
      const snaps = await subagent.peek('dup');
      expect(snaps.length).toBe(1);

      controllers.get(fw2)!({ speech: 'second done', toolCallsCount: 0 });
      await promise2;
      await new Promise(r => setTimeout(r, 50));
      // Now the second run's completion does tear the entry down.
      expect(internal.liveSubagents.has('dup')).toBe(false);
    } finally {
      await cleanup();
    }
  }, 10_000);
});

describe('async delivery to a dead parent is dropped (audit 2.7)', () => {
  interface DeliveryView {
    ctx: { addMessage: (...a: unknown[]) => void; pushEvent: (e: unknown) => void } | null;
    framework: { getAgent: (n: string) => unknown } | null;
    deliverAsyncResult: (name: string, result: SubagentResult, parent: string) => void;
    deliverAsyncError: (name: string, err: unknown, parent: string) => void;
  }

  function makeDeliveryFixture(agentExists: boolean, dataDir?: string) {
    const mod = new SubagentModule(dataDir ? { dataDir } : {});
    const added: unknown[][] = [];
    const events: unknown[] = [];
    const view = mod as unknown as DeliveryView;
    view.ctx = {
      addMessage: (...a: unknown[]) => { added.push(a); },
      pushEvent: (e: unknown) => { events.push(e); },
    };
    view.framework = {
      getAgent: (_n: string) => (agentExists ? { name: _n } : undefined),
    };
    return { view, added, events };
  }

  const result: SubagentResult = { summary: 'findings', findings: [], issues: [], toolCallsCount: 0 };

  test('result for a vanished ephemeral parent: no root-context message, no inference-request', () => {
    const { view, added, events } = makeDeliveryFixture(false);
    view.deliverAsyncResult('child', result, 'fork-ghost-d2-12345');
    expect(added.length).toBe(0);
    expect(events.length).toBe(0);
  });

  test('error for a vanished ephemeral parent is also dropped', () => {
    const { view, added, events } = makeDeliveryFixture(false);
    view.deliverAsyncError('child', new Error('boom'), 'fork-ghost-d2-12345');
    expect(added.length).toBe(0);
    expect(events.length).toBe(0);
  });

  test('result for a live parent is still delivered with an inference-request', () => {
    const { view, added, events } = makeDeliveryFixture(true);
    view.deliverAsyncResult('child', result, 'parent');
    expect(added.length).toBe(1);
    expect(events.length).toBe(1);
    expect((events[0] as { agentName: string }).agentName).toBe('parent');
  });

  test('error for a live parent is still delivered', () => {
    const { view, added, events } = makeDeliveryFixture(true);
    view.deliverAsyncError('child', new Error('boom'), 'parent');
    expect(added.length).toBe(1);
    expect(events.length).toBe(1);
  });

  test('a dropped result is DEAD-LETTERED to dropped-results.jsonl (recoverable, not lost)', () => {
    // Gating the delivery is right (polluting the root context was worse), but
    // a console.error records only THAT a result dropped, not the result — it
    // could be ten minutes of Opus at 165K context. Dead-letter it instead.
    const dir = mkdtempSync(join(tmpdir(), 'sub-deadletter-'));
    const originalError = console.error;
    console.error = () => { /* silence the expected drop log */ };
    try {
      const { view, added, events } = makeDeliveryFixture(false, dir);
      const bigResult: SubagentResult = {
        summary: 'a very expensive synthesis that must not vanish',
        findings: [], issues: [], toolCallsCount: 42,
      };
      view.deliverAsyncResult('child', bigResult, 'fork-ghost-d2-12345');
      // Still dropped from the live context…
      expect(added.length).toBe(0);
      expect(events.length).toBe(0);
      // …but recoverable on disk.
      const dlqPath = join(dir, 'dropped-results.jsonl');
      expect(existsSync(dlqPath)).toBe(true);
      const line = readFileSync(dlqPath, 'utf-8').trim().split('\n')[0];
      const rec = JSON.parse(line) as Record<string, unknown>;
      expect(rec.kind).toBe('result');
      expect(rec.subagent).toBe('child');
      expect(rec.parentAgentName).toBe('fork-ghost-d2-12345');
      expect(rec.summary).toBe(bigResult.summary);
      expect(rec.toolCallsCount).toBe(42);
    } finally {
      console.error = originalError;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a dropped error is dead-lettered too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sub-deadletter-'));
    const originalError = console.error;
    console.error = () => { /* silence */ };
    try {
      const { view } = makeDeliveryFixture(false, dir);
      view.deliverAsyncError('child', new Error('kaboom'), 'fork-ghost-d2-999');
      const rec = JSON.parse(
        readFileSync(join(dir, 'dropped-results.jsonl'), 'utf-8').trim().split('\n')[0],
      ) as Record<string, unknown>;
      expect(rec.kind).toBe('error');
      expect(rec.error).toBe('kaboom');
    } finally {
      console.error = originalError;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a result landing AFTER module stop (ctx null) is dead-lettered, not silently dropped (NEW-2)', () => {
    // ctx is nulled at module stop(). An async subagent completing after
    // shutdown began is precisely when in-flight results become undeliverable
    // — the `!this.ctx` early return must dead-letter BEFORE returning, not
    // vanish the work with no record.
    const dir = mkdtempSync(join(tmpdir(), 'sub-deadletter-'));
    try {
      const { view } = makeDeliveryFixture(true, dir);
      view.ctx = null; // simulate module stop
      const bigResult: SubagentResult = {
        summary: 'expensive synthesis that landed just after shutdown',
        findings: [], issues: [], toolCallsCount: 7,
      };
      view.deliverAsyncResult('child', bigResult, 'parent');
      const rec = JSON.parse(
        readFileSync(join(dir, 'dropped-results.jsonl'), 'utf-8').trim().split('\n')[0],
      ) as Record<string, unknown>;
      expect(rec.kind).toBe('result');
      expect(rec.reason).toBe('module-stopped');
      expect(rec.subagent).toBe('child');
      expect(rec.summary).toBe(bigResult.summary);
      expect(rec.toolCallsCount).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an error landing AFTER module stop (ctx null) is dead-lettered too (NEW-2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sub-deadletter-'));
    try {
      const { view } = makeDeliveryFixture(true, dir);
      view.ctx = null; // simulate module stop
      view.deliverAsyncError('child', new Error('post-stop boom'), 'parent');
      const rec = JSON.parse(
        readFileSync(join(dir, 'dropped-results.jsonl'), 'utf-8').trim().split('\n')[0],
      ) as Record<string, unknown>;
      expect(rec.kind).toBe('error');
      expect(rec.reason).toBe('module-stopped');
      expect(rec.error).toBe('post-stop boom');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
