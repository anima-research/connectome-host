import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '@animalabs/agent-framework';
import type { Module } from '@animalabs/agent-framework';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import type { ProviderRequest } from '@animalabs/membrane';
import { LoggingAnthropicAdapter, modelThinking } from '../src/logging-adapter.js';
import {
  buildFrameworkAgentConfig,
  FOLD_REASONING_LINE,
  systemPromptFor,
  thinkingBindingSettings,
} from '../src/framework-agent-config.js';
import { validateRecipe } from '../src/recipe.js';
import { getDefaultModelLimits } from '../src/model-limits.js';
import { SubagentModule, describeSubagentLaunch } from '../src/modules/subagent-module.js';

const DROP_BLOCK = { prefix_mismatch_behavior: 'drop_block' };
const BOUND = { binds: true, dropBlock: true, thinksWithoutConfig: true, windowShownByRefusal: true };
const BOUND_NO_CONTROL = { binds: true, dropBlock: false, thinksWithoutConfig: true };
const UNREACHED = { binds: true, dropBlock: false, thinksWithoutConfig: false };
const THINKS_UNBOUND = { binds: false, dropBlock: false, thinksWithoutConfig: true };
const NEITHER = { binds: false, dropBlock: false, thinksWithoutConfig: false };

describe('modelThinking', () => {
  test.each([
    ['claude-fable-5-1', BOUND], ['claude-opus-5-5', BOUND], ['claude-sonnet-5-5', BOUND], ['claude-haiku-5-5', BOUND],
    ['claude-mythos-5-1', BOUND_NO_CONTROL], ['claude-mythos-5', BOUND_NO_CONTROL], ['claude-mythos-preview', BOUND_NO_CONTROL],
    ['claude-fable-5', THINKS_UNBOUND], ['claude-opus-5', THINKS_UNBOUND], ['claude-sonnet-5', THINKS_UNBOUND],
    ['claude-opus-4-8', NEITHER], ['claude-opus-4-7', NEITHER], ['claude-opus-4-6', NEITHER], ['claude-opus-4-5', NEITHER],
    ['claude-sonnet-4-6', NEITHER], ['claude-sonnet-4-5', NEITHER], ['claude-haiku-4-5', NEITHER],
  ])('records %s as measured', (model, facts) => {
    expect(modelThinking(model)).toEqual(facts);
  });

  test.each([
    'claude-opus-5-5-20260301', 'claude-opus-5-5@20260301', 'claude-opus-5-5[1m]', 'anthropic/claude-opus-5-5',
    'anthropic.claude-opus-5-5', 'us.anthropic.claude-opus-5-5-v1:0', 'anthropic/claude-opus-5.5', 'Claude-Opus-5-5',
  ])('covers %s as Opus 5.5', (model) => {
    expect(modelThinking(model)).toEqual(BOUND);
  });

  test('covers dated snapshots of the older models too', () => {
    expect(modelThinking('claude-haiku-4-5-20251001')).toEqual(NEITHER);
    expect(modelThinking('claude-sonnet-4-5-20250929')).toEqual(NEITHER);
    expect(modelThinking('claude-opus-5-20260101')).toEqual(THINKS_UNBOUND);
  });

  test.each([
    'claude-opus-4-1', 'claude-opus-4-1-20250805', 'claude-opus-4-1@20250805', 'us.anthropic.claude-opus-4-1-20250805-v1:0',
    'claude-opus-4-0', 'claude-opus-4-20250514', 'anthropic.claude-opus-4-20250514-v1:0',
    'claude-sonnet-4-0', 'claude-sonnet-4-20250514', 'claude-sonnet-4@20250514',
    'claude-3-7-sonnet-20250219', 'claude-3-7-sonnet-latest', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022',
    'claude-3-opus-20240229', 'claude-3-sonnet-20240229', 'claude-3-haiku-20240307', 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    'claude-2.1', 'claude-2.0', 'claude-instant-1.2', 'anthropic.claude-v2:1', 'anthropic.claude-instant-v1',
  ])('records %s, from before Claude 4.5, as neither binding nor thinking unasked', (model) => {
    expect(modelThinking(model)).toEqual(NEITHER);
  });

  test.each([
    'claude-opus-5-6', 'claude-opus-5-50', 'claude-fable-5-2', 'claude-fable-5-10', 'claude-sonnet-5-6', 'claude-haiku-5-6',
    'claude-mythos-5-2', 'claude-opus-6', 'claude-opus-4-9', 'bedrock:claude-opus-5-6', 'claude-5-opus',
  ])('records %s, which it doesn\'t name, as binding without the control', (model) => {
    expect(modelThinking(model)).toEqual(UNREACHED);
  });

  test.each(['gpt-5.4', 'gemini-3-pro', 'mock', '', 'local-claude-distill-7b', 'my-claude-opus-5-5'])('gives %s, not a Claude model, none of it', (model) => {
    expect(modelThinking(model)).toEqual(NEITHER);
  });
});

