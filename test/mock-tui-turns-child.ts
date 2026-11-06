/**
 * The fake framework sends each trace to every listener in turn, as
 * agent-framework's emitTrace calls each one. In `undone` the agent's record
 * holds two rows, and its window's undone ones are the test's to set.
 */
import { mock } from 'bun:test';
import * as core from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';

const [scenario] = process.argv.slice(2);
// Kitty's key encoding, so a lone Escape is read at once rather than held to
// tell it from the start of a sequence.
const { renderer, mockInput, renderOnce, captureCharFrame, captureSpans } = await createTestRenderer({
  width: 120, height: 60, exitOnCtrlC: false, kittyKeyboard: true,
});
mock.module('@opentui/core', () => ({ ...core, createCliRenderer: async () => renderer }));
const { runTui } = await import('../src/tui.js');

type Trace = Record<string, unknown>;
type Listener = (event: Trace) => void;

let ready!: () => void;
const initialized = new Promise<void>(resolve => { ready = resolve; });
const aborts: string[] = [];

const subagents = {
  name: 'subagent',
  activeSubagents: new Map(),
  parentMap: new Map(),
  restoreFromStore() {},
  peek: async () => [],
  onPeekStream: () => () => {},
  isSubagentAgent: (agentName: string) => agentName === 'spawn-1',
  cancelAll() { aborts.push('cancelAll'); return 1; },
};

/** The agent's record in the `undone` scenarios, and which of its rows an undo took out of its window. */
const history: Array<{ id: string; participant: string; content: Array<Record<string, unknown>>; metadata?: Record<string, unknown> }> = [
  { id: 'u1', participant: 'user', content: [{ type: 'text', text: 'count the ledgers' }] },
  { id: 'a1', participant: 'agent', content: [{ type: 'thinking', thinking: 'tally them first' }, { type: 'text', text: 'three ledgers' }] },
];
const undoneRows = new Set<string>();
/** The store's branch in `async-branch`, which a /checkout moves (the framework's switchBranch traces nothing). */
let storeBranch = 'main';
/** The record's reads the TUI makes of the agent's context, over `rows`. */
const recordOf = (rows: typeof history) => ({
  getAllMessages: () => rows,
  getMessageCount: () => rows.length,
  getMessageWindow: (offset: number, limit: number) => ({
    messages: rows.slice(offset, offset + limit), startIndex: offset, totalCount: rows.length,
  }),
});
const contextManager = () => (scenario.startsWith('undone')
  ? {
      ...recordOf(history),
      windowStatusOf: (id: string) => (undoneRows.has(id) ? 'undone' : 'in'),
    }
  : scenario.startsWith('async-branch')
    ? {
        ...recordOf(history),
        listBranches: () => [{ id: 'b-main', name: 'main', head: 2 }, { id: 'b-side', name: 'side', head: 2 }],
        currentBranch: () => ({ id: `b-${storeBranch}`, name: storeBranch, head: 2 }),
      }
    : recordOf([]));

function fakeFramework(name: string) {
  const listeners = new Set<Listener>();
  const abortable = new Set<string>();
  return {
    setAbortable(value: boolean, agentName = 'agent') {
      if (value) abortable.add(agentName);
      else abortable.delete(agentName);
    },
    send(type: string, extra: Trace = {}) {
      for (const listener of [...listeners]) listener({ type, agentName: 'agent', ...extra });
    },
    getAllModules: () => (['subagents', 'subagent-exhausted', 'numbered-fork-failed', 'numbered-fork-exhausted', 'numbered-fork-failed-then-exhausted', 'numbered-fork-failed-then-started', 'fork-figures', 'fork-figures-reversed', 'fleet-parents'].includes(scenario) ? [subagents] : []),
    getAllAgents: () => (scenario === 'subagents' ? [{ name: 'agent' }, { name: 'spawn-1' }]
      : scenario.startsWith('async-branch') ? [{ name: 'agent', state: { status: 'idle' }, getContextManager: contextManager }]
      : [{ name: 'agent' }]),
    getModule: (moduleName: string) => (scenario.startsWith('async-branch') && moduleName === 'workspace' ? workspace : undefined),
    getAgent: (agentName: string) => agentName === 'agent'
      ? { name: 'agent', state: { status: 'idle' }, getContextManager: contextManager }
      : undefined,
    onTrace(listener: Listener) {
      listeners.add(listener);
      ready();
      return () => { listeners.delete(listener); };
    },
    offTrace(listener: Listener) { listeners.delete(listener); },
    abortInference(agentName: string, reason?: string) {
      aborts.push(`${name}:${agentName}`);
      if (!abortable.delete(agentName)) return false;
      this.send('inference:aborted', { agentName, reason });
      return true;
    },
    pushEvent: () => {},
    stop: async () => {},
    getStore: () => ({ currentBranch: () => ({ name: storeBranch }) }),
    async switchBranch(branch: string) {
      storeBranch = branch;
      history.splice(1, history.length, { id: 's1', participant: 'agent', content: [{ type: 'text', text: 'the side branch reply' }] });
      if (scenario === 'async-branch-turn') await new Promise<void>((resolve) => { releaseMove = resolve; });
    },
  };
}

