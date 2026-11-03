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
// agent-framework keeps a stop under way, and a successful one, for a later
// stop() call.
let stopCalls = 0;
let switchedStopCalls = 0;
let traceDetached = 0;
let followedAfterStop = 0;
let detachedAtStop: number | null = null;
let switchedDetachedAtStop: number | null = null;
let serverStops = 0;
let stopSignalled = false;
let activeAfterStop = 0;
let modulesReadAfterStop = 0;
let settledBeforeSwitch: boolean | null = null;
let unhandled = false;
let ready!: () => void;
const initialized = new Promise<void>(resolve => { ready = resolve; });
let stopStarted!: () => void;
const stopUnderWay = new Promise<void>(resolve => { stopStarted = resolve; });
process.on('unhandledRejection', () => { unhandled = true; });
let secondSignalSent!: () => void;
const secondSent = new Promise<void>(resolve => { secondSignalSent = resolve; });
let commandStarted!: () => void;
const commandUnderWay = new Promise<void>(resolve => { commandStarted = resolve; });
let errorEmitted!: () => void;
const errorDuringStop = new Promise<void>(resolve => { errorEmitted = resolve; });

function mockFramework(body: () => Promise<void>) {
  let stopping: Promise<void> | undefined;
  return {
    getAllModules: () => { if (stopSignalled) modulesReadAfterStop++; return []; },
    getModule: () => undefined,
    getAgent: () => undefined,
    getAllAgents: () => [{ name: 'agent' }],
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
  if (mode === 'slow') await (control.startsWith('SIGTERM-then-') ? secondSent.then(() => sleep(2000)) : errorDuringStop);
  if (mode === 'failure' || mode === 'delayed-failure') throw failure;
});
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
  // A turn of the timers first, so an unhandled rejection the settlement leaves
  // is reported before the receipt.
  await sleep(20);
  process.stdout.write(`TUI_RESULT ${JSON.stringify({
    status, stopCalls, switchedStopCalls, traceDetached, followedAfterStop, detachedAtStop, switchedDetachedAtStop,
    serverStops, activeAfterStop, modulesReadAfterStop, settledBeforeSwitch,
    destroyed: renderer.isDestroyed, unhandled, originalError: error === failure,
  })}\n`);
  if (status === 'rejected') console.error('Fatal error:', error);
  process.exit(status === 'fulfilled' ? 0 : status === 'rejected' ? 1 : 2);
}

function lingerThenSignal(): void {
  setTimeout(() => process.exit(3), 20_000);
  process.stdout.write('TUI_SETTLED\n');
  process.kill(process.pid, 'SIGTERM');
}

function lateError(): void {
  process.stdout.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }));
  void finish('fulfilled');
}

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
    else if (control === 'exit-at-once') { console.error('Fatal error:', error); process.exit(1); }
    else void finish('rejected', error);
  },
);
await initialized;
if (control === 'ctrl-c') {
  mockInput.pressCtrlC();
} else if (control === 'quit' || control === 'detach-throws' || control === 'linger' || control === 'late-error') {
  await mockInput.typeText('/quit');
  mockInput.pressEnter();
} else if (control === 'stdout-error' || control === 'stdin-error') {
  // A terminal can fail with no signal, as a write to a pseudo-terminal whose
  // other end has closed does.
  const stream = control === 'stdout-error' ? process.stdout : process.stdin;
  stream.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }));
} else if (control === 'two-errors') {
  process.stdin.emit('error', Object.assign(new Error('setRawMode failed with errno: 5'), { code: 'EIO' }));
  process.stdout.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }));
} else if (control === 'title-throws' || control === 'exit-at-once') {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (chunk === '\x1b]0;\x07') throw new Error('injected title write failure');
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  await mockInput.typeText('/quit');
  mockInput.pressEnter();
} else if (control === 'switch') {
  await mockInput.typeText('/session switch other');
  mockInput.pressEnter();
  await switchUnderWay;
  stopSignalled = true;
  process.kill(process.pid, 'SIGTERM');
} else if (control === 'late-command') {
  await mockInput.typeText('/puppet late_tool');
  mockInput.pressEnter();
  await commandUnderWay;
  process.kill(process.pid, 'SIGTERM');
} else if (control === 'error-during-stop') {
  process.kill(process.pid, 'SIGTERM');
  await stopUnderWay;
  process.stdout.emit('error', Object.assign(new Error('write EIO'), { code: 'EIO' }));
  errorEmitted();
} else if (control.startsWith('SIGTERM-then-')) {
  process.kill(process.pid, 'SIGTERM');
  await stopUnderWay;
  process.kill(process.pid, control.slice('SIGTERM-then-'.length) as NodeJS.Signals);
  secondSignalSent();
} else {
  process.kill(process.pid, control as NodeJS.Signals);
}
