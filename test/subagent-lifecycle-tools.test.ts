/**
 * Subagents on the Dendrite registry (agent-framework#546): a spawn is a
 * worker and a fork a task-fork, each recorded with its spawner, its result
 * route and its launch; an async result returns by that route as attributed
 * mail; and five tools act on the registry — list, stop, message, adopt,
 * resume.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, workerSpec } from '@animalabs/agent-framework';
import type { Module, ToolCall, AgentRecord } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { SubagentModule } from '../src/modules/subagent-module.js';

async function harness(
  adapterConfig: ConstructorParameters<typeof MockAdapter>[0] = {},
  moduleConfig: Record<string, unknown> = {},
  /** Further residents beside `parent`: another agent's tree, or a restricted caller. */
  extraAgents: Array<{ name: string; model: string; systemPrompt: string; maxTokens: number; allowedTools?: string[] }> = [],
) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sub-lifecycle-'));
  const adapter = new MockAdapter({ defaultResponse: 'all done', ...adapterConfig });
  const subagent = new SubagentModule({ provider: 'mock', parentAgentName: 'parent', defaultModel: 'mock', maxRetries: 0, ...moduleConfig });
  const framework = await AgentFramework.create({
    storePath: join(tmpDir, 'store'),
    membrane: new Membrane(adapter, { formatter: new NativeFormatter() }),
    agents: [{ name: 'parent', model: 'mock', systemPrompt: 'parent prompt', maxTokens: 256 }, ...extraAgents],
    modules: [subagent as unknown as Module],
  });
  subagent.setFramework(framework);
  framework.start();
  const callAs = (caller: string, name: string, input: Record<string, unknown>, id = `call-${name}-${Math.random().toString(36).slice(2, 8)}`) =>
    subagent.handleToolCall({ id, name, input, callerAgentName: caller } as unknown as ToolCall);
  const call = (name: string, input: Record<string, unknown>, id?: string) => callAs('parent', name, input, id);
  const records = () => framework.listAgents({ includeEnded: true }).filter((r) => typeof (r.metadata as { subagent?: unknown } | undefined)?.subagent === 'string');
  /** The newest incarnation under a subagent's display name. */
  const recordOf = (name: string): AgentRecord | undefined => records().filter((r) => (r.metadata as { subagent: string }).subagent === name).sort((a, b) => b.incarnation - a.incarnation)[0];
  const parentMessages = () => framework.getAgent('parent')!.getContextManager().getAllMessages() as unknown as Array<{ participant: string; content: Array<{ type: string; text?: string }>; metadata?: Record<string, unknown> }>;
  const until = async (cond: () => boolean, what: string, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!cond()) { if (Date.now() > deadline) throw new Error(`timed out: ${what}`); await Bun.sleep(25); }
  };
  return {
    adapter, subagent, framework, call, callAs, records, recordOf, parentMessages, until, storePath: join(tmpDir, 'store'),
    cleanup: async () => { await framework.stop().catch(() => {}); rmSync(tmpDir, { recursive: true, force: true }); },
  };
}

describe('subagents are Dendrite agents', () => {
  test('a sync spawn is a worker spawned by its caller, its result a tool result; a sync fork is a task-fork that inherited a copy', async () => {
    const h = await harness();
    try {
      const spawned = await h.call('spawn', { name: 'worker-1', systemPrompt: 'p', task: 'say done', sync: true });
      expect(spawned.success).toBe(true);
      const w = h.recordOf('worker-1')!;
      expect(w.kind).toBe('worker');
      expect(w.relationships.spawnedBy).toBe('parent');
      expect(w.relationships.resultTo).toEqual({ to: 'parent', as: 'tool-result' });
      expect(w.ended?.reason).toBe('completed');
      expect((w.metadata as { launch: { model: string } }).launch.model).toBe('mock');

      const cm = h.framework.getAgent('parent')!.getContextManager();
      cm.addMessage('user', [{ type: 'text', text: 'please look into it' }]);
      cm.addMessage('parent', [{ type: 'tool_use', id: 'toolu_f1', name: 'subagent--fork', input: { name: 'fork-1', task: 'look' } }] as never);
      const forked = await h.call('fork', { name: 'fork-1', task: 'look', sync: true }, 'toolu_f1');
      expect(forked.success).toBe(true);
      const f = h.recordOf('fork-1')!;
      expect(f.kind).toBe('task-fork');
      expect(f.relationships.spawnedBy).toBe('parent');
      expect(f.inherit).toMatchObject({ from: 'parent', mode: 'copy' });
      expect(f.relationships.resultTo).toEqual({ to: 'parent', as: 'tool-result' });
      expect(f.ended?.reason).toBe('completed');

      const listed = await h.call('list', {});
      expect(listed.success).toBe(true);
      const names = (listed.data as { subagents: Array<{ name: string; status: string; kind: string }> }).subagents;
      expect(names.map((s) => s.name).sort()).toEqual(['fork-1', 'worker-1']);
      expect(names.every((s) => s.status === 'ended: completed')).toBe(true);
      expect(names.find((s) => s.name === 'fork-1')!.kind).toBe('task-fork');
    } finally { await h.cleanup(); }
  }, 30_000);

  test("an async spawn's result returns by its route: attributed mail under the subagent's name in the caller's context", async () => {
    const h = await harness({ responseGenerator: (r) => (r.model === 'mock-async' ? 'the async answer' : 'ok') });
    try {
      const accepted = await h.call('spawn', { name: 'async-1', systemPrompt: 'p', task: 'answer', model: 'mock-async' });
      expect(accepted.success).toBe(true);
      await h.until(() => h.recordOf('async-1')?.ended !== undefined, 'the run ends');
      const r = h.recordOf('async-1')!;
      expect(r.relationships.resultTo).toEqual({ to: 'parent', as: 'message' });
      await h.until(() => h.parentMessages().some((m) => m.metadata?.kind === 'agent-result'), 'the result reaches the parent');
      const mail = h.parentMessages().find((m) => m.metadata?.kind === 'agent-result')!;
      expect(mail.participant).toBe(r.name);
      expect(mail.content.map((b) => b.text ?? '').join('')).toContain("[Subagent 'async-1' returned]");
      expect(mail.content.map((b) => b.text ?? '').join('')).toContain('the async answer');
      expect((mail.metadata!.dendrite as { from: { agent: string } }).from.agent).toBe(r.name);
    } finally { await h.cleanup(); }
  }, 30_000);

  test('message reaches a running subagent under the sender\'s name; stop ends a run; both refuse a subagent that is not running', async () => {
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, defaultResponse: 'x'.repeat(1_200) });
    try {
      const accepted = await h.call('spawn', { name: 'slow-1', systemPrompt: 'p', task: 'take your time' });
      expect(accepted.success).toBe(true);
      await h.until(() => h.recordOf('slow-1') !== undefined && !h.recordOf('slow-1')!.ended, 'the run is registered');
      const live = h.recordOf('slow-1')!;
      const sent = await h.call('message', { name: 'slow-1', text: 'a word from the parent' });
      expect(sent.success).toBe(true);
      expect((sent.data as { agent: string }).agent).toBe(live.name);
      // A turn with no tool boundary takes the message when it ends; it is
      // then in the subagent's stored context under the sender's name, or
      // still held for it. Either way it was never dropped.
      await h.until(() => h.recordOf('slow-1')?.ended !== undefined, 'the run ends', 20_000);
      const stored = (await h.framework.inspectAgentContext(live.name)).getAllMessages() as unknown as Array<{ participant: string; content: Array<{ text?: string }> }>;
      const inContext = stored.some((m) => m.participant === 'parent' && m.content.some((bk) => bk.text?.includes('a word from the parent')));
      const held = h.framework.listHeldMail({ to: live.name }).some((m) => JSON.stringify(m.content).includes('a word from the parent'));
      expect(inContext || held).toBe(true);

      const second = await h.call('spawn', { name: 'slow-2', systemPrompt: 'p', task: 'take your time too' });
      expect(second.success).toBe(true);
      await h.until(() => h.recordOf('slow-2') !== undefined && !h.recordOf('slow-2')!.ended, 'the second run is registered');
      const stopped = await h.call('stop', { name: 'slow-2', reason: 'enough' });
      expect(stopped.success).toBe(true);
      await h.until(() => h.recordOf('slow-2')?.ended !== undefined, 'the record ends');
      expect(['stopped', 'cancelled']).toContain(h.recordOf('slow-2')!.ended!.reason);
      const late = await h.call('message', { name: 'slow-2', text: 'too late' });
      expect(late.success).toBe(false);
      expect(late.error).toContain('is running');
      const again = await h.call('stop', { name: 'slow-2' });
      expect(again.success).toBe(false);
      expect(again.error).toContain('already ended');
    } finally { await h.cleanup(); }
  }, 30_000);

  test('adopt takes an orphan — a subagent whose spawner ended — under the caller, and refuses one that has its parent', async () => {
    const h = await harness();
    try {
      const internals = h.framework as unknown as { registry: { register(spec: ReturnType<typeof workerSpec>): unknown } };
      internals.registry.register(workerSpec('mid', { spawnedBy: 'parent', metadata: { subagent: 'mid', task: 'middle' } }));
      internals.registry.register(workerSpec('leaf', { spawnedBy: 'mid', metadata: { subagent: 'leaf', task: 'leaf work' } }));
      const refused = await h.call('adopt', { name: 'leaf' });
      expect(refused.success).toBe(false);
      expect(refused.error).toContain('has its parent (mid)');
      h.framework.stopAgent('mid', { by: 'test' });
      await h.until(() => h.recordOf('leaf')?.orphaned !== undefined, 'leaf is orphaned');
      const listed = await h.call('list', {});
      expect((listed.data as { subagents: Array<{ name: string; status: string }> }).subagents.find((s) => s.name === 'leaf')!.status).toBe('running, orphaned');
      const adopted = await h.call('adopt', { name: 'leaf' });
      expect(adopted.success).toBe(true);
      expect(h.recordOf('leaf')!.relationships.spawnedBy).toBe('parent');
      expect(h.recordOf('leaf')!.orphaned).toBeUndefined();
    } finally { await h.cleanup(); }
  }, 30_000);

  test('resume runs a failed subagent again from the context it left, under the same name, and delivers its result as a message', async () => {
    let calls = 0;
    const h = await harness({
      responseGenerator: (r) => {
        calls++;
        if (calls === 1) throw new Error('the provider is unavailable');
        return JSON.stringify(r.messages).includes('first pass, 7 beans') ? 'resumed and finished' : 'I have no task';
      },
    });
    try {
      const first = await h.call('spawn', { name: 'again-1', systemPrompt: 'p', task: 'first pass, 7 beans', sync: true });
      expect(first.success).toBe(false);
      const ended = h.recordOf('again-1')!;
      expect(ended.ended?.reason).toBe('failed');
      const resumed = await h.call('resume', { name: 'again-1' });
      expect(resumed.success).toBe(true);
      expect((resumed.data as { incarnation: number }).incarnation).toBe(2);
      await h.until(() => (h.recordOf('again-1')?.incarnation ?? 0) === 2 && h.recordOf('again-1')!.ended !== undefined, 'the second incarnation ends');
      // The first run's route was its awaiting call; nothing awaits the resumed one, so its words come as a message under its own name.
      await h.until(() => h.parentMessages().some((m) => m.participant === h.recordOf('again-1')!.name && m.content.some((b) => b.text?.includes('resumed and finished'))), 'its result reaches the parent as a message under its name');
      const still = await h.call('resume', { name: 'nobody' });
      expect(still.success).toBe(false);
      expect(still.error).toContain("no subagent named 'nobody'");
    } finally { await h.cleanup(); }
  }, 30_000);

  test('a resumed run is created with the thinking binding, window and summary voice its launch was created with', async () => {
    const cases = [
      { provider: 'anthropic', model: undefined, binding: { binds: true, dropBlock: true } },
      { provider: 'bedrock', model: undefined, binding: { binds: true, dropBlock: false } },
      { provider: 'anthropic', model: 'claude-opus-4-8', binding: undefined },
    ] as const;
    for (const { provider, model, binding } of cases) {
      let calls = 0;
      const h = await harness(
        { responseGenerator: () => { calls++; if (calls === 1) throw new Error('the provider is unavailable'); return 'resumed and finished'; } },
        { provider, defaultModel: 'claude-opus-5-5' },
      );
      try {
        const configs: Array<Record<string, unknown>> = [];
        const fw = h.framework as unknown as Record<string, (...args: unknown[]) => unknown>;
        for (const [method, at] of [['createEphemeralAgent', 0], ['resumeAgent', 1]] as const) {
          const original = fw[method]!.bind(h.framework);
          fw[method] = (...args: unknown[]) => { configs.push(args[at] as Record<string, unknown>); return original(...args); };
        }
        const first = await h.call('spawn', { name: 'bound-1', systemPrompt: 'p', task: 'first pass', sync: true, ...(model ? { model } : {}) });
        expect(first.success).toBe(false);
        expect((await h.call('resume', { name: 'bound-1' })).success).toBe(true);
        await h.until(() => (h.recordOf('bound-1')?.incarnation ?? 0) === 2 && h.recordOf('bound-1')!.ended !== undefined, 'the second incarnation ends');
        expect(configs).toHaveLength(2);
        const view = (config: Record<string, unknown>) => ({
          thinkingBinding: config.thinkingBinding,
          physicalWindowTokens: config.physicalWindowTokens,
          summaryParticipant: (config.strategy as { config?: Record<string, unknown> }).config?.summaryParticipant,
        });
        const [launched, resumed] = configs as [Record<string, unknown>, Record<string, unknown>];
        expect(launched.thinkingBinding).toEqual(binding);
        expect(view(launched).summaryParticipant).toBe(h.recordOf('bound-1')!.name);
        expect(view(resumed)).toEqual(view(launched));
      } finally { await h.cleanup(); }
    }
  }, 30_000);

  test("under orientation 'none' a fork is handed its task after one line saying it is the forked stream — no launch description, no 'two parallel streams of you'", async () => {
    const h = await harness({ responseGenerator: () => 'ok' }, { orientation: 'none' });
    try {
      const cm = h.framework.getAgent('parent')!.getContextManager();
      cm.addMessage('user', [{ type: 'text', text: 'please look into it' }]);
      cm.addMessage('parent', [{ type: 'tool_use', id: 'toolu_plain', name: 'subagent--fork', input: { name: 'plain-1', task: 'count the beans' } }] as never);
      const forked = await h.call('fork', { name: 'plain-1', task: 'count the beans', model: 'mock-plain', sync: true }, 'toolu_plain');
      expect(forked.error).toBeUndefined();
      expect(forked.success).toBe(true);
      const request = h.adapter.getRequestLog().map((r) => r.request).find((r) => r.model === 'mock-plain');
      expect(request).toBeDefined();
      const wire = JSON.stringify(request!.messages);
      expect(wire).toContain('You are the forked stream. Your intention for this stream follows.');
      expect(wire).toContain('count the beans');
      expect(wire).not.toContain('Two parallel streams of you');
      expect(wire).not.toContain('Launch of fork');
      // The caller's receipt still describes the launch: the switch is about what the stream itself is told.
      expect(JSON.stringify(forked.data)).toContain('Launch of fork');
      expect(h.recordOf('plain-1')!.kind).toBe('task-fork');
    } finally { await h.cleanup(); }
  }, 30_000);
});