describe('LoggingAnthropicAdapter.withBinding', () => {
  type WithBinding = { withBinding(r: ProviderRequest): ProviderRequest };
  const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null');
  const bind = (req: ProviderRequest) => (adapter as unknown as WithBinding).withBinding(req);
  const thinkingOf = (req: ProviderRequest) => (req.extra as { thinking?: unknown } | undefined)?.thinking;
  const request = (model: string, more: Record<string, unknown> = {}) =>
    ({ messages: [], model, maxTokens: 1024, ...more }) as ProviderRequest;

  test.each(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])(
    "sends %s, which thinks with no config, an 'omitted' adaptive config with the control when there's none",
    (model) => {
      const req = request(model);
      expect(thinkingOf(bind(req))).toEqual({ type: 'adaptive', display: 'omitted', block_binding: DROP_BLOCK });
      expect((req as { extra?: unknown }).extra).toBeUndefined();
    },
  );

  test("adds the control to the config in effect, keeping its fields; extra.thinking wins, as in the adapter", () => {
    const viaExtra = request('claude-opus-5-5', { extra: { keep: 1, thinking: { type: 'adaptive', display: 'summarized' } } });
    const out = bind(viaExtra);
    expect(thinkingOf(out)).toEqual({ type: 'adaptive', display: 'summarized', block_binding: DROP_BLOCK });
    expect((out.extra as Record<string, unknown>).keep).toBe(1);
    expect(thinkingOf(viaExtra)).toEqual({ type: 'adaptive', display: 'summarized' });
    const topLevel = request('claude-sonnet-5-5', { thinking: { type: 'enabled', budget_tokens: 2048 } });
    expect(thinkingOf(bind(topLevel))).toEqual({ type: 'enabled', budget_tokens: 2048, block_binding: DROP_BLOCK });
    expect((topLevel as { thinking?: unknown }).thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    const nulled = request('claude-opus-5-5', { thinking: { type: 'adaptive', block_binding: null } });
    expect(thinkingOf(bind(nulled))).toEqual({ type: 'adaptive', block_binding: DROP_BLOCK });
    const both = request('claude-haiku-5-5', {
      thinking: { type: 'adaptive', display: 'summarized' },
      extra: { thinking: { type: 'adaptive', display: 'omitted' } },
    });
    expect(thinkingOf(bind(both))).toEqual({ type: 'adaptive', display: 'omitted', block_binding: DROP_BLOCK });
  });

  test('leaves a config that already carries a binding control alone (same reference)', () => {
    const own = { prefix_mismatch_behavior: 'error' };
    for (const req of [
      request('claude-opus-5-5', { thinking: { type: 'adaptive', block_binding: DROP_BLOCK } }),
      request('claude-opus-5-5', { extra: { thinking: { type: 'adaptive', block_binding: own } } }),
    ]) {
      expect(bind(req)).toBe(req);
    }
  });

  test("leaves a config of another type alone ('disabled', 'between_tools')", () => {
    for (const type of ['disabled', 'between_tools']) {
      const req = request('claude-opus-5-5', { extra: { thinking: { type } } });
      expect(bind(req)).toBe(req);
    }
  });

  test.each([
    'claude-mythos-5-1', 'claude-mythos-5', 'claude-opus-5-6', 'claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'gpt-5.4',
  ])('leaves %s untouched: it binds without the control, or doesn\'t bind', (model) => {
    for (const req of [request(model), request(model, { extra: { thinking: { type: 'adaptive', display: 'summarized' } } })]) {
      expect(bind(req)).toBe(req);
    }
  });
});

