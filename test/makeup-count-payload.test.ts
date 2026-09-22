import { describe, test, expect } from 'bun:test';
import { buildCountTokensPayload } from '../src/web/panel-data.js';

// Regression: the makeup panel's exact count flattened every message to its
// text blocks and sent no tool definitions, so signed thinking, tool_use and
// tool_result — most of a keep-all model's prompt — were not counted and the
// "exact" number read up to ~10x below what the provider bills.

const SIG = 'A'.repeat(4000);

describe('buildCountTokensPayload', () => {
  test('keeps signed thinking, tool_use and tool_result blocks', () => {
    const p = buildCountTokensPayload({
      system: 'sys',
      messages: [
        { participant: 'Lari', content: [{ type: 'text', text: 'hello' }] },
        { participant: 'agent', content: [
          { type: 'thinking', thinking: '', signature: SIG },
          { type: 'tool_use', id: 't1', name: 'read', input: { path: 'a' } },
        ] },
        { participant: 'user', content: [
          { type: 'tool_result', toolUseId: 't1', content: 'file body' },
        ] },
        { participant: 'agent', content: [{ type: 'text', text: 'done' }] },
      ],
      tools: [{ name: 'read', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
    }, 'agent');

    expect(p.system).toBe('sys');
    expect(p.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const asst = p.messages[1]!.content as Array<{ type: string; signature?: string; id?: string }>;
    expect(asst.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(asst[0]!.signature).toBe(SIG);
    const res = p.messages[2]!.content as Array<{ type: string; tool_use_id?: string }>;
    expect(res[0]!.type).toBe('tool_result');
    expect(res[0]!.tool_use_id).toBe('t1');
    expect(p.tools).toEqual([{ name: 'read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }]);
  });

  test('prefixes other participants and merges consecutive same-role runs', () => {
    const p = buildCountTokensPayload({
      messages: [
        { participant: 'Lari', content: [{ type: 'text', text: 'one' }] },
        { participant: 'Antra', content: [{ type: 'text', text: 'two' }] },
        { participant: 'agent', content: [{ type: 'text', text: 'three' }] },
      ],
    }, 'agent');
    expect(p.messages).toHaveLength(2);
    const first = p.messages[0]!.content as Array<{ type: string; text?: string }>;
    expect(first.map((b) => b.text)).toEqual(['Lari: ', 'one', 'Antra: ', 'two']);
    expect(p.messages[1]!.role).toBe('assistant');
    expect(p.tools).toBeUndefined();
    expect(p.system).toBeUndefined();
  });

  test('string content and empty messages', () => {
    const p = buildCountTokensPayload({
      messages: [
        { participant: 'user', content: 'plain' },
        { participant: 'agent', content: [] },
      ],
    }, 'agent');
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]!.content).toEqual([{ type: 'text', text: 'plain' }]);
  });
});
