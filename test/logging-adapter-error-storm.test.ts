/**
 * An error record keeps the full request for the first failure of each kind
 * (error type, or an untyped error's name, with any HTTP status) in a cache lineage's run of failures, within a
 * budget per log; the run's later failures of that kind (each retry, each
 * turn of a storm) record the request's hash and size instead.
 */
import { test, expect, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { AnthropicAdapter, cacheLineageKey, rateLimitError, serverError, invalidRequestError, contextLengthError, abortError } from '@animalabs/membrane';
import { LoggingAnthropicAdapter } from '../src/logging-adapter.js';

const BIG = { model: 'claude-fable-5', messages: [{ role: 'user', content: 'x'.repeat(200_000) }] };
/** Multi-byte UTF-8 (CJK, accents, emoji): its byte size exceeds its string length. */
const NON_ASCII = { model: 'claude-fable-5', messages: [{ role: 'user', content: '日本語のテキスト café 🙂'.repeat(5_000) }] };
const proto = AnthropicAdapter.prototype as unknown as Record<'complete' | 'stream', unknown>;
const original = { complete: proto.complete, stream: proto.stream };
const logPath = join(tmpdir(), `llm-error-storm-${process.pid}.jsonl`);
const savedFullPayloads = process.env.LLM_CALLS_FULL_PAYLOADS;

// The adapter reads the flag at construction: clear it before each test so a
// run with LLM_CALLS_FULL_PAYLOADS=1 in the environment tests the default.
beforeEach(() => {
  delete process.env.LLM_CALLS_FULL_PAYLOADS;
});

afterEach(() => {
  proto.complete = original.complete;
  proto.stream = original.stream;
  if (savedFullPayloads === undefined) delete process.env.LLM_CALLS_FULL_PAYLOADS;
  else process.env.LLM_CALLS_FULL_PAYLOADS = savedFullPayloads;
  rmSync(logPath, { force: true });
});

/** Make the underlying adapter capture `raw` as its raw request, then fail. */
function failWith(err: unknown, raw: unknown = BIG): void {
  const fail = async (_req: unknown, a?: unknown, b?: unknown) => {
    const opts = (b ?? a) as { onRequest?: (r: unknown) => void } | undefined;
    opts?.onRequest?.(raw);
    throw err;
  };
  proto.complete = fail;
  proto.stream = fail;
}

const sha = (raw: unknown) => createHash('sha256').update(JSON.stringify(raw)).digest('hex');
/** A request of its own cache lineage: the system text is part of the lineage. */
const ofLineage = (name: string, content = 'x') => ({ model: 'claude-fable-5', system: [{ type: 'text', text: name }], messages: [{ role: 'user', content }] });
const newAdapter = () => new LoggingAnthropicAdapter({ apiKey: 'test-key' }, logPath, () => ({ enabled: false, budgetTokens: 0 }));

/** Call `n` times on one adapter; the error records it wrote, in order. */
async function errorRecords(kind: 'complete' | 'stream', n: number, adapter = newAdapter()): Promise<Record<string, unknown>[]> {
  const request = { model: 'claude-fable-5', messages: [] } as never;
  for (let i = 0; i < n; i++) {
    const call = kind === 'complete' ? adapter.complete(request) : adapter.stream(request, {} as never);
    await expect(call).rejects.toBeDefined();
  }
  return readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'error');
}

for (const kind of ['complete', 'stream'] as const) {
  test(`${kind}: a rate-limit storm keeps the request once, then its hash and size`, async () => {
    failWith(rateLimitError('429 too many requests'));
    const [first, ...repeats] = await errorRecords(kind, 3);
    expect(first.rawRequest).toEqual(BIG);
    expect(first.requestSha256).toBe(sha(BIG));
    expect(repeats).toHaveLength(2);
    for (const rec of repeats) {
      expect(rec.rawRequest).toBeUndefined();
      expect(rec.requestSha256).toBe(sha(BIG));
      expect(rec.rawRequestOmitted).toMatchObject({ bytes: JSON.stringify(BIG).length, reason: expect.stringContaining('LLM_CALLS_FULL_PAYLOADS=1') });
      expect(JSON.stringify(rec).length).toBeLessThan(10_000);
    }
  });
}