describe('the binding on the wire (through the real adapter)', () => {
  type Reasoning = () => { enabled: boolean; budgetTokens: number; display?: 'summarized' | 'omitted' };
  const BINDING_BETA = 'thinking-binding-controls-2026-08-01';
  const UPDATES_BETA = 'thinking-display-updates-2026-08-18';

  const wire = (reasoning: Reasoning) => {
    const bodies: Array<Record<string, unknown>> = [];
    const headers: Array<Record<string, string> | undefined> = [];
    const live = new LoggingAnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } }, '/dev/null', reasoning);
    (live as unknown as { client: unknown }).client = {
      withOptions() { return this; },
      messages: {
        stream: async (body: Record<string, unknown>, opts?: { headers?: Record<string, string> }) => {
          bodies.push(body);
          headers.push(opts?.headers);
          return {
            controller: { abort() {} },
            async *[Symbol.asyncIterator]() {
              yield { type: 'message_start', message: { model: body.model, usage: { input_tokens: 1 } } };
              yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
              yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } };
              yield { type: 'content_block_stop', index: 0 };
              yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } };
            },
          };
        },
        create: async (body: Record<string, unknown>, opts?: { headers?: Record<string, string> }) => {
          bodies.push(body);
          headers.push(opts?.headers);
          return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: body.model, usage: { input_tokens: 1, output_tokens: 1 } };
        },
      },
    };
    const req = (model: string) =>
      ({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], model, maxTokens: 1024 }) as ProviderRequest;
    const stream = (model: string) => live.stream(req(model), { onChunk: () => {} });
    const complete = (model: string) => live.complete(req(model));
    const betas = (i: number) => (headers[i]?.['anthropic-beta'] ?? '').split(',').filter(Boolean);
    return { bodies, betas, stream, complete };
  };
  const off: Reasoning = () => ({ enabled: false, budgetTokens: 0 });

  test('with reasoning off, an agent turn on each binding model carries the control and its beta', async () => {
    const w = wire(off);
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']) await w.stream(model);
    expect(w.bodies).toHaveLength(4);
    // Opus, Sonnet and Fable return the notes between tool calls as thinking blocks.
    for (const i of [0, 1, 3]) {
      expect(w.bodies[i]?.thinking).toEqual({ type: 'adaptive', display: 'updates', block_binding: DROP_BLOCK });
      expect(w.betas(i)).toEqual(expect.arrayContaining([BINDING_BETA, UPDATES_BETA]));
    }
    expect(w.bodies[2]?.thinking).toEqual({ type: 'adaptive', display: 'omitted', block_binding: DROP_BLOCK });
    expect(w.betas(2)).toContain(BINDING_BETA);
    expect(w.betas(2)).not.toContain(UPDATES_BETA);
  });

  test('with reasoning on, the setting\'s config carries the control on a binding model, and on no other', async () => {
    const w = wire(() => ({ enabled: true, budgetTokens: 0, display: 'summarized' }));
    await w.stream('claude-sonnet-5-5');
    await w.stream('claude-opus-4-8');
    await w.stream('claude-mythos-5-1');
    await w.stream('claude-haiku-5-5');
    expect(w.bodies).toHaveLength(4);
    expect(w.bodies[0]?.thinking).toEqual({ type: 'adaptive', display: 'summarized', block_binding: DROP_BLOCK });
    expect(w.betas(0)).toContain(BINDING_BETA);
    for (const i of [1, 2]) {
      expect(w.bodies[i]?.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(w.betas(i)).not.toContain(BINDING_BETA);
    }
    expect(w.bodies[3]?.thinking).toEqual({ type: 'adaptive', display: 'summarized', block_binding: DROP_BLOCK });
    expect(w.betas(3)).toContain(BINDING_BETA);
  });

  test('Haiku 5.5 in each reasoning state: its setting with the control when on, the reasoning-off config with it when off', async () => {
    const on = wire(() => ({ enabled: true, budgetTokens: 0, display: 'omitted' }));
    await on.stream('claude-haiku-5-5');
    const offWire = wire(off);
    await offWire.stream('claude-haiku-5-5');
    expect(on.bodies).toHaveLength(1);
    expect(offWire.bodies).toHaveLength(1);
    expect(on.bodies[0]?.thinking).toEqual({ type: 'adaptive', display: 'omitted', block_binding: DROP_BLOCK });
    expect(offWire.bodies[0]?.thinking).toEqual({ type: 'adaptive', display: 'omitted', block_binding: DROP_BLOCK });
    const summarized = wire(() => ({ enabled: true, budgetTokens: 0 }));
    await summarized.stream('claude-haiku-5-5');
    expect(summarized.bodies[0]?.thinking).toEqual({ type: 'adaptive', display: 'summarized', block_binding: DROP_BLOCK });
  });

  test('one-shot calls (complete) get no control, with reasoning off or on', async () => {
    const quiet = wire(off);
    await quiet.complete('claude-sonnet-5-5');
    expect(quiet.bodies).toHaveLength(1);
    expect(quiet.bodies[0]?.thinking).toBeUndefined();
    expect(quiet.betas(0)).not.toContain(BINDING_BETA);
    const on = wire(() => ({ enabled: true, budgetTokens: 0, display: 'omitted' }));
    await on.complete('claude-sonnet-5-5');
    expect(on.bodies).toHaveLength(1);
    expect(on.bodies[0]?.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
    expect(on.betas(0)).not.toContain(BINDING_BETA);
  });
});

