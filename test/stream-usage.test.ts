/**
 * Usage samples are a stream's running total, so each provider call counts
 * once and the context size is the prompt of the latest call.
 *
 * The stream below runs through a real AgentFramework and a real Membrane,
 * with a small adapter that reports fixed usage per call, cache included
 * (membrane's own MockAdapter reports no cache tokens). So the reducer and
 * the subagent module fold the samples membrane actually emits:
 * `TurnUsageAccumulator.addRound` adds each call into the stream's totals and
 * agent-framework forwards the sum as `inference:usage`.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module, ToolCall } from '@animalabs/agent-framework';
import { Membrane, NativeFormatter } from '@animalabs/membrane';
import type { ProviderAdapter, ProviderRequest, ProviderResponse, StreamCallbacks } from '@animalabs/membrane';
import { AgentTreeReducer } from '../src/state/agent-tree-reducer.js';
import { emptyUsage, foldUsageSample } from '../src/state/stream-usage.js';
import { SubagentModule, type SubagentStreamEvent } from '../src/modules/subagent-module.js';

interface CallUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }

/** Three provider calls: two that call a tool, then a text answer. */
const CALLS: CallUsage[] = [
  { inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 4000 },
  { inputTokens: 80, outputTokens: 25, cacheReadTokens: 4000, cacheCreationTokens: 150 },
  { inputTokens: 60, outputTokens: 40, cacheReadTokens: 4150, cacheCreationTokens: 90 },
];
const prompt = (c: CallUsage) => c.inputTokens + c.cacheReadTokens + c.cacheCreationTokens;
const sum = (k: keyof CallUsage) => CALLS.reduce((n, c) => n + c[k], 0);

/** Answers each streamed call from its script, in order, with that call's
 *  usage: every call but the last calls the probe's tool. */
class MeteredAdapter implements ProviderAdapter {
  readonly name = 'metered';
  readonly usageCacheConvention = 'cache-excluded' as const;
  calls = 0;
  constructor(private readonly script: CallUsage[]) {}
  supportsModel(): boolean { return true; }
  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    throw new Error(`unexpected non-streaming call for ${request.model}`);
  }
  async stream(request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
    const i = this.calls++;
    const usage = this.script[i];
    if (!usage) throw new Error(`unexpected provider call ${i + 1}`);
    const last = i === this.script.length - 1;
    if (last) callbacks.onChunk('done');
    return {
      content: last
        ? [{ type: 'text', text: 'done' }]
        : [{ type: 'tool_use', id: `ping-${i + 1}`, name: 'probe--ping', input: {} }],
      stopReason: last ? 'end_turn' : 'tool_use',
      usage: { ...usage },
      model: request.model,
      rawRequest: request,
      raw: {},
    };
  }
}

class ProbeTools implements Module {
  readonly name = 'probe';
  async start() {}
  async stop() {}
  async onProcess() { return {}; }
  getTools() {
    return [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' as const, properties: {} } }];
  }
  async handleToolCall(_call: ToolCall) {
    return { success: true, data: 'pong' };
  }
}

/** Add one call's usage to every `inference:completed` the listeners see,
 *  as a completion carrying a call no sample reported would. */
function widenCompletions(framework: AgentFramework, extra: CallUsage): void {
  const onTrace = framework.onTrace.bind(framework);
  (framework as unknown as { onTrace: typeof onTrace }).onTrace = (listener) => onTrace((event) => {
    const e = event as unknown as { type: string; tokenUsage?: Record<string, number | undefined> };
    if (e.type !== 'inference:completed' || !e.tokenUsage) return listener(event);
    const u = e.tokenUsage;
    return listener({
      ...e,
      tokenUsage: {
        input: (u.input ?? 0) + extra.inputTokens,
        output: (u.output ?? 0) + extra.outputTokens,
        cacheRead: (u.cacheRead ?? 0) + extra.cacheReadTokens,
        cacheCreation: (u.cacheCreation ?? 0) + extra.cacheCreationTokens,
      },
    } as unknown as typeof event);
  });
}

async function harness(script: CallUsage[] = CALLS, opts: { completionAdds?: CallUsage } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stream-usage-'));
  const adapter = new MeteredAdapter(script);
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
  const subagent = new SubagentModule({
    parentAgentName: 'parent',
    defaultModel: 'metered-model',
    defaultMaxTokens: 256,
    maxRetries: 0,
  });
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane,
    agents: [{ name: 'parent', model: 'metered-model', systemPrompt: 'parent', maxTokens: 256 }],
    modules: [new ProbeTools(), subagent as unknown as Module],
  });
  if (opts.completionAdds) widenCompletions(framework, opts.completionAdds);
  subagent.setFramework(framework);
  const traces: Array<Record<string, unknown>> = [];
  framework.onTrace((event) => { traces.push(event as unknown as Record<string, unknown>); });
  framework.start();
  const cleanup = async () => {
    await framework.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  };
  return { adapter, framework, subagent, traces, cleanup };
}

