import { describe, expect, test } from 'bun:test';
import { compiledWithoutStoredInjections, storedInjectionLabel } from '../src/stored-injection.js';
import { namingSummary } from '../src/synesthete.js';
import { historyInjectionLine } from '../src/tui.js';
import { toWireEntry } from '../src/modules/web-ui-module.js';
import { handleCommand, createBranchState } from '../src/commands.js';
import { SubagentModule } from '../src/modules/subagent-module.js';

const lessonsRow = (agent = 'alice') => ({
  id: 'inj1',
  participant: 'system_context:retrieval',
  content: [{ type: 'text', text: '## Retrieved Knowledge, for the message beginning "hello"\n- [90%] a lesson' }],
  metadata: { contextInjection: { agent, namespace: 'retrieval', contentHash: 'h1', part: 0, parts: 1 } },
});

describe('the mark', () => {
  test('a partial mark is no mark to the host\'s readers, as it\'s none to the compile', () => {
    const partial = { ...lessonsRow(), metadata: { contextInjection: { agent: 'alice', namespace: 'retrieval' } } };
    expect(toWireEntry(partial, 4).participant).toBe('assistant');
    expect(historyInjectionLine(partial)).toBeUndefined();
    expect(namingSummary([partial])).toContain('Retrieved Knowledge');
  });

  test('its label names the namespace and the agent', () => {
    expect(storedInjectionLabel({ agent: 'alice', namespace: 'retrieval' })).toBe('[retrieval, injected for alice]');
  });
});

describe('readers that answer "what did someone say" leave stored injections out', () => {
  test('session naming reads the conversation, not the first turn\'s lessons block', () => {
    const summary = namingSummary([
      { participant: 'user', content: [{ type: 'text', text: 'Let us plan the migration.' }] },
      lessonsRow(),
      { participant: 'alice', content: [{ type: 'text', text: 'Here is a plan.' }] },
    ]);
    expect(summary).toBe('user: Let us plan the migration.\nalice: Here is a plan.');
  });

  test('session naming leaves stored injections out before it takes its six rows', () => {
    const said = (n: number) => ({ participant: n % 2 ? 'user' : 'alice', content: [{ type: 'text', text: `row ${n}` }] });
    const summary = namingSummary([said(1), lessonsRow(), said(2), lessonsRow(), said(3), said(4), said(5), said(6), said(7)]);
    expect(summary.split('\n')).toEqual(['user: row 1', 'alice: row 2', 'user: row 3', 'alice: row 4', 'user: row 5', 'alice: row 6']);
  });

  test('a subagent whose last act was a tool call doesn\'t report a stored injection as its answer', () => {
    const mod = new SubagentModule({ provider: 'mock' });
    const extract = (mod as unknown as { extractLastAssistantText: (cm: unknown) => string }).extractLastAssistantText.bind(mod);
    const messages = [
      { participant: 'user', content: [{ type: 'text', text: 'Find the file.' }] },
      { participant: 'scout', content: [{ type: 'text', text: 'It is in src/.' }] },
      { participant: 'scout', content: [{ type: 'tool_use', id: 't1', name: 'look', input: {} }] },
      { participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }] },
      lessonsRow('scout'),
    ];
    expect(extract({ getAllMessages: () => messages })).toBe('It is in src/.');
  });
});

