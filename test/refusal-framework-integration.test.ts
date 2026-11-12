import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentFramework } from '@animalabs/agent-framework';
import { assertRefusalBridgeAvailable, prepareRefusalReactions, installRefusalReactions, DISCORD_SOURCE, DISCORD_REFUSAL_MARKERS, ZULIP_SOURCE, type RefusalReactionConfig } from '../src/refusal-reactions.js';

// Coherent LOCAL AF-source profile only; NEVER stock 0.33 qualification.
const localSource = process.env.LOCAL_AF_SOURCE_ROOT;
describe.skipIf(!localSource)('local AF companion + offline stdio tool path', () => {
  for (const kind of ['discord-legacy', 'discord-handover', 'zulip-handover'] as const) {
    test(`${kind}: exactly one ADD, frozen origin, no new inference`, async () => {
      assertRefusalBridgeAvailable(AgentFramework.prototype);
      const { MockMembrane, MockYieldingStream, createMockResponse } = await import(pathToFileURL(join(localSource!, 'test/helpers/mock-membrane.ts')).href);
      const dir = mkdtempSync(join(tmpdir(), 'host-refusal-local-'));
      const membrane = new MockMembrane();
      membrane.streamYielding = (request: unknown) => {
        membrane.calls.push(request);
        return new MockYieldingStream([{ ...createMockResponse([], 'refusal'), raw: { request: {}, response: { stop_details: { category: 'bio' } } } }]);
      };
      const isDiscord = kind.startsWith('discord');
      const config: RefusalReactionConfig = { ownership: 'whole-framework', servers: [isDiscord
        ? { serverId: 's', kind: 'discord', sourceRevision: DISCORD_SOURCE }
        : { serverId: 's', kind: 'zulip', sourceRevision: ZULIP_SOURCE, realmTag: 'realm', idMode: 'strict', emojis: { bio: 'biohazard', unknown: 'stop_sign' }, availableEmojiNames: ['biohazard', 'stop_sign'] }] };
      const serverConfig = [{ id: 's', command: process.execPath, args: [resolve(import.meta.dir, 'fixtures/main-refusal-server.mjs')], env: isDiscord
        ? { DISCORD_SUPPRESSED_REACTIONS_BASELINE: [...Object.values(DISCORD_REFUSAL_MARKERS), '👁️'].join(',') }
        : { ZULIP_ID_MODE: 'strict', ZULIP_REALM_TAG: 'realm' } }];
      const prepared = prepareRefusalReactions(config, serverConfig);
      const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane, agents: [{ name: 'agent', model: 'mock', systemPrompt: 'offline fixture' }], modules: [], mcplServers: prepared, syncIntervalMs: 0, maintenanceIntervalMs: 0 });
      try {
        const diagnostics: string[] = [];
        if (kind !== 'discord-legacy') installRefusalReactions(framework, config, prepared, d => diagnostics.push(d));
        framework.pushEvent({ type: 'mcpl:channel-incoming', serverId: 's', channelId: isDiscord ? 'discord:12345678901234567:23456789012345678' : 'zulip:room', messageId: isDiscord ? '34567890123456789' : 'realm:009',
          author: { id: 'u', name: 'Fixture' }, content: [{ type: 'text', text: 'offline input' }], tags: ['chat:addressed'], timestamp: new Date().toISOString(), triggerInference: true });
        await framework.runUntilIdle();
        // Handler effects are deliberately detached from inference; explicitly
        // wait for the fake ADD ack rather than claiming runUntilIdle waits on it.
        if (kind !== 'discord-legacy') {
          for (let n = 0; !diagnostics.length && n < 200; n++) await Bun.sleep(5);
          expect(diagnostics).toEqual(['add-acknowledged: not proof of human receipt or cause']);
        }
        const result = await framework.executeToolCall({ id: 'read', name: 'mcpl--s--read_calls', input: {}, callerAgentName: 'agent' });
        const data = result.data as Array<{ text: string }>;
        const adds = JSON.parse(data[0]!.text);
        expect(adds.length).toBe(1);
        if (kind === 'zulip-handover') expect(adds[0]).toEqual({ message_id: 'realm:009', emoji_name: 'biohazard' });
        else expect(adds[0]).toEqual({ channelId: kind === 'discord-legacy' ? '23456789012345678' : 'discord:12345678901234567:23456789012345678', messageId: '34567890123456789', emoji: '☣️' });
        expect(membrane.calls.length).toBe(1);
      } finally { await framework.stop(); rmSync(dir, { recursive: true, force: true }); }
    }, 20_000);
  }
});

test('stock compatibility does not rely on a new top-level named export', () => {
  // Importing this module, including under stock AF, is itself the load check.
  expect(typeof prepareRefusalReactions).toBe('function');
  if (typeof (AgentFramework.prototype as unknown as { getMainRefusalBridge?: unknown }).getMainRefusalBridge !== 'function') {
    expect(() => assertRefusalBridgeAvailable(AgentFramework.prototype)).toThrow('unsupported');
  }
});

