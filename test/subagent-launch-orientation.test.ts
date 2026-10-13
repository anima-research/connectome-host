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
import { AnthropicXmlFormatter, Membrane, MockAdapter, NativeFormatter, OpenAIResponsesFormatter } from '@animalabs/membrane';
import { SubagentModule, type SubagentModuleConfig, toolDifferences, undeliveredLaunchParts } from '../src/modules/subagent-module.js';

interface Run {
  name: string;
  /** The prose routing, output limit and system prompt the child agent
   *  was created with. */
  proseRouting: string;
  maxTokens: number;
  systemPrompt: string;
  /** The model, stream budget, strategy message cap and tool rules it was
   *  created with. The strategy's windows have no public
   *  reader. */
  model: string;
  maxStreamTokens: number;
  maxMessageTokens: number | undefined;
  allowedTools: 'all' | string[];
  /** The text the launch composed, as stored (before the message cap): a
   *  fork's tool_result message, or a spawn's or parentless fork's own
   *  messages (its orientation, then its task). Tests of what arrives read
   *  the provider's request instead. */
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
    const a = agent as {
      name: string; proseRouting: string; maxTokens: number; systemPrompt: string;
      model: string; maxStreamTokens: number; allowedTools: 'all' | string[];
      getContextManager(): { getStrategy(): unknown };
    };
    fw.agents.set(a.name, agent); // what the real run does at its start
    try {
      const { messages } = (cm as { queryMessages(q: object): { messages: Array<{ content: unknown }> } })
        .queryMessages({});
      runs.push({
        name: a.name,
        proseRouting: a.proseRouting,
        maxTokens: a.maxTokens,
        systemPrompt: a.systemPrompt,
        model: a.model,
        maxStreamTokens: a.maxStreamTokens,
        maxMessageTokens: (a.getContextManager().getStrategy() as { maxMessageTokens?: number }).maxMessageTokens,
        allowedTools: a.allowedTools,
        firstContext: launchText(messages),
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

/** What the launch composed: a fork's result message, or a spawn's or
 *  parentless fork's own messages (its orientation, then its task). */
function launchText(messages: Array<{ content: unknown }>): string {
  const last = messages[messages.length - 1]?.content;
  const isResult = Array.isArray(last) && (last as Array<{ type?: string }>).some((b) => b.type === 'tool_result');
  return isResult ? textOf(last) : messages.map((m) => textOf(m.content)).join('\n');
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
  'are as that context had them when this stream started, except that an exact repeat of an earlier ' +
  "message is dropped. The call's assistant message and its result message keep their other blocks, " +
  "with sibling fork calls and their results removed and this call's result rewritten as this message, " +
  "which comes first in its message, so if that message is over the cap, what's cut is text after it. " +
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
      expect(block).toContain('- Lineage: forked from stream "parent"; depth 1 of 3. If that stream is still registered when the fork starts, the fork inherits its compiled context: through this call\'s exchange if the call is in that context then, and otherwise all of it as it is then. If it is gone by then, the fork inherits nothing.');
      // The harness parent runs passthrough: no windows or cap to compare.
      expect(line(block, '- Against the parent at the call')).toBe(
        '- Against the parent at the call: Differs in model, strategy type and stream budget. ' +
        'Same: provider connection, system prompt, output limit, prose routing and tool rules. ' +
        "Not compared: head window, recent window, message cap and compression model (the parent doesn't report them), " +
        'and context budget (set when the stream starts).',
      );
      expect(block).toContain("- Model: mock-alt (the parent's: mock).");
      expect(block).toContain("- Provider: mock, on the same connection as the parent's.");
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

  test("a fork's extra tools are named up to ten and the rest counted; a short parent restriction is named whole", async () => {
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
      // Only the stream's own tools are named in full: tools it has beyond
      // its parent's are named up to ten, and the rest counted.
      for (const name of extra.slice(0, 10)) expect(tools).toContain(name);
      expect(tools).toContain(` and ${extra.length - 10} more`);
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
      // The orientation comes first and the task last: the stream's message
      // cap keeps a message's start, and the orientation is usually short.
      expect(run.firstContext).toStartWith("Launch of fork 'orphan'");
      expect(run.firstContext).toContain('When this intention is complete, return your findings via subagent--return. Your intention for this stream follows.\n');
      expect(run.firstContext).toEndWith('\nlist the files');
      expect(run.firstContext).toContain(block);
      const start = startSection(run.firstContext);
      expect(start).toContain('- Inherited: nothing; there is no parent stream.');
      expect(run.proseRouting).toBe('locus');
      expect(start).toContain(`- Prose routing: locus, the framework's default: ${ROUTING_EFFECT.locus}.`);
      expect(start).toContain(`- Tools: ${run.surface.length} available to this stream: `);
      for (const name of run.surface) expect(start).toContain(name);

      // Its own prompt replaces the default; with no parent there's no prompt
      // it overrides.
      const own = await h.subagent.handleToolCall(
        call('fork', 'toolu_fork_5b', { name: 'stray', task: 'list them again', systemPrompt: 'you list files' }, null),
      );
      await h.asyncPromise('stray');
      expect(launchBlock(own.data as string)).toContain('- System prompt: set for this fork.');
      expect(launchBlock(own.data as string)).not.toContain('overridden');
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

      const held = h.holdNextRun();
      const slowInput = { name: 'slow', task: 'a long thing', sync: true, timeoutMs: 50 };
      seedForkCall(h.framework, 'toolu_fork_7', slowInput);
      const detached = await h.subagent.handleToolCall(call('fork', 'toolu_fork_7', slowInput));
      expect(detached.success).toBe(true);
      const text = detached.data as string;
      expect(text).toStartWith("Subagent 'slow' moved to background.");
      // The detach fires on its timer, whether or not the run has reached the
      // stub yet, so wait for the run itself.
      await held;
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
      expect(block).toContain("- Tool rules: only subagent--return; the caller also listed time--now, which isn't offered to it at the call; the caller has no restriction.");
      expect(input.tools).toEqual(['time--now']); // the caller's array is not mutated
      const run = h.runs[0]!;
      expect(run.proseRouting).toBe('disabled');
      expect(run.firstContext).toStartWith("Launch of spawn 'probe'");
      expect(run.firstContext).toEndWith('\nprobe the harness');
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

describe("a spawn's tool rule says what the list grants", () => {
  async function ruleFor(tools: string[], module: Partial<SubagentModuleConfig> = {}, parent: Partial<AgentConfig> = {}) {
    const h = await makeHarness({ parent, module, modules: [toolModule('probe', 1)] });
    try {
      const res = await h.subagent.handleToolCall(call('spawn', `toolu_${tools.length}`, { name: 'probe', systemPrompt: 'p', task: 't', tools }));
      expect(res.success).toBe(true);
      await h.asyncPromise('probe');
      return line(launchBlock(res.data as string), '- Tool rules');
    } finally {
      await h.cleanup();
    }
  }

  test('names subagent--return once, even when the caller listed it', async () => {
    expect(await ruleFor(['probe--t1', 'subagent--return'])).toStartWith("- Tool rules: only these 2 from the caller's list, as the process offered them at the call: probe--t1 and subagent--return, subagent--return among them");
  });

  test("names a listed tool the process doesn't offer as not offered, below the depth limit too", async () => {
    expect(await ruleFor(['probe--t1', 'no-such-tool'])).toStartWith(
      "- Tool rules: only these 2 from the caller's list, as the process offered them at the call: probe--t1 and subagent--return, subagent--return among them; the caller also listed no-such-tool, which isn't offered to it at the call",
    );
  });

  test('reads an empty list as subagent--return alone', async () => {
    expect(await ruleFor([])).toStartWith('- Tool rules: only subagent--return: the caller listed no tools');
  });

  test('at the depth limit, names what the process doesn\'t offer there as dropped', async () => {
    expect(await ruleFor(['time--now'], { maxDepth: 1 })).toStartWith(
      "- Tool rules: only subagent--return; the caller also listed time--now, which isn't offered to it at the call, and none of the other subagent tools at this depth",
    );
  });

  // The process offers subagent--fork; the depth removes it.
  test('at the depth limit, names a listed subagent tool as removed by the depth, not as not offered', async () => {
    const rule = await ruleFor(['probe--t1', 'subagent--fork'], { maxDepth: 1 });
    expect(rule).toContain('; it also listed subagent--fork, which this depth removes');
    expect(rule).not.toContain("subagent--fork, which isn't offered");
  });

  // agentToolSurface adds prose_help under explicit routing, whatever the
  // list says.
  test('under explicit prose routing, a listed prose_help is not dropped, and the rule says the routing shows it', async () => {
    const rule = await ruleFor(['probe--t1', 'prose_help'], {}, { proseRouting: 'explicit' });
    expect(rule).not.toContain("prose_help, which isn't offered");
    expect(rule).toContain('; explicit prose routing shows it prose_help too, whatever the list says');
    expect(await ruleFor(['probe--t1'])).not.toContain('prose_help');
  });
});

describe('what a launch block says beyond the settings it compares', () => {
  // An empty list is no tools, not "0: ".
  test('a parent restricted to no tools is said to be', async () => {
    const h = await makeHarness({ parent: { allowedTools: [] } });
    try {
      const input = { name: 'bare', task: 't' };
      seedForkCall(h.framework, 'toolu_bare_fork', input);
      const res = await h.subagent.handleToolCall(call('fork', 'toolu_bare_fork', input));
      await h.asyncPromise('bare');
      const rule = line(launchBlock(res.data as string), '- Tool rules');
      expect(rule).toEndWith('; the parent is restricted to no tools.');
      expect(rule).not.toContain('0: ');
    } finally {
      await h.cleanup();
    }
  });

  // The stream's agent is built from the launch alone, so its agent settings
  // are the framework's defaults. The start block sets them against the
  // parent's, naming only what differs.
  test('a fork names the agent settings it does not carry from its parent, with the parent\'s', async () => {
    const h = await makeHarness({ parent: {
      thinking: { enabled: true, budgetTokens: 2048 },
      providerParams: { reasoning: { effort: 'high' } },
      promptCaching: false,
    } });
    try {
      const input = { name: 'plain', task: 't' };
      seedForkCall(h.framework, 'toolu_plain', input);
      await h.subagent.handleToolCall(call('fork', 'toolu_plain', input));
      await h.asyncPromise('plain');
      const start = startSection(h.runs.find((r) => r.name.startsWith('plain-'))!.firstContext);
      const settings = line(start, '- Agent settings');
      expect(settings).toStartWith(
        "- Agent settings not carried from the parent stream, so the framework's defaults apply: " +
          "extended thinking off (the parent stream's: enabled), provider parameters none (the parent stream's: set (reasoning)), " +
          "prompt caching on (the parent stream's: off). The rest match: ",
      );
      expect(settings).toContain('tool-wrapper prose guard');
    } finally {
      await h.cleanup();
    }
  });

  test('a fork from a parent on the defaults says they match', async () => {
    const h = await makeHarness({});
    try {
      const input = { name: 'same', task: 't' };
      seedForkCall(h.framework, 'toolu_same', input);
      await h.subagent.handleToolCall(call('fork', 'toolu_same', input));
      await h.asyncPromise('same');
      const start = startSection(h.runs.find((r) => r.name.startsWith('same-'))!.firstContext);
      expect(line(start, '- Agent settings')).toStartWith(
        "- Agent settings: the framework's defaults, the same as the parent stream's now (extended thinking, provider parameters, ",
      );
    } finally {
      await h.cleanup();
    }
  });
});

describe('a host that states no provider', () => {
  for (const parent of [undefined, null] as const) {
    test(`is described as not stating it, rather than as any provider's (${parent === null ? 'no parent' : 'with a parent'})`, async () => {
      const h = await makeHarness({ module: { provider: undefined }, ...(parent === null ? { parent: null } : {}) });
      try {
        const input = { name: 'probe', systemPrompt: 'p', task: 't' };
        const res = await h.subagent.handleToolCall(call('spawn', 'toolu_np', input, parent === null ? null : 'parent'));
        await h.asyncPromise('probe');
        expect(line(launchBlock(res.data as string), '- Provider')).toBe(
          parent === null ? '- Provider: not stated by the host.' : "- Provider: not stated by the host, on the same connection as the caller's.",
        );
      } finally {
        await h.cleanup();
      }
    });
  }
});

describe('a module without its framework yet', () => {
  test('is built with no config, and answers a launch with an error rather than a throw', async () => {
    const bare = new SubagentModule();
    const res = await bare.handleToolCall(call('spawn', 'toolu_bare', { name: 'early', systemPrompt: 'p', task: 't' }));
    expect(res.success).toBe(false);
    // The missing framework is the reason, not any error.
    expect(String(res.error)).toStartWith("Couldn't spawn 'early': SubagentModule: framework not set.");
    const forked = await bare.handleToolCall(call('fork', 'toolu_bare_fork', { name: 'early-fork', task: 't' }));
    expect(String(forked.error)).toStartWith("Couldn't fork 'early-fork': SubagentModule: framework not set.");
  });
});

describe('a queued launch', () => {
  /** A knowledge parent with its own windows (Kit's review probe). */
  const probeParent: Partial<AgentConfig> = {
    maxStreamTokens: 500_000,
    contextBudgetTokens: 220_000,
    strategy: new KnowledgeStrategy({ headWindowTokens: 19_000, recentWindowTokens: 41_000, maxMessageTokens: 17_000 }),
  };

  async function queueBehindAHeldFork(h: Awaited<ReturnType<typeof makeHarness>>) {
    const held = h.holdNextRun();
    const first = { name: 'first', task: 'hold the slot' };
    seedForkCall(h.framework, 'toolu_first', first);
    await h.subagent.handleToolCall(call('fork', 'toolu_first', first));
    await held;
  }

  test('structural: keeps the call\'s inputs, cuts at the call, and states the budget as created', async () => {
    const h = await makeHarness({ parent: probeParent, module: { maxConcurrent: 1 } });
    try {
      await queueBehindAHeldFork(h);
      const second = { name: 'second', task: 'wait your turn' };
      seedForkCall(h.framework, 'toolu_second', second);
      const res = await h.subagent.handleToolCall(call('fork', 'toolu_second', second));
      const receipt = res.data as string;
      expect(receipt).toStartWith("Subagent 'second' forked. Every subagent slot (1) is in use, so it waits for one to free, for up to 120 s; if none does, it ends with an error, delivered as its result would be.");
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
        "- Inherited: the parent's whole compiled context as it was when this stream started, because the fork call wasn't in that context. It can include turns that came after the call. An exact repeat of an earlier message is dropped.",
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
      const parent = h.framework.getAgent('parent')! as unknown as {
        maxTokens: number; proseRouting: string; systemPrompt: string; model: string; maxStreamTokens: number;
      };
      parent.maxTokens = 999;
      parent.proseRouting = 'disabled';
      parent.systemPrompt = 'changed prompt';
      parent.model = 'changed-model';
      parent.maxStreamTokens = 777_000;

      h.releaseHeld();
      await h.asyncPromise('first');
      await h.asyncPromise('second');
      await h.asyncPromise('third');

      for (const [prefix, receipt] of [['second-', forkReceipt], ['spawn-third-', spawnReceipt]] as const) {
        const run = h.runs.find((r) => r.name.startsWith(prefix))!;
        expect(launchBlock(receipt)).toContain('- Output limit: 256 tokens, the same as ');
        expect(run.maxTokens).toBe(256);
        expect(run.proseRouting).toBe('hybrid');
        // The rest of the launch, too.
        expect(run.model).toBe('mock');
        expect(run.maxStreamTokens).toBe(500_000);
        expect(run.maxMessageTokens).toBe(10_000);
        expect(run.allowedTools).toBe('all');
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
      expect(run.firstContext).toStartWith("Launch of fork 'child'");
      expect(run.firstContext).toEndWith('Your intention for this stream follows.\noutlive the caller');
      expect(run.firstContext).toContain(block);
      expect(run.allText).not.toContain('please look into it');
      const start = startSection(run.firstContext);
      expect(start).toContain('- Inherited: nothing; the parent stream "helper" was no longer registered when this stream started.');
      expect(line(start, '- Agent settings')).toEndWith('; not compared, since the parent stream was no longer registered when this stream started.');
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

  // A spawn's Tools line lists its surface in full, and the request it sends
  // must carry exactly those, prose_help under explicit routing included.
  test('a spawn with a tool the board offers sends exactly the tools its orientation lists', async () => {
    const { adapter, subagent, cleanup } = await realHarness({ parent: { proseRouting: 'explicit' } });
    try {
      const input = { name: 'worker', systemPrompt: 'p', task: 'say done', model: 'mock-spawn', sync: true, tools: ['extra--t1'] };
      const res = await subagent.handleToolCall(call('spawn', 'toolu_worker', input));
      expect(res.success).toBe(true);
      const request = adapter.getRequestLog().map((r) => r.request).find((r) => r.model === 'mock-spawn');
      expect(request).toBeDefined();
      const toolNames = (request!.tools ?? []).map((t) => (t as { name: string }).name);
      expect([...toolNames].sort()).toEqual(['extra--t1', 'prose_help', 'subagent--return']);
      const wire = JSON.stringify(request!.messages);
      const toolsLine = wire.split('\\n').find((l) => l.startsWith('- Tools: '));
      expect(toolsLine).toBeDefined();
      expect(toolsLine).toStartWith(`- Tools: ${toolNames.length} available to this stream: `);
      for (const name of toolNames) expect(toolsLine).toContain(name);
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

describe('what a stream first reads is what its launch promises', () => {
  /** The real framework and a mock provider, so a test reads the request
   *  the provider actually receives. `tools` adds that many tools to the
   *  board, for an orientation longer than one message. */
  async function realHarness(opts: {
    parentless?: boolean;
    tools?: number;
    maxPromptTokens?: number;
    maxRetries?: number;
    formatter?: 'anthropic-xml' | 'openai-responses';
  } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'launch-delivered-'));
    const adapter = new MockAdapter({ defaultResponse: 'done' });
    const subagent = new SubagentModule({
      provider: 'mock', defaultModel: 'mock', maxRetries: opts.maxRetries ?? 0,
      ...(opts.parentless ? {} : { parentAgentName: 'parent' }),
      ...(opts.maxPromptTokens !== undefined ? { maxPromptTokens: opts.maxPromptTokens } : {}),
    });
    const bulk: Module = {
      name: 'bulk',
      getTools: () => Array.from({ length: opts.tools ?? 0 }, (_, i) => ({
        name: bulkName(i),
        description: 'x',
        inputSchema: { type: 'object' as const, properties: {} },
      })),
      start: async () => {},
      stop: async () => {},
      handleToolCall: async () => ({ success: false, error: 'no' }),
      onProcess: async () => ({}),
    };
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new Membrane(adapter, {
        formatter: opts.formatter === 'anthropic-xml'
          ? new AnthropicXmlFormatter()
          : opts.formatter === 'openai-responses' ? new OpenAIResponsesFormatter() : new NativeFormatter(),
      }),
      agents: [{ name: 'parent', model: 'mock', systemPrompt: 'p', maxTokens: 256 }],
      modules: [subagent as never, ...(opts.tools ? [bulk] : [])],
    });
    subagent.setFramework(framework);
    framework.start();
    const requestFor = (model: string) => adapter.getRequestLog().map((r) => r.request).find((r) => r.model === model);
    return {
      framework, subagent, requestFor,
      cleanup: async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); },
    };
  }

  // Longer than one message holds (10,000 tokens; the cap keeps a message's start).
  const LONG_TASK = 'Inspect this supplied work item. '.repeat(3000);
  const bulkName = (i: number) => `bulk--a-tool-with-a-long-enough-name-to-fill-an-orientation-${i}`;

  test('a long task: a spawn and a parentless fork are refused, saying why and what to do, and nothing is sent', async () => {
    for (const kind of ['spawn', 'parentless'] as const) {
      const h = await realHarness({ parentless: kind === 'parentless' });
      try {
        const model = `mock-${kind}`;
        const result = await h.subagent.handleToolCall({
          id: 'call-1', name: kind === 'spawn' ? 'spawn' : 'fork',
          input: { name: `long-${kind}`, task: LONG_TASK, model, sync: true, ...(kind === 'spawn' ? { systemPrompt: 'p' } : {}) },
          ...(kind === 'spawn' ? { callerAgentName: 'parent' } : {}),
        } as never);
        expect(result.success).toBe(false);
        expect(String(result.error)).toBe(
          `Subagent long-${kind} wasn't launched: its task is longer than one message holds (10,000 tokens): ` +
          `shorten or split it, or put the detail in a file, ${kind === 'spawn' ? 'give the spawn a tool that can read it' : 'make sure its tools can read it'}, and pass the path.`,
        );
        expect(h.requestFor(model)).toBeUndefined();
      } finally {
        await h.cleanup();
      }
    }
  });

  test('a long task: a structural fork launches, its first request carrying its orientation whole and its task in its fork call', async () => {
    const h = await realHarness();
    try {
      const input = { name: 'long-structural', task: LONG_TASK, model: 'mock-structural', sync: true };
      const cm = h.framework.getAgent('parent')!.getContextManager();
      cm.addMessage('user', [{ type: 'text', text: 'begin' }]);
      cm.addMessage('parent', [{ type: 'tool_use', id: 'fork-point', name: 'subagent--fork', input }] as never);
      const result = await h.subagent.handleToolCall({ id: 'fork-point', name: 'fork', input, callerAgentName: 'parent' } as never);
      expect(result.success).toBe(true);
      const wire = JSON.stringify(h.requestFor('mock-structural')!.messages);
      expect(wire).toContain("Launch of fork 'long-structural'");
      expect(wire).toContain('At the start of this stream:');
      expect(wire).toContain('When this intention is complete, return your findings via subagent--return');
      // The whole task rides in the inherited fork call.
      expect(wire).toContain(JSON.stringify(LONG_TASK).slice(1, -1));
    } finally {
      await h.cleanup();
    }
  });

  test('an orientation longer than one message: refused for it, a spawn told to shorten its list and a fork to spawn with one', async () => {
    // A spawn names its whole surface, and so does a fork with no parent
    // stream to compare against (one with a parent names only differences).
    const h = await realHarness({ tools: 900 });
    try {
      const spawn = await h.subagent.handleToolCall({
        id: 'call-s', name: 'spawn', callerAgentName: 'parent',
        input: { name: 'wide-spawn', task: 'short', systemPrompt: 'p', model: 'mock-wide-spawn', sync: true },
      } as never);
      expect(spawn.success).toBe(false);
      // The short task is its own message, so it arrives, and only the orientation is named.
      expect(String(spawn.error)).toBe(
        "Subagent wide-spawn wasn't launched: its orientation, which names the spawn's tools in full, is longer than one message holds (10,000 tokens): give the spawn a shorter tools list.",
      );
      expect(h.requestFor('mock-wide-spawn')).toBeUndefined();
    } finally {
      await h.cleanup();
    }
    const p = await realHarness({ parentless: true, tools: 900 });
    try {
      const fork = await p.subagent.handleToolCall({
        id: 'call-f', name: 'fork',
        input: { name: 'wide-fork', task: 'short', model: 'mock-wide-fork', sync: true },
      } as never);
      expect(fork.success).toBe(false);
      // With no parent there is no context to lose by spawning instead.
      expect(String(fork.error)).toBe(
        "Subagent wide-fork wasn't launched: its orientation is longer than one message holds (10,000 tokens): launch it as subagent--spawn with a short tools list instead.",
      );
      expect(p.requestFor('mock-wide-fork')).toBeUndefined();
    } finally {
      await p.cleanup();
    }
  });

  test('a fork whose surface matches its parent\'s says so in a line, so a wide board still launches', async () => {
    const h = await realHarness({ tools: 900 });
    try {
      const result = await h.subagent.handleToolCall({
        id: 'call-p', name: 'fork', callerAgentName: 'parent',
        input: { name: 'wide-parented', task: 'short', model: 'mock-wide-parented', sync: true },
      } as never);
      expect(result.success).toBe(true);
      expect(JSON.stringify(h.requestFor('mock-wide-parented')!.messages)).toContain('the same set the parent stream has now');
    } finally {
      await h.cleanup();
    }
  });

  // A size refusal is the launch's outcome too, so it's never retried. Its
  // text holds the subagent's name, and the retry gate reads that name's
  // "idle" as transient.
  for (const kind of ['spawn', 'fork'] as const) {
    test(`a ${kind}'s size check refuses a launch over the limit once, without a retry`, async () => {
      const h = await realHarness({ maxPromptTokens: 1, maxRetries: 2 });
      const attempts = countAttempts(h.framework);
      try {
        const input = { name: `sized-idle-${kind}`, task: 'short', model: `mock-sized-idle-${kind}`, sync: true, ...(kind === 'spawn' ? { systemPrompt: 'p' } : {}) };
        if (kind === 'fork') {
          const cm = h.framework.getAgent('parent')!.getContextManager();
          cm.addMessage('user', [{ type: 'text', text: 'begin' }]);
          cm.addMessage('parent', [{ type: 'tool_use', id: 'fork-point', name: 'subagent--fork', input }] as never);
        }
        const result = await h.subagent.handleToolCall({ id: 'fork-point', name: kind, input, callerAgentName: 'parent' } as never);
        expect(result.success).toBe(false);
        expect(String(result.error)).toContain(`Prompt too large for subagent sized-idle-${kind}: ~`);
        expect(String(result.error)).toContain('its orientation included (limit: 1)');
        expect(attempts.count).toBe(1);
      } finally {
        await h.cleanup();
      }
    });
  }

  test("a long task: a fallback fork launches, its own result's head whole and its whole task in its own call", async () => {
    const h = await realHarness();
    try {
      // The call isn't in the parent's context, so the fork takes the fallback path.
      const result = await h.subagent.handleToolCall({
        id: 'not-in-context', name: 'fork', callerAgentName: 'parent',
        input: { name: 'long-fallback', task: LONG_TASK, model: 'mock-fallback', sync: true },
      } as never);
      expect(result.success).toBe(true);
      const messages = h.requestFor('mock-fallback')!.messages as unknown as Array<{ content: unknown }>;
      const wire = JSON.stringify(messages);
      expect(wire).toContain("Launch of fork 'long-fallback'");
      expect(wire).toContain('When this intention is complete, return your findings via subagent--return');
      const call = messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []) as Array<{ type?: string; name?: string; input?: { task?: string } }>)
        .find((b) => b.type === 'tool_use' && b.name === 'subagent--fork');
      expect(call?.input?.task).toBe(LONG_TASK);
    } finally {
      await h.cleanup();
    }
  });

  test("a structural fork whose turn returned a long result before its own: its result leads the message, so it launches oriented", async () => {
    const h = await realHarness();
    try {
      const input = { name: 'after-a-read', task: 'short', model: 'mock-after-a-read', sync: true };
      const cm = h.framework.getAgent('parent')!.getContextManager();
      cm.addMessage('user', [{ type: 'text', text: 'begin' }]);
      cm.addMessage('parent', [
        { type: 'tool_use', id: 'read-1', name: 'files--read', input: { path: 'big' } },
        { type: 'tool_use', id: 'fork-point', name: 'subagent--fork', input },
      ] as never);
      cm.addMessage('user', [
        { type: 'tool_result', toolUseId: 'read-1', content: 'x'.repeat(45_000) },
        { type: 'tool_result', toolUseId: 'fork-point', content: 'forked' },
      ] as never);
      const result = await h.subagent.handleToolCall({ id: 'fork-point', name: 'fork', input, callerAgentName: 'parent' } as never);
      expect(result.success).toBe(true);
      const wire = JSON.stringify(h.requestFor('mock-after-a-read')!.messages);
      expect(wire).toContain("Launch of fork 'after-a-read'");
      expect(wire).toContain('Your intention for this stream: short');
    } finally {
      await h.cleanup();
    }
  });

  test('an async launch answers with its receipt, and a refusal reaches the caller afterwards as its failure notice', async () => {
    const h = await realHarness();
    try {
      const failures: Array<{ name: string; message: string }> = [];
      let delivered!: () => void;
      const notice = new Promise<void>((resolve) => { delivered = resolve; });
      const internals = h.subagent as unknown as {
        deliverAsyncError(name: string, err: unknown, parent: string): void;
      };
      const deliver = internals.deliverAsyncError.bind(h.subagent);
      internals.deliverAsyncError = (name, err, parent) => {
        failures.push({ name, message: err instanceof Error ? err.message : String(err) });
        deliver(name, err, parent);
        delivered();
      };
      const result = await h.subagent.handleToolCall({
        id: 'call-async', name: 'spawn', callerAgentName: 'parent',
        input: { name: 'long-async', task: LONG_TASK, systemPrompt: 'p', model: 'mock-long-async' },
      } as never);
      expect(result.success).toBe(true);
      await notice;
      expect(failures).toEqual([{
        name: 'long-async',
        message: "Subagent long-async wasn't launched: its task is longer than one message holds (10,000 tokens): " +
          'shorten or split it, or put the detail in a file, give the spawn a tool that can read it, and pass the path.',
      }]);
      expect(h.requestFor('mock-long-async')).toBeUndefined();
    } finally {
      await h.cleanup();
    }
  });

  /** Counts the streams a launch creates: one per attempt. */
  const countAttempts = (framework: AgentFramework) => {
    const fw = framework as unknown as { createEphemeralAgent: (...args: unknown[]) => Promise<unknown> };
    const create = fw.createEphemeralAgent.bind(framework);
    const attempts = { count: 0 };
    fw.createEphemeralAgent = (...args: unknown[]) => { attempts.count++; return create(...args); };
    return attempts;
  };

  test("a refusal is never retried, even when its text holds a word the retry gate reads as transient", async () => {
    const h = await realHarness({ maxRetries: 2 });
    try {
      const attempts = countAttempts(h.framework);
      const result = await h.subagent.handleToolCall({
        id: 'call-idle', name: 'spawn', callerAgentName: 'parent',
        input: { name: 'idle-network-503', task: LONG_TASK, systemPrompt: 'p', model: 'mock-idle', sync: true },
      } as never);
      expect(result.success).toBe(false);
      expect(String(result.error)).toStartWith("Subagent idle-network-503 wasn't launched: its task is longer");
      expect(attempts.count).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test('an orientation and a task that each fit a message launch together, each in its own message', async () => {
    // An orientation of 30,036 characters (25,888 of them tool names) and
    // a 20,761-character task: each under the 40,000-character cap,
    // together over it.
    const h = await realHarness({ tools: 400 });
    try {
      const task = `${'Read the supplied notes. '.repeat(830)}END-OF-TASK`;
      const result = await h.subagent.handleToolCall({
        id: 'call-both', name: 'spawn', callerAgentName: 'parent',
        input: { name: 'both-fit', task, systemPrompt: 'p', model: 'mock-both-fit', sync: true },
      } as never);
      expect(result.success).toBe(true);
      const wire = JSON.stringify(h.requestFor('mock-both-fit')!.messages);
      expect(wire).toContain("Launch of spawn 'both-fit'");
      expect(wire).toContain(bulkName(399));
      expect(wire).toContain('END-OF-TASK');
      expect(wire).not.toContain('[truncated');
    } finally {
      await h.cleanup();
    }
  });

  test('a parentless fork\'s orientation and task each fit a message and launch together, each in its own message', async () => {
    const h = await realHarness({ parentless: true, tools: 400 });
    try {
      const task = `${'Read the supplied notes. '.repeat(830)}END-OF-TASK`;
      const result = await h.subagent.handleToolCall({
        id: 'call-both-fork', name: 'fork',
        input: { name: 'both-fit-fork', task, model: 'mock-both-fit-fork', sync: true },
      } as never);
      expect(result.success).toBe(true);
      const wire = JSON.stringify(h.requestFor('mock-both-fit-fork')!.messages);
      expect(wire).toContain("Launch of fork 'both-fit-fork'");
      expect(wire).toContain(bulkName(399));
      expect(wire).toContain('Your intention for this stream follows.');
      expect(wire).toContain('END-OF-TASK');
      expect(wire).not.toContain('[truncated');
    } finally {
      await h.cleanup();
    }
  });

  // The native formatter merges the two messages into one user turn; these
  // two formatters send them as two consecutive user turns. Either way the
  // stream reads both whole.
  for (const formatter of ['anthropic-xml', 'openai-responses'] as const) {
    test(`under the ${formatter} formatter, a spawn's orientation and task both reach the provider whole`, async () => {
      const h = await realHarness({ tools: 400, formatter });
      try {
        const task = `${'Read the supplied notes. '.repeat(830)}END-OF-TASK`;
        const result = await h.subagent.handleToolCall({
          id: 'call-fmt', name: 'spawn', callerAgentName: 'parent',
          input: { name: 'formatted', task, systemPrompt: 'p', model: 'mock-formatted', sync: true },
        } as never);
        expect(result.success).toBe(true);
        const wire = JSON.stringify(h.requestFor('mock-formatted'));
        expect(wire).toContain("Launch of spawn 'formatted'");
        expect(wire).toContain(bulkName(399));
        expect(wire).toContain('END-OF-TASK');
        expect(wire).not.toContain('[truncated');
      } finally {
        await h.cleanup();
      }
    });
  }

  test("a fork with a call, which would inherit its parent's context, is told that a spawn inherits none of it", () => {
    const subagent = new SubagentModule({ provider: 'mock', defaultModel: 'mock' });
    const refuse = (subagent as unknown as {
      launchRefusal(kind: 'spawn' | 'fork', name: string, cut: string[], delivery: unknown): Error;
    }).launchRefusal.bind(subagent);
    const withCall = { kind: 'fork-result', callId: 'c', head: 'HEAD', task: 'TASK' };
    const ownMessages = { kind: 'message', orientation: 'ORIENT', taskBlock: 'TASK' };
    expect(refuse('fork', 'f', ['orientation'], ownMessages).message).toBe(
      "Subagent f wasn't launched: its orientation is longer than one message holds (10,000 tokens): " +
      'launch it as subagent--spawn with a short tools list instead.',
    );
    expect(refuse('fork', 'f', ['orientation'], withCall).message).toBe(
      "Subagent f wasn't launched: its orientation is longer than one message holds (10,000 tokens): " +
      'launch it as subagent--spawn with a short tools list instead, though a spawn inherits none of this context.',
    );
    expect(refuse('fork', 'f', ['call'], withCall).message).toBe(
      "Subagent f wasn't launched: the fork call that carries its task isn't in the context it would start from: " +
      'launch it as subagent--spawn with the task instead.',
    );
    expect(refuse('spawn', 's', ['orientation', 'task'], ownMessages).message).toContain('give the spawn a shorter tools list; and its task is longer');
  });

  test('a refusal leaves the rate-limit backoff alone, even when its text holds "rate"', async () => {
    for (const kind of ['spawn', 'parentless'] as const) {
      const h = await realHarness({ parentless: kind === 'parentless' });
      const state = h.subagent as unknown as { rateLimitCooldownMs: number; effectiveConcurrent: number; lastRateLimitAt: number };
      state.rateLimitCooldownMs = 0;
      try {
        const before = state.effectiveConcurrent;
        // "generate" holds "rate".
        const result = await h.subagent.handleToolCall({
          id: 'call-rate', name: kind === 'spawn' ? 'spawn' : 'fork',
          input: { name: 'generate-report', task: LONG_TASK, model: `mock-rate-${kind}`, sync: true, ...(kind === 'spawn' ? { systemPrompt: 'p' } : {}) },
          ...(kind === 'spawn' ? { callerAgentName: 'parent' } : {}),
        } as never);
        expect(result.success).toBe(false);
        expect(h.requestFor(`mock-rate-${kind}`)).toBeUndefined();
        expect(state.effectiveConcurrent).toBe(before);
        expect(state.lastRateLimitAt).toBe(0);
      } finally {
        await h.cleanup();
      }
    }
  });

  test('a short task and a modest surface launch as before, the orientation first and the task last', async () => {
    const h = await realHarness();
    try {
      const result = await h.subagent.handleToolCall({
        id: 'call-ok', name: 'spawn', callerAgentName: 'parent',
        input: { name: 'fine', task: 'list the files', systemPrompt: 'p', model: 'mock-fine', sync: true },
      } as never);
      expect(result.success).toBe(true);
      const first = h.requestFor('mock-fine')!.messages.find((m) => JSON.stringify(m).includes('list the files'))!;
      const text = JSON.stringify(first);
      expect(text.indexOf("Launch of spawn 'fine'")).toBeGreaterThanOrEqual(0);
      expect(text.indexOf("Launch of spawn 'fine'")).toBeLessThan(text.indexOf('list the files'));
    } finally {
      await h.cleanup();
    }
  });
});

describe('lists about another stream are named in part, so only the stream\'s own tools can make its orientation long', () => {
  async function harness(parentAllowed: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'launch-lists-'));
    const names = Array.from({ length: 900 }, (_, i) => `bulk--a-tool-with-a-long-enough-name-to-fill-an-orientation-${i}`);
    const adapter = new MockAdapter({ defaultResponse: 'done' });
    const subagent = new SubagentModule({ provider: 'mock', defaultModel: 'mock', parentAgentName: 'parent', maxRetries: 0 });
    const bulk: Module = {
      name: 'bulk',
      getTools: () => names.map((name) => ({ name, description: 'x', inputSchema: { type: 'object' as const, properties: {} } })),
      start: async () => {},
      stop: async () => {},
      handleToolCall: async () => ({ success: false, error: 'no' }),
      onProcess: async () => ({}),
    };
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new Membrane(adapter, { formatter: new NativeFormatter() }),
      agents: [{ name: 'parent', model: 'mock', systemPrompt: 'p', maxTokens: 256, allowedTools: parentAllowed === undefined ? undefined : [...parentAllowed] } as AgentConfig],
      modules: [subagent as never, bulk],
    });
    subagent.setFramework(framework);
    framework.start();
    const requestFor = (model: string) => adapter.getRequestLog().map((r) => r.request).find((r) => r.model === model);
    return { names, subagent, requestFor, cleanup: async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); } };
  }

  test("a caller restricted to 902 tools: a spawn with a short list launches, its orientation counting the rest of the caller's list", async () => {
    const all = Array.from({ length: 900 }, (_, i) => `bulk--a-tool-with-a-long-enough-name-to-fill-an-orientation-${i}`);
    const h = await harness([...all, 'subagent--spawn', 'subagent--fork']);
    try {
      for (const tools of [['subagent--return'], []]) {
        const name = tools.length ? 'single' : 'empty';
        const result = await h.subagent.handleToolCall({
          id: name, name: 'spawn', callerAgentName: 'parent',
          input: { name, model: `mock-${name}`, systemPrompt: 'p', task: 't', sync: true, tools },
        } as never);
        expect(result.success).toBe(true);
        const wire = JSON.stringify(h.requestFor(`mock-${name}`)!.messages);
        expect(wire).toContain('the caller is restricted to 902: bulk--a-tool-with-a-long-enough-name-to-fill-an-orientation-0, ');
        expect(wire).toContain(' and 892 more');
      }
    } finally {
      await h.cleanup();
    }
  });

  test("a fork of a restricted parent has the whole board: its orientation names how it differs in part, and it launches", async () => {
    const h = await harness(['subagent--fork', 'subagent--return']);
    try {
      const result = await h.subagent.handleToolCall({
        id: 'call-r', name: 'fork', callerAgentName: 'parent',
        input: { name: 'from-narrow', task: 'short', model: 'mock-from-narrow', sync: true },
      } as never);
      expect(result.success).toBe(true);
      const wire = JSON.stringify(h.requestFor('mock-from-narrow')!.messages);
      expect(wire).toMatch(/it also has [^"]* and \d+ more/);
    } finally {
      await h.cleanup();
    }
  });
});

describe('what counts as delivered: each shape\'s own carriers, whole', () => {
  const text = (t: string) => ({ type: 'text', text: t });
  const msgs = (...content: unknown[]) => [{ content: content as never }];

  test('a spawn or parentless fork: the orientation and the task text, each whole', () => {
    const delivery = { kind: 'message' as const, orientation: 'ORIENT', taskBlock: 'TASK' };
    expect(undeliveredLaunchParts([...msgs(text('ORIENT')), ...msgs(text('TASK'))], delivery)).toEqual([]);
    expect(undeliveredLaunchParts([...msgs(text('ORI\n\n[truncated]')), ...msgs(text('TASK'))], delivery)).toEqual(['orientation']);
    expect(undeliveredLaunchParts([...msgs(text('ORIENT')), ...msgs(text('TA\n\n[truncated]'))], delivery)).toEqual(['task']);
    expect(undeliveredLaunchParts([...msgs(text('ORI[truncated]')), ...msgs(text('TA[truncated]'))], delivery)).toEqual(['orientation', 'task']);
    // The task's words elsewhere aren't its text.
    expect(undeliveredLaunchParts(msgs(text('ORIENT mentions TASK')), { ...delivery, orientation: 'ORIENT mentions TASK' })).toEqual(['task']);
  });

  test("a fork: its own result's head, and the whole task in its own call, found by the call's id", () => {
    const delivery = { kind: 'fork-result' as const, callId: 'c1', head: 'HEAD', task: 'TASK' };
    const call = (id: string, task: string) => ({ type: 'tool_use', id, name: 'subagent--fork', input: { task } });
    const result = (id: string, content: string) => ({ type: 'tool_result', toolUseId: id, content });
    expect(undeliveredLaunchParts([...msgs(call('c1', 'TASK')), ...msgs(result('c1', 'HEAD\n\nYour intention for this stream: TA[truncated]'))], delivery)).toEqual([]);
    expect(undeliveredLaunchParts([...msgs(call('c1', 'TASK')), ...msgs(result('c1', 'HE[truncated]'))], delivery)).toEqual(['orientation']);
    // Another call carrying the same task isn't this fork's call.
    expect(undeliveredLaunchParts([...msgs(call('other', 'TASK')), ...msgs(result('c1', 'HEAD'))], delivery)).toEqual(['call']);
    // Another result's head isn't this fork's result.
    expect(undeliveredLaunchParts([...msgs(call('c1', 'TASK')), ...msgs(result('other', 'HEAD'))], delivery)).toEqual(['orientation']);
  });
});

describe("a fork's tools set against its parent's", () => {
  const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);

  test('every tool it lacks is named, however many; the tools it has beyond the parent\'s are named up to ten', () => {
    const text = toolDifferences(names('extra', 15), names('lacks', 15));
    for (const name of names('extra', 10)) expect(text).toContain(name);
    expect(text).not.toContain('extra-10');
    expect(text).toContain('extra-9 and 5 more');
    for (const name of names('lacks', 15)) expect(text).toContain(name);
    expect(text).toEndWith('lacks-13 and lacks-14');
  });
});
