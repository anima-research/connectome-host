/**
 * What the subagent tools tell the agent.
 *
 * - Every tool's inputs are checked against the types its schema declares
 *   before anything starts, and a refusal names every problem with what to
 *   give. Absent or null means not given, which a required input can't be.
 *   Before, a spawn without systemPrompt answered "spawned" and then failed
 *   on a TypeError, "false" turned the HUD on and ran a spawn sync, a
 *   timeoutMs of null ended an async run at once and one of "300" set no
 *   limit, and maxConcurrent {} held every spawn.
 * - A spawn's or fork's failure says whether anything ran, what ended it,
 *   and what to do, in the call's answer and in the async notice.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module, ToolCall } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { SubagentModule } from '../src/modules/subagent-module.js';

type Internal = {
  rateLimitCooldownMs: number;
  asyncHandles: Map<string, { promise: Promise<unknown> }>;
  activeSubagents: Map<string, { status: string; statusMessage?: string }>;
  returnedResults: Map<string, unknown>;
  callIdIndex: Map<string, string>;
  waitOrStop(ms: number, cancelled: Promise<never>): Promise<unknown>;
  effectiveConcurrent: number;
  configuredMaxConcurrent: number;
  throttled: boolean;
  ctx: { getState<T>(): T | undefined };
};
const internal = (s: SubagentModule) => s as unknown as Internal;

type Run = (agent: { name: string; maxTokens: number }, contextManager: unknown) => Promise<{ speech: string; toolCallsCount: number }>;

interface Harness {
  framework: AgentFramework;
  subagent: SubagentModule;
  runs(): number;
  cleanup(): Promise<void>;
}

/** `run` stands in for the framework's run of each ephemeral agent; left
 *  out, the framework runs it against the mock provider. */
