/**
 * What the host writes into an agent's context (#291, HOST-1). Each agent's
 * context follows its own window, so a row stored is not yet a row the agent
 * is shown: it enters the window at the agent's presentation points, by the
 * audience it is stamped for. The host's own writes are stamped and stored the
 * way the framework's are:
 *
 * - a host notice and an operator's settings notice are rows for the agent
 *   they're about, written through a module's context, so they enter that
 *   agent's window at once while it is idle, or where its turn can carry
 *   them, and no other resident's;
 * - /newtopic's transition is the agent's own row, presented as it is
 *   written, so the head window starts at a row the window holds;
 * - a subagent's seed rows (its orientation and task, or a fork's copy of
 *   its parent's context) are the child's own rows, in its window once its
 *   run takes it on.
 *
 * Each runs a real AgentFramework (test/presented-host.ts) and reads the
 * agents' windows and the requests the provider receives.
 */
import { describe, test, expect, setDefaultTimeout } from 'bun:test';
import { audienceOf } from '@animalabs/agent-framework';
import type { Module, ToolCall } from '@animalabs/agent-framework';
import { AutobiographicalStrategy, type StoredMessage } from '@animalabs/context-manager';
import { createBranchState, handleCommand } from '../src/commands.js';
import { NoticesModule } from '../src/modules/notices-module.js';
import { SettingsModule } from '../src/modules/settings-module.js';
import { SubagentModule } from '../src/modules/subagent-module.js';
import { DEFAULT_RECIPE } from '../src/recipe.js';
import { notifyAgentOfSettingsChange, type PanelAppRef } from '../src/web/panel-data.js';
import { bootPresentedHost, textOf, until } from './presented-host.js';

// A real framework per test, whose turns a busy machine can slow down; the
// limit is there to catch a hang.
setDefaultTimeout(30_000);

/** NoticesModule's marker write, which its posting flow calls once the host has spoken in a channel. */
type Marker = { writeMarker(ep: unknown, channelId: string, text: string, kind: string, form: 'unanswered' | 'status'): void };

describe('host notices', () => {
  test("a notice is stamped for its agent, enters that agent's window at once while it's idle, and no other resident's", async () => {
    const notices = new NoticesModule({ agentName: 'clerk', quietMs: 0 });
    const h = await bootPresentedHost({ agents: ['clerk', 'mira'], modules: [notices], prefix: 'host-notice-' });
    try {
      notices.setFramework(h.framework);
      (notices as unknown as Marker).writeMarker({}, 'zulip:ops', 'Back soon.', 'quota-spent', 'unanswered');
      const row = h.rowWith('clerk', '[host-notice]');
      expect(row).toBeDefined();
      expect(audienceOf(row!.metadata)).toEqual({ audience: ['clerk'] });
      expect(row!.metadata).toMatchObject({ kind: 'host-notice', alertKind: 'quota-spent', channelId: 'zulip:ops' });
      expect(h.inWindow('clerk', row!.id)).toBe(true);

      await h.turn('mira');
      expect(h.inWindow('mira', row!.id)).toBe(false);
      expect(h.adapter.wireOf('mira').join('\n')).not.toContain('[host-notice]');

      await h.turn('clerk');
      expect(h.adapter.wireOf('clerk').at(-1)).toContain('[host-notice]');
    } finally {
      await h.cleanup();
    }
  });

  test("a notice written during the agent's turn enters its window only where a request carried it, and its next request carries it", async () => {
    const notices = new NoticesModule({ agentName: 'clerk', quietMs: 0 });
    const h = await bootPresentedHost({ agents: ['clerk'], modules: [notices], prefix: 'host-notice-turn-' });
    try {
      notices.setFramework(h.framework);
      const cm = h.framework.getAgent('clerk')!.getContextManager();
      h.adapter.script('clerk', { wait: 'g' }, { text: 'clerk done' });
      const before = h.adapter.callsFor('clerk');
      h.framework.nudgeAgent('clerk', 'test');
      await until(() => h.gates.entered.has('g'), "clerk's tool call");

      (notices as unknown as Marker).writeMarker({}, 'zulip:ops', 'Back soon.', 'quota-spent', 'unanswered');
      const row = h.rowWith('clerk', '[host-notice]');
      expect(row).toBeDefined();
      // Stored at once, and kept out of the window while the turn is alive.
      expect(h.inWindow('clerk', row!.id)).toBe(false);

      h.gates.release('g');
      await until(() => h.adapter.callsFor('clerk') >= before + 2, "clerk's round after the tool");
      await h.settled('clerk');
      const reply = h.rowWith('clerk', 'clerk done');
      expect(reply).toBeDefined();
      // Window = wire for the notice: the round after the tool carried it, and
      // it sits before that round's reply, or it didn't, and it entered as the
      // turn ended, after the reply.
      const carried = h.adapter.wireOf('clerk')[before + 1]!.includes('[host-notice]');
      expect(cm.ordinalOf(row!.id)! < cm.ordinalOf(reply!.id)!).toBe(carried);

      await h.turn('clerk');
      expect(h.adapter.wireOf('clerk').at(-1)).toContain('[host-notice]');
    } finally {
      await h.cleanup();
    }
  });
});

