import { runHeadless } from '../src/headless.ts';
import type { AppContext } from '../src/index.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from 'node:net';

const mode = process.argv[2];
if (!['healthy', 'failure', 'delayed-failure', 'ready-window'].includes(mode)) throw new Error('Unknown shutdown fixture mode');
// A live socket can accept a client before runHeadless resumes after listen.
// Delay only the listen callback so the ready-to-command contract is decisive.
if (mode === 'ready-window') {
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (this: Server, ...args: any[]) {
    const callback = args.at(-1);
    if (typeof callback === 'function') args[args.length - 1] = () => setTimeout(callback, 200);
    return listen.apply(this, args as Parameters<typeof listen>);
  } as typeof listen;
}
let stopCalls = 0;
await runHeadless({
  recipe: { name: 'Shutdown test', agent: { name: 'fixture' } },
  agentName: 'fixture',
  framework: {
    getAllAgents: () => [{ name: 'fixture', state: { status: 'idle' } }],
    onTrace: () => () => {},
    async stop() {
      stopCalls++;
      if (mode === 'delayed-failure') await new Promise(resolve => setTimeout(resolve, 100));
      writeFileSync(join(process.env.DATA_DIR!, 'stop-calls.json'), JSON.stringify({ stopCalls }));
      if (mode === 'failure' || mode === 'delayed-failure') throw new Error('injected framework stop failure');
    },
  },
} as unknown as AppContext);
