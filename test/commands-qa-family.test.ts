import { describe, test, expect, afterEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { handleCommand, createBranchState } from '../src/commands.js';
import { DEFAULT_CONFIG_PATH } from '../src/mcpl-config.js';
import { clearAccountBindings, recordAccountBinding } from '../src/logging-adapter.js';

interface StubMessage { id: string; participant: string; content: unknown[] }

function makeStubWorld(agentStatus: string | null = 'idle') {
  const messagesByBranch = new Map<string, StubMessage[]>([['main', []]]);
  let currentName = 'main';
  let msgCounter = 0;

  const cm = {
    currentBranch: () => ({ id: currentName, name: currentName, head: messagesByBranch.get(currentName)!.length }),
    listBranches: () => [...messagesByBranch.keys()].map(name => ({ id: name, name, head: messagesByBranch.get(name)!.length })),
    queryMessages: (_q: unknown) => ({ messages: messagesByBranch.get(currentName)! }),
    branchAt: (messageId: string, newName: string): string => {
      const msgs = messagesByBranch.get(currentName)!;
      const idx = msgs.findIndex(m => m.id === messageId);
      if (idx === -1) throw new Error(`Message not found: ${messageId}`);
      messagesByBranch.set(newName, msgs.slice(0, idx + 1));
      return newName;
    },
    switchBranch: async (name: string): Promise<void> => {
      if (!messagesByBranch.has(name)) throw new Error(`No such branch: ${name}`);
      currentName = name;
    },
  };

  const agent = {
    name: 'stub-agent',
    ...(agentStatus !== null ? { state: { status: agentStatus } } : {}),
    getContextManager: () => cm,
  };

  const deleted: string[] = [];
  const sessions = [
    { id: 'aaaa1111', name: 'Renamed Multi Word Name', manuallyNamed: true, createdAt: 't', lastAccessedAt: 't', messageCount: 3 },
    { id: 'bbbb2222', name: 'other', manuallyNamed: true, createdAt: 't', lastAccessedAt: 't', messageCount: 1 },
  ];

  const app = {
    framework: {
      getAgent: () => undefined,
      getAllAgents: () => [agent],
      getAllModules: () => [],
      getStore: () => ({ currentBranch: () => cm.currentBranch() }),
      switchBranch: (name: string) => cm.switchBranch(name),
    },
    sessionManager: {
      listSessions: () => sessions,
      getActiveSession: () => sessions[1],
      findSession: (nameOrId: string) =>
        sessions.find(s => s.id === nameOrId || s.id.startsWith(nameOrId) || s.name === nameOrId),
      deleteSession: (id: string) => { deleted.push(id); },
    },
    branchState: createBranchState(),
  } as any;

  const addMessage = (participant = 'user'): StubMessage => {
    const msg: StubMessage = { id: `m${++msgCounter}`, participant, content: [] };
    messagesByBranch.get(currentName)!.push(msg);
    return msg;
  };

  const text = (r: { lines: Array<{ text: string }> }) => r.lines.map(l => l.text).join('\n');

  return { cm, app, addMessage, deleted, text, currentName: () => currentName };
}

describe('multi-word names: rest-of-line parsing', () => {
  test('/checkpoint saves the full multi-word name', () => {
    const { app, addMessage } = makeStubWorld();
    addMessage(); addMessage('agent');
    handleCommand('/checkpoint my test point', app);
    expect(app.branchState.checkpoints.has('my test point')).toBe(true);
    expect(app.branchState.checkpoints.has('my')).toBe(false);
  });

  test('/restore finds a multi-word checkpoint', async () => {
    const { app, addMessage, text } = makeStubWorld();
    addMessage(); addMessage('agent');
    handleCommand('/checkpoint some check point', app);
    addMessage(); addMessage('agent');
    const r = handleCommand('/restore some check point', app);
    expect(text(r)).not.toContain('not found');
    await r.asyncWork;
  });

  test('/session switch reaches a multi-word-renamed session', () => {
    const { app, text } = makeStubWorld();
    const r = handleCommand('/session switch Renamed Multi Word Name', app);
    expect(text(r)).toContain('Switching to session');
    expect(r.switchToSessionId).toBe('aaaa1111');
  });

  test('/checkout passes the full name through (not found reported honestly)', () => {
    const { app, text } = makeStubWorld();
    const r = handleCommand('/checkout my branch name', app);
    expect(text(r)).toContain('Branch "my branch name" not found');
  });
});

describe('/session delete confirmation', () => {
  test('bare delete shows the match and asks for --confirm, deletes nothing', () => {
    const { app, deleted, text } = makeStubWorld();
    const r = handleCommand('/session delete other', app);
    expect(deleted).toEqual([]);
    expect(text(r)).toContain('irreversible');
    expect(text(r)).toContain('--confirm');
    expect(text(r)).toContain('bbbb2222');
  });

  test('delete with --confirm deletes', () => {
    const { app, deleted } = makeStubWorld();
    handleCommand('/session delete other --confirm', app);
    expect(deleted).toEqual(['bbbb2222']);
  });

  test('multi-word name + --confirm parses both correctly', () => {
    const { app, deleted } = makeStubWorld();
    handleCommand('/session delete Renamed Multi Word Name --confirm', app);
    expect(deleted).toEqual(['aaaa1111']);
  });
});

describe('in-flight guard on head-moving commands', () => {
  for (const cmd of ['/undo', '/redo', '/checkout main', '/newtopic', '/branchto m1']) {
    test(`${cmd} is refused while streaming`, () => {
      const { app, addMessage, text } = makeStubWorld('streaming');
      addMessage(); addMessage('agent');
      const r = handleCommand(cmd, app);
      expect(text(r)).toContain('refused: a turn is in flight');
      expect(r.asyncWork).toBeUndefined();
    });
  }

  test('/undo proceeds when idle', () => {
    const { app, addMessage, text } = makeStubWorld('idle');
    addMessage(); addMessage('agent');
    const r = handleCommand('/undo', app);
    expect(text(r)).toContain('Undoing');
  });

  test('agents without state (stubs) are treated as idle', () => {
    const { app, addMessage, text } = makeStubWorld(null);
    addMessage(); addMessage('agent');
    const r = handleCommand('/undo', app);
    expect(text(r)).toContain('Undoing');
  });
});

describe('checkpoint visibility', () => {
  test('/branches lists checkpoints alongside branches', () => {
    const { app, addMessage, text } = makeStubWorld();
    addMessage(); addMessage('agent');
    handleCommand('/checkpoint visible point', app);
    const r = handleCommand('/branches', app);
    expect(text(r)).toContain('Checkpoints (1');
    expect(text(r)).toContain('visible point');
  });

  test('bare /checkpoint lists existing checkpoints', () => {
    const { app, addMessage, text } = makeStubWorld();
    addMessage(); addMessage('agent');
    handleCommand('/checkpoint alpha', app);
    const r = handleCommand('/checkpoint', app);
    expect(text(r)).toContain('alpha');
  });
});

describe('/budget honest display', () => {
  function makeBudgetApp(maxStreamTokens: number, last = 0) {
    return {
      framework: {
        getAgent: () => undefined,
        getAllAgents: () => [{ name: 'a', maxStreamTokens, lastStreamInputTokens: last, getContextManager: () => null }],
        getAllModules: () => [],
      },
      branchState: createBranchState(),
    } as any;
  }

  test('small values display exactly, not as 0k', () => {
    const app = makeBudgetApp(1000);
    const r = handleCommand('/budget 50', app);
    expect(r.lines[0]!.text).toContain('50 tokens');
    expect(r.lines[0]!.text).not.toContain('0k');
  });

  test('show branch displays small budgets exactly', () => {
    const app = makeBudgetApp(50, 12);
    const r = handleCommand('/budget', app);
    expect(r.lines.map(l => l.text).join('\n')).toContain('a: 50 (last: 12');
  });

  test("an agent whose thinking binds and whose window is set is told apart: the budget doesn't break its stream", () => {
    const agent = (name: string, model: string, physicalWindowTokens?: number) => ({
      name, model, physicalWindowTokens, maxStreamTokens: 150_000, lastStreamInputTokens: 400_000, getContextManager: () => null,
    });
    const app = {
      framework: {
        getAgent: () => undefined,
        getAllAgents: () => [
          agent('bound', 'claude-opus-5-5', 1_000_000),
          agent('unbound', 'claude-opus-4-8', 1_000_000),
          agent('nowindow', 'claude-opus-5-5'),
        ],
        getAllModules: () => [],
      },
      branchState: createBranchState(),
    } as any;
    const listed = handleCommand('/budget', app).lines.map(l => l.text);
    expect(listed.find(l => l.startsWith('  bound:'))).toContain("its stream doesn't break at this budget mid-turn: for its size, only before a request its 1.0M window can't hold");
    for (const name of ['unbound', 'nowindow']) {
      expect(listed.find(l => l.startsWith(`  ${name}:`))).not.toContain("doesn't break");
    }
    const set = handleCommand('/budget 200k', app).lines.map(l => l.text);
    expect(set[0]).toBe('Stream budget set to 200.0k tokens for all agents.');
    expect(set[1]).toContain("doesn't break the stream mid-turn for bound, whose thinking binds and whose window is set");
    expect(set).toHaveLength(2);
  });
  test("on an account found to show thinking whose earlier conversation changed, the budget breaks a binding model's stream as any other", () => {
    recordAccountBinding('claude-opus-5-5', 'shows');
    try {
      const app = {
        framework: {
          getAgent: () => undefined,
          getAllAgents: () => [{
            name: 'bound', model: 'claude-opus-5-5', physicalWindowTokens: 1_000_000, maxStreamTokens: 150_000, lastStreamInputTokens: 400_000, getContextManager: () => null,
          }],
          getAllModules: () => [],
        },
        branchState: createBranchState(),
      } as any;
      expect(handleCommand('/budget', app).lines.map(l => l.text).find(l => l.startsWith('  bound:'))).not.toContain("doesn't break");
      expect(handleCommand('/budget 200k', app).lines.map(l => l.text)).toEqual(['Stream budget set to 200.0k tokens for all agents.']);
    } finally {
      clearAccountBindings();
    }
  });
});

describe('/mcp add preserves env on overwrite', () => {
  const hadFile = existsSync(DEFAULT_CONFIG_PATH);
  const original = hadFile ? readFileSync(DEFAULT_CONFIG_PATH, 'utf-8') : null;

  afterEach(() => {
    if (original !== null) writeFileSync(DEFAULT_CONFIG_PATH, original);
    else if (existsSync(DEFAULT_CONFIG_PATH)) unlinkSync(DEFAULT_CONFIG_PATH);
  });

  test('overwriting the command keeps env vars and reports them', () => {
    const app = { framework: { getAllAgents: () => [], getAllModules: () => [] }, branchState: createBranchState() } as any;
    handleCommand('/mcp add envtest echo hello', app);
    handleCommand('/mcp env envtest FOO=bar SECRET=hunter2', app);
    const r = handleCommand('/mcp add envtest echo goodbye', app);

    const saved = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf-8')).mcplServers;
    expect(saved.envtest.env).toEqual({ FOO: 'bar', SECRET: 'hunter2' });
    expect(saved.envtest.command).toBe('echo');
    expect(saved.envtest.args).toEqual(['goodbye']);
    expect(r.lines.map(l => l.text).join('\n')).toContain('kept env: FOO, SECRET');
  });

  test('old args are dropped when the new command line has none', () => {
    const app = { framework: { getAllAgents: () => [], getAllModules: () => [] }, branchState: createBranchState() } as any;
    handleCommand('/mcp add argtest echo one two', app);
    handleCommand('/mcp add argtest ls', app);
    const saved = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, 'utf-8')).mcplServers;
    expect(saved.argtest.command).toBe('ls');
    expect(saved.argtest.args).toBeUndefined();
  });
});

describe('/newtopic cut short by a stop', () => {
  const CROSSED = 'Transition summary crossed a branch generation; reinitialize before retrying';
  test('a reset that fails while the host is stopping says so and gives what the reset said; one that fails otherwise gives the failure', async () => {
    for (const stopping of [true, false]) {
      const { cm, app, text } = makeStubWorld('idle');
      Object.assign(cm, {
        resetHeadWindow: async () => {
          if (stopping) app.stopping = true;
          throw new Error(CROSSED);
        },
      });
      const follow = await handleCommand('/newtopic', app).asyncWork!;
      expect(text(follow)).toBe(stopping
        ? `Topic reset stopped: the host is stopping. What the reset said: ${CROSSED}`
        : `Topic reset failed: ${CROSSED}`);
    }
  });
});