// Regression for the conservative V1 lifetime, NOT a runtime recovery mechanism.
// Public Host createFramework wiring is not exercised by this manual install.
test.skipIf(!localSource)('real selected-server restart retains ownership, rejects reinstall and suppresses all later ADDs', async () => {
  const { MockMembrane, MockYieldingStream, createMockResponse } = await import(pathToFileURL(join(localSource!, 'test/helpers/mock-membrane.ts')).href);
  const dir = mkdtempSync(join(tmpdir(), 'host-refusal-restart-'));
  const membrane = new MockMembrane();
  membrane.streamYielding = (request: unknown) => {
    membrane.calls.push(request);
    return new MockYieldingStream([{ ...createMockResponse([], 'refusal'), raw: { request: {}, response: { stop_details: { category: 'bio' } } } }]);
  };
  const config: RefusalReactionConfig = { ownership: 'whole-framework', servers: [
    { serverId: 's', kind: 'discord', sourceRevision: DISCORD_SOURCE },
  ] };
  const serverConfig = [{ id: 's', command: process.execPath, args: [resolve(import.meta.dir, 'fixtures/main-refusal-server.mjs')],
    env: { DISCORD_SUPPRESSED_REACTIONS_BASELINE: Object.values(DISCORD_REFUSAL_MARKERS).join(',') } }];
  const prepared = prepareRefusalReactions(config, serverConfig);
  const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane,
    agents: [{ name: 'agent', model: 'mock', systemPrompt: 'offline fixture' }], modules: [], mcplServers: prepared, syncIntervalMs: 0, maintenanceIntervalMs: 0 });
  const diagnostics: string[] = [];
  const readAdds = async () => {
    const result = await framework.executeToolCall({ id: 'read', name: 'mcpl--s--read_calls', input: {}, callerAgentName: 'agent' });
    expect(result.success).toBe(true);
    return JSON.parse((result.data as Array<{ text: string }>)[0]!.text);
  };
  const refuse = async (id: string, count: number) => {
    framework.pushEvent({ type: 'mcpl:channel-incoming', serverId: 's', channelId: 'discord:12345678901234567:23456789012345678', messageId: id,
      author: { id: 'u', name: 'Fixture' }, content: [{ type: 'text', text: 'offline input' }], tags: ['chat:addressed'], timestamp: new Date().toISOString(), triggerInference: true });
    await framework.runUntilIdle();
    for (let n = 0; diagnostics.length < count && n < 200; n++) await Bun.sleep(5);
    expect(diagnostics.length).toBe(count);
  };
  try {
    installRefusalReactions(framework, config, prepared, d => diagnostics.push(d));
    await refuse('34567890123456789', 1);
    expect(diagnostics).toEqual(['add-acknowledged: not proof of human receipt or cause']);
    // Initial preflight permits an actual fixture ADD.
    expect((await readAdds()).length).toBe(1);
    const bridge = (framework as unknown as { getMainRefusalBridge(): { serverEpoch(id: string): string | undefined; serverBinding(id: string): string | undefined } }).getMainRefusalBridge();
    const epoch = bridge.serverEpoch('s');
    const binding = bridge.serverBinding('s');
    // Test-only inspection; no private-field dependency in the Host driver.
    const registry = (framework as unknown as { mcplServerRegistry: { getServer(id: string): object | undefined } }).mcplServerRegistry;
    const connection = registry.getServer('s');
    expect(epoch).toBeDefined(); expect(connection).toBeDefined();
    await framework.restartMcplServer('s');
    expect(registry.getServer('s')).not.toBe(connection);
    expect(bridge.serverEpoch('s')).toBeDefined();
    expect(bridge.serverEpoch('s')).not.toBe(epoch);
    expect(bridge.serverBinding('s')).toBe(binding);

    // Normal prepare alone cannot reinstall while the startup owner is held.
    const preparedAgain = prepareRefusalReactions(config, serverConfig);
    expect(() => installRefusalReactions(framework, config, preparedAgain)).toThrow('already have a host owner');
    await refuse('34567890123456790', 2);
    await refuse('34567890123456791', 3);
    expect(diagnostics).toEqual(['add-acknowledged: not proof of human receipt or cause',
      'stale-or-unsupported-server', 'stale-or-unsupported-server']);
    // Restart resets this fixture's call log. Neither Host nor legacy may ADD
    // on the replacement, even though its endpoint, schema and seed still match.
    expect(await readAdds()).toEqual([]);
    // Exactly the three requested main turns; no recovery inference.
    expect(membrane.calls.length).toBe(3);
  } finally { await framework.stop(); rmSync(dir, { recursive: true, force: true }); }
}, 20_000);
