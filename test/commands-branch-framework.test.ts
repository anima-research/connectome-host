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
 *   has a turn alive, and each is in the operator log;
 * - after each, every resident's context follows the store's branch, so an
 *   autobiographical resident's next turn is served (J-AF1, J-H9: before
 *   agent-framework re-initialized every live context at a branch move, a
 *   resident whose context didn't make the move failed every turn until a
 *   restart);
 * - a rollback on a presented window says which rows after its target it
 *   kept (J-H6): rows that wait out of the window until the agent's next
 *   turn starts, and rows one write showed with the target.
 *
 * Each runs a real AgentFramework (test/presented-host.ts).
 */
import { describe, test, expect, setDefaultTimeout } from 'bun:test';
import { withAudience } from '@animalabs/agent-framework';
import { AutobiographicalStrategy } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { createBranchState, handleCommand, type CommandResult } from '../src/commands.js';
import { bootPresentedHost, until, type PresentedHost } from './presented-host.js';

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
      // agent-framework writes the switch to the operator log as a checkout
      // (J-H7), with the host's requester and the command, and a refused one
      // with its error.
      const checkouts = h.framework.getOperatorLog().filter((e) => e.kind === 'checkout');
      expect(checkouts.map((e) => [e.requester?.via, e.note, e.result?.targetBranch, !!e.error])).toEqual([
        ['host-console', `/checkout ${branch}`, undefined, true],
        ['host-console', `/checkout ${branch}`, branch, false],
      ]);
    } finally {
      await h.cleanup();
    }
  });
});

// A checkpoint saves the record's position, its last row, which an /undo
// leaves in the record (#485 bot review findings 41 and 42): with no row
// stored after it, a /restore to it is at it already, and moves nothing.
describe('/checkpoint and /restore with the last row undone', () => {
  test("say the checkpoint's last row is out of the agent's window as undone, and what puts it back", async () => {
    const h = await bootPresentedHost({ agents: ['clerk', 'mira'], prefix: 'cmd-checkpoint-undone-' });
    try {
      await h.turn('clerk');
      await h.turn('clerk');
      const clerk = h.framework.getAgent('clerk')!.getContextManager();
      const store = h.framework.getStore();
      const app = { framework: h.framework, agentName: 'clerk', branchState: createBranchState() };
      const saved = (name: string) => `Checkpoint "${name}" saved at branch ${store.currentBranch().name} (head: ${store.currentBranch().head}).`;

      // Taken with its last row in the window: nothing more to say.
      const p = await run('/checkpoint p', app);
      expect(p.all).toBe(saved('p'));
      const last = clerk.getAllMessages().at(-1)!;

      await run('/undo', app);
      expect(clerk.windowStatusOf(last.id)).toBe('undone');
      expect((await run('/restore p', app)).all).toBe(
        `Already at checkpoint "p". Its last row is out of clerk's window as undone: /redo puts back what clerk's latest undo took out, this row if that undo took it.`,
      );
      const q = await run('/checkpoint q', app);
      expect(q.all).toBe([
        saved('q'),
        `  Its last row [${last.id}] is out of clerk's window as undone: /redo puts back what clerk's latest undo took out, ` +
          'this row if that undo took it, and a /restore to "q" puts it back once rows are stored after it.',
      ].join('\n'));

      // Back in the window: at the checkpoint, nothing more to say.
      await run('/redo', app);
      expect((await run('/restore p', app)).all).toBe('Already at checkpoint "p".');

      // Undone again, and rows stored after it: a /restore to it rolls the
      // record back to it, and it is in the window again.
      await run('/undo', app);
      await h.turn('mira');
      const restored = await run('/restore q', app);
      expect(restored.follow!.branchChanged).toBe(true);
      expect(clerk.getAllMessages().at(-1)!.id).toBe(last.id);
      expect(clerk.windowStatusOf(last.id)).toBe('in');
    } finally {
      await h.cleanup();
    }
  });

  test('name no /redo when none is kept, as for a row a shed took out', async () => {
    const h = await bootPresentedHost({ agents: ['clerk'], prefix: 'cmd-checkpoint-shed-' });
    try {
      await h.turn('clerk');
      const clerk = h.framework.getAgent('clerk')!.getContextManager();
      const last = clerk.getAllMessages().at(-1)!;
      // A shed's retraction: undone, with no redo kept.
      clerk.retractRows([last.id], { undone: true });
      expect(h.framework.getUndoRedoState('clerk').canRedo).toBe(false);
      const app = { framework: h.framework, agentName: 'clerk', branchState: createBranchState() };
      const s = await run('/checkpoint s', app);
      expect(s.result.lines.map((l) => l.text).slice(1)).toEqual([
        `  Its last row [${last.id}] is out of clerk's window as undone: a /restore to "s" puts it back once rows are stored after it.`,
      ]);
      expect((await run('/restore s', app)).all).toBe(`Already at checkpoint "s". Its last row is out of clerk's window as undone.`);
    } finally {
      await h.cleanup();
    }
  });
});