describe('thinkingBindingSettings and the agent config', () => {
  test('a binding model on the Anthropic route gets the control and its window', () => {
    expect(thinkingBindingSettings('claude-opus-5-5', 'anthropic'))
      .toEqual({ thinkingBinding: { binds: true, dropBlock: true }, physicalWindowTokens: 1_000_000 });
  });

  test.each(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])(
    '%s gets the 1,000,000-token window its provider\'s refusal showed, from the limits table', (model) => {
      expect(getDefaultModelLimits(model)?.maxContextTokens).toBe(1_000_000);
      expect(thinkingBindingSettings(model, 'anthropic').physicalWindowTokens).toBe(1_000_000);
    },
  );

  test('on another route, or one not stated, it binds without the control and has no window', () => {
    for (const provider of ['bedrock', 'openrouter', undefined]) {
      expect(thinkingBindingSettings('claude-opus-5-5', provider)).toEqual({ thinkingBinding: { binds: true, dropBlock: false } });
    }
  });

  test('a model recorded as binding without the control binds, with no window', () => {
    for (const model of ['claude-mythos-5-1', 'claude-opus-5-6']) {
      expect(thinkingBindingSettings(model, 'anthropic')).toEqual({ thinkingBinding: { binds: true, dropBlock: false } });
    }
  });

  test('a model that doesn\'t bind gets neither', () => {
    for (const model of ['claude-opus-4-8', 'claude-opus-5', 'gpt-5.4']) {
      expect(thinkingBindingSettings(model, 'anthropic')).toEqual({});
    }
  });

  test('a model from before Claude 4.5 gets no binding, no window and no fold line, as before', () => {
    for (const model of ['claude-opus-4-1', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219']) {
      expect(thinkingBindingSettings(model, 'anthropic')).toEqual({});
      expect(systemPromptFor('Be yourself.', model)).toBe('Be yourself.');
    }
  });

  const recipe = (provider?: string) => validateRecipe({
    name: 'binding',
    agent: { systemPrompt: 'Be yourself.', ...(provider ? { provider } : {}) },
  });
  const build = (model: string, provider?: string) => buildFrameworkAgentConfig(recipe(provider), 'a', model, { kind: 's' } as never);

  test('buildFrameworkAgentConfig sets them, and the fold line, from the model and the recipe\'s provider', () => {
    const direct = build('claude-sonnet-5-5');
    expect(direct.thinkingBinding).toEqual({ binds: true, dropBlock: true });
    expect(direct.physicalWindowTokens).toBe(1_000_000);
    expect(direct.systemPrompt).toBe(`Be yourself.\n\n${FOLD_REASONING_LINE}`);
    const bedrock = build('claude-sonnet-5-5', 'bedrock');
    expect(bedrock.thinkingBinding).toEqual({ binds: true, dropBlock: false });
    expect(bedrock.physicalWindowTokens).toBeUndefined();
    expect(bedrock.systemPrompt).toBe(`Be yourself.\n\n${FOLD_REASONING_LINE}`);
    const older = build('claude-opus-4-8');
    expect(older.thinkingBinding).toBeUndefined();
    expect(older.physicalWindowTokens).toBeUndefined();
    expect(older.systemPrompt).toBe('Be yourself.');
  });
});

