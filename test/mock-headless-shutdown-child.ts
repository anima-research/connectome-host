import { runHeadless } from '../src/headless.ts';
import type { AppContext } from '../src/index.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2];
if (!['healthy', 'failure', 'delayed-failure'].includes(mode)) throw new Error('Unknown shutdown fixture mode');
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
      if (mode !== 'healthy') throw new Error('injected framework stop failure');
    },
  },
} as unknown as AppContext);
