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

  test('"off" override disables auto-close; counters persist across restart', async () => {
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
    // Undeclared ≠ dead: agent muscle memory routes via the old name.
    const result = await mod.handleToolCall({
      id: 't1',
      name: 'set_channel_idle_limit',
      input: { channelId: 'C1', limit: 'off' },
    });
    expect(result.success).toBe(true);
    const ext = mod.getAgentSettingsExtension();
    expect(ext.get('agent').channel_idle_limits).toEqual({ C1: 'off' });
  });

  test('get reports read-only status: default, counters, pins', async () => {
    const mod = new SubscriptionGcModule({ defaultLimitChars: 10 });
    const { ctx } = mockCtx();
    await mod.start(ctx);
    await mod.onProcess(ambient('c1', 'abc'), PS);
    await mod.handleToolCall({
      id: 't1',
      name: 'pin_channel_idle_limit',
      input: { channelId: 'C9', pinned: true },
    });
    const ext = mod.getAgentSettingsExtension();
    expect(ext.get('agent')).toEqual({
      channel_idle_limits: {},
      channel_idle_default: 10,
      channel_idle_counters: { 'discord:g1:c1': 3 },
      channel_idle_pinned: ['C9'],
    });
    await mod.stop();
  });

  test('update merges per entry: number, off, default/null', async () => {
    const mod = new SubscriptionGcModule();
    await mod.start(mockCtx().ctx as unknown as ModuleContext);
    const ext = mod.getAgentSettingsExtension();
    ext.update('agent', { channel_idle_limits: { A: 5000, B: 'off', C: '12000' } });
    expect(ext.get('agent').channel_idle_limits).toEqual({ A: 5000, B: 'off', C: 12000 });
    // merge: only mentioned entries change; default/null clear
    ext.update('agent', { channel_idle_limits: { A: 'default', B: null } });
    expect(ext.get('agent').channel_idle_limits).toEqual({ C: 12000 });
  });

  test('update rejects junk values with a clear error', async () => {
    const mod = new SubscriptionGcModule();
    await mod.start(mockCtx().ctx as unknown as ModuleContext);
    const ext = mod.getAgentSettingsExtension();
    expect(() => ext.update('agent', { channel_idle_limits: { A: -3 } })).toThrow(/positive/);
    expect(() => ext.update('agent', { channel_idle_limits: 'off' })).toThrow(/object/);
    expect(() => ext.update('agent', { channel_idle_limits: ['A'] })).toThrow(/object/);
  });

  test('every bad entry is named at once, with an empty channel id, and none is applied', async () => {
    const mod = new SubscriptionGcModule();
    const { ctx, getState } = mockCtx();
    await mod.start(ctx);
    const ext = mod.getAgentSettingsExtension();
    ext.update('agent', { channel_idle_limits: { Z: 5000 } });
    const refusal = (patch: Record<string, unknown>) => {
      try {
        ext.update('agent', patch);
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error('applied');
    };
    const rule = 'neither a positive number, "off", nor "default"/null (a number given as text is digits only)';
    const others = 'Other settings given in the same call may not all have been applied: agent_settings with action "get" shows each as it stands.';
    expect(refusal({ channel_idle_limits: { A: 5000, B: -3, C: '5.5', '': 10 } })).toBe(
      "channel_idle_limits wasn't changed, and none of its entries were applied. " +
        `These entries are ${rule}: "B": -3, "C": "5.5". ` +
        `A channel id is empty: give each channel by its id. The other entry was fine as given. ${others}`,
    );
    expect(refusal({ channel_idle_limits: { A: 5000, C: 'off', '': 10 } })).toBe(
      "channel_idle_limits wasn't changed, and none of its entries were applied. " +
        `A channel id is empty: give each channel by its id. The other 2 entries were fine as given. ${others}`,
    );
    // An empty id with a bad value is named as empty, not as a bad entry.
    expect(refusal({ channel_idle_limits: { A: 5000, '': 'soon' } })).toBe(
      "channel_idle_limits wasn't changed, and none of its entries were applied. " +
        `A channel id is empty: give each channel by its id. The other entry was fine as given. ${others}`,
    );
    expect(refusal({ channel_idle_limits: { B: 0 } })).toBe(
      "channel_idle_limits wasn't changed, and none of its entries were applied. " +
        `This entry is ${rule}: "B": 0. ${others}`,
    );
    expect(refusal({ channel_idle_limits: 'off' })).toBe(
      "channel_idle_limits wasn't changed: it must be an object mapping channel ids to a " +
        `positive number, "off", or "default"/null, not "off". ${others}`,
    );
    expect(ext.get('agent').channel_idle_limits).toEqual({ Z: 5000 });
    const persisted = getState() as { overrides: Record<string, unknown> } | null;
    expect(persisted?.overrides ?? {}).toEqual({ Z: 5000 });
  });

  test('a name the module doesn\'t have points to agent_settings', async () => {
    const mod = new SubscriptionGcModule();
    await mod.start(mockCtx().ctx);
    const r = await mod.handleToolCall({ id: 't1', name: 'set_idle_limit', input: {} });
    expect(r.error).toBe(
      'There\'s no tool "subscription-gc--set_idle_limit", so nothing ran. The subscription-gc module has no tools of its own; call one of the tools listed for you. ' +
        'Idle-limit controls live in agent_settings (field channel_idle_limits).',
    );
  });

  test('a partially-invalid patch applies nothing', async () => {
    const mod = new SubscriptionGcModule();
    const { ctx, getState } = mockCtx();
    await mod.start(ctx);
    const ext = mod.getAgentSettingsExtension();
    // A is valid, B is junk: the whole patch must be rejected — per-entry
    // application would leave A live (limitFor reads the map directly) and
    // persisted by the next flush, after the agent was told the update failed.
    expect(() => ext.update('agent', { channel_idle_limits: { A: 5000, B: -3 } })).toThrow(
      /positive/,
    );
    expect(ext.get('agent').channel_idle_limits).toEqual({});
    const persisted = getState() as { overrides: Record<string, unknown> } | null;
    expect(persisted?.overrides ?? {}).toEqual({});
  });

  test('reset clears all overrides', async () => {
    const mod = new SubscriptionGcModule();
    await mod.start(mockCtx().ctx as unknown as ModuleContext);
    const ext = mod.getAgentSettingsExtension();
    ext.update('agent', { channel_idle_limits: { A: 5000, B: 'off' } });
    expect(ext.reset('agent').channel_idle_limits).toEqual({});
    // keyed reset also clears
    ext.update('agent', { channel_idle_limits: { A: 5000 } });
    expect(ext.reset('agent', ['channel_idle_limits']).channel_idle_limits).toEqual({});
    // reset for other keys leaves ours alone
    ext.update('agent', { channel_idle_limits: { A: 5000 } });
    expect(ext.reset('agent', ['reasoning_enabled']).channel_idle_limits).toEqual({ A: 5000 });
  });
});

