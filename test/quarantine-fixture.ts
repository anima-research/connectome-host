/** Private fake stores/providers only. No framework start and no real adapter. */
import { AgentFramework } from '@animalabs/agent-framework';
import { AutobiographicalStrategy, PassthroughStrategy } from '@animalabs/context-manager';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppContext } from '../src/index.js';
import { QuarantineOperator, waiverConfirmation } from '../src/quarantine-operator.js';
import { randomUUID } from 'node:crypto';

export async function fixture(dir = mkdtempSync(join(tmpdir(), 'host-keyed-'))) {
  const strategy = new AutobiographicalStrategy({ compressionModel: 'fake-model', targetChunkTokens: 100,
    recentWindowTokens: 0, headWindowTokens: 0, autoTickOnNewMessage: false, minChunkCharsForLLM: 0,
    mergeThreshold: 99, compressionRefusalCurveFallbacks: 0, quarantineAlarmIntervalMs: 3_600_000 });
  const membrane = new Membrane(new MockAdapter(), { formatter: new NativeFormatter() });
  let calls = 0;
  let response = 'refusal';
  membrane.complete = async () => {
    calls++;
    return { content: response === 'refusal' ? [] : [{ type: 'text', text: 'The synthetic conversation discussed implementation and tests.' }],
      stopReason: response, usage: { inputTokens: 100, outputTokens: response === 'refusal' ? 0 : 20 } } as never;
  };
  const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane, modules: [],
    agents: [{ name: 'selected', model: 'fake', systemPrompt: 'unused', strategy },
      { name: 'other', model: 'fake', systemPrompt: 'unused', strategy: new PassthroughStrategy() }] });
  const agent = framework.getAgent('selected')!;
  const manager = agent.getContextManager();
  for (let i = 0; i < 16; i++) manager.presentRows([manager.addMessage(i % 2 ? 'Claude' : 'User',
    [{ type: 'text', text: `synthetic ${i} ${'substantive '.repeat(12)}` }])]);
  await manager.compile();
  await manager.tick();
  const app = { framework, recipe: { name: 'private fake', agent: { name: 'selected' } }, agentName: 'selected' } as AppContext;
  const operator = new QuarantineOperator(app, dir);
  return { dir, strategy, framework, manager, app, operator, calls: () => calls,
    answer: (value: string) => { response = value; },
    async close() { operator.close(); await app.framework.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

export async function selection(operator: QuarantineOperator, operation = randomUUID()) {
  const view = await operator.handle({ type: 'quarantine-inspect', agent: 'selected' });
  if (view.status !== 'ok') throw new Error(JSON.stringify(view));
  const record = (view.records as Array<{key: string; generation: string}>)[0]!;
  if (!record) throw new Error('no native quarantine record');
  const cmd = { type: 'quarantine-release' as const, agent: 'selected', key: record.key, generation: record.generation,
    selection: String(view.selection), operation, confirmation: '' };
  cmd.confirmation = waiverConfirmation(cmd.agent, cmd.key, cmd.generation, cmd.selection, cmd.operation);
  return cmd;
}
