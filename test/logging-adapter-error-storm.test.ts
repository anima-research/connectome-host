/**
 * Error records drop the raw request for errors whose cause is not in the
 * request (rate limit, overload, network, auth) — those repeat across
 * retries — and keep it where the request is the evidence.
 */
import { test, expect, afterEach } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicAdapter, rateLimitError, serverError, invalidRequestError } from '@animalabs/membrane';
import { LoggingAnthropicAdapter } from '../src/logging-adapter.js';

const BIG = { model: 'claude-fable-5', messages: [{ role: 'user', content: 'x'.repeat(200_000) }] };
const proto = AnthropicAdapter.prototype as unknown as Record<'complete' | 'stream', unknown>;
const original = { complete: proto.complete, stream: proto.stream };
const logPath = join(tmpdir(), `llm-error-storm-${process.pid}.jsonl`);

afterEach(() => {
  proto.complete = original.complete;
  proto.stream = original.stream;
  delete process.env.LLM_CALLS_FULL_PAYLOADS;
  rmSync(logPath, { force: true });
});

/** Make the underlying adapter capture BIG as its raw request, then fail. */
function failWith(err: unknown): void {
  const fail = async (_req: unknown, a?: unknown, b?: unknown) => {
    const opts = (b ?? a) as { onRequest?: (r: unknown) => void } | undefined;
    opts?.onRequest?.(BIG);
    throw err;
  };
  proto.complete = fail;
  proto.stream = fail;
}

async function lastErrorRecord(kind: 'complete' | 'stream'): Promise<Record<string, unknown>> {
  const adapter = new LoggingAnthropicAdapter({ apiKey: 'test-key' }, logPath, () => ({ enabled: false, budgetTokens: 0 }));
  const request = { model: 'claude-fable-5', messages: [] } as never;
  const call = kind === 'complete' ? adapter.complete(request) : adapter.stream(request, {} as never);
  await expect(call).rejects.toBeDefined();
  const lines = readFileSync(logPath, 'utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

for (const kind of ['complete', 'stream'] as const) {
  test(`${kind}: rate-limit error records a size note, not the request`, async () => {
    failWith(rateLimitError('429 too many requests'));
    const rec = await lastErrorRecord(kind);
    expect(rec.type).toBe('error');
    expect(rec.rawRequest).toMatchObject({ bytes: JSON.stringify(BIG).length });
    expect(JSON.stringify(rec).length).toBeLessThan(10_000);
  });
}

test('server (overload) error records a size note', async () => {
  failWith(serverError('529 overloaded', 529));
  expect((await lastErrorRecord('stream')).rawRequest).toMatchObject({ bytes: expect.any(Number) });
});

test('invalid_request keeps the full request (it is the evidence)', async () => {
  failWith(invalidRequestError('400 messages: roles must alternate'));
  expect((await lastErrorRecord('stream')).rawRequest).toEqual(BIG);
});

test('non-membrane errors keep the full request (unchanged behaviour)', async () => {
  failWith(new Error('something else'));
  expect((await lastErrorRecord('complete')).rawRequest).toEqual(BIG);
});

test('LLM_CALLS_FULL_PAYLOADS=1 keeps the request even for a rate limit', async () => {
  process.env.LLM_CALLS_FULL_PAYLOADS = '1';
  failWith(rateLimitError('429'));
  expect((await lastErrorRecord('stream')).rawRequest).toEqual(BIG);
});