/**
 * The tools keep the module's own rules (slimepriestess's read of 1639b86 on
 * connectome-host#334): reach is the caller's subtree, as peek's is; a
 * resume never grants more than its caller has; an orphan goes only to an
 * agent it was offered to or in whose tree it hung; a resume says where the
 * result will go.
 */
describe('the lifecycle tools keep the module\'s rules', () => {
  const bob = { name: 'bob', model: 'mock', systemPrompt: 'bob prompt', maxTokens: 256 };
  type Registry = { registry: { register(spec: ReturnType<typeof workerSpec>): unknown; end(name: string, reason: string, by?: string): unknown } };
  const names = (listed: { data?: unknown }) => (listed.data as { subagents: Array<{ name: string }> }).subagents.map((s) => s.name).sort();

  test("list, stop and message reach the caller's subtree: not another agent's subagent, not a sibling, not the caller's own parent", async () => {
    const h = await harness({}, {}, [bob]);
    try {
      const internals = h.framework as unknown as Registry;
      internals.registry.register(workerSpec('bobs-sub', { spawnedBy: 'bob', metadata: { subagent: 'bobs-sub', task: "bob's private errand" } }));
      internals.registry.register(workerSpec('mid', { spawnedBy: 'parent', metadata: { subagent: 'mid', task: 'middle' } }));
      internals.registry.register(workerSpec('leaf', { spawnedBy: 'mid', metadata: { subagent: 'leaf', task: 'leaf work' } }));
      internals.registry.register(workerSpec('leaf-2', { spawnedBy: 'mid', metadata: { subagent: 'leaf-2', task: 'other leaf work' } }));

      expect(names(await h.call('list', {}))).toEqual(['leaf', 'leaf-2', 'mid']);
      expect(names(await h.callAs('bob', 'list', {}))).toEqual(['bobs-sub']);
      expect(names(await h.callAs('mid', 'list', {}))).toEqual(['leaf', 'leaf-2', 'mid']);

      const msg = await h.call('message', { name: 'bobs-sub', text: 'psst' });
      expect(msg.success).toBe(false);
      expect(msg.error).toContain("'bobs-sub' is not in your tree (it was started by bob)");
      const stop = await h.call('stop', { name: 'bobs-sub' });
      expect(stop.success).toBe(false);
      expect(stop.error).toContain('not in your tree');
      // A sibling, and the caller's own parent.
      const sibling = await h.callAs('leaf', 'stop', { name: 'leaf-2' });
      expect(sibling.success).toBe(false);
      expect(sibling.error).toContain('not in your tree');
      const up = await h.callAs('leaf', 'stop', { name: 'mid' });
      expect(up.success).toBe(false);
      expect(up.error).toContain('not in your tree');
      expect(h.recordOf('mid')!.ended).toBeUndefined();
      // Within the tree it works, from any level.
      const down = await h.callAs('mid', 'stop', { name: 'leaf-2', reason: 'done with it' });
      expect(down.success).toBe(true);
      expect(h.recordOf('leaf-2')!.ended?.by).toBe('mid');
      const own = await h.callAs('bob', 'stop', { name: 'bobs-sub' });
      expect(own.success).toBe(true);
    } finally { await h.cleanup(); }
  }, 30_000);

  test("lifecycleReach 'all' is the host's option to widen them", async () => {
    const h = await harness({}, { lifecycleReach: 'all' }, [bob]);
    try {
      const internals = h.framework as unknown as Registry;
      internals.registry.register(workerSpec('bobs-sub', { spawnedBy: 'bob', metadata: { subagent: 'bobs-sub', task: 'errand' } }));
      expect(names(await h.call('list', {}))).toEqual(['bobs-sub']);
      const stop = await h.call('stop', { name: 'bobs-sub' });
      expect(stop.success).toBe(true);
    } finally { await h.cleanup(); }
  }, 30_000);

  test('an orphan is adopted only by an agent it was offered to or in whose tree it hung, and the offer\'s framework name is accepted', async () => {
    const h = await harness({}, {}, [bob]);
    try {
      const internals = h.framework as unknown as Registry;
      internals.registry.register(workerSpec('mid', { spawnedBy: 'parent', metadata: { subagent: 'mid', task: 'middle' } }));
      internals.registry.register(workerSpec('spawn-leaf-1234', { spawnedBy: 'mid', resultTo: { to: 'mid', as: 'message' }, metadata: { subagent: 'leaf', task: 'leaf work' } }));
      h.framework.stopAgent('mid', { by: 'test' });
      await h.until(() => h.recordOf('leaf')?.orphaned !== undefined, 'leaf is orphaned');
      expect(h.recordOf('leaf')!.orphaned!.candidates).toContain('parent');

      const stranger = await h.callAs('bob', 'adopt', { name: 'leaf' });
      expect(stranger.success).toBe(false);
      expect(stranger.error).toContain("'leaf' was mid's, and it is offered to parent");
      expect(h.recordOf('leaf')!.orphaned).toBeDefined();

      const adopted = await h.call('adopt', { name: 'spawn-leaf-1234' });
      expect(adopted.success).toBe(true);
      expect((adopted.data as { adopted: string; agent: string }).agent).toBe('spawn-leaf-1234');
      expect(h.recordOf('leaf')!.relationships.spawnedBy).toBe('parent');
      expect(h.recordOf('leaf')!.relationships.resultTo).toEqual({ to: 'parent', as: 'message' });
    } finally { await h.cleanup(); }
  }, 30_000);

  test('an ancestor the offer passes over adopts too, since the orphan hung in its tree', async () => {
    const h = await harness({}, {}, [bob]);
    try {
      const internals = h.framework as unknown as Registry;
      internals.registry.register(workerSpec('top', { spawnedBy: 'parent', metadata: { subagent: 'top', task: 'top' } }));
      internals.registry.register(workerSpec('mid', { spawnedBy: 'top', metadata: { subagent: 'mid', task: 'middle' } }));
      internals.registry.register(workerSpec('mid-2', { spawnedBy: 'mid', metadata: { subagent: 'mid-2', task: 'lower' } }));
      internals.registry.register(workerSpec('leaf', { spawnedBy: 'mid-2', metadata: { subagent: 'leaf', task: 'leaf work' } }));
      h.framework.stopAgent('mid', { by: 'test' });
      h.framework.stopAgent('mid-2', { by: 'test' });
      await h.until(() => h.recordOf('leaf')?.orphaned !== undefined, 'leaf is orphaned');
      expect(h.recordOf('leaf')!.orphaned!.candidates).not.toContain('top');
      const adopted = await h.callAs('top', 'adopt', { name: 'leaf' });
      expect(adopted.success).toBe(true);
      expect(h.recordOf('leaf')!.relationships.spawnedBy).toBe('top');
    } finally { await h.cleanup(); }
  }, 30_000);

  test("lifecycleReach 'all' widens what the tools reach, not who adopts: an orphan still goes only to an agent it was offered to or in whose tree it hung", async () => {
    const h = await harness({}, { lifecycleReach: 'all' }, [bob]);
    try {
      const internals = h.framework as unknown as Registry;
      internals.registry.register(workerSpec('mid', { spawnedBy: 'parent', metadata: { subagent: 'mid', task: 'middle' } }));
      internals.registry.register(workerSpec('spawn-leaf-1', { spawnedBy: 'mid', metadata: { subagent: 'leaf', task: 'leaf work' } }));
      h.framework.stopAgent('mid', { by: 'test' });
      await h.until(() => h.recordOf('leaf')?.orphaned !== undefined, 'leaf is orphaned');
      const stranger = await h.callAs('bob', 'adopt', { name: 'leaf' });
      expect(stranger.success).toBe(false);
      expect(stranger.error).toContain("'leaf' was mid's, and it is offered to parent");
      expect(h.recordOf('leaf')!.orphaned).toBeDefined();
    } finally { await h.cleanup(); }
  }, 30_000);

  test('a run waiting for a slot is reached through the agent it was launched for, not a record another launch left under its name', async () => {
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, defaultResponse: 'x'.repeat(1_200) }, { maxConcurrent: 1 }, [bob]);
    try {
      const internals = h.framework as unknown as Registry;
      internals.registry.register(workerSpec('spawn-x-bob', { spawnedBy: 'bob', metadata: { subagent: 'x', task: "bob's own x" } }));
      h.framework.stopAgent('spawn-x-bob', { by: 'test' });
      expect((await h.call('spawn', { name: 'busy', systemPrompt: 'p', task: 'hold the slot' })).success).toBe(true);
      await h.until(() => h.recordOf('busy') !== undefined && !h.recordOf('busy')!.ended, 'the slot is taken');
      expect((await h.call('spawn', { name: 'x', systemPrompt: 'p', task: 'wait for the slot' })).success).toBe(true);
      expect(h.subagent.getConcurrencyStatus().queued).toBe(1);

      const stranger = await h.callAs('bob', 'stop', { name: 'x' });
      expect(stranger.success).toBe(false);
      expect(stranger.error).toContain("'x' is not in your tree (it was started by parent)");
      expect(h.subagent.getConcurrencyStatus().queued).toBe(1);

      const own = await h.call('stop', { name: 'x' });
      expect(own.success).toBe(true);
      await h.until(() => h.subagent.getConcurrencyStatus().queued === 0, 'the queued run leaves the queue');
      await h.call('stop', { name: 'busy' });
    } finally { await h.cleanup(); }
  }, 30_000);

  test('a stop by the framework name the adoption offer gives stops a run and the runs it started, as a stop by its name does', async () => {
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, defaultResponse: 'x'.repeat(5_000) });
    try {
      expect((await h.call('spawn', { name: 'mid', systemPrompt: 'p', task: 'take your time' })).success).toBe(true);
      await h.until(() => h.recordOf('mid') !== undefined && !h.recordOf('mid')!.ended, 'mid runs');
      const mid = h.recordOf('mid')!.name;
      expect((await h.callAs(mid, 'spawn', { name: 'leaf', systemPrompt: 'p', task: 'take your time too' })).success).toBe(true);
      await h.until(() => h.recordOf('leaf') !== undefined && !h.recordOf('leaf')!.ended, 'leaf runs');
      const stopped = await h.call('stop', { name: mid });
      expect(stopped.success).toBe(true);
      expect(h.recordOf('leaf')!.orphaned).toBeUndefined();
      expect(h.recordOf('leaf')!.ended).toBeDefined();
    } finally { await h.cleanup(); }
  }, 30_000);

  test("a stop by an ended run's framework name stops nothing, not the live run that now holds its name", async () => {
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, defaultResponse: 'x'.repeat(5_000) });
    try {
      const internals = h.framework as unknown as Registry;
      internals.registry.register(workerSpec('spawn-x-old', { spawnedBy: 'parent', metadata: { subagent: 'x', task: 'an earlier x' } }));
      h.framework.stopAgent('spawn-x-old', { by: 'test' });
      const liveX = () => h.records().find((r) => (r.metadata as { subagent: string }).subagent === 'x' && !r.ended);
      expect((await h.call('spawn', { name: 'x', systemPrompt: 'p', task: 'take your time' })).success).toBe(true);
      await h.until(() => liveX() !== undefined, 'the new x runs');
      const stopped = await h.call('stop', { name: 'spawn-x-old' });
      expect(stopped.success).toBe(false);
      expect(stopped.error).toContain("'spawn-x-old' already ended");
      expect(liveX()).toBeDefined();
      await h.call('stop', { name: 'x' });
    } finally { await h.cleanup(); }
  }, 30_000);

  test("a resume by an ended run's framework name resumes that run, not a newer one under its name", async () => {
    const h = await harness();
    try {
      const internals = h.framework as unknown as Registry;
      const launch = { kind: 'spawn', model: 'mock', systemPrompt: 'p', maxTokens: 64, allowedTools: 'all', strategy: {} };
      internals.registry.register(workerSpec('spawn-y-old', { spawnedBy: 'parent', metadata: { subagent: 'y', task: 'the first y', launch } }));
      internals.registry.end('spawn-y-old', 'failed', 'test');
      await Bun.sleep(5);
      internals.registry.register(workerSpec('spawn-y-new', { spawnedBy: 'parent', metadata: { subagent: 'y', task: 'the second y', launch } }));
      internals.registry.end('spawn-y-new', 'failed', 'test');
      const resumed = await h.call('resume', { name: 'spawn-y-old' });
      expect(resumed.success).toBe(true);
      expect((resumed.data as { agent: string }).agent).toBe('spawn-y-old');
      await h.until(() => h.framework.getAgentRecord('spawn-y-old')!.incarnation === 2 && h.framework.getAgentRecord('spawn-y-old')!.ended !== undefined, 'the named run is resumed and ends');
      expect(h.framework.getAgentRecord('spawn-y-new')!.incarnation).toBe(1);
    } finally { await h.cleanup(); }
  }, 30_000);

  test("an adopt by an ended run's framework name adopts nothing, not the live orphan that now holds its name", async () => {
    const h = await harness();
    try {
      const internals = h.framework as unknown as Registry;
      internals.registry.register(workerSpec('spawn-z-old', { spawnedBy: 'parent', metadata: { subagent: 'z', task: 'an earlier z' } }));
      h.framework.stopAgent('spawn-z-old', { by: 'test' });
      internals.registry.register(workerSpec('mid', { spawnedBy: 'parent', metadata: { subagent: 'mid', task: 'middle' } }));
      internals.registry.register(workerSpec('spawn-z-new', { spawnedBy: 'mid', metadata: { subagent: 'z', task: 'the live z' } }));
      h.framework.stopAgent('mid', { by: 'test' });
      await h.until(() => h.framework.getAgentRecord('spawn-z-new')?.orphaned !== undefined, 'the live z is orphaned');
      const adopted = await h.call('adopt', { name: 'spawn-z-old' });
      expect(adopted.success).toBe(false);
      expect(h.framework.getAgentRecord('spawn-z-new')!.orphaned).toBeDefined();
      expect(h.framework.getAgentRecord('spawn-z-new')!.relationships.spawnedBy).toBe('mid');
    } finally { await h.cleanup(); }
  }, 30_000);

  test("an adopted run is its adopter's: stopping the adopter stops it first, as one of its own", async () => {
    const h = await harness({
      streamChunkDelayMs: 20, streamChunkSize: 10,
      responseGenerator: (r) => (r.model === 'mock-brief' ? 'y'.repeat(600) : 'x'.repeat(5_000)),
    });
    try {
      const live = (name: string) => h.recordOf(name) !== undefined && !h.recordOf(name)!.ended;
      expect((await h.call('spawn', { name: 'top', systemPrompt: 'p', task: 'take your time' })).success).toBe(true);
      await h.until(() => live('top'), 'top runs');
      const top = h.recordOf('top')!.name;
      expect((await h.callAs(top, 'spawn', { name: 'mid', systemPrompt: 'p', task: 'be brief', model: 'mock-brief' })).success).toBe(true);
      await h.until(() => live('mid'), 'mid runs');
      expect((await h.callAs(h.recordOf('mid')!.name, 'spawn', { name: 'leaf', systemPrompt: 'p', task: 'take your time' })).success).toBe(true);
      await h.until(() => live('leaf'), 'leaf runs');
      await h.until(() => h.recordOf('mid')?.ended !== undefined && h.recordOf('leaf')?.orphaned !== undefined, 'mid ends and leaf is orphaned');
      expect(h.recordOf('leaf')!.orphaned!.candidates).toContain(top);
      expect((await h.callAs(top, 'adopt', { name: 'leaf' })).success).toBe(true);

      expect((await h.call('stop', { name: 'top' })).success).toBe(true);
      expect(h.recordOf('leaf')!.orphaned).toBeUndefined();
      expect(h.recordOf('leaf')!.ended).toBeDefined();
    } finally { await h.cleanup(); }
  }, 30_000);

  test("a resume is refused when the launch's tools exceed the caller's rule, or the subagent is outside the caller's tree, or it is still running", async () => {
    const narrow = { name: 'narrow', model: 'mock', systemPrompt: 'narrow prompt', maxTokens: 256, allowedTools: ['subagent--resume', 'subagent--return'] };
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, defaultResponse: 'x'.repeat(1_200) }, {}, [bob, narrow]);
    try {
      const first = await h.call('spawn', { name: 'f1', systemPrompt: 'p', task: 'first pass', sync: true });
      expect(first.success).toBe(true);
      expect((h.recordOf('f1')!.metadata as { launch: { allowedTools: unknown } }).launch.allowedTools).toBe('all');

      const outside = await h.callAs('narrow', 'resume', { name: 'f1' });
      expect(outside.success).toBe(false);
      expect(outside.error).toContain("'f1' is not in your tree");
      // Give narrow a launch of its own that it could not have made.
      const internals = h.framework as unknown as Registry;
      internals.registry.register(workerSpec('spawn-all-1', { spawnedBy: 'narrow', metadata: { subagent: 'everything', task: 'all work', launch: { kind: 'spawn', model: 'mock', systemPrompt: 'p', maxTokens: 64, allowedTools: 'all', strategy: {} } } }));
      internals.registry.end('spawn-all-1', 'failed', 'test');
      const all = await h.callAs('narrow', 'resume', { name: 'everything' });
      expect(all.success).toBe(false);
      expect(all.error).toContain('tools you do not have (all tools, where your own list is limited)');
      internals.registry.register(workerSpec('spawn-wide-1', { spawnedBy: 'narrow', metadata: { subagent: 'wide', task: 'wide work', launch: { kind: 'spawn', model: 'mock', systemPrompt: 'p', maxTokens: 64, allowedTools: ['subagent--resume', 'subagent--return', 'read_file'], strategy: {} } } }));
      internals.registry.end('spawn-wide-1', 'failed', 'test');
      const more = await h.callAs('narrow', 'resume', { name: 'wide' });
      expect(more.success).toBe(false);
      expect(more.error).toContain('tools you do not have (read_file)');
      const stranger = await h.callAs('bob', 'resume', { name: 'f1' });
      expect(stranger.success).toBe(false);
      expect(stranger.error).toContain('not in your tree');

      const running = await h.call('spawn', { name: 'slow-3', systemPrompt: 'p', task: 'take your time' });
      expect(running.success).toBe(true);
      await h.until(() => h.recordOf('slow-3') !== undefined && !h.recordOf('slow-3')!.ended, 'the run is registered');
      const early = await h.call('resume', { name: 'slow-3' });
      expect(early.success).toBe(false);
      expect(early.error).toContain('is still running');
      const strangerEarly = await h.callAs('bob', 'resume', { name: 'slow-3' });
      expect(strangerEarly.success).toBe(false);
      expect(strangerEarly.error).toContain("'slow-3' is not in your tree");
      expect(strangerEarly.error).not.toContain('still running');
      // Not pinned here: resume's name-in-use check (a record ended while its
      // async handle is still finishing). The mock closes that window too
      // fast to hold a call in it.

      await h.call('stop', { name: 'slow-3' });
    } finally { await h.cleanup(); }
  }, 30_000);

  test("a resume says where the result goes when the record's route is to someone else who is still running", async () => {
    const h = await harness({}, {}, [bob]);
    try {
      const internals = h.framework as unknown as Registry;
      internals.registry.register(workerSpec('spawn-job-1', { spawnedBy: 'parent', resultTo: { to: 'bob', as: 'message' }, metadata: { subagent: 'job', task: 'for bob', launch: { kind: 'spawn', model: 'mock', systemPrompt: 'p', maxTokens: 64, allowedTools: 'all', strategy: {} } } }));
      internals.registry.end('spawn-job-1', 'failed', 'test');
      const resumed = await h.call('resume', { name: 'job' });
      expect(resumed.success).toBe(true);
      expect((resumed.data as { resultTo: string; note: string }).resultTo).toBe('bob');
      expect((resumed.data as { note: string }).note).toContain('its result goes to bob as a message');
    } finally { await h.cleanup(); }
  }, 30_000);
});

