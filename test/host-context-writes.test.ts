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
 *   written, so the head window starts at a row the window holds, and
 *   never while a turn of the agent is alive, a bare /newtopic's included,
 *   whose summary a turn can start during;
 * - a subagent's seed rows (its orientation and task, or a fork's copy of
 *   its parent's context) are the child's own rows, in its window once its
 *   run takes it on;
 * - a subagent's result or failure told straight to the agent that started
 *   it is written for that agent, so no other resident is shown it; one
 *   whose launcher has ended is written for the nearest listed agent above
 *   the launcher, else for the primary, and wakes nobody.
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

  // An idle agent's turn is alive while a continuation of it (a budget
  // restart's) or a retry (a provider hold's) is on its way: the agent's
  // status reads idle, and inFlightGuard, which reads only that, lets the
  // command by. Stored then, the transition entered the window between the
  // turn's rounds (the review's probe, HOST-1).
  test("given its text while a continuation of the agent's turn is on its way, stores its transition once the turn has ended", async () => {
    const strategy = new AutobiographicalStrategy({ headWindowTokens: 4000, recentWindowTokens: 4000, autoTickOnNewMessage: false });
    const h = await bootPresentedHost({ agents: ['clerk', 'mira'], agentConfig: (name) => (name === 'clerk' ? { strategy } : {}), prefix: 'newtopic-alive-' });
    const fw = h.framework as unknown as { pendingContinuationAgents: () => Set<string> };
    const original = fw.pendingContinuationAgents.bind(h.framework);
    try {
      await h.turn('clerk');
      // A continuation of clerk's turn on its way.
      fw.pendingContinuationAgents = () => new Set([...original(), 'clerk']);
      expect(h.framework.getAgent('clerk')!.state.status).toBe('idle');
      expect(h.framework.getHostModeStatus().activeTurnAgents).toContain('clerk');
      expect(() => h.framework.undoLastTurn('clerk')).toThrow("a turn of clerk's is alive");

      const app = { framework: h.framework, agentName: 'clerk', branchState: createBranchState() } as never;
      const result = handleCommand('/newtopic Moving on.', app);
      expect(result.lines.map((l) => l.text)).toEqual([
        'Resetting topic with provided context...',
        "  A turn of clerk's is still alive (a continuation or a retry of it on its way): the transition is stored once it has ended.",
      ]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(h.rowWith('clerk', '[Topic Transition]')).toBeUndefined();

      // The turn ends.
      fw.pendingContinuationAgents = original;
      const outcome = await result.asyncWork!;
      expect(outcome.lines.map((l) => l.text)).toEqual(['Topic reset. Transition summary:', 'Moving on.']);
      const row = h.rowWith('clerk', '[Topic Transition]')!;
      expect(audienceOf(row.metadata)).toEqual({ audience: ['clerk'], ownRowOf: 'clerk' });
      expect(h.inWindow('clerk', row.id)).toBe(true);
      expect((strategy as unknown as { headWindowStartId: string | null }).headWindowStartId).toBe(row.id);
    } finally {
      fw.pendingContinuationAgents = original;
      await h.cleanup();
    }
  });
});

