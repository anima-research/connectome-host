import { describe, expect, spyOn, test } from 'bun:test';
import { ChannelRegistry, EventGate, AgentFramework, type ModuleContext, type ToolCall } from '@animalabs/agent-framework';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelModeModule } from '../src/modules/channel-mode-module.js';
import { Membrane, MockAdapter } from '@animalabs/membrane';
import { SubscriptionGcModule } from '../src/modules/subscription-gc-module.js';

type Rule = { name: string; match: { source: string; channel: string } };

function wired(options: {
  entries?: Array<{ serverId: string; descriptor: { id: string; label?: string } }>;
  servers?: Array<{ id: string; connected: boolean }>;
  fallback?: string;
  closeError?: string;
} = {}) {
  const calls: ToolCall[] = [];
  const rules = new Map<string, Rule>();
  const removed: string[] = [];
  const m = new ChannelModeModule({ serverId: options.fallback });
  m.setFramework({
    channels: { listChannelsRaw: () => options.entries ?? [] },
    listMcplServers: () => options.servers ?? ['discord', 'zulip', 'slack'].map(id => ({ id, connected: true })),
    addGatePolicy: (rule: Rule) => { rules.set(rule.name, rule); },
    removeGatePolicy: (name: string) => { removed.push(name); return rules.delete(name); },
  } as unknown as AgentFramework);
  void m.start({ getModule: () => m, getState: () => undefined, setState: () => {}, callTool: async (call: ToolCall) => {
    calls.push(call);
    return call.name === 'channel_close' && options.closeError
      ? { success: false, error: options.closeError } : { success: true };
  } } as unknown as ModuleContext);
  const set = (channelId: string, mode = 'debounced', serverId?: string) => m.handleToolCall({
    id: 'test', name: 'set_channel_mode', input: { channelId, mode, serverId },
  });
  return { m, calls, rules, removed, set };
}

// Lifecycle stubs model a real transport: requests cannot succeed while down.
function registryWired(ids = ['zulip', 'discord', 'slack'], initialState?: unknown) {
  const sent: Array<{ serverId: string; method: string }> = [];
  const servers = ids.map(id => ({
    id, isConnected: true, willReconnect: true,
    grant: { has: (path: string) => path === 'channels.lifecycle' },
    sendChannelsOpen: async ({ channelId }: { channelId: string }) => {
      if (!servers.find(s => s.id === id)!.isConnected) throw new Error('transport closed');
      sent.push({ serverId: id, method: 'channels/open' });
      return { channelId };
    },
    sendChannelsClose: async () => {
      if (!servers.find(s => s.id === id)!.isConnected) throw new Error('transport closed');
      sent.push({ serverId: id, method: 'channels/close' });
      return {};
    },
  }));
  const channels = new ChannelRegistry({ getServer: (id: string) => servers.find(s => s.id === id) } as never, {} as never, () => {}, () => {});
  const rules = new Map<string, Rule>();
  const calls: ToolCall[] = [];
  let saved: unknown = initialState;
  const writes: unknown[] = [];
  const failedTools = new Set<string>();
  const framework = {
    channels, listMcplServers: () => servers.map(s => ({ id: s.id, connected: s.isConnected })),
    addGatePolicy: (r: Rule) => { rules.set(r.name, r); },
    removeGatePolicy: (name: string) => rules.delete(name),
  } as unknown as AgentFramework;
  const createModule = async () => {
    const m = new ChannelModeModule();
    m.setFramework(framework);
    await m.start({
      getModule: () => m,
      getState: () => structuredClone(saved), setState: (state: unknown) => { saved = structuredClone(state); writes.push(saved); },
      callTool: async (call: ToolCall) => {
        calls.push(call);
        if (failedTools.has(call.name)) return { success: false, error: 'injected failure' };
        return call.name.startsWith('subscription-gc--') ? { success: true }
          : channels.handleChannelToolCall(call.name, call.input, { kind: 'module' });
      },
    } as unknown as ModuleContext);
    return m;
  };
  const set = (m: ChannelModeModule, channelId: string, mode = 'debounced', serverId?: string) =>
    m.handleToolCall({ id: 'real', name: 'set_channel_mode', input: { channelId, mode, serverId } });
  const register = (serverId: string, id: string) => channels.handleRegister(serverId, { channels: [{ id, label: id }] } as never);
  return { channels, servers, rules, calls, sent, framework, createModule, set, register, writes, failedTools, saved: () => saved };
}

