/**
 * The host's /undo, /redo, /checkout, /branchto and /restore go through the
 * framework (#291, HOST-1; decision 4 and answer 11). Every agent's context
 * follows its own window over one store, so a host command that moved the
 * store's branch through one agent's context manager bypassed the other
 * agents' windows and the framework's reservation of the store:
 *
 * - /undo and /redo are the framework's undoLastTurn and redo: the agent's
 *   own last turn leaves its window and comes back, no branch moves, and a
 *   co-resident's newer row is left alone;
 * - /checkout is the framework's switchBranch, and /branchto and /restore
 *   its rollbackToMessage: each is refused while any agent sharing the store
 *   has a turn alive, and each is in the operator log.
 *
 * Each runs a real AgentFramework (test/presented-host.ts).
 */
import { describe, test, expect, setDefaultTimeout } from 'bun:test';
import { createBranchState, handleCommand, type CommandResult } from '../src/commands.js';
import { bootPresentedHost, until } from './presented-host.js';

setDefaultTimeout(30_000);

const text = (r: CommandResult) => r.lines.map((l) => l.text).join('\n');
/** A command's lines, and its follow-up's once it has settled. */
async function run(command: string, app: unknown): Promise<{ result: CommandResult; follow?: CommandResult; all: string }> {
  const result = handleCommand(command, app as never);
  const follow = result.asyncWork ? await result.asyncWork : undefined;
  return { result, follow, all: [text(result), ...(follow ? [text(follow)] : [])].join('\n') };
}

describe('/undo and /redo', () => {
  test("take the agent's own last turn out of its window and put it back, though a co-resident's row is newest, and move no branch", async () => {
    const h = await bootPresentedHost({ agents: ['clerk', 'mira'], prefix: 'cmd-undo-' });
    try {
      await h.turn('clerk');
      await h.turn('mira');
      const clerk = h.framework.getAgent('clerk')!.getContextManager();
      const mira = h.framework.getAgent('mira')!.getContextManager();
      const clerkReply = h.rowWith('clerk', 'clerk reply 1')!;
      const miraReply = h.rowWith('mira', 'mira reply 1')!;
      // Mira's reply is the newest row in the record the two share.
      expect(clerk.getAllMessages().at(-1)!.id).toBe(miraReply.id);
      const branch = h.framework.getStore().currentBranch().name;
      const miraWindow = mira.getPresentedMessages().map((m) => m.id);
      const app = { framework: h.framework, agentName: 'clerk', branchState: createBranchState() };

      const undo = await run('/undo', app);
      expect(undo.result.branchChanged).toBeFalsy();
      expect(undo.all).toContain("clerk's last turn left its window");
      expect(h.framework.getStore().currentBranch().name).toBe(branch);
      expect(clerk.windowStatusOf(clerkReply.id)).toBe('undone');
      // The record keeps both, and mira's window is as it was.
      expect(clerk.getAllMessages().map((m) => m.id)).toContain(clerkReply.id);
      expect(clerk.getAllMessages().map((m) => m.id)).toContain(miraReply.id);
      expect(mira.getPresentedMessages().map((m) => m.id)).toEqual(miraWindow);

      const redo = await run('/redo', app);
      expect(redo.result.branchChanged).toBeFalsy();
      expect(redo.all).toContain("clerk's undone turn is back in its window");
      expect(clerk.windowStatusOf(clerkReply.id)).toBe('in');
      expect(h.framework.getStore().currentBranch().name).toBe(branch);

      expect(text(handleCommand('/redo', app as never))).toBe('Nothing to redo.');
      const log = h.framework.getOperatorLog().map((e) => [e.kind, e.agent, e.requester?.via]);
      expect(log).toContainEqual(['undo-turn', 'clerk', 'host-console']);
      expect(log).toContainEqual(['redo-turn', 'clerk', 'host-console']);
    } finally {
      await h.cleanup();
    }
  });

  test('say when there is nothing to undo or redo', async () => {
    const h = await bootPresentedHost({ agents: ['clerk'], prefix: 'cmd-undo-none-' });
    try {
      const app = { framework: h.framework, agentName: 'clerk', branchState: createBranchState() };
      expect((await run('/undo', app)).all).toBe('Nothing to undo.');
      expect((await run('/redo', app)).all).toBe('Nothing to redo.');
    } finally {
      await h.cleanup();
    }
  });
});

describe('/checkout, /branchto and /restore', () => {
  test("are refused while another agent's turn is alive, and run through the framework, in its operator log, once it has ended", async () => {
    const h = await bootPresentedHost({ agents: ['clerk', 'mira'], prefix: 'cmd-branch-' });
    try {
      await h.turn('clerk');
      await h.turn('clerk');
      const clerk = h.framework.getAgent('clerk')!.getContextManager();
      const first = h.rowWith('clerk', 'clerk reply 1')!;
      const store = h.framework.getStore();
      const branch = store.currentBranch().name;
      const app = { framework: h.framework, agentName: 'clerk', branchState: createBranchState() };
      handleCommand('/checkpoint cp1', app as never);
      await h.turn('clerk');

      h.adapter.script('mira', { wait: 'm' }, { text: 'mira done' });
      h.framework.nudgeAgent('mira', 'test');
      await until(() => h.gates.entered.has('m'), "mira's tool call");
      for (const command of [`/checkout ${branch}`, `/branchto ${first.id}`, '/restore cp1']) {
        const { all, follow } = await run(command, app);
        expect(all, command).toContain('every agent sharing the store must be idle');
        expect(follow?.branchChanged, command).toBeFalsy();
      }
      expect(store.currentBranch().name).toBe(branch);

      h.gates.release('m');
      await h.settled('mira');
      const branchto = await run(`/branchto ${first.id}`, app);
      expect(branchto.follow!.branchChanged).toBe(true);
      const rolled = store.currentBranch().name;
      expect(rolled).toStartWith(`rollback-at-${first.id}-`);
      expect(clerk.getAllMessages().at(-1)!.id).toBe(first.id);

      await run(`/checkout ${branch}`, app);
      expect(store.currentBranch().name).toBe(branch);
      const restore = await run('/restore cp1', app);
      expect(restore.follow!.branchChanged).toBe(true);
      expect(store.currentBranch().name).toStartWith('restore-cp1-');
      expect(text(handleCommand('/restore cp1', app as never))).toContain('Already at checkpoint');

      const rollbacks = h.framework.getOperatorLog().filter((e) => e.kind === 'rollback' && !e.error);
      expect(rollbacks.map((e) => [e.agent, e.requester?.via])).toEqual([['clerk', 'host-console'], ['clerk', 'host-console']]);
    } finally {
      await h.cleanup();
    }
  });
});
