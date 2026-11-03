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
  const dir = mkdtempSync(join(tmpdir(), 'tool-hints-'));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ mcplServers: servers }));
  return path;
}

function recipe(server: Record<string, unknown>) {
  return { name: 'tool-hints-test', agent: { systemPrompt: 'sys' }, mcpServers: { surfaces: { command: 'node', ...server } } };
}

describe('recipe: mcpServers.*.toolHints', () => {
  test('takes true or false, and leaves it out when unset', () => {
    expect(validateRecipe(recipe({ toolHints: true })).mcpServers!.surfaces.toolHints).toBe(true);
    expect(validateRecipe(recipe({ toolHints: false })).mcpServers!.surfaces.toolHints).toBe(false);
    expect('toolHints' in validateRecipe(recipe({})).mcpServers!.surfaces).toBe(false);
  });

  test('refuses anything else, naming the server', () => {
    for (const toolHints of ['true', 1, null, {}, []]) {
      expect(() => validateRecipe(recipe({ toolHints }))).toThrow('mcpServers.surfaces.toolHints must be true or false');
    }
  });
});

describe('mcpl-servers.json: toolHints', () => {
  test('is carried for the server that sets it, and absent for one that does not', () => {
    const loaded = loadMcplServers(serversFile({ surfaces: { command: 'node', toolHints: true }, other: { command: 'node' } }));
    expect(loaded.find((s) => s.id === 'surfaces')!.toolHints).toBe(true);
    expect('toolHints' in loaded.find((s) => s.id === 'other')!).toBe(false);
  });

  test('refuses a value that is not true or false, naming the file and the server', () => {
    expect(() => loadMcplServers(serversFile({ surfaces: { command: 'node', toolHints: 'yes' } })))
      .toThrow('mcpl-servers.json: mcplServers.surfaces.toolHints must be true or false');
  });
});

describe('what the host hands agent-framework', () => {
  test('a recipe naming a file server may override toolHints; omitting it keeps the file\'s', () => {
    expect(RECIPE_OVERRIDABLE_SERVER_FIELDS).toContain('toolHints');
    const loaded = loadMcplServers(serversFile({ on: { command: 'node', toolHints: true }, kept: { command: 'node', toolHints: true } }));
    const merged = mergeRecipeServers({ on: { toolHints: false }, kept: {} }, loaded as never);
    expect(merged.find((s) => s.id === 'on')!.toolHints).toBe(false);
    expect(merged.find((s) => s.id === 'kept')!.toolHints).toBe(true);
  });

  test('a server the recipe defines itself keeps it as written, beside an agent overlay that loads', () => {
    const merged = mergeRecipeServers({ surfaces: { url: 'ws://127.0.0.1:1/mcpl', toolHints: true } }, []);
    const overlay = serversFile({ mine: { command: 'node' } }, 'mcpl-servers.agent.json');
    const final = applyAgentOverlay(merged, overlay);
    expect(final.find((s) => s.id === 'surfaces')).toEqual({ id: 'surfaces', url: 'ws://127.0.0.1:1/mcpl', toolHints: true });
    expect(final.map((s) => s.id).sort()).toEqual(['mine', 'surfaces']);
  });
});

describe('the agent overlay: toolHints', () => {
  test('passes true or false through, including over a recipe server it replaces', () => {
    const merged = mergeRecipeServers({ surfaces: { url: 'ws://127.0.0.1:1/mcpl', toolHints: true } }, []);
    const overlay = serversFile(
      { surfaces: { url: 'ws://127.0.0.1:1/mcpl', toolHints: false }, mine: { command: 'node', toolHints: true } },
      'mcpl-servers.agent.json',
    );
    const byId = Object.fromEntries(applyAgentOverlay(merged, overlay).map((s) => [s.id, s]));
    expect(byId.surfaces.toolHints).toBe(false);
    expect(byId.mine.toolHints).toBe(true);
    expect(overlayWarnings(merged, overlay).filter((line) => line.includes('toolHints'))).toEqual([]);
  });

  test('refuses any other value: left out of what the boot loads, and named in the startup lines', () => {
    const odd: Record<string, unknown> = { quoted: 'false', one: 1, empty: null, listed: [true], object: {} };
    const overlay = serversFile(
      Object.fromEntries(Object.entries(odd).map(([id, toolHints]) => [id, { command: 'node', toolHints }])),
      'mcpl-servers.agent.json',
    );
    const loaded = applyAgentOverlay([], overlay);
    expect(loaded.map((s) => s.id).sort()).toEqual(Object.keys(odd).sort());
    for (const server of loaded) expect('toolHints' in server).toBe(false);
    const lines = overlayWarnings([], overlay).filter((line) => line.includes('toolHints'));
    expect(lines).toHaveLength(Object.keys(odd).length);
    for (const id of Object.keys(odd)) {
      expect(lines.some((line) => line.includes(`server "${id}"`) && line.includes('its toolHints isn\'t true or false, so it\'s left out'))).toBe(true);
    }
    expect(lines.join('\n')).not.toContain('"false"');
  });

  test('refuses a new write (mcpl_deploy\'s strict reading) whose toolHints isn\'t true or false', () => {
    expect(readOverlayEntry({ command: 'node', toolHints: 'true' }, { strict: true }).problem)
      .toBe('its toolHints is neither true nor false');
    expect(readOverlayEntry({ command: 'node', toolHints: true }, { strict: true }).entry?.toolHints).toBe(true);
  });
});
