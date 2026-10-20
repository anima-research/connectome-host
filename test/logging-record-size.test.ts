import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoggingAnthropicAdapter } from '../src/logging-adapter.js';
import { LoggingBedrockAdapter } from '../src/logging-bedrock-adapter.js';
import { LoggingProviderAdapter } from '../src/logging-provider-wrapper.js';
import { MAX_RECORD_BYTES, serializeRecord } from '../src/logging-record.js';
import { parseLoggedCall } from '../src/call-ledger.js';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const CAP = 16 * 1024 * 1024;
const factories = {
  anthropic: (p: string) => new LoggingAnthropicAdapter({ apiKey: 'unit-test' }, p),
  bedrock: (p: string) => new LoggingBedrockAdapter({ region: 'us-east-1', accessKeyId: 'unit-test', secretAccessKey: 'unit-test' } as never, p),
  generic: (p: string) => new LoggingProviderAdapter({ name: 'unit-test', supportsModel: () => true } as never, p),
};
const head = { type: 'error', provider: 'unit-test', kind: 'stream', timestamp: '2026-10-19T00:00:00.000Z', durationMs: 3, error: 'invalid request', errorType: 'invalid_request', httpStatus: 400, retryable: false };
function emit(make: (p: string) => unknown, record: object) {
  const d = mkdtempSync(join(tmpdir(), 'llm-record-size-')); dirs.push(d);
  const p = join(d, 'llm-calls.test.jsonl');
  (make(p) as { log(r: object): void }).log(record);
  const bytes = readFileSync(p);
  expect(bytes[bytes.length - 1]).toBe(10);
  const parsed = JSON.parse(bytes.toString('utf8'));
  return { bytes, parsed };
}
// A failing assertion prints what it received, and these records hold values
// of up to 16 MiB. So the tests assert presence as a boolean, compare large
// values by identity, and compare whole objects only by their small fields.
const has = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key);
const fields = (record: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((key) => has(record, key)).map((key) => [key, record[key]]));
for (const [name, make] of Object.entries(factories)) {
  test(`${name}: cap counts UTF8 bytes and preserves error classification after dropping raw bodies`, () => {
    const record = { ...head, requestSummary: { model: 'unit-test', messageCount: 1 }, rawRequest: '界'.repeat(6_000_000) };
    const { bytes, parsed } = emit(make, record);
    expect(bytes.byteLength).toBeLessThanOrEqual(CAP);
    expect(fields(parsed, Object.keys(head))).toEqual(head);
    expect(parsed.requestSummary).toEqual(record.requestSummary);
    expect(has(parsed, 'rawRequest')).toBe(false);
    expect(typeof parsed.truncated).toBe('string');
  });
  test(`${name}: oversized summaries cannot bypass the final byte cap`, () => {
    const { bytes, parsed } = emit(make, { ...head, requestSummary: { toolNames: ['界'.repeat(6_000_000)] }, rawRequest: 'small' });
    expect(bytes.byteLength).toBeLessThanOrEqual(CAP);
    expect(fields(parsed, Object.keys(head))).toEqual(head);
    expect(typeof parsed.truncated).toBe('string');
  });
  test(`${name}: ordinary records retain their exact serialized shape`, () => {
    const record = { ...head, requestSummary: { model: 'unit-test' }, rawRequest: { diagnostic: true }, rawResponse: { ok: false } };
    const { bytes, parsed } = emit(make, record);
    expect(parsed).toEqual(record);
    expect(bytes.toString('utf8')).toBe(JSON.stringify(record) + '\n');
  });
  test(`${name}: an oversized request goes and the raw response stays`, () => {
    const rawResponse = { stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } };
    const { bytes, parsed } = emit(make, { ...head, type: 'call', requestSummary: { model: 'unit-test' }, rawRequest: '界'.repeat(6_000_000), rawResponse });
    expect(bytes.byteLength).toBeLessThanOrEqual(CAP);
    expect(has(parsed, 'rawRequest')).toBe(false);
    expect(parsed.rawResponse).toEqual(rawResponse);
    expect(parsed.truncated).toBe('raw request dropped (record exceeded size guard)');
  });
  test(`${name}: an unserializable raw body retains an actionable error record`, () => {
    const cycle: any = {}; cycle.self = cycle;
    const { bytes, parsed } = emit(make, { ...head, requestSummary: { model: 'unit-test' }, rawRequest: cycle });
    expect(bytes.byteLength).toBeLessThanOrEqual(CAP);
    expect(fields(parsed, Object.keys(head))).toEqual(head);
    expect(has(parsed, 'rawRequest')).toBe(false);
    expect(typeof parsed.truncated).toBe('string');
  });
}

