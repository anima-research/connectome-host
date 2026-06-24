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
    expect(toolCalls[0].name).toBe('mcpl--discord--unsubscribe_channel');
    expect(toolCalls[0].input.channelId).toBe('c1');
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
      input: { channelId: 'c1', limit: 'off' },
    });
    await m.onProcess(ambient('c1', 'waytoolongambient'), PS);
    expect(toolCalls.length).toBe(0); // pinned → never unsubscribed

    // A different channel still accrues, and state is persisted.
    await m.onProcess(ambient('c2', 'abc'), PS);
    const persisted = getState() as { overrides: Record<string, unknown>; counters: Record<string, number> };
    expect(persisted.overrides.c1).toBe('off');

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
    expect(restart.toolCalls[0].input.channelId).toBe('c2');

    await m.stop();
    await m2.stop();
  });
});
