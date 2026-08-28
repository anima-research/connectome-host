import { describe, expect, spyOn, test } from 'bun:test';
import type { AgentFramework } from '@animalabs/agent-framework';
import type { Membrane } from '@animalabs/membrane';
import {
  assertResidentRetirementSupport,
  assertResidentRetirementToolSurface,
  buildFrameworkAgentConfig,
  buildRetirementReadinessCheck,
} from '../src/framework-agent-config.js';
import { createFramework } from '../src/index.js';
import { SettingsModule } from '../src/modules/settings-module.js';
import { validateRecipe } from '../src/recipe.js';

const recipe = (retirement?: unknown) => ({
  name: 'retirement-test',
  agent: {
    systemPrompt: '',
    ...(retirement === undefined ? {} : { retirement }),
  },
});

describe('resident retirement recipe', () => {
  test('is opt-in and passes validated configuration to Agent Framework', () => {
    const absent = validateRecipe(recipe());
    expect(buildFrameworkAgentConfig(absent, 'resident', 'model', undefined).retirement)
      .toBeUndefined();

    const parsed = validateRecipe(recipe({
      enabled: true,
      confirmationTtlMs: 120_000,
      confirmationDelayMs: 60_000,
    }));
    const retirement = buildFrameworkAgentConfig(
      parsed,
      'resident',
      'model',
      undefined,
    ).retirement;
    expect(retirement).toMatchObject({
      enabled: true,
    });
    expect(retirement).toEqual({ enabled: true });
  });

  test('rejects malformed or unsafe confirmation configuration', () => {
    expect(() => validateRecipe(recipe(true))).toThrow(/retirement must be an object/);
    expect(() => validateRecipe(recipe({}))).toThrow(/enabled must be a boolean/);
    expect(() => validateRecipe(recipe({ enabled: true, confirmationTtlMs: 9_999 })))
      .toThrow(/confirmationTtlMs/);
    expect(() => validateRecipe(recipe({ enabled: true, confirmationTtlMs: 3_600_001 })))
      .toThrow(/confirmationTtlMs/);
    expect(() => validateRecipe(recipe({ enabled: true, confirmationDelayMs: 0 })))
      .toThrow(/confirmationDelayMs/);
    expect(() => validateRecipe(recipe({
      enabled: true,
      confirmationTtlMs: 60_000,
      confirmationDelayMs: 60_000,
    }))).toThrow(/smaller than confirmationTtlMs/);
    expect(() => validateRecipe(recipe({ enabled: true, surprise: true })))
      .toThrow(/unknown field/);
  });

  test('defers retirement while autobiographical compression quarantine is non-empty', () => {
    let count = 2;
    const strategy = {
      getCompressionQuarantineStatus: () => ({
        count,
        keys: Array.from({ length: count }, (_, i) => `chunk-${i}`),
      }),
    };
    const check = buildRetirementReadinessCheck(
      strategy as Parameters<typeof buildRetirementReadinessCheck>[0],
    );
    expect(check('request')).toEqual({
      ready: false,
      code: 'compression_quarantine',
      reason:
        'Retirement is temporarily unavailable while 2 context span(s) are in compression quarantine.',
    });

    count = 0;
    expect(check('confirm')).toEqual({ ready: true });

    const missingReader = buildRetirementReadinessCheck(
      { name: 'autobiographical' } as Parameters<typeof buildRetirementReadinessCheck>[0],
    );
    expect(() => missingReader('request'))
      .toThrow(/does not expose compression quarantine status/);
  });

  test('fails closed when the installed framework lacks retirement support', () => {
    const parsed = validateRecipe(recipe({ enabled: true }));
    expect(() => assertResidentRetirementSupport(parsed, {})).toThrow(/does not support/);
    expect(() => assertResidentRetirementSupport(parsed, {
      getResidentLifecycleStatus() {},
      retireResident() {},
      previewActivation() {},
    })).not.toThrow();

    const disabled = validateRecipe(recipe({ enabled: false }));
    expect(() => assertResidentRetirementSupport(disabled, {})).not.toThrow();
  });

  test('fails closed when the framework ignores the protected live-tool surface', async () => {
    const parsed = validateRecipe(recipe({ enabled: true }));
    const framework = {
      previewActivation: async () => ({ tools: [] }),
    } as unknown as AgentFramework;
    await expect(assertResidentRetirementToolSurface(parsed, framework, 'resident'))
      .rejects.toThrow(/protected resident lifecycle tool surface/);
  });

  test('fails closed at the framework startup seam and preserves the compatibility error', async () => {
    const optedInRecipe = recipe({ enabled: true });
    const parsed = validateRecipe({
      ...optedInRecipe,
      agent: {
        ...optedInRecipe.agent,
        provider: 'mock',
        strategy: { type: 'passthrough' },
      },
      modules: {
        subagents: false,
        lessons: false,
        retrieval: false,
        wake: false,
        workspace: false,
        subscriptionGc: false,
        channelMode: false,
      },
    });
    let stopCalls = 0;
    const unsupportedFramework = {
      async stop() {
        stopCalls += 1;
        throw new Error('cleanup also failed');
      },
    } as unknown as AgentFramework;

    let startupError: unknown;
    const cleanupLog = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await createFramework(
        {} as Membrane,
        '/tmp/retirement-startup-seam',
        parsed,
        'resident',
        new SettingsModule(),
        null,
        async () => unsupportedFramework,
      );
    } catch (error) {
      startupError = error;
    } finally {
      cleanupLog.mockRestore();
    }

    expect(stopCalls).toBe(1);
    expect(startupError).toBeInstanceOf(Error);
    expect((startupError as Error).message).toMatch(/does not support resident retirement/);
  });
});
