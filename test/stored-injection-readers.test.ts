import { describe, expect, test } from 'bun:test';
import { compiledWithoutStoredInjections, storedInjectionLabel } from '../src/stored-injection.js';
import { namingSummary } from '../src/synesthete.js';
import { historyInjectionLine } from '../src/tui.js';
import { toWireEntry } from '../src/modules/web-ui-module.js';
import { handleCommand, createBranchState } from '../src/commands.js';
import { SubagentModule } from '../src/modules/subagent-module.js';
import { storedInjectionMarkOf, type Module, type ModuleContext, type ModuleContextInjection } from '@animalabs/agent-framework';
import { bootPresentedHost } from './presented-host.js';

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

// On this branch /undo is the framework's undo on the agent's window
// (agent-framework #291, decision 4): the host no longer picks a record row to
// branch at, so main's cases for where /undo lands among stored injections,
// written over a stub record and its branchAt, are read onto a real framework.
// A turn's stored injections are stored after its checkpoint, by its compile,
// so the undo takes them out of the window with the turn's reply, and the rows
// before the turn stay: where main's /undo lands. Main's tool-round case is
// gone with the record-level undo: the framework's undo takes the whole turn,
// its rounds too, and "nothing to undo" means no turn to undo
// (commands-branch-framework.test.ts).
describe('/undo steps back past stored injections', () => {
  /** Gathers one afterUser block per compile, its text new each time, so each turn stores its own. */
  class Lessons implements Module {
    readonly name = 'lessons';
    ctx: ModuleContext | null = null;
    private n = 0;
    async start(ctx: ModuleContext): Promise<void> { this.ctx = ctx; }
    async stop(): Promise<void> {}
    getTools() { return []; }
    async handleToolCall() { return { success: false, isError: true, error: 'no tools' }; }
    async onProcess() { return {}; }
    async gatherContext(): Promise<ModuleContextInjection[]> {
      this.n += 1;
      return [{ namespace: 'retrieval', position: 'afterUser', content: [{ type: 'text', text: `LESSON ${this.n}` }] }];
    }
  }

  test("after a turn, the turn's stored block leaves the agent's window with its reply, and the rows before the turn stay", async () => {
    const lessons = new Lessons();
    const h = await bootPresentedHost({ agents: ['alice'], modules: [lessons as unknown as Module], prefix: 'undo-injections-' });
    try {
      const cm = h.framework.getAgent('alice')!.getContextManager();
      const say = (text: string) => lessons.ctx!.addMessage('user', [{ type: 'text', text }], undefined, { forAgent: 'alice' });
      say('u1 plan the migration');
      await h.turn('alice');
      say('u2 and the rollback');
      const before = cm.getPresentedMessages().map((m) => m.id);
      await h.turn('alice');
      const stored = cm.getAllMessages().filter((m) => storedInjectionMarkOf(m.metadata) !== undefined && !before.includes(m.id));
      // The premise: the second turn stored a block of its own, after the user's row.
      expect(stored.length).toBeGreaterThan(0);
      const reply = cm.getAllMessages().at(-1)!;
      expect(reply.participant).toBe('alice');

      const undo = handleCommand('/undo', { framework: h.framework, agentName: 'alice', branchState: createBranchState() } as never);
      expect(undo.lines[0]!.text).toContain("alice's last turn left its window");
      expect(cm.getPresentedMessages().map((m) => m.id)).toEqual(before);
      for (const row of [...stored, reply]) {
        expect(h.inWindow('alice', row.id)).toBe(false);
        expect(cm.getAllMessages().map((m) => m.id)).toContain(row.id);
      }
    } finally {
      await h.cleanup();
    }
  }, 30_000);
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