/** A stream for `name` from `script` (the three-call one by default), run to
 *  completion; returns its traces. */
async function runStream(name: string, script: CallUsage[] = CALLS, agentConfig: { maxStreamTokens?: number } = {}) {
  const h = await harness(script);
  try {
    const { agent, contextManager } = await h.framework.createEphemeralAgent({
      name, model: 'metered-model', systemPrompt: 'Ping twice, then answer.', maxTokens: 256,
      allowedTools: 'all', proseRouting: 'disabled', ...agentConfig,
    });
    contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
    await h.framework.runEphemeralToCompletion(agent, contextManager);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const mine = h.traces.filter((e) => e.agentName === name);
    const tracked = h.framework.getSessionUsage().byAgent.find((a) => a.agentName === name)?.usage;
    return { calls: h.adapter.calls, events: mine, tracked };
  } finally {
    await h.cleanup();
  }
}

function fold(events: Array<Record<string, unknown>>, r = new AgentTreeReducer()) {
  for (const e of events) r.applyEvent(e as never);
  return r;
}

describe('usage samples from a real stream', () => {
  test('membrane emits one running total per call, and the completion repeats the last', async () => {
    const run = await runStream('worker');
    expect(run.calls).toBe(3);
    const usage = run.events.filter((e) => e.type === 'inference:usage').map((e) => e.tokenUsage);
    expect(usage).toEqual([
      // No call has read the cache yet, so membrane leaves cacheRead out.
      { input: 120, output: 30, cacheCreation: 4000, cacheRead: undefined },
      { input: 200, output: 55, cacheCreation: 4150, cacheRead: 4000 },
      { input: 260, output: 95, cacheCreation: 4240, cacheRead: 8150 },
    ]);
    const completed = run.events.filter((e) => e.type === 'inference:completed');
    expect(completed.map((e) => e.tokenUsage)).toEqual([usage[2]]);
  });

  test('the reducer counts each call once, as the framework tracker does, and shows the last prompt', async () => {
    const run = await runStream('worker');
    const tokens = fold(run.events).getNode('worker')!.tokens;
    expect(tokens).toEqual({
      input: prompt(CALLS[2]!),
      output: sum('outputTokens'),
      cacheRead: sum('cacheReadTokens'),
      cacheWrite: sum('cacheCreationTokens'),
    });
    expect(run.tracked).toMatchObject({
      outputTokens: tokens.output,
      cacheReadTokens: tokens.cacheRead,
      cacheCreationTokens: tokens.cacheWrite,
    });
  });

  test('a second stream counts from zero after its inference:started', async () => {
    const run = await runStream('worker');
    const tokens = fold([...run.events, ...run.events]).getNode('worker')!.tokens;
    expect(tokens).toEqual({
      input: prompt(CALLS[2]!),
      output: 2 * sum('outputTokens'),
      cacheRead: 2 * sum('cacheReadTokens'),
      cacheWrite: 2 * sum('cacheCreationTokens'),
    });
  });

  test('a context-budget restart starts a new stream that counts from zero', async () => {
    // The first call's 120 fresh tokens pass maxStreamTokens, so the framework
    // restarts at the tool boundary. The new stream's first call is larger in
    // every count than the old stream's total, so only its inference:started
    // tells the fold that the counts began again.
    const script: CallUsage[] = [
      { inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 4000 },
      { inputTokens: 130, outputTokens: 40, cacheReadTokens: 4000, cacheCreationTokens: 4100 },
    ];
    const run = await runStream('worker', script, { maxStreamTokens: 100 });
    expect(run.calls).toBe(2);
    expect(run.events.map((e) => e.type).filter((t) => /^inference:(started|usage|stream_restarted)$/.test(String(t))))
      .toEqual(['inference:started', 'inference:usage', 'inference:stream_restarted', 'inference:started', 'inference:usage']);
    // agent-framework v0.21's tracker leaves the restarted stream out (#207
    // counts it), so this test checks the calls themselves.
    expect(fold(run.events).getNode('worker')!.tokens).toEqual({
      input: prompt(script[1]!), output: 70, cacheRead: 4000, cacheWrite: 8100,
    });
  });

  test('the context size follows each call as its sample arrives', async () => {
    const run = await runStream('worker');
    const r = new AgentTreeReducer();
    const seen: number[] = [];
    for (const e of run.events) {
      r.applyEvent(e as never);
      if (e.type === 'inference:usage') seen.push(r.getNode('worker')!.tokens.input);
    }
    expect(seen).toEqual(CALLS.map(prompt));
  });

  test('a reducer seeded from a mid-stream snapshot keeps counting each call once', async () => {
    const run = await runStream('worker');
    const cut = run.events.findIndex((e) => e.type === 'inference:usage') + 1;
    const before = fold(run.events.slice(0, cut));
    // Over the wire: the describe reply and the web welcome send nodes as JSON.
    const snapshot = JSON.parse(JSON.stringify(before.getSnapshot()));
    const after = new AgentTreeReducer();
    after.applySnapshot(snapshot);
    expect(fold(run.events.slice(cut), after).getNode('worker')!.tokens)
      .toEqual(fold(run.events).getNode('worker')!.tokens);
  });

  test('a reader that joins mid-stream counts the stream once and waits a call for its context size', async () => {
    const run = await runStream('worker');
    const cut = run.events.findIndex((e) => e.type === 'inference:usage') + 1;
    const r = new AgentTreeReducer();
    const seen: number[] = [];
    for (const e of run.events.slice(cut)) {
      r.applyEvent(e as never);
      if (e.type === 'inference:usage') seen.push(r.getNode('worker')!.tokens.input);
    }
    // Its first sample spans calls 1 and 2, so it isn't one call's prompt.
    expect(seen).toEqual([0, prompt(CALLS[2]!)]);
    expect(r.getNode('worker')!.tokens.output).toBe(sum('outputTokens'));
  });

  for (const script of [CALLS, CALLS.slice(2)]) {
    test(`a subagent's context size is its last call's prompt (${script.length} call${script.length > 1 ? 's' : ''})`, async () => {
      const h = await harness(script);
      try {
        const done: Array<Extract<SubagentStreamEvent, { type: 'done' }>> = [];
        h.subagent.onPeekStream('*', (event) => { if (event.type === 'done') done.push(event); });
        const result = await h.subagent.handleToolCall({
          id: 'spawn-1',
          name: 'spawn',
          callerAgentName: 'parent',
          input: { name: 'probe', systemPrompt: 'Ping, then answer.', task: 'ping', tools: ['probe--ping'], sync: true },
        } as unknown as ToolCall);
        expect(result.success).toBe(true);
        expect(h.adapter.calls).toBe(script.length);
        expect(done.map((e) => e.lastInputTokens)).toEqual([prompt(script[script.length - 1]!)]);
      } finally {
        await h.cleanup();
      }
    });
  }

  test("a completion carrying a call no sample reported sets the subagent's context size to it", async () => {
    // agent-framework's completions repeat the last sample, so this one is
    // widened by a call on its way to the listeners.
    const extra: CallUsage = { inputTokens: 70, outputTokens: 10, cacheReadTokens: 4240, cacheCreationTokens: 20 };
    const h = await harness(CALLS.slice(2), { completionAdds: extra });
    try {
      const done: Array<Extract<SubagentStreamEvent, { type: 'done' }>> = [];
      h.subagent.onPeekStream('*', (event) => { if (event.type === 'done') done.push(event); });
      const result = await h.subagent.handleToolCall({
        id: 'spawn-1',
        name: 'spawn',
        callerAgentName: 'parent',
        input: { name: 'probe', systemPrompt: 'Answer.', task: 'answer', tools: ['probe--ping'], sync: true },
      } as unknown as ToolCall);
      expect(result.success).toBe(true);
      expect(done.map((e) => e.lastInputTokens)).toEqual([prompt(extra)]);
    } finally {
      await h.cleanup();
    }
  });
});

