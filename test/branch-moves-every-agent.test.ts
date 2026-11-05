import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, OperatorActionError } from '@animalabs/agent-framework';
import { AutobiographicalStrategy } from '@animalabs/context-manager';
import type { NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { handleCommand, createBranchState } from '../src/commands.js';

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
  ['/undo', async () => '/undo'],
  ['/redo', async (w) => { await w.run('/undo'); return '/redo'; }],
  ['/restore', async (w) => { await w.run('/checkpoint cp'); await w.turn('a'); return '/restore cp'; }],
  ['/checkout', async (w) => {
    const store = w.framework.getStore();
    store.createBranchAt('side', store.currentBranch().name, store.currentSequence());
    return '/checkout side';
  }],
  ['/branchto', async (w) => `/branchto ${w.firstId}`],
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
});

describe('while another agent is mid-turn, a branch move moves nothing', () => {
  for (const [name, setup] of moves) {
    test(`${name}: refused naming b, with the branch, branches, stacks and checkpoints as they were`, async () => {
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
        undo: [...w.app.branchState.undoStack],
        redo: [...w.app.branchState.redoStack],
        checkpoints: [...w.app.branchState.checkpoints.entries()],
      };
      try {
        const said = await w.run(command);
        expect(said.now).toContain('refused');
        expect(said.now).toContain('b: streaming');
        expect(said.now).toContain('Wait for the turn to end, then retry.');
        expect(said.now).not.toContain('stop it');
        expect({
          branch: w.branch(),
          branches: store.listBranches().map((b) => b.name).sort(),
          undo: [...w.app.branchState.undoStack],
          redo: [...w.app.branchState.redoStack],
          checkpoints: [...w.app.branchState.checkpoints.entries()],
        }).toEqual(before);
      } finally {
        held.release();
        await turn;
      }
    });
  }
});

function stubWorld(answer: (name: string, move: () => void) => Promise<void>, options: { deleteFails?: boolean } = {}) {
  const branches = new Map<string, Array<{ id: string; participant: string; content: unknown[] }>>([
    ['main', [{ id: 'u1', participant: 'user', content: [] }, { id: 'a1', participant: 'agent', content: [] }]],
  ]);
  let current = 'main';
  const listBranches = () => [...branches.keys()].map((name) => ({ id: name, name, head: branches.get(name)!.length }));
  const cm = {
    currentBranch: () => ({ id: current, name: current, head: branches.get(current)!.length }),
    listBranches,
    queryMessages: () => ({ messages: branches.get(current)! }),
    branchAt: (id: string, name: string) => {
      const rows = branches.get(current)!;
      branches.set(name, rows.slice(0, rows.findIndex((m) => m.id === id) + 1));
      return name;
    },
  };
  const app = {
    framework: {
      getAgent: () => undefined,
      getAllAgents: () => [{ name: 'a', state: { status: 'idle' }, getContextManager: () => cm }],
      getAllModules: () => [],
      getStore: () => ({
        currentBranch: () => cm.currentBranch(),
        listBranches,
        deleteBranch: (name: string) => {
          if (options.deleteFails) throw new Error('the branch is locked');
          branches.delete(name);
        },
      }),
      switchBranch: (name: string) => answer(name, () => {
        if (!branches.has(name)) throw new Error(`No such branch: ${name}`);
        current = name;
      }),
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
    undo: [...app.branchState.undoStack],
    redo: [...app.branchState.redoStack],
    checkpoints: [...app.branchState.checkpoints.entries()],
  });
  const add = (id: string, participant = 'user') => { branches.get(current)!.push({ id, participant, content: [] }); };
  const moveTo = (name: string) => { current = name; };
  return { app, run, records, add, moveTo, branch: () => current, deleteBranch: (name: string) => { branches.delete(name); } };
}

const busy = () => new OperatorActionError('agent-busy', 'Cannot switch branch while b is idle+turn-alive — every agent sharing the store must be idle (quiesce the host first)');

