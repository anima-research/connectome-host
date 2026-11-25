import { afterEach, beforeEach, describe, test, expect, spyOn } from 'bun:test';
import { SubscriptionGcModule } from '../src/modules/subscription-gc-module.js';
import type { AgentFramework, ModuleContext, ProcessEvent, ProcessState } from '@animalabs/agent-framework';

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

    let r = await m.onProcess(ambient('c1', 'abcdef'), PS);
    expect(toolCalls.length).toBe(0);
    expect(r.addMessages).toBeUndefined();

    r = await m.onProcess(ambient('c1', 'ghijkl'), PS);
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

    await m.onProcess(ambient('c1', 'abcdefgh'), PS);
    traceListeners[0]({ type: 'inference:started', agentName: 'lena' });
    await m.onProcess(ambient('c1', 'abcdefgh'), PS);
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
    expect(toolCalls.length).toBe(0);

    await m.onProcess(ambient('c2', 'abc'), PS);
    const persisted = getState() as { overrides: Record<string, unknown>; counters: Record<string, number> };
    expect(persisted.overrides['discord:g1:c1']).toBe('off');

    const m2 = new SubscriptionGcModule({ defaultLimitChars: 5 });
    const restart = mockCtx();
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
      channel_idle_server: 'discord',
    });
    await mod.stop();
  });

  test('update merges per entry: number, off, default/null', async () => {
    const mod = new SubscriptionGcModule();
    await mod.start(mockCtx().ctx as unknown as ModuleContext);
    const ext = mod.getAgentSettingsExtension();
    ext.update('agent', { channel_idle_limits: { A: 5000, B: 'off', C: '12000' } });
    expect(ext.get('agent').channel_idle_limits).toEqual({ A: 5000, B: 'off', C: 12000 });
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
        'Idle-limit controls live in agent_settings (field channel_idle_limits); reach it with ' +
        'toolsets--open {"toolset": "settings"}, then toolsets--act {"tool": "agent_settings", "args": {...}}; if your tool ' +
        'list lacks toolsets--open or toolsets--act, call it by its name instead.',
    );
  });

  test('a partially-invalid patch applies nothing', async () => {
    const mod = new SubscriptionGcModule();
    const { ctx, getState } = mockCtx();
    await mod.start(ctx);
    const ext = mod.getAgentSettingsExtension();
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
    ext.update('agent', { channel_idle_limits: { A: 5000 } });
    expect(ext.reset('agent', ['channel_idle_limits']).channel_idle_limits).toEqual({});
    ext.update('agent', { channel_idle_limits: { A: 5000 } });
    expect(ext.reset('agent', ['reasoning_enabled']).channel_idle_limits).toEqual({ A: 5000 });
  });
});

