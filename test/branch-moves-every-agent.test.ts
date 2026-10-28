import { describe, test, expect, afterEach, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, OperatorActionError } from '@animalabs/agent-framework';
import { AutobiographicalStrategy } from '@animalabs/context-manager';
import type { NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { handleCommand, createBranchState, resetBranchState } from '../src/commands.js';

// Main's #264 tests, read onto this branch's commands (#291, HOST-1): /undo
// and /redo are the framework's undo and redo on the agent's window, which
// move no branch and are allowed while another agent's turn is alive
// (decision 4), and /checkout, /restore and /branchto its switchBranch and
// rollbackToMessage. The host's guard checks the agent the command acts for;
// a branch move is refused for any other agent by the framework, which names
// it and writes the refusal to the operator log. What #264 pins that still
// applies is pinned here: every agent compiles after each command; a refused
// move leaves the branch, the branches and the checkpoints as they were and
// says this command moved nothing; a switch that landed before its `_config`
// refresh failed is answered as the move it was; a /restore that lands moves
// its checkpoint unless it was saved again meanwhile. The host keeps no undo
// or redo stacks and makes no branch for a move, so #264's cases for those
// (a branch made for a refused move, a /redo whose branch is gone) become
// the framework's: a branch move drops the undo /redo would put back.

const text = (t: string) => [{ type: 'text' as const, text: t }];
const budget = { maxTokens: 100_000, reserveForResponse: 1_000 };
const lines = (r: { lines: Array<{ text: string }> }) => r.lines.map((l) => l.text).join('\n');

function reply(t: string): NormalizedResponse {
  return {
    content: text(t),
    stopReason: 'end_turn',
    rawAssistantText: t,
    toolCalls: [],
    toolResults: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    details: { raw: {}, stop: { reason: 'end_turn', wasTruncated: false }, model: { requested: 'test-model', actual: 'test-model' } },
  } as unknown as NormalizedResponse;
}

function provider() {
  let held: { system: string; released: Promise<void>; started: () => void } | undefined;
  const stream = (response: NormalizedResponse, wait?: Promise<void>): YieldingStream => {
    let cancelled = false;
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
        if (wait) await wait;
        if (cancelled) { yield { type: 'aborted', reason: 'user' } as StreamEvent; return; }
        const t = response.rawAssistantText;
        yield { type: 'block', event: { event: 'block_start', index: 0, block: { type: 'text' } } } as StreamEvent;
        yield { type: 'tokens', content: t, meta: { type: 'text', visible: true, blockIndex: 0 } } as StreamEvent;
        yield { type: 'block', event: { event: 'block_complete', index: 0, block: { type: 'text', content: t } } } as StreamEvent;
        yield { type: 'usage', usage: response.usage } as StreamEvent;
        yield { type: 'complete', response } as StreamEvent;
      },
      provideToolResults() { throw new Error('Not waiting for tools'); },
      cancel() { cancelled = true; },
      isWaitingForTools: false,
      pendingToolCallIds: [],
    } as unknown as YieldingStream;
  };
  const membrane = {
    async complete(): Promise<NormalizedResponse> { return reply('done'); },
    async stream(): Promise<NormalizedResponse> { return reply('done'); },
    streamYielding(request: NormalizedRequest): YieldingStream {
      if (held && JSON.stringify(request.system ?? '').includes(held.system)) {
        const { released, started } = held;
        held = undefined;
        started();
        return stream(reply('answers late'), released);
      }
      return stream(reply('answers'));
    },
  };
  const holdFor = (system: string) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const streaming = new Promise<void>((resolve) => { started = resolve; });
    held = { system, released, started };
    return { streaming, release };
  };
  return { membrane, holdFor };
}

// A real framework's turns and stop run past bun's 5 s default on a loaded
// host, as commands-branch-framework's do.
setDefaultTimeout(30_000);

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

