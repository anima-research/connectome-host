import { describe, test, expect } from 'bun:test';
import { SettingsModule } from '../src/modules/settings-module.js';
import type { ModuleContext } from '@animalabs/agent-framework';

function started(saved?: unknown) {
  let persisted: unknown = saved;
  const ctx = {
    getState: () => persisted,
    setState: (s: unknown) => { persisted = JSON.parse(JSON.stringify(s)); },
  } as unknown as ModuleContext;
  const mod = new SettingsModule();
  return mod.start(ctx).then(() => ({ mod, ext: mod.getAgentSettingsExtension(), persisted: () => persisted }));
}

describe('SettingsModule reasoning_effort', () => {
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

  test('reset by key and reset-all both restore default', async () => {
    const { ext } = await started();
    ext.update('a', { reasoning_effort: 'low' });
    expect(ext.reset('a', ['reasoning_display']).reasoning_effort).toBe('low');
    expect(ext.reset('a', ['reasoning_effort']).reasoning_effort).toBe('default');
    ext.update('a', { reasoning_effort: 'max' });
    expect(ext.reset('a').reasoning_effort).toBe('default');
  });
});
