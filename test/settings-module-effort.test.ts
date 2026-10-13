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
      reasoning: { enabled: false, budgetTokens: 8192, display: 'summarized', effort: 'low', effortExplicit: true },
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

  test('an invalid saved value falls back to its default instead of failing every turn', async () => {
    const { mod, ext } = await started({
      reasoning: { enabled: true, budgetTokens: 'lots', display: 'full', effort: 'minimal' },
    });
    expect(mod.getReasoning()).toEqual({ enabled: true, budgetTokens: 8192, display: 'summarized', effort: 'default' });
    expect(ext.get('a').reasoning_effort).toBe('default');
  });

  test('valid saved values are restored unchanged', async () => {
    const saved = { enabled: true, budgetTokens: 2048, display: 'omitted', effort: 'xhigh' };
    const { mod } = await started({ reasoning: saved });
    expect(mod.getReasoning()).toEqual(saved);
  });

  test('reset by key and reset-all both restore recipe baseline', async () => {
    const { ext } = await started(undefined, 'medium');
    ext.update('a', { reasoning_effort: 'low' });
    expect(ext.reset('a', ['reasoning_display']).reasoning_effort).toBe('low');
    expect(ext.reset('a', ['reasoning_effort']).reasoning_effort).toBe('medium');
    ext.update('a', { reasoning_effort: 'max' });
    expect(ext.reset('a').reasoning_effort).toBe('medium');
  });
});


describe('recipe effort baseline and explicit override across restarts', () => {
  test('unrelated settings do not save the recipe baseline as an override', async () => {
    const first = await started(undefined, 'medium');
    first.ext.update('a', { reasoning_display: 'omitted' });
    expect((first.persisted() as { reasoning: Record<string, unknown> }).reasoning.effort).toBeUndefined();
    const restarted = await started(first.persisted(), 'low');
    expect(restarted.mod.getReasoning()).toMatchObject({ display: 'omitted', effort: 'low' });
  });

  test('legacy default follows recipe, while a legacy nondefault remains explicit', async () => {
    expect((await started({ reasoning: { effort: 'default' } }, 'medium')).mod.getReasoning().effort).toBe('medium');
    const legacy = await started({ reasoning: { effort: 'high' } }, 'medium');
    legacy.ext.update('a', { reasoning_enabled: true });
    expect((await started(legacy.persisted(), 'low')).mod.getReasoning().effort).toBe('high');
  });

  test('an explicit model default survives unrelated updates and recipe edits until reset', async () => {
    const first = await started(undefined, 'medium');
    first.ext.update('a', { reasoning_effort: 'default' });
    first.ext.update('a', { reasoning_display: 'omitted' });
    const restarted = await started(first.persisted(), 'low');
    expect(restarted.mod.getReasoning().effort).toBe('default');
    expect(restarted.ext.reset('a', ['reasoning_effort']).reasoning_effort).toBe('low');
    expect((await started(restarted.persisted(), 'high')).mod.getReasoning().effort).toBe('high');
  });

  test('reset-all drops effort override and restart follows edited recipe', async () => {
    const first = await started(undefined, 'medium');
    first.ext.update('a', { reasoning_effort: 'max', reasoning_enabled: true });
    expect(first.ext.reset('a').reasoning_effort).toBe('medium');
    expect((await started(first.persisted(), 'low')).mod.getReasoning()).toEqual({
      enabled: false, budgetTokens: 8192, display: 'summarized', effort: 'low',
    });
  });

  test('invalid saved fields retain independent restore validation and recipe fallback', async () => {
    const first = await started({ reasoning: {
      enabled: 'yes', budgetTokens: 'lots', display: 'full', effort: 'invalid', effortExplicit: true,
    } }, 'medium');
    expect(first.mod.getReasoning()).toEqual({
      enabled: false, budgetTokens: 8192, display: 'summarized', effort: 'medium',
    });
    for (const marker of [false, 'true', 1]) {
      expect((await started({ reasoning: { effort: 'default', effortExplicit: marker } }, 'medium')).mod.getReasoning().effort).toBe('medium');
    }
  });

  test('reused module clears override for a destination with saved unrelated fields', async () => {
    const first = await started(undefined, 'medium');
    first.ext.update('a', { reasoning_effort: 'default' });
    await first.mod.stop();
    let destination: unknown = { reasoning: { display: 'omitted' } };
    await first.mod.start({ getState: () => destination, setState: (s: unknown) => { destination = structuredClone(s); } } as unknown as ModuleContext);
    expect(first.mod.getReasoning()).toMatchObject({ display: 'omitted', effort: 'medium' });
    first.ext.update('a', { reasoning_enabled: true });
    expect((await started(destination, 'low')).mod.getReasoning().effort).toBe('low');
  });
});
