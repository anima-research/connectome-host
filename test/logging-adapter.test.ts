import { describe, test, expect } from 'bun:test';
import { LoggingAnthropicAdapter } from '../src/logging-adapter.js';
import { cacheLineageKey, Membrane, NativeFormatter } from '@animalabs/membrane';
import type { ProviderCallRecord } from '../src/call-ledger.js';
import type { ProviderRequest, ProviderResponse } from '@animalabs/membrane';
import type { ModuleContext } from '@animalabs/agent-framework';
import { SettingsModule } from '../src/modules/settings-module.js';
import { validateRecipe } from '../src/recipe.js';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Regression guard for the reasoning passthrough. `withReasoning` injects
// adaptive `thinking` into `request.extra`, which the Anthropic adapter
// forwards to the API params verbatim. This is invisible to the type system
// (membrane's ProviderRequest doesn't type `thinking`), so it's exactly the
// kind of contract that silently rots on a dependency bump — pin it here so
// the next break is a red test with a name, not a tsc error blamed on the
// wrong package (see the git history of this file).

const baseRequest: ProviderRequest = {
  messages: [],
  model: 'claude-opus-4-6',
  maxTokens: 1024,
};

const enabled = () => ({ enabled: true, budgetTokens: 0 });
const disabled = () => ({ enabled: false, budgetTokens: 0 });

describe('LoggingAnthropicAdapter.withReasoning', () => {
  test('injects adaptive thinking into request.extra when reasoning enabled', () => {
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null', enabled);
    const out = (adapter as unknown as { withReasoning(r: ProviderRequest): ProviderRequest })
      .withReasoning(baseRequest);
    expect((out.extra as Record<string, { type?: string }> | undefined)?.thinking?.type).toBe('adaptive');
    // shallow clone — original request untouched
    expect((baseRequest as { extra?: unknown }).extra).toBeUndefined();
  });

  test('preserves pre-existing extra keys', () => {
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null', enabled);
    const req = { ...baseRequest, extra: { normalizedMessages: 'keep-me' } } as ProviderRequest;
    const out = (adapter as unknown as { withReasoning(r: ProviderRequest): ProviderRequest })
      .withReasoning(req);
    const extra = out.extra as Record<string, unknown>;
    expect(extra.normalizedMessages).toBe('keep-me');
    expect((extra.thinking as { type?: string }).type).toBe('adaptive');
  });

  test('no-op (same reference) when reasoning disabled', () => {
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null', disabled);
    const out = (adapter as unknown as { withReasoning(r: ProviderRequest): ProviderRequest })
      .withReasoning(baseRequest);
    expect(out).toBe(baseRequest);
  });

  test('no-op when no reasoning getter is wired', () => {
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null');
    const out = (adapter as unknown as { withReasoning(r: ProviderRequest): ProviderRequest })
      .withReasoning(baseRequest);
    expect(out).toBe(baseRequest);
  });

  // Reasoning is host-wide, but every call through the shared membrane passes
  // here — including RetrievalModule's Haiku calls. Models without adaptive
  // thinking 400 on it, so they must go out untouched.
  test.each([
    'claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-5',
    'claude-opus-4-1', 'anthropic.claude-haiku-4-5', 'claude-opus-4-5@20251101',
  ])('no thinking for %s (rejects adaptive)', (model) => {
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null', enabled);
    const req = { ...baseRequest, model };
    const out = (adapter as unknown as { withReasoning(r: ProviderRequest): ProviderRequest })
      .withReasoning(req);
    expect(out).toBe(req);
  });

  test.each([
    'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5',
    'claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-fable-5', 'claude-fable-5-1',
    'claude-mythos-5-1', 'anthropic.claude-opus-5-5',
  ])('adaptive thinking for %s', (model) => {
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null', enabled);
    const out = (adapter as unknown as { withReasoning(r: ProviderRequest): ProviderRequest })
      .withReasoning({ ...baseRequest, model });
    expect((out.extra as Record<string, { type?: string }> | undefined)?.thinking?.type).toBe('adaptive');
  });
});

