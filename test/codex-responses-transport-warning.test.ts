import { describe, expect, test } from 'bun:test';
import { buildFrameworkAgentConfig, responsesTransportSettingsWarning } from '../src/framework-agent-config.js';
import { validateRecipe } from '../src/recipe.js';

const recipe = (provider: string, responses?: Record<string, unknown>) => validateRecipe({
  name: 'transport',
  agent: { systemPrompt: 'sys', provider, ...(responses ? { responses } : {}) },
});

describe('agent.responses transport settings on openai-codex', () => {
  test('a Codex recipe that sets serviceTier or compactThreshold is warned, naming what is dropped', () => {
    expect(responsesTransportSettingsWarning(recipe('openai-codex', { serviceTier: 'priority' })))
      .toBe('[agent-settings] agent.responses.serviceTier is API-key transport setting sent on provider "openai-responses" only: '
        + 'provider "openai-codex" doesn\'t send it (fast processing on Codex is agent.codex.fastMode).');
    expect(responsesTransportSettingsWarning(recipe('openai-codex', { compactThreshold: 200000 })))
      .toBe('[agent-settings] agent.responses.compactThreshold is API-key transport setting sent on provider "openai-responses" only: '
        + 'provider "openai-codex" doesn\'t send it.');
    expect(responsesTransportSettingsWarning(recipe('openai-codex', { serviceTier: 'priority', compactThreshold: 200000 })))
      .toMatch(/^\[agent-settings\] agent\.responses\.serviceTier and agent\.responses\.compactThreshold are API-key transport settings/);
  });

  test('nothing is said where the settings are sent, or where none is set', () => {
    expect(responsesTransportSettingsWarning(recipe('openai-responses', { serviceTier: 'priority', compactThreshold: 200000 }))).toBeUndefined();
    expect(responsesTransportSettingsWarning(recipe('openai-codex', { reasoningEffort: 'high' }))).toBeUndefined();
    expect(responsesTransportSettingsWarning(recipe('openai-codex'))).toBeUndefined();
    expect(responsesTransportSettingsWarning(recipe('anthropic', { serviceTier: 'priority' }))).toBeUndefined();
  });

  test('the warning describes what the config does: Codex gets reasoning only, Responses gets the transport fields', () => {
    const codex = buildFrameworkAgentConfig(recipe('openai-codex', { serviceTier: 'priority', compactThreshold: 200000 }), 'a', 'gpt-6.1-sol', { kind: 's' } as never);
    expect((codex.providerParams as Record<string, unknown>).service_tier).toBeUndefined();
    expect((codex.providerParams as Record<string, unknown>).context_management).toBeUndefined();
    const responses = buildFrameworkAgentConfig(recipe('openai-responses', { serviceTier: 'priority', compactThreshold: 200000 }), 'a', 'gpt-6.1-sol', { kind: 's' } as never);
    expect((responses.providerParams as Record<string, unknown>).service_tier).toBe('priority');
    expect((responses.providerParams as Record<string, unknown>).context_management).toEqual([{ type: 'compaction', compact_threshold: 200000 }]);
  });
});