test('an overload, a bad request and a plain error are each kept the first time, and their repeats noted', async () => {
  for (const err of [serverError('529 overloaded', 529), invalidRequestError('400 roles must alternate'), new Error('something else')]) {
    rmSync(logPath, { force: true });
    failWith(err);
    const [first, second] = await errorRecords('stream', 2);
    expect(first.rawRequest).toEqual(BIG);
    expect(second.rawRequest).toBeUndefined();
    expect(second.rawRequestOmitted).toMatchObject({ bytes: expect.any(Number) });
  }
});

test('the note counts UTF-8 bytes, not string length', async () => {
  failWith(rateLimitError('429'), NON_ASCII);
  const bytes = Buffer.byteLength(JSON.stringify(NON_ASCII), 'utf8');
  expect(bytes).toBeGreaterThan(JSON.stringify(NON_ASCII).length);
  expect((await errorRecords('stream', 2))[1].rawRequestOmitted).toMatchObject({ bytes });
});

test('a storm across turns is one run: each turn adds a message, and only the first is kept whole', async () => {
  const adapter = newAdapter();
  const turns = Array.from({ length: 20 }, (_, n) => ({
    ...BIG,
    messages: [...BIG.messages, ...Array.from({ length: n }, (_, i) => ({ role: 'user', content: `[inference-failed] turn ${i}` }))],
  }));
  for (const turn of turns) {
    failWith(rateLimitError('429'), turn);
    await errorRecords('stream', 1, adapter);
  }
  const records = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(records).toHaveLength(20);
  expect(records[0].rawRequest).toEqual(turns[0]);
  for (const [n, rec] of records.slice(1).entries()) {
    expect(rec.rawRequest).toBeUndefined();
    expect(rec.requestSha256).toBe(sha(turns[n + 1]));
    expect(rec.rawRequestOmitted).toMatchObject({ reason: expect.stringContaining('failed with this kind of error (its type, or for an untyped error its name, with its HTTP status when it has one) since a call on it last succeeded, with no hour between its failures') });
  }
  // One copy of a ~200 KB request, and nineteen notes.
  expect(readFileSync(logPath).length).toBeLessThan(2 * JSON.stringify(BIG).length);
});

test('runs are told apart by lineage: each lineage keeps its own first failure', async () => {
  const adapter = newAdapter();
  for (const name of ['a', 'b', 'a', 'b']) {
    failWith(rateLimitError('429'), ofLineage(name));
    await errorRecords('stream', 1, adapter);
  }
  const records = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(records.map((r) => r.rawRequest !== undefined)).toEqual([true, true, false, false]);
});

test('within a run, the first failure of each kind is kept whole', async () => {
  const adapter = newAdapter();
  const kept: boolean[] = [];
  for (const [n, err] of [rateLimitError('429'), rateLimitError('429'), invalidRequestError('400 prompt is too long'), invalidRequestError('400 prompt is too long'), new Error('socket hang up'), new Error('socket hang up'), rateLimitError('429')].entries()) {
    failWith(err, ofLineage('a', `turn ${n}`));
    kept.push((await errorRecords('stream', 1, adapter)).at(-1)!.rawRequest !== undefined);
  }
  // The run keeps every type it has met: the 429 after the others is noted.
  expect(kept).toEqual([true, false, true, false, true, false, false]);
});

test('a kind is the error type, or an untyped error\'s name, with its HTTP status when it has one', async () => {
  const adapter = newAdapter();
  const kept: boolean[] = [];
  // membrane types every 5xx as server: a 500 after 529s is another kind. Two
  // types that share a status are two kinds too.
  const errors = [serverError('529 overloaded', 529), serverError('529 overloaded', 529), serverError('500 invalid_request_error', 500), invalidRequestError('400 roles must alternate'), contextLengthError('400 prompt is too long'), new Error('socket hang up'), new TypeError('x is not a function'), new TypeError('y is not a function')];
  for (const [n, err] of errors.entries()) {
    failWith(err, ofLineage('a', `turn ${n}`));
    kept.push((await errorRecords('stream', 1, adapter)).at(-1)!.rawRequest !== undefined);
  }
  expect(kept).toEqual([true, false, true, true, true, true, true, false]);
});