describe("a launch whose caller ends before it registers", () => {
  const caller = { name: 'caller', model: 'mock', systemPrompt: 'caller prompt', maxTokens: 256 };
  const reached = (h: Awaited<ReturnType<typeof harness>>, name: string) =>
    h.parentMessages().find((m) => m.metadata?.kind === 'agent-result' && m.content.some((b) => b.text?.includes(`[Subagent '${name}' returned, for 'caller', which has ended]`)));

  test("a run registered under a live subagent ancestor, its caller having ended, is that ancestor's child: stopping the ancestor stops it first", async () => {
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, responseGenerator: (r) => (r.model === 'mock-slow' ? 'x'.repeat(3_000) : 'ok') }, { maxConcurrent: 2 });
    try {
      expect((await h.call('spawn', { name: 'anc-a', systemPrompt: 'p', task: 'hold', model: 'mock-slow' })).success).toBe(true);
      await h.until(() => h.recordOf('anc-a') !== undefined && !h.recordOf('anc-a')!.ended, 'A runs');
      const a = h.recordOf('anc-a')!.name;
      expect((await h.callAs(a, 'spawn', { name: 'anc-b', systemPrompt: 'p', task: 'hold', model: 'mock-slow' })).success).toBe(true);
      await h.until(() => h.recordOf('anc-b') !== undefined && !h.recordOf('anc-b')!.ended, 'B runs');
      const b = h.recordOf('anc-b')!.name;
      expect((await h.callAs(b, 'spawn', { name: 'anc-c', systemPrompt: 'p', task: 'hold', model: 'mock-slow' })).success).toBe(true);
      expect(h.subagent.getConcurrencyStatus().queued).toBe(1);
      h.framework.stopAgent(b, { by: 'test' });
      await h.until(() => h.recordOf('anc-c') !== undefined && !h.recordOf('anc-c')!.ended, 'C registers and runs', 20_000);
      expect(h.recordOf('anc-c')!.relationships.spawnedBy).toBe(a);

      expect((await h.call('stop', { name: 'anc-a' })).success).toBe(true);
      await h.until(() => h.recordOf('anc-c')!.ended !== undefined || h.recordOf('anc-c')!.orphaned !== undefined, "C is stopped, or left behind as A's orphan");
      expect(h.recordOf('anc-c')!.ended?.reason).toBe('stopped');
    } finally { await h.cleanup(); }
  }, 40_000);

  test("a sync spawn queued for a slot, whose caller ended while it waited, returns to the ancestor it ran under, not to the ended caller's call", async () => {
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, responseGenerator: (r) => (r.model === 'mock-slow' ? 'x'.repeat(600) : 'the sync answer') }, { maxConcurrent: 1 }, [caller]);
    try {
      expect((await h.call('spawn', { name: 'busy-s', systemPrompt: 'p', task: 'take your time', model: 'mock-slow' })).success).toBe(true);
      await h.until(() => h.recordOf('busy-s') !== undefined && !h.recordOf('busy-s')!.ended, 'the slot is taken');
      const pending = h.callAs('caller', 'spawn', { name: 'sync-q', systemPrompt: 'p', task: 'answer', sync: true });
      await h.until(() => h.subagent.getConcurrencyStatus().queued === 1, 'the sync spawn waits for the slot');
      h.framework.stopAgent('caller', { by: 'test' });
      await pending;
      await h.until(() => reached(h, 'sync-q') !== undefined, 'its result reaches the ancestor', 20_000);
      expect(reached(h, 'sync-q')!.content.map((b) => b.text ?? '').join('')).toContain('the sync answer');
    } finally { await h.cleanup(); }
  }, 40_000);

  test("a sync spawn whose caller ends while it runs holds its result for that caller, as an async one does", async () => {
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, responseGenerator: (r) => (r.model === 'mock-slow' ? 'the held sync answer ' + 'x'.repeat(400) : 'ok') }, {}, [caller]);
    try {
      const pending = h.callAs('caller', 'spawn', { name: 'sync-h', systemPrompt: 'p', task: 'take your time', model: 'mock-slow', sync: true });
      await h.until(() => h.recordOf('sync-h') !== undefined && !h.recordOf('sync-h')!.ended, 'the run is registered');
      const run = h.recordOf('sync-h')!.name;
      h.framework.stopAgent('caller', { by: 'test' });
      await pending;
      const held = () => h.framework.listHeldMail({ to: 'caller' }).filter((m) => JSON.stringify(m.content).includes("[Subagent 'sync-h' returned]"));
      await h.until(() => held().length > 0, 'the result is held for the ended caller');
      expect(held()[0]!.from.agent).toBe(run);
    } finally { await h.cleanup(); }
  }, 40_000);

  test("a retry after its run was adopted registers under the adopter, not under the launcher's nearest live ancestor", async () => {
    let adopted = false;
    let h: Awaited<ReturnType<typeof harness>> | undefined;
    h = await harness({
      streamChunkDelayMs: 20, streamChunkSize: 10,
      responseGenerator: (r) => {
        if (r.model === 'mock-slow') return 'x'.repeat(3_000);
        if (r.model !== 'mock-flaky') return 'ok';
        if (!adopted) {
          adopted = true;
          h!.framework.stopAgent(h!.recordOf('kept-m')!.name, { by: 'test' });
          h!.framework.reparentAgent(h!.recordOf('kept-c')!.name, 'parent', { by: 'parent' });
          throw new Error('the provider is overloaded');
        }
        return 'the second try';
      },
    }, { maxConcurrent: 3, maxRetries: 1 });
    try {
      expect((await h.call('spawn', { name: 'kept-a', systemPrompt: 'p', task: 'hold', model: 'mock-slow' })).success).toBe(true);
      await h.until(() => h!.recordOf('kept-a') !== undefined && !h!.recordOf('kept-a')!.ended, 'A runs');
      const a = h.recordOf('kept-a')!.name;
      expect((await h.callAs(a, 'spawn', { name: 'kept-m', systemPrompt: 'p', task: 'hold', model: 'mock-slow' })).success).toBe(true);
      await h.until(() => h!.recordOf('kept-m') !== undefined && !h!.recordOf('kept-m')!.ended, 'M runs');
      const m = h.recordOf('kept-m')!.name;
      expect((await h.callAs(m, 'spawn', { name: 'kept-c', systemPrompt: 'p', task: 'answer', model: 'mock-flaky' })).success).toBe(true);
      const attempts = () => h!.records().filter((r) => (r.metadata as { subagent: string }).subagent === 'kept-c');
      await h.until(() => attempts().length === 2, 'the retry registers', 20_000);
      expect(adopted).toBe(true);
      const [first, retry] = attempts().sort((x, y) => x.createdAt - y.createdAt);
      expect(first!.relationships.spawnedBy).toBe('parent');
      expect(retry!.relationships.spawnedBy).toBe('parent');
    } finally { await h.cleanup(); }
  }, 40_000);

  test("a launch queued for a slot, whose caller ended while it waited, runs under the caller's nearest live ancestor and returns to it", async () => {
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, responseGenerator: (r) => (r.model === 'mock-slow' ? 'x'.repeat(600) : 'the queued answer') }, { maxConcurrent: 1 }, [caller]);
    try {
      const busy = await h.call('spawn', { name: 'busy-2', systemPrompt: 'p', task: 'take your time', model: 'mock-slow' });
      expect(busy.success).toBe(true);
      await h.until(() => h.recordOf('busy-2') !== undefined && !h.recordOf('busy-2')!.ended, 'the slot is taken');
      const queued = await h.callAs('caller', 'spawn', { name: 'queued-2', systemPrompt: 'p', task: 'answer' });
      expect(queued.success).toBe(true);
      expect(h.subagent.getConcurrencyStatus().queued).toBe(1);
      h.framework.stopAgent('caller', { by: 'test' });
      await h.until(() => h.recordOf('queued-2')?.ended !== undefined, 'the queued run registers and ends', 20_000);
      const run = h.recordOf('queued-2')!;
      expect(run.ended!.reason).toBe('completed');
      expect(run.relationships.spawnedBy).toBe('parent');
      expect(run.relationships.resultTo).toEqual({ to: 'parent', as: 'message' });
      await h.until(() => reached(h, 'queued-2') !== undefined, 'its result reaches the ancestor');
      expect(reached(h, 'queued-2')!.content.map((b) => b.text ?? '').join('')).toContain('the queued answer');
    } finally { await h.cleanup(); }
  }, 40_000);

  test("a fork queued for a slot, whose caller ended while it waited, runs under the caller's nearest live ancestor and returns to it", async () => {
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, responseGenerator: (r) => (r.model === 'mock-slow' ? 'x'.repeat(600) : 'the forked answer') }, { maxConcurrent: 1 }, [caller]);
    try {
      expect((await h.call('spawn', { name: 'busy-4', systemPrompt: 'p', task: 'take your time', model: 'mock-slow' })).success).toBe(true);
      await h.until(() => h.recordOf('busy-4') !== undefined && !h.recordOf('busy-4')!.ended, 'the slot is taken');
      const cm = h.framework.getAgent('caller')!.getContextManager();
      cm.addMessage('user', [{ type: 'text', text: 'please look into it' }]);
      cm.addMessage('caller', [{ type: 'tool_use', id: 'toolu_qf', name: 'subagent--fork', input: { name: 'queued-fork', task: 'look' } }] as never);
      expect((await h.callAs('caller', 'fork', { name: 'queued-fork', task: 'look' }, 'toolu_qf')).success).toBe(true);
      expect(h.subagent.getConcurrencyStatus().queued).toBe(1);
      h.framework.stopAgent('caller', { by: 'test' });
      await h.until(() => reached(h, 'queued-fork') !== undefined, 'its result reaches the ancestor', 20_000);
      expect(reached(h, 'queued-fork')!.content.map((b) => b.text ?? '').join('')).toContain('the forked answer');
      expect(h.recordOf('queued-fork')!.relationships.spawnedBy).toBe('parent');
    } finally { await h.cleanup(); }
  }, 40_000);

  test("a queued launch whose caller ended and which then fails tells the primary whose run it was", async () => {
    const h = await harness({
      streamChunkDelayMs: 20, streamChunkSize: 10,
      responseGenerator: (r) => {
        if (r.model === 'mock-slow') return 'x'.repeat(600);
        if (r.model === 'mock-refused') throw new Error('the request was refused');
        return 'ok';
      },
    }, { maxConcurrent: 1, maxRetries: 0 }, [caller]);
    try {
      expect((await h.call('spawn', { name: 'busy-3', systemPrompt: 'p', task: 'take your time', model: 'mock-slow' })).success).toBe(true);
      await h.until(() => h.recordOf('busy-3') !== undefined && !h.recordOf('busy-3')!.ended, 'the slot is taken');
      expect((await h.callAs('caller', 'spawn', { name: 'queued-3', systemPrompt: 'p', task: 'answer', model: 'mock-refused' })).success).toBe(true);
      expect(h.subagent.getConcurrencyStatus().queued).toBe(1);
      h.framework.stopAgent('caller', { by: 'test' });
      const told = () => h.parentMessages().find((m) => m.content.some((b) => b.text?.includes("[Subagent 'queued-3' failed, for 'caller', which has ended]")));
      await h.until(() => told() !== undefined, 'the failure reaches the primary', 20_000);
      expect(told()!.content.map((b) => b.text ?? '').join('')).toContain('the request was refused');
      expect(h.recordOf('queued-3')!.relationships.spawnedBy).toBe('parent');
    } finally { await h.cleanup(); }
  }, 40_000);

  test("a retry after the caller ended registers under the caller's nearest live ancestor and returns to it", async () => {
    let calls = 0;
    let atFirst: (() => void) | undefined;
    const h = await harness({
      responseGenerator: (r) => {
        if (r.model !== 'mock-flaky') return 'ok';
        calls++;
        if (calls === 1) { atFirst?.(); throw new Error('the provider is overloaded'); }
        return 'the second try';
      },
    }, { maxRetries: 1 }, [caller]);
    try {
      atFirst = () => { h.framework.stopAgent('caller', { by: 'test' }); };
      const accepted = await h.callAs('caller', 'spawn', { name: 'retried-1', systemPrompt: 'p', task: 'answer', model: 'mock-flaky' });
      expect(accepted.success).toBe(true);
      await h.until(() => reached(h, 'retried-1') !== undefined, 'the retry returns to the ancestor', 25_000);
      const retry = h.framework.getAgentRecord(reached(h, 'retried-1')!.participant)!;
      expect((retry.metadata as { subagent: string }).subagent).toBe('retried-1');
      expect(retry.relationships.spawnedBy).toBe('parent');
      expect(reached(h, 'retried-1')!.content.map((b) => b.text ?? '').join('')).toContain('the second try');
    } finally { await h.cleanup(); }
  }, 40_000);
});

