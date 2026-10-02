import type { ContextInjection } from '@animalabs/context-manager';
import type { Lesson } from './lessons-module.js';

export const RETRIEVAL_TRACE_SCHEMA_VERSION = 2;
export const DEFAULT_RETRIEVAL_TRACE_CAPACITY = 100;
export const DEFAULT_RETRIEVAL_TRACE_BYTE_BUDGET = 8 * 1024 * 1024;

const MIN_RETRIEVAL_TRACE_BYTE_BUDGET = 1024;
const MAX_ERROR_BYTES = 16 * 1024;

export type RetrievalTraceOutcome =
  | 'not-started'
  | 'no-lessons-module'
  | 'no-eligible-lessons'
  | 'no-recent-context'
  | 'cache-hit'
  | 'no-relevant-lessons'
  | 'injected'
  | 'error';

export interface RetrievalLessonTrace {
  id: string;
  content: string;
  confidence: number;
  tags: string[];
  evidence: string[];
  created: number;
  updated: number;
  deprecated: boolean;
  deprecationReason?: string;
}

/** A search result as the pipeline sees it, before tracing. */
export interface RetrievalCandidateScores {
  lesson: Lesson;
  /** Reciprocal-rank-fusion score over all lexical and dense lists. */
  fusedScore: number;
  /** Best 1-based rank in any BM25 list; absent if no query shared a word with it. */
  lexicalRank?: number;
  /** Best 1-based rank in any dense list. */
  denseRank?: number;
}

export interface RetrievalCandidateTrace extends RetrievalLessonTrace {
  fusedScore: number;
  lexicalRank?: number;
  denseRank?: number;
  /** Reranker relevance in [0, 1], compared against config.relevanceThreshold. */
  rerankScore: number;
}

export interface RetrievalTrace {
  schemaVersion: 2;
  id: number;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  agentName: string;
  config: {
    embeddingModel: string;
    rerankerModel: string;
    minConfidence: number;
    maxCandidates: number;
    maxInjectedLessons: number;
    relevanceThreshold: number;
  };
  context?: {
    hash: string;
    messageCount: number;
    messageIds: string[];
    /** Rendered recent conversation. Omitted from default HTTP views. */
    input?: string;
  };
  cache: {
    hit: boolean;
    sourceTraceId?: number;
    sourceTraceEvicted?: boolean;
    sourceTraceTruncated?: boolean;
  };
  /** Search queries derived from recent context. Omitted from default HTTP views. */
  queries?: string[];
  /** Conversation tail the reranker judged against. Omitted from default HTTP views. */
  rerankQuery?: string;
  /** Reranked candidates, in fused-search order. */
  candidates: RetrievalCandidateTrace[];
  relevantLessonIds: string[];
  injected: {
    lessonIds: string[];
    lessons: RetrievalLessonTrace[];
    namespace?: string;
    position?: ContextInjection['position'];
    block?: string;
  };
  outcome?: RetrievalTraceOutcome;
  error?: string;
  truncation?: {
    truncated: true;
    kind: 'tombstone';
    reason: 'trace-exceeded-byte-budget';
    originalBytes: number;
    byteBudget: number;
  };
}

export interface RetrievalTraceListOptions {
  limit?: number;
  includeInputs?: boolean;
}

/** Structural interface used by WebUiModule to avoid importing RetrievalModule. */
export interface RetrievalTraceSource {
  getRetrievalTraces(options?: RetrievalTraceListOptions): RetrievalTrace[];
}

export interface RetrievalTraceBeginOptions {
  agentName: string;
  embeddingModel: string;
  rerankerModel: string;
  minConfidence: number;
  maxCandidates: number;
  maxInjectedLessons: number;
  relevanceThreshold: number;
}

export interface RetrievalTraceStoreOptions {
  capacity?: number;
  byteBudget?: number;
}

function errorMessage(error: unknown): string {
  try {
    const value = error instanceof Error ? error.message : error;
    return truncateUtf8(
      typeof value === 'string' ? value : String(value),
      MAX_ERROR_BYTES,
    );
  } catch {
    return 'unavailable error';
  }
}

