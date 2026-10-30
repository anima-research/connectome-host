import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework, type Module } from '@animalabs/agent-framework';
import { Membrane, MockAdapter } from '@animalabs/membrane';
import { runHeadless } from '../src/headless.js';
import type { AppContext } from '../src/index.js';
import { TuiModule } from '../src/modules/tui-module.js';

const dir = process.env.DATA_DIR!;
const textOf = (content: Array<{ text?: string }>): string => content.map((b) => b.text ?? '').join('');

const holdsTurnOne = {
  name: 'holds-turn-one',
  async start(): Promise<void> {},
  async stop(): Promise<void> {},
  getTools: () => [],
  async handleToolCall() { return { success: true, data: '' }; },
  async onProcess() { return {}; },
  async onSpeechRouted(_agentName: string, text: string): Promise<void> {
    if (text !== 'Reply one.') return;
    writeFileSync(join(dir, 'asked-one'), '');
    while (!existsSync(join(dir, 'release'))) await new Promise((resolve) => setTimeout(resolve, 10));
  },
};

class TakesTexts extends TuiModule {
  override async onProcess(...args: Parameters<TuiModule['onProcess']>): ReturnType<TuiModule['onProcess']> {
    if ((args[0] as { content?: unknown }).content === 'second') writeFileSync(join(dir, 'taken-second'), '');
    return super.onProcess(...args);
  }
}

// CHILD_MODE=wake: a turn no surface opens, woken once `wake` exists.
const wakeMode = process.env.CHILD_MODE === 'wake';
const adapter = new MockAdapter();
adapter.queueResponses(wakeMode ? ['Woken reply.'] : ['Reply one.', 'Reply two.']);
const framework = await AgentFramework.create({
  storePath: join(dir, 'store.chronicle'),
  membrane: new Membrane(adapter),
  agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'Resident.', proseRouting: 'locus' }],
  modules: [new TakesTexts(), holdsTurnOne as unknown as Module],
});
let starts = 0;
framework.onTrace((event) => {
  if (event.type === 'inference:started') writeFileSync(join(dir, 'starts'), String(++starts));
});
await framework.start();
await (framework as unknown as { initializeMcpl(servers: []): Promise<void> }).initializeMcpl([]);

setInterval(() => {
  const texts = framework.getAgent('resident')!.getContextManager().getAllMessages()
    .map((m) => textOf(m.content as Array<{ text?: string }>));
  writeFileSync(join(dir, 'context.json.tmp'), JSON.stringify(texts));
  renameSync(join(dir, 'context.json.tmp'), join(dir, 'context.json'));
}, 50);

if (wakeMode) {
  const poll = setInterval(() => {
    if (!existsSync(join(dir, 'wake'))) return;
    clearInterval(poll);
    framework.pushEvent({ type: 'external-message', source: 'system', content: 'a system wake', metadata: {} } as never);
  }, 20);
}

await runHeadless({
  recipe: { name: 'framework-answer-test', agent: { name: 'resident' } },
  agentName: 'resident',
  framework,
} as unknown as AppContext);
