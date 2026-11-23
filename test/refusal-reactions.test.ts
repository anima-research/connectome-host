import { describe, expect, test } from 'bun:test';
import { REFUSAL_REACTION_BASELINE, type AgentFramework, type McplServerConfig, type ToolCall, type ToolResult } from '@animalabs/agent-framework';
import { assertRefusalBridgeAvailable, prepareRefusalReactions, installRefusalReactions, DISCORD_SOURCE, ZULIP_SOURCE,
  type MainRefusal, type RefusalReactionConfig } from '../src/refusal-reactions.js';

const discordConfig = (): RefusalReactionConfig => ({ ownership: 'whole-framework', servers: [{ serverId: 's', kind: 'discord', sourceRevision: DISCORD_SOURCE }] });
const zulipConfig = (idMode: 'strict' | 'compat' | 'legacy' = 'strict'): RefusalReactionConfig => ({ ownership: 'whole-framework', servers: [{ serverId: 's', kind: 'zulip', sourceRevision: ZULIP_SOURCE, realmTag: 'realm', idMode,
  emojis: { bio: 'biohazard', unknown: 'stop_sign' }, availableEmojiNames: ['biohazard', 'stop_sign'] }] });
function servers(config: RefusalReactionConfig): McplServerConfig[] {
  const driver = config.servers[0]!;
  return [{ id: 's', command: 'node', args: ['fixture-only-no-spawn'], env: driver.kind === 'zulip'
    ? { ZULIP_ID_MODE: driver.idMode, ZULIP_REALM_TAG: driver.realmTag }
    : { DISCORD_SUPPRESSED_REACTIONS_BASELINE: REFUSAL_REACTION_BASELINE.join(',') } }];
}
const signal = (messageRef = 'realm:009', turnId = 1): MainRefusal => Object.freeze({ agentName: 'agent', agentInstanceId: 'instance', turnId, category: 'bio', rewind: 'unhandled',
  origin: Object.freeze({ serverId: 's', binding: 'binding', channelId: 'zulip:room', messageRef }) });
function harness(config = zulipConfig()) {
  type Handler = (r: MainRefusal) => void | Promise<void>;
  let owner: { handler: Handler } | undefined;
  let current = true;
  let binding: string | undefined = 'binding';
  let epoch: string | undefined = 'epoch';
  let suppression: unknown = { source: 'baseline-default', status: 'active', protectionActive: true };
  let onCall: ((call: ToolCall) => Promise<ToolResult>) | undefined;
  const calls: ToolCall[] = [];
  const diagnostics: string[] = [];
  const alerts: unknown[][] = [];
  const tools: any[] = config.servers[0]!.kind === 'discord' ? [
    { name: 'p--add_reaction', inputSchema: { type: 'object', properties: { channelId: { type: 'string' }, messageId: { type: ['string', 'null'] }, emoji: { type: 'string' } }, required: ['channelId', 'emoji'] } },
    { name: 'p--filters_get', inputSchema: { type: 'object', properties: {} } },
  ] : [{ name: 'p--add_reaction', inputSchema: { type: 'object', properties: { message_id: { type: config.servers[0]!.kind === 'zulip' && config.servers[0]!.idMode === 'legacy' ? 'number' : ['string'] }, emoji_name: { type: 'string' } }, required: ['message_id', 'emoji_name'] } }];
  const serverRows = [{ id: 's', connected: true, transport: 'stdio', family: 'legacy', refused: null, toolPrefix: 'p' }];
  const framework = {
    notifyOps: (...args: unknown[]) => { alerts.push(args); },
    getMainRefusalBridge: () => ({ version: 1, isCurrent: () => current, serverBinding: () => binding, serverEpoch: () => epoch,
      takeOwnership: (handler: Handler) => {
        if (owner) throw Error('already owned');
        const acquired = { handler };
        owner = acquired;
        return () => { if (owner === acquired) owner = undefined; };
      } }),
    listMcplServers: () => serverRows,
    getAllTools: () => tools,
    executeToolCall: async (call: ToolCall): Promise<ToolResult> => {
      calls.push(call);
      if (onCall) return onCall(call);
      return call.name === 'p--filters_get' ? { success: true, data: [{ type: 'text', text: JSON.stringify({ reactionSuppression: suppression }) }] } : { success: true, data: 'Reaction added' };
    },
  };
  const prepared = prepareRefusalReactions(config, servers(config));
  const install = (duringSessionSwitch = false) => installRefusalReactions(framework as unknown as Pick<AgentFramework, 'executeToolCall' | 'getAllTools' | 'listMcplServers'>, config, prepared, d => diagnostics.push(d), duringSessionSwitch);
  return { config, framework, prepared, tools, serverRows, calls, diagnostics, alerts, install, emit: (r: MainRefusal) => owner?.handler(r),
    setCurrent: (v: boolean) => { current = v; }, setBinding: (v: string | undefined) => { binding = v; }, setEpoch: (v: string | undefined) => { epoch = v; },
    setSuppression: (v: unknown) => { suppression = v; }, setCall: (fn: typeof onCall) => { onCall = fn; } };
}

