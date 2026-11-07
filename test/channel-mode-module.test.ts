import { describe, expect, test } from 'bun:test';
import { ChannelRegistry, EventGate, type AgentFramework, type ModuleContext, type ToolCall } from '@animalabs/agent-framework';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelModeModule } from '../src/modules/channel-mode-module.js';
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
  void m.start({ callTool: async (call: ToolCall) => {
    calls.push(call);
    return call.name === 'channel_close' && options.closeError
      ? { success: false, error: options.closeError } : { success: true };
  } } as unknown as ModuleContext);
  const set = (channelId: string, mode = 'debounced') => m.handleToolCall({
    id: 'test', name: 'set_channel_mode', input: { channelId, mode },
  });
  return { m, calls, rules, removed, set };
}

describe('channel-mode server ownership', () => {
  test('real registry ownership produces a rule matched by the real event gate for incoming and push events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'channel-mode-'));
    const channels = new ChannelRegistry({ getServer: () => undefined } as never, {} as never, () => {}, () => {});
    const gate = new EventGate({
      configPath: join(dir, 'gate.json'), emitTrace: () => {}, addMessage: () => {},
      requestInference: () => {}, getAgentNames: () => ['test'],
    });
    const m = new ChannelModeModule();
    try {
      // The descriptor prefix deliberately differs from the owning connection.
      await channels.handleRegister('slack', { channels: [{ id: 'zulip:backend', label: 'Backend' }] } as never);
      m.setFramework({
        channels, listMcplServers: () => [{ id: 'slack', connected: true }, { id: 'zulip', connected: true }],
        addGatePolicy: gate.addPolicy.bind(gate), removeGatePolicy: gate.removePolicy.bind(gate),
      } as unknown as AgentFramework);
      await m.start({ callTool: async () => ({ success: true }) } as unknown as ModuleContext);
      expect((await m.handleToolCall({ id: 'real', name: 'set_channel_mode', input: { channelId: 'zulip:backend', mode: 'debounced' } })).success).toBe(true);
      for (const eventType of ['mcpl:channel-incoming', 'mcpl:push-event']) {
        const event = { content: 'ambient', eventType, serverId: 'slack', channelId: 'zulip:backend', tags: ['chat:ambient'] };
        expect(gate.probe(event).policyName).toBe('channel-mode:debounced:zulip:backend');
        expect(gate.probe({ ...event, serverId: 'zulip' }).policyName).toBeNull();
      }
      expect((await m.handleToolCall({ id: 'revert', name: 'set_channel_mode', input: { channelId: 'zulip:backend', mode: 'mentions' } })).success).toBe(true);
      expect(gate.probe({ content: 'ambient', eventType: 'mcpl:channel-incoming', serverId: 'slack', channelId: 'zulip:backend', tags: ['chat:ambient'] }).policyName).toBeNull();
    } finally {
      await m.stop();
      gate.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  for (const [channelId, serverId] of [
    ['zulip:backend', 'zulip'], ['slack:T123:C456', 'slack'], ['discord:guild:channel', 'discord'],
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
    for (const id of ['zulip:backend', 'slack:T:C', 'discord:g:c']) await w.set(id);
    expect([...w.rules.values()].map(r => r.match.source)).toEqual(['zulip', 'slack', 'discord']);
    await w.set('slack:T:C', 'mentions');
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
        await m.start({ callTool: async (call: ToolCall) => {
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

  test('single-Discord recipe without serverId still accepts a legacy raw id', async () => {
    const w = wired({ servers: [{ id: 'discord', connected: true }] });
    const channelId = '123456789012345678';
    expect((await w.set(channelId)).success).toBe(true);
    expect(w.calls[0]).toMatchObject({ name: 'channel_open', input: { channelId, serverId: 'discord' } });
    expect((await w.set(channelId, 'mentions')).success).toBe(true);
    expect(w.calls[2]).toMatchObject({ name: 'channel_close', input: { channelId, serverId: 'discord' } });
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

  for (const registered of [false, true]) {
    test(`mentions cleans up after disconnect (${registered ? 'registry' : 'prefix'} owner), without using fallback`, async () => {
      const servers = [{ id: 'zulip', connected: true }, { id: 'discord', connected: true }];
      const w = wired({ servers, fallback: 'discord', entries: registered ? [{ serverId: 'zulip', descriptor: { id: 'zulip:backend' } }] : [] });
      await w.set('zulip:backend');
      servers[0].connected = false;
      w.calls.length = 0;
      const result = await w.set('zulip:backend', 'mentions');
      expect(result.success).toBe(false);
      expect(result.error).toContain('skipped');
      expect(result.error).toMatch(/zulip.*disconnected/);
      expect(w.rules.size).toBe(0);
      expect(w.removed).toEqual(['channel-mode:debounced:zulip:backend']);
      expect(w.calls).toMatchObject([{ name: 'subscription-gc--pin_channel_idle_limit', input: { channelId: 'zulip:backend', pinned: false } }]);
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

  test('tool schema explains the raw-id legacy fallback without promising a matching rule', () => {
    const schema = JSON.stringify(new ChannelModeModule().getTools()[0].inputSchema);
    expect(schema).toContain('legacy');
    expect(schema).toContain('no colon');
    expect(schema).toContain('Unknown namespaces are refused');
    expect(schema).not.toContain('silently');
  });
});