const textEncoder = new TextEncoder();
function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(value) <= maxBytes) return value;
  const suffix = '...[truncated]';
  const suffixBytes = utf8Bytes(suffix);
  if (suffixBytes >= maxBytes) return suffix.slice(0, maxBytes);

  let low = 0;
  let high = value.length;
  const contentBudget = maxBytes - suffixBytes;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, mid)) <= contentBudget) low = mid;
    else high = mid - 1;
  }
  if (low > 0) {
    const code = value.charCodeAt(low - 1);
    if (code >= 0xd800 && code <= 0xdbff) low--;
  }
  return value.slice(0, low) + suffix;
}

function lessonSnapshot(lesson: Lesson): RetrievalLessonTrace {
  return {
    id: lesson.id,
    content: lesson.content,
    confidence: lesson.confidence,
    tags: [...lesson.tags],
    evidence: [...lesson.evidence],
    created: lesson.created,
    updated: lesson.updated,
    deprecated: lesson.deprecated,
    ...(lesson.deprecationReason !== undefined
      ? { deprecationReason: lesson.deprecationReason }
      : {}),
  };
}

/**
 * Mutable handle for one retrieval run. Every mutation is guarded so tracing
 * can never make retrieval fail; a malformed trace is less important than the
 * inference it observes.
 */
export class RetrievalTraceRun {
  private finished = false;

  constructor(
    private readonly store: RetrievalTraceStore,
    private readonly trace: RetrievalTrace,
  ) {}

  get id(): number {
    return this.trace.id;
  }

  private update(fn: (trace: RetrievalTrace) => void): void {
    if (this.finished) return;
    try {
      this.store.update(this.trace, fn);
    } catch {
      // Observability is strictly fail-open.
    }
  }

  setContext(hash: string, input: string, messageCount: number, messageIds: string[]): void {
    this.update(trace => {
      trace.context = { hash, input, messageCount, messageIds: [...messageIds] };
    });
  }

  recordCacheHit(
    sourceTraceId: number | undefined,
    lessonIds: string[],
    lessons: Lesson[],
    injections: ContextInjection[],
  ): void {
    this.update(trace => {
      trace.cache = { hit: true };
      if (sourceTraceId !== undefined) {
        const sourceStatus = this.store.sourceStatus(sourceTraceId);
        if (sourceStatus === 'exact') trace.cache.sourceTraceId = sourceTraceId;
        else if (sourceStatus === 'truncated') {
          trace.cache.sourceTraceId = sourceTraceId;
          trace.cache.sourceTraceTruncated = true;
        } else trace.cache.sourceTraceEvicted = true;
      }
      trace.injected.lessonIds = [...lessonIds];
      trace.injected.lessons = lessons.map(lessonSnapshot);
      recordInjectionShape(trace, injections);
    });
  }

  recordQueries(queries: string[], rerankQuery: string): void {
    this.update(trace => {
      trace.queries = [...queries];
      trace.rerankQuery = rerankQuery;
    });
  }

  recordCandidates(candidates: Array<RetrievalCandidateScores & { rerankScore: number }>): void {
    this.update(trace => {
      trace.candidates = candidates.map(c => ({
        ...lessonSnapshot(c.lesson),
        fusedScore: c.fusedScore,
        ...(c.lexicalRank !== undefined ? { lexicalRank: c.lexicalRank } : {}),
        ...(c.denseRank !== undefined ? { denseRank: c.denseRank } : {}),
        rerankScore: c.rerankScore,
      }));
    });
  }

  recordRelevant(lessons: Lesson[]): void {
    this.update(trace => {
      trace.relevantLessonIds = lessons.map(lesson => lesson.id);
    });
  }

  recordInjection(lessons: Lesson[], injections: ContextInjection[]): void {
    this.update(trace => {
      trace.injected = {
        lessonIds: lessons.map(lesson => lesson.id),
        lessons: lessons.map(lessonSnapshot),
      };
      recordInjectionShape(trace, injections);
    });
  }

  finish(outcome: RetrievalTraceOutcome, error?: unknown): void {
    if (this.finished) return;
    this.finished = true;
    try {
      this.store.finish(this.trace, outcome, error);
    } catch {
      // Observability is strictly fail-open.
    }
  }
}

export class RetrievalTraceStore {
  private readonly traces: RetrievalTrace[] = [];
  private readonly sizes = new Map<RetrievalTrace, number>();
  private readonly capacity: number;
  private readonly byteBudget: number;
  private payloadBytes = 0;
  private nextId = 1;

