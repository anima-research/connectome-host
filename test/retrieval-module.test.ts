import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_RELEVANCE_THRESHOLD,
  RetrievalModule,
  fuse,
  lessonDocument,
  rerankQuery,
  searchQueries,
  type RecentMessage,
} from '../src/modules/retrieval-module.js';
import type { RetrievalModels } from '../src/modules/retrieval-models.js';
import { RetrievalTraceStore, type RetrievalTraceBeginOptions } from '../src/modules/retrieval-trace.js';
import type { Lesson } from '../src/modules/lessons-module.js';

const AGENT = 'test-agent';

function lesson(id: string, content: string, extra: Partial<Lesson> = {}): Lesson {
  return {
    id,
    content,
    confidence: 0.9,
    tags: [],
    evidence: [],
    created: Date.now(),
    updated: 1,
    deprecated: false,
    ...extra,
  };
}

// Words folded together by the fake embedder, standing in for what a real
// embedding model knows and BM25 does not.
const SYNONYMS: Record<string, string> = { invoices: 'billing', invoice: 'billing', payments: 'billing' };
const DIMS = 64;

function fakeEmbed(text: string): Float32Array {
  const v = new Float32Array(DIMS);
  v[0] = 0.01; // never a zero vector
  for (const raw of text.toLowerCase().split(/[^a-z]+/).filter(w => w.length > 2)) {
    const w = SYNONYMS[raw] ?? raw;
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % (DIMS - 1);
    v[h + 1] += 1;
  }
  const norm = Math.hypot(...v);
  return v.map(x => x / norm);
}

class FakeModels implements RetrievalModels {
  readonly embeddingModel = 'fake-embed';
  readonly rerankerModel = 'fake-rerank';
  embedded: Array<{ texts: string[]; kind: 'query' | 'document' }> = [];
  reranked: Array<{ query: string; documents: string[] }> = [];
  disposed = false;

  constructor(private readonly score: (query: string, document: string) => number) {}

  async embed(texts: string[], kind: 'query' | 'document'): Promise<Float32Array[]> {
    this.embedded.push({ texts: [...texts], kind });
    return texts.map(fakeEmbed);
  }