describe('system pins (pin_channel_idle_limit)', () => {
  test('reset-all clears overrides but not pins; pinned channel stays open', async () => {
    const mod = new SubscriptionGcModule({ defaultLimitChars: 5 });
    const { ctx, toolCalls } = mockCtx();
    await mod.start(ctx);
    await mod.handleToolCall({
      id: 't1',
      name: 'pin_channel_idle_limit',
      input: { channelId: 'discord:g1:c1', pinned: true },
    });
    const ext = mod.getAgentSettingsExtension();
    ext.update('agent', { channel_idle_limits: { A: 5000 } });
    const after = ext.reset('agent');
    expect(after.channel_idle_limits).toEqual({});
    expect(after.channel_idle_pinned).toEqual(['discord:g1:c1']);
    await mod.onProcess(ambient('c1', 'waytoolongambienttraffic'), PS);
    expect(toolCalls.length).toBe(0);
    await mod.stop();
  });

  test('pin/unpin round-trip preserves an agent override, and pinned traffic still counts toward it', async () => {
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
    await mod.onProcess(ambient('c1', 'longerthannine'), PS);
    expect(toolCalls.length).toBe(0);
    await mod.handleToolCall({
      id: 't2',
      name: 'pin_channel_idle_limit',
      input: { channelId: 'discord:g1:c1', pinned: false },
    });
    expect(ext.get('agent').channel_idle_limits).toEqual({ 'discord:g1:c1': 9 });
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

    await m.onProcess(ambient('c1', 'abcdefghijkl'), PS);
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
    await m.onProcess(ambient('c1', 'abcdefghij'), PS);
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

    const r = await m.onProcess(ambient('c1', 'abcdefghijkl'), PS);
    expect(toolCalls.length).toBe(1);
    expect(r.addMessages).toBeUndefined();
    const counters = (getState() as { counters: Record<string, number> }).counters;
    expect(counters['discord:g1:c1']).toBeUndefined();

    await m.onProcess(ambient('c1', 'ab'), PS);
    expect(toolCalls.length).toBe(1);

    await m.stop();
  });

  test('a tuned-out refusal under a configured budget stands down without a retry loop', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 10, serverId: 'discord' });
    const { ctx, toolCalls, getState } = mockCtx();
    (ctx as unknown as { callTool: unknown }).callTool = async (call: { name: string; input: Record<string, unknown> }) => {
      toolCalls.push(call);
      // As agent-framework refuses a close of a tuned-out channel, even one
      // that certifies an idle lease.
      return {
        success: false,
        isError: false,
        error: 'tuned out',
        data: { refusal: 'tuned-out', channelId: 'discord:g1:c1' },
      };
    };
    await m.start(ctx);
    await m.handleToolCall({
      id: 't1',
      name: 'set_channel_idle_limit',
      input: { channelId: 'discord:g1:c1', limit: 8 },
    });

    const r = await m.onProcess(ambient('c1', 'abcdefghij'), PS);
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].input.overrideExplicitOpen).toBe(true);
    expect(r.addMessages).toBeUndefined();
    const counters = (getState() as { counters: Record<string, number> }).counters;
    expect(counters['discord:g1:c1']).toBeUndefined();

    await m.onProcess(ambient('c1', 'ab'), PS);
    expect(toolCalls.length).toBe(1);
    await m.onProcess(ambient('c1', 'abcdefg'), PS);
    expect(toolCalls.length).toBe(2);

    await m.stop();
  });

  test('a successful close emits a privacy-minimal ops receipt when notifyOps exists', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 10, serverId: 'discord' });
    const { ctx } = mockCtx();
    const receipts: Array<{ kind: string; agent: string; message: string; data?: Record<string, unknown> }> = [];
    // `this`-sensitive, as agent-framework's ModuleContextImpl.notifyOps is (it
    // reads this.registry), so a detached call throws.
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
    await m.onProcess(ambient('c1', 'abcdefghij'), PS);
    expect(receipts.length).toBe(1);
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

// Events as agent-framework 0.35.3 hands them to a module: it adds
// chat:addressed to every chat:mention, chat:reply and chat:dm at entry, on
// both paths (mcpl/push-handler.ts, mcpl/channel-registry.ts).
function pushFrom(
  serverId: string,
  channelId: string,
  text: string,
  opts: { tags?: string[]; origin?: Record<string, unknown> } = {},
): ProcessEvent {
  return {
    type: 'mcpl:push-event',
    serverId,
    featureSet: `${serverId}.events`,
    eventId: 'e1',
    content: [{ type: 'text', text }],
    origin: opts.origin ?? { source: serverId, channelId },
    ...(opts.tags ? { tags: opts.tags } : {}),
    timestamp: '2026-01-01T00:00:00Z',
    inferenceId: 'i1',
  };
}

function incomingFrom(
  serverId: string,
  channelId: string,
  text: string,
  opts: { tags?: string[]; metadata?: Record<string, unknown> } = {},
): ProcessEvent {
  return {
    type: 'mcpl:channel-incoming',
    serverId,
    channelId,
    messageId: 'm1',
    author: { id: 'u1', name: 'someone' },
    content: [{ type: 'text', text }],
    timestamp: '2026-01-01T00:00:00Z',
    metadata: opts.metadata ?? {},
    ...(opts.tags ? { tags: opts.tags } : {}),
  };
}