describe('a bare /newtopic', () => {
  // Its summary is an LLM call, and the agent can start a turn during it
  // (J-H3). Stored then, the transition entered the window inside the turn,
  // between rounds its requests were sent without.
  test('whose summary a turn started during stores its transition once the turn has ended, after it in the window, and the next request carries it', async () => {
    const strategy = new AutobiographicalStrategy({ headWindowTokens: 4000, recentWindowTokens: 4000, autoTickOnNewMessage: false });
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    (strategy as unknown as { generateTransitionSummary: () => Promise<string> }).generateTransitionSummary = async () => {
      await summaryGate;
      return 'The ledger work is done; next is the release.';
    };
    const h = await bootPresentedHost({ agents: ['clerk', 'mira'], agentConfig: (name) => (name === 'clerk' ? { strategy } : {}), prefix: 'newtopic-bare-' });
    try {
      await h.turn('clerk');
      const app = { framework: h.framework, agentName: 'clerk', branchState: createBranchState() } as never;
      const result = handleCommand('/newtopic', app);
      expect(result.lines[0]!.text).toBe('Generating transition summary...');

      // A turn starts while the summary is written, and waits in a tool call.
      h.adapter.script('clerk', { wait: 'g' }, { text: 'after the tool' });
      h.framework.nudgeAgent('clerk', 'test');
      await until(() => h.gates.entered.has('g'), "clerk's tool call");
      const before = h.adapter.callsFor('clerk');
      releaseSummary();
      // The summary is in; the turn is alive, so nothing is stored yet.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(h.rowWith('clerk', '[Topic Transition]')).toBeUndefined();

      h.gates.release('g');
      const outcome = await result.asyncWork!;
      expect(outcome.lines.map((l) => l.text)).toEqual(['Topic reset. Transition summary:', 'The ledger work is done; next is the release.']);
      const row = h.rowWith('clerk', '[Topic Transition]')!;
      expect(audienceOf(row.metadata)).toEqual({ audience: ['clerk'], ownRowOf: 'clerk' });
      // The turn's requests went without it, and it follows the turn's rows.
      const sent = h.adapter.wireOf('clerk').slice(before);
      expect(sent.length).toBeGreaterThan(0);
      for (const wire of sent) expect(wire).not.toContain('[Topic Transition]');
      const cm = h.framework.getAgent('clerk')!.getContextManager();
      const window = cm.getPresentedMessages();
      expect(window.at(-1)!.id).toBe(row.id);
      expect(textOf(window.at(-2)!)).toBe('after the tool');
      expect((strategy as unknown as { headWindowStartId: string | null }).headWindowStartId).toBe(row.id);

      await h.turn('clerk');
      expect(h.adapter.wireOf('clerk').at(-1)).toContain('The ledger work is done');
      expect(h.inWindow('mira', row.id)).toBe(false);
    } finally {
      await h.cleanup();
    }
  });
});

describe("a subagent's result or failure told directly", () => {
  // The fallbacks for a run with no route to its caller (J-H4): an
  // untargeted write is stamped for every resident sharing the slot, so
  // another resident's next request carried mira's subagent's failure. Main's
  // addForLauncher (#467) writes it for the launcher and names the launcher
  // when it isn't the module's agent, so the rows read ", for 'mira'".
  test("is in the window of the agent that started it, and no other resident's", async () => {
    const subagent = new SubagentModule({ provider: 'mock', parentAgentName: 'clerk', defaultModel: 'model-kid', maxRetries: 0 });
    const h = await bootPresentedHost({ agents: ['clerk', 'mira'], modules: [subagent as unknown as Module], prefix: 'subagent-told-' });
    subagent.setFramework(h.framework);
    try {
      await h.turn('clerk');
      await h.turn('mira');
      const inner = subagent as unknown as {
        deliverAsyncError(name: string, err: unknown, parent: string): void;
        deliverAsyncResult(name: string, result: { summary: string }, parent: string): void;
      };
      inner.deliverAsyncError('scout', new Error('the search index is down'), 'mira');
      inner.deliverAsyncResult('surveyor', { summary: 'Three ledgers, all balanced.' }, 'mira');
      const failed = h.rowWith('mira', "[Subagent 'scout' failed, for 'mira']")!;
      const returned = h.rowWith('mira', "[Subagent 'surveyor' returned, for 'mira']")!;
      for (const row of [failed, returned]) {
        expect(audienceOf(row.metadata)).toEqual({ audience: ['mira'] });
        expect(h.inWindow('mira', row.id)).toBe(true);
        expect(h.inWindow('clerk', row.id)).toBe(false);
      }
      // Each woke mira; clerk's next request carries neither.
      await until(() => h.adapter.wireOf('mira').some((wire) => wire.includes('Three ledgers')), "mira's request with the result");
      await h.settled('mira');
      await h.turn('clerk');
      const clerkWire = h.adapter.wireOf('clerk').at(-1)!;
      expect(clerkWire).not.toContain('the search index is down');
      expect(clerkWire).not.toContain('Three ledgers');
    } finally {
      await h.cleanup();
    }
  });
});

