/**
 * LivenessTracker + unansweredSince: the always-visible "is the MCPL link up
 * and is the agent answering" strip. Pure folds over trace events, driven
 * here with AF 0.18-shaped sequences (#145 review).
 */
import { describe, test, expect } from 'bun:test';
import { isBusy, LivenessTracker, unansweredSince, type LivenessAgent } from '../src/web/liveness.js';

const MIN = 60_000;

const incoming = (serverId: string, timestamp: number, triggerInference?: boolean, targetAgents?: string[]) => ({
  type: 'process:received',
  timestamp,
  processEvent: { type: 'mcpl:channel-incoming', serverId, triggerInference, ...(targetAgents ? { targetAgents } : {}) },
});
const started = (agentName: string, timestamp: number) => ({ type: 'inference:started', agentName, timestamp });

/** Tracker whose broadcast set is `broadcast` (the module supplies the real one). */
const tracker = (broadcast: string[] = ['main']) =>
  new LivenessTracker({ now: 0, wakeTargets: (explicit) => explicit ?? broadcast });
/** Snapshot the whole roster (snapshots prune unlisted agents), then pick one. */
const ROSTER = ['main', 'other', 'spawn-research-1'];
const agentOf = (t: LivenessTracker, name = 'main', exempt = false): LivenessAgent =>
  t.snapshot([], ROSTER.map((n) => ({ name: n, wakeExempt: n === name ? exempt : n.startsWith('spawn-') })))
    .agents.find((a) => a.name === name)!;

describe('LivenessTracker: servers', () => {
  test('records inbound times per server; ignores unrelated events', () => {
    const t = tracker();
    expect(t.observe(incoming('chat', 10, false))).toBe(true);
    expect(t.observe(incoming('chat', 20, true))).toBe(true);
    expect(t.observe({ type: 'process:received', timestamp: 30, processEvent: { type: 'user-message' } })).toBe(false);
    expect(t.observe({ type: 'inference:tokens', agentName: 'a', timestamp: 40 })).toBe(false);
    expect(t.observe({ type: 'process:received', timestamp: 50, processEvent: { type: 'mcpl:push-event', serverId: 'feed', triggerInference: false } })).toBe(true);
    const snap = t.snapshot([{ id: 'chat', connected: true }, { id: 'feed', connected: false, retrying: true }], [], 99);
    expect(snap.at).toBe(99);
    expect(snap.servers).toEqual([
      { id: 'chat', connected: true, lastInboundAt: 20 },
      { id: 'feed', connected: false, retrying: true, lastInboundAt: 50 },
    ]);
  });

  test('connect failure is recorded (clipped) and cleared on reconnect', () => {
    const t = tracker();
    t.observe({ type: 'mcpl:server-connect-failed', serverId: 'chat', error: 'x'.repeat(500), attempt: 4, willRetry: true, timestamp: 5 });
    let s = t.snapshot([{ id: 'chat', connected: false }], []).servers[0]!;
    expect(s.lastError).toEqual({ message: 'x'.repeat(200), attempt: 4, willRetry: true, at: 5 });
    t.observe({ type: 'mcpl:server-reconnected', serverId: 'chat', attempts: 5, timestamp: 6 });
    s = t.snapshot([{ id: 'chat', connected: true }], []).servers[0]!;
    expect(s.lastError).toBeUndefined();
  });

  test('a runtime connect (module:added mcpl:<id>) clears a stale error; tools-refreshed does not', () => {
    const t = tracker();
    t.observe({ type: 'mcpl:server-connect-failed', serverId: 'chat', error: 'boom', attempt: 0, willRetry: false, timestamp: 1 });
    expect(t.observe({ type: 'module:added', moduleName: 'mcpl:chat:tools-refreshed', timestamp: 2 })).toBe(false);
    expect(t.snapshot([{ id: 'chat', connected: false }], []).servers[0]!.lastError).toBeDefined();
    expect(t.observe({ type: 'module:added', moduleName: 'mcpl:chat', timestamp: 3 })).toBe(true);
    expect(t.snapshot([{ id: 'chat', connected: true }], []).servers[0]!.lastError).toBeUndefined();
  });
});

