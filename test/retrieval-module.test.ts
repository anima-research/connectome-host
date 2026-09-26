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

/** Concept stage flags "memory"; relevance stage selects l1. */
function stageAnswer(request: NormalizedRequest): string {
  return request.system?.startsWith('You are a relevance filter') ? '["l1"]' : '["memory"]';
}

function harness(responses: Array<string | Error>, lessons: Lesson[]) {
  const calls: NormalizedRequest[] = [];
  const retrieved: string[][] = [];
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
      getModule: (name: string) => name === 'lessons'
        ? { getLessons: () => lessons, recordRetrieval: (ids: string[]) => { retrieved.push(ids); } }
        : null,
      queryMessages: () => ({
        messages: [{
          participant: 'user',
          content: [{ type: 'text', text: 'Please recall the relevant memory context.' }],
        }],
        totalCount: 1,
      }),
    };
  };

  return { calls, retrieved, membrane, installContext };
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

  test('validates even small candidate sets, and caches non-empty results', async () => {
    const h = harness(['["memory"]', '["l1", "l2"]'], [lesson('l1', 'memory alpha'), lesson('l2', 'memory beta')]);
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
    expect(h.calls).toHaveLength(2);
    for (const request of h.calls) {
      expect(request.providerParams).toEqual({ reasoning: { effort: 'xhigh' } });
    }
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
      getModule: () => ({ getLessons: () => [lesson('l1', 'memory detail')], recordRetrieval: () => {} }),
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
    const h = harness(['["memory"]', '["complete-lesson"]'], [source]);
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
    const h = harness(['["memory"]', '["l1"]'], [source]);
    const mod = new RetrievalModule({ membrane: h.membrane });
    h.installContext(mod);

    await mod.gatherContext(TEST_AGENT);
    for (let i = 0; i < 105; i++) await mod.gatherContext(TEST_AGENT);

    const cached = mod.getRetrievalTraces({ limit: 100 })[0];
    expect(cached.outcome).toBe('cache-hit');
    expect(cached.cache).toEqual({ hit: true, sourceTraceEvicted: true });
    expect(cached.injected.lessons[0]).toEqual(expected);
  });

  test('an unparseable relevance judgment injects nothing', async () => {
    const lessons = [1, 2, 3, 4].map(n => lesson(`l${n}`, `memory ${n}`));
    const h = harness(['["memory"]', 'not valid json'], lessons);
    const mod = new RetrievalModule({ membrane: h.membrane });
    h.installContext(mod);

    expect(await mod.gatherContext(TEST_AGENT)).toEqual([]);
    const [trace] = mod.getRetrievalTraces();
    expect(trace.outcome).toBe('no-relevant-lessons');
    expect(trace.relevance).toMatchObject({
      ran: true,
      rawOutput: 'not valid json',
      parsedValues: [],
      parseMode: 'invalid',
    });
    expect(trace.relevantLessonIds).toEqual([]);
  });

  test('a prose-wrapped relevance judgment is extracted', async () => {
    const lessons = [1, 2, 3, 4].map(n => lesson(`l${n}`, `memory ${n}`));
    const h = harness(['["memory"]', 'Relevant:\n```json\n["l2"]\n```'], lessons);
    const mod = new RetrievalModule({ membrane: h.membrane });
    h.installContext(mod);

    const [injection] = await mod.gatherContext(TEST_AGENT);
    expect((injection.content[0] as { type: 'text'; text: string }).text).toContain('memory 2');
    expect(mod.getRetrievalTraces()[0].relevance).toMatchObject({
      parsedValues: ['l2'],
      parseMode: 'array-extraction',
    });
  });

  test('trace-only message IDs cannot make retrieval fail', async () => {
    const h = harness(['["memory"]', '["l1"]'], [lesson('l1', 'memory detail')]);
    const mod = new RetrievalModule({ membrane: h.membrane });
    const message = {
      participant: 'user',
      content: [{ type: 'text', text: 'memory please' }],
    } as Record<string, unknown>;
    Object.defineProperty(message, 'id', { get: () => { throw new Error('trace-only id getter'); } });
    (mod as unknown as { ctx: unknown }).ctx = {
      getModule: (name: string) => name === 'lessons' ? { getLessons: () => [lesson('l1', 'memory detail')], recordRetrieval: () => {} } : null,
      queryMessages: () => ({ messages: [message], totalCount: 1 }),
    };

    const injections = await mod.gatherContext(TEST_AGENT);
    expect(injections).toHaveLength(1);
    expect(mod.getRetrievalTraces({ includeInputs: true })[0].context?.messageIds).toEqual([]);
  });

  test('malformed mixed wrapper keeps only the string concepts', async () => {
    const h = harness(['prose ["memory", 3]', '["l1"]'], [lesson('l1', 'memory detail')]);
    const mod = new RetrievalModule({ membrane: h.membrane });
    h.installContext(mod);

    expect(await mod.gatherContext(TEST_AGENT)).toHaveLength(1);
    const [trace] = mod.getRetrievalTraces();
    expect(trace.outcome).toBe('injected');
    expect(trace.conceptExtraction).toMatchObject({
      parseMode: 'array-extraction',
      parsedValues: ['memory'],
    });
  });

  test('candidate provenance records whole-word term hits only', async () => {
    const h = harness(['["   ", "memory tools"]', '["l1"]'], [lesson('l1', 'unrelated memoryless memory detail')]);
    const mod = new RetrievalModule({ membrane: h.membrane });
    h.installContext(mod);

    expect(await mod.gatherContext(TEST_AGENT)).toHaveLength(1);
    const [trace] = mod.getRetrievalTraces();
    expect(trace.candidateSelection).toEqual({ mode: 'full-library', eligible: 1 });
    expect(trace.candidates[0].matches).toEqual([
      { concept: 'memory tools', keyword: 'memory', field: 'content' },
      { concept: 'memory tools', keyword: 'memory', field: 'tag', tag: 'memory' },
    ]);
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
      complete: async (request: NormalizedRequest) => ({
        content: [{ type: 'text', text: stageAnswer(request) }, opaque],
      }),
    } as unknown as Membrane;
    const mod = new RetrievalModule({ membrane });
    (mod as unknown as { ctx: unknown }).ctx = {
      getModule: (name: string) => name === 'lessons' ? { getLessons: () => [lesson('l1', 'memory detail')], recordRetrieval: () => {} } : null,
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
      complete: async (request: NormalizedRequest) => ({
        content: [{ type: 'text', text: stageAnswer(request) }, opaque],
      }),
    } as unknown as Membrane;
    const mod = new RetrievalModule({ membrane });
    (mod as unknown as { ctx: unknown }).ctx = {
      getModule: () => ({ getLessons: () => [lesson('l1', 'memory detail')], recordRetrieval: () => {} }),
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
      getModule: (name: string) => name === 'lessons' ? { getLessons: () => [lesson('l1', 'memory detail')], recordRetrieval: () => {} } : null,
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
    await new Promise(resolve => setTimeout(resolve, 0));
    release({ content: [{ type: 'text', text: '["l1"]' }] });
    expect(await pending).toHaveLength(1);
    expect(mod.getRetrievalTraces()[0].outcome).toBe('injected');
  });

  test('cache links are marked evicted rather than left dangling', async () => {
    const h = harness(['["memory"]', '["l1"]'], [lesson('l1', 'memory detail')]);
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

describe('RetrievalModule usage feedback', () => {
  test('reports fresh injections to the lessons module, but not cache hits', async () => {
    const h = harness(['["memory"]', '["l1", "l2"]'], [lesson('l1', 'memory alpha'), lesson('l2', 'memory beta')]);
    const mod = new RetrievalModule({ membrane: h.membrane, retrievalModel: TEST_RETRIEVAL_MODEL });
    h.installContext(mod);

    await mod.gatherContext(TEST_AGENT);
    await mod.gatherContext(TEST_AGENT);

    expect(h.retrieved).toEqual([['l1', 'l2']]);
  });

  test('ranks equally confident candidates by recent use', async () => {
    const now = Date.now();
    const stale = { ...lesson('stale', 'memory stale'), created: now - 365 * 86_400_000 };
    const used = {
      ...lesson('used', 'memory used'),
      created: now - 365 * 86_400_000,
      lastRetrieved: now,
      retrievalCount: 4,
    };
    const h = harness(['["memory"]', '["stale", "used"]'], [stale, used]);
    const mod = new RetrievalModule({ membrane: h.membrane, retrievalModel: TEST_RETRIEVAL_MODEL });
    h.installContext(mod);

    const [injection] = await mod.gatherContext(TEST_AGENT);
    const text = (injection.content[0] as { type: 'text'; text: string }).text;

    expect(text.indexOf('memory used')).toBeLessThan(text.indexOf('memory stale'));
    expect(h.retrieved).toEqual([['used', 'stale']]);
  });
});

describe('RetrievalModule candidate selection', () => {
  test('shows the relevance model the whole library, including lessons sharing no words with the concepts', async () => {
    const lessons = [
      lesson('l1', 'Alice owns the billing pipeline'),
      lesson('l2', 'Deploys are frozen on Fridays'),
    ];
    const h = harness(['["who is responsible for invoices"]', '["l1"]'], lessons);
    const mod = new RetrievalModule({ membrane: h.membrane });
    h.installContext(mod);

    const [injection] = await mod.gatherContext(TEST_AGENT);

    expect(h.calls[1].messages[0].content[0]).toMatchObject({ text: expect.stringContaining('[l2]') });
    expect((injection.content[0] as { type: 'text'; text: string }).text).toContain('billing pipeline');
    expect(mod.getRetrievalTraces()[0].candidateSelection).toEqual({ mode: 'full-library', eligible: 2 });
  });

  test('shortlists a library larger than maxCandidates by BM25', async () => {
    const lessons = [
      lesson('auth', 'OAuth tokens expire after one hour'),
      lesson('deploy', 'Deploys are frozen on Fridays'),
      lesson('billing', 'Alice owns the billing pipeline'),
      lesson('auth2', 'Refresh OAuth tokens before batch jobs'),
    ];
    const h = harness(['["oauth token expiry"]', '["auth"]'], lessons);
    const mod = new RetrievalModule({ membrane: h.membrane, maxCandidates: 2 });
    h.installContext(mod);

    await mod.gatherContext(TEST_AGENT);

    const [trace] = mod.getRetrievalTraces();
    expect(trace.candidateSelection).toEqual({ mode: 'bm25', eligible: 4 });
    expect(trace.candidates.map(c => c.id).sort()).toEqual(['auth', 'auth2']);
    expect(trace.config.maxCandidates).toBe(2);
  });
});
