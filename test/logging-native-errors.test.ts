import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicAdapter, BedrockAdapter, MembraneError, cacheLineageKey } from '@animalabs/membrane';
import type { ProviderRequest, ProviderResponse } from '@animalabs/membrane';
import { LoggingAnthropicAdapter } from '../src/logging-adapter.js';
import { LoggingBedrockAdapter } from '../src/logging-bedrock-adapter.js';
import { CallLedger, type ProviderCallRecord } from '../src/call-ledger.js';

const request: ProviderRequest = { messages: [], model: 'claude-opus-4-6', maxTokens: 16 };
const dirs: string[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function failWith(base: { prototype: object }, thrown: unknown): void {
  const proto = base.prototype as Record<string, unknown>;
  const { complete, stream } = proto;
  proto.complete = async () => { throw thrown; };
  proto.stream = async () => { throw thrown; };
  restores.push(() => { proto.complete = complete; proto.stream = stream; });
}

function succeedWith(base: { prototype: object }, response: ProviderResponse): void {
  const proto = base.prototype as Record<string, unknown>;
  const { complete, stream } = proto;
  proto.complete = async () => response;
  proto.stream = async () => response;
  restores.push(() => { proto.complete = complete; proto.stream = stream; });
}

type Adapter = {
  complete: (request: ProviderRequest) => Promise<ProviderResponse>;
  stream: (request: ProviderRequest, callbacks: object) => Promise<ProviderResponse>;
  onProviderError?: (error: unknown) => void;
  onProviderSuccess?: () => void;
};

function writers(): Array<{ name: 'anthropic' | 'bedrock'; base: { prototype: object }; stack: boolean; hostile: ProviderRequest; make: (log: string, calls: ProviderCallRecord[]) => Adapter }> {
  return [
    {
      name: 'anthropic', base: AnthropicAdapter, stack: true,
      hostile: { ...request, messages: undefined } as unknown as ProviderRequest,
      make: (log, calls) => new LoggingAnthropicAdapter({ apiKey: 'test' }, log, undefined, (call) => calls.push(call)) as never,
    },
    {
      name: 'bedrock', base: BedrockAdapter, stack: false,
      hostile: { ...request, messages: [{ role: 'user', content: [null] }] } as unknown as ProviderRequest,
      make: (log) => new LoggingBedrockAdapter({ region: 'us-east-1', accessKeyId: 'test', secretAccessKey: 'test' } as never, log) as never,
    },
  ];
}

function records(log: string): Array<Record<string, unknown>> {
  return readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function setup(w: ReturnType<typeof writers>[number]) {
  const dir = mkdtempSync(join(tmpdir(), 'llm-native-errors-'));
  dirs.push(dir);
  const log = join(dir, 'llm-calls.test.jsonl');
  const calls: ProviderCallRecord[] = [];
  const adapter = w.make(log, calls);
  const errors: unknown[] = [];
  let successes = 0;
  adapter.onProviderError = (error) => { errors.push(error); };
  adapter.onProviderSuccess = () => { successes++; };
  const call = (kind: 'complete' | 'stream', req: ProviderRequest = request) =>
    kind === 'complete' ? adapter.complete(req) : adapter.stream(req, {});
  return { dir, log, calls, errors, successes: () => successes, call };
}

function ledgerRows(dir: string, calls: ProviderCallRecord[]) {
  const live = new CallLedger({ hydrate: false });
  for (const call of calls) live.record(call);
  return { live: live.snapshot().rows, restored: new CallLedger({ dataDir: dir }).snapshot().rows };
}

describe('the Anthropic and Bedrock writers\' error records', () => {
  for (const w of writers()) {
    for (const kind of ['complete', 'stream'] as const) {
      test(`${w.name} ${kind}: an echoed request in the error is bounded, the error rethrown as it was`, async () => {
        const { log, calls, call } = setup(w);
        const echo = 'x'.repeat(200_000);
        const thrown = Object.assign(new Error(`400 invalid request: ${echo}`), {
          type: 'invalid_request_error', httpStatus: 400, providerErrorCode: 'invalid_request', retryable: false,
        });
        failWith(w.base, thrown);
        await expect(call(kind)).rejects.toBe(thrown);
        const [record] = records(log);
        const error = record!.error as { name: string; message: string; stack?: string };
        expect(error.name).toBe('Error');
        expect(error.message.length).toBeLessThanOrEqual(4_000);
        expect(error.message).toStartWith('400 invalid request: xxx');
        expect(error.message).toContain('characters omitted]');
        expect(record!.errorChars).toBe(thrown.message.length);
        expect(record!.errorType).toBe('invalid_request_error');
        expect(record!.httpStatus).toBe(400);
        expect(record!.providerErrorCode).toBe('invalid_request');
        expect(record!.retryable).toBe(false);
        if (w.stack) {
          expect(error.stack).toStartWith('Error: [the message above]\n');
          expect(error.stack).toContain('    at ');
          expect(error.stack!.length).toBeLessThan(4_000);
          expect(calls).toHaveLength(1);
          expect(calls[0]!.error).toBe(error.message);
        } else {
          expect('stack' in error).toBe(false);
        }
        expect(JSON.stringify(record).length).toBeLessThan(20_000);
      });

      test(`${w.name} ${kind}: a small error's name and message are recorded whole`, async () => {
        const { log, calls, call } = setup(w);
        const thrown = new TypeError('fetch failed');
        failWith(w.base, thrown);
        await expect(call(kind)).rejects.toBe(thrown);
        const [record] = records(log);
        const error = record!.error as Record<string, unknown>;
        expect(error.name).toBe('TypeError');
        expect(error.message).toBe('fetch failed');
        expect('errorChars' in record!).toBe(false);
        if (w.stack) {
          expect(error.stack).toStartWith('TypeError: [the message above]\n');
          expect(calls[0]!.error).toBe('fetch failed');
        }
      });

      test(`${w.name} ${kind}: a thrown value whose type test throws (a revoked Proxy) is rethrown, not replaced`, async () => {
        const { log, calls, errors, call } = setup(w);
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        failWith(w.base, proxy);
        await expect(call(kind)).rejects.toBe(proxy);
        const [record] = records(log);
        expect(record!.error).toBe('[error could not be read]');
        if (w.name === 'anthropic') {
          expect(errors).toHaveLength(1);
          expect(errors[0]).toBe(proxy);
          expect(calls).toHaveLength(1);
          expect(calls[0]!.error).toBe('[error could not be read]');
        }
      });

      test(`${w.name} ${kind}: a rejection with undefined is recorded as the failure it is, and on anthropic observed as one`, async () => {
        const { log, calls, errors, successes, call } = setup(w);
        failWith(w.base, undefined);
        await expect(call(kind)).rejects.toBeUndefined();
        const [record] = records(log);
        expect(record!.type).toBe('error');
        expect(record!.error).toBe('undefined');
        if (w.name === 'anthropic') {
          expect(errors).toHaveLength(1);
          expect(errors[0]).toBeUndefined();
          expect(successes()).toBe(0);
          expect(calls[0]!.error).toBe('undefined');
        }
      });

      test(`${w.name} ${kind}: a thrown string is bounded like a message`, async () => {
        const { log, call } = setup(w);
        const thrown = `upstream said: ${'y'.repeat(100_000)}`;
        failWith(w.base, thrown);
        await expect(call(kind)).rejects.toBe(thrown);
        const [record] = records(log);
        expect(typeof record!.error).toBe('string');
        expect((record!.error as string).length).toBeLessThanOrEqual(4_000);
        expect(record!.error as string).toStartWith('upstream said: yyy');
        expect(record!.error as string).toContain('characters omitted]');
        expect(record!.errorChars).toBe(thrown.length);
      });

      test(`${w.name} ${kind}: an Error whose every part throws when read is recorded, and rethrown`, async () => {
        const { log, call } = setup(w);
        const thrown = new Error('never read');
        for (const part of ['name', 'message', 'stack', 'type', 'httpStatus', 'providerErrorCode', 'retryable']) {
          Object.defineProperty(thrown, part, { get() { throw new Error(`${part} getter failed`); } });
        }
        failWith(w.base, thrown);
        await expect(call(kind)).rejects.toBe(thrown);
        const [record] = records(log);
        expect(record!.error).toEqual({ name: 'Error', message: '[message could not be read]' });
        for (const field of ['errorType', 'httpStatus', 'providerErrorCode', 'retryable', 'errorChars']) {
          expect(field in record!).toBe(false);
        }
      });

      test(`${w.name} ${kind}: a long name is bounded like a classification code`, async () => {
        const { log, call } = setup(w);
        const thrown = new Error('short');
        thrown.name = `Custom${'N'.repeat(10_000)}Error`;
        failWith(w.base, thrown);
        await expect(call(kind)).rejects.toBe(thrown);
        const [record] = records(log);
        const error = record!.error as { name: string; stack?: string };
        expect(error.name.length).toBeLessThanOrEqual(128);
        expect(error.name).toStartWith('CustomNNN');
        expect(error.name).toContain('characters omitted]');
        if (w.stack) expect(error.stack).toStartWith(`${error.name}: [the message above]\n`);
      });
    }
  }

  for (const w of writers()) {
    for (const kind of ['complete', 'stream'] as const) {
      test(`${w.name} ${kind}: a failed call whose request the summary can't fully read is still recorded and observed`, async () => {
        const { dir, log, calls, errors, call } = setup(w);
        const thrown = Object.assign(new Error('overloaded'), { type: 'overloaded', retryable: true });
        failWith(w.base, thrown);
        await expect(call(kind, w.hostile)).rejects.toBe(thrown);
        const [record] = records(log);
        expect(record).toMatchObject({
          type: 'error', kind, error: { name: 'Error', message: 'overloaded' }, errorType: 'overloaded', retryable: true,
        });
        if (w.name === 'anthropic') {
          expect(record!.requestSummary).toEqual({ model: 'claude-opus-4-6', maxTokens: 16, tools: 0 });
          expect('summaryUnavailable' in record!).toBe(false);
          expect(errors).toHaveLength(1);
          expect(errors[0]).toBe(thrown);
          expect(calls).toHaveLength(1);
          expect(calls[0]).toMatchObject({ kind, model: 'claude-opus-4-6', messages: 0, error: 'overloaded' });
          const { live, restored } = ledgerRows(dir, calls);
          expect(live[0]).toMatchObject({ verdict: 'ERROR', cause: 'overloaded', messages: 0 });
          expect(restored).toEqual(live);
        } else {
          expect(record).toMatchObject({ summaryUnavailable: true });
          expect('requestSummary' in record!).toBe(false);
        }
      });

      test(`${w.name} ${kind}: a successful call whose request the summary can't fully read still returns its response`, async () => {
        const { dir, log, calls, errors, successes, call } = setup(w);
        const response = {
          content: [{ type: 'text', text: 'hello' }],
          stopReason: 'end_turn',
          usage: { inputTokens: 3, outputTokens: 2 },
          raw: { stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } },
        } as unknown as ProviderResponse;
        succeedWith(w.base, response);
        await expect(call(kind, w.hostile)).resolves.toBe(response);
        const [record] = records(log);
        expect(record).toMatchObject({ type: 'call', kind });
        if (w.name === 'anthropic') {
          expect(record!.requestSummary).toEqual({ model: 'claude-opus-4-6', maxTokens: 16, tools: 0 });
          expect(record!.rawResponse).toEqual({ stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } });
          expect(successes()).toBe(1);
          expect(errors).toHaveLength(0);
          expect(calls).toHaveLength(1);
          expect(calls[0]!.error).toBeUndefined();
          const { live, restored } = ledgerRows(dir, calls);
          expect(live[0]).toMatchObject({ tokens: { input: 3, output: 2 }, stopReason: 'end_turn', messages: 0 });
          expect(restored).toEqual(live);
        } else {
          expect(record).toMatchObject({ summaryUnavailable: true });
        }
      });
    }
  }

  for (const kind of ['complete', 'stream'] as const) {
    test(`anthropic ${kind}: a failure whose text is empty is an ERROR in the ledger, live and restored`, async () => {
      for (const thrown of [new Error(''), '']) {
        const { dir, log, calls, call } = setup(writers()[0]!);
        failWith(AnthropicAdapter, thrown);
        await expect(call(kind)).rejects.toBe(thrown);
        const [record] = records(log);
        expect(record!.error).toEqual(typeof thrown === 'string' ? '' : { name: 'Error', message: '', stack: expect.any(String) });
        expect(calls[0]!.error).toBe('');
        const { live, restored } = ledgerRows(dir, calls);
        expect(live[0]).toMatchObject({ verdict: 'ERROR', cause: 'the error carried no text', error: '' });
        expect('cost' in live[0]!).toBe(false);
        expect(restored).toEqual(live);
        for (const restore of restores.splice(0)) restore();
      }
    });

    test(`anthropic ${kind}: a raw request whose cache summary can't be read costs only that summary`, async () => {
      const { dir, log, calls, call } = setup(writers()[0]!);
      const { proxy, revoke } = Proxy.revocable({}, {});
      revoke();
      const response = {
        content: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 4 },
        raw: { stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 4 } },
      } as unknown as ProviderResponse;
      const proto = AnthropicAdapter.prototype as unknown as Record<string, unknown>;
      const { complete, stream } = proto;
      const deliver = async (_request: unknown, a?: unknown, b?: unknown) => {
        const options = (kind === 'complete' ? a : b) as { onRequest?: (raw: unknown) => void } | undefined;
        options?.onRequest?.({ model: 'claude-opus-4-6', messages: [proxy] });
        return response;
      };
      proto.complete = deliver;
      proto.stream = deliver;
      restores.push(() => { proto.complete = complete; proto.stream = stream; });
      await expect(call(kind)).resolves.toBe(response);
      const [record] = records(log);
      expect(record!.requestSummary).toEqual({
        model: 'claude-opus-4-6', maxTokens: 16, messages: 0, tools: 0, lineage: cacheLineageKey({ model: 'claude-opus-4-6' }),
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cacheBreakpoints).toBeUndefined();
      const { live, restored } = ledgerRows(dir, calls);
      expect(live[0]).toMatchObject({ verdict: 'HIT', tokens: { input: 5, output: 1, cacheRead: 4 } });
      expect(restored).toEqual(live);
    });

    test(`anthropic ${kind}: a successful call whose response can't be read is recorded minimal, with no ledger row`, async () => {
      const { dir, log, calls, successes, call } = setup(writers()[0]!);
      const response = { content: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } as Record<string, unknown>;
      Object.defineProperty(response, 'raw', { get() { throw new Error('raw getter failed'); } });
      succeedWith(AnthropicAdapter, response as unknown as ProviderResponse);
      await expect(call(kind)).resolves.toBe(response as unknown as ProviderResponse);
      const [record] = records(log);
      expect(record).toEqual({ type: 'call', kind, timestamp: expect.any(String), durationMs: expect.any(Number), summaryUnavailable: true });
      expect(successes()).toBe(1);
      expect(calls).toHaveLength(0);
      expect(ledgerRows(dir, calls).restored).toEqual([]);
    });
  }

  test('anthropic: a message that changes on each read is read once, and the record and the ledger agree', async () => {
    const { log, calls, call } = setup(writers()[0]!);
    const thrown = new Error('placeholder');
    let reads = 0;
    Object.defineProperty(thrown, 'message', { get() { reads++; return `read ${reads}`; } });
    failWith(AnthropicAdapter, thrown);
    await expect(call('complete')).rejects.toBe(thrown);
    expect(reads).toBe(1);
    expect((records(log)[0]!.error as { message: string }).message).toBe('read 1');
    expect(calls[0]!.error).toBe('read 1');
  });

  for (const w of writers()) {
    test(`${w.name}: a long error type and provider code are bounded like the name`, async () => {
      const { log, call } = setup(w);
      const thrown = Object.assign(new Error('short'), {
        type: `type_${'t'.repeat(10_000)}`, providerErrorCode: `code_${'c'.repeat(10_000)}`,
      });
      failWith(w.base, thrown);
      await expect(call('complete')).rejects.toBe(thrown);
      const [record] = records(log);
      for (const field of ['errorType', 'providerErrorCode'] as const) {
        const value = record![field] as string;
        expect(value.length).toBeLessThanOrEqual(128);
        expect(value).toContain('characters omitted]');
      }
      expect(record!.errorType as string).toStartWith('type_ttt');
      expect(record!.providerErrorCode as string).toStartWith('code_ccc');
    });
  }

  test('anthropic: a real MembraneError echoing the request keeps its frames, not the echo', async () => {
    const { log } = setup(writers()[0]!);
    const thrown = new MembraneError({
      type: 'invalid_request', message: `400 invalid request: ${'x'.repeat(200_000)}`, retryable: false, httpStatus: 400,
    });
    failWith(AnthropicAdapter, thrown);
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, log);
    await expect(adapter.complete(request)).rejects.toBe(thrown);
    const [record] = records(log);
    const error = record!.error as { name: string; message: string; stack: string };
    expect(error.name).toBe('MembraneError');
    expect(error.stack).toStartWith('MembraneError: [the message above]\n');
    expect(error.stack).toContain('    at ');
    expect(error.stack).not.toContain('characters omitted]');
    expect(record).toMatchObject({ errorType: 'invalid_request', httpStatus: 400, retryable: false });
  });

  test('anthropic: a multi-line message\'s header is recognized whole', async () => {
    const { log } = setup(writers()[0]!);
    const thrown = new Error('first line\nsecond line');
    failWith(AnthropicAdapter, thrown);
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, log);
    await expect(adapter.complete(request)).rejects.toBe(thrown);
    const stack = (records(log)[0]!.error as { stack: string }).stack;
    expect(stack).toStartWith('Error: [the message above]\n    at ');
  });

  test('anthropic: a stack that is only the header line names the message above', async () => {
    const { log } = setup(writers()[0]!);
    const thrown = new Error('abc');
    Object.defineProperty(thrown, 'stack', { value: 'Error: abc' });
    failWith(AnthropicAdapter, thrown);
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, log);
    await expect(adapter.complete(request)).rejects.toBe(thrown);
    expect((records(log)[0]!.error as { stack: string }).stack).toBe('Error: [the message above]');
  });

  test('anthropic: a stack whose first line only begins with the header is kept as it is', async () => {
    const { log } = setup(writers()[0]!);
    const thrown = new Error('abc');
    Object.defineProperty(thrown, 'stack', { value: 'Error: abcdef\n    at frame (file.js:1:1)' });
    failWith(AnthropicAdapter, thrown);
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, log);
    await expect(adapter.complete(request)).rejects.toBe(thrown);
    expect((records(log)[0]!.error as { stack: string }).stack).toBe('Error: abcdef\n    at frame (file.js:1:1)');
  });

  test('anthropic: a missing or non-string stack is left out', async () => {
    for (const value of [undefined, 42]) {
      const { log } = setup(writers()[0]!);
      const thrown = new Error('no stack here');
      Object.defineProperty(thrown, 'stack', { value });
      failWith(AnthropicAdapter, thrown);
      const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, log);
      await expect(adapter.complete(request)).rejects.toBe(thrown);
      expect(records(log)[0]!.error).toEqual({ name: 'Error', message: 'no stack here' });
      for (const restore of restores.splice(0)) restore();
    }
  });

  test('anthropic: a long stack that doesn\'t open with the message is bounded, with the omission stated', async () => {
    const { log } = setup(writers()[0]!);
    const thrown = new Error('short');
    Object.defineProperty(thrown, 'stack', { value: `Wrapped: ${'y'.repeat(50_000)}\n    at frame (file.js:1:1)` });
    failWith(AnthropicAdapter, thrown);
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, log);
    await expect(adapter.complete(request)).rejects.toBe(thrown);
    const [record] = records(log);
    const stack = (record!.error as { stack: string }).stack;
    expect(stack.length).toBeLessThanOrEqual(4_000);
    expect(stack).toStartWith('Wrapped: yyy');
    expect(stack).toContain('characters omitted]');
    expect(stack).toEndWith('    at frame (file.js:1:1)');
  });

  test('bedrock: a stack is never read', async () => {
    const { log } = setup(writers()[1]!);
    const thrown = new Error('short');
    let reads = 0;
    Object.defineProperty(thrown, 'stack', { get() { reads++; return 'never wanted'; } });
    failWith(BedrockAdapter, thrown);
    const adapter = new LoggingBedrockAdapter({ region: 'us-east-1', accessKeyId: 'test', secretAccessKey: 'test' } as never, log);
    await expect(adapter.complete(request)).rejects.toBe(thrown);
    expect(reads).toBe(0);
    expect('stack' in (records(log)[0]!.error as object)).toBe(false);
  });
});