describe('LivenessTracker: turn lifecycle (AF 0.18 terminals)', () => {
  test('a turn ending via skip_reply/sleep (inference:turn_ended) is not busy', () => {
    const t = tracker();
    t.observe(started('main', 1));
    expect(isBusy(agentOf(t))).toBe(true);
    t.observe({ type: 'inference:turn_ended', agentName: 'main', timestamp: 2 });
    const a = agentOf(t);
    expect(isBusy(a)).toBe(false);
    expect(a.lastOutcome).toBe('turn_ended');
    expect(a.lastEndedAt).toBe(2);
  });

  test('inference:aborted ends the turn as aborted', () => {
    const t = tracker();
    t.observe(started('main', 1));
    t.observe({ type: 'inference:aborted', agentName: 'main', durationMs: 5, timestamp: 2 });
    expect(isBusy(agentOf(t))).toBe(false);
    expect(agentOf(t).lastOutcome).toBe('aborted');
  });

  test('an operator Stop (exhausted "Stream aborted: …") is aborted, not failed', () => {
    const t = tracker();
    t.observe(started('main', 1));
    t.observe({ type: 'inference:exhausted', agentName: 'main', error: 'Stream aborted: operator', inputTokens: 0, budget: 0, timestamp: 2 });
    expect(agentOf(t).lastOutcome).toBe('aborted');
    expect(agentOf(t).lastFailure).toBeUndefined();
  });

  test('failed / real exhaustion record the failure; a later success clears it', () => {
    const t = tracker();
    t.observe(started('main', 1));
    t.observe({ type: 'inference:failed', agentName: 'main', error: 'boom', timestamp: 2 });
    expect(agentOf(t)).toMatchObject({ lastOutcome: 'failed', lastFailure: 'boom' });
    t.observe(started('main', 3));
    t.observe({ type: 'inference:completed', agentName: 'main', durationMs: 1, timestamp: 4 });
    expect(agentOf(t).lastOutcome).toBe('completed');
    expect(agentOf(t).lastFailure).toBeUndefined();
  });

  test('entries for agents and servers no longer listed are pruned', () => {
    const t = tracker();
    t.observe(started('spawn-research-1', 1));
    t.observe(incoming('old', 1, false));
    t.snapshot([], [{ name: 'main' }]);
    // A later snapshot listing them again starts from scratch.
    const snap = t.snapshot([{ id: 'old', connected: true }], [{ name: 'spawn-research-1' }]);
    expect(snap.agents[0]!.lastStartedAt).toBeUndefined();
    expect(snap.servers[0]!.lastInboundAt).toBeUndefined();
  });
});

describe('unansweredSince', () => {
  test('warns when a wake has gone unanswered past the threshold', () => {
    const t = tracker();
    t.observe({ type: 'inference:completed', agentName: 'main', durationMs: 1, timestamp: 1 * MIN });
    t.observe(incoming('chat', 10 * MIN, true));
    expect(unansweredSince(agentOf(t), 16 * MIN)).toBe(10 * MIN);
    expect(unansweredSince(agentOf(t), 12 * MIN)).toBeUndefined();
  });

  test('a busy channel does not reset the clock: the OLDEST pending wake counts', () => {
    const t = tracker();
    for (let m = 0; m <= 60; m += 3) t.observe(incoming('chat', m * MIN, true)); // wakes every 3 min, never answered
    expect(unansweredSince(agentOf(t), 60 * MIN)).toBe(0);
  });

  test('a turn start or any turn end answers the pending wakes', () => {
    for (const end of ['inference:turn_ended', 'inference:completed', 'inference:aborted']) {
      const t = tracker();
      t.observe(incoming('chat', 10 * MIN, true));
      t.observe({ type: end, agentName: 'main', durationMs: 1, timestamp: 11 * MIN });
      expect(unansweredSince(agentOf(t), 60 * MIN)).toBeUndefined();
    }
    const t = tracker();
    t.observe(incoming('chat', 10 * MIN, true));
    t.observe(started('main', 10 * MIN + 1));
    expect(unansweredSince(agentOf(t), 60 * MIN)).toBeUndefined();
  });

  test('wakes are per target agent: an explicit target does not charge others', () => {
    const t = tracker(['main', 'other']);
    t.observe(incoming('chat', 10 * MIN, true, ['other']));
    expect(unansweredSince(agentOf(t, 'main'), 60 * MIN)).toBeUndefined();
    expect(unansweredSince(agentOf(t, 'other'), 60 * MIN)).toBe(10 * MIN);
  });

  test('exempt agents (subagents, subconscious, router trunk) never warn', () => {
    const t = tracker(['main', 'spawn-research-1']);
    t.observe(started('spawn-research-1', 1 * MIN)); // started before the wake the resident answers
    t.observe(incoming('chat', 2 * MIN, true));
    t.observe(started('main', 2 * MIN + 1));
    expect(unansweredSince(agentOf(t, 'spawn-research-1', true), 60 * MIN)).toBeUndefined();
    expect(unansweredSince(agentOf(t, 'main'), 60 * MIN)).toBeUndefined();
  });

  test('non-waking inbound traffic never warns', () => {
    const t = tracker();
    t.observe(incoming('chat', 10 * MIN, false));
    expect(unansweredSince(agentOf(t), 60 * MIN)).toBeUndefined();
  });
});
