/**
 * The Web UI stream panel's lines: what each end of a turn shows as, the
 * bookkeeping traces it skips, and how many lines a panel keeps.
 */
import { describe, expect, test } from 'bun:test';
import { formatStreamEvent, STREAM_LINES_KEPT, withStreamLines, type StreamLine } from '../src/web/stream-lines.js';

const text = (event: { type: string; [k: string]: unknown }) => formatStreamEvent(event)?.text ?? null;

describe('formatStreamEvent', () => {
  test('each end of a turn has its own line', () => {
    expect(text({ type: 'inference:completed' })).toBe('── inference completed ──');
    expect(text({ type: 'inference:turn_ended' })).toBe('── turn ended by a tool ──');
    expect(text({ type: 'inference:aborted', reason: 'interrupted' })).toBe('✗ turn aborted: interrupted');
    expect(text({ type: 'inference:aborted' })).toBe('✗ turn aborted');
    expect(text({ type: 'inference:aborted', reason: '' })).toBe('✗ turn aborted');
    expect(text({ type: 'inference:exhausted', error: 'Stream aborted: timeout' })).toBe('✗ turn ended: Stream aborted: timeout');
    expect(text({ type: 'inference:failed', error: 'overloaded' })).toBe('✗ inference failed: overloaded');
    // What a client gets in place of an end whose trace its scopes don't cover.
    expect(text({ type: 'stream-ended', agentName: 'clerk' })).toBe('── stream ended ──');
  });

  test("an end whose error is missing or empty says 'Unknown error', as every other surface does", () => {
    expect(text({ type: 'inference:failed' })).toBe('✗ inference failed: Unknown error');
    expect(text({ type: 'inference:failed', error: '' })).toBe('✗ inference failed: Unknown error');
    expect(text({ type: 'inference:exhausted', error: '  ' })).toBe('✗ turn ended: Unknown error');
  });

  test('bookkeeping traces and tokens show no line', () => {
    for (const type of ['inference:content_block', 'inference:usage', 'usage:updated', 'inference:started', 'inference:tokens', 'tokens']) {
      expect(formatStreamEvent({ type })).toBeNull();
    }
  });
});

describe('withStreamLines', () => {
  const lines = (from: number, n: number): StreamLine[] =>
    Array.from({ length: n }, (_, i) => ({ id: from + i, kind: 'event' as const, text: String(from + i) }));

  test('adds lines after the panel\'s own', () => {
    expect(withStreamLines(lines(1, 2), lines(3, 1)).map((l) => l.id)).toEqual([1, 2, 3]);
  });

  test('a panel holds 2,000 lines, its first still its own while it has let none go', () => {
    expect(STREAM_LINES_KEPT).toBe(2_000);
    const full = withStreamLines(lines(1, STREAM_LINES_KEPT - 1), lines(STREAM_LINES_KEPT, 1));
    expect(full).toHaveLength(STREAM_LINES_KEPT);
    expect(full[0]!.id).toBe(1);
    expect(full.some((l) => l.text.includes('not shown'))).toBe(false);
  });

  test('once it holds more, its first line says how many earlier lines it no longer shows, and the rest are the newest', () => {
    const kept = withStreamLines(lines(1, STREAM_LINES_KEPT), lines(STREAM_LINES_KEPT + 1, 3));
    expect(kept).toHaveLength(STREAM_LINES_KEPT);
    expect(kept[0]!.text).toBe('… 4 earlier lines not shown');
    expect(kept[1]!.id).toBe(5);
    expect(kept[kept.length - 1]!.id).toBe(STREAM_LINES_KEPT + 3);
    // The count goes on from the line that says it, which stays first.
    const later = withStreamLines(kept, lines(STREAM_LINES_KEPT + 4, 1));
    expect(later).toHaveLength(STREAM_LINES_KEPT);
    expect(later[0]!.text).toBe('… 5 earlier lines not shown');
    expect(later[1]!.id).toBe(6);
    expect(later.filter((l) => l.text.includes('not shown'))).toHaveLength(1);
  });

  test('the first line past the cap lets two go, the line that says so taking a place', () => {
    const kept = withStreamLines(lines(1, STREAM_LINES_KEPT), lines(STREAM_LINES_KEPT + 1, 1));
    expect(kept[0]!.text).toBe('… 2 earlier lines not shown');
    expect(kept[1]!.id).toBe(3);
  });
});
