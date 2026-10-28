/**
 * A server's `presentation` (agent-framework's host toolsets, 0.29.0): how
 * agents are shown it at first — "full", "tab" or "closed-tab" — validated
 * and passed through from the recipe, mcpl-servers.json and the agent overlay.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateRecipe } from '../src/recipe.js';
import {
  applyAgentOverlay,
  loadMcplServers,
  mergeRecipeServers,
  overlayWarnings,
  readOverlayEntry,
  RECIPE_OVERRIDABLE_SERVER_FIELDS,
} from '../src/mcpl-config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function serversFile(servers: Record<string, unknown>, name = 'mcpl-servers.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'presentation-'));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ mcplServers: servers }));
  return path;
}

function recipe(server: Record<string, unknown>) {
  return { name: 'presentation-test', agent: { systemPrompt: 'sys' }, mcpServers: { games: { command: 'node', ...server } } };
}

const VALUES = ['full', 'tab', 'closed-tab'] as const;
const ODD: unknown[] = ['Tab', 'hidden', '', 1, true, null, {}, ['tab']];

describe('recipe: mcpServers.*.presentation', () => {
  test('takes full, tab or closed-tab, and leaves it out when unset', () => {
    for (const presentation of VALUES) {
      expect(validateRecipe(recipe({ presentation })).mcpServers!.games.presentation).toBe(presentation);
    }
    expect('presentation' in validateRecipe(recipe({})).mcpServers!.games).toBe(false);
  });

  test('refuses anything else, naming the server and the values', () => {
    for (const presentation of ODD) {
      expect(() => validateRecipe(recipe({ presentation })))
        .toThrow('mcpServers.games.presentation must be "full", "tab" or "closed-tab"');
    }
  });
});

describe('mcpl-servers.json: presentation', () => {
  test('is carried for the server that sets it, and absent for one that does not', () => {
    const loaded = loadMcplServers(serversFile({ games: { command: 'node', presentation: 'tab' }, other: { command: 'node' } }));
    expect(loaded.find((s) => s.id === 'games')!.presentation).toBe('tab');
    expect('presentation' in loaded.find((s) => s.id === 'other')!).toBe(false);
  });

  test('refuses another value, naming the file and the server', () => {
    expect(() => loadMcplServers(serversFile({ games: { command: 'node', presentation: 'hidden' } })))
      .toThrow('mcpl-servers.json: mcplServers.games.presentation must be "full", "tab" or "closed-tab"');
  });

  test('a recipe naming a file server may override it; omitting it keeps the file\'s', () => {
    expect(RECIPE_OVERRIDABLE_SERVER_FIELDS).toContain('presentation');
    const loaded = loadMcplServers(serversFile({ over: { command: 'node', presentation: 'tab' }, kept: { command: 'node', presentation: 'closed-tab' } }));
    const merged = mergeRecipeServers({ over: { presentation: 'full' }, kept: {} }, loaded as never);
    expect(merged.find((s) => s.id === 'over')!.presentation).toBe('full');
    expect(merged.find((s) => s.id === 'kept')!.presentation).toBe('closed-tab');
  });
});

describe('the agent overlay: presentation', () => {
  test('passes a valid value through, including over a recipe server it replaces', () => {
    const merged = mergeRecipeServers({ games: { url: 'ws://127.0.0.1:1/mcpl', presentation: 'full' } }, []);
    const overlay = serversFile(
      { games: { url: 'ws://127.0.0.1:1/mcpl', presentation: 'tab' }, mine: { command: 'node', presentation: 'closed-tab' } },
      'mcpl-servers.agent.json',
    );
    const byId = Object.fromEntries(applyAgentOverlay(merged, overlay).map((s) => [s.id, s]));
    expect(byId.games.presentation).toBe('tab');
    expect(byId.mine.presentation).toBe('closed-tab');
    expect(overlayWarnings(merged, overlay).filter((line) => line.includes('presentation'))).toEqual([]);
  });

  test('another value is left out of what the boot loads, and named in the startup lines', () => {
    const overlay = serversFile(
      Object.fromEntries(ODD.map((presentation, i) => [`s${i}`, { command: 'node', presentation }])),
      'mcpl-servers.agent.json',
    );
    const loaded = applyAgentOverlay([], overlay);
    expect(loaded).toHaveLength(ODD.length);
    for (const server of loaded) expect('presentation' in server).toBe(false);
    const lines = overlayWarnings([], overlay).filter((line) => line.includes('presentation'));
    expect(lines).toHaveLength(ODD.length);
    for (const line of lines) expect(line).toContain('its presentation isn\'t "full", "tab" or "closed-tab", so it\'s left out');
  });

  test('refuses a new write (mcpl_deploy\'s strict reading) with another value', () => {
    expect(readOverlayEntry({ command: 'node', presentation: 'hidden' }, { strict: true }).problem)
      .toBe('its presentation isn\'t "full", "tab" or "closed-tab"');
    expect(readOverlayEntry({ command: 'node', presentation: 'tab' }, { strict: true }).entry?.presentation).toBe('tab');
  });
});