describe('channel-mode server ownership', () => {
  for (const mode of ['mentions', 'debounced']) {
    test(`R2-1 sequence ${mode === 'mentions' ? 1 : 2}: saved owner binds ${mode} until cleanup`, async () => {
      const w = registryWired(['a', 'b']);
      const m = await w.createModule();
      const id = 'zulip:g';
      for (const server of ['a', 'b']) await w.register(server, id);
      expect((await w.set(m, id, 'debounced', 'a')).success).toBe(true);
      const rules = structuredClone([...w.rules]);
      const calls = w.calls.length;
      const refused = await w.set(m, id, mode, 'b');
      expect(refused.success).toBe(false);
      expect(refused.error).toContain('mentions with serverId "a"');
      expect(w.calls).toHaveLength(calls);
      expect([...w.rules]).toEqual(rules);
      expect(w.saved()).toEqual({ owners: { [id]: 'a' } });
      expect(w.channels.getDesiredState('a', id)).toBe('open');
      // The saved owner also disambiguates a repeated debounced call.
      expect((await w.set(m, id)).success).toBe(true);
      expect((await w.set(m, id, 'mentions')).success).toBe(true);
      expect(w.channels.getDesiredState('a', id)).toBe('closed');
      expect((await w.set(m, id, 'debounced', 'b')).success).toBe(true);
      expect((await w.set(m, id, 'mentions')).success).toBe(true);
      expect(w.channels.getDesiredState('b', id)).toBe('closed');
      expect(w.saved()).toEqual({ owners: {} });
      await m.stop();
    });
  }

  for (const connected of [false, true]) {
    for (const otherRegistered of [false, true]) {
      test(`R4-1/R4-2 configured owner awaiting registration retains binding (connected: ${connected}, other registered: ${otherRegistered})`, async () => {
        const id = 'zulip:g';
        const w = registryWired(['a', 'b']);
        const m = await w.createModule();
        await w.register('a', id);
        await w.set(m, id);
        w.channels.removeServer('a');
        w.servers[0].isConnected = connected;
        // Other entries do not prove that a lazy thread/DM registration is finished.
        if (otherRegistered) await w.register('a', 'zulip:other');
        await w.register('b', id);
        const calls = w.calls.length;
        for (const explicit of [undefined, 'a', 'b']) {
          const refused = await w.set(m, id, 'debounced', explicit);
          expect(refused.success).toBe(false);
          if (explicit !== 'b') {
            expect(refused.error).toContain(connected ? 'threads/DMs' : 'disconnected');
            if (connected) expect(refused.error).not.toContain('disconnected');
          }
          expect(refused.error).toContain('mentions with serverId "a"');
          expect(refused.error).toContain('without a confirmed close');
          expect(refused.error).not.toContain('call again with serverId "b"');
          expect(refused.error).not.toContain('leave serverId out');
          expect(w.calls).toHaveLength(calls);
          expect(w.saved()).toEqual({ owners: { [id]: 'a' } });
        }
        const cleanup = await w.set(m, id, 'mentions');
        expect(cleanup.success).toBe(false);
        expect(cleanup.error).toContain('Retry mentions once');
        expect(cleanup.error).toContain('mentions with serverId "a"');
        expect(cleanup.error).toContain('without a confirmed close');
        expect(cleanup.error).not.toContain('serverId "b"');
        expect(cleanup.error).not.toContain('leave serverId out');
        expect(cleanup.error).not.toContain('must be retried');
        expect(w.saved()).toEqual({ owners: { [id]: 'a' } });
        expect(w.calls[calls]).toMatchObject({ name: 'channel_close', input: { serverId: 'a' } });
        expect(w.rules.size).toBe(0);
        const wrongOwner = await w.set(m, id, 'mentions', 'b');
        expect(wrongOwner.success).toBe(false);
        expect(wrongOwner.error).toContain('mentions with serverId "a"');
        expect(wrongOwner.error).toContain('without a confirmed close');
        expect(w.saved()).toEqual({ owners: { [id]: 'a' } });
        // Explicitly naming the saved owner deliberately abandons it.
        await w.set(m, id, 'mentions', 'a');
        expect(w.saved()).toEqual({ owners: {} });
        await m.stop();
      });
    }
  }

  for (const gcModuleName of [undefined, 'misspelled-gc', 'custom-gc']) {
    test(`R4-3 absent GC wording and one-time custom-name warning (${gcModuleName})`, async () => {
      const m = new ChannelModeModule({ gcModuleName });
      const w = registryWired();
      m.setFramework(w.framework);
      let modulePresent = gcModuleName === 'custom-gc';
      await m.start({
        getModule: () => modulePresent ? m : null,
        getState: () => undefined, setState: () => {},
        callTool: async (call: ToolCall) => call.name === 'channel_open'
          ? { success: false, error: 'injected open failure' } : { success: true },
      } as unknown as ModuleContext);
      const warn = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const set = (mode: string) => w.set(m, 'zulip:g', mode);
        const first = await set('debounced');
        if (modulePresent) {
          expect(first.error).toContain('it is pinned open');
          expect(warn).not.toHaveBeenCalled();
          modulePresent = false; // A custom module removed at runtime also warns.
        }
        const partial = await set('debounced');
        expect(partial.success).toBe(false);
        expect(partial.error).toContain(
          `its debounce rule is set and nothing will auto-close it (no ${gcModuleName ?? 'subscription-gc'} module)`,
        );
        await set('mentions');
        await set('debounced');
        expect(warn).toHaveBeenCalledTimes(gcModuleName === undefined ? 0 : 1);
        if (gcModuleName !== undefined) {
          expect(warn.mock.calls[0][0]).toContain(gcModuleName);
          expect(warn.mock.calls[0][0]).toContain('may still auto-close channels');
        }
      } finally {
        warn.mockRestore();
        await m.stop();
      }
    });
  }

  test('R4-2 lazy registration retains a configured owner despite other channels', async () => {
    const id = 'discord:g1:thread1';
    const w = registryWired(['a', 'b']);
    const m = await w.createModule();
    await w.register('a', id);
    await w.set(m, id);
    w.channels.removeServer('a');
    await w.register('a', 'discord:g1:text1');
    const calls = w.calls.length;
    expect((await w.set(m, id)).success).toBe(false);
    expect(w.calls).toHaveLength(calls);
    await w.set(m, id, 'mentions');
    expect(w.saved()).toEqual({ owners: { [id]: 'a' } });
    await w.register('a', id); // The next thread message registers it.
    expect((await w.set(m, id, 'mentions')).success).toBe(true);
    expect(w.channels.getDesiredState('a', id)).toBe('closed');
    expect(w.saved()).toEqual({ owners: {} });
    await m.stop();
  });

  test('R2-1 sequence 3: removed saved owner cannot silently move to a replacement', async () => {
    const w = registryWired(['a', 'b']);
    const m = await w.createModule();
    const id = 'zulip:g';
    await w.register('a', id);
    await w.set(m, id);
    const removed = w.servers.shift()!;
    w.channels.removeServer('a');
    await w.register('b', id);
    const calls = w.calls.length;
    const rules = structuredClone([...w.rules]);
    const refused = await w.set(m, id);
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('Restore');
    expect(w.calls).toHaveLength(calls);
    expect([...w.rules]).toEqual(rules);
    expect(w.saved()).toEqual({ owners: { [id]: 'a' } });
    w.servers.push(removed);
    await w.register('a', id);
    expect((await w.set(m, id, 'mentions')).success).toBe(true);
    expect(w.channels.getDesiredState('a', id)).toBe('closed');
    await m.stop();
  });

  for (const explicit of ['a']) {
    test(`R2-1 deregistered connected owner releases after mentions (serverId: ${explicit})`, async () => {
      const w = registryWired(['a', 'b']);
      const m = await w.createModule();
      const id = 'zulip:g';
      await w.register('a', id);
      expect((await w.set(m, id)).success).toBe(true);
      await w.channels.handleChanged('a', { removed: [id] });
      await w.register('b', id);
      expect(w.servers[0].isConnected).toBe(true);
      const calls = w.calls.length;
      const replacementState = w.channels.getDesiredState('b', id);
      const cleanup = await w.set(m, id, 'mentions', explicit);
      expect(cleanup.success).toBe(false); // old owner's close is unconfirmed
      expect(cleanup.error).toContain("Old owner a's close could not be confirmed");
      expect(cleanup.error).toContain('saved owner record was cleared');
      expect(cleanup.error).not.toContain('the channel is closed');
      expect(w.calls.slice(calls)).toMatchObject([
        { name: 'channel_close', input: { channelId: id, serverId: 'a' } },
        { name: 'subscription-gc--pin_channel_idle_limit', input: { channelId: id, pinned: false } },
      ]);
      expect(w.calls).toHaveLength(calls + 2);
      // AF refuses before recording closed. Do not mistake abandonment for close.
      expect(w.channels.getDesiredState('a', id)).toBe('open');
      expect(w.channels.getDesiredState('b', id)).toBe(replacementState);
      expect(w.rules.size).toBe(0);
      expect(w.saved()).toEqual({ owners: {} });
      // Reviewer's retry is no longer refused by a permanent binding.
      expect((await w.set(m, id, 'mentions', 'b')).success).toBe(true);
      expect((await w.set(m, id, 'debounced', 'b')).success).toBe(true);
      expect(w.saved()).toEqual({ owners: { [id]: 'b' } });
      await m.stop();
    });
  }

  for (const explicit of [undefined, 'a']) {
    test(`R2-1 removed owner without replacement releases after mentions (serverId: ${explicit})`, async () => {
      const w = registryWired(['a']);
      const m = await w.createModule();
      const id = 'zulip:g';
      await w.register('a', id);
      expect((await w.set(m, id)).success).toBe(true);
      w.servers.shift();
      w.channels.removeServer('a');
      const refused = await w.set(m, id);
      expect(refused.error).toContain('mentions');
      expect(refused.error).toContain('without serverId');
      expect(refused.error).toContain('unconfirmed');
      const calls = w.calls.length;
      const cleanup = await w.set(m, id, 'mentions', explicit);
      expect(cleanup.success).toBe(false);
      expect(cleanup.error).toContain("Old owner a's close could not be confirmed");
      expect(cleanup.error).toContain('saved owner record was cleared');
      expect(cleanup.error).not.toContain('the channel is closed');
      expect(w.calls[calls]).toMatchObject({ name: 'channel_close', input: { channelId: id, serverId: 'a' } });
      expect(w.calls.at(-1)).toMatchObject({ input: { channelId: id, pinned: false } });
      expect(w.channels.getDesiredState('a', id)).toBe('open');
      expect(w.rules.size).toBe(0);
      expect(w.saved()).toEqual({ owners: {} });
      await m.stop();
    });
  }

  for (const failing of ['rule', 'unpin']) {
    test(`R2-1 orphan release still requires successful ${failing} cleanup`, async () => {
      const w = registryWired(['a', 'b']);
      const m = await w.createModule();
      const id = 'zulip:g';
      await w.register('a', id);
      await w.set(m, id);
      await w.channels.handleChanged('a', { removed: [id] });
      await w.register('b', id);
      const remove = w.framework.removeGatePolicy;
      if (failing === 'rule') w.framework.removeGatePolicy = () => { throw new Error('rule removal failed'); };
      else w.failedTools.add('subscription-gc--pin_channel_idle_limit');
      const cleanup = await w.set(m, id, 'mentions', 'a');
      expect(cleanup.success).toBe(false);
      expect(cleanup.error).not.toContain('saved owner record was cleared');
      expect((cleanup.data as { steps: Array<{ detail: string }> }).steps[1].detail).toBe(
        "Old owner a's close could not be confirmed. The saved owner record was retained. " +
        'This does not confirm a close. ' +
        'Call mentions with serverId "a" to retry cleanup and release the binding without a confirmed close.',
      );
      expect(w.saved()).toEqual({ owners: { [id]: 'a' } });
      w.framework.removeGatePolicy = remove;
      w.failedTools.clear();
      await w.set(m, id, 'mentions', 'a');
      expect(w.saved()).toEqual({ owners: {} });
      await m.stop();
    });
  }

  test('R2-2 wrong explicit owner preserves working rule before any step, with binding-aware guidance', async () => {
    const w = registryWired();
    const m = await w.createModule();
    const id = 'zulip:backend';
    await w.register('zulip', id);
    expect((await w.set(m, id)).success).toBe(true);
    const rules = structuredClone([...w.rules]);
    const calls = w.calls.length;
    // Also exercise the registry check without a saved binding to mask it.
    for (const module of [await registryModuleWithoutOwners(), m]) {
      const refused = await w.set(module, id, 'debounced', 'discord');
      expect(refused.success).toBe(false);
      expect([...w.rules]).toEqual(rules);
      expect(refused.error).toContain(module === m
        ? 'mentions with serverId "zulip"'
        : 'It\'s on server "zulip": call again with serverId "zulip"');
      expect(w.calls).toHaveLength(calls);
      expect(w.saved()).toEqual({ owners: { [id]: 'zulip' } });
      expect(w.channels.getDesiredState('zulip', id)).toBe('open');
      expect(w.channels.getDesiredState('discord', id)).toBeUndefined();
      await module.stop();
    }
    async function registryModuleWithoutOwners() {
      const fresh = new ChannelModeModule();
      fresh.setFramework(w.framework);
      await fresh.start({ getModule: () => fresh, getState: () => undefined, setState: () => {}, callTool: async (call: ToolCall) => {
        w.calls.push(call);
        return call.name.startsWith('subscription-gc--') ? { success: true }
          : w.channels.handleChannelToolCall(call.name, call.input, { kind: 'module' });
      } } as unknown as ModuleContext);
      return fresh;
    }
  });

  test('R2-3 framework.switchBranch reads current owners and preserves destination records on writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-branch-'));
    const w = registryWired(['a', 'b']);
    const m = new ChannelModeModule();
    const start = m.start.bind(m);
    m.start = ctx => start({ ...ctx,
      getState: ctx.getState.bind(ctx), setState: ctx.setState.bind(ctx),
      getModule: ctx.getModule.bind(ctx),
      callTool: async (call: ToolCall) => {
        w.calls.push(call);
        return call.name.startsWith('subscription-gc--') ? { success: true }
          : w.channels.handleChannelToolCall(call.name, call.input, { kind: 'module' });
      },
    });
    m.setFramework(w.framework);
    const fw = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: new Membrane(new MockAdapter()),
      agents: [{ name: 'test', model: 'mock', systemPrompt: 'test' }], modules: [m],
      gate: { configPath: join(dir, 'gate.json'), onboarding: false },
    });
    try {
      for (const server of ['a', 'b']) await w.register(server, 'zulip:g');
      await w.register('b', 'zulip:keep');
      const store = fw.getStore();
      const stateId = 'modules/channel-mode/state';
      const main = store.currentBranch().name;
      store.createBranch('destination');
      expect((await w.set(m, 'zulip:g', 'debounced', 'a')).success).toBe(true);
      const source = store.getStateJson(stateId);
      await fw.switchBranch('destination');
      expect((await w.set(m, 'zulip:g', 'debounced', 'b')).success).toBe(true);
      expect((await w.set(m, 'zulip:keep')).success).toBe(true);
      await fw.switchBranch(main);
      expect(store.getStateJson(stateId)).toEqual(source);
      w.calls.length = 0;
      expect((await w.set(m, 'zulip:g', 'mentions')).success).toBe(true);
      expect(w.calls[0]).toMatchObject({ name: 'channel_close', input: { serverId: 'a' } });
      expect((store.getStateJson(stateId) as { owners: object }).owners).toEqual({});
      await fw.switchBranch('destination');
      w.calls.length = 0;
      expect((await w.set(m, 'zulip:g', 'mentions')).success).toBe(true);
      expect(w.calls[0]).toMatchObject({ name: 'channel_close', input: { serverId: 'b' } });
      expect(store.getStateJson(stateId)).toMatchObject({ owners: { 'zulip:keep': 'b' } });
      await fw.switchBranch(main);
      expect((store.getStateJson(stateId) as { owners: object }).owners).toEqual({});
    } finally {
      await fw.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const gcMode of ['off', 'removed', 'unpin-failure'] as const) {
    for (const ownerStatus of ['live', 'deregistered', 'removed'] as const) {
      if (gcMode === 'unpin-failure' && ownerStatus === 'live') continue;
      for (const explicit of ownerStatus === 'live' ? [undefined] : ownerStatus === 'deregistered' ? ['a'] : [undefined, 'a', 'b']) {
        test(`R3 GC ${gcMode}: ${ownerStatus} owner cleanup (serverId: ${explicit})`, async () => {
          const dir = mkdtempSync(join(tmpdir(), 'cm-gc-'));
          const w = registryWired(['a', 'b']);
          const m = new ChannelModeModule();
          const gc = new SubscriptionGcModule();
          const start = m.start.bind(m);
          m.start = ctx => start({ ...ctx,
            getState: ctx.getState.bind(ctx), setState: ctx.setState.bind(ctx),
            getModule: ctx.getModule.bind(ctx),
            // Real AF module lookup/dispatch for GC; real AF registry with
            // module origin and a fake transport for lifecycle (no network).
            callTool: call => {
              w.calls.push(call);
              return call.name.startsWith('subscription-gc--') ? ctx.callTool(call)
                : w.channels.handleChannelToolCall(call.name, call.input, { kind: 'module' });
            },
          });
          m.setFramework(w.framework);
          const fw = await AgentFramework.create({
            storePath: join(dir, 'store'), membrane: new Membrane(new MockAdapter()),
            agents: [{ name: 'test', model: 'mock', systemPrompt: 'test' }],
            modules: gcMode === 'off' ? [m] : [gc, m],
            gate: { configPath: join(dir, 'gate.json'), onboarding: false },
          });
          try {
            const id = 'zulip:g';
            const state = () => fw.getStore().getStateJson('modules/channel-mode/state') as { owners: Record<string, string> };
            await w.register('a', id);
            const setup = await w.set(m, id);
            expect(setup.success).toBe(true);
            if (gcMode === 'off') expect((setup.data as { steps: unknown[] }).steps[2]).toMatchObject({ step: 'gc-pin', ok: true });
            else expect(gc.getAgentSettingsExtension().get('test').channel_idle_pinned).toEqual([id]);
            expect(state()).toMatchObject({ owners: { [id]: 'a' } });
            if (gcMode === 'removed') await fw.removeModule('subscription-gc');
            if (gcMode === 'unpin-failure') {
              // Even this wording is a real failure when the module exists.
              gc.handleToolCall = async () => ({ success: false, error: 'Module not found: subscription-gc, so nothing was done' });
            }
            if (ownerStatus === 'deregistered') {
              await w.channels.handleChanged('a', { removed: [id] });
            }
            if (ownerStatus === 'removed') {
              w.servers.shift();
              w.channels.removeServer('a');
            }
            if (ownerStatus !== 'live') {
              await w.register('b', id);
              expect((await w.set(m, id, 'debounced', 'b')).success).toBe(false);
            }
            const calls = w.calls.length;
            const replacementState = w.channels.getDesiredState('b', id);
            const cleanup = await w.set(m, id, 'mentions', explicit);
            const steps = (cleanup.data as { steps: Array<{ step: string; ok: boolean; detail: string }> }).steps;
            expect(steps[1].step).toBe('close');
            expect(w.calls[calls]).toMatchObject({ name: 'channel_close', input: { channelId: id, serverId: 'a' } });
            expect(w.channels.getDesiredState('b', id)).toBe(replacementState);
            expect(w.rules.size).toBe(0);
            if (gcMode === 'unpin-failure') {
              expect(fw.getModule('subscription-gc')).toBe(gc);
              expect(steps[2]).toMatchObject({ step: 'gc-unpin', ok: false });
              expect(cleanup.error).toContain('releasing its pin failed');
              expect(state().owners).toEqual({ [id]: 'a' });
              expect((await w.set(m, id, 'debounced', 'b')).success).toBe(false);
              expect(gc.getAgentSettingsExtension().get('test').channel_idle_pinned).toEqual([id]);
            } else {
              const closeDetail = "Old owner a's close could not be confirmed. " +
                'The saved owner record was cleared. This does not confirm a close. ' +
                'Close attempt: No channel "zulip:g" is on server "a", so nothing ran. ' +
                'It\'s on server "b": call again with serverId "b", or leave serverId out.';
              const message = ownerStatus === 'live' ? 'Channel zulip:g set to mentions mode.' :
                'Channel zulip:g is only partly in mentions mode: its debounce rule was removed and ' +
                `there was no pin to release (no subscription-gc module), and closing the channel failed (${closeDetail}).`;
              // Assert all text, including nested step details: a correct
              // summary must not hide a false claim that an unpin ran.
              expect(cleanup).toEqual({
                success: ownerStatus === 'live', isError: ownerStatus !== 'live',
                ...(ownerStatus === 'live' ? {} : { error: message }),
                data: {
                  channelId: id, mode: 'mentions', debounceMs: undefined, message,
                  steps: [
                    { step: 'gate-policy', ok: true, detail: 'removed' },
                    { step: 'close', ok: ownerStatus === 'live', detail: ownerStatus === 'live' ? 'channel_close' : closeDetail },
                    { step: 'gc-unpin', ok: true, detail: 'no subscription-gc module; nothing to unpin' },
                  ],
                },
              });
              expect(w.calls.slice(calls)).toHaveLength(1); // no absent-module unpin call
              expect(cleanup.error ?? '').not.toContain('releasing its pin failed');
              expect(cleanup.error ?? '').not.toContain('Module not found');
              expect(state().owners).toEqual({});
              expect(cleanup.success).toBe(ownerStatus === 'live');
              if (ownerStatus === 'live') expect(w.channels.getDesiredState('a', id)).toBe('closed');
              else {
                expect(cleanup.error).toContain('saved owner record was cleared');
                expect(cleanup.error).toContain('there was no pin to release (no subscription-gc module)');
                expect(cleanup.error).not.toContain('the channel is closed');
                // GC absence is harmless; the old binding no longer blocks
                // the replacement's open/rule/record.
                const replacement = await w.set(m, id, 'debounced', 'b');
                expect(replacement.success).toBe(true);
                expect(state().owners).toEqual({ [id]: 'b' });
                expect(w.channels.getDesiredState('b', id)).toBe('open');
              }
            }
          } finally {
            await fw.stop();
            rmSync(dir, { recursive: true, force: true });
          }
        });
      }
    }
  }

  test('real lifecycle and framework push routing match the registry owner, not the prefix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'channel-mode-'));
    const w = registryWired();
    const fw = await AgentFramework.create({
      storePath: join(dir, 'store'), membrane: new Membrane(new MockAdapter()),
      agents: [{ name: 'test', model: 'mock', systemPrompt: 'test' }], modules: [],
      gate: { configPath: join(dir, 'gate.json'), onboarding: false },
    });
    const gate = (fw as unknown as { eventGate: EventGate }).eventGate;
    const m = await w.createModule();
    m.setFramework({ channels: w.channels, listMcplServers: w.framework.listMcplServers,
      addGatePolicy: fw.addGatePolicy.bind(fw), removeGatePolicy: fw.removeGatePolicy.bind(fw),
    } as unknown as AgentFramework);
    try {
      // The descriptor prefix deliberately differs from the owning connection.
      await w.register('slack', 'zulip:backend');
      expect((await w.set(m, 'zulip:backend')).success).toBe(true);
      for (const eventType of ['mcpl:channel-incoming', 'mcpl:push-event']) {
        // Pushes carry the composite id in origin metadata, not channelId.
        // This exercises the framework's resolveRouteChannel/derivePushEventChannel.
        const event = { content: 'ambient', eventType, serverId: 'slack',
          channelId: eventType === 'mcpl:push-event' ? 'backend' : 'zulip:backend',
          metadata: { mcplChannelId: 'zulip:backend' }, tags: ['chat:ambient'] };
        expect(gate.probe(event).policyName).toBe('channel-mode:debounced:zulip:backend');
        expect(gate.probe({ ...event, serverId: 'zulip' }).policyName).toBeNull();
      }
      expect((await w.set(m, 'zulip:backend', 'mentions')).success).toBe(true);
      expect(gate.probe({ content: 'ambient', eventType: 'mcpl:channel-incoming', serverId: 'slack', channelId: 'zulip:backend', tags: ['chat:ambient'] }).policyName).toBeNull();
      expect(w.sent.at(-1)).toEqual({ serverId: 'slack', method: 'channels/close' });
    } finally {
      await m.stop();
      await fw.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  for (const [channelId, serverId] of [
    ['zulip:backend', 'zulip'], ['slack:C0123ABCD', 'slack'], ['discord:guild:channel', 'discord'],
  ]) {
    test(`${channelId}: open, gate source, and close use ${serverId}`, async () => {
      const w = wired();
      expect((await w.set(channelId)).success).toBe(true);
      expect(w.calls[0]).toMatchObject({ name: 'channel_open', input: { channelId, serverId } });
      expect([...w.rules.values()]).toMatchObject([{ match: { source: serverId, channel: channelId } }]);
      expect((await w.set(channelId, 'mentions')).success).toBe(true);
      expect(w.calls[2]).toMatchObject({ name: 'channel_close', input: { channelId, serverId } });
      expect(w.rules.size).toBe(0);
      expect(w.removed).toEqual([`channel-mode:debounced:${channelId}`]);
    });
  }

  test('mixed servers in one module keep distinct rules and remove only the requested rule', async () => {
    const w = wired();
    for (const id of ['zulip:backend', 'slack:C456', 'discord:g:c']) await w.set(id);
    expect([...w.rules.values()].map(r => r.match.source)).toEqual(['zulip', 'slack', 'discord']);
    await w.set('slack:C456', 'mentions');
    expect([...w.rules.values()].map(r => r.match.channel)).toEqual(['zulip:backend', 'discord:g:c']);
    expect(w.calls.filter(c => c.name === 'channel_open' || c.name === 'channel_close').map(c => c.input.serverId))
      .toEqual(['zulip', 'slack', 'discord', 'slack']);
  });

  test('registry owner overrides a misleading prefix and explicit fallback', async () => {
    const w = wired({ entries: [{ serverId: 'slack', descriptor: { id: 'zulip:backend' } }], fallback: 'discord' });
    await w.set('zulip:backend');
    expect(w.calls[0].input.serverId).toBe('slack');
    expect([...w.rules.values()][0].match.source).toBe('slack');
    await w.set('zulip:backend', 'mentions');
    expect(w.calls[2].input.serverId).toBe('slack');
  });

  test('registry matches exact ids, not labels or substrings', async () => {
    const w = wired({ entries: [{ serverId: 'zulip', descriptor: { id: 'bare-channel', label: 'label-only' } }], fallback: 'slack' });
    expect((await w.set('bare-channel')).success).toBe(true);
    expect(w.calls[0].input.serverId).toBe('zulip');
    for (const id of ['label-only', 'bare']) {
      expect((await w.set(id)).success).toBe(true);
      expect(w.calls.at(-2)!.input.serverId).toBe('slack');
    }
  });

  test('connected prefix wins over a different connected fallback', async () => {
    const w = wired({ fallback: 'discord' });
    await w.set('zulip:backend');
    expect(w.calls[0].input.serverId).toBe('zulip');
    expect([...w.rules.values()][0].match.source).toBe('zulip');
    await w.set('zulip:backend', 'mentions');
    expect(w.calls[2].input.serverId).toBe('zulip');
  });

  for (const fallback of [undefined, 'slack']) {
    test(`bare legacy ids and matching namespaces use ${fallback ?? 'implicit discord'} fallback`, async () => {
      const w = wired({ fallback });
      for (const channelId of ['legacy-id', `${fallback ?? 'discord'}:channel`]) {
        expect((await w.set(channelId)).success).toBe(true);
        expect(w.calls.at(-2)!.input.serverId).toBe(fallback ?? 'discord');
        expect(w.rules.get(`channel-mode:debounced:${channelId}`)!.match.source).toBe(fallback ?? 'discord');
        expect((await w.set(channelId, 'mentions')).success).toBe(true);
        expect(w.calls.at(-2)!.input.serverId).toBe(fallback ?? 'discord');
      }
    });
  }

  for (const fallback of [undefined, 'slack']) {
    test(`unknown namespaces refuse instead of using ${fallback ?? 'implicit discord'} fallback`, async () => {
      const w = wired({ fallback });
      for (const channelId of ['unknown:channel', 'teams:x', ':channel']) {
        const result = await w.set(channelId);
        expect(result.success).toBe(false);
        expect(result.isError).toBe(true);
        expect(result.error).toContain('Nothing changed: Cannot resolve a known MCPL server');
        expect(result.error).not.toContain('disconnected');
      }
      expect(w.calls).toEqual([]);
      expect(w.rules.size).toBe(0);
      expect(w.removed).toEqual([]);
    });
  }

  test('registry owner takes precedence even over an unknown namespace', async () => {
    const w = wired({ entries: [{ serverId: 'slack', descriptor: { id: 'teams:x' } }] });
    expect((await w.set('teams:x')).success).toBe(true);
    expect(w.calls[0].input.serverId).toBe('slack');
    expect([...w.rules.values()][0].match.source).toBe('slack');
  });

  for (const fallback of [undefined, 'discord']) {
    test(`teams:x refuses without lifecycle, persisted gate, or GC side effects (${fallback ?? 'implicit'} fallback, real components)`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'channel-mode-unknown-'));
      const configPath = join(dir, 'gate.json');
      const channels = new ChannelRegistry({ getServer: () => undefined } as never, {} as never, () => {}, () => {});
      const gate = new EventGate({
        configPath, emitTrace: () => {}, addMessage: () => {},
        requestInference: () => {}, getAgentNames: () => ['test'],
      });
      const gc = new SubscriptionGcModule();
      const m = new ChannelModeModule({ serverId: fallback });
      const calls: ToolCall[] = [];
      const savedGcStates: unknown[] = [];
      try {
        await gc.start({
          getState: () => undefined, setState: (state: unknown) => { savedGcStates.push(structuredClone(state)); },
          onTrace: () => () => {},
        } as unknown as ModuleContext);
        m.setFramework({
          channels, listMcplServers: () => [{ id: 'discord', connected: true }],
          addGatePolicy: gate.addPolicy.bind(gate), removeGatePolicy: gate.removePolicy.bind(gate),
        } as unknown as AgentFramework);
        await m.start({ getModule: () => m, getState: () => undefined, setState: () => {}, callTool: async (call: ToolCall) => {
          calls.push(call);
          return call.name.startsWith('subscription-gc--')
            ? gc.handleToolCall({ ...call, name: call.name.split('--')[1]! })
            : channels.handleChannelToolCall(call.name, call.input, { kind: 'module' });
        } } as unknown as ModuleContext);
        const result = await m.handleToolCall({ id: 'unknown', name: 'set_channel_mode', input: { channelId: 'teams:x', mode: 'debounced' } });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Nothing changed: Cannot resolve a known MCPL server');
        expect(calls).toEqual([]);
        expect(existsSync(configPath)).toBe(false);
        expect(savedGcStates).toEqual([]);
        expect(gc.getAgentSettingsExtension().get('test').channel_idle_pinned).toEqual([]);
        const event = { content: 'ambient', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'teams:x', tags: ['chat:ambient'] };
        expect(gate.probe(event).policyName).toBeNull();
        expect(gate.probe({ ...event, serverId: 'teams' }).policyName).toBeNull();

        // Old wrong-source state must still be removable without an owner.
        gate.addPolicy({ name: 'channel-mode:debounced:teams:x', match: { source: 'discord', channel: 'teams:x' }, behavior: { debounce: 1000 } });
        await gc.handleToolCall({ id: 'old-pin', name: 'pin_channel_idle_limit', input: { channelId: 'teams:x', pinned: true } });
        const cleanup = await m.handleToolCall({ id: 'cleanup', name: 'set_channel_mode', input: { channelId: 'teams:x', mode: 'mentions' } });
        expect(cleanup.success).toBe(false);
        expect(cleanup.error).toContain('skipped: Cannot resolve');
        expect(calls).toMatchObject([{ name: 'subscription-gc--pin_channel_idle_limit', input: { channelId: 'teams:x', pinned: false } }]);
        expect(calls).toHaveLength(1);
        expect(JSON.parse(readFileSync(configPath, 'utf8')).policies).toEqual([]);
        expect(gc.getAgentSettingsExtension().get('test').channel_idle_pinned).toEqual([]);
        expect(gate.probe(event).policyName).toBeNull();
      } finally {
        await m.stop();
        await gc.stop();
        gate.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('real registry accepts Slack conversation ids and refuses an unregistered raw Discord snowflake', async () => {
    const w = registryWired();
    const m = await w.createModule();
    await w.register('slack', 'slack:C0123ABCD');
    await w.register('discord', 'discord:g:123456789012345678');
    expect((await w.set(m, 'slack:C0123ABCD')).success).toBe(true);
    expect(w.channels.getDesiredState('slack', 'slack:C0123ABCD')).toBe('open');
    expect((await w.set(m, 'slack:C0123ABCD', 'mentions')).success).toBe(true);
    const raw = await w.set(m, '123456789012345678');
    // Legacy routing remains, but the registry must not pretend this id exists.
    expect(raw.success).toBe(false);
    expect((raw.data as { steps: Array<{ step: string; ok: boolean }> }).steps[0]).toMatchObject({ step: 'open', ok: false });
    expect(w.channels.getDesiredState('discord', '123456789012345678')).toBeUndefined();
    await m.stop();
  });

  test('debounced refuses unknown, disconnected, and ambiguous ownership before any step', async () => {
    for (const [options, id, message] of [
      [{ servers: [] }, 'legacy-id', /Cannot resolve/],
      [{ fallback: 'missing' }, 'legacy-id', /Cannot resolve/],
      [{ servers: [{ id: 'zulip', connected: false }, { id: 'discord', connected: true }], fallback: 'discord' }, 'zulip:backend', /zulip.*disconnected/],
      [{ entries: [{ serverId: 'slack', descriptor: { id: 'zulip:backend' } }], servers: [{ id: 'discord', connected: true }], fallback: 'discord' }, 'zulip:backend', /slack.*disconnected/],
      [{ entries: ['zulip', 'slack'].map(serverId => ({ serverId, descriptor: { id: 'zulip:backend' } })) }, 'zulip:backend', /multiple MCPL/],
    ] as const) {
      const w = wired(options as Parameters<typeof wired>[0]);
      const result = await w.set(id);
      expect(result.success).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.error).toContain('Nothing changed');
      expect(result.error).toMatch(message);
      if (message.source.includes('disconnected')) expect(result.error).not.toContain('fallback');
      expect(w.calls).toEqual([]);
      expect(w.rules.size).toBe(0);
      expect(w.removed).toEqual([]);
    }
  });

  for (const [serverId, channelId] of [['zulip', 'zulip:backend'], ['discord', 'discord:g:c']]) {
    test(`R1-1 mentions records a disconnected ${serverId} close and re-registration never reopens`, async () => {
      const w = registryWired();
      const m = await w.createModule();
      await w.register(serverId, channelId);
      expect((await w.set(m, channelId)).success).toBe(true);
      expect(w.channels.getDesiredState(serverId, channelId)).toBe('open');
      w.channels.transportClosed(serverId);
      w.servers.find(s => s.id === serverId)!.isConnected = false;
      const before = structuredClone(w.saved());
      const refused = await w.set(m, channelId);
      expect(refused.error).toContain('Nothing changed');
      expect(w.saved()).toEqual(before);
      const result = await w.set(m, channelId, 'mentions');
      expect(result.success).toBe(false);
      expect(result.error).toContain('no need to call channel_close again');
      expect(result.error).not.toContain('to retry');
      expect(w.channels.getDesiredState(serverId, channelId)).toBe('closed');
      expect(w.saved()).toEqual({ owners: {} });
      expect(w.rules.size).toBe(0);
      expect(w.calls.at(-1)).toMatchObject({ input: { channelId, pinned: false } });
      w.sent.length = 0;
      w.servers.find(s => s.id === serverId)!.isConnected = true;
      await w.register(serverId, channelId);
      expect(w.sent).toEqual([{ serverId, method: 'channels/close' }]);
      expect(w.channels.isChannelOpen({ serverId, channelId })).toBe(false);
      await m.stop();
    });
  }

  for (const [serverId, channelId] of [['discord', 'discord:g:c'], ['zulip', 'zulip:x']]) {
    for (const disconnected of [false, true]) {
      for (const legacyRule of [false, true]) {
        test(`R1-1 unsaved ${serverId} owner closes (disconnected: ${disconnected}, pre-upgrade rule: ${legacyRule})`, async () => {
          const w = registryWired([serverId]);
          await w.register(serverId, channelId);
          // Direct/agent channel_open or persisted pre-upgrade debounced state:
          // neither has a channel-mode owner record.
          expect((await w.channels.handleChannelToolCall('channel_open', { serverId, channelId }, { kind: 'module' })).success).toBe(true);
          const policyName = `channel-mode:debounced:${channelId}`;
          if (legacyRule) w.rules.set(policyName, { name: policyName, match: { source: serverId, channel: channelId } });
          const m = await w.createModule();
          if (disconnected) {
            w.channels.transportClosed(serverId);
            w.servers[0].isConnected = false;
          }
          const result = await w.set(m, channelId, 'mentions');
          expect(result.success).toBe(!disconnected);
          if (disconnected) expect(result.error).toContain('no need to call channel_close again');
          expect(w.calls).toMatchObject([
            { name: 'channel_close', input: { serverId, channelId } },
            { name: 'subscription-gc--pin_channel_idle_limit', input: { channelId, pinned: false } },
          ]);
          expect(w.channels.getDesiredState(serverId, channelId)).toBe('closed');
          expect(w.rules.size).toBe(0);
          expect(w.writes).toEqual([]);
          w.sent.length = 0;
          w.servers[0].isConnected = true;
          await w.register(serverId, channelId);
          expect(w.sent).toEqual([{ serverId, method: 'channels/close' }]);
          expect(w.channels.isChannelOpen({ serverId, channelId })).toBe(false);
          await m.stop();
        });
      }
    }
  }

  test('unsaved mentions uses explicit > registry > known prefix > bare/own-namespace fallback', async () => {
    for (const [channelId, options, explicit, expected] of [
      ['zulip:x', { entries: [{ serverId: 'slack', descriptor: { id: 'zulip:x' } }] }, 'discord', 'discord'],
      ['zulip:x', { entries: [{ serverId: 'slack', descriptor: { id: 'zulip:x' } }] }, undefined, 'slack'],
      ['zulip:x', {}, undefined, 'zulip'],
      ['legacy', { fallback: 'slack' }, undefined, 'slack'],
      ['slack:x', { fallback: 'slack' }, undefined, 'slack'],
    ] as const) {
      const w = wired(options);
      expect((await w.set(channelId, 'mentions', explicit)).success).toBe(true);
      expect(w.calls[0]).toMatchObject({ name: 'channel_close', input: { channelId, serverId: expected } });
    }
  });

  test('R1-4 explicit serverId disambiguates real registry owners and is validated', async () => {
    const w = registryWired(['realm-a', 'realm-b']);
    const m = await w.createModule();
    for (const server of w.servers) await w.register(server.id, 'zulip:general');
    const ambiguous = await w.set(m, 'zulip:general');
    expect(ambiguous.error).toContain('realm-a, realm-b');
    expect(ambiguous.error).toContain('Pass serverId');
    expect(w.calls).toEqual([]);
    expect((await w.set(m, 'zulip:general', 'debounced', 'realm-b')).success).toBe(true);
    expect(w.rules.get('channel-mode:debounced:zulip:general')!.match.source).toBe('realm-b');
    expect(w.channels.getDesiredState('realm-b', 'zulip:general')).toBe('open');
    expect(w.channels.getDesiredState('realm-a', 'zulip:general')).toBe('closed');
    // Live saved ownership also disambiguates mentions when serverId is omitted.
    expect((await w.set(m, 'zulip:general', 'mentions')).success).toBe(true);
    expect((await w.set(m, 'zulip:general', 'debounced', 'realm-b')).success).toBe(true);
    expect((await w.set(m, 'zulip:general', 'mentions', 'realm-b')).success).toBe(true);
    expect(w.sent.at(-1)).toEqual({ serverId: 'realm-b', method: 'channels/close' });
    const count = w.calls.length;
    expect((await w.set(m, 'zulip:general', 'debounced', 'missing')).error).toContain('missing');
    expect(w.calls).toHaveLength(count);
    for (const serverId of ['', 42, null]) {
      const invalid = await m.handleToolCall({ id: 'invalid', name: 'set_channel_mode', input: { channelId: 'zulip:general', mode: 'debounced', serverId } });
      expect(invalid.error).toContain('Nothing changed: serverId');
    }
    await m.stop();
  });

  test('explicit mentions closes a known disconnected owner without saved state', async () => {
    const w = registryWired();
    const m = await w.createModule();
    await w.register('zulip', 'zulip:backend');
    await w.register('zulip', 'zulip:other');
    expect((await w.channels.handleChannelToolCall('channel_open', { serverId: 'zulip', channelId: 'zulip:other' }, { kind: 'module' })).success).toBe(true);
    w.channels.transportClosed('zulip');
    w.servers.find(s => s.id === 'zulip')!.isConnected = false;
    const result = await w.set(m, 'zulip:other', 'mentions', 'zulip');
    expect(result.error).toContain('no need to call channel_close again');
    expect(w.channels.getDesiredState('zulip', 'zulip:other')).toBe('closed');
    await m.stop();
  });

  for (const removeKnownServer of [false, true]) {
    test(`R1-4 persisted owner prevents cleanup retargeting after removeServer (known removed: ${removeKnownServer})`, async () => {
      const w = registryWired(['realm-a', 'realm-b']);
      const m = await w.createModule();
      await w.register('realm-a', 'zulip:general');
      expect((await w.set(m, 'zulip:general')).success).toBe(true);
      expect(w.saved()).toEqual({ owners: { 'zulip:general': 'realm-a' } });
      await m.stop();
      w.channels.removeServer('realm-a');
      if (removeKnownServer) w.servers.splice(0, 1);
      else w.servers[0].isConnected = false;
      await w.register('realm-b', 'zulip:general');
      await w.channels.handleChannelToolCall('channel_open', { serverId: 'realm-b', channelId: 'zulip:general' }, { kind: 'module' });
      const restarted = await w.createModule();
      w.calls.length = 0;
      const result = await w.set(restarted, 'zulip:general', 'mentions');
      expect(result.success).toBe(false);
      expect(w.rules.size).toBe(0);
      expect(w.calls.filter(c => c.name === 'channel_close').map(c => c.input.serverId))
        .toEqual(['realm-a']);
      expect(w.channels.getDesiredState('realm-b', 'zulip:general')).toBe('open');
      if (!removeKnownServer) {
        expect(result.error).toContain('Retry mentions once');
        expect(w.saved()).toEqual({ owners: { 'zulip:general': 'realm-a' } });
        expect((await w.set(restarted, 'zulip:general', 'debounced', 'realm-b')).success).toBe(false);
        // Once registration arrives, a retried close completes normal cleanup.
        w.servers[0].isConnected = true;
        await w.register('realm-a', 'zulip:general');
        expect((await w.set(restarted, 'zulip:general', 'mentions')).success).toBe(true);
        expect(w.channels.getDesiredState('realm-a', 'zulip:general')).toBe('closed');
      } else expect(result.error).toContain("Old owner realm-a's close could not be confirmed");
      expect(w.saved()).toEqual({ owners: {} });
      // No replacement close occurred; the released binding permits its use.
      expect((await w.set(restarted, 'zulip:general', 'debounced', 'realm-b')).success).toBe(true);
      expect((await w.set(restarted, 'zulip:general', 'mentions')).success).toBe(true);
      await restarted.stop();
    });
  }

  test('failed real opens and failed rule installs never persist an owner', async () => {
    const w = registryWired();
    const m = await w.createModule();
    const missing = await w.set(m, 'zulip:missing');
    expect(missing.success).toBe(false);
    expect(w.saved()).toBeUndefined();
    expect(w.writes).toEqual([]);
    await w.register('zulip', 'zulip:backend');
    w.framework.addGatePolicy = () => { throw new Error('rule write failed'); };
    expect((await w.set(m, 'zulip:backend')).success).toBe(false);
    expect(w.channels.getDesiredState('zulip', 'zulip:backend')).toBe('open');
    expect(w.saved()).toBeUndefined();
    expect(w.writes).toEqual([]);
    await m.stop();
  });

  test('completed mentions deletes its owner; a new unsaved call after restart uses the current registry', async () => {
    const w = registryWired(['realm-a', 'realm-b']);
    const m = await w.createModule();
    await w.register('realm-a', 'zulip:general');
    expect((await w.set(m, 'zulip:general')).success).toBe(true);
    expect((await w.set(m, 'zulip:general', 'mentions')).success).toBe(true);
    expect(w.saved()).toEqual({ owners: {} });
    await m.stop();
    w.channels.removeServer('realm-a');
    w.servers.splice(0, 1);
    await w.register('realm-b', 'zulip:general');
    await w.channels.handleChannelToolCall('channel_open', { serverId: 'realm-b', channelId: 'zulip:general' }, { kind: 'module' });
    const restarted = await w.createModule();
    w.calls.length = 0;
    const repeated = await w.set(restarted, 'zulip:general', 'mentions');
    expect(repeated.success).toBe(true);
    expect(w.calls[0]).toMatchObject({ name: 'channel_close', input: { serverId: 'realm-b' } });
    expect(w.channels.getDesiredState('realm-b', 'zulip:general')).toBe('closed');
    expect(w.saved()).toEqual({ owners: {} });
    await restarted.stop();
  });

  test('owner remains when local cleanup fails or close is unanswered and not recorded', async () => {
    const w = registryWired();
    const m = await w.createModule();
    await w.register('zulip', 'zulip:backend');
    await w.set(m, 'zulip:backend');
    w.framework.removeGatePolicy = () => { throw new Error('cannot remove'); };
    expect((await w.set(m, 'zulip:backend', 'mentions')).success).toBe(false);
    expect(w.saved()).toEqual({ owners: { 'zulip:backend': 'zulip' } });
    w.framework.removeGatePolicy = () => true;
    await m.start({ getModule: () => m, getState: () => w.saved(), setState: () => { throw new Error('unexpected deletion'); },
      callTool: async (call: ToolCall) => {
        if (call.name === 'channel_close') throw new Error('no answer');
        return { success: true };
      },
    } as unknown as ModuleContext);
    await w.channels.handleChannelToolCall('channel_open', { serverId: 'zulip', channelId: 'zulip:backend' }, { kind: 'module' });
    expect((await w.set(m, 'zulip:backend', 'mentions')).error).toContain('got no answer');
    expect(w.saved()).toEqual({ owners: { 'zulip:backend': 'zulip' } });
    await m.stop();
  });

  test('1024 live-owner limit refuses before effects; mentions frees capacity, existing ids can be reapplied', async () => {
    const owners = Object.fromEntries(Array.from({ length: 1023 }, (_, i) => [`zulip:tracked-${i}`, 'zulip']));
    const w = registryWired(undefined, { owners });
    const m = await w.createModule();
    await w.register('zulip', 'zulip:last');
    await w.register('zulip', 'zulip:extra');
    expect((await w.set(m, 'zulip:last')).success).toBe(true);
    expect(Object.keys((w.saved() as { owners: object }).owners)).toHaveLength(1024);
    w.calls.length = 0;
    w.writes.length = 0;
    const beforeRules = [...w.rules];
    const refused = await w.set(m, 'zulip:extra');
    expect(refused.error).toContain('Nothing changed');
    expect(refused.error).toContain('1024');
    expect(refused.error).toContain('Complete mentions cleanup');
    expect(refused.error).toContain('mentions with serverId');
    expect(refused.error).toContain('without a confirmed close');
    expect(w.calls).toEqual([]);
    expect(w.writes).toEqual([]);
    expect([...w.rules]).toEqual(beforeRules);
    expect(w.channels.getDesiredState('zulip', 'zulip:extra')).toBe('closed');
    expect((await w.set(m, 'zulip:last')).success).toBe(true);
    expect((await w.set(m, 'zulip:last', 'mentions')).success).toBe(true);
    expect(Object.keys((w.saved() as { owners: object }).owners)).toHaveLength(1023);
    expect((await w.set(m, 'zulip:extra')).success).toBe(true);
    await m.stop();
  });

  test('capacity includes in-flight opens before effects', async () => {
    const owners = Object.fromEntries(Array.from({ length: 1023 }, (_, i) => [`zulip:tracked-${i}`, 'zulip']));
    const w = registryWired(undefined, { owners });
    const m = await w.createModule();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const calls: ToolCall[] = [];
    await m.start({ getModule: () => m, getState: () => ({ owners }), setState: () => {}, callTool: async (call: ToolCall) => {
      calls.push(call);
      if (call.name === 'channel_open') await pending;
      return { success: true };
    } } as unknown as ModuleContext);
    const first = w.set(m, 'zulip:last');
    expect(calls).toHaveLength(1);
    expect((await w.set(m, 'zulip:extra')).error).toContain('1024');
    expect(calls).toHaveLength(1);
    release();
    expect((await first).success).toBe(true);
    await m.stop();
  });

  test('mentions still removes rule and pin when ownership is unknown or ambiguous', async () => {
    for (const entries of [[], ['zulip', 'slack'].map(serverId => ({ serverId, descriptor: { id: 'legacy-id' } }))]) {
      const w = wired({ servers: [], entries });
      w.rules.set('channel-mode:debounced:legacy-id', { name: 'channel-mode:debounced:legacy-id', match: { source: 'discord', channel: 'legacy-id' } });
      const result = await w.set('legacy-id', 'mentions');
      expect(result.error).toContain('skipped');
      expect(w.rules.size).toBe(0);
      expect(w.calls).toMatchObject([{ input: { pinned: false } }]);
      expect(w.calls).toHaveLength(1);
    }
  });

  test('mentions reports a failed close while removing rule and pin', async () => {
    const w = wired({ closeError: 'adapter refused close' });
    await w.set('zulip:backend');
    const result = await w.set('zulip:backend', 'mentions');
    expect(result.success).toBe(false);
    expect(result.error).toContain('closing the channel failed (adapter refused close)');
    expect(w.rules.size).toBe(0);
    expect(w.calls.at(-1)).toMatchObject({ input: { pinned: false } });
  });

  for (const mode of ['debounced', 'mentions']) {
    test(`reapplying ${mode} repairs a persisted wrong-source rule with the real EventGate`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'channel-mode-reapply-'));
      const configPath = join(dir, 'gate.json');
      const channelId = 'zulip:backend';
      const name = `channel-mode:debounced:${channelId}`;
      writeFileSync(configPath, JSON.stringify({ policies: [{ name, match: { source: 'discord', channel: channelId, tagsAny: ['chat:ambient'] }, behavior: { debounce: 1000 } }] }));
      const gate = new EventGate({ configPath, emitTrace: () => {}, addMessage: () => {}, requestInference: () => {}, getAgentNames: () => ['test'] });
      const m = new ChannelModeModule();
      const event = { content: 'ambient', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId, tags: ['chat:ambient'] };
      try {
        expect(gate.probe(event).policyName).toBe(name);
        m.setFramework({ listMcplServers: () => [{ id: 'zulip', connected: true }], addGatePolicy: gate.addPolicy.bind(gate), removeGatePolicy: gate.removePolicy.bind(gate) } as unknown as AgentFramework);
        await m.start({ getModule: () => m, getState: () => undefined, setState: () => {}, callTool: async () => ({ success: true }) } as unknown as ModuleContext);
        expect((await m.handleToolCall({ id: 'reapply', name: 'set_channel_mode', input: { channelId, mode, serverId: 'zulip' } })).success).toBe(true);
        expect(gate.probe(event).policyName).toBeNull();
        expect(gate.probe({ ...event, serverId: 'zulip' }).policyName).toBe(mode === 'debounced' ? name : null);
        const saved = JSON.parse(readFileSync(configPath, 'utf8')).policies;
        expect(saved).toHaveLength(mode === 'debounced' ? 1 : 0);
        if (mode === 'debounced') expect(saved[0].match.source).toBe('zulip');
      } finally {
        await m.stop();
        gate.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('tool schema explains the raw-id legacy fallback without promising a matching rule', () => {
    const tool = new ChannelModeModule().getTools()[0];
    expect(JSON.stringify(tool).length).toBeLessThanOrEqual(1345);
    const schema = JSON.stringify(tool.inputSchema);
    expect(schema).toContain('legacy');
    expect(schema).toContain('no colon');
    expect(schema).toContain('Unknown namespaces are refused');
    expect(schema).not.toContain('silently');
    expect(schema).toContain('slack:<conversationId>');
    expect(schema).not.toContain('teamId');
    expect(schema).toContain('serverId');
  });
});