const inactiveLine = (watched: string, named: 'default' | 'recipe', from: string) =>
  `[agent-settings] modules.subscriptionGc watches server "${watched}", ` +
  (named === 'default' ? 'its default' : 'which modules.subscriptionGc.serverId names') +
  `, and this host has no server "${watched}", so it closes no channel. Ambient traffic from server "${from}" isn't counted. ` +
  'modules.subscriptionGc.serverId names the one server it watches, and modules.subscriptionGc: false turns it off.';

const defaultLine = (from: string) =>
  `[agent-settings] modules.subscriptionGc watches only server "discord", its default, so ambient traffic from server ` +
  `"${from}" isn't counted, and no channel of "${from}" auto-closes. modules.subscriptionGc.serverId names the one ` +
  'server it watches. Setting it to "discord" keeps cleanup as it is, without this line.';

const settingsWarning = (watched: string) =>
  `Idle cleanup watches server "${watched}", which this host doesn't have, so these limits are stored and not in ` +
  "force, and no channel auto-closes. Only the host's operator can change the server " +
  '(modules.subscriptionGc.serverId in the recipe): tell them if these limits matter to you.';

const legacyNote = (watched: string) =>
  ` Idle cleanup isn't in force on this host: it watches server "${watched}", which this host doesn't have.`;

function host(...ids: string[]) {
  const servers = [...ids];
  const framework = {
    listMcplServers: () => servers.map((id) => ({ id, connected: true })),
  } as unknown as Pick<AgentFramework, 'listMcplServers'>;
  return { framework, servers };
}