describe('a resume that ends before its run starts', () => {
  type Internals = {
    registry: { register(spec: ReturnType<typeof workerSpec>): unknown; end(name: string, reason: string, by?: string): unknown };
  };
  const failedRecord = (h: Awaited<ReturnType<typeof harness>>, agent: string, subagent: string) => {
    const internals = h.framework as unknown as Internals;
    internals.registry.register(workerSpec(agent, { spawnedBy: 'parent', metadata: { subagent, task: 'again', launch: { kind: 'spawn', model: 'mock', systemPrompt: 'p', maxTokens: 64, allowedTools: 'all', strategy: {} } } }));
    internals.registry.end(agent, 'failed', 'test');
  };
  const said = (h: Awaited<ReturnType<typeof harness>>, text: string) => h.parentMessages().some((m) => m.content.some((b) => b.text?.includes(text)));

  const bob = { name: 'bob', model: 'mock', systemPrompt: 'bob prompt', maxTokens: 256 };
  const failedRecordFor = (h: Awaited<ReturnType<typeof harness>>, agent: string, subagent: string, to: string) => {
    const internals = h.framework as unknown as Internals;
    internals.registry.register(workerSpec(agent, { spawnedBy: 'parent', resultTo: { to, as: 'message' }, metadata: { subagent, task: 'again', launch: { kind: 'spawn', model: 'mock', systemPrompt: 'p', maxTokens: 64, allowedTools: 'all', strategy: {} } } }));
    internals.registry.end(agent, 'failed', 'test');
  };
  const mailTo = (h: Awaited<ReturnType<typeof harness>>) => {
    const seen: Array<{ from: string; to: string; kind: string }> = [];
    h.framework.onTrace((e) => {
      const event = e as unknown as { type: string; from: string; to: string; kind: string };
      if (event.type === 'dendrite:mail-delivered') seen.push({ from: event.from, to: event.to, kind: event.kind });
    });
    return seen;
  };

  test("a resume stopped while it waits for a slot tells its record's route, from the record's agent", async () => {
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, responseGenerator: (r) => (r.model === 'mock-slow' ? 'x'.repeat(1_200) : 'ok') }, { maxConcurrent: 1 }, [bob]);
    try {
      const delivered = mailTo(h);
      expect((await h.call('spawn', { name: 'busy-r', systemPrompt: 'p', task: 'take your time', model: 'mock-slow' })).success).toBe(true);
      await h.until(() => h.recordOf('busy-r') !== undefined && !h.recordOf('busy-r')!.ended, 'the slot is taken');
      failedRecordFor(h, 'spawn-q-bob-1', 'q-bob', 'bob');
      expect((await h.call('resume', { name: 'q-bob' })).success).toBe(true);
      await h.until(() => h.subagent.getConcurrencyStatus().queued === 1, 'the resume waits for the slot');
      expect((await h.call('stop', { name: 'q-bob' })).success).toBe(true);
      await h.until(() => delivered.some((m) => m.from === 'spawn-q-bob-1'), "the stop reaches the record's route");
      expect(delivered.filter((m) => m.from === 'spawn-q-bob-1')).toEqual([{ from: 'spawn-q-bob-1', to: 'bob', kind: 'result' }]);
      expect(said(h, "[Subagent 'q-bob' returned]")).toBe(true);
      await h.call('stop', { name: 'busy-r' });
    } finally { await h.cleanup(); }
  }, 30_000);

  test("a resume of a run whose route is a live agent's awaiting call says its result goes to that agent, and it does", async () => {
    const h = await harness({ responseGenerator: () => 'the resumed answer' }, {}, [bob]);
    try {
      const delivered = mailTo(h);
      const internals = h.framework as unknown as Internals;
      internals.registry.register(workerSpec('spawn-t-bob-1', { spawnedBy: 'parent', resultTo: { to: 'bob', as: 'tool-result' }, metadata: { subagent: 't-bob', task: 'again', launch: { kind: 'spawn', model: 'mock', systemPrompt: 'p', maxTokens: 64, allowedTools: 'all', strategy: {} } } }));
      internals.registry.end('spawn-t-bob-1', 'failed', 'test');
      const resumed = await h.call('resume', { name: 't-bob' });
      expect(resumed.success).toBe(true);
      expect((resumed.data as { resultTo: string; note: string }).resultTo).toBe('bob');
      expect((resumed.data as { note: string }).note).toContain('its result goes to bob');
      await h.until(() => delivered.some((m) => m.from === 'spawn-t-bob-1'), 'the result reaches bob');
      expect(delivered.filter((m) => m.from === 'spawn-t-bob-1').map((m) => m.to)).toEqual(['bob']);
    } finally { await h.cleanup(); }
  }, 30_000);

  test("a resume whose context fails to reopen tells its record's route that it failed, from the record's agent", async () => {
    const h = await harness({}, {}, [bob]);
    try {
      const delivered = mailTo(h);
      failedRecordFor(h, 'spawn-r-bob-1', 'r-bob', 'bob');
      h.framework.resumeAgent = (async () => { throw new Error("the store can't reopen its context"); }) as typeof h.framework.resumeAgent;
      expect((await h.call('resume', { name: 'r-bob' })).success).toBe(true);
      await h.until(() => delivered.some((m) => m.from === 'spawn-r-bob-1'), "the failure reaches the record's route");
      expect(delivered.filter((m) => m.from === 'spawn-r-bob-1')).toEqual([{ from: 'spawn-r-bob-1', to: 'bob', kind: 'result' }]);
      expect(said(h, "[Subagent 'r-bob' failed]")).toBe(true);
    } finally { await h.cleanup(); }
  }, 30_000);

  test('only a run a restart cut off, a time limit stopped, or that failed is resumed; a stop, a completion or any other end is refused with its reason', async () => {
    const h = await harness();
    try {
      const internals = h.framework as unknown as Internals;
      const endAs = (n: number, reason: string, by?: string) => {
        internals.registry.register(workerSpec(`spawn-ends-${n}`, { spawnedBy: 'parent', metadata: { subagent: `ends-${n}`, task: 'again', launch: { kind: 'spawn', model: 'mock', systemPrompt: 'p', maxTokens: 64, allowedTools: 'all', strategy: {} } } }));
        internals.registry.end(`spawn-ends-${n}`, reason, by);
        return `ends-${n}`;
      };
      const stopped = await h.call('resume', { name: endAs(1, 'stopped', 'bob') });
      expect(stopped.success).toBe(false);
      expect(stopped.error).toContain("'ends-1' was stopped by bob, and a resume would undo that stop");
      expect(stopped.error).toContain('Spawn or fork it again');
      const completed = await h.call('resume', { name: endAs(2, 'completed') });
      expect(completed.success).toBe(false);
      expect(completed.error).toContain("'ends-2' completed and returned its result");
      const other = await h.call('resume', { name: endAs(3, 'parent-ended') });
      expect(other.success).toBe(false);
      expect(other.error).toContain("'ends-3' ended (parent-ended)");
      for (const [n, reason] of [[4, 'host-restart'], [5, 'deadline'], [6, 'failed']] as const) {
        const resumed = await h.call('resume', { name: endAs(n, reason) });
        expect(resumed.success).toBe(true);
      }
      const incarnation = (n: number) => h.framework.getAgentRecord(`spawn-ends-${n}`)!.incarnation;
      await h.until(() => [4, 5, 6].every((n) => incarnation(n) === incarnation(1) + 1), 'the three resumes run as new incarnations');
      for (const n of [1, 2, 3]) {
        expect(h.framework.getAgentRecord(`spawn-ends-${n}`)!.ended).toBeDefined();
        expect(incarnation(n)).toBe(incarnation(4) - 1);
      }
    } finally { await h.cleanup(); }
  }, 30_000);

  test('a resume stopped while it waits for a slot ends as a stop, not a failure', async () => {
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, responseGenerator: (r) => (r.model === 'mock-slow' ? 'x'.repeat(1_200) : 'ok') }, { maxConcurrent: 1 });
    try {
      const busy = await h.call('spawn', { name: 'busy-1', systemPrompt: 'p', task: 'take your time', model: 'mock-slow' });
      expect(busy.success).toBe(true);
      await h.until(() => h.recordOf('busy-1') !== undefined && !h.recordOf('busy-1')!.ended, 'the slot is taken');
      failedRecord(h, 'spawn-queued-1', 'queued-1');
      const resumed = await h.call('resume', { name: 'queued-1' });
      expect(resumed.success).toBe(true);
      await h.until(() => h.subagent.getConcurrencyStatus().queued === 1, 'the resume waits for the slot');
      const stopped = await h.call('stop', { name: 'queued-1', reason: 'not now' });
      expect(stopped.success).toBe(true);
      await h.until(() => said(h, "[Subagent 'queued-1'"), "the resume's end reaches the parent");
      expect(said(h, "[Subagent 'queued-1' returned]")).toBe(true);
      expect(said(h, '[Stopped by parent: not now] (no output: it was still waiting for a concurrency slot, and never started)')).toBe(true);
      expect(said(h, "[Subagent 'queued-1' failed]")).toBe(false);
      expect(h.subagent.getConcurrencyStatus().queued).toBe(0);
      await h.call('stop', { name: 'busy-1' });
    } finally { await h.cleanup(); }
  }, 30_000);

  test('a resume waiting for a slot is stopped by its framework name as by its name', async () => {
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, responseGenerator: (r) => (r.model === 'mock-slow' ? 'x'.repeat(1_200) : 'ok') }, { maxConcurrent: 1 });
    try {
      const busy = await h.call('spawn', { name: 'busy-2', systemPrompt: 'p', task: 'take your time', model: 'mock-slow' });
      expect(busy.success).toBe(true);
      await h.until(() => h.recordOf('busy-2') !== undefined && !h.recordOf('busy-2')!.ended, 'the slot is taken');
      failedRecord(h, 'spawn-queued-2', 'queued-2');
      expect((await h.call('resume', { name: 'queued-2' })).success).toBe(true);
      await h.until(() => h.subagent.getConcurrencyStatus().queued === 1, 'the resume waits for the slot');
      const stopped = await h.call('stop', { name: 'spawn-queued-2', reason: 'not now' });
      expect(stopped.success).toBe(true);
      await h.until(() => h.subagent.getConcurrencyStatus().queued === 0, 'the resume leaves the queue');
      await h.call('stop', { name: 'busy-2' });
    } finally { await h.cleanup(); }
  }, 30_000);

  test('a resume whose context fails to reopen is reported failed and leaves no run listed as running', async () => {
    const h = await harness();
    try {
      failedRecord(h, 'spawn-reopen-1', 'reopen-1');
      h.framework.resumeAgent = (async () => { throw new Error("the store can't reopen its context"); }) as typeof h.framework.resumeAgent;
      const resumed = await h.call('resume', { name: 'reopen-1' });
      expect(resumed.success).toBe(true);
      await h.until(() => said(h, "[Subagent 'reopen-1' failed]"), 'the failure reaches the parent');
      const entries = (h.subagent as unknown as { activeSubagents: Map<string, { name: string; status: string }> }).activeSubagents;
      expect([...entries.values()].filter((e) => e.name === 'reopen-1' && e.status === 'running')).toEqual([]);
      expect(h.subagent.getConcurrencyStatus().active).toBe(0);
    } finally { await h.cleanup(); }
  }, 30_000);
});