describe('readers that show the transcript label stored injections', () => {
  test('the TUI\'s history replay shows one dim line under its label', () => {
    expect(historyInjectionLine(lessonsRow()))
      .toBe('[retrieval, injected for alice] ## Retrieved Knowledge, for the message beginning "hello" - [90%] a lesson');
    const long = { ...lessonsRow(), content: [{ type: 'text', text: 'x'.repeat(300) }] };
    const line = historyInjectionLine(long)!;
    expect(line).toHaveLength(118);
    expect(line.endsWith('…')).toBe(true);
    expect(historyInjectionLine({ ...lessonsRow(), content: [] })).toBe('[retrieval, injected for alice]');
    expect(historyInjectionLine({ content: [{ type: 'text', text: 'hi' }] })).toBeUndefined();
  });

  test('the TUI\'s cut keeps a character whole', () => {
    const line = historyInjectionLine({ ...lessonsRow(), content: [{ type: 'text', text: `${'x'.repeat(84)}😀 more` }] })!;
    expect(line).toBe(`[retrieval, injected for alice] ${'x'.repeat(84)}…`);
  });

  test('a block stored in shards is one line in the TUI, its first shard\'s', () => {
    expect(historyInjectionLine({ ...lessonsRow(), shardIndex: 0 })).toStartWith('[retrieval, injected for alice] ');
    expect(historyInjectionLine({ ...lessonsRow(), shardIndex: 1 })).toBeNull();
  });

  test('the Web UI shows a labelled system row, not the agent\'s message', () => {
    const entry = toWireEntry(lessonsRow(), 4);
    expect(entry.participant).toBe('system');
    expect(entry.text).toBe('[retrieval, injected for alice]\n## Retrieved Knowledge, for the message beginning "hello"\n- [90%] a lesson');
    expect(entry.blocks[0]).toEqual({ kind: 'text', text: '[retrieval, injected for alice]' });
    const unmarked = toWireEntry({ ...lessonsRow(), metadata: undefined }, 4);
    expect(unmarked.participant).toBe('assistant');
    expect(unmarked.text).not.toContain('injected');
  });
});

describe('/undo steps back past stored injections', () => {
  interface Row { id: string; participant: string; content: unknown[]; metadata?: unknown }
  function world(rows: Row[]) {
    const branches = new Map<string, Row[]>([['main', rows]]);
    let current = 'main';
    const cm = {
      currentBranch: () => ({ id: current, name: current, head: branches.get(current)!.length }),
      queryMessages: () => ({ messages: branches.get(current)! }),
      branchAt: (id: string, name: string): string => {
        const msgs = branches.get(current)!;
        const at = msgs.findIndex(m => m.id === id);
        if (at === -1) throw new Error(`Message not found: ${id}`);
        branches.set(name, msgs.slice(0, at + 1));
        return name;
      },
      switchBranch: async (name: string) => { current = name; },
    };
    const app = {
      framework: {
        getAgent: () => undefined,
        getAllAgents: () => [{ getContextManager: () => cm }],
        getAllModules: () => [],
        getStore: () => ({ currentBranch: () => cm.currentBranch() }),
        switchBranch: (name: string) => cm.switchBranch(name),
      },
      branchState: createBranchState(),
      userMessageCount: 0,
    } as never;
    return { app, ids: async () => { return branches.get(current)!.map(m => m.id); } };
  }
  const injection = (id: string): Row => ({ id, participant: 'system_context:retrieval', content: [], metadata: { contextInjection: { agent: 'alice', namespace: 'retrieval', contentHash: 'h1', part: 0, parts: 1 } } });

  test('after a turn, it undoes to the row before the turn\'s stored block', async () => {
    const w = world([
      { id: 'u1', participant: 'user', content: [] },
      { id: 'a1', participant: 'alice', content: [] },
      { id: 'u2', participant: 'user', content: [] },
      injection('i2'),
      injection('f2'),
      { id: 'a2', participant: 'alice', content: [] },
    ]);
    await handleCommand('/undo', w.app).asyncWork;
    expect(await w.ids()).toEqual(['u1', 'a1', 'u2']);
  });

  test('a stored block after the agent\'s last reply isn\'t taken for it', async () => {
    const w = world([
      { id: 'u1', participant: 'user', content: [] },
      injection('i1'),
      { id: 'a1', participant: 'alice', content: [] },
      { id: 'u2', participant: 'user', content: [] },
      injection('i2'),
    ]);
    await handleCommand('/undo', w.app).asyncWork;
    expect(await w.ids()).toEqual(['u1']);
  });

  test('a turn with a tool round keeps its block, as it keeps the round: /undo lands where it would without stored injections', async () => {
    const w = world([
      { id: 'u1', participant: 'user', content: [] },
      injection('i1'),
      { id: 'a1', participant: 'alice', content: [{ type: 'tool_use', id: 't1', name: 'look', input: {} }] },
      { id: 'r1', participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }] },
      { id: 'a2', participant: 'alice', content: [] },
    ]);
    await handleCommand('/undo', w.app).asyncWork;
    expect(await w.ids()).toEqual(['u1', 'i1', 'a1', 'r1']);
  });

  test('with only stored blocks before the reply, there\'s nothing to undo to', () => {
    const w = world([injection('i1'), { id: 'a1', participant: 'alice', content: [] }]);
    expect(handleCommand('/undo', w.app).lines[0]!.text).toBe('Nothing to undo (no agent messages found).');
  });
});

