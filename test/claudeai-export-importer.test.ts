import { describe, test, expect } from 'bun:test';
import {
  linearize,
  transformContent,
  parseToggleSpec,
  splitMixedToolMessages,
} from '../scripts/import-claudeai-export.js';
import type { ContentBlock } from '@animalabs/membrane';

const ROOT = '00000000-0000-4000-8000-000000000000';

function mkMsg(opts: {
  uuid: string;
  parent?: string;
  created?: string;
  sender?: 'human' | 'assistant';
  content?: unknown[];
  text?: string;
}) {
  return {
    uuid: opts.uuid,
    parent_message_uuid: opts.parent ?? ROOT,
    sender: opts.sender ?? 'human',
    text: opts.text ?? '',
    content: (opts.content ?? []) as never[],
    attachments: [],
    files: [],
    created_at: opts.created ?? '2026-01-01T00:00:00.000Z',
    updated_at: opts.created ?? '2026-01-01T00:00:00.000Z',
  };
}

describe('linearize', () => {
  test('returns messages in topological order for an unbranched conversation', () => {
    const msgs = [
      mkMsg({ uuid: 'a', parent: ROOT, created: '2026-01-01T00:00:01Z' }),
      mkMsg({ uuid: 'b', parent: 'a', created: '2026-01-01T00:00:02Z' }),
      mkMsg({ uuid: 'c', parent: 'b', created: '2026-01-01T00:00:03Z' }),
    ];
    const { path, branched } = linearize(msgs);
    expect(branched).toBe(false);
    expect(path.map((m) => m.uuid)).toEqual(['a', 'b', 'c']);
  });

  test('at a single fork, picks the subtree with the latest-leaf timestamp', () => {
    // Tree:        a
    //             / \
    //            b   c
    //            |   |
    //            b2  c2  (c2 is more recent → expect a, c, c2)
    const msgs = [
      mkMsg({ uuid: 'a', parent: ROOT, created: '2026-01-01T00:00:01Z' }),
      mkMsg({ uuid: 'b', parent: 'a', created: '2026-01-01T00:00:02Z' }),
      mkMsg({ uuid: 'b2', parent: 'b', created: '2026-01-01T00:00:03Z' }),
      mkMsg({ uuid: 'c', parent: 'a', created: '2026-01-01T00:00:04Z' }),
      mkMsg({ uuid: 'c2', parent: 'c', created: '2026-01-01T00:00:05Z' }),
    ];
    const { path, branched } = linearize(msgs);
    expect(branched).toBe(true);
    expect(path.map((m) => m.uuid)).toEqual(['a', 'c', 'c2']);
  });

  test('with multiple forks at tied depths, picks deterministically by timestamp', () => {
    // a -> {b -> b2 @ T=5, c -> c2 @ T=10}
    // Both subtrees are depth 2; c-side has the later leaf, so we pick c.
    const msgs = [
      mkMsg({ uuid: 'a', parent: ROOT, created: '2026-01-01T00:00:01Z' }),
      mkMsg({ uuid: 'b', parent: 'a', created: '2026-01-01T00:00:02Z' }),
      mkMsg({ uuid: 'b2', parent: 'b', created: '2026-01-01T00:00:05Z' }),
      mkMsg({ uuid: 'c', parent: 'a', created: '2026-01-01T00:00:03Z' }),
      mkMsg({ uuid: 'c2', parent: 'c', created: '2026-01-01T00:00:10Z' }),
    ];
    const { path } = linearize(msgs);
    expect(path.map((m) => m.uuid)).toEqual(['a', 'c', 'c2']);
  });

  test('handles empty input', () => {
    const { path, branched } = linearize([]);
    expect(path).toEqual([]);
    expect(branched).toBe(false);
  });
});

