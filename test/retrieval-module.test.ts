import { describe, expect, test } from 'bun:test';
import type { Membrane, NormalizedRequest } from '@animalabs/membrane';
import { RetrievalModule } from '../src/modules/retrieval-module.js';
import { RetrievalTraceStore } from '../src/modules/retrieval-trace.js';
import { buildRetrievalModuleConfig } from '../src/retrieval-config.js';
import type { Lesson } from '../src/modules/lessons-module.js';

const TEST_AGENT = 'test-agent';
const TEST_RETRIEVAL_MODEL = 'test-retrieval-model';

function lesson(id: string, content: string): Lesson {
  return {
    id,
    content,
    confidence: 0.9,
    tags: ['memory'],
    evidence: [],
    created: 1,
    updated: 1,
    deprecated: false,
  };
}

function harness(responses: Array<string | Error>, lessons: Lesson[]) {
  const calls: NormalizedRequest[] = [];
  const membrane = {
    complete: async (request: NormalizedRequest) => {
      calls.push(structuredClone(request));
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error('unexpected retrieval call');
      return { content: [{ type: 'text', text: next }] };
    },
  } as unknown as Membrane;

  const installContext = (mod: RetrievalModule) => {
    (mod as unknown as { ctx: unknown }).ctx = {
      getModule: (name: string) => name === 'lessons' ? { getLessons: () => lessons } : null,
      queryMessages: () => ({
        messages: [{
          id: 'm1',
          participant: 'user',
          content: [{ type: 'text', text: 'Please recall the relevant memory context.' }],
        }],
        totalCount: 1,
      }),
    };
  };

  return { calls, membrane, installContext };
}

describe('RetrievalModule provider-specific reasoning', () => {
  test('passes configured reasoning to concept extraction and relevance validation', async () => {
    const lessons = [1, 2, 3, 4].map(n => lesson(`l${n}`, `memory detail ${n}`));
    const h = harness(['["memory"]', '["l1", "l3"]'], lessons);
    const mod = new RetrievalModule(buildRetrievalModuleConfig(h.membrane, {
      model: TEST_RETRIEVAL_MODEL,
      reasoningEffort: 'xhigh',
    }, 'openai-codex'));
    h.installContext(mod);

    const injections = await mod.gatherContext(TEST_AGENT);

    expect(h.calls).toHaveLength(2);
    for (const request of h.calls) {
      expect(request.config.model).toBe(TEST_RETRIEVAL_MODEL);
      expect(request.providerParams).toEqual({
        reasoning: { effort: 'xhigh' },
      });
    }
    const text = (injections[0].content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('memory detail 1');
    expect(text).toContain('memory detail 3');
    expect(text).not.toContain('memory detail 2');
  });

  test('omits providerParams when retrieval reasoning is not configured', async () => {
    const h = harness(['[]'], [lesson('l1', 'memory detail')]);
    const mod = new RetrievalModule({ membrane: h.membrane, retrievalModel: 'gpt-5.4-mini' });
    h.installContext(mod);

    expect(await mod.gatherContext(TEST_AGENT)).toEqual([]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].providerParams).toBeUndefined();
  });

  test('skips relevance validation for three or fewer candidates and caches non-empty results', async () => {
    const h = harness(['["memory"]'], [lesson('l1', 'memory alpha'), lesson('l2', 'memory beta')]);
    const mod = new RetrievalModule({
      membrane: h.membrane,
      retrievalModel: TEST_RETRIEVAL_MODEL,
      retrievalReasoning: { effort: 'xhigh' },
    });
    h.installContext(mod);

    const first = await mod.gatherContext(TEST_AGENT);
    const second = await mod.gatherContext(TEST_AGENT);

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].providerParams).toEqual({ reasoning: { effort: 'xhigh' } });
  });

  test('fails open when the concept extraction provider call fails', async () => {
    const h = harness([new Error('provider unavailable')], [lesson('l1', 'memory detail')]);
    const mod = new RetrievalModule({
      membrane: h.membrane,
      retrievalModel: TEST_RETRIEVAL_MODEL,
      retrievalReasoning: { effort: 'xhigh' },
    });
    h.installContext(mod);

    expect(await mod.gatherContext(TEST_AGENT)).toEqual([]);
    expect(h.calls).toHaveLength(1);
    expect(mod.getRetrievalTraces()[0]).toMatchObject({
      outcome: 'error',
      error: 'provider unavailable',
      conceptExtraction: { error: 'provider unavailable' },
    });
  });

  test('fails open and records the relevance stage when its provider call fails', async () => {
    const lessons = [1, 2, 3, 4].map(n => lesson(`l${n}`, `memory detail ${n}`));
    const h = harness(['["memory"]', new Error('relevance unavailable')], lessons);
    const mod = new RetrievalModule({
      membrane: h.membrane,
      retrievalModel: TEST_RETRIEVAL_MODEL,
      retrievalReasoning: { effort: 'high' },
    });
    h.installContext(mod);

    expect(await mod.gatherContext(TEST_AGENT)).toEqual([]);
    expect(h.calls).toHaveLength(2);
    expect(mod.getRetrievalTraces()[0]).toMatchObject({
      outcome: 'error',
      error: 'relevance unavailable',
      relevance: { ran: true, error: 'relevance unavailable' },
    });
  });
});