/** The line serializeRecord gives, its byte length and its parsed record. */
function line(record: Record<string, unknown>) {
  const text = serializeRecord(record);
  expect(text.endsWith('\n')).toBe(true);
  return { bytes: Buffer.byteLength(text, 'utf8'), parsed: JSON.parse(text) as Record<string, any> };
}
/** A successful call's raw response: what the call ledger and the doctor read. */
const response = { stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 0 } };
const call = { type: 'call', provider: 'unit-test', kind: 'stream', timestamp: '2026-10-19T00:00:00.000Z', durationMs: 3, requestSummary: { model: 'unit-test', messages: 2 } };
const BIG = 'x'.repeat(CAP + 1);

describe('serializeRecord drops parts in order, each step checked against the cap', () => {
  test('a record whose line fills the cap exactly, its newline included, is written whole; one byte more drops its raw bodies', () => {
    const base = { ...call, rawRequest: '' };
    const room = CAP - 1 - JSON.stringify(base).length;
    const exact = line({ ...base, rawRequest: 'x'.repeat(room) });
    expect(exact.bytes).toBe(CAP);
    expect(exact.parsed.rawRequest.length).toBe(room);
    expect(exact.parsed.truncated).toBeUndefined();
    const over = line({ ...base, rawRequest: 'x'.repeat(room + 1) });
    expect(has(over.parsed, 'rawRequest')).toBe(false);
    expect(over.parsed.truncated).toBe('raw bodies dropped (record exceeded size guard)');
    // Two-byte characters bring a line of half as many UTF-16 units to the
    // cap's bytes before its newline, so only the byte count, newline
    // included, can tell it doesn't fit.
    const twoByte = 'é'.repeat(Math.floor((room + 1) / 2)) + 'x'.repeat((room + 1) % 2);
    const multiByte = line({ ...base, rawRequest: twoByte });
    expect(has(multiByte.parsed, 'rawRequest')).toBe(false);
    expect(multiByte.parsed.truncated).toBe('raw bodies dropped (record exceeded size guard)');
  });

  test('a multi-byte record under the cap is counted by its bytes and written whole', () => {
    // 6,000,000 two-byte characters: 12 MB of UTF-8, over what a count of
    // UTF-16 units alone could clear, under the cap.
    const record = { ...call, rawRequest: 'é'.repeat(6_000_000) };
    const { bytes, parsed } = line(record);
    expect(bytes).toBeLessThan(CAP);
    expect(Object.keys(parsed)).toEqual(Object.keys(record));
    expect(parsed.rawRequest === record.rawRequest).toBe(true);
  });

  test('an oversized request goes first, and the response, which holds usage and the stop reason, stays', () => {
    const { bytes, parsed } = line({ ...call, rawRequest: BIG, rawResponse: response });
    expect(bytes).toBeLessThanOrEqual(CAP);
    expect(has(parsed, 'rawRequest')).toBe(false);
    expect(parsed.rawResponse).toEqual(response);
    expect(parsed.requestSummary).toEqual(call.requestSummary);
    expect(parsed.truncated).toBe('raw request dropped (record exceeded size guard)');
  });

  test("the call ledger's restore reads that line's usage and stop reason", () => {
    const restored = parseLoggedCall(JSON.parse(serializeRecord({ ...call, rawRequest: BIG, rawResponse: response })));
    expect(restored).toMatchObject({ inputTokens: 12, outputTokens: 34, cacheReadTokens: 5_000, stopReason: 'end_turn' });
  });

  test('a null raw response counts as none: both raw bodies go, with the author\'s marker', () => {
    const { parsed } = line({ ...call, rawRequest: BIG, rawResponse: null });
    expect(has(parsed, 'rawRequest')).toBe(false);
    expect(has(parsed, 'rawResponse')).toBe(false);
    expect(parsed.truncated).toBe('raw bodies dropped (record exceeded size guard)');
  });

  test('the response goes too when the line still does not fit', () => {
    const { bytes, parsed } = line({ ...call, rawRequest: BIG, rawResponse: { text: BIG } });
    expect(bytes).toBeLessThanOrEqual(CAP);
    expect(has(parsed, 'rawRequest')).toBe(false);
    expect(has(parsed, 'rawResponse')).toBe(false);
    expect(parsed.requestSummary).toEqual(call.requestSummary);
    expect(parsed.truncated).toBe('raw bodies dropped (record exceeded size guard)');
  });

  test('an unserializable request goes alone; an unserializable response takes both raw bodies', () => {
    const cycle: any = {}; cycle.self = cycle;
    const request = line({ ...call, rawRequest: cycle, rawResponse: response });
    expect(request.parsed.rawResponse).toEqual(response);
    expect(request.parsed.truncated).toBe('raw request dropped (the record could not be serialized)');
    const both = line({ ...call, rawRequest: { ok: true }, rawResponse: cycle });
    expect(has(both.parsed, 'rawRequest')).toBe(false);
    expect(has(both.parsed, 'rawResponse')).toBe(false);
    expect(both.parsed.truncated).toBe('raw bodies dropped (they could not be serialized)');
  });

  test("an oversized summary leaves the head's values and the error's name and message", () => {
    const error = { name: 'Error', message: 'invalid request', stack: 'Error: invalid request' };
    const keepalive = { key: 'lineage-1', reason: 'ttl' };
    const { bytes, parsed } = line({ ...head, error, keepalive, requestSummary: { toolNames: [BIG] }, rawRequest: 'small' });
    expect(bytes).toBeLessThanOrEqual(CAP);
    expect(fields(parsed, Object.keys(head))).toEqual({ ...head, error: { name: 'Error', message: 'invalid request' } });
    expect(has(parsed, 'requestSummary')).toBe(false);
    expect(has(parsed, 'keepalive')).toBe(false);
    expect(parsed.truncated).toBe('only bounded head and classification kept (record exceeded size guard)');
  });

  test("a head too big for its own line leaves bounded scalars and the error's name and message", () => {
    const error = { name: 'Error', message: `invalid request: ${BIG}`, stack: BIG };
    const { bytes, parsed } = line({ ...head, error, errorType: BIG, keepalive: { key: 'lineage-1' } });
    expect(bytes).toBeLessThan(64 * 1024);
    expect(fields(parsed, ['type', 'kind', 'durationMs', 'httpStatus', 'retryable'])).toEqual({ type: 'error', kind: 'stream', durationMs: 3, httpStatus: 400, retryable: false });
    expect(parsed.error.name).toBe('Error');
    expect(parsed.error.message.startsWith('invalid request: x')).toBe(true);
    expect(parsed.error.message.length).toBeLessThan(2_048);
    expect(has(parsed.error, 'stack')).toBe(false);
    expect(parsed.errorType.length).toBeLessThan(2_048);
    expect(has(parsed, 'keepalive')).toBe(false);
    expect(parsed.truncated).toBe('only bounded head and classification kept (record exceeded size guard)');
  });

  test("the last fallback keeps only an error's text name and message, and no error with neither", () => {
    const big = { ...head, errorType: BIG };
    const numberName = line({ ...big, error: { name: 42, message: 'boom' } }).parsed;
    expect(numberName.error).toEqual({ message: 'boom' });
    const unreadableName: Record<string, unknown> = { message: 'boom' };
    Object.defineProperty(unreadableName, 'name', { enumerable: true, get() { throw new Error('unreadable'); } });
    expect(line({ ...big, error: unreadableName }).parsed.error).toEqual({ message: 'boom' });
    const neither = line({ ...big, error: { code: 5 } }).parsed;
    expect(has(neither, 'error')).toBe(false);
    expect(neither.truncated).toBe('only bounded head and classification kept (record exceeded size guard)');
  });

  test('a head field that cannot be serialized sends the line to the last fallback', () => {
    const cycle: any = {}; cycle.self = cycle;
    const { bytes, parsed } = line({ ...head, keepalive: cycle, requestSummary: { model: 'unit-test' }, rawRequest: 'small' });
    expect(bytes).toBeLessThan(64 * 1024);
    expect(fields(parsed, ['type', 'kind', 'durationMs', 'errorType'])).toEqual({ type: 'error', kind: 'stream', durationMs: 3, errorType: 'invalid_request' });
    expect(has(parsed, 'keepalive')).toBe(false);
    expect(parsed.truncated).toBe('only bounded head and classification kept (the record could not be serialized)');
  });

  test('a head field whose getter throws costs only itself', () => {
    const record: Record<string, unknown> = { ...call, rawRequest: 'small' };
    Object.defineProperty(record, 'durationMs', { enumerable: true, get() { throw new Error('unreadable'); } });
    const { parsed } = line(record);
    expect(fields(parsed, ['type', 'provider', 'kind', 'timestamp'])).toEqual({ type: 'call', provider: 'unit-test', kind: 'stream', timestamp: call.timestamp });
    expect(has(parsed, 'durationMs')).toBe(false);
    expect(parsed.truncated).toBe('only bounded head and classification kept (the record could not be serialized)');
  });

  test('serializing leaves the record as it was', () => {
    const record = { ...call, rawRequest: BIG, rawResponse: { text: BIG } };
    const before = structuredClone(record);
    line(record);
    expect(Object.keys(record)).toEqual(Object.keys(before));
    expect(record.rawRequest === before.rawRequest).toBe(true);
    expect(record.rawResponse.text === before.rawResponse.text).toBe(true);
  });

  test('MAX_RECORD_BYTES is the 16 MiB the line may take', () => {
    expect(MAX_RECORD_BYTES).toBe(CAP);
  });
});
