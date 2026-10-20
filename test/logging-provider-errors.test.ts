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
      const kept = record.error as string;
      expect(kept.length).toBeLessThanOrEqual(4_000);
      expect(loneSurrogate.test(kept)).toBe(false);
      // The stated count is what the cuts actually removed, after any step
      // a cut took to keep a pair whole.
      const m = / …\[(\d+) of (\d+) characters omitted\]… /.exec(kept)!;
      const [omitted, total] = [Number(m[1]), Number(m[2])];
      expect(total).toBe(n);
      expect(kept.length - m[0].length + omitted).toBe(n);
    }
  });

  test('an overlong errorType and providerErrorCode are each cut like the text, within 128 characters; the text, the other fields and the thrown error are unchanged', async () => {
    const path = logFile();
    // A pair at every position of a value past the bound, so wherever the
    // bound places its cuts, some case has a pair straddling each one.
    const n = 300;
    const thrown: Array<{ error: Error & { type: string; providerErrorCode: string }; type: string; code: string }> = [];
    for (let at = 0; at <= n - 2; at++) {
      const value = `${'x'.repeat(at)}😀${'x'.repeat(n - 2 - at)}`;
      const type = `zz-type ${value}`;
      const code = `zz-code ${value}`;
      const error = Object.assign(membraneLike('zz the actual provider diagnostic'), { type, providerErrorCode: code });
      await expect(new LoggingProviderAdapter(failing(error), path).complete(request)).rejects.toBe(error);
      thrown.push({ error, type, code });
    }
    const written = records(path);
    expect(written.length).toBe(thrown.length);
    written.forEach((record, i) => {
      for (const [field, prefix] of [['errorType', 'zz-type'], ['providerErrorCode', 'zz-code']] as const) {
        const kept = record[field] as string;
        expect(kept.length).toBeLessThanOrEqual(128);
        expect(kept).toMatch(new RegExp(`^${prefix} .* …\\[\\d+ of ${prefix.length + 1 + n} characters omitted\\]… .+$`));
        expect(loneSurrogate.test(kept)).toBe(false);
      }
      expect(record).toMatchObject({ error: 'MembraneError: zz the actual provider diagnostic', httpStatus: 400, retryable: false });
      expect('errorChars' in record).toBe(false);
      const { error, type, code } = thrown[i]!;
      expect([error.type, error.providerErrorCode]).toEqual([type, code]);
    });
  });

  test('a message getter that throws loses only the message: the classification is kept, the error rethrown', async () => {
    const path = logFile();
    const hostile = membraneLike('zz');
    Object.defineProperty(hostile, 'message', { get() { throw new Error('getter failed'); } });
    await expect(new LoggingProviderAdapter(failing(hostile), path).complete(request)).rejects.toBe(hostile);
    const [record] = records(path);
    expect(record!.error).toBe('MembraneError: [message could not be read]');
    expect(record).toMatchObject({ errorType: 'invalid_request', httpStatus: 400, retryable: false });
  });

  test('a thrown value whose type test itself throws (a revoked Proxy) is rethrown as the same reference (room-225 #48939)', async () => {
    const path = logFile();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    let thrown: unknown;
    try { await new LoggingProviderAdapter(failing(proxy), path).complete(request); } catch (e) { thrown = e; }
    expect(thrown === proxy).toBe(true);
    const [record] = records(path);
    expect(record!.error).toBe('[error could not be read]');
  });

  test('a metadata getter that throws loses only that field: the provider text is kept (room-225 #48791)', async () => {
    const path = logFile();
    const error = new Error('zz the actual provider diagnostic');
    Object.defineProperty(error, 'providerErrorCode', { get() { throw new Error('getter failed'); } });
    Object.assign(error, { type: 'server', retryable: true });
    await expect(new LoggingProviderAdapter(failing(error), path).complete(request)).rejects.toBe(error);
    const [record] = records(path);
    expect(record!.error).toBe('Error: zz the actual provider diagnostic');
    expect(record).toMatchObject({ errorType: 'server', retryable: true });
    expect('providerErrorCode' in record!).toBe(false);
  });
  function succeeding(response: ProviderResponse): ProviderAdapter {
    return {
      name: 'ok-fixture',
      usageCacheConvention: 'cache-excluded',
      requiresNativeResponsesInput: false,
      supportsModel: () => true,
      complete: async () => response,
      stream: async () => response,
    } as ProviderAdapter;
  }

  for (const kind of ['complete', 'stream'] as const) {
    test(`${kind}: a successful call whose record can't be built still returns the response, and is recorded as a call (sw-ch216 I1)`, async () => {
      const path = logFile();
      const response = { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } as unknown as ProviderResponse;
      Object.defineProperty(response, 'content', { get() { throw new Error('zz content getter failed'); } });
      const wrapped = new LoggingProviderAdapter(succeeding(response), path);
      const got = kind === 'complete' ? await wrapped.complete(request) : await wrapped.stream(request, {} as never);
      expect(got).toBe(response);
      const written = records(path);
      expect(written.length).toBe(1);
      expect(written[0]).toMatchObject({ type: 'call', provider: 'ok-fixture', kind, summaryUnavailable: true });
      expect('error' in written[0]!).toBe(false);
    });

    test(`${kind}: null blocks and tools are summarized, not thrown on (sw-ch216 I1)`, async () => {
      const path = logFile();
      const odd = { model: 'zz-model', messages: [{ role: 'user', content: [null, { type: 'text', text: 'zz' }] }], tools: [null, { name: 'zz-tool' }] } as unknown as ProviderRequest;
      const response = { content: [null, { type: 'text', text: 'zz-reply' }], stopReason: 'end_turn' } as unknown as ProviderResponse;
      const wrapped = new LoggingProviderAdapter(succeeding(response), path);
      const got = kind === 'complete' ? await wrapped.complete(odd) : await wrapped.stream(odd, {} as never);
      expect(got).toBe(response);
      const [record] = records(path);
      expect(record).toMatchObject({ type: 'call', requestSummary: { toolNames: [null, 'zz-tool'] } });
      expect((record!.response as { blocks: unknown[] }).blocks.length).toBe(2);
    });

    test(`${kind}: a rejection with undefined is recorded as an error and rethrown (sw-ch216 I2)`, async () => {
      const path = logFile();
      const wrapped = new LoggingProviderAdapter(failing(undefined), path);
      let thrown: unknown = 'not thrown';
      try { kind === 'complete' ? await wrapped.complete(request) : await wrapped.stream(request, {} as never); } catch (e) { thrown = e; }
      expect(thrown).toBeUndefined();
      const [record] = records(path);
      expect(record).toMatchObject({ type: 'error', error: 'undefined' });
    });

    test(`${kind}: a failure whose request can't be summarized is still recorded, and the provider's error rethrown (sw-ch216 I4, I7)`, async () => {
      const path = logFile();
      const hostile = {} as ProviderRequest;
      Object.defineProperty(hostile, 'messages', { get() { throw new Error('zz messages getter failed'); } });
      const error = membraneLike('zz the actual provider diagnostic');
      const wrapped = new LoggingProviderAdapter(failing(error), path);
      const call = kind === 'complete' ? wrapped.complete(hostile) : wrapped.stream(hostile, {} as never);
      await expect(call).rejects.toBe(error);
      const [record] = records(path);
      expect(record).toMatchObject({
        type: 'error', kind, summaryUnavailable: true,
        error: 'MembraneError: zz the actual provider diagnostic', errorType: 'invalid_request', httpStatus: 400,
      });
      expect('rawRequest' in record!).toBe(false);
    });
  }

  test('the credential monitor\'s taps follow the outcome, and a throwing tap changes nothing (merge with main\'s 8ed0a18)', async () => {
    for (const kind of ['complete', 'stream'] as const) {
      const seen: Array<[string, unknown]> = [];
      const tap = (wrapped: LoggingProviderAdapter) => {
        wrapped.onProviderError = (error) => { seen.push(['error', error]); throw new Error('zz tap failed'); };
        wrapped.onProviderSuccess = () => { seen.push(['success', undefined]); throw new Error('zz tap failed'); };
        return wrapped;
      };
      const call = (w: LoggingProviderAdapter) => (kind === 'complete' ? w.complete(request) : w.stream(request, {} as never));
      const response = { content: [], stopReason: 'end_turn' } as unknown as ProviderResponse;
      expect(await call(tap(new LoggingProviderAdapter(succeeding(response), logFile())))).toBe(response);
      const error = membraneLike('zz');
      await expect(call(tap(new LoggingProviderAdapter(failing(error), logFile())))).rejects.toBe(error);
      // A rejection with undefined is a failure for the taps too.
      let thrown: unknown = 'not thrown';
      try { await call(tap(new LoggingProviderAdapter(failing(undefined), logFile()))); } catch (e) { thrown = e; }
      expect(thrown).toBeUndefined();
      expect(seen).toEqual([['success', undefined], ['error', error], ['error', undefined]]);
    }
  });

  test('each classification field is read on its own: a throwing getter or a wrong type loses only that field (sw-ch216 I5)', async () => {
    const all = { type: 'invalid_request', httpStatus: 400, providerErrorCode: 'invalid_request_error', retryable: false };
    const recordField = { type: 'errorType', httpStatus: 'httpStatus', providerErrorCode: 'providerErrorCode', retryable: 'retryable' } as const;
    const wrongType = { type: 42, httpStatus: '429', providerErrorCode: null, retryable: 'yes' } as const;
    for (const field of Object.keys(recordField) as Array<keyof typeof recordField>) {
      for (const how of ['throws', 'wrong type'] as const) {
        const path = logFile();
        const error = Object.assign(new Error('zz the actual provider diagnostic'), { name: 'MembraneError' }, all) as Error & Record<string, unknown>;
        if (how === 'throws') Object.defineProperty(error, field, { get() { throw new Error('getter failed'); } });
        else Object.defineProperty(error, field, { value: wrongType[field] });
        await expect(new LoggingProviderAdapter(failing(error), path).complete(request)).rejects.toBe(error);
        const [record] = records(path);
        expect(record!.error).toBe('MembraneError: zz the actual provider diagnostic');
        expect(recordField[field] in record!).toBe(false);
        for (const other of Object.keys(recordField) as Array<keyof typeof recordField>) {
          if (other !== field) expect(record![recordField[other]]).toEqual(all[other]);
        }
      }
    }
    // An unreadable name falls back to "Error"; the message and fields stay.
    const path = logFile();
    const error = Object.assign(new Error('zz diagnostic'), all);
    Object.defineProperty(error, 'name', { get() { throw new Error('getter failed'); } });
    await expect(new LoggingProviderAdapter(failing(error), path).complete(request)).rejects.toBe(error);
    const [record] = records(path);
    expect(record).toMatchObject({ error: 'Error: zz diagnostic', errorType: 'invalid_request', httpStatus: 400 });
  });

  test('a record over the 16 MiB guard drops the raw bodies and keeps the bounded error and its classification (sw-ch216 I19)', async () => {
    const path = logFile();
    const huge = { model: 'zz-model', maxTokens: 16, messages: [{ role: 'user', content: `zz ${'h'.repeat(17 * 1024 * 1024)}` }] } as unknown as ProviderRequest;
    const error = membraneLike(`Bad request: ${echo}`);
    await expect(new LoggingProviderAdapter(failing(error), path).complete(huge)).rejects.toBe(error);
    const [record] = records(path);
    expect('rawRequest' in record!).toBe(false);
    expect(record!.truncated).toBe('raw bodies dropped (record exceeded size guard)');
    expect((record!.error as string).length).toBeLessThanOrEqual(4_000);
    expect(record!.errorChars).toBe(`MembraneError: Bad request: ${echo}`.length);
    expect(record).toMatchObject({ type: 'error', errorType: 'invalid_request', httpStatus: 400, retryable: false });
  });

  test('a record whose summaries cannot be serialized either keeps only its bounded head and classification (Nell-1783, room-437 #70633)', async () => {
    const path = logFile();
    const response = { content: [], stopReason: 'end_turn', usage: { inputTokens: 1n, outputTokens: 1 } } as unknown as ProviderResponse;
    const wrapped = new LoggingProviderAdapter(succeeding(response), path);
    expect(await wrapped.complete(request)).toBe(response);
    const [record] = records(path);
    expect(record).toMatchObject({ type: 'call', provider: 'ok-fixture', kind: 'complete' });
    expect(record!.truncated).toBe('only bounded head and classification kept (the record could not be serialized)');
    expect('response' in record!).toBe(false);
  });

  test('a request that cannot be serialized drops the raw bodies and keeps the record (sw-ch216 I16)', async () => {
    const path = logFile();
    const cyclic = { model: 'zz-model', maxTokens: 16, messages: [{ role: 'user', content: 'zz' }] } as Record<string, unknown>;
    cyclic.self = cyclic;
    const error = membraneLike('zz the actual provider diagnostic');
    await expect(new LoggingProviderAdapter(failing(error), path).complete(cyclic as unknown as ProviderRequest)).rejects.toBe(error);
    const [record] = records(path);
    expect('rawRequest' in record!).toBe(false);
    expect(record!.truncated).toBe('raw bodies dropped (they could not be serialized)');
    expect(record).toMatchObject({ type: 'error', error: 'MembraneError: zz the actual provider diagnostic', requestSummary: { model: 'zz-model' } });
  });
});
