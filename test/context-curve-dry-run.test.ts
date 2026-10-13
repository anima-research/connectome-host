/**
 * The context curve panel shows a compile and never sends it, so the compile
 * is a dry run (Ada-1017's finding for context-manager #155). These tests pin
 * what the host controls: the arguments the curve compiles with, the verdict
 * it reports, a summary's first and last dates, and that every strategy the
 * host defines passes the dry run through to the select it extends. What a
 * dry run spares the resident is context-manager's to test.
 */
import { describe, expect, test } from 'bun:test';
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

/** The curve's one entry when the compiled context is a single summary of `messages`. */
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
  test('compiles as a dry run, at the live budget', async () => {
    const calls: unknown[][] = [];
    const app = appWith(async (...args: unknown[]) => {
      calls.push(args);
      return { messages: [{ participant: 'scout', content: [{ type: 'text', text: 'hello' }], sourceMessageId: 'm1' }] };
    });

    const curve = await buildContextCurve(app, 'scout');

    expect(calls).toEqual([[{ maxTokens: 150_000, reserveForResponse: 8_000 }, undefined, { dryRun: true }]]);
    expect(curve.totals).toEqual({ entries: 1, rendered: 2, rawCovered: 2 });
    expect(curve.verdict).toBeNull();   // no feasibility preview on this framework
  });

  test("a summary's first and last dates are its messages' earliest and latest by time", async () => {
    // The store gives timestamps as Dates, which the default sort orders by
    // their text, weekday first: these fall out of time order that way in
    // every time zone, and by day of the month too. The latest is ISO text,
    // which the curve takes as well, and a timestamp that's missing, null or
    // not a time is left out.
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
    // Asked at the curve's own budget, the live one.
    expect(asked).toEqual([['scout', 150_000], ['scout', 150_000], ['scout', 150_000]]);
    // A preview that throws, or has no verdict, leaves the plot without one.
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