test('old AF is honestly unsupported only when the feature is selected; omission is identity', () => {
  const input: McplServerConfig[] = [];
  expect(prepareRefusalReactions(undefined, input)).toBe(input);
  expect(() => assertRefusalBridgeAvailable({})).toThrow('unsupported');
  expect(() => installRefusalReactions({ getMainRefusalBridge: () => ({ version: 1 }) } as any, zulipConfig(), [])).toThrow('capability');
  const h = harness();
  const bridge = h.framework.getMainRefusalBridge();
  h.framework.getMainRefusalBridge = () => ({ ...bridge, version: 2 });
  expect(h.install).toThrow('Unsupported main refusal bridge capability');
  expect(h.emit(signal())).toBeUndefined();
});

test('explicit whole-framework ownership and known configured stdio/pin are required', () => {
  for (const config of [{ ...zulipConfig(), ownership: 'selected-servers' }, { ...zulipConfig(), servers: [...zulipConfig().servers, ...zulipConfig().servers] }]) {
    expect(() => prepareRefusalReactions(config as any, servers(zulipConfig()))).toThrow();
  }
  for (const change of [{ url: 'https://example.invalid' }, { inheritEnv: true }, { command: '' }]) {
    expect(() => prepareRefusalReactions(zulipConfig(), [{ ...servers(zulipConfig())[0]!, ...change }])).toThrow();
  }
  const c = zulipConfig(); c.servers[0]!.sourceRevision = 'unknown' as any;
  expect(() => prepareRefusalReactions(c, servers(c))).toThrow('source contract');
});

test('Zulip injects names, preserves existing baseline, never writes operator files; Discord preserves the AF default and checks only explicit seeds', () => {
  const c = zulipConfig(); const input = servers(c); input[0]!.env!.ZULIP_SUPPRESSED_REACTIONS_BASELINE = 'operator_extra';
  const prepared = prepareRefusalReactions(c, input);
  expect(prepared[0]!.env!.ZULIP_SUPPRESSED_REACTIONS_BASELINE).toBe('operator_extra,biohazard,stop_sign');
  expect(input[0]!.env!.ZULIP_SUPPRESSED_REACTIONS_BASELINE).toBe('operator_extra');
  expect(Object.isFrozen(prepared[0]!.env)).toBe(true);
  const d = discordConfig(); const ds = servers(d); ds[0]!.env = {};
  expect(prepareRefusalReactions(d, ds)[0]!.env).toEqual({});
  ds[0]!.env = { DISCORD_SUPPRESSED_REACTIONS_BASELINE: 'incomplete' };
  expect(() => prepareRefusalReactions(d, ds)).toThrow('s: Discord refusal suppression seed');
  ds[0]!.env.DISCORD_SUPPRESSED_REACTIONS_BASELINE = REFUSAL_REACTION_BASELINE.join(',') + ',custom:123';
  expect(prepareRefusalReactions(d, ds)[0]!.env).toEqual(ds[0]!.env);
  const z = zulipConfig(); if (z.servers[0]!.kind === 'zulip') z.servers[0]!.availableEmojiNames = [];
  expect(() => prepareRefusalReactions(z, servers(z))).toThrow('preflight');
  const wrongEnv = servers(c); wrongEnv[0]!.env!.ZULIP_REALM_TAG = 'wrong';
  expect(() => prepareRefusalReactions(c, wrongEnv)).toThrow('ID contract');
});