// A redo puts back the latest undo's rows, which needn't hold the
// checkpoint's last row (#485 bot review 2, finding 16): a shed took it out,
// and an /undo after it took out the turn's other rows.
describe('/checkpoint and /restore with the last row shed, then an /undo', () => {
  test("don't promise that /redo puts that row back, which it doesn't", async () => {
    const h = await bootPresentedHost({ agents: ['clerk'], prefix: 'cmd-checkpoint-shed-undo-' });
    try {
      await h.turn('clerk');
      await h.turn('clerk');
      const clerk = h.framework.getAgent('clerk')!.getContextManager();
      const last = clerk.getAllMessages().at(-1)!;
      clerk.retractRows([last.id], { undone: true });
      const app = { framework: h.framework, agentName: 'clerk', branchState: createBranchState() };
      await run('/undo', app);
      expect(h.framework.getUndoRedoState('clerk').canRedo).toBe(true);
      const said = (await run('/checkpoint s', app)).result.lines.map((l) => l.text).slice(1);
      expect(said).toEqual([
        `  Its last row [${last.id}] is out of clerk's window as undone: /redo puts back what clerk's latest undo took out, ` +
          'this row if that undo took it, and a /restore to "s" puts it back once rows are stored after it.',
      ]);
      expect((await run('/restore s', app)).all).toBe(
        `Already at checkpoint "s". Its last row is out of clerk's window as undone: /redo puts back what clerk's latest undo took out, this row if that undo took it.`,
      );
      // What the redo puts back is the undo's, and the row stays out.
      await run('/redo', app);
      expect(clerk.windowStatusOf(last.id)).toBe('undone');
    } finally {
      await h.cleanup();
    }
  });
});

/** Nudge `agent` and wait for its request or its failure; the inference
 *  failures traced meanwhile, and whether a request was made. */
async function served(h: PresentedHost, agent: string): Promise<{ requested: boolean; failures: string[] }> {
  const calls = h.adapter.callsFor(agent);
  const failed = () => h.traces.filter((t) => t.type === 'inference:failed' && t.agentName === agent);
  const failuresBefore = failed().length;
  const nudged = h.framework.nudgeAgent(agent, 'test');
  if (!nudged.ok) throw new Error(nudged.error);
  await until(() => h.adapter.callsFor(agent) > calls || failed().length > failuresBefore, `${agent}'s request or failure`);
  await h.settled(agent);
  return {
    requested: h.adapter.callsFor(agent) > calls,
    failures: failed().slice(failuresBefore).map((t) => String((t as { error?: unknown }).error)),
  };
}

