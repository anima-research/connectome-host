import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runHeadless } from '../src/headless.ts';
import type { AppContext } from '../src/index.ts';
import { switchSessionSteps } from '../src/session-switch.ts';

const dir = process.env.DATA_DIR!;
const mark = (name: string): void => writeFileSync(join(dir, name), String(Date.now()));
const order = (what: string): void => appendFileSync(join(dir, 'order'), `${what}\n`);
const written = async (name: string): Promise<void> => {
  while (!existsSync(join(dir, name))) await Bun.sleep(10);
};

const framework = (name: string) => ({
  getAllAgents: () => [{ name: 'fixture', state: { status: 'idle' } }],
  getAllModules: () => [],
  getHostModeStatus: () => ({ drained: true, activeTurnAgents: [], parkedAdmissions: 0, gatedRequests: 0, backgroundScripts: 0 }),
  getQueueDepth: () => 0,
  onTrace: () => () => {},
  start(): void {
    mark(`started-${name}`);
  },
  async stop(): Promise<void> {
    order(`stop ${name}`);
    mark(`stopping-${name}`);
    if (name === 'first') await written('stop-go');
    if (name === 'next' && process.env.FIXTURE_NEXT_STOP === 'fail') throw new Error('the next framework\'s stop failed');
    mark(`stopped-${name}`);
  },
});

const sessions = new Map([['s1', { id: 's1', name: 'first' }]]);
let active = 's1';
const sessionManager = {
  createSession: (name?: string) => {
    mark(`created-${name ?? 'unnamed'}`);
    const session = { id: `s${sessions.size + 1}`, name: name ?? 'unnamed' };
    sessions.set(session.id, session);
    return session;
  },
  getActiveSession: () => sessions.get(active) ?? null,
  setActiveSession: (id: string) => { active = id; },
};

const app: Record<string, unknown> & { framework: ReturnType<typeof framework>; onFrameworkReplaced?: () => void } = {
  recipe: { name: 'switch-stop-test', agent: { name: 'fixture' } },
  agentName: 'fixture',
  framework: framework('first'),
  sessionManager,
  branchState: { checkpoints: new Map(), undoStack: [], redoStack: [] },
  switchSession: (id: string) => switchSessionSteps(app as { stopping?: boolean; switching?: boolean }, {
    stopOld: async () => {},
    make: async () => {
      mark('making');
      if (process.env.FIXTURE_MAKE === 'on-stop') await new Promise<void>((resolve) => { process.once('SIGTERM', () => resolve()); });
      else await written('make-go');
      order('make settled');
      if (process.env.FIXTURE_MAKE === 'fail') throw new Error('making the next framework failed');
      sessionManager.setActiveSession(id);
      return framework('next');
    },
    install: async (next) => {
      app.framework = next;
      app.onFrameworkReplaced?.();
      next.start();
      if (process.env.FIXTURE_INSTALL === 'held') {
        mark('installing');
        await written('install-go');
      }
    },
    stopServer: async () => {},
  }),
};

await runHeadless(app as unknown as AppContext);