test('a run ends once more than an hour has passed since its last failed call, and a failure within the hour keeps it going', async () => {
  const adapter = newAdapter();
  // bun's system time stands still once set, so each failure happens at `now`.
  let now = Date.parse('2026-10-21T09:00:00Z');
  const fail = async (content: string) => {
    setSystemTime(new Date(now));
    failWith(rateLimitError('429'), ofLineage('a', content));
    return (await errorRecords('stream', 1, adapter)).at(-1)!.rawRequest !== undefined;
  };
  try {
    expect(await fail('09:00')).toBe(true);
    now += 50 * 60_000;
    expect(await fail('09:50')).toBe(false);
    now += 60 * 60_000;
    // An hour after the last failure, 110 minutes after the first: the run goes on.
    expect(await fail('10:50')).toBe(false);
    now += 60 * 60_000 + 1;
    // A millisecond past the hour: a new run, whose first failure is kept.
    expect(await fail('11:50')).toBe(true);
    now += 60_000;
    // The new run goes on from there.
    expect(await fail('11:51')).toBe(false);
  } finally {
    setSystemTime();
  }
});

test("a keepalive poke's success doesn't end its lineage's run", async () => {
  const adapter = newAdapter();
  const poke = (outcome: 'success' | 'error') => (adapter as unknown as { logKeepaliveCall(call: unknown): void }).logKeepaliveCall({
    key: cacheLineageKey(ofLineage('a') as never), lane: 'stream', startedAt: Date.now(), durationMs: 1, request: { model: 'claude-fable-5', max_tokens: 0, messages: [] },
    ...(outcome === 'success' ? { outcome, response: { usage: { input_tokens: 1 } } } : { outcome, error: rateLimitError('429') }),
  });
  const fail = async (content: string) => {
    failWith(rateLimitError('429'), ofLineage('a', content));
    return (await errorRecords('stream', 1, adapter)).at(-1)!.rawRequest !== undefined;
  };
  expect(await fail('first')).toBe(true);
  poke('error');
  expect(await fail('after a failed poke')).toBe(false);
  poke('success');
  expect(await fail('after a poke that succeeded')).toBe(false);
  // Both pokes were written, so the poke that succeeded reached its record.
  const pokes = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'keepalive');
  expect(pokes.map((r) => r.type)).toEqual(['error', 'call']);
});

test("a success ends its own lineage's run, and another lineage's success doesn't", async () => {
  const adapter = newAdapter();
  const answer = async (raw: unknown) => {
    const ok = async (_req: unknown, a?: unknown, b?: unknown) => {
      ((b ?? a) as { onRequest?: (r: unknown) => void } | undefined)?.onRequest?.(raw);
      return { content: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, raw: { stop_reason: 'end_turn' } };
    };
    proto.complete = ok;
    proto.stream = ok;
    await adapter.stream({ model: 'claude-fable-5', messages: [] } as never, {} as never);
  };
  const fail = async (raw: unknown) => {
    failWith(rateLimitError('429'), raw);
    return (await errorRecords('stream', 1, adapter)).at(-1)!;
  };
  expect((await fail(ofLineage('a'))).rawRequest).toBeDefined();
  // Another caller's success, on another lineage: a's run goes on.
  await answer(ofLineage('b'));
  expect((await fail(ofLineage('a', 'next turn'))).rawRequest).toBeUndefined();
  // a's own success ends its run, so its next failure is a new run's first.
  await answer(ofLineage('a', 'answered'));
  expect((await fail(ofLineage('a', 'later'))).rawRequest).toEqual(ofLineage('a', 'later'));
});

