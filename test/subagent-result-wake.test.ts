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

function failingSubagents(h: PresentedHost): void {
  const stream = h.adapter.stream.bind(h.adapter);
  h.adapter.stream = async (req, cb) => {
    if (req.model === modelOf('sub')) throw new Error('the provider refused the request');
    return stream(req, cb);
  };
}

function wakesWeighed(h: PresentedHost): Array<{ source: string; readsRow: boolean }> {
  const wakes: Array<{ source: string; readsRow: boolean }> = [];
  const fw = h.framework as unknown as { inferencePolicy: { shouldInfer: (agent: string, requests: Array<{ source: string; readsRow?: string }>, state: unknown) => boolean } };
  const shouldInfer = fw.inferencePolicy.shouldInfer.bind(fw.inferencePolicy);
  fw.inferencePolicy.shouldInfer = (agent, requests, state) => {
    if (agent === 'parent') for (const r of requests) wakes.push({ source: r.source, readsRow: r.readsRow !== undefined });
    return shouldInfer(agent, requests, state);
  };
  return wakes;
}

const spawnAsync = (subagent: SubagentModule, name: string) =>
  subagent.handleToolCall({ id: `call-${name}`, name: 'spawn', input: { name, systemPrompt: 'p', task: 'answer' }, callerAgentName: 'parent' } as unknown as ToolCall);

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
      await until(() => h.rowWith('parent', "[Subagent 'scout' returned]") !== undefined, 'the result stored for the launcher');
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

describe("an async subagent's failure by its message route", () => {
  test('read within the turn it arrived in, at a tool boundary, starts no turn after that one', async () => {
    const { h, subagent } = await boot();
    try {
      failingSubagents(h);
      const wakes = wakesWeighed(h);
      h.adapter.script('parent', { wait: 'g' }, { text: 'answered' });
      const nudged = h.framework.nudgeAgent('parent', 'test');
      expect(nudged.ok).toBe(true);
      await until(() => h.gates.entered.has('g'), 'the gate call');
      expect((await spawnAsync(subagent, 'scout')).success).toBe(true);
      await until(() => h.rowWith('parent', "[Subagent 'scout' failed]") !== undefined, 'the failure stored for the launcher');
      h.gates.release('g');
      await atRest(h);
      expect(h.adapter.wireOf('parent')[1]).toContain("[Subagent 'scout' failed]");
      expect(wakes.filter((w) => w.source === 'subagent' && !w.readsRow)).toEqual([]);
      expect(h.adapter.callsFor('parent')).toBe(2);
    } finally { await h.cleanup(); }
  }, 20_000);

  test('for an idle launcher, wakes it once, with the failure', async () => {
    const { h, subagent } = await boot();
    try {
      failingSubagents(h);
      expect((await spawnAsync(subagent, 'scout')).success).toBe(true);
      await until(() => h.adapter.callsFor('parent') > 0, "the launcher's turn");
      await atRest(h);
      expect(h.adapter.callsFor('parent')).toBe(1);
      expect(h.adapter.wireOf('parent')[0]).toContain("[Subagent 'scout' failed]");
    } finally { await h.cleanup(); }
  }, 20_000);
});
