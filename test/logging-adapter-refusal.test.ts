/**
 * Off-path refusal dragnet (observability M3): the logging adapter fires
 * onRefusal for refusals on complete() calls — the compression/summarizer
 * path the framework's own noteRefusal never sees — and stays silent for
 * streamed refusals (main driver's job) and non-refusal completions.
 */
import { test, expect } from 'bun:test';
import { LoggingAnthropicAdapter, offPathRefusalAlert } from '../src/logging-adapter.js';

function makeAdapter() {
  const adapter = new LoggingAnthropicAdapter({ apiKey: 'test-key' }, '/tmp/llm-test.jsonl', () => ({ enabled: false, budgetTokens: 0 }));
  const fired: unknown[] = [];
  adapter.onRefusal = (info) => fired.push(info);
  const observe = (kind: 'complete' | 'stream', stopReason?: string, category?: string) =>
    (adapter as unknown as {
      observeCall: (k: string, t: string, d: number, req: unknown, raw: unknown, outcome: unknown, errorText?: string) => void;
    }).observeCall(kind, new Date().toISOString(), 100,
      { model: 'claude-fable-5', messages: new Array(37).fill({}) },
      undefined,
      stopReason
        ? {
            response: {
              usage: { inputTokens: 1_000, outputTokens: 3, cacheReadTokens: 60_000, cacheCreationTokens: 3_000 },
              stopReason,
              raw: { stop_reason: stopReason, ...(category ? { stop_details: { category } } : {}) },
            },
          }
        : { error: new Error('overloaded') },
      stopReason ? undefined : 'overloaded',
    );
  return { adapter, fired, observe };
}

test('complete() refusal fires the dragnet with category + the whole prompt\'s size', () => {
  const { fired, observe } = makeAdapter();
  observe('complete', 'refusal', 'reasoning_extraction');
  expect(fired.length).toBe(1);
  expect(fired[0]).toMatchObject({
    kind: 'complete',
    category: 'reasoning_extraction',
    model: 'claude-fable-5',
    messages: 37,
    inputTokens: 64_000,
  });
});

test('streamed refusal does NOT fire (main driver already escalates those)', () => {
  const { fired, observe } = makeAdapter();
  observe('stream', 'refusal', 'cyber');
  expect(fired.length).toBe(0);
});

test('non-refusal completions and throwing callbacks are harmless', () => {
  const { adapter, fired, observe } = makeAdapter();
  observe('complete', 'end_turn');
  observe('complete');            // error path: no response at all
  expect(fired.length).toBe(0);
  adapter.onRefusal = () => { throw new Error('observer bug'); };
  expect(() => observe('complete', 'refusal', 'cyber')).not.toThrow();
});

test("the ops alert says which call refused, and keeps 'refusal-offpath' as failures.log's kind", () => {
  const alert = offPathRefusalAlert({ kind: 'complete', category: 'cyber', model: 'claude-fable-5', messages: 37, inputTokens: 64_000 });
  expect(alert.kind).toBe('refusal-offpath');
  expect(alert.message).toBe('off-path refusal (category=cyber) on a 37-message complete() call (~64k tok) — likely compression/summarizer');
  // agent-framework's failures.log spreads the data after the alert's kind.
  expect(alert.data).toEqual({ call: 'complete', category: 'cyber', model: 'claude-fable-5', messages: 37, inputTokens: 64_000 });
  const unknown = offPathRefusalAlert({ kind: 'complete', model: 'claude-fable-5', messages: 37, inputTokens: 64_000 });
  expect(unknown.message).toBe('off-path refusal (category=unknown) on a 37-message complete() call (~64k tok) — likely compression/summarizer');
});