async function twoAgents() {
  const dir = mkdtempSync(join(tmpdir(), 'branch-moves-'));
  const { membrane, holdFor } = provider();
  const strategy = () => new AutobiographicalStrategy({
    adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 30_000, kvStableReachTokens: 8_000,
  });
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane as never,
    agents: [
      { name: 'a', model: 'test-model', systemPrompt: 'You are a.', strategy: strategy() },
      { name: 'b', model: 'test-model', systemPrompt: 'You are b.', strategy: strategy() },
    ],
    modules: [],
  });
  cleanup = async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); };
  const cmOf = (name: string) => framework.getAgent(name)!.getContextManager();
  const turn = async (name: string) => { framework.nudgeAgent(name, 'test'); await framework.runUntilIdle(); };
  const firstId = String(cmOf('a').addMessage('user', text('hello a')));
  cmOf('b').addMessage('user', text('hello b'));
  await turn('a');
  const app = { framework, branchState: createBranchState(), agentName: 'a', userMessageCount: 0 } as never;
  const run = async (command: string) => {
    const result = handleCommand(command, app);
    return { now: lines(result), later: result.asyncWork ? lines(await result.asyncWork) : '' };
  };
  const compiles = async (name: string) => { await cmOf(name).compile(budget, undefined, { dryRun: true }); };
  const branch = () => framework.getStore().currentBranch().name;
  return { framework, app: app as { branchState: ReturnType<typeof createBranchState> }, firstId, turn, run, compiles, branch, holdFor };
}

const moves: Array<[string, (w: Awaited<ReturnType<typeof twoAgents>>) => Promise<string>]> = [
  ['/restore', async (w) => { await w.run('/checkpoint cp'); await w.turn('a'); return '/restore cp'; }],
  ['/checkout', async (w) => {
    const store = w.framework.getStore();
    store.createBranchAt('side', store.currentBranch().name, store.currentSequence());
    return '/checkout side';
  }],
  ['/branchto', async (w) => `/branchto ${w.firstId}`],
];

const windowOps: Array<[string, (w: Awaited<ReturnType<typeof twoAgents>>) => Promise<string>]> = [
  ['/undo', async () => '/undo'],
  ['/redo', async (w) => { await w.run('/undo'); return '/redo'; }],
];

describe('a branch move re-initializes every agent sharing the store', () => {
  for (const [name, setup] of moves) {
    test(`${name}: both agents compile afterwards`, async () => {
      const w = await twoAgents();
      const command = await setup(w);
      const before = w.branch();
      await w.run(command);
      expect(w.branch()).not.toBe(before);
      await w.compiles('a');
      await w.compiles('b');
    });
  }
  for (const [name, setup] of windowOps) {
    test(`${name}: moves no branch, and both agents compile afterwards`, async () => {
      const w = await twoAgents();
      const command = await setup(w);
      const before = w.branch();
      const said = await w.run(command);
      expect(said.now).toContain(name === '/undo' ? "Undone: a's last turn left its window" : "Redone: a's undone turn is back in its window");
      expect(w.branch()).toBe(before);
      await w.compiles('a');
      await w.compiles('b');
    });
  }

  test('a branch move drops the undo /redo would put back, so /redo has nothing to redo', async () => {
    const w = await twoAgents();
    const store = w.framework.getStore();
    store.createBranchAt('side', store.currentBranch().name, store.currentSequence());
    expect((await w.run('/undo')).now).toContain('Undone');
    expect((await w.run('/checkout side')).later).toContain('Switched to branch side.');
    expect((await w.run('/redo')).now).toBe('Nothing to redo.');
  });
});

