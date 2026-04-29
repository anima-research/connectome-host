/**
 * Unit tests for FleetTreeAggregator using a mock FleetModule.
 *
 * The aggregator's job is to:
 *   1. Maintain a per-child AgentTreeReducer.
 *   2. Request describe on lifecycle:ready (cold start + restart).
 *   3. Apply snapshots, reseed reducers, drop stale events.
 *   4. Notify listeners on tree changes.
 *
 * These tests drive a fake FleetModule API to assert that orchestration
 * happens correctly, without actually spawning child processes.
 */
import { describe, test, expect } from 'bun:test';
import { FleetTreeAggregator } from '../src/state/fleet-tree-aggregator.js';
import type { FleetEventCallback } from '../src/modules/fleet-module.js';
import type { WireEvent } from '../src/modules/fleet-types.js';

// Minimal stub: only the surface FleetTreeAggregator actually touches.
interface FakeChild { name: string; status: string }

class FakeFleet {
  private subscribers = new Map<string, Set<FleetEventCallback>>();
  private children: FakeChild[] = [];
  describeRequests: Array<{ name: string; corrId?: string }> = [];

  setChildren(children: FakeChild[]): void { this.children = children; }
  getChildren(): Map<string, FakeChild> {
    const m = new Map<string, FakeChild>();
    for (const c of this.children) m.set(c.name, c);
    return m;
  }

  onChildEvent(name: string, callback: FleetEventCallback): () => void {
    if (!this.subscribers.has(name)) this.subscribers.set(name, new Set());
    this.subscribers.get(name)!.add(callback);
    return () => { this.subscribers.get(name)?.delete(callback); };
  }

  requestDescribe(name: string, corrId?: string): boolean {
    if (corrId !== undefined) this.describeRequests.push({ name, corrId });
    else this.describeRequests.push({ name });
    return this.children.some(c => c.name === name);
  }

  /** Drive an event from a child (for test injection). */
  emit(name: string, event: WireEvent): void {
    const subs = this.subscribers.get(name);
    if (!subs) return;
    for (const cb of subs) cb(name, event);
  }
}

