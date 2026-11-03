/**
 * `modules.heartbeat` and `modules.wake.judge` take effect on the
 * agent-framework this host depends on: a framework booted with the options
 * the host builds from them offers the heartbeat's own tools and a
 * `wake_add_rule` that takes a `judge`.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import { Membrane, MockAdapter } from '@animalabs/membrane';
import { DEFAULT_RECIPE, validateRecipe } from '../src/recipe.js';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { heartbeatOptionsFor } from '../src/heartbeat-options.js';
import { gateOptionsFor } from '../src/gate-options.js';

const MODEL = 'claude-opus-4-6';

async function boot(dir: string, modules: { heartbeat?: unknown; wake?: unknown }): Promise<AgentFramework> {
  const recipe = validateRecipe({ ...structuredClone(DEFAULT_RECIPE), modules: { ...DEFAULT_RECIPE.modules, ...modules } });
  const storePath = join(dir, 'store');
  const heartbeat = heartbeatOptionsFor(recipe.modules?.heartbeat, join(dir, 'data'));
  return AgentFramework.create({
    storePath,
    membrane: new Membrane(new MockAdapter()),
    agents: [buildFrameworkAgentConfig(recipe, 'agent', MODEL, buildFrameworkStrategy(recipe, MODEL, 'UTC'))],
    modules: [],
    gate: gateOptionsFor(recipe.modules?.wake, storePath, {}),
    ...(heartbeat !== undefined ? { heartbeat } : {}),
  });
}

const names = (fw: AgentFramework) => fw.getAllTools().map((t) => t.name);
const wakeAddRule = (fw: AgentFramework) => fw.getAllTools().find((t) => t.name.endsWith('wake_add_rule'));
const takesJudge = (fw: AgentFramework) =>
  JSON.stringify(wakeAddRule(fw)?.inputSchema ?? {}).includes('"judge"');

describe('modules.heartbeat and modules.wake.judge take effect', () => {
  test('with both on, the heartbeat tools are offered and wake_add_rule takes a judge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-judge-on-'));
    const fw = await boot(dir, { heartbeat: { defaults: { paused: true } }, wake: { judge: { model: 'claude-haiku-5-5' } } });
    try {
      expect(names(fw)).toContain('heartbeat--heartbeat_status');
      expect(names(fw)).toContain('heartbeat--reminder_add');
      expect(wakeAddRule(fw)).toBeDefined();
      expect(takesJudge(fw)).toBe(true);
    } finally {
      await fw.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with the heartbeat off, none of its tools are offered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-judge-off-'));
    const fw = await boot(dir, { heartbeat: false });
    try {
      expect(names(fw).some((n) => n.startsWith('heartbeat--'))).toBe(false);
    } finally {
      await fw.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with the judge turned off, wake_add_rule takes no judge', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-judge-nojudge-'));
    const fw = await boot(dir, { wake: { judge: { enabled: false } } });
    try {
      expect(wakeAddRule(fw)).toBeDefined();
      expect(takesJudge(fw)).toBe(false);
    } finally {
      await fw.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
