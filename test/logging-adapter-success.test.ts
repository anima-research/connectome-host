/**
 * Provider-success dragnet (AF cairn-cap-park, review blocker 2): the logging
 * adapter fires onSuccess for every SUCCESSFUL provider call — both kinds —
 * so the framework's provider-cap park can release on REAL provider-success
 * evidence from the aux lanes (compression/summarizer/maintenance) it cannot
 * observe itself. Error-path calls must never fire it, and a throwing
 * observer must never affect provider traffic.
 */
import { test, expect } from 'bun:test';
import { LoggingAnthropicAdapter } from '../src/logging-adapter.js';

function makeAdapter() {
  const adapter = new LoggingAnthropicAdapter({ apiKey: 'test-key' }, '/tmp/llm-test.jsonl', () => ({ enabled: false, budgetTokens: 0 }));
  const fired: unknown[] = [];
  adapter.onSuccess = (info) => fired.push(info);
  const observe = (kind: 'complete' | 'stream', ok: boolean) =>
    (adapter as unknown as {
      observeCall: (k: string, t: string, d: number, req: unknown, raw: unknown, res?: unknown, err?: unknown) => void;
    }).observeCall(kind, new Date().toISOString(), 100,
      { model: 'claude-opus-4-8', messages: new Array(12).fill({}) },
      undefined,
      ok
        ? {
            usage: { inputTokens: 1000, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
            stopReason: 'end_turn',
            raw: { stop_reason: 'end_turn' },
          }
        : undefined,
      ok ? undefined : new Error('400 provider says no'),
    );
  return { adapter, fired, observe };
}

test('successful complete() and stream() both fire with model + size', () => {
  const { fired, observe } = makeAdapter();
  observe('complete', true);
  observe('stream', true);
  expect(fired.length).toBe(2);
  expect(fired[0]).toMatchObject({ kind: 'complete', model: 'claude-opus-4-8', messages: 12 });
  expect(fired[1]).toMatchObject({ kind: 'stream', model: 'claude-opus-4-8', messages: 12 });
});

test('error-path calls never fire onSuccess (a cap-400 is not success evidence)', () => {
  const { fired, observe } = makeAdapter();
  observe('complete', false);
  observe('stream', false);
  expect(fired.length).toBe(0);
});

test('a throwing onSuccess observer never affects provider traffic', () => {
  const { adapter, observe } = makeAdapter();
  adapter.onSuccess = () => { throw new Error('observer bug'); };
  expect(() => observe('complete', true)).not.toThrow();
});

test('refusal completions still fire onSuccess=false path correctly: a refusal IS a completed provider call', () => {
  // A refusal is a successful HTTP call (the provider answered) — for cap
  // purposes that proves the account is not capped. onSuccess fires; the
  // separate onRefusal dragnet handles the refusal semantics.
  const adapter = new LoggingAnthropicAdapter({ apiKey: 'test-key' }, '/tmp/llm-test.jsonl', () => ({ enabled: false, budgetTokens: 0 }));
  const fired: unknown[] = [];
  adapter.onSuccess = (info) => fired.push(info);
  (adapter as unknown as {
    observeCall: (k: string, t: string, d: number, req: unknown, raw: unknown, res?: unknown) => void;
  }).observeCall('complete', new Date().toISOString(), 100,
    { model: 'claude-opus-4-8', messages: [{}] },
    undefined,
    {
      usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      stopReason: 'refusal',
      raw: { stop_reason: 'refusal', stop_details: { category: 'cyber' } },
    },
  );
  expect(fired.length).toBe(1);
});
