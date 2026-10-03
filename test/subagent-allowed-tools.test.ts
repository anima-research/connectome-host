import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Agent, Module, ToolCall } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { SubagentModule } from '../src/modules/subagent-module.js';

const restricted = ['subagent--spawn', 'subagent--fork', 'probe--allowed'];

async function harness(allowedTools: 'all' | string[] = restricted, maxDepth = 3, maxRetries = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'sub-tools-'));
  const subagent = new SubagentModule({ parentAgentName: 'parent', defaultModel: 'mock', maxRetries, maxDepth });
  const probe = {
    name: 'probe', start: async () => {}, stop: async () => {},
    getTools: () => ['allowed', 'denied'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })),
    handleToolCall: async () => ({ success: true, data: 'inert' }),
  } as unknown as Module;
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new Membrane(new MockAdapter({ defaultResponse: 'ok', streamChunkDelayMs: 200 }), { formatter: new NativeFormatter() }),
    agents: [
      { name: 'parent', model: 'mock', systemPrompt: 'parent', allowedTools, maxTokens: 256 },
      { name: 'other', model: 'mock', systemPrompt: 'other', allowedTools: ['probe--denied'], maxTokens: 256 },
    ],
    modules: [subagent as unknown as Module, probe],
  });
  subagent.setFramework(framework);
  const realRun = framework.runEphemeralToCompletion.bind(framework);
  const captured: Agent[] = [];
  framework.runEphemeralToCompletion = async agent => {
    captured.push(agent);
    return { speech: 'done', toolCallsCount: 0 };
  };
  const call = (kind: 'spawn' | 'fork', tools?: string[], callerAgentName: string | undefined = 'parent') => subagent.handleToolCall({
    id: 'tc', name: kind, callerAgentName,
    input: { name: `worker-${captured.length}`, systemPrompt: 'inert worker', task: 'inspect tools', sync: true, ...(tools === undefined ? {} : { tools }) },
  } as unknown as ToolCall);
  return {
    framework, subagent, captured, realRun, call,
    cleanup: async () => { await framework.stop().catch(() => {}); rmSync(dir, { recursive: true, force: true }); },
  };
}

function visible(framework: AgentFramework, agent: Agent) {
  return framework.getAllTools().filter(tool => agent.canUseTool(tool.name)).map(tool => tool.name);
}