  constructor(options: RetrievalTraceStoreOptions | number = {}) {
    const normalized = typeof options === 'number' ? { capacity: options } : options;
    const requestedCapacity = normalized.capacity ?? DEFAULT_RETRIEVAL_TRACE_CAPACITY;
    const requestedByteBudget = normalized.byteBudget ?? DEFAULT_RETRIEVAL_TRACE_BYTE_BUDGET;
    this.capacity = Number.isFinite(requestedCapacity)
      ? Math.max(1, Math.min(DEFAULT_RETRIEVAL_TRACE_CAPACITY, Math.trunc(requestedCapacity)))
      : DEFAULT_RETRIEVAL_TRACE_CAPACITY;
    if (!Number.isFinite(requestedByteBudget)
        || requestedByteBudget < MIN_RETRIEVAL_TRACE_BYTE_BUDGET) {
      throw new RangeError(
        `Retrieval trace byteBudget must be at least ${MIN_RETRIEVAL_TRACE_BYTE_BUDGET}.`,
      );
    }
    this.byteBudget = Math.trunc(requestedByteBudget);
  }

  begin(options: RetrievalTraceBeginOptions): RetrievalTraceRun {
    const trace: RetrievalTrace = {
      schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
      id: this.nextId++,
      startedAt: new Date().toISOString(),
      agentName: options.agentName,
      config: {
        embeddingModel: options.embeddingModel,
        rerankerModel: options.rerankerModel,
        minConfidence: options.minConfidence,
        maxCandidates: options.maxCandidates,
        maxInjectedLessons: options.maxInjectedLessons,
        relevanceThreshold: options.relevanceThreshold,
      },
      cache: { hit: false },
      candidates: [],
      relevantLessonIds: [],
      injected: { lessonIds: [], lessons: [] },
    };
    this.commit(trace);
    return new RetrievalTraceRun(this, trace);
  }

  has(id: number): boolean {
    return this.traces.some(trace => trace.id === id);
  }

  sourceStatus(id: number): 'exact' | 'truncated' | 'evicted' {
    const source = this.traces.find(trace => trace.id === id);
    if (!source) return 'evicted';
    return source.truncation ? 'truncated' : 'exact';
  }

  get retainedBytes(): number {
    return this.totalEncodedBytes();
  }

  update(trace: RetrievalTrace, fn: (trace: RetrievalTrace) => void): void {
    if (!this.sizes.has(trace) || trace.truncation) return;
    try {
      fn(trace);
    } finally {
      this.enforceBounds(trace);
    }
  }

  finish(trace: RetrievalTrace, outcome: RetrievalTraceOutcome, error?: unknown): void {
    if (!this.sizes.has(trace)) return;
    try {
      trace.outcome = outcome;
      if (error !== undefined && !trace.truncation) trace.error = errorMessage(error);
      trace.completedAt = new Date().toISOString();
      trace.durationMs = Math.max(0, Date.now() - Date.parse(trace.startedAt));
    } finally {
      this.enforceBounds(trace);
    }
  }

  private commit(trace: RetrievalTrace): void {
    this.traces.push(trace);
    const size = encodedTraceBytes(trace);
    this.sizes.set(trace, size);
    this.payloadBytes += size;
    this.enforceBounds(trace);
  }

  private enforceBounds(mutatedTrace?: RetrievalTrace): void {
    if (mutatedTrace && this.sizes.has(mutatedTrace)) {
      this.refreshSize(mutatedTrace);
    }
    for (const retained of [...this.traces]) {
      const size = this.sizes.get(retained) ?? Number.POSITIVE_INFINITY;
      if (size > this.byteBudget && !retained.truncation) {
        this.replaceWithTombstone(retained, size);
      }
    }

    while (this.traces.length > this.capacity || this.totalEncodedBytes() > this.byteBudget) {
      const evicted = new Set<number>();
      do {
        const oldest = this.traces.shift();
        if (!oldest) break;
        const evictedId = oldest.id;
        evicted.add(evictedId);
        const size = this.sizes.get(oldest) ?? 0;
        this.sizes.delete(oldest);
        if (Number.isFinite(size)) this.payloadBytes -= size;
        else this.recalculatePayloadBytes();
        // A still-running RetrievalTraceRun may retain this object. Strip its
        // payload as part of eviction so concurrent active runs cannot bypass
        // the store's memory bound; the ID remains available for provenance.
        for (const key of Object.keys(oldest)) Reflect.deleteProperty(oldest, key);
        Object.assign(oldest, { id: evictedId });
      } while (this.traces.length > this.capacity || this.totalEncodedBytes() > this.byteBudget);
      if (evicted.size === 0) break;
      this.rewriteEvictedProvenance(evicted);
    }
  }

