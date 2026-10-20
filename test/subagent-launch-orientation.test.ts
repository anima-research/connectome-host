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
 * context. Two describe blocks, 'the first request a fork actually sends'
 * and 'what a stream first reads is what its launch promises', run the
 * real one against the mock provider and read the first request the child
 * actually sends.
 */
import { describe, test, expect, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, KnowledgeStrategy } from '@animalabs/agent-framework';
import type { Module, ToolCall, AgentConfig } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { recipeFormatter } from '../src/recipe-formatter.js';
import type { Recipe } from '../src/recipe.js';
import {
  SubagentModule, type SubagentModuleConfig, type SubagentLaunch, agentSettingsOf, describeSubagentStart, toolDifferences, undeliveredLaunchParts,
} from '../src/modules/subagent-module.js';

// Most tests here build subagent harnesses and run launches through them,
// which is CPU work that a busy machine can slow many times over. The limit
// is there to catch a hang, not slowness, so it's longer than bun's 5 s
// default. bun applies it to every test in this file, and to no other file.
setDefaultTimeout(20_000);

interface Run {
  name: string;
  /** The prose routing, output limit and system prompt the child agent
   *  was created with. */
  proseRouting: string;
  maxTokens: number;
  systemPrompt: string;
  /** The model, stream budget, strategy message cap and tool rules it was
   *  created with. */
  model: string;
  maxStreamTokens: number;
  maxMessageTokens: number | undefined;
  /** The strategy's windows, compression model and auto-tick as created.
   *  They have no public reader, so they're read from the strategy's own
   *  config (context-manager 0.14.1's AutobiographicalStrategy). */
  strategyConfig: { headWindowTokens?: number; recentWindowTokens?: number; compressionModel?: string; autoTickOnNewMessage?: boolean };
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

/** A created strategy's windows, compression model and auto-tick. */
function strategyConfigOf(strategy: unknown): Run['strategyConfig'] {
  const config = (strategy as { config?: Record<string, unknown> }).config ?? {};
  return {
    headWindowTokens: config.headWindowTokens as number | undefined,
    recentWindowTokens: config.recentWindowTokens as number | undefined,
    compressionModel: config.compressionModel as string | undefined,
    autoTickOnNewMessage: config.autoTickOnNewMessage as boolean | undefined,
  };
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
        strategyConfig: strategyConfigOf(a.getContextManager().getStrategy()),
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
  "message is dropped, and this stream's own strategy caps and selects them as it does every message. " +
  "The call's assistant message keeps its other blocks, with sibling fork calls removed. Its result " +
  "message keeps the turn's other results, with sibling forks' results removed, and leads with this " +
  "call's result rewritten as this message, so if that message is over the cap, what's cut is what comes " +
  "after it. If the parent's context held no result message for the call, one is made holding this " +
  "call's result alone. No other message after the call is included.";

/** What the orientation says each prose-routing mode does with plain text. */
const ROUTING_EFFECT = {
  locus: 'plain text is published to the channel the framework infers for each turn, if there is one',
  explicit: 'plain text is delivered only with a destination prefix line, such as ">>#channel"',
  hybrid: 'unprefixed plain text is published to the channel the framework infers for each turn, if there is one; ' +
    'a leading ">>>destination" envelope routes that text to the destination it names instead',
  disabled: 'plain text is never published, even with a prefix; only explicit send tools reach a channel',
} as const;
/** What explicit routing's line adds for a stream that is shown prose_help. */
const PROSE_HELP = '; the prose_help tool shows the syntax';

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
      expect(receipt).toStartWith("Subagent 'scout' accepted as a fork. Starting in background.");
      await h.asyncPromise('scout');

      const block = launchBlock(receipt);
      expect(block).toContain("Launch of fork 'scout', as resolved at its subagent--fork call (toolu_fork_1):");
      // The receipt describes the intended lineage, not which path will run.
      expect(block).toContain('- Lineage: forked from stream "parent"; depth 1 of 3. When the fork starts, it inherits that stream\'s compiled context, even if the stream has ended by then: through this call\'s exchange if the call is in that context then, and otherwise all of it as it is then.');
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
      expect(block).toContain("- Head window: 2,000 tokens (the parent's isn't reported).");
      expect(block).toContain("- Compression model: mock-alt (the parent's isn't reported).");
      expect(block).toContain("- Output limit: 256 tokens, the same as the parent's.");
      // The harness parent sets no mode, so it runs the framework's default.
      expect(block).toContain(`- Prose routing: locus, inherited from the parent: ${ROUTING_EFFECT.locus}.`);
      expect(block).toContain("summary text already in the parent's compiled context comes with that context");
      expect(block).not.toContain('Matches');

      const run = h.runs[0]!;
      expect(run.proseRouting).toBe('locus');
      // The stream's strategy is created with the windows and compression model its block states.
      expect(run.strategyConfig).toStrictEqual({
        headWindowTokens: 2_000, recentWindowTokens: 80_000, compressionModel: 'mock-alt', autoTickOnNewMessage: true,
      });
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
      expect(block).toContain('- Tool rules: every tool the process offers at the call except the subagent tools, keeping subagent--return: no further forks or spawns at this depth; the parent has no restriction.');
      const run = h.runs[0]!;
      expect(run.proseRouting).toBe('explicit');
      // The depth limit's rules hold the board's tools only, and the
      // framework shows prose_help only to a stream its rules allow.
      expect(run.surface).not.toContain('prose_help');
      expect(run.surface).not.toContain('subagent--fork');
      const parentTools = h.framework.listToolClasses('parent').map((t) => t.tool);
      const missing = parentTools.filter((n) => !run.surface.includes(n));
      expect(missing).toContain('prose_help');
      expect(missing.length).toBeGreaterThan(1);
      const tools = line(startSection(run.firstContext), '- Tools:');
      expect(tools).toStartWith(`- Tools: ${run.surface.length} available to this stream. Compared with what the parent stream has now, it doesn't have `);
      for (const name of missing) expect(tools).toContain(name);
    } finally {
      await h.cleanup();
    }
  });

  test("a fork of a restricted parent keeps the parent's rules, says so, and has no tool the parent lacks but subagent--return", async () => {
    const h = await makeHarness({ parent: { allowedTools: ['agent_settings'] }, modules: [toolModule('wide', 15)] });
    try {
      const input = { name: 'wide', task: 'use what the parent may' };
      seedForkCall(h.framework, 'toolu_fork_11', input);
      const res = await h.subagent.handleToolCall(call('fork', 'toolu_fork_11', input));
      await h.asyncPromise('wide');
      const block = launchBlock(res.data as string);
      expect(block).toContain('- Tool rules: the parent is restricted to 1, and this stream keeps those rules, with subagent--return added; it\'s given only these 2, as the process offered them at the call: agent_settings and subagent--return.');
      // The stream's rules are the parent's and subagent--return, so not the same.
      expect(line(block, '- Against the parent at the call:')).toMatch(/Differs in [^.]*tool rules/);
      const run = h.runs[0]!;
      expect(run.allowedTools).toEqual(['agent_settings', 'subagent--return']);
      const parentTools = h.framework.listToolClasses('parent').map((t) => t.tool);
      expect(run.surface.filter((n) => !parentTools.includes(n))).toEqual(['subagent--return']);
      expect(run.surface.some((n) => n.startsWith('wide--'))).toBe(false);
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
        // An unrestricted fork short of the depth limit is shown prose_help
        // under explicit routing, so its line points to the tool.
        const effect = mode === 'explicit' ? `${ROUTING_EFFECT.explicit}${PROSE_HELP}` : ROUTING_EFFECT[mode];
        expect(line(block, '- Prose routing:')).toBe(`- Prose routing: ${mode}, inherited from the parent: ${effect}.`);
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
      expect(block).toContain("- Tool rules: only subagent--return, added; the caller's list names time--now, which this stream isn't given at the call; the caller has no restriction.");
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

  test('names and counts a name the list repeats once, as the stream gets it', async () => {
    expect(await ruleFor(['probe--t1', 'probe--t1'])).toBe(
      "- Tool rules: only these 2 from the caller's list, with subagent--return added, as the process offered them at the call: probe--t1 and subagent--return; the caller has no restriction.",
    );
    expect(await ruleFor(['subagent--return', 'subagent--return'])).toBe('- Tool rules: only subagent--return; the caller has no restriction.');
    // A repeated name the stream isn't given is named once among those too.
    expect(await ruleFor(['gone--t1', 'gone--t1'])).toBe(
      "- Tool rules: only subagent--return, added; the caller's list names gone--t1, which this stream isn't given at the call; the caller has no restriction.",
    );
  });

  test("names every listed tool the stream isn't given at the call, past ten too", async () => {
    const unoffered = Array.from({ length: 12 }, (_, i) => `gone--t${i}`);
    expect(await ruleFor(unoffered)).toBe(
      `- Tool rules: only subagent--return, added; the caller's list names ${unoffered.slice(0, -1).join(', ')} and gone--t11, ` +
        "which this stream isn't given at the call; the caller has no restriction.",
    );
  });

  // A list that names subagent--return isn't said to have it added.
  test('names subagent--return once, even when the caller listed it', async () => {
    const rule = await ruleFor(['probe--t1', 'subagent--return']);
    expect(rule).toBe("- Tool rules: only these 2 from the caller's list, as the process offered them at the call: probe--t1 and subagent--return; the caller has no restriction.");
    expect(rule.split('subagent--return').length - 1).toBe(1);
  });

  test("names a listed tool the stream isn't given at the call in one list, with no reason, below the depth limit too", async () => {
    expect(await ruleFor(['probe--t1', 'no-such-tool'])).toStartWith(
      "- Tool rules: only these 2 from the caller's list, with subagent--return added, as the process offered them at the call: probe--t1 and subagent--return; the caller's list also names no-such-tool, which this stream isn't given at the call",
    );
  });

  test('reads an empty list as subagent--return alone', async () => {
    expect(await ruleFor([])).toStartWith('- Tool rules: only subagent--return, added: the caller listed no tools');
  });

  test('at the depth limit, names what the stream isn\'t given at the call and that it can\'t fork or spawn', async () => {
    expect(await ruleFor(['time--now'], { maxDepth: 1 })).toStartWith(
      "- Tool rules: only subagent--return, added; the caller's list names time--now, which this stream isn't given at the call; at this depth, no subagent tool but subagent--return",
    );
    // A list the depth limit leaves an offered tool of says, whole, that
    // subagent--return was added, and that no other subagent tool is.
    expect(await ruleFor(['probe--t1'], { maxDepth: 1 })).toBe(
      "- Tool rules: only these 2 from the caller's list, with subagent--return added, as the process offered them at the call: probe--t1 and subagent--return; " +
        'at this depth, no subagent tool but subagent--return; the caller has no restriction.',
    );
  });

  // Whatever kept a name out (not offered at the call, removed by the depth,
  // or prose_help, which explicit routing shows short of the limit), it's
  // named in the one list, with no reason.
  test('at the depth limit, a listed tool the stream isn\'t given is named in the one list, whatever kept it out', async () => {
    for (const [name, parent] of [['subagent--nope', {}], ['subagent--fork', {}], ['prose_help', { proseRouting: 'explicit' as const }]] as const) {
      const rule = await ruleFor(['probe--t1', name], { maxDepth: 1 }, parent);
      expect(rule).toContain(`; the caller's list also names ${name}, which this stream isn't given at the call`);
      expect(rule).not.toContain('offered to it');
      expect(rule).not.toContain('depth removes');
      expect(rule).not.toContain('explicit prose routing shows');
    }
  });

  // agent-framework's availableToolsForPresentation adds prose_help under
  // explicit routing when the stream's rules allow it: it isn't on the
  // board, so it's never "offered".
  test('under explicit prose routing, a listed prose_help is not dropped, and the rule counts it and says the routing shows it', async () => {
    // Whole, so a shown prose_help named again among what the stream isn't
    // given would fail it.
    expect(await ruleFor(['probe--t1', 'prose_help'], {}, { proseRouting: 'explicit' })).toBe(
      "- Tool rules: only these 3 from the caller's list, with subagent--return added: probe--t1 and subagent--return, as the process offered them at the call, " +
        'and prose_help, which explicit prose routing shows; the caller has no restriction.',
    );
    // A list of prose_help alone isn't "only subagent--return".
    expect(await ruleFor(['prose_help'], {}, { proseRouting: 'explicit' })).toBe(
      "- Tool rules: only these 2 from the caller's list, with subagent--return added: subagent--return, as the process offered it at the call, " +
        'and prose_help, which explicit prose routing shows; the caller has no restriction.',
    );
    expect(await ruleFor(['probe--t1'], {}, { proseRouting: 'explicit' })).not.toContain('prose_help');
    expect(await ruleFor(['probe--t1'])).not.toContain('prose_help');
  });

  test("without explicit routing, a listed prose_help is named with the rest the stream isn't given at the call", async () => {
    expect(await ruleFor(['probe--t1', 'prose_help'])).toContain("; the caller's list also names prose_help, which this stream isn't given at the call");
  });
});

describe("a launch from a restricted caller keeps the caller's rules, and its tool rule says so", () => {
  async function launch(kind: 'fork' | 'spawn', parentTools: string[], input: Record<string, unknown>, module: Partial<SubagentModuleConfig> = {}) {
    const h = await makeHarness({ parent: { allowedTools: parentTools }, module, modules: [toolModule('probe', 1)] });
    try {
      const full = { name: 'kept', task: 't', ...(kind === 'spawn' ? { systemPrompt: 'p' } : {}), ...input };
      if (kind === 'fork') seedForkCall(h.framework, 'toolu_kept', full);
      const res = await h.subagent.handleToolCall(call(kind, 'toolu_kept', full));
      expect(res.success).toBe(true);
      await h.asyncPromise('kept');
      const block = launchBlock(res.data as string);
      return { rule: line(block, '- Tool rules'), block, run: h.runs[0]! };
    } finally {
      await h.cleanup();
    }
  }

  test("a spawn's listed tool that the caller's own rules don't allow is named with the rest the stream isn't given at the call", async () => {
    const { rule, run } = await launch('spawn', ['probe--t1', 'subagent--spawn'], { tools: ['probe--t1', 'agent_settings'] });
    expect(rule).toBe(
      "- Tool rules: only these 2 from the caller's list, with subagent--return added, as the process offered them at the call: probe--t1 and subagent--return; " +
        "the caller's list also names agent_settings, which this stream isn't given at the call; the caller is restricted to 2: probe--t1 and subagent--spawn.",
    );
    expect(run.allowedTools).toEqual(['probe--t1', 'subagent--return']);
  });

  // The line is about the list: one that names subagent--return isn't said
  // to have it added, whatever the caller's rules hold, and the caller's
  // restriction stands beside it.
  test("a spawn's list that names subagent--return, from a caller whose rules lack it, isn't said to have it added", async () => {
    const { rule, run } = await launch('spawn', ['probe--t1'], { tools: ['probe--t1', 'subagent--return'] });
    expect(rule).toBe(
      "- Tool rules: only these 2 from the caller's list, as the process offered them at the call: probe--t1 and subagent--return; " +
        'the caller is restricted to 1: probe--t1.',
    );
    expect(run.allowedTools).toEqual(['probe--t1', 'subagent--return']);
  });

  // A spawn without a list keeps its caller's rules as a fork does, and the
  // line says where filterToolNames added subagent--return to them.
  test('a spawn without a list from a caller whose rules lack subagent--return says it was added', async () => {
    const { rule, run } = await launch('spawn', ['probe--t1'], {});
    expect(rule).toBe(
      "- Tool rules: the caller is restricted to 1, and this stream keeps those rules, with subagent--return added; it's given only these 2, as the process offered them at the call: " +
        'probe--t1 and subagent--return.',
    );
    expect(run.allowedTools).toEqual(['probe--t1', 'subagent--return']);
  });

  test('a fork at the depth limit keeps what the process offers of its restricted parent\'s rules, less the subagent tools, and names the rest', async () => {
    const { rule, block, run } = await launch('fork', ['probe--t1', 'subagent--fork'], {}, { maxDepth: 1 });
    expect(rule).toBe(
      '- Tool rules: the parent is restricted to 2, and at this depth it keeps only what the process offers of that at the call, ' +
        "less the subagent tools, with subagent--return added: only these 2: probe--t1 and subagent--return; the parent's rules also allow subagent--fork, which this stream isn't given at the call.",
    );
    expect(run.allowedTools).toEqual(['probe--t1', 'subagent--return']);
    expect(line(block, '- Against the parent at the call:')).toMatch(/Differs in [^.]*tool rules/);
  });

  // A fork's summary compares the rules the stream is created with to its
  // parent's, whatever the depth limit did: different names differ, and the
  // same names, all offered, are the same.
  test('at the depth limit, a parent whose rules hold subagent--return: the line says the stream keeps it, and the summary compares the names', async () => {
    const lost = await launch('fork', ['probe--t1', 'subagent--fork', 'subagent--return'], {}, { maxDepth: 1 });
    expect(lost.rule).toBe(
      '- Tool rules: the parent is restricted to 3, and at this depth it keeps only what the process offers of that at the call, ' +
        "less the subagent tools but subagent--return: only these 2: probe--t1 and subagent--return; the parent's rules also allow subagent--fork, which this stream isn't given at the call.",
    );
    expect(lost.run.allowedTools).toEqual(['probe--t1', 'subagent--return']);
    expect(line(lost.block, '- Against the parent at the call:')).toMatch(/Differs in [^.]*tool rules/);

    const kept = await launch('fork', ['subagent--return', 'probe--t1'], {}, { maxDepth: 1 });
    expect(kept.rule).toBe(
      '- Tool rules: the parent is restricted to 2, and at this depth it keeps only what the process offers of that at the call, ' +
        'less the subagent tools but subagent--return: only these 2: probe--t1 and subagent--return.',
    );
    expect(kept.run.allowedTools).toEqual(['probe--t1', 'subagent--return']);
    expect(line(kept.block, '- Against the parent at the call:')).toMatch(/Same: [^.]*tool rules/);
  });

  test("a fork at the depth limit names its parent's rule for a tool the process doesn't offer, which the depth doesn't keep", async () => {
    const { rule, run } = await launch('fork', ['probe--t1', 'no-such-tool'], {}, { maxDepth: 1 });
    expect(rule).toBe(
      '- Tool rules: the parent is restricted to 2, and at this depth it keeps only what the process offers of that at the call, ' +
        "less the subagent tools, with subagent--return added: only these 2: probe--t1 and subagent--return; the parent's rules also allow " +
        "no-such-tool, which this stream isn't given at the call.",
    );
    expect(run.allowedTools).toEqual(['probe--t1', 'subagent--return']);
  });

  test("under explicit routing, a parent's prose_help is shown short of the depth limit and removed at it, and the routing line follows", async () => {
    const parent = { allowedTools: ['probe--t1', 'prose_help'], proseRouting: 'explicit' as const };
    for (const maxDepth of [3, 1]) {
      const h = await makeHarness({ parent, module: { maxDepth }, modules: [toolModule('probe', 1)] });
      try {
        const input = { name: 'kept', task: 't' };
        seedForkCall(h.framework, 'toolu_kept', input);
        const res = await h.subagent.handleToolCall(call('fork', 'toolu_kept', input));
        expect(res.success).toBe(true);
        await h.asyncPromise('kept');
        const block = launchBlock(res.data as string);
        const run = h.runs[0]!;
        if (maxDepth === 3) {
          expect(line(block, '- Tool rules')).toBe(
            "- Tool rules: the parent is restricted to 2, and this stream keeps those rules, with subagent--return added; it's given only these 3: probe--t1 and subagent--return, as the process " +
              'offered them at the call, and prose_help, which explicit prose routing shows.',
          );
          expect(line(block, '- Prose routing')).toBe(`- Prose routing: explicit, inherited from the parent: ${ROUTING_EFFECT.explicit}${PROSE_HELP}.`);
          expect(run.surface).toContain('prose_help');
        } else {
          expect(line(block, '- Tool rules')).toBe(
            '- Tool rules: the parent is restricted to 2, and at this depth it keeps only what the process offers of that at the call, ' +
              "less the subagent tools, with subagent--return added: only these 2: probe--t1 and subagent--return; the parent's rules also " +
              "allow prose_help, which this stream isn't given at the call.",
          );
          expect(line(block, '- Prose routing')).toBe(`- Prose routing: explicit, inherited from the parent: ${ROUTING_EFFECT.explicit}.`);
          expect(run.surface).not.toContain('prose_help');
        }
      } finally {
        await h.cleanup();
      }
    }
  });

  test("a parent's rules past ten that the stream isn't given are named up to ten and the rest counted", async () => {
    const unoffered = Array.from({ length: 12 }, (_, i) => `gone--t${i}`);
    const { rule } = await launch('fork', unoffered, {});
    expect(rule).toBe(
      "- Tool rules: the parent is restricted to 12, and this stream keeps those rules, with subagent--return added; it's given only subagent--return; " +
        `the parent's rules also allow ${unoffered.slice(0, 10).join(', ')} and 2 more, which this stream isn't given at the call.`,
    );
  });

  test("a parent's rule for a tool the process doesn't offer is kept, and named among what the stream isn't given at the call", async () => {
    const { rule, run } = await launch('fork', ['probe--t1', 'no-such-tool'], {});
    expect(rule).toBe(
      '- Tool rules: the parent is restricted to 2, and this stream keeps those rules, with subagent--return added; it\'s given only these 2, as the process offered them at the call: ' +
        "probe--t1 and subagent--return; the parent's rules also allow no-such-tool, which this stream isn't given at the call.",
    );
    expect(run.allowedTools).toEqual(['probe--t1', 'no-such-tool', 'subagent--return']);
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
      // The fork keeps the restriction, with subagent--return.
      expect(rule).toBe('- Tool rules: the parent is restricted to no tools, and this stream keeps those rules, with subagent--return added; it\'s given only subagent--return.');
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

describe("an agent setting that can't be read", () => {
  test("is said to be, and never counted as matching the parent's", () => {
    const unreadable = agentSettingsOf({ getRuntimeSettings: () => { throw new Error('no settings'); } });
    expect(unreadable['same-round think-text policy']).toBe('unreadable');
    // Only what describeSubagentStart reads of the launch.
    const launch = { kind: 'fork', parent: { contextBudgetTokens: 1_000 }, proseRouting: 'locus' } as unknown as SubagentLaunch;
    const text = describeSubagentStart(launch, {
      inherited: { kind: 'cut-at-call' },
      contextBudgetTokens: 1_000,
      proseRouting: 'locus',
      tools: ['subagent--return'],
      parentTools: ['subagent--return'],
      agentSettings: unreadable,
      parentAgentSettings: unreadable,
    });
    const settings = line(text, '- Agent settings');
    expect(settings).toContain("same-round think-text policy unreadable (the parent stream's: unreadable)");
    expect(settings).not.toContain('the same as');
  });
});

describe('each agent setting is read from its own field', () => {
  test('moving one field moves its setting alone', () => {
    const base = agentSettingsOf({});
    const cases: Array<[Parameters<typeof agentSettingsOf>[0], string, string]> = [
      [{ thinking: { enabled: true, type: 'adaptive' } }, 'extended thinking', 'adaptive'],
      [{ providerParams: { top_k: 5, reasoning: {} } }, 'provider parameters', 'set (reasoning and top_k)'],
      [{ promptCaching: true }, 'prompt caching', 'on'],
      [{ cacheTtl: '5m' }, 'prompt-cache TTL', '5m'],
      [{ prefillUserMessage: 'go on' }, 'prefill user message', 'set'],
      [{ getRuntimeSettings: () => ({ sameRoundThinkTextPolicy: 'strip' }) }, 'same-round think-text policy', 'strip'],
      [{ refusalHandling: { mode: 'rewind' } }, 'refusal handling', 'set'],
      [{ toolResultGuard: { enabled: true } }, 'tool-result guard', 'on'],
      [{ toolWrapperProseGuard: true }, 'tool-wrapper prose guard', 'on'],
    ];
    expect(new Set(cases.map(([, name]) => name))).toStrictEqual(new Set(Object.keys(base)));
    for (const [agent, name, value] of cases) {
      const moved = agentSettingsOf(agent);
      expect(moved[name]).toBe(value);
      expect(base[name]).not.toBe(value);
      for (const other of Object.keys(base)) if (other !== name) expect(moved[other]).toBe(base[other]);
    }
  });
});

describe('a module without its framework yet', () => {
  test('is built with no config, and answers a launch with an error rather than a throw', async () => {
    const bare = new SubagentModule();
    const res = await bare.handleToolCall(call('spawn', 'toolu_bare', { name: 'early', systemPrompt: 'p', task: 't' }));
    expect(res.success).toBe(false);
    // The missing framework is the reason, not any error.
    // main's words, unprefixed, as for a caller that can't be resolved.
    expect(String(res.error)).toStartWith('SubagentModule: framework not set.');
    const forked = await bare.handleToolCall(call('fork', 'toolu_bare_fork', { name: 'early-fork', task: 't' }));
    expect(String(forked.error)).toStartWith('SubagentModule: framework not set.');
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
      expect(receipt).toStartWith("Subagent 'second' accepted as a fork. Every subagent slot (1) is in use, so it waits for one to free, for up to 120 s; if none does, it ends with an error, delivered as its result would be.");
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
        "- Inherited: the parent's whole compiled context as it was when this stream started, because the fork call wasn't in that context. It can include turns that came after the call. An exact repeat of an earlier message is dropped, and this stream's own strategy caps and selects what remains as it does every message.",
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
      // A spawn says it waits, as a fork does.
      expect(spawnReceipt).toStartWith(
        "Subagent 'third' accepted as a spawn. Every subagent slot (1) is in use, so it waits for one to free, for up to 120 s; if none does, it ends with an error, delivered as its result would be.",
      );

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

  test('a parent that has left the framework by the start: the fork still inherits its context, cut at the call, and its tools are not compared', async () => {
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
      // The parent resolved at the call is the one the fork compiles, though
      // it's no longer registered: its context, through the call's exchange.
      expect(run.allText).toContain('please look into it');
      expect(run.firstContext).toContain(block);
      expect(run.firstContext).toEndWith('Your intention for this stream: outlive the caller');
      const start = startSection(run.firstContext);
      expect(start).toContain("- Inherited: the parent's compiled context through the fork call's exchange.");
      expect(line(start, '- Agent settings')).toStartWith("- Agent settings: the framework's defaults, the same as the parent stream's now");
      expect(start).toContain(`- Tools: ${run.surface.length} available to this stream: `);
      expect(start).toContain("The parent stream's tools couldn't be read for comparison.");
      // Created with the values resolved at the call, not the default
      // prompt and output limit a missing parent would give now.
      expect(run.systemPrompt).toBe('helper prompt');
      expect(run.maxTokens).toBe(256);
    } finally {
      await h.cleanup();
    }
  });

  test("a parent whose name another agent has taken by the start: the fork's tools aren't compared with that agent's", async () => {
    const h = await makeHarness({
      extraAgents: [
        { name: 'helper', model: 'mock', systemPrompt: 'helper prompt', maxTokens: 256 },
        { name: 'stranger', model: 'mock', systemPrompt: 'stranger prompt', maxTokens: 256, allowedTools: ['subagent--return'] },
      ],
      module: { maxConcurrent: 1 },
    });
    try {
      await queueBehindAHeldFork(h);
      const child = { name: 'child', task: 'outlive the caller' };
      seedForkCall(h.framework, 'toolu_child', child, 'helper');
      const res = await h.subagent.handleToolCall(call('fork', 'toolu_child', child, 'helper'));
      expect(res.success).toBe(true);
      // The helper leaves, and another agent is registered under its name.
      const agents = (h.framework as unknown as { agents: Map<string, unknown> }).agents;
      h.unregister('helper');
      agents.set('helper', agents.get('stranger'));
      h.releaseHeld();
      await h.asyncPromise('first');
      await h.asyncPromise('child');

      const run = h.runs.find((r) => r.name.startsWith('child-'))!;
      const start = startSection(run.firstContext);
      expect(start).toContain("The parent stream's tools couldn't be read for comparison.");
      expect(start).not.toContain('Compared with what the parent stream has now');
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
    // limit's allowlist, and prose_help under explicit routing only where
    // the stream's rules allow it, which the depth limit's don't.
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
      expect(toolNames).not.toContain('prose_help');
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
  // must carry exactly those: under explicit routing, prose_help only when
  // its list allows it.
  for (const [tools, sends] of [
    [['extra--t1'], ['extra--t1', 'subagent--return']],
    [['extra--t1', 'prose_help'], ['extra--t1', 'prose_help', 'subagent--return']],
  ] as const) {
    test(`a spawn listing ${tools.join(' and ')} under explicit routing sends exactly the tools its orientation lists`, async () => {
      const { adapter, subagent, cleanup } = await realHarness({ parent: { proseRouting: 'explicit' } });
      try {
        const input = { name: 'worker', systemPrompt: 'p', task: 'say done', model: 'mock-spawn', sync: true, tools: [...tools] };
        const res = await subagent.handleToolCall(call('spawn', 'toolu_worker', input));
        expect(res.success).toBe(true);
        const request = adapter.getRequestLog().map((r) => r.request).find((r) => r.model === 'mock-spawn');
        expect(request).toBeDefined();
        const toolNames = (request!.tools ?? []).map((t) => (t as { name: string }).name);
        expect([...toolNames].sort()).toEqual([...sends]);
        const wire = JSON.stringify(request!.messages);
        const toolsLine = wire.split('\\n').find((l) => l.startsWith('- Tools: '));
        expect(toolsLine).toBeDefined();
        expect(toolsLine).toStartWith(`- Tools: ${toolNames.length} available to this stream: `);
        for (const name of toolNames) expect(toolsLine).toContain(name);
        const rule = wire.split('\\n').find((l) => l.startsWith('- Tool rules: '))!;
        const routing = wire.split('\\n').find((l) => l.startsWith('- Prose routing: '))!;
        if (tools.includes('prose_help' as never)) {
          expect(rule).toContain(', and prose_help, which explicit prose routing shows');
          expect(routing).toBe(sent(`- Prose routing: explicit, inherited from the caller: ${ROUTING_EFFECT.explicit}${PROSE_HELP}.`));
        } else {
          expect(rule).not.toContain('prose_help');
          // Not shown the tool, so not pointed to it.
          expect(routing).toBe(sent(`- Prose routing: explicit, inherited from the caller: ${ROUTING_EFFECT.explicit}.`));
        }
      } finally {
        await cleanup();
      }
    });
  }

  // Only explicit routing shows prose_help: under locus routing a list that
  // allows it gets neither the tool nor a line saying it has it.
  test('a spawn listing prose_help under locus routing is sent neither it nor a Tools line naming it', async () => {
    const { adapter, subagent, cleanup } = await realHarness({ parent: { proseRouting: 'locus' } });
    try {
      const input = { name: 'worker', systemPrompt: 'p', task: 'say done', model: 'mock-spawn', sync: true, tools: ['extra--t1', 'prose_help'] };
      const res = await subagent.handleToolCall(call('spawn', 'toolu_worker', input));
      expect(res.success).toBe(true);
      const request = adapter.getRequestLog().map((r) => r.request).find((r) => r.model === 'mock-spawn');
      expect(request).toBeDefined();
      const toolNames = (request!.tools ?? []).map((t) => (t as { name: string }).name);
      expect([...toolNames].sort()).toEqual(['extra--t1', 'subagent--return']);
      const wire = JSON.stringify(request!.messages);
      const toolsLine = wire.split('\\n').find((l) => l.startsWith('- Tools: '));
      expect(toolsLine).toBeDefined();
      expect(toolsLine).toStartWith('- Tools: 2 available to this stream: ');
      expect(toolsLine).not.toContain('prose_help');
      const rule = wire.split('\\n').find((l) => l.startsWith('- Tool rules: '))!;
      expect(rule).toContain("; the caller's list also names prose_help, which this stream isn't given at the call");
      expect(rule).not.toContain('explicit prose routing shows');
      const routing = wire.split('\\n').find((l) => l.startsWith('- Prose routing: '))!;
      expect(routing).toBe(sent(`- Prose routing: locus, inherited from the caller: ${ROUTING_EFFECT.locus}.`));
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
    /** The parent's tool rules, when it's restricted. */
    parentTools?: string[];
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
      // Built as the host builds a recipe's formatter, so anthropic-xml runs
      // in XML tool mode: membrane would otherwise pick native tools for it.
      // The recipe's agent has the parent's prompt and caching, so an
      // anthropic-xml agent's tools go into its system block.
      membrane: new Membrane(adapter, {
        formatter: recipeFormatter(
          { agent: { systemPrompt: 'p', ...(opts.formatter === 'anthropic-xml' ? { formatter: 'anthropic-xml' } : {}) } } as unknown as Recipe,
          opts.formatter === 'openai-responses' ? 'openai-responses' : 'mock',
          'mock',
        ),
      }),
      agents: [{ name: 'parent', model: 'mock', systemPrompt: 'p', maxTokens: 256, ...(opts.parentTools ? { allowedTools: opts.parentTools } : {}) }],
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
          `${kind === 'spawn' ? 'Subagent' : 'Fork'} 'long-${kind}' didn't start, so nothing ran: its task is longer than one message holds (10,000 tokens): ` +
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
        "Subagent 'wide-spawn' didn't start, so nothing ran: its orientation, which names the spawn's tools in full, is longer than one message holds (10,000 tokens): give the spawn a shorter tools list.",
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
        "Fork 'wide-fork' didn't start, so nothing ran: its orientation is longer than one message holds (10,000 tokens): launch it as subagent--spawn instead, with a name, a systemPrompt, a short tools list and a task that fits one message and says what it needs to know.",
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

  // A size refusal is the module's own failure, so the launch is tried once.
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
        expect(String(result.error)).toContain(`${kind === 'spawn' ? 'Subagent' : 'Fork'} 'sized-idle-${kind}' didn't start, so nothing ran: `);
        expect(String(result.error)).toContain("over this host's limit of 1");
        expect(attempts.count).toBe(1);
      } finally {
        await h.cleanup();
      }
    });
  }

  test("a fork over the limit from a caller whose rules don't allow subagent--spawn is told to do it in its own stream", async () => {
    const h = await realHarness({ maxPromptTokens: 1, parentTools: ['subagent--fork'] });
    try {
      const input = { name: 'sized-no-spawn', task: 'short', model: 'mock-sized-no-spawn', sync: true };
      const cm = h.framework.getAgent('parent')!.getContextManager();
      cm.addMessage('user', [{ type: 'text', text: 'begin' }]);
      cm.addMessage('parent', [{ type: 'tool_use', id: 'fork-no-spawn', name: 'subagent--fork', input }] as never);
      const result = await h.subagent.handleToolCall({ id: 'fork-no-spawn', name: 'fork', input, callerAgentName: 'parent' } as never);
      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(new RegExp(
        "^Fork 'sized-no-spawn' didn't start, so nothing ran: it would begin at about \\d+ tokens, over this host's limit of 1, " +
        "because a fork carries your whole conversation\\. Do it in this stream instead, since subagent--spawn isn't among your tools\\.$",
      ));
      expect(h.requestFor('mock-sized-no-spawn')).toBeUndefined();
    } finally {
      await h.cleanup();
    }
  });

  test("a fork refused for its call is told the way out its caller's own rules allow: a spawn, or its own stream", async () => {
    for (const canSpawn of [false, true]) {
      const h = await realHarness(canSpawn ? {} : { parentTools: ['subagent--fork'] });
      try {
        const input = { name: `stale-${canSpawn}`, task: 'the task this call carries', model: `mock-stale-${canSpawn}`, sync: true };
        const cm = h.framework.getAgent('parent')!.getContextManager();
        cm.addMessage('user', [{ type: 'text', text: 'begin' }]);
        // The stored call carries another task, so the fork's own call
        // doesn't carry this one: the delivery check's 'call' part.
        cm.addMessage('parent', [{ type: 'tool_use', id: 'fork-stale', name: 'subagent--fork', input: { ...input, task: 'an earlier task' } }] as never);
        const result = await h.subagent.handleToolCall({ id: 'fork-stale', name: 'fork', input, callerAgentName: 'parent' } as never);
        expect(result.success).toBe(false);
        expect(String(result.error)).toBe(
          `Fork '${input.name}' didn't start, so nothing ran: the fork call that carries its task, or its result, isn't in the context it would start from: ` +
          (canSpawn
            ? 'launch it as subagent--spawn instead, with a name, a systemPrompt, a short tools list and a task that fits one message (10,000 tokens) ' +
              'and says what it needs to know, though a spawn inherits none of this context.'
            : "do it in this stream instead, since subagent--spawn isn't among your tools."),
        );
        expect(h.requestFor(input.model)).toBeUndefined();
      } finally {
        await h.cleanup();
      }
    }
  });

  test("in XML tool mode, a fork's first request shows no sibling fork, and each result names its tool, so its own is told apart where it leads", async () => {
    for (const path of ['structural', 'fallback'] as const) {
      const h = await realHarness({ formatter: 'anthropic-xml' });
      try {
        const input = { name: `xml-${path}`, task: 'short', model: `mock-xml-${path}`, sync: true };
        const cm = h.framework.getAgent('parent')!.getContextManager();
        cm.addMessage('user', [{ type: 'text', text: 'begin' }]);
        if (path === 'structural') {
          // As agent-framework 0.22.3 stores an XML round: each call carries
          // the round's raw text, a sibling fork's included, and each result
          // is named, in call order.
          const sibling = { name: 'sibling', task: 'SIBLING-TASK' };
          const raw = '<function_calls>\n<invoke name="files--read">\n<parameter name="path">notes</parameter>\n</invoke>\n' +
            `<invoke name="subagent--fork">\n<parameter name="task">${sibling.task}</parameter>\n</invoke>\n` +
            `<invoke name="subagent--fork">\n<parameter name="task">${input.task}</parameter>\n</invoke>\n</function_calls>`;
          cm.addMessage('parent', [
            { type: 'tool_use', id: 'read-x', name: 'files--read', input: { path: 'notes' }, rawXml: raw },
            { type: 'tool_use', id: 'fork-sibling', name: 'subagent--fork', input: sibling, rawXml: raw },
            { type: 'tool_use', id: 'fork-x', name: 'subagent--fork', input, rawXml: raw },
          ] as never);
          cm.addMessage('user', [
            { type: 'tool_result', toolUseId: 'read-x', toolName: 'files--read', content: 'NOTES' },
            { type: 'tool_result', toolUseId: 'fork-sibling', toolName: 'subagent--fork', content: 'accepted' },
            { type: 'tool_result', toolUseId: 'fork-x', toolName: 'subagent--fork', content: 'accepted' },
          ] as never);
        }
        const result = await h.subagent.handleToolCall({ id: 'fork-x', name: 'fork', input, callerAgentName: 'parent' } as never);
        expect(result.success).toBe(true);
        const wire = JSON.stringify(h.requestFor(input.model));
        const forkResult = wire.indexOf('<result>\\n<tool_name>subagent--fork</tool_name>\\n<stdout>\\n');
        expect(forkResult).toBeGreaterThan(-1);
        expect(wire.indexOf(`Launch of fork '${input.name}'`, forkResult)).toBeGreaterThan(forkResult);
        // Every result is named: the fork's alone, or the fork's leading the read's.
        expect(wire.split('<result>').length - 1).toBe(path === 'structural' ? 2 : 1);
        expect(wire.split('<tool_name>').length - 1).toBe(path === 'structural' ? 2 : 1);
        if (path === 'structural') {
          expect(wire.indexOf('<result>\\n<tool_name>files--read</tool_name>\\n<stdout>\\nNOTES')).toBeGreaterThan(forkResult);
          // The sibling's call and result are gone, its task with them: the
          // kept calls render from their blocks, not the round's raw text.
          expect(wire).not.toContain('SIBLING-TASK');
          expect(wire).toContain('<invoke name=\\"files--read\\">');
        }
      } finally {
        await h.cleanup();
      }
    }
  });

  test("a parentless fork over the limit isn't told it carries a conversation, and gets the same way out", async () => {
    const h = await realHarness({ parentless: true, maxPromptTokens: 1 });
    try {
      const result = await h.subagent.handleToolCall({
        id: 'call-sized', name: 'fork',
        input: { name: 'sized-parentless', task: 'short', model: 'mock-sized-parentless', sync: true },
      } as never);
      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(new RegExp(
        "^Fork 'sized-parentless' didn't start, so nothing ran: it would begin at about \\d+ tokens, over this host's limit of 1\\. " +
        'Launch it as subagent--spawn instead, with a name, a systemPrompt, a short tools list and a task that fits one message ' +
        '\\(10,000 tokens\\) and says what it needs to know\\.$',
      ));
    } finally {
      await h.cleanup();
    }
  });

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
        message: "Subagent 'long-async' didn't start, so nothing ran: its task is longer than one message holds (10,000 tokens): " +
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
    const refusal = (subagent as unknown as {
      launchRefusal(kind: 'spawn' | 'fork', cut: string[], delivery: unknown, canSpawn: boolean): Error;
    }).launchRefusal.bind(subagent);
    const refuse = (kind: 'spawn' | 'fork', cut: string[], delivery: unknown) => refusal(kind, cut, delivery, true);
    const withCall = { kind: 'fork-result', callId: 'c', head: 'HEAD', task: 'TASK' };
    const ownMessages = { kind: 'message', orientation: 'ORIENT', taskBlock: 'TASK' };
    // The module's own failure, which the retry loop ends on unread, and the
    // reasons alone: failedRun puts them after "didn't start, so nothing ran".
    expect(refuse('fork', ['orientation'], ownMessages).name).toBe('SubagentFailure');
    expect(refuse('fork', ['orientation'], ownMessages).message).toBe(
      'its orientation is longer than one message holds (10,000 tokens): ' +
      'launch it as subagent--spawn instead, with a name, a systemPrompt, a short tools list and a task that fits one message and says what it needs to know',
    );
    expect(refuse('fork', ['orientation'], withCall).message).toBe(
      'its orientation is longer than one message holds (10,000 tokens): ' +
      'launch it as subagent--spawn instead, with a name, a systemPrompt, a short tools list and a task that fits one message and says what it needs to know, though a spawn inherits none of this context',
    );
    expect(refuse('fork', ['call'], withCall).message).toBe(
      "the fork call that carries its task, or its result, isn't in the context it would start from: " +
      'launch it as subagent--spawn instead, with a name, a systemPrompt, a short tools list and a task that fits one message (10,000 tokens) and says what it needs to know, though a spawn inherits none of this context',
    );
    expect(refuse('spawn', ['orientation', 'task'], ownMessages).message).toContain('give the spawn a shorter tools list; and its task is longer');
    // A caller whose rules don't allow subagent--spawn isn't sent to it.
    const noSpawn = (cut: string[]) => refusal('fork', cut, withCall, false).message;
    expect(noSpawn(['orientation'])).toBe(
      "its orientation is longer than one message holds (10,000 tokens): do it in this stream instead, since subagent--spawn isn't among your tools",
    );
    expect(noSpawn(['call'])).toBe(
      "the fork call that carries its task, or its result, isn't in the context it would start from: do it in this stream instead, since subagent--spawn isn't among your tools",
    );
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

  test("a fork of a parent restricted to a few tools keeps them, so a wide board doesn't lengthen its orientation, and it launches", async () => {
    const h = await harness(['subagent--fork', 'subagent--return']);
    try {
      const result = await h.subagent.handleToolCall({
        id: 'call-r', name: 'fork', callerAgentName: 'parent',
        input: { name: 'from-narrow', task: 'short', model: 'mock-from-narrow', sync: true },
      } as never);
      expect(result.success).toBe(true);
      const wire = JSON.stringify(h.requestFor('mock-from-narrow')!.messages);
      expect(wire).toContain('- Tool rules: the parent is restricted to 2, and this stream keeps those rules; it\'s given only these 2, as the process offered them at the call: subagent--fork and subagent--return.');
      // Its rules already hold subagent--return, so they're the parent's, the same.
      expect(wire).toMatch(/Same: [^.]*tool rules/);
      expect(wire).not.toContain('bulk--');
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
    // The fork's own call carrying another task, or none, doesn't carry this one.
    expect(undeliveredLaunchParts([...msgs(call('c1', 'OTHER TASK')), ...msgs(result('c1', 'HEAD'))], delivery)).toEqual(['call']);
    expect(undeliveredLaunchParts([...msgs({ type: 'tool_use', id: 'c1', name: 'subagent--fork', input: {} }), ...msgs(result('c1', 'HEAD'))], delivery)).toEqual(['call']);
    // Another call carrying the same task isn't this fork's call.
    expect(undeliveredLaunchParts([...msgs(call('other', 'TASK')), ...msgs(result('c1', 'HEAD'))], delivery)).toEqual(['call']);
    // Another result isn't this fork's: its own result isn't there, which is
    // the call's part to say, not a cut orientation.
    expect(undeliveredLaunchParts([...msgs(call('c1', 'TASK')), ...msgs(result('other', 'HEAD'))], delivery)).toEqual(['call']);
    // A context that lost the call lost its result with it: one part, the
    // call's. 'orientation' is for a result that is there and cut.
    expect(undeliveredLaunchParts(msgs(text('earlier')), delivery)).toEqual(['call']);
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

  test('an empty list adds no clause', () => {
    expect(toolDifferences(['extra-0'], [])).toBe('it also has extra-0');
    expect(toolDifferences([], ['lacks-0'])).toBe("it doesn't have lacks-0");
  });
});