describe('RetrievalModule observability', () => {
  test('records a completed error trace and rethrows when getModule throws', async () => {
    const mod = new RetrievalModule({ membrane: {} as Membrane });
    (mod as unknown as { ctx: unknown }).ctx = {
      getModule: () => { throw new Error('getModule failed'); },
    };

    await expect(mod.gatherContext(TEST_AGENT)).rejects.toThrow('getModule failed');
    expect(mod.getRetrievalTraces()[0]).toMatchObject({
      outcome: 'error',
      error: 'getModule failed',
    });
    expect(mod.getRetrievalTraces()[0].completedAt).toBeDefined();
  });

  test('records a completed error trace and rethrows when getLessons throws', async () => {
    const mod = new RetrievalModule({ membrane: {} as Membrane });
    (mod as unknown as { ctx: unknown }).ctx = {
      getModule: () => ({ getLessons: () => { throw new Error('getLessons failed'); } }),
    };

    await expect(mod.gatherContext(TEST_AGENT)).rejects.toThrow('getLessons failed');
    expect(mod.getRetrievalTraces()[0]).toMatchObject({
      outcome: 'error',
      error: 'getLessons failed',
    });
    expect(mod.getRetrievalTraces()[0].completedAt).toBeDefined();
  });

  test('records a completed error trace and rethrows when queryMessages throws', async () => {
    const mod = new RetrievalModule({ membrane: {} as Membrane });
    (mod as unknown as { ctx: unknown }).ctx = {
      getModule: () => ({ getLessons: () => [lesson('l1', 'memory detail')] }),
      queryMessages: () => { throw new Error('queryMessages failed'); },
    };

    await expect(mod.gatherContext(TEST_AGENT)).rejects.toThrow('queryMessages failed');
    expect(mod.getRetrievalTraces()[0]).toMatchObject({
      outcome: 'error',
      error: 'queryMessages failed',
    });
    expect(mod.getRetrievalTraces()[0].completedAt).toBeDefined();
  });

  test('records candidates, selector outputs, selected IDs, and the exact injection', async () => {
    const lessons = [1, 2, 3, 4].map(n => lesson(`l${n}`, `memory detail ${n}`));
    const h = harness(['["memory"]', '["l1", "l3"]'], lessons);
    const mod = new RetrievalModule(buildRetrievalModuleConfig(h.membrane, {
      model: TEST_RETRIEVAL_MODEL,
      maxInjected: 5,
      reasoningEffort: 'xhigh',
    }, 'openai-codex'));
    h.installContext(mod);

    const injections = await mod.gatherContext(TEST_AGENT);

    const [trace] = mod.getRetrievalTraces({ includeInputs: true });
    expect(trace.outcome).toBe('injected');
    expect(trace.agentName).toBe(TEST_AGENT);
    expect(trace.config).toMatchObject({
      model: TEST_RETRIEVAL_MODEL,
      requestedReasoning: { effort: 'xhigh' },
      providerParams: { reasoning: { effort: 'xhigh' } },
      maxInjectedLessons: 5,
    });
    expect(trace.context?.input).toContain('Please recall the relevant memory context.');
    expect(trace.conceptExtraction).toMatchObject({
      rawOutput: '["memory"]',
      responseContent: [{ type: 'text', text: '["memory"]' }],
      parsedValues: ['memory'],
      parseMode: 'json',
    });
    expect(trace.candidates.map(candidate => candidate.id)).toEqual(['l1', 'l2', 'l3', 'l4']);
    expect(trace.candidates[0].matches).toContainEqual({
      concept: 'memory', keyword: 'memory', field: 'content',
    });
    expect(trace.relevance).toMatchObject({
      ran: true,
      rawOutput: '["l1", "l3"]',
      responseContent: [{ type: 'text', text: '["l1", "l3"]' }],
      parsedValues: ['l1', 'l3'],
      parseMode: 'json',
    });
    expect(trace.relevantLessonIds).toEqual(['l1', 'l3']);
    expect(trace.injected.lessonIds).toEqual(['l1', 'l3']);
    expect(trace.injected.namespace).toBe(injections[0].namespace);
    expect(trace.injected.position).toBe(injections[0].position);
    expect(trace.injected.block).toBe((injections[0].content[0] as { type: 'text'; text: string }).text);
    expect(trace.injected.block).toContain('## Retrieved Knowledge');
    expect(trace.injected.block).toContain('memory detail 1');
    expect(trace.injected.block).not.toContain('memory detail 2');

    const [safeView] = mod.getRetrievalTraces();
    expect(safeView.context?.input).toBeUndefined();
    expect(safeView.conceptExtraction?.input).toBeUndefined();
    expect(safeView.relevance?.input).toBeUndefined();
    expect(safeView.candidates[0].content).toBe('memory detail 1');
  });

  test('retains complete point-in-time lesson snapshots', async () => {
    const source: Lesson = {
      id: 'complete-lesson',
      content: 'memory detail',
      confidence: 0.87,
      tags: ['memory', 'original-tag'],
      evidence: ['message-1', 'message-2'],
      created: 101,
      updated: 202,
      deprecated: false,
      deprecationReason: 'retained optional field',
    };
    const expected = structuredClone(source);
    const h = harness(['["memory"]'], [source]);
    const mod = new RetrievalModule({ membrane: h.membrane });
    h.installContext(mod);

    expect(await mod.gatherContext(TEST_AGENT)).toHaveLength(1);
    source.content = 'mutated content';
    source.tags.push('mutated-tag');
    source.evidence.push('mutated-evidence');
    source.updated = 999;
    source.deprecationReason = 'mutated reason';

    const trace = mod.getRetrievalTraces()[0];
    expect(trace.candidates[0]).toMatchObject(expected);
    expect(trace.injected.lessons[0]).toEqual(expected);

    trace.injected.lessons[0].tags.push('caller mutation');
    trace.injected.lessons[0].evidence.push('caller mutation');
    expect(mod.getRetrievalTraces()[0].injected.lessons[0]).toEqual(expected);
  });

  test('records cache reuse with a source trace and no extra model calls', async () => {
    const lessons = [1, 2, 3, 4].map(n => lesson(`l${n}`, `memory detail ${n}`));
    const h = harness(['["memory"]', '["l2"]'], lessons);
    const mod = new RetrievalModule({ membrane: h.membrane, retrievalModel: TEST_RETRIEVAL_MODEL });
    h.installContext(mod);

    await mod.gatherContext(TEST_AGENT);
    await mod.gatherContext(TEST_AGENT);

    expect(h.calls).toHaveLength(2);
    const [cached, source] = mod.getRetrievalTraces({ limit: 2 });
    expect(source.outcome).toBe('injected');
    expect(cached.outcome).toBe('cache-hit');
    expect(cached.cache).toEqual({ hit: true, sourceTraceId: source.id });
    expect(cached.injected.lessonIds).toEqual(['l2']);
    expect(cached.injected.lessons).toEqual(source.injected.lessons);
    expect(cached.injected.lessons[0].content).toBe('memory detail 2');
    expect(cached.injected.block).toContain('memory detail 2');
  });

  test('cache-hit snapshots stay complete after source eviction', async () => {
    const source: Lesson = {
      ...lesson('l1', 'memory detail'),
      evidence: ['message-1'],
      created: 10,
      updated: 20,
      deprecationReason: 'optional metadata',
    };
    const expected = structuredClone(source);
    const h = harness(['["memory"]'], [source]);
    const mod = new RetrievalModule({ membrane: h.membrane });
    h.installContext(mod);

    await mod.gatherContext(TEST_AGENT);
    for (let i = 0; i < 105; i++) await mod.gatherContext(TEST_AGENT);

    const cached = mod.getRetrievalTraces({ limit: 100 })[0];
    expect(cached.outcome).toBe('cache-hit');
    expect(cached.cache).toEqual({ hit: true, sourceTraceEvicted: true });
    expect(cached.injected.lessons[0]).toEqual(expected);
  });

  test('records skipped validation and relevance fallback without changing behavior', async () => {
    const few = harness(['["memory"]'], [lesson('l1', 'memory one'), lesson('l2', 'memory two')]);
    const fewMod = new RetrievalModule({ membrane: few.membrane });
    few.installContext(fewMod);
    await fewMod.gatherContext(TEST_AGENT);
    expect(fewMod.getRetrievalTraces()[0].relevance).toMatchObject({
      ran: false,
      skippedReason: 'three-or-fewer-candidates',
    });
    expect(fewMod.getRetrievalTraces()[0].relevance?.parsedValues).toBeUndefined();

    const manyLessons = [1, 2, 3, 4].map(n => lesson(`l${n}`, `memory ${n}`));
    const many = harness(['["memory"]', 'not valid json'], manyLessons);
    const manyMod = new RetrievalModule({ membrane: many.membrane });
    many.installContext(manyMod);
    const injections = await manyMod.gatherContext(TEST_AGENT);
    expect(injections).toHaveLength(1);
    expect(manyMod.getRetrievalTraces()[0].relevance).toMatchObject({
      ran: true,
      rawOutput: 'not valid json',
      parsedValues: [],
      parseMode: 'fallback',
    });
    expect(manyMod.getRetrievalTraces()[0].relevantLessonIds).toEqual(['l1', 'l2', 'l3', 'l4']);
  });

  test('trace-only message IDs cannot make retrieval fail', async () => {
    const h = harness(['["memory"]'], [lesson('l1', 'memory detail')]);
    const mod = new RetrievalModule({ membrane: h.membrane });
    const message = {
      participant: 'user',
      content: [{ type: 'text', text: 'memory please' }],
    } as Record<string, unknown>;
    Object.defineProperty(message, 'id', { get: () => { throw new Error('trace-only id getter'); } });
    (mod as unknown as { ctx: unknown }).ctx = {
      getModule: (name: string) => name === 'lessons' ? { getLessons: () => [lesson('l1', 'memory detail')] } : null,
      queryMessages: () => ({ messages: [message], totalCount: 1 }),
    };

    const injections = await mod.gatherContext(TEST_AGENT);
    expect(injections).toHaveLength(1);
    expect(mod.getRetrievalTraces({ includeInputs: true })[0].context?.messageIds).toEqual([]);
  });

  test('takes its window from the last 10 stored messages, leaving out rows the framework still holds and counting one marked held: false as stored', async () => {
    const h = harness(['[]'], [lesson('l1', 'memory detail')]);
    const mod = new RetrievalModule({ membrane: h.membrane });
    const row = (id: string, text: string, held?: boolean) => ({
      id,
      participant: 'user',
      content: [{ type: 'text', text }],
      ...(held === undefined ? {} : { held }),
    });
    const stored = Array.from({ length: 11 }, (_, i) => row(`m${i + 1}`, `stored message ${i + 1}.`, i % 2 === 0 ? undefined : false));
    (mod as unknown as { ctx: unknown }).ctx = {
      getModule: (name: string) => name === 'lessons' ? { getLessons: () => [lesson('l1', 'memory detail')] } : null,
      queryMessages: () => ({
        messages: [...stored, row('h1', 'held message A.', true), row('h2', 'held message B.', true)],
        totalCount: 13,
      }),
    };

    expect(await mod.gatherContext(TEST_AGENT)).toEqual([]);
    expect(h.calls).toHaveLength(1);
    const sent = JSON.stringify(h.calls[0].messages);
    for (let i = 2; i <= 11; i++) expect(sent).toContain(`stored message ${i}.`);
    expect(sent).not.toContain('stored message 1.');
    expect(sent).not.toContain('held message');
    const context = mod.getRetrievalTraces({ includeInputs: true })[0].context;
    expect(context?.messageCount).toBe(10);
    expect(context?.messageIds).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 2}`));
  });

  test('leaves out rows a tune-out holds from the residents, whether stored or still held', async () => {
    const h = harness(['[]'], [lesson('l1', 'memory detail')]);
    const mod = new RetrievalModule({ membrane: h.membrane });
    const row = (id: string, text: string, extra: Record<string, unknown> = {}) =>
      ({ id, participant: 'user', content: [{ type: 'text', text }], ...extra });
    const shown = Array.from({ length: 10 }, (_, i) => row(`m${i + 1}`, `shown message ${i + 1}.`));
    (mod as unknown as { ctx: unknown }).ctx = {
      getModule: (name: string) => name === 'lessons' ? { getLessons: () => [lesson('l1', 'memory detail')] } : null,
      queryMessages: () => ({
        messages: [
          ...shown.slice(0, 5),
          row('t1', 'tuned-out message A.', { heldFromResidents: true }),
          ...shown.slice(5),
          row('t2', 'tuned-out message B.', { heldFromResidents: true }),
          row('t3', 'tuned-out message C.', { heldFromResidents: true, held: true }),
        ],
        totalCount: 13,
      }),
    };

    expect(await mod.gatherContext(TEST_AGENT)).toEqual([]);
    expect(h.calls).toHaveLength(1);
    const sent = JSON.stringify(h.calls[0].messages);
    for (let i = 1; i <= 10; i++) expect(sent).toContain(`shown message ${i}.`);
    expect(sent).not.toContain('tuned-out message');
    const context = mod.getRetrievalTraces({ includeInputs: true })[0].context;
    expect(context?.messageIds).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 1}`));
  });

  test('a held arrival leaves the window, so the cached retrieval stands', async () => {
    const h = harness(['["memory"]'], [lesson('l1', 'memory detail')]);
    const mod = new RetrievalModule({ membrane: h.membrane });
    const rows: Array<Record<string, unknown>> = [
      { id: 'm1', participant: 'user', content: [{ type: 'text', text: 'Please recall the memory detail.' }] },
    ];
    (mod as unknown as { ctx: unknown }).ctx = {
      getModule: (name: string) => name === 'lessons' ? { getLessons: () => [lesson('l1', 'memory detail')] } : null,
      queryMessages: () => ({ messages: [...rows], totalCount: rows.length }),
    };

    const first = await mod.gatherContext(TEST_AGENT);
    expect(first).toHaveLength(1);
    rows.push({ id: 'h1', participant: 'user', content: [{ type: 'text', text: 'A message that arrived mid-turn.' }], held: true });
    const second = await mod.gatherContext(TEST_AGENT);

    expect(second).toEqual(first);
    expect(h.calls).toHaveLength(1);
    expect(mod.getRetrievalTraces()[0].outcome).toBe('cache-hit');
  });

  test('finds no recent context when every row is still held', async () => {
    const h = harness([], [lesson('l1', 'memory detail')]);
    const mod = new RetrievalModule({ membrane: h.membrane });
    (mod as unknown as { ctx: unknown }).ctx = {
      getModule: (name: string) => name === 'lessons' ? { getLessons: () => [lesson('l1', 'memory detail')] } : null,
      queryMessages: () => ({
        messages: [{ participant: 'user', content: [{ type: 'text', text: 'held message.' }], held: true }],
        totalCount: 1,
      }),
    };

    expect(await mod.gatherContext(TEST_AGENT)).toEqual([]);
    expect(h.calls).toHaveLength(0);
    expect(mod.getRetrievalTraces()[0].outcome).toBe('no-recent-context');
  });

  test('malformed mixed wrapper retains historical fail-open behavior', async () => {
    const h = harness(['prose ["memory", 3]'], [lesson('l1', 'memory detail')]);
    const mod = new RetrievalModule({ membrane: h.membrane });
    h.installContext(mod);

    expect(await mod.gatherContext(TEST_AGENT)).toEqual([]);
    const [trace] = mod.getRetrievalTraces();
    expect(trace.outcome).toBe('error');
    expect(trace.conceptExtraction).toMatchObject({
      parseMode: 'array-extraction',
      parsedValues: ['memory'],
    });
  });

  test('candidate provenance mirrors historical empty-keyword matching', async () => {
    const h = harness(['["   "]'], [lesson('l1', 'unrelated detail')]);
    const mod = new RetrievalModule({ membrane: h.membrane });
    h.installContext(mod);

    expect(await mod.gatherContext(TEST_AGENT)).toHaveLength(1);
    expect(mod.getRetrievalTraces()[0].candidates[0].matches).toContainEqual({
      concept: '   ', keyword: '', field: 'content',
    });
  });

  test('provider blocks preserve JSON safety markers for unusual values', async () => {
    const opaque: Record<string, unknown> = {
      type: 'redacted_thinking',
      bytes: 42n,
      nonfinite: Number.POSITIVE_INFINITY,
    };
    opaque.self = opaque;
    Object.defineProperty(opaque, 'unreadable', {
      enumerable: true,
      get: () => { throw new Error('unreadable provider property'); },
    });
    const membrane = {
      complete: async () => ({
        content: [{ type: 'text', text: '["memory"]' }, opaque],
      }),
    } as unknown as Membrane;
    const mod = new RetrievalModule({ membrane });
    (mod as unknown as { ctx: unknown }).ctx = {
      getModule: (name: string) => name === 'lessons' ? { getLessons: () => [lesson('l1', 'memory detail')] } : null,
      queryMessages: () => ({
        messages: [{ participant: 'user', content: [{ type: 'text', text: 'memory' }] }],
        totalCount: 1,
      }),
    };

    expect(await mod.gatherContext(TEST_AGENT)).toHaveLength(1);
    const serialized = JSON.stringify(mod.getRetrievalTraces({ includeInputs: true }));
    expect(serialized).toContain('"type":"bigint"');
    expect(serialized).toContain('"type":"circular"');
    expect(serialized).toContain('"type":"number"');
    expect(serialized).toContain('"type":"unreadable"');
  });

  test('canonicalizes non-JSON provider parameters before byte accounting', () => {
    const binary = new ArrayBuffer(2 * 1024 * 1024);
    const broad = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`key-${i}`, i]));
    const store = new RetrievalTraceStore({ byteBudget: 4096 });
    const run = store.begin({
      agentName: TEST_AGENT,
      model: TEST_RETRIEVAL_MODEL,
      providerParams: {
        binary,
        view: new Uint8Array(binary),
        map: new Map([['binary', binary]]),
        set: new Set([binary]),
        broad,
      } as unknown as Record<string, unknown>,
      minConfidence: 0.3,
      maxCandidates: 20,
      maxInjectedLessons: 5,
    });
    run.finish('no-concepts');

    const [trace] = store.list({ includeInputs: true });
    expect(trace.truncation).toBeUndefined();
    expect(trace.config.providerParams).toMatchObject({
      binary: { type: 'array-buffer', byteLength: binary.byteLength, unavailable: true },
      view: { type: 'array-buffer-view', byteLength: binary.byteLength, unavailable: true },
      map: { type: 'map', size: 1, unavailable: true },
      set: { type: 'set', size: 1, unavailable: true },
    });
    expect(trace.config.providerParamsTruncation?.reasons).toContain('non-json-value');
    expect(trace.config.providerParamsTruncation?.reasons).toContain('max-object-keys');
    expect(store.retainedBytes).toBeLessThanOrEqual(4096);
  });

  test('uses intrinsic primitive metadata for shadowed binary and collection values', () => {
    const hiddenMetadata = new ArrayBuffer(2 * 1024 * 1024);
    const binary = new ArrayBuffer(8);
    const typedArray = new Uint8Array(16);
    const dataView = new DataView(new ArrayBuffer(24));
    const map = new Map([['value', 1]]);
    const set = new Set(['value']);
    Object.defineProperty(binary, 'byteLength', { value: hiddenMetadata });
    Object.defineProperty(typedArray, 'byteLength', { value: hiddenMetadata });
    Object.defineProperty(dataView, 'byteLength', { value: hiddenMetadata });
    Object.defineProperty(map, 'size', { value: hiddenMetadata });
    Object.defineProperty(set, 'size', { value: hiddenMetadata });

    const byteBudget = 4096;
    const store = new RetrievalTraceStore({ byteBudget });
    const run = store.begin({
      agentName: TEST_AGENT,
      model: TEST_RETRIEVAL_MODEL,
      providerParams: { binary, typedArray, dataView, map, set },
      minConfidence: 0.3,
      maxCandidates: 20,
      maxInjectedLessons: 5,
    });
    run.finish('no-concepts');

    const traces = store.list({ includeInputs: true });
    const [trace] = traces;
    expect(trace.truncation).toBeUndefined();
    expect(trace.config.providerParams).toMatchObject({
      binary: { type: 'array-buffer', byteLength: 8, unavailable: true },
      typedArray: { type: 'array-buffer-view', byteLength: 16, unavailable: true },
      dataView: { type: 'array-buffer-view', byteLength: 24, unavailable: true },
      map: { type: 'map', size: 1, unavailable: true },
      set: { type: 'set', size: 1, unavailable: true },
    });
    expect(trace.config.providerParamsTruncation?.reasons).toEqual(['non-json-value']);
    expect(store.retainedBytes).toBeLessThanOrEqual(byteBudget);
    expect(new TextEncoder().encode(JSON.stringify(traces)).byteLength)
      .toBeLessThanOrEqual(byteBudget);
  });

  test('bounds oversized BigInt decimal output with truthful string-limit reasons', () => {
    const byteBudget = 32 * 1024;
    const store = new RetrievalTraceStore({ byteBudget });
    const run = store.begin({
      agentName: TEST_AGENT,
      model: TEST_RETRIEVAL_MODEL,
      providerParams: { hugeInteger: 1n << 600_000n },
      minConfidence: 0.3,
      maxCandidates: 20,
      maxInjectedLessons: 5,
    });
    run.finish('no-concepts');

    const traces = store.list({ includeInputs: true });
    const [trace] = traces;
    const marker = trace.config.providerParams?.hugeInteger as {
      type: string;
      value: string;
      unavailable: boolean;
    };
    expect(trace.truncation).toBeUndefined();
    expect(marker.type).toBe('bigint');
    expect(marker.unavailable).toBe(true);
    expect(marker.value.endsWith('...[truncated]')).toBe(true);
    expect(new TextEncoder().encode(marker.value).byteLength).toBeLessThanOrEqual(16 * 1024);
    expect(trace.config.providerParamsTruncation?.reasons).toContain('max-string-bytes');
    expect(trace.config.providerParamsTruncation?.reasons).toContain('max-total-string-bytes');
    expect(store.retainedBytes).toBeLessThanOrEqual(byteBudget);
    expect(new TextEncoder().encode(JSON.stringify(traces)).byteLength)
      .toBeLessThanOrEqual(byteBudget);
  });

  test('bounds non-string Error.message values before retention', () => {
    const hiddenMessage = new ArrayBuffer(2 * 1024 * 1024);
    const error = new Error('ordinary');
    Object.defineProperty(error, 'message', { value: hiddenMessage });
    const byteBudget = 1024;
    const store = new RetrievalTraceStore({ byteBudget });
    const run = store.begin({
      agentName: TEST_AGENT,
      model: TEST_RETRIEVAL_MODEL,
      minConfidence: 0.3,
      maxCandidates: 20,
      maxInjectedLessons: 5,
    });
    run.finish('error', error);

    const traces = store.list({ includeInputs: true });
    const [trace] = traces;
    expect(trace.truncation).toBeUndefined();
    expect(trace.error).toBe('[object ArrayBuffer]');
    expect(store.retainedBytes).toBeLessThanOrEqual(byteBudget);
    expect(new TextEncoder().encode(JSON.stringify(traces)).byteLength)
      .toBeLessThanOrEqual(byteBudget);
  });

  test('retains enumerable __proto__ input as an accounted own data property', () => {
    const providerParams: Record<string, unknown> = {};
    Object.defineProperty(providerParams, '__proto__', {
      value: 1n << 600_000n,
      enumerable: true,
    });
    const byteBudget = 1024;
    const store = new RetrievalTraceStore({ byteBudget });
    const run = store.begin({
      agentName: TEST_AGENT,
      model: TEST_RETRIEVAL_MODEL,
      providerParams,
      minConfidence: 0.3,
      maxCandidates: 20,
      maxInjectedLessons: 5,
    });
    run.finish('no-concepts');

    const traces = store.list({ includeInputs: true });
    const [trace] = traces;
    expect(trace.truncation).toMatchObject({
      kind: 'tombstone',
      reason: 'trace-exceeded-byte-budget',
      byteBudget,
    });
    expect(store.retainedBytes).toBeLessThanOrEqual(byteBudget);
    expect(new TextEncoder().encode(JSON.stringify(traces)).byteLength)
      .toBeLessThanOrEqual(byteBudget);
  });

  test('uses intrinsic bounded Date output and fails safe for invalid dates', () => {
    let customCalled = false;
    const validDate = new Date('2026-07-31T12:34:56.789Z');
    Object.defineProperty(validDate, 'toISOString', {
      value: () => {
        customCalled = true;
        return 'x'.repeat(2 * 1024 * 1024);
      },
    });
    const invalidDate = new Date(Number.NaN);
    Object.defineProperty(invalidDate, 'toISOString', {
      value: () => new ArrayBuffer(2 * 1024 * 1024),
    });

    const byteBudget = 4096;
    const store = new RetrievalTraceStore({ byteBudget });
    const run = store.begin({
      agentName: TEST_AGENT,
      model: TEST_RETRIEVAL_MODEL,
      providerParams: { validDate, invalidDate },
      minConfidence: 0.3,
      maxCandidates: 20,
      maxInjectedLessons: 5,
    });
    run.finish('no-concepts');

    const traces = store.list({ includeInputs: true });
    const [trace] = traces;
    expect(customCalled).toBe(false);
    expect(trace.truncation).toBeUndefined();
    expect(trace.config.providerParams).toMatchObject({
      validDate: '2026-07-31T12:34:56.789Z',
      invalidDate: { type: 'date', unavailable: true },
    });
    expect(store.retainedBytes).toBeLessThanOrEqual(byteBudget);
    expect(new TextEncoder().encode(JSON.stringify(traces)).byteLength)
      .toBeLessThanOrEqual(byteBudget);
  });

  test('provider block snapshots bound breadth and strings with explicit reasons', async () => {
    const opaque = {
      type: 'opaque',
      huge: '🔒'.repeat(50_000),
      items: Array.from({ length: 10_000 }, () => 'x'.repeat(4_000)),
    };
    const membrane = {
      complete: async () => ({
        content: [{ type: 'text', text: '["memory"]' }, opaque],
      }),
    } as unknown as Membrane;
    const mod = new RetrievalModule({ membrane });
    (mod as unknown as { ctx: unknown }).ctx = {
      getModule: () => ({ getLessons: () => [lesson('l1', 'memory detail')] }),
      queryMessages: () => ({
        messages: [{ participant: 'user', content: [{ type: 'text', text: 'memory' }] }],
        totalCount: 1,
      }),
    };

    expect(await mod.gatherContext(TEST_AGENT)).toHaveLength(1);
    const stage = mod.getRetrievalTraces({ includeInputs: true })[0].conceptExtraction;
    expect(stage?.responseContentTruncation?.truncated).toBe(true);
    expect(stage?.responseContentTruncation?.reasons).toContain('max-array-items');
    expect(stage?.responseContentTruncation?.reasons).toContain('max-string-bytes');
    expect(stage?.responseContentTruncation?.reasons).toContain('max-total-string-bytes');
    expect(new TextEncoder().encode(JSON.stringify(stage?.responseContent)).byteLength)
      .toBeLessThan(256 * 1024);
  });

  test('in-flight retrieval is visible before the provider returns', async () => {
    let release!: (value: unknown) => void;
    const membrane = {
      complete: () => new Promise(resolve => { release = resolve; }),
    } as unknown as Membrane;
    const mod = new RetrievalModule({ membrane });
    (mod as unknown as { ctx: unknown }).ctx = {
      getModule: (name: string) => name === 'lessons' ? { getLessons: () => [lesson('l1', 'memory detail')] } : null,
      queryMessages: () => ({
        messages: [{ participant: 'user', content: [{ type: 'text', text: 'memory' }] }],
        totalCount: 1,
      }),
    };

    const pending = mod.gatherContext(TEST_AGENT);
    await new Promise(resolve => setTimeout(resolve, 0));
    const [running] = mod.getRetrievalTraces({ includeInputs: true });
    expect(running.outcome).toBeUndefined();
    expect(running.completedAt).toBeUndefined();
    expect(running.conceptExtraction?.input).toContain('memory');

    release({ content: [{ type: 'text', text: '["memory"]' }] });
    expect(await pending).toHaveLength(1);
    expect(mod.getRetrievalTraces()[0].outcome).toBe('injected');
  });

  test('cache links are marked evicted rather than left dangling', async () => {
    const h = harness(['["memory"]'], [lesson('l1', 'memory detail')]);
    const mod = new RetrievalModule({ membrane: h.membrane });
    h.installContext(mod);

    await mod.gatherContext(TEST_AGENT);
    for (let i = 0; i < 105; i++) await mod.gatherContext(TEST_AGENT);

    const traces = mod.getRetrievalTraces({ limit: 100 });
    expect(traces).toHaveLength(100);
    expect(traces.every(trace => trace.outcome === 'cache-hit')).toBe(true);
    expect(traces.every(trace => trace.cache.sourceTraceId === undefined)).toBe(true);
    expect(traces.every(trace => trace.cache.sourceTraceEvicted === true)).toBe(true);
  });

  test('preserves the numeric capacity constructor contract', () => {
    const store = new RetrievalTraceStore(2);
    for (let i = 0; i < 3; i++) {
      const run = store.begin({
        agentName: TEST_AGENT,
        model: TEST_RETRIEVAL_MODEL,
        minConfidence: 0.3,
        maxCandidates: 20,
        maxInjectedLessons: 5,
      });
      run.finish('not-started');
    }
    expect(store.list({ limit: 100 }).map(trace => trace.id)).toEqual([3, 2]);
  });

  test('retains only the newest 100 runs', async () => {
    const mod = new RetrievalModule({ membrane: {} as Membrane });
    for (let i = 0; i < 105; i++) await mod.gatherContext(TEST_AGENT);
    const traces = mod.getRetrievalTraces({ limit: 100 });
    expect(traces).toHaveLength(100);
    expect(traces[0].id).toBe(105);
    expect(traces.at(-1)?.id).toBe(6);
    expect(traces.every(trace => trace.outcome === 'not-started')).toBe(true);
  });

  test('evicts oldest traces to stay within the UTF-8 byte budget', () => {
    const byteBudget = 2800;
    const store = new RetrievalTraceStore({ byteBudget });
    for (let i = 0; i < 3; i++) {
      const run = store.begin({
        agentName: TEST_AGENT,
        model: TEST_RETRIEVAL_MODEL,
        minConfidence: 0.3,
        maxCandidates: 20,
        maxInjectedLessons: 5,
      });
      run.setContext(`hash-${i}`, `context-${i}-` + 'x'.repeat(1300), 1, [`m${i}`]);
      run.finish('no-concepts');
    }

    const traces = store.list({ limit: 100, includeInputs: true });
    expect(traces.length).toBeLessThan(3);
    expect(traces[0].id).toBe(3);
    expect(traces[0].truncation).toBeUndefined();
    expect(store.retainedBytes).toBeLessThanOrEqual(byteBudget);
    expect(new TextEncoder().encode(JSON.stringify(traces)).byteLength)
      .toBeLessThanOrEqual(byteBudget);
  });

  test('marks a byte-tombstoned cache source honestly', () => {
    const byteBudget = 4096;
    const store = new RetrievalTraceStore({ byteBudget });
    const source = store.begin({
      agentName: TEST_AGENT,
      model: TEST_RETRIEVAL_MODEL,
      minConfidence: 0.3,
      maxCandidates: 20,
      maxInjectedLessons: 5,
    });
    source.setContext('large-source', 'x'.repeat(20_000), 1, ['message-1']);
    source.finish('injected');

    const cached = store.begin({
      agentName: TEST_AGENT,
      model: TEST_RETRIEVAL_MODEL,
      minConfidence: 0.3,
      maxCandidates: 20,
      maxInjectedLessons: 5,
    });
    cached.recordCacheHit(source.id, ['l1'], [lesson('l1', 'memory detail')], []);
    cached.finish('cache-hit');

    const [cacheTrace, sourceTrace] = store.list({ limit: 2 });
    expect(sourceTrace.truncation?.kind).toBe('tombstone');
    expect(cacheTrace.cache).toEqual({
      hit: true, sourceTraceId: source.id, sourceTraceTruncated: true,
    });
    expect(cacheTrace.injected.lessons[0]).toMatchObject(lesson('l1', 'memory detail'));
    expect(store.retainedBytes).toBeLessThanOrEqual(byteBudget);
  });

  test('replaces one oversized trace with an explicit bounded tombstone', () => {
    const byteBudget = 1200;
    const store = new RetrievalTraceStore({ byteBudget });
    const run = store.begin({
      agentName: TEST_AGENT,
      model: TEST_RETRIEVAL_MODEL,
      minConfidence: 0.3,
      maxCandidates: 20,
      maxInjectedLessons: 5,
    });
    run.setContext('large-context', '🔒'.repeat(20_000), 1, ['message-1']);
    run.finish('no-concepts');

    const traces = store.list({ limit: 100, includeInputs: true });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      outcome: 'no-concepts',
      truncation: {
        truncated: true,
        kind: 'tombstone',
        reason: 'trace-exceeded-byte-budget',
        byteBudget,
      },
    });
    expect(traces[0].context).toBeUndefined();
    expect(store.retainedBytes).toBeLessThanOrEqual(byteBudget);
  });

  test('evicted active runs cannot reintroduce payload beyond the byte budget', () => {
    const byteBudget = 2200;
    const store = new RetrievalTraceStore({ byteBudget });
    const begin = () => store.begin({
      agentName: TEST_AGENT,
      model: TEST_RETRIEVAL_MODEL,
      minConfidence: 0.3,
      maxCandidates: 20,
      maxInjectedLessons: 5,
    });
    const older = begin();
    older.setContext('older', 'x'.repeat(1300), 1, ['older-message']);
    const newer = begin();
    newer.setContext('newer', 'y'.repeat(1300), 1, ['newer-message']);

    expect(store.list({ limit: 100, includeInputs: true }).map(trace => trace.id)).toEqual([2]);
    older.setContext('evicted', 'z'.repeat(100_000), 1, ['evicted-message']);
    older.finish('error', new Error('late active failure'));
    newer.finish('no-concepts');

    expect(store.list({ limit: 100, includeInputs: true }).map(trace => trace.id)).toEqual([2]);
    expect(store.retainedBytes).toBeLessThanOrEqual(byteBudget);
  });
});

