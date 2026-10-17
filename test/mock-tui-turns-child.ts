/**
 * runTui driven through its own key handler and its own trace subscription,
 * for test/tui-turns.test.ts. The fake app's framework sends the traces each
 * step names to every listener, as agent-framework's emitTrace calls each
 * one, and its abortInference aborts only once told an agent's model call is
 * in flight, then sends `inference:aborted`, and the aborted stream's
 * `inference:exhausted` after it, as agent-framework 0.22.2's does. In the
 * `subagents` scenario its subagent module stands in for the host's.
 * Prints one `TUI_STEP` line of JSON per step: the frame's text and the
 * aborts asked for so far.
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

/** The subagent module, as runTui reads it: one live attempt, spawn-1. */
const subagents = {
  name: 'subagent',
  activeSubagents: new Map(),
  parentMap: new Map(),
  restoreFromStore() {},
  peek: async () => [],
  isSubagentAgent: (agentName: string) => agentName === 'spawn-1',
  cancelAll() { aborts.push('cancelAll'); return 1; },
};

function fakeFramework(name: string) {
  const listeners = new Set<Listener>();
  const abortable = new Set<string>();
  return {
    /** Whether an agent's model call is in flight, so an abort finds it. */
    setAbortable(value: boolean, agentName = 'agent') {
      if (value) abortable.add(agentName);
      else abortable.delete(agentName);
    },
    send(type: string, extra: Trace = {}) {
      for (const listener of [...listeners]) listener({ type, agentName: 'agent', ...extra });
    },
    getAllModules: () => (scenario === 'subagents' ? [subagents] : []),
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
      // The aborted stream's own end, sent as its loop ends, before the turn
      // lets the agent go.
      queueMicrotask(() => this.send('inference:exhausted', { agentName, error: `Stream aborted: ${reason ?? 'unknown'}` }));
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

// runTui sends stderr to its error log, so what goes wrong is told on stdout.
// The watchdog only catches a hang: each wait below has its own deadline.
const watchdog = setTimeout(() => { process.stdout.write(`TUI_ERROR timed out in ${scenario}\n`); process.exit(2); }, 25000);
void runTui(app as unknown as Parameters<typeof runTui>[0]);
await initialized;

// runTui registered its key handler before it followed the framework, so a
// listener registered now hears each key after runTui's handler has run.
let keysHandled = 0;
renderer.keyInput.on('keypress', () => { keysHandled++; });

async function pressed(press: () => void, what: string): Promise<void> {
  const before = keysHandled;
  press();
  await until(() => keysHandled > before, `${what} handled`);
  // A kept interrupt's abort runs on a microtask.
  await Promise.resolve();
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

    // A message sent, before its turn starts: the status line shows a turn
    // the follower has none of.
    await command('hello');
    await until(async () => (await frame()).includes('You: hello'), 'the message to show');
    await step('sent');
    await escape();
    await step('sent, Escape');

    first.send('inference:started');
    first.setAbortable(true);
    await escape();
    await step('in flight');

    first.send('inference:started');
    await escape();
    await step('compiling');
    first.setAbortable(true);
    first.send('inference:tokens');
    await Promise.resolve();
    await step('compiled');

    // A turn moved to the background with Ctrl+B, which the status line
    // shows from its next tool call.
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
    await Promise.resolve();
    first.setAbortable(true);
    first.send('inference:tokens');
    await Promise.resolve();
    await step('retried');

    first.send('inference:started');
    first.send('inference:failed', { error: 'gave up' });
    first.send('inference:exhausted', { error: 'gave up' });
    await step('ended error');
    await escape();
    await step('ended error, Escape');
  } else if (scenario === 'missed-start') {
    // A turn whose start the TUI didn't follow, as one that began before it
    // followed the framework: its running traces show it, and its own end,
    // or its failure, shows.
    first.send('inference:tool_calls_yielded', { calls: [{ name: 'search' }] });
    await step('no start, then tools');
    // Running tools, so nothing to abort yet: the interrupt is kept.
    await escape();
    await step('no start, Escape');
    first.send('inference:completed');
    await step('no start, then completed');
    first.send('inference:failed', { error: 'a turn the TUI never saw start' });
    await step('no start, then failed');
  } else if (scenario === 'switch' || scenario === 'switch-fails') {
    // A turn is running when the switch starts; the switch stops its
    // framework, so no turn is running once it ends.
    first.send('inference:started');
    await command('/session switch other');
    await until(async () => (await frame()).includes('switching'), 'the switch to start');
    await escape();
    await step('switching, Escape');
    endSwitch(scenario === 'switch' ? 'switched' : 'failed');
    const settled = scenario === 'switch' ? 'Session: other' : 'Session switch failed';
    await until(async () => (await frame()).includes(settled), 'the switch to end');
    await step('switch ended');
    // An end with no start since the switch, from the framework the host
    // holds: the turn that was showing went with the switch, so it shows
    // nothing.
    (scenario === 'switch' ? second : first).send('inference:aborted', { reason: 'from before the switch' });
    await step('late end');
    // A failure always shows, with no start since the switch too.
    (scenario === 'switch' ? second : first).send('inference:failed', { error: 'a late failure' });
    await step('late failure');
    // The trace of the framework the host doesn't hold goes first: by the
    // time the other's line shows, its own would have, had it reached the
    // TUI.
    const [gone, held] = scenario === 'switch' ? [first, second] : [second, first];
    gone.send('inference:started');
    gone.send('inference:failed', { error: 'from the framework the TUI left' });
    held.send('inference:started');
    held.send('inference:failed', { error: 'from the framework the host holds' });
    await step('after the switch');
  } else if (scenario === 'subagents') {
    // The root's model call is in flight; spawn-1's turn is compiling.
    first.send('inference:started');
    first.send('inference:started', { agentName: 'spawn-1' });
    first.setAbortable(true);
    await escape();
    await step('subagents, Escape');
    // spawn-1's call goes out: its kept interrupt aborts it.
    first.setAbortable(true, 'spawn-1');
    first.send('inference:tokens', { agentName: 'spawn-1' });
    await Promise.resolve();
    await step('subagent compiled');
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