describe("a resumed run's launch, and a registry stop of a live run", () => {
  type Internals = {
    registry: { register(spec: ReturnType<typeof workerSpec>): unknown; end(name: string, reason: string, by?: string): unknown };
  };

  test("a resumed run runs with its launch's tools, stream budget and prose routing", async () => {
    let seen: { readFile: boolean; writeFile: boolean; maxStreamTokens: number; proseRouting: string } | undefined;
    let h: Awaited<ReturnType<typeof harness>> | undefined;
    h = await harness({
      responseGenerator: (r) => {
        if (r.model === 'mock-launched') {
          const agent = h!.framework.getAgent('spawn-launched-1')!;
          seen = { readFile: agent.canUseTool('read_file'), writeFile: agent.canUseTool('write_file'), maxStreamTokens: agent.maxStreamTokens, proseRouting: agent.proseRouting };
        }
        return 'ok';
      },
    });
    try {
      const internals = h.framework as unknown as Internals;
      internals.registry.register(workerSpec('spawn-launched-1', { spawnedBy: 'parent', metadata: { subagent: 'launched-1', task: 'again', launch: { kind: 'spawn', model: 'mock-launched', systemPrompt: 'p', maxTokens: 64, maxStreamTokens: 12_345, proseRouting: 'explicit', allowedTools: ['read_file', 'subagent--return'], strategy: {} } } }));
      internals.registry.end('spawn-launched-1', 'failed', 'test');
      const resumed = await h.call('resume', { name: 'launched-1' });
      expect(resumed.success).toBe(true);
      await h.until(() => seen !== undefined, "the resumed run's request");
      expect(seen).toEqual({ readFile: true, writeFile: false, maxStreamTokens: 12_345, proseRouting: 'explicit' });
    } finally { await h.cleanup(); }
  }, 30_000);

  test('a live spawn, fork or resume stopped through the registry, outside this module, ends as a stop that names who stopped it, not as a failure', async () => {
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, responseGenerator: (r) => (r.model === 'mock-slow' ? 'x'.repeat(1_200) : 'ok') });
    try {
      const result = (name: string) => h.parentMessages().find((m) => m.content.some((b) => b.text?.includes(`[Subagent '${name}' `)));
      const stopLive = async (name: string) => {
        await h.until(() => h.recordOf(name) !== undefined && !h.recordOf(name)!.ended, `${name} is running`);
        h.framework.stopAgent(h.recordOf(name)!.name, { by: 'operator' });
        await h.until(() => result(name) !== undefined, `${name}'s end reaches the parent`);
        const text = result(name)!.content.map((b) => b.text ?? '').join('');
        expect(text).toContain(`[Subagent '${name}' returned]`);
        expect(text).toContain('[Stopped by operator]');
      };

      expect((await h.call('spawn', { name: 'reg-spawn', systemPrompt: 'p', task: 'take your time', model: 'mock-slow' })).success).toBe(true);
      await stopLive('reg-spawn');

      const cm = h.framework.getAgent('parent')!.getContextManager();
      cm.addMessage('user', [{ type: 'text', text: 'please look into it' }]);
      cm.addMessage('parent', [{ type: 'tool_use', id: 'toolu_reg', name: 'subagent--fork', input: { name: 'reg-fork', task: 'look slowly' } }] as never);
      expect((await h.call('fork', { name: 'reg-fork', task: 'look slowly', model: 'mock-slow' }, 'toolu_reg')).success).toBe(true);
      await stopLive('reg-fork');

      const internals = h.framework as unknown as Internals;
      internals.registry.register(workerSpec('spawn-reg-resume-1', { spawnedBy: 'parent', resultTo: { to: 'parent', as: 'message' }, metadata: { subagent: 'reg-resume', task: 'again', launch: { kind: 'spawn', model: 'mock-slow', systemPrompt: 'p', maxTokens: 64, allowedTools: 'all', strategy: {} } } }));
      internals.registry.end('spawn-reg-resume-1', 'failed', 'test');
      expect((await h.call('resume', { name: 'reg-resume' })).success).toBe(true);
      await stopLive('reg-resume');
    } finally { await h.cleanup(); }
  }, 40_000);
});

