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

function makeModuleWithSubagent(opts: {
  displayName: string;
  startedAt: number;
  lastActivityAt: number;
  currentStream?: string;
  pendingToolCalls?: Array<{ name: string; input?: unknown }>;
  status?: 'running' | 'completed' | 'failed';
}): SubagentModule {
  const mod = new SubagentModule({ provider: 'mock' });
  const live: FakeLiveState = {
    frameworkAgentName: `fw-${opts.displayName}`,
    displayName: opts.displayName,
    systemPrompt: 'test',
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

  (mod as unknown as { liveSubagents: Map<string, FakeLiveState> }).liveSubagents.set(
    opts.displayName,
    live,
  );
  // `readonly` stops re-binding the field, not changes to the Map it holds.
  mod.activeSubagents.set(`entry-${opts.displayName}`, entry);
  return mod;
}

describe('SubagentModule.peek — F2 dual-clock zombie predicate', () => {
  test('healthy long-running scout is NOT zombie (lastActivityAt fresh)', async () => {
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
