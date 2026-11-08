import { describe, test, expect } from 'bun:test';
import type { Module, ToolCall } from '@animalabs/agent-framework';
import { bootPresentedHost, until, modelOf, type PresentedHost } from './presented-host.js';
import { SubagentModule } from '../src/modules/subagent-module.js';

async function boot(): Promise<{ h: PresentedHost; subagent: SubagentModule }> {
  const subagent = new SubagentModule({ provider: 'mock', parentAgentName: 'parent', defaultModel: modelOf('sub'), maxRetries: 0 });
  const h = await bootPresentedHost({ agents: ['parent'], modules: [subagent as unknown as Module], prefix: 'subagent-wake-' });
  subagent.setFramework(h.framework);
  return { h, subagent };
}

const spawnAsync = (subagent: SubagentModule, name: string) =>
  subagent.handleToolCall({ id: `call-${name}`, name: 'spawn', input: { name, systemPrompt: 'p', task: 'answer' }, callerAgentName: 'parent' } as unknown as ToolCall);

const resultStored = (h: PresentedHost) => () => h.framework.getAgent('parent')!.getContextManager().getAllMessages()
  .some((m) => (m.metadata as { kind?: string } | undefined)?.kind === 'agent-result');

async function atRest(h: PresentedHost): Promise<void> {
  const pending = () => (h.framework as unknown as { pendingRequests: Array<{ agentName: string }> }).pendingRequests
    .filter((r) => r.agentName === 'parent').length;
  for (;;) {
    await h.settled('parent');
    const calls = h.adapter.callsFor('parent');
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (pending() === 0 && h.adapter.callsFor('parent') === calls && h.framework.getAgent('parent')!.state.status === 'idle') return;
  }
}

describe("an async subagent's result by its message route", () => {
  test('read within the turn it arrived in, at a tool boundary, starts no turn after that one', async () => {
    const { h, subagent } = await boot();
    try {
      h.adapter.script('parent', { wait: 'g' }, { text: 'answered' });
      const nudged = h.framework.nudgeAgent('parent', 'test');
      expect(nudged.ok).toBe(true);
      await until(() => h.gates.entered.has('g'), 'the gate call');
      expect((await spawnAsync(subagent, 'scout')).success).toBe(true);
      await until(resultStored(h), 'the result stored for the launcher');
      h.gates.release('g');
      await atRest(h);
      expect(h.adapter.wireOf('parent')[1]).toContain("[Subagent 'scout' returned]");
      expect(h.adapter.callsFor('parent')).toBe(2);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('for an idle launcher, wakes it once, with the result', async () => {
    const { h, subagent } = await boot();
    try {
      expect((await spawnAsync(subagent, 'scout')).success).toBe(true);
      await until(() => h.adapter.callsFor('parent') > 0, "the launcher's turn");
      await atRest(h);
      expect(h.adapter.callsFor('parent')).toBe(1);
      expect(h.adapter.wireOf('parent')[0]).toContain("[Subagent 'scout' returned]");
    } finally { await h.cleanup(); }
  }, 20_000);
});
