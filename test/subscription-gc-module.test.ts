import { describe, test, expect } from 'bun:test';
import { SubscriptionGcModule } from '../src/modules/subscription-gc-module.js';
import type { ModuleContext, ProcessEvent, ProcessState } from '@animalabs/agent-framework';

function mockCtx() {
  let state: unknown = null;
  const traceListeners: Array<(e: { type: string; agentName?: string }) => void> = [];
  const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const ctx = {
    getState: () => state,
    setState: (s: unknown) => {
      state = s;
    },
    onTrace: (l: (e: { type: string }) => void) => {
      traceListeners.push(l);
      return () => {};
    },
    callTool: async (call: { name: string; input: Record<string, unknown> }) => {
      toolCalls.push(call);
      return { success: true, data: {}, isError: false };
    },
  } as unknown as ModuleContext;
  return { ctx, traceListeners, toolCalls, getState: () => state };
}

function ambient(
  channelId: string,
  text: string,
  opts: { isMention?: boolean; isDM?: boolean; serverId?: string } = {},
): ProcessEvent {
  return {
    type: 'mcpl:push-event',
    serverId: opts.serverId ?? 'discord',
    featureSet: 'discord.messaging',
    eventId: 'e1',
    content: [{ type: 'text', text }],
    origin: {
      source: 'discord',
      channelId,
      mcplChannelId: `discord:g1:${channelId}`,
      isMention: !!opts.isMention,
      isDM: !!opts.isDM,
    },
    timestamp: '2026-01-01T00:00:00Z',
    inferenceId: 'i1',
  } as unknown as ProcessEvent;
}

const PS = {} as ProcessState;

describe('SubscriptionGcModule', () => {
  test('auto-unsubscribes when ambient crosses the limit', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 10, serverId: 'discord' });
    const { ctx, toolCalls } = mockCtx();
    await m.start(ctx);

    let r = await m.onProcess(ambient('c1', 'abcdef'), PS); // 6 — under
    expect(toolCalls.length).toBe(0);
    expect(r.addMessages).toBeUndefined();

    r = await m.onProcess(ambient('c1', 'ghijkl'), PS); // +6 = 12 > 10 → unsub
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].name).toBe('channel_close');
    expect(toolCalls[0].input.channelId).toBe('discord:g1:c1');
    expect(toolCalls[0].input.serverId).toBe('discord');
    expect(r.addMessages?.length).toBe(1);

    await m.stop();
  });

  test('does not count mentions, DMs, or other servers', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 5 });
    const { ctx, toolCalls } = mockCtx();
    await m.start(ctx);

    await m.onProcess(ambient('c1', 'longmention', { isMention: true }), PS);
    await m.onProcess(ambient('c1', 'longdm', { isDM: true }), PS);
    await m.onProcess(ambient('c1', 'otherserver', { serverId: 'slack' }), PS);
    expect(toolCalls.length).toBe(0);

    await m.stop();
  });

  test('an activation resets all counters', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 10 });
    const { ctx, traceListeners, toolCalls } = mockCtx();
    await m.start(ctx);

    await m.onProcess(ambient('c1', 'abcdefgh'), PS); // 8 — under
    traceListeners[0]({ type: 'inference:started', agentName: 'lena' }); // reset
    await m.onProcess(ambient('c1', 'abcdefgh'), PS); // 8 again, not 16 → no unsub
    expect(toolCalls.length).toBe(0);

    await m.stop();
  });

  test('"off" override pins a channel; counters persist across restart', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 5 });
    const { ctx, toolCalls, getState } = mockCtx();
    await m.start(ctx);

    await m.handleToolCall({
      id: 't1',
      name: 'set_channel_idle_limit',
      input: { channelId: 'discord:g1:c1', limit: 'off' },
    });
    await m.onProcess(ambient('c1', 'waytoolongambient'), PS);
    expect(toolCalls.length).toBe(0); // pinned → never unsubscribed

    // A different channel still accrues, and state is persisted.
    await m.onProcess(ambient('c2', 'abc'), PS);
    const persisted = getState() as { overrides: Record<string, unknown>; counters: Record<string, number> };
    expect(persisted.overrides['discord:g1:c1']).toBe('off');

    // Simulate restart: a new module loads the persisted state (counters carry
    // across — a restart is not an activation).
    const m2 = new SubscriptionGcModule({ defaultLimitChars: 5 });
    const restart = mockCtx();
    // Feed the prior persisted state into the "restarted" module.
    const ctx2 = {
      getState: () => persisted,
      setState: () => {},
      onTrace: () => () => {},
      callTool: async (c: { name: string; input: Record<string, unknown> }) => {
        restart.toolCalls.push(c);
        return { success: true, data: {}, isError: false };
      },
    } as unknown as ModuleContext;
    await m2.start(ctx2);
    // c2 was at 3; +3 = 6 > 5 → unsubscribe (counter survived the "restart")
    await m2.onProcess(ambient('c2', 'def'), PS);
    expect(restart.toolCalls.length).toBe(1);
    expect(restart.toolCalls[0].input.channelId).toBe('discord:g1:c2');

    await m.stop();
    await m2.stop();
  });
});

