import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, type Module, type ToolCall } from '@animalabs/agent-framework';
import { Membrane, MembraneError, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { frameworkErrorPolicy } from '../src/framework-error-policy.js';
import { hostMembraneRetry } from '../src/membrane-retry.js';
import { SubagentModule } from '../src/modules/subagent-module.js';

for (const [httpStatus, statedWait] of [[429, 120_000], [529, 360_000]]) {
  test(`R1-3: a subagent keeps its ${statedWait} ms stated wait in its run (${httpStatus})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turn-wait-'));
    const retry = { maxRetries: 4 };
    let sends = 0;
    const adapter = new MockAdapter({ responseGenerator: request => {
      if (request.model === 'mock-worker' && ++sends === 1) {
        throw new MembraneError({
          type: httpStatus === 429 ? 'rate_limit' : 'server',
          message: `synthetic ${httpStatus}`, retryable: true, httpStatus, retryAfterMs: statedWait,
        });
      }
      return 'finished after the wait';
    } });
    const subagent = new SubagentModule({ parentAgentName: 'parent', defaultModel: 'mock-worker', maxRetries: 0 });
    Reflect.set(subagent, 'rateLimitCooldownMs', 0); // Keep the unfixed failure path fast.
    const throttle = spyOn(subagent as any, 'onRateLimitHit');
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new Membrane(adapter, { formatter: new NativeFormatter(), retry: hostMembraneRetry(retry) }),
      ...frameworkErrorPolicy(retry),
      agents: [{ name: 'parent', model: 'mock', systemPrompt: 'parent', maxTokens: 256 }],
      modules: [subagent as unknown as Module],
    });
    subagent.setFramework(framework);
    // Exercise the real subagent launch and ephemeral error-policy path, but
    // record the framework's selected sleep instead of waiting several minutes.
    const waits: number[] = [];
    const sleep = spyOn(framework as any, 'waitForRetry').mockImplementation(async (ms: number) => { waits.push(ms); });
    try {
      await framework.start();
      const result = await subagent.handleToolCall({
        id: 'wait-probe', name: 'spawn', callerAgentName: 'parent',
        input: { name: 'wait-worker', task: 'finish', systemPrompt: 'worker', sync: true },
      } as ToolCall);
      expect(result.success).toBe(true);
      expect(waits).toEqual([statedWait]);
      expect(sends).toBe(2);
      expect(throttle).not.toHaveBeenCalled();
      const runs = framework.listAgents({ includeEnded: true }).filter(record => record.kind === 'worker');
      expect(runs).toHaveLength(1); // No failed run handed back for a restart.
      expect(runs[0].ended?.reason).toBe('completed');
    } finally {
      sleep.mockRestore();
      throttle.mockRestore();
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
}
