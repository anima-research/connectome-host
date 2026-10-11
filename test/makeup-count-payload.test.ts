import { describe, test, expect } from 'bun:test';
import { NativeFormatter } from '@animalabs/membrane';
import type { NormalizedMessage } from '@animalabs/membrane';
import { buildCountTokensPayload } from '../src/web/panel-data.js';

// Regression: the makeup panel's exact count flattened every message to its
// text blocks and sent no tool definitions, so signed thinking, tool_use and
// tool_result — most of a keep-all model's prompt — were not counted and the
// "exact" number read up to ~10x below what the provider bills. A hand-rolled
// mirror of the formatter then differed in prefix bytes and block framing; the
// payload is now built by the formatter inference uses.

const SIG = 'A'.repeat(4000);
type Block = { type: string; text?: string; signature?: string; id?: string; tool_use_id?: string; source?: unknown };
const blocksOf = (m: unknown) => (m as { content: Block[] }).content;
const roleOf = (m: unknown) => (m as { role: string }).role;

describe('buildCountTokensPayload', () => {
  test('is byte-identical to the NativeFormatter build inference would send', () => {
    const messages: NormalizedMessage[] = [
      { participant: 'Lari', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
      { participant: 'agent', content: [
        { type: 'thinking', thinking: '', signature: SIG } as never,
        { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } },
      ] },
      { participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'file body' }] },
      { participant: 'agent', content: [{ type: 'text', text: 'done' }] },
    ];
    const tools = [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
    const payload = buildCountTokensPayload({ system: 'sys', messages, tools }, 'agent');
    const reference = new NativeFormatter().buildMessages(messages, {
      participantMode: 'multiuser', assistantParticipant: 'agent', tools, toolMode: 'native',
      systemPrompt: 'sys', promptCaching: false, cacheMarkers: 'membrane-system',
    });
    expect(payload.messages).toEqual(reference.messages as unknown[]);
    expect(payload.tools).toEqual(reference.nativeTools as unknown[]);
    expect(payload.system).toEqual(reference.systemContent);
  });

  // The name rides in the message's own text, never as a block of its own,
  // and the first text block carries it: that much any formatter must keep,
  // and the test pins it. Which later blocks carry the name too is the
  // formatter's choice: membrane 0.5.86 prefixes every one, and membrane's
  // main (f857fff) only the first. So for the rest, the payload must equal
  // the formatter's own output.
  test('prefixes a named user message in place, as the formatter does — no standalone name block', () => {
    const messages: NormalizedMessage[] = [{ participant: 'Lari', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }];
    const payload = buildCountTokensPayload({ messages }, 'agent');
    const blocks = blocksOf(payload.messages[0]);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'text']);
    expect(blocks[0]!.text).toBe('Lari: one');
    expect(blocks[1]!.text).toMatch(/^(Lari: )?two$/);
    const reference = new NativeFormatter().buildMessages(messages, {
      participantMode: 'multiuser', assistantParticipant: 'agent', toolMode: 'native',
      promptCaching: false, cacheMarkers: 'membrane-system',
    });
    expect(payload.messages).toEqual(reference.messages as unknown[]);
  });

  test('a named message with no text gets no name block', () => {
    const png = 'iVBORw0KGgo=';
    const payload = buildCountTokensPayload({
      messages: [{ participant: 'Lari', content: [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: png } } as never]}],
    }, 'agent');
    const blocks = blocksOf(payload.messages[0]);
    expect(blocks.map((b) => b.type)).toEqual(['image']);
  });

  test('keeps signed thinking, tool_use and tool_result blocks with ids and signature; tools carry input_schema', () => {
    const payload = buildCountTokensPayload({
      messages: [
        { participant: 'Lari', content: [{ type: 'text', text: 'hello' }] },
        { participant: 'agent', content: [
          { type: 'thinking', thinking: '', signature: SIG } as never,
          { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } },
        ] },
        { participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'file body' }] },
        { participant: 'agent', content: [{ type: 'text', text: 'done' }] },
      ],
      tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
    }, 'agent');
    expect(payload.messages.map(roleOf)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const asst = blocksOf(payload.messages[1]);
    expect(asst.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(asst[0]!.signature).toBe(SIG);
    expect(blocksOf(payload.messages[2])[0]!.tool_use_id).toBe('t1');
    expect((payload.tools as Array<{ name: string; input_schema?: unknown }>)[0]!.name).toBe('read');
    expect((payload.tools as Array<{ input_schema?: unknown }>)[0]!.input_schema).toBeDefined();
  });

  test('merges consecutive same-role runs and omits empty tools/system', () => {
    const payload = buildCountTokensPayload({
      messages: [
        { participant: 'Lari', content: [{ type: 'text', text: 'one' }] },
        { participant: 'Antra', content: [{ type: 'text', text: 'two' }] },
        { participant: 'agent', content: [{ type: 'text', text: 'three' }] },
      ],
    }, 'agent');
    expect(payload.messages).toHaveLength(2);
    expect(blocksOf(payload.messages[0]).map((b) => b.text)).toEqual(['Lari: one', 'Antra: two']);
    expect(payload.tools).toBeUndefined();
    expect(payload.system).toBeUndefined();
  });
});