describe('foldUsageSample', () => {
  const sample = { input: 50, output: 10, cacheRead: 300, cacheCreation: 20 };

  test('after a stream starts, the first sample is one call', () => {
    expect(foldUsageSample(emptyUsage(), sample)).toEqual({
      total: { ...sample }, added: { ...sample }, prompt: 370,
    });
  });

  test('a sample that repeats the last adds nothing and names no prompt', () => {
    const step = foldUsageSample({ ...sample }, sample);
    expect(step.added).toEqual(emptyUsage());
    expect(step.prompt).toBeUndefined();
  });

  test('with no previous sample the whole sample counts, but it may span calls', () => {
    const step = foldUsageSample(undefined, sample);
    expect(step.added).toEqual(sample);
    expect(step.prompt).toBeUndefined();
  });

  test('a sample below the last in any count is a new stream, and counts whole', () => {
    for (const k of ['input', 'output', 'cacheRead', 'cacheCreation'] as const) {
      const previous = { input: 40, output: 5, cacheRead: 200, cacheCreation: 10, [k]: sample[k] + 1 };
      const step = foldUsageSample(previous, sample);
      expect(step.added).toEqual(sample);
      expect(step.prompt).toBeUndefined();
    }
  });

  test('a count that is absent or not a positive number counts as zero', () => {
    const step = foldUsageSample(emptyUsage(), { input: 50, output: Number.NaN, cacheRead: -3 });
    expect(step.total).toEqual({ input: 50, output: 0, cacheRead: 0, cacheCreation: 0 });
    expect(step.prompt).toBe(50);
  });
});
