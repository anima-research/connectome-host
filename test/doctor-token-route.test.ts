import { describe, test, expect } from 'bun:test';
import { tokenRoute } from '../src/cli/discord-check.js';

const FILES = { recipe: '/w/recipe.json', servers: '/w/mcpl-servers.json', overlay: '/w/mcpl-servers.agent.json' };

function route(id: string, sources: {
  recipe?: Record<string, unknown>;
  file?: Array<{ id: string } & Record<string, unknown>>;
  overlay?: Record<string, Record<string, unknown>>;
  inheritEnv?: boolean;
}) {
  return tokenRoute(id, {
    ...FILES,
    recipeServers: sources.recipe ?? {},
    fileServers: sources.file ?? [],
    overlayServers: sources.overlay ?? {},
    inheritEnv: sources.inheritEnv ?? false,
  });
}

describe('doctor: where the Discord entry is defined, and how it gets DISCORD_TOKEN', () => {
  test('an entry the recipe defines alone maps the service\'s variable, with the default its reference gives', () => {
    expect(route('discord', { recipe: { discord: { command: 'd', env: { DISCORD_TOKEN: '${DISCORD_TOKEN}' } } } })).toEqual({
      id: 'discord', defined: 'recipe', file: FILES.recipe, recipe: FILES.recipe,
      gets: { by: 'mapped', name: 'DISCORD_TOKEN', fallback: null }, beneath: null,
    });
    expect(route('discord', { recipe: { discord: { command: 'd', env: { DISCORD_TOKEN: '${BOT_TOKEN:-spare}' } } } }).gets)
      .toEqual({ by: 'mapped', name: 'BOT_TOKEN', fallback: 'spare' });
  });

  test('an entry mcpl-servers.json defines, for a server the recipe names, inherits the token, or gives it as written', () => {
    expect(route('discord', {
      recipe: { discord: { inheritEnv: true } },
      file: [{ id: 'discord', command: 'd', env: { DISCORD_GUILD_ID: '100' } }],
      inheritEnv: true,
    })).toEqual({ id: 'discord', defined: 'file', file: FILES.servers, recipe: FILES.recipe, gets: { by: 'inherited' }, beneath: null });
    expect(route('discord', {
      recipe: { discord: { inheritEnv: true, env: { DISCORD_TOKEN: '${DISCORD_TOKEN}' } } },
      file: [{ id: 'discord', command: 'd', env: { DISCORD_TOKEN: '${DISCORD_TOKEN}' } }],
      inheritEnv: true,
    }).gets).toEqual({ by: 'given' });
  });

  test('an entry the agent overlay defines gives the token as written or not at all, and names what defines the server beneath it', () => {
    const recipe = { discord: { inheritEnv: true } };
    const file = [{ id: 'discord', command: 'd' }];
    expect(route('discord', { recipe, file, overlay: { discord: { command: 'd2', env: { DISCORD_TOKEN: 'x' } } }, inheritEnv: false }))
      .toEqual({ id: 'discord', defined: 'overlay', file: FILES.overlay, recipe: FILES.recipe, gets: { by: 'given' }, beneath: 'file' });
    expect(route('discord', { recipe: { discord: { command: 'd' } }, overlay: { discord: { command: 'd2', inheritEnv: true } } }))
      .toEqual({ id: 'discord', defined: 'overlay', file: FILES.overlay, recipe: FILES.recipe, gets: { by: 'none' }, beneath: 'recipe' });
    expect(route('discord', { overlay: { discord: { command: 'd2' } } }))
      .toEqual({ id: 'discord', defined: 'overlay', file: FILES.overlay, recipe: FILES.recipe, gets: { by: 'none' }, beneath: null });
  });

  test('an entry whose env has no DISCORD_TOKEN and that doesn\'t inherit gets none, and a recipe\'s literal is given', () => {
    expect(route('discord', { recipe: { discord: { command: 'd', env: { DISCORD_GUILD_ID: '100' } } } }).gets).toEqual({ by: 'none' });
    expect(route('discord', { recipe: { discord: { command: 'd', env: { DISCORD_TOKEN: 'MTEx.literal' } } } }).gets)
      .toEqual({ by: 'given' });
  });
});
