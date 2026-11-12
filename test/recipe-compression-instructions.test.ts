import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy as FrameworkStrategy, PassthroughStrategy } from '@animalabs/agent-framework';
import { AutobiographicalStrategy, ContextManager, validateCompressionInstructions } from '@animalabs/context-manager';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { buildConversationsConfig, buildSubconsciousConfig, buildFrameworkStrategy } from '../src/framework-strategy.js';
import { emptyExtensionRegistry } from '../src/extensions.js';
import { FrontdeskStrategy } from '../src/strategies/frontdesk-strategy.js';
import { unknownRecipeKeys, validateRecipe } from '../src/recipe.js';

const raw = (strategy: Record<string, unknown> = {}) => JSON.parse(JSON.stringify({
  name: 'Instruction test', agent: { name: 'Participant', provider: 'mock', systemPrompt: 'Synthetic record.', strategy },
}));
const recipe = (strategy: Record<string, unknown> = {}) => validateRecipe(raw(strategy));
const build = (strategy: Record<string, unknown> = {}) => buildFrameworkStrategy(recipe(strategy), 'mock-only', 'UTC');
function errorMessage(run: () => unknown): string {
  try { run(); } catch (error) { return (error as Error).message; }
  throw new Error('Expected validation to reject the recipe');
}
// R2-4: CM diagnostics add fixed paths/reasons, never caller-controlled values.
function expectInvalidCompression(run: () => unknown): void {
  const message = errorMessage(run);
  expect(message).toStartWith('Invalid compressionInstructions configuration: ');
  for (const value of ['VALUE_SENTINEL', 'SECRET', 'secret', 'unknown-preset', 'unregistered-preset', 'CUSTOM']) {
    expect(message).not.toContain(value);
  }
}
const text = (value: string): ContentBlock => ({ type: 'text', text: value });
const instruction = (request: NormalizedRequest) => request.messages.at(-1)!.content
  .filter(b => b.type === 'text').map(b => b.text).join('\n');
const texts = (request: NormalizedRequest) => request.messages.flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text));

// No replacement constructor or formatter. Drive one native L1 request on the
// actual host-built class, using a synthetic Chronicle store and a mock only at
// the summarizer boundary. Four messages close one chunk; no merges are due.
async function capture(settings: Record<string, unknown> = {}, inherited = false, route: 'main' | 'conversation' | 'reader' = 'main') {
  const input = recipe({
    headWindowTokens: 0, recentWindowTokens: 0, targetChunkTokens: 100, l1HoldbackChunks: 0,
    summaryTargetTokens: 321, adaptiveResolution: false, mergeThreshold: 99,
    ...(inherited ? { witnessedBeforeSequence: 1_000_000 } : {}), ...settings,
  });
  input.conversations = {};
  input.subconscious = { enabled: true, reader: 'forks', model: 'mock-only', voice: 'Synthetic reader.' };
  const reader = buildSubconsciousConfig(input, 'mock-only', 'UTC');
  let strategy: ReturnType<typeof buildFrameworkStrategy>;
  if (route === 'conversation') {
    strategy = buildConversationsConfig(input, 'Participant', 'mock-only', 'UTC')!.strategyFactory!();
  } else if (route === 'reader') {
    if (reader?.reader !== 'forks') throw new Error('Expected a fork reader');
    strategy = reader.strategyFactory!();
  } else {
    strategy = buildFrameworkStrategy(input, 'mock-only', 'UTC');
  }
  expect(strategy.constructor).toBe(FrameworkStrategy);
  expect(FrameworkStrategy).toBe(AutobiographicalStrategy);
  const calls: NormalizedRequest[] = [];
  const path = mkdtempSync(join(tmpdir(), 'host-instruction-test-'));
  const manager = await ContextManager.open({ path, strategy, membrane: {
    complete: async (request: NormalizedRequest) => {
      calls.push(structuredClone(request));
      return { content: [text('A synthetic event note.')], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } };
    },
  } as never });
  try {
    for (let i = 0; i < 4; i++) manager.addMessage(i % 2 ? 'Participant' : 'Other', [text(`raw-${i} {participant} $& ` + 'synthetic event. '.repeat(20))]);
    const before = structuredClone(manager.getAllMessages());
    // autoTickOnNewMessage may already have started this L1. Bounded public
    // ticks/macrotask hops let that work finish without inspecting lane state.
    for (let tick = 0; tick < 20 && manager.getSummariesInRange({ level: 1 }).length === 0; tick++) {
      await manager.tick();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(calls).toHaveLength(1);
    const summaries = manager.getSummariesInRange({ level: 1 });
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.content).toBe('A synthetic event note.');
    expect(summaries[0]!.sourceIds).toEqual(before.map(m => m.id));
    expect(manager.getAllMessages()).toEqual(before);
    return calls[0]!;
  } finally {
    await manager.close();
    rmSync(path, { recursive: true, force: true });
  }
}

