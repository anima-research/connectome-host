/**
 * Provider-success dragnet (AF cairn-cap-park, review blockers 08-13): the
 * logging adapter fires onSuccess for successful `complete()` calls ONLY —
 * the aux lanes (compression/summarizer/maintenance) — so the framework's
 * provider-cap park can release on REAL provider-success evidence it cannot
 * observe itself. `stream` NEVER fires it: primary turns stream, and the
 * adapter observes the provider response BEFORE the stream driver settles
 * and emits `inference:completed` — a stream-fired hook would release the
 * park as aux-success and queue a duplicate catch-up wake ahead of the
 * primary release (the composition blocker Sol's independent review found).
 */
import { test, expect } from 'bun:test';
import { LoggingAnthropicAdapter } from '../src/logging-adapter.js';

function makeAdapter() {
  const adapter = new LoggingAnthropicAdapter({ apiKey: 'test-key' }, '/tmp/llm-test.jsonl', () => ({ enabled: false, budgetTokens: 0 }));
  const fired: unknown[] = [];
  adapter.onSuccess = (info) => fired.push(info);
  const observe = (kind: 'complete' | 'stream', ok: boolean, stopReason = 'end_turn') =>
    (adapter as unknown as {
      observeCall: (k: string, t: string, d: number, req: unknown, raw: unknown, res?: unknown, err?: unknown) => void;
    }).observeCall(kind, new Date().toISOString(), 100,
      { model: 'claude-opus-4-8', messages: new Array(12).fill({}) },
      undefined,
      ok
        ? {
            usage: { inputTokens: 1000, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
            stopReason,
            raw: { stop_reason: stopReason, ...(stopReason === 'refusal' ? { stop_details: { category: 'cyber' } } : {}) },
          }
        : undefined,
      ok ? undefined : new Error('400 provider says no'),
    );
  return { adapter, fired, observe };
}

test('successful complete() fires with model + size; successful stream() NEVER fires', () => {
  const { fired, observe } = makeAdapter();
  observe('complete', true);
  expect(fired.length).toBe(1);
  expect(fired[0]).toMatchObject({ kind: 'complete', model: 'claude-opus-4-8', messages: 12 });

  observe('stream', true);
  observe('stream', true);
  expect(fired.length).toBe(1, 'primary lane streams — it releases via inference:completed, never here');
});

test('error-path calls never fire onSuccess, either kind (a cap-400 is not success evidence)', () => {
  const { fired, observe } = makeAdapter();
  observe('complete', false);
  observe('stream', false);
  expect(fired.length).toBe(0);
});

test('INTEGRATION ORDER: wired as index.ts wires it, a primary stream success never reaches the framework hook', () => {
  // Exactly the index.ts wiring shape, against a counting fake framework.
  const { adapter, observe } = makeAdapter();
  const calls: string[] = [];
  const app = {
    agentName: 'mythos',
    framework: { noteProviderSuccess: (agent: string) => { calls.push(agent); } },
  };
  adapter.onSuccess = () => {
    const fw = app.framework as unknown as { noteProviderSuccess?: (agent: string) => void };
    fw.noteProviderSuccess?.(app.agentName);
  };

  observe('stream', true);   // primary turn succeeding
  expect(calls.length).toBe(0, 'no aux-success release can race the primary inference:completed');

  observe('complete', true); // compression lane succeeding
  expect(calls).toEqual(['mythos'], 'aux success reaches the framework exactly once');
});

test('a throwing onSuccess observer never affects provider traffic', () => {
  const { adapter, observe } = makeAdapter();
  adapter.onSuccess = () => { throw new Error('observer bug'); };
  expect(() => observe('complete', true)).not.toThrow();
});

test('a refusal on complete() still fires: the provider answered, so the account is provably not capped', () => {
  const { fired, observe } = makeAdapter();
  observe('complete', true, 'refusal');
  expect(fired.length).toBe(1);
});