test.each(['', '  ', ', ,,, '])('Discord seed %j preserves AF’s default', (seed) => {
  const config = discordConfig();
  const env = { DISCORD_SUPPRESSED_REACTIONS_BASELINE: seed };
  expect(prepareRefusalReactions(config, [{ ...servers(config)[0]!, env }])[0]!.env).toEqual(env);
});

test('Zulip legacy IDs fail preparation rather than taking ownership without a usable ID', () => {
  const config = zulipConfig('legacy');
  expect(() => prepareRefusalReactions(config, servers(config))).toThrow('Refusal server s: Zulip idMode "legacy"');
});

for (const mode of ['strict', 'compat'] as const) {
  for (const id of ['realm:009', '009', 'other:009', 'realm:9007199254740992', ' realm:9', 'realm:0', 'realm:-9']) {
    test(`Zulip ${mode} preserves or refuses opaque ${id}`, async () => {
      const h = harness(zulipConfig(mode)); h.install(); await h.emit(signal(id));
      const accepted = id === 'realm:009' || (id === '009' && mode === 'compat');
      expect(h.calls.length).toBe(accepted ? 1 : 0);
      if (accepted) {
        expect(h.calls[0]!.input).toEqual({ message_id: id, emoji_name: 'biohazard' });
        expect(h.calls[0]!.callerAgentName).toBe('agent');
      }
    });
  }
}

test('ADD only, per-turn dedup, unknown ack has no automatic retry and a new turn is independent', async () => {
  const h = harness(); h.setCall(async () => { throw Error('ack lost'); }); h.install();
  await h.emit(signal()); await h.emit(signal());
  expect(h.calls.length).toBe(1); expect(h.diagnostics[0]).toStartWith('add-or-preflight-ack-unknown: no retry');
  await h.emit(signal('realm:009', 2)); expect(h.calls.length).toBe(2);
  expect(h.calls.every(c => c.name === 'p--add_reaction')).toBe(true);
});

test('handled rewind, unknown origin, unselected server, stale instance/binding/epoch do not effect', async () => {
  for (const change of ['rewind', 'unknown', 'unselected', 'instance', 'binding', 'epoch']) {
    const h = harness(); h.install(); let s = signal();
    if (change === 'rewind') s = { ...s, rewind: 'handled' };
    if (change === 'unknown') s = { ...s, origin: undefined };
    if (change === 'unselected') s = { ...s, origin: { ...s.origin!, serverId: 'unselected' } };
    if (change === 'instance') h.setCurrent(false);
    if (change === 'binding') h.setBinding('replacement');
    if (change === 'epoch') h.setEpoch('replacement');
    await h.emit(s); expect(h.calls.length).toBe(0);
    if (change === 'unknown') expect(h.diagnostics[0]).toContain('no first-refusal home fallback');
  }
});

test('tool/schema/capability/transport unsupported fails closed', async () => {
  for (const change of ['tool', 'schema', 'constraint', 'required', 'transport', 'connected']) {
    const h = harness(); h.install();
    if (change === 'tool') h.tools.splice(0);
    if (change === 'schema') h.tools[0].inputSchema.properties.message_id.type = 'number';
    if (change === 'constraint') h.tools[0].inputSchema.properties.message_id.enum = ['different'];
    if (change === 'required') h.tools[0].inputSchema.required.push('new-required-field');
    if (change === 'transport') h.serverRows[0]!.transport = 'websocket';
    if (change === 'connected') h.serverRows[0]!.connected = false;
    await h.emit(signal()); expect(h.calls.length).toBe(0);
  }
});
const discordSignal = (): MainRefusal => ({ ...signal(), origin: { ...signal().origin!, channelId: 'discord:12345678901234567:23456789012345678', messageRef: '34567890123456789' } });

