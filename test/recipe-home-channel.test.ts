/**
 * recipe.agent.homeChannel: where heartbeat / no-trigger speech goes. Validated
 * at load time, recognised as a known key (no "keys the host does not read"
 * warning), and forwarded to AgentFramework.create as `homeChannel`.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateRecipe, unknownRecipeKeys } from '../src/recipe.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(TEST_DIR, '..', 'src', 'index.ts');
const CAPTURE_PRELOAD = join(TEST_DIR, 'fixtures', 'capture-framework-create.ts');

function recipeWithHomeChannel(homeChannel?: unknown) {
  return {
    name: 'home-channel-test',
    agent: {
      systemPrompt: 'sys',
      ...(homeChannel !== undefined && { homeChannel }),
    },
  };
}

describe('recipe agent.homeChannel', () => {
  test('accepts a channel id and keeps it', () => {
    const recipe = validateRecipe(recipeWithHomeChannel('discord:123:456'));
    expect(recipe.agent.homeChannel).toBe('discord:123:456');
  });

  test('is optional', () => {
    expect(validateRecipe(recipeWithHomeChannel()).agent.homeChannel).toBeUndefined();
  });

  test('rejects empty, padded and non-string values at load time', () => {
    // Matched by the refusal's own words, so a TypeError past a missing guard can't stand in for it.
    for (const bad of ['', '  ', 42, ' discord:123:456', 'discord:123:456 ']) {
      expect(() => validateRecipe(recipeWithHomeChannel(bad))).toThrow(/agent\.homeChannel must be a non-empty channel id with no spaces around it/);
    }
  });

  test('is a known agent key', () => {
    expect(unknownRecipeKeys(recipeWithHomeChannel('discord:123:456'))).toEqual([]);
  });

  // Runs the real createFramework() with AgentFramework.create stubbed by a
  // preload, so a dropped or misspelled spread in src/index.ts fails here.
  function frameworkCreateOptions(homeChannel?: string): { keys: string[]; scalars: Record<string, unknown> } {
    const dir = mkdtempSync(join(tmpdir(), 'fkm-home-channel-'));
    try {
      const recipePath = join(dir, 'recipe.json');
      const capturePath = join(dir, 'create-options.json');
      writeFileSync(recipePath, JSON.stringify({
        name: 'home-channel-forwarding',
        agent: { name: 'home', systemPrompt: 'never asked to infer in this test', ...(homeChannel && { homeChannel }) },
        modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
      }), 'utf-8');
      const run = spawnSync('bun', ['--preload', CAPTURE_PRELOAD, INDEX_PATH, recipePath, '--headless'], {
        // cwd=dir so DEFAULT_CONFIG_PATH doesn't pick up a real mcpl-servers.json.
        cwd: dir,
        env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test-home-channel', DATA_DIR: dir, CAPTURE_FRAMEWORK_CREATE: capturePath },
        encoding: 'utf-8',
        timeout: 30_000,
      });
      let captured: string;
      try {
        captured = readFileSync(capturePath, 'utf-8');
      } catch {
        throw new Error(`AgentFramework.create was never reached (exit ${run.status}):\n${run.stderr}`);
      }
      return JSON.parse(captured);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('is forwarded to AgentFramework.create', () => {
    expect(frameworkCreateOptions('discord:123:456').scalars.homeChannel).toBe('discord:123:456');
  }, 40_000);

  test('is omitted from AgentFramework.create when unset', () => {
    expect(frameworkCreateOptions().keys).not.toContain('homeChannel');
  }, 40_000);
});
