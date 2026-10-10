/**
 * Fork and spawn orientation: a stream is told what it runs on before its
 * first inference, and the caller's receipt describes the same launch.
 *
 * One launch description is resolved at the call: lineage, model, provider,
 * system prompt source, strategy and its windows, budgets, prose routing,
 * tool rules, and the parent's values at the call. The stream is created
 * from it, the receipt renders it, and the stream's first context renders
 * it again, byte for byte. The first context then adds what is known only
 * when the stream is created: which inheritance path ran, its context
 * budget as created, its prose routing when the launch left that to the
 * framework, and the tools it is shown beside what its parent is shown now.
 *
 * Most cases stub runEphemeralToCompletion and read the child's stored
 * context. The last describe block runs the real one against the mock
 * provider and reads the first request the child actually sends.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, KnowledgeStrategy } from '@animalabs/agent-framework';
import type { Module, ToolCall, AgentConfig } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { SubagentModule, type SubagentModuleConfig } from '../src/modules/subagent-module.js';

interface Run {
  name: string;
  /** The prose routing, output limit and system prompt the child agent
   *  was created with. */
  proseRouting: string;
  maxTokens: number;
  systemPrompt: string;
  /** Text of the child's last message: the fork's tool_result, or the
   *  spawn's / parentless fork's task message. */
  firstContext: string;
  /** All of the child's context, for inheritance checks. */
  allText: string;
  /** What the framework reports the child is shown, once registered. */
  surface: string[];
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    const block = b as { type?: string; text?: string; content?: unknown };
    if (block.type === 'text') return block.text ?? '';
    if (block.type === 'tool_result') return textOf(block.content);
    return '';
  }).join('\n');
}

/** A module offering `count` plain tools, to widen the shared board. */
function toolModule(name: string, count: number): Module {
  return {
    name,
    async start() {},
    async stop() {},
    getTools: () => Array.from({ length: count }, (_, i) => ({
      name: `t${i + 1}`,
      description: `tool ${i + 1}`,
      inputSchema: { type: 'object', properties: {} },
    })),
    async handleToolCall() { return { success: true, data: 0 }; },
    async onProcess() { return {}; },
  } as unknown as Module;
}