test('Discord uses canonical channel contract, same category Unicode, and suppression SOURCE (not counts/digests)', async () => {
  const h = harness(discordConfig()); h.install(); await h.emit(discordSignal());
  expect(h.calls.map(c => c.name)).toEqual(['p--filters_get', 'p--add_reaction']);
  expect(h.calls[1]!.input).toEqual({ channelId: discordSignal().origin!.channelId, messageId: '34567890123456789', emoji: '☣️' });
  for (const status of [{ source: 'file', status: 'active', protectionActive: true, effectiveCount: 999, effectiveDigest: 'same' },
    { source: 'baseline-default', status: 'stale', protectionActive: true }, { source: 'baseline-default', status: 'active', protectionActive: false }, {}]) {
    const x = harness(discordConfig()); x.setSuppression(status); x.install(); await x.emit(discordSignal());
    expect(x.calls.map(c => c.name)).toEqual(['p--filters_get']);
  }
});

test('Discord never blind-splits unknown channel forms or guesses latest message', async () => {
  for (const channelId of ['discord:?:23456789012345678', 'discord:x:y:z', 'discord:123', 'wrong:12345678901234567:23456789012345678']) {
    const h = harness(discordConfig()); h.install(); await h.emit({ ...discordSignal(), origin: { ...discordSignal().origin!, channelId } });
    expect(h.calls.length).toBe(0);
  }
});

test('Discord reports denied, failed and thrown filters_get calls without issuing ADD', async () => {
  for (const [reason, refused] of [['not permitted by allowedTools', true], ['connector unavailable', false], ['transport closed', undefined]] as const) {
    const h = harness(discordConfig());
    h.setCall(async () => {
      if (refused === undefined) throw new Error(reason);
      return { success: false, refused, isError: true, error: reason };
    });
    h.install();
    await h.emit(discordSignal());
    expect(h.calls.map(c => c.name)).toEqual(['p--filters_get']);
    expect(h.diagnostics[0]).toStartWith(`filters_get-${refused ? 'refused' : 'failed'}:`);
    expect(h.diagnostics[0]).toContain(reason);
    expect(h.alerts[0]?.[2]).toContain(reason);
  }
});

test('an epoch/instance/prefix replacement during preflight prevents ADD', async () => {
  for (const change of ['epoch', 'instance', 'prefix']) {
    const h = harness(discordConfig());
    h.setCall(async () => {
      if (change === 'epoch') h.setEpoch('new');
      if (change === 'instance') h.setCurrent(false);
      if (change === 'prefix') h.serverRows[0]!.toolPrefix = 'replacement';
      return { success: true, data: JSON.stringify({ reactionSuppression: { source: 'baseline-default', status: 'active', protectionActive: true } }) };
    });
    h.install(); await h.emit(discordSignal()); expect(h.calls.length).toBe(1);
  }
});

test('overlapping old/new turn effects never remove each other; configuration cannot retarget them', async () => {
  const h = harness(); let finish!: (r: ToolResult) => void;
  h.setCall(call => call.input && (call.input as any).message_id === 'realm:1' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ success: true }));
  h.install();
  const old = h.emit(signal('realm:1', 1));
  if (h.config.servers[0]?.kind === 'zulip') h.config.servers[0].emojis.bio = 'changed';
  await h.emit(signal('realm:2', 2));
  finish({ success: true }); await old;
  expect(h.calls.map(c => c.input)).toEqual([{ message_id: 'realm:1', emoji_name: 'biohazard' }, { message_id: 'realm:2', emoji_name: 'biohazard' }]);
});

