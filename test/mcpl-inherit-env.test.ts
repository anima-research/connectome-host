import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRecipe } from '../src/recipe.js';
import { applyAgentOverlay, composeMcplChildEnv, loadMcplServers, mergeRecipeServers, resolveOverlayEntry } from '../src/mcpl-config.js';

function recipe(server: Record<string, unknown>) {
  return validateRecipe({
    name: 'inherit-env-test',
    agent: { systemPrompt: 'sys' },
    mcpServers: { tools: server },
  });
}

function loadFile(server: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-inherit-env-'));
  try {
    const path = join(dir, 'mcpl-servers.json');
    writeFileSync(path, JSON.stringify({ mcplServers: { tools: { command: 'node', ...server } } }));
    return loadMcplServers(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('MCPL inheritEnv configuration', () => {
  test('file entries preserve true, false, and omission', () => {
    for (const inheritEnv of [true, false]) {
      expect(loadFile({ inheritEnv })[0].inheritEnv).toBe(inheritEnv);
    }
    expect(loadFile({})[0]).not.toHaveProperty('inheritEnv');
  });

  test('recipe overrides preserve explicit false and leave omitted file policy alone', () => {
    for (const fileValue of [true, false, undefined]) {
      const file = loadFile(fileValue === undefined ? {} : { inheritEnv: fileValue });
      for (const recipeValue of [true, false, undefined]) {
        const validated = recipe(recipeValue === undefined ? {} : { inheritEnv: recipeValue });
        const [merged] = mergeRecipeServers(
          validated.mcpServers as unknown as Record<string, Record<string, unknown>>,
          file as unknown as Array<{ id: string } & Record<string, unknown>>,
        );
        expect(merged.inheritEnv).toBe(recipeValue ?? fileValue);
        expect(merged.command).toBe('node');
        if (recipeValue === undefined && fileValue === undefined) {
          expect(merged).not.toHaveProperty('inheritEnv');
        }
      }
    }
  });

  test('recipe-defined servers retain the flag through validation and merge', () => {
    for (const inheritEnv of [true, false]) {
      const validated = recipe({ command: 'node', inheritEnv });
      expect(validated.mcpServers?.tools.inheritEnv).toBe(inheritEnv);
      const [merged] = mergeRecipeServers(
        validated.mcpServers as unknown as Record<string, Record<string, unknown>>, [],
      );
      expect(merged.inheritEnv).toBe(inheritEnv);
    }
  });

  test('agent-owned overlays cannot grant full host environment inheritance', () => {
    for (const inheritEnv of [true, false, 'false', 'true', 0, 1, null, {}, []]) {
      const entry = { command: 'node', inheritEnv } as any;
      expect(resolveOverlayEntry('tools', entry, '/tmp/overlay.json')).not.toHaveProperty('inheritEnv');
      expect(entry).toHaveProperty('inheritEnv', inheritEnv);
    }
    expect(resolveOverlayEntry('tools', { command: 'node' }, '/tmp/overlay.json'))
      .not.toHaveProperty('inheritEnv');
  });

  test('overlay replacement strips the grant through the final server composition', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpl-inherit-overlay-'));
    const path = join(dir, 'mcpl-servers.agent.json');
    try {
      for (const operatorPolicy of [true, false]) {
        const merged = mergeRecipeServers(
          { tools: {} },
          [{ id: 'tools', command: 'operator-command', inheritEnv: operatorPolicy }],
        );
        writeFileSync(path, JSON.stringify({ mcplServers: {} }));
        expect(applyAgentOverlay(merged, path)[0].inheritEnv).toBe(operatorPolicy);
        writeFileSync(path, JSON.stringify({
          mcplServers: { tools: { command: 'agent-command', inheritEnv: true, env: { DECLARED: 'value' } } },
        }));
        const final = applyAgentOverlay(merged, path).map(server => ({
          ...server,
          env: composeMcplChildEnv(server.env as Record<string, string> | undefined, 'UTC'),
        }));
        expect(final[0]).toHaveProperty('command', 'agent-command');
        expect(final[0]).not.toHaveProperty('inheritEnv');
        expect(final[0].env.DECLARED).toBe('value');
        expect(final[0].env.AGENT_TIMEZONE).toBe('UTC');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [source, load] of [
    ['recipe', (inheritEnv: unknown) => recipe({ command: 'node', inheritEnv })],
    ['file', (inheritEnv: unknown) => loadFile({ inheritEnv })],
  ] as const) {
    test(`${source} rejects malformed inheritEnv instead of treating it as truthy`, () => {
      for (const value of ['false', 'true', 0, 1, null, {}, []]) {
        expect(() => load(value)).toThrow(/tools\.inheritEnv must be a boolean/);
      }
    });
  }

  test('recipe references without their own command validate the flag too', () => {
    expect(() => recipe({ inheritEnv: 'false' })).toThrow(/tools\.inheritEnv must be a boolean/);
  });
});
