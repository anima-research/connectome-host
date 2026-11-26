import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentFramework, REFUSAL_REACTIONS } from '@animalabs/agent-framework';
import { assertRefusalBridgeAvailable, prepareRefusalReactions, installRefusalReactions, refusalReactionLifecycle,
  DISCORD_SOURCE, ZULIP_SOURCE, type MainRefusal, type RefusalReactionConfig } from '../src/refusal-reactions.js';

const localSource = process.env.LOCAL_AF_SOURCE_ROOT;
const discordChannel = 'discord:12345678901234567:23456789012345678';
const a = '34567890123456789';
const b = '34567890123456790';

async function rig(kind: 'discord' | 'zulip', enabled = true) {
  const { MockMembrane, MockYieldingStream, HeldStream, createMockResponse } =
    await import(pathToFileURL(join(localSource!, 'test/helpers/mock-membrane.ts')).href);
  const dir = mkdtempSync(join(tmpdir(), 'host-refusal-local-'));
  const membrane = new MockMembrane();
  let hold: Promise<void> | undefined;
  let started: (() => void) | undefined;
  membrane.streamYielding = (request: unknown) => {
    membrane.calls.push(request);
    const responses = [{ ...createMockResponse([], 'refusal'), raw: { request: {}, response: { stop_details: { category: 'bio' } } } }];
    const gate = hold;
    hold = undefined;
    started?.();
    started = undefined;
    return gate ? new HeldStream(gate, responses) : new MockYieldingStream(responses);
  };
  const isDiscord = kind === 'discord';
  const config: RefusalReactionConfig = { ownership: 'whole-framework', servers: [isDiscord
    ? { serverId: 's', kind: 'discord', sourceRevision: DISCORD_SOURCE }
    : { serverId: 's', kind: 'zulip', sourceRevision: ZULIP_SOURCE, realmTag: 'realm', idMode: 'strict',
      emojis: { bio: 'biohazard', unknown: 'stop_sign' }, availableEmojiNames: ['biohazard', 'stop_sign'] }] };
  const serverConfig = [{ id: 's', command: process.execPath, args: [resolve(import.meta.dir, 'fixtures/main-refusal-server.mjs')],
    env: isDiscord ? {} : { ZULIP_ID_MODE: 'strict', ZULIP_REALM_TAG: 'realm' } }];
  const prepared = prepareRefusalReactions(enabled ? config : undefined, serverConfig);
  const diagnostics: string[] = [];
  const lifecycle = enabled ? refusalReactionLifecycle(config, prepared, { diagnostic: d => diagnostics.push(d) }) : undefined;
  let framework: AgentFramework;
  try {
    framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: membrane.asMembrane(),
      agents: [{ name: 'agent', model: 'mock', systemPrompt: 'offline fixture' }],
      modules: lifecycle ? [lifecycle.module] : [], mcplServers: prepared, syncIntervalMs: 0, maintenanceIntervalMs: 0 });
  } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  const bridge = framework.getMainRefusalBridge();
  const readAdds = async () => {
    const result = await framework.executeToolCall({ id: 'read', name: 'mcpl--s--read_calls', input: {}, callerAgentName: 'agent' });
    expect(result.success).toBe(true);
    return JSON.parse((result.data as Array<{ text: string }>)[0]!.text);
  };
  const incoming = (messageId: string, triggerInference = true) => framework.pushEvent({
    type: 'mcpl:channel-incoming', serverId: 's', channelId: isDiscord ? discordChannel : 'zulip:room', messageId,
    author: { id: 'u', name: 'Fixture' }, content: [{ type: 'text', text: 'offline input' }],
    tags: triggerInference ? ['chat:addressed'] : ['chat:ambient'], timestamp: new Date().toISOString(), triggerInference,
  });
  const waitForDiagnostics = async (count: number) => {
    // Owner effects are detached from runUntilIdle; wait for the fake ADD ack.
    for (let n = 0; diagnostics.length < count && n < 200; n++) await Bun.sleep(5);
    expect(diagnostics).toHaveLength(count);
  };
  const close = async () => {
    try { await framework.stop(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  };
  return { framework, membrane, bridge, lifecycle, config, prepared, diagnostics, incoming, readAdds, waitForDiagnostics, close,
    holdNextStream() {
      let release!: () => void;
      hold = new Promise<void>(resolve => { release = resolve; });
      const waiting = new Promise<void>(resolve => { started = resolve; });
      return { release, waiting };
    },
  };
}

describe.skipIf(!localSource)('local AF companion + offline stdio', () => {
  for (const mode of ['discord-unset', 'discord-opt-in', 'zulip-opt-in'] as const) {
    test(`${mode}: exactly one ADD on the turn's answer, not newer inbound context`, async () => {
      const enabled = mode !== 'discord-unset';
      const isDiscord = mode !== 'zulip-opt-in';
      const r = await rig(isDiscord ? 'discord' : 'zulip', enabled);
      const stream = r.holdNextStream();
      try {
        if (enabled) r.lifecycle!.install(r.framework);
        else expect(r.prepared[0]!.env).toEqual({});
        const newMessage = isDiscord ? b : 'realm:010';
        const admitted = new Promise<void>(resolve => r.framework.onTrace(event => {
          if (event.type === 'admission:decided' && event.messageId === newMessage) resolve();
        }));
        r.incoming(isDiscord ? a : 'realm:009');
        const run = r.framework.runUntilIdle();
        await stream.waiting;
        r.incoming(newMessage, false);
        await admitted;
        stream.release();
        await run;
        if (enabled) {
          await r.waitForDiagnostics(1);
          expect(r.diagnostics[0]).toStartWith('add-acknowledged:');
        }
        const expected = isDiscord ? { channelId: enabled ? discordChannel : '23456789012345678', messageId: a, emoji: REFUSAL_REACTIONS.bio }
          : { message_id: 'realm:009', emoji_name: 'biohazard' };
        expect(await r.readAdds()).toEqual([expected]);
        expect(r.membrane.calls).toHaveLength(1);
      } finally { stream.release(); await r.close(); }
    }, 20_000);
  }

  test('a stale disposer leaves the next acquisition in place; disposing restores the built-in reaction', async () => {
    const r = await rig('discord');
    try {
      expect(r.bridge.version).toBe(1);
      const signals: MainRefusal[] = [];
      const handler = (signal: MainRefusal) => { signals.push(signal); };
      const first = r.bridge.takeOwnership(handler);
      first();
      const second = r.bridge.takeOwnership(handler); // Same handler, different acquisition.
      first();
      r.incoming(a);
      await r.framework.runUntilIdle();
      expect(signals).toHaveLength(1);
      expect(signals[0]!.origin?.messageRef).toBe(a);
      expect(Object.isFrozen(signals[0]!.origin)).toBe(true);
      expect(await r.readAdds()).toEqual([]);
      second();
      r.incoming(b);
      await r.framework.runUntilIdle();
      expect(await r.readAdds()).toEqual([{ channelId: '23456789012345678', messageId: b, emoji: REFUSAL_REACTIONS.bio }]);
      expect(signals).toHaveLength(1);
    } finally { await r.close(); }
  }, 20_000);

  test('a selected-server restart releases the host owner and the next refusal uses the built-in path', async () => {
    const r = await rig('discord');
    try {
      r.lifecycle!.install(r.framework);
      r.incoming(a);
      await r.framework.runUntilIdle();
      await r.waitForDiagnostics(1);
      expect(r.diagnostics[0]).toStartWith('add-acknowledged:');
      expect(await r.readAdds()).toHaveLength(1);
      const epoch = r.bridge.serverEpoch('s');
      const binding = r.bridge.serverBinding('s');
      expect(epoch).toBeDefined();
      await r.framework.restartMcplServer('s');
      expect(r.bridge.serverEpoch('s')).toBeDefined();
      expect(r.bridge.serverEpoch('s')).not.toBe(epoch);
      expect(r.bridge.serverBinding('s')).toBe(binding);
      expect(() => installRefusalReactions(r.framework, r.config, r.prepared)).toThrow('already have a host owner');

      r.incoming(b);
      await r.framework.runUntilIdle();
      await r.waitForDiagnostics(2);
      expect(r.diagnostics[1]).toStartWith('stale-connection');
      // The detecting refusal was already handed off, so it isn't replayed.
      expect(await r.readAdds()).toEqual([]);
      r.incoming(a);
      await r.framework.runUntilIdle();
      expect(await r.readAdds()).toEqual([{ channelId: '23456789012345678', messageId: a, emoji: REFUSAL_REACTIONS.bio }]);
      expect(r.diagnostics).toHaveLength(2);
      expect(r.membrane.calls).toHaveLength(3);
    } finally { await r.close(); }
    // Test the old facet only; a stopped framework is never reused by the host.
    expect(() => r.bridge.takeOwnership(() => {})()).not.toThrow();
  }, 20_000);
});

test('stock compatibility does not rely on a new top-level named export', () => {
  expect(typeof prepareRefusalReactions).toBe('function');
  if (typeof (AgentFramework.prototype as { getMainRefusalBridge?: unknown }).getMainRefusalBridge !== 'function') {
    expect(() => assertRefusalBridgeAvailable(AgentFramework.prototype)).toThrow('unsupported');
  }
});
