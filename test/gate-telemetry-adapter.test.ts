/**
 * Adapter-level proof (review finding on #113): with the PUBLISHED membrane,
 * a stream call consults the active-turn trigger and carries the origin trio,
 * while a complete call (compression / side-calls / keepalive) carries the
 * debt stamp only. Runs the real AnthropicAdapter with a mocked SDK client.
 */
import { describe, expect, it } from 'bun:test';
import { AnthropicAdapter } from '@animalabs/membrane';
import { gateTelemetryHeaders } from '../src/gate-telemetry.js';

const env = { GATE_TELEMETRY: '1', ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic' };
const wake = { reason: 'mcpl:channel-incoming', source: 'discord', channelId: 'discord:1:2', counterparty: 'discord:user:42' };

const REQUEST = {
  model: 'claude-test',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
} as any;

const RESPONSE = {
  id: 'msg_test', model: 'claude-test', role: 'assistant',
  content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
};

/** Minimal SDK stream: an async iterable of the events the adapter reads. */
function mockStream() {
  const events = [
    { type: 'message_start', message: { id: 'msg_s', model: 'claude-test', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  return {
    async *[Symbol.asyncIterator]() { for (const e of events) yield e; },
  };
}

function adapterWithTrigger(trigger: () => typeof wake | null) {
  let asked = 0;
  const dyn = gateTelemetryHeaders(env, () => 3, () => { asked++; return trigger(); })!;
  const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false }, dynamicHeaders: dyn } as any);
  const calls: Array<{ kind: string; headers: Record<string, string> | undefined }> = [];
  (adapter as any).client = {
    messages: {
      create: async (_req: unknown, opts: { headers?: Record<string, string> }) => { calls.push({ kind: 'complete', headers: opts?.headers }); return RESPONSE; },
      stream: async (_req: unknown, opts: { headers?: Record<string, string> }) => { calls.push({ kind: 'stream', headers: opts?.headers }); return mockStream(); },
    },
  };
  return { adapter, calls, asked: () => asked };
}

describe('gate telemetry through the published AnthropicAdapter', () => {
  it('complete lane: debt only — the active trigger is not consulted', async () => {
    const { adapter, calls, asked } = adapterWithTrigger(() => wake);
    await adapter.complete(REQUEST);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe('complete');
    expect(calls[0]!.headers).toEqual({ 'x-gate-debt-chunks': '3' });
    expect(asked()).toBe(0);
  });

  it('stream lane: the trigger is consulted and the origin trio rides the request', async () => {
    const { adapter, calls, asked } = adapterWithTrigger(() => wake);
    const chunks: string[] = [];
    await adapter.stream(REQUEST, { onChunk: (c: string) => { chunks.push(c); } } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe('stream');
    expect(calls[0]!.headers).toEqual({
      'x-gate-debt-chunks': '3',
      'x-gate-origin': 'event',
      'x-gate-channel': 'discord:1:2',
      'x-gate-counterparty': 'discord:user:42',
    });
    expect(asked()).toBe(1);
  });

  it('stream lane with no turn in progress: debt only, nothing guessed', async () => {
    const { adapter, calls } = adapterWithTrigger(() => null);
    await adapter.stream(REQUEST, { onChunk: () => {} } as any);
    expect(calls[0]!.headers).toEqual({ 'x-gate-debt-chunks': '3' });
  });
});
