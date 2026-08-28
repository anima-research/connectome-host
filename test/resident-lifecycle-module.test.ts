import { describe, expect, test } from 'bun:test';
import type { AgentFramework, ModuleContext, ToolCall } from '@animalabs/agent-framework';
import { ResidentLifecycleModule } from '../src/modules/resident-lifecycle-module.js';

function call(
  action: string,
  input: Record<string, unknown> = {},
): ToolCall {
  return {
    id: `call-${action}`,
    name: 'lifecycle',
    callerAgentName: 'resident',
    input: { action, ...input },
  };
}

function harness(options: { ready?: () => boolean } = {}) {
  let now = 1_000;
  const nudges: Array<{ agent: string; reason?: string }> = [];
  const retirements: Array<{ agent: string; reason?: string }> = [];
  const notifications: unknown[][] = [];
  const module = new ResidentLifecycleModule({
    agentName: 'resident',
    enabled: true,
    confirmationDelayMs: 100,
    confirmationTtlMs: 1_000,
    now: () => now,
    readinessCheck: () => options.ready?.() === false
      ? { ready: false, code: 'quarantine', reason: 'memory quarantine is not empty' }
      : { ready: true },
  });
  const framework = {
    getResidentLifecycleStatus: () => ({ status: 'active', retirementEnabled: true }),
    nudgeAgent: (agent: string, reason?: string) => {
      nudges.push({ agent, reason });
      return { ok: true, message: 'queued' };
    },
    retireResident: (agent: string, reason?: string) => {
      retirements.push({ agent, reason });
      return {
        status: 'retired' as const,
        retiredAt: now,
        ...(reason ? { reason } : {}),
        chronicleRecorded: true,
        alreadyRetired: false,
      };
    },
  } as unknown as AgentFramework;
  module.setFramework(framework);
  void module.start({
    notifyOps: (...args: unknown[]) => { notifications.push(args); },
  } as unknown as ModuleContext);
  return {
    module,
    nudges,
    retirements,
    notifications,
    advance: (ms: number) => { now += ms; },
  };
}

describe('ResidentLifecycleModule', () => {
  test('exposes the ceremony only to the configured resident live surface', () => {
    const { module } = harness();
    expect(module.getTools()).toEqual([]);
    expect(module.getLiveTools('resident').map((tool) => tool.name)).toEqual(['lifecycle']);
    expect(module.getLiveTools('conversation-dm-g1')).toEqual([]);
  });

  test('requires a separate cooled-off confirmation and notifies only after sealing', async () => {
    const { module, advance, retirements, notifications } = harness();
    const requested = await module.handleToolCall(call('request_retirement'));
    expect(requested.success).toBe(true);
    expect(requested.endTurn).toBe(true);
    const data = requested.data as { challenge: string; confirmableAt: number; expiresAt: number };

    const early = await module.handleToolCall(call('confirm_retirement', {
      challenge: data.challenge,
      confirmation: 'RETIRE_RESIDENT',
    }));
    expect(early.success).toBe(false);
    expect((early.data as { status: string }).status).toBe('cooling_off');
    expect(retirements).toHaveLength(0);

    advance(100);
    const confirmed = await module.handleToolCall(call('confirm_retirement', {
      challenge: data.challenge,
      confirmation: 'RETIRE_RESIDENT',
      reason: 'resident reason',
    }));
    expect(confirmed.success).toBe(true);
    expect(confirmed.endTurn).toBe(true);
    expect(retirements).toEqual([{ agent: 'resident', reason: 'resident reason' }]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.[0]).toBe('resident-retired');
  });

  test('expires a challenge and requires a fresh request', async () => {
    const { module, advance, retirements } = harness();
    const requested = await module.handleToolCall(call('request_retirement'));
    const challenge = (requested.data as { challenge: string }).challenge;
    advance(1_001);
    const expired = await module.handleToolCall(call('confirm_retirement', {
      challenge,
      confirmation: 'RETIRE_RESIDENT',
    }));
    expect(expired.success).toBe(false);
    expect(expired.error).toMatch(/No unexpired retirement challenge/);
    expect(retirements).toHaveLength(0);
  });

  test('fails closed on quarantine at request and confirmation without consuming a valid challenge', async () => {
    let ready = false;
    const { module, advance, retirements } = harness({ ready: () => ready });
    const blockedRequest = await module.handleToolCall(call('request_retirement'));
    expect(blockedRequest.success).toBe(false);
    expect((blockedRequest.data as { code: string }).code).toBe('quarantine');

    ready = true;
    const requested = await module.handleToolCall(call('request_retirement'));
    const challenge = (requested.data as { challenge: string }).challenge;
    advance(100);
    ready = false;
    const blockedConfirmation = await module.handleToolCall(call('confirm_retirement', {
      challenge,
      confirmation: 'RETIRE_RESIDENT',
    }));
    expect(blockedConfirmation.success).toBe(false);

    ready = true;
    const confirmed = await module.handleToolCall(call('confirm_retirement', {
      challenge,
      confirmation: 'RETIRE_RESIDENT',
    }));
    expect(confirmed.success).toBe(true);
    expect(retirements).toHaveLength(1);
  });

  test('consumes a post-cooling invalid confirmation', async () => {
    const { module, advance } = harness();
    const requested = await module.handleToolCall(call('request_retirement'));
    const challenge = (requested.data as { challenge: string }).challenge;
    advance(100);
    const invalid = await module.handleToolCall(call('confirm_retirement', {
      challenge,
      confirmation: 'DO_NOT_RETIRE',
    }));
    expect(invalid.success).toBe(false);
    const retry = await module.handleToolCall(call('confirm_retirement', {
      challenge,
      confirmation: 'RETIRE_RESIDENT',
    }));
    expect(retry.error).toMatch(/No unexpired retirement challenge/);
  });
});