describe('system pins (pin_channel_idle_limit)', () => {
  test('reset-all clears overrides but not pins; pinned channel stays open', async () => {
    const mod = new SubscriptionGcModule({ defaultLimitChars: 5 });
    const { ctx, toolCalls } = mockCtx();
    await mod.start(ctx);
    // ChannelMode's debounced-mode step 3.
    await mod.handleToolCall({
      id: 't1',
      name: 'pin_channel_idle_limit',
      input: { channelId: 'discord:g1:c1', pinned: true },
    });
    const ext = mod.getAgentSettingsExtension();
    ext.update('agent', { channel_idle_limits: { A: 5000 } });
    // Blanket `agent_settings reset` (e.g. to restore default reasoning).
    const after = ext.reset('agent');
    expect(after.channel_idle_limits).toEqual({});
    expect(after.channel_idle_pinned).toEqual(['discord:g1:c1']);
    // The pinned channel must NOT auto-close after the reset.
    await mod.onProcess(ambient('c1', 'waytoolongambienttraffic'), PS);
    expect(toolCalls.length).toBe(0);
    await mod.stop();
  });

  test('pin/unpin round-trip preserves an agent override', async () => {
    const mod = new SubscriptionGcModule({ defaultLimitChars: 5 });
    const { ctx, toolCalls } = mockCtx();
    await mod.start(ctx);
    const ext = mod.getAgentSettingsExtension();
    ext.update('agent', { channel_idle_limits: { 'discord:g1:c1': 9 } });
    await mod.handleToolCall({
      id: 't1',
      name: 'pin_channel_idle_limit',
      input: { channelId: 'discord:g1:c1', pinned: true },
    });
    await mod.onProcess(ambient('c1', 'longerthannine'), PS); // pinned → no close
    expect(toolCalls.length).toBe(0);
    await mod.handleToolCall({
      id: 't2',
      name: 'pin_channel_idle_limit',
      input: { channelId: 'discord:g1:c1', pinned: false },
    });
    expect(ext.get('agent').channel_idle_limits).toEqual({ 'discord:g1:c1': 9 });
    // Override (9) is live again: counter is at 14 from the pinned message,
    // so the next ambient char crosses it.
    await mod.onProcess(ambient('c1', 'x'), PS);
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].name).toBe('channel_close');
    await mod.stop();
  });

  test('pin tool validates its input', async () => {
    const mod = new SubscriptionGcModule();
    await mod.start(mockCtx().ctx as unknown as ModuleContext);
    const bad1 = await mod.handleToolCall({
      id: 't1',
      name: 'pin_channel_idle_limit',
      input: { pinned: true },
    });
    expect(bad1.success).toBe(false);
    const bad2 = await mod.handleToolCall({
      id: 't2',
      name: 'pin_channel_idle_limit',
      input: { channelId: 'C1', pinned: 'yes' },
    });
    expect(bad2.success).toBe(false);
  });
});

