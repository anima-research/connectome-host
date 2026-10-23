import { mock } from 'bun:test';
import * as core from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { switchSessionSteps } from '../src/session-switch.js';

const [mode, control] = process.argv.slice(2);
const { renderer, mockInput } = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false });
mock.module('@opentui/core', () => ({ ...core, createCliRenderer: async () => renderer }));
const { runTui } = await import('../src/tui.js');

const failure = new AggregateError([new Error('injected Fleet cleanup failure')], 'Fleet shutdown failed');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// The runs of each framework's stop body. agent-framework keeps a stop under
// way, and a successful one, for a later stop() call. These keep a failed one
// too, which no case here stops again, so a framework that the switch and
// the TUI's stop both stop runs its body once.
let stopCalls = 0;
let switchedStopCalls = 0;
// Trace listeners detached, from either framework, and listeners attached to
// either once the stop has been signalled: the TUI follows nothing then.
let traceDetached = 0;
let followedAfterStop = 0;
// How many trace detaches had happened when each framework's stop body
// first ran: the TUI stops following a framework before it stops it.
let detachedAtStop: number | null = null;
let switchedDetachedAtStop: number | null = null;
// The Web UI server's closes by the host's switch (control 'switch').
let serverStops = 0;
// Reads of the active session once the stop has been signalled: the switch's
// continuation reads it, and draws, only while the TUI runs.
let stopSignalled = false;
let activeAfterStop = 0;
// Reads of a framework's modules once the stop has been signalled: the
// switch's continuation rebinds to the new framework's modules only while
// the TUI runs.
let modulesReadAfterStop = 0;
// Control 'switch': whether the TUI's stop settled while the switch was
// still making its framework.
let settledBeforeSwitch: boolean | null = null;
let unhandled = false;
let ready!: () => void;
const initialized = new Promise<void>(resolve => { ready = resolve; });
let stopStarted!: () => void;
const stopUnderWay = new Promise<void>(resolve => { stopStarted = resolve; });
process.on('unhandledRejection', () => { unhandled = true; });
// Controls 'SIGTERM-then-*': the second signal has been sent. The slow stop
// holds until then, and a while after, so the second signal comes while the
// stop runs however long sending it took.
let secondSignalSent!: () => void;
const secondSent = new Promise<void>(resolve => { secondSignalSent = resolve; });
let commandStarted!: () => void;
const commandUnderWay = new Promise<void>(resolve => { commandStarted = resolve; });

function mockFramework(body: () => Promise<void>) {
  let stopping: Promise<void> | undefined;
  return {
    getAllModules: () => { if (stopSignalled) modulesReadAfterStop++; return []; },
    getModule: () => undefined,
    getAgent: () => undefined,
    getAllAgents: () => [{ name: 'agent' }],
    // /puppet's call (control 'late-command') answers once the framework's
    // stop is under way, as a command's slow work can.
    puppetToolCall: async () => {
      commandStarted();
      await stopUnderWay;
      process.stdout.write('LATE_COMMAND_ANSWERED\n');
      return { toolUseId: 'toolu_late', result: { isError: false, data: 'ok' } };
    },
    // As agent-framework's: onTrace returns its listener's unsubscribe, and
    // offTrace removes a listener too. Either detaches it.
    onTrace: () => {
      ready();
      if (stopSignalled) followedAfterStop++;
      return () => {
        traceDetached++;
        if (control === 'detach-throws') throw new Error('injected trace detach failure');
      };
    },
    offTrace: () => { traceDetached++; },
    stop: () => (stopping ??= body()),
  };
}
const framework = mockFramework(async () => {
  stopCalls++;
  detachedAtStop ??= traceDetached;
  stopStarted();
  if (mode === 'delayed-failure') await sleep(25);
  if (mode === 'slow') await (control.startsWith('SIGTERM-then-') ? secondSent.then(() => sleep(2000)) : sleep(1000));
  if (mode === 'failure' || mode === 'delayed-failure') throw failure;
});
// The framework a session switch makes (control 'switch').
const switched = mockFramework(async () => {
  switchedStopCalls++;
  switchedDetachedAtStop ??= traceDetached;
});
let switchStarted!: () => void;
const switchUnderWay = new Promise<void>(resolve => { switchStarted = resolve; });
let releaseSwitch!: () => void;
const switchGate = new Promise<void>(resolve => { releaseSwitch = resolve; });
let switchDone: Promise<unknown> = Promise.resolve();

const app = {
  membrane: {},
  recipe: { name: 'tui-shutdown-test', agent: { name: 'agent' } },
  branchState: { undoStack: [], redoStack: [], checkpoints: new Map() },
  sessionManager: {
    getActiveSession: () => { if (stopSignalled) activeAfterStop++; return null; },
    findSession: (name: string) => (name === 'other' ? { id: 'other-id', name: 'other' } : undefined),
  },
  framework: framework as ReturnType<typeof mockFramework>,
  stopping: undefined as boolean | undefined,
  // The host's switch (src/index.ts), with a framework whose making waits for
  // the test to release it.
  switchSession() {
    const switching = switchSessionSteps(app, {
      stopOld: () => app.framework.stop(),
      make: async () => {
        switchStarted();
        await switchGate;
        return switched;
      },
      install: (next) => { app.framework = next; },
      stopServer: async () => { serverStops++; },
    });
    switchDone = switching.catch(() => {});
    return switching;
  },
};

