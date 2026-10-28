import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AutobiographicalStrategy } from '@animalabs/context-manager';
import { buildContextCurve, type PanelAppRef } from '../src/web/panel-data.js';
import { FrontdeskStrategy } from '../src/strategies/frontdesk-strategy.js';

type StoredMessage = { id: string; timestamp: unknown; content: unknown[] };
const HELLO: StoredMessage[] = [{ id: 'm1', timestamp: '2026-10-10T21:00:00Z', content: [{ type: 'text', text: 'hello' }] }];

function appWith(
  compile: (...args: unknown[]) => Promise<unknown>,
  preview?: (name: string, budget: number) => unknown,
  store: { messages: StoredMessage[]; summaries: unknown[] } = { messages: HELLO, summaries: [] },
): PanelAppRef {
  const cm = {
    compile,
    getMessageCount: () => store.messages.length,
    getMessageWindow: () => ({ messages: store.messages }),
    getStrategy: () => ({ summaries: store.summaries }),
    currentBranch: () => ({ name: 'main' }),
  };
  return {
    framework: {
      getAgent: (name: string) => (name === 'scout' ? { getContextManager: () => cm } : undefined),
      getAgentRuntimeSettings: () => ({ contextBudgetTokens: 150_000 }),
      ...(preview ? { previewContextSettings: preview } : {}),
    },
    recipe: { agent: { maxTokens: 8_000 } },
  } as unknown as PanelAppRef;
}

const said = (id: string, timestamp: unknown): StoredMessage => ({ id, timestamp, content: [{ type: 'text', text: 'said' }] });

async function summaryEntry(messages: StoredMessage[]) {
  const text = 'what was said';
  const app = appWith(
    async () => ({ messages: [{ participant: 'scout', content: [{ type: 'text', text }] }] }),
    undefined,
    { messages, summaries: [{ id: 's1', level: 1, content: text, sourceLevel: 0, sourceIds: messages.map((m) => m.id) }] },
  );
  const entries = (await buildContextCurve(app, 'scout')).entries as Array<{ kind: string; msgCount: number; dateFirst: Date | null; dateLast: Date | null }>;
  expect(entries).toHaveLength(1);
  return entries[0]!;
}

