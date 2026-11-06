import { describe, test, expect } from 'bun:test';
import {
  importedMessages,
  linearize,
  personNameOf,
  transformContent,
  parseToggleSpec,
  splitMixedToolMessages,
} from '../scripts/import-claudeai-export.js';
import type { ContentBlock } from '@animalabs/membrane';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import { SessionManager } from '../src/session-manager.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  test('synthesizes a stable id for null-id tool_use blocks, unlike another message\'s at the same position', () => {
    const msgOpts = {
      uuid: 'msg-A',
      sender: 'assistant' as const,
      content: [
        { type: 'text', text: 'thinking out loud' },
        { type: 'tool_use', id: null, name: 'web_search', input: { q: 'hi' } },
      ],
    };
    const msg = mkMsg(msgOpts);
    const out = transformContent(msg);
    const tu = out.find((b) => b.type === 'tool_use') as Extract<ContentBlock, { type: 'tool_use' }>;
    expect(tu).toBeDefined();
    expect(typeof tu.id).toBe('string');
    expect(tu.id.length).toBeGreaterThan(0);
    const again = transformContent(msg).find((b) => b.type === 'tool_use') as Extract<ContentBlock, { type: 'tool_use' }>;
    expect(again.id).toBe(tu.id);
    const other = transformContent(mkMsg({ ...msgOpts, uuid: 'msg-A2' })).find((b) => b.type === 'tool_use') as Extract<ContentBlock, { type: 'tool_use' }>;
    expect(other.id).not.toBe(tu.id);
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
  });
});

