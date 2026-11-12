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