describe('readers of a compile leave stored injections out by its provenance', () => {
  const marked = { contextInjection: { agent: 'alice', namespace: 'retrieval', contentHash: 'h1', part: 0, parts: 1 } };
  const raw = (...ids: string[]) => ({ kind: 'raw' as const, bodies: ids.map((messageId, sequence) => ({ messageId, sequence, complete: true })) });
  const compiled = (sources: unknown[], rows: Record<string, unknown>) => ({
    messages: sources.map((_, i) => `message ${i}`),
    provenance: { messages: sources } as never,
    rawBodies: new Map(Object.entries(rows).map(([id, metadata]) => [id, [{ id, metadata }]])) as never,
  });

  test('a message whose every row is a stored injection goes; any other stays', () => {
    const result = compiled(
      [raw('u1'), raw('i1'), raw('i1', 'u2'), { kind: 'summary', summaries: [{ id: 's', level: 1 }] }, raw('i2'), { kind: 'other' }],
      { u1: {}, i1: marked, u2: { system: true }, i2: marked },
    );
    expect(compiledWithoutStoredInjections(result)).toEqual(['message 0', 'message 2', 'message 3', 'message 5']);
  });

  test('a message the compile can\'t account for stays', () => {
    expect(compiledWithoutStoredInjections({ messages: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(compiledWithoutStoredInjections({ messages: ['a'], provenance: { messages: [raw('i1')] } as never })).toEqual(['a']);
    expect(compiledWithoutStoredInjections(compiled([raw('gone'), raw()], {}))).toEqual(['message 0', 'message 1']);
  });
});

describe('peek', () => {
  test('a subagent\'s last message and its count are its own, not the lessons block stored after it', async () => {
    const mod = new SubagentModule({ provider: 'mock' });
    const view = mod as unknown as { liveSubagents: Map<string, unknown>; frameworkNameIndex: Map<string, string> };
    const mark = { contextInjection: { agent: 'fw-scout', namespace: 'retrieval', contentHash: 'h1', part: 0, parts: 1 } };
    view.liveSubagents.set('scout', {
      frameworkAgentName: 'fw-scout', displayName: 'scout', systemPrompt: 'test', currentStream: '',
      pendingToolCalls: [], activeCallIds: new Set(),
      contextManager: {
        compile: async () => ({
          messages: [
            { participant: 'user', content: [{ type: 'text', text: 'Scout task: find the vault.' }] },
            { participant: 'system_context:retrieval', content: [{ type: 'text', text: '## Retrieved Knowledge\n- [90%] a lesson' }] },
          ],
          provenance: { messages: [
            { kind: 'raw', bodies: [{ messageId: 'u1', sequence: 1, complete: true }] },
            { kind: 'raw', bodies: [{ messageId: 'i1', sequence: 2, complete: true }] },
          ] },
          rawBodies: new Map([['u1', [{ id: 'u1', metadata: {} }]], ['i1', [{ id: 'i1', metadata: mark }]]]),
        }),
      },
    });
    view.frameworkNameIndex.set('fw-scout', 'scout');
    const [snapshot] = await mod.peek('scout');
    expect(snapshot!.lastMessageSnippet).toBe('Scout task: find the vault.');
    expect(snapshot!.messageCount).toBe(1);
  });
});