describe('transformContent', () => {
  test('text block round-trips as TextContent', () => {
    const msg = mkMsg({
      uuid: 'x',
      sender: 'human',
      content: [{ type: 'text', text: 'hello' }],
    });
    const out = transformContent(msg);
    expect(out).toEqual([{ type: 'text', text: 'hello' }]);
  });

  test('thinking block becomes <recovered_thinking>-wrapped text', () => {
    const msg = mkMsg({
      uuid: 'x',
      sender: 'assistant',
      content: [{ type: 'thinking', thinking: 'I was reasoning about X' }],
    });
    const out = transformContent(msg);
    expect(out).toHaveLength(1);
    const t = out[0]! as { type: 'text'; text: string };
    expect(t.type).toBe('text');
    expect(t.text).toContain('<recovered_thinking>');
    expect(t.text).toContain('I was reasoning about X');
    expect(t.text).toContain('</recovered_thinking>');
  });

  test('tool_use round-trips with id, name, input', () => {
    const msg = mkMsg({
      uuid: 'x',
      sender: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'web_search', input: { q: 'rust' } }],
    });
    const out = transformContent(msg);
    expect(out).toEqual([{ type: 'tool_use', id: 'tu_1', name: 'web_search', input: { q: 'rust' } }]);
  });

  test('tool_result round-trips with toolUseId (renamed from tool_use_id)', () => {
    const msg = mkMsg({
      uuid: 'x',
      sender: 'human',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'result text' }],
    });
    const out = transformContent(msg);
    expect(out).toEqual([{ type: 'tool_result', toolUseId: 'tu_1', content: 'result text' }]);
  });

  test('unknown block types are preserved as grep-able placeholder text', () => {
    const msg = mkMsg({
      uuid: 'x',
      sender: 'assistant',
      content: [{ type: 'server_tool_use', some: 'payload' } as never],
    });
    const out = transformContent(msg);
    expect(out).toHaveLength(1);
    const t = out[0]! as { type: 'text'; text: string };
    expect(t.text).toContain('[unknown_block');
    expect(t.text).toContain('"server_tool_use"');
  });

  test('attachments prepend as <attachment>-wrapped text', () => {
    const msg = {
      ...mkMsg({ uuid: 'x', sender: 'human' }),
      attachments: [
        { file_name: 'notes.txt', file_type: 'txt', file_size: 42, extracted_content: 'NOTES' },
      ],
    };
    const out = transformContent(msg);
    const first = out[0]! as { type: 'text'; text: string };
    expect(first.text).toContain('<attachment name="notes.txt"');
    expect(first.text).toContain('size="42"');
    expect(first.text).toContain('NOTES');
    expect(first.text).toContain('</attachment>');
  });

  test('escapeAttr handles ampersand correctly (canonical order)', () => {
    const msg = {
      ...mkMsg({ uuid: 'x', sender: 'human' }),
      attachments: [{ file_name: 'Q&A.txt', extracted_content: 'body' }],
    };
    const out = transformContent(msg);
    const first = out[0]! as { type: 'text'; text: string };
    expect(first.text).toContain('Q&amp;A.txt');
    expect(first.text).not.toContain('Q&A.txt');
  });

  test('file references (no bytes) trail as placeholder text', () => {
    const msg = {
      ...mkMsg({ uuid: 'x', sender: 'human' }),
      files: [{ file_uuid: 'fu_1', file_name: 'image.png' }],
    };
    const out = transformContent(msg);
    const last = out[out.length - 1]! as { type: 'text'; text: string };
    expect(last.text).toContain('image.png');
    expect(last.text).toContain('fu_1');
    expect(last.text).toContain('bytes not in export');
  });
});

