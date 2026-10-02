import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KeepaliveCall, KeepaliveUsage, ProviderRequest } from '@animalabs/membrane';
import { LoggingAnthropicAdapter } from '../src/logging-adapter.js';
import { CallLedger, type ProviderCallRecord } from '../src/call-ledger.js';

const model = 'claude-fable-5';
const request: ProviderRequest = {
  model, maxTokens: 64,
  system: [{ type: 'text', text: 'stable private prefix', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
};
const readUsage: KeepaliveUsage = {
  input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 6000, cache_creation_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
  service_tier: 'standard', inference_geo: 'global',
};

async function exercise(options: {
  usage?: KeepaliveUsage; fail?: boolean; pokes?: number;
  observer?: (call: KeepaliveCall) => void | Promise<void>;
  ledgerThrows?: boolean;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'logging-keepalive-'));
  const path = join(dir, 'llm-calls.test.jsonl');
  const wire: string[] = [];
  const seen: ProviderCallRecord[] = [];
  const events: string[] = [];
  const ledger = new CallLedger({ hydrate: false });
  let finished!: () => void;
  const done = new Promise<void>(resolve => { finished = resolve; });
  let receipts = 0;
  let adapter: LoggingAnthropicAdapter | undefined;
  let seedFinished!: () => void;
  const seeded = new Promise<void>(resolve => { seedFinished = resolve; });
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      const body = await req.text();
      wire.push(body);
      const poke = JSON.parse(body).max_tokens === 0;
      // A slow runner may fire the timer before the seed call returns. Order
      // fixture responses explicitly rather than assuming a fast seed request.
      if (poke) await seeded;
      if (poke && options.fail) {
        return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'fixture rejection' } }, { status: 400 });
      }
      return Response.json({
        id: 'msg_fixture', type: 'message', role: 'assistant', model,
        content: poke ? [] : [{ type: 'text', text: 'ok' }],
        stop_reason: poke ? 'max_tokens' : 'end_turn', stop_sequence: null,
        usage: poke ? (options.usage ?? readUsage) : {
          input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 100,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 },
          service_tier: 'standard', inference_geo: 'global',
        },
      });
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    adapter = new LoggingAnthropicAdapter({
      apiKey: 'fixture-key', baseURL: server.url.toString(),
      defaultHeaders: { 'x-private-fixture': 'never-in-ledger' },
      cacheKeepalive: {
        lanes: ['complete'], refreshAfterMs: 40, checkIntervalMs: 5,
        maxIdleMs: 10000,
        onEvent(event) { events.push(event.type); },
        onCall(call) {
          receipts++;
          if (receipts >= (options.pokes ?? 1)) {
            adapter?.cacheKeepalive?.stop();
            finished();
          }
          return options.observer?.(call);
        },
      },
    }, path, undefined, record => {
      seen.push(record);
      ledger.record(record);
      if (options.ledgerThrows && record.kind === 'keepalive') throw new Error('fixture ledger observer');
    });
    await adapter.complete(request);
    seedFinished();
    await Promise.race([
      done,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('keepalive receipt timed out')), 5000);
      }),
    ]);
    // Let isolated observer promises and onEvent finish before checking them.
    await Bun.sleep(0);
    const logs = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    return { wire, seen, events, logs, receipts, live: ledger.snapshot(), reloaded: new CallLedger({ dataDir: dir }).snapshot() };
  } finally {
    seedFinished();
    if (timeout !== undefined) clearTimeout(timeout);
    adapter?.cacheKeepalive?.stop();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('keepalive calls reach the normal logs and spend ledger', () => {
  test('a real request seeds a timer poke with exact payload and cache-read usage', async () => {
    const result = await exercise();
    expect(result.receipts).toBe(1);
    expect(result.logs.map(r => r.kind)).toEqual(['complete', 'keepalive']);
    const poke = result.logs[1];
    expect(poke.type).toBe('call');
    expect(poke.requestSummary).toMatchObject({ model, maxTokens: 0, messages: 1, cacheBreakpoints: 1, cacheTtls: ['1h'] });
    expect(poke.rawRequest).toBeUndefined();
    expect(poke.rawResponse.usage).toEqual(readUsage);
    expect(JSON.stringify(result.logs)).not.toContain('never-in-ledger');
    const expected = { ...JSON.parse(result.wire[0]), max_tokens: 0 };
    delete expected.stream;
    expect(result.wire[1]).toBe(JSON.stringify(expected));
    expect(result.seen[1]).toMatchObject({
      kind: 'keepalive', inputTokens: 7, outputTokens: 0, cacheReadTokens: 6000, cacheWriteTokens: 0,
      serviceTier: 'standard', inferenceGeo: 'global',
    });
    expect(result.live.rows[1]).toMatchObject({ kind: 'keepalive', originEstimate: 'keepalive', verdict: 'HIT' });
    expect(result.live.rows[1].cost!.total).toBeGreaterThan(0);
    expect(result.live.summary.calls).toBe(2);
    expect(result.reloaded).toEqual(result.live);
    expect(result.events).toContain('refreshed');
  });

  test('ineffective writes retain split cache buckets and contribute their actual cost', async () => {
    const usage = { ...readUsage, cache_read_input_tokens: 0, cache_creation_input_tokens: 6000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 5000 } };
    const result = await exercise({ usage });
    expect(result.logs[1].rawResponse.usage).toEqual(usage);
    expect(result.seen[1]).toMatchObject({ cacheWriteTokens: 6000, cacheWrite5mTokens: 1000, cacheWrite1hTokens: 5000, cacheWriteBucketsAuthoritative: true });
    expect(result.live.rows[1].cost!.cacheWrite5m).toBeGreaterThan(0);
    expect(result.live.rows[1].cost!.cacheWrite1h).toBeGreaterThan(0);
    expect(result.reloaded).toEqual(result.live);
    expect(result.events).toContain('ineffective');
  });

  test('failed pokes emit an error row without inventing usage or cost', async () => {
    const result = await exercise({ fail: true });
    expect(result.logs[1]).toMatchObject({ kind: 'keepalive', type: 'error', rawRequest: { max_tokens: 0 } });
    expect(result.logs[1].error.message).toContain('fixture rejection');
    expect(result.live.rows[1]).toMatchObject({ kind: 'keepalive', verdict: 'ERROR', tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(result.live.rows[1].cost).toBeUndefined();
    expect(result.reloaded).toEqual(result.live);
    expect(result.events).toContain('error');
  });

  test('caller mutation and sync failure cannot change logged usage or the next poke', async () => {
    const result = await exercise({ pokes: 2, ledgerThrows: true, observer(call) {
      call.request.system = 'mutated';
      if (call.outcome === 'success') call.response.usage = { input_tokens: 99999 };
      throw new Error('fixture caller observer');
    } });
    expect(result.logs.map(r => r.kind)).toEqual(['complete', 'keepalive', 'keepalive']);
    expect(result.wire[2]).toBe(result.wire[1]);
    expect(result.logs[1].rawResponse.usage).toEqual(readUsage);
    expect(result.logs[2].rawResponse.usage).toEqual(readUsage);
    expect(result.events.filter(event => event === 'refreshed')).toHaveLength(2);
  });

  test('caller async rejection remains isolated from the keepalive loop', async () => {
    const result = await exercise({ observer: async () => { throw new Error('fixture async observer'); } });
    expect(result.logs.map(r => r.kind)).toEqual(['complete', 'keepalive']);
    expect(result.events).toContain('refreshed');
  });
});
