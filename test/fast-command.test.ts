import { describe, expect, test } from 'bun:test';
import type { AgentFramework } from '@animalabs/agent-framework';
import { handleCommand } from '../src/commands.js';

function app(adapter?: { enabled: boolean }) : Parameters<typeof handleCommand>[1] {
  return {
    framework: {} as AgentFramework,
    sessionManager: {} as never,
    recipe: { name: 'test' } as never,
    branchState: {} as never,
    codexAdapter: adapter ? {
      isFastMode: () => adapter.enabled,
      setFastMode: (enabled) => { adapter.enabled = enabled; },
    } : undefined,
    switchSession: async () => {},
  };
}

describe('/fast', () => {
  test('reports that the command requires the Codex subscription provider', () => {
    expect(handleCommand('/fast on', app()).lines[0]?.text).toMatch(/openai-codex/);
  });

  test('toggles and reports Fast mode', () => {
    const state = { enabled: false };

    expect(handleCommand('/fast', app(state)).lines[0]?.text).toMatch(/OFF/);
    expect(handleCommand('/fast on', app(state)).lines[0]?.text).toMatch(/requested/);
    expect(state.enabled).toBe(true);
    expect(handleCommand('/fast status', app(state)).lines[0]?.text).toMatch(/ON/);
    expect(handleCommand('/fast off', app(state)).lines[0]?.text).toMatch(/disabled/);
    expect(state.enabled).toBe(false);
  });

  test('rejects unknown modes', () => {
    expect(handleCommand('/fast turbo', app({ enabled: false })).lines[0]?.text)
      .toBe('Usage: /fast [on|off|status]');
  });
});
