/**
 * Ephemeral subagents must inherit the caller's proseRouting mode.
 *
 * AF's Agent defaults proseRouting to 'locus' (ambient locus capture
 * publishes plain prose to the open channel). Before this fix,
 * SubagentModule never passed proseRouting to createEphemeralAgent, so a
 * resident running proseRouting 'disabled' still spawned divers whose
 * between-tool-calls prose leaked into its live Zulip topic as parent
 * speech — field-confirmed on a deployed resident, 2026-08-26, and
 * reproduced again after the recipe adopted 'disabled' (the recipe value
 * reached only the resident, never the divers).
 *
 * Harness follows subagent-async-timeout.test.ts: real framework + mock
 * membrane, runEphemeralToCompletion stubbed — here to capture the
 * ephemeral Agent it receives so the test can read its proseRouting.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module, ToolCall } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { SubagentModule } from '../src/modules/subagent-module.js';

async function makeHarness(parentProseRouting?: 'locus' | 'explicit' | 'hybrid' | 'disabled') {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sub-prose-'));
  const adapter = new MockAdapter({ defaultResponse: 'ok' });
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
  const subagent = new SubagentModule({
    provider: 'mock',
    parentAgentName: 'parent',
    defaultModel: 'mock',
    defaultMaxTokens: 256,
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
      ...(parentProseRouting !== undefined ? { proseRouting: parentProseRouting } : {}),
    }],
    modules: [subagent as unknown as Module],
  });
  subagent.setFramework(framework);

  // Capture the ephemeral Agent handed to the run loop; resolve immediately.
  let captured: { proseRouting?: string; name?: string } | null = null;
  const fw = framework as unknown as {
    runEphemeralToCompletion: (agent: unknown, ctxMgr: unknown) => Promise<{ speech: string; toolCallsCount: number }>;
  };
  fw.runEphemeralToCompletion = async (agent: unknown) => {
    captured = agent as { proseRouting?: string; name?: string };
    return { speech: 'done', toolCallsCount: 0 };
  };

  const cleanup = async () => {
    await framework.stop().catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
  };
  return { subagent, getCaptured: () => captured, cleanup };
}

function spawnCall(): ToolCall {
  return {
    id: 'tc-1',
    name: 'spawn',
    callerAgentName: 'parent',
    input: {
      name: 'probe',
      systemPrompt: 'you are a probe',
      task: 'probe the harness',
      sync: true,
    },
  } as unknown as ToolCall;
}

describe('subagent prose-routing inheritance', () => {
  test("spawned subagent inherits the parent's proseRouting 'disabled'", async () => {
    const h = await makeHarness('disabled');
    try {
      const result = await h.subagent.handleToolCall(spawnCall());
      if (!result.success) console.error('SPAWN ERROR:', result.error);
      expect(result.success).toBe(true);
      expect(h.getCaptured()).not.toBeNull();
      expect(h.getCaptured()!.proseRouting).toBe('disabled');
    } finally {
      await h.cleanup();
    }
  });

  test("parent without explicit proseRouting yields AF's default on the child ('locus')", async () => {
    const h = await makeHarness(undefined);
    try {
      const result = await h.subagent.handleToolCall(spawnCall());
      if (!result.success) console.error('SPAWN ERROR:', result.error);
      expect(result.success).toBe(true);
      // Parent's resolved mode is AF's default 'locus'; inheritance passes it
      // through explicitly — same value the child would default to, asserted
      // so a future AF default change keeps parent and child in lockstep.
      expect(h.getCaptured()!.proseRouting).toBe('locus');
    } finally {
      await h.cleanup();
    }
  });
});