describe("a resumed run's parent", () => {
  type Internals = {
    registry: { register(spec: ReturnType<typeof workerSpec>): unknown; end(name: string, reason: string, by?: string): unknown };
  };
  const slowLaunch = { kind: 'spawn', model: 'mock-slow', systemPrompt: 'p', maxTokens: 64, allowedTools: 'all', strategy: {} };
  const slow = { streamChunkDelayMs: 20, streamChunkSize: 10, responseGenerator: (r: { model: string }) => (r.model === 'mock-slow' ? 'x'.repeat(3_000) : 'done quickly') };
  const names = (listed: { data?: unknown }) => (listed.data as { subagents: Array<{ name: string }> }).subagents.map((s) => s.name);

  test("a run resumed after its spawner ended becomes its resumer's: the resumer lists it and stops it", async () => {
    const h = await harness(slow);
    try {
      const internals = h.framework as unknown as Internals;
      internals.registry.register(workerSpec('spawn-mid-1', { spawnedBy: 'parent', metadata: { subagent: 'mid', task: 'mid' } }));
      internals.registry.register(workerSpec('spawn-left-1', { spawnedBy: 'spawn-mid-1', metadata: { subagent: 'left', task: 'again', launch: slowLaunch } }));
      internals.registry.end('spawn-left-1', 'failed', 'test');
      internals.registry.end('spawn-mid-1', 'stopped', 'test');
      expect((await h.call('resume', { name: 'left' })).success).toBe(true);
      await h.until(() => h.recordOf('left') !== undefined && !h.recordOf('left')!.ended, 'the resumed run is registered');
      expect(h.recordOf('left')!.relationships.spawnedBy).toBe('parent');
      expect(names(await h.call('list', {}))).toContain('left');
      expect((await h.call('stop', { name: 'left' })).success).toBe(true);
      await h.until(() => h.recordOf('left')!.ended !== undefined, 'the resumed run ends');
      expect(h.recordOf('left')!.ended!.reason).toBe('stopped');
    } finally { await h.cleanup(); }
  }, 30_000);

  test("a resumed run is stopped through its own parent, not through another launch's link left on its display name", async () => {
    const h = await harness(slow, { maxConcurrent: 4 });
    try {
      for (const n of ['link-p', 'link-q']) expect((await h.call('spawn', { name: n, systemPrompt: 'p', task: 'hold', model: 'mock-slow' })).success).toBe(true);
      await h.until(() => ['link-p', 'link-q'].every((n) => h.recordOf(n) !== undefined && !h.recordOf(n)!.ended), 'P and Q run');
      const [p, q] = ['link-p', 'link-q'].map((n) => h.recordOf(n)!.name) as [string, string];
      expect((await h.callAs(p, 'spawn', { name: 'x', systemPrompt: 'p', task: 'quick', sync: true })).success).toBe(true);
      const internals = h.framework as unknown as Internals;
      internals.registry.register(workerSpec('spawn-x-of-q', { spawnedBy: q, metadata: { subagent: 'x', task: 'again', launch: slowLaunch } }));
      internals.registry.end('spawn-x-of-q', 'failed', 'test');
      expect((await h.call('resume', { name: 'spawn-x-of-q' })).success).toBe(true);
      await h.until(() => h.framework.getAgentRecord('spawn-x-of-q')!.ended === undefined, 'the resumed run is registered');

      expect((await h.call('stop', { name: 'link-p' })).success).toBe(true);
      expect(h.framework.getAgentRecord('spawn-x-of-q')!.ended).toBeUndefined();
      expect((await h.call('stop', { name: 'link-q' })).success).toBe(true);
      await h.until(() => h.framework.getAgentRecord('spawn-x-of-q')!.ended !== undefined || h.framework.getAgentRecord('spawn-x-of-q')!.orphaned !== undefined, "x is stopped, or left behind as Q's orphan");
      expect(h.framework.getAgentRecord('spawn-x-of-q')!.ended?.reason).toBe('stopped');
    } finally { await h.cleanup(); }
  }, 40_000);
});