describe('splitMixedToolMessages', () => {
  function mkBlocks(spec: string): ContentBlock[] {
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

describe('the person\'s name', () => {
  const exportWith = (users: string | null): string => {
    const dir = mkdtempSync(join(tmpdir(), 'claudeai-export-'));
    if (users !== null) writeFileSync(join(dir, 'users.json'), users);
    return dir;
  };

  test('is the full_name of the one user the export\'s users.json gives, trimmed', () => {
    expect(personNameOf(exportWith(JSON.stringify([{ uuid: 'u1', full_name: ' Walk Three ', email_address: 'w@example.invalid', verified_phone_number: null }])))).toBe('Walk Three');
  });

  test('--person with no name after it is refused, writing nothing, rather than taking the next option as the name', () => {
    const dir = exportWith(null);
    writeFileSync(join(dir, 'conversations.json'), '[]');
    const out = join(dir, 'out');
    const ran = Bun.spawnSync([process.execPath, join(import.meta.dir, '..', 'scripts', 'import-claudeai-export.ts'), dir,
      '--out', out, '--no-interactive', '--person', '--dry-run'], { stdin: 'ignore' });
    expect(ran.exitCode).toBe(1);
    expect(ran.stderr.toString()).toContain('--person needs the name to give the person\'s turns: --person <name>');
    expect(existsSync(out)).toBe(false);
  });

  test('"user", given with --person or named in users.json, is refused, saying why and to give another, writing nothing', () => {
    for (const [users, extra, said] of [
      [null, ['--person', 'user'], '--person names the person "user"'],
      [JSON.stringify([{ uuid: 'u1', full_name: ' user ' }]), [], 'The export\'s users.json names its one user "user"'],
    ] as const) {
      const dir = exportWith(users);
      writeFileSync(join(dir, 'conversations.json'), '[]');
      const out = join(dir, 'out');
      const ran = Bun.spawnSync([process.execPath, join(import.meta.dir, '..', 'scripts', 'import-claudeai-export.ts'), dir,
        '--out', out, '--no-interactive', ...extra], { stdin: 'ignore' });
      expect(ran.exitCode, said).toBe(1);
      expect(ran.stderr.toString()).toContain(`${said}, which is the name the host gives a turn whose author has no name, so their turns would go in unnamed. Give the name to use with --person <name>.`);
      expect(existsSync(out)).toBe(false);
    }
  });

  test('is "user" where users.json is missing, isn\'t JSON, names no one, more than one, or a blank name', () => {
    for (const users of [null, '{not json', '[]', JSON.stringify([{ full_name: 'A' }, { full_name: 'B' }]), JSON.stringify([{ full_name: '  ' }]), JSON.stringify([{}])]) {
      expect(personNameOf(exportWith(users)), String(users)).toBe('user');
    }
  });

  test('names the person\'s turns as a channel message names its author, under "user", and leaves the agent\'s, and the tool results its turns carry, as they were', () => {
    const said: ContentBlock[] = [{ type: 'text', text: 'Hello' }];
    expect(importedMessages(said, 'human', { agent: 'Claude', person: 'Walk Three' })).toEqual([
      { participant: 'user', content: [{ type: 'text', text: 'Walk Three: Hello' }], author: { name: 'Walk Three' } },
    ]);
    expect(said).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(importedMessages(said, 'human', { agent: 'Claude', person: 'user' })).toEqual([{ participant: 'user', content: said }]);
    const returned = [{ type: 'tool_result', toolUseId: 't1', content: 'found' }] as ContentBlock[];
    expect(importedMessages(returned, 'human', { agent: 'Claude', person: 'Walk Three' })).toEqual([{ participant: 'user', content: returned }]);
    const mixed = [{ type: 'text', text: 'and this' }, { type: 'tool_result', toolUseId: 't1', content: 'found' }] as ContentBlock[];
    const unnamed = importedMessages(mixed, 'human', { agent: 'Claude', person: 'Walk Three' });
    expect(unnamed.map((message) => message.participant)).toEqual(unnamed.map(() => 'user'));
    expect(unnamed.flatMap((message) => message.content)).toEqual(mixed);
    expect(JSON.stringify(unnamed)).not.toContain('Walk Three');
    const turn: ContentBlock[] = [
      { type: 'tool_use', id: 't1', name: 'search', input: {} },
      { type: 'tool_result', toolUseId: 't1', content: 'found' },
      { type: 'text', text: 'Done.' },
    ] as ContentBlock[];
    expect(importedMessages(turn, 'assistant', { agent: 'Claude', person: 'Walk Three' })).toEqual(splitMixedToolMessages(turn, 'Claude'));
    expect(importedMessages([], 'human', { agent: 'Claude', person: 'Walk Three' })).toEqual([]);
  });
});

describe('an import, run as a person runs it', () => {
  const message = (uuid: string, parent: string, sender: 'human' | 'assistant', text: string) => ({
    uuid, parent_message_uuid: parent, sender, text, content: [{ type: 'text', text }], attachments: [], files: [],
    created_at: '2026-08-02T09:30:00Z', updated_at: '2026-08-02T09:30:00Z',
  });
  const exportOf = (users: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'claudeai-export-run-'));
    writeFileSync(join(dir, 'users.json'), JSON.stringify(users));
    writeFileSync(join(dir, 'conversations.json'), JSON.stringify([{
      uuid: '8c9a0ab7-96c6-4a36-87fa-7e27c0c4be88', name: 'Lisbon', summary: '', created_at: '2026-08-02T09:30:00Z',
      updated_at: '2026-08-02T09:31:00Z', account: { uuid: 'u1' },
      chat_messages: [
        message('cc2f4b0a-e85f-4062-abe3-6ecdb88f55f4', ROOT, 'human', 'Four days in Lisbon?'),
        message('dd2f4b0a-e85f-4062-abe3-6ecdb88f55f4', 'cc2f4b0a-e85f-4062-abe3-6ecdb88f55f4', 'assistant', 'Plenty of time.'),
      ],
    }]));
    return dir;
  };
  const imported = async (exportDir: string, extra: string[]) => {
    const out = join(mkdtempSync(join(tmpdir(), 'claudeai-import-out-')), 'data');
    mkdirSync(out, { recursive: true });
    const ran = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'scripts', 'import-claudeai-export.ts'), exportDir, '--out', out, '--no-interactive', ...extra]);
    expect(ran.exitCode, ran.stderr.toString()).toBe(0);
    const sessions = new SessionManager(out);
    const [meta] = Object.values((sessions.load() as { sessions: Record<string, { id: string }> }).sessions);
    const store = JsStore.openOrCreate({ path: sessions.getStorePath(meta!.id) });
    const cm = await ContextManager.open({ store });
    return cm.queryMessages({}).messages.map((m) => ({
      participant: m.participant,
      author: (m.metadata as { author?: unknown } | undefined)?.author ?? null,
      text: (m.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text,
    }));
  };

  test('names the person by users.json\'s one name, or by --person, as a channel message names its author, and leaves the agent\'s turns as they were', async () => {
    const dir = exportOf([{ uuid: 'u1', full_name: 'Walk Three', email_address: 'w@example.invalid', verified_phone_number: null }]);
    expect((await imported(dir, [])).slice(0, 2)).toEqual([
      { participant: 'user', author: { name: 'Walk Three' }, text: 'Walk Three: Four days in Lisbon?' },
      { participant: 'Claude', author: null, text: 'Plenty of time.' },
    ]);
    expect((await imported(dir, ['--person', 'ra']))[0]).toEqual({ participant: 'user', author: { name: 'ra' }, text: 'ra: Four days in Lisbon?' });
  }, 60_000);

  test('leaves the person\'s turns as before where the export names no one and no --person is given', async () => {
    const dir = exportOf([]);
    expect((await imported(dir, []))[0]).toEqual({ participant: 'user', author: null, text: 'Four days in Lisbon?' });
  }, 60_000);
});
