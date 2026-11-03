/**
 * context-manager's dry compile (SelectOptions.dryRun) commits nothing a later
 * compile or an observer reads, though it releases a compression hold past its
 * deadline, and it returns an over-budget plan where a real compile refuses it.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module, ToolCall } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { SubagentModule } from '../src/modules/subagent-module.js';

type Compiled = { messages: Array<{ content: unknown }> };
type Compile = (budget?: unknown, injections?: unknown, opts?: { dryRun?: boolean }) => Promise<Compiled>;
interface Seen { who: string; dry: boolean; text: string }

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    const block = b as { text?: unknown; content?: unknown };
    if (typeof block.text === 'string') return block.text;
    return block.content === undefined ? '' : textOf(block.content);
  }).join('\n');
}

function record(cm: { compile: Compile }, who: string, seen: Seen[]): void {
  const original = cm.compile.bind(cm);
  cm.compile = async (budget, injections, opts) => {
    const result = await original(budget, injections, opts);
    seen.push({ who, dry: opts?.dryRun === true, text: result.messages.map((m) => textOf(m.content)).join('\n') });
    return result;
  };
}

async function harness() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sub-unsent-'));
  const adapter = new MockAdapter({ defaultResponse: 'all done' });
  const subagent = new SubagentModule({ provider: 'mock', parentAgentName: 'parent', defaultModel: 'mock', maxRetries: 0 });
  const framework = await AgentFramework.create({
    storePath: join(tmpDir, 'store'),
    membrane: new Membrane(adapter, { formatter: new NativeFormatter() }),
    agents: [{ name: 'parent', model: 'mock', systemPrompt: 'parent prompt', maxTokens: 256 }],
    modules: [subagent as unknown as Module],
  });
  subagent.setFramework(framework);
  framework.start();

  const seen: Seen[] = [];
  const fw = framework as unknown as { createEphemeralAgent(config: unknown): Promise<{ contextManager: { compile: Compile } }> };
  const create = fw.createEphemeralAgent.bind(framework);
  fw.createEphemeralAgent = async (config: unknown) => {
    const made = await create(config);
    record(made.contextManager, 'stream', seen);
    return made;
  };
  return {
    adapter, subagent, framework, seen,
    requestFor: (model: string) => adapter.getRequestLog().map((r) => r.request).find((r) => r.model === model),
    cleanup: async () => {
      await framework.stop().catch(() => {});
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function call(name: 'fork' | 'spawn', id: string, input: Record<string, unknown>): ToolCall {
  return { id, name, input, callerAgentName: 'parent' } as unknown as ToolCall;
}

describe("a peek's and a fork's read of another context are dry; launch checks are real", () => {
  test("a fork compiles its parent's context dry and seeds its stream from that compile; its launch check is a real compile", async () => {
    const h = await harness();
    try {
      const parentCM = h.framework.getAgent('parent')!.getContextManager() as unknown as { compile: Compile; addMessage: (p: string, c: unknown) => void };
      const input = { name: 'probe', task: 'say done', model: 'mock-child', sync: true };
      parentCM.addMessage('user', [{ type: 'text', text: 'please look into it: the ledger total is 4,212' }]);
      parentCM.addMessage('parent', [{ type: 'tool_use', id: 'toolu_probe', name: 'subagent--fork', input }]);
      record(parentCM, 'parent', h.seen);

      const res = await h.subagent.handleToolCall(call('fork', 'toolu_probe', input));
      expect(res.success).toBe(true);

      const parents = h.seen.filter((s) => s.who === 'parent');
      expect(parents.map((s) => s.dry)).toEqual([true]);
      expect(parents[0]!.text).toContain('the ledger total is 4,212');
      const request = h.requestFor('mock-child');
      expect(request).toBeDefined();
      expect(JSON.stringify(request)).toContain('the ledger total is 4,212');

      const streams = h.seen.filter((s) => s.who === 'stream');
      expect(streams[0]!.dry).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  test("a spawn's launch check is a real compile", async () => {
    const h = await harness();
    try {
      const res = await h.subagent.handleToolCall(call('spawn', 'toolu_spawn', { name: 'scout', systemPrompt: 'p', task: 'say done', model: 'mock-spawn', sync: true }));
      expect(res.success).toBe(true);
      expect(h.requestFor('mock-spawn')).toBeDefined();
      const streams = h.seen.filter((s) => s.who === 'stream');
      expect(streams[0]!.dry).toBe(false);
    } finally {
      await h.cleanup();
    }
  });

  test("a peek compiles the stream's context dry", async () => {
    const seen: Seen[] = [];
    const mod = new SubagentModule({ provider: 'mock' });
    const view = mod as unknown as {
      liveSubagents: Map<string, unknown>;
      frameworkNameIndex: Map<string, string>;
      handlePeek(input: { name?: string }, caller?: string): Promise<{ success: boolean; data: unknown }>;
    };
    const cm = { compile: (async () => ({ messages: [{ content: [{ type: 'text', text: 'working on it' }] }] })) as Compile };
    record(cm, 'stream', seen);
    view.liveSubagents.set('scout', {
      frameworkAgentName: 'fw-scout', displayName: 'scout', systemPrompt: 'test', contextManager: cm,
      currentStream: '', pendingToolCalls: [], activeCallIds: new Set(),
    });
    view.frameworkNameIndex.set('fw-scout', 'scout');
    const result = await view.handlePeek({ name: 'scout' });
    expect(result.success).toBe(true);
    expect(seen.map((s) => s.dry)).toEqual([true]);
    expect(JSON.stringify(result.data)).toContain('working on it');
  });
});
