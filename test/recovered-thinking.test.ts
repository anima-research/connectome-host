import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicAdapter } from '@animalabs/membrane';
import { LoggingAnthropicAdapter } from '../src/logging-adapter.js';
import { LoggingProviderAdapter } from '../src/logging-provider-wrapper.js';
import {
  classifyRecoveredThinking,
  isRecoveredThinkingRefusal,
  recordRecoveredThinkingRefused,
  recoveredThinkingRefused,
  resetRecoveredThinkingRefusals,
  stripRecoveredThinking,
} from '../src/recovered-thinking.js';

const TAG = '<recovered_thinking>\nThe user is greeting me.\n</recovered_thinking>';

/** A refusal as membrane 0.8.1's AnthropicAdapter returns it: normalized
 *  fields beside the raw API message. */
const refusal = () => ({
  content: [],
  stopReason: 'refusal',
  providerStopReason: 'refusal',
  refusalCategory: 'reasoning_extraction',
  usage: { inputTokens: 10, outputTokens: 0 },
  raw: {
    type: 'message', role: 'assistant', content: [],
    stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'reasoning_extraction' },
    usage: { input_tokens: 10, output_tokens: 0 },
  },
});
/** The same refusal from an adapter or decorator that leaves the normalized
 *  category and stop reason out: only the raw message says what it was. */
const rawOnlyRefusal = () => {
  const { refusalCategory: _c, providerStopReason: _p, ...rest } = refusal();
  return { ...rest, stopReason: 'end_turn', usage: { inputTokens: 10 } };
};
const fine = () => ({
  content: [{ type: 'text', text: 'fine' }], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 1 },
  raw: { stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1 } },
});
const chat = () => [
  { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  { role: 'assistant', content: [{ type: 'text', text: TAG }, { type: 'text', text: 'Hello!' }] },
  { role: 'user', content: [{ type: 'text', text: 'how are you?' }] },
];

describe('stripRecoveredThinking', () => {
  test('classifies the importer shapes', () => {
    expect(classifyRecoveredThinking({ type: 'text', text: '<recovered_thinking>\n\n</recovered_thinking>' })).toBe('remove');
    expect(classifyRecoveredThinking({ type: 'text', text: TAG })).toBe('remove');
    expect(classifyRecoveredThinking({ type: 'text', text: TAG }, true)).toBe('keep');
    expect(classifyRecoveredThinking({ type: 'text', text: `${TAG}\n\nHello` })).toBe('mixed');
    expect(classifyRecoveredThinking({ type: 'tool_use', id: 't', name: 'x', input: {} })).toBe('keep');
  });

  test('returns the same array when nothing matches', () => {
    const messages = [{ role: 'user', content: 'plain string content' }, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }];
    expect(stripRecoveredThinking(messages)).toBe(messages);
  });

  test('removes the block and keeps the rest', () => {
    const out = stripRecoveredThinking(chat()) as Array<{ content: unknown }>;
    expect(out[1]!.content).toEqual([{ type: 'text', text: 'Hello!' }]);
    expect(out[0]).toEqual(chat()[0]);
  });

  test("a removed block's cache_control moves to a neighbour", () => {
    const cc = { type: 'ephemeral' };
    const before = stripRecoveredThinking([
      { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: TAG, cache_control: cc }] },
    ]) as Array<{ content: unknown }>;
    expect(before[0]!.content).toEqual([{ type: 'text', text: 'a', cache_control: cc }]);
    const after = stripRecoveredThinking([
      { role: 'assistant', content: [{ type: 'text', text: TAG, cache_control: cc }, { type: 'text', text: 'b' }] },
    ]) as Array<{ content: unknown }>;
    expect(after[0]!.content).toEqual([{ type: 'text', text: 'b', cache_control: cc }]);
  });

  test('complete spans inside other text are replaced; a lone mention is left alone', () => {
    const transcript = `Claude: ${TAG}\nHello!\nUser: how are you?`;
    const out = stripRecoveredThinking([
      { role: 'user', content: [{ type: 'text', text: transcript }] },
      { role: 'user', content: [{ type: 'text', text: 'what does <recovered_thinking> mean?' }] },
    ]) as Array<{ content: Array<{ text: string }> }>;
    expect(out[0]!.content[0]!.text).toBe('Claude: [earlier thinking left out]\nHello!\nUser: how are you?');
    expect(out[1]!.content[0]!.text).toBe('what does <recovered_thinking> mean?');
  });

  test('string content is filtered too', () => {
    const out = stripRecoveredThinking([
      { role: 'assistant', content: TAG },
      { role: 'assistant', content: `${TAG}\n\nHello!` },
    ]) as Array<{ content: string }>;
    expect(out[0]!.content).toBe('[earlier thinking left out]');
    expect(out[1]!.content).toBe('[earlier thinking left out]\n\nHello!');
  });

  test('a message with only thinking keeps a short placeholder', () => {
    const out = stripRecoveredThinking([{ role: 'assistant', content: [{ type: 'text', text: TAG }] }]) as Array<{ content: unknown }>;
    expect(out[0]!.content).toEqual([{ type: 'text', text: '[earlier thinking left out]' }]);
  });
});

