/**
 * The fake framework sends each trace to every listener in turn, as
 * agent-framework's emitTrace calls each one.
 */
import { mock } from 'bun:test';
import * as core from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';

const [scenario] = process.argv.slice(2);
// Kitty's key encoding, so a lone Escape is read at once rather than held to
// tell it from the start of a sequence.
const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
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
    getAllAgents: () => (scenario === 'subagents' ? [{ name: 'agent' }, { name: 'spawn-1' }] : [{ name: 'agent' }]),
    getModule: () => undefined,
    getAgent: (agentName: string) => agentName === 'agent'
      ? { name: 'agent', state: { status: 'idle' }, getContextManager: () => ({ getAllMessages: () => [] }) }
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
  };
}

const first = fakeFramework('first');
const second = fakeFramework('second');
const sessions = [{ id: 's1', name: 'first' }, { id: 's2', name: 'other' }];
let active = sessions[0];
let endSwitch!: (outcome: 'switched' | 'failed') => void;
const app = {
  membrane: {},
  recipe: { name: 'tui-turns-test', agent: { name: 'agent' } },
  credentials: { provider: 'anthropic', snapshot: () => ({ kind: 'ok' }) },
  branchState: { undoStack: [], redoStack: [], checkpoints: new Map() },
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
  process.stdout.write(`TUI_STEP ${JSON.stringify({ step: name, frame: await frame(), aborts: [...aborts] })}\n`);
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
  } else if (scenario === 'background-switch') {
    first.send('inference:started');
    await pressed(() => mockInput.pressKey('b', { ctrl: true }), 'Ctrl+B');
    first.send('inference:tokens', { content: 'old session words' });
    first.send('inference:failed', { error: 'overloaded' });
    await command('/session switch other');
    await until(async () => (await frame()).includes('switching'), 'the switch to start');
    endSwitch('switched');
    await until(async () => (await frame()).includes('Session: other'), 'the switch to end');
    second.send('inference:started');
    second.send('inference:tokens', { content: 'new session words', blockType: 'text' });
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