describe('after /checkout, /restore and /branchto', () => {
  // The host's default strategy is the autobiographical one, which refuses
  // to compile on a branch generation it wasn't initialized on.
  test('every autobiographical resident is served its next turn, whichever agent the command was for', async () => {
    const h = await bootPresentedHost({
      agents: ['clerk', 'mira'],
      agentConfig: () => ({ strategy: new AutobiographicalStrategy({ headWindowTokens: 4000, recentWindowTokens: 4000, autoTickOnNewMessage: false }) }),
      prefix: 'cmd-branch-autobio-',
    });
    try {
      await h.turn('clerk');
      await h.turn('mira');
      await h.turn('clerk');
      const clerk = h.framework.getAgent('clerk')!.getContextManager();
      const first = h.rowWith('clerk', 'clerk reply 1')!;
      const store = h.framework.getStore();
      const main = store.currentBranch().name;
      const side = clerk.branchAt(first.id, 'side');
      const app = { framework: h.framework, agentName: 'clerk', branchState: createBranchState() };
      // A checkpoint with no message: /restore takes the branch's head, through switchBranch.
      app.branchState.checkpoints.set('main-head', { branchName: main });

      for (const command of [`/checkout ${side}`, '/restore main-head', `/branchto ${first.id}`]) {
        const { follow } = await run(command, app);
        expect(follow?.branchChanged, `${command}: ${follow?.lines.map((l) => l.text).join(' | ')}`).toBe(true);
        for (const agent of ['clerk', 'mira']) {
          expect(await served(h, agent), `${agent} after ${command}`).toEqual({ requested: true, failures: [] });
        }
      }
      expect(store.currentBranch().name).toStartWith(`rollback-at-${first.id}-`);
      // The operator log records a /restore to a branch's head as a checkout.
      const restored = h.framework.getOperatorLog().filter((e) => e.note === '/restore main-head');
      expect(restored.map((e) => [e.kind, e.requester?.via, e.error])).toEqual([['checkout', 'host-console', undefined]]);
    } finally {
      await h.cleanup();
    }
  });
});

