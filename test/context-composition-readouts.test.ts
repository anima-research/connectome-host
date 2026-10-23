/**
 * The context composition readouts where an agent has no composition
 * (connectome-host#425), and the Health view's last-inference line.
 * context-manager gives an agent's render stats only from a live compile
 * since its context was loaded, and only for a strategy that keeps them, so
 * the views say which of the two it is. agent-framework keeps an agent's
 * last inference start, end and failure each until the next of its kind, so
 * the last-inference line names a failure only when it came at or after the
 * latest start, and the last-error line shows only then.
 *
 * web/src/composition-text.ts is imported inside each test that uses it, so
 * that run against main's sources, where it doesn't exist, each such test
 * fails on its own.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { buildContextMakeup, buildHealthSnapshot, type PanelAppRef } from '../src/web/panel-data.js';
import { HEALTH_STRINGS, keepNamedStrings } from '../src/modules/web-ui-observers.js';

const words = () => import('../web/src/composition-text');

describe('the line where an agent has no composition', () => {
  test("it says no live compile since the context was loaded, or that the agent's strategy keeps none", async () => {
    const { noComposition } = await words();
    expect(noComposition(true)).toBe('No live compile since its context was loaded.');
    expect(noComposition(false)).toBe("This agent's strategy keeps no composition.");
  });

  test('either view shows the stats where there are any, else the line for a strategy that keeps them or one that keeps none', async () => {
    const { compositionView } = await words();
    const stats = { head: { messages: 2, tokens: 10 } };
    expect(compositionView(stats, true)).toEqual({ stats });
    expect(compositionView(null, true)).toEqual({ line: 'No live compile since its context was loaded.' });
    expect(compositionView(undefined, false)).toEqual({ line: "This agent's strategy keeps no composition." });
  });

  test("the Health view shows an agent's stats, else the line by whether contextCompositionNotKept names it, and nothing where the section or the agent's read of it failed", async () => {
    const { healthComposition } = await words();
    const stats = { head: { messages: 2, tokens: 10 } };
    const health = {
      contextComposition: { compiled: stats },
      contextCompositionNotKept: ['passthrough'],
      readFailures: { broken: { contextComposition: 'the store refused the read' }, other: { compressionDebt: 'no' } },
    };
    expect(healthComposition(health, 'compiled')).toEqual({ stats });
    expect(healthComposition(health, 'waiting')).toEqual({ line: 'No live compile since its context was loaded.' });
    expect(healthComposition(health, 'passthrough')).toEqual({ line: "This agent's strategy keeps no composition." });
    expect(healthComposition(health, 'broken')).toBeNull();
    // Another section's failure says nothing about this one.
    expect(healthComposition(health, 'other')).toEqual({ line: 'No live compile since its context was loaded.' });
    // Read by own key: a name Object.prototype also has is an agent with none.
    const parsed = JSON.parse(JSON.stringify(health)) as typeof health;
    expect(healthComposition(parsed, 'toString')).toEqual({ line: 'No live compile since its context was loaded.' });
    // With no agent kept out, the key is absent.
    expect(healthComposition({ contextComposition: {} }, 'waiting')).toEqual({ line: 'No live compile since its context was loaded.' });
    // A section that wasn't read, or no snapshot at all, shows nothing.
    expect(healthComposition({ contextCompositionNotKept: ['passthrough'] }, 'passthrough')).toBeNull();
    expect(healthComposition(null, 'compiled')).toBeNull();
  });
});

describe("the Context page's figures", () => {
  test('it shows the exact count and the model it was counted for, or why it was not counted', async () => {
    const { contextPageView } = await words();
    const makeup = { stats: null, statsKept: true, exactTotalTokens: 4_242, countModel: 'claude-haiku-4-5', countSource: 'count_tokens' };
    expect(contextPageView(makeup).count).toEqual({ tokens: 4_242, model: 'claude-haiku-4-5' });
    expect(contextPageView({ ...makeup, exactTotalTokens: 0 }).count).toEqual({ tokens: 0, model: 'claude-haiku-4-5' });
    expect(contextPageView({ ...makeup, exactTotalTokens: null, countSource: 'count_tokens_failed_429' }).count)
      .toEqual({ reason: 'not counted: count_tokens answered 429' });
  });

  test("it shows the last live compile's stats, else the line, taking a response without statsKept as a strategy that keeps them", async () => {
    const { contextPageView } = await words();
    const stats = { total: { messages: 160, tokens: 16_690 } };
    const makeup = { stats: null, exactTotalTokens: null, countModel: 'gpt-6', countSource: 'count_tokens_unsupported_model' };
    expect(contextPageView({ ...makeup, stats }).composition).toEqual({ stats });
    expect(contextPageView({ ...makeup, statsKept: true }).composition).toEqual({ line: 'No live compile since its context was loaded.' });
    expect(contextPageView({ ...makeup, statsKept: false }).composition).toEqual({ line: "This agent's strategy keeps no composition." });
    expect(contextPageView(makeup).composition).toEqual({ line: 'No live compile since its context was loaded.' });
  });
});

describe("the Health view's last-inference line", () => {
  test('a failure then a later success reads as ended', async () => {
    const { lastInferenceState } = await words();
    expect(lastInferenceState({ failedAt: 105, startedAt: 200, endedAt: 260 })).toEqual({ word: 'ended', at: 260 });
  });

  test('a success then a later failure reads as failed', async () => {
    const { lastInferenceState } = await words();
    // A failed inference may have an end too, before or after its failure.
    expect(lastInferenceState({ startedAt: 200, failedAt: 230, endedAt: 231 })).toEqual({ word: 'failed', at: 230 });
    expect(lastInferenceState({ startedAt: 200, endedAt: 229, failedAt: 230 })).toEqual({ word: 'failed', at: 230 });
  });

  test('a failure then a start still running reads as started', async () => {
    const { lastInferenceState } = await words();
    expect(lastInferenceState({ startedAt: 200, failedAt: 105, endedAt: 106 })).toEqual({ word: 'started', at: 200 });
    expect(lastInferenceState({ startedAt: 200 })).toEqual({ word: 'started', at: 200 });
  });

  test("a failure or an end in the latest start's millisecond reads as that inference's", async () => {
    const { lastInferenceState } = await words();
    // A failure before any request can land in its own start's millisecond.
    expect(lastInferenceState({ startedAt: 200, failedAt: 200 })).toEqual({ word: 'failed', at: 200 });
    expect(lastInferenceState({ startedAt: 200, failedAt: 200, endedAt: 200 })).toEqual({ word: 'failed', at: 200 });
    expect(lastInferenceState({ startedAt: 200, endedAt: 200 })).toEqual({ word: 'ended', at: 200 });
  });

  test("the tie rule's cost: a start in the millisecond of the one before's failure, then a success, still reads as failed", async () => {
    const { lastInferenceState, latestInferenceError } = await words();
    // The record can't tell this from a failure of the latest inference
    // followed by its own end, so it reads as failed until the next start.
    expect(lastInferenceState({ failedAt: 200, startedAt: 200, endedAt: 260 })).toEqual({ word: 'failed', at: 200 });
    expect(latestInferenceError({ failedAt: 200, lastError: 'earlier', startedAt: 200, endedAt: 260 })).toBe('earlier');
    // A start in any later millisecond reads as its own.
    expect(lastInferenceState({ failedAt: 200, startedAt: 201, endedAt: 260 })).toEqual({ word: 'ended', at: 260 });
  });

  test('the line says the word and how long ago, from the time the word is about', async () => {
    const { lastInferenceLine } = await words();
    const ago = (at: number) => `${300 - at}ms ago`;
    expect(lastInferenceLine({ failedAt: 105, startedAt: 200, endedAt: 260 }, ago)).toBe('last inference: ended 40ms ago');
    expect(lastInferenceLine({ startedAt: 200, failedAt: 230 }, ago)).toBe('last inference: failed 70ms ago');
    expect(lastInferenceLine({ startedAt: 200 }, ago)).toBe('last inference: started 100ms ago');
    expect(lastInferenceLine(null, ago)).toBeNull();
  });

  test("the last error shows only while the latest inference is the one that failed", async () => {
    const { latestInferenceError } = await words();
    const lastError = 'overloaded_error';
    // A failure then a later success, or a later start still running: no error line.
    expect(latestInferenceError({ failedAt: 105, lastError, startedAt: 200, endedAt: 260 })).toBeUndefined();
    expect(latestInferenceError({ failedAt: 105, lastError, startedAt: 200 })).toBeUndefined();
    // A success then a later failure, or a failure in its start's millisecond: the error.
    expect(latestInferenceError({ startedAt: 200, endedAt: 229, failedAt: 230, lastError })).toBe(lastError);
    expect(latestInferenceError({ startedAt: 200, failedAt: 200, lastError })).toBe(lastError);
    // An observer without 'ops' gets the text empty, so there's no line to show.
    expect(latestInferenceError({ startedAt: 200, failedAt: 230, lastError: '' })).toBeUndefined();
    expect(latestInferenceError(null)).toBeUndefined();
  });

  test('a failure with no start is failed, and nothing reported is no line', async () => {
    const { lastInferenceState } = await words();
    expect(lastInferenceState({ failedAt: 105 })).toEqual({ word: 'failed', at: 105 });
    expect(lastInferenceState({})).toBeNull();
    expect(lastInferenceState(null)).toBeNull();
    expect(lastInferenceState(undefined)).toBeNull();
  });
});

describe("why the Context page's next request wasn't counted", () => {
  test('each countSource the makeup endpoint gives has its reason', async () => {
    const { notCounted } = await words();
    expect(notCounted('count_tokens_unsupported_model')).toBe("not counted: count_tokens doesn't take this agent's model");
    expect(notCounted('count_tokens_failed_429')).toBe('not counted: count_tokens answered 429');
    expect(notCounted('count_tokens_error')).toBe('not counted: the count_tokens call failed');
    expect(notCounted('count_tokens')).toBe('not counted: count_tokens answered with no count');
    expect(notCounted('something_new')).toBe('not counted (something_new)');
  });
});

/** A context manager whose strategy keeps render stats, or one that, like
 *  PassthroughStrategy, has no getRenderStats. */