describe('while another agent is mid-turn', () => {
  for (const [name, setup] of moves) {
    test(`${name}: refused naming b, with the branch, branches and checkpoints as they were`, async () => {
      const w = await twoAgents();
      const command = await setup(w);
      const held = w.holdFor('You are b.');
      w.framework.nudgeAgent('b', 'test');
      const turn = w.framework.runUntilIdle();
      await held.streaming;
      const store = w.framework.getStore();
      const before = {
        branch: w.branch(),
        branches: store.listBranches().map((b) => b.name).sort(),
        checkpoints: [...w.app.branchState.checkpoints.entries()],
      };
      try {
        const said = await w.run(command);
        expect(said.later).toContain('b is streaming');
        expect(said.later).toContain('This command moved nothing. Try again once what it names has finished.');
        expect(said.later).not.toContain('stop it');
        expect({
          branch: w.branch(),
          branches: store.listBranches().map((b) => b.name).sort(),
          checkpoints: [...w.app.branchState.checkpoints.entries()],
        }).toEqual(before);
      } finally {
        held.release();
        await turn;
      }
    });
  }
  for (const [name, setup] of windowOps) {
    test(`${name}: acts on a's window, moving no branch`, async () => {
      const w = await twoAgents();
      const command = await setup(w);
      const held = w.holdFor('You are b.');
      w.framework.nudgeAgent('b', 'test');
      const turn = w.framework.runUntilIdle();
      await held.streaming;
      const store = w.framework.getStore();
      const before = { branch: w.branch(), branches: store.listBranches().map((b) => b.name).sort() };
      try {
        const said = await w.run(command);
        expect(said.now).not.toContain('refused');
        expect(said.now).toContain(name === '/undo' ? 'Undone' : 'Redone');
        expect({ branch: w.branch(), branches: store.listBranches().map((b) => b.name).sort() }).toEqual(before);
      } finally {
        held.release();
        await turn;
      }
    });
  }
});

/**
 * A stub framework whose switchBranch and rollbackToMessage answer through
 * `answer`, which may move the store (`move`) or not, and resolve or reject.
 * A rollback makes its branch inside `move`, as agent-framework makes it only
 * once it has reserved the store.
 */
function stubWorld(answer: (name: string, move: () => void) => Promise<void>) {
  const branches = new Map<string, Array<{ id: string; participant: string; content: unknown[] }>>([
    ['main', [{ id: 'u1', participant: 'user', content: [] }, { id: 'a1', participant: 'agent', content: [] }]],
  ]);
  let current = 'main';
  const listBranches = () => [...branches.keys()].map((name) => ({ id: name, name, head: branches.get(name)!.length }));
  const cm = {
    currentBranch: () => ({ id: current, name: current, head: branches.get(current)!.length }),
    listBranches,
    queryMessages: () => ({ messages: branches.get(current)! }),
  };
  const agent = { name: 'a', state: { status: 'idle' }, getContextManager: () => cm };
  const app = {
    framework: {
      getAgent: (name: string) => (name === 'a' ? agent : undefined),
      getAllAgents: () => [agent],
      getAllModules: () => [],
      getStore: () => ({ currentBranch: () => cm.currentBranch(), listBranches }),
      switchBranch: (name: string) => answer(name, () => {
        if (!branches.has(name)) throw new Error(`No such branch: ${name}`);
        current = name;
      }),
      rollbackToMessage: async (_agent: string, opts: { messageId: string; branchName: string }) => {
        await answer(opts.branchName, () => {
          const rows = branches.get(current)!;
          branches.set(opts.branchName, rows.slice(0, rows.findIndex((m) => m.id === opts.messageId) + 1));
          current = opts.branchName;
        });
        return { targetBranch: opts.branchName, tailMessageId: opts.messageId, messagesRemoved: 1 };
      },
    },
    branchState: createBranchState(),
    agentName: 'a',
    userMessageCount: 0,
  } as never as { branchState: ReturnType<typeof createBranchState> };
  const run = async (command: string) => {
    const result = handleCommand(command, app as never);
    const later = result.asyncWork ? await result.asyncWork : undefined;
    return { said: lines(result) + '\n' + (later ? lines(later) : ''), branchChanged: later?.branchChanged ?? false };
  };
  const records = () => ({
    branches: listBranches().map((b) => b.name).sort(),
    checkpoints: [...app.branchState.checkpoints.entries()],
  });
  const add = (id: string, participant = 'user') => { branches.get(current)!.push({ id, participant, content: [] }); };
  const addBranch = (name: string) => { branches.set(name, [...branches.get(current)!]); };
  const moveTo = (name: string) => { current = name; };
  return { app, run, records, add, addBranch, moveTo, branch: () => current };
}