describe("the host's stop and a live run's record", () => {
  test("a run the host's stop cuts off keeps its record live for the next boot, which ends it as a restart, and it can be resumed then", async () => {
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, defaultResponse: 'x'.repeat(1_200) });
    let next: AgentFramework | undefined;
    try {
      const running = await h.call('spawn', { name: 'slow-k', systemPrompt: 'p', task: 'take your time' });
      expect(running.success).toBe(true);
      await h.until(() => h.recordOf('slow-k') !== undefined && !h.recordOf('slow-k')!.ended, 'the run is registered');
      const before = h.recordOf('slow-k')!;

      await h.framework.stop();
      const subagent = new SubagentModule({ provider: 'mock', parentAgentName: 'parent', defaultModel: 'mock', maxRetries: 0 });
      next = await AgentFramework.create({
        storePath: h.storePath,
        membrane: new Membrane(new MockAdapter({ defaultResponse: 'resumed after the restart' }), { formatter: new NativeFormatter() }),
        agents: [{ name: 'parent', model: 'mock', systemPrompt: 'parent prompt', maxTokens: 256 }],
        modules: [subagent as unknown as Module],
      });
      subagent.setFramework(next);
      next.start();
      const after = next.getAgentRecord(before.name)!;
      expect(after.incarnation).toBe(before.incarnation);
      expect(after.ended?.reason).toBe('host-restart');
      const resumed = await subagent.handleToolCall({ id: 'resume-k', name: 'resume', input: { name: 'slow-k' }, callerAgentName: 'parent' } as unknown as ToolCall);
      expect(resumed.success).toBe(true);
      expect((resumed.data as { incarnation: number }).incarnation).toBe(before.incarnation + 1);
    } finally {
      await next?.stop().catch(() => {});
      await h.cleanup();
    }
  }, 30_000);
});