describe('transformContent — null tool IDs', () => {
  test('synthesizes a stable id for null-id tool_use blocks', () => {
    const msg = mkMsg({
      uuid: 'msg-A',
      sender: 'assistant',
      content: [
        { type: 'text', text: 'thinking out loud' },
        { type: 'tool_use', id: null, name: 'web_search', input: { q: 'hi' } },
      ],
    });
    const out = transformContent(msg);
    const tu = out.find((b) => b.type === 'tool_use') as Extract<ContentBlock, { type: 'tool_use' }>;
    expect(tu).toBeDefined();
    expect(typeof tu.id).toBe('string');
    expect(tu.id.length).toBeGreaterThan(0);
    expect(tu.id).toContain('msg-A');
  });

  test('pairs null tool_use id with null tool_result.tool_use_id by FIFO', () => {
    const msg = mkMsg({
      uuid: 'msg-B',
      sender: 'assistant',
      content: [
        { type: 'tool_use', id: null, name: 'conversation_search', input: { q: 'foo' } },
        { type: 'tool_result', tool_use_id: null, content: 'result body' },
      ],
    });
    const out = transformContent(msg);
    const tu = out.find((b) => b.type === 'tool_use') as Extract<ContentBlock, { type: 'tool_use' }>;
    const tr = out.find((b) => b.type === 'tool_result') as Extract<ContentBlock, { type: 'tool_result' }>;
    expect(tu.id).toBe(tr.toolUseId);
    expect(tu.id).toContain('msg-B');
  });

  test('handles multiple bundled cycles in one message (FIFO pairing)', () => {
    const msg = mkMsg({
      uuid: 'msg-C',
      sender: 'assistant',
      content: [
        { type: 'tool_use', id: null, name: 'search_A', input: {} },
        { type: 'tool_result', tool_use_id: null, content: 'A' },
        { type: 'tool_use', id: null, name: 'search_B', input: {} },
        { type: 'tool_result', tool_use_id: null, content: 'B' },
      ],
    });
    const out = transformContent(msg);
    const uses = out.filter((b) => b.type === 'tool_use') as Array<Extract<ContentBlock, { type: 'tool_use' }>>;
    const results = out.filter((b) => b.type === 'tool_result') as Array<Extract<ContentBlock, { type: 'tool_result' }>>;
    expect(uses).toHaveLength(2);
    expect(results).toHaveLength(2);
    expect(uses[0]!.id).toBe(results[0]!.toolUseId);
    expect(uses[1]!.id).toBe(results[1]!.toolUseId);
    expect(uses[0]!.id).not.toBe(uses[1]!.id);
  });

  test('preserves explicit non-null ids unchanged', () => {
    const msg = mkMsg({
      uuid: 'msg-D',
      sender: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_explicit_123', name: 'do', input: {} },
        { type: 'tool_result', tool_use_id: 'toolu_explicit_123', content: 'ok' },
      ],
    });
    const out = transformContent(msg);
    const tu = out.find((b) => b.type === 'tool_use') as Extract<ContentBlock, { type: 'tool_use' }>;
    const tr = out.find((b) => b.type === 'tool_result') as Extract<ContentBlock, { type: 'tool_result' }>;
    expect(tu.id).toBe('toolu_explicit_123');
    expect(tr.toolUseId).toBe('toolu_explicit_123');
  });

  test('emits an orphan id for tool_result with no preceding tool_use', () => {
    const msg = mkMsg({
      uuid: 'msg-E',
      sender: 'assistant',
      content: [{ type: 'tool_result', tool_use_id: null, content: 'orphaned' }],
    });
    const out = transformContent(msg);
    const tr = out.find((b) => b.type === 'tool_result') as Extract<ContentBlock, { type: 'tool_result' }>;
    expect(tr.toolUseId).toBeTruthy();
    expect(tr.toolUseId).toContain('orphan');
  });
});

