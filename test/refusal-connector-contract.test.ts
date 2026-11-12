import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DISCORD_REFUSAL_MARKERS, DISCORD_SOURCE, ZULIP_SOURCE, prepareRefusalReactions, installRefusalReactions, type RefusalReactionConfig } from '../src/refusal-reactions.js';

// Optional source-backed OFFLINE qualification. No connector install, spawn,
// bot/API/MCP calls or public listener. Point at fresh anonymous pinned caches.
const root = process.env.REFUSAL_CONNECTOR_SOURCE_DIR;
describe.skipIf(!root)('reviewed connector sources, not a deployed qualification', () => {
  async function source(which: 'discord' | 'zulip', file: string) {
    const dir = join(root!, `${which}-source`);
    expect(execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(which === 'discord' ? DISCORD_SOURCE : ZULIP_SOURCE);
    return import(pathToFileURL(join(dir, 'src', `${file}.ts`)).href);
  }

  test('Discord injected Unicode baseline suppresses a fake echo; opaque operator override is NOT proven safe', async () => {
    const { DiscordFiltersState } = await source('discord', 'filters');
    const state = new DiscordFiltersState({ baselineEnv: Object.values(DISCORD_REFUSAL_MARKERS).join(','), legacyEnv: undefined, fileConfigured: false });
    state.applyParsed({});
    const echoes: string[] = [];
    for (const emoji of Object.values(DISCORD_REFUSAL_MARKERS)) {
      if (!state.isSuppressed({ emoji: emoji.replace(/\uFE0F/g, '') })) echoes.push(emoji);
    }
    expect(echoes).toEqual([]);
    expect(state.suppressionStatus().source).toBe('baseline-default');
    state.applyParsed({ suppressedReactionEmojis: ['other_marker'] });
    expect(state.isSuppressed({ emoji: DISCORD_REFUSAL_MARKERS.bio })).toBe(false);
    expect(state.suppressionStatus().source).toBe('file');
  });

  for (const mode of ['strict', 'compat', 'legacy'] as const) {
    test(`Zulip real ${mode} advertised schema and ID parser, add-only driver and NAME echo baseline`, async () => {
      const { MessageIds, idToolDefinitions } = await source('zulip', 'message-ids');
      const { toolDefinitions } = await source('zulip', 'tools');
      const { FiltersPlane } = await source('zulip', 'filters');
      const ids = new MessageIds('realm', mode);
      const driverConfig: RefusalReactionConfig = { ownership: 'whole-framework', servers: [{ serverId: 's', kind: 'zulip', sourceRevision: ZULIP_SOURCE, idMode: mode, realmTag: 'realm',
        emojis: { bio: 'biohazard', unknown: 'stop_sign' }, availableEmojiNames: ['biohazard', 'stop_sign'] }] };
      const prepared = prepareRefusalReactions(driverConfig, [{ id: 's', command: 'node', env: { ZULIP_ID_MODE: mode, ZULIP_REALM_TAG: 'realm' } }]);
      // Constructor only: pure suppression logic, no real or fake operator file.
      const plane = new FiltersPlane('/never-read-or-written', prepared[0]!.env);
      const tools = idToolDefinitions(toolDefinitions, ids).map((t: any) => ({ ...t, name: `p--${t.name}` }));
      const calls: unknown[] = [];
      const echoes: string[] = [];
      let handler!: (r: any) => Promise<void>;
      installRefusalReactions({
        getMainRefusalBridge: () => ({ version: 1, takeOwnership: (h: any) => { handler = h; return () => {}; }, isCurrent: () => true, serverBinding: () => 'binding', serverEpoch: () => 'epoch' }),
        listMcplServers: () => [{ id: 's', connected: true, transport: 'stdio', refused: null, toolPrefix: 'p' }],
        getAllTools: () => tools,
        executeToolCall: async (call: any) => {
          const numeric = ids.parse(call.input.message_id); // SAME strict/compat normalizer as tool-runtime
          expect(numeric).toBe(9); calls.push(call.input);
          if (!plane.reactionSuppressed(call.input.emoji_name, '2623', 'unicode_emoji')) echoes.push(call.input.emoji_name);
          return { success: true };
        },
      } as any, driverConfig, prepared, () => {});
      await handler({ agentName: 'agent', agentInstanceId: 'instance', turnId: 1, category: 'bio', rewind: 'unhandled', origin: { serverId: 's', binding: 'binding', channelId: 'zulip:room', messageRef: 'realm:009' } });
      expect(calls).toEqual(mode === 'legacy' ? [] : [{ message_id: 'realm:009', emoji_name: 'biohazard' }]);
      expect(echoes).toEqual([]);
      expect(() => ids.parse('other:009')).toThrow();
      if (mode === 'strict') expect(() => ids.parse(9)).toThrow();
    });
  }

  test('Discord real advertised tool accepts the documented canonical channel without stripping it', async () => {
    const { toolDefinitions } = await source('discord', 'tools');
    const { parseChannelRef } = await source('discord', 'channel-names');
    const canonical = 'discord:12345678901234567:23456789012345678';
    expect(parseChannelRef(canonical)).toEqual({ kind: 'id', id: '23456789012345678' });
    const add = toolDefinitions.find((t: any) => t.name === 'add_reaction');
    expect(add.inputSchema.properties.channelId.type).toBe('string');
    expect(add.inputSchema.properties.messageId.type).toContain('string');
  });
});
