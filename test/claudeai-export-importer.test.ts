import { describe, test, expect } from 'bun:test';
import { linearize, transformContent } from '../scripts/import-claudeai-export.js';

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
