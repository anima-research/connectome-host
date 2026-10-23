/**
 * Anomalous responses in llm-calls: a response that carries a client tool_use
 * block under a stop reason other than 'tool_use' keeps its full raw request,
 * names the anomaly, and prints one timestamped stderr line that says whether
 * the row with the request was written. Rows also keep the provider's message
 * and request ids where the response (or a failed call's error) has them.
 * Driven end to end through a local Anthropic-shaped server, so the rows are
 * the ones the real adapter writes.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderRequest } from '@animalabs/membrane';
import {
  LoggingAnthropicAdapter,
  responseAnomaly,
  responseIds,
  anomalyLogLine,
  errorRequestId,
} from '../src/logging-adapter.js';
import { MAX_RECORD_BYTES, serializeRecordOutcome } from '../src/logging-record.js';

const request: ProviderRequest = {
  messages: [{ participant: 'user', content: [{ type: 'text', text: 'fixture prompt' }] }] as never,
  model: 'claude-opus-5',
  maxTokens: 1024,
  tools: [{ name: 'think', description: 'private note', inputSchema: { type: 'object', properties: { content: { type: 'string' } } } }],
};

type Block = Record<string, unknown>;

/** An Anthropic SSE body for one message with the given blocks and stop reason. */
function sse(blocks: Block[], stopReason: string | null, id = 'msg_fixture_stream'): string {
  const events: Array<[string, unknown]> = [
    ['message_start', {
      type: 'message_start',
      message: {
        id, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [],
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }],
  ];
  blocks.forEach((block, index) => {
    if (block.type === 'tool_use') {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { ...block, input: {} } }]);
      events.push(['content_block_delta', {
        type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      }]);
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }]);
    }
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  });
  events.push(['message_delta', {
    type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 42 },
  }]);
  events.push(['message_stop', { type: 'message_stop' }]);
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** An Anthropic Messages JSON body for complete(). */
function message(blocks: Block[], stopReason: string | null, id = 'msg_fixture_complete'): Record<string, unknown> {
  return {
    id, type: 'message', role: 'assistant', model: 'claude-opus-5', content: blocks,
    stop_reason: stopReason, stop_sequence: null,
    ...(stopReason === 'refusal' ? { stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' } } : {}),
    usage: { input_tokens: 10, output_tokens: 42, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

const THINK: Block = { type: 'tool_use', id: 'toolu_fixture1', name: 'think', input: { content: 'a long private note' } };
const TEXT: Block = { type: 'text', text: 'plain answer' };

/** Run one call against a local server answering `body` (with `status`),
 *  return its llm-calls row (undefined when none was written), stderr
 *  lines, and the error the call threw, if any. `logPath` places the log
 *  somewhere else in the run's directory (an unwritable path, say). */
async function oneCall(
  kind: 'stream' | 'complete',
  body: string | Record<string, unknown>,
  opts: { status?: number; logPath?: (dir: string) => string; request?: ProviderRequest } = {},
) {
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      await req.json();
      const headers = { 'request-id': `req_fixture_${kind}` };
      const status = opts.status ?? 200;
      return typeof body === 'string'
        ? new Response(body, { status, headers: { ...headers, 'content-type': 'text/event-stream' } })
        : Response.json(body, { status, headers });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'llm-calls-anomaly-'));
  const path = opts.logPath ? opts.logPath(dir) : join(dir, 'llm-calls.test.jsonl');
  const errors: string[] = [];
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  const prev = process.env.LLM_CALLS_FULL_PAYLOADS;
  delete process.env.LLM_CALLS_FULL_PAYLOADS;
  try {
    const adapter = new LoggingAnthropicAdapter(
      { apiKey: 'test', baseURL: server.url.href, cacheKeepalive: { enabled: false } }, path,
    );
    let thrown: unknown;
    try {
      if (kind === 'stream') await adapter.stream(opts.request ?? request, { onChunk: () => {} });
      else await adapter.complete(opts.request ?? request);
    } catch (err) {
      thrown = err;
    }
    let row: Record<string, unknown> | undefined;
    try { row = JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown>; } catch { row = undefined; }
    return { row: row as Record<string, unknown>, anomalyLines: errors.filter((l) => l.startsWith('[llm-calls]')), thrown };
  } finally {
    spy.mockRestore();
    if (prev !== undefined) process.env.LLM_CALLS_FULL_PAYLOADS = prev;
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('llm-calls rows for anomalous responses', () => {
  test('stream: a tool_use under end_turn keeps the request, names the anomaly, and prints one stamped line', async () => {
    const { row, anomalyLines } = await oneCall('stream', sse([THINK], 'end_turn'));
    expect(row.anomaly).toEqual({
      kind: 'tool_use_with_stop_reason', stopReason: 'end_turn', providerStopReason: 'end_turn', toolNames: ['think'],
    });
    expect(JSON.stringify(row.rawRequest)).toContain('fixture prompt');
    expect(anomalyLines).toHaveLength(1);
    expect(anomalyLines[0]).toMatch(
      /^\[llm-calls\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z ANOMALY tool_use with stop_reason=end_turn \(provider: end_turn\) kind=stream model=claude-opus-5 tools=think/,
    );
  });

  test('stream: a provider that reports no stop reason reads as provider: none', async () => {
    const { row, anomalyLines } = await oneCall('stream', sse([THINK], null));
    expect(row.anomaly).toMatchObject({ kind: 'tool_use_with_stop_reason', providerStopReason: null, toolNames: ['think'] });
    expect(anomalyLines[0]).toContain('(provider: none)');
    expect(row.rawRequest).toBeDefined();
  });

  test('a missing stop reason records the same stopReason on complete() and stream()', async () => {
    const viaStream = await oneCall('stream', sse([THINK], null));
    const viaComplete = await oneCall('complete', message([THINK], null));
    expect(viaComplete.row.anomaly).toEqual(viaStream.row.anomaly);
    expect(viaComplete.row.anomaly).toMatchObject({ stopReason: 'end_turn', providerStopReason: null });
  });

  test('complete: same, and the row keeps the message id and the request id', async () => {
    const { row, anomalyLines } = await oneCall('complete', message([THINK], 'end_turn'));
    expect(row.anomaly).toMatchObject({ kind: 'tool_use_with_stop_reason', stopReason: 'end_turn', toolNames: ['think'] });
    expect(row.messageId).toBe('msg_fixture_complete');
    expect(row.requestId).toBe('req_fixture_complete');
    expect(JSON.stringify(row.rawRequest)).toContain('fixture prompt');
    expect(anomalyLines).toHaveLength(1);
    expect(anomalyLines[0]).toContain('request=req_fixture_complete message=msg_fixture_complete');
  });

  test('normal rows are unchanged: tool_use under tool_use, and text under end_turn, keep no request and name no anomaly', async () => {
    for (const [kind, body] of [
      ['stream', sse([THINK], 'tool_use')],
      ['stream', sse([TEXT], 'end_turn')],
      ['complete', message([THINK], 'tool_use')],
      ['complete', message([TEXT], 'end_turn')],
    ] as const) {
      const { row, anomalyLines } = await oneCall(kind, body);
      expect(row.anomaly).toBeUndefined();
      expect(row.rawRequest).toBeUndefined();
      expect(anomalyLines).toHaveLength(0);
    }
  });

  test('a refusal keeps its request as before, and is not an anomaly without a tool call', async () => {
    const { row, anomalyLines } = await oneCall('complete', message([], 'refusal'));
    expect(row.anomaly).toBeUndefined();
    expect(JSON.stringify(row.rawRequest)).toContain('fixture prompt');
    expect(anomalyLines).toHaveLength(0);
  });
});

describe('responseAnomaly', () => {
  test('flags a client tool call under every stop reason but tool_use', () => {
    for (const stop of ['end_turn', 'stop_sequence', 'max_tokens', 'refusal', 'pause_turn']) {
      expect(responseAnomaly({ raw: { content: [THINK], stop_reason: stop } })?.stopReason).toBe(stop);
    }
    expect(responseAnomaly({ raw: { content: [THINK], stop_reason: 'tool_use' } })).toBeUndefined();
    expect(responseAnomaly({ raw: { content: [THINK] } })).toMatchObject({ stopReason: null });
    expect(responseAnomaly({ raw: { content: [THINK], stop_reason: null } })).toMatchObject({ stopReason: null });
  });

  test('ignores server-side tool blocks and text-only responses', () => {
    expect(responseAnomaly({ raw: { content: [{ type: 'server_tool_use', name: 'web_search' }], stop_reason: 'end_turn' } })).toBeUndefined();
    expect(responseAnomaly({ raw: { content: [TEXT], stop_reason: 'end_turn' } })).toBeUndefined();
  });

  test("doesn't read a raw `anomalies` list: nothing writes one at this layer", () => {
    // membrane#168 records its anomalies on the Membrane-level response
    // (`details.anomalies`), which a provider adapter never returns.
    expect(responseAnomaly({ raw: { content: [TEXT], stop_reason: 'end_turn', anomalies: [{ kind: 'x' }] } })).toBeUndefined();
  });

  test('a missing stop reason reads as membrane\'s defaulted end_turn on both shapes, the provider\'s as null', () => {
    // complete(): the raw response is the API message (stop_reason null),
    // membrane's normalized reason is the default.
    expect(responseAnomaly({ raw: { content: [THINK], stop_reason: null }, stopReason: 'end_turn', providerStopReason: undefined }))
      .toEqual({ kind: 'tool_use_with_stop_reason', stopReason: 'end_turn', providerStopReason: null, toolNames: ['think'] });
    // stream(): membrane's raw already carries the default.
    expect(responseAnomaly({ raw: { content: [THINK], stop_reason: 'end_turn' }, stopReason: 'end_turn', providerStopReason: undefined }))
      .toEqual({ kind: 'tool_use_with_stop_reason', stopReason: 'end_turn', providerStopReason: null, toolNames: ['think'] });
  });

  test('reads the normalized response when there is no raw one, and never throws', () => {
    expect(responseAnomaly({ content: [THINK], stopReason: 'end_turn' })).toMatchObject({ toolNames: ['think'] });
    const hostile = { get raw() { throw new Error('boom'); } };
    expect(responseAnomaly(hostile)).toBeUndefined();
    expect(responseAnomaly(null)).toBeUndefined();
  });
});

describe('responseIds', () => {
  test('reads ids from the raw response, including an SDK-attached request id', () => {
    const raw: Record<string, unknown> = { id: 'msg_a' };
    Object.defineProperty(raw, '_request_id', { value: 'req_a', enumerable: false });
    expect(responseIds({ raw })).toEqual({ messageId: 'msg_a', requestId: 'req_a' });
    expect(responseIds({ raw: { request_id: 'req_b' } })).toEqual({ requestId: 'req_b' });
    expect(responseIds({ raw: { id: '' } })).toEqual({});
    expect(responseIds(undefined)).toEqual({});
  });
});

describe('anomalyLogLine', () => {
  const A = { kind: 'tool_use_with_stop_reason', stopReason: 'end_turn', toolNames: ['a', 'b'] } as const;
  test('omits the provider part when the response does not say, and says what membrane does', () => {
    expect(anomalyLogLine('2026-01-01T00:00:00.000Z', 'stream', 'm', { ...A, toolNames: ['a', 'b'] }, {}, { written: true, kept: 'whole' }))
      .toBe('[llm-calls] 2026-01-01T00:00:00.000Z ANOMALY tool_use with stop_reason=end_turn kind=stream model=m tools=a,b'
        + " — provider response; membrane with membrane#168 may have run these calls; earlier membrane drops them"
        + " — full request kept in this call's llm-calls row");
    expect(anomalyLogLine('t', 'complete', 'm', { ...A, toolNames: ['a'], stopReason: 'max_tokens' }, {}, { written: true, kept: 'whole' }))
      .toContain('membrane runs no calls under this stop reason');
  });

  test('says the request was saved only when the row that holds it was written whole', () => {
    const line = (saved: Parameters<typeof anomalyLogLine>[5], captured = true) =>
      anomalyLogLine('t', 'stream', 'm', { ...A, toolNames: ['a'] }, {}, saved, captured);
    expect(line({ written: false, error: 'ENOSPC: no space left on device' }))
      .toEndWith('request could not be saved: the llm-calls write failed (ENOSPC: no space left on device)');
    expect(line({ written: true, kept: 'without-raw-request', truncated: 'raw request dropped (record exceeded size guard)' }))
      .toEndWith('request not kept: raw request dropped (record exceeded size guard)');
    expect(line({ written: true, kept: 'whole' }, false)).toEndWith('no request was captured for this call');
    expect(line({ written: true, kept: 'whole' })).not.toContain('could not');
  });
});

describe('an anomalous row the log could not keep whole', () => {
  test("a failed write: the alert says the request couldn't be saved, not that it was kept", async () => {
    // A path under a directory that doesn't exist: the append fails.
    const { row, anomalyLines } = await oneCall('stream', sse([THINK], 'end_turn'), {
      logPath: (dir) => join(dir, 'missing-dir', 'llm-calls.test.jsonl'),
    });
    expect(row).toBeUndefined();
    expect(anomalyLines).toHaveLength(1);
    expect(anomalyLines[0]).toContain('request could not be saved: the llm-calls write failed (');
    expect(anomalyLines[0]).not.toContain('full request kept');
  });

  test('over the size guard: the request is dropped and said so; the anomaly and ids stay on the line', async () => {
    const big: ProviderRequest = {
      ...request,
      messages: [{ participant: 'user', content: [{ type: 'text', text: 'x'.repeat(MAX_RECORD_BYTES + 1024) }] }] as never,
    };
    const { row, anomalyLines } = await oneCall('complete', message([THINK], 'end_turn'), { request: big });
    expect(row.rawRequest).toBeUndefined();
    expect(row.truncated).toBe('raw request dropped (record exceeded size guard)');
    expect(row.anomaly).toMatchObject({ kind: 'tool_use_with_stop_reason', stopReason: 'end_turn', toolNames: ['think'] });
    expect(row.messageId).toBe('msg_fixture_complete');
    expect(row.requestId).toBe('req_fixture_complete');
    expect(anomalyLines[0]).toEndWith('request not kept: raw request dropped (record exceeded size guard)');
  }, 60_000);

  test("the guard's last fallback keeps the anomaly and ids, bounded", () => {
    const record = {
      type: 'call', kind: 'stream', timestamp: 't', durationMs: 1,
      messageId: 'msg_a', requestId: 'req_a',
      anomaly: { kind: 'tool_use_with_stop_reason', stopReason: 'end_turn', providerStopReason: null, toolNames: ['think', 'y'.repeat(5_000)] },
      // A summary too big for any step but the last.
      requestSummary: { model: 'z'.repeat(MAX_RECORD_BYTES) },
      rawRequest: { a: 1 }, rawResponse: { b: 2 },
    };
    const out = serializeRecordOutcome(record);
    expect(out.kept).toBe('head-only');
    const line = JSON.parse(out.line) as Record<string, unknown>;
    expect(line.truncated).toBe(out.truncated);
    expect(line.messageId).toBe('msg_a');
    expect(line.requestId).toBe('req_a');
    const anomaly = line.anomaly as { kind: string; stopReason: string; providerStopReason: null; toolNames: string[] };
    expect(anomaly.kind).toBe('tool_use_with_stop_reason');
    expect(anomaly.providerStopReason).toBeNull();
    expect(anomaly.toolNames[0]).toBe('think');
    expect(anomaly.toolNames[1]!.length).toBeLessThan(5_000);
  });

  test('a whole record reports kept: whole and no marker', () => {
    expect(serializeRecordOutcome({ type: 'call', a: 1 })).toEqual({ line: '{"type":"call","a":1}\n', kept: 'whole' });
  });
});

describe('failed calls', () => {
  test("a failed call's row keeps the provider's request id from its error", async () => {
    const errBody = { type: 'error', error: { type: 'invalid_request_error', message: 'fixture bad request' } };
    for (const kind of ['complete', 'stream'] as const) {
      const { row, thrown } = await oneCall(kind, errBody, { status: 400 });
      expect(thrown).toBeDefined();
      expect(row.type).toBe('error');
      expect(row.requestId).toBe(`req_fixture_${kind}`);
      expect(row.messageId).toBeUndefined();
    }
  });

  test('errorRequestId reads the error and the provider error it wraps, never throwing', () => {
    expect(errorRequestId({ requestID: 'req_1' })).toBe('req_1');
    expect(errorRequestId({ rawError: { requestID: 'req_2' } })).toBe('req_2');
    expect(errorRequestId({ rawError: { headers: new Headers({ 'request-id': 'req_3' }) } })).toBe('req_3');
    expect(errorRequestId({ rawError: { headers: { 'request-id': 'req_4' } } })).toBe('req_4');
    expect(errorRequestId({ requestID: '' })).toBeUndefined();
    expect(errorRequestId(null)).toBeUndefined();
    expect(errorRequestId({ get requestID() { throw new Error('boom'); } })).toBeUndefined();
  });
});