function cmWith(stats: unknown, statsKept: boolean) {
  return {
    getRenderStats: () => stats,
    getStrategy: () => (statsKept ? { getRenderStats: () => stats } : {}),
  };
}

describe('the makeup endpoint', () => {
  const priorModel = process.env.COUNT_TOKENS_MODEL;
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    // The Claude-model path counts through a fetch stub; the other path is
    // a model count_tokens doesn't take.
    globalThis.fetch = (async () => new Response(JSON.stringify({ input_tokens: 4_242 }), { status: 200 })) as unknown as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    if (priorModel === undefined) delete process.env.COUNT_TOKENS_MODEL;
    else process.env.COUNT_TOKENS_MODEL = priorModel;
  });

  function appWith(cm: ReturnType<typeof cmWith>, model: string) {
    return {
      recipe: { agent: { name: 'agent' } },
      framework: {
        getAgent: () => ({ model, getContextManager: () => cm }),
        previewActivation: async () => ({ messages: [{ participant: 'Lari', content: [{ type: 'text', text: 'hi' }] }] }),
      },
    } as unknown as PanelAppRef;
  }

  for (const [path, model, count] of [
    ['a model count_tokens takes', 'claude-haiku-4-5', 4_242],
    ["a model count_tokens doesn't take", 'gpt-6', null],
  ] as const) {
    test(`with ${path}, it tells a strategy that keeps no render stats from one with none yet, and gives the stats after a compile`, async () => {
      if (count === null) delete process.env.COUNT_TOKENS_MODEL;
      else process.env.COUNT_TOKENS_MODEL = model;
      const none = await buildContextMakeup(appWith(cmWith(null, true), model), 'agent');
      expect(none.stats).toBeNull();
      expect(none.statsKept).toBe(true);
      expect(none.exactTotalTokens).toBe(count);
      const passthrough = await buildContextMakeup(appWith(cmWith(null, false), model), 'agent');
      expect(passthrough.stats).toBeNull();
      expect(passthrough.statsKept).toBe(false);
      const stats = { total: { messages: 160, tokens: 16_690 } };
      const compiled = await buildContextMakeup(appWith(cmWith(stats, true), model), 'agent');
      expect(compiled.stats).toBe(stats);
      expect(compiled.statsKept).toBe(true);
    });
  }
});