describe('LoggingAnthropicAdapter.withEffort', () => {
  type WithEffort = { withEffort(r: ProviderRequest): ProviderRequest };
  const fable: ProviderRequest = { ...baseRequest, model: 'claude-fable-5-1' };
  const withEffort = (effort: string | undefined, req: ProviderRequest = fable) => {
    const getter = () => ({ enabled: false, budgetTokens: 0, effort }) as ReturnType<
      NonNullable<ConstructorParameters<typeof LoggingAnthropicAdapter>[2]>
    >;
    const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null', getter);
    return (adapter as unknown as WithEffort).withEffort(req);
  };

  test('sends output_config.effort even with reasoning_enabled false', () => {
    const out = withEffort('low');
    expect((out.extra as { output_config?: unknown }).output_config).toEqual({ effort: 'low' });
    expect((fable as { extra?: unknown }).extra).toBeUndefined();
  });

  test("no-op (same reference) for 'default' and for unset", () => {
    expect(withEffort('default')).toBe(fable);
    expect(withEffort(undefined)).toBe(fable);
  });

  test('merges into an existing output_config instead of replacing it', () => {
    const req = { ...fable, extra: { output_config: { format: { type: 'json_schema' } }, keep: 1 } } as ProviderRequest;
    const extra = withEffort('max', req).extra as Record<string, unknown>;
    expect(extra.output_config).toEqual({ format: { type: 'json_schema' }, effort: 'max' });
    expect(extra.keep).toBe(1);
  });

  test('drops levels the model rejects rather than bricking its turns', () => {
    expect(withEffort('high', { ...baseRequest, model: 'claude-haiku-4-5' }).extra).toBeUndefined();
    expect(withEffort('xhigh', { ...baseRequest, model: 'claude-opus-4-6' }).extra).toBeUndefined();
    expect(withEffort('max', { ...baseRequest, model: 'claude-opus-4-5' }).extra).toBeUndefined();
    expect(withEffort('max', { ...baseRequest, model: 'claude-opus-4-6' }).extra).toBeDefined();
    expect(withEffort('xhigh', { ...baseRequest, model: 'claude-opus-5-5' }).extra).toBeDefined();
  });

  test('never sends a level outside the known set, whatever the model', () => {
    expect(withEffort('minimal')).toBe(fable);
    expect(withEffort('minimal', { ...baseRequest, model: 'claude-opus-4-6' }).extra).toBeUndefined();
  });
});