describe('close provenance + explicit-open protection (issue #5)', () => {
  test('closes carry source subscription-gc; default budget certifies no lease', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 10, serverId: 'discord' });
    const { ctx, toolCalls } = mockCtx();
    await m.start(ctx);

    await m.onProcess(ambient('c1', 'abcdefghijkl'), PS); // 12 > 10 → close
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].input.source).toBe('subscription-gc');
    expect(toolCalls[0].input.overrideExplicitOpen).toBe(false);

    await m.stop();
  });

  test('a configured numeric budget is an explicit lease: overrideExplicitOpen true', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 10, serverId: 'discord' });
    const { ctx, toolCalls } = mockCtx();
    await m.start(ctx);

    await m.handleToolCall({
      id: 't1',
      name: 'set_channel_idle_limit',
      input: { channelId: 'discord:g1:c1', limit: 8 },
    });
    await m.onProcess(ambient('c1', 'abcdefghij'), PS); // 10 > 8 → close under lease
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].input.overrideExplicitOpen).toBe(true);

    await m.stop();
  });

  test('a structural explicit-open refusal stands down without a retry loop', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 10, serverId: 'discord' });
    const { ctx, toolCalls, getState } = mockCtx();
    (ctx as unknown as { callTool: unknown }).callTool = async (call: { name: string; input: Record<string, unknown> }) => {
      toolCalls.push(call);
      return {
        success: false,
        isError: false,
        error: 'explicitly opened',
        data: { refusal: 'explicit-open' },
      };
    };
    await m.start(ctx);

    const r = await m.onProcess(ambient('c1', 'abcdefghijkl'), PS); // 12 > 10
    expect(toolCalls.length).toBe(1);
    // No context spam, no counter restore: the janitor stands down and the
    // next attempt is at least a full budget away.
    expect(r.addMessages).toBeUndefined();
    const counters = (getState() as { counters: Record<string, number> }).counters;
    expect(counters['discord:g1:c1']).toBeUndefined();

    // Next ambient message counts from zero rather than instantly re-firing.
    await m.onProcess(ambient('c1', 'ab'), PS);
    expect(toolCalls.length).toBe(1);

    await m.stop();
  });

  test('a successful close emits a privacy-minimal ops receipt when notifyOps exists', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 10, serverId: 'discord' });
    const { ctx } = mockCtx();
    const receipts: Array<{ kind: string; agent: string; message: string; data?: Record<string, unknown> }> = [];
    // The mock is deliberately `this`-sensitive, like the real
    // ModuleContextImpl.notifyOps (which reads this.registry): a detached
    // `const f = ctx.notifyOps; f(...)` throws here instead of passing —
    // the exact bug class Sol caught in the first revision.
    Object.assign(ctx as object, {
      getAgents: () => [{ name: 'mythos' }],
      _receipts: receipts,
      notifyOps(
        this: { _receipts: typeof receipts },
        kind: string,
        agent: string,
        message: string,
        data?: Record<string, unknown>,
      ) {
        this._receipts.push({ kind, agent, message, data });
      },
    });
    await m.start(ctx);

    await m.onProcess(ambient('c1', 'abcdefghijkl'), PS);
    expect(receipts.length).toBe(1);
    expect(receipts[0].kind).toBe('subscription-gc-close');
    expect(receipts[0].agent).toBe('mythos');
    expect(receipts[0].data).toMatchObject({
      channelId: 'discord:g1:c1',
      limitChars: 10,
      decisionSource: 'subscription-gc',
      lease: 'default',
    });
    // Privacy-minimal: the receipt names ids and thresholds, never content.
    expect(receipts[0].message).not.toContain('abcdef');

    await m.stop();
  });

  test('a configured-budget close reports lease configured-budget, claiming no actor', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 10, serverId: 'discord' });
    const { ctx } = mockCtx();
    const receipts: Array<{ message: string; data?: Record<string, unknown> }> = [];
    Object.assign(ctx as object, {
      getAgents: () => [{ name: 'mythos' }],
      _receipts: receipts,
      notifyOps(
        this: { _receipts: typeof receipts },
        _kind: string,
        _agent: string,
        message: string,
        data?: Record<string, unknown>,
      ) {
        this._receipts.push({ message, data });
      },
    });
    await m.start(ctx);

    await m.handleToolCall({
      id: 't1',
      name: 'set_channel_idle_limit',
      input: { channelId: 'discord:g1:c1', limit: 8 },
    });
    await m.onProcess(ambient('c1', 'abcdefghij'), PS); // 10 > 8
    expect(receipts.length).toBe(1);
    // The override state records no actor (agent, operator, or imported are
    // all possible) — the receipt must not claim 'agent-set'.
    expect(receipts[0].data?.lease).toBe('configured-budget');
    expect(receipts[0].message).toContain('configured per-channel budget');
    expect(receipts[0].message).not.toContain('agent-set');

    await m.stop();
  });

  test('an ordinary close failure still restores the counter for retry', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 10, serverId: 'discord' });
    const { ctx, toolCalls, getState } = mockCtx();
    (ctx as unknown as { callTool: unknown }).callTool = async (call: { name: string; input: Record<string, unknown> }) => {
      toolCalls.push(call);
      return { success: false, error: 'server unreachable', isError: true };
    };
    await m.start(ctx);

    await m.onProcess(ambient('c1', 'abcdefghijkl'), PS);
    expect(toolCalls.length).toBe(1);
    const counters = (getState() as { counters: Record<string, number> }).counters;
    expect(counters['discord:g1:c1']).toBe(12);

    await m.stop();
  });
});
