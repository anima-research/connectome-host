import { describe, test, expect, afterEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { handleCommand, createBranchState } from '../src/commands.js';
import { DEFAULT_CONFIG_PATH } from '../src/mcpl-config.js';

// Regression tests for the QA-reported command family:
// - first-token argument parsing truncated multi-word names on
//   /checkpoint, /restore, /checkout, /session switch, /session delete
//   (while /session rename accepted them — making renamed sessions
//   unreachable by name);
// - /session delete executed irreversibly with no confirmation;
// - /mcp add on an existing server silently wiped its env vars;
// - head-moving commands ran while a generation was in flight, letting
//   the streaming reply commit onto the wrong branch (orphaned nodes);
// - /budget displayed small values as "0k" (50 → "0k") while rejecting 0.

interface StubMessage { id: string; participant: string; content: unknown[] }

function makeStubWorld(agentStatus: string | undefined = 'idle') {
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
    ...(agentStatus !== undefined ? { state: { status: agentStatus } } : {}),
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
    const { app, addMessage, text } = makeStubWorld(undefined);
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
});

describe('/mcp add preserves env on overwrite', () => {
  // handleMcp* read/write DEFAULT_CONFIG_PATH (cwd/mcpl-servers.json, which
  // is gitignored). Skip rather than clobber if a real config exists.
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
