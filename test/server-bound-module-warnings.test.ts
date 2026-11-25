import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { serverBoundModuleWarnings, warnServerBoundModules } from '../src/framework-agent-config.js';
import { validateRecipe } from '../src/recipe.js';
import { takeRecipeWarnings } from '../src/recipe-warnings.js';

const recipe = (modules: Record<string, unknown>) => validateRecipe({ name: 'servers', agent: { systemPrompt: 'sys' }, modules });
const relay = (editServerId?: string) => ({ url: 'ws://localhost:8800/bot', token: 't', ...(editServerId !== undefined ? { editServerId } : {}) });

const gcLine = (id: string, servers: string) =>
  `[agent-settings] modules.subscriptionGc.serverId is "${id}", and this host has no server "${id}" (${servers}), ` +
  'so subscription cleanup closes no channel. Name the server it is to watch, or set modules.subscriptionGc to false.';
const ttsLine = (id: string, servers: string) =>
  `[agent-settings] modules.ttsRelay.editServerId is "${id}", and this host has no server "${id}" (${servers}), ` +
  "so the relay voices none of the agent's published messages. Name the server whose messages it is to voice.";

describe('the start names a module bound to a server the host lacks', () => {
  test('subscriptionGc.serverId and ttsRelay.editServerId naming a missing server are each named, with the host\'s servers', () => {
    expect(serverBoundModuleWarnings(recipe({ subscriptionGc: { serverId: 'zulipp' } }), ['zulip', 'shell']))
      .toEqual([gcLine('zulipp', 'its servers: "zulip", "shell"')]);
    expect(serverBoundModuleWarnings(recipe({ ttsRelay: relay('discrod') }), ['discord']))
      .toEqual([ttsLine('discrod', 'its servers: "discord"')]);
    expect(serverBoundModuleWarnings(recipe({ subscriptionGc: { serverId: 'zulipp' }, ttsRelay: relay('discrod') }), []))
      .toEqual([gcLine('zulipp', 'it has no MCPL servers'), ttsLine('discrod', 'it has no MCPL servers')]);
  });

  test('an empty serverId, which the recipe schema accepts, is named too', () => {
    expect(serverBoundModuleWarnings(recipe({ subscriptionGc: { serverId: '' } }), ['portal']))
      .toEqual([gcLine('', 'its servers: "portal"')]);
  });

  test('nothing is said for an omitted or configured id, for modules that are off, or on a chat-free host', () => {
    for (const modules of [
      {},
      { subscriptionGc: true },
      { subscriptionGc: {} },
      { subscriptionGc: { serverId: 'portal' } },
      { subscriptionGc: false },
      { ttsRelay: false },
      { ttsRelay: relay() },
      { ttsRelay: relay('portal') },
    ]) {
      expect(serverBoundModuleWarnings(recipe(modules), ['portal'])).toEqual([]);
      expect(serverBoundModuleWarnings(recipe(modules), ['portal', 'heartbeat', 'github'])).toEqual([]);
    }
    expect(serverBoundModuleWarnings(recipe({}), ['heartbeat', 'github'])).toEqual([]);
  });
});

describe('warnServerBoundModules', () => {
  let warn: ReturnType<typeof spyOn> | undefined;
  afterEach(() => { warn?.mockRestore(); warn = undefined; });

  test('says each line on stderr and keeps it for the runtime log', () => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
    takeRecipeWarnings();
    const said = warnServerBoundModules(recipe({ subscriptionGc: { serverId: 'zulipp' }, ttsRelay: relay('discrod') }), ['zulip']);
    expect(said).toEqual([gcLine('zulipp', 'its servers: "zulip"'), ttsLine('discrod', 'its servers: "zulip"')]);
    expect(warn.mock.calls).toEqual(said.map((line) => [line]));
    expect(takeRecipeWarnings()).toEqual(said);
  });

  test('says and keeps nothing where nothing is wrong', () => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
    takeRecipeWarnings();
    expect(warnServerBoundModules(recipe({ subscriptionGc: { serverId: 'zulip' } }), ['zulip'])).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(takeRecipeWarnings()).toEqual([]);
  });
});