describe('isRecoveredThinkingRefusal', () => {
  test("reads membrane's normalized fields", () => {
    expect(isRecoveredThinkingRefusal(refusal())).toBe(true);
  });
  test('falls back to the raw stop_details when the normalized ones are missing', () => {
    expect(isRecoveredThinkingRefusal(rawOnlyRefusal())).toBe(true);
  });
  test('another category, output, or no refusal is not it', () => {
    expect(isRecoveredThinkingRefusal({ ...refusal(), refusalCategory: 'cyber', raw: { stop_reason: 'refusal', stop_details: { category: 'cyber' } } })).toBe(false);
    expect(isRecoveredThinkingRefusal({ ...refusal(), usage: { outputTokens: 5 } })).toBe(false);
    expect(isRecoveredThinkingRefusal(fine())).toBe(false);
    expect(isRecoveredThinkingRefusal(undefined)).toBe(false);
  });
});

describe('the adapter learns which models refuse it', () => {
  const proto = AnthropicAdapter.prototype as unknown as {
    complete: (req: unknown, opts?: unknown) => Promise<unknown>;
    stream: (req: unknown, cb: unknown, opts?: unknown) => Promise<unknown>;
  };
  const original = { complete: proto.complete, stream: proto.stream };
  let sent: Array<{ model: string; messages: unknown[] }>;
  let dir: string;
  const refusingModels = new Set(['claude-opus-5-5']);
  const respond = (req: { model: string; messages: unknown[] }) => {
    sent.push(req);
    const tagged = stripRecoveredThinking(req.messages) !== req.messages;
    return tagged && refusingModels.has(req.model) ? refusal() : fine();
  };

  beforeEach(() => {
    resetRecoveredThinkingRefusals();
    sent = [];
    dir = mkdtempSync(join(tmpdir(), 'rt-adapter-'));
    proto.complete = async (req) => respond(req as never);
    proto.stream = async (req) => respond(req as never);
  });
  afterEach(() => {
    proto.complete = original.complete;
    proto.stream = original.stream;
    rmSync(dir, { recursive: true, force: true });
  });

  const adapter = () => new LoggingAnthropicAdapter({ apiKey: 'test-key' }, join(dir, 'llm.jsonl'), () => ({ enabled: false, budgetTokens: 0 }));
  const request = (model: string) => ({ model, maxTokens: 100, messages: chat() });

  test('a refusing model: sent again without the blocks, and left out from then on', async () => {
    const a = adapter();
    const first = await a.stream(request('claude-opus-5-5') as never, { onChunk() {} } as never) as { stopReason: string };
    expect(first.stopReason).toBe('end_turn');
    expect(sent).toHaveLength(2);
    expect(recoveredThinkingRefused('claude-opus-5-5')).toBe(true);
    const second = await a.complete(request('claude-opus-5-5') as never) as { stopReason: string };
    expect(second.stopReason).toBe('end_turn');
    expect(sent).toHaveLength(3);
    expect((sent[2]!.messages[1] as { content: unknown }).content).toEqual([{ type: 'text', text: 'Hello!' }]);
  });

  test('a model that takes them keeps them', async () => {
    const a = adapter();
    await a.stream(request('claude-sonnet-5-5') as never, { onChunk() {} } as never);
    expect(sent).toHaveLength(1);
    expect((sent[0]!.messages[1] as { content: unknown[] }).content).toHaveLength(2);
    expect(recoveredThinkingRefused('claude-sonnet-5-5')).toBe(false);
  });

  test('a refusal of a request without the blocks is passed on, and marks nothing', async () => {
    refusingModels.add('claude-fable-5-2');
    proto.complete = async (req) => {
      sent.push(req as never);
      return refusal();
    };
    const a = adapter();
    const plain = { model: 'claude-fable-5-2', maxTokens: 100, messages: [{ role: 'user', content: 'hi' }] };
    const r = await a.complete(plain as never) as { stopReason: string };
    expect(r.stopReason).toBe('refusal');
    expect(sent).toHaveLength(1);
    expect(recoveredThinkingRefused('claude-fable-5-2')).toBe(false);
  });

  test('a refusal named only in the raw message is learned and sent again', async () => {
    proto.complete = async (req) => {
      sent.push(req as never);
      const tagged = stripRecoveredThinking((req as { messages: unknown[] }).messages) !== (req as { messages: unknown[] }).messages;
      return tagged ? rawOnlyRefusal() : fine();
    };
    const r = await adapter().complete(request('claude-opus-5') as never) as { stopReason: string };
    expect(r.stopReason).toBe('end_turn');
    expect(sent).toHaveLength(2);
    expect(recoveredThinkingRefused('claude-opus-5')).toBe(true);
  });

  test('requests in flight together are each sent again, not only the first one refused', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    proto.stream = async (req) => {
      const r = respond(req as never);
      if (r.stopReason === 'refusal') await gate;
      return r;
    };
    const a = adapter();
    const one = a.stream(request('claude-opus-5-5') as never, { onChunk() {} } as never);
    const two = a.stream(request('claude-opus-5-5') as never, { onChunk() {} } as never);
    await Bun.sleep(0);
    release();
    const results = await Promise.all([one, two]) as Array<{ stopReason: string }>;
    expect(results.map((r) => r.stopReason)).toEqual(['end_turn', 'end_turn']);
    expect(sent).toHaveLength(4);
  });

  test('a refusal after part of the stream reached the caller is passed on, and still marks the model', async () => {
    proto.stream = async (req, cb) => {
      sent.push(req as never);
      (cb as { onChunk: (c: string) => void }).onChunk('Hel');
      return refusal();
    };
    const chunks: string[] = [];
    const r = await adapter().stream(request('claude-opus-5-5') as never, { onChunk: (c: string) => chunks.push(c) } as never) as { stopReason: string };
    expect(r.stopReason).toBe('refusal');
    expect(sent).toHaveLength(1);
    expect(chunks).toEqual(['Hel']);
    expect(recoveredThinkingRefused('claude-opus-5-5')).toBe(true);
  });

  test('a refusal that is sent again raises no off-path refusal alert; one that is not, does', async () => {
    const alerts: unknown[] = [];
    const a = adapter();
    a.onRefusal = (info) => alerts.push(info);
    const r = await a.complete(request('claude-opus-5-5') as never) as { stopReason: string };
    expect(r.stopReason).toBe('end_turn');
    expect(sent).toHaveLength(2);
    expect(alerts).toHaveLength(0);
    proto.complete = async (req) => { sent.push(req as never); return refusal(); };
    await a.complete(request('claude-opus-5-5') as never);
    expect(alerts).toHaveLength(1);
  });

  test('spans inside a compression-style transcript are learned and left out', async () => {
    const transcript = { model: 'claude-opus-5-5', maxTokens: 100, messages: [
      { role: 'user', content: [{ type: 'text', text: `Summarize:\nClaude: ${TAG}\nHello!` }] },
    ] };
    const r = await adapter().complete(transcript as never) as { stopReason: string };
    expect(r.stopReason).toBe('end_turn');
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[1]!.messages)).not.toContain('<recovered_thinking>');
  });
});

