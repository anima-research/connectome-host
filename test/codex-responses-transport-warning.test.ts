import { afterEach, describe, expect, test, spyOn } from 'bun:test';
import { buildFrameworkAgentConfig, responsesTransportSettingsWarning, warnTransportSettings } from '../src/framework-agent-config.js';
import { validateRecipe } from '../src/recipe.js';
import { takeRecipeWarnings } from '../src/recipe-warnings.js';

const recipe = (provider: string, agent: Record<string, unknown> = {}) => validateRecipe({
  name: 'transport',
  agent: { systemPrompt: 'sys', provider, ...agent },
});

describe('the settings one OpenAI provider reads and the other drops', () => {
  test('a Codex recipe that sets serviceTier or compactThreshold is warned, naming what is dropped', () => {
    expect(responsesTransportSettingsWarning(recipe('openai-codex', { responses: { serviceTier: 'priority' } })))
      .toBe('[agent-settings] agent.responses.serviceTier is sent on provider "openai-responses" only: '
        + 'provider "openai-codex" doesn\'t send it (priority processing on Codex is agent.codex.fastMode, or /fast on at runtime).');
    expect(responsesTransportSettingsWarning(recipe('openai-codex', { responses: { compactThreshold: 200000 } })))
      .toBe('[agent-settings] agent.responses.compactThreshold is sent on provider "openai-responses" only: '
        + 'provider "openai-codex" doesn\'t send it.');
    expect(responsesTransportSettingsWarning(recipe('openai-codex', { responses: { serviceTier: 'priority', compactThreshold: 200000 } })))
      .toBe('[agent-settings] agent.responses.serviceTier and agent.responses.compactThreshold are sent on provider "openai-responses" only: '
        + 'provider "openai-codex" doesn\'t send them (priority processing on Codex is agent.codex.fastMode, or /fast on at runtime).');
  });

  test('the fast-mode pointer is for a priority tier only: flex, auto and default get none', () => {
    for (const serviceTier of ['flex', 'auto', 'default']) {
      expect(responsesTransportSettingsWarning(recipe('openai-codex', { responses: { serviceTier } })))
        .toBe('[agent-settings] agent.responses.serviceTier is sent on provider "openai-responses" only: provider "openai-codex" doesn\'t send it.');
    }
  });

  test('the mirror: agent.codex on a provider other than openai-codex is named, with the Responses tier for fastMode', () => {
    expect(responsesTransportSettingsWarning(recipe('openai-responses', { codex: { fastMode: true } })))
      .toBe('[agent-settings] agent.codex is read on provider "openai-codex" only: provider "openai-responses" doesn\'t read it '
        + '(priority processing on openai-responses is agent.responses.serviceTier: "priority").');
    expect(responsesTransportSettingsWarning(recipe('openai-responses', { codex: { fastMode: false } })))
      .toBe('[agent-settings] agent.codex is read on provider "openai-codex" only: provider "openai-responses" doesn\'t read it.');
    expect(responsesTransportSettingsWarning(recipe('anthropic', { codex: { fastMode: true } })))
      .toBe('[agent-settings] agent.codex is read on provider "openai-codex" only: provider "anthropic" doesn\'t read it.');
  });

  test('nothing is said where the settings are read, or where none is set', () => {
    expect(responsesTransportSettingsWarning(recipe('openai-responses', { responses: { serviceTier: 'priority', compactThreshold: 200000 } }))).toBeUndefined();
    expect(responsesTransportSettingsWarning(recipe('openai-codex', { codex: { fastMode: true }, responses: { reasoningEffort: 'high' } }))).toBeUndefined();
    expect(responsesTransportSettingsWarning(recipe('openai-codex'))).toBeUndefined();
    expect(responsesTransportSettingsWarning(recipe('anthropic'))).toBeUndefined();
  });

  test('the config does what the line says: Codex gets reasoning only, Responses gets the transport fields', () => {
    const codex = buildFrameworkAgentConfig(recipe('openai-codex', { responses: { serviceTier: 'priority', compactThreshold: 200000 } }), 'a', 'gpt-6.1-sol', { kind: 's' } as never);
    expect((codex.providerParams as Record<string, unknown>).service_tier).toBeUndefined();
    expect((codex.providerParams as Record<string, unknown>).context_management).toBeUndefined();
    const responses = buildFrameworkAgentConfig(recipe('openai-responses', { responses: { serviceTier: 'priority', compactThreshold: 200000 } }), 'a', 'gpt-6.1-sol', { kind: 's' } as never);
    expect((responses.providerParams as Record<string, unknown>).service_tier).toBe('priority');
    expect((responses.providerParams as Record<string, unknown>).context_management).toEqual([{ type: 'compaction', compact_threshold: 200000 }]);
  });
});

describe('warnTransportSettings', () => {
  let warn: ReturnType<typeof spyOn> | undefined;
  afterEach(() => { warn?.mockRestore(); warn = undefined; });

  test('says the line on stderr and keeps it for the runtime log, taken once', () => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
    takeRecipeWarnings();
    const said = warnTransportSettings(recipe('openai-codex', { responses: { serviceTier: 'priority' } }));
    expect(said).toContain('agent.responses.serviceTier is sent on provider "openai-responses" only');
    expect(warn).toHaveBeenCalledWith(said);
    const taken = takeRecipeWarnings();
    expect(taken).toEqual([said]);
    expect(takeRecipeWarnings()).toEqual([]);
  });

  test('says nothing, and keeps nothing, for a recipe with nothing to say', () => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
    takeRecipeWarnings();
    expect(warnTransportSettings(recipe('openai-codex'))).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(takeRecipeWarnings()).toEqual([]);
  });
});
