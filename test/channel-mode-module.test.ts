import { describe, expect, test } from 'bun:test';
import { ChannelRegistry, EventGate, AgentFramework, type ModuleContext, type ToolCall } from '@animalabs/agent-framework';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelModeModule } from '../src/modules/channel-mode-module.js';
import { Membrane, MockAdapter } from '@animalabs/membrane';
import { SubscriptionGcModule } from '../src/modules/subscription-gc-module.js';

type Rule = { name: string; match: { source: string; channel: string } };

function wired(options: {
  entries?: Array<{ serverId: string; descriptor: { id: string; label?: string } }>;
  servers?: Array<{ id: string; connected: boolean }>;
  fallback?: string;
  closeError?: string;
} = {}) {
  const calls: ToolCall[] = [];
  const rules = new Map<string, Rule>();
  const removed: string[] = [];
  const m = new ChannelModeModule({ serverId: options.fallback });
  m.setFramework({
    channels: { listChannelsRaw: () => options.entries ?? [] },
    listMcplServers: () => options.servers ?? ['discord', 'zulip', 'slack'].map(id => ({ id, connected: true })),
    addGatePolicy: (rule: Rule) => { rules.set(rule.name, rule); },
    removeGatePolicy: (name: string) => { removed.push(name); return rules.delete(name); },
  } as unknown as AgentFramework);
  void m.start({ getState: () => undefined, setState: () => {}, callTool: async (call: ToolCall) => {
    calls.push(call);
    return call.name === 'channel_close' && options.closeError
      ? { success: false, error: options.closeError } : { success: true };
  } } as unknown as ModuleContext);
  const set = (channelId: string, mode = 'debounced') => m.handleToolCall({
    id: 'test', name: 'set_channel_mode', input: { channelId, mode },
  });
  return { m, calls, rules, removed, set };
}

// Lifecycle stubs model a real transport: requests cannot succeed while down.
function registryWired(ids = ['zulip', 'discord', 'slack']) {
  const sent: Array<{ serverId: string; method: string }> = [];
  const servers = ids.map(id => ({
    id, isConnected: true, willReconnect: true,
    grant: { has: (path: string) => path === 'channels.lifecycle' },
    sendChannelsOpen: async ({ channelId }: { channelId: string }) => {
      if (!servers.find(s => s.id === id)!.isConnected) throw new Error('transport closed');
      sent.push({ serverId: id, method: 'channels/open' });
      return { channelId };
    },
    sendChannelsClose: async () => {
      if (!servers.find(s => s.id === id)!.isConnected) throw new Error('transport closed');
      sent.push({ serverId: id, method: 'channels/close' });
      return {};
    },
  }));
  const channels = new ChannelRegistry({ getServer: (id: string) => servers.find(s => s.id === id) } as never, {} as never, () => {}, () => {});
  const rules = new Map<string, Rule>();
  const calls: ToolCall[] = [];
  let saved: unknown;
  const framework = {
    channels, listMcplServers: () => servers.map(s => ({ id: s.id, connected: s.isConnected })),
    addGatePolicy: (r: Rule) => { rules.set(r.name, r); },
    removeGatePolicy: (name: string) => rules.delete(name),
  } as unknown as AgentFramework;
  const createModule = async () => {
    const m = new ChannelModeModule();
    m.setFramework(framework);
    await m.start({
      getState: () => structuredClone(saved), setState: (state: unknown) => { saved = structuredClone(state); },
      callTool: async (call: ToolCall) => {
        calls.push(call);
        return call.name.startsWith('subscription-gc--') ? { success: true }
          : channels.handleChannelToolCall(call.name, call.input, { kind: 'module' });
      },
    } as unknown as ModuleContext);
    return m;
  };
  const set = (m: ChannelModeModule, channelId: string, mode = 'debounced', serverId?: string) =>
    m.handleToolCall({ id: 'real', name: 'set_channel_mode', input: { channelId, mode, serverId } });
  const register = (serverId: string, id: string) => channels.handleRegister(serverId, { channels: [{ id, label: id }] } as never);
  return { channels, servers, rules, calls, sent, framework, createModule, set, register, saved: () => saved };
}

