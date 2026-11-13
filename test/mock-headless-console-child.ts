import { runHeadless } from '../src/headless.ts';
import type { AppContext } from '../src/index.ts';

// A headless host that says two console lines once it is up, as the host and
// agent-framework do ([fit], [mcpl], [inference-failed] …).
const running = runHeadless({
  recipe: { name: 'console-probe', agent: { name: 'agent' } },
  framework: {
    getAllAgents: () => [{ name: 'agent', state: { status: 'idle' } }],
    getAllModules: () => [],
    getHostModeStatus: () => ({ drained: true, activeTurnAgents: [], parkedAdmissions: 0, gatedRequests: 0, backgroundScripts: 0 }),
    getQueueDepth: () => 0,
    onTrace: () => () => {},
    async stop() {},
  },
} as unknown as AppContext, []);
setTimeout(() => {
  console.error('[probe] zz-console-error line %d', 1);
  console.warn('[probe] zz-console-warn line');
}, 100);
await running;
