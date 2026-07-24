import { describe, test, expect } from 'bun:test';
import { handleCommand, createBranchState } from '../src/commands.js';

// Regression tests for /checkpoint + /restore POSITION semantics. The
// original bug: checkpoints stored only a branch name, so /restore switched
// to the branch HEAD — including everything after the checkpoint — rolling
// back nothing, silently. These tests run over a stub ContextManager that
// mimics Chronicle's contract: branchAt resolves ids against the CURRENT
// branch's view of the log and throws for unreachable ids.

interface StubMessage { id: string; participant: string; content: unknown[] }

function makeStubWorld() {
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

  const addMessage = (participant = 'user'): StubMessage => {
    const msg: StubMessage = { id: `m${++msgCounter}`, participant, content: [] };
    messagesByBranch.get(currentName)!.push(msg);
    return msg;
  };

  const app = {
    framework: {
      getAgent: () => undefined,
      getAllAgents: () => [{ getContextManager: () => cm }],
      getAllModules: () => [],
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
    addMessage('agent'); // work after the checkpoint that must be rolled back

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

    // Second restore at the same position: the guard must hold even though
    // we're now on restore-cp-… rather than the original branch (the guard
    // used to compare branch names and died after the first restore,
    // minting a sibling branch per repeat).
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

    // Simulate /undo: branch truncated BEFORE the checkpoint message, so the
    // checkpoint id is unreachable from the current branch's view.
    const undoBranch = cm.branchAt(early.id, 'undo-1');
    await cm.switchBranch(undoBranch);

    const result = handleCommand('/restore cp', app);
    const outcome = await result.asyncWork!;
    expect(currentName()).toBe('main');
    expect(outcome.lines.some(l => l.text.includes('unreachable'))).toBe(true);
  });
});
