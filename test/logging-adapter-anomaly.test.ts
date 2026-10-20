/**
 * Anomalous responses in llm-calls: a response that carries a client tool_use
 * block under a stop reason other than 'tool_use' is dropped downstream (the
 * caller runs tool rounds only on 'tool_use'), so its row keeps the full raw
 * request while its line fits the 16 MiB cap, names the anomaly, and prints
 * one timestamped stderr line that says what became of the row. Rows also
 * keep the provider's message and request ids where the response has them.
 * Driven end to end through a local Anthropic-shaped server, so the rows are
 * the ones the real adapter writes.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderRequest } from '@animalabs/membrane';
import {
  LoggingAnthropicAdapter,
  responseAnomaly,
  responseIds,
  anomalyLogLine,
} from '../src/logging-adapter.js';

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
function message(blocks: Block[], stopReason: string, id = 'msg_fixture_complete'): Record<string, unknown> {
  return {
    id, type: 'message', role: 'assistant', model: 'claude-opus-5', content: blocks,
    stop_reason: stopReason, stop_sequence: null,
    ...(stopReason === 'refusal' ? { stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' } } : {}),
    usage: { input_tokens: 10, output_tokens: 42, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

const THINK: Block = { type: 'tool_use', id: 'toolu_fixture1', name: 'think', input: { content: 'a long private note' } };
const TEXT: Block = { type: 'text', text: 'plain answer' };

/** Run one call against a local server answering `body`, return its llm-calls row and stderr lines.
 *  `prompt` replaces the request's text; `unwritable` puts the log in a directory that doesn't
 *  exist, so the row can't be appended (`written` false, `row` empty). */
async function oneCall(
  kind: 'stream' | 'complete',
  body: string | Record<string, unknown>,
  options: { prompt?: string; unwritable?: boolean } = {},
) {
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(req) {
      await req.json();
      const headers = { 'request-id': `req_fixture_${kind}` };
      return typeof body === 'string'
        ? new Response(body, { headers: { ...headers, 'content-type': 'text/event-stream' } })
        : Response.json(body, { headers });
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'llm-calls-anomaly-'));
  const path = options.unwritable ? join(dir, 'missing', 'llm-calls.test.jsonl') : join(dir, 'llm-calls.test.jsonl');
  const call: ProviderRequest = options.prompt === undefined ? request
    : { ...request, messages: [{ participant: 'user', content: [{ type: 'text', text: options.prompt }] }] as never };
  const errors: string[] = [];
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  const prev = process.env.LLM_CALLS_FULL_PAYLOADS;
  delete process.env.LLM_CALLS_FULL_PAYLOADS;
  try {
    const adapter = new LoggingAnthropicAdapter(
      { apiKey: 'test', baseURL: server.url.href, cacheKeepalive: { enabled: false } }, path,
    );
    if (kind === 'stream') await adapter.stream(call, { onChunk: () => {} });
    else await adapter.complete(call);
    const written = existsSync(path);
    const row = written ? JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown> : {};
    return { row, written, anomalyLines: errors.filter((l) => l.startsWith('[llm-calls]')) };
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
    expect(anomalyLines[0].endsWith(" — full request kept in this call's llm-calls row")).toBe(true);
  });

  test("a row over the 16 MiB cap is written without its raw request, and the line quotes the row's own truncated text", async () => {
    const { row, anomalyLines } = await oneCall('stream', sse([THINK], 'end_turn'), { prompt: `big ${'x'.repeat(17 * 1024 * 1024)}` });
    expect('rawRequest' in row).toBe(false);
    expect(row.truncated).toBe('raw request dropped (record exceeded size guard)');
    expect(row.anomaly).toEqual({
      kind: 'tool_use_with_stop_reason', stopReason: 'end_turn', providerStopReason: 'end_turn', toolNames: ['think'],
    });
    expect(anomalyLines).toHaveLength(1);
    expect(anomalyLines[0].endsWith(` — this call's llm-calls row: ${row.truncated}`)).toBe(true);
  });

  test("a row that can't be appended is named as not written, not as kept", async () => {
    const { written, anomalyLines } = await oneCall('stream', sse([THINK], 'end_turn'), { unwritable: true });
    expect(written).toBe(false);
    expect(anomalyLines).toHaveLength(1);
    expect(anomalyLines[0].endsWith(" — this call's llm-calls row could not be written (ENOENT)")).toBe(true);
  });

  test('stream: a provider that reports no stop reason reads as provider: none', async () => {
    const { row, anomalyLines } = await oneCall('stream', sse([THINK], null));
    expect(row.anomaly).toMatchObject({ kind: 'tool_use_with_stop_reason', providerStopReason: null, toolNames: ['think'] });
    expect(anomalyLines[0]).toContain('(provider: none)');
    expect(row.rawRequest).toBeDefined();
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
  });

  test('ignores server-side tool blocks and text-only responses', () => {
    expect(responseAnomaly({ raw: { content: [{ type: 'server_tool_use', name: 'web_search' }], stop_reason: 'end_turn' } })).toBeUndefined();
    expect(responseAnomaly({ raw: { content: [TEXT], stop_reason: 'end_turn' } })).toBeUndefined();
  });

  test("names a raw response's own anomalies list", () => {
    expect(responseAnomaly({ raw: { content: [TEXT], stop_reason: 'end_turn', anomalies: [{ kind: 'x' }] } }))
      .toEqual({ kind: 'provider_reported', stopReason: 'end_turn', toolNames: [], reported: [{ kind: 'x' }] });
    expect(responseAnomaly({ raw: { content: [TEXT], stop_reason: 'end_turn', anomalies: [] } })).toBeUndefined();
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
  test('omits the provider part when the response does not say', () => {
    expect(anomalyLogLine('2026-01-01T00:00:00.000Z', 'stream', 'm', { kind: 'tool_use_with_stop_reason', stopReason: 'end_turn', toolNames: ['a', 'b'] }, {}, { written: true }))
      .toBe("[llm-calls] 2026-01-01T00:00:00.000Z ANOMALY tool_use with stop_reason=end_turn kind=stream model=m tools=a,b — full request kept in this call's llm-calls row");
  });

  test("ends with what the row kept: the row's own truncated text, or that it could not be written", () => {
    const line = (row: { written: boolean; truncated?: string; code?: string }) =>
      anomalyLogLine('2026-01-01T00:00:00.000Z', 'stream', 'm', { kind: 'tool_use_with_stop_reason', stopReason: 'end_turn', toolNames: ['a'] }, {}, row);
    const start = '[llm-calls] 2026-01-01T00:00:00.000Z ANOMALY tool_use with stop_reason=end_turn kind=stream model=m tools=a';
    expect(line({ written: true, truncated: 'raw bodies dropped (record exceeded size guard)' }))
      .toBe(`${start} — this call's llm-calls row: raw bodies dropped (record exceeded size guard)`);
    expect(line({ written: false, code: 'ENOSPC' })).toBe(`${start} — this call's llm-calls row could not be written (ENOSPC)`);
    expect(line({ written: false })).toBe(`${start} — this call's llm-calls row could not be written`);
  });
});