describe("a subagent's result or failure whose launcher has ended", () => {
  // Written for no agent, it was stamped for every resident sharing the slot,
  // and shown to each of them at rest. It is written for the nearest agent
  // above the launcher that agent-framework lists, else for the primary, and
  // wakes nobody (#291).
  test("is in the window of the nearest listed agent above the launcher, else the primary's, no other resident's, and wakes nobody", async () => {
    const subagent = new SubagentModule({ provider: 'mock', parentAgentName: 'clerk', defaultModel: 'model-kid', maxRetries: 0 });
    const h = await bootPresentedHost({ agents: ['clerk', 'mira'], modules: [subagent as unknown as Module], prefix: 'subagent-ended-' });
    subagent.setFramework(h.framework);
    const ctx = (subagent as unknown as { ctx: { pushEvent(event: { type: string; agentName?: string }): unknown } }).ctx;
    const push = ctx.pushEvent.bind(ctx);
    const woken: string[] = [];
    ctx.pushEvent = (event) => {
      if (event.type === 'inference-request' && event.agentName) woken.push(event.agentName);
      return push(event);
    };
    try {
      expect(h.framework.getPrimaryAgentName()).toBe('clerk');
      await h.turn('clerk');
      await h.turn('mira');
      // mira's subagent 'lead' runs and ends.
      const led = await subagent.handleToolCall({
        id: 'call-lead', name: 'spawn', callerAgentName: 'mira',
        input: { name: 'lead', task: 'Check the ledgers.', model: 'model-lead', sync: true, systemPrompt: 'p' },
      } as unknown as ToolCall);
      expect(led.success).toBe(true);
      const lead = h.framework.listAgents({ includeEnded: true }).find((record) => record.name.startsWith('spawn-lead-'))!;
      expect(lead.ended).toBeDefined();
      expect(lead.relationships.spawnedBy).toBe('mira');
      const calls = { clerk: h.adapter.callsFor('clerk'), mira: h.adapter.callsFor('mira') };
      const inner = subagent as unknown as {
        deliverAsyncError(name: string, err: unknown, launcher: string, launcherShown?: string): void;
        deliverAsyncResult(name: string, result: { summary: string }, launcher: string, launcherShown?: string): void;
      };
      inner.deliverAsyncResult('scout', { summary: 'LEAD-CHILD-RESULT' }, lead.name, 'lead');
      inner.deliverAsyncError('miner', new Error('LEAD-CHILD-FAIL'), lead.name, 'lead');
      inner.deliverAsyncResult('stray', { summary: 'NO-LISTED-ANCESTOR' }, 'gone-launcher');
      const forMira = [
        h.rowWith('mira', "[Subagent 'scout' returned, for 'lead', which has ended]")!,
        h.rowWith('mira', "[Subagent 'miner' failed, for 'lead', which has ended]")!,
      ];
      for (const row of forMira) {
        expect(audienceOf(row.metadata)).toEqual({ audience: ['mira'] });
        expect(h.inWindow('mira', row.id)).toBe(true);
        expect(h.inWindow('clerk', row.id)).toBe(false);
      }
      const forPrimary = h.rowWith('clerk', "[Subagent 'stray' returned, for 'gone-launcher', which has ended]")!;
      expect(audienceOf(forPrimary.metadata)).toEqual({ audience: ['clerk'] });
      expect(h.inWindow('clerk', forPrimary.id)).toBe(true);
      expect(h.inWindow('mira', forPrimary.id)).toBe(false);
      // Nobody is woken: no request is asked for, and none is sent.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(woken).toEqual([]);
      expect({ clerk: h.adapter.callsFor('clerk'), mira: h.adapter.callsFor('mira') }).toEqual(calls);
      // Each one's next request carries its own rows and not the other's.
      await h.turn('clerk');
      const clerkWire = h.adapter.wireOf('clerk').at(-1)!;
      expect(clerkWire).toContain('NO-LISTED-ANCESTOR');
      expect(clerkWire).not.toContain('LEAD-CHILD-RESULT');
      expect(clerkWire).not.toContain('LEAD-CHILD-FAIL');
      await h.turn('mira');
      const miraWire = h.adapter.wireOf('mira').at(-1)!;
      expect(miraWire).toContain('LEAD-CHILD-RESULT');
      expect(miraWire).toContain('LEAD-CHILD-FAIL');
      expect(miraWire).not.toContain('NO-LISTED-ANCESTOR');
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