describe('events addressed to the agent are not ambient (chat:addressed)', () => {
  test('a GitHub reply on a thread, on both paths, is neither counted nor closed', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 5, serverId: 'github' });
    const { ctx, toolCalls } = mockCtx();
    m.setFramework(host('github').framework);
    await m.start(ctx);
    const replyTags = ['chat:reply', 'chat:from-human', 'chat:addressed'];
    const thread = 'github:o/r#1';
    await m.onProcess(pushFrom('github', thread, 'a long review reply', {
      tags: replyTags,
      origin: { source: 'github', repo: 'o/r', kind: 'issue_comment', number: 1, threadKind: 'pull', channelId: thread },
    }), PS);
    await m.onProcess(incomingFrom('github', thread, 'a long review reply', { tags: replyTags }), PS);
    await m.onProcess(incomingFrom('github', thread, 'a long mention', { tags: ['chat:mention', 'chat:addressed'] }), PS);
    await m.onProcess(pushFrom('github', thread, 'a long direct message', { tags: ['chat:dm', 'chat:addressed', 'chat:private'] }), PS);
    expect(toolCalls).toEqual([]);
    expect(m.getAgentSettingsExtension().get('agent').channel_idle_counters).toEqual({});
    await m.stop();
  });

  test('an ambient comment on the same thread still counts and closes', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 5, serverId: 'github' });
    const { ctx, toolCalls } = mockCtx();
    m.setFramework(host('github').framework);
    await m.start(ctx);
    await m.onProcess(incomingFrom('github', 'github:o/r#1', 'an overheard comment', { tags: ['chat:ambient'] }), PS);
    expect(toolCalls.map((c) => c.input)).toEqual([
      { channelId: 'github:o/r#1', serverId: 'github', source: 'subscription-gc', overrideExplicitOpen: false },
    ]);
    await m.stop();
  });

  test('an addressed event from an unwatched server gives no line, and leaves the line for the first ambient one', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const m = new SubscriptionGcModule({ defaultLimitChars: 5 });
      m.setFramework(host('github').framework);
      await m.start(mockCtx().ctx);
      await m.onProcess(pushFrom('github', 'github:o/r#1', 'a reply', { tags: ['chat:reply', 'chat:addressed'] }), PS);
      await m.onProcess(incomingFrom('github', 'github:o/r#1', 'a reply', { tags: ['chat:reply', 'chat:addressed'] }), PS);
      expect(warn).not.toHaveBeenCalled();
      await m.onProcess(pushFrom('github', 'github:o/r#1', 'an overheard comment', { tags: ['chat:ambient'] }), PS);
      expect(warn.mock.calls).toEqual([[inactiveLine('discord', 'default', 'github')]]);
      await m.stop();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the module says when it watches a server that sends nothing, or leaves one unwatched', () => {
  let warn: ReturnType<typeof spyOn>;
  beforeEach(() => { warn = spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });
  const said = () => warn.mock.calls.map((call: unknown[]) => call.join(' '));

  test('a Portal host with the default: one line per unwatched server, at its first ambient text, and nothing closes', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 5 });
    const { ctx, toolCalls } = mockCtx();
    m.setFramework(host('portal', 'zulip').framework);
    await m.start(ctx);
    await m.onProcess(incomingFrom('portal', 'portal:r1', 'a mention', { metadata: { isMention: true } }), PS);
    await m.onProcess(incomingFrom('portal', 'portal:r1', 'a dm', { metadata: { isDM: true } }), PS);
    await m.onProcess(incomingFrom('portal', 'portal:r1', ''), PS);
    await m.onProcess(pushFrom('portal', '', 'no channel', { origin: { source: 'portal' } }), PS);
    expect(said()).toEqual([]);
    await m.onProcess(incomingFrom('portal', 'portal:r1', 'ambient chatter'), PS);
    expect(said()).toEqual([inactiveLine('discord', 'default', 'portal')]);
    await m.onProcess(pushFrom('portal', 'portal:r2', 'more ambient chatter'), PS);
    await m.onProcess(incomingFrom('zulip', 'zulip:backend', 'ambient chatter'), PS);
    expect(said()).toEqual([inactiveLine('discord', 'default', 'portal'), inactiveLine('discord', 'default', 'zulip')]);
    await m.onProcess(incomingFrom('zulip', 'zulip:backend', 'more'), PS);
    expect(said()).toEqual([inactiveLine('discord', 'default', 'portal'), inactiveLine('discord', 'default', 'zulip')]);
    expect(toolCalls).toEqual([]);
    await m.stop();
  });

  test('a GitHub-only host with the default is told the facts, with no server suggested', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 5 });
    m.setFramework(host('github').framework);
    await m.start(mockCtx().ctx);
    await m.onProcess(pushFrom('github', 'github:o/r#1', 'an overheard comment', { tags: ['chat:ambient'] }), PS);
    expect(said()).toEqual([inactiveLine('discord', 'default', 'github')]);
    expect(said()[0]).not.toContain('serverId: "github"');
    await m.stop();
  });

  test('a recipe that names a server the host lacks is told so, naming the recipe', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 5, serverId: 'zulipp' });
    const { ctx, toolCalls } = mockCtx();
    m.setFramework(host('zulip').framework);
    await m.start(ctx);
    await m.onProcess(incomingFrom('zulip', 'zulip:backend', 'ambient chatter'), PS);
    expect(said()).toEqual([inactiveLine('zulipp', 'recipe', 'zulip')]);
    await m.onProcess(incomingFrom('zulip', 'zulip:backend', 'more ambient chatter'), PS);
    expect(said()).toEqual([inactiveLine('zulipp', 'recipe', 'zulip')]);
    expect(toolCalls).toEqual([]);
    await m.stop();
  });

  test('the default on a host that has discord and other chat servers: one note per other server, and discord still closes', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 5 });
    const { ctx, toolCalls } = mockCtx();
    m.setFramework(host('discord', 'portal', 'zulip').framework);
    await m.start(ctx);
    await m.onProcess(pushFrom('portal', 'portal:r1', 'ambient chatter'), PS);
    expect(said()).toEqual([defaultLine('portal')]);
    await m.onProcess(pushFrom('portal', 'portal:r1', 'ambient chatter'), PS);
    await m.onProcess(incomingFrom('zulip', 'zulip:backend', 'ambient chatter'), PS);
    await m.onProcess(incomingFrom('zulip', 'zulip:backend', 'ambient chatter'), PS);
    expect(said()).toEqual([defaultLine('portal'), defaultLine('zulip')]);
    expect(toolCalls).toEqual([]);
    await m.onProcess(ambient('c1', 'abcdefgh'), PS);
    expect(toolCalls.map((c) => c.input.serverId)).toEqual(['discord']);
    expect(said()).toHaveLength(2);
    await m.stop();
  });

  test('a recipe that names discord on purpose hears nothing about the other server', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 5, serverId: 'discord' });
    m.setFramework(host('discord', 'portal').framework);
    await m.start(mockCtx().ctx);
    await m.onProcess(pushFrom('portal', 'portal:r1', 'ambient chatter'), PS);
    await m.onProcess(incomingFrom('portal', 'portal:r1', 'ambient chatter'), PS);
    expect(said()).toEqual([]);
    await m.stop();
  });

  test('a server unloaded or connected while the host runs changes what the module says, and each new line comes once', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 50 });
    const live = host('discord', 'zulip');
    m.setFramework(live.framework);
    await m.start(mockCtx().ctx);
    const settings = () => m.getAgentSettingsExtension().get('agent');
    const listed = async () => (await m.handleToolCall({ id: 'l', name: 'list_channel_idle_limits', input: {} })).data;
    await m.onProcess(incomingFrom('zulip', 'zulip:backend', 'ambient chatter'), PS);
    expect(said()).toEqual([defaultLine('zulip')]);
    expect(settings()).not.toHaveProperty('channel_idle_warning');

    live.servers.splice(live.servers.indexOf('discord'), 1);
    expect(settings().channel_idle_warning).toBe(settingsWarning('discord'));
    expect(await listed()).toMatchObject({ active: false });
    await m.onProcess(incomingFrom('zulip', 'zulip:backend', 'ambient chatter'), PS);
    expect(said()).toEqual([defaultLine('zulip'), inactiveLine('discord', 'default', 'zulip')]);

    live.servers.push('discord');
    expect(settings()).not.toHaveProperty('channel_idle_warning');
    expect(await listed()).toMatchObject({ active: true });
    await m.onProcess(incomingFrom('zulip', 'zulip:backend', 'ambient chatter'), PS);
    expect(said()).toEqual([defaultLine('zulip'), inactiveLine('discord', 'default', 'zulip')]);
    await m.stop();
  });
});