describe('the framework\'s answer to a move decides what the session records', () => {
  const refusals: Array<[string, (w: ReturnType<typeof stubWorld>) => Promise<void>]> = [
    ['/undo', async () => {}],
    ['/redo', async (w) => { await w.run('/undo'); }],
    ['/restore cp', async (w) => { await w.run('/checkpoint cp'); w.add('u2'); }],
    ['/checkout main', async (w) => { await w.run('/undo'); }],
    ['/branchto u1', async () => {}],
  ];
  for (const [command, setup] of refusals) {
    test(`${command}: a refusal leaves the branch, branches, stacks and checkpoints as they were, and says to try again`, async () => {
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
  });

  test('a move that landed before its follow-up failed is recorded, so /redo returns from it', async () => {
    let failAfterMove = true;
    const w = stubWorld(async (_name, move) => {
      move();
      if (failAfterMove) throw new Error('EIO: the mount could not be written');
    });
    const outcome = await w.run('/undo');
    expect(outcome.said).toContain('Undone. Switched to branch');
    expect(outcome.said).toContain('Refreshing the _config mount from it failed: EIO: the mount could not be written');
    expect(outcome.said).toContain('/checkout undo-');
    expect(outcome.branchChanged).toBe(true);
    expect(w.app.branchState.redoStack).toEqual([{ branchName: 'main' }]);
    failAfterMove = false;
    await w.run('/redo');
    expect(w.branch()).toBe('main');
    expect(w.app.branchState.redoStack).toEqual([]);
  });

  test('a /restore that lands moves its checkpoint to the new branch; one saved again meanwhile is kept', async () => {
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

    await w.run('/undo');
    hold = true;
    const pending = handleCommand('/restore cp', w.app as never).asyncWork!;
    await w.run('/checkpoint cp');
    const saved = w.app.branchState.checkpoints.get('cp');
    release();
    await pending;
    expect(w.app.branchState.checkpoints.get('cp')).toBe(saved);
  });

  test('a refusal is never taken for a move, though a switch already holding the store has moved it to the same branch', async () => {
    let holder: ((name: string) => void) | undefined;
    const w = stubWorld(async (name, move) => {
      if (!holder) return move();
      holder(name);
      throw busy();
    });
    await w.run('/undo');
    holder = (name) => w.moveTo(name);
    const outcome = await w.run('/redo');
    expect(w.branch()).toBe('main');
    expect(outcome.said).toContain('This command moved nothing. Try again once what it names has finished.');
    expect(outcome.branchChanged).toBe(false);
    expect(w.app.branchState.redoStack).toEqual([{ branchName: 'main' }]);
  });

  test('a branch made for a refused move that can\'t be removed is named as staying', async () => {
    const w = stubWorld(async () => { throw busy(); }, { deleteFails: true });
    const outcome = await w.run('/undo');
    const made = w.records().branches.find((name) => name.startsWith('undo-'));
    expect(made).toBeDefined();
    expect(outcome.said).toContain(`The branch "${made}" made for it stays: removing it failed (the branch is locked).`);
    expect(outcome.said).toContain('This command moved nothing. Try again once what it names has finished.');
    expect(w.branch()).toBe('main');
  });

  test('a /redo whose branch no longer exists drops that step and says so', async () => {
    const w = stubWorld(async (_name, move) => { move(); });
    await w.run('/undo');
    expect(w.app.branchState.redoStack).toEqual([{ branchName: 'main' }]);
    w.deleteBranch('main');
    const outcome = await w.run('/redo');
    expect(outcome.said).toContain('The branch this redo returns to, "main", no longer exists, so that step is dropped; nothing is left to redo.');
    expect(w.app.branchState.redoStack).toEqual([]);
  });

  test('a dropped /redo step says which branch the next /redo tries', async () => {
    const w = stubWorld(async (_name, move) => { move(); });
    await w.run('/undo');
    w.app.branchState.redoStack.push({ branchName: 'gone' });
    const outcome = await w.run('/redo');
    expect(outcome.said).toContain('The branch this redo returns to, "gone", no longer exists, so that step is dropped; the next /redo tries "main".');
    expect(w.app.branchState.redoStack).toEqual([{ branchName: 'main' }]);
  });
});

describe('a refusal offers stopping only for the turn an operator can stop', () => {
  const refusalFor = (statuses: Record<string, string>) => {
    const agents = Object.entries(statuses).map(([name, status]) => ({ name, state: { status } }));
    const app = {
      agentName: 'a',
      framework: {
        getAgent: (name: string) => agents.find((agent) => agent.name === name),
        getAllAgents: () => agents,
      },
    };
    return handleCommand('/undo', app as never).lines.map((line) => line.text).join('\n');
  };

  test('the main agent alone mid-turn: wait for it, or stop it', () => {
    expect(refusalFor({ a: 'streaming', b: 'idle' })).toContain('Wait for the turn to end, or stop it, then retry.');
  });

  test('another agent alone mid-turn: wait for it, with no stop offered', () => {
    const said = refusalFor({ a: 'idle', b: 'streaming' });
    expect(said).toContain('(b: streaming)');
    expect(said).toContain('Wait for the turn to end, then retry.');
    expect(said).not.toContain('stop');
  });

  test('/newtopic waits for the main agent only: another agent mid-turn doesn\'t refuse it', () => {
    const newtopicWith = (statuses: Record<string, string>) => {
      const agents = Object.entries(statuses).map(([name, status]) => ({ name, state: { status }, getContextManager: () => null }));
      const app = {
        agentName: 'a',
        framework: {
          getAgent: (name: string) => agents.find((agent) => agent.name === name),
          getAllAgents: () => agents,
        },
      };
      return handleCommand('/newtopic', app as never).lines.map((line) => line.text).join('\n');
    };
    const otherBusy = newtopicWith({ a: 'idle', b: 'streaming' });
    expect(otherBusy).not.toContain('refused');
    expect(otherBusy).toContain('No context manager.');
    expect(newtopicWith({ a: 'streaming', b: 'idle' })).toContain('/newtopic refused: a turn is in flight (a: streaming).');
  });

  test('the main agent and another mid-turn: wait for both, and only the main agent\'s can be stopped', () => {
    const said = refusalFor({ a: 'streaming', b: 'inferring' });
    expect(said).toContain('(a: streaming, b: inferring)');
    expect(said).toContain("Wait for those turns to end, then retry; a's can be stopped.");
  });
});