describe('subagent allowed-tools inheritance', () => {
  for (const scenario of [
    { kind: 'spawn' as const, tools: undefined, label: 'omitted spawn' },
    { kind: 'spawn' as const, tools: ['probe--allowed', 'probe--denied'], label: 'explicit widening spawn' },
    { kind: 'fork' as const, tools: undefined, label: 'fork' },
  ]) {
    test(scenario.label + ' preserves the operator restriction', async () => {
      const h = await harness();
      try {
        expect((await h.call(scenario.kind, scenario.tools)).success).toBe(true);
        const agent = h.captured[0];
        expect(visible(h.framework, agent)).toContain('probe--allowed');
        expect(visible(h.framework, agent)).not.toContain('probe--denied');
        expect(agent.canUseTool('probe--denied')).toBe(false);
        expect(agent.canUseTool('subagent--return')).toBe(true);
      } finally { await h.cleanup(); }
    });
  }

  test('empty explicit list and input arrays remain intact', async () => {
    const h = await harness();
    try {
      const empty: string[] = [];
      expect((await h.call('spawn', empty)).success).toBe(true);
      expect(h.captured[0].allowedTools).toEqual(['subagent--return']);
      expect(empty).toEqual([]);
      const tools = ['probe--allowed'];
      expect((await h.call('spawn', tools)).success).toBe(true);
      expect(h.captured[1].allowedTools).toEqual(['probe--allowed', 'subagent--return']);
      expect(tools).toEqual(['probe--allowed']);
      expect(h.framework.getAgent('parent')!.allowedTools).toEqual(restricted);
    } finally { await h.cleanup(); }
  });

  test('actual caller overrides configured parent; absent caller uses configured parent', async () => {
    const h = await harness();
    try {
      for (const kind of ['spawn', 'fork'] as const) {
        expect((await h.call(kind, undefined, 'other')).success).toBe(true);
        const agent = h.captured.at(-1)!;
        expect(agent.canUseTool('probe--allowed')).toBe(false);
        expect(agent.canUseTool('probe--denied')).toBe(true);
        // Omit identity rather than using the call helper's default.
        expect((await h.subagent.handleToolCall({ id: 'absent', name: kind, input: {
          name: `absent-${kind}`, task: 'inspect', systemPrompt: 'inert', sync: true,
        } } as ToolCall)).success).toBe(true);
        expect(h.captured.at(-1)!.canUseTool('probe--denied')).toBe(false);
      }
    } finally { await h.cleanup(); }
  });

  test('unresolved explicit identity fails closed', async () => {
    const h = await harness('all');
    try {
      for (const kind of ['spawn', 'fork'] as const) {
        expect((await h.call(kind, undefined, 'missing')).success).toBe(false);
        expect(h.captured).toHaveLength(0);
      }
    } finally { await h.cleanup(); }
  });

  for (const kind of ['spawn', 'fork'] as const) {
    for (const sync of [true, false]) {
      test(`${kind} unknown explicit caller fails before admission (sync=${sync})`, async () => {
        const h = await harness('all');
        try {
          const result = await h.subagent.handleToolCall({ id: 'unknown', name: kind, callerAgentName: 'missing', input: {
            name: 'unknown-worker', task: 'inspect', systemPrompt: 'inert', sync,
          } } as ToolCall);
          expect(result.success).toBe(false);
          expect(result.error).toContain('Cannot resolve subagent caller');
          expect(h.captured).toHaveLength(0);
          expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0, queued: 0 });
          const state = h.subagent as unknown as { asyncHandles: Map<string, unknown>; activeSubagents: Map<string, unknown>; parentMap: Map<string, unknown> };
          expect(state.asyncHandles.size).toBe(0);
          expect(state.activeSubagents.size).toBe(0);
          expect(state.parentMap.size).toBe(0);
        } finally { await h.cleanup(); }
      });
    }

    test(`${kind} queued acceptance survives ephemeral caller exit and permission mutation`, async () => {
      const h = await harness('all');
      let unblock!: () => void;
      let markStarted!: () => void;
      const started = new Promise<void>(resolve => { markStarted = resolve; });
      const blocked = new Promise<void>(resolve => { unblock = resolve; });
      let blocker!: Promise<unknown>;
      try {
        await h.framework.start();
        h.subagent.setConcurrency(1);
        h.framework.runEphemeralToCompletion = async agent => {
          h.captured.push(agent);
          if (h.captured.length === 1) { markStarted(); await blocked; }
          return { speech: 'done', toolCallsCount: 0 };
        };
        blocker = h.call('spawn');
        await started;
        expect(h.captured).toHaveLength(1);
        const caller = await h.framework.createEphemeralAgent({ name: `queue-caller-${kind}`, model: 'mock', systemPrompt: 'inert', allowedTools: [...restricted], maxTokens: 256 });
        const running = h.realRun(caller.agent, caller.contextManager);
        const tools = ['probe--allowed'];
        try {
          expect(h.framework.getAgent(caller.agent.name)).toBe(caller.agent);
          const accepted = await h.subagent.handleToolCall({ id: 'queued', name: kind, callerAgentName: caller.agent.name, input: {
            name: 'queued-worker', task: 'inspect', systemPrompt: 'inert', tools,
          } } as ToolCall);
          expect(accepted.success).toBe(true);
          expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 1, queued: 1 });
          const pending = (h.subagent as unknown as { asyncHandles: Map<string, { promise: Promise<unknown> }> }).asyncHandles.get('queued-worker')!.promise;
          // Observe rejection immediately so the red run has no unhandled promise.
          const settled = pending.then(() => null, error => error);
          if (caller.agent.allowedTools !== 'all') caller.agent.allowedTools.push('probe--denied');
          caller.agent.allowedTools = 'all';
          tools.push('probe--denied');
          await running;
          caller.cleanup();
          expect(h.framework.getAgent(caller.agent.name)).toBeNull();
          unblock();
          await blocker;
          expect(await settled).toBeNull();
          expect(h.captured).toHaveLength(2);
          expect(h.captured[1].canUseTool('probe--allowed')).toBe(true);
          expect(h.captured[1].canUseTool('probe--denied')).toBe(false);
          expect(h.captured[1].canUseTool('subagent--return')).toBe(true);
        } finally { await running; caller.cleanup(); }
      } finally { unblock(); await blocker?.catch(() => {}); await h.cleanup(); }
    });

    test(`${kind} retry reuses admission tools after ephemeral caller exit`, async () => {
      const h = await harness('all', 3, 1);
      try {
        await h.framework.start();
        const caller = await h.framework.createEphemeralAgent({ name: `retry-caller-${kind}`, model: 'mock', systemPrompt: 'inert', allowedTools: [...restricted], maxTokens: 256 });
        const running = h.realRun(caller.agent, caller.contextManager);
        const tools = ['probe--allowed'];
        h.framework.runEphemeralToCompletion = async agent => {
          h.captured.push(agent);
          if (h.captured.length === 1) {
            expect(agent.canUseTool('probe--denied')).toBe(false);
            // An attempt must not own the accepted array used by later attempts.
            if (agent.allowedTools !== 'all') agent.allowedTools.push('probe--denied');
            if (caller.agent.allowedTools !== 'all') caller.agent.allowedTools.push('probe--denied');
            caller.agent.allowedTools = 'all';
            tools.push('probe--denied');
            await running;
            caller.cleanup();
            throw new Error('ECONNRESET');
          }
          return { speech: 'done', toolCallsCount: 0 };
        };
        try {
          expect((await h.subagent.handleToolCall({ id: 'retry', name: kind, callerAgentName: caller.agent.name, input: {
            name: 'retry-worker', task: 'inspect', systemPrompt: 'inert', tools, sync: true,
          } } as ToolCall)).success).toBe(true);
          expect(h.framework.getAgent(caller.agent.name)).toBeNull();
          expect(h.captured).toHaveLength(2);
          expect(h.captured[1].canUseTool('probe--allowed')).toBe(true);
          expect(h.captured[1].canUseTool('probe--denied')).toBe(false);
        } finally { await running; caller.cleanup(); }
      } finally { await h.cleanup(); }
    }, 15_000);
  }

  test('unrestricted caller preserves all and explicit narrowing', async () => {
    const h = await harness('all');
    try {
      for (const kind of ['spawn', 'fork'] as const) {
        expect((await h.call(kind)).success).toBe(true);
        expect(h.captured.at(-1)!.allowedTools).toBe('all');
      }
      const tools = ['probe--denied', 'subagent--return'];
      expect((await h.call('spawn', tools)).success).toBe(true);
      expect(h.captured.at(-1)!.allowedTools).toEqual(tools);
      expect(tools).toEqual(['probe--denied', 'subagent--return']);
    } finally { await h.cleanup(); }
  });

  test('maxDepth filters inherited and explicit tools, preserving return', async () => {
    for (const allowedTools of [restricted, 'all'] as const) {
      const h = await harness(allowedTools === 'all' ? 'all' : [...allowedTools], 1);
      try {
        for (const kind of ['spawn', 'fork'] as const) {
          expect((await h.call(kind)).success).toBe(true);
          const agent = h.captured.at(-1)!;
          expect(agent.canUseTool('subagent--spawn')).toBe(false);
          expect(agent.canUseTool('subagent--fork')).toBe(false);
          expect(agent.canUseTool('subagent--return')).toBe(true);
          expect(agent.canUseTool('probe--denied')).toBe(allowedTools === 'all');
        }
        expect((await h.call('spawn', ['subagent--spawn', 'probe--allowed', 'probe--denied'])).success).toBe(true);
        expect(h.captured.at(-1)!.canUseTool('subagent--spawn')).toBe(false);
        expect(h.captured.at(-1)!.canUseTool('probe--denied')).toBe(allowedTools === 'all');
      } finally { await h.cleanup(); }
    }
  });

  test('running restricted ephemeral caller resolves through the real framework lookup', async () => {
    const h = await harness('all');
    try {
      await h.framework.start();
      const caller = await h.framework.createEphemeralAgent({ name: 'ephemeral-parent', model: 'mock', systemPrompt: 'inert', allowedTools: [...restricted], maxTokens: 256 });
      const running = h.realRun(caller.agent, caller.contextManager);
      expect(h.framework.getAgent(caller.agent.name)).toBe(caller.agent);
      try {
        for (const kind of ['spawn', 'fork'] as const) {
          expect((await h.call(kind, undefined, caller.agent.name)).success).toBe(true);
          expect(h.captured.at(-1)!.canUseTool('probe--denied')).toBe(false);
          expect(h.captured.at(-1)!.canUseTool('probe--allowed')).toBe(true);
        }
      } finally { await running; caller.cleanup(); }
    } finally { await h.cleanup(); }
  });
});