test('past its budget, a log notes even a new run\'s first failure', async () => {
  const adapter = newAdapter();
  expect((adapter as unknown as { failedCopyBudget: number }).failedCopyBudget).toBe(64 * 1024 * 1024);
  const size = JSON.stringify(ofLineage('a', 'x'.repeat(1000))).length;
  (adapter as unknown as { failedCopyBudget: number }).failedCopyBudget = 2 * size + 10;
  const kept: boolean[] = [];
  for (const name of ['a', 'b', 'c']) {
    failWith(rateLimitError('429'), ofLineage(name, 'x'.repeat(1000)));
    const rec = (await errorRecords('stream', 1, adapter)).at(-1)!;
    kept.push(rec.rawRequest !== undefined);
    if (name === 'c') expect(rec.rawRequestOmitted).toMatchObject({ bytes: size, reason: expect.stringContaining('has no room for this one') });
  }
  expect(kept).toEqual([true, true, false]);
});

test('a request whose record the line bound cut is tried whole again, not noted as written', async () => {
  // Under 16 MiB itself, over it with the record's other fields.
  const near = { model: 'claude-fable-5', messages: [{ role: 'user', content: 'x'.repeat(16 * 1024 * 1024 - 150) }] };
  failWith(rateLimitError('429'), near);
  const records = await errorRecords('stream', 2);
  expect(records).toHaveLength(2);
  for (const rec of records) {
    expect(rec.rawRequestOmitted).toBeUndefined();
    expect(rec.truncated).toBe('raw bodies dropped (record exceeded size guard)');
  }
}, 30_000);

test('the memory keeps the latest 256 runs: the oldest is written whole again, the newest noted', async () => {
  const adapter = newAdapter();
  for (let n = 0; n <= 256; n++) {
    failWith(rateLimitError('429'), ofLineage(`agent ${n}`));
    await errorRecords('stream', 1, adapter);
  }
  failWith(rateLimitError('429'), ofLineage('agent 256', 'again'));
  const newest = (await errorRecords('stream', 1, adapter)).at(-1)!;
  expect(newest.rawRequest).toBeUndefined();
  // The second oldest is still remembered: the memory holds 256.
  failWith(rateLimitError('429'), ofLineage('agent 1', 'again'));
  expect((await errorRecords('stream', 1, adapter)).at(-1)!.rawRequest).toBeUndefined();
  failWith(rateLimitError('429'), ofLineage('agent 0', 'again'));
  const oldest = (await errorRecords('stream', 1, adapter)).at(-1)!;
  expect(oldest.rawRequest).toEqual(ofLineage('agent 0', 'again'));
}, 30_000);

test("a request membrane's own check refuses before sending is kept from the error, with its lineage", async () => {
  // claude-opus-4-8 takes no assistant prefill: membrane refuses an
  // assistant-ended request before onRequest, with the built request on the
  // error. Nothing is sent: the adapter's own complete, unpatched.
  const adapter = newAdapter();
  const request = { model: 'claude-opus-4-8', maxTokens: 16, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Once upon' }] };
  await expect(adapter.complete(request as never)).rejects.toMatchObject({ type: 'unsupported' });
  const [rec] = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(rec.type).toBe('error');
  expect(rec.rawRequest).toMatchObject({ model: 'claude-opus-4-8', messages: [{ role: 'user' }, { role: 'assistant' }] });
  expect(rec.requestSummary.lineage).toBe(cacheLineageKey(rec.rawRequest));
});

test('a request with no lineage is held to the budget alone', async () => {
  const adapter = newAdapter();
  // Room for two copies of it, not three.
  (adapter as unknown as { failedCopyBudget: number }).failedCopyBudget = 2 * JSON.stringify('not an object').length;
  failWith(rateLimitError('429'), 'not an object');
  const records = await errorRecords('stream', 3, adapter);
  expect(records.map((r) => [r.rawRequest, r.requestSummary?.lineage])).toEqual([['not an object', undefined], ['not an object', undefined], [undefined, undefined]]);
  expect(records[2].rawRequestOmitted).toMatchObject({ reason: expect.stringContaining('has no room for this one') });
});

test('LLM_CALLS_FULL_PAYLOADS=1 keeps every copy', async () => {
  process.env.LLM_CALLS_FULL_PAYLOADS = '1';
  failWith(rateLimitError('429'));
  const records = await errorRecords('stream', 2);
  expect(records).toHaveLength(2);
  for (const rec of records) {
    expect(rec.rawRequest).toEqual(BIG);
    expect(rec.requestSha256).toBe(sha(BIG));
  }
});

/** Make the underlying adapter capture `raw`, then answer. */
function answerWith(raw: unknown, stopReason = 'end_turn'): void {
  const ok = async (_req: unknown, a?: unknown, b?: unknown) => {
    ((b ?? a) as { onRequest?: (r: unknown) => void } | undefined)?.onRequest?.(raw);
    return { content: [], stopReason, usage: { inputTokens: 1, outputTokens: 1 }, raw: { stop_reason: stopReason } };
  };
  proto.complete = ok;
  proto.stream = ok;
}

/** Console.error's lines while `run` runs. */
async function stderrOf(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const saved = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await run();
  } finally {
    console.error = saved;
  }
  return lines;
}