describe('the context curve', () => {
  const originalModel = process.env.MODEL;
  beforeEach(() => { delete process.env.MODEL; });
  afterEach(() => { if (originalModel === undefined) delete process.env.MODEL; else process.env.MODEL = originalModel; });

  test('compiles as a dry run, at the live budget', async () => {
    const calls: unknown[][] = [];
    const app = appWith(async (...args: unknown[]) => {
      calls.push(args);
      return { messages: [{ participant: 'scout', content: [{ type: 'text', text: 'hello' }], sourceMessageId: 'm1' }] };
    });

    const curve = await buildContextCurve(app, 'scout');

    expect(calls).toEqual([[{ maxTokens: 150_000, reserveForResponse: 8_000 }, undefined, { dryRun: true }]]);
    expect(curve.totals).toEqual({ entries: 1, rendered: 2, rawCovered: 2 });
    expect(curve.verdict).toBeNull();
  });

  test("without a live budget it falls back to the recipe's effective budget, the 300k default when unset", async () => {
    const calls: unknown[][] = [];
    const app = appWith(async (...args: unknown[]) => {
      calls.push(args);
      return { messages: [] };
    });
    (app.framework as unknown as { getAgentRuntimeSettings: () => unknown }).getAgentRuntimeSettings = () => ({});

    await buildContextCurve(app, 'scout');
    (app.recipe.agent as { contextBudgetTokens?: number }).contextBudgetTokens = 180_000;
    await buildContextCurve(app, 'scout');

    expect(calls.map((c) => (c[0] as { maxTokens: number }).maxTokens)).toEqual([300_000, 180_000]);
  });

  test("without a live budget, the default it falls back to is the running model's, MODEL first", async () => {
    const calls: unknown[][] = [];
    const app = appWith(async (...args: unknown[]) => {
      calls.push(args);
      return { messages: [] };
    });
    (app.framework as unknown as { getAgentRuntimeSettings: () => unknown }).getAgentRuntimeSettings = () => ({});
    Object.assign(app.recipe.agent, { model: 'claude-opus-4-6', systemPrompt: '' });
    process.env.MODEL = 'claude-haiku-4-5';
    const curve = await buildContextCurve(app, 'scout');
    expect((calls[0]![0] as { maxTokens: number }).maxTokens).toBe(200_000 - 32_000);
    expect(curve.budget).toEqual({ maxTokens: 200_000 - 32_000, reserveForResponse: 8_000 });
  });

  test("a summary's first and last dates are its messages' earliest and latest by time", async () => {
    // The default sort orders Dates by their text, weekday first, so these fall
    // out of time order that way.
    const wednesday = new Date('2026-10-14T12:00:00Z');
    const friday = new Date('2026-10-16T12:00:00Z');
    const monday = new Date('2026-11-02T12:00:00Z');
    const tuesday = '2026-11-03T12:00:00.000Z';

    const entry = await summaryEntry([
      said('m1', friday), said('m2', undefined), said('m3', monday), said('m4', tuesday),
      said('m5', new Date(Number.NaN)), said('m6', null), said('m7', wednesday),
    ]);

    expect([entry.kind, entry.msgCount]).toEqual(['L1', 7]);
    // toEqual, since bun's toMatchObject finds any two Dates alike.
    expect([entry.dateFirst, entry.dateLast]).toEqual([wednesday, new Date(tuesday)]);
  });

  test('a numeric timestamp of 0 is a time, the epoch', async () => {
    const friday = new Date('2026-10-16T12:00:00Z');

    const entry = await summaryEntry([said('m1', friday), said('m2', 0)]);

    expect([entry.dateFirst, entry.dateLast]).toEqual([new Date(0), friday]);
  });

  test('reports the feasibility preview\'s verdict, so an over-budget plot says it won\'t fit (sw-ch234 I12)', async () => {
    const compile = async () => ({ messages: [{ participant: 'scout', content: [{ type: 'text', text: 'hello' }], sourceMessageId: 'm1' }] });
    const asked: unknown[][] = [];
    for (const [finalTokens, expected] of [
      [120_000, { fitsRequested: true, withinGrace: true, unreachable: false }],
      [150_000, { fitsRequested: false, withinGrace: true, unreachable: false }],
      [190_000, { fitsRequested: false, withinGrace: false, unreachable: true }],
    ] as const) {
      const app = appWith(compile, (...args) => {
        asked.push(args);
        return { finalTokens, budgetTokens: 155_000, exhausted: finalTokens > 155_000 };
      });
      const curve = await buildContextCurve(app, 'scout');
      expect(curve.verdict).toEqual({
        plannedTokens: finalTokens, effectiveBudgetTokens: 142_000, rejectionBudgetTokens: 155_000, ...expected,
        atDescentTarget: false,
      });
    }
    expect(asked).toEqual([['scout', 150_000], ['scout', 150_000], ['scout', 150_000]]);
    for (const preview of [() => { throw new Error('zz'); }, () => null]) {
      const curve = await buildContextCurve(appWith(compile, preview), 'scout');
      expect(curve.verdict).toBeNull();
    }
  });

  test('during a paced descent the verdict says it is at the descent\'s target (Ada-1017, room-543 #70622)', async () => {
    const compile = async () => ({ messages: [] });
    for (const [transition, atTarget] of [['converging', true], ['blocked', true], ['stable', false]] as const) {
      const app = appWith(compile, () => ({ finalTokens: 150_000, budgetTokens: 155_000, exhausted: false }));
      (app.framework as unknown as { getAgentRuntimeSettings: () => unknown }).getAgentRuntimeSettings =
        () => ({ contextBudgetTokens: 150_000, transition });
      const curve = await buildContextCurve(app, 'scout');
      expect((curve.verdict as { atDescentTarget: boolean }).atDescentTarget).toBe(atTarget);
    }
  });
});

describe('strategies the host defines', () => {
  test('FrontdeskStrategy passes SelectOptions through to the select it extends (sw-ch234 I1)', () => {
    const seen: unknown[] = [];
    const original = AutobiographicalStrategy.prototype.select;
    AutobiographicalStrategy.prototype.select = function (this: unknown, ...args: unknown[]) {
      seen.push(args[3]);
      return [];
    } as typeof original;
    try {
      const strategy = new FrontdeskStrategy();
      const store = { getAll: () => [] } as never;
      strategy.select(store, {} as never, {} as never, { dryRun: true });
      strategy.select(store, {} as never, {} as never);
    } finally {
      AutobiographicalStrategy.prototype.select = original;
    }
    expect(seen).toEqual([{ dryRun: true }, undefined]);
  });
});
