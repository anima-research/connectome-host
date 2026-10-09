/**
 * MCPL tool lifecycle (RFC-007) and tool classes (RFC-008) configuration:
 * recipe validation of `mcpServers.*.toolLifecycle` and `toolClassOverrides`,
 * mcpl-servers.json carrying `toolLifecycle`, the recipe override of it for a
 * file-defined server, and this host's module class table.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateRecipe } from '../src/recipe.js';
import {
  AGENT_DEPLOY_DENIED_CAPABILITIES,
  applyRecipeServerOverrides,
  loadMcplServers,
  mergeRecipeServers,
  RECIPE_OVERRIDABLE_SERVER_FIELDS,
  resolveOverlayEntry,
} from '../src/mcpl-config.js';
import { HOST_TOOL_CLASSES, isToolClass, toolClassConfig } from '../src/tool-lifecycle-config.js';

function recipe(extra: Record<string, unknown> = {}, server: Record<string, unknown> = {}) {
  return {
    name: 'tool-lifecycle-test',
    agent: { systemPrompt: 'sys' },
    mcpServers: { avatar: { command: 'node', args: ['avatar.mjs'], ...server } },
    ...extra,
  };
}

describe('recipe: mcpServers.*.toolLifecycle', () => {
  test('accepts the documented shapes', () => {
    for (const toolLifecycle of [
      { observe: {} },
      { observe: { tools: ['computer--*'], conversations: ['scout*'] } },
      { observe: {}, inputs: { classes: 'default' } },
      { observe: {}, inputs: { classes: ['computer', 'shell'], tools: ['blender--*'] }, maxInputBytes: 4096 },
    ]) {
      expect(() => validateRecipe(recipe({}, { toolLifecycle }))).not.toThrow();
    }
  });

  test('rejects an "off-looking" value instead of reading it as a grant', () => {
    expect(() => validateRecipe(recipe({}, { toolLifecycle: { observe: false } }))).toThrow(/narrowing object/);
    expect(() => validateRecipe(recipe({}, { toolLifecycle: { inputs: null } }))).toThrow(/narrowing object/);
    expect(() => validateRecipe(recipe({}, { toolLifecycle: true }))).toThrow(/must be an object/);
  });

  test('rejects malformed narrowings and unknown fields', () => {
    const bad: unknown[] = [
      { observe: { tools: 'computer--*' } },
      { observe: { tools: [''] } },
      { observe: { conversations: [7] } },
      { inputs: { classes: 'shell' } },
      { inputs: { classes: [] } },
      { inputs: { classes: ['quantum'] } },
      { observe: { tool: ['x'] } },
      { observe: {}, results: {} },
      { maxInputBytes: 0 },
      { maxInputBytes: 1.5 },
    ];
    for (const toolLifecycle of bad) {
      expect(() => validateRecipe(recipe({}, { toolLifecycle }))).toThrow(/mcpServers\.avatar\.toolLifecycle/);
    }
  });
});

describe('recipe: toolClassOverrides', () => {
  test('accepts pattern → known classes', () => {
    expect(() => validateRecipe(recipe({
      toolClassOverrides: { 'blender--*': ['media'], 'cua--*': ['computer'], 'mail--send': ['comms', 'files'] },
    }))).not.toThrow();
  });

  test('rejects unknown classes, empty lists, and non-objects', () => {
    for (const toolClassOverrides of [
      { 'x--*': ['quantum'] },
      { 'x--*': [] },
      { 'x--*': 'files' },
      ['files'],
    ]) {
      expect(() => validateRecipe(recipe({ toolClassOverrides }))).toThrow(/toolClassOverrides/);
    }
  });
});

describe('mcpl-servers.json and recipe overrides', () => {
  test('the file carries toolLifecycle through to the loaded config (and validates it)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-lifecycle-file-'));
    try {
      const path = join(dir, 'mcpl-servers.json');
      writeFileSync(path, JSON.stringify({
        mcplServers: { avatar: { command: 'node', toolLifecycle: { observe: {}, inputs: { classes: 'default' } } } },
      }));
      const [loaded] = loadMcplServers(path);
      expect(loaded.toolLifecycle).toEqual({ observe: {}, inputs: { classes: 'default' } });

      writeFileSync(path, JSON.stringify({ mcplServers: { avatar: { command: 'node', toolLifecycle: { observe: false } } } }));
      expect(() => loadMcplServers(path)).toThrow(/mcpl-servers\.json: mcplServers\.avatar\.toolLifecycle\.observe/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a recipe can set toolLifecycle on a server it takes from the file', () => {
    expect(RECIPE_OVERRIDABLE_SERVER_FIELDS).toContain('toolLifecycle');
    const file = { id: 'avatar', command: 'node', args: ['a.mjs'], env: { SECRET: 'x' } };
    const merged = applyRecipeServerOverrides(file, {
      command: 'evil', // not a policy field: the file's spawn definition stands
      toolLifecycle: { observe: {} },
      toolPrefix: 'avatar',
    });
    expect(merged.command).toBe('node');
    expect(merged.env).toEqual({ SECRET: 'x' });
    expect(merged.toolLifecycle).toEqual({ observe: {} });
    expect(merged.toolPrefix).toBe('avatar');
  });

  test('unset recipe fields leave the file values alone', () => {
    const merged = applyRecipeServerOverrides(
      { id: 'a', command: 'node', toolPrefix: 'file', toolLifecycle: { observe: {} } },
      { toolPrefix: undefined },
    );
    expect(merged.toolPrefix).toBe('file');
    expect(merged.toolLifecycle).toEqual({ observe: {} });
  });
});

describe('HOST_TOOL_CLASSES', () => {
  test('every entry names only RFC-008 classes', () => {
    for (const [pattern, classes] of Object.entries(HOST_TOOL_CLASSES)) {
      expect(classes.length).toBeGreaterThan(0);
      for (const c of classes) expect(isToolClass(c)).toBe(true);
      expect(pattern.length).toBeGreaterThan(0);
    }
  });

  test('specific fleet entries precede the fleet catch-all (first match wins)', () => {
    const keys = Object.keys(HOST_TOOL_CLASSES);
    const catchAll = keys.indexOf('fleet--*');
    for (const k of ['fleet--send', 'fleet--relay', 'fleet--peek']) {
      expect(keys.indexOf(k)).toBeGreaterThanOrEqual(0);
      expect(keys.indexOf(k)).toBeLessThan(catchAll);
    }
  });

  test('toolClassConfig hands the framework both tables', () => {
    const cfg = toolClassConfig({ toolClassOverrides: { 'cua--*': ['computer'] } });
    expect(cfg.hostToolClasses['lessons--*']).toEqual(['memory']);
    expect(cfg.toolClassOverrides).toEqual({ 'cua--*': ['computer'] });
    expect('toolClassOverrides' in toolClassConfig({})).toBe(false);
  });
});

describe('review: an agent cannot grant itself tool-lifecycle observation', () => {
  test('agent-deployed servers have toolLifecycle denied and any block stripped', () => {
    expect(AGENT_DEPLOY_DENIED_CAPABILITIES).toContain('toolLifecycle');
    const resolved = resolveOverlayEntry('spy', {
      command: 'node',
      args: ['spy.mjs'],
      toolLifecycle: { observe: {}, inputs: { classes: 'default' } },
      enabledCapabilities: ['toolLifecycle.*'],
    } as never, '/tmp/mcpl-servers.agent.json')!;
    expect('toolLifecycle' in resolved).toBe(false);
    expect('enabledCapabilities' in resolved).toBe(false);
    // The bare parent masks both leaves in the framework's capability mask.
    expect(resolved.disabledCapabilities).toContain('toolLifecycle');
  });
});

describe('review: a recipe can name a file-defined server by id alone', () => {
  test('validateRecipe accepts an entry with only policy fields', () => {
    expect(() => validateRecipe({
      name: 't', agent: { systemPrompt: 's' },
      mcpServers: { zulip: { toolLifecycle: { observe: {} } } },
    })).not.toThrow();
    expect(() => validateRecipe({
      name: 't', agent: { systemPrompt: 's' }, mcpServers: { zulip: { command: '' } },
    })).toThrow(/mcpServers\.zulip\.command must be a non-empty string/);
  });

  test('mergeRecipeServers: id-only resolves to the file definition plus overrides', () => {
    const file = [{ id: 'zulip', command: 'python', args: ['zulip.py'], env: { KEY: 'k' } }];
    const [merged] = mergeRecipeServers({ zulip: { toolLifecycle: { observe: {} }, toolPrefix: 'z' } }, file);
    expect(merged.command).toBe('python');
    expect(merged.env).toEqual({ KEY: 'k' });
    expect(merged.toolLifecycle).toEqual({ observe: {} });
    expect(merged.toolPrefix).toBe('z');
  });

  test('mergeRecipeServers: the file spawn definition wins over a recipe command', () => {
    const [merged] = mergeRecipeServers({ zulip: { command: 'other' } }, [{ id: 'zulip', command: 'python' }]);
    expect(merged.command).toBe('python');
  });

  test('mergeRecipeServers: recipe-defined servers pass through; unknown id-only entries fail loudly', () => {
    const [own] = mergeRecipeServers({ avatar: { command: 'node', args: ['a.mjs'] } }, []);
    expect(own).toEqual({ id: 'avatar', command: 'node', args: ['a.mjs'] });
    expect(() => mergeRecipeServers({ zulpi: { toolPrefix: 'z' } }, [{ id: 'zulip', command: 'python' }]))
      .toThrow(/mcpServers\.zulpi has no "command" or "url", and mcpl-servers\.json defines no "zulpi"/);
  });
});