describe('RetrievalModule keyed on the turn\'s opening message', () => {
  const AGENT = 'alice';

  function turnHarness(
    responses: Array<string | Error | Promise<string>>,
    opts: { lessons?: Lesson[]; maxMessageTokens?: number; maxInjectedLessons?: number } = {},
  ) {
    const calls: NormalizedRequest[] = [];
    const membrane = {
      complete: async (request: NormalizedRequest) => {
        calls.push(structuredClone(request));
        const next = await responses.shift();
        if (next instanceof Error) throw next;
        if (next === undefined) throw new Error('unexpected retrieval call');
        return { content: [{ type: 'text', text: next }] };
      },
    } as unknown as Membrane;
    const rows: Array<Record<string, unknown>> = [];
    const windows = new Map<string, Array<Record<string, unknown>>>();
    let seq = 0;
    const addTo = (window: Array<Record<string, unknown>>) =>
      (participant: string, content: unknown[], metadata?: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
        const row = { id: `m${++seq}`, participant, content, ...(metadata ? { metadata } : {}), ...extra };
        window.push(row);
        return row;
      };
    const add = addTo(rows);
    const say = (participant: string, text: string, metadata?: Record<string, unknown>) =>
      add(participant, [{ type: 'text', text }], metadata);
    const own = (agent: string) => {
      const window: Array<Record<string, unknown>> = [];
      windows.set(agent, window);
      const addHere = addTo(window);
      return (participant: string, text: string) => addHere(participant, [{ type: 'text', text }]);
    };
    const toolRound = (n: number) => {
      add(AGENT, [{ type: 'tool_use', id: `t${n}`, name: 'look', input: {} }]);
      add('user', [{ type: 'tool_result', toolUseId: `t${n}`, content: 'memory detail found' }]);
    };
    const mod = new RetrievalModule({
      membrane,
      ...(opts.maxMessageTokens !== undefined ? { maxMessageTokens: opts.maxMessageTokens } : {}),
      ...(opts.maxInjectedLessons !== undefined ? { maxInjectedLessons: opts.maxInjectedLessons } : {}),
    });
    const lessons = opts.lessons ?? [lesson('l1', 'memory detail')];
    (mod as unknown as { ctx: unknown }).ctx = {
      getModule: (name: string) => name === 'lessons' ? { getLessons: () => lessons } : null,
      queryMessages: (_filter: unknown, query?: { forAgent?: string }) => {
        const window = (query?.forAgent !== undefined ? windows.get(query.forAgent) : undefined) ?? rows;
        return { messages: [...window], totalCount: window.length };
      },
    };
    const block = (injections: Awaited<ReturnType<RetrievalModule['gatherContext']>>) =>
      (injections[0]?.content[0] as { text: string } | undefined)?.text;
    return { calls, rows, add, say, own, toolRound, mod, block, responses };
  }

  test('a budget restart after tool rounds gets the turn\'s block, with no model calls', async () => {
    const h = turnHarness(['["memory"]']);
    h.say('user', 'What do you remember about the memory detail?');
    const first = await h.mod.gatherContext(AGENT);
    for (let n = 1; n <= 8; n++) h.toolRound(n);
    const restart = await h.mod.gatherContext(AGENT);

    expect(first).toHaveLength(1);
    expect(restart).toEqual(first);
    expect(h.calls).toHaveLength(1);
    expect(h.mod.getRetrievalTraces()[0].outcome).toBe('cache-hit');
  });

  test('the heading quotes the opening message\'s start, on one line', async () => {
    const h = turnHarness(['["memory"]', '["memory"]']);
    h.say('user', 'What do you remember\n\nabout the memory detail?');
    expect(h.block(await h.mod.gatherContext(AGENT)))
      .toStartWith('## Retrieved Knowledge, for the message beginning "What do you remember about the memory detail?"\n');

    h.say('user', `${'memory '.repeat(20)}end`);
    const text = h.block(await h.mod.gatherContext(AGENT))!;
    expect(/beginning "(.*)"\n/.exec(text)![1]).toBe(`${'memory '.repeat(8)}memo…`);
  });

  test('an opening message with no text gets the plain heading', async () => {
    const h = turnHarness(['["memory"]']);
    h.say('user', 'memory detail please');
    h.add('user', [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'AAAA' } }]);
    expect(h.block(await h.mod.gatherContext(AGENT))).toStartWith('## Retrieved Knowledge\n');
  });

  test('a message stored in shards is quoted from its start, and a budget restart keeps its block', async () => {
    const h = turnHarness(['["memory"]']);
    h.add('user', [{ type: 'text', text: 'memory shard zero ' }], undefined, { bodyGroupId: 'g1', shardIndex: 0 });
    h.add('user', [{ type: 'text', text: 'and shard one' }], undefined, { bodyGroupId: 'g1', shardIndex: 1 });
    const first = await h.mod.gatherContext(AGENT);
    expect(h.block(first)).toStartWith('## Retrieved Knowledge, for the message beginning "memory shard zero and shard one"\n');
    h.toolRound(1);
    expect(await h.mod.gatherContext(AGENT)).toEqual(first);
    expect(h.calls).toHaveLength(1);
  });

  const passedOver: Array<[string, (h: ReturnType<typeof turnHarness>) => void]> = [
    ['a clock row', h => h.say('user', 'Clock: 10:50 Europe/Berlin (UTC+02:00)', { system: true, kind: 'clock', clock: { at: 1, onBoundary: true, zone: 'Europe/Berlin' } })],
    ['a framework notice', h => h.say('user', '[turn-interrupted] Your previous turn was stopped', { system: true, kind: 'turn-interrupted' })],
    ['autoContinue\'s [continue]', h => h.say('user', '[continue]', { system: true, kind: 'auto-continue', agentName: AGENT })],
    ['a host notice', h => h.say('user', '[host-notice] The host posted this status notice', { system: true, kind: 'host-notice' })],
    ['a self-wake\'s line', h => h.say('user', '[self-wake] your heartbeat timer (600s) elapsed — now 2026-10-23T19:00:00Z', { source: 'gate:self-wake' })],
    ['a stored injection', h => h.say('system_context:subagent-fleet', '[Fleet Status]\n  scout [spawn] running', { contextInjection: { agent: AGENT, namespace: 'subagent-fleet', contentHash: 'h1', part: 0, parts: 1 } })],
    ['the agent\'s own reply', h => h.say(AGENT, 'Here is what I remember.')],
    ['a tool round', h => h.toolRound(1)],
    ['another agent\'s tool call', h => h.add('bob', [{ type: 'tool_use', id: 'tb', name: 'look', input: {} }])],
    ['a host note under participant system', h => h.say('system', '[subscription-gc] Auto-closed channel zulip:qa: it emitted too much')],
    ['a tune-out\'s report to the subconscious', h => h.say('user', '[Tune-out cancelled: #ops — duration elapsed.]', { system: true, kind: 'tune-out-cancel-report', channelId: 'ops' })],
  ];
  for (const [kind, store] of passedOver) {
    test(`${kind} isn't the opening message: the block stands, and the heading doesn't quote it`, async () => {
      const h = turnHarness(['["memory"]']);
      h.say('user', 'Tell me the memory detail.');
      const first = await h.mod.gatherContext(AGENT);
      store(h);
      const again = await h.mod.gatherContext(AGENT);
      expect(again).toEqual(first);
      expect(h.calls).toHaveLength(1);
      expect(h.block(again)).toStartWith('## Retrieved Knowledge, for the message beginning "Tell me the memory detail."\n');
    });
  }

  const opening: Array<[string, (h: ReturnType<typeof turnHarness>) => void, string]> = [
    ['a new message', h => h.say('user', 'And the memory detail again?'), 'And the memory detail again?'],
    ['a batched wake\'s [Gate: …] line', h => h.say('user', '[Gate: 2 events matched]\n\n- memory in #general', { source: 'gate:debounce' }), '[Gate: 2 events matched] - memory in #general'],
    ['another agent\'s message', h => h.say('bob', 'memory detail from bob'), 'memory detail from bob'],
    ['a subagent\'s result', h => h.say('user', '[Subagent \'scout\' returned]\n\nmemory detail'), '[Subagent \'scout\' returned] memory detail'],
    ['a note the host stores unmarked', h => h.say('user', '[voice] Your reply was interrupted after: "memory"'), '[voice] Your reply was interrupted after: "memory"'],
    ['the session\'s start time', h => h.say('user', 'The local time at the start of this session is 20:00.'), 'The local time at the start of this session is 20:00.'],
    ['a self-restart\'s note', h => h.say('user', 'Back after a restart: the memory detail was saved.'), 'Back after a restart: the memory detail was saved.'],
    ['a script\'s wake', h => h.say('user', 'script: the memory detail is in the vault', { source: 'code-execution-script', scriptId: 's1', tags: ['script:wake'] }), 'script: the memory detail is in the vault'],
    ['a tune-out\'s release of what it held', h => h.say('user', '[Tune-out: #ops cancelled — duration elapsed, 0 wakes]\n\n<tuned-out-backlog channel="#ops" messages=1>\nbob: the memory detail is in ops\n</tuned-out-backlog>', { system: true, kind: 'tune-out-cancel', channelId: 'ops', epochId: 'e1' }), '[Tune-out: #ops cancelled — duration elapsed, 0 wakes] <tune…'],
    ['a tune-out\'s release of every channel but one', h => h.say('user', '[Tune-out: all channels except #ops released — duration elapsed, 0 wakes]\n\nThe memory detail came up in #general.', { system: true, kind: 'tune-out-cancel', scope: 'all-except', channelId: 'ops', epochId: 'e2' }), '[Tune-out: all channels except #ops released — duration elap…'],
  ];
  for (const [kind, store, quoted] of opening) {
    test(`${kind} opens a turn of its own: retrieval runs for it`, async () => {
      const h = turnHarness(['["memory"]', '["memory"]']);
      h.say('user', 'Tell me the memory detail.');
      await h.mod.gatherContext(AGENT);
      store(h);
      const next = await h.mod.gatherContext(AGENT);
      expect(h.calls).toHaveLength(2);
      expect(JSON.stringify(h.calls[1].messages)).toContain(quoted.slice(0, 20));
      expect(h.block(next)).toStartWith(`## Retrieved Knowledge, for the message beginning "${quoted}"\n`);
    });
  }

  test('stored injections are left out of the window the concept step reads', async () => {
    const h = turnHarness(['["memory"]', '["memory"]']);
    h.say('user', 'Tell me the memory detail.');
    h.say('system_context:retrieval', '## Retrieved Knowledge\n- [90%] an earlier lesson', { contextInjection: { agent: AGENT, namespace: 'retrieval', contentHash: 'h1', part: 0, parts: 1 } });
    await h.mod.gatherContext(AGENT);
    const sent = JSON.stringify(h.calls[0].messages);
    expect(sent).toContain('Tell me the memory detail.');
    expect(sent).not.toContain('an earlier lesson');
  });

  test('a turn whose retrieval found nothing keeps that: a budget restart makes no call', async () => {
    const h = turnHarness(['[]']);
    h.say('user', 'Nothing to recall here.');
    expect(await h.mod.gatherContext(AGENT)).toEqual([]);
    h.toolRound(1);
    expect(await h.mod.gatherContext(AGENT)).toEqual([]);
    expect(h.calls).toHaveLength(1);
    expect(h.mod.getRetrievalTraces()[0].outcome).toBe('cache-hit');
  });

  test('a failed retrieval keeps nothing: the turn\'s next start tries again', async () => {
    const h = turnHarness([new Error('provider unavailable'), '["memory"]']);
    h.say('user', 'Tell me the memory detail.');
    expect(await h.mod.gatherContext(AGENT)).toEqual([]);
    expect(await h.mod.gatherContext(AGENT)).toHaveLength(1);
    expect(h.calls).toHaveLength(2);
  });

  test('a window with no one\'s message yet is a key of its own', async () => {
    const h = turnHarness(['["memory"]']);
    h.say(AGENT, 'I am thinking about the memory detail.');
    const first = await h.mod.gatherContext(AGENT);
    h.say('user', 'Clock: 10:50 Europe/Berlin (UTC+02:00)', { system: true, kind: 'clock' });
    h.say(AGENT, 'Still thinking about the memory detail.');
    const again = await h.mod.gatherContext(AGENT);
    expect(first).toHaveLength(1);
    expect(h.block(first)).toStartWith('## Retrieved Knowledge\n');
    expect(again).toEqual(first);
    expect(h.calls).toHaveLength(1);
  });

  test('each agent keeps its own turn\'s block', async () => {
    const h = turnHarness(['["memory"]', '["memory"]']);
    h.say('user', 'Tell me the memory detail.');
    const alice = await h.mod.gatherContext(AGENT);
    h.say(AGENT, 'The memory detail is this.');
    const bob = await h.mod.gatherContext('bob');
    const aliceAgain = await h.mod.gatherContext(AGENT);
    expect(h.calls).toHaveLength(2);
    expect(h.block(bob)).toStartWith('## Retrieved Knowledge, for the message beginning "The memory detail is this."\n');
    expect(aliceAgain).toEqual(alice);
  });

  test('a message whose id is missing or can\'t be read keeps nothing, so each start retrieves', async () => {
    const unreadable: Array<(row: Record<string, unknown>) => void> = [
      row => { Object.defineProperty(row, 'id', { get: () => { throw new Error('unreadable id'); } }); },
      row => { delete row.id; },
    ];
    for (const spoil of unreadable) {
      const h = turnHarness(['["memory"]', '["memory"]']);
      spoil(h.say('user', 'memory please'));
      expect(await h.mod.gatherContext(AGENT)).toHaveLength(1);
      expect(await h.mod.gatherContext(AGENT)).toHaveLength(1);
      expect(h.calls).toHaveLength(2);
    }
  });

  test('past 64 agents, the oldest agent\'s block goes, and it retrieves again', async () => {
    const h = turnHarness(Array.from({ length: 66 }, () => '["memory"]'));
    h.say('user', 'Tell me the memory detail.');
    for (let i = 0; i <= 64; i++) await h.mod.gatherContext(`agent-${i}`);
    expect(h.calls).toHaveLength(65);
    await h.mod.gatherContext('agent-64');
    expect(h.calls).toHaveLength(65);
    await h.mod.gatherContext('agent-0');
    expect(h.calls).toHaveLength(66);
  });

  test('an agent\'s new turn makes its block the newest, so it outlasts older ones', async () => {
    const h = turnHarness(Array.from({ length: 70 }, () => '["memory"]'));
    h.say('user', 'Tell me the memory detail.');
    await h.mod.gatherContext(AGENT);
    for (let i = 0; i < 63; i++) await h.mod.gatherContext(`agent-${i}`);
    h.say('user', 'And the memory detail again?');
    await h.mod.gatherContext(AGENT);
    await h.mod.gatherContext('agent-63');
    expect(h.calls).toHaveLength(66);
    await h.mod.gatherContext(AGENT);
    expect(h.calls).toHaveLength(66);
  });

  test('a turn served from its kept block stays the newest, so it outlasts agents that came after', async () => {
    const h = turnHarness(Array.from({ length: 70 }, () => '["memory"]'));
    h.say('user', 'Tell me the memory detail.');
    await h.mod.gatherContext(AGENT);
    for (let i = 0; i < 63; i++) await h.mod.gatherContext(`agent-${i}`);
    await h.mod.gatherContext(AGENT);
    expect(h.calls).toHaveLength(64);
    await h.mod.gatherContext('agent-63');
    await h.mod.gatherContext(AGENT);
    expect(h.calls).toHaveLength(65);
  });

  test('a subagent\'s key and heading come from its own window, not the primary\'s', async () => {
    const h = turnHarness(['["memory"]']);
    h.say('user', 'Prime, find the memory detail.');
    h.say(AGENT, 'I will send a scout.');
    const scoutSays = h.own('scout');
    scoutSays('user', 'Scout task: look for the memory detail.');
    const first = await h.mod.gatherContext('scout');
    expect(h.block(first)).toStartWith('## Retrieved Knowledge, for the message beginning "Scout task: look for the memory detail."\n');
    const sent = JSON.stringify(h.calls[0]!.messages);
    expect(sent).toContain('Scout task');
    expect(sent).not.toContain('Prime, find');
    h.say('user', 'Prime, and the memory detail?');
    expect(await h.mod.gatherContext('scout')).toEqual(first);
    expect(h.calls).toHaveLength(1);
  });

  test('a concept reply that doesn\'t parse keeps nothing: the turn\'s next start asks again', async () => {
    const h = turnHarness(['I have no concepts to list.', '["memory"]']);
    h.say('user', 'Tell me the memory detail.');
    expect(await h.mod.gatherContext(AGENT)).toEqual([]);
    expect(await h.mod.gatherContext(AGENT)).toHaveLength(1);
    expect(h.calls).toHaveLength(2);
  });

  test('a retrieval that finishes after a newer turn kept its block leaves that block kept', async () => {
    let release!: (text: string) => void;
    const held = new Promise<string>((resolve) => { release = resolve; });
    const h = turnHarness([held, '["memory"]']);
    h.say('user', 'First: the memory detail?');
    const late = h.mod.gatherContext(AGENT);
    h.say('user', 'Second: the memory detail again?');
    const second = await h.mod.gatherContext(AGENT);
    release('["memory"]');
    await late;
    expect(await h.mod.gatherContext(AGENT)).toEqual(second);
    expect(h.calls).toHaveLength(2);
  });

  test('a turn whose concepts match no lesson keeps that: a budget restart makes no call', async () => {
    const h = turnHarness(['["zebra"]']);
    h.say('user', 'Tell me about zebras.');
    expect(await h.mod.gatherContext(AGENT)).toEqual([]);
    expect(await h.mod.gatherContext(AGENT)).toEqual([]);
    expect(h.calls).toHaveLength(1);
  });

  test('a turn whose relevance check keeps no lesson keeps that: a budget restart makes no call', async () => {
    const lessons = [1, 2, 3, 4].map(n => lesson(`l${n}`, `memory detail ${n}`));
    const h = turnHarness(['["memory"]', '[]'], { lessons });
    h.say('user', 'Tell me the memory detail.');
    expect(await h.mod.gatherContext(AGENT)).toEqual([]);
    expect(await h.mod.gatherContext(AGENT)).toEqual([]);
    expect(h.calls).toHaveLength(2);
  });

  test('a message in shards is quoted joined as stored, apart from another message\'s shards', async () => {
    const h = turnHarness(['["memory"]']);
    h.add('user', [{ type: 'text', text: 'an older pasted note ' }], undefined, { bodyGroupId: 'g0', shardIndex: 0 });
    h.add('user', [{ type: 'text', text: 'about vaults' }], undefined, { bodyGroupId: 'g0', shardIndex: 1 });
    h.add(AGENT, [{ type: 'text', text: 'Noted.' }]);
    h.add('user', [{ type: 'text', text: 'the mem' }], undefined, { bodyGroupId: 'g1', shardIndex: 0 });
    h.add('user', [{ type: 'text', text: 'ory detail, pasted' }], undefined, { bodyGroupId: 'g1', shardIndex: 1 });
    expect(h.block(await h.mod.gatherContext(AGENT)))
      .toStartWith('## Retrieved Knowledge, for the message beginning "the memory detail, pasted"\n');
  });

  test('stored injections are left out before the last ten rows are taken', async () => {
    const h = turnHarness(['["memory"]']);
    for (let i = 1; i <= 10; i++) h.say(i % 2 ? 'user' : AGENT, `row ${i} about memory.`);
    h.say('system_context:retrieval', '## Retrieved Knowledge\n- [90%] an earlier lesson', { contextInjection: { agent: AGENT, namespace: 'retrieval', contentHash: 'h1', part: 0, parts: 1 } });
    await h.mod.gatherContext(AGENT);
    const sent = JSON.stringify(h.calls[0]!.messages);
    for (let i = 1; i <= 10; i++) expect(sent).toContain(`row ${i} about memory.`);
    expect(sent).not.toContain('an earlier lesson');
  });

  test('the heading\'s cut keeps a character whole and leaves no space before the ellipsis', async () => {
    const h = turnHarness(['["memory"]', '["memory"]']);
    h.say('user', `${'m'.repeat(59)}😀 and the memory detail`);
    expect(h.block(await h.mod.gatherContext(AGENT)))
      .toStartWith(`## Retrieved Knowledge, for the message beginning "${'m'.repeat(59)}😀…"\n`);
    h.say('user', `${'m'.repeat(59)} and the memory detail`);
    expect(h.block(await h.mod.gatherContext(AGENT)))
      .toStartWith(`## Retrieved Knowledge, for the message beginning "${'m'.repeat(59)}…"\n`);
  });

  test('at a small cap, the block keeps the most relevant lessons that fit and says how many it left out', async () => {
    const lessons = [lesson('l1', 'memory one'), lesson('l2', `memory ${'large '.repeat(200)}`), lesson('l3', 'memory three')];
    const h = turnHarness(['["memory"]'], { lessons, maxMessageTokens: 60 });
    h.say('user', 'Tell me the memory detail.');
    const text = h.block(await h.mod.gatherContext(AGENT))!;
    expect(text.split('\n')).toEqual([
      '## Retrieved Knowledge, for the message beginning "Tell me the memory detail."',
      '- [90%] memory one (tags: memory)',
      '- [90%] memory three (tags: memory)',
      '(1 more relevant lesson left out, to keep this message under its size limit)',
    ]);
    expect(Math.ceil(text.length / 4)).toBeLessThanOrEqual(60);
    expect(h.mod.getRetrievalTraces()[0]!.injected?.lessonIds).toEqual(['l1', 'l3']);
  });

  test('a lesson that fits with the note its count ends up saying is kept, though the note for more wouldn\'t fit', async () => {
    const heading = '## Retrieved Knowledge, for the message beginning "Tell me the memory detail."';
    const note = '(1 more relevant lesson left out, to keep this message under its size limit)';
    const base = [heading, '- [90%] memory one (tags: memory)', note].join('\n').length;
    const content = `memory one${'!'.repeat((4 - (base % 4)) % 4)}`;
    const lessons = [lesson('l1', content), lesson('l2', `memory ${'large '.repeat(200)}`)];
    const expected = [heading, `- [90%] ${content} (tags: memory)`, note].join('\n');
    const h = turnHarness(['["memory"]'], { lessons, maxMessageTokens: expected.length / 4 });
    h.say('user', 'Tell me the memory detail.');
    expect(h.block(await h.mod.gatherContext(AGENT))).toBe(expected);
  });

  test('a later lesson\'s room for the note counts only the lessons not kept, so it\'s kept where the note for more wouldn\'t fit', async () => {
    const heading = '## Retrieved Knowledge, for the message beginning "Tell me the memory detail."';
    const note = '(1 more relevant lesson left out, to keep this message under its size limit)';
    const base = [heading, '- [90%] memory one (tags: memory)', '- [90%] memory three (tags: memory)', note].join('\n').length;
    const three = `memory three${'!'.repeat((4 - (base % 4)) % 4)}`;
    const lessons = [lesson('l1', 'memory one'), lesson('l2', `memory ${'large '.repeat(200)}`), lesson('l3', three)];
    const expected = [heading, '- [90%] memory one (tags: memory)', `- [90%] ${three} (tags: memory)`, note].join('\n');
    const h = turnHarness(['["memory"]'], { lessons, maxMessageTokens: expected.length / 4 });
    h.say('user', 'Tell me the memory detail.');
    expect(h.block(await h.mod.gatherContext(AGENT))).toBe(expected);
  });

  for (const tool of [
    { type: 'tool_use', id: 't9', name: 'look', input: {} },
    { type: 'tool_result', toolUseId: 't9', content: 'found it' },
  ]) {
    test(`a ${tool.type} stored in shards is passed over whole, its text-only shards included`, async () => {
      const h = turnHarness(['["memory"]']);
      h.say('user', 'Tell me the memory detail.');
      h.add('bob', [{ type: 'text', text: 'looking it up, part one' }, tool], undefined, { bodyGroupId: 'g1', shardIndex: 0 });
      h.add('bob', [{ type: 'text', text: 'part two of the same reply' }], undefined, { bodyGroupId: 'g1', shardIndex: 1 });
      expect(h.block(await h.mod.gatherContext(AGENT)))
        .toStartWith('## Retrieved Knowledge, for the message beginning "Tell me the memory detail."\n');
    });
  }

  test('a message of the same text as a tool message stored in shards is a message of its own', async () => {
    const h = turnHarness(['["memory"]']);
    h.add('bob', [{ type: 'text', text: 'the memory detail' }, { type: 'tool_use', id: 't9', name: 'look', input: {} }], undefined, { bodyGroupId: 'g1', shardIndex: 0 });
    h.add('bob', [{ type: 'text', text: ', pasted' }], undefined, { bodyGroupId: 'g1', shardIndex: 1 });
    h.add('carol', [{ type: 'text', text: 'the memory detail' }], undefined, { bodyGroupId: 'g1', shardIndex: 0 });
    h.add('carol', [{ type: 'text', text: ', pasted' }], undefined, { bodyGroupId: 'g1', shardIndex: 1 });
    expect(h.block(await h.mod.gatherContext(AGENT)))
      .toStartWith('## Retrieved Knowledge, for the message beginning "the memory detail, pasted"\n');
  });

  test('a relevance reply that doesn\'t parse keeps nothing when no lesson fits, or none may be injected', async () => {
    const lessons = ['one', 'two', 'three', 'four'].map((n, i) => lesson(`l${i + 1}`, `memory ${n} ${'long '.repeat(40)}`));
    const tight = turnHarness(['["memory"]', 'not a list', '["memory"]', '["l2"]'], { lessons, maxMessageTokens: 20 });
    tight.say('user', 'Tell me the memory detail.');
    expect(await tight.mod.gatherContext(AGENT)).toEqual([]);
    expect(await tight.mod.gatherContext(AGENT)).toEqual([]);
    expect(tight.calls).toHaveLength(4);
    const none = turnHarness(['["memory"]', 'not a list', '["memory"]', '["l2"]'], { lessons, maxInjectedLessons: 0 });
    none.say('user', 'Tell me the memory detail.');
    expect(await none.mod.gatherContext(AGENT)).toEqual([]);
    expect(await none.mod.gatherContext(AGENT)).toEqual([]);
    expect(none.calls).toHaveLength(4);
  });

  test('a relevance reply that doesn\'t parse injects the top candidates, and keeps nothing, so the next start asks again', async () => {
    const lessons = ['one', 'two', 'three', 'four'].map((n, i) => lesson(`l${i + 1}`, `memory ${n}`));
    const h = turnHarness(['["memory"]', 'not a list', '["memory"]', '["l2"]'], { lessons });
    h.say('user', 'Tell me the memory detail.');
    expect(h.block(await h.mod.gatherContext(AGENT))).toContain('memory four');
    const again = h.block(await h.mod.gatherContext(AGENT))!;
    expect(h.calls).toHaveLength(4);
    expect(again).toContain('memory two');
    expect(again).not.toContain('memory four');
  });

  test('a message a tune-out diverted is neither the opening message nor in what the concept step reads', async () => {
    const h = turnHarness(['["memory"]']);
    h.say('user', 'Tell me the memory detail.');
    h.say('user', 'a diverted channel line', { tuneOut: { epochId: 'e1' } });
    expect(h.block(await h.mod.gatherContext(AGENT)))
      .toStartWith('## Retrieved Knowledge, for the message beginning "Tell me the memory detail."\n');
    expect(JSON.stringify(h.calls[0])).not.toContain('a diverted channel line');
  });

  test('a block whose lessons all fit is kept whole, with no room held for a note it doesn\'t need', async () => {
    const lessons = [lesson('l1', 'memory one'), lesson('l2', 'memory two')];
    const whole = '## Retrieved Knowledge, for the message beginning "Tell me the memory detail."\n- [90%] memory one (tags: memory)\n- [90%] memory two (tags: memory)';
    const h = turnHarness(['["memory"]'], { lessons, maxMessageTokens: Math.ceil(whole.length / 4) });
    h.say('user', 'Tell me the memory detail.');
    expect(h.block(await h.mod.gatherContext(AGENT))).toBe(whole);
  });

  test('a cap that isn\'t a positive number is no cap, as the strategy reads it', async () => {
    const lessons = [lesson('l1', `memory ${'large '.repeat(200)}`)];
    const h = turnHarness(['["memory"]'], { lessons, maxMessageTokens: 0 });
    h.say('user', 'Tell me the memory detail.');
    expect(h.block(await h.mod.gatherContext(AGENT))).toContain('large large');
    expect(h.mod.getRetrievalTraces()[0]!.outcome).toBe('injected');
  });

  test('a start the framework\'s timeout left behind doesn\'t replace the block a later start of the same turn kept', async () => {
    let release!: (text: string) => void;
    const held = new Promise<string>((resolve) => { release = resolve; });
    const h = turnHarness([held, '["memory"]']);
    h.say('user', 'Tell me the memory detail.');
    const behind = h.mod.gatherContext(AGENT);
    const later = await h.mod.gatherContext(AGENT);
    expect(h.block(later)).toContain('memory detail');
    release('["zebra"]');
    expect(await behind).toEqual([]);
    expect(await h.mod.gatherContext(AGENT)).toEqual(later);
    expect(h.calls).toHaveLength(2);
  });

  test('an older start that finishes while a later one still runs keeps nothing, and leaves the later one its keep', async () => {
    let releaseOlder!: (text: string) => void;
    let releaseLater!: (text: string) => void;
    const older = new Promise<string>((resolve) => { releaseOlder = resolve; });
    const later = new Promise<string>((resolve) => { releaseLater = resolve; });
    const h = turnHarness([older, later]);
    h.say('user', 'Tell me the memory detail.');
    const first = h.mod.gatherContext(AGENT);
    const second = h.mod.gatherContext(AGENT);
    releaseOlder('["zebra"]');
    expect(await first).toEqual([]);
    releaseLater('["memory"]');
    const kept = await second;
    expect(h.block(kept)).toContain('memory detail');
    expect(await h.mod.gatherContext(AGENT)).toEqual(kept);
    expect(h.calls).toHaveLength(2);
    expect((h.mod as unknown as { latestStarts: Map<string, number> }).latestStarts.size).toBe(0);
  });

  test('when no lesson fits the cap, nothing is injected, and that is kept for the turn', async () => {
    const h = turnHarness(['["memory"]'], { maxMessageTokens: 20 });
    h.say('user', 'Tell me the memory detail.');
    expect(await h.mod.gatherContext(AGENT)).toEqual([]);
    expect(h.mod.getRetrievalTraces()[0]!.outcome).toBe('too-large');
    expect(await h.mod.gatherContext(AGENT)).toEqual([]);
    expect(h.calls).toHaveLength(1);
  });
});
