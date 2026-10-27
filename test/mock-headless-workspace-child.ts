import { runHeadless } from '../src/headless.js';
import type { AppContext } from '../src/index.js';
import { readResultShapes } from './workspace-read-shapes.js';

const shape = process.env.READ_SHAPE as keyof typeof readResultShapes;
const result = readResultShapes[shape];
if (!result) throw new Error(`READ_SHAPE must name one of: ${Object.keys(readResultShapes).join(', ')}`);

await runHeadless({
  recipe: { name: 'workspace-viewer-test', agent: { name: 'fixture' } },
  agentName: 'fixture',
  framework: {
    getAllAgents: () => [{ name: 'fixture', state: { status: 'idle' } }],
    getAllModules: () => [{ name: 'workspace', handleToolCall: async () => result }],
    onTrace: () => {},
    stop: async () => {},
  },
} as unknown as AppContext);