describe("an operator's settings notice", () => {
  test("is stamped for its agent, in that agent's window at once, and in its next request, and no other resident's", async () => {
    const h = await bootPresentedHost({ agents: ['clerk', 'mira'], modules: [new SettingsModule()], prefix: 'settings-notice-' });
    try {
      const app = { framework: h.framework, recipe: DEFAULT_RECIPE } as unknown as PanelAppRef;
      notifyAgentOfSettingsChange(app, 'clerk', 'update');
      const row = h.rowWith('clerk', '[operator] context settings changed');
      expect(row).toBeDefined();
      expect(row!.participant).toBe('Context Manager');
      expect(audienceOf(row!.metadata)).toEqual({ audience: ['clerk'] });
      expect(h.inWindow('clerk', row!.id)).toBe(true);

      await h.turn('clerk');
      expect(h.adapter.wireOf('clerk').at(-1)).toContain('[operator] context settings changed');
      await h.turn('mira');
      expect(h.inWindow('mira', row!.id)).toBe(false);
      expect(h.adapter.wireOf('mira').join('\n')).not.toContain('[operator] context settings');
    } finally {
      await h.cleanup();
    }
  });
});

describe('/newtopic', () => {
  test("its transition is the agent's own row, in its window, where the head window starts, and no other resident sees it", async () => {
    const strategy = new AutobiographicalStrategy({ headWindowTokens: 4000, recentWindowTokens: 4000, autoTickOnNewMessage: false });
    const h = await bootPresentedHost({
      agents: ['clerk', 'mira'],
      agentConfig: (name) => (name === 'clerk' ? { strategy } : {}),
      prefix: 'newtopic-',
    });
    try {
      await h.turn('clerk');
      const app = { framework: h.framework, agentName: 'clerk', branchState: createBranchState() } as never;
      const result = handleCommand('/newtopic Moving on to the release.', app);
      const outcome = await result.asyncWork!;
      expect(outcome.lines[0]!.text).toBe('Topic reset. Transition summary:');
      const row = h.rowWith('clerk', '[Topic Transition]');
      expect(row).toBeDefined();
      expect(audienceOf(row!.metadata)).toEqual({ audience: ['clerk'], ownRowOf: 'clerk' });
      expect(h.inWindow('clerk', row!.id)).toBe(true);
      expect((strategy as unknown as { headWindowStartId: string | null }).headWindowStartId).toBe(row!.id);

      await h.turn('clerk');
      expect(h.adapter.wireOf('clerk').at(-1)).toContain('Moving on to the release.');
      await h.turn('mira');
      expect(h.inWindow('mira', row!.id)).toBe(false);
      expect(h.adapter.wireOf('mira').join('\n')).not.toContain('[Topic Transition]');
    } finally {
      await h.cleanup();
    }
  });
});

describe("a subagent's seed rows", () => {
  /** The child's rows as its run is given them, and its window once the run is done. */
  interface Seeded { name: string; seeds: StoredMessage[]; window: string[] }

  async function launch(calls: Array<{ call: ToolCall; parentRows?: boolean }>) {
    const subagent = new SubagentModule({ provider: 'mock', parentAgentName: 'clerk', defaultModel: 'model-kid', maxRetries: 0 });
    const h = await bootPresentedHost({ agents: ['clerk'], modules: [subagent as unknown as Module], prefix: 'subagent-seeds-' });
    subagent.setFramework(h.framework);
    const seeded: Seeded[] = [];
    const fw = h.framework as unknown as { runEphemeralToCompletion: (...args: unknown[]) => Promise<unknown> };
    const run = fw.runEphemeralToCompletion.bind(h.framework);
    fw.runEphemeralToCompletion = async (...args: unknown[]) => {
      const [agent, cm] = args as [{ name: string }, { getAllMessages(): StoredMessage[]; getPresentedMessages(): StoredMessage[] }];
      const seeds = cm.getAllMessages();
      const result = await run(...args);
      seeded.push({ name: agent.name, seeds, window: cm.getPresentedMessages().map((m) => m.id) });
      return result;
    };
    const results = [];
    for (const { call } of calls) results.push(await subagent.handleToolCall(call));
    return { h, seeded, results };
  }

  // Stored before the run registers the child, they are in its window from
  // the window's write-down at that registration on.
  test("a spawn's and a fork's are the child's own rows, in its window once its run takes it on, and its first request carries its task", async () => {
    const forkInput = { name: 'forked', task: 'Count the ledger rows.', model: 'model-forked', sync: true };
    const { h, seeded, results } = await launch([
      { call: { id: 'call-spawn', name: 'spawn', input: { name: 'scout', task: 'Read the release notes.', model: 'model-scout', sync: true, systemPrompt: 'p' }, callerAgentName: 'clerk' } as unknown as ToolCall },
      // A fork with no call in the parent's context: the fallback path's copy and its fork pair.
      { call: { id: 'call-missing', name: 'fork', input: forkInput, callerAgentName: 'clerk' } as unknown as ToolCall },
    ]);
    try {
      for (const result of results) expect(result.success).toBe(true);
      expect(seeded.map((s) => s.name)).toEqual([expect.stringContaining('scout'), expect.stringContaining('forked')]);
      for (const { name, seeds, window } of seeded) {
        expect(seeds.length).toBeGreaterThan(1);
        for (const seed of seeds) {
          expect(audienceOf(seed.metadata), `${name}: ${textOf(seed).slice(0, 60)}`).toEqual({ audience: [name], ownRowOf: name });
          expect(window).toContain(seed.id);
        }
      }
      expect(h.adapter.wireOf('scout')[0]).toContain('Read the release notes.');
      expect(h.adapter.wireOf('forked')[0]).toContain('Count the ledger rows.');
    } finally {
      await h.cleanup();
    }
  });
});
