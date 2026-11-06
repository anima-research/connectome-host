import { describe, expect, test } from 'bun:test';
import {
  FINE_GRAINED_TOOL_STREAMING_BETA,
  buildFrameworkAgentConfig,
  speculativeChannelChunksSetupWarning,
  speculativeChannelChunksSupportWarning,
} from '../src/framework-agent-config.js';
import { validateRecipe } from '../src/recipe.js';

const base = (value?: unknown, agent: Record<string, unknown> = {}) => ({
  name: 'speculative-channel-chunks',
  agent: {
    systemPrompt: 'sys',
    ...agent,
    ...(value === undefined ? {} : { speculativeChannelChunks: value }),
  },
});

describe('speculativeChannelChunks recipe wiring', () => {
  test('is off by omission and composes a boolean into AgentConfig, through a save and reload too', () => {
    const absent = validateRecipe(base());
    expect(absent.agent.speculativeChannelChunks).toBeUndefined();
    expect(buildFrameworkAgentConfig(absent, 'a', 'm', { kind: 's' } as never).speculativeChannelChunks).toBeUndefined();

    const enabled = validateRecipe(base(true));
    expect(enabled.agent.speculativeChannelChunks).toBe(true);
    expect(buildFrameworkAgentConfig(enabled, 'a', 'm', { kind: 's' } as never).speculativeChannelChunks).toBe(true);

    const disabled = validateRecipe(base(false));
    expect(disabled.agent.speculativeChannelChunks).toBe(false);
    expect(buildFrameworkAgentConfig(disabled, 'b', 'm', { kind: 's' } as never).speculativeChannelChunks).toBe(false);

    const reloaded = validateRecipe(JSON.parse(JSON.stringify(enabled)));
    expect(buildFrameworkAgentConfig(reloaded, 'c', 'm', { kind: 's' } as never).speculativeChannelChunks).toBe(true);
  });

  test('rejects non-boolean values', () => {
    for (const value of ['true', 1, null, {}]) {
      expect(() => validateRecipe(base(value))).toThrow(/speculativeChannelChunks/);
    }
  });

  test('warns when the installed agent-framework predates the option', () => {
    const on = validateRecipe(base(true));
    expect(speculativeChannelChunksSupportWarning(on, {}))
      .toMatch(/^\[agent-settings\] agent\.speculativeChannelChunks is set, but the installed agent-framework predates it/);
    expect(speculativeChannelChunksSupportWarning(on, { speculativeChannelChunks: true })).toBeUndefined();
    expect(speculativeChannelChunksSupportWarning(on, { speculativeChannelChunks: false })).toBeUndefined();
    expect(speculativeChannelChunksSupportWarning(validateRecipe(base(false)), {})).toBeUndefined();
    expect(speculativeChannelChunksSupportWarning(validateRecipe(base()), {})).toBeUndefined();
    expect(speculativeChannelChunksSupportWarning(on, undefined)).toBeUndefined();
  });

  test('warns when it is set where it can gain nothing: another provider, the XML formatter, or no fine-grained beta', () => {
    const beta = { anthropicBetas: [FINE_GRAINED_TOOL_STREAMING_BETA] };
    expect(speculativeChannelChunksSetupWarning(validateRecipe(base(true, beta)))).toBeUndefined();
    expect(speculativeChannelChunksSetupWarning(validateRecipe(base(true, { ...beta, provider: 'anthropic' })))).toBeUndefined();
    expect(speculativeChannelChunksSetupWarning(validateRecipe(base(false)))).toBeUndefined();
    expect(speculativeChannelChunksSetupWarning(validateRecipe(base()))).toBeUndefined();

    expect(speculativeChannelChunksSetupWarning(validateRecipe(base(true))))
      .toMatch(/agent\.anthropicBetas doesn't have "fine-grained-tool-streaming-2025-05-14"/);
    expect(speculativeChannelChunksSetupWarning(validateRecipe(base(true, { anthropicBetas: ['other-beta'] }))))
      .toMatch(/fine-grained-tool-streaming-2025-05-14/);
    expect(speculativeChannelChunksSetupWarning(validateRecipe(base(true, { ...beta, formatter: 'anthropic-xml' }))))
      .toMatch(/formatter "anthropic-xml"/);
    expect(speculativeChannelChunksSetupWarning(validateRecipe(base(true, { provider: 'openrouter' }))))
      .toMatch(/provider "openrouter" doesn't stream tool arguments/);
  });
});