describe('recipe compression instructions: native dependency route', () => {
  test('AF re-exports the same feature-capable CM constructor (an older nested CM must fail)', () => {
    expect(FrameworkStrategy).toBe(AutobiographicalStrategy);
    expect(typeof validateCompressionInstructions).toBe('function');
    expect(() => new FrameworkStrategy({ compressionInstructions: { preset: 'unknown-preset' } } as never))
      .toThrow('Invalid compressionInstructions configuration');
  });

  test('omission and explicit default preserve the native request', async () => {
    const omitted = await capture();
    expect(await capture({ compressionInstructions: { preset: 'default' } })).toEqual(omitted);
  });

  test('JSON template-only override reaches the native mock request; partial slots inherit defaults', async () => {
    const baseline = await capture();
    const settings = { compressionInstructions: { templates: { chunk: 'HOST CHUNK {targetTokens}' } } };
    const selected = await capture(settings);
    expect(instruction(selected)).toBe('HOST CHUNK 321');
    expect({ ...selected, messages: selected.messages.slice(0, -1) })
      .toEqual({ ...baseline, messages: baseline.messages.slice(0, -1) });
    expect(await capture(settings, true)).toEqual(await capture({}, true));
  });

  for (const route of ['conversation', 'reader'] as const) {
    test(`${route} factory forwards templates to a native request`, async () => {
      const result = await capture({ compressionInstructions: { templates: { chunk: 'FORK {targetTokens}' } } }, false, route);
      expect(instruction(result)).toBe('FORK 321');
    });
  }

  test('CM performs substitutions once; existing identity reminders still append', async () => {
    const result = await capture({ identityReminder: 'REMINDER', compressionInstructions: {
      participant: 'Participant {targetTokens} $&',
      templates: { opening: 'OPEN {participant}', chunk: 'CHUNK {participant} {targetTokens}' },
    } });
    expect(texts(result)).toContain('OPEN Participant {targetTokens} $&');
    expect(instruction(result)).toBe('CHUNK Participant {targetTokens} $& 321\n\nREMINDER');
  });
});

