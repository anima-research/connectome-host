import { captureBootConsole } from '../src/headless-boot-console.ts';
import { runHeadless } from '../src/headless.ts';
import type { AppContext } from '../src/index.ts';

// A headless host that says console lines while it boots, as agent-framework
// does when an MCPL server fails to connect, and two more once it is up, as
// the host and agent-framework do ([mcpl], [gate], [inference-failed] …).
// main() installs the capture once the data directory exists; this child does
// the same before its boot lines.
captureBootConsole();
console.error('Failed to connect MCPL server "zz-boot": connection refused');
console.error('[mcpl] server "zz-boot": tools/list failed: not connected');
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
  console.error('[mcpl] server "zz-boot": tools/list failed: still not connected');
}, 100);
await running;