/** In `async-branch-turn`, lets the moved store's answer go. */
let releaseMove: (() => void) | undefined;
/** The workspace module in `async-branch`: each mount refresh the TUI starts. */
const mountRefreshes: string[] = [];
const workspace = { name: 'workspace', materializeMount: async (mount: string) => { mountRefreshes.push(mount); } };

const first = fakeFramework('first');
const second = fakeFramework('second');
const sessions = [{ id: 's1', name: 'first' }, { id: 's2', name: 'other' }];
let active = sessions[0];
let endSwitch!: (outcome: 'switched' | 'failed') => void;
const app = {
  membrane: {},
  recipe: { name: 'tui-turns-test', agent: { name: 'agent' } },
  credentials: { provider: 'anthropic', snapshot: () => ({ kind: 'ok' }) },
  branchState: { checkpoints: new Map() },
  sessionManager: {
    getActiveSession: () => active,
    findSession: (nameOrId: string) => sessions.find(s => s.id === nameOrId || s.name === nameOrId) ?? null,
  },
  framework: first as ReturnType<typeof fakeFramework>,
  switchSession(sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      endSwitch = (outcome) => {
        if (outcome === 'failed') { reject(new Error('the new session would not open')); return; }
        active = sessions.find(s => s.id === sessionId)!;
        app.framework = second;
        resolve();
      };
    });
  },
};

const watchdog = setTimeout(() => { process.stdout.write(`TUI_ERROR timed out in ${scenario}\n`); process.exit(2); }, 25000);
void runTui(app as unknown as Parameters<typeof runTui>[0]);
await initialized;

// keyInput calls its keypress listeners in the order they were added, and
// runTui added its key handler before it followed the framework, so a
// listener added now hears each key after runTui's handler has run.
let keysHandled = 0;
renderer.keyInput.on('keypress', () => { keysHandled++; });

const letAKeptInterruptTry = (): Promise<void> => Promise.resolve();

async function pressed(press: () => void, what: string): Promise<void> {
  const before = keysHandled;
  press();
  await until(() => keysHandled > before, `${what} handled`);
  await letAKeptInterruptTry();
}

const escape = (): Promise<void> => pressed(() => mockInput.pressEscape(), 'Escape');

async function frame(): Promise<string> {
  await renderOnce();
  return captureCharFrame();
}

async function until(done: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function step(name: string): Promise<void> {
  process.stdout.write(`TUI_STEP ${JSON.stringify({ step: name, frame: await frame(), aborts: [...aborts], mountRefreshes: [...mountRefreshes], colours: colours() })}\n`);
}

/** The words whose colour a step reports, each where it is first drawn. */
const COLOURED = ['three ledgers', 'tally them first', 'a fifth ledger', 'You: and the fifth?'];

/** The foreground, as `#rrggbb`, of the span each of COLOURED is drawn in, on the last frame rendered. */
function colours(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of captureSpans().lines) {
    const text = line.spans.map((span) => span.text).join('');
    for (const words of COLOURED) {
      const at = text.indexOf(words);
      if (at === -1 || words in out) continue;
      let from = 0;
      for (const span of line.spans) {
        if (at < from + span.text.length) {
          out[words] = `#${span.fg.toInts().slice(0, 3).map((n) => n.toString(16).padStart(2, '0')).join('')}`;
          break;
        }
        from += span.text.length;
      }
    }
  }
  return out;
}

/** A reply of the root agent's, streamed in `parts` and completed. */
async function streamed(...parts: string[]): Promise<void> {
  first.send('inference:started');
  for (const content of parts) first.send('inference:tokens', { content, blockType: 'text' });
  first.send('inference:completed');
  await until(async () => (await frame()).includes(parts.join('')), 'the reply');
}

/** A reply of the root agent's, streamed and stored as agent-framework
 *  stores a turn's last reply: its row before inference:completed. */
async function replied(id: string, text: string): Promise<void> {
  first.send('inference:started');
  first.send('inference:tokens', { content: text, blockType: 'text' });
  history.push({ id, participant: 'agent', content: [{ type: 'text', text }] });
  first.send('inference:completed');
  await until(async () => (await frame()).includes(text), 'the reply');
}