describe('the fold line and the recipe\'s formatter', () => {
  const xml = (systemPrompt: string, prefillUserMessage?: string) => validateRecipe({
    name: 'xml',
    agent: { systemPrompt, formatter: 'anthropic-xml', ...(prefillUserMessage ? { prefillUserMessage } : {}) },
  });
  // Membrane refuses assistant prefill on the binding models the record names.
  const promptOf = (recipe: ReturnType<typeof validateRecipe>, model = 'claude-opus-6') =>
    buildFrameworkAgentConfig(recipe, 'a', model, { kind: 's' } as never).systemPrompt;

  test('an agent under an anthropic-xml recipe never gets the line, whatever its prompt or prefill message', () => {
    expect(promptOf(xml(''))).toBe('');
    expect(promptOf(xml('', '<cmd>cat untitled.txt</cmd>'))).toBe('');
    expect(promptOf(xml('You are you.'))).toBe('You are you.');
    expect(systemPromptFor('You are you.', 'claude-opus-6', 'anthropic-xml')).toBe('You are you.');
    expect(systemPromptFor(`You are you.\n\n${FOLD_REASONING_LINE}`, 'claude-opus-6', 'anthropic-xml')).toBe('You are you.');
    expect(systemPromptFor(FOLD_REASONING_LINE, 'claude-opus-6', 'anthropic-xml')).toBe('');
  });

  test('under a native recipe, a binding model gets it, an empty prompt included', () => {
    const native = (systemPrompt: string) => validateRecipe({ name: 'native', agent: { systemPrompt } });
    expect(promptOf(native(''))).toBe(FOLD_REASONING_LINE);
    expect(promptOf(native('You are you.'))).toBe(`You are you.\n\n${FOLD_REASONING_LINE}`);
    expect(promptOf(validateRecipe({ name: 'n', agent: { systemPrompt: '', formatter: 'native' } }))).toBe(FOLD_REASONING_LINE);
  });
});

describe('systemPromptFor', () => {
  test('the line, word for word', () => {
    expect(FOLD_REASONING_LINE).toBe(
      'When your context folds, the reasoning behind your earlier replies leaves it, though their words stay, ' +
      'so a reply of yours that shows no reasoning may still have had some.',
    );
  });

  test('ends a binding model\'s prompt with the line, as its own paragraph, once', () => {
    const once = systemPromptFor('Be yourself.', 'claude-opus-5-5');
    expect(once).toBe(`Be yourself.\n\n${FOLD_REASONING_LINE}`);
    expect(systemPromptFor(once, 'claude-opus-5-5')).toBe(once);
    expect(systemPromptFor('', 'claude-opus-5-5')).toBe(FOLD_REASONING_LINE);
    expect(systemPromptFor(FOLD_REASONING_LINE, 'claude-mythos-5-1')).toBe(FOLD_REASONING_LINE);
  });

  test('gives another model the prompt without the line, taking off a copied one', () => {
    expect(systemPromptFor('Be yourself.', 'claude-opus-4-8')).toBe('Be yourself.');
    expect(systemPromptFor(`Be yourself.\n\n${FOLD_REASONING_LINE}`, 'claude-opus-4-8')).toBe('Be yourself.');
    expect(systemPromptFor(FOLD_REASONING_LINE, 'claude-opus-4-8')).toBe('');
  });
});

