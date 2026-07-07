import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoggingAnthropicAdapter, RotatingJsonlLog } from '../src/logging-adapter.js';
import type { ProviderRequest } from '@animalabs/membrane';

// Regression guard for the reasoning passthrough. `withReasoning` injects
// adaptive `thinking` into `request.extra`, which the Anthropic adapter
// forwards to the API params verbatim. This is invisible to the type system
// (membrane's ProviderRequest doesn't type `thinking`), so it's exactly the
// kind of contract that silently rots on a dependency bump — pin it here so
// the next break is a red test with a name, not a tsc error blamed on the
// wrong package (see the git history of this file).

const baseRequest: ProviderRequest = {
  messages: [],
  model: 'claude-opus-4-6',
  maxTokens: 1024,
};

const enabled = () => ({ enabled: true, budgetTokens: 0 });
const disabled = () => ({ enabled: false, budgetTokens: 0 });

describe('LoggingAnthropicAdapter.withReasoning', () => {
  test('injects adaptive thinking into request.extra when reasoning enabled', () => {
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null', enabled);
    const out = (adapter as unknown as { withReasoning(r: ProviderRequest): ProviderRequest })
      .withReasoning(baseRequest);
    expect((out.extra as Record<string, { type?: string }> | undefined)?.thinking?.type).toBe('adaptive');
    // shallow clone — original request untouched
    expect((baseRequest as { extra?: unknown }).extra).toBeUndefined();
  });

  test('preserves pre-existing extra keys', () => {
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null', enabled);
    const req = { ...baseRequest, extra: { normalizedMessages: 'keep-me' } } as ProviderRequest;
    const out = (adapter as unknown as { withReasoning(r: ProviderRequest): ProviderRequest })
      .withReasoning(req);
    const extra = out.extra as Record<string, unknown>;
    expect(extra.normalizedMessages).toBe('keep-me');
    expect((extra.thinking as { type?: string }).type).toBe('adaptive');
  });

  test('no-op (same reference) when reasoning disabled', () => {
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null', disabled);
    const out = (adapter as unknown as { withReasoning(r: ProviderRequest): ProviderRequest })
      .withReasoning(baseRequest);
    expect(out).toBe(baseRequest);
  });

  test('no-op when no reasoning getter is wired', () => {
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null');
    const out = (adapter as unknown as { withReasoning(r: ProviderRequest): ProviderRequest })
      .withReasoning(baseRequest);
    expect(out).toBe(baseRequest);
  });
});

// Fragility audit 6.4: the llm-calls JSONL previously grew without bound
// (appendFileSync of full request+response per call, no rotation). The sink
// must roll to `<path>.1` at the byte cap, mirroring the mcpl-stderr log.
describe('RotatingJsonlLog', () => {
  test('rotates to .1 when the cap is exceeded and keeps appending', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fkm-llmlog-'));
    const path = join(dir, 'llm-calls.jsonl');
    try {
      const maxBytes = 500;
      const log = new RotatingJsonlLog(path, maxBytes);
      const record = { type: 'call', payload: 'x'.repeat(80) }; // ~100 bytes/line

      for (let i = 0; i < 20; i++) log.append({ ...record, i });

      // Rotation happened: the rolled file exists and the live file is
      // within the cap (plus at most one entry of slack).
      expect(existsSync(`${path}.1`)).toBe(true);
      expect(statSync(path).size).toBeLessThanOrEqual(maxBytes + 200);

      // Every line in both files is intact JSON — rotation never tears a record.
      for (const p of [path, `${path}.1`]) {
        const lines = readFileSync(p, 'utf8').trim().split('\n');
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no rotation below the cap; append failures never throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fkm-llmlog-'));
    const path = join(dir, 'small.jsonl');
    try {
      const log = new RotatingJsonlLog(path, 10 * 1024 * 1024);
      log.append({ a: 1 });
      log.append({ b: 2 });
      expect(existsSync(`${path}.1`)).toBe(false);
      expect(readFileSync(path, 'utf8').trim().split('\n').length).toBe(2);

      // Unwritable path — must swallow, not throw (logging is not load-bearing).
      const broken = new RotatingJsonlLog(join(dir, 'no-such-dir', 'x.jsonl'), 100);
      expect(() => broken.append({ c: 3 })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