  async rerank(query: string, documents: string[]): Promise<number[]> {
    this.reranked.push({ query, documents: [...documents] });
    return documents.map(d => this.score(query, d));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

/** Relevant iff the document mentions any of `words`. */
const mentions = (...words: string[]) => (_q: string, d: string) =>
  words.some(w => d.toLowerCase().includes(w)) ? 0.9 : 0.1;

function harness(
  lessons: Lesson[],
  score: (query: string, document: string) => number,
  messages: RecentMessage[] = [{ participant: 'user', text: 'Tell me about memory please.' }],
  config: { maxCandidates?: number; relevanceThreshold?: number; maxInjectedLessons?: number } = {},
) {
  const models = new FakeModels(score);
  const retrieved: string[][] = [];
  const mod = new RetrievalModule({ models, ...config });
  (mod as unknown as { ctx: unknown }).ctx = {
    getModule: (name: string) => name === 'lessons'
      ? { getLessons: () => lessons, recordRetrieval: (ids: string[]) => { retrieved.push(ids); } }
      : null,
    queryMessages: () => ({
      messages: messages.map((m, i) => ({
        id: `m${i}`,
        participant: m.participant,
        content: [{ type: 'text', text: m.text }],
      })),
      totalCount: messages.length,
    }),
  };
  return { mod, models, retrieved };
}

function injectedText(injections: Awaited<ReturnType<RetrievalModule['gatherContext']>>): string {
  return (injections[0].content[0] as { type: 'text'; text: string }).text;
}

describe('query construction', () => {
  test('latest incoming and own messages come first, then window chunks newest-first', () => {
    const messages = [
      { participant: 'user', text: 'first question' },
      { participant: AGENT, text: 'my answer' },
      { participant: 'user', text: 'follow-up' },
    ];
    expect(searchQueries(messages, AGENT)).toEqual([
      'follow-up',
      'my answer',
      `user: first question\n\n${AGENT}: my answer\n\nuser: follow-up`,
    ]);
  });

  test('queries are capped and the window is chunked from the end', () => {
    const text = Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' '); // ~11k chars, no repeats
    const queries = searchQueries([{ participant: 'user', text }], AGENT);
    expect(queries.every(q => q.length <= 2000)).toBe(true);
    // latest incoming (identical to the newest window chunk, deduplicated) + 3 older chunks
    expect(queries).toHaveLength(4);
  });

  test('the rerank query is the conversation tail', () => {
    const q = rerankQuery([{ participant: 'user', text: 'a'.repeat(5000) + 'END' }]);
    expect(q.length).toBe(1200);
    expect(q.endsWith('END')).toBe(true);
  });

  test('lesson documents carry their tags', () => {
    expect(lessonDocument(lesson('l', 'content', { tags: ['people', 'billing'] })))
      .toBe('content\nTags: people, billing');
  });

  test('fusion favours agreement across lists over one top rank', () => {
    expect(fuse([['a', 'b'], ['c', 'b'], ['d', 'b']])[0].id).toBe('b');
  });
});

describe('RetrievalModule pipeline', () => {
  test('injects reranked lessons at or above the threshold and traces how each was found', async () => {
    const lessons = [
      lesson('l1', 'Alice owns the billing pipeline'),
      lesson('l2', 'Deploys are frozen on Fridays'),
    ];
    const h = harness(lessons, mentions('billing'), [{ participant: 'user', text: 'Who owns billing?' }]);

    const injections = await h.mod.gatherContext(AGENT);

    expect(injectedText(injections)).toContain('Alice owns the billing pipeline');
    expect(injectedText(injections)).not.toContain('Fridays');
    const [trace] = h.mod.getRetrievalTraces({ includeInputs: true });
    expect(trace.outcome).toBe('injected');
    expect(trace.config).toMatchObject({
      embeddingModel: 'fake-embed', rerankerModel: 'fake-rerank', relevanceThreshold: DEFAULT_RELEVANCE_THRESHOLD,
    });
    expect(trace.candidates.find(c => c.id === 'l1')).toMatchObject({ rerankScore: 0.9, lexicalRank: 1, denseRank: 1 });
    expect(trace.candidates.find(c => c.id === 'l2')!.lexicalRank).toBeUndefined();
    expect(trace.relevantLessonIds).toEqual(['l1']);
    expect(trace.queries).toContain('Who owns billing?');
    expect(trace.rerankQuery).toBe('user: Who owns billing?');
    expect(h.retrieved).toEqual([['l1']]);
  });

  test('dense search reaches a lesson sharing no words with the conversation', async () => {
    const lessons = [
      lesson('billing', 'Alice owns the billing pipeline'),
      lesson('deploys', 'Deploys are frozen on Fridays'),
    ];
    const h = harness(lessons, mentions('billing'), [{ participant: 'user', text: 'who handles invoices?' }], {
      maxCandidates: 1,
    });

    const injections = await h.mod.gatherContext(AGENT);

    expect(h.models.reranked[0].documents).toEqual(['Alice owns the billing pipeline']);
    expect(injectedText(injections)).toContain('billing pipeline');
    const [trace] = h.mod.getRetrievalTraces();
    expect(trace.candidates[0]).toMatchObject({ id: 'billing', denseRank: 1 });
    expect(trace.candidates[0].lexicalRank).toBeUndefined();
  });

  test('nothing at or above the threshold injects nothing', async () => {
    const h = harness([lesson('l1', 'memory detail')], () => DEFAULT_RELEVANCE_THRESHOLD - 0.01);

    expect(await h.mod.gatherContext(AGENT)).toEqual([]);
    expect(h.mod.getRetrievalTraces()[0].outcome).toBe('no-relevant-lessons');
    expect(h.retrieved).toEqual([]);
  });

  test('the threshold is configurable', async () => {
    const h = harness([lesson('l1', 'memory detail')], () => 0.2, undefined, { relevanceThreshold: 0.15 });
    expect(await h.mod.gatherContext(AGENT)).toHaveLength(1);
  });

  test('relevant lessons are injected in salience order, up to maxInjectedLessons', async () => {
    const yearAgo = Date.now() - 365 * 86_400_000;
    const lessons = [
      lesson('stale', 'memory stale', { created: yearAgo }),
      lesson('used', 'memory used', { created: yearAgo, lastRetrieved: Date.now(), retrievalCount: 3 }),
      lesson('weak', 'memory weak', { confidence: 0.4 }),
    ];
    const h = harness(lessons, () => 0.9, undefined, { maxInjectedLessons: 2 });

    const text = injectedText(await h.mod.gatherContext(AGENT));

    expect(text.indexOf('memory used')).toBeLessThan(text.indexOf('memory stale'));
    expect(text).not.toContain('memory weak');
    expect(h.retrieved).toEqual([['used', 'stale']]);
  });

  test('document embeddings are computed once, recomputed on edit, and pruned', async () => {
    const l1 = lesson('l1', 'memory alpha');
    const messages: RecentMessage[] = [{ participant: 'user', text: 'memory one' }];
    const h = harness([l1, lesson('l2', 'memory beta')], () => 0.9, messages);

    await h.mod.gatherContext(AGENT);
    messages.push({ participant: 'user', text: 'memory two' });
    l1.content = 'memory alpha revised';
    await h.mod.gatherContext(AGENT);

    const documentCalls = h.models.embedded.filter(c => c.kind === 'document').map(c => c.texts);
    expect(documentCalls).toEqual([['memory alpha', 'memory beta'], ['memory alpha revised']]);
    const vectors = (h.mod as unknown as { documentVectors: Map<string, unknown> }).documentVectors;
    expect([...vectors.keys()].sort()).toEqual(['memory alpha revised', 'memory beta']);
  });

  test('a cache hit makes no model calls and is not counted as a retrieval', async () => {
    const h = harness([lesson('l1', 'memory detail')], () => 0.9);

    const first = await h.mod.gatherContext(AGENT);
    const second = await h.mod.gatherContext(AGENT);

    expect(second).toEqual(first);
    expect(h.models.reranked).toHaveLength(1);
    expect(h.retrieved).toEqual([['l1']]);
    const [cached, source] = h.mod.getRetrievalTraces({ limit: 2 });
    expect(cached.outcome).toBe('cache-hit');
    expect(cached.cache).toEqual({ hit: true, sourceTraceId: source.id });
    expect(cached.injected.lessonIds).toEqual(['l1']);
  });

  test('model failures fail open with an error trace', async () => {
    const h = harness([lesson('l1', 'memory detail')], () => { throw new Error('reranker unavailable'); });

    expect(await h.mod.gatherContext(AGENT)).toEqual([]);
    expect(h.mod.getRetrievalTraces()[0]).toMatchObject({ outcome: 'error', error: 'reranker unavailable' });
  });

  test('a reranker returning the wrong number of scores is an error, not a guess', async () => {
    const h = harness([lesson('l1', 'memory a'), lesson('l2', 'memory b')], () => 0.9);
    h.models.rerank = async () => [0.9];

    expect(await h.mod.gatherContext(AGENT)).toEqual([]);
    expect(h.mod.getRetrievalTraces()[0].error).toBe('reranker returned 1 scores for 2 candidates');
  });

  test('default trace views omit conversation-derived inputs', async () => {
    const h = harness([lesson('l1', 'memory detail')], () => 0.9);
    await h.mod.gatherContext(AGENT);

    const [safe] = h.mod.getRetrievalTraces();
    expect(safe.context?.input).toBeUndefined();
    expect(safe.queries).toBeUndefined();
    expect(safe.rerankQuery).toBeUndefined();
    expect(safe.candidates[0].content).toBe('memory detail');
    const [full] = h.mod.getRetrievalTraces({ includeInputs: true });
    expect(full.context?.input).toContain('Tell me about memory');
  });

  test('stop disposes the models', async () => {
    const h = harness([], () => 0.9);
    await h.mod.stop();
    expect(h.models.disposed).toBe(true);
  });
});

describe('RetrievalModule upstream failures', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['getModule', { getModule: () => { throw new Error('getModule failed'); } }],
    ['getLessons', { getModule: () => ({ getLessons: () => { throw new Error('getLessons failed'); } }) }],
    ['queryMessages', {
      getModule: () => ({ getLessons: () => [lesson('l1', 'memory')], recordRetrieval: () => {} }),
      queryMessages: () => { throw new Error('queryMessages failed'); },
    }],
  ];
  for (const [what, ctx] of cases) {
    test(`records a completed error trace and rethrows when ${what} throws`, async () => {
      const mod = new RetrievalModule({ models: new FakeModels(() => 0.9) });
      (mod as unknown as { ctx: unknown }).ctx = ctx;

      await expect(mod.gatherContext(AGENT)).rejects.toThrow(`${what} failed`);
      expect(mod.getRetrievalTraces()[0]).toMatchObject({ outcome: 'error', error: `${what} failed` });
      expect(mod.getRetrievalTraces()[0].completedAt).toBeDefined();
    });
  }
});