test('in-flight effects are bounded without an inference/action loop', async () => {
  const h = harness(); const finishes: Array<(r: ToolResult) => void> = [];
  h.setCall(() => new Promise(resolve => { finishes.push(resolve); })); h.install();
  const work = Array.from({ length: 10 }, (_, n) => h.emit(signal('realm:9', n)));
  expect(h.calls.length).toBe(8); expect(h.diagnostics.filter(d => d.startsWith('effect-capacity-exhausted')).length).toBe(2);
  finishes.forEach(f => f({ success: false })); await Promise.all(work);
});

test('disposing ownership during preflight prevents an unissued ADD', async () => {
  const h = harness(discordConfig());
  let finish!: (r: ToolResult) => void;
  h.setCall(() => new Promise(resolve => { finish = resolve; }));
  const dispose = h.install();
  const pending = h.emit(discordSignal());
  dispose();
  const disposeNext = h.install();
  dispose(); // Must not deactivate the replacement.
  finish({ success: true, data: { reactionSuppression: { source: 'baseline-default', status: 'active', protectionActive: true } } });
  await pending; expect(h.calls.length).toBe(1);
  h.setCall(undefined);
  await h.emit(discordSignal()); // The replacement has its own dedup state.
  expect(h.calls.map(c => c.name)).toEqual(['p--filters_get', 'p--filters_get', 'p--add_reaction']);
  disposeNext();
});

// R1-4: startup failures must not acquire ownership and disable legacy markers.
for (const state of ['closed-tab', 'failed-connect', 'binding', 'epoch'] as const) {
  test(`selected server ${state} fails before handover`, () => {
    const h = harness(discordConfig());
    if (state === 'closed-tab') h.serverRows.splice(0);
    if (state === 'failed-connect') h.serverRows[0]!.connected = false;
    if (state === 'binding') h.setBinding(undefined);
    if (state === 'epoch') h.setEpoch(undefined);
    let acquired = false;
    const bridge = h.framework.getMainRefusalBridge();
    h.framework.getMainRefusalBridge = () => ({ ...bridge, takeOwnership: () => { acquired = true; return () => {}; } });
    expect(h.install).toThrow('Refusal server s: must be connected');
    expect(acquired).toBe(false);
  });
}

test('explicit closed-tab config is rejected before connect', () => {
  const c = discordConfig();
  expect(() => prepareRefusalReactions(c, [{ ...servers(c)[0]!, presentation: 'closed-tab' }])).toThrow('s: closed-tab');
});

test('an unavailable switched-to endpoint stays disabled after reconnect without handing legacy back', async () => {
  const h = harness(discordConfig());
  h.serverRows[0]!.connected = false;
  h.install(true);
  h.serverRows[0]!.connected = true;
  expect(h.emit(discordSignal())).toBeInstanceOf(Promise); // Ownership was taken, not left to AF.
  await h.emit({ ...discordSignal(), turnId: 2 });
  expect(h.calls).toEqual([]);
  expect(h.diagnostics).toEqual([expect.stringContaining('marking is off until restart')]);
});

test('unchanged epoch survives recovery; replacement alerts once with actionable context', async () => {
  const h = harness(discordConfig()); h.install();
  h.serverRows[0]!.connected = false;
  h.serverRows[0]!.connected = true; // AF determines whether a restart preserves its epoch.
  await h.emit(discordSignal());
  expect(h.calls.length).toBe(2);
  h.setEpoch('deployed-config');
  await h.emit({ ...discordSignal(), turnId: 2 });
  await h.emit({ ...discordSignal(), turnId: 3 });
  expect(h.calls.length).toBe(2);
  expect(h.alerts.length).toBe(1);
  expect(h.alerts[0]![3]).toEqual({ serverId: 's', agentName: 'agent', turnId: 2, category: 'bio', status: 'stale-or-unsupported-server' });
  expect(h.diagnostics[1]).toContain('"serverId":"s"');
  expect(h.diagnostics[1]).toContain('"turnId":2');
});