describe('splitMixedToolMessages', () => {
  function mkBlocks(spec: string): ContentBlock[] {
    // shorthand: 't' = text, 'u' = tool_use, 'r' = tool_result
    return spec.split('').map((c, i) => {
      if (c === 't') return { type: 'text', text: `t${i}` };
      if (c === 'u') return { type: 'tool_use', id: `u${i}`, name: 'fn', input: {} };
      if (c === 'r') return { type: 'tool_result', toolUseId: `u${i}`, content: 'res' };
      throw new Error(`bad char: ${c}`);
    });
  }

  test('passes through a user-source message unchanged', () => {
    const blocks = mkBlocks('tt');
    const out = splitMixedToolMessages(blocks, 'user');
    expect(out).toEqual([{ participant: 'user', content: blocks }]);
  });

  test('returns empty for empty input', () => {
    expect(splitMixedToolMessages([], 'agent')).toEqual([]);
  });

  test('passes through assistant message with no tool_result unchanged', () => {
    const blocks = mkBlocks('tut');
    const out = splitMixedToolMessages(blocks, 'agent');
    expect(out).toHaveLength(1);
    expect(out[0]!.participant).toBe('agent');
    expect(out[0]!.content).toEqual(blocks);
  });

  test('splits text-tool_use-tool_result-text into three messages', () => {
    const blocks = mkBlocks('turt');
    const out = splitMixedToolMessages(blocks, 'agent');
    expect(out).toHaveLength(3);
    expect(out[0]!.participant).toBe('agent');
    expect(out[0]!.content.map((b) => b.type)).toEqual(['text', 'tool_use']);
    expect(out[1]!.participant).toBe('user');
    expect(out[1]!.content.map((b) => b.type)).toEqual(['tool_result']);
    expect(out[2]!.participant).toBe('agent');
    expect(out[2]!.content.map((b) => b.type)).toEqual(['text']);
  });

  test('merges adjacent tool_results into one user message', () => {
    const blocks = mkBlocks('uurr');
    const out = splitMixedToolMessages(blocks, 'agent');
    expect(out).toHaveLength(2);
    expect(out[0]!.participant).toBe('agent');
    expect(out[0]!.content.map((b) => b.type)).toEqual(['tool_use', 'tool_use']);
    expect(out[1]!.participant).toBe('user');
    expect(out[1]!.content.map((b) => b.type)).toEqual(['tool_result', 'tool_result']);
  });

  test('handles tool_result at the start of an assistant message', () => {
    const blocks = mkBlocks('rt');
    const out = splitMixedToolMessages(blocks, 'agent');
    expect(out).toHaveLength(2);
    expect(out[0]!.participant).toBe('user');
    expect(out[0]!.content.map((b) => b.type)).toEqual(['tool_result']);
    expect(out[1]!.participant).toBe('agent');
    expect(out[1]!.content.map((b) => b.type)).toEqual(['text']);
  });

  test('handles tool_result at the end of an assistant message', () => {
    const blocks = mkBlocks('tur');
    const out = splitMixedToolMessages(blocks, 'agent');
    expect(out).toHaveLength(2);
    expect(out[0]!.participant).toBe('agent');
    expect(out[0]!.content.map((b) => b.type)).toEqual(['text', 'tool_use']);
    expect(out[1]!.participant).toBe('user');
    expect(out[1]!.content.map((b) => b.type)).toEqual(['tool_result']);
  });

  test('handles multiple alternating cycles in one message', () => {
    const blocks = mkBlocks('urur');
    const out = splitMixedToolMessages(blocks, 'agent');
    // [u]-[r]-[u]-[r] → 4 messages: agent, user, agent, user
    expect(out.map((m) => m.participant)).toEqual(['agent', 'user', 'agent', 'user']);
    expect(out.flatMap((m) => m.content.map((b) => b.type))).toEqual([
      'tool_use', 'tool_result', 'tool_use', 'tool_result',
    ]);
  });

  test('preserves custom agentName as participant of non-tool-result chunks', () => {
    const blocks = mkBlocks('tur');
    const out = splitMixedToolMessages(blocks, 'commander');
    expect(out[0]!.participant).toBe('commander');
    expect(out[1]!.participant).toBe('user');
  });
});

describe('parseToggleSpec', () => {
  test('handles single numbers', () => {
    const s = parseToggleSpec('3', 10);
    expect([...s].sort((a, b) => a - b)).toEqual([3]);
  });

  test('handles ranges', () => {
    const s = parseToggleSpec('2-5', 10);
    expect([...s].sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
  });

  test('mixes commas, ranges, and whitespace', () => {
    const s = parseToggleSpec('1, 3-5  7', 10);
    expect([...s].sort((a, b) => a - b)).toEqual([1, 3, 4, 5, 7]);
  });

  test('clamps to [1, max]', () => {
    const s = parseToggleSpec('0-3 8-99', 5);
    expect([...s].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    // 8-99 → low bound > max, nothing added
  });

  test('ignores non-numeric junk', () => {
    const s = parseToggleSpec('foo 2 bar', 10);
    expect([...s]).toEqual([2]);
  });

  test('returns empty set for empty input', () => {
    expect(parseToggleSpec('', 10).size).toBe(0);
    expect(parseToggleSpec('   ', 10).size).toBe(0);
  });
});
