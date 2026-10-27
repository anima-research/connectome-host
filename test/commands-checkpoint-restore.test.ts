import { describe, test, expect } from 'bun:test';
import { handleCommand, createBranchState } from '../src/commands.js';

// The stub ContextManager mimics context-manager's branchAt: it resolves an id
// against the current branch's messages and throws for an id that branch
// can't reach.
//
// Since agent-framework #291 /restore goes through the framework: its
// rollbackToMessage (branchAt and a switch, with every agent sharing the
// store idle), whose 'unknown-message' refusal sends it to the checkpoint's
// branch head through the framework's switchBranch. The stub framework below
// does what those two do over the stub ContextManager; commands-branch-
// framework.test.ts runs them on a real framework.

interface StubMessage { id: string; participant: string; content: unknown[] }

function makeStubWorld() {
  const messagesByBranch = new Map<string, StubMessage[]>([['main', []]]);
  let currentName = 'main';
  let msgCounter = 0;

  // The store the context reads. agent-framework's switchBranch moves it,
  // past every context on it (each live one then follows the move), where a
  // context's own switchBranch also initializes that context's strategy
  // again, as a rollback's switch does for its agent. The stub framework's
  // switchBranch moved the store through the context's, so it modelled a
  // switch that re-initialized the strategy, which the real one didn't (J-H9).
  const store = {
    switchBranch: (name: string): void => {
      if (!messagesByBranch.has(name)) throw new Error(`No such branch: ${name}`);
      currentName = name;
    },
  };

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
    switchBranch: async (name: string): Promise<void> => store.switchBranch(name),
  };

  const addMessage = (participant = 'user'): StubMessage => {
    const msg: StubMessage = { id: `m${++msgCounter}`, participant, content: [] };
    messagesByBranch.get(currentName)!.push(msg);
    return msg;
  };

  const app = {
    framework: {
      getAgent: () => undefined,
      getAllAgents: () => [{ name: 'stub-agent', getContextManager: () => cm }],
      getAllModules: () => [],
      switchBranch: async (name: string) => store.switchBranch(name),
      rollbackToMessage: async (_agent: string, opts: { messageId: string; branchName: string }) => {
        if (!messagesByBranch.get(currentName)!.some(m => m.id === opts.messageId)) {
          throw Object.assign(new Error(`Message ${opts.messageId} is not on the active branch`), { code: 'unknown-message' });
        }
        const targetBranch = cm.branchAt(opts.messageId, opts.branchName);
        await cm.switchBranch(targetBranch);
        return { targetBranch, tailMessageId: opts.messageId };
      },
    },
    branchState: createBranchState(),
    userMessageCount: 0,
  } as any;

  return { cm, app, addMessage, branchCount: () => messagesByBranch.size, currentName: () => currentName };
}

describe('/checkpoint + /restore position semantics', () => {
  test('checkpoint records the last message id, not just the branch', () => {
    const { app, addMessage } = makeStubWorld();
    addMessage();
    const last = addMessage('agent');
    handleCommand('/checkpoint cp', app);
    const point = app.branchState.checkpoints.get('cp');
    expect(point.branchName).toBe('main');
    expect(point.messageId).toBe(last.id);
  });

  test('restore rolls back to the checkpoint position, not the branch head', async () => {
    const { app, addMessage, currentName } = makeStubWorld();
    addMessage();
    const cpMsg = addMessage('agent');
    handleCommand('/checkpoint cp', app);
    addMessage();
    addMessage('agent');

    const result = handleCommand('/restore cp', app);
    const outcome = await result.asyncWork!;
    expect(outcome.branchChanged).toBe(true);
    expect(currentName().startsWith('restore-cp-')).toBe(true);

    const { messages } = (app.framework.getAllAgents()[0].getContextManager() as any).queryMessages({});
    expect(messages[messages.length - 1].id).toBe(cpMsg.id);
  });

  test('restoring while already at the checkpoint is a no-op — no branch minted', async () => {
    const { app, addMessage, branchCount } = makeStubWorld();
    addMessage();
    addMessage('agent');
    handleCommand('/checkpoint cp', app);
    addMessage();

    await handleCommand('/restore cp', app).asyncWork!;
    const branchesAfterFirst = branchCount();

    const second = handleCommand('/restore cp', app);
    expect(second.asyncWork).toBeUndefined();
    expect(second.lines[0]!.text).toContain('Already at checkpoint');
    expect(branchCount()).toBe(branchesAfterFirst);
  });

  test('unreachable checkpoint position degrades to the branch head with a note', async () => {
    const { app, cm, addMessage, currentName } = makeStubWorld();
    const early = addMessage();
    addMessage('agent');
    handleCommand('/checkpoint cp', app);

    const undoBranch = cm.branchAt(early.id, 'undo-1');
    await cm.switchBranch(undoBranch);

    const result = handleCommand('/restore cp', app);
    const outcome = await result.asyncWork!;
    expect(currentName()).toBe('main');
    expect(outcome.lines.some(l => l.text.includes('unreachable'))).toBe(true);
  });
});