// On Fable 5/5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5 the notes the model
// writes between tool calls come back as signed thinking blocks, empty under
// display 'omitted', the default. The host never leaves them empty there.
describe('LoggingAnthropicAdapter.withProgressNotes', () => {
  type WithProgressNotes = { withProgressNotes(r: ProviderRequest): ProviderRequest };
  const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null');
  const notes = (req: ProviderRequest) => (adapter as unknown as WithProgressNotes).withProgressNotes(req);
  const thinkingOf = (req: ProviderRequest) => (req.extra as { thinking?: unknown } | undefined)?.thinking;
  const opus55: ProviderRequest = { ...baseRequest, model: 'claude-opus-5-5' };

  test.each([
    'claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5',
    'anthropic.claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'claude-opus-5-5[1m]',
    // Dated snapshots, in the forms the repo uses elsewhere.
    'claude-opus-5-5-20260301', 'claude-sonnet-5-5-20260101', 'claude-fable-5-1-20261001', 'claude-opus-5-5@20260301',
  ])('sends adaptive thinking with display updates to %s when no config would be sent', (model) => {
    const req = { ...baseRequest, model };
    expect(thinkingOf(notes(req))).toEqual({ type: 'adaptive', display: 'updates' });
    expect((req as { extra?: unknown }).extra).toBeUndefined();
  });

  test.each([
    'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-haiku-4-5',
    'claude-mythos-5', 'claude-fable-5-2', 'claude-opus-5-6', 'claude-opus-5-50',
    // A version after the listed one is another model, not a snapshot of it.
    'claude-fable-5-10', 'claude-fable-5-1-1', 'claude-mythos-5-12',
  ])('leaves %s untouched (same reference)', (model) => {
    const req = { ...baseRequest, model };
    expect(notes(req)).toBe(req);
  });

  test("turns an explicit 'omitted', in extra or top-level, into 'updates', keeping the config's other fields", () => {
    const viaExtra = { ...opus55, extra: { keep: 1, thinking: { type: 'adaptive', display: 'omitted' } } } as ProviderRequest;
    const out = notes(viaExtra);
    expect(thinkingOf(out)).toEqual({ type: 'adaptive', display: 'updates' });
    expect((out.extra as Record<string, unknown>).keep).toBe(1);
    const binding = { prefix_mismatch_behavior: 'drop_block' };
    const topLevel = { ...opus55, thinking: { type: 'adaptive', display: 'omitted', block_binding: binding } } as ProviderRequest;
    expect(thinkingOf(notes(topLevel))).toEqual({ type: 'adaptive', display: 'updates', block_binding: binding });
    // A top-level config with no display is the default ('omitted') too.
    const noDisplay = { ...opus55, thinking: { type: 'adaptive', block_binding: binding } } as ProviderRequest;
    expect(thinkingOf(notes(noDisplay))).toEqual({ type: 'adaptive', block_binding: binding, display: 'updates' });
  });

  test('extra.thinking wins over request.thinking, as in the adapter', () => {
    const req = {
      ...opus55,
      thinking: { type: 'adaptive', display: 'summarized' },
      extra: { thinking: { type: 'adaptive', display: 'omitted' } },
    } as ProviderRequest;
    expect(thinkingOf(notes(req))).toEqual({ type: 'adaptive', display: 'updates' });
  });

  test("leaves 'summarized' and 'updates' alone: both return the notes", () => {
    for (const display of ['summarized', 'updates']) {
      const req = { ...opus55, extra: { thinking: { type: 'adaptive', display } } } as ProviderRequest;
      expect(notes(req)).toBe(req);
    }
  });

  test("leaves a config of another type alone ('disabled', 'between_tools')", () => {
    for (const type of ['disabled', 'between_tools']) {
      const req = { ...baseRequest, model: 'claude-sonnet-5-5', extra: { thinking: { type } } } as ProviderRequest;
      expect(notes(req)).toBe(req);
    }
  });

  /** A real adapter whose SDK client records each streamed request's body and headers. */
  const wireAdapter = (reasoning: () => { enabled: boolean; budgetTokens: number; display?: 'summarized' | 'omitted' }) => {
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
      },
    };
    const send = (model: string) => live.stream(
      { ...baseRequest, model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as ProviderRequest,
      { onChunk: () => {} },
    );
    const betas = (i: number) => (headers[i]?.['anthropic-beta'] ?? '').split(',').filter(Boolean);
    return { bodies, betas, send, live };
  };

  test('with reasoning off, the wire request still asks for updates, with the beta that needs (stream lane, through the real adapter)', async () => {
    const wire = wireAdapter(disabled);
    await wire.send('claude-opus-5-5');
    await wire.send('claude-fable-5-1');
    await wire.send('claude-opus-4-8');
    // Every call reached the client, so the other model's omissions below aren't vacuous.
    expect(wire.bodies).toHaveLength(3);
    for (const i of [0, 1]) {
      expect(wire.bodies[i]?.thinking).toEqual({ type: 'adaptive', display: 'updates' });
      // membrane >= 0.7.0 adds the beta 'updates' needs; without it the API refuses the value.
      expect(wire.betas(i)).toContain('thinking-display-updates-2026-08-18');
      // No binding controls were asked for, so none go, nor their beta.
      expect(wire.betas(i)).not.toContain('thinking-binding-controls-2026-08-01');
    }
    // Another model gets neither.
    expect(wire.bodies[2]?.thinking).toBeUndefined();
    expect(wire.betas(2)).not.toContain('thinking-display-updates-2026-08-18');
  });

  test("with reasoning on, stream() applies the reasoning setting before the progress-note step", async () => {
    // 'omitted' is turned into 'updates' only because withReasoning has run first.
    const wire = wireAdapter(() => ({ enabled: true, budgetTokens: 0, display: 'omitted' as const }));
    await wire.send('claude-opus-5-5');
    await wire.send('claude-opus-4-8');
    expect(wire.bodies).toHaveLength(2);
    expect(wire.bodies[0]?.thinking).toEqual({ type: 'adaptive', display: 'updates' });
    expect(wire.betas(0)).toContain('thinking-display-updates-2026-08-18');
    // Elsewhere the chosen display goes as chosen.
    expect(wire.bodies[1]?.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
    // 'summarized' is left alone on the listed models, Fable's included: with
    // reasoning on, the setting's config goes in `extra`, which membrane doesn't drop.
    const summarized = wireAdapter(() => ({ enabled: true, budgetTokens: 0, display: 'summarized' as const }));
    await summarized.send('claude-opus-5-5');
    await summarized.send('claude-fable-5-1');
    expect(summarized.bodies).toHaveLength(2);
    for (const i of [0, 1]) {
      expect(summarized.bodies[i]?.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
      expect(summarized.betas(i)).not.toContain('thinking-display-updates-2026-08-18');
    }
  });

  test("through membrane, a recipe's 'summarized' goes as 'updates' wherever membrane sends no config for it, as chosen where it sends one, and the reasoning setting decides over it", async () => {
    // membrane sends the Fable and Mythos family a thinking config only for
    // binding controls or 'updates' (buildThinkingParam), and another model one
    // only when the recipe's `enabled` is true. Where it sends none, the step
    // adds 'updates' on the listed models. Mythos 5 isn't listed, so nothing
    // goes there.
    const recipeSend = (membrane: Membrane, model: string, enabled = true) => membrane.stream({
      messages: [{ participant: 'user', content: [{ type: 'text', text: 'hi' }] }],
      config: { model, maxTokens: 64, thinking: { enabled, type: 'adaptive', display: 'summarized' } },
    }, { onChunk: () => {} });
    const updates = { type: 'adaptive', display: 'updates' };
    const off = wireAdapter(disabled);
    const viaOff = new Membrane(off.live, { formatter: new NativeFormatter() });
    for (const model of ['claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5-1']) await recipeSend(viaOff, model);
    await recipeSend(viaOff, 'claude-opus-5-5', false);
    await recipeSend(viaOff, 'claude-opus-5-5');
    await recipeSend(viaOff, 'claude-mythos-5');
    expect(off.bodies).toHaveLength(6);
    for (const i of [0, 1, 2, 3]) {
      expect(off.bodies[i]?.thinking).toEqual(updates);
      expect(off.betas(i)).toContain('thinking-display-updates-2026-08-18');
    }
    expect(off.bodies[4]?.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(off.betas(4)).not.toContain('thinking-display-updates-2026-08-18');
    expect(off.bodies[5]?.thinking).toBeUndefined();
    // With reasoning on, the setting's display goes in place of the recipe's
    // (on a model the step leaves alone, so only withReasoning acts).
    const on = wireAdapter(() => ({ enabled: true, budgetTokens: 0, display: 'omitted' as const }));
    await recipeSend(new Membrane(on.live, { formatter: new NativeFormatter() }), 'claude-opus-4-8');
    expect(on.bodies).toHaveLength(1);
    expect(on.bodies[0]?.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
  });

  test('complete() gets no progress-note step, and the reasoning setting still applies there', async () => {
    const oneShot = (reasoning: () => { enabled: boolean; budgetTokens: number; display?: 'summarized' | 'omitted' }) => {
      const bodies: Array<Record<string, unknown>> = [];
      const live = new LoggingAnthropicAdapter({ apiKey: 'test', cacheKeepalive: { enabled: false } }, '/dev/null', reasoning);
      (live as unknown as { client: unknown }).client = {
        withOptions() { return this; },
        messages: {
          create: async (body: Record<string, unknown>) => {
            bodies.push(body);
            return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 } };
          },
        },
      };
      const send = () => live.complete({ ...opus55, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as ProviderRequest);
      return { bodies, send };
    };
    // With reasoning off, a one-shot call goes with no thinking config.
    const off = oneShot(disabled);
    await off.send();
    expect(off.bodies).toHaveLength(1);
    expect(off.bodies[0]?.thinking).toBeUndefined();
    // With reasoning on, it carries the setting's config, 'omitted' left as chosen.
    const on = oneShot(() => ({ enabled: true, budgetTokens: 0, display: 'omitted' as const }));
    await on.send();
    expect(on.bodies).toHaveLength(1);
    expect(on.bodies[0]?.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
  });
});

describe('LoggingAnthropicAdapter initial recipe effort', () => {
  test('native index constructs settings with the recipe effort before dispatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chost-initial-effort-'));
    const recipePath = join(dir, 'recipe.json');
    const captured = join(dir, 'settings.json');
    const preload = join(dir, 'capture-settings.ts');
    const settingsPath = resolve(import.meta.dir, '../src/modules/settings-module.ts');
    writeFileSync(recipePath, JSON.stringify({
      name: 'Initial effort startup',
      agent: { provider: 'mock', systemPrompt: 'No inference requested', thinking: { enabled: false, effort: 'medium' } },
      modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
    }));
    // Spy on the existing constructor in a separate process. Index must supply
    // the recipe value; constructing a module in this test would miss that wire.
    writeFileSync(preload, `
      import { mock } from 'bun:test';
      import { writeFileSync } from 'node:fs';
      import { SettingsModule } from ${JSON.stringify(settingsPath)};
      class CapturedSettings extends SettingsModule {
        constructor(...args) {
          super(...args);
          writeFileSync(${JSON.stringify(captured)}, JSON.stringify(this.getReasoning()));
        }
      }
      mock.module(${JSON.stringify(settingsPath)}, () => ({ SettingsModule: CapturedSettings }));
    `);
    const child = Bun.spawn([process.execPath, '--preload', preload, resolve(import.meta.dir, '../src/index.ts'), recipePath, '--no-tui'], {
      cwd: dir, env: { ...process.env, DATA_DIR: join(dir, 'data') },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    try {
      const [exit, _stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(exit, stderr).toBe(0);
      expect(JSON.parse(readFileSync(captured, 'utf8')).effort).toBe('medium');
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test('first stream builds medium effort on the wire without a settings update', async () => {
    const recipe = validateRecipe({
      name: 'initial-effort-test',
      agent: { systemPrompt: 'sys', thinking: { enabled: false, effort: 'medium' } },
    });
    const settings = new SettingsModule(recipe.agent.thinking?.effort);
    await settings.start({ getState: () => undefined } as unknown as ModuleContext);
    const config = buildFrameworkAgentConfig(recipe, 'agent', baseRequest.model, undefined);
    let wire: unknown;
    let requests = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        requests += 1;
        wire = await request.json();
        return Response.json({ error: { type: 'invalid_request_error', message: 'local request fixture' } }, { status: 400 });
      },
    });
    try {
      const adapter = new LoggingAnthropicAdapter(
        { apiKey: 'test', baseURL: server.url.href, cacheKeepalive: { enabled: false } },
        '/dev/null', () => settings.getReasoning(),
      );
      await expect(adapter.stream(baseRequest, {})).rejects.toThrow(/local request fixture/);
      expect(requests).toBe(1);
      expect(wire).toMatchObject({ output_config: { effort: 'medium' }, stream: true });
      expect(config.thinking).toEqual({ enabled: false });
      expect((wire as { thinking?: unknown }).thinking).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});

describe('LoggingAnthropicAdapter cache lineage', () => {
  test("a stream call's row and its live ledger record name the wire request's cache lineage", async () => {
    let wire: Record<string, unknown> | undefined;
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        wire = await request.json() as Record<string, unknown>;
        return Response.json({ error: { type: 'invalid_request_error', message: 'local request fixture' } }, { status: 400 });
      },
    });
    const dir = mkdtempSync(join(tmpdir(), 'stream-lineage-'));
    const seen: ProviderCallRecord[] = [];
    try {
      const adapter = new LoggingAnthropicAdapter(
        { apiKey: 'test', baseURL: server.url.href, cacheKeepalive: { enabled: false } },
        join(dir, 'llm-calls.test.jsonl'), undefined, (call) => { seen.push(call); },
      );
      // A system prompt and a tool, which the lineage key covers beside the model.
      const request = { ...baseRequest, system: 'You are a fixture.', tools: [{ name: 'shell', description: 'run a command', inputSchema: { type: 'object', properties: {} } }] } as ProviderRequest;
      await expect(adapter.stream(request, {})).rejects.toThrow(/local request fixture/);
      expect(wire).toMatchObject({ tools: [{ name: 'shell' }] });
      expect(JSON.stringify(wire!.system)).toContain('You are a fixture.');
      const row = JSON.parse(readFileSync(join(dir, 'llm-calls.test.jsonl'), 'utf8').trim());
      expect(row.kind).toBe('stream');
      expect(typeof row.requestSummary.lineage).toBe('string');
      expect(row.requestSummary.lineage).toBe(cacheLineageKey(wire!));
      expect(seen.map((call) => [call.kind, call.lineage])).toEqual([['stream', row.requestSummary.lineage]]);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('LoggingAnthropicAdapter request logging', () => {
  const adapter = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null');
  const internals = adapter as unknown as {
    requestSummary(r: ProviderRequest, raw?: unknown): Record<string, unknown>;
    retainedRawRequest(r: ProviderResponse, raw: unknown): unknown;
  };

  test('summarizes requests without retaining message content', () => {
    const request = {
      ...baseRequest,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'large context' }] }],
      tools: [{ name: 'shell', description: 'run a command', inputSchema: {} }],
    } as ProviderRequest;

    expect(internals.requestSummary(request)).toEqual({
      model: 'claude-opus-4-6',
      maxTokens: 1024,
      messages: 1,
      tools: 1,
    });
  });

  test('summarizes provider cache markers without retaining prompt content', () => {
    const raw = {
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'do not log me', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      }],
    };
    expect(internals.requestSummary(baseRequest, raw)).toMatchObject({
      cacheBreakpoints: 1,
      cacheTtls: ['1h'],
    });
    expect(JSON.stringify(internals.requestSummary(baseRequest, raw))).not.toContain('do not log me');
  });

  test('of calls that get a response, retains the raw request only for refusals', () => {
    const rawRequest = { messages: ['forensic context'] };
    const success = { raw: { stop_reason: 'end_turn' } } as unknown as ProviderResponse;
    const refusal = { raw: { stop_reason: 'refusal' } } as unknown as ProviderResponse;

    expect(internals.retainedRawRequest(success, rawRequest)).toBeUndefined();
    expect(internals.retainedRawRequest(refusal, rawRequest)).toBe(rawRequest);
  });

  test('LLM_CALLS_FULL_PAYLOADS=1 retains the raw request on every call', () => {
    const prev = process.env.LLM_CALLS_FULL_PAYLOADS;
    process.env.LLM_CALLS_FULL_PAYLOADS = '1';
    try {
      const full = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null');
      const fi = full as unknown as typeof internals;
      const rawRequest = { messages: ['forensic context'] };
      const success = { raw: { stop_reason: 'end_turn' } } as unknown as ProviderResponse;
      const refusal = { raw: { stop_reason: 'refusal' } } as unknown as ProviderResponse;
      expect(fi.retainedRawRequest(success, rawRequest)).toBe(rawRequest);
      expect(fi.retainedRawRequest(refusal, rawRequest)).toBe(rawRequest);
    } finally {
      if (prev === undefined) delete process.env.LLM_CALLS_FULL_PAYLOADS;
      else process.env.LLM_CALLS_FULL_PAYLOADS = prev;
    }
  });

  test('LLM_CALLS_FULL_PAYLOADS off-values keep refusal-only behavior', () => {
    const prev = process.env.LLM_CALLS_FULL_PAYLOADS;
    try {
      for (const off of ['', '0', 'false', 'FALSE']) {
        process.env.LLM_CALLS_FULL_PAYLOADS = off;
        const a = new LoggingAnthropicAdapter({ apiKey: 'test' }, '/dev/null');
        const ai = a as unknown as typeof internals;
        const success = { raw: { stop_reason: 'end_turn' } } as unknown as ProviderResponse;
        expect(ai.retainedRawRequest(success, { m: 1 })).toBeUndefined();
      }
    } finally {
      if (prev === undefined) delete process.env.LLM_CALLS_FULL_PAYLOADS;
      else process.env.LLM_CALLS_FULL_PAYLOADS = prev;
    }
  });

  test('forwards authoritative billing buckets from the provider response', () => {
    const calls: ProviderCallRecord[] = [];
    const observed = new LoggingAnthropicAdapter(
      { apiKey: 'test' },
      '/dev/null',
      undefined,
      (call) => calls.push(call),
    ) as unknown as {
      observeCall(
        kind: 'complete' | 'stream',
        timestamp: string,
        durationMs: number,
        request: ProviderRequest,
        rawRequest: unknown,
        outcome: { response: ProviderResponse },
        errorText: undefined,
      ): void;
    };
    const response = {
      usage: { inputTokens: 2, outputTokens: 10, cacheCreationTokens: 100, cacheReadTokens: 50 },
      raw: {
        usage: {
          cache_creation: {
            ephemeral_5m_input_tokens: 25,
            ephemeral_1h_input_tokens: 75,
          },
          service_tier: 'standard',
          inference_geo: 'global',
        },
      },
    } as unknown as ProviderResponse;

    observed.observeCall('stream', '2026-07-13T00:00:00Z', 10, baseRequest, {}, { response }, undefined);
    expect(calls[0]).toMatchObject({
      cacheWriteTokens: 100,
      cacheWrite5mTokens: 25,
      cacheWrite1hTokens: 75,
      cacheWriteBucketsAuthoritative: true,
      serviceTier: 'standard',
      inferenceGeo: 'global',
    });
  });
});
