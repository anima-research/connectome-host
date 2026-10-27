import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module, ToolCall } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { SubagentModule } from '../src/modules/subagent-module.js';

async function makeHarness(opts: { maxExecutionMs: number; subagentRunMs: number }) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sub-timeout-'));
  const adapter = new MockAdapter({ defaultResponse: 'ok' });
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
  const subagent = new SubagentModule({
    provider: 'mock',
    parentAgentName: 'parent',
    defaultModel: 'mock',
    defaultMaxTokens: 256,
    maxExecutionMs: opts.maxExecutionMs,
    maxRetries: 0,
  });
  const framework = await AgentFramework.create({
    storePath: join(tmpDir, 'store'),
    membrane,
    agents: [{
      name: 'parent',
      model: 'mock',
      systemPrompt: 'parent',
      maxTokens: 256,
    }],
    modules: [subagent as unknown as Module],
  });

  const fw = framework as unknown as {
    runEphemeralToCompletion: (
      agent: unknown,
      ctxMgr: unknown,
    ) => Promise<{ speech: string; toolCallsCount: number }>;
    agents: Map<string, unknown>;
  };
  fw.runEphemeralToCompletion = (agent: unknown) => {
    // agent-framework's runEphemeralToCompletion registers the agent in its
    // agents map while it runs.
    const a = agent as { name: string };
    fw.agents.set(a.name, agent);
    return new Promise((resolve) => {
      setTimeout(() => {
        fw.agents.delete(a.name);
        resolve({ speech: 'ok', toolCallsCount: 0 });
      }, opts.subagentRunMs);
    });
  };

  subagent.setFramework(framework);
  framework.start();

  return {
    framework,
    subagent,
    cleanup: async () => {
      try { await framework.stop(); } catch { }
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { }
    },
  };
}