async function makeHarness(opts: {
  parent?: Partial<AgentConfig> | null;
  extraAgents?: AgentConfig[];
  module?: Partial<SubagentModuleConfig>;
  modules?: Module[];
}) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'sub-orient-'));
  const adapter = new MockAdapter({ defaultResponse: 'ok' });
  const membrane = new Membrane(adapter, { formatter: new NativeFormatter() });
  const subagent = new SubagentModule({
    provider: 'mock',
    ...(opts.parent === null ? {} : { parentAgentName: 'parent' }),
    defaultModel: 'mock',
    maxRetries: 0,
    ...opts.module,
  });
  const framework = await AgentFramework.create({
    storePath: join(tmpDir, 'store'),
    membrane,
    agents: [{
      name: 'parent',
      model: 'mock',
      systemPrompt: 'parent prompt',
      maxTokens: 256,
      ...(opts.parent ?? {}),
    }, ...(opts.extraAgents ?? [])],
    modules: [subagent as unknown as Module, ...(opts.modules ?? [])],
  });
  subagent.setFramework(framework);

  const fw = framework as unknown as {
    runEphemeralToCompletion: (agent: unknown, cm: unknown) => Promise<{ speech: string; toolCallsCount: number }>;
    agents: Map<string, unknown>;
  };
  const runs: Run[] = [];
  const holds: Array<() => void> = [];
  let holdNext: (() => void) | null = null;
  fw.runEphemeralToCompletion = async (agent: unknown, cm: unknown) => {
    const a = agent as { name: string; proseRouting: string; maxTokens: number; systemPrompt: string };
    fw.agents.set(a.name, agent); // what the real run does at its start
    try {
      const { messages } = (cm as { queryMessages(q: object): { messages: Array<{ content: unknown }> } })
        .queryMessages({});
      runs.push({
        name: a.name,
        proseRouting: a.proseRouting,
        maxTokens: a.maxTokens,
        systemPrompt: a.systemPrompt,
        firstContext: textOf(messages[messages.length - 1]?.content),
        allText: messages.map((m) => textOf(m.content)).join('\n'),
        surface: framework.listToolClasses(a.name).map((t) => t.tool),
      });
      if (holdNext) {
        const reached = holdNext;
        holdNext = null;
        const held = new Promise<void>((resolve) => holds.push(resolve));
        reached();
        await held;
      }
      return { speech: 'done', toolCallsCount: 0 };
    } finally {
      fw.agents.delete(a.name);
    }
  };

  return {
    framework,
    subagent,
    runs,
    /** Hold the next run inside the stub; resolves once it is held. */
    holdNextRun: () => new Promise<void>((resolve) => { holdNext = resolve; }),
    releaseHeld: () => { for (const r of holds.splice(0)) r(); },
    /** Unregister an agent, as the framework does when an ephemeral
     *  parent's run ends (there is no public removal API). */
    unregister: (name: string) => { fw.agents.delete(name); },
    asyncPromise: (name: string) =>
      (subagent as unknown as { asyncHandles: Map<string, { promise: Promise<unknown> }> })
        .asyncHandles.get(name)?.promise,
    cleanup: async () => {
      await framework.stop().catch(() => {});
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function call(name: 'fork' | 'spawn', id: string, input: Record<string, unknown>, caller: string | null = 'parent'): ToolCall {
  return { id, name, input, ...(caller !== null ? { callerAgentName: caller } : {}) } as unknown as ToolCall;
}

/** The parent's assistant turn holding the fork call, so the structural
 *  path finds it. */
function seedForkCall(framework: AgentFramework, id: string, input: Record<string, unknown>, agent = 'parent'): void {
  const cm = framework.getAgent(agent)!.getContextManager();
  cm.addMessage('user', [{ type: 'text', text: 'please look into it' }]);
  cm.addMessage(agent, [{ type: 'tool_use', id, name: 'subagent--fork', input }] as never);
}

/** The structural path's inheritance, as materialiseStructuralFork does it. */
const CUT_AT_EXCHANGE =
  "- Inherited: the parent's compiled context through the fork call's exchange. Messages before the call " +
  "are kept as they were. The call's assistant message and its result message keep their other blocks, " +
  "with sibling fork calls and their results removed and this call's result rewritten as this message. " +
  'No other message after the call is included.';

/** What the orientation says each prose-routing mode does with plain text. */
const ROUTING_EFFECT = {
  locus: 'plain text is published to the channel the framework infers for each turn, if there is one',
  explicit: 'plain text is delivered only after a destination prefix line such as ">>#channel" in the same turn; ' +
    'the prose_help tool shows the syntax',
  hybrid: 'unprefixed plain text is published to the channel the framework infers for each turn, if there is one; ' +
    'a leading ">>>destination" envelope routes that text to the destination it names instead',
  disabled: 'plain text is never published, even with a prefix; only explicit send tools reach a channel',
} as const;

function launchBlock(receipt: string): string {
  const at = receipt.indexOf('\n\nLaunch of ');
  expect(at).toBeGreaterThan(-1);
  return receipt.slice(at + 2);
}

/** The creation-time section of a first context. */
function startSection(text: string): string {
  const at = text.indexOf('At the start of this stream:');
  expect(at).toBeGreaterThan(-1);
  const end = text.indexOf('\n\n', at);
  return end < 0 ? text.slice(at) : text.slice(at, end);
}

function line(text: string, prefix: string): string {
  const found = text.split('\n').find((l) => l.startsWith(prefix));
  expect(found).toBeDefined();
  return found!;
}

describe('fork orientation', () => {
  test('a fork on a model override: receipt and first context state the same launch; the start says what happened', async () => {
    const h = await makeHarness({});
    try {
      const input = { name: 'scout', task: 'map the caves', model: 'mock-alt' };
      seedForkCall(h.framework, 'toolu_fork_1', input);
      const res = await h.subagent.handleToolCall(call('fork', 'toolu_fork_1', input));
      expect(res.success).toBe(true);
      const receipt = res.data as string;
      expect(receipt).toStartWith("Subagent 'scout' forked. Running in background.");
      await h.asyncPromise('scout');

      const block = launchBlock(receipt);
      expect(block).toContain("Launch of fork 'scout', as resolved at its subagent--fork call (toolu_fork_1):");
      // The receipt describes the intended lineage, not which path will run.
      expect(block).toContain('- Lineage: forked from stream "parent"; depth 1 of 3. A fork inherits the parent\'s compiled context: through this call\'s exchange if the call is still in that context when the fork starts, and otherwise all of it as it is then.');
      // The harness parent runs passthrough: no windows or cap to compare.
      expect(line(block, '- Against the parent at the call')).toBe(
        '- Against the parent at the call: Differs in model, strategy type and stream budget. ' +
        'Same: provider connection, system prompt, output limit, prose routing and tool rules. ' +
        "Not compared: head window, recent window, message cap and compression model (the parent doesn't report them), " +
        'and context budget (set when the stream starts).',
      );
      expect(block).toContain("- Model: mock-alt (the parent's: mock).");
      expect(block).toContain("- Provider: mock, the parent's own connection.");
      expect(block).toContain("- Recent window: 80,000 tokens (the parent's isn't reported).");
      expect(block).toContain("- Output limit: 256 tokens, the same as the parent's.");
      // The harness parent sets no mode, so it runs the framework's default.
      expect(block).toContain(`- Prose routing: locus, inherited from the parent: ${ROUTING_EFFECT.locus}.`);
      expect(block).toContain("summary text already in the parent's compiled context comes with that context");
      expect(block).not.toContain('Matches');

      const run = h.runs[0]!;
      expect(run.proseRouting).toBe('locus');
      expect(run.firstContext).toContain('Two parallel streams of you continue from this point');
      expect(run.firstContext).toContain(block);
      const start = startSection(run.firstContext);
      expect(start).toContain(CUT_AT_EXCHANGE);
      expect(start).toContain("- Context budget: 100,000 tokens (the parent's at the call: 100,000 tokens).");
      expect(start).toContain(`- Tools: ${run.surface.length} available to this stream, the same set the parent stream has now.`);
    } finally {
      await h.cleanup();
    }
  });

  test('a fork whose parent reports matching windows names only the settings it compared', async () => {
    const h = await makeHarness({
      parent: {
        maxStreamTokens: 500_000,
        strategy: new KnowledgeStrategy({ headWindowTokens: 2_000, recentWindowTokens: 80_000, maxMessageTokens: 10_000 }),
      },
    });
    try {
      const input = { name: 'twin', task: 'carry on' };
      seedForkCall(h.framework, 'toolu_fork_3', input);
      const res = await h.subagent.handleToolCall(call('fork', 'toolu_fork_3', input));
      await h.asyncPromise('twin');
      const block = launchBlock(res.data as string);
      expect(line(block, '- Against the parent at the call')).toBe(
        '- Against the parent at the call: Same: model, provider connection, system prompt, strategy type, ' +
        'recent window, message cap, stream budget, output limit, prose routing and tool rules. ' +
        "Not compared: head window and compression model (the parent doesn't report them), " +
        'and context budget (set when the stream starts).',
      );
      expect(block).toContain('- Strategy: a fresh knowledge instance, the same type as the parent\'s.');
      expect(block).toContain("- Recent window: 80,000 tokens, the same as the parent's.");
      expect(h.runs[0]!.firstContext).toContain(block);
    } finally {
      await h.cleanup();
    }
  });

  test('a system-prompt override and a narrower output limit are named as differences', async () => {
    const h = await makeHarness({ parent: { maxTokens: 512 }, module: { defaultMaxTokens: 128 } });
    try {
      const input = { name: 'critic', task: 'review it', systemPrompt: 'you are a critic' };
      seedForkCall(h.framework, 'toolu_fork_4', input);
      const res = await h.subagent.handleToolCall(call('fork', 'toolu_fork_4', input));
      await h.asyncPromise('critic');
      const block = launchBlock(res.data as string);
      expect(line(block, '- Against the parent at the call')).toContain('Differs in system prompt, strategy type, stream budget and output limit.');
      expect(block).toContain('- System prompt: overridden for this fork.');
      expect(block).toContain("- Output limit: 128 tokens (the parent's: 512 tokens).");

      // Naming the parent's own prompt overrides nothing.
      const echo = { name: 'echo', task: 'review it too', systemPrompt: 'parent prompt' };
      seedForkCall(h.framework, 'toolu_fork_4b', echo);
      const echoed = await h.subagent.handleToolCall(call('fork', 'toolu_fork_4b', echo));
      await h.asyncPromise('echo');
      const echoBlock = launchBlock(echoed.data as string);
      expect(echoBlock).toContain("- System prompt: the parent's.");
      expect(line(echoBlock, '- Against the parent at the call')).toContain('Differs in strategy type, stream budget and output limit.');
    } finally {
      await h.cleanup();
    }
  });

  test('a fork at the depth limit, under explicit prose routing, names every tool it lacks', async () => {
    const h = await makeHarness({ parent: { proseRouting: 'explicit' }, module: { maxDepth: 1 } });
    try {
      const input = { name: 'leaf', task: 'finish here' };
      seedForkCall(h.framework, 'toolu_fork_10', input);
      const res = await h.subagent.handleToolCall(call('fork', 'toolu_fork_10', input));
      await h.asyncPromise('leaf');
      const block = launchBlock(res.data as string);
      expect(block).toContain('depth 1 of 1');
      expect(block).toContain(`- Prose routing: explicit, inherited from the parent: ${ROUTING_EFFECT.explicit}.`);
      expect(block).toContain('- Tool rules: every tool the process offers except the subagent tools, keeping subagent--return: no further forks or spawns at this depth; the parent has no restriction.');
      const run = h.runs[0]!;
      expect(run.proseRouting).toBe('explicit');
      expect(run.surface).toContain('prose_help');
      expect(run.surface).not.toContain('subagent--fork');
      const parentTools = h.framework.listToolClasses('parent').map((t) => t.tool);
      const missing = parentTools.filter((n) => !run.surface.includes(n));
      expect(missing.length).toBeGreaterThan(1);
      const tools = line(startSection(run.firstContext), '- Tools:');
      expect(tools).toStartWith(`- Tools: ${run.surface.length} available to this stream. Compared with what the parent stream has now, it doesn't have `);
      for (const name of missing) expect(tools).toContain(name);
    } finally {
      await h.cleanup();
    }
  });

  test('tool differences and a parent restriction are named in full, however many there are', async () => {
    const h = await makeHarness({ parent: { allowedTools: ['agent_settings'] }, modules: [toolModule('wide', 15)] });
    try {
      const input = { name: 'wide', task: 'use everything' };
      seedForkCall(h.framework, 'toolu_fork_11', input);
      const res = await h.subagent.handleToolCall(call('fork', 'toolu_fork_11', input));
      await h.asyncPromise('wide');
      const block = launchBlock(res.data as string);
      expect(block).toContain('- Tool rules: no restriction; the parent is restricted to 1: agent_settings.');
      const run = h.runs[0]!;
      const parentTools = h.framework.listToolClasses('parent').map((t) => t.tool);
      const extra = run.surface.filter((n) => !parentTools.includes(n));
      expect(extra.length).toBeGreaterThan(15);
      const tools = line(startSection(run.firstContext), '- Tools:');
      for (const name of extra) expect(tools).toContain(name);
      expect(tools).not.toContain('more');
    } finally {
      await h.cleanup();
    }
  });

  test('a fork with no parent stream gets its task and an orientation that says so', async () => {
    const h = await makeHarness({ parent: null });
    try {
      const res = await h.subagent.handleToolCall(call('fork', 'toolu_fork_5', { name: 'orphan', task: 'list the files' }, null));
      expect(res.success).toBe(true);
      await h.asyncPromise('orphan');
      const block = launchBlock(res.data as string);
      expect(block).toContain('- Lineage: no parent stream, so this fork inherits no context; depth 1 of 3.');
      expect(block).toContain('- System prompt: the default research-assistant prompt.');
      expect(block).toContain("- Prose routing: not set by this launch, so the framework's default applies, stated when the stream starts.");
      expect(block).not.toContain('Against the parent');
      const run = h.runs[0]!;
      // Before this change a parentless fork started with an empty context.
      expect(run.firstContext).toStartWith('Your intention for this stream: list the files');
      expect(run.firstContext).toContain(block);
      const start = startSection(run.firstContext);
      expect(start).toContain('- Inherited: nothing; there is no parent stream.');
      expect(run.proseRouting).toBe('locus');
      expect(start).toContain(`- Prose routing: locus, the framework's default: ${ROUTING_EFFECT.locus}.`);
      expect(start).toContain(`- Tools: ${run.surface.length} available to this stream: `);
      for (const name of run.surface) expect(start).toContain(name);

      // Its own prompt overrides the default.
      const own = await h.subagent.handleToolCall(
        call('fork', 'toolu_fork_5b', { name: 'stray', task: 'list them again', systemPrompt: 'you list files' }, null),
      );
      await h.asyncPromise('stray');
      expect(launchBlock(own.data as string)).toContain('- System prompt: overridden for this fork.');
      expect(h.runs.find((r) => r.name.startsWith('stray-'))!.systemPrompt).toBe('you list files');
    } finally {
      await h.cleanup();
    }
  });

  test('a fork call with no id inherits the whole context, and says why', async () => {
    const h = await makeHarness({});
    try {
      h.framework.getAgent('parent')!.getContextManager().addMessage('user', [{ type: 'text', text: 'BEFORE_THE_CALL' }]);
      const input = { name: 'blind', task: 'look around' };
      const res = await h.subagent.handleToolCall({ name: 'fork', input, callerAgentName: 'parent' } as unknown as ToolCall);
      expect(res.success).toBe(true);
      await h.asyncPromise('blind');
      const run = h.runs[0]!;
      expect(run.allText).toContain('BEFORE_THE_CALL');
      expect(startSection(run.firstContext)).toContain(
        "- Inherited: the parent's whole compiled context as it was when this stream started, because the fork call had no id to cut at. It can include turns that came after the call.",
      );
    } finally {
      await h.cleanup();
    }
  });

  test("a parent whose tools can't be read isn't compared, and the stream is told so", async () => {
    const h = await makeHarness({});
    try {
      const fw = h.framework as unknown as { listToolClasses(agent: string): Array<{ tool: string }> };
      const real = fw.listToolClasses.bind(h.framework);
      fw.listToolClasses = (agent: string) => {
        if (agent === 'parent') throw new Error('unreadable');
        return real(agent);
      };
      const input = { name: 'unsure', task: 'carry on' };
      seedForkCall(h.framework, 'toolu_fork_unread', input);
      await h.subagent.handleToolCall(call('fork', 'toolu_fork_unread', input));
      await h.asyncPromise('unsure');
      const run = h.runs[0]!;
      const start = startSection(run.firstContext);
      expect(start).toContain(`- Tools: ${run.surface.length} available to this stream: `);
      expect(start).toContain(" The parent stream's tools couldn't be read for comparison.");
      expect(start).not.toContain('Compared with');
    } finally {
      await h.cleanup();
    }
  });

  test('a sync fork returns the launch with its result, and a detached one with its notice', async () => {
    const h = await makeHarness({});
    try {
      const input = { name: 'quick', task: 'one thing', sync: true };
      seedForkCall(h.framework, 'toolu_fork_6', input);
      const done = await h.subagent.handleToolCall(call('fork', 'toolu_fork_6', input));
      expect(done.success).toBe(true);
      const data = done.data as { summary: string; launch: string };
      expect(data.summary).toBe('done');
      expect(data.launch).toContain("Launch of fork 'quick'");
      expect(h.runs[0]!.firstContext).toContain(data.launch);

      void h.holdNextRun();
      const slowInput = { name: 'slow', task: 'a long thing', sync: true, timeoutMs: 50 };
      seedForkCall(h.framework, 'toolu_fork_7', slowInput);
      const detached = await h.subagent.handleToolCall(call('fork', 'toolu_fork_7', slowInput));
      expect(detached.success).toBe(true);
      const text = detached.data as string;
      expect(text).toStartWith("Subagent 'slow' moved to background.");
      expect(h.runs[1]!.firstContext).toContain(launchBlock(text));
      h.releaseHeld();
      await h.asyncPromise('slow');
    } finally {
      await h.cleanup();
    }
  });

  test('each prose-routing mode is named with what it does to plain text, and the stream runs it', async () => {
    for (const mode of ['locus', 'explicit', 'hybrid', 'disabled'] as const) {
      const h = await makeHarness({ parent: { proseRouting: mode } });
      try {
        const input = { name: `speaker-${mode}`, task: 'say something' };
        seedForkCall(h.framework, `toolu_${mode}`, input);
        const res = await h.subagent.handleToolCall(call('fork', `toolu_${mode}`, input));
        await h.asyncPromise(input.name);
        const block = launchBlock(res.data as string);
        expect(line(block, '- Prose routing:')).toBe(`- Prose routing: ${mode}, inherited from the parent: ${ROUTING_EFFECT[mode]}.`);
        expect(line(block, '- Against the parent at the call')).toContain('prose routing and tool rules.');
        const run = h.runs[0]!;
        expect(run.proseRouting).toBe(mode);
        expect(run.firstContext).toContain(block);
      } finally {
        await h.cleanup();
      }
    }
  });
});

describe('spawn orientation', () => {
  test("a spawn's task message carries the same launch as the receipt and names its whole surface", async () => {
    // A caller off the default mode, so the spawn's inheritance shows.
    const h = await makeHarness({ parent: { proseRouting: 'disabled' } });
    try {
      const input = { name: 'probe', systemPrompt: 'you are a probe', task: 'probe the harness', tools: ['time--now'] };
      const res = await h.subagent.handleToolCall(call('spawn', 'toolu_spawn_1', input));
      expect(res.success).toBe(true);
      await h.asyncPromise('probe');
      const block = launchBlock(res.data as string);
      expect(block).toContain("Launch of spawn 'probe', as resolved at its subagent--spawn call:");
      expect(block).toContain('- Lineage: spawned by stream "parent" as a separate agent with its own system prompt and task; it inherits none of the caller\'s context; depth 1 of 3.');
      expect(block).toContain('- System prompt: supplied by the caller for this spawn.');
      expect(block).toContain(`- Prose routing: disabled, inherited from the caller: ${ROUTING_EFFECT.disabled}.`);
      expect(block).toContain('- Tool rules: only the 1 the caller listed (time--now), plus subagent--return; the caller has no restriction.');
      expect(input.tools).toEqual(['time--now']); // the caller's array is not mutated
      const run = h.runs[0]!;
      expect(run.proseRouting).toBe('disabled');
      expect(run.firstContext).toStartWith('probe the harness\n');
      expect(run.firstContext).toContain(block);
      const start = startSection(run.firstContext);
      expect(start).toContain('- Inherited: nothing; a spawn starts from its task.');
      // time--now isn't on this harness's board, so only subagent--return is.
      expect(start).toContain('- Tools: 1 available to this stream: subagent--return.');
    } finally {
      await h.cleanup();
    }
  });
});

describe('a queued launch', () => {
  /** A knowledge parent with its own windows (Kit's review probe). */
  const probeParent: Partial<AgentConfig> = {
    maxStreamTokens: 500_000,
    contextBudgetTokens: 220_000,
    strategy: new KnowledgeStrategy({ headWindowTokens: 19_000, recentWindowTokens: 41_000, maxMessageTokens: 17_000 }),
  };

  async function queueBehindAHeldFork(h: Awaited<ReturnType<typeof makeHarness>>, caller = 'parent') {
    const held = h.holdNextRun();
    const first = { name: 'first', task: 'hold the slot' };
    seedForkCall(h.framework, 'toolu_first', first);
    await h.subagent.handleToolCall(call('fork', 'toolu_first', first));
    await held;
    void caller;
  }

  test('structural: keeps the call\'s inputs, cuts at the call, and states the budget as created', async () => {
    const h = await makeHarness({ parent: probeParent, module: { maxConcurrent: 1 } });
    try {
      await queueBehindAHeldFork(h);
      const second = { name: 'second', task: 'wait your turn' };
      seedForkCall(h.framework, 'toolu_second', second);
      const res = await h.subagent.handleToolCall(call('fork', 'toolu_second', second));
      const receipt = res.data as string;
      expect(receipt).toStartWith("Subagent 'second' forked. Every subagent slot (1) is in use, so it starts when one frees.");
      const block = launchBlock(receipt);
      expect(line(block, '- Against the parent at the call')).toBe(
        '- Against the parent at the call: Differs in recent window and message cap. ' +
        'Same: model, provider connection, system prompt, strategy type, stream budget, output limit, prose routing and tool rules. ' +
        "Not compared: head window and compression model (the parent doesn't report them), " +
        'and context budget (set when the stream starts).',
      );
      expect(block).toContain("- Recent window: 80,000 tokens (the parent's: 41,000 tokens).");
      expect(block).toContain("- Message cap: 10,000 tokens (the parent's: 17,000 tokens).");
      expect(block).toContain("(the parent's: 220,000 tokens).");

      // While it waits: the parent's settings change, a tool arrives, and a
      // message lands after the call.
      h.framework.getAgent('parent')!.maxStreamTokens = 777_000;
      await h.framework.addModule(toolModule('gauge', 1));
      h.framework.getAgent('parent')!.getContextManager().addMessage('user', [{ type: 'text', text: 'POST_CALL_ARRIVAL' }]);

      h.releaseHeld();
      await h.asyncPromise('first');
      await h.asyncPromise('second');

      const run = h.runs.find((r) => r.name.startsWith('second-'))!;
      expect(run.firstContext).toContain(block); // the call's inputs, not 777,000
      expect(run.allText).not.toContain('POST_CALL_ARRIVAL');
      const start = startSection(run.firstContext);
      expect(start).toContain(CUT_AT_EXCHANGE);
      expect(start).toContain("- Context budget: 100,000 tokens (the parent's at the call: 220,000 tokens).");
      expect(run.surface).toContain('gauge--t1');
      expect(start).toContain(`- Tools: ${run.surface.length} available to this stream, the same set the parent stream has now.`);
    } finally {
      await h.cleanup();
    }
  });

  test('structural: the call\'s exchange keeps its other blocks; later messages are dropped', async () => {
    // What "through the fork call's exchange" means: text beside the fork
    // call in its assistant message and beside its result in the result
    // message stays; a sibling fork call and its result go; so does any
    // message after the exchange.
    const h = await makeHarness({});
    try {
      const input = { name: 'kept', task: 'check the boundary' };
      const cm = h.framework.getAgent('parent')!.getContextManager();
      cm.addMessage('user', [{ type: 'text', text: 'BEFORE_THE_CALL' }]);
      cm.addMessage('parent', [
        { type: 'tool_use', id: 'toolu_kept', name: 'subagent--fork', input },
        { type: 'tool_use', id: 'toolu_sibling', name: 'subagent--fork', input: { name: 'sibling', task: 'other' } },
        { type: 'text', text: 'BESIDE_THE_CALL' },
      ] as never);
      cm.addMessage('user', [
        { type: 'tool_result', toolUseId: 'toolu_kept', content: 'the receipt' },
        { type: 'tool_result', toolUseId: 'toolu_sibling', content: 'SIBLING_RESULT' },
        { type: 'text', text: 'BESIDE_THE_RESULT' },
      ] as never);
      cm.addMessage('user', [{ type: 'text', text: 'AFTER_THE_EXCHANGE' }]);
      const res = await h.subagent.handleToolCall(call('fork', 'toolu_kept', input));
      expect(res.success).toBe(true);
      await h.asyncPromise('kept');

      const run = h.runs[0]!;
      expect(run.allText).toContain('BEFORE_THE_CALL');
      expect(run.allText).toContain('BESIDE_THE_CALL');
      expect(run.allText).toContain('BESIDE_THE_RESULT');
      expect(run.allText).not.toContain('SIBLING_RESULT');
      expect(run.allText).not.toContain('AFTER_THE_EXCHANGE');
      expect(startSection(run.allText)).toContain(CUT_AT_EXCHANGE);
    } finally {
      await h.cleanup();
    }
  });

  test('fallback: copies the parent\'s context at the start, post-call arrival included, and says so', async () => {
    const h = await makeHarness({ parent: probeParent, module: { maxConcurrent: 1 } });
    try {
      await queueBehindAHeldFork(h);
      // No seeded call: the fork call isn't in the parent's compiled context.
      const second = { name: 'second', task: 'queued fallback' };
      const res = await h.subagent.handleToolCall(call('fork', 'toolu_second', second));
      const block = launchBlock(res.data as string);
      h.framework.getAgent('parent')!.getContextManager().addMessage('user', [{ type: 'text', text: 'POST_CALL_ARRIVAL' }]);
      h.releaseHeld();
      await h.asyncPromise('first');
      await h.asyncPromise('second');

      const run = h.runs.find((r) => r.name.startsWith('second-'))!;
      expect(run.firstContext).toContain(block);
      expect(run.allText).toContain('POST_CALL_ARRIVAL');
      expect(startSection(run.firstContext)).toContain(
        "- Inherited: the parent's whole compiled context as it was when this stream started, because the fork call was no longer in that context. It can include turns that came after the call.",
      );
    } finally {
      await h.cleanup();
    }
  });

  test('a launch that waits is created with what was resolved at its call', async () => {
    const h = await makeHarness({ parent: { proseRouting: 'hybrid' }, module: { maxConcurrent: 1 } });
    try {
      await queueBehindAHeldFork(h);
      const fork = { name: 'second', task: 'wait your turn' };
      seedForkCall(h.framework, 'toolu_second', fork);
      const forkReceipt = (await h.subagent.handleToolCall(call('fork', 'toolu_second', fork))).data as string;
      const spawn = { name: 'third', systemPrompt: 'spawn prompt', task: 'wait as well' };
      const spawnReceipt = (await h.subagent.handleToolCall(call('spawn', 'toolu_third', spawn))).data as string;

      // While both wait, the values their launches took from the parent change.
      const parent = h.framework.getAgent('parent')! as unknown as { maxTokens: number; proseRouting: string; systemPrompt: string };
      parent.maxTokens = 999;
      parent.proseRouting = 'disabled';
      parent.systemPrompt = 'changed prompt';

      h.releaseHeld();
      await h.asyncPromise('first');
      await h.asyncPromise('second');
      await h.asyncPromise('third');

      for (const [prefix, receipt] of [['second-', forkReceipt], ['spawn-third-', spawnReceipt]] as const) {
        const run = h.runs.find((r) => r.name.startsWith(prefix))!;
        expect(launchBlock(receipt)).toContain('- Output limit: 256 tokens, the same as ');
        expect(run.maxTokens).toBe(256);
        expect(run.proseRouting).toBe('hybrid');
      }
      expect(h.runs.find((r) => r.name.startsWith('second-'))!.systemPrompt).toBe('parent prompt');
    } finally {
      await h.cleanup();
    }
  });

  test('a parent that is gone by the start: nothing inherited, and no comparison claimed', async () => {
    const h = await makeHarness({
      extraAgents: [{ name: 'helper', model: 'mock', systemPrompt: 'helper prompt', maxTokens: 256 }],
      module: { maxConcurrent: 1 },
    });
    try {
      await queueBehindAHeldFork(h);
      const child = { name: 'child', task: 'outlive the caller' };
      seedForkCall(h.framework, 'toolu_child', child, 'helper');
      const res = await h.subagent.handleToolCall(call('fork', 'toolu_child', child, 'helper'));
      const block = launchBlock(res.data as string);
      expect(block).toContain('- Lineage: forked from stream "helper"');
      h.unregister('helper');
      h.releaseHeld();
      await h.asyncPromise('first');
      await h.asyncPromise('child');

      const run = h.runs.find((r) => r.name.startsWith('child-'))!;
      expect(run.firstContext).toStartWith('Your intention for this stream: outlive the caller');
      expect(run.firstContext).toContain(block);
      expect(run.allText).not.toContain('please look into it');
      const start = startSection(run.firstContext);
      expect(start).toContain('- Inherited: nothing; the parent stream "helper" was no longer registered when this stream started.');
      expect(start).toContain(`- Tools: ${run.surface.length} available to this stream: `);
      expect(start).not.toContain('Compared with');
      expect(start).not.toContain("couldn't be read");
      // Created with the values resolved at the call, not the default
      // prompt and output limit a missing parent would give now.
      expect(run.systemPrompt).toBe('helper prompt');
      expect(run.maxTokens).toBe(256);
    } finally {
      await h.cleanup();
    }
  });
});

describe('the first request a fork actually sends', () => {
  // The real runEphemeralToCompletion and the mock provider: these read the
  // request the child sends, not its stored context.
  async function realHarness(opts: { parent?: Partial<AgentConfig>; module?: Partial<SubagentModuleConfig> } = {}) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'sub-orient-real-'));
    const adapter = new MockAdapter({ defaultResponse: 'all done' });
    const subagent = new SubagentModule({
      provider: 'mock', parentAgentName: 'parent', defaultModel: 'mock', maxRetries: 0, ...opts.module,
    });
    const framework = await AgentFramework.create({
      storePath: join(tmpDir, 'store'),
      membrane: new Membrane(adapter, { formatter: new NativeFormatter() }),
      agents: [{ name: 'parent', model: 'mock', systemPrompt: 'parent prompt', maxTokens: 256, ...opts.parent }],
      modules: [subagent as unknown as Module, toolModule('extra', 3)],
    });
    subagent.setFramework(framework);
    framework.start();
    return {
      adapter, subagent, framework,
      cleanup: async () => {
        await framework.stop().catch(() => {});
        rmSync(tmpDir, { recursive: true, force: true });
      },
    };
  }
  const sent = (s: string) => JSON.stringify(s).slice(1, -1);

  test('a depth-limited fork under explicit prose routing sends exactly the tools its orientation names', async () => {
    // The two rules the surface mirror applies beyond the board: the depth
    // limit's allowlist, and prose_help under explicit routing.
    const { adapter, subagent, framework, cleanup } = await realHarness({
      parent: { proseRouting: 'explicit' }, module: { maxDepth: 1 },
    });
    try {
      const input = { name: 'leaf', task: 'say done', model: 'mock-leaf', sync: true };
      seedForkCall(framework, 'toolu_leaf', input);
      const res = await subagent.handleToolCall(call('fork', 'toolu_leaf', input));
      expect(res.success).toBe(true);
      const request = adapter.getRequestLog().map((r) => r.request).find((r) => r.model === 'mock-leaf');
      expect(request).toBeDefined();
      const wire = JSON.stringify(request!.messages);
      expect(wire).toContain(sent(`- Prose routing: explicit, inherited from the parent: ${ROUTING_EFFECT.explicit}.`));
      const toolNames = (request!.tools ?? []).map((t) => (t as { name: string }).name);
      expect(toolNames).toContain('prose_help');
      expect(toolNames).toContain('subagent--return');
      expect(toolNames).not.toContain('subagent--fork');
      const parentTools = framework.listToolClasses('parent').map((t) => t.tool);
      const missing = parentTools.filter((n) => !toolNames.includes(n));
      const extra = toolNames.filter((n) => !parentTools.includes(n));
      const parts: string[] = [];
      const all = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
      if (extra.length > 0) parts.push(`it also has ${all(extra)}`);
      if (missing.length > 0) parts.push(`it doesn't have ${all(missing)}`);
      expect(wire).toContain(sent(
        `- Tools: ${toolNames.length} available to this stream. Compared with what the parent stream has now, ${parts.join(', and ')}.`,
      ));
    } finally {
      await cleanup();
    }
  });

  test('carries the orientation, and its tools are the ones the orientation names', async () => {
    const { adapter, subagent, framework, cleanup } = await realHarness();
    try {
      const input = { name: 'real', task: 'say done', model: 'mock-child', sync: true };
      seedForkCall(framework, 'toolu_real', input);
      const res = await subagent.handleToolCall(call('fork', 'toolu_real', input));
      expect(res.success).toBe(true);
      const launch = (res.data as { launch: string }).launch;

      const request = adapter.getRequestLog().map((r) => r.request).find((r) => r.model === 'mock-child');
      expect(request).toBeDefined();
      const wire = JSON.stringify(request!.messages);
      expect(wire).toContain(sent(launch));
      const toolNames = (request!.tools ?? []).map((t) => (t as { name: string }).name).sort();
      const parentTools = framework.listToolClasses('parent').map((t) => t.tool).sort();
      // The orientation said "the same set the parent stream has now"; the
      // request is the evidence that it was.
      expect(wire).toContain(sent(`- Tools: ${toolNames.length} available to this stream, the same set the parent stream has now.`));
      expect(toolNames).toEqual(parentTools);
      expect(wire).toContain(sent(CUT_AT_EXCHANGE));
    } finally {
      await cleanup();
    }
  });
});