async function command(text: string): Promise<void> {
  await mockInput.typeText(text);
  mockInput.pressEnter();
}

async function play(): Promise<void> {
  if (scenario === 'escape') {
    await escape();
    await step('idle');

    await command('hello');
    await until(async () => (await frame()).includes('You: hello'), 'the message to show');
    await step('sent, before its turn starts');
    await escape();
    await step('sent, before its turn starts, Escape');

    first.send('inference:started');
    first.setAbortable(true);
    await escape();
    await step('in flight');

    first.send('inference:started');
    await escape();
    await step('compiling');
    first.setAbortable(true);
    first.send('inference:tokens');
    await letAKeptInterruptTry();
    await step('compiled');

    first.send('inference:started');
    await pressed(() => mockInput.pressKey('b', { ctrl: true }), 'Ctrl+B');
    first.send('inference:tool_calls_yielded', { calls: [{ name: 'search' }] });
    await step('background');
    first.setAbortable(true);
    await escape();
    await step('background, Escape');

    first.send('inference:started');
    first.send('inference:failed', { error: 'overloaded' });
    await step('retry wait');
    await escape();
    await step('retry wait, Escape');
    first.send('inference:started');
    await letAKeptInterruptTry();
    first.setAbortable(true);
    first.send('inference:tokens');
    await letAKeptInterruptTry();
    await step('retried');

    first.send('inference:started');
    first.send('inference:failed', { error: 'gave up' });
    first.send('inference:exhausted', { error: 'gave up' });
    await step('ended error');
    await escape();
    await step('ended error, Escape');
  } else if (scenario.startsWith('background-retry')) {
    first.send('inference:started');
    await pressed(() => mockInput.pressKey('b', { ctrl: true }), 'Ctrl+B');
    first.send('inference:tokens', { content: 'first round words' });
    first.send('inference:tool_calls_yielded', { calls: [{ name: 'search' }] });
    if (scenario === 'background-retry') first.send('inference:stream_resumed');
    if (scenario === 'background-retry-restarted') first.send('inference:started');
    if (scenario !== 'background-retry-before-resume') first.send('inference:tokens', { content: 'dead attempt words' });
    first.send('inference:failed', { error: 'overloaded' });
    await step('failed in background');
    first.send('inference:started');
    first.send('inference:tokens', { content: 'retry words' });
    first.send('inference:completed');
    await step('returned');
  } else if (scenario === 'switch-ctrl-b') {
    first.send('inference:started');
    await command('/session switch other');
    await until(async () => (await frame()).includes('switching'), 'the switch to start');
    await pressed(() => mockInput.pressKey('b', { ctrl: true }), 'Ctrl+B');
    endSwitch('switched');
    await until(async () => (await frame()).includes('Session: other'), 'the switch to end');
    second.send('inference:started');
    second.send('inference:tokens', { content: 'new session words', blockType: 'text' });
    await step('new session streaming');
  } else if (scenario === 'background-switch-fails') {
    first.send('inference:started');
    await pressed(() => mockInput.pressKey('b', { ctrl: true }), 'Ctrl+B');
    first.send('inference:tokens', { content: 'old round words' });
    first.send('inference:tool_calls_yielded', { calls: [{ name: 'search' }] });
    first.send('inference:failed', { error: 'overloaded' });
    await command('/session switch other');
    await until(async () => (await frame()).includes('switching'), 'the switch to start');
    endSwitch('failed');
    await until(async () => (await frame()).includes('Session switch failed'), 'the switch to fail');
    first.send('inference:started');
    first.send('inference:tokens', { content: 'retry words' });
    first.send('inference:completed');
    await step('old turn returned');
  } else if (scenario === 'background-switch') {
    first.send('inference:started');
    await pressed(() => mockInput.pressKey('b', { ctrl: true }), 'Ctrl+B');
    first.send('inference:tokens', { content: 'old session words' });
    first.send('inference:tool_calls_yielded', { calls: [{ name: 'search' }] });
    first.send('inference:failed', { error: 'overloaded' });
    await command('/session switch other');
    await until(async () => (await frame()).includes('switching'), 'the switch to start');
    endSwitch('switched');
    await until(async () => (await frame()).includes('Session: other'), 'the switch to end');
    second.send('inference:started');
    await pressed(() => mockInput.pressKey('b', { ctrl: true }), 'Ctrl+B');
    second.send('inference:tokens', { content: 'new session words' });
    second.send('inference:completed');
    await step('new session answered');
  } else if (scenario === 'missed-start') {
    first.send('inference:tool_calls_yielded', { calls: [{ name: 'search' }] });
    await step('no start, then tools');
    await escape();
    await step('no start, Escape');
    first.send('inference:completed');
    await step('no start, then completed');
    first.send('inference:failed', { error: 'a turn the TUI never saw start' });
    await step('no start, then failed');
    first.send('inference:exhausted', { error: 'a turn the TUI never saw start' });
    await step('no start, failed, then exhausted');
  } else if (scenario === 'switch' || scenario === 'switch-fails') {
    first.send('inference:started');
    await command('/session switch other');
    await until(async () => (await frame()).includes('switching'), 'the switch to start');
    await escape();
    await step('switching, Escape');
    endSwitch(scenario === 'switch' ? 'switched' : 'failed');
    const settled = scenario === 'switch' ? 'Session: other' : 'Session switch failed';
    await until(async () => (await frame()).includes(settled), 'the switch to end');
    await step('switch ended');
    (scenario === 'switch' ? second : first).send('inference:aborted', { reason: 'from before the switch' });
    await step('late end');
    (scenario === 'switch' ? second : first).send('inference:failed', { error: 'a late failure' });
    await step('late failure');
    const [gone, held] = scenario === 'switch' ? [first, second] : [second, first];
    gone.send('inference:started');
    gone.send('inference:failed', { error: 'from the framework the TUI left' });
    held.send('inference:started');
    held.send('inference:failed', { error: 'from the framework the host holds' });
    await step('after the switch');
  } else if (scenario === 'subagents') {
    first.send('inference:started');
    first.send('inference:started', { agentName: 'spawn-1' });
    first.setAbortable(true);
    await escape();
    await step('subagents, Escape');
    first.setAbortable(true, 'spawn-1');
    first.send('inference:tokens', { agentName: 'spawn-1' });
    await letAKeptInterruptTry();
    await step('subagent compiled');
  } else if (scenario.startsWith('numbered-fork-')) {
    for (const name of ['web', 'web-1']) {
      subagents.activeSubagents.set(name, {
        name, status: 'running', startedAt: Date.now(),
        task: 'Check numbered fork attribution', toolCallsCount: 0,
      });
    }
    const tab = () => pressed(() => mockInput.pressTab(), 'Tab');
    await until(async () => (await frame()).includes('Session: first'), 'initial render');
    await tab();
    await until(async () => {
      const text = await frame();
      return /web  \[sending /.test(text) && /web-1  \[sending /.test(text);
    }, 'both running subagent rows');
    await step('before');

    const agentName = 'web-1-d1-1700000000001';
    first.send('inference:started', { agentName });
    if (scenario !== 'numbered-fork-exhausted') first.send('inference:failed', { agentName, error: 'numbered fork failure' });
    if (scenario === 'numbered-fork-exhausted' || scenario === 'numbered-fork-failed-then-exhausted') first.send('inference:exhausted', { agentName, error: 'numbered fork failure' });
    if (scenario === 'numbered-fork-failed-then-started') first.send('inference:started', { agentName });
    await tab();
    await tab();
    await step('after');
  } else if (scenario === 'fork-figures' || scenario === 'fork-figures-reversed') {
    for (const name of ['web-retry1', 'web']) {
      subagents.activeSubagents.set(name, {
        name, status: 'running', startedAt: Date.now(),
        task: 'Check each row reads its own figure', toolCallsCount: 0,
      });
    }
    const usage: Array<[string, number]> = [['web-retry1-d1-1700000000000', 50000], ['web-d1-1700000000001', 20000]];
    if (scenario === 'fork-figures-reversed') usage.reverse();
    for (const [agentName, input] of usage) {
      first.send('inference:started', { agentName });
      first.send('inference:usage', { agentName, tokenUsage: { input, output: 10 } });
    }
    await until(async () => (await frame()).includes('Session: first'), 'initial render');
    await pressed(() => mockInput.pressTab(), 'Tab');
    await until(async () => /web  \[sending /.test(await frame()), 'the rows');
    await step('fleet');
  } else if (scenario === 'fleet-parents') {
    for (const name of ['web', 'web-retry1', 'saved-child', 'live-child']) {
      subagents.activeSubagents.set(name, {
        name, status: 'running', startedAt: Date.now(),
        task: 'Check which row each child hangs under', toolCallsCount: 0,
      });
    }
    subagents.parentMap.set('saved-child', 'web-retry2');
    subagents.parentMap.set('live-child', 'web-retry1-d1-1700000000001');
    await until(async () => (await frame()).includes('Session: first'), 'initial render');
    first.send('branches:changed', { event: 'switched', branch: 'restored', previous: 'main', source: 'test' });
    await pressed(() => mockInput.pressTab(), 'Tab');
    await until(async () => /web  \[sending /.test(await frame()), 'the rows');
    await pressed(() => mockInput.pressArrow('down'), 'Down');
    await pressed(() => mockInput.pressEnter(), 'Enter');
    await pressed(() => mockInput.pressArrow('down'), 'Down');
    await pressed(() => mockInput.pressArrow('down'), 'Down');
    await pressed(() => mockInput.pressEnter(), 'Enter');
    await step('fleet');
  } else if (scenario === 'repeated-failures') {
    const sub = 'spawn-web-1700000000000';
    for (let i = 0; i < 3; i++) {
      first.send('inference:started');
      first.send('inference:failed', { error: 'zz connection refused' });
    }
    await step('three failures');
    first.send('inference:started');
    first.send('inference:failed', { error: 'zz credential rejected' });
    await step('other words');
    first.send('inference:exhausted', { error: 'zz credential rejected', errorType: 'auth' });
    await step('gave up');
    for (let i = 0; i < 2; i++) {
      first.send('inference:started', { agentName: sub });
      first.send('inference:started');
      first.send('inference:failed', { agentName: sub, error: 'zz subagent failure' });
      first.send('inference:failed', { error: 'zz root again' });
    }
    await step('subagent twice');
    first.send('inference:started');
    first.send('inference:exhausted', { error: 'zz stream aborted' });
    await step('aborted retry');
    first.send('inference:started');
    first.send('inference:failed', { error: 'zz before the switch' });
    await command('/session switch other');
    await until(async () => (await frame()).includes('switching'), 'the switch to start');
    endSwitch('switched');
    await until(async () => (await frame()).includes('Session: other'), 'the switch to end');
    second.send('inference:started');
    second.send('inference:failed', { error: 'zz before the switch' });
    await step('after the switch');
  } else if (scenario === 'subagent-exhausted') {
    const agentName = 'spawn-web-1700000000000';
    subagents.activeSubagents.set('spawn-web', {
      name: 'web', status: 'running', startedAt: Date.now(),
      task: 'Check stream failures', toolCallsCount: 0,
    });
    const tab = () => pressed(() => mockInput.pressTab(), 'Tab');
    await tab();
    await until(async () => /web  \[sending /.test(await frame()), 'the running subagent row');
    await step('before exhaustion');
    await tab();

    first.send('inference:started', { agentName });
    first.send('inference:exhausted', { agentName, error: 'lone first stream' });
    await step('lone first');
    await tab();
    await until(async () => /web  \[failed /.test(await frame()), 'the failed subagent phase');
    await step('failed phase');
    await tab();

    first.send('inference:started', { agentName });
    first.send('inference:failed', { agentName, error: 'paired stream' });
    first.send('inference:exhausted', { agentName, error: 'paired stream' });
    await step('paired');
    first.send('inference:started', { agentName });
    first.send('inference:exhausted', { agentName, error: 'lone later stream' });
    await step('lone later');
    first.send('inference:started', { agentName: 'spawn-2' });
    first.send('inference:exhausted', { agentName: 'spawn-2', error: 'other agent stream' });
    await step('other agent');

    first.send('inference:started', { agentName });
    first.send('inference:failed', { agentName, error: 'first try' });
    first.send('inference:started', { agentName });
    first.send('inference:exhausted', { agentName, error: 'retry exhausted' });
    await step('retried');

    const failing = 'spawn-web-1700000000001';
    const lone = 'spawn-web-1700000000002';
    first.send('inference:started', { agentName: failing });
    first.send('inference:failed', { agentName: failing, error: 'failing stream' });
    first.send('inference:started', { agentName: lone });
    first.send('inference:exhausted', { agentName: lone, error: 'lone stream' });
    first.send('inference:exhausted', { agentName: failing, error: 'failing stream' });
    await step('interleaved');

    first.send('inference:started', { agentName });
    first.send('inference:failed', { agentName, error: 'before switch' });
    await command('/session switch other');
    await until(async () => (await frame()).includes('switching'), 'the switch to start');
    endSwitch('switched');
    await until(async () => (await frame()).includes('Session: other'), 'the switch to end');
    second.send('inference:exhausted', { agentName, error: 'after switch' });
    await step('after switch');
  } else if (scenario === 'async-branch-turn') {
    await until(async () => (await frame()).includes('three ledgers'), 'the history');
    // A turn of the root agent's starts on the branch the store moved to
    // before the move's follow-up is drawn (#485 bot review 2, finding 24).
    await command('/checkout side');
    await until(() => releaseMove !== undefined, 'the move');
    first.send('inference:started');
    first.send('inference:tokens', { content: 'on the side ', blockType: 'text' });
    releaseMove!();
    await until(async () => (await frame()).includes('Switched to branch side.'), 'the follow-up');
    first.send('inference:tokens', { content: 'branch now', blockType: 'text' });
    await step('streaming at the follow-up');
    history.push({ id: 's2', participant: 'agent', content: [{ type: 'text', text: 'on the side branch now' }] });
    first.send('inference:completed');
    await until(async () => (await frame()).includes('the side branch reply'), 'the branch drawn');
    await step('turn ended');
  } else if (scenario === 'async-branch') {
    await until(async () => (await frame()).includes('three ledgers'), 'the history');
    // The store moves in the command's follow-up, with no trace of it.
    await command('/checkout side');
    await until(async () => (await frame()).includes('Switched to branch side.'), 'the follow-up');
    await step('switched');
  } else if (scenario === 'undone-shed') {
    await until(async () => (await frame()).includes('three ledgers'), 'the history');
    await streamed('a fifth ledger');
    history.push({ id: 'a2', participant: 'agent', content: [{ type: 'text', text: 'a fifth ledger' }] });
    // A failed inference's shed takes the reply out of the window as undone,
    // with no window:undone (agent-framework's shedFailedExchange).
    undoneRows.add('a2');
    first.send('presentation:retracted', { messageIds: ['a2'], reason: 'shed' });
    await until(async () => (await frame()).includes('(undone) a fifth ledger'), 'the mark');
    await step('shed');
  } else if (scenario === 'undone-co-resident') {
    await until(async () => (await frame()).includes('three ledgers'), 'the history');
    // A co-resident's row with the same words, stored in the record the
    // residents share before the root agent's reply.
    history.push({
      id: 'm1', participant: 'mira', content: [{ type: 'text', text: 'Done with the ledgers.' }],
      metadata: { audience: ['mira'], ownRowOf: 'mira' },
    });
    await streamed('Done with the ledgers.');
    history.push({
      id: 'a2', participant: 'agent', content: [{ type: 'text', text: 'Done with the ledgers.' }],
      metadata: { audience: ['agent'], ownRowOf: 'agent' },
    });
    undoneRows.add('a2');
    first.send('window:undone', { retracted: 1 });
    await until(async () => (await frame()).includes('(undone) Done with the ledgers.'), 'the mark');
    await step('undone');
  } else if (scenario === 'undone-blocks') {
    await until(async () => (await frame()).includes('three ledgers'), 'the history');
    // A reply whose thinking is followed by two text blocks: the TUI
    // streams the two into one line.
    first.send('inference:started');
    first.send('inference:content_block', { phase: 'block_start', blockType: 'thinking' });
    first.send('inference:tokens', { content: 'weigh them', blockType: 'thinking' });
    first.send('inference:content_block', { phase: 'block_start', blockType: 'text' });
    first.send('inference:tokens', { content: 'the first half, ', blockType: 'text' });
    first.send('inference:content_block', { phase: 'block_start', blockType: 'text' });
    first.send('inference:tokens', { content: 'the second half', blockType: 'text' });
    first.send('inference:completed');
    await until(async () => (await frame()).includes('the first half, the second half'), 'the reply');
    history.push({
      id: 'a2', participant: 'agent',
      content: [{ type: 'thinking', thinking: 'weigh them' }, { type: 'text', text: 'the first half, ' }, { type: 'text', text: 'the second half' }],
    });
    undoneRows.add('a2');
    first.send('window:undone', { retracted: 1 });
    await until(async () => (await frame()).includes('(undone) the first half, the second half'), 'the mark');
    await step('undone');
  } else if (scenario === 'undone-tools') {
    await until(async () => (await frame()).includes('three ledgers'), 'the history');
    // A reply with text after its tool call: the stream changes lines only
    // between text and thinking, so the TUI draws the two texts as one line.
    first.send('inference:started');
    first.send('inference:content_block', { phase: 'block_start', blockType: 'text' });
    first.send('inference:tokens', { content: 'Checking the ledgers, ', blockType: 'text' });
    first.send('inference:content_block', { phase: 'block_start', blockType: 'tool_use' });
    first.send('inference:content_block', { phase: 'block_start', blockType: 'text' });
    first.send('inference:tokens', { content: 'then counting.', blockType: 'text' });
    first.send('inference:tool_calls_yielded', { calls: [{ name: 'search' }] });
    history.push({
      id: 'a2', participant: 'agent',
      content: [{ type: 'text', text: 'Checking the ledgers, ' }, { type: 'tool_use', id: 't1', name: 'search', input: {} }, { type: 'text', text: 'then counting.' }],
    });
    first.send('inference:completed');
    await until(async () => (await frame()).includes('Checking the ledgers, then counting.'), 'the reply');
    undoneRows.add('a2');
    first.send('window:undone', { retracted: 1 });
    await until(async () => (await frame()).includes('(undone) Checking the ledgers, then counting.'), 'the mark');
    await step('text around a tool call');
    // A round that only calls a tool (#485 bot review 3, finding 5).
    undoneRows.clear();
    first.send('window:undone', { retracted: 0, represented: 1 });
    first.send('inference:started');
    first.send('inference:tool_calls_yielded', { calls: [{ name: 'tally' }] });
    history.push({ id: 'a3', participant: 'agent', content: [{ type: 'tool_use', id: 't2', name: 'tally', input: {} }] });
    first.send('inference:completed');
    undoneRows.add('a3');
    first.send('window:undone', { retracted: 1 });
    await until(async () => /\(undone\).*\[tools\] tally/.test(await frame()), 'the mark');
    await step('tools only');
  } else if (scenario === 'undone-background') {
    await until(async () => (await frame()).includes('three ledgers'), 'the history');
    // Ctrl+B while a reply streams: its first round's words before the
    // press are drawn, the rest come back with the turn (#485 bot review 3,
    // finding 4).
    first.send('inference:started');
    first.send('inference:tokens', { content: 'Counting the ', blockType: 'text' });
    await until(async () => (await frame()).includes('Counting the'), 'the words before the press');
    await pressed(() => mockInput.pressKey('b', { ctrl: true }), 'Ctrl+B');
    first.send('inference:tokens', { content: 'ledgers now.', blockType: 'text' });
    first.send('inference:tool_calls_yielded', { calls: [{ name: 'tally' }] });
    history.push({
      id: 'a2', participant: 'agent',
      content: [{ type: 'text', text: 'Counting the ledgers now.' }, { type: 'tool_use', id: 't1', name: 'tally', input: {} }],
    });
    first.send('inference:stream_resumed');
    first.send('inference:tokens', { content: 'weigh the count', blockType: 'thinking' });
    first.send('inference:tokens', { content: 'There are three.', blockType: 'text' });
    history.push({
      id: 'a3', participant: 'agent',
      content: [{ type: 'thinking', thinking: 'weigh the count' }, { type: 'text', text: 'There are three.' }],
    });
    first.send('inference:completed');
    await until(async () => (await frame()).includes('returned from background'), 'the return');
    await step('returned');
    undoneRows.add('a2');
    undoneRows.add('a3');
    first.send('window:undone', { retracted: 2 });
    await until(async () => (await frame()).includes('(undone) There are three.'), 'the mark');
    await step('undone');
  } else if (scenario === 'undone-evicted') {
    await until(async () => (await frame()).includes('three ledgers'), 'the history');
    /** More streamed lines than the scrollback holds, none of them a row's. */
    const fill = (prefix: string) => {
      for (let i = 0; i <= 2000; i++) {
        first.send('inference:started');
        first.send('inference:tokens', { content: `${prefix} filler ${i}`, blockType: 'text' });
        first.send('inference:completed');
      }
    };
    // A streamed reply whose lines /clear took down, then enough streamed
    // lines to push its entry out before any undo linked it to its row.
    await streamed('a lost ledger');
    history.push({ id: 'a2', participant: 'agent', content: [{ type: 'text', text: 'a lost ledger' }] });
    await command('/clear');
    await until(async () => !(await frame()).includes('ledger'), 'the display to clear');
    fill('first');
    // Undone, with a row stored since that the TUI drew no line for.
    history.push({ id: 'a3', participant: 'agent', content: [{ type: 'text', text: 'a ninth ledger' }] });
    undoneRows.add('a2');
    undoneRows.add('a3');
    first.send('window:undone', { retracted: 2 });
    await until(async () => (await frame()).includes('(undone) a ninth ledger'), 'the mark');
    await step('cleared, then pushed out');
    // A streamed reply the scrollback cap took down, with no /clear.
    await streamed('a stray ledger');
    history.push({ id: 'a4', participant: 'agent', content: [{ type: 'text', text: 'a stray ledger' }] });
    fill('second');
    history.push({ id: 'a5', participant: 'agent', content: [{ type: 'text', text: 'a tenth ledger' }] });
    undoneRows.add('a4');
    undoneRows.add('a5');
    first.send('window:undone', { retracted: 2 });
    await until(async () => (await frame()).includes('(undone) a tenth ledger'), 'the mark');
    await step('pushed out');
    // Past the cap, a row stored with no line of the TUI's (a turn it
    // didn't stream), then one more streamed line, then its undo
    // (#485 bot review 3, finding 14).
    undoneRows.clear();
    fill('third');
    history.push({ id: 'a6', participant: 'agent', content: [{ type: 'text', text: 'an eleventh ledger' }] });
    await streamed('one more line');
    undoneRows.add('a6');
    first.send('window:undone', { retracted: 1 });
    await until(async () => (await frame()).includes('one more line'), 'the line');
    await step('no line, past the cap');
    // A reply whose line the cap pushed out, then a later reply in the same
    // words, then an undo of the later one (finding 2).
    undoneRows.clear();
    first.send('window:undone', { retracted: 0, represented: 1 });
    await replied('a7', 'Done.');
    fill('fourth');
    await replied('a8', 'Done.');
    undoneRows.add('a8');
    first.send('window:undone', { retracted: 1 });
    await until(async () => (await frame()).includes('Done.'), 'the reply');
    await step('same words, pushed out');
  } else if (scenario === 'undone') {
    await until(async () => (await frame()).includes('three ledgers'), 'the history');
    await step('history');
    // A line that isn't the history's: the operator's message, sent here.
    await command('and the fifth?');
    await until(async () => (await frame()).includes('You: and the fifth?'), 'the message to show');
    // A turn of this session's: its reply streamed after the history was
    // drawn, and its rows stored.
    await streamed('a fifth ', 'ledger');
    history.push(
      { id: 'u2', participant: 'user', content: [{ type: 'text', text: 'and the fifth?' }] },
      { id: 'a2', participant: 'agent', content: [{ type: 'text', text: 'a fifth ledger' }] },
    );
    // A line after the reply that is no row's, so marking in place can be
    // told from drawing the marked rows again at the bottom.
    first.send('tool:failed', { callId: 'c9', toolName: 'abacus', error: 'the beads stuck' });
    await until(async () => (await frame()).includes('the beads stuck'), 'the failed tool line');
    // A row stored after the history was drawn that the TUI drew no line for.
    history.push({ id: 'a3', participant: 'agent', content: [{ type: 'text', text: 'a sixth ledger' }] });
    // An undo on the agent's window: the history marks its rows.
    for (const id of ['a1', 'u2', 'a2', 'a3']) undoneRows.add(id);
    first.send('window:undone', { retracted: 4 });
    await until(async () => (await frame()).includes('(undone) three ledgers'), 'the mark');
    await step('undone');
    // A redo puts the rows back.
    undoneRows.clear();
    first.send('window:undone', { retracted: 0, represented: 4 });
    await until(async () => !(await frame()).includes('(undone)'), 'the mark to go');
    await step('redone');
    // Another agent's window isn't the history's.
    undoneRows.add('a1');
    first.send('window:undone', { agentName: 'other', retracted: 1 });
    await step('another agent');
    // Rows whose lines /clear took down: a2's and a3's, marked by an undo,
    // and a5's, streamed and never marked.
    undoneRows.clear();
    await streamed('an eighth ledger');
    history.push({ id: 'a5', participant: 'agent', content: [{ type: 'text', text: 'an eighth ledger' }] });
    undoneRows.add('a2');
    undoneRows.add('a3');
    first.send('window:undone', { retracted: 2 });
    await until(async () => (await frame()).includes('(undone) a sixth ledger'), 'the mark');
    await command('/clear');
    await until(async () => !(await frame()).includes('ledger'), 'the display to clear');
    // Another undo while they are out of the window: a row the TUI drew no
    // line for is drawn, marked, and the cleared ones aren't drawn again.
    history.push({ id: 'a4', participant: 'agent', content: [{ type: 'text', text: 'a seventh ledger' }] });
    undoneRows.add('a4');
    undoneRows.add('a5');
    first.send('window:undone', { retracted: 2 });
    await until(async () => (await frame()).includes('(undone) a seventh ledger'), 'the mark');
    await step('cleared, undone');
    // A redo of that row, and the cleared ones still aren't drawn.
    undoneRows.delete('a4');
    first.send('window:undone', { retracted: 0, represented: 1 });
    await until(async () => !(await frame()).includes('a seventh ledger'), 'the mark to go');
    await step('cleared, redone');
  } else {
    throw new Error(`unknown scenario ${scenario}`);
  }
}

try {
  await play();
} catch (error) {
  process.stdout.write(`TUI_ERROR ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
clearTimeout(watchdog);
process.stdout.write('TUI_DONE\n');
process.exit(0);