describe('a close that changes nothing says nothing', () => {
  test('"already closed" adds no notice and sends no ops receipt', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 5, serverId: 'discord' });
    const { ctx, toolCalls, getState } = mockCtx();
    const receipts: string[] = [];
    Object.assign(ctx as object, {
      getAgents: () => [{ name: 'mythos' }],
      _receipts: receipts,
      notifyOps(this: { _receipts: string[] }, kind: string) { this._receipts.push(kind); },
      callTool: async (call: { name: string; input: Record<string, unknown> }) => {
        toolCalls.push(call);
        return { success: true, data: { channelId: 'g1:c1', serverId: 'discord', status: 'already closed' } };
      },
    });
    m.setFramework(host('discord').framework);
    await m.start(ctx);
    const r = await m.onProcess(ambient('c1', 'abcdefgh'), PS);
    expect(toolCalls).toHaveLength(1);
    expect(r).toEqual({});
    expect(receipts).toEqual([]);
    expect((getState() as { counters: Record<string, number> }).counters).toEqual({});
    await m.stop();
  });

  test('a real close names its server in the ops receipt and in the notice', async () => {
    const m = new SubscriptionGcModule({ defaultLimitChars: 5, serverId: 'zulip' });
    const { ctx } = mockCtx();
    const receipts: Array<{ message: string; data?: Record<string, unknown> }> = [];
    Object.assign(ctx as object, {
      getAgents: () => [{ name: 'mythos' }],
      _receipts: receipts,
      notifyOps(this: { _receipts: typeof receipts }, _kind: string, _agent: string, message: string, data?: Record<string, unknown>) {
        this._receipts.push({ message, data });
      },
      callTool: async () => ({ success: true, data: { channelId: 'backend', serverId: 'zulip', status: 'closed' } }),
    });
    m.setFramework(host('zulip').framework);
    await m.start(ctx);
    const r = await m.onProcess(incomingFrom('zulip', 'zulip:backend', 'ambient chatter'), PS);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].data).toMatchObject({ channelId: 'zulip:backend', serverId: 'zulip' });
    expect(receipts[0].message).toStartWith('subscription-gc auto-closed channel zulip:backend on server zulip (');
    const notice = r.addMessages?.[0]?.content[0];
    expect(notice?.type === 'text' ? notice.text : '').toStartWith('[subscription-gc] Auto-closed channel zulip:backend on server zulip: ');
    await m.stop();
  });
});