describe('subagents', () => {
  async function harness(parentModel: string, parentPrompt: string, provider = 'anthropic', formatter?: 'native' | 'anthropic-xml') {
    const membrane = new Membrane(new MockAdapter({ defaultResponse: 'ok' }), { formatter: new NativeFormatter() });
    const subagent = new SubagentModule({
      provider,
      ...(formatter !== undefined ? { formatter } : {}),
      parentAgentName: 'parent',
      defaultModel: 'claude-opus-5-5',
      defaultMaxTokens: 256,
      maxRetries: 0,
    });
    const framework = await AgentFramework.create({
      storePath: join(mkdtempSync(join(tmpdir(), 'sub-binding-')), 'store'),
      membrane,
      agents: [{ name: 'parent', model: parentModel, systemPrompt: parentPrompt, maxTokens: 256 }],
      modules: [subagent as unknown as Module],
    });
    subagent.setFramework(framework);
    type Launch = Parameters<typeof describeSubagentLaunch>[0];
    const inner = subagent as unknown as {
      resolveLaunch(kind: 'spawn' | 'fork', input: Record<string, unknown>, caller: string, depth: number): Launch;
      ephemeralAgentConfig(launch: Launch, name: string): Record<string, unknown>;
    };
    return { framework, inner };
  }

  test('a spawn on a binding model gets the fold line, the control and its window', async () => {
    const { framework, inner } = await harness('claude-opus-4-8', 'parent');
    try {
      const launch = inner.resolveLaunch('spawn', { name: 'child', systemPrompt: 'Look it up.', task: 't' }, 'parent', 0);
      expect(launch.systemPrompt).toBe(`Look it up.\n\n${FOLD_REASONING_LINE}`);
      const config = inner.ephemeralAgentConfig(launch, 'child-1');
      expect(config.systemPrompt).toBe(launch.systemPrompt);
      expect(config.thinkingBinding).toEqual({ binds: true, dropBlock: true });
      expect(config.physicalWindowTokens).toBe(1_000_000);
      const plain = inner.resolveLaunch('spawn', { name: 'old', systemPrompt: 'Look it up.', task: 't', model: 'claude-opus-4-8' }, 'parent', 0);
      expect(plain.systemPrompt).toBe('Look it up.');
      const plainConfig = inner.ephemeralAgentConfig(plain, 'old-1');
      expect(plainConfig.thinkingBinding).toBeUndefined();
      expect(plainConfig.physicalWindowTokens).toBeUndefined();
    } finally {
      await framework.stop();
    }
  });

  test('a spawn on Bedrock binds without the control and has no window', async () => {
    const { framework, inner } = await harness('claude-opus-4-8', 'parent', 'bedrock');
    try {
      const launch = inner.resolveLaunch('spawn', { name: 'child', systemPrompt: 'Look it up.', task: 't' }, 'parent', 0);
      expect(launch.systemPrompt).toBe(`Look it up.\n\n${FOLD_REASONING_LINE}`);
      const config = inner.ephemeralAgentConfig(launch, 'child-1');
      expect(config.thinkingBinding).toEqual({ binds: true, dropBlock: false });
      expect(config.physicalWindowTokens).toBeUndefined();
    } finally {
      await framework.stop();
    }
  });

  test("a fork's copy of its parent's prompt has the line once, or not at all on a model that doesn't bind, and its receipt says which", async () => {
    const parentPrompt = systemPromptFor('parent', 'claude-opus-5-5');
    const { framework, inner } = await harness('claude-opus-5-5', parentPrompt);
    try {
      const same = inner.resolveLaunch('fork', { name: 'f', task: 't' }, 'parent', 0);
      expect(same.systemPrompt).toBe(parentPrompt);
      expect(same.systemPromptSource).toBe('parent');
      expect(same.systemPromptFoldLine).toBeUndefined();
      expect(describeSubagentLaunch(same)).toContain("- System prompt: the parent's.");
      const older = inner.resolveLaunch('fork', { name: 'g', task: 't', model: 'claude-opus-4-8' }, 'parent', 0);
      expect(older.systemPrompt).toBe('parent');
      expect(older.systemPromptSource).toBe('parent');
      expect(older.systemPromptFoldLine).toBe('removed');
      const olderReceipt = describeSubagentLaunch(older);
      expect(olderReceipt).toContain("- System prompt: the parent's, with the host's paragraph on folds taken off.");
      expect(olderReceipt).toMatch(/Differs in [^.]*system prompt/);
      expect(olderReceipt).not.toMatch(/Same: [^.]*system prompt/);
      const passed = inner.resolveLaunch('fork', { name: 'h', task: 't', systemPrompt: 'parent' }, 'parent', 0);
      expect(passed.systemPromptSource).toBe('parent');
      expect(passed.systemPrompt).toBe(parentPrompt);
      const other = inner.resolveLaunch('fork', { name: 'i', task: 't', systemPrompt: 'other' }, 'parent', 0);
      expect(other.systemPromptSource).toBe('override');
      expect(other.systemPrompt).toBe(`other\n\n${FOLD_REASONING_LINE}`);
      expect(other.systemPromptFoldLine).toBe('added');
      expect(describeSubagentLaunch(other)).toContain("- System prompt: overridden for this fork, with the host's paragraph on folds added.");
      const spawn = inner.resolveLaunch('spawn', { name: 's', systemPrompt: 'Look it up.', task: 't' }, 'parent', 0);
      expect(spawn.systemPromptFoldLine).toBe('added');
      expect(describeSubagentLaunch(spawn)).toContain("- System prompt: supplied by the caller for this spawn, with the host's paragraph on folds added.");
      const already = inner.resolveLaunch('spawn', { name: 't', systemPrompt: parentPrompt, task: 't' }, 'parent', 0);
      expect(already.systemPrompt).toBe(parentPrompt);
      expect(already.systemPromptFoldLine).toBeUndefined();
    } finally {
      await framework.stop();
    }
  });

  test('under an anthropic-xml recipe no subagent gets the line: a fork keeps its parent\'s prompt as it is, and a spawn has its own', async () => {
    const { framework, inner } = await harness('claude-opus-6', '', 'anthropic', 'anthropic-xml');
    try {
      const fork = inner.resolveLaunch('fork', { name: 'f', task: 't' }, 'parent', 0);
      expect(fork.systemPrompt).toBe('');
      expect(fork.systemPromptSource).toBe('parent');
      expect(fork.systemPromptFoldLine).toBeUndefined();
      expect(describeSubagentLaunch(fork)).toContain("- System prompt: the parent's.");
      const spawn = inner.resolveLaunch('spawn', { name: 's', systemPrompt: 'Look it up.', task: 't' }, 'parent', 0);
      expect(spawn.systemPrompt).toBe('Look it up.');
      expect(spawn.systemPromptFoldLine).toBeUndefined();
      const copied = inner.resolveLaunch('spawn', { name: 'c', systemPrompt: `Look it up.\n\n${FOLD_REASONING_LINE}`, task: 't' }, 'parent', 0);
      expect(copied.systemPrompt).toBe('Look it up.');
      expect(copied.systemPromptFoldLine).toBe('removed');
      const passed = inner.resolveLaunch('fork', { name: 'g', task: 't', systemPrompt: '' }, 'parent', 0);
      expect(passed.systemPromptSource).toBe('parent');
    } finally {
      await framework.stop();
    }
    const plain = await harness('claude-opus-6', '', 'anthropic', 'native');
    try {
      const fork = plain.inner.resolveLaunch('fork', { name: 'f', task: 't' }, 'parent', 0);
      expect(fork.systemPrompt).toBe(FOLD_REASONING_LINE);
      expect(fork.systemPromptFoldLine).toBe('added');
    } finally {
      await plain.framework.stop();
    }
  });

  test("a fork onto a binding model from a parent whose model doesn't bind gets the line, and its receipt says so", async () => {
    const { framework, inner } = await harness('claude-opus-4-8', 'parent');
    try {
      const fork = inner.resolveLaunch('fork', { name: 'f', task: 't', model: 'claude-opus-5-5' }, 'parent', 0);
      expect(fork.systemPrompt).toBe(`parent\n\n${FOLD_REASONING_LINE}`);
      expect(fork.systemPromptFoldLine).toBe('added');
      expect(describeSubagentLaunch(fork)).toContain("- System prompt: the parent's, with the host's paragraph on folds added.");
      const passed = inner.resolveLaunch('fork', { name: 'g', task: 't', model: 'claude-opus-5-5', systemPrompt: 'parent' }, 'parent', 0);
      expect(passed.systemPromptSource).toBe('parent');
      expect(passed.systemPromptFoldLine).toBe('added');
    } finally {
      await framework.stop();
    }
  });
});
