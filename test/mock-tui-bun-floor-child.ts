import { mock } from 'bun:test';
import * as core from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';

const watchdog = setTimeout(() => { process.stdout.write('TUI_ERROR timed out\n'); process.exit(2); }, 20000);
const [running] = process.argv.slice(2);
process.versions.bun = running!;
const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 100, height: 24, exitOnCtrlC: false });
mock.module('@opentui/core', () => ({ ...core, createCliRenderer: async () => renderer }));
const { runTui } = await import('../src/tui.js');

let ready!: () => void;
const initialized = new Promise<void>(resolve => { ready = resolve; });
const history = Array.from({ length: 50 }, (_, i) => ({
  participant: i % 2 === 0 ? 'user' : 'agent',
  content: [{ type: 'text', text: `history ${String(i + 1).padStart(2, '0')}` }],
}));
const app = {
  membrane: {},
  recipe: { name: 'bun-floor-test', agent: { name: 'agent' } },
  sessionManager: { getActiveSession: () => ({ id: 's1', name: 'saved' }) },
  framework: {
    getAllModules: () => [],
    getModule: () => undefined,
    getAgent: (name: string) => name === 'agent'
      ? { name, state: { status: 'idle' }, getContextManager: () => ({ getAllMessages: () => history }) }
      : undefined,
    onTrace: () => { ready(); return () => {}; },
    offTrace: () => {},
    stop: async () => {},
  },
} as unknown as Parameters<typeof runTui>[0];

void runTui(app).catch((error: unknown) => {
  process.stdout.write(`TUI_ERROR ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
await initialized;
await renderOnce();
clearTimeout(watchdog);
process.stdout.write(`TUI_FRAME ${JSON.stringify(captureCharFrame())}\n`);
process.exit(0);