describe('what a run that ends without a result says, and to whom', () => {
  const caller = { name: 'caller', model: 'mock', systemPrompt: 'caller prompt', maxTokens: 256 };
  const bob = { name: 'bob', model: 'mock', systemPrompt: 'bob prompt', maxTokens: 256 };
  const heldFor = (h: Awaited<ReturnType<typeof harness>>, to: string, said: string) =>
    h.framework.listHeldMail({ to }).filter((m) => JSON.stringify(m.content).includes(said));

  test("a failed run whose caller has ended is held for that caller as mail from the run's own agent, not a line in the primary's window", async () => {
    let atRequest: (() => void) | undefined;
    const h = await harness({
      responseGenerator: (r) => {
        if (r.model !== 'mock-fail') return 'ok';
        atRequest?.();
        throw new Error('the provider is unavailable');
      },
    }, {}, [caller]);
    try {
      atRequest = () => { atRequest = undefined; h.framework.stopAgent('caller', { by: 'test' }); };
      const accepted = await h.callAs('caller', 'spawn', { name: 'failing-1', systemPrompt: 'p', task: 'try', model: 'mock-fail' });
      expect(accepted.success).toBe(true);
      await h.until(() => heldFor(h, 'caller', "[Subagent 'failing-1' failed]").length > 0, "the failure is held for the ended caller");
      const [mail] = heldFor(h, 'caller', "[Subagent 'failing-1' failed]");
      expect(mail!.from.agent).toBe(h.recordOf('failing-1')!.name);
      expect(h.parentMessages().some((m) => m.content.some((b) => b.text?.includes("[Subagent 'failing-1'")))).toBe(false);
    } finally { await h.cleanup(); }
  }, 30_000);

  test("a stopped run whose caller has ended is held for that caller as mail from the run's own agent, not a line in the primary's window", async () => {
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, responseGenerator: (r) => (r.model === 'mock-slow' ? 'x'.repeat(1_200) : 'ok') }, {}, [caller]);
    try {
      const accepted = await h.callAs('caller', 'spawn', { name: 'stopped-1', systemPrompt: 'p', task: 'take your time', model: 'mock-slow' });
      expect(accepted.success).toBe(true);
      await h.until(() => h.recordOf('stopped-1') !== undefined && !h.recordOf('stopped-1')!.ended, 'the run is registered');
      const run = h.recordOf('stopped-1')!;
      h.framework.stopAgent('caller', { by: 'test' });
      h.framework.stopAgent(run.name, { by: 'test' });
      await h.until(() => heldFor(h, 'caller', "[Subagent 'stopped-1' returned]").length > 0, 'the stop is held for the ended caller');
      const [mail] = heldFor(h, 'caller', "[Subagent 'stopped-1' returned]");
      expect(mail!.from.agent).toBe(run.name);
      expect(JSON.stringify(mail!.content)).toContain('Stopped');
      expect(h.parentMessages().some((m) => m.content.some((b) => b.text?.includes("[Subagent 'stopped-1'")))).toBe(false);
    } finally { await h.cleanup(); }
  }, 30_000);

  test("a run stopped with the stop tool says who stopped it and why in its stopped result", async () => {
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, responseGenerator: (r) => (r.model === 'mock-slow' ? 'x'.repeat(1_200) : 'ok') });
    try {
      const accepted = await h.call('spawn', { name: 'told-1', systemPrompt: 'p', task: 'take your time', model: 'mock-slow' });
      expect(accepted.success).toBe(true);
      await h.until(() => h.recordOf('told-1') !== undefined && !h.recordOf('told-1')!.ended, 'the run is registered');
      const stopped = await h.call('stop', { name: 'told-1', reason: 'the question was answered elsewhere' });
      expect(stopped.success).toBe(true);
      const result = () => h.parentMessages().find((m) => m.content.some((b) => b.text?.includes("[Subagent 'told-1' returned]")));
      await h.until(() => result() !== undefined, 'the stopped result reaches the parent');
      expect(result()!.content.map((b) => b.text ?? '').join('')).toContain('[Stopped by parent: the question was answered elsewhere]');
    } finally { await h.cleanup(); }
  }, 30_000);

  test("a result held for a caller that has ended is logged, and counted on its run in list", async () => {
    const logged = spyOn(console, 'error');
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, responseGenerator: (r) => (r.model === 'mock-slow' ? 'the held answer ' + 'x'.repeat(400) : 'ok') }, {}, [caller]);
    try {
      const accepted = await h.callAs('caller', 'spawn', { name: 'held-1', systemPrompt: 'p', task: 'take your time', model: 'mock-slow' });
      expect(accepted.success).toBe(true);
      await h.until(() => h.recordOf('held-1') !== undefined && !h.recordOf('held-1')!.ended, 'the run is registered');
      h.framework.stopAgent('caller', { by: 'test' });
      await h.until(() => heldFor(h, 'caller', "[Subagent 'held-1' returned]").length > 0, 'the result is held for the ended caller');
      const lines = logged.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("'held-1' returned, and its result is held as mail for 'caller', which has ended"))).toBe(true);
      const listed = await h.subagent.handleToolCall({ id: 'list-held', name: 'list', input: {} } as unknown as ToolCall);
      const row = (listed.data as { subagents: Array<{ name: string; held?: number }> }).subagents.find((s) => s.name === 'held-1')!;
      expect(row.held).toBe(1);
    } finally { logged.mockRestore(); await h.cleanup(); }
  }, 30_000);

  test("an orphan that finished before anyone adopted it is adopted for the result it holds for its ended caller: the result reaches the adopter under its name, and it stays ended; a stranger is refused", async () => {
    let adopterSaw = false;
    const h = await harness({
      streamChunkDelayMs: 20, streamChunkSize: 10,
      responseGenerator: (r) => {
        if (r.model === 'mock-slow') return 'the held answer ' + 'x'.repeat(400);
        if (JSON.stringify(r).includes('the held answer')) adopterSaw = true;
        return 'ok';
      },
    }, {}, [caller, bob]);
    try {
      const accepted = await h.callAs('caller', 'spawn', { name: 'held-2', systemPrompt: 'p', task: 'take your time', model: 'mock-slow' });
      expect(accepted.success).toBe(true);
      await h.until(() => h.recordOf('held-2') !== undefined && !h.recordOf('held-2')!.ended, 'the run is registered');
      const run = h.recordOf('held-2')!.name;
      h.framework.stopAgent('caller', { by: 'test' });
      await h.until(() => heldFor(h, 'caller', "[Subagent 'held-2' returned]").length > 0, 'the result is held for the ended caller');
      expect(h.framework.getAgentRecord(run)!.ended).toBeDefined();

      const stranger = await h.callAs('bob', 'adopt', { name: run });
      expect(stranger.success).toBe(false);
      expect(stranger.error).toContain('not to you');
      expect(heldFor(h, 'caller', "[Subagent 'held-2' returned]").length).toBe(1);

      const adopted = await h.call('adopt', { name: run });
      expect(adopted.success).toBe(true);
      expect((adopted.data as { collected: number }).collected).toBe(1);
      const arrived = () => h.parentMessages().find((m) => m.content.some((b) => b.text?.includes("[Subagent 'held-2' returned")));
      await h.until(() => arrived() !== undefined, 'the held result reaches the adopter');
      expect(arrived()!.participant).toBe(run);
      await h.until(() => adopterSaw, 'the adopter is woken for it');
      const after = h.framework.getAgentRecord(run)!;
      expect(after.ended?.reason).toBe('completed');
      expect(after.incarnation).toBe(1);
      expect(heldFor(h, 'caller', "[Subagent 'held-2' returned]")).toEqual([]);
    } finally { await h.cleanup(); }
  }, 30_000);

  test('an orphan that ended is reached by its framework name however many runs have ended since', async () => {
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, responseGenerator: (r) => (r.model === 'mock-slow' ? 'the old answer ' + 'x'.repeat(400) : 'ok') }, {}, [caller]);
    try {
      expect((await h.callAs('caller', 'spawn', { name: 'old-1', systemPrompt: 'p', task: 'take your time', model: 'mock-slow' })).success).toBe(true);
      await h.until(() => h.recordOf('old-1') !== undefined && !h.recordOf('old-1')!.ended, 'the run is registered');
      const run = h.recordOf('old-1')!.name;
      h.framework.stopAgent('caller', { by: 'test' });
      await h.until(() => heldFor(h, 'caller', "[Subagent 'old-1' returned]").length > 0, 'the result is held for the ended caller');
      const internals = h.framework as unknown as { registry: { register(spec: ReturnType<typeof workerSpec>): unknown } };
      for (let i = 0; i < 260; i++) {
        internals.registry.register(workerSpec(`later-${i}`, { spawnedBy: 'parent', metadata: { subagent: `later-${i}`, task: 'later' } }));
        h.framework.stopAgent(`later-${i}`, { by: 'test' });
      }
      expect(h.framework.listAgents({ includeEnded: true }).some((r) => r.name === run)).toBe(false);
      const adopted = await h.call('adopt', { name: run });
      expect(adopted.success).toBe(true);
      expect((adopted.data as { collected: number }).collected).toBe(1);
    } finally { await h.cleanup(); }
  }, 30_000);

  test('an orphan that ended and holds nothing for a recipient that has gone is not adopted, and the refusal says so', async () => {
    const h = await harness();
    try {
      const internals = h.framework as unknown as { registry: { register(spec: ReturnType<typeof workerSpec>): unknown } };
      internals.registry.register(workerSpec('mid', { spawnedBy: 'parent', metadata: { subagent: 'mid', task: 'middle' } }));
      internals.registry.register(workerSpec('spawn-empty-1', { spawnedBy: 'mid', metadata: { subagent: 'empty', task: 'nothing to say' } }));
      h.framework.stopAgent('mid', { by: 'test' });
      await h.until(() => h.framework.getAgentRecord('spawn-empty-1')?.orphaned !== undefined, 'it is orphaned');
      h.framework.stopAgent('spawn-empty-1', { by: 'test' });
      const refused = await h.call('adopt', { name: 'empty' });
      expect(refused.success).toBe(false);
      expect(refused.error).toContain("'empty' has ended, and holds nothing for a recipient that has gone");
      expect(h.framework.getAgentRecord('spawn-empty-1')!.relationships.spawnedBy).toBe('mid');
    } finally { await h.cleanup(); }
  }, 30_000);

  test("a resumed run's failure goes where its record's route goes, as its result would, not to whoever resumed it", async () => {
    const h = await harness({ responseGenerator: (r) => { if (r.model === 'mock-fail') throw new Error('the provider is unavailable'); return 'ok'; } }, {}, [bob]);
    try {
      const internals = h.framework as unknown as { registry: { register(spec: ReturnType<typeof workerSpec>): unknown; end(name: string, reason: string, by?: string): unknown } };
      internals.registry.register(workerSpec('spawn-for-bob-1', { spawnedBy: 'parent', resultTo: { to: 'bob', as: 'message' }, metadata: { subagent: 'for-bob', task: 'for bob', launch: { kind: 'spawn', model: 'mock-fail', systemPrompt: 'p', maxTokens: 64, allowedTools: 'all', strategy: {} } } }));
      internals.registry.end('spawn-for-bob-1', 'failed', 'test');
      const delivered: Array<{ from: string; to: string; kind: string }> = [];
      h.framework.onTrace((e) => {
        const event = e as unknown as { type: string; from: string; to: string; kind: string };
        if (event.type === 'dendrite:mail-delivered') delivered.push({ from: event.from, to: event.to, kind: event.kind });
      });
      const resumed = await h.call('resume', { name: 'for-bob' });
      expect(resumed.success).toBe(true);
      expect((resumed.data as { resultTo: string }).resultTo).toBe('bob');
      await h.until(() => delivered.some((m) => m.from === 'spawn-for-bob-1'), 'the failure is delivered');
      expect(delivered.filter((m) => m.from === 'spawn-for-bob-1')).toEqual([{ from: 'spawn-for-bob-1', to: 'bob', kind: 'result' }]);
      expect(h.parentMessages().some((m) => m.metadata?.kind === 'agent-result' && m.content.some((b) => b.text?.includes("[Subagent 'for-bob' failed]")))).toBe(true);
      expect(h.parentMessages().filter((m) => m.metadata?.kind !== 'agent-result' && m.content.some((b) => b.text?.includes("[Subagent 'for-bob'")))).toEqual([]);
    } finally { await h.cleanup(); }
  }, 30_000);

  test("a sync run moved to the background, whose caller ended and which the primary then adopted, returns to its adopter", async () => {
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, responseGenerator: (r) => (r.model === 'mock-slow' ? 'the adopted answer ' + 'x'.repeat(1_200) : 'ok') }, {}, [caller]);
    try {
      const moved = await h.callAs('caller', 'spawn', { name: 'moved-1', systemPrompt: 'p', task: 'take your time', model: 'mock-slow', sync: true, timeoutMs: 500 });
      expect(moved.success).toBe(true);
      expect(String(moved.data)).toContain('moved to background');
      const run = h.recordOf('moved-1')!;
      expect(run.relationships.resultTo).toEqual({ to: 'caller', as: 'tool-result' });
      h.framework.stopAgent('caller', { by: 'test' });
      await h.until(() => h.recordOf('moved-1')?.orphaned !== undefined, 'the run is orphaned');
      const adopted = await h.call('adopt', { name: 'moved-1' });
      expect(adopted.success).toBe(true);
      await h.until(() => h.parentMessages().some((m) => m.content.some((b) => b.text?.includes("[Subagent 'moved-1' returned, for 'caller', which has ended]"))), 'the result reaches the adopter, saying whose run it was', 20_000);
      expect(h.parentMessages().find((m) => m.content.some((b) => b.text?.includes("[Subagent 'moved-1' returned, for 'caller', which has ended]")))!.participant).toBe(run.name);
      expect(h.framework.listHeldMail({ to: 'caller' }).some((m) => JSON.stringify(m.content).includes("[Subagent 'moved-1'"))).toBe(false);
    } finally { await h.cleanup(); }
  }, 30_000);
});
