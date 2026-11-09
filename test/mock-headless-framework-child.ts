import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework, type Module } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { runHeadless } from '../src/headless.js';
import { SurfaceAnswers } from '../src/surfaces.js';
import type { AppContext } from '../src/index.js';
import { TuiModule } from '../src/modules/tui-module.js';

const dir = process.env.DATA_DIR!;
const textOf = (content: Array<{ text?: string }>): string => content.map((b) => b.text ?? '').join('');

const surfaces = new SurfaceAnswers();

const looks = {
  name: 'looks',
  async start(): Promise<void> {},
  async stop(): Promise<void> {},
  getTools: () => [{ name: 'look', description: 'Look.', inputSchema: { type: 'object', properties: {} } }],
  async handleToolCall() { return { success: true, data: 'seen' }; },
  async onProcess() { return {}; },
};

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
const look = (id: string): Block => ({ type: 'tool_use', id, name: 'looks--look', input: {} });
const ROUNDS: Record<string, Block[][]> = {
  notes: [
    [{ type: 'text', text: 'First note.' }, look('look-1')],
    [{ type: 'text', text: 'Second note.' }, look('look-2')],
    [{ type: 'text', text: 'The reply.' }],
  ],
  kept: [[{ type: 'text', text: 'Kept words.' }, { type: 'tool_use', id: 'skip-1', name: 'skip_reply', input: {} }]],
};

class RoundsAdapter extends MockAdapter {
  private calls = 0;
  constructor(private readonly rounds: Block[][]) { super(); }
  override async stream(...[request, callbacks]: Parameters<MockAdapter['stream']>): ReturnType<MockAdapter['stream']> {
    const blocks = this.rounds[Math.min(this.calls++, this.rounds.length - 1)]!;
    for (const block of blocks) if (block.type === 'text') callbacks.onChunk(block.text);
    return {
      content: [...blocks],
      stopReason: blocks.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
      model: request.model,
      rawRequest: request,
      raw: {},
    } as Awaited<ReturnType<MockAdapter['stream']>>;
  }
}

const mode = process.env.CHILD_MODE;
const wakeMode = mode === 'wake';
const rounds = mode ? ROUNDS[mode] : undefined;
const adapter = rounds ? new RoundsAdapter(rounds) : new MockAdapter();
if (!rounds) adapter.queueResponses(['Woken reply.']);
const framework = await AgentFramework.create({
  storePath: join(dir, 'store.chronicle'),
  membrane: new Membrane(adapter, rounds ? { formatter: new NativeFormatter() } : undefined),
  agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'Resident.', proseRouting: 'locus' }],
  modules: [new TuiModule(surfaces), ...(rounds ? [looks as unknown as Module] : [])],
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
  surfaces,
  recipe: { name: 'framework-answer-test', agent: { name: 'resident' } },
  agentName: 'resident',
  framework,
} as unknown as AppContext);
