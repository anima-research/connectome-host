/**
 * LivenessTracker + unansweredSince: the always-visible "is the MCPL link up
 * and is the agent answering" strip. Pure folds over trace events.
 */
import { describe, test, expect } from 'bun:test';
import { LivenessTracker, unansweredSince } from '../src/web/liveness.js';

const MIN = 60_000;

const incoming = (serverId: string, timestamp: number, triggerInference?: boolean) => ({
  type: 'process:received',
  timestamp,
  processEvent: { type: 'mcpl:channel-incoming', serverId, triggerInference },
});

describe('LivenessTracker', () => {
  test('records inbound and wake times per server; ignores unrelated events', () => {
    const t = new LivenessTracker(0);
    expect(t.observe(incoming('chat', 10, false))).toBe(true);
    expect(t.observe(incoming('chat', 20, true))).toBe(true);
    expect(t.observe({ type: 'process:received', timestamp: 30, processEvent: { type: 'user-message' } })).toBe(false);
    expect(t.observe({ type: 'inference:tokens', agentName: 'a', timestamp: 40 })).toBe(false);
    expect(t.observe({
      type: 'process:received', timestamp: 50,
      processEvent: { type: 'mcpl:push-event', serverId: 'feed', triggerInference: false },
    })).toBe(true);

    const snap = t.snapshot([{ id: 'chat', connected: true }, { id: 'feed', connected: false, retrying: true }], [], 99);
    expect(snap.at).toBe(99);
    expect(snap.servers).toEqual([
      { id: 'chat', connected: true, lastInboundAt: 20, lastWakeAt: 20 },
      { id: 'feed', connected: false, retrying: true, lastInboundAt: 50 },
    ]);
  });

  test('connect failure is recorded (clipped) and cleared on reconnect', () => {
    const t = new LivenessTracker(0);
    t.observe({ type: 'mcpl:server-connect-failed', serverId: 'chat', error: 'x'.repeat(500), attempt: 4, willRetry: true, timestamp: 5 });
    let s = t.snapshot([{ id: 'chat', connected: false }], []).servers[0]!;
    expect(s.lastError).toEqual({ message: 'x'.repeat(200), attempt: 4, willRetry: true, at: 5 });
    t.observe({ type: 'mcpl:server-reconnected', serverId: 'chat', attempts: 5, timestamp: 6 });
    s = t.snapshot([{ id: 'chat', connected: true }], []).servers[0]!;
    expect(s.lastError).toBeUndefined();
  });

  test('tracks agent turn start / completion / failure; only listed agents appear', () => {
    const t = new LivenessTracker(0);
    t.observe({ type: 'inference:started', agentName: 'main', timestamp: 1 });
    t.observe({ type: 'inference:completed', agentName: 'main', timestamp: 2 });
    t.observe({ type: 'inference:failed', agentName: 'main', error: 'boom', timestamp: 3 });
    t.observe({ type: 'inference:started', agentName: 'subagent-x', timestamp: 4 });
    const snap = t.snapshot([], ['main', 'idle']);
    expect(snap.agents).toEqual([
      { name: 'main', lastStartedAt: 1, lastCompletedAt: 2, lastFailedAt: 3, lastFailure: 'boom' },
      { name: 'idle' },
    ]);
  });
});

describe('unansweredSince', () => {
  const build = (wakeAt: number | undefined, agent: { lastStartedAt?: number; lastCompletedAt?: number }) => {
    const t = new LivenessTracker(0);
    if (wakeAt !== undefined) t.observe(incoming('chat', wakeAt, true));
    if (agent.lastStartedAt) t.observe({ type: 'inference:started', agentName: 'main', timestamp: agent.lastStartedAt });
    if (agent.lastCompletedAt) t.observe({ type: 'inference:completed', agentName: 'main', timestamp: agent.lastCompletedAt });
    const snap = t.snapshot([{ id: 'chat', connected: true }], ['main']);
    return { snap, agent: snap.agents[0]! };
  };

  test('warns when a wake has gone unanswered past the threshold', () => {
    const { snap, agent } = build(10 * MIN, { lastCompletedAt: 1 * MIN });
    expect(unansweredSince(snap, agent, 16 * MIN)).toBe(10 * MIN);
  });

  test('quiet within the threshold, or once the agent has started a turn', () => {
    let b = build(10 * MIN, { lastCompletedAt: 1 * MIN });
    expect(unansweredSince(b.snap, b.agent, 12 * MIN)).toBeUndefined();
    b = build(10 * MIN, { lastStartedAt: 10 * MIN + 1 });
    expect(unansweredSince(b.snap, b.agent, 60 * MIN)).toBeUndefined();
  });

  test('non-waking inbound traffic never warns', () => {
    const t = new LivenessTracker(0);
    t.observe(incoming('chat', 10 * MIN, false));
    const snap = t.snapshot([{ id: 'chat', connected: true }], ['main']);
    expect(unansweredSince(snap, snap.agents[0]!, 60 * MIN)).toBeUndefined();
  });
});
