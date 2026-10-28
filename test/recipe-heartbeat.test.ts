/**
 * `modules.heartbeat` (agent-framework's heartbeat, `FrameworkConfig.heartbeat`):
 * recipe validation, the refusal beside heartbeat-mcpl, and the options the
 * host hands agent-framework.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

import { validateRecipe } from '../src/recipe.js';
import { heartbeatOptionsFor, isHeartbeatMcpl, withoutHeartbeatMcpl } from '../src/heartbeat-options.js';

function recipe(heartbeat: unknown, extra: Record<string, unknown> = {}) {
  return { name: 'heartbeat-test', agent: { systemPrompt: 'sys' }, modules: { heartbeat }, ...extra };
}

describe('recipe: modules.heartbeat', () => {
  test('takes true, false, and every key agent-framework reads, as written', () => {
    expect(validateRecipe(recipe(true)).modules!.heartbeat).toBe(true);
    expect(validateRecipe(recipe(false)).modules!.heartbeat).toBe(false);
    const full = {
      statePath: 'data/heartbeat.json',
      defaults: { intervalSeconds: 7200, paused: false, message: 'check in', deliveryMode: 'silent' },
      importFrom: { configPath: 'heartbeat-config.json', remindersPath: 'heartbeat-reminders.json' },
    };
    expect(validateRecipe(recipe(full)).modules!.heartbeat).toEqual(full);
  });

  test('refuses an unknown key at each level, naming the keys it takes', () => {
    expect(() => validateRecipe(recipe({ interval: 60 }))).toThrow(
      'Recipe modules.heartbeat has unknown key "interval"; it takes statePath, defaults and importFrom.',
    );
    expect(() => validateRecipe(recipe({ defaults: { every: 60 } }))).toThrow(
      'Recipe modules.heartbeat.defaults has unknown key "every"; it takes intervalSeconds, paused, message and deliveryMode.',
    );
    expect(() => validateRecipe(recipe({ importFrom: { config: 'x' } }))).toThrow(
      'Recipe modules.heartbeat.importFrom has unknown key "config"; it takes configPath and remindersPath.',
    );
  });

  test('refuses a value agent-framework would read past, naming the key and what it must be', () => {
    const cases: Array<[unknown, string]> = [
      [{ defaults: { intervalSeconds: 30 } }, 'Recipe modules.heartbeat.defaults.intervalSeconds is 30; it must be a number of seconds, 60 or more.'],
      [{ defaults: { deliveryMode: 'loud' } }, 'Recipe modules.heartbeat.defaults.deliveryMode is "loud"; it must be "message" or "silent".'],
      [{ defaults: { paused: 'no' } }, 'Recipe modules.heartbeat.defaults.paused is "no"; it must be true or false.'],
      [{ importFrom: { configPath: '' } }, 'Recipe modules.heartbeat.importFrom.configPath is ""; it must be a non-empty string.'],
      [{ statePath: 3 }, 'Recipe modules.heartbeat.statePath is 3; it must be a non-empty string.'],
      ['on', 'Recipe modules.heartbeat must be true, false or an object'],
    ];
    for (const [heartbeat, message] of cases) {
      expect(() => validateRecipe(recipe(heartbeat))).toThrow(message);
    }
  });

  test('refuses the framework heartbeat beside heartbeat-mcpl, and keeps the server alone as before', () => {
    const server = { mcpServers: { heartbeat: { command: 'node', args: ['heartbeat-mcpl/dist/src/index.js', '--stdio'] } } };
    expect(() => validateRecipe(recipe(true, server))).toThrow('Recipe turns modules.heartbeat on and names mcpServers.heartbeat');
    expect(validateRecipe(recipe(false, server)).mcpServers!.heartbeat).toBeDefined();
    expect(validateRecipe({ name: 'x', agent: { systemPrompt: 's' }, ...server }).mcpServers!.heartbeat).toBeDefined();
  });
});

describe('heartbeat options for modules.heartbeat', () => {
  test('off or left out is none; on keeps its state in the install\'s data directory, across sessions', () => {
    expect(heartbeatOptionsFor(undefined, 'data')).toBeUndefined();
    expect(heartbeatOptionsFor(false, 'data')).toBeUndefined();
    expect(heartbeatOptionsFor(true, 'data')).toEqual({ statePath: resolve('data/heartbeat.json') });
  });

  test('paths are read from the install directory; the rest goes as written', () => {
    expect(heartbeatOptionsFor({
      statePath: 'state/heartbeat.json',
      defaults: { intervalSeconds: 3600 },
      importFrom: { configPath: 'old/heartbeat-config.json' },
    }, 'data')).toEqual({
      statePath: resolve('state/heartbeat.json'),
      defaults: { intervalSeconds: 3600 },
      importFrom: { configPath: resolve('old/heartbeat-config.json') },
    });
  });

  test('heartbeat-mcpl is known by its id, a heartbeat tool prefix, or the command that runs it', () => {
    expect(isHeartbeatMcpl({ id: 'heartbeat' })).toBe(true);
    expect(isHeartbeatMcpl({ id: 'hb', toolPrefix: 'mcpl--heartbeat' })).toBe(true);
    expect(isHeartbeatMcpl({ id: 'hb', toolPrefix: 'heartbeat' })).toBe(true);
    expect(isHeartbeatMcpl({ id: 'ticks', command: 'node', args: ['/opt/heartbeat-mcpl/dist/src/index.js', '--stdio'] })).toBe(true);
    expect(isHeartbeatMcpl({ id: 'discord', command: 'node', args: ['discord-mcpl/dist/index.js'] })).toBe(false);
  });

  test("a heartbeat-mcpl from the server file or the agent's overlay is left out beside it, named", () => {
    const lines: string[] = [];
    const kept = withoutHeartbeatMcpl([
      { id: 'discord', command: 'node' },
      { id: 'hb', command: 'node', args: ['heartbeat-mcpl/dist/src/index.js', '--stdio'] },
    ], (line) => lines.push(line));
    expect(kept.map((s) => s.id)).toEqual(['discord']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('the MCPL server "hb" (heartbeat-mcpl');
  });
});