const busy = () => new OperatorActionError('agent-busy', 'Cannot switch branch while b is idle+turn-alive — every agent sharing the store must be idle (quiesce the host first)');

describe('the framework\'s answer to a move decides what the session records', () => {
  const refusals: Array<[string, (w: ReturnType<typeof stubWorld>) => Promise<void>]> = [
    ['/restore cp', async (w) => { await w.run('/checkpoint cp'); w.add('u2'); }],
    ['/restore head', async (w) => { w.app.branchState.checkpoints.set('head', { branchName: 'main' }); }],
    ['/checkout side', async (w) => { w.addBranch('side'); }],
    ['/branchto u1', async () => {}],
  ];
  for (const [command, setup] of refusals) {
    test(`${command}: a refusal leaves the branch, branches and checkpoints as they were, and says to try again`, async () => {
      let refuse = false;
      const w = stubWorld(async (_name, move) => { if (refuse) throw busy(); move(); });
      await setup(w);
      refuse = true;
      const before = { branch: w.branch(), ...w.records() };
      const outcome = await w.run(command);
      expect(outcome.said).toContain('This command moved nothing. Try again once what it names has finished.');
      expect(outcome.said).not.toContain('restored to the branch head');
      expect(outcome.branchChanged).toBe(false);
      expect({ branch: w.branch(), ...w.records() }).toEqual(before);
    });
  }

  test('a refusal that isn\'t the store being busy still says this command moved nothing', async () => {
    const w = stubWorld(async () => { throw new Error('switch branch refused: the framework is stopping'); });
    const outcome = await w.run('/checkout main');
    expect(outcome.said).toContain('Checkout failed: switch branch refused: the framework is stopping');
    expect(outcome.said).toContain('This command moved nothing.');
    expect(outcome.said).not.toContain('Try again once');
    expect(outcome.branchChanged).toBe(false);
    const rolled = await w.run('/branchto u1');
    expect(rolled.said).toContain('branchto failed: switch branch refused: the framework is stopping');
    expect(rolled.said).toContain('This command moved nothing.');
  });

  test('a rollback that failed once its branch was made says what the framework did, and not that nothing moved', async () => {
    const w = stubWorld(async () => {
      throw new OperatorActionError('failed', 'Rollback failed; active branch restored to main: EIO');
    });
    const outcome = await w.run('/branchto u1');
    expect(outcome.said).toContain('branchto failed: Rollback failed; active branch restored to main: EIO');
    expect(outcome.said).not.toContain('moved nothing');
    expect(outcome.branchChanged).toBe(false);
  });

  test('a switch that landed before its _config refresh failed is answered as the move it was', async () => {
    let failAfterMove = true;
    const w = stubWorld(async (_name, move) => {
      move();
      if (failAfterMove) throw new Error('EIO: the mount could not be written');
    });
    w.addBranch('side');
    const outcome = await w.run('/checkout side');
    expect(outcome.said).toContain('Switched to branch side. Refreshing the _config mount from it failed: EIO: the mount could not be written');
    expect(outcome.said).toContain("The gate's files may still be the previous branch's. /checkout side runs the refresh again.");
    expect(outcome.said).not.toContain('moved nothing');
    expect(outcome.branchChanged).toBe(true);
    expect(w.branch()).toBe('side');

    w.app.branchState.checkpoints.set('head', { branchName: 'main' });
    const restored = await w.run('/restore head');
    expect(restored.said).toContain('Restored to checkpoint "head" (branch: main). Refreshing the _config mount from it failed');
    expect(restored.branchChanged).toBe(true);

    failAfterMove = false;
    const again = await w.run('/checkout main');
    expect(again.said).toContain('Switched to branch main.');
    expect(again.branchChanged).toBe(true);
  });

  test('a /restore that lands moves its checkpoint to the new branch; one saved again or cleared meanwhile is kept as it is', async () => {
    let release!: () => void;
    let hold = false;
    const w = stubWorld(async (_name, move) => {
      if (hold) await new Promise<void>((resolve) => { release = resolve; });
      move();
    });
    await w.run('/checkpoint cp');
    w.add('u2');
    await w.run('/restore cp');
    const restored = w.app.branchState.checkpoints.get('cp')!;
    expect(restored.branchName).toBe(w.branch());
    expect(restored.branchName.startsWith('restore-cp-')).toBe(true);

    w.add('u3');
    hold = true;
    let pending = handleCommand('/restore cp', w.app as never).asyncWork!;
    await w.run('/checkpoint cp');
    const saved = w.app.branchState.checkpoints.get('cp');
    release();
    expect((await pending).branchChanged).toBe(true);
    expect(w.app.branchState.checkpoints.get('cp')).toBe(saved);

    w.add('u4');
    pending = handleCommand('/restore cp', w.app as never).asyncWork!;
    resetBranchState(w.app.branchState);
    release();
    expect((await pending).branchChanged).toBe(true);
    expect(w.app.branchState.checkpoints.has('cp')).toBe(false);
  });

  test('a refusal is never taken for a move, though a switch already holding the store has moved it to the same branch', async () => {
    let holder: ((name: string) => void) | undefined;
    const w = stubWorld(async (name, move) => {
      if (!holder) return move();
      holder(name);
      throw busy();
    });
    w.addBranch('side');
    holder = (name) => w.moveTo(name);
    const outcome = await w.run('/checkout side');
    expect(w.branch()).toBe('side');
    expect(outcome.said).toContain('This command moved nothing. Try again once what it names has finished.');
    expect(outcome.branchChanged).toBe(false);
  });
});