async function finish(status: string, error?: unknown): Promise<void> {
  // A turn of the timers first, so an unhandled rejection that the
  // settlement leaves behind is reported before the receipt.
  await sleep(20);
  process.stdout.write(`TUI_RESULT ${JSON.stringify({
    status, stopCalls, switchedStopCalls, traceDetached, followedAfterStop, detachedAtStop, switchedDetachedAtStop,
    serverStops, activeAfterStop, modulesReadAfterStop, settledBeforeSwitch,
    destroyed: renderer.isDestroyed, unhandled, originalError: error === failure,
  })}\n`);
  if (status === 'rejected') console.error('Fatal error:', error);
  process.exit(status === 'fulfilled' ? 0 : status === 'rejected' ? 1 : 2);
}

// linger: once the stop has settled, something else keeps the process
// running, and a stop signal then ends it by default, as before the TUI.
function lingerThenSignal(): void {
  setTimeout(() => process.exit(3), 20_000);
  process.stdout.write('TUI_SETTLED\n');
  process.kill(process.pid, 'SIGTERM');
}

// late-error: the terminal fails once the stop has settled and its log has
// ended; the error is swallowed, and nothing writes to the ended log.
function lateError(): void {
  process.stdout.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }));
  void finish('fulfilled');
}

// switch: the stop has settled while the switch was still making its
// framework. Release it, and receipt once it has ended.
async function afterSwitch(status: string, error?: unknown): Promise<void> {
  settledBeforeSwitch = serverStops === 0 && switchedStopCalls === 0;
  releaseSwitch();
  await switchDone;
  await finish(status, error);
}

const watchdog = setTimeout(() => { void finish('timed-out'); }, 30_000);
void runTui(app as unknown as Parameters<typeof runTui>[0]).then(
  () => {
    clearTimeout(watchdog);
    if (control === 'linger') lingerThenSignal();
    else if (control === 'late-error') lateError();
    else if (control === 'switch') void afterSwitch('fulfilled');
    else void finish('fulfilled');
  },
  error => {
    clearTimeout(watchdog);
    if (control === 'linger') lingerThenSignal();
    // exit-at-once: as the host's own exit after a failed stop (index.ts's
    // main().catch), with no wait of its own for the TUI's log.
    else if (control === 'exit-at-once') { console.error('Fatal error:', error); process.exit(1); }
    else void finish('rejected', error);
  },
);
await initialized;
if (control === 'ctrl-c') {
  mockInput.pressCtrlC();
} else if (control === 'quit' || control === 'detach-throws' || control === 'linger' || control === 'late-error') {
  // detach-throws: ending the TUI's trace subscription throws (onTrace
  // above), before the renderer goes; the rest of the teardown still runs,
  // and the framework still stops.
  await mockInput.typeText('/quit');
  mockInput.pressEnter();
} else if (control === 'stdout-error' || control === 'stdin-error') {
  // A terminal that fails with no signal, as a write to a pseudo-terminal
  // whose other end has closed does: Bun's own terminal sends no SIGHUP.
  const stream = control === 'stdout-error' ? process.stdout : process.stdin;
  stream.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }));
} else if (control === 'two-errors') {
  // A terminal that fails on both streams: only the first gets a line.
  process.stdin.emit('error', Object.assign(new Error('setRawMode failed with errno: 5'), { code: 'EIO' }));
  process.stdout.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }));
} else if (control === 'title-throws' || control === 'exit-at-once') {
  // cleanup's title reset throws where it's written; the host still stops.
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (chunk === '\x1b]0;\x07') throw new Error('injected title write failure');
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  await mockInput.typeText('/quit');
  mockInput.pressEnter();
} else if (control === 'switch') {
  // A stop while a session switch is making its framework, after it has
  // stopped the old one.
  await mockInput.typeText('/session switch other');
  mockInput.pressEnter();
  await switchUnderWay;
  stopSignalled = true;
  process.kill(process.pid, 'SIGTERM');
} else if (control === 'late-command') {
  // A command whose work answers once the stop has begun: the TUI draws
  // nothing for it then, since its renderer is destroyed.
  await mockInput.typeText('/puppet late_tool');
  mockInput.pressEnter();
  await commandUnderWay;
  process.kill(process.pid, 'SIGTERM');
} else if (control === 'error-during-stop') {
  // A hangup's SIGHUP can start the stop before the dead terminal's error
  // comes: that error still gets its line.
  process.kill(process.pid, 'SIGTERM');
  await stopUnderWay;
  process.stdout.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }));
} else if (control.startsWith('SIGTERM-then-')) {
  // The Web UI's quit, then another stop signal while the stop runs, such as
  // the terminal closing.
  process.kill(process.pid, 'SIGTERM');
  await stopUnderWay;
  process.kill(process.pid, control.slice('SIGTERM-then-'.length) as NodeJS.Signals);
  secondSignalSent();
} else {
  // A signal, as the Web UI's own quit sends SIGTERM (scheduleShutdown).
  process.kill(process.pid, control as NodeJS.Signals);
}
