import { readFileSync } from 'node:fs';
import { runHeadless } from '../src/headless.ts';
import type { AppContext } from '../src/index.ts';

const recipe = JSON.parse(readFileSync(process.argv[2]!, 'utf-8')) as { name: string; agent: { name: string } };

await runHeadless({
  recipe,
  framework: {
    getAllAgents: () => [{ name: recipe.agent.name, state: { status: 'idle' } }],
    getAllModules: () => [],
    getHostModeStatus: () => ({ drained: true, activeTurnAgents: [], parkedAdmissions: 0, gatedRequests: 0, backgroundScripts: 0 }),
    getQueueDepth: () => 0,
    onTrace: () => () => {},
    async stop() {},
  },
} as unknown as AppContext, process.argv.slice(2));
