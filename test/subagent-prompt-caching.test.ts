import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { cacheSettingsFor, promptCachingFor, recipeCacheSettings, resolvePromptCaching } from '../src/framework-agent-config.js';
import { SubagentModule, describeSubagentLaunch } from '../src/modules/subagent-module.js';
import type { Recipe } from '../src/recipe.js';

// #339: spawn and fork built their agent config without promptCaching or
// cacheTtl, so a recipe's explicit `promptCaching: false` never reached a
// subagent, and a Bedrock child on a model the caching gate denies sent
// cache_control anyway. The resident and each subagent now read the same
// resolver, gated on the model each of them runs.

const BEDROCK_CACHED = 'anthropic.claude-sonnet-4-5-20250929-v1:0';
const BEDROCK_UNCACHED = 'anthropic.claude-3-5-sonnet-20241022-v2:0';

describe('cacheSettingsFor', () => {
  test('an explicit promptCaching wins on every provider and model', () => {
    expect(promptCachingFor({ promptCaching: false, provider: 'anthropic' }, 'claude-opus-5-5')).toBe(false);
    expect(promptCachingFor({ promptCaching: false, provider: 'bedrock' }, BEDROCK_CACHED)).toBe(false);
    expect(promptCachingFor({ promptCaching: true, provider: 'bedrock' }, BEDROCK_UNCACHED)).toBe(true);
    expect(cacheSettingsFor({ promptCaching: false, provider: 'openai-codex' }, 'gpt-6.1-sol')).toEqual({ promptCaching: false });
  });

  test('without one, Bedrock gates per model and other providers leave membrane its default', () => {
    expect(promptCachingFor({ provider: 'bedrock' }, BEDROCK_CACHED)).toBe(true);
    expect(promptCachingFor({ provider: 'bedrock' }, BEDROCK_UNCACHED)).toBe(false);
    expect(promptCachingFor({ provider: 'anthropic' }, 'claude-3-5-sonnet-20241022')).toBeUndefined();
    expect(promptCachingFor({}, 'claude-opus-5-5')).toBeUndefined();
    expect(cacheSettingsFor({ provider: 'anthropic' }, 'claude-opus-5-5')).toEqual({});
  });

  test('cacheTtl is forwarded except on Bedrock, which offers only its default cache', () => {
    expect(cacheSettingsFor({ cacheTtl: '1h', provider: 'anthropic' }, 'claude-opus-5-5')).toEqual({ cacheTtl: '1h' });
    expect(cacheSettingsFor({ cacheTtl: '1h', provider: 'bedrock' }, BEDROCK_CACHED)).toEqual({ promptCaching: true });
    expect(cacheSettingsFor({ cacheTtl: '1h', promptCaching: false, provider: 'anthropic' }, 'claude-opus-5-5'))
      .toEqual({ cacheTtl: '1h', promptCaching: false });
  });

  test('the resident reads the recipe through the same resolver', () => {
    const recipe = (agent: Record<string, unknown>) => ({ agent } as unknown as Recipe);
    expect(resolvePromptCaching(recipe({ promptCaching: false }), 'claude-opus-5-5')).toBe(false);
    expect(resolvePromptCaching(recipe({ provider: 'bedrock' }), BEDROCK_UNCACHED)).toBe(false);
    expect(resolvePromptCaching(recipe({ provider: 'bedrock' }), BEDROCK_CACHED)).toBe(true);
    expect(resolvePromptCaching(recipe({}), 'claude-opus-5-5')).toBeUndefined();
    expect(recipeCacheSettings(recipe({ promptCaching: false, cacheTtl: '1h', provider: 'anthropic' })))
      .toEqual({ promptCaching: false, cacheTtl: '1h', provider: 'anthropic' });
    expect(recipeCacheSettings(recipe({}))).toEqual({});
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
    const framework = await AgentFramework.create({
      storePath: join(mkdtempSync(join(tmpdir(), 'sub-caching-')), 'store'),
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
    return { framework, configOf };
  }

  test('a caching-off recipe reaches a spawn and a fork, with its cacheTtl', async () => {
    const { framework, configOf } = await harness({ provider: 'anthropic', promptCaching: false, cacheTtl: '1h' });
    try {
      const spawn = configOf('spawn', { systemPrompt: 'Look it up.' });
      expect(spawn.promptCaching).toBe(false);
      expect(spawn.cacheTtl).toBe('1h');
      const fork = configOf('fork', {});
      expect(fork.promptCaching).toBe(false);
      expect(fork.cacheTtl).toBe('1h');
    } finally {
      await framework.stop();
    }
  });

  test('a recipe that says nothing leaves both out, so membrane keeps its default', async () => {
    const { framework, configOf } = await harness({ provider: 'anthropic' });
    try {
      const spawn = configOf('spawn', { systemPrompt: 'Look it up.' });
      expect('promptCaching' in spawn).toBe(false);
      expect('cacheTtl' in spawn).toBe(false);
    } finally {
      await framework.stop();
    }
  });

  test("on Bedrock the gate follows the subagent's own model, and no cacheTtl is forwarded", async () => {
    const { framework, configOf } = await harness({ provider: 'bedrock', cacheTtl: '1h' });
    try {
      const denied = configOf('spawn', { systemPrompt: 'Look it up.', model: BEDROCK_UNCACHED });
      expect(denied.promptCaching).toBe(false);
      expect('cacheTtl' in denied).toBe(false);
      const allowed = configOf('spawn', { systemPrompt: 'Look it up.', model: BEDROCK_CACHED });
      expect(allowed.promptCaching).toBe(true);
      expect('cacheTtl' in allowed).toBe(false);
    } finally {
      await framework.stop();
    }
  });
});