  private replaceWithTombstone(trace: RetrievalTrace, originalBytes: number): void {
    const sourceId = trace.id;
    const tombstone: RetrievalTrace = {
      schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
      id: trace.id,
      startedAt: trace.startedAt,
      ...(trace.completedAt ? { completedAt: trace.completedAt } : {}),
      ...(trace.durationMs !== undefined ? { durationMs: trace.durationMs } : {}),
      agentName: truncateUtf8(trace.agentName, 128),
      config: {
        embeddingModel: truncateUtf8(trace.config.embeddingModel, 256),
        rerankerModel: truncateUtf8(trace.config.rerankerModel, 256),
        minConfidence: trace.config.minConfidence,
        maxCandidates: trace.config.maxCandidates,
        maxInjectedLessons: trace.config.maxInjectedLessons,
        relevanceThreshold: trace.config.relevanceThreshold,
      },
      cache: { hit: trace.cache.hit },
      candidates: [],
      relevantLessonIds: [],
      injected: { lessonIds: [], lessons: [] },
      ...(trace.outcome ? { outcome: trace.outcome } : {}),
      truncation: {
        truncated: true,
        kind: 'tombstone',
        reason: 'trace-exceeded-byte-budget',
        originalBytes,
        byteBudget: this.byteBudget,
      },
    };
    for (const key of Object.keys(trace)) Reflect.deleteProperty(trace, key);
    Object.assign(trace, tombstone);
    this.refreshSize(trace);

    for (const retained of this.traces) {
      if (retained === trace || retained.cache.sourceTraceId !== sourceId) continue;
      retained.cache.sourceTraceTruncated = true;
      delete retained.cache.sourceTraceEvicted;
      this.refreshSize(retained);
    }
  }

  private rewriteEvictedProvenance(evicted: Set<number>): void {
    for (const retained of this.traces) {
      if (retained.cache.sourceTraceId === undefined
          || !evicted.has(retained.cache.sourceTraceId)) continue;
      delete retained.cache.sourceTraceId;
      delete retained.cache.sourceTraceTruncated;
      retained.cache.sourceTraceEvicted = true;
      this.refreshSize(retained);
    }
  }

  private refreshSize(trace: RetrievalTrace): void {
    const previous = this.sizes.get(trace) ?? 0;
    const next = encodedTraceBytes(trace);
    this.sizes.set(trace, next);
    if (Number.isFinite(previous) && Number.isFinite(next)) {
      this.payloadBytes += next - previous;
    } else {
      this.recalculatePayloadBytes();
    }
  }

  private recalculatePayloadBytes(): void {
    this.payloadBytes = 0;
    for (const size of this.sizes.values()) this.payloadBytes += size;
  }

  private totalEncodedBytes(): number {
    return 2 + this.payloadBytes + Math.max(0, this.traces.length - 1);
  }

  list(options: RetrievalTraceListOptions = {}): RetrievalTrace[] {
    const requestedLimit = options.limit ?? 20;
    const finiteLimit = Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 20;
    const limit = Math.max(1, Math.min(this.capacity, finiteLimit));
    const selected = this.traces.slice(-limit).reverse().map(trace => structuredClone(trace));
    if (options.includeInputs) return selected;

    for (const trace of selected) {
      if (trace.context) delete trace.context.input;
      delete trace.queries;
      delete trace.rerankQuery;
    }
    return selected;
  }
}

function encodedTraceBytes(trace: RetrievalTrace): number {
  try {
    return utf8Bytes(JSON.stringify(trace));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function recordInjectionShape(trace: RetrievalTrace, injections: ContextInjection[]): void {
  const injection = injections[0];
  if (!injection) return;
  trace.injected.namespace = injection.namespace;
  trace.injected.position = injection.position;
  trace.injected.block = injectionText(injections);
}

function injectionText(injections: ContextInjection[]): string | undefined {
  for (const injection of injections) {
    for (const block of injection.content) {
      if (block.type === 'text') return block.text;
    }
  }
  return undefined;
}
