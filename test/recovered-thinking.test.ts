import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicAdapter } from '@animalabs/membrane';
import { LoggingAnthropicAdapter } from '../src/logging-adapter.js';
import {
  classifyRecoveredThinking,
  recoveredThinkingRefused,
  resetRecoveredThinkingRefusals,
  stripRecoveredThinking,
} from '../src/recovered-thinking.js';

const TAG = '<recovered_thinking>\nThe user is greeting me.\n</recovered_thinking>';
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

  test('a message with only thinking keeps a short placeholder', () => {
    const out = stripRecoveredThinking([{ role: 'assistant', content: [{ type: 'text', text: TAG }] }]) as Array<{ content: unknown }>;
    expect(out[0]!.content).toEqual([{ type: 'text', text: '[earlier thinking left out]' }]);
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
    return tagged && refusingModels.has(req.model)
      ? { content: [], stopReason: 'refusal', refusalCategory: 'reasoning_extraction', usage: { inputTokens: 10, outputTokens: 0 } }
      : { content: [{ type: 'text', text: 'fine' }], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 1 } };
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
      return { content: [], stopReason: 'refusal', refusalCategory: 'reasoning_extraction', usage: { inputTokens: 10, outputTokens: 0 } };
    };
    const a = adapter();
    const plain = { model: 'claude-fable-5-2', maxTokens: 100, messages: [{ role: 'user', content: 'hi' }] };
    const r = await a.complete(plain as never) as { stopReason: string };
    expect(r.stopReason).toBe('refusal');
    expect(sent).toHaveLength(1);
    expect(recoveredThinkingRefused('claude-fable-5-2')).toBe(false);
  });
});