describe('the provider-agnostic decorator learns it too', () => {
  let dir: string;
  beforeEach(() => {
    resetRecoveredThinkingRefusals();
    dir = mkdtempSync(join(tmpdir(), 'rt-wrapper-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const inner = (sent: unknown[]) => ({
    name: 'fake',
    supportsModel: () => true,
    async complete(req: { messages: unknown[] }) {
      sent.push(req);
      return (stripRecoveredThinking(req.messages) !== req.messages ? refusal() : fine()) as never;
    },
    async stream(req: { messages: unknown[] }) {
      sent.push(req);
      return (stripRecoveredThinking(req.messages) !== req.messages ? refusal() : fine()) as never;
    },
  });

  test('complete and stream: refused, sent again without, left out from then on', async () => {
    const sent: Array<{ messages: unknown[] }> = [];
    const w = new LoggingProviderAdapter(inner(sent) as never, join(dir, 'llm.jsonl'));
    const req = { model: 'anthropic/claude-opus-5.5', maxTokens: 100, messages: chat() };
    expect((await w.stream(req as never, { onChunk() {} } as never)).stopReason).toBe('end_turn');
    expect(sent).toHaveLength(2);
    expect((await w.complete(req as never)).stopReason).toBe('end_turn');
    expect(sent).toHaveLength(3);
    expect(JSON.stringify(sent[2]!.messages)).not.toContain('<recovered_thinking>');
  });

  test('a model already marked never gets the blocks', async () => {
    recordRecoveredThinkingRefused('m');
    const sent: Array<{ messages: unknown[] }> = [];
    const w = new LoggingProviderAdapter(inner(sent) as never, join(dir, 'llm.jsonl'));
    await w.complete({ model: 'm', maxTokens: 1, messages: chat() } as never);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]!.messages)).not.toContain('<recovered_thinking>');
  });
});
