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

describe("a synchronous subagent's failure after it was detached from its caller", () => {
  test('reaches an idle launcher once, from the run, with no wake of the host\'s own', async () => {
    const { h, subagent } = await boot();
    try {
      let fail!: () => void;
      const failing = new Promise<void>((resolve) => { fail = resolve; });
      const stream = h.adapter.stream.bind(h.adapter);
      h.adapter.stream = async (req, cb) => {
        if (req.model === modelOf('sub')) {
          await failing;
          throw new Error('the provider refused the request');
        }
        return stream(req, cb);
      };
      const wakes = wakesWeighed(h);
      const launched = await subagent.handleToolCall({
        id: 'call-scout', name: 'spawn', callerAgentName: 'parent',
        input: { name: 'scout', systemPrompt: 'p', task: 'answer', sync: true, timeoutMs: 100 },
      } as unknown as ToolCall);
      expect(launched.success).toBe(true);
      fail();
      await until(() => h.rowWith('parent', "[Subagent 'scout' failed]") !== undefined, 'the failure stored for the launcher');
      await atRest(h);
      const run = h.framework.listAgents({ includeEnded: true }).find((record) => record.name.startsWith('spawn-scout-'))!;
      expect(run.relationships.resultTo).toEqual({ to: 'parent', as: 'tool-result' });
      const rows = h.framework.getAgent('parent')!.getContextManager().getAllMessages()
        .filter((m) => m.content.some((b) => (b as { text?: string }).text?.startsWith("[Subagent 'scout' failed]")));
      expect(rows).toHaveLength(1);
      expect((rows[0]!.metadata as { hostNote?: string } | undefined)?.hostNote).toBeUndefined();
      expect(wakes.filter((w) => w.source === 'subagent' && !w.readsRow)).toEqual([]);
      expect(h.adapter.callsFor('parent')).toBe(1);
      expect(h.adapter.wireOf('parent')[0]).toContain("[Subagent 'scout' failed]");
    } finally { await h.cleanup(); }
  }, 20_000);
});