describe('/branchto on a presented window', () => {
  /** A Discord message stored past the framework, in no window until presented, as a test's stand-in for an arrival. */
  const arrival = (h: PresentedHost, text: string): string =>
    h.framework.getAgent('clerk')!.getContextManager().addMessage('someone', [{ type: 'text', text } as ContentBlock], {
      serverId: 'discord', channelId: 'discord:g1:c1', messageId: `d-${text}`,
    });

  test('says a row one write showed with the target stays in the window after it, and how to take it out', async () => {
    const h = await bootPresentedHost({ agents: ['clerk'], prefix: 'cmd-branchto-batch-' });
    try {
      const cm = h.framework.getAgent('clerk')!.getContextManager();
      // Two messages that arrived while clerk was busy, shown together, then a third on its own.
      const a = arrival(h, 'A');
      const b = arrival(h, 'B');
      cm.presentRows([a, b]);
      cm.presentRows([arrival(h, 'R')]);
      const app = { framework: h.framework, agentName: 'clerk', branchState: createBranchState() };

      const { follow } = await run(`/branchto ${a}`, app);
      const said = follow!.lines.map((l) => l.text);
      expect(said[0]).toContain(`1 message after [${a}] is dropped on this branch; old branch preserved.`);
      expect(said[0]).not.toContain('Everything after');
      expect(said.slice(1)).toEqual([
        `  1 row after [${a}] stays in clerk's window: one write showed it with [${a}], and a branch cut can't separate them. ` +
          "The Web UI's suppress, or a hide by Discord message id, takes it out.",
      ]);
      expect(cm.getPresentedMessages().map((m) => m.id)).toEqual([a, b]);
    } finally {
      await h.cleanup();
    }
  });

  // The cut at the write that presented the target keeps a co-resident's
  // row stored before it, which the command agent's window never held
  // (#485 bot review 2, finding 15).
  test("doesn't say everything after the target was dropped when a co-resident's row stored before it was shown stays", async () => {
    const h = await bootPresentedHost({ agents: ['clerk', 'mira'], prefix: 'cmd-branchto-co-resident-' });
    try {
      const cm = h.framework.getAgent('clerk')!.getContextManager();
      const t = arrival(h, 'T');
      const m = cm.addMessage('someone', [{ type: 'text', text: 'M' } as ContentBlock], withAudience(undefined, ['mira']));
      cm.presentRows([t]);
      cm.presentRows([arrival(h, 'Z')]);
      const app = { framework: h.framework, agentName: 'clerk', branchState: createBranchState() };

      const { follow } = await run(`/branchto ${t}`, app);
      const said = follow!.lines.map((l) => l.text);
      expect(said[0]).toContain(`1 message after [${t}] is dropped on this branch; old branch preserved.`);
      expect(said[0]).not.toContain('Everything after');
      expect(said).toHaveLength(1);
      expect(cm.getAllMessages().map((r) => r.id)).toEqual([t, m]);
    } finally {
      await h.cleanup();
    }
  });

  test('says everything after the target was dropped when the cut took every row stored after it', async () => {
    const h = await bootPresentedHost({ agents: ['clerk', 'mira'], prefix: 'cmd-branchto-everything-' });
    try {
      const cm = h.framework.getAgent('clerk')!.getContextManager();
      const t = arrival(h, 'T');
      cm.presentRows([t]);
      cm.addMessage('someone', [{ type: 'text', text: 'M' } as ContentBlock], withAudience(undefined, ['mira']));
      cm.presentRows([arrival(h, 'Z')]);
      const app = { framework: h.framework, agentName: 'clerk', branchState: createBranchState() };

      const { follow } = await run(`/branchto ${t}`, app);
      expect(follow!.lines.map((l) => l.text)).toEqual([
        `Branched at [${t}] -> "${h.framework.getStore().currentBranch().name}" and switched. Everything after [${t}] is dropped on this branch; old branch preserved.`,
      ]);
      expect(cm.getAllMessages().map((r) => r.id)).toEqual([t]);
    } finally {
      await h.cleanup();
    }
  });

  for (const command of ['/branchto', '/restore']) {
    test(`${command} says a row stored before the target was shown, and shown after it, stays in the record and enters the window at the next turn`, async () => {
      const h = await bootPresentedHost({ agents: ['clerk'], prefix: `cmd-${command.slice(1)}-returned-` });
      try {
        const cm = h.framework.getAgent('clerk')!.getContextManager();
        const t = arrival(h, 'T');
        const r = arrival(h, 'R'); // stored before T was shown, shown after it
        cm.presentRows([t]);
        cm.presentRows([r]);
        cm.presentRows([arrival(h, 'Z')]);
        const app = { framework: h.framework, agentName: 'clerk', branchState: createBranchState() };
        app.branchState.checkpoints.set('at-t', { branchName: h.framework.getStore().currentBranch().name, messageId: t });

        const { follow } = await run(command === '/branchto' ? `/branchto ${t}` : '/restore at-t', app);
        const said = follow!.lines.map((l) => l.text);
        expect(said[0]).toContain(command === '/branchto'
          ? `1 message after [${t}] is dropped on this branch; old branch preserved.`
          : 'Restored to checkpoint "at-t" (branch: restore-at-t-');
        expect(said.slice(1)).toEqual([
          `  1 row after [${t}] stays in the record: stored before clerk was shown [${t}], it is out of its window until its next turn starts, or the host restarts before then, and enters it then.`,
        ]);
        expect(cm.windowStatusOf(r)).toBe('out');
        // The Web UI's operator log says so too (Surgery.tsx reads these).
        const entry = h.framework.getOperatorLog().find((e) => e.kind === 'rollback' && !e.error)!;
        expect([entry.result?.returnedToArrivals, entry.result?.keptInWindowAfterTarget]).toEqual([1, 0]);

        // clerk's next turn shows it.
        await h.turn('clerk');
        expect(cm.windowStatusOf(r)).toBe('in');
      } finally {
        await h.cleanup();
      }
    });
  }
});
