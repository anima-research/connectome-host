import { describe, test, expect } from 'bun:test';
import {
  SubagentModule,
  type ActiveSubagent,
} from '../src/modules/subagent-module.js';
import type { TraceEvent } from '@animalabs/agent-framework';

interface FakeLiveState {
  frameworkAgentName: string;
  displayName: string;
  systemPrompt: string;
  contextManager: { compile: () => Promise<{ messages: unknown[] }> };
  currentStream: string;
  pendingToolCalls: Array<{ name: string; input?: unknown }>;
  activeCallIds: Set<string>;
  requestInFlightSince?: number;
}

function installSubagent(
  mod: SubagentModule,
  opts: {
    displayName: string;
    frameworkAgentName?: string;
    startedAt: number;
    lastActivityAt: number;
    currentStream?: string;
    pendingToolCalls?: Array<{ name: string; input?: unknown }>;
    requestInFlightSince?: number;
    status?: 'running' | 'completed' | 'failed';
  },
): { live: FakeLiveState; entry: ActiveSubagent } {
  const frameworkAgentName = opts.frameworkAgentName ?? `fw-${opts.displayName}`;
  const live: FakeLiveState = {
    frameworkAgentName,
    displayName: opts.displayName,
    systemPrompt: 'test',
    contextManager: { compile: async () => ({ messages: [] }) },
    currentStream: opts.currentStream ?? '',
    pendingToolCalls: opts.pendingToolCalls ?? [],
    activeCallIds: new Set(),
    requestInFlightSince: opts.requestInFlightSince,
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
  const privateView = mod as unknown as {
    liveSubagents: Map<string, FakeLiveState>;
    frameworkNameIndex: Map<string, string>;
  };
  privateView.liveSubagents.set(opts.displayName, live);
  privateView.frameworkNameIndex.set(frameworkAgentName, opts.displayName);
  mod.activeSubagents.set(`entry-${opts.displayName}`, entry);
  return { live, entry };
}

function makeTraceCapturingFramework(): {
  framework: { onTrace: (cb: (e: TraceEvent) => void) => void };
  fire: (event: TraceEvent) => void;
} {
  let captured: ((e: TraceEvent) => void) | null = null;
  return {
    framework: {
      onTrace(cb: (e: TraceEvent) => void) {
        captured = cb;
      },
    },
    fire(event: TraceEvent) {
      if (!captured) throw new Error('onTrace was never called');
      captured(event);
    },
  };
}

describe('SubagentModule reaper — F3 request-in-flight protection', () => {
  test('reaper does NOT cancel an agent with a request in flight', () => {
    const now = Date.now();
    const mod = new SubagentModule({ provider: 'mock' });
    const { entry } = installSubagent(mod, {
      displayName: 'opus-in-flight',
      startedAt: now - 5 * 60_000,
      lastActivityAt: now - 3 * 60_000,
      requestInFlightSince: now - 3 * 60_000,
    });

    const reclaimed = (mod as unknown as { reclaimZombieSlots: () => number })
      .reclaimZombieSlots();

    expect(reclaimed).toBe(0);
    expect(entry.status).toBe('running');
  });

  test('reaper DOES cancel a genuinely silent agent (control)', () => {
    const now = Date.now();
    const mod = new SubagentModule({ provider: 'mock' });
    const { entry } = installSubagent(mod, {
      displayName: 'genuinely-stuck',
      startedAt: now - 10 * 60_000,
      lastActivityAt: now - 5 * 60_000,
    });

    const reclaimed = (mod as unknown as { reclaimZombieSlots: () => number })
      .reclaimZombieSlots();

    expect(reclaimed).toBe(1);
    expect(entry.status).toBe('cancelled');
  });

  test('peek.isZombie also respects requestInFlightSince', async () => {
    const now = Date.now();
    const mod = new SubagentModule({ provider: 'mock' });
    installSubagent(mod, {
      displayName: 'opus-in-flight',
      startedAt: now - 5 * 60_000,
      lastActivityAt: now - 3 * 60_000,
      requestInFlightSince: now - 3 * 60_000,
    });
    const [snap] = await mod.peek('opus-in-flight');
    expect(snap!.isZombie).toBe(false);
  });

  test('lifecycle: inference:started sets requestInFlightSince', () => {
    const now = Date.now();
    const mod = new SubagentModule({ provider: 'mock' });
    const { live } = installSubagent(mod, {
      displayName: 'lc',
      frameworkAgentName: 'fw-lc',
      startedAt: now - 10_000,
      lastActivityAt: now - 10_000,
    });
    expect(live.requestInFlightSince).toBeUndefined();

    const fake = makeTraceCapturingFramework();
    mod.setFramework(fake.framework as never);

    fake.fire({ type: 'inference:started', agentName: 'fw-lc', timestamp: Date.now() } as never);
    expect(typeof live.requestInFlightSince).toBe('number');
  });

  test('lifecycle: first inference:tokens clears requestInFlightSince', () => {
    const now = Date.now();
    const mod = new SubagentModule({ provider: 'mock' });
    const { live } = installSubagent(mod, {
      displayName: 'lc2',
      frameworkAgentName: 'fw-lc2',
      startedAt: now - 10_000,
      lastActivityAt: now - 10_000,
      requestInFlightSince: now - 5_000,
    });

    const fake = makeTraceCapturingFramework();
    mod.setFramework(fake.framework as never);

    fake.fire({ type: 'inference:tokens', agentName: 'fw-lc2', content: 'hello', timestamp: Date.now() } as never);
    expect(live.requestInFlightSince).toBeUndefined();
  });

  test('lifecycle: inference:stream_resumed sets requestInFlightSince again', () => {
    // After a tool round, agent-framework emits stream_resumed and sends the
    // next request.
    const now = Date.now();
    const mod = new SubagentModule({ provider: 'mock' });
    const { live } = installSubagent(mod, {
      displayName: 'lc3',
      frameworkAgentName: 'fw-lc3',
      startedAt: now - 60_000,
      lastActivityAt: now - 60_000,
    });

    const fake = makeTraceCapturingFramework();
    mod.setFramework(fake.framework as never);

    fake.fire({ type: 'inference:stream_resumed', agentName: 'fw-lc3', timestamp: Date.now() } as never);
    expect(typeof live.requestInFlightSince).toBe('number');
  });
});
