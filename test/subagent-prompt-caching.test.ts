import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { cacheSettingsFor, subagentModuleConfig } from '../src/framework-agent-config.js';
import { SubagentModule, describeSubagentLaunch } from '../src/modules/subagent-module.js';
import { validateRecipe } from '../src/recipe.js';

// #339: spawn and fork built their agent config without promptCaching or
// cacheTtl, so a recipe's explicit `promptCaching: false` never reached a
// subagent, and a Bedrock child on a model the caching gate denies sent
// cache_control anyway. The resident and each subagent now read the same
// resolver, gated on the model each of them runs.

const BEDROCK_CACHED = 'anthropic.claude-sonnet-4-5-20250929-v1:0';
const BEDROCK_UNCACHED = 'anthropic.claude-3-5-sonnet-20241022-v2:0';

describe('cacheSettingsFor', () => {
  test('the module the host builds carries the recipe\'s settings, as a loaded recipe has them', () => {
    const loaded = (agent: Record<string, unknown>) => validateRecipe({ name: 'r', agent: { systemPrompt: 'sys', ...agent }, modules: { subagents: true } });
    const off = subagentModuleConfig(loaded({ promptCaching: false }), 'resident', 'claude-opus-5-5', 'UTC');
    expect(off.promptCaching).toBe(false);
    expect(off.cacheTtl).toBe('1h'); // validateRecipe fills the TTL
    expect(off.provider).toBe('anthropic');
    expect(off.defaultModel).toBe('claude-opus-5-5');
    const says = subagentModuleConfig(loaded({}), 'resident', 'claude-opus-5-5', 'UTC');
    expect('promptCaching' in says).toBe(false);
    expect(says.cacheTtl).toBe('1h');
    const bedrock = subagentModuleConfig(loaded({ provider: 'bedrock', cacheTtl: '5m' }), 'resident', BEDROCK_CACHED, 'UTC');
    expect(bedrock.provider).toBe('bedrock');
    expect(bedrock.cacheTtl).toBe('5m');
    // Through the module, with the model each child sends.
    expect(cacheSettingsFor(off, 'claude-opus-5-5')).toEqual({ promptCaching: false, cacheTtl: '1h' });
    expect(cacheSettingsFor(bedrock, BEDROCK_UNCACHED)).toEqual({ promptCaching: false });
  });
});

describe('subagents', () => {
  async function harness(config: { provider?: string; promptCaching?: boolean; cacheTtl?: string }) {
    const membrane = new Membrane(new MockAdapter({ defaultResponse: 'ok' }), { formatter: new NativeFormatter() });
    const subagent = new SubagentModule({
      ...config,
      parentAgentName: 'parent',
      defaultModel: 'claude-opus-5-5',
      defaultMaxTokens: 256,
      maxRetries: 0,
    });
    const dir = mkdtempSync(join(tmpdir(), 'sub-caching-'));
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane,
      agents: [{ name: 'parent', model: 'claude-opus-5-5', systemPrompt: 'parent', maxTokens: 256 }],
      modules: [subagent as unknown as Module],
    });
    subagent.setFramework(framework);
    type Launch = Parameters<typeof describeSubagentLaunch>[0];
    const inner = subagent as unknown as {
      resolveLaunch(kind: 'spawn' | 'fork', input: Record<string, unknown>, caller: string, depth: number): Launch;
      ephemeralAgentConfig(launch: Launch, name: string): Record<string, unknown>;
    };
    const configOf = (kind: 'spawn' | 'fork', input: Record<string, unknown>) =>
      inner.ephemeralAgentConfig(inner.resolveLaunch(kind, { name: 'child', task: 't', ...input }, 'parent', 0), 'child-1');
    const stop = async () => {
      try { await framework.stop(); } finally { rmSync(dir, { recursive: true, force: true }); }
    };
    return { framework, configOf, stop };
  }

  test('a caching-off recipe reaches a spawn and a fork, with its cacheTtl', async () => {
    const { configOf, stop } = await harness({ provider: 'anthropic', promptCaching: false, cacheTtl: '1h' });
    try {
      const spawn = configOf('spawn', { systemPrompt: 'Look it up.' });
      expect(spawn.promptCaching).toBe(false);
      expect(spawn.cacheTtl).toBe('1h');
      const fork = configOf('fork', {});
      expect(fork.promptCaching).toBe(false);
      expect(fork.cacheTtl).toBe('1h');
    } finally {
      await stop();
    }
  });

  test('a module handed nothing leaves both out, so agent-framework keeps its default', async () => {
    const { configOf, stop } = await harness({ provider: 'anthropic' });
    try {
      const spawn = configOf('spawn', { systemPrompt: 'Look it up.' });
      expect('promptCaching' in spawn).toBe(false);
      expect('cacheTtl' in spawn).toBe(false);
    } finally {
      await stop();
    }
  });

  test("on Bedrock the gate follows the subagent's own model, and no cacheTtl is forwarded", async () => {
    const { configOf, stop } = await harness({ provider: 'bedrock', cacheTtl: '1h' });
    try {
      const denied = configOf('spawn', { systemPrompt: 'Look it up.', model: BEDROCK_UNCACHED });
      expect(denied.promptCaching).toBe(false);
      expect('cacheTtl' in denied).toBe(false);
      const allowed = configOf('spawn', { systemPrompt: 'Look it up.', model: BEDROCK_CACHED });
      expect(allowed.promptCaching).toBe(true);
      expect('cacheTtl' in allowed).toBe(false);
    } finally {
      await stop();
    }
  });
});
