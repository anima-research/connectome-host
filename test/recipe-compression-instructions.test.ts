import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy as FrameworkStrategy, PassthroughStrategy } from '@animalabs/agent-framework';
import { AutobiographicalStrategy, ContextManager, validateCompressionInstructions, type StrategyContext } from '@animalabs/context-manager';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { buildFrameworkStrategy } from '../src/framework-strategy.js';
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
const text = (value: string): ContentBlock => ({ type: 'text', text: value });
const instruction = (request: NormalizedRequest) => request.messages.at(-1)!.content
  .filter(b => b.type === 'text').map(b => b.text).join('\n');
const texts = (request: NormalizedRequest) => request.messages.flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text));

// No replacement constructor or formatter. Drive one native L1 request on the
// actual host-built class, using a synthetic Chronicle store and a mock only at
// the summarizer boundary. Large windows keep automatic ticks from adding work.
async function capture(settings: Record<string, unknown> = {}, inherited = false) {
  const strategy = build({
    headWindowTokens: 0, recentWindowTokens: 100_000, targetChunkTokens: 100_000,
    summaryTargetTokens: 321, adaptiveResolution: false, mergeThreshold: 99,
    ...(inherited ? { witnessedBeforeSequence: 1_000_000 } : {}), ...settings,
  });
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
    const ctx = (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
    const messages = ctx.messageStore.getAll();
    const before = structuredClone(messages);
    const native = strategy as unknown as {
      compressChunkHierarchical(chunk: object, context: StrategyContext): Promise<void>;
      summaries: { content: string; sourceIds: string[] }[];
    };
    await native.compressChunkHierarchical({ index: 0, startIndex: 0, endIndex: messages.length,
      messages, tokens: 400, compressed: false }, ctx);
    expect(calls).toHaveLength(1);
    expect(native.summaries).toHaveLength(1);
    expect(native.summaries[0]!.content).toBe('A synthetic event note.');
    expect(native.summaries[0]!.sourceIds).toEqual(messages.map(m => m.id));
    expect(ctx.messageStore.getAll()).toEqual(before);
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
    expect(() => new FrameworkStrategy({ compressionInstructions: { preset: 'legacy' } } as never))
      .toThrow('Invalid compressionInstructions configuration');
  });

  test('omission and explicit default preserve the native request', async () => {
    const omitted = await capture();
    expect(await capture({ compressionInstructions: { preset: 'default' } })).toEqual(omitted);
    expect(instruction(omitted)).toContain('Write the memory of events since the most recent memory system notification.');
    expect(instruction(omitted)).toContain('Target ~321 tokens.');
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

  test('CM performs substitutions once; existing identity reminders still append', async () => {
    const result = await capture({ identityReminder: 'REMINDER', compressionInstructions: {
      participant: 'Participant {targetTokens} $&',
      templates: { opening: 'OPEN {participant}', chunk: 'CHUNK {participant} {targetTokens}' },
    } });
    expect(texts(result)).toContain('OPEN Participant {targetTokens} $&');
    expect(instruction(result)).toBe('CHUNK Participant {targetTokens} $& 321\n\nREMINDER');
  });

  test('factual is optional, requires an explicit participant, and reaches the request', async () => {
    const result = await capture({ compressionInstructions: { preset: 'factual', participant: 'Participant' } });
    expect(instruction(result)).toContain('factual event note about Participant');
  });
});

describe('recipe compression instructions: admission before construction/provider use', () => {
  const invalid = [null, [], 'VALUE_SENTINEL', 1, { preset: 'legacy' }, { preset: 'FACTUAL' },
    { preset: 'factual' }, { participant: '' }, { participant: 123 }, { VALUE_SENTINEL: 'secret' },
    { templates: {} }, { templates: [] }, { templates: { VALUE_SENTINEL: 'secret' } },
    ...['', ' ', 123, null, {}, [], '{', '{{targetTokens}}', '{unknown}', '{totalTokens}', '{participant}']
      .map(chunk => ({ templates: { chunk } })),
    { templates: { transition: 'no context' } }, { templates: { transition: '{context}{context}' } },
    { templates: { opening: '{targetTokens}' } },
  ];
  for (const [i, value] of invalid.entries()) {
    test(`malformed nested settings ${i} fail with a fixed, value-free error`, () => {
      expect(errorMessage(() => recipe({ compressionInstructions: value })))
        .toBe('Invalid compressionInstructions configuration');
      expect(errorMessage(() => buildFrameworkStrategy(raw({ compressionInstructions: value }), 'mock-only', 'UTC')))
        .toBe('Invalid compressionInstructions configuration');
    });
  }

  test('all documented slots are admitted and forwarded without host defaults', () => {
    const settings = { participant: 'Participant', templates: {
      opening: 'O {participant}', chunk: 'C {targetTokens}', witnessedChunk: 'W {targetTokens}',
      readingChunk: 'R {totalTokens}', merge: 'M {sourceLevelShown} {targetLevel}',
      witnessedMerge: 'WM {targetTokens}', readingMerge: 'RM {totalTokens}', transition: 'T {context}',
    } };
    const config = (build({ compressionInstructions: settings }) as unknown as { config: Record<string, unknown> }).config;
    expect(config.compressionInstructions).toEqual(settings);
    expect((build() as unknown as { config: Record<string, unknown> }).config.compressionInstructions).toBeUndefined();
    expect(() => recipe({ compressionInstructions: {} })).not.toThrow();
  });

  test('conflicting witnessed instructions fail at recipe validation, not first compression', () => {
    expect(errorMessage(() => recipe({ witnessedInstruction: 'VALUE_SENTINEL', compressionInstructions: { templates: { witnessedChunk: 'new' } } })))
      .toBe('Conflicting witnessed instruction configuration');
  });

  for (const type of ['frontdesk', 'passthrough']) {
    test(`${type} rejects even empty/default settings, including direct builder callers`, () => {
      for (const compressionInstructions of [{}, { preset: 'default' }, { templates: { chunk: 'C' } }]) {
        const input = raw({ type, compressionInstructions });
        expect(() => validateRecipe(input)).toThrow('requires an autobiographical strategy');
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
        .toBe('Invalid compressionInstructions configuration');
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
