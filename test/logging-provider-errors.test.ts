import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from '@animalabs/membrane';
import { LoggingProviderAdapter } from '../src/logging-provider-wrapper.js';

// A provider can echo the whole rejected request in its error body (a
// household's OpenAI-compatible 400 echoed ~1.7 MB). The record keeps the
// request already; its error text is bounded, and the classification is
// kept beside it so a reader can tell a rejection from a transient failure.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function logFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'logging-provider-errors-'));
  dirs.push(dir);
  return join(dir, 'llm-calls.jsonl');
}

function failing(error: unknown): ProviderAdapter {
  return {
    name: 'error-fixture',
    usageCacheConvention: 'cache-excluded',
    requiresNativeResponsesInput: false,
    supportsModel: () => true,
    complete: async () => { throw error; },
    stream: async () => { throw error; },
  } as ProviderAdapter;
}

const request = { model: 'zz-model', maxTokens: 16, messages: [{ role: 'user', content: 'zz-prompt' }] } as unknown as ProviderRequest;
const echo = `zz-head ${'e'.repeat(1_000_000)} zz-tail`;
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function membraneLike(message: string): Error {
  return Object.assign(new Error(message), {
    name: 'MembraneError', type: 'invalid_request', httpStatus: 400, providerErrorCode: 'invalid_request_error', retryable: false,
  });
}

function records(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
}

describe('LoggingProviderAdapter error records', () => {
  for (const kind of ['complete', 'stream'] as const) {
    test(`${kind}: a ~1 MB echoed error is bounded, classified, and rethrown unchanged`, async () => {
      const path = logFile();
      const error = membraneLike(`Bad request: ${echo}`);
      const wrapped = new LoggingProviderAdapter(failing(error), path);
      const call = kind === 'complete' ? wrapped.complete(request) : wrapped.stream(request, {} as never);
      await expect(call).rejects.toBe(error);
      const [record] = records(path);
      expect(record!.type).toBe('error');
      expect((record!.error as string).length).toBeLessThanOrEqual(4_000);
      expect(record!.error as string).toMatch(/^MembraneError: Bad request: zz-head e+ …\[\d+ of \d+ characters omitted\]… e+ zz-tail$/);
      expect(record!.errorChars).toBe(`MembraneError: Bad request: ${echo}`.length);
      expect(record).toMatchObject({ errorType: 'invalid_request', httpStatus: 400, providerErrorCode: 'invalid_request_error', retryable: false });
      expect(record!.rawRequest).toEqual(request as unknown as Record<string, unknown>);
    });
  }

  test('a small error is recorded exactly as before', async () => {
    const path = logFile();
    const wrapped = new LoggingProviderAdapter(failing(new Error('zz connection reset')), path);
    await expect(wrapped.complete(request)).rejects.toThrow('zz connection reset');
    const [record] = records(path);
    expect(record!.error).toBe('Error: zz connection reset');
    expect('errorChars' in record!).toBe(false);
    expect('errorType' in record!).toBe(false);
  });

  test('a thrown non-Error is bounded too, and no excerpt splits a surrogate pair at either cut', async () => {
    const path = logFile();
    // The cuts as the bound computes them for this length: a pair is placed
    // straddling each one, and on every position around it.
    const n = 100_002;
    const marker = ` …[${n} of ${n} characters omitted]… `.length;
    const budget = 4_000 - marker;
    const tail = Math.floor(budget / 4);
    const headEnd = budget - tail;
    const tailStart = n - tail;
    const positions = [-3, -2, -1, 0, 1].flatMap((d) => [headEnd + d, tailStart + d]);
    for (const at of positions) {
      const text = `${'x'.repeat(at)}😀${'x'.repeat(n - 2 - at)}`;
      expect(text.length).toBe(n);
      await expect(new LoggingProviderAdapter(failing(text), path).complete(request)).rejects.toBe(text);
    }
    const written = records(path);
    expect(written.length).toBe(positions.length);
    for (const record of written) {
      expect((record.error as string).length).toBeLessThanOrEqual(4_000);
      expect(loneSurrogate.test(record.error as string)).toBe(false);
    }
  });

  test('an error whose message getter throws is still logged, and still rethrown', async () => {
    const path = logFile();
    const hostile = new Error('zz');
    Object.defineProperty(hostile, 'message', { get() { throw new Error('getter failed'); } });
    await expect(new LoggingProviderAdapter(failing(hostile), path).complete(request)).rejects.toBe(hostile);
    const [record] = records(path);
    expect(record!.error).toBe('[error could not be read]');
  });
});