describe('agent_settings and the old tools say which server cleanup watches, and when it is not in force', () => {
  test('get, update and reset name the server, and carry the warning only where the host lacks it', async () => {
    const active = new SubscriptionGcModule();
    active.setFramework(host('discord').framework);
    await active.start(mockCtx().ctx);
    const on = active.getAgentSettingsExtension();
    for (const answer of [
      on.get('agent'),
      on.update('agent', { channel_idle_limits: { 'discord:g1:c1': 5000 } }),
      on.reset('agent'),
    ]) {
      expect(answer.channel_idle_server).toBe('discord');
      expect(answer).not.toHaveProperty('channel_idle_warning');
    }

    const inactive = new SubscriptionGcModule();
    inactive.setFramework(host('portal').framework);
    await inactive.start(mockCtx().ctx);
    const off = inactive.getAgentSettingsExtension();
    for (const answer of [
      off.get('agent'),
      off.update('agent', { channel_idle_limits: { 'portal:r1': 5000 } }),
      off.reset('agent'),
    ]) {
      expect(answer.channel_idle_server).toBe('discord');
      expect(answer.channel_idle_warning).toBe(settingsWarning('discord'));
    }
    expect(off.properties).toEqual(on.properties);
    expect(off.keys).toEqual(on.keys);
  });

  test('the old tools still store and succeed where the host lacks the server, and say it is not in force', async () => {
    const m = new SubscriptionGcModule({ serverId: 'zulipp' });
    m.setFramework(host('zulip').framework);
    await m.start(mockCtx().ctx);
    const pin = await m.handleToolCall({ id: 't1', name: 'pin_channel_idle_limit', input: { channelId: 'zulip:a', pinned: true } });
    expect(pin).toEqual({ success: true, isError: false, data: { message: `Channel zulip:a pinned open (never auto-close).${legacyNote('zulipp')}` } });
    const set = await m.handleToolCall({ id: 't2', name: 'set_channel_idle_limit', input: { channelId: 'zulip:b', limit: 'off' } });
    expect(set).toEqual({ success: true, isError: false, data: { message: `Idle limit for zulip:b set to off (never auto-close).${legacyNote('zulipp')}` } });
    const list = await m.handleToolCall({ id: 't3', name: 'list_channel_idle_limits', input: {} });
    expect(list.data).toMatchObject({ active: false, serverId: 'zulipp', overrides: { 'zulip:b': 'off' }, pins: ['zulip:a'] });
  });

  test('where the host has the server, the old tools add no note and list says active', async () => {
    const m = new SubscriptionGcModule({ serverId: 'zulip' });
    m.setFramework(host('zulip').framework);
    await m.start(mockCtx().ctx);
    const pin = await m.handleToolCall({ id: 't1', name: 'pin_channel_idle_limit', input: { channelId: 'zulip:a', pinned: true } });
    expect(pin.data).toEqual({ message: 'Channel zulip:a pinned open (never auto-close).' });
    const list = await m.handleToolCall({ id: 't3', name: 'list_channel_idle_limits', input: {} });
    expect(list.data).toMatchObject({ active: true, serverId: 'zulip' });
  });
});
