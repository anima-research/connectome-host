import { describe, expect, test } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';
import {
  buildFrameworkAgentConfig,
  bedrockModelSupportsPromptCaching,
  membraneCachingOverride,
} from '../src/framework-agent-config.js';

function recipe(agent: Record<string, unknown> = {}) {
  return { name: 'bedrock-caching-test', agent: { systemPrompt: 'sys', ...agent } };
}

describe('bedrockModelSupportsPromptCaching', () => {
  test('ids without GA caching support are gated off', () => {
    for (const id of [
      'anthropic.claude-3-opus-20240229-v1:0',
      'anthropic.claude-3-sonnet-20240229-v1:0',
      'anthropic.claude-3-haiku-20240307-v1:0',
      'us.anthropic.claude-3-5-sonnet-20240620-v1:0',
      'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
      'claude-3-5-sonnet-20241022',
      'claude-3-opus-20240229',
      'anthropic.claude-v2:1',
      'anthropic.claude-instant-v1',
    ]) {
      expect(bedrockModelSupportsPromptCaching(id)).toBe(false);
    }
  });

  test('the deny-list matches families, not single dated spellings', () => {
    for (const id of [
      'claude-3-opus',
      'claude-3-opus-latest',
      'claude-3-sonnet',
      'claude-3-haiku-latest',
      'claude-3-5-sonnet',
      'claude-3-5-sonnet-latest',
      'us.anthropic.claude-3-opus-latest-v1:0',
      'apac.anthropic.claude-3-5-sonnet-v2:0',
      'CLAUDE-3-OPUS',
    ]) {
      expect(bedrockModelSupportsPromptCaching(id)).toBe(false);
    }
  });

  test('models with GA Bedrock caching support stay on', () => {
    for (const id of [
      'anthropic.claude-3-5-haiku-20241022-v1:0',
      'claude-3-5-haiku-latest',
      'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
      'claude-3-7-sonnet',
      'us.anthropic.claude-sonnet-4-20250514-v1:0',
      'claude-sonnet-4-20250514',
      'claude-opus-4-6',
      'bedrock:us.anthropic.claude-opus-4-20250514-v1:0',
    ]) {
      expect(bedrockModelSupportsPromptCaching(id)).toBe(true);
    }
  });

  test('non-Claude Bedrock ids are conservatively off, not accidentally on', () => {
    for (const id of ['amazon.nova-pro-v1:0', 'meta.llama3-70b-instruct-v1:0', 'mistral.mistral-large-2402-v1:0']) {
      expect(bedrockModelSupportsPromptCaching(id)).toBe(false);
    }
  });
});

describe('bedrock agent config', () => {
  test('GA-supported bedrock model gets caching on, without cacheTtl', () => {
    const parsed = validateRecipe(recipe({ provider: 'bedrock' }));
    const config = buildFrameworkAgentConfig(
      parsed, 'agent', 'us.anthropic.claude-3-7-sonnet-20250219-v1:0', undefined,
    );
    expect(config.promptCaching).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(config, 'cacheTtl')).toBe(false);
  });

  test('legacy bedrock model keeps caching suppressed', () => {
    const parsed = validateRecipe(recipe({ provider: 'bedrock' }));
    const config = buildFrameworkAgentConfig(
      parsed, 'agent', 'us.anthropic.claude-3-5-sonnet-20240620-v1:0', undefined,
    );
    expect(config.promptCaching).toBe(false);
  });

  test('recipe promptCaching overrides the model gate in both directions', () => {
    const forcedOff = buildFrameworkAgentConfig(
      validateRecipe(recipe({ provider: 'bedrock', promptCaching: false })),
      'agent', 'us.anthropic.claude-3-7-sonnet-20250219-v1:0', undefined,
    );
    expect(forcedOff.promptCaching).toBe(false);

    const forcedOn = buildFrameworkAgentConfig(
      validateRecipe(recipe({ provider: 'bedrock', promptCaching: true })),
      'agent', 'us.anthropic.claude-3-5-sonnet-20241022-v2:0', undefined,
    );
    expect(forcedOn.promptCaching).toBe(true);
  });

  test('explicit override lands at BOTH layers on any provider (composition)', () => {
    const anthOff = validateRecipe(recipe({ promptCaching: false }));
    expect(buildFrameworkAgentConfig(anthOff, 'agent', 'claude-opus-4-6', undefined).promptCaching).toBe(false);
    expect(membraneCachingOverride(anthOff, 'claude-opus-4-6')).toEqual({ defaultPromptCaching: false });

    const bedOn = validateRecipe(recipe({ provider: 'bedrock', promptCaching: true }));
    expect(buildFrameworkAgentConfig(bedOn, 'agent', 'us.anthropic.claude-3-5-sonnet-20241022-v2:0', undefined).promptCaching).toBe(true);
    expect(membraneCachingOverride(bedOn, 'us.anthropic.claude-3-5-sonnet-20241022-v2:0')).toEqual({ defaultPromptCaching: true });

    const bedOff = validateRecipe(recipe({ provider: 'bedrock', promptCaching: false }));
    expect(buildFrameworkAgentConfig(bedOff, 'agent', 'us.anthropic.claude-opus-4-1-20250805-v1:0', undefined).promptCaching).toBe(false);
    expect(membraneCachingOverride(bedOff, 'us.anthropic.claude-opus-4-1-20250805-v1:0')).toEqual({ defaultPromptCaching: false });

    const bedGate = validateRecipe(recipe({ provider: 'bedrock' }));
    expect(membraneCachingOverride(bedGate, 'us.anthropic.claude-3-7-sonnet-20250219-v1:0')).toEqual({ defaultPromptCaching: true });
    expect(membraneCachingOverride(bedGate, 'anthropic.claude-3-opus-20240229-v1:0')).toEqual({ defaultPromptCaching: false });

    const anthDefault = validateRecipe(recipe());
    expect(Object.prototype.hasOwnProperty.call(
      buildFrameworkAgentConfig(anthDefault, 'agent', 'claude-opus-4-6', undefined), 'promptCaching',
    )).toBe(false);
    expect(membraneCachingOverride(anthDefault, 'claude-opus-4-6')).toEqual({});
  });

  test('non-bedrock providers keep prior behavior: caching omitted, cacheTtl forwarded', () => {
    const parsed = validateRecipe(recipe());
    const config = buildFrameworkAgentConfig(parsed, 'agent', 'claude-opus-4-6', undefined);
    expect(Object.prototype.hasOwnProperty.call(config, 'promptCaching')).toBe(false);
    expect(config.cacheTtl).toBe('1h');
  });

  test('recipe promptCaching applies on non-bedrock providers too', () => {
    const parsed = validateRecipe(recipe({ promptCaching: false }));
    const config = buildFrameworkAgentConfig(parsed, 'agent', 'claude-opus-4-6', undefined);
    expect(config.promptCaching).toBe(false);
  });

  test('non-boolean promptCaching is rejected at validation', () => {
    expect(() => validateRecipe(recipe({ promptCaching: 'yes' }))).toThrow(/promptCaching/);
    expect(() => validateRecipe(recipe({ promptCaching: 1 }))).toThrow(/promptCaching/);
  });
});
