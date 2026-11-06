import { describe, expect, test } from 'bun:test';
import { ChannelRegistry, EventGate, type AgentFramework, type ModuleContext, type ToolCall } from '@animalabs/agent-framework';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelModeModule } from '../src/modules/channel-mode-module.js';

type Rule = { name: string; match: { source: string; channel: string } };

function wired(options: {
  entries?: Array<{ serverId: string; descriptor: { id: string } }>;
  servers?: Array<{ id: string; connected: boolean }>;
  fallback?: string;
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
  void m.start({ callTool: async (call: ToolCall) => { calls.push(call); return { success: true }; } } as unknown as ModuleContext);
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

  test('registry handles ids without a server prefix, and does not match labels or substrings', async () => {
    const w = wired({ entries: [{ serverId: 'zulip', descriptor: { id: 'bare-channel' } }] });
    expect((await w.set('bare-channel')).success).toBe(true);
    expect(w.calls[0].input.serverId).toBe('zulip');
    expect((await w.set('bare')).success).toBe(false);
    expect(w.calls.length).toBe(2);
  });

  test('only an explicit connected fallback resolves a legacy id', async () => {
    const w = wired({ fallback: 'slack' });
    expect((await w.set('legacy-id')).success).toBe(true);
    expect(w.calls[0].input.serverId).toBe('slack');
    expect([...w.rules.values()][0].match.source).toBe('slack');
    await w.set('legacy-id', 'mentions');
    expect(w.calls[2].input.serverId).toBe('slack');
  });

  for (const mode of ['debounced', 'mentions']) {
    test(`${mode}: unresolvable, disconnected, and ambiguous ids refuse before any step`, async () => {
      for (const [options, id] of [
        [{}, 'unknown:channel'], [{}, 'legacy-id'],
        [{ servers: [{ id: 'zulip', connected: false }] }, 'zulip:backend'],
        [{ fallback: 'missing' }, 'legacy-id'],
        [{ entries: [{ serverId: 'missing', descriptor: { id: 'zulip:backend' } }] }, 'zulip:backend'],
        [{ entries: ['zulip', 'slack'].map(serverId => ({ serverId, descriptor: { id: 'zulip:backend' } })), fallback: 'discord' }, 'zulip:backend'],
      ] as const) {
        const w = wired(options as Parameters<typeof wired>[0]);
        const result = await w.set(id, mode);
        expect(result.success).toBe(false);
        expect(result.isError).toBe(true);
        expect(result.error).toContain('Nothing changed');
        expect(result.error).toContain('channel');
        expect(result.error).toMatch(/connect|operator|registered/i);
        expect(w.calls).toEqual([]);
        expect(w.rules.size).toBe(0);
        expect(w.removed).toEqual([]);
      }
    });
  }
});
