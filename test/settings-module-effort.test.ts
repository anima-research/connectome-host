import { describe, test, expect, spyOn } from 'bun:test';
import { SettingsModule, type ReasoningEffort } from '../src/modules/settings-module.js';
import { ModuleRegistry, type ModuleContext } from '@animalabs/agent-framework';
import { JsStore } from '@animalabs/chronicle';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  test('a reset by key restores only that field, and reset-all restores each one', async () => {
    const saved = { reasoning: { enabled: true, budgetTokens: 2048, display: 'omitted', effort: 'high', effortExplicit: true } };
    const { ext, persisted } = await started(saved, 'medium');
    const set = { reasoning_enabled: true, reasoning_budget_tokens: 2048, reasoning_display: 'omitted', reasoning_effort: 'high' };
    expect(ext.reset('a', ['reasoning_budget_tokens'])).toEqual({ ...set, reasoning_budget_tokens: 8192 });
    expect(ext.reset('a', ['reasoning_display'])).toEqual({ ...set, reasoning_budget_tokens: 8192, reasoning_display: 'summarized' });
    expect(ext.reset('a', ['reasoning_enabled'])).toEqual({ ...set, reasoning_enabled: false, reasoning_budget_tokens: 8192, reasoning_display: 'summarized' });
    ext.update('a', { reasoning_enabled: true, reasoning_budget_tokens: 2048, reasoning_display: 'omitted' });
    expect(ext.reset('a')).toEqual({ reasoning_enabled: false, reasoning_budget_tokens: 8192, reasoning_display: 'summarized', reasoning_effort: 'medium' });
    expect(persisted()).toEqual({ reasoning: { enabled: false, budgetTokens: 8192, display: 'summarized' } });
  });
});

