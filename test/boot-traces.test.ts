/**
 * holdBootTraces (src/boot-traces.ts): the listener main() attaches before
 * framework.start() so the headless sink, which attaches after, still gets
 * the boot — what create() replays and what start() emitted — oldest first,
 * then live; the first N are kept and the overrun is counted.
 */
import { describe, test, expect } from 'bun:test';
import type { TraceEvent } from '@animalabs/agent-framework';
import { holdBootTraces, BOOT_TRACE_CAP } from '../src/boot-traces.js';

function fakeFramework(early: Array<Record<string, unknown>> = []) {
  const listeners: Array<{ listener: (event: TraceEvent) => void; options?: { replay?: boolean } }> = [];
  return {
    listeners,
    onTrace(listener: (event: TraceEvent) => void, options?: { replay?: boolean }) {
      listeners.push({ listener, options });
      if (options?.replay) for (const event of early) listener(event as unknown as TraceEvent);
      return () => {};
    },
    emit(event: Record<string, unknown>) {
      for (const { listener } of listeners) listener(event as unknown as TraceEvent);
    },
  };
}
const ev = (n: number, type = 'inference:started') => ({ type, agentName: 'a', timestamp: n }) as unknown as TraceEvent;

describe('holdBootTraces', () => {
  test('attaches one listener that asks for the replay', () => {
    const fw = fakeFramework();
    holdBootTraces(fw);
    expect(fw.listeners).toHaveLength(1);
    expect(fw.listeners[0]!.options).toEqual({ replay: true });
  });

  test('what arrives before the handover is delivered at it, oldest first, then live events flow straight through', () => {
    const fw = fakeFramework();
    const hold = holdBootTraces(fw);
    fw.emit(ev(1)); fw.emit(ev(2)); fw.emit(ev(3));
    const seen: number[] = [];
    const dropped = hold.handOver((event) => seen.push((event as { timestamp: number }).timestamp));
    expect(seen).toEqual([1, 2, 3]);
    expect(dropped).toBe(0);
    fw.emit(ev(4));
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  test('keeps the FIRST cap events and counts the rest; the count is returned at handover', () => {
    const fw = fakeFramework();
    const hold = holdBootTraces(fw, 3);
    for (const n of [1, 2, 3, 4, 5]) fw.emit(ev(n));
    const seen: number[] = [];
    const dropped = hold.handOver((event) => seen.push((event as { timestamp: number }).timestamp));
    expect(seen).toEqual([1, 2, 3]);
    expect(dropped).toBe(2);
    expect(BOOT_TRACE_CAP).toBe(1000);
  });

  test('the framework\'s replay comes first, and its count of what it didn\'t keep is added to the hold\'s own, not held', () => {
    const fw = fakeFramework([
      ev(1) as unknown as Record<string, unknown>,
      ev(2) as unknown as Record<string, unknown>,
      { type: 'dendrite:early-traces-dropped', dropped: 5, timestamp: 3 },
    ]);
    const hold = holdBootTraces(fw, 1);
    fw.emit(ev(4) as unknown as Record<string, unknown>);
    const seen: Array<{ type: string; timestamp: number }> = [];
    const dropped = hold.handOver((event) => seen.push(event as unknown as { type: string; timestamp: number }));
    expect(seen).toEqual([{ type: 'inference:started', agentName: 'a', timestamp: 1 }]);
    expect(dropped).toBe(7);
  });

  test('a second handover does nothing and redelivers nothing', () => {
    const fw = fakeFramework();
    const hold = holdBootTraces(fw);
    fw.emit(ev(1));
    const first: number[] = [];
    const second: number[] = [];
    hold.handOver((event) => first.push((event as { timestamp: number }).timestamp));
    expect(hold.handOver((event) => second.push((event as { timestamp: number }).timestamp))).toBe(0);
    fw.emit(ev(2));
    expect(first).toEqual([1, 2]);
    expect(second).toEqual([]);
  });
});