test('failures that each succeed on retry spend the budget, which refills over a day: a later failure of a new kind is kept', async () => {
  const adapter = newAdapter();
  const size = Buffer.byteLength(JSON.stringify(ofLineage('a', 'x'.repeat(1000))), 'utf8');
  // Room for three copies at once.
  (adapter as unknown as { failedCopyBudget: number }).failedCopyBudget = 3 * size + 10;
  let now = Date.parse('2026-10-24T09:00:00Z');
  const kept: boolean[] = [];
  try {
    const told = await stderrOf(async () => {
      for (let i = 0; i < 5; i++) {
        setSystemTime(new Date(now));
        // A 529 that membrane's retry answers: the failure is its run's first, and the success ends the run.
        failWith(serverError('overloaded', 529), ofLineage('a', 'x'.repeat(1000)));
        kept.push((await errorRecords('stream', 1, adapter)).at(-1)!.rawRequest !== undefined);
        answerWith(ofLineage('a', 'x'.repeat(1000)));
        await adapter.stream({ model: 'claude-fable-5', messages: [] } as never, {} as never);
        now += 60_000;
      }
    });
    expect(kept).toEqual([true, true, true, false, false]);
    expect(told.filter((l) => l.includes('the budget for failing requests in full'))).toHaveLength(1);
    expect(told.find((l) => l.includes('the budget for failing requests'))).toContain('LLM_CALLS_FULL_PAYLOADS=1');
    // A day later, the budget has refilled: a failure the request caused is kept.
    now += 24 * 60 * 60 * 1000;
    setSystemTime(new Date(now));
    failWith(invalidRequestError('bad request'), ofLineage('a', 'y'.repeat(1000)));
    const later = (await errorRecords('stream', 1, adapter)).at(-1)!;
    expect(later.rawRequest).toEqual(ofLineage('a', 'y'.repeat(1000)));
  } finally {
    setSystemTime();
  }
});

test('the budget refills in proportion to the time passed, and the stderr line comes again only after a copy is written', async () => {
  const adapter = newAdapter();
  const size = Buffer.byteLength(JSON.stringify(ofLineage('a', 'x'.repeat(1000))), 'utf8');
  (adapter as unknown as { failedCopyBudget: number }).failedCopyBudget = 2 * size;
  let now = Date.parse('2026-10-24T09:00:00Z');
  const keep = async (name: string) => {
    setSystemTime(new Date(now));
    failWith(rateLimitError('429'), ofLineage(name, 'x'.repeat(1000)));
    return (await errorRecords('stream', 1, adapter)).at(-1)!.rawRequest !== undefined;
  };
  try {
    const told = await stderrOf(async () => {
      expect(await keep('a')).toBe(true);
      expect(await keep('b')).toBe(true);
      expect(await keep('c')).toBe(false);
      // A third of a day refills two thirds of a copy: still no room.
      now += 8 * 60 * 60 * 1000;
      expect(await keep('d')).toBe(false);
      // Thirteen hours in all refill more than a whole copy.
      now += 5 * 60 * 60 * 1000;
      expect(await keep('e')).toBe(true);
      expect(await keep('f')).toBe(false);
    });
    expect(told.filter((l) => l.includes('the budget for failing requests in full'))).toHaveLength(2);
  } finally {
    setSystemTime();
  }
});

