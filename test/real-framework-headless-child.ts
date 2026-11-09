import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { runHeadless } from '../src/headless.ts';
import type { AppContext } from '../src/index.ts';

const dataDir = process.env.DATA_DIR!;
const heldProcessing = {
  name: 'held-processing',
  async start() {},
  async stop() {},
  getTools: () => [],
  async handleToolCall() { return { success: false, error: 'no tools' }; },
  async onProcess(event: { type: string }) {
    if (event.type !== 'external-message') return {};
    await Bun.sleep(900);
    writeFileSync(join(dataDir, 'processed-at'), String(Date.now()));
    return {};
  },
};
const framework = await AgentFramework.create({
  storePath: join(dataDir, 'store'),
  membrane: new Membrane(new MockAdapter({ defaultResponse: 'heard' }), { formatter: new NativeFormatter() }),
  agents: [{ name: 'resident', model: 'mock', systemPrompt: 'test', maxTokens: 64 }],
  modules: [heldProcessing as never],
});
framework.start();
await runHeadless({
  recipe: { name: 'Real framework test', agent: { name: 'resident' } },
  agentName: 'resident',
  framework,
} as unknown as AppContext);
