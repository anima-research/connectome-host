import { mock } from 'bun:test';
import * as core from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';

const [mode, control] = process.argv.slice(2);
const { renderer, mockInput } = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false });
mock.module('@opentui/core', () => ({ ...core, createCliRenderer: async () => renderer }));
const { runTui } = await import('../src/tui.js');

const failure = new AggregateError([new Error('injected Fleet cleanup failure')], 'Fleet shutdown failed');
let stopCalls = 0;
let traceDetached = 0;
let destroyCalls = 0;
let unhandled = false;
let ready!: () => void;
const initialized = new Promise<void>(resolve => { ready = resolve; });
const originalDestroy = renderer.destroy.bind(renderer);
renderer.destroy = () => { destroyCalls++; originalDestroy(); };
process.on('unhandledRejection', () => { unhandled = true; });

const app = {
  membrane: {},
  recipe: { name: 'tui-shutdown-test', agent: { name: 'agent' } },
  sessionManager: { getActiveSession: () => null },
  framework: {
    getAllModules: () => [],
    getModule: () => undefined,
    getAgent: () => undefined,
    onTrace: () => ready(),
    offTrace: () => { traceDetached++; },
    stop: async () => {
      stopCalls++;
      if (mode === 'delayed-failure') await new Promise(resolve => setTimeout(resolve, 25));
      if (mode !== 'healthy') throw failure;
    },
  },
} as unknown as Parameters<typeof runTui>[0];

function finish(status: string, error?: unknown): void {
  process.stdout.write(`TUI_RESULT ${JSON.stringify({ status, stopCalls, traceDetached, destroyCalls, unhandled, originalError: error === failure })}\n`);
  if (status === 'rejected') console.error('Fatal error:', error);
  process.exit(status === 'fulfilled' ? 0 : status === 'rejected' ? 1 : 2);
}

const watchdog = setTimeout(() => finish('timed-out'), 2000);
void runTui(app).then(
  () => { clearTimeout(watchdog); finish('fulfilled'); },
  error => { clearTimeout(watchdog); finish('rejected', error); },
);
await initialized;
if (control === 'ctrl-c') {
  mockInput.pressCtrlC();
} else {
  await mockInput.typeText('/quit');
  mockInput.pressEnter();
}
