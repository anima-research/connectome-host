import { afterEach, describe, expect, test, spyOn } from 'bun:test';
import { buildFrameworkAgentConfig, responsesTransportSettingsWarning, warnTransportSettings } from '../src/framework-agent-config.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_RECIPE, validateRecipe } from '../src/recipe.js';
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

  test('the mirror: agent.codex.fastMode on a provider other than openai-codex is named, with the Responses tier for fastMode: true', () => {
    expect(responsesTransportSettingsWarning(recipe('openai-responses', { codex: { fastMode: true } })))
      .toBe('[agent-settings] agent.codex.fastMode is read on provider "openai-codex" only: provider "openai-responses" doesn\'t read it '
        + '(priority processing on openai-responses is agent.responses.serviceTier: "priority").');
    expect(responsesTransportSettingsWarning(recipe('openai-responses', { codex: { fastMode: false } })))
      .toBe('[agent-settings] agent.codex.fastMode is read on provider "openai-codex" only: provider "openai-responses" doesn\'t read it.');
    expect(responsesTransportSettingsWarning(recipe('anthropic', { codex: { fastMode: true } })))
      .toBe('[agent-settings] agent.codex.fastMode is read on provider "openai-codex" only: provider "anthropic" doesn\'t read it.');
  });

  test('the block alone says nothing: codex: {} or a block of keys no provider reads drops no setting (R2-1)', () => {
    expect(responsesTransportSettingsWarning(recipe('openai-responses', { codex: {} }))).toBeUndefined();
    expect(responsesTransportSettingsWarning(recipe('anthropic', { codex: {} }))).toBeUndefined();
    expect(responsesTransportSettingsWarning(recipe('openai-responses', { codex: { futureFlag: true } }))).toBeUndefined();
  });

  test('no pointer at a setting the recipe already has: a portable recipe with both fastMode and the priority tier', () => {
    expect(responsesTransportSettingsWarning(recipe('openai-codex', { codex: { fastMode: true }, responses: { serviceTier: 'priority' } })))
      .toBe('[agent-settings] agent.responses.serviceTier is sent on provider "openai-responses" only: provider "openai-codex" doesn\'t send it.');
    expect(responsesTransportSettingsWarning(recipe('openai-responses', { codex: { fastMode: true }, responses: { serviceTier: 'priority' } })))
      .toBe('[agent-settings] agent.codex.fastMode is read on provider "openai-codex" only: provider "openai-responses" doesn\'t read it.');
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

describe('the host says the line once, from main(), on a real boot (R2-2)', () => {
  test('a mock-provider recipe with codex.fastMode boots to create() with exactly one line on stderr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'transport-warning-'));
    try {
      const booted = structuredClone(DEFAULT_RECIPE);
      booted.agent.provider = 'mock';
      (booted.agent as Record<string, unknown>).codex = { fastMode: true };
      booted.modules = {};
      booted.mcpServers = {};
      const path = join(dir, 'recipe.json');
      writeFileSync(path, JSON.stringify(booted));
      const result = Bun.spawnSync([
        process.execPath, '--preload', resolve(import.meta.dir, 'capture-retry-create.preload.ts'),
        resolve(import.meta.dir, '../src/index.ts'), path,
      ], {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir, DATA_DIR: join(dir, 'data'), CONNECTOME_UPDATE_CHECK: '0' },
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain('RETRY_CAPTURE=');
      const lines = result.stderr.toString().split('\n').filter((line) => line.startsWith('[agent-settings] agent.codex.fastMode'));
      expect(lines).toEqual(['[agent-settings] agent.codex.fastMode is read on provider "openai-codex" only: provider "mock" doesn\'t read it.']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