describe('a refusal offers stopping only for the turn an operator can stop', () => {
  const said = (command: string, statuses: Record<string, string>, framework: Record<string, unknown> = {}) => {
    const agents = Object.entries(statuses).map(([name, status]) => ({ name, state: { status }, getContextManager: () => null }));
    const app = {
      agentName: 'a',
      framework: {
        getAgent: (name: string) => agents.find((agent) => agent.name === name),
        getAllAgents: () => agents,
        ...framework,
      },
    };
    return handleCommand(command, app as never).lines.map((line) => line.text).join('\n');
  };

  test('the main agent mid-turn: wait for it, or stop it', () => {
    for (const command of ['/undo', '/redo', '/checkout side', '/restore cp', '/branchto m1', '/newtopic']) {
      const refusal = said(command, { a: 'streaming', b: 'idle' });
      expect(refusal, command).toContain(`${command.split(' ')[0]} refused: a turn is in flight (a: streaming).`);
      expect(refusal, command).toContain('Wait for the turn to end, or stop it, then retry.');
    }
  });

  test('another agent alone mid-turn: /undo, /redo and /newtopic act for the main agent, and a branch move is left to the framework', () => {
    const framework = {
      undoLastTurn: () => ({ undone: false }),
      redo: () => ({ redone: false }),
    };
    expect(said('/undo', { a: 'idle', b: 'streaming' }, framework)).toBe('Nothing to undo.');
    expect(said('/redo', { a: 'idle', b: 'streaming' }, framework)).toBe('Nothing to redo.');
    const newtopic = said('/newtopic', { a: 'idle', b: 'streaming' });
    expect(newtopic).not.toContain('refused');
    expect(newtopic).toContain('No context manager.');
    // No refusal from the host: the stub agents have no context manager, so
    // /checkout gets as far as saying so; the framework's refusal of b is
    // the stub world's case above.
    expect(said('/checkout side', { a: 'idle', b: 'streaming' })).toBe('No agent context manager.');
  });

  test('the main agent and another mid-turn: the host refuses for the main agent\'s turn, which can be stopped', () => {
    const refusal = said('/checkout side', { a: 'streaming', b: 'inferring' });
    expect(refusal).toContain('(a: streaming)');
    expect(refusal).toContain('Wait for the turn to end, or stop it, then retry.');
  });
});