function makeToolCall(name: string, input: Record<string, unknown>): ToolCall {
  return {
    id: `test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    input,
    callerAgentName: 'parent',
  };
}

type InternalSubagent = SubagentModule & {
  asyncHandles: Map<string, { promise: Promise<unknown> }>;
};

async function makeBudgetHarness(opts: {
  parentMaxTokens: number;
  moduleDefaultMaxTokens?: number;
}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sub-budget-'));
  const adapter = new MockAdapter({ defaultResponse: 'ok' });
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
  const subagent = new SubagentModule({
    provider: 'mock',
    parentAgentName: 'parent',
    defaultModel: 'mock',
    defaultMaxTokens: opts.moduleDefaultMaxTokens,
    maxRetries: 0,
  });
  const framework = await AgentFramework.create({
    storePath: join(tmpDir, 'store'),
    membrane,
    agents: [{
      name: 'parent',
      model: 'mock',
      systemPrompt: 'parent',
      maxTokens: opts.parentMaxTokens,
    }],
    modules: [subagent as unknown as Module],
  });

  const captured: Array<{ name: string; maxTokens: number }> = [];
  const fw = framework as unknown as {
    createEphemeralAgent: (config: { name: string; maxTokens: number; [k: string]: unknown }) => Promise<{
      agent: { name: string; maxTokens: number };
      contextManager: { addMessage: (...a: unknown[]) => void; compile: () => Promise<{ messages: unknown[] }> };
      cleanup: () => void;
    }>;
    runEphemeralToCompletion: (agent: unknown, cm: unknown) => Promise<{ speech: string; toolCallsCount: number }>;
    getAllTools: () => Array<{ name: string }>;
    agents: Map<string, unknown>;
  };
  const originalCreate = fw.createEphemeralAgent.bind(fw);
  fw.createEphemeralAgent = async (config) => {
    captured.push({ name: config.name, maxTokens: config.maxTokens });
    return originalCreate(config);
  };
  fw.runEphemeralToCompletion = (agent: unknown) => {
    const a = agent as { name: string };
    fw.agents.set(a.name, agent);
    return new Promise((resolve) => setTimeout(() => {
      fw.agents.delete(a.name);
      resolve({ speech: 'ok', toolCallsCount: 0 });
    }, 20));
  };

  subagent.setFramework(framework);
  framework.start();

  return {
    framework,
    subagent,
    captured,
    cleanup: async () => {
      try { await framework.stop(); } catch { }
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { }
    },
  };
}

describe('SubagentModule timeout behaviour (async vs sync default)', () => {
  test('ASYNC spawn, no explicit timeoutMs, subagent runs longer than maxExecutionMs', async () => {
    const MAX_EXEC = 1_000;
    const SUBAGENT_WORK = 3_000;
    const { subagent, cleanup } = await makeHarness({
      maxExecutionMs: MAX_EXEC,
      subagentRunMs: SUBAGENT_WORK,
    });
    try {
      const t0 = Date.now();
      const ack = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'async-slowpoke',
        systemPrompt: 'you are a test subagent',
        task: 'reply',
      }));
      expect(ack.success).toBe(true);
      const ackElapsed = Date.now() - t0;
      expect(ackElapsed).toBeLessThan(500);
      const ackText = typeof ack.data === 'string' ? ack.data : JSON.stringify(ack.data);
      expect(ackText).toMatch(/background/i);

      const handles = (subagent as unknown as InternalSubagent).asyncHandles;
      const handle = handles.get('async-slowpoke');
      expect(handle).toBeDefined();

      const settled = await handle!.promise.then(
        r => ({ ok: true as const, r }),
        e => ({ ok: false as const, e: e as Error }),
      );
      const elapsed = Date.now() - t0;
      console.log(
        `[async-no-timeout] settled=${settled.ok ? 'ok' : 'error'} ` +
        `elapsed=${elapsed}ms ` +
        (settled.ok ? '' : `err=${settled.e.message}`),
      );

      expect(settled.ok).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(SUBAGENT_WORK - 200);
    } finally {
      await cleanup();
    }
  }, 15_000);

  test('SYNC spawn, no explicit timeoutMs: moves to the background at maxExecutionMs, and the run goes on', async () => {
    const MAX_EXEC = 1_000;
    const SUBAGENT_WORK = 3_000;
    const { subagent, cleanup } = await makeHarness({
      maxExecutionMs: MAX_EXEC,
      subagentRunMs: SUBAGENT_WORK,
    });
    try {
      const t0 = Date.now();
      const res = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'sync-slowpoke',
        systemPrompt: 'you are a test subagent',
        task: 'reply',
        sync: true,
      }));
      const elapsed = Date.now() - t0;
      console.log(
        `[sync-default] success=${res.success} elapsed=${elapsed}ms ` +
        `data=${typeof res.data === 'string' ? res.data : JSON.stringify(res.data)} ` +
        `error=${res.error ?? '—'}`,
      );

      expect(res.success).toBe(true);
      expect(String(res.data)).toContain('moved to background');
      expect(elapsed).toBeLessThan(SUBAGENT_WORK);
      const handle = (subagent as unknown as { asyncHandles: Map<string, { promise: Promise<{ summary: string }> }> })
        .asyncHandles.get('sync-slowpoke')!;
      expect((await handle.promise).summary).toBe('ok');
    } finally {
      await cleanup();
    }
  }, 10_000);

  test('SYNC spawn WITH explicit timeoutMs shorter than work: moves to the background, and the run goes on', async () => {
    const { subagent, cleanup } = await makeHarness({
      maxExecutionMs: 60_000,
      subagentRunMs: 3_000,
    });
    try {
      const t0 = Date.now();
      const res = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'sync-explicit',
        systemPrompt: 'you are a test subagent',
        task: 'reply',
        sync: true,
        timeoutMs: 500,
      }));
      const elapsed = Date.now() - t0;
      console.log(
        `[sync-explicit-race] success=${res.success} elapsed=${elapsed}ms ` +
        `data=${typeof res.data === 'string' ? res.data : JSON.stringify(res.data)} ` +
        `error=${res.error ?? '—'}`,
      );
      expect(res.success).toBe(true);
      expect(String(res.data)).toContain('moved to background');
      expect(elapsed).toBeLessThan(2_500);
      const handle = (subagent as unknown as { asyncHandles: Map<string, { promise: Promise<{ summary: string }> }> })
        .asyncHandles.get('sync-explicit')!;
      expect((await handle.promise).summary).toBe('ok');
    } finally {
      await cleanup();
    }
  }, 10_000);
});

describe('SubagentModule maxTokens cascade', () => {
  test('SPAWN inherits parent.maxTokens when no per-call and no module default', async () => {
    const { subagent, captured, cleanup } = await makeBudgetHarness({
      parentMaxTokens: 12_345,
    });
    try {
      const res = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'inherit-spawn',
        systemPrompt: 'sp',
        task: 'reply',
        sync: true,
      }));
      expect(res.success).toBe(true);
      expect(captured.length).toBe(1);
      expect(captured[0].maxTokens).toBe(12_345);
    } finally {
      await cleanup();
    }
  }, 10_000);

  test('FORK inherits parent.maxTokens when no per-call and no module default', async () => {
    const { subagent, captured, cleanup } = await makeBudgetHarness({
      parentMaxTokens: 12_345,
    });
    try {
      const res = await subagent.handleToolCall(makeToolCall('fork', {
        name: 'inherit-fork',
        task: 'reply',
        sync: true,
      }));
      expect(res.success).toBe(true);
      expect(captured.length).toBe(1);
      expect(captured[0].maxTokens).toBe(12_345);
    } finally {
      await cleanup();
    }
  }, 10_000);

  test('per-call maxTokens wins over recipe default and parent', async () => {
    const { subagent, captured, cleanup } = await makeBudgetHarness({
      parentMaxTokens: 12_345,
      moduleDefaultMaxTokens: 8_000,
    });
    try {
      const resSpawn = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'override-spawn',
        systemPrompt: 'sp',
        task: 'reply',
        maxTokens: 3_333,
        sync: true,
      }));
      expect(resSpawn.success).toBe(true);

      const resFork = await subagent.handleToolCall(makeToolCall('fork', {
        name: 'override-fork',
        task: 'reply',
        maxTokens: 4_444,
        sync: true,
      }));
      expect(resFork.success).toBe(true);

      expect(captured.length).toBe(2);
      expect(captured[0].maxTokens).toBe(3_333);
      expect(captured[1].maxTokens).toBe(4_444);
    } finally {
      await cleanup();
    }
  }, 10_000);

  test('recipe-level defaultMaxTokens wins over parent.maxTokens', async () => {
    const { subagent, captured, cleanup } = await makeBudgetHarness({
      parentMaxTokens: 12_345,
      moduleDefaultMaxTokens: 8_000,
    });
    try {
      const res = await subagent.handleToolCall(makeToolCall('spawn', {
        name: 'recipe-default',
        systemPrompt: 'sp',
        task: 'reply',
        sync: true,
      }));
      expect(res.success).toBe(true);
      expect(captured.length).toBe(1);
      expect(captured[0].maxTokens).toBe(8_000);
    } finally {
      await cleanup();
    }
  }, 10_000);
});
