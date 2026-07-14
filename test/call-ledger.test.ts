import { describe, expect, test } from 'bun:test';
import { CallLedger, summarizeCacheControls, type ProviderCallRecord } from '../src/call-ledger.js';

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
});

test('summarizeCacheControls inventories markers without retaining content', () => {
  const raw = {
    system: [{ type: 'text', text: 'secret', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'private', cache_control: { type: 'ephemeral' } }] }],
  };
  expect(summarizeCacheControls(raw)).toEqual({ count: 2, ttls: ['1h', 'default'] });
});
