import { describe, expect, spyOn, test } from 'bun:test';
import { ChannelRegistry, EventGate, AgentFramework, type ModuleContext, type ToolCall } from '@animalabs/agent-framework';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelModeModule } from '../src/modules/channel-mode-module.js';
import { Membrane, MockAdapter } from '@animalabs/membrane';

type Rule = { name: string; match: { source: string; channel: string } };

/** Fake lifecycle: every tool call succeeds unless listed in `failing`. */
function wired(options: {
  servers?: Array<{ id: string; connected: boolean }>;
  config?: ConstructorParameters<typeof ChannelModeModule>[0];
  failing?: string[];
  gateFails?: boolean;
  entries?: Array<{ serverId: string; descriptor: { id: string } }>;
} = {}) {
  const calls: ToolCall[] = [];
  const rules = new Map<string, Rule>();
  const removed: string[] = [];
  const gates: string[] = [];
  let hold: Promise<void> | null = null;
  const m = new ChannelModeModule(options.config);
  m.setFramework({
    // Never consulted: routing is the prefix only.
    channels: { listChannelsRaw: () => options.entries ?? [], getDesiredState: () => undefined, isChannelOpen: () => false },
    listMcplServers: () => options.servers ?? ['discord', 'zulip', 'slack'].map(id => ({ id, connected: true })),
    addGatePolicy: (rule: Rule) => {
      gates.push(`add ${rule.name}`);
      if (options.gateFails) throw new Error('debounce rule refused');
      rules.set(rule.name, rule);
    },
    removeGatePolicy: (name: string) => { gates.push(`remove ${name}`); removed.push(name); return rules.delete(name); },
  } as unknown as AgentFramework);
  void m.start({ callTool: async (call: ToolCall) => {
    calls.push(call);
    if (hold) await hold;
    return options.failing?.includes(call.name) ? { success: false, error: `${call.name} refused` } : { success: true };
  } } as unknown as ModuleContext);
  const set = (channelId: unknown, mode = 'debounced', extra: Record<string, unknown> = {}) => m.handleToolCall({
    id: 'test', name: 'set_channel_mode', input: { channelId, mode, ...extra },
  });
  const holdCalls = () => {
    let release!: () => void;
    hold = new Promise<void>(resolve => { release = () => { hold = null; resolve(); }; });
    return release;
  };
  return { m, calls, rules, removed, gates, set, holdCalls };
}