describe("the health snapshot's contextComposition and contextCompositionNotKept", () => {
  const stats = { head: 10, tail: 20 };
  function appOf(agents: Array<{ name: string; getContextManager: () => unknown }>) {
    return {
      recipe: {},
      framework: {
        agents,
        healthSnapshot: () => ({ agents: agents.map((a) => ({ name: a.name })) }),
        getAllAgents() { return this.agents; },
      },
    } as unknown as PanelAppRef;
  }

  test('an agent with stats has its entry, and one with none is left out, named in contextCompositionNotKept where its strategy keeps none', () => {
    const snapshot = buildHealthSnapshot(appOf([
      { name: 'first-passthrough', getContextManager: () => cmWith(null, false) },
      { name: 'compiled', getContextManager: () => cmWith(stats, true) },
      { name: 'passthrough', getContextManager: () => cmWith(null, false) },
      { name: 'waiting', getContextManager: () => cmWith(null, true) },
    ]));
    expect(snapshot.contextComposition).toEqual({ compiled: stats });
    expect(snapshot.contextCompositionNotKept).toEqual(['first-passthrough', 'passthrough']);
    expect(snapshot.readFailures).toBeUndefined();
  });

  test('with no agent whose strategy keeps none, contextCompositionNotKept is left out', () => {
    const snapshot = buildHealthSnapshot(appOf([
      { name: 'compiled', getContextManager: () => cmWith(stats, true) },
      { name: 'waiting', getContextManager: () => cmWith(null, true) },
    ]));
    expect(snapshot.contextComposition).toEqual({ compiled: stats });
    expect('contextCompositionNotKept' in snapshot).toBe(false);
  });

  test("an agent whose read throws partway is a read failure, and isn't named as keeping none", () => {
    const snapshot = buildHealthSnapshot(appOf([
      { name: 'broken', getContextManager: () => ({ getRenderStats: () => null, getStrategy: () => { throw new Error('not ready'); } }) },
      { name: 'passthrough', getContextManager: () => cmWith(null, false) },
    ]));
    expect(snapshot.contextComposition).toEqual({});
    expect(snapshot.contextCompositionNotKept).toEqual(['passthrough']);
    // Other sections that ask the strategy fail for it too; this one's is named.
    expect((snapshot.readFailures as Record<string, Record<string, string>>).broken!.contextComposition).toBe('not ready');
  });

  test("an observer without 'ops' still reads which agent's strategy keeps none", async () => {
    const { healthComposition } = await words();
    const snapshot = buildHealthSnapshot(appOf([
      { name: 'waiting', getContextManager: () => cmWith(null, true) },
      { name: 'passthrough', getContextManager: () => cmWith(null, false) },
      { name: 'broken', getContextManager: () => { throw new Error('not ready'); } },
    ]));
    const sent = JSON.parse(JSON.stringify(keepNamedStrings(snapshot, HEALTH_STRINGS)));
    expect(healthComposition(sent, 'passthrough')).toEqual({ line: "This agent's strategy keeps no composition." });
    expect(healthComposition(sent, 'waiting')).toEqual({ line: 'No live compile since its context was loaded.' });
    // A failed read comes with its text emptied, and still shows nothing.
    expect(sent.readFailures.broken.contextComposition).toBe('');
    expect(healthComposition(sent, 'broken')).toBeNull();
  });
});
