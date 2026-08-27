import { describe, expect, test } from 'bun:test';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { validateRecipe } from '../src/recipe.js';

const base = (value?: unknown) => ({
  name: 'tool-wrapper-prose-guard',
  agent: {
    systemPrompt: 'sys',
    ...(value === undefined ? {} : { toolWrapperProseGuard: value }),
  },
});

describe('toolWrapperProseGuard recipe wiring', () => {
  test('is default-off by omission and composes true into AgentConfig', () => {
    const absent = validateRecipe(base());
    expect(absent.agent.toolWrapperProseGuard).toBeUndefined();
    expect(buildFrameworkAgentConfig(absent, 'a', 'm', { kind: 's' } as never).toolWrapperProseGuard).toBeUndefined();

    const enabled = validateRecipe(base(true));
    expect(enabled.agent.toolWrapperProseGuard).toBe(true);
    expect(buildFrameworkAgentConfig(enabled, 'a', 'm', { kind: 's' } as never).toolWrapperProseGuard).toBe(true);

    const disabled = validateRecipe(base(false));
    expect(disabled.agent.toolWrapperProseGuard).toBe(false);
    expect(buildFrameworkAgentConfig(disabled, 'b', 'm', { kind: 's' } as never).toolWrapperProseGuard).toBe(false);

    const reloaded = validateRecipe(JSON.parse(JSON.stringify(enabled)));
    expect(buildFrameworkAgentConfig(reloaded, 'c', 'm', { kind: 's' } as never).toolWrapperProseGuard).toBe(true);
    expect(buildFrameworkAgentConfig(absent, 'd', 'm', { kind: 's' } as never).toolWrapperProseGuard).toBeUndefined();
  });

  test('rejects non-boolean values instead of silently disabling the guard', () => {
    for (const value of ['true', 1, null, {}]) {
      expect(() => validateRecipe(base(value))).toThrow(/toolWrapperProseGuard/);
    }
  });
});