describe('channel-mode routes each call to the server named by the id prefix', () => {
  for (const [channelId, serverId] of [
    ['zulip:backend', 'zulip'], ['slack:C0123ABCD', 'slack'], ['discord:guild:channel', 'discord'],
  ]) {
    test(`${channelId}: open, gate source and close use ${serverId}`, async () => {
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

  test('each call installs one rule, for its own server only', async () => {
    const w = wired();
    for (const id of ['zulip:backend', 'slack:C456', 'discord:g:c']) await w.set(id);
    expect([...w.rules.values()].map(r => [r.match.source, r.match.channel])).toEqual([
      ['zulip', 'zulip:backend'], ['slack', 'slack:C456'], ['discord', 'discord:g:c'],
    ]);
    // Reapplying replaces the id's rule rather than adding a second one.
    await w.set('zulip:backend', 'debounced', { debounceMs: 5000 });
    expect(w.rules.size).toBe(3);
    await w.set('slack:C456', 'mentions');
    expect([...w.rules.keys()]).toEqual(['channel-mode:debounced:zulip:backend', 'channel-mode:debounced:discord:g:c']);
    expect(w.calls.filter(c => c.name === 'channel_open' || c.name === 'channel_close').map(c => c.input.serverId))
      .toEqual(['zulip', 'slack', 'discord', 'zulip', 'slack']);
  });

  test('a known but disconnected server still gets all three steps', async () => {
    const w = wired({ servers: [{ id: 'discord', connected: false }] });
    expect((await w.set('discord:g:c')).success).toBe(true);
    expect(w.calls.map(c => c.name)).toEqual(['channel_open', 'subscription-gc--pin_channel_idle_limit']);
    expect(w.rules.get('channel-mode:debounced:discord:g:c')!.match.source).toBe('discord');
  });

  test('registry entries naming another server do not change the route', async () => {
    const w = wired({ entries: [{ serverId: 'slack', descriptor: { id: 'zulip:backend' } }] });
    await w.set('zulip:backend');
    await w.set('zulip:backend', 'mentions');
    expect(w.calls.filter(c => c.name.startsWith('channel_')).map(c => c.input.serverId)).toEqual(['zulip', 'zulip']);
  });

  test('an ignored config serverId is named once at startup and routes nothing', async () => {
    const lines: string[] = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    let w: ReturnType<typeof wired>;
    try {
      w = wired({ config: { serverId: 'zulip' } });
      wired();
    } finally {
      spy.mockRestore();
    }
    expect(lines).toEqual([
      `[gate] channel-mode's serverId "zulip" is ignored: set_channel_mode takes each channel's server from the ` +
      'prefix of its id (zulip:<stream>, discord:<guildId>:<channelId>).',
    ]);
    await w.set('discord:g:c');
    expect(w.calls[0]!.input.serverId).toBe('discord');
    expect((await w.set('backend')).success).toBe(false);
  });
});

describe('channel-mode refuses before any step', () => {
  for (const mode of ['debounced', 'mentions']) {
    test(`ids without a server prefix are refused in ${mode}, naming the expected form`, async () => {
      // Includes a raw Discord snowflake: on a Discord-only host it used to route to discord.
      for (const channelId of ['123456789012345678', 'backend', ':backend', 'zulip:']) {
        const w = wired({ servers: [{ id: 'discord', connected: true }] });
        const result = await w.set(channelId, mode);
        expect(result.success).toBe(false);
        expect(result.isError).toBe(true);
        expect(result.error).toBe(
          `Nothing changed: channelId ${JSON.stringify(channelId)} has no server prefix: give it as <serverId>:<channel>, ` +
          'exactly as channel_list shows it (for example zulip:<stream> or discord:<guildId>:<channelId>), ' +
          'where <serverId> is the MCPL server that owns the channel.',
        );
        expect(w.calls).toEqual([]);
        expect(w.gates).toEqual([]);
      }
    });

    test(`an unknown prefix is refused in ${mode}, naming the known servers`, async () => {
      const w = wired({ servers: [{ id: 'zulip', connected: false }, { id: 'discord', connected: true }] });
      for (const channelId of ['teams:x', 'slack:C1', 'Discord:g:c']) {
        const result = await w.set(channelId, mode);
        expect(result.success).toBe(false);
        expect(result.error).toStartWith(
          `Nothing changed: channelId ${channelId} names MCPL server "${channelId.split(':')[0]}", which this host ` +
          "doesn't know (it knows discord and zulip); give it as <serverId>:<channel>",
        );
      }
      const none = await wired({ servers: [] }).set('discord:g:c', mode);
      expect(none.error).toContain("which this host doesn't know (it knows none)");
      expect(w.calls).toEqual([]);
      expect(w.gates).toEqual([]);
    });
  }

  for (const mode of ['debounced', 'mentions']) {
    test(`an id with * in its server or channel is refused in ${mode}, as the gate would read it as a wildcard`, async () => {
      // Review witnesses: discord:* took discord:123:456's events, and chat*:room
      // on a server named chat* took chat1:room's.
      const w = wired({ servers: ['discord', 'chat*', 'chat1'].map(id => ({ id, connected: true })) });
      for (const channelId of ['discord:*', 'discord:123:*', 'chat*:room', '*:room']) {
        const result = await w.set(channelId, mode);
        expect(result.success).toBe(false);
        expect(result.error).toBe(
          `Nothing changed: channelId ${JSON.stringify(channelId)} contains *, which the gate reads as a wildcard, so ` +
          'its rule could match other channels or servers; channel mode takes one exact channel id, with no * in its ' +
          'server or channel.',
        );
      }
      expect(w.calls).toEqual([]);
      expect(w.gates).toEqual([]);
    });
  }

  test('a prefix problem is named alongside other input problems', async () => {
    const w = wired();
    const result = await w.set('backend', 'loud');
    expect(result.error).toStartWith('Nothing changed: channelId "backend" has no server prefix');
    expect(result.error).toContain('; mode must be "debounced"');
  });

  for (const [first, second] of [
    ['debounced', 'debounced'], ['debounced', 'mentions'], ['mentions', 'debounced'], ['mentions', 'mentions'],
  ]) {
    test(`one call per exact id at a time (${first} then ${second})`, async () => {
      const w = wired();
      const release = w.holdCalls();
      const running = w.set('zulip:backend', first);
      await Promise.resolve();
      const gatesBefore = [...w.gates];
      const callsBefore = w.calls.length;
      const busy = await w.set('zulip:backend', second);
      expect(busy.success).toBe(false);
      expect(busy.error).toBe(
        'Nothing changed: another channel-mode--set_channel_mode call for channel zulip:backend is still in progress. ' +
        'Wait for its result, then call again if it is still needed.',
      );
      expect(w.gates).toEqual(gatesBefore);
      expect(w.calls).toHaveLength(callsBefore);
      // A different id is not held up.
      const other = w.set('zulip:frontend', second);
      release();
      expect((await running).success).toBe(true);
      expect((await other).success).toBe(true);
      // Once the first call ends, the id is free again.
      expect((await w.set('zulip:backend', second)).success).toBe(true);
    });
  }

  test('a call that fails still frees its id', async () => {
    const w = wired({ failing: ['channel_open'] });
    expect((await w.set('zulip:backend')).success).toBe(false);
    expect((await w.set('zulip:backend')).error).not.toContain('in progress');
  });
});

describe('channel-mode closes only what the call targets', () => {
  test('debounced never closes or rolls back when a later step fails', async () => {
    for (const options of [{ gateFails: true }, { failing: ['subscription-gc--pin_channel_idle_limit'] }]) {
      const w = wired(options);
      const result = await w.set('zulip:backend');
      expect(result.success).toBe(false);
      expect(w.calls.map(c => c.name)).toEqual(['channel_open', 'subscription-gc--pin_channel_idle_limit']);
      expect(w.gates.filter(g => g.startsWith('remove'))).toEqual([]);
    }
  });

  test('mentions closes on the prefix server and leaves the same id open on another server', async () => {
    const servers = ['zulip', 'slack'].map(id => ({
      id, isConnected: true, willReconnect: true,
      grant: { has: (path: string) => path === 'channels.lifecycle' },
      sendChannelsOpen: async ({ channelId }: { channelId: string }) => ({ channelId }),
      sendChannelsClose: async () => ({}),
    }));
    const channels = new ChannelRegistry({ getServer: (id: string) => servers.find(s => s.id === id) } as never, {} as never, () => {}, () => {});
    for (const { id } of servers) await channels.handleRegister(id, { channels: [{ id: 'zulip:backend', label: 'backend' }] } as never);
    const m = new ChannelModeModule();
    m.setFramework({
      channels, listMcplServers: () => servers.map(s => ({ id: s.id, connected: true })),
      addGatePolicy: () => {}, removeGatePolicy: () => true,
    } as unknown as AgentFramework);
    await m.start({ callTool: async (call: ToolCall) => call.name.startsWith('subscription-gc--')
      ? { success: true }
      : channels.handleChannelToolCall(call.name, call.input, { kind: 'module' }),
    } as unknown as ModuleContext);
    await channels.handleChannelToolCall('channel_open', { channelId: 'zulip:backend', serverId: 'slack' }, { kind: 'module' });
    const set = (mode: string) => m.handleToolCall({ id: 'real', name: 'set_channel_mode', input: { channelId: 'zulip:backend', mode } });
    expect((await set('debounced')).success).toBe(true);
    expect(channels.getDesiredState('zulip', 'zulip:backend')).toBe('open');
    expect((await set('mentions')).success).toBe(true);
    expect(channels.getDesiredState('zulip', 'zulip:backend')).toBe('closed');
    expect(channels.getDesiredState('slack', 'zulip:backend')).toBe('open');
    await m.stop();
  });

  // Review witness: a registered channel on a disconnected server, an unusable
  // gate and no GC. Every step fails, but the registry records the decision.
  // A close on a disconnected server succeeds, so mentions fails its close on
  // a connected one.
  for (const mode of ['debounced', 'mentions'] as const) {
    test(`${mode}: a failed step whose decision was recorded is reported as recorded, not as nothing changed`, async () => {
      let down = false;
      const server = {
        id: 'discord', isConnected: true, willReconnect: true,
        grant: { has: (path: string) => path === 'channels.lifecycle' },
        sendChannelsOpen: async ({ channelId }: { channelId: string }) => {
          if (down) throw new Error('transport offline');
          return { channelId };
        },
        sendChannelsClose: async () => {
          if (down) throw new Error('transport offline');
          return {};
        },
      };
      const channels = new ChannelRegistry({ getServer: (id: string) => id === 'discord' ? server : undefined } as never, {} as never, () => {}, () => {});
      await channels.handleRegister('discord', { channels: [{ id: 'discord:123:456', label: 'general' }, { id: 'discord:123:789', label: 'other' }] } as never);
      if (mode === 'mentions') await channels.handleChannelToolCall('channel_open', { channelId: 'discord:123:456', serverId: 'discord' }, { kind: 'module' });
      down = true;
      server.isConnected = mode === 'mentions';
      const m = new ChannelModeModule();
      m.setFramework({
        channels, listMcplServers: () => [{ id: 'discord', connected: server.isConnected }],
        addGatePolicy: () => { throw new Error('gate.json is not JSON'); },
        removeGatePolicy: () => { throw new Error('gate.json is not JSON'); },
      } as unknown as AgentFramework);
      await m.start({ callTool: async (call: ToolCall) => call.name.startsWith('subscription-gc--')
        ? { success: false, error: 'Module not found: subscription-gc' }
        : channels.handleChannelToolCall(call.name, call.input, { kind: 'module' }),
      } as unknown as ModuleContext);
      const before = channels.getDesiredState('discord', 'discord:123:456');
      const result = await m.handleToolCall({ id: 'rec', name: 'set_channel_mode', input: { channelId: 'discord:123:456', mode } });
      const target = mode === 'debounced' ? 'open' : 'closed';
      expect(before).toBe(mode === 'debounced' ? 'closed' : 'open');
      expect(channels.getDesiredState('discord', 'discord:123:456')).toBe(target);
      expect(result.success).toBe(false);
      expect(result.error).not.toContain('Nothing changed for');
      expect(result.error).toStartWith(
        `Channel discord:123:456 is only partly in ${mode} mode: its ${mode === 'debounced' ? 'open' : 'close'} is ` +
        `recorded but the channel isn't ${target} yet, and `,
      );
      const later = ' It opens once the "discord" server reconnects and registers this channel, if this host may ' +
        'open and close its channels then. Each step is safe to repeat';
      if (mode === 'debounced') expect(result.error).toContain(later);
      else expect(result.error).not.toContain('reconnects');
      // An unregistered id records nothing, and the result claims nothing recorded.
      const unregistered = await m.handleToolCall({ id: 'none', name: 'set_channel_mode', input: { channelId: 'discord:123:000', mode } });
      expect(channels.getDesiredState('discord', 'discord:123:000')).toBeUndefined();
      expect(unregistered.error).toStartWith('No step for channel discord:123:000 reported success: ');
      expect(unregistered.error).not.toContain('recorded but');
      expect(unregistered.error).not.toContain('reconnects');
      await m.stop();
    });
  }

  test('a failed close is reported and retried on the same server', async () => {
    const w = wired({ failing: ['channel_close'] });
    await w.set('zulip:backend');
    const result = await w.set('zulip:backend', 'mentions');
    expect(result.success).toBe(false);
    expect(result.error).toContain('closing the channel failed (channel_close refused)');
    expect(result.error).toContain('again with the same channelId and mode to retry');
    expect(w.rules.size).toBe(0);
    expect(w.calls.at(-1)).toMatchObject({ input: { pinned: false } });
  });
});

describe('channel-mode with real framework parts', () => {
  test('framework push and incoming events match the rule on the prefix server only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'channel-mode-'));
    const fw = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: new Membrane(new MockAdapter()),
      agents: [{ name: 'test', model: 'mock', systemPrompt: 'test' }], modules: [],
      gate: { configPath: join(dir, 'gate.json'), onboarding: false },
    });
    const gate = (fw as unknown as { eventGate: EventGate }).eventGate;
    const m = new ChannelModeModule();
    m.setFramework({ listMcplServers: () => [{ id: 'zulip', connected: true }],
      addGatePolicy: fw.addGatePolicy.bind(fw), removeGatePolicy: fw.removeGatePolicy.bind(fw),
    } as unknown as AgentFramework);
    await m.start({ callTool: async () => ({ success: true }) } as unknown as ModuleContext);
    const set = (mode: string) => m.handleToolCall({ id: 'real', name: 'set_channel_mode', input: { channelId: 'zulip:backend', mode } });
    try {
      expect((await set('debounced')).success).toBe(true);
      for (const eventType of ['mcpl:channel-incoming', 'mcpl:push-event']) {
        // Pushes carry the composite id in origin metadata, not channelId.
        const event = { content: 'ambient', eventType, serverId: 'zulip',
          channelId: eventType === 'mcpl:push-event' ? 'backend' : 'zulip:backend',
          metadata: { mcplChannelId: 'zulip:backend' }, tags: ['chat:ambient'] };
        expect(gate.probe(event).policyName).toBe('channel-mode:debounced:zulip:backend');
        expect(gate.probe({ ...event, serverId: 'discord' }).policyName).toBeNull();
      }
      expect((await set('mentions')).success).toBe(true);
      expect(gate.probe({ content: 'ambient', eventType: 'mcpl:channel-incoming', serverId: 'zulip', channelId: 'zulip:backend', tags: ['chat:ambient'] }).policyName).toBeNull();
    } finally {
      await m.stop();
      await fw.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const mode of ['debounced', 'mentions']) {
    test(`${mode} replaces or removes an older release's discord-source rule for a prefixed id`, async () => {
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
        await m.start({ callTool: async () => ({ success: true }) } as unknown as ModuleContext);
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

  test('a * id installs no rule that takes another server\'s or channel\'s events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'channel-mode-glob-'));
    const fw = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: new Membrane(new MockAdapter()),
      agents: [{ name: 'test', model: 'mock', systemPrompt: 'test' }], modules: [],
      gate: { configPath: join(dir, 'gate.json'), onboarding: false },
    });
    const gate = (fw as unknown as { eventGate: EventGate }).eventGate;
    const m = new ChannelModeModule();
    m.setFramework({ listMcplServers: () => ['discord', 'chat*', 'chat1'].map(id => ({ id, connected: true })),
      addGatePolicy: fw.addGatePolicy.bind(fw), removeGatePolicy: fw.removeGatePolicy.bind(fw),
    } as unknown as AgentFramework);
    const calls: string[] = [];
    await m.start({ callTool: async (call: ToolCall) => { calls.push(call.name); return { success: true }; } } as unknown as ModuleContext);
    const probe = (serverId: string, channelId: string) => gate.probe({
      content: 'ambient', eventType: 'mcpl:channel-incoming', serverId, channelId, tags: ['chat:ambient'],
    }).policyName;
    try {
      for (const channelId of ['discord:*', 'chat*:room']) {
        const result = await m.handleToolCall({ id: 'glob', name: 'set_channel_mode', input: { channelId, mode: 'debounced' } });
        expect(result.success).toBe(false);
      }
      expect(probe('discord', 'discord:123:456')).toBeNull();
      expect(probe('chat1', 'chat1:room')).toBeNull();
      expect(calls).toEqual([]);
    } finally {
      await m.stop();
      await fw.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('tool text names the prefix rule and carries no server selector', () => {
    const tool = new ChannelModeModule().getTools()[0]!;
    const schema = tool.inputSchema as { properties: Record<string, { description?: string }> };
    expect(Object.keys(schema.properties)).toEqual(['channelId', 'mode', 'debounceMs']);
    expect(schema.properties.channelId!.description).toContain('<serverId>:<channel>');
    expect(schema.properties.channelId!.description).toContain('slack:<conversationId>');
    expect(schema.properties.channelId!.description).toContain('is refused');
    expect(schema.properties.channelId!.description).toContain('an id containing *, which the gate would read as a wildcard');
    expect(tool.description).toContain("the MCPL server named by the channel id's prefix");
  });
});
