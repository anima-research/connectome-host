/**
 * Postmortem 2026-05-28 F3: reaper's guard does not cover the
 * "request in flight, awaiting first token" window.
 *
 * Today's reap guard is `!live.currentStream && pendingToolCalls.length === 0`.
 * At inference:started and inference:stream_resumed, both are cleared. The
 * agent then sits with the guard open while the next LLM request is on the
 * wire. With Opus on 100–165K-token contexts under rate-limited MCP tools,
 * single-round TTFT routinely exceeds 30s, and the periodic reaper executes
 * mid-request even though the agent is genuinely progressing.
 *
 * Forensic signature in production: every reaped scout's last message in the
 * Chronicle store is an unconsumed `tool_result` — i.e., tool results came
 * back, stream_resumed cleared the guards, the next request was dispatched,
 * the reaper struck before the first token.
 *
 * Tests:
 *   1) reaper does NOT cancel an entry with `requestInFlightSince` set, even
 *      when lastActivityAt is older than the threshold.
 *   2) reaper DOES cancel a genuinely silent entry (control — proves the
 *      threshold path is still alive).
 *   3) Lifecycle: trace events set/clear `requestInFlightSince` on the live
 *      subagent state via the module's onTrace handler.
 */
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
  /** Populated when an inference request has been dispatched but no token
   *  has arrived yet. The reaper must treat this as a protected state. */
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

/** Captures the trace handler that SubagentModule.setFramework registers, so
 *  the lifecycle test can fire events without spinning up the full framework. */
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
    // Postmortem scenario: stream_resumed fired, currentStream + pendingToolCalls
    // cleared, the next LLM round is on the wire. lastActivityAt is frozen at
    // the moment of stream_resumed dispatch. TTFT is 45s — pre-fix the reaper
    // would strike mid-request because all of (!currentStream, no pending tools,
    // silentMs > threshold) hold. With the in-flight guard, the agent is left
    // alone.
    const now = Date.now();
    const mod = new SubagentModule();
    const { entry } = installSubagent(mod, {
      displayName: 'opus-in-flight',
      startedAt: now - 5 * 60_000,
      lastActivityAt: now - 3 * 60_000,        // well past any threshold
      requestInFlightSince: now - 3 * 60_000,  // request dispatched, no token yet
    });

    const reclaimed = (mod as unknown as { reclaimZombieSlots: () => number })
      .reclaimZombieSlots();

    expect(reclaimed).toBe(0);
    expect(entry.status).toBe('running');
  });

  test('reaper DOES cancel a genuinely silent agent (control)', () => {
    // Same staleness, but no request in flight — this is the "stuck" case the
    // reaper exists to clean up. 5 min silence exceeds both the pre- and
    // post-fix thresholds, so this test stays valid if the threshold is
    // tuned in either direction.
    const now = Date.now();
    const mod = new SubagentModule();
    const { entry } = installSubagent(mod, {
      displayName: 'genuinely-stuck',
      startedAt: now - 10 * 60_000,
      lastActivityAt: now - 5 * 60_000,
    });

    const reclaimed = (mod as unknown as { reclaimZombieSlots: () => number })
      .reclaimZombieSlots();

    expect(reclaimed).toBe(1);
    // Postmortem 2026-05-28 P1 #4: zombie-reaped subagents land in
    // 'cancelled' (terminal-but-benign), not 'failed'. Aligns the
    // SubagentModule's terminal state with the reducer's split between
    // genuine faults (inference:failed) and benign cancels.
    expect(entry.status).toBe('cancelled');
  });

  test('peek.isZombie also respects requestInFlightSince', async () => {
    // The peek surface drives the orchestrator's perception. Postmortem F2 was
    // about dual clocks; F3 is the same shape: a healthy in-flight agent must
    // not report isZombie=true.
    const now = Date.now();
    const mod = new SubagentModule();
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
    const mod = new SubagentModule();
    const { live } = installSubagent(mod, {
      displayName: 'lc',
      frameworkAgentName: 'fw-lc',
      startedAt: now - 10_000,
      lastActivityAt: now - 10_000,
    });
    expect(live.requestInFlightSince).toBeUndefined();

    const fake = makeTraceCapturingFramework();
    // setFramework registers the onTrace handler. Cast: our fake satisfies the
    // surface SubagentModule uses at registration time.
    mod.setFramework(fake.framework as never);

    fake.fire({ type: 'inference:started', agentName: 'fw-lc', timestamp: Date.now() } as never);
    expect(typeof live.requestInFlightSince).toBe('number');
  });

  test('lifecycle: first inference:tokens clears requestInFlightSince', () => {
    const now = Date.now();
    const mod = new SubagentModule();
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
    // After a tool round, the framework emits stream_resumed and dispatches a
    // new request. This is the gap the postmortem traced reaps to.
    const now = Date.now();
    const mod = new SubagentModule();
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
