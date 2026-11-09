import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module, ToolCall, TraceEvent } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { SubagentModule, type SubagentStreamEvent } from '../src/modules/subagent-module.js';

const THOUGHT = 'Weighing which file to open first.';
const SAID = 'Opening the config now.';

type Block = { type: 'thinking'; thinking: string; signature: string } | { type: 'text'; text: string };

class ThinkingAdapter extends MockAdapter {
  override async stream(...args: Parameters<MockAdapter['stream']>): ReturnType<MockAdapter['stream']> {
    const [request, callbacks, options] = args;
    if (!request.model.startsWith('thinker')) return super.stream(...args);
    options?.onRequest?.(request);
    const blocks: Block[] = [{ type: 'thinking', thinking: THOUGHT, signature: 'test-signature' }];
    if (request.model !== 'thinker-quiet') blocks.push({ type: 'text', text: SAID });
    blocks.forEach((block, index) => {
      callbacks.onContentBlock?.(index, block.type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' });
      options?.onProgress?.();
      callbacks.onChunk(block.type === 'text' ? block.text : block.thinking);
      if (block.type === 'thinking') callbacks.onContentBlock?.(index, block);
    });
    const signal = options?.signal;
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    // MockAdapter throws its abort error from its first check.
    return super.stream(...args);
  }
}

async function harness() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sub-thinking-'));
  const subagent = new SubagentModule({ provider: 'mock', parentAgentName: 'parent', defaultModel: 'mock', maxRetries: 0 });
  (subagent as unknown as { retryBackoffMs: number }).retryBackoffMs = 0;
  const framework = await AgentFramework.create({
    storePath: join(tmpDir, 'store'),
    membrane: new Membrane(new ThinkingAdapter({ defaultResponse: 'ok' }), { formatter: new NativeFormatter() }),
    agents: [{ name: 'parent', model: 'mock', systemPrompt: 'parent prompt', maxTokens: 256 }],
    modules: [subagent as unknown as Module],
  });
  subagent.setFramework(framework);
  framework.start();
  const call = (name: string, input: Record<string, unknown>) =>
    subagent.handleToolCall({ id: `call-${name}-${Math.random().toString(36).slice(2, 8)}`, name, input, callerAgentName: 'parent' } as unknown as ToolCall);
  const liveTail = (name: string) => {
    let said = '';
    subagent.onPeekStream(name, (event: SubagentStreamEvent) => { if (event.type === 'tokens') said += event.content; });
    return () => said;
  };
  const parentTexts = () => (framework.getAgent('parent')!.getContextManager().getAllMessages() as unknown as Array<{ content: Array<{ text?: string }> }>)
    .map((m) => m.content.map((b) => b.text ?? '').join(''));
  const until = async (cond: () => boolean, what: string, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!cond()) { if (Date.now() > deadline) throw new Error(`timed out: ${what}`); await Bun.sleep(25); }
  };
  return {
    subagent, framework, call, liveTail, parentTexts, until,
    cleanup: async () => { await framework.stop().catch(() => {}); rmSync(tmpDir, { recursive: true, force: true }); },
  };
}

