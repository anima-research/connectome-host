import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CallLedger, parseLoggedCall, summarizeCacheControls, type ProviderCallRecord } from '../src/call-ledger.js';

const at = (seconds: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

function call(overrides: Partial<ProviderCallRecord> = {}): ProviderCallRecord {
  return {
    timestamp: at(0),
    kind: 'stream',
    durationMs: 1000,
    model: 'claude-fable-5',
    messages: 10,
    inputTokens: 2,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheBreakpoints: 4,
    cacheTtls: ['1h', '1h', '1h', '1h'],
    stopReason: 'end_turn',
    ...overrides,
  };
}

describe('CallLedger cache verdicts', () => {
  test('distinguishes first write, hit, and expired rewrite using the effective TTL', () => {
    const ledger = new CallLedger({ hydrate: false, defaultTtl: '1h' });
    ledger.record(call({ timestamp: at(0), cacheWriteTokens: 100_000 }));
    ledger.record(call({ timestamp: at(1800), cacheReadTokens: 100_000 }));
    ledger.record(call({ timestamp: at(5500), cacheWriteTokens: 101_000 }));

    const rows = ledger.snapshot().rows;
    expect(rows.map((r) => r.verdict)).toEqual(['first-write', 'HIT', 'rewrite:expired']);
    expect(rows[2]!.cause).toContain('gap 3700s > ttl 3600s');
  });

  test('calls without cache flags are visibly uncached', () => {
    const ledger = new CallLedger({ hydrate: false });
    ledger.record(call({ kind: 'complete', cacheBreakpoints: 0, cacheTtls: [], inputTokens: 48_000 }));
    expect(ledger.snapshot().rows[0]).toMatchObject({
      verdict: 'uncached',
      cause: 'no cache_control flags in request',
    });
  });

  test('reports hit+extend and an aggregate cache ratio', () => {
    const ledger = new CallLedger({ hydrate: false });
    ledger.record(call({ inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 100 }));
    const snap = ledger.snapshot();
    expect(snap.rows[0]!.verdict).toBe('hit+extend');
    expect(snap.summary.cacheHitRatio).toBeCloseTo(900 / 1100);
  });

  test('allocates an auditable per-call cost and reconciles the retained total', () => {
    const ledger = new CallLedger({ hydrate: false });
    ledger.record(call({
      cacheWriteTokens: 336_010,
      cacheWrite5mTokens: 336_010,
      cacheWrite1hTokens: 0,
      cacheWriteBucketsAuthoritative: true,
      cacheTtls: ['5m'],
      outputTokens: 639,
      serviceTier: 'standard',
      inferenceGeo: 'global',
    }));
    ledger.record(call({ model: 'unknown-model' }));

    const snap = ledger.snapshot();
    expect(snap.rows[0]!.cost?.total).toBeCloseTo(4.232095, 9);
    expect(snap.rows[1]!.cost).toBeUndefined();
    expect(snap.summary.cost).toMatchObject({
      total: 4.232095,
      pricedCalls: 1,
      unpricedCalls: 1,
      currency: 'USD',
    });
  });

  test('does not guess a cache-write TTL bucket from request flags', () => {
    const ledger = new CallLedger({ hydrate: false });
    ledger.record(call({ cacheWriteTokens: 100_000, cacheTtls: ['1h'] }));
    expect(ledger.snapshot().rows[0]!.cost).toBeUndefined();
  });

  test('a call that carries an error is an ERROR, unpriced, even when its text is empty', () => {
    const ledger = new CallLedger({ hydrate: false });
    ledger.record(call({ error: '', inputTokens: 1_000, cacheReadTokens: 100_000 }));
    const [row] = ledger.snapshot().rows;
    expect(row).toMatchObject({ verdict: 'ERROR', cause: 'the error carried no text', error: '' });
    expect(row!.cost).toBeUndefined();
  });
});

describe('CallLedger cache gaps by lineage', () => {
  test("another lineage's activity doesn't make an expired entry read as a changed prefix", () => {
    const ledger = new CallLedger({ hydrate: false, defaultTtl: '1h' });
    ledger.record(call({ timestamp: at(0), lineage: 'a', cacheWriteTokens: 100_000 }));
    // Lineage b's keepalive pokes read its own entry while a's expires.
    ledger.record(call({ timestamp: at(3000), kind: 'keepalive', lineage: 'b', cacheReadTokens: 80_000 }));
    ledger.record(call({ timestamp: at(6000), kind: 'keepalive', lineage: 'b', cacheReadTokens: 80_000 }));
    ledger.record(call({ timestamp: at(7300), lineage: 'a', cacheWriteTokens: 100_000 }));
    const last = ledger.snapshot().rows.at(-1)!;
    expect(last.verdict).toBe('rewrite:expired');
    expect(last.cause).toBe('gap 7300s > ttl 3600s');
  });

  test('a lineage not seen yet is measured from any lineage, so a changed system prompt or tool list reads as a changed prefix', () => {
    const ledger = new CallLedger({ hydrate: false, defaultTtl: '1h' });
    ledger.record(call({ timestamp: at(0), lineage: 'a', cacheWriteTokens: 100_000 }));
    ledger.record(call({ timestamp: at(600), lineage: 'a2', cacheWriteTokens: 100_000 }));
    expect(ledger.snapshot().rows.at(-1)).toMatchObject({
      verdict: 'rewrite:unexplained',
      cause: "cache miss inside ttl (600s <= 3600s); the ledger holds no earlier cache activity of this lineage, so the gap runs from any lineage's last: a changed prefix, a new agent's first call, or a lineage last active before what the ledger holds",
    });
    // Past the TTL of any lineage's last activity, it reads as expired, and
    // says the gap is any lineage's.
    ledger.record(call({ timestamp: at(4300), lineage: 'a3', cacheWriteTokens: 100_000 }));
    expect(ledger.snapshot().rows.at(-1)).toMatchObject({
      verdict: 'rewrite:expired',
      cause: "gap 3700s > ttl 3600s; the ledger holds no earlier cache activity of this lineage, so the gap runs from any lineage's last",
    });
  });

  test("a row that names no lineage is measured from any lineage, as an older log's rows are", () => {
    const ledger = new CallLedger({ hydrate: false, defaultTtl: '1h' });
    ledger.record(call({ timestamp: at(0), cacheWriteTokens: 100_000 }));
    ledger.record(call({ timestamp: at(3000), lineage: 'b', cacheReadTokens: 80_000 }));
    ledger.record(call({ timestamp: at(3300), cacheWriteTokens: 100_000 }));
    expect(ledger.snapshot().rows.at(-1)!.cause).toBe('cache miss inside ttl (300s <= 3600s); prefix changed or was truncated');
  });

  test('a ledger remembers the 256 lineages last active, and measures one it forgot as one not seen', () => {
    const verdictAfter = (others: number): string => {
      const ledger = new CallLedger({ hydrate: false, defaultTtl: '1h' });
      ledger.record(call({ timestamp: at(0), lineage: 'a', cacheWriteTokens: 100_000 }));
      for (let i = 0; i < others; i++) {
        ledger.record(call({ timestamp: at(3000 + i), lineage: `other-${i}`, cacheReadTokens: 80_000 }));
      }
      ledger.record(call({ timestamp: at(3700), lineage: 'a', cacheWriteTokens: 100_000 }));
      return ledger.snapshot().rows.at(-1)!.verdict;
    };
    // Remembered, a's gap is its own 3700 s; forgotten, it runs from the
    // last activity of any lineage, under the hour.
    expect(verdictAfter(255)).toBe('rewrite:expired');
    expect(verdictAfter(256)).toBe('rewrite:unexplained');
  });

  test('a lineage active again is remembered as recent', () => {
    const ledger = new CallLedger({ hydrate: false, defaultTtl: '1h' });
    ledger.record(call({ timestamp: at(0), lineage: 'a', cacheWriteTokens: 100_000 }));
    for (let i = 0; i < 255; i++) {
      ledger.record(call({ timestamp: at(2800 + i), lineage: `other-${i}`, cacheReadTokens: 80_000 }));
    }
    ledger.record(call({ timestamp: at(3100), lineage: 'a', cacheReadTokens: 80_000 }));
    ledger.record(call({ timestamp: at(3300), lineage: 'other-255', cacheReadTokens: 80_000 }));
    // The 257th lineage forgets the least recent, other-0, not a.
    ledger.record(call({ timestamp: at(6801), lineage: 'a', cacheWriteTokens: 100_000 }));
    expect(ledger.snapshot().rows.at(-1)!.cause).toBe('gap 3701s > ttl 3600s');
  });

  test("a call that didn't read or write the cache leaves its lineage's clock where it was", () => {
    const ledger = new CallLedger({ hydrate: false, defaultTtl: '1h' });
    ledger.record(call({ timestamp: at(0), lineage: 'a', cacheWriteTokens: 100_000 }));
    ledger.record(call({ timestamp: at(3000), lineage: 'a', error: 'overloaded' }));
    // Nor the process's: a row that names no lineage is measured from it.
    ledger.record(call({ timestamp: at(3700), cacheWriteTokens: 100_000 }));
    ledger.record(call({ timestamp: at(3800), lineage: 'a', cacheWriteTokens: 100_000 }));
    expect(ledger.snapshot().rows.slice(-2).map((r) => r.cause)).toEqual(['gap 3700s > ttl 3600s', 'gap 3800s > ttl 3600s']);
  });

  test('a row that names no lineage takes no place among the lineages remembered', () => {
    const ledger = new CallLedger({ hydrate: false, defaultTtl: '1h' });
    ledger.record(call({ timestamp: at(0), lineage: 'a', cacheWriteTokens: 100_000 }));
    for (let i = 0; i < 254; i++) {
      ledger.record(call({ timestamp: at(3000 + i), lineage: `other-${i}`, cacheReadTokens: 80_000 }));
    }
    ledger.record(call({ timestamp: at(3300), cacheReadTokens: 80_000 }));
    ledger.record(call({ timestamp: at(3301), lineage: 'other-254', cacheReadTokens: 80_000 }));
    // 256 lineages: a is still remembered, so its own gap reads.
    ledger.record(call({ timestamp: at(3700), lineage: 'a', cacheWriteTokens: 100_000 }));
    expect(ledger.snapshot().rows.at(-1)!.cause).toBe('gap 3700s > ttl 3600s');
  });

  test("a reload remembers every read call's lineage, though it keeps only the newest rows", () => {
    const dir = mkdtempSync(join(tmpdir(), 'call-ledger-lineage-'));
    try {
      const row = (seconds: number, lineage: string, usage: Record<string, number>) => JSON.stringify({
        type: 'call', kind: 'stream', timestamp: at(seconds), durationMs: 1000,
        requestSummary: { model: 'claude-fable-5', messages: 10, cacheBreakpoints: 4, cacheTtls: ['1h', '1h', '1h', '1h'], lineage },
        rawResponse: { stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } },
      });
      // Lineage a's earlier activity is older than the three rows the reload
      // keeps, and its last kept row is measured from it.
      writeFileSync(join(dir, 'llm-calls.test.jsonl'), [
        row(0, 'a', { cache_creation_input_tokens: 100_000 }),
        row(3000, 'b', { cache_read_input_tokens: 80_000 }),
        row(3100, 'b', { cache_read_input_tokens: 80_000 }),
        row(3700, 'a', { cache_creation_input_tokens: 100_000 }),
      ].join('\n') + '\n');
      const rows = new CallLedger({ dataDir: dir, maxRows: 3, defaultTtl: '1h' }).snapshot().rows;
      expect(rows).toHaveLength(3);
      expect(rows.at(-1)!.cause).toBe('gap 3700s > ttl 3600s');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a reload keeps its calls in time order around a call whose time can't be read", () => {
    const dir = mkdtempSync(join(tmpdir(), 'call-ledger-order-'));
    try {
      const row = (timestamp: string, usage: Record<string, number>) => JSON.stringify({
        type: 'call', kind: 'stream', timestamp, durationMs: 1000,
        requestSummary: { model: 'claude-fable-5', messages: 10, cacheBreakpoints: 4, cacheTtls: ['1h', '1h', '1h', '1h'], lineage: 'a' },
        rawResponse: { stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage } },
      });
      // In file order, a read at 3500 s, a row whose time can't be read, a
      // write at 0 and a write at 3800: the last is measured from the read.
      writeFileSync(join(dir, 'llm-calls.test.jsonl'), [
        row(at(3500), { cache_read_input_tokens: 80_000 }),
        row('not a time', { cache_read_input_tokens: 80_000 }),
        row(at(0), { cache_creation_input_tokens: 100_000 }),
        row(at(3800), { cache_creation_input_tokens: 100_000 }),
      ].join('\n') + '\n');
      const rows = new CallLedger({ dataDir: dir, defaultTtl: '1h' }).snapshot().rows;
      expect(rows.at(-1)).toMatchObject({ verdict: 'rewrite:unexplained', cause: 'cache miss inside ttl (300s <= 3600s); prefix changed or was truncated' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a call whose time can\'t be read leaves the clocks where they were', () => {
    const ledger = new CallLedger({ hydrate: false, defaultTtl: '1h' });
    ledger.record(call({ timestamp: at(0), lineage: 'a', cacheWriteTokens: 100_000 }));
    ledger.record(call({ timestamp: 'not a time', lineage: 'a', cacheReadTokens: 80_000 }));
    ledger.record(call({ timestamp: at(3700), lineage: 'a', cacheWriteTokens: 100_000 }));
    expect(ledger.snapshot().rows.at(-1)!.cause).toBe('gap 3700s > ttl 3600s');
  });

  test('parseLoggedCall reads the lineage a row names', () => {
    const row = { kind: 'stream', timestamp: at(0), requestSummary: { model: 'claude-fable-5', messages: 3, lineage: '0123456789abcdef' } };
    expect(parseLoggedCall(row)?.lineage).toBe('0123456789abcdef');
    expect(parseLoggedCall({ ...row, requestSummary: { model: 'claude-fable-5', messages: 3 } })?.lineage).toBeUndefined();
  });
});

test('summarizeCacheControls inventories markers without retaining content', () => {
  const raw = {
    system: [{ type: 'text', text: 'secret', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'private', cache_control: { type: 'ephemeral' } }] }],
  };
  expect(summarizeCacheControls(raw)).toEqual({ count: 2, ttls: ['1h', 'default'] });
});
