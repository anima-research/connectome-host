/**
 * Subagents on the Dendrite registry (agent-framework#546): a spawn is a
 * worker and a fork a task-fork, each recorded with its spawner, its result
 * route and its launch; an async result returns by that route as attributed
 * mail; and five tools act on the registry — list, stop, message, adopt,
 * resume.
 */
import { describe, test, expect } from 'bun:test';
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
    adapter, subagent, framework, call, callAs, records, recordOf, parentMessages, until,
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

  test('resume runs an ended subagent again from the context it left, under the same name, and delivers its result as a message', async () => {
    const h = await harness({ responseGenerator: (r) => (JSON.stringify(r.messages).includes('all done') ? 'resumed and finished' : 'all done') });
    try {
      const first = await h.call('spawn', { name: 'again-1', systemPrompt: 'p', task: 'first pass', sync: true });
      expect(first.success).toBe(true);
      const ended = h.recordOf('again-1')!;
      expect(ended.ended?.reason).toBe('completed');
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

  test("under orientation 'none' a fork is handed its task alone — no launch description, no 'two parallel streams of you'", async () => {
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
 * agent it was offered to; a resume says where the result will go.
 */
describe('the lifecycle tools keep the module\'s rules', () => {
  const bob = { name: 'bob', model: 'mock', systemPrompt: 'bob prompt', maxTokens: 256 };
  type Registry = { registry: { register(spec: ReturnType<typeof workerSpec>): unknown } };
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

  test('an orphan is adopted only by an agent it was offered to, and the offer\'s framework name is accepted', async () => {
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

  test("a resume is refused when the launch's tools exceed the caller's rule, or the subagent is outside the caller's tree, or it is still running", async () => {
    const narrow = { name: 'narrow', model: 'mock', systemPrompt: 'narrow prompt', maxTokens: 256, allowedTools: ['subagent--resume', 'subagent--return'] };
    const h = await harness({ streamChunkDelayMs: 20, streamChunkSize: 10, defaultResponse: 'x'.repeat(1_200) }, {}, [bob, narrow]);
    try {
      const first = await h.call('spawn', { name: 'f1', systemPrompt: 'p', task: 'first pass', sync: true });
      expect(first.success).toBe(true);
      expect((h.recordOf('f1')!.metadata as { launch: { allowedTools: unknown } }).launch.allowedTools).toBe('all');

      const beyond = await h.callAs('narrow', 'resume', { name: 'f1' });
      expect(beyond.success).toBe(false);
      expect(beyond.error).toContain("'f1' is not in your tree");
      // Give narrow a launch of its own that it could not have made.
      const internals = h.framework as unknown as Registry;
      internals.registry.register(workerSpec('spawn-wide-1', { spawnedBy: 'narrow', metadata: { subagent: 'wide', task: 'wide work', launch: { kind: 'spawn', model: 'mock', systemPrompt: 'p', maxTokens: 64, allowedTools: ['subagent--resume', 'subagent--return', 'read_file'], strategy: {} } } }));
      h.framework.stopAgent('spawn-wide-1', { by: 'test' });
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
      h.framework.stopAgent('spawn-job-1', { by: 'test' });
      const resumed = await h.call('resume', { name: 'job' });
      expect(resumed.success).toBe(true);
      expect((resumed.data as { resultTo: string; note: string }).resultTo).toBe('bob');
      expect((resumed.data as { note: string }).note).toContain('its result goes to bob as a message');
    } finally { await h.cleanup(); }
  }, 30_000);
});