describe('channel-mode server ownership', () => {
  test('real lifecycle and framework push routing match the registry owner, not the prefix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'channel-mode-'));
    const w = registryWired();
    const fw = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: new Membrane(new MockAdapter()),
      agents: [{ name: 'test', model: 'mock', systemPrompt: 'test' }], modules: [],
      gate: { configPath: join(dir, 'gate.json'), onboarding: false },
    });
    const gate = (fw as unknown as { eventGate: EventGate }).eventGate;
    const m = await w.createModule();
    m.setFramework({ channels: w.channels, listMcplServers: w.framework.listMcplServers,
      addGatePolicy: fw.addGatePolicy.bind(fw), removeGatePolicy: fw.removeGatePolicy.bind(fw),
    } as unknown as AgentFramework);
    try {
      // The descriptor prefix deliberately differs from the owning connection.
      await w.register('slack', 'zulip:backend');
      expect((await w.set(m, 'zulip:backend')).success).toBe(true);
      for (const eventType of ['mcpl:channel-incoming', 'mcpl:push-event']) {
        // Pushes carry the composite id in origin metadata, not channelId.
        // This exercises the framework's resolveRouteChannel/derivePushEventChannel.
        const event = { content: 'ambient', eventType, serverId: 'slack',
          channelId: eventType === 'mcpl:push-event' ? 'backend' : 'zulip:backend',
          metadata: { mcplChannelId: 'zulip:backend' }, tags: ['chat:ambient'] };
        expect(gate.probe(event).policyName).toBe('channel-mode:debounced:zulip:backend');
        expect(gate.probe({ ...event, serverId: 'zulip' }).policyName).toBeNull();
      }
      expect((await w.set(m, 'zulip:backend', 'mentions')).success).toBe(true);
      expect(gate.probe({ content: 'ambient', eventType: 'mcpl:channel-incoming', serverId: 'slack', channelId: 'zulip:backend', tags: ['chat:ambient'] }).policyName).toBeNull();
      expect(w.sent.at(-1)).toEqual({ serverId: 'slack', method: 'channels/close' });
    } finally {
      await m.stop();
      await fw.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  for (const [channelId, serverId] of [
    ['zulip:backend', 'zulip'], ['slack:C0123ABCD', 'slack'], ['discord:guild:channel', 'discord'],
  ]) {
    test(`${channelId}: open, gate source, and close use ${serverId}`, async () => {
      const w = wired();
      expect((await w.set(channelId)).success).toBe(true);
      expect(w.calls[0]).toMatchObject({ name: 'channel_open', input: { channelId, serverId } });
      expect([...w.rules.values()]).toMatchObject([{ match: { source: serverId, channel: channelId } }]);
      expect((await w.set(channelId, 'mentions')).success).toBe(true);
      expect(w.calls[2]).toMatchObject({ name: 'channel_close', input: { channelId, serverId } });
      expect(w.rules.size).toBe(0);
      expect(w.removed).toEqual([`channel-mode:debounced:${channelId}`]);
    });
  }

  test('mixed servers in one module keep distinct rules and remove only the requested rule', async () => {
    const w = wired();
    for (const id of ['zulip:backend', 'slack:C456', 'discord:g:c']) await w.set(id);
    expect([...w.rules.values()].map(r => r.match.source)).toEqual(['zulip', 'slack', 'discord']);
    await w.set('slack:C456', 'mentions');
    expect([...w.rules.values()].map(r => r.match.channel)).toEqual(['zulip:backend', 'discord:g:c']);
    expect(w.calls.filter(c => c.name === 'channel_open' || c.name === 'channel_close').map(c => c.input.serverId))
      .toEqual(['zulip', 'slack', 'discord', 'slack']);
  });

  test('registry owner overrides a misleading prefix and explicit fallback', async () => {
    const w = wired({ entries: [{ serverId: 'slack', descriptor: { id: 'zulip:backend' } }], fallback: 'discord' });
    await w.set('zulip:backend');
    expect(w.calls[0].input.serverId).toBe('slack');
    expect([...w.rules.values()][0].match.source).toBe('slack');
    await w.set('zulip:backend', 'mentions');
    expect(w.calls[2].input.serverId).toBe('slack');
  });

  test('registry matches exact ids, not labels or substrings', async () => {
    const w = wired({ entries: [{ serverId: 'zulip', descriptor: { id: 'bare-channel', label: 'label-only' } }], fallback: 'slack' });
    expect((await w.set('bare-channel')).success).toBe(true);
    expect(w.calls[0].input.serverId).toBe('zulip');
    for (const id of ['label-only', 'bare']) {
      expect((await w.set(id)).success).toBe(true);
      expect(w.calls.at(-2)!.input.serverId).toBe('slack');
    }
  });

  test('connected prefix wins over a different connected fallback', async () => {
    const w = wired({ fallback: 'discord' });
    await w.set('zulip:backend');
    expect(w.calls[0].input.serverId).toBe('zulip');
    expect([...w.rules.values()][0].match.source).toBe('zulip');
    await w.set('zulip:backend', 'mentions');
    expect(w.calls[2].input.serverId).toBe('zulip');
  });

  for (const fallback of [undefined, 'slack']) {
    test(`bare legacy ids and matching namespaces use ${fallback ?? 'implicit discord'} fallback`, async () => {
      const w = wired({ fallback });
      for (const channelId of ['legacy-id', `${fallback ?? 'discord'}:channel`]) {
        expect((await w.set(channelId)).success).toBe(true);
        expect(w.calls.at(-2)!.input.serverId).toBe(fallback ?? 'discord');
        expect(w.rules.get(`channel-mode:debounced:${channelId}`)!.match.source).toBe(fallback ?? 'discord');
        expect((await w.set(channelId, 'mentions')).success).toBe(true);
        expect(w.calls.at(-2)!.input.serverId).toBe(fallback ?? 'discord');
      }
    });
  }

  for (const fallback of [undefined, 'slack']) {
    test(`unknown namespaces refuse instead of using ${fallback ?? 'implicit discord'} fallback`, async () => {
      const w = wired({ fallback });
      for (const channelId of ['unknown:channel', 'teams:x', ':channel']) {
        const result = await w.set(channelId);
        expect(result.success).toBe(false);
        expect(result.isError).toBe(true);
        expect(result.error).toContain('Nothing changed: Cannot resolve a known MCPL server');
        expect(result.error).not.toContain('disconnected');
      }
      expect(w.calls).toEqual([]);
      expect(w.rules.size).toBe(0);
      expect(w.removed).toEqual([]);
    });
  }

  test('registry owner takes precedence even over an unknown namespace', async () => {
    const w = wired({ entries: [{ serverId: 'slack', descriptor: { id: 'teams:x' } }] });
    expect((await w.set('teams:x')).success).toBe(true);
    expect(w.calls[0].input.serverId).toBe('slack');
    expect([...w.rules.values()][0].match.source).toBe('slack');
  });

  for (const fallback of [undefined, 'discord']) {
    test(`teams:x refuses without lifecycle, persisted gate, or GC side effects (${fallback ?? 'implicit'} fallback, real components)`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'channel-mode-unknown-'));
      const configPath = join(dir, 'gate.json');
      const channels = new ChannelRegistry({ getServer: () => undefined } as never, {} as never, () => {}, () => {});
      const gate = new EventGate({
        configPath, emitTrace: () => {}, addMessage: () => {},
        requestInference: () => {}, getAgentNames: () => ['test'],
      });
      const gc = new SubscriptionGcModule();
      const m = new ChannelModeModule({ serverId: fallback });
      const calls: ToolCall[] = [];
      const savedGcStates: unknown[] = [];
      try {
        await gc.start({
          getState: () => undefined, setState: (state: unknown) => { savedGcStates.push(structuredClone(state)); },
          onTrace: () => () => {},
        } as unknown as ModuleContext);
        m.setFramework({
          channels, listMcplServers: () => [{ id: 'discord', connected: true }],
          addGatePolicy: gate.addPolicy.bind(gate), removeGatePolicy: gate.removePolicy.bind(gate),
        } as unknown as AgentFramework);
        await m.start({ getState: () => undefined, setState: () => {}, callTool: async (call: ToolCall) => {
          calls.push(call);
          return call.name.startsWith('subscription-gc--')
            ? gc.handleToolCall({ ...call, name: call.name.split('--')[1]! })
            : channels.handleChannelToolCall(call.name, call.input, { kind: 'module' });
        } } as unknown as ModuleContext);
        const result = await m.handleToolCall({ id: 'unknown', name: 'set_channel_mode', input: { channelId: 'teams:x', mode: 'debounced' } });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Nothing changed: Cannot resolve a known MCPL server');
        expect(calls).toEqual([]);
        expect(existsSync(configPath)).toBe(false);
        expect(savedGcStates).toEqual([]);
        expect(gc.getAgentSettingsExtension().get('test').channel_idle_pinned).toEqual([]);
        const event = { content: 'ambient', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'teams:x', tags: ['chat:ambient'] };
        expect(gate.probe(event).policyName).toBeNull();
        expect(gate.probe({ ...event, serverId: 'teams' }).policyName).toBeNull();

        // Old wrong-source state must still be removable without an owner.
        gate.addPolicy({ name: 'channel-mode:debounced:teams:x', match: { source: 'discord', channel: 'teams:x' }, behavior: { debounce: 1000 } });
        await gc.handleToolCall({ id: 'old-pin', name: 'pin_channel_idle_limit', input: { channelId: 'teams:x', pinned: true } });
        const cleanup = await m.handleToolCall({ id: 'cleanup', name: 'set_channel_mode', input: { channelId: 'teams:x', mode: 'mentions' } });
        expect(cleanup.success).toBe(false);
        expect(cleanup.error).toContain('skipped: Cannot resolve');
        expect(calls).toMatchObject([{ name: 'subscription-gc--pin_channel_idle_limit', input: { channelId: 'teams:x', pinned: false } }]);
        expect(calls).toHaveLength(1);
        expect(JSON.parse(readFileSync(configPath, 'utf8')).policies).toEqual([]);
        expect(gc.getAgentSettingsExtension().get('test').channel_idle_pinned).toEqual([]);
        expect(gate.probe(event).policyName).toBeNull();
      } finally {
        await m.stop();
        await gc.stop();
        gate.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('real registry accepts Slack conversation ids and refuses an unregistered raw Discord snowflake', async () => {
    const w = registryWired();
    const m = await w.createModule();
    await w.register('slack', 'slack:C0123ABCD');
    await w.register('discord', 'discord:g:123456789012345678');
    expect((await w.set(m, 'slack:C0123ABCD')).success).toBe(true);
    expect(w.channels.getDesiredState('slack', 'slack:C0123ABCD')).toBe('open');
    expect((await w.set(m, 'slack:C0123ABCD', 'mentions')).success).toBe(true);
    const raw = await w.set(m, '123456789012345678');
    // Legacy routing remains, but the registry must not pretend this id exists.
    expect(raw.success).toBe(false);
    expect((raw.data as { steps: Array<{ step: string; ok: boolean }> }).steps[0]).toMatchObject({ step: 'open', ok: false });
    expect(w.channels.getDesiredState('discord', '123456789012345678')).toBeUndefined();
    await m.stop();
  });

  test('debounced refuses unknown, disconnected, and ambiguous ownership before any step', async () => {
    for (const [options, id, message] of [
      [{ servers: [] }, 'legacy-id', /Cannot resolve/],
      [{ fallback: 'missing' }, 'legacy-id', /Cannot resolve/],
      [{ servers: [{ id: 'zulip', connected: false }, { id: 'discord', connected: true }], fallback: 'discord' }, 'zulip:backend', /zulip.*disconnected/],
      [{ entries: [{ serverId: 'slack', descriptor: { id: 'zulip:backend' } }], servers: [{ id: 'discord', connected: true }], fallback: 'discord' }, 'zulip:backend', /slack.*disconnected/],
      [{ entries: ['zulip', 'slack'].map(serverId => ({ serverId, descriptor: { id: 'zulip:backend' } })) }, 'zulip:backend', /multiple MCPL/],
    ] as const) {
      const w = wired(options as Parameters<typeof wired>[0]);
      const result = await w.set(id);
      expect(result.success).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.error).toContain('Nothing changed');
      expect(result.error).toMatch(message);
      if (message.source.includes('disconnected')) expect(result.error).not.toContain('fallback');
      expect(w.calls).toEqual([]);
      expect(w.rules.size).toBe(0);
      expect(w.removed).toEqual([]);
    }
  });

  for (const [serverId, channelId] of [['zulip', 'zulip:backend'], ['discord', 'discord:g:c']]) {
    test(`R1-1 mentions records a disconnected ${serverId} close and re-registration never reopens`, async () => {
      const w = registryWired();
      const m = await w.createModule();
      await w.register(serverId, channelId);
      expect((await w.set(m, channelId)).success).toBe(true);
      expect(w.channels.getDesiredState(serverId, channelId)).toBe('open');
      w.channels.transportClosed(serverId);
      w.servers.find(s => s.id === serverId)!.isConnected = false;
      const before = structuredClone(w.saved());
      const refused = await w.set(m, channelId);
      expect(refused.error).toContain('Nothing changed');
      expect(w.saved()).toEqual(before);
      const result = await w.set(m, channelId, 'mentions');
      expect(result.success).toBe(false);
      expect(result.error).toContain('no need to call channel_close again');
      expect(result.error).not.toContain('to retry');
      expect(w.channels.getDesiredState(serverId, channelId)).toBe('closed');
      expect(w.rules.size).toBe(0);
      expect(w.calls.at(-1)).toMatchObject({ input: { channelId, pinned: false } });
      w.sent.length = 0;
      w.servers.find(s => s.id === serverId)!.isConnected = true;
      await w.register(serverId, channelId);
      expect(w.sent).toEqual([{ serverId, method: 'channels/close' }]);
      expect(w.channels.isChannelOpen({ serverId, channelId })).toBe(false);
      await m.stop();
    });
  }

  test('R1-4 explicit serverId disambiguates real registry owners and is validated', async () => {
    const w = registryWired(['realm-a', 'realm-b']);
    const m = await w.createModule();
    for (const server of w.servers) await w.register(server.id, 'zulip:general');
    const ambiguous = await w.set(m, 'zulip:general');
    expect(ambiguous.error).toContain('realm-a, realm-b');
    expect(ambiguous.error).toContain('Pass serverId');
    expect(w.calls).toEqual([]);
    expect((await w.set(m, 'zulip:general', 'debounced', 'realm-b')).success).toBe(true);
    expect(w.rules.get('channel-mode:debounced:zulip:general')!.match.source).toBe('realm-b');
    expect(w.channels.getDesiredState('realm-b', 'zulip:general')).toBe('open');
    expect(w.channels.getDesiredState('realm-a', 'zulip:general')).toBe('closed');
    // Saved ownership also disambiguates mentions when serverId is omitted.
    expect((await w.set(m, 'zulip:general', 'mentions')).success).toBe(true);
    expect((await w.set(m, 'zulip:general', 'debounced', 'realm-b')).success).toBe(true);
    expect((await w.set(m, 'zulip:general', 'mentions', 'realm-b')).success).toBe(true);
    expect(w.sent.at(-1)).toEqual({ serverId: 'realm-b', method: 'channels/close' });
    const count = w.calls.length;
    expect((await w.set(m, 'zulip:general', 'debounced', 'missing')).error).toContain('missing');
    expect(w.calls).toHaveLength(count);
    for (const serverId of ['', 42, null]) {
      const invalid = await m.handleToolCall({ id: 'invalid', name: 'set_channel_mode', input: { channelId: 'zulip:general', mode: 'debounced', serverId } });
      expect(invalid.error).toContain('Nothing changed: serverId');
    }
    await m.stop();
  });

  test('explicit known server overrides a sole registry owner; mentions closes a known disconnected prefix without saved state', async () => {
    const w = registryWired();
    const m = await w.createModule();
    await w.register('zulip', 'zulip:backend');
    const wrongKnown = await w.set(m, 'zulip:backend', 'debounced', 'slack');
    // A known connection is accepted, but the real registry refuses its missing channel.
    expect((wrongKnown.data as { steps: Array<{ step: string; ok: boolean }> }).steps[0]).toMatchObject({ step: 'open', ok: false });
    expect(w.calls[0]).toMatchObject({ input: { serverId: 'slack' } });
    await w.register('zulip', 'zulip:other');
    expect((await w.channels.handleChannelToolCall('channel_open', { serverId: 'zulip', channelId: 'zulip:other' }, { kind: 'module' })).success).toBe(true);
    w.channels.transportClosed('zulip');
    w.servers.find(s => s.id === 'zulip')!.isConnected = false;
    const result = await w.set(m, 'zulip:other', 'mentions');
    expect(result.error).toContain('no need to call channel_close again');
    expect(w.channels.getDesiredState('zulip', 'zulip:other')).toBe('closed');
    await m.stop();
  });

  for (const removeKnownServer of [false, true]) {
    test(`R1-4 persisted owner prevents cleanup retargeting after removeServer (known removed: ${removeKnownServer})`, async () => {
      const w = registryWired(['realm-a', 'realm-b']);
      const m = await w.createModule();
      await w.register('realm-a', 'zulip:general');
      expect((await w.set(m, 'zulip:general')).success).toBe(true);
      expect(w.saved()).toEqual({ owners: { 'zulip:general': 'realm-a' } });
      await m.stop();
      w.channels.removeServer('realm-a');
      if (removeKnownServer) w.servers.splice(0, 1);
      else w.servers[0].isConnected = false;
      await w.register('realm-b', 'zulip:general');
      const restarted = await w.createModule();
      w.calls.length = 0;
      const result = await w.set(restarted, 'zulip:general', 'mentions');
      expect(result.success).toBe(false);
      expect(w.rules.size).toBe(0);
      expect(w.calls.filter(c => c.name === 'channel_close').map(c => c.input.serverId))
        .toEqual(removeKnownServer ? [] : ['realm-a']);
      expect(w.channels.getDesiredState('realm-b', 'zulip:general')).toBe('closed');
      // An explicit override remains available to target the other owner.
      expect((await w.set(restarted, 'zulip:general', 'debounced', 'realm-b')).success).toBe(true);
      expect((await w.set(restarted, 'zulip:general', 'mentions')).success).toBe(true);
      expect(w.sent.at(-1)).toEqual({ serverId: 'realm-b', method: 'channels/close' });
      await restarted.stop();
    });
  }

  test('mentions still removes rule and pin when ownership is unknown or ambiguous', async () => {
    for (const entries of [[], ['zulip', 'slack'].map(serverId => ({ serverId, descriptor: { id: 'legacy-id' } }))]) {
      const w = wired({ servers: [], entries });
      w.rules.set('channel-mode:debounced:legacy-id', { name: 'channel-mode:debounced:legacy-id', match: { source: 'discord', channel: 'legacy-id' } });
      const result = await w.set('legacy-id', 'mentions');
      expect(result.error).toContain('skipped');
      expect(w.rules.size).toBe(0);
      expect(w.calls).toMatchObject([{ input: { pinned: false } }]);
      expect(w.calls).toHaveLength(1);
    }
  });

  test('mentions reports a failed close while removing rule and pin', async () => {
    const w = wired({ closeError: 'adapter refused close' });
    await w.set('zulip:backend');
    const result = await w.set('zulip:backend', 'mentions');
    expect(result.success).toBe(false);
    expect(result.error).toContain('closing the channel failed (adapter refused close)');
    expect(w.rules.size).toBe(0);
    expect(w.calls.at(-1)).toMatchObject({ input: { pinned: false } });
  });

  for (const mode of ['debounced', 'mentions']) {
    test(`reapplying ${mode} repairs a persisted wrong-source rule with the real EventGate`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'channel-mode-reapply-'));
      const configPath = join(dir, 'gate.json');
      const channelId = 'zulip:backend';
      const name = `channel-mode:debounced:${channelId}`;
      writeFileSync(configPath, JSON.stringify({ policies: [{ name, match: { source: 'discord', channel: channelId, tagsAny: ['chat:ambient'] }, behavior: { debounce: 1000 } }] }));
      const gate = new EventGate({ configPath, emitTrace: () => {}, addMessage: () => {}, requestInference: () => {}, getAgentNames: () => ['test'] });
      const m = new ChannelModeModule();
      const event = { content: 'ambient', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId, tags: ['chat:ambient'] };
      try {
        expect(gate.probe(event).policyName).toBe(name);
        m.setFramework({ listMcplServers: () => [{ id: 'zulip', connected: true }], addGatePolicy: gate.addPolicy.bind(gate), removeGatePolicy: gate.removePolicy.bind(gate) } as unknown as AgentFramework);
        await m.start({ getState: () => undefined, setState: () => {}, callTool: async () => ({ success: true }) } as unknown as ModuleContext);
        expect((await m.handleToolCall({ id: 'reapply', name: 'set_channel_mode', input: { channelId, mode } })).success).toBe(true);
        expect(gate.probe(event).policyName).toBeNull();
        expect(gate.probe({ ...event, serverId: 'zulip' }).policyName).toBe(mode === 'debounced' ? name : null);
        const saved = JSON.parse(readFileSync(configPath, 'utf8')).policies;
        expect(saved).toHaveLength(mode === 'debounced' ? 1 : 0);
        if (mode === 'debounced') expect(saved[0].match.source).toBe('zulip');
      } finally {
        await m.stop();
        gate.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('tool schema explains the raw-id legacy fallback without promising a matching rule', () => {
    const schema = JSON.stringify(new ChannelModeModule().getTools()[0].inputSchema);
    expect(schema).toContain('legacy');
    expect(schema).toContain('no colon');
    expect(schema).toContain('Unknown namespaces are refused');
    expect(schema).not.toContain('silently');
    expect(schema).toContain('slack:<conversationId>');
    expect(schema).not.toContain('teamId');
    expect(schema).toContain('serverId');
  });
});
