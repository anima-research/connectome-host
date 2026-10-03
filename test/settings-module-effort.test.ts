import { describe, test, expect } from 'bun:test';
import { SettingsModule, type ReasoningEffort } from '../src/modules/settings-module.js';
import type { ModuleContext } from '@animalabs/agent-framework';

function started(saved?: unknown, initialEffort?: ReasoningEffort) {
  let persisted: unknown = saved;
  const ctx = {
    getState: () => persisted,
    setState: (s: unknown) => { persisted = JSON.parse(JSON.stringify(s)); },
  } as unknown as ModuleContext;
  const mod = new SettingsModule(initialEffort);
  return mod.start(ctx).then(() => ({ mod, ext: mod.getAgentSettingsExtension(), persisted: () => persisted }));
}

describe('SettingsModule reasoning_effort', () => {
  test('configured effort is available before start and for fresh state', async () => {
    expect(new SettingsModule('medium').getReasoning().effort).toBe('medium');
    const { mod } = await started(undefined, 'medium');
    expect(mod.getReasoning()).toEqual({
      enabled: false, budgetTokens: 8192, display: 'summarized', effort: 'medium',
    });
  });

  test('saved effort takes precedence over configured effort', async () => {
    const { mod } = await started({ reasoning: { effort: 'high' } }, 'medium');
    expect(mod.getReasoning().effort).toBe('high');
  });

  test('reused module resets all reasoning settings for a fresh destination session', async () => {
    const previousSettings = {
      reasoning: { enabled: true, budgetTokens: 4096, display: 'omitted', effort: 'high' },
    };
    const { mod, ext, persisted } = await started(previousSettings, 'medium');
    expect(mod.getReasoning()).toEqual(previousSettings.reasoning);
    await mod.stop();

    let destinationSettings: unknown;
    await mod.start({
      getState: () => destinationSettings,
      setState: (s: unknown) => { destinationSettings = JSON.parse(JSON.stringify(s)); },
    } as unknown as ModuleContext);
    expect(mod.getReasoning()).toEqual({
      enabled: false, budgetTokens: 8192, display: 'summarized', effort: 'medium',
    });
    ext.update('a', { reasoning_effort: 'low' });
    expect(destinationSettings).toEqual({
      reasoning: { enabled: false, budgetTokens: 8192, display: 'summarized', effort: 'low' },
    });
    expect(persisted()).toEqual(previousSettings);
  });

  test('legacy and invalid saved effort use configured effort and preserve other saved fields', async () => {
    for (const effort of [undefined, null, 'invalid', 2]) {
      const { mod } = await started({
        reasoning: { enabled: true, budgetTokens: 4096, display: 'omitted', effort },
      }, 'medium');
      expect(mod.getReasoning()).toEqual({
        enabled: true, budgetTokens: 4096, display: 'omitted', effort: 'medium',
      });
    }
    expect((await started({}, 'medium')).mod.getReasoning().effort).toBe('medium');
  });

  test("defaults to 'default', including for state persisted before the field existed", async () => {
    const { mod, ext } = await started({ reasoning: { enabled: true, budgetTokens: 4096, display: 'omitted' } });
    expect(ext.get('a').reasoning_effort).toBe('default');
    expect(mod.getReasoning()).toMatchObject({ enabled: true, display: 'omitted', effort: 'default' });
  });

  test('update persists and is read back by the adapter accessor', async () => {
    const { mod, ext, persisted } = await started();
    expect(ext.update('a', { reasoning_effort: 'xhigh' }).reasoning_effort).toBe('xhigh');
    expect(mod.getReasoning().effort).toBe('xhigh');
    expect((persisted() as { reasoning: { effort: string } }).reasoning.effort).toBe('xhigh');
  });

  test('rejects unknown levels without changing state', async () => {
    const { mod, ext } = await started();
    expect(() => ext.update('a', { reasoning_effort: 'minimal' })).toThrow(/reasoning_effort must be one of/);
    expect(mod.getReasoning().effort).toBe('default');
  });

  test('reset by key and reset-all both restore default', async () => {
    const { ext } = await started(undefined, 'medium');
    ext.update('a', { reasoning_effort: 'low' });
    expect(ext.reset('a', ['reasoning_display']).reasoning_effort).toBe('low');
    expect(ext.reset('a', ['reasoning_effort']).reasoning_effort).toBe('default');
    ext.update('a', { reasoning_effort: 'max' });
    expect(ext.reset('a').reasoning_effort).toBe('default');
  });
});