describe('reasoning follows branch state without restarting the module', () => {
  const source = { reasoning: { enabled: true, budgetTokens: 4096, display: 'omitted', effort: 'high', effortExplicit: true } };
  const baseline = { enabled: false, budgetTokens: 8192, display: 'summarized', effort: 'medium' };

  async function branches(destination: unknown) {
    const states = new Map<string, unknown>([['A', structuredClone(source)], ['B', structuredClone(destination)]]);
    let branch = 'A';
    const mod = new SettingsModule('medium');
    await mod.start({
      getState: () => structuredClone(states.get(branch)),
      setState: (state: unknown) => { states.set(branch, structuredClone(state)); },
    } as unknown as ModuleContext);
    return { mod, ext: mod.getAgentSettingsExtension(), states, switchTo: (name: string) => { branch = name; } };
  }

  for (const reader of ['adapter', 'agent_settings'] as const) {
    test(`${reader} reads destination and source again without writing either branch`, async () => {
      const destination = { reasoning: { enabled: false, budgetTokens: 2048, display: 'summarized', effort: 'low' } };
      const { mod, ext, states, switchTo } = await branches(destination);
      const read = () => reader === 'adapter' ? mod.getReasoning().effort : ext.get('a').reasoning_effort;
      switchTo('B');
      expect(read()).toBe('low');
      switchTo('A');
      expect(read()).toBe('high');
      expect(states.get('A')).toEqual(source);
      expect(states.get('B')).toEqual(destination);
    });
  }

  const destinations = [
    { name: 'empty state', saved: undefined, expected: baseline, override: undefined },
    { name: 'saved unrelated fields', saved: { reasoning: { enabled: false, budgetTokens: 2048 } },
      expected: { ...baseline, budgetTokens: 2048 }, override: undefined },
    { name: 'legacy default', saved: { reasoning: { effort: 'default' } }, expected: baseline, override: undefined },
    { name: 'explicit default', saved: { reasoning: { effort: 'default', effortExplicit: true } },
      expected: { ...baseline, effort: 'default' }, override: 'default' },
    { name: 'legacy nondefault', saved: { reasoning: { effort: 'max', budgetTokens: 2048 } },
      expected: { ...baseline, effort: 'max', budgetTokens: 2048 }, override: 'max' },
    { name: 'invalid fields', saved: { reasoning: { enabled: 'yes', budgetTokens: 'lots', display: 'full', effort: 'invalid', effortExplicit: true } },
      expected: baseline, override: undefined },
  ];
  for (const destination of destinations) {
    for (const operation of ['update', 'reset'] as const) {
      test(`${operation} before any read uses ${destination.name} and preserves destination fields`, async () => {
        const { mod, ext, states, switchTo } = await branches(destination.saved);
        switchTo('B');
        const display = operation === 'update' ? 'omitted' : 'summarized';
        const result = operation === 'update'
          ? ext.update('a', { reasoning_display: display })
          : ext.reset('a', ['reasoning_display']);
        const expected = { ...destination.expected, display };
        expect(result).toEqual({
          reasoning_enabled: expected.enabled, reasoning_budget_tokens: expected.budgetTokens,
          reasoning_display: expected.display, reasoning_effort: expected.effort,
        });
        expect(mod.getReasoning()).toEqual(expected);
        const { effort: _effort, ...unrelated } = expected;
        expect(states.get('B')).toEqual({ reasoning: {
          ...unrelated,
          ...(destination.override === undefined ? {} : { effort: destination.override, effortExplicit: true }),
        } });
        switchTo('A');
        expect(mod.getReasoning()).toEqual({ enabled: true, budgetTokens: 4096, display: 'omitted', effort: 'high' });
        expect(states.get('A')).toEqual(source);
      });
    }
  }

  test('effort reset before any read preserves other destination values and drops its override', async () => {
    const { mod, ext, states, switchTo } = await branches({ reasoning: {
      enabled: false, budgetTokens: 2048, display: 'summarized', effort: 'default', effortExplicit: true,
    } });
    switchTo('B');
    expect(ext.reset('a', ['reasoning_effort'])).toEqual({
      reasoning_enabled: false, reasoning_budget_tokens: 2048, reasoning_display: 'summarized', reasoning_effort: 'medium',
    });
    expect(states.get('B')).toEqual({ reasoning: { enabled: false, budgetTokens: 2048, display: 'summarized' } });
    switchTo('A');
    expect(mod.getReasoning().effort).toBe('high');
    expect(states.get('A')).toEqual(source);
  });

  test('invalid update after switching refuses the write and exposes validated destination values', async () => {
    const destination = { reasoning: { enabled: false, budgetTokens: 2048, display: 'summarized', effort: 'low' } };
    const { mod, ext, states, switchTo } = await branches(destination);
    switchTo('B');
    expect(() => ext.update('a', { reasoning_display: 'omitted', reasoning_effort: 'invalid' })).toThrow(/reasoning_effort must be one of/);
    expect(mod.getReasoning()).toEqual(destination.reasoning);
    expect(states.get('B')).toEqual(destination);
    expect(states.get('A')).toEqual(source);
  });

  test('a malformed saved value is logged once however often it is read, and a different one is logged too', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      let saved: unknown = { reasoning: { display: 'loud' } };
      const mod = new SettingsModule();
      await mod.start({ getState: () => saved, setState: (s: unknown) => { saved = structuredClone(s); } } as unknown as ModuleContext);
      for (let i = 0; i < 3; i++) expect(mod.getReasoning().display).toBe('summarized');
      mod.getAgentSettingsExtension().get('a');
      saved = { reasoning: { display: 'quiet' } };
      mod.getReasoning();
      mod.getReasoning();
      const lines = errors.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('reasoning.display'));
      expect(lines).toEqual([expect.stringContaining('"loud"'), expect.stringContaining('"quiet"')]);
    } finally {
      errors.mockRestore();
    }
  });

  test('real Chronicle branch switch to earlier empty state uses recipe effort and isolates writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'settings-branch-'));
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    try {
      const stateId = 'modules/settings/state';
      store.registerState({ id: stateId, strategy: 'snapshot' });
      const originalBranch = store.currentBranch().name;
      store.createBranch('earlier');
      const mod = new SettingsModule('medium');
      // Started through agent-framework's own registry, so its context is the
      // framework's, which reads the store at each getState; CM's branch
      // selection calls switchBranch on this same store.
      const unused = (): never => { throw new Error('not used by this test'); };
      await new ModuleRegistry(store, {} as never, {
        getAgents: () => [], addMessage: unused, editMessage: unused, removeMessage: unused, getMessage: unused,
        queryMessages: unused, pushEvent: unused, onTrace: () => () => {}, callTool: unused,
      }).addModule(mod);
      const ext = mod.getAgentSettingsExtension();
      ext.update('a', { reasoning_effort: 'high' });
      const sourceState = store.getStateJson(stateId);
      store.switchBranch('earlier');
      expect(store.getStateJson(stateId)).toBeNull();
      // Write first, with no read of the settings before it.
      expect(ext.update('a', { reasoning_display: 'omitted' }).reasoning_effort).toBe('medium');
      expect(store.getStateJson(stateId)).toEqual({ reasoning: { enabled: false, budgetTokens: 8192, display: 'omitted' }, externalIdMap: {} });
      store.switchBranch(originalBranch);
      expect(mod.getReasoning().effort).toBe('high');
      expect(store.getStateJson(stateId)).toEqual(sourceState);
      store.switchBranch('earlier');
      expect(ext.get('a').reasoning_effort).toBe('medium');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
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