function makeSnapshot(asOfTs: number, agents: Array<{ name: string; phase?: string; input?: number; toolCalls?: number }>): WireEvent {
  return {
    type: 'snapshot',
    corrId: 'test',
    asOfTs,
    child: { name: 'c', pid: 0, startedAt: 0 },
    tree: {
      nodes: agents.map(a => ({
        name: a.name,
        kind: 'framework',
        status: 'running',
        phase: a.phase ?? 'idle',
        tokens: { input: a.input ?? 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        toolCallsCount: a.toolCalls ?? 0,
        findingsCount: 0,
      })),
      callIdIndex: {},
    },
    ts: asOfTs,
  } as unknown as WireEvent;
}

describe('FleetTreeAggregator', () => {
  test('register triggers describe when child is already ready', () => {
    const fake = new FakeFleet();
    fake.setChildren([{ name: 'miner', status: 'ready' }]);
    const agg = new FleetTreeAggregator(fake as never);
    agg.registerChild('miner');
    expect(fake.describeRequests.map(r => r.name)).toEqual(['miner']);
  });

  test('register does NOT describe when child not yet ready; lifecycle:ready triggers it', () => {
    const fake = new FakeFleet();
    fake.setChildren([{ name: 'miner', status: 'starting' }]);
    const agg = new FleetTreeAggregator(fake as never);
    agg.registerChild('miner');
    expect(fake.describeRequests).toEqual([]);

    fake.emit('miner', { type: 'lifecycle', phase: 'ready', pid: 1, dataDir: '/tmp' } as WireEvent);
    expect(fake.describeRequests.map(r => r.name)).toEqual(['miner']);
  });

  test('snapshot reseeds the per-child reducer', () => {
    const fake = new FakeFleet();
    fake.setChildren([{ name: 'miner', status: 'ready' }]);
    const agg = new FleetTreeAggregator(fake as never);
    agg.registerChild('miner');

    fake.emit('miner', makeSnapshot(1000, [{ name: 'commander', input: 5000, toolCalls: 3 }]));
    const nodes = agg.getChildNodes('miner');
    expect(nodes.length).toBe(1);
    expect(nodes[0]!.name).toBe('commander');
    expect(nodes[0]!.tokens.input).toBe(5000);
    expect(nodes[0]!.toolCallsCount).toBe(3);
  });

  test('events with ts < lastSnapshotTs are dropped', () => {
    const fake = new FakeFleet();
    fake.setChildren([{ name: 'miner', status: 'ready' }]);
    const agg = new FleetTreeAggregator(fake as never);
    agg.registerChild('miner');

    // Snapshot at t=1000 with toolCallsCount=3
    fake.emit('miner', makeSnapshot(1000, [{ name: 'commander', toolCalls: 3 }]));
    expect(agg.getChildNodes('miner')[0]!.toolCallsCount).toBe(3);

    // Stale tool event (t=500 < snapshot t=1000) — should be dropped
    fake.emit('miner', {
      type: 'inference:tool_calls_yielded',
      agentName: 'commander',
      calls: [{ id: 'old-c1', name: 'x', input: {} }],
      timestamp: 500,
      ts: 500,
    } as WireEvent);
    fake.emit('miner', { type: 'tool:started', callId: 'old-c1', tool: 'x', module: 'm', ts: 500 } as WireEvent);
    expect(agg.getChildNodes('miner')[0]!.toolCallsCount).toBe(3); // unchanged

    // Fresh tool event (t=2000 > snapshot t=1000) — applied
    fake.emit('miner', {
      type: 'inference:tool_calls_yielded',
      agentName: 'commander',
      calls: [{ id: 'new-c1', name: 'y', input: {} }],
      timestamp: 2000,
      ts: 2000,
    } as WireEvent);
    fake.emit('miner', { type: 'tool:started', callId: 'new-c1', tool: 'y', module: 'm', ts: 2001 } as WireEvent);
    expect(agg.getChildNodes('miner')[0]!.toolCallsCount).toBe(4);
  });

  test('events with no ts are applied (best-effort)', () => {
    const fake = new FakeFleet();
    fake.setChildren([{ name: 'miner', status: 'ready' }]);
    const agg = new FleetTreeAggregator(fake as never);
    agg.registerChild('miner');

    fake.emit('miner', makeSnapshot(1000, []));
    fake.emit('miner', {
      type: 'inference:started',
      agentName: 'lazy-agent',
      timestamp: 5000,
      // No ts field on the wrapper
    } as WireEvent);
    const nodes = agg.getChildNodes('miner');
    expect(nodes.find(n => n.name === 'lazy-agent')).toBeDefined();
  });

  test('describe is not re-requested while one is in flight', () => {
    const fake = new FakeFleet();
    fake.setChildren([{ name: 'miner', status: 'ready' }]);
    const agg = new FleetTreeAggregator(fake as never);
    agg.registerChild('miner');
    expect(fake.describeRequests.length).toBe(1);

    // Second lifecycle:ready before snapshot returns: should NOT re-request.
    fake.emit('miner', { type: 'lifecycle', phase: 'ready', pid: 1, dataDir: '/tmp' } as WireEvent);
    expect(fake.describeRequests.length).toBe(1);

    // After snapshot arrives, in-flight clears.
    fake.emit('miner', makeSnapshot(1000, []));

    // A subsequent lifecycle:ready (e.g. after parent reconnect) DOES re-request.
    fake.emit('miner', { type: 'lifecycle', phase: 'ready', pid: 1, dataDir: '/tmp' } as WireEvent);
    expect(fake.describeRequests.length).toBe(2);
  });

  test('listeners fire on child tree changes', () => {
    const fake = new FakeFleet();
    fake.setChildren([{ name: 'miner', status: 'ready' }]);
    const agg = new FleetTreeAggregator(fake as never);
    agg.registerChild('miner');

    const updates: string[] = [];
    agg.onTreeUpdate((scope) => updates.push(scope));

    fake.emit('miner', makeSnapshot(1000, [{ name: 'commander' }]));
    expect(updates).toContain('miner');
  });

  test('local events feed the local reducer', () => {
    const fake = new FakeFleet();
    const agg = new FleetTreeAggregator(fake as never);
    agg.seedLocalAgents(['conductor']);
    agg.applyLocalEvent({
      type: 'inference:usage',
      agentName: 'conductor',
      tokenUsage: { input: 12000, output: 200 },
      timestamp: 1000,
    });
    const local = agg.getLocalNodes();
    expect(local.find(n => n.name === 'conductor')!.tokens.input).toBe(12000);
  });

  test('unregister stops further event handling for that child', () => {
    const fake = new FakeFleet();
    fake.setChildren([{ name: 'miner', status: 'ready' }]);
    const agg = new FleetTreeAggregator(fake as never);
    agg.registerChild('miner');
    fake.emit('miner', makeSnapshot(1000, [{ name: 'commander', toolCalls: 1 }]));
    expect(agg.getChildNodes('miner')[0]!.toolCallsCount).toBe(1);

    agg.unregisterChild('miner');
    fake.emit('miner', { type: 'lifecycle', phase: 'ready', pid: 1, dataDir: '/tmp', ts: 9999 } as WireEvent);
    // After unregister, child is gone; getChildNodes returns empty.
    expect(agg.getChildNodes('miner')).toEqual([]);
  });

  test('dispose tears down all subscriptions', () => {
    const fake = new FakeFleet();
    fake.setChildren([{ name: 'a', status: 'ready' }, { name: 'b', status: 'ready' }]);
    const agg = new FleetTreeAggregator(fake as never);
    agg.registerChild('a');
    agg.registerChild('b');
    expect(agg.getAllChildNames().sort()).toEqual(['a', 'b']);
    agg.dispose();
    expect(agg.getAllChildNames()).toEqual([]);
  });
});