async function harness(config: ConstructorParameters<typeof SubagentModule>[0] = {}, run?: Run): Promise<Harness> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sub-words-'));
  const membrane = new Membrane(new MockAdapter({ defaultResponse: 'ok' }), { formatter: new NativeFormatter() });
  const subagent = new SubagentModule({ parentAgentName: 'parent', defaultModel: 'mock', defaultMaxTokens: 256, ...config });
  internal(subagent).rateLimitCooldownMs = 0;
  const framework = await AgentFramework.create({
    storePath: join(tmpDir, 'store'),
    membrane,
    agents: [{ name: 'parent', model: 'mock', systemPrompt: 'parent', maxTokens: 256 }],
    modules: [subagent as unknown as Module],
  });
  let runs = 0;
  const fw = framework as unknown as { createEphemeralAgent: (c: unknown) => Promise<unknown>; runEphemeralToCompletion: Run };
  const create = fw.createEphemeralAgent.bind(fw);
  fw.createEphemeralAgent = (c) => { runs++; return create(c); };
  if (run) fw.runEphemeralToCompletion = run;
  subagent.setFramework(framework);
  framework.start();
  return {
    framework,
    subagent,
    runs: () => runs,
    cleanup: async () => {
      try { await framework.stop(); } catch { /* noop */ }
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

const call = (name: string, input: unknown, id = `t-${Math.random().toString(36).slice(2)}`): ToolCall =>
  ({ id, name, input: input as Record<string, unknown>, callerAgentName: 'parent' });
const spawn = (name: string, extra: Record<string, unknown> = {}) => call('spawn', { name, systemPrompt: 'sp', task: 't', ...extra });
const fork = (name: string, extra: Record<string, unknown> = {}) => call('fork', { name, task: 't', ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const end = performance.now() + ms;
  while (!done()) {
    if (performance.now() >= end) throw new Error(`not brought about within ${ms} ms`);
    await sleep(10);
  }
}

/** The settled outcome of an async subagent, from its handle. */
async function outcome(h: Harness, name: string): Promise<{ ok: boolean; text: string }> {
  const handle = internal(h.subagent).asyncHandles.get(name);
  if (!handle) throw new Error(`no async handle for ${name}`);
  return handle.promise.then(
    (r) => ({ ok: true, text: (r as { summary: string }).summary }),
    (e) => ({ ok: false, text: e instanceof Error ? e.message : String(e) }),
  );
}

const SPAWN_MISSING = {
  name: 'name is missing: give the subagent a short name',
  systemPrompt: "systemPrompt is missing: give the new subagent's system prompt (a spawn has no default; subagent--fork starts from your own prompt and conversation)",
  task: "task is missing: give the subagent's task",
};

describe('every input is checked against the type its schema declares', () => {
  test('a spawn or fork with no input names each input it needs, and nothing runs', async () => {
    const h = await harness();
    try {
      for (const input of [undefined, null, {}]) {
        expect((await h.subagent.handleToolCall(call('spawn', input))).error).toBe(
          `Nothing was started: ${SPAWN_MISSING.name}; ${SPAWN_MISSING.systemPrompt}; ${SPAWN_MISSING.task}.`,
        );
        expect((await h.subagent.handleToolCall(call('fork', input))).error).toBe(
          'Nothing was started: name is missing: give the fork a short name; task is missing: give the intention the fork pursues.',
        );
      }
      // A null counts as not given.
      expect((await h.subagent.handleToolCall(spawn('scout', { name: null, task: null }))).error).toBe(
        `Nothing was started: ${SPAWN_MISSING.name}; ${SPAWN_MISSING.task}.`,
      );
      expect(h.runs()).toBe(0);
      expect(internal(h.subagent).activeSubagents.size).toBe(0);
    } finally { await h.cleanup(); }
  });

  test('a whole input that isn\'t an object is refused as such by every tool, and nothing runs or changes', async () => {
    const h = await harness();
    try {
      const sub = internal(h.subagent);
      sub.callIdIndex.set('t-ret', 'scout');
      await h.subagent.handleToolCall(call('hud', { enabled: true }));
      for (const [tool, input, notDone] of [
        ['spawn', 'go', 'Nothing was started'], ['spawn', [], 'Nothing was started'], ['fork', 5, 'Nothing was started'],
        ['hud', 'off', "The fleet HUD wasn't changed"], ['concurrency', 3, "The concurrency limit wasn't changed"],
        ['peek', 'scout', 'Nothing was shown'], ['return', 'done', 'Nothing was returned'],
      ] as const) {
        expect((await h.subagent.handleToolCall(call(tool, input, 't-ret'))).error).toBe(
          `${notDone}: the input must be an object of named inputs, not ${JSON.stringify(input)}.`,
        );
      }
      expect(h.runs()).toBe(0);
      expect(sub.ctx.getState<{ hudEnabled?: unknown }>()?.hudEnabled).toBe(true);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ configured: 5, effective: 5 });
      expect(sub.returnedResults.has('scout')).toBe(false);
      // A tool the module doesn't have is answered as that, whatever its input.
      expect((await h.subagent.handleToolCall(call('constructor', 'x'))).error).toStartWith('There\'s no tool "subagent--constructor"');
    } finally { await h.cleanup(); }
  });

  test('peek, concurrency and return with no input at all answer as with no inputs', async () => {
    const h = await harness();
    try {
      const sub = internal(h.subagent);
      expect((await h.subagent.handleToolCall(call('peek', undefined))).data).toEqual({ message: 'None of your subagents is running now.' });
      expect((await h.subagent.handleToolCall(call('concurrency', undefined))).data).toMatchObject({ configured: 5, effective: 5 });
      sub.callIdIndex.set('t-ret', 'scout');
      expect(await h.subagent.handleToolCall(call('return', undefined, 't-ret'))).toEqual({ success: true, data: 'Result received.', endTurn: true });
      expect(sub.returnedResults.has('scout')).toBe(true);
      expect(sub.returnedResults.get('scout')).toBeUndefined();
    } finally { await h.cleanup(); }
  });

  test('a spawn names every input of another type at once, with its value', async () => {
    const h = await harness();
    try {
      const r = await h.subagent.handleToolCall(call('spawn', {
        name: 5, systemPrompt: 42, task: true, model: 5, maxTokens: '4096', tools: 'all', sync: 'false', timeoutMs: '300',
      }));
      expect(r.error).toBe(
        'Nothing was started: name must be text, not 5; systemPrompt must be text, not 42; task must be text, not true; ' +
        'model must be text, not 5; maxTokens must be a number, not "4096"; tools must be a list of names, not "all"; ' +
        'sync must be true or false, not "false"; timeoutMs must be a number, not "300".',
      );
      for (const [extra, problem] of [
        [{ tools: ['subagent--peek', 5] }, 'tools must be a list of names, not ["subagent--peek",5]'],
        [{ tools: {} }, 'tools must be a list of names, not {}'],
        [{ sync: 0 }, 'sync must be true or false, not 0'],
        [{ timeoutMs: 1e400 }, 'timeoutMs must be a number, not Infinity'],
      ] as const) {
        expect((await h.subagent.handleToolCall(spawn('scout', extra))).error).toBe(`Nothing was started: ${problem}.`);
      }
      expect((await h.subagent.handleToolCall(fork('scout', { systemPrompt: 42, sync: 'true' }))).error).toBe(
        'Nothing was started: systemPrompt must be text, not 42; sync must be true or false, not "true".',
      );
      expect(h.runs()).toBe(0);
    } finally { await h.cleanup(); }
  });

  test('a timeoutMs or maxTokens of null reads as not given', async () => {
    const maxTokens: number[] = [];
    const h = await harness({}, async (agent) => { maxTokens.push(agent.maxTokens); await sleep(50); return { speech: 'ok', toolCallsCount: 0 }; });
    try {
      // An async run with timeoutMs null has no limit: it runs to its end.
      await h.subagent.handleToolCall(spawn('scout', { timeoutMs: null, maxTokens: null }));
      expect(await outcome(h, 'scout')).toEqual({ ok: true, text: 'ok' });
      // maxTokens null gives the module's default, as leaving it out does.
      expect(maxTokens).toEqual([256]);
    } finally { await h.cleanup(); }
  });

  test('hud takes only true or false, and leaves the HUD as it was otherwise', async () => {
    const h = await harness();
    try {
      const enabled = () => internal(h.subagent).ctx.getState<{ hudEnabled?: unknown }>()?.hudEnabled;
      expect((await h.subagent.handleToolCall(call('hud', { enabled: true }))).success).toBe(true);
      for (const [input, problem] of [
        [{}, 'enabled is missing: give true to show the fleet status summary before each inference, or false to hide it'],
        [undefined, 'enabled is missing: give true to show the fleet status summary before each inference, or false to hide it'],
        [{ enabled: 'false' }, 'enabled must be true or false, not "false"'],
        [{ enabled: 0 }, 'enabled must be true or false, not 0'],
      ] as const) {
        expect((await h.subagent.handleToolCall(call('hud', input))).error).toBe(`The fleet HUD wasn't changed: ${problem}.`);
        expect(enabled()).toBe(true);
      }
    } finally { await h.cleanup(); }
  });

  test('concurrency takes a number, and leaves the limit as it was otherwise; null only views it', async () => {
    const h = await harness();
    try {
      for (const maxConcurrent of ['four', '3', {}, true, [3]]) {
        expect((await h.subagent.handleToolCall(call('concurrency', { maxConcurrent }))).error).toBe(
          `The concurrency limit wasn't changed: maxConcurrent must be a number, not ${JSON.stringify(maxConcurrent)}.`,
        );
        expect(h.subagent.getConcurrencyStatus()).toMatchObject({ configured: 5, effective: 5 });
      }
      expect((await h.subagent.handleToolCall(call('concurrency', { maxConcurrent: null }))).data).toMatchObject({ configured: 5, effective: 5 });
      expect((await h.subagent.handleToolCall(call('concurrency', { maxConcurrent: 3 }))).data).toMatchObject({ configured: 3, effective: 3 });
    } finally { await h.cleanup(); }
  });

  test('peek and return refuse an input of another type; return without a result keeps its fallback', async () => {
    const h = await harness();
    try {
      expect((await h.subagent.handleToolCall(call('peek', { name: 5 }))).error).toBe('Nothing was shown: name must be text, not 5.');
      const sub = internal(h.subagent);
      sub.callIdIndex.set('t-ret', 'scout');
      expect((await h.subagent.handleToolCall(call('return', { result: { a: 1 } }, 't-ret'))).error).toBe(
        'Nothing was returned: result must be text, not {"a":1}.',
      );
      expect(sub.returnedResults.has('scout')).toBe(false);
      // Without a result, the run's last words stand for it, as before.
      expect(await h.subagent.handleToolCall(call('return', {}, 't-ret'))).toEqual({ success: true, data: 'Result received.', endTurn: true });
      expect(sub.returnedResults.get('scout')).toBeUndefined();
    } finally { await h.cleanup(); }
  });

  test('a tool the module doesn\'t have is answered with the ones it has', async () => {
    const h = await harness();
    try {
      expect((await h.subagent.handleToolCall(call('kill', {}))).error).toBe(
        'There\'s no tool "subagent--kill", so nothing ran. The subagent tools are subagent--spawn, subagent--fork, ' +
        'subagent--hud, subagent--concurrency, subagent--peek and subagent--return.',
      );
    } finally { await h.cleanup(); }
  });
});

describe('a spawn\'s or fork\'s failure says whether anything ran, and what to do', () => {
  test('an agent that couldn\'t be made: nothing ran, and the subagent is recorded failed', async () => {
    const h = await harness();
    try {
      const fw = h.framework as unknown as { createEphemeralAgent: (c: unknown) => Promise<unknown> };
      fw.createEphemeralAgent = async () => { throw new Error('no model "mock-x" here.'); };
      expect((await h.subagent.handleToolCall(spawn('scout', { sync: true }))).error).toBe(
        "Subagent 'scout' didn't start, so nothing ran: no model \"mock-x\" here.",
      );
      expect(internal(h.subagent).activeSubagents.get('spawn-scout')).toMatchObject({ status: 'failed', statusMessage: 'no model "mock-x" here.' });
    } finally { await h.cleanup(); }
  });

  test('a run\'s own error after its retries: it stopped, what it did stays done, and calling again starts over', async () => {
    let attempts = 0;
    const h = await harness({ maxRetries: 1 }, async () => { attempts++; throw new Error('503 overloaded'); });
    internal(h.subagent).waitOrStop = async () => null; // the 5 s back-off before the retry
    try {
      expect((await h.subagent.handleToolCall(fork('scout', { sync: true }))).error).toBe(
        "Fork 'scout' stopped after 2 attempts and returned no result: 503 overloaded. What it did before then stays done, " +
        'and forking it again starts its task over.',
      );
      expect(attempts).toBe(2);
    } finally { await h.cleanup(); }
  });

  test('the async notice carries the same account', async () => {
    const h = await harness({ maxRetries: 0 }, async () => { throw new Error('the provider refused the request'); });
    const messages: string[] = [];
    const ctx = (h.subagent as unknown as { ctx: { addMessage(p: string, c: Array<{ text?: string }>): unknown } }).ctx;
    const add = ctx.addMessage.bind(ctx);
    ctx.addMessage = (p, c) => { if (c[0]?.text) messages.push(c[0].text); return add(p, c); };
    try {
      await h.subagent.handleToolCall(spawn('scout'));
      await outcome(h, 'scout');
      await until(() => messages.some((m) => m.startsWith("[Subagent 'scout' failed]")));
      expect(messages.at(-1)).toBe(
        "[Subagent 'scout' failed]\n\nError: Subagent 'scout' stopped and returned no result: the provider refused the request. " +
        'What it did before then stays done, and spawning it again starts its task over.',
      );
    } finally { await h.cleanup(); }
  });

  test('a prompt over the limit didn\'t start, and says what to shorten, or for a fork to spawn instead', async () => {
    const h = await harness({ maxPromptTokens: 10 });
    try {
      expect((await h.subagent.handleToolCall(spawn('scout', { sync: true }))).error).toMatch(new RegExp(
        "^Subagent 'scout' didn't start, so nothing ran: its prompt would be about \\d+ tokens, over this host's limit of 10\\. " +
        "Shorten its task or systemPrompt, or pass tools naming only the tools it needs, since every tool's definition counts\\.$",
      ));
      expect((await h.subagent.handleToolCall(fork('probe', { sync: true }))).error).toMatch(new RegExp(
        "^Fork 'probe' didn't start, so nothing ran: it would begin at about \\d+ tokens, over this host's limit of 10, because a " +
        'fork carries your whole conversation\\. Use subagent--spawn instead, with a name, a systemPrompt, and a task that says ' +
        'what it needs to know\\.$',
      ));
    } finally { await h.cleanup(); }
  });

  test('no slot in time: it didn\'t start, and the remedy follows whether a rate limit holds the limit down', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const h = await harness({ maxConcurrent: 2 }, async () => { await held; return { speech: 'ok', toolCallsCount: 0 }; });
    const sub = internal(h.subagent);
    const acquire = (sub as unknown as { acquireSlot: (k: 'spawn' | 'fork', ms?: number, c?: Promise<never>) => Promise<unknown> });
    const slot = acquire.acquireSlot.bind(h.subagent);
    acquire.acquireSlot = (kind, _ms, cancelled) => slot(kind, 50, cancelled);
    try {
      await h.subagent.handleToolCall(spawn('a'));
      await h.subagent.handleToolCall(spawn('b'));
      // The holder list names the subagents running.
      await until(() => ['spawn-a', 'spawn-b'].every((n) => sub.activeSubagents.get(n)?.status === 'running'));
      const first = (await h.subagent.handleToolCall(spawn('c', { sync: true }))).error ?? '';
      expect(first).toStartWith(
        "Subagent 'c' didn't start, so nothing ran: no concurrency slot opened within 50 ms (2 running against a limit of 2, " +
        '0 others waiting). Wait for one of the subagents below to finish, or raise the limit with subagent--concurrency, then ' +
        'call subagent--spawn again. At most 2 run at once here, so start no more than that together.\nSlots held by:\n  - a [spawn] ',
      );
      // While a rate limit's halving holds, raising the ceiling doesn't raise
      // the limit, so the remedy is to wait.
      sub.configuredMaxConcurrent = 4;
      sub.throttled = true;
      const held2 = (await h.subagent.handleToolCall(fork('d', { sync: true }))).error ?? '';
      expect(held2).toStartWith(
        "Fork 'd' didn't start, so nothing ran: no concurrency slot opened within 50 ms (2 running against a limit of 2, " +
        '0 others waiting). A rate limit holds the limit at 2. It rises by one after every three subagents that finish without ' +
        'error, up to 4. Wait for one of the subagents below to finish, then call subagent--fork again. At most 2 run at once ' +
        'here, so start no more than that together.\nSlots held by:\n',
      );
    } finally { release(); await h.cleanup(); }
  });

  test('no slot in time, with no subagent listed as running and one other waiting', async () => {
    const h = await harness({ maxConcurrent: 1 });
    const sub = h.subagent as unknown as {
      acquireSlot(kind: 'spawn' | 'fork', ms?: number): Promise<{ slot: object }>;
      releaseSlot(slot: object): void;
    };
    try {
      const held = await sub.acquireSlot('spawn'); // a slot no subagent entry holds
      const later = sub.acquireSlot('fork', 10_000);
      const failure = await sub.acquireSlot('spawn', 50).then(() => null, (e: unknown) => e as { why: string; remedy: string });
      expect(failure?.why).toBe('no concurrency slot opened within 50 ms (1 running against a limit of 1, 1 other waiting)');
      expect(failure?.remedy).toBe(
        'Wait for a running subagent to finish, or raise the limit with subagent--concurrency, then call subagent--spawn again. ' +
        'At most 1 run at once here, so start no more than that together.',
      );
      sub.releaseSlot(held.slot);
      sub.releaseSlot((await later).slot);
      expect(h.subagent.getConcurrencyStatus()).toMatchObject({ active: 0, queued: 0 });
    } finally { await h.cleanup(); }
  });

  test('a peek that finds nothing says what that can mean', async () => {
    const h = await harness();
    try {
      expect((await h.subagent.handleToolCall(call('peek', { name: 'scout' }))).data).toEqual({
        message: "No subagent of yours named 'scout' is running now. It may have finished (an async subagent's result arrives " +
          'as a message), or not have started yet, such as while it waits for a concurrency slot. subagent--peek with no name ' +
          'lists the ones running now.',
      });
      expect((await h.subagent.handleToolCall(call('peek', {}))).data).toEqual({ message: 'None of your subagents is running now.' });
    } finally { await h.cleanup(); }
  });
});