describe("a subagent's thinking never reaches its parent model", () => {
  test("subagent--peek gives a running subagent's text without its thinking, which the live tail still carries", async () => {
    const h = await harness();
    try {
      const shown = h.liveTail('peeked');
      expect((await h.call('spawn', { name: 'peeked', systemPrompt: 'p', task: 'look', model: 'thinker' })).success).toBe(true);
      await h.until(() => shown().includes(SAID), 'the run has said something');
      expect(shown()).toContain(THOUGHT);
      const peek = await h.call('peek', { name: 'peeked' });
      expect(peek.success).toBe(true);
      expect(JSON.stringify(peek)).not.toContain(THOUGHT);
      expect((peek.data as Array<{ currentStream: string }>)[0]!.currentStream).toBe(SAID);
    } finally { await h.cleanup(); }
  }, 30_000);

  test("a sync subagent stopped partway returns the text it said, without its thinking", async () => {
    const h = await harness();
    try {
      const shown = h.liveTail('sync-stopped');
      const pending = h.call('spawn', { name: 'sync-stopped', systemPrompt: 'p', task: 'look', model: 'thinker', sync: true });
      await h.until(() => shown().includes(SAID), 'the run has said something');
      expect((await h.call('stop', { name: 'sync-stopped', reason: 'enough' })).success).toBe(true);
      const result = JSON.stringify(await pending);
      expect(result).toContain(SAID);
      expect(result).not.toContain(THOUGHT);
    } finally { await h.cleanup(); }
  }, 30_000);

  test("an async subagent stopped partway returns the text it said, without its thinking", async () => {
    const h = await harness();
    try {
      const shown = h.liveTail('async-stopped');
      expect((await h.call('spawn', { name: 'async-stopped', systemPrompt: 'p', task: 'look', model: 'thinker' })).success).toBe(true);
      await h.until(() => shown().includes(SAID), 'the run has said something');
      expect((await h.call('stop', { name: 'async-stopped', reason: 'enough' })).success).toBe(true);
      const result = () => h.parentTexts().find((t) => t.includes("[Subagent 'async-stopped' returned]"));
      await h.until(() => result() !== undefined, 'the stopped result reaches the parent');
      expect(result()).toContain(SAID);
      expect(result()).not.toContain(THOUGHT);
    } finally { await h.cleanup(); }
  }, 30_000);

  test("a round that has only thought so far counts as streaming: it isn't a zombie, and its slot says streaming", async () => {
    const h = await harness();
    try {
      const shown = h.liveTail('quiet');
      expect((await h.call('spawn', { name: 'quiet', systemPrompt: 'p', task: 'look', model: 'thinker-quiet' })).success).toBe(true);
      await h.until(() => shown().includes(THOUGHT), 'the run has thought');
      const priv = h.subagent as unknown as {
        activeSubagents: Map<string, { name: string; status: string; lastActivityAt: number }>;
        describeSlotHolders(): string[];
        reclaimZombieSlots(): number;
      };
      const entry = [...priv.activeSubagents.values()].find((e) => e.name === 'quiet' && e.status === 'running')!;
      entry.lastActivityAt = Date.now() - 10 * 60_000;
      const peek = await h.call('peek', { name: 'quiet' });
      expect(JSON.stringify(peek)).not.toContain(THOUGHT);
      expect((peek.data as Array<{ isZombie: boolean }>)[0]!.isZombie).toBe(false);
      expect(priv.describeSlotHolders().join('\n')).toMatch(/^quiet \[spawn\] .* streaming$/);
      expect(priv.reclaimZombieSlots()).toBe(0);
      expect(entry.status).toBe('running');
    } finally { await h.cleanup(); }
  }, 30_000);
});

describe("a round's streaming ends where its text is cleared", () => {
  function setUp() {
    const mod = new SubagentModule();
    const live = {
      frameworkAgentName: 'fw-scout',
      displayName: 'scout',
      systemPrompt: 'test',
      contextManager: { compile: async () => ({ messages: [] }) },
      currentStream: '',
      pendingToolCalls: [] as Array<{ name: string; input?: unknown }>,
      activeCallIds: new Set<string>(),
      requestInFlightSince: undefined as number | undefined,
    };
    const priv = mod as unknown as {
      liveSubagents: Map<string, typeof live>;
      frameworkNameIndex: Map<string, string>;
      activeSubagents: Map<string, Record<string, unknown>>;
      describeSlotHolders(): string[];
    };
    priv.liveSubagents.set('scout', live);
    priv.frameworkNameIndex.set('fw-scout', 'scout');
    priv.activeSubagents.set('scout-entry', {
      name: 'scout', type: 'spawn', task: 'look', status: 'running',
      startedAt: Date.now(), lastActivityAt: Date.now(), toolCallsCount: 0, findingsCount: 0,
    });
    let handler: ((e: TraceEvent) => void) | null = null;
    mod.setFramework({ onTrace: (cb: (e: TraceEvent) => void) => { handler = cb; } } as never);
    const fire = (event: Record<string, unknown>) => handler!({ agentName: 'fw-scout', ...event } as unknown as TraceEvent);
    const label = () => priv.describeSlotHolders()[0]!.split(' ').slice(4).join(' ');
    return { fire, label };
  }

  for (const [end, event, after] of [
    ['a new round', { type: 'inference:started' }, 'idle'],
    ['a yield of tool calls', { type: 'inference:tool_calls_yielded', calls: [{ id: 'c1', name: 'look', input: {} }] }, 'awaiting 1 tool(s)'],
    ['a resumed stream', { type: 'inference:stream_resumed' }, 'idle'],
  ] as const) {
    test(`a thinking token makes a round streaming, and ${end} ends it`, () => {
      const { fire, label } = setUp();
      fire({ type: 'inference:started' });
      expect(label()).toBe('idle');
      fire({ type: 'inference:tokens', content: THOUGHT, blockType: 'thinking', blockIndex: 0 });
      expect(label()).toBe('streaming');
      fire(event);
      expect(label()).toBe(after);
    });
  }
});