describe('recipe compression instructions: admission before construction/provider use', () => {
  const invalid = [null, [], 'VALUE_SENTINEL', 1, { preset: 'unknown-preset' }, { preset: 'unregistered-preset' },
    { preset: 'unregistered-preset', participant: 'Participant', templates: { chunk: 'CUSTOM {participant}' } },
    { participant: '' }, { participant: 123 }, { VALUE_SENTINEL: 'secret' },
    { templates: {} }, { templates: [] }, { templates: { VALUE_SENTINEL: 'secret' } },
    ...['', ' ', 123, null, {}, [], '{', '{{targetTokens}}', '{unknown}', '{totalTokens}', '{participant}']
      .map(chunk => ({ templates: { chunk } })),
    { templates: { transition: 'no context' } }, { templates: { transition: '{context}{context}' } },
    { templates: { opening: '{targetTokens}' } },
  ];
  for (const [i, value] of invalid.entries()) {
    test(`malformed nested settings ${i} fail with a fixed, value-free error`, () => {
      expectInvalidCompression(() => recipe({ compressionInstructions: value }));
      expectInvalidCompression(() => buildFrameworkStrategy(raw({ compressionInstructions: value }), 'mock-only', 'UTC'));
    });
  }

  test('representative diagnostics use fixed paths and reasons rather than input values', () => {
    const cases: [unknown, string][] = [
      [null, 'configuration: expected object'],
      [{ VALUE_SENTINEL: 'SECRET' }, 'configuration: unknown key'],
      [{ preset: 'VALUE_SENTINEL' }, 'preset: unsupported preset'],
      [{ participant: { VALUE_SENTINEL: 'SECRET' } }, 'participant: expected nonblank string'],
      [{ templates: { VALUE_SENTINEL: 'SECRET' } }, 'templates: unknown key'],
      [{ templates: { chunk: 'SECRET {' } }, 'templates.chunk: malformed braces'],
      [{ templates: { chunk: 'SECRET {SECRET}' } }, 'templates.chunk: unsupported placeholder'],
      [{ templates: { transition: 'SECRET' } }, 'templates.transition: context must appear once'],
    ];
    for (const [value, diagnostic] of cases) {
      for (const run of [() => recipe({ compressionInstructions: value }),
        () => buildFrameworkStrategy(raw({ compressionInstructions: value }), 'mock-only', 'UTC')]) {
        expectInvalidCompression(run);
        expect(errorMessage(run)).toBe(`Invalid compressionInstructions configuration: ${diagnostic}`);
      }
    }
  });

  test('all documented slots are admitted (request forwarding is exercised above)', () => {
    const settings = { participant: 'Participant', templates: {
      opening: 'O {participant}', chunk: 'C {targetTokens}', witnessedChunk: 'W {targetTokens}',
      readingChunk: 'R {totalTokens}', merge: 'M {sourceLevelShown} {targetLevel}',
      witnessedMerge: 'WM {targetTokens}', readingMerge: 'RM {totalTokens}', transition: 'T {context}',
    } };
    expect(() => build({ compressionInstructions: settings })).not.toThrow();
    expect(() => build()).not.toThrow();
    expect(() => recipe({ compressionInstructions: {} })).not.toThrow();
  });

  test('conflicting witnessed instructions fail as TypeError at both boundaries', () => {
    for (const type of [undefined, 'autobiographical']) {
      const input = raw({ type, witnessedInstruction: 'VALUE_SENTINEL',
        compressionInstructions: { templates: { witnessedChunk: 'new' } } });
      for (const run of [() => validateRecipe(input), () => buildFrameworkStrategy(input, 'mock-only', 'UTC')]) {
        expect(run).toThrow(TypeError);
        expect(errorMessage(run)).toBe('Conflicting witnessed instruction configuration');
      }
    }
    expect(() => build({ witnessedInstruction: '', compressionInstructions: { templates: { witnessedChunk: 'new' } } })).not.toThrow();
  });

  for (const type of ['frontdesk', 'passthrough']) {
    test(`${type} rejects even empty/default settings, including direct builder callers`, () => {
      for (const compressionInstructions of [{}, { preset: 'default' }, { templates: { chunk: 'C' } }]) {
        const input = raw({ type, compressionInstructions });
        expect(() => validateRecipe(input)).toThrow(TypeError);
        expect(() => validateRecipe(input)).toThrow('requires an autobiographical strategy');
        expect(() => buildFrameworkStrategy(input, 'mock-only', 'UTC')).toThrow(TypeError);
        expect(() => buildFrameworkStrategy(input, 'mock-only', 'UTC')).toThrow('requires an autobiographical strategy');
      }
      expect(() => build({ type })).not.toThrow();
    });
  }

  for (const type of [undefined, 'autobiographical', 'frontdesk', 'passthrough']) {
    for (const extra of [{ identityReminderSilent: false }, { formerlyIgnored: true }]) {
      test(`review repro: ${type ?? 'omitted type'} accepts ${Object.keys(extra)[0]} without templates`, () => {
        // Real JSON admission AND the actual host/AF/CM constructor, not mocks.
        const input = JSON.parse(JSON.stringify({ name: 'Compatibility repro', agent: {
          name: 'Synthetic', provider: 'mock', systemPrompt: 'Synthetic only', strategy: { type, ...extra },
        } }));
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const validated = validateRecipe(input);
          const built = buildFrameworkStrategy(validated, 'mock-only', 'UTC');
          expect(built.constructor).toBe(type === 'passthrough' ? PassthroughStrategy
            : type === 'frontdesk' ? FrontdeskStrategy : FrameworkStrategy);
          if ('identityReminderSilent' in extra) {
            const retired = 'agent.strategy.identityReminderSilent (replaced by a sentence asking for silence at the end of ' +
              'each nonblank reminder the recipe sets, agent.strategy.identityReminder and agent.strategy.witnessedIdentityReminder, ' +
              'if it was true; if it was false, nothing)';
            expect(unknownRecipeKeys(input)).toEqual([retired]);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith(`Recipe "Compatibility repro" has keys the host does not read (ignored): ${retired}.`);
          } else {
            expect(unknownRecipeKeys(input)).toEqual([]);
            expect(warn).not.toHaveBeenCalled();
          }
        } finally { warn.mockRestore(); }
      });
    }
  }

  test('templates do not tighten unrelated keys or change the native forwarded request', async () => {
    const settings = { compressionInstructions: { templates: { chunk: 'HOST CHUNK {targetTokens}' } } };
    const baseline = await capture(settings);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await capture({ ...settings, identityReminderSilent: false, formerlyIgnored: true })).toEqual(baseline);
      expect(instruction(baseline)).toBe('HOST CHUNK 321');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain('if it was false, nothing');
      expect(warn.mock.calls[0]![0]).not.toContain('formerlyIgnored');
    } finally { warn.mockRestore(); }
  });

  test('invalid new settings fail before recipe warnings can echo arbitrary keys or values', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(errorMessage(() => recipe({ identityReminderSilent: false, VALUE_SENTINEL: 'SECRET', compressionInstructions: { templates: { VALUE_SENTINEL: 'SECRET' } } })))
        .toBe('Invalid compressionInstructions configuration: templates: unknown key');
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

  test('unrelated known recipe keys remain open to their existing validators', () => {
    expect(() => recipe({ compressionInstructions: {}, summarySystemPrompt: 's', summaryUserPrompt: 'u',
      compressionRecallBudgetTokens: 123, maxLiveImages: 6, l1HoldbackChunks: 2 })).not.toThrow();
  });

  test('custom extension factories keep their independent, verbatim config contract', () => {
    const input = raw({ type: 'custom', compressionInstructions: 'extension-owned', compressionInstruction: 'also extension-owned' });
    input.extensions = { custom: { kind: 'strategy', path: './synthetic-extension.ts' } };
    const validated = validateRecipe(input);
    const registry = emptyExtensionRegistry();
    let received: unknown;
    registry.strategies.set('custom', ({ config }) => { received = config; return new PassthroughStrategy(); });
    expect(unknownRecipeKeys(input)).toEqual([]);
    buildFrameworkStrategy(validated, 'mock-only', 'UTC', registry);
    expect(received).toBe(validated.agent.strategy);
    expect(received).toEqual(input.agent.strategy);
  });
});