test("a cancelled call keeps no copy and leaves its lineage's run as it was", async () => {
  const adapter = newAdapter();
  let now = Date.parse('2026-10-24T09:00:00Z');
  const call = async (err: unknown, content: string) => {
    setSystemTime(new Date(now));
    failWith(err, ofLineage('a', content));
    return (await errorRecords('stream', 1, adapter)).at(-1)!;
  };
  try {
    const cancelled = await call(abortError('Request was aborted'), '09:00');
    expect(cancelled.rawRequest).toBeUndefined();
    expect(cancelled.requestSha256).toBe(sha(ofLineage('a', '09:00')));
    expect(cancelled.rawRequestOmitted).toMatchObject({ reason: expect.stringContaining('never the request') });
    // The cancellation began no run: the lineage's first failure is kept.
    expect((await call(rateLimitError('429'), '09:01')).rawRequest).toEqual(ofLineage('a', '09:01'));
    // Nor does one end a run going on: the next 429 is its repeat.
    expect((await call(abortError('Request was aborted'), '09:02')).rawRequest).toBeUndefined();
    expect((await call(rateLimitError('429'), '09:03')).rawRequestOmitted).toMatchObject({ copySha256: sha(ofLineage('a', '09:01')) });
    // A cancellation 50 minutes on doesn't carry the run on: an hour after
    // its last failure, the run has ended, and the next failure is kept.
    now += 50 * 60_000;
    expect((await call(abortError('Request was aborted'), '09:51')).rawRequest).toBeUndefined();
    now += 11 * 60_000 + 1;
    expect((await call(rateLimitError('429'), '10:02')).rawRequest).toEqual(ofLineage('a', '10:02'));
  } finally {
    setSystemTime();
  }
});

test("a repeat's note names its run's copy of that kind by hash, which is that copy's record's requestSha256", async () => {
  const adapter = newAdapter();
  const turn = async (content: string, err: unknown) => {
    failWith(err, ofLineage('a', content));
    return (await errorRecords('stream', 1, adapter)).at(-1)!;
  };
  const firstLimit = await turn('turn 1', rateLimitError('429'));
  const firstOverload = await turn('turn 2', serverError('529 overloaded', 529));
  const limitNote = await turn('turn 3', rateLimitError('429'));
  const overloadNote = await turn('turn 4', serverError('529 overloaded', 529));
  expect(firstLimit.requestSha256).toBe(sha(ofLineage('a', 'turn 1')));
  expect(limitNote.requestSha256).toBe(sha(ofLineage('a', 'turn 3')));
  expect(limitNote.rawRequestOmitted).toMatchObject({ copySha256: firstLimit.requestSha256 });
  expect(overloadNote.rawRequestOmitted).toMatchObject({ copySha256: firstOverload.requestSha256 });
  expect((limitNote.rawRequestOmitted as { reason: string }).reason).toContain('copySha256');
});

test("LLM_CALLS_FULL_PAYLOADS=1 keeps a cancelled call's request too", async () => {
  process.env.LLM_CALLS_FULL_PAYLOADS = '1';
  failWith(abortError('Request was aborted'), ofLineage('a'));
  const [rec] = await errorRecords('stream', 1);
  expect(rec.rawRequest).toEqual(ofLineage('a'));
  expect(rec.rawRequestOmitted).toBeUndefined();
});

test("a refusal's request, kept on a call that got a response, isn't charged to the budget for failing requests", async () => {
  const adapter = newAdapter();
  const size = Buffer.byteLength(JSON.stringify(ofLineage('a', 'x'.repeat(1000))), 'utf8');
  (adapter as unknown as { failedCopyBudget: number }).failedCopyBudget = size + 10;
  answerWith(ofLineage('b', 'x'.repeat(1000)), 'refusal');
  await adapter.complete({ model: 'claude-fable-5', messages: [] } as never);
  const refusal = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.type === 'call')!;
  expect(refusal.rawRequest).toEqual(ofLineage('b', 'x'.repeat(1000)));
  failWith(rateLimitError('429'), ofLineage('a', 'x'.repeat(1000)));
  expect((await errorRecords('stream', 1, adapter)).at(-1)!.rawRequest).toEqual(ofLineage('a', 'x'.repeat(1000)));
});

