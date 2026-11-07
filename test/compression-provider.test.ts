import { describe, expect, test } from 'bun:test';
import { Membrane } from '@animalabs/membrane';
import { validateRecipe } from '../src/recipe.js';
import { buildCompressionMembrane, describeCompressionProvider } from '../src/compression-provider.js';

const recipe = (strategy: Record<string, unknown>, agent: Record<string, unknown> = {}) => ({
  name: 'compression-provider',
  agent: { systemPrompt: 'sys', model: 'claude-opus-5', ...agent, strategy: { type: 'autobiographical', ...strategy } },
});

const adapterName = (m: Membrane) => (m as unknown as { adapter: { name: string } }).adapter.name;

describe('agent.strategy.compressionProvider', () => {
  test('accepts a provider, an apiKeyEnv and a baseUrl', () => {
    const r = validateRecipe(recipe({ compressionProvider: { provider: 'anthropic', apiKeyEnv: 'ANTHROPIC_COMPRESSION_API_KEY' } }));
    expect(r.agent.strategy?.compressionProvider).toEqual({ provider: 'anthropic', apiKeyEnv: 'ANTHROPIC_COMPRESSION_API_KEY' });
    expect(() => validateRecipe(recipe({
      compressionModel: 'anthropic/claude-opus-5',
      compressionProvider: { provider: 'openrouter' },
    }))).not.toThrow();
    expect(() => validateRecipe(recipe({
      compressionModel: 'gpt-5.1',
      compressionProvider: { provider: 'openai-compatible', baseUrl: 'https://gateway.example/v1' },
    }))).not.toThrow();
  });

  test('refuses a credential in the recipe, an unknown provider, and a malformed apiKeyEnv or baseUrl', () => {
    expect(() => validateRecipe(recipe({ compressionProvider: { provider: 'anthropic', apiKey: 'sk-ant-secret' } })))
      .toThrow(/apiKey is not a known field.*apiKeyEnv/);
    expect(() => validateRecipe(recipe({ compressionProvider: { provider: 'bedrock' } }))).toThrow(/provider must be one of/);
    expect(() => validateRecipe(recipe({ compressionProvider: 'anthropic' }))).toThrow(/must be an object/);
    expect(() => validateRecipe(recipe({ compressionProvider: { provider: 'anthropic', apiKeyEnv: '${KEY}' } })))
      .toThrow(/apiKeyEnv must be an environment variable name/);
    expect(() => validateRecipe(recipe({ compressionProvider: { provider: 'anthropic', baseUrl: 'gateway' } })))
      .toThrow(/baseUrl must be an http\(s\) URL/);
  });

  test('openai-compatible needs a baseUrl', () => {
    expect(() => validateRecipe(recipe({ compressionModel: 'm', compressionProvider: { provider: 'openai-compatible' } })))
      .toThrow(/baseUrl is required/);
  });

  test('on another provider than the agent\'s, compressionModel must be named for it', () => {
    expect(() => validateRecipe(recipe({ compressionProvider: { provider: 'openrouter' } })))
      .toThrow(/set agent.strategy.compressionModel/);
    // The agent's own provider (anthropic by default) takes agent.model as before.
    expect(() => validateRecipe(recipe({ compressionProvider: { provider: 'anthropic' } }))).not.toThrow();
  });

  test('builds a membrane on the named provider with the key from the named variable', () => {
    const r = validateRecipe(recipe({ compressionProvider: { provider: 'anthropic', apiKeyEnv: 'COMPRESSION_KEY' } }));
    const build = (env: NodeJS.ProcessEnv, spec = r.agent.strategy!.compressionProvider!) => buildCompressionMembrane({
      recipe: r, spec, model: 'claude-opus-5', assistantParticipant: 'agent', llmLogPath: '/dev/null', env,
    });
    expect(() => build({ ANTHROPIC_API_KEY: 'sk-ant-other' })).toThrow(/COMPRESSION_KEY is not set/);
    const m = build({ COMPRESSION_KEY: 'sk-ant-compression' });
    expect(m).toBeInstanceOf(Membrane);
    expect(adapterName(m)).toBe('anthropic');
    expect(adapterName(build({ OPENROUTER_API_KEY: 'k' }, { provider: 'openrouter' }))).toBe('openrouter');
    expect(adapterName(build({ OPENAI_API_KEY: 'k' }, { provider: 'openai-responses' }))).toBe('openai-responses-api');
    // openai-compatible may run keyless (a local endpoint).
    expect(adapterName(build({}, { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:8000/v1' }))).toBe('openai-compatible');
  });

  test('the startup line names the variable, never the key', () => {
    const line = describeCompressionProvider({ provider: 'anthropic', baseUrl: 'https://gw.example' });
    expect(line).toBe('anthropic at https://gw.example, credential from ANTHROPIC_API_KEY');
  });
});