describe('agent_settings extension (channel_idle_limits)', () => {
  test('declares no standalone tools but keeps the old names routable', async () => {
    const mod = new SubscriptionGcModule();
    await mod.start(mockCtx().ctx as unknown as ModuleContext);
    expect(mod.getTools()).toEqual([]);
    // Undeclared ≠ dead: ChannelModeModule pins limits via this name.
    const result = await mod.handleToolCall({
      id: 't1',
      name: 'set_channel_idle_limit',
      input: { channelId: 'C1', limit: 'off' },
    });
    expect(result.success).toBe(true);
    const ext = mod.getAgentSettingsExtension();
    expect(ext.get('agent')).toEqual({ channel_idle_limits: { C1: 'off' } });
  });

  test('update merges per entry: number, off, default/null', () => {
    const mod = new SubscriptionGcModule();
    void mod.start(mockCtx().ctx as unknown as ModuleContext);
    const ext = mod.getAgentSettingsExtension();
    ext.update('agent', { channel_idle_limits: { A: 5000, B: 'off', C: '12000' } });
    expect(ext.get('agent')).toEqual({ channel_idle_limits: { A: 5000, B: 'off', C: 12000 } });
    // merge: only mentioned entries change; default/null clear
    ext.update('agent', { channel_idle_limits: { A: 'default', B: null } });
    expect(ext.get('agent')).toEqual({ channel_idle_limits: { C: 12000 } });
  });

  test('update rejects junk values with a clear error', () => {
    const mod = new SubscriptionGcModule();
    void mod.start(mockCtx().ctx as unknown as ModuleContext);
    const ext = mod.getAgentSettingsExtension();
    expect(() => ext.update('agent', { channel_idle_limits: { A: -3 } })).toThrow(/positive/);
    expect(() => ext.update('agent', { channel_idle_limits: 'off' })).toThrow(/object/);
    expect(() => ext.update('agent', { channel_idle_limits: ['A'] })).toThrow(/object/);
  });

  test('reset clears all overrides', () => {
    const mod = new SubscriptionGcModule();
    void mod.start(mockCtx().ctx as unknown as ModuleContext);
    const ext = mod.getAgentSettingsExtension();
    ext.update('agent', { channel_idle_limits: { A: 5000, B: 'off' } });
    expect(ext.reset('agent')).toEqual({ channel_idle_limits: {} });
    // keyed reset also clears
    ext.update('agent', { channel_idle_limits: { A: 5000 } });
    expect(ext.reset('agent', ['channel_idle_limits'])).toEqual({ channel_idle_limits: {} });
    // reset for other keys leaves ours alone
    ext.update('agent', { channel_idle_limits: { A: 5000 } });
    expect(ext.reset('agent', ['reasoning_enabled'])).toEqual({ channel_idle_limits: { A: 5000 } });
  });
});