test('however long the budget sits, it refills only to its whole', async () => {
  const adapter = newAdapter();
  const size = Buffer.byteLength(JSON.stringify(ofLineage('a', 'x'.repeat(1000))), 'utf8');
  (adapter as unknown as { failedCopyBudget: number }).failedCopyBudget = 2 * size;
  let now = Date.parse('2026-10-24T09:00:00Z');
  const keep = async (name: string) => {
    setSystemTime(new Date(now));
    failWith(rateLimitError('429'), ofLineage(name, 'x'.repeat(1000)));
    return (await errorRecords('stream', 1, adapter)).at(-1)!.rawRequest !== undefined;
  };
  try {
    await stderrOf(async () => {
      expect([await keep('a'), await keep('b'), await keep('c')]).toEqual([true, true, false]);
      // Two days later: room for two copies, not four.
      now += 2 * 24 * 60 * 60 * 1000;
      expect([await keep('d'), await keep('e'), await keep('f')]).toEqual([true, true, false]);
    });
  } finally {
    setSystemTime();
  }
});

test('a clock stepped back and forward again refills the stretch between once', async () => {
  const adapter = newAdapter();
  const size = Buffer.byteLength(JSON.stringify(ofLineage('a', 'x'.repeat(1000))), 'utf8');
  (adapter as unknown as { failedCopyBudget: number }).failedCopyBudget = 2 * size;
  let now = Date.parse('2026-10-24T09:00:00Z');
  const keep = async (name: string) => {
    setSystemTime(new Date(now));
    failWith(rateLimitError('429'), ofLineage(name, 'x'.repeat(1000)));
    return (await errorRecords('stream', 1, adapter)).at(-1)!.rawRequest !== undefined;
  };
  try {
    await stderrOf(async () => {
      expect([await keep('a'), await keep('b')]).toEqual([true, true]);
      // Eight hours on, two thirds of a copy have refilled: no room yet.
      now += 8 * 60 * 60 * 1000;
      expect(await keep('c')).toBe(false);
      // The clock steps back eight hours, then comes forward to where it was:
      // nothing more has refilled.
      now -= 8 * 60 * 60 * 1000;
      expect(await keep('d')).toBe(false);
      now += 8 * 60 * 60 * 1000;
      expect(await keep('e')).toBe(false);
    });
  } finally {
    setSystemTime();
  }
});

test("a repeat while the budget has no room is noted as its run's repeat, naming its copy, with no stderr line", async () => {
  const adapter = newAdapter();
  const size = Buffer.byteLength(JSON.stringify(ofLineage('a', 'x'.repeat(1000))), 'utf8');
  (adapter as unknown as { failedCopyBudget: number }).failedCopyBudget = size;
  const told = await stderrOf(async () => {
    failWith(rateLimitError('429'), ofLineage('a', 'x'.repeat(1000)));
    const first = (await errorRecords('stream', 1, adapter)).at(-1)!;
    expect(first.rawRequest).toBeDefined();
    failWith(rateLimitError('429'), ofLineage('a', 'y'.repeat(1000)));
    const repeat = (await errorRecords('stream', 1, adapter)).at(-1)!;
    expect(repeat.rawRequestOmitted).toMatchObject({ copySha256: first.requestSha256 });
  });
  expect(told.filter((l) => l.includes('the budget for failing requests'))).toHaveLength(0);
});

test("an error whose request can't be serialized keeps its summary and error, without the request or a hash", async () => {
  const adapter = newAdapter();
  const raw = { model: 'claude-fable-5', system: [{ type: 'text', text: 'a' }], messages: [{ role: 'user', content: 'x' }], extra: 10n };
  failWith(rateLimitError('429'), raw);
  const rec = (await errorRecords('stream', 1, adapter)).at(-1)!;
  expect(rec.summaryUnavailable).toBeUndefined();
  expect(rec.requestSummary).toMatchObject({ model: 'claude-fable-5' });
  expect(rec.errorType).toBe('rate_limit');
  expect(rec.rawRequest).toBeUndefined();
  expect(rec.requestSha256).toBeUndefined();
  expect(rec.truncated).toBe('raw bodies dropped (they could not be serialized)');
});