describe('RetrievalTraceStore bounds', () => {
  const options: RetrievalTraceBeginOptions = {
    agentName: AGENT,
    embeddingModel: 'fake-embed',
    rerankerModel: 'fake-rerank',
    minConfidence: 0.3,
    maxCandidates: 16,
    maxInjectedLessons: 5,
    relevanceThreshold: 0.5,
  };

  test('preserves the numeric capacity constructor contract', () => {
    const store = new RetrievalTraceStore(2);
    for (let i = 0; i < 3; i++) store.begin(options).finish('not-started');
    expect(store.list({ limit: 100 }).map(trace => trace.id)).toEqual([3, 2]);
  });

  test('retains only the newest 100 runs', async () => {
    const mod = new RetrievalModule({ models: new FakeModels(() => 0.9) });
    for (let i = 0; i < 105; i++) await mod.gatherContext(AGENT);
    const traces = mod.getRetrievalTraces({ limit: 100 });
    expect(traces).toHaveLength(100);
    expect(traces[0].id).toBe(105);
    expect(traces.at(-1)?.id).toBe(6);
    expect(traces.every(trace => trace.outcome === 'not-started')).toBe(true);
  });

  test('cache links are marked evicted rather than left dangling', async () => {
    const h = harness([lesson('l1', 'memory detail')], () => 0.9);
    for (let i = 0; i < 106; i++) await h.mod.gatherContext(AGENT);

    const traces = h.mod.getRetrievalTraces({ limit: 100 });
    expect(traces.every(trace => trace.outcome === 'cache-hit')).toBe(true);
    expect(traces.every(trace => trace.cache.sourceTraceEvicted === true)).toBe(true);
    expect(traces[0].injected.lessons[0]).toMatchObject({ id: 'l1', content: 'memory detail' });
  });

  test('evicts oldest traces to stay within the UTF-8 byte budget', () => {
    const byteBudget = 2800;
    const store = new RetrievalTraceStore({ byteBudget });
    for (let i = 0; i < 3; i++) {
      const run = store.begin(options);
      run.setContext(`hash-${i}`, `context-${i}-` + 'x'.repeat(1300), 1, [`m${i}`]);
      run.finish('no-relevant-lessons');
    }

    const traces = store.list({ limit: 100, includeInputs: true });
    expect(traces.length).toBeLessThan(3);
    expect(traces[0].id).toBe(3);
    expect(store.retainedBytes).toBeLessThanOrEqual(byteBudget);
  });

  test('marks a byte-tombstoned cache source honestly and keeps its config', () => {
    const store = new RetrievalTraceStore({ byteBudget: 4096 });
    const source = store.begin(options);
    source.setContext('large-source', 'x'.repeat(20_000), 1, ['message-1']);
    source.finish('injected');
    const cached = store.begin(options);
    cached.recordCacheHit(source.id, ['l1'], [lesson('l1', 'memory detail')], []);
    cached.finish('cache-hit');

    const [cacheTrace, sourceTrace] = store.list({ limit: 2 });
    expect(sourceTrace.truncation?.kind).toBe('tombstone');
    const { agentName: _agentName, ...config } = options;
    expect(sourceTrace.config).toEqual(config);
    expect(cacheTrace.cache).toEqual({ hit: true, sourceTraceId: source.id, sourceTraceTruncated: true });
  });

  test('evicted active runs cannot reintroduce payload beyond the byte budget', () => {
    const byteBudget = 2200;
    const store = new RetrievalTraceStore({ byteBudget });
    const older = store.begin(options);
    older.setContext('older', 'x'.repeat(1300), 1, ['older-message']);
    const newer = store.begin(options);
    newer.setContext('newer', 'y'.repeat(1300), 1, ['newer-message']);

    older.setContext('evicted', 'z'.repeat(100_000), 1, ['evicted-message']);
    older.finish('error', new Error('late active failure'));
    newer.finish('no-relevant-lessons');

    expect(store.list({ limit: 100, includeInputs: true }).map(trace => trace.id)).toEqual([2]);
    expect(store.retainedBytes).toBeLessThanOrEqual(byteBudget);
  });
});
