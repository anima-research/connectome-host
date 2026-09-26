import type { ContextInjection } from '@animalabs/context-manager';
import type { Lesson } from './lessons-module.js';
import { tokenize } from './lesson-search.js';
import type { RetrievalReasoningConfig } from './retrieval-module.js';

export const RETRIEVAL_TRACE_SCHEMA_VERSION = 1;
export const DEFAULT_RETRIEVAL_TRACE_CAPACITY = 100;
export const DEFAULT_RETRIEVAL_TRACE_BYTE_BUDGET = 8 * 1024 * 1024;

const MIN_RETRIEVAL_TRACE_BYTE_BUDGET = 1024;
const PROVIDER_SERIALIZATION_LIMITS = {
  maxDepth: 8,
  maxNodes: 512,
  maxArrayItems: 64,
  maxObjectKeys: 64,
  maxStringBytes: 16 * 1024,
  maxTotalStringBytes: 128 * 1024,
} as const;

export type RetrievalTraceOutcome =
  | 'not-started'
  | 'no-lessons-module'
  | 'no-eligible-lessons'
  | 'no-recent-context'
  | 'cache-hit'
  | 'no-concepts'
  | 'no-candidates'
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

export interface RetrievalCandidateMatch {
  concept: string;
  keyword: string;
  field: 'content' | 'tag';
  tag?: string;
}

export interface RetrievalCandidateTrace extends RetrievalLessonTrace {
  matches: RetrievalCandidateMatch[];
}

export interface RetrievalStageTrace {
  systemPrompt: string;
  /** Exact user input. Omitted from default HTTP views. */
  input?: string;
  rawOutput?: string;
  /** Provider-returned content blocks, including any opaque/redacted reasoning blocks. */
  responseContent?: unknown[];
  responseContentTruncation?: RetrievalProviderTruncation;
  parsedValues?: string[];
  parseMode?: 'json' | 'array-extraction' | 'fallback' | 'invalid';
  error?: string;
}

export type RetrievalProviderTruncationReason =
  | 'max-depth'
  | 'max-nodes'
  | 'max-array-items'
  | 'max-object-keys'
  | 'max-string-bytes'
  | 'max-total-string-bytes'
  | 'non-json-value'
  | 'serialization-error';

export interface RetrievalProviderTruncation {
  truncated: true;
  reasons: RetrievalProviderTruncationReason[];
  retainedNodes: number;
  retainedStringBytes: number;
  limits: typeof PROVIDER_SERIALIZATION_LIMITS;
}

export interface RetrievalTrace {
  schemaVersion: 1;
  id: number;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  agentName: string;
  config: {
    model: string;
    requestedReasoning?: RetrievalReasoningConfig;
    providerParams?: Record<string, unknown>;
    providerParamsTruncation?: RetrievalProviderTruncation;
    minConfidence: number;
    maxCandidates: number;
    maxInjectedLessons: number;
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
  conceptExtraction?: RetrievalStageTrace;
  /** How candidates were chosen: the whole eligible library, or a BM25 shortlist of it. */
  candidateSelection?: { mode: 'full-library' | 'bm25'; eligible: number };
  candidates: RetrievalCandidateTrace[];
  relevance?: RetrievalStageTrace & {
    ran: boolean;
    skippedReason?: string;
  };
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
  model: string;
  requestedReasoning?: RetrievalReasoningConfig;
  providerParams?: Record<string, unknown>;
  minConfidence: number;
  maxCandidates: number;
  maxInjectedLessons: number;
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
      PROVIDER_SERIALIZATION_LIMITS.maxStringBytes,
    );
  } catch {
    return 'unavailable error';
  }
}

interface ProviderSerializationState {
  nodes: number;
  stringBytes: number;
  reasons: Set<RetrievalProviderTruncationReason>;
}

const textEncoder = new TextEncoder();
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength',
)?.get;
const typedArrayByteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'byteLength',
)?.get;
const dataViewByteLengthGetter = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  'byteLength',
)?.get;
const mapSizeGetter = Object.getOwnPropertyDescriptor(Map.prototype, 'size')?.get;
const setSizeGetter = Object.getOwnPropertyDescriptor(Set.prototype, 'size')?.get;
const bigIntToString = BigInt.prototype.toString;
const dateToISOString = Date.prototype.toISOString;

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

function boundedProviderString(value: string, state: ProviderSerializationState): string {
  const valueBytes = utf8Bytes(value);
  const remainingTotal = Math.max(
    0,
    PROVIDER_SERIALIZATION_LIMITS.maxTotalStringBytes - state.stringBytes,
  );
  if (valueBytes > PROVIDER_SERIALIZATION_LIMITS.maxStringBytes) {
    state.reasons.add('max-string-bytes');
  }
  if (valueBytes > remainingTotal) state.reasons.add('max-total-string-bytes');
  const retained = truncateUtf8(
    value,
    Math.min(PROVIDER_SERIALIZATION_LIMITS.maxStringBytes, remainingTotal),
  );
  state.stringBytes += utf8Bytes(retained);
  return retained;
}

function intrinsicNonnegativeInteger(
  value: object,
  getter: (() => unknown) | undefined,
): number | undefined {
  if (!getter) return undefined;
  try {
    const metadata = Reflect.apply(getter, value, []);
    return typeof metadata === 'number'
      && Number.isSafeInteger(metadata)
      && metadata >= 0
      ? metadata
      : undefined;
  } catch {
    return undefined;
  }
}

function jsonSafeValue(
  value: unknown,
  state: ProviderSerializationState,
  ancestors = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (state.nodes >= PROVIDER_SERIALIZATION_LIMITS.maxNodes) {
    state.reasons.add('max-nodes');
    return { type: 'truncated', reason: 'max-nodes', unavailable: true };
  }
  state.nodes++;

  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return boundedProviderString(value, state);
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? value
      : { type: 'number', value: String(value), unavailable: true };
  }
  if (typeof value === 'bigint') {
    return {
      type: 'bigint',
      value: boundedProviderString(Reflect.apply(bigIntToString, value, []), state),
      unavailable: true,
    };
  }
  if (typeof value === 'undefined' || typeof value === 'symbol' || typeof value === 'function') {
    return { type: typeof value, unavailable: true };
  }
  if (depth >= PROVIDER_SERIALIZATION_LIMITS.maxDepth) {
    state.reasons.add('max-depth');
    return { type: 'max-depth', unavailable: true };
  }

  const object = value as object;
  if (value instanceof ArrayBuffer) {
    state.reasons.add('non-json-value');
    const byteLength = intrinsicNonnegativeInteger(value, arrayBufferByteLengthGetter);
    return {
      type: 'array-buffer',
      ...(byteLength !== undefined ? { byteLength } : {}),
      unavailable: true,
    };
  }
  if (ArrayBuffer.isView(value)) {
    state.reasons.add('non-json-value');
    const getter = value instanceof DataView
      ? dataViewByteLengthGetter
      : typedArrayByteLengthGetter;
    const byteLength = intrinsicNonnegativeInteger(value, getter);
    return {
      type: 'array-buffer-view',
      ...(byteLength !== undefined ? { byteLength } : {}),
      unavailable: true,
    };
  }
  if (value instanceof Map) {
    state.reasons.add('non-json-value');
    const size = intrinsicNonnegativeInteger(value, mapSizeGetter);
    return { type: 'map', ...(size !== undefined ? { size } : {}), unavailable: true };
  }
  if (value instanceof Set) {
    state.reasons.add('non-json-value');
    const size = intrinsicNonnegativeInteger(value, setSizeGetter);
    return { type: 'set', ...(size !== undefined ? { size } : {}), unavailable: true };
  }
  if (ancestors.has(object)) return { type: 'circular', unavailable: true };
  ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      const retainedLength = Math.min(value.length, PROVIDER_SERIALIZATION_LIMITS.maxArrayItems);
      if (value.length > retainedLength) state.reasons.add('max-array-items');
      for (let i = 0; i < retainedLength; i++) {
        if (state.nodes >= PROVIDER_SERIALIZATION_LIMITS.maxNodes) {
          state.reasons.add('max-nodes');
          result.push({ type: 'truncated', reason: 'max-nodes', unavailable: true });
          break;
        }
        result.push(jsonSafeValue(value[i], state, ancestors, depth + 1));
      }
      if (value.length > retainedLength) {
        result.push({
          type: 'truncated',
          reason: 'max-array-items',
          omittedItems: value.length - retainedLength,
          unavailable: true,
        });
      }
      return result;
    }
    if (value instanceof Date) {
      try {
        return boundedProviderString(Reflect.apply(dateToISOString, value, []), state);
      } catch {
        return { type: 'date', unavailable: true };
      }
    }

    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const retainedKeys: string[] = [];
    let omittedKeys = false;
    try {
      for (const key in object as Record<string, unknown>) {
        if (!Object.prototype.hasOwnProperty.call(object, key)) continue;
        if (retainedKeys.length >= PROVIDER_SERIALIZATION_LIMITS.maxObjectKeys) {
          omittedKeys = true;
          break;
        }
        retainedKeys.push(key);
      }
    } catch {
      return { type: 'unreadable', unavailable: true };
    }
    if (omittedKeys) state.reasons.add('max-object-keys');
    for (const originalKey of retainedKeys) {
      if (state.nodes >= PROVIDER_SERIALIZATION_LIMITS.maxNodes) {
        state.reasons.add('max-nodes');
        result.__truncated__ = { type: 'truncated', reason: 'max-nodes', unavailable: true };
        break;
      }
      let key = boundedProviderString(originalKey, state);
      for (let suffix = 2; Object.prototype.hasOwnProperty.call(result, key); suffix++) {
        key = `${truncateUtf8(key, 256)}#${suffix}`;
      }
      try {
        result[key] = jsonSafeValue(
          (object as Record<string, unknown>)[originalKey],
          state,
          ancestors,
          depth + 1,
        );
      } catch {
        result[key] = { type: 'unreadable', unavailable: true };
      }
    }
    if (omittedKeys) {
      result.__truncated__ = {
        type: 'truncated',
        reason: 'max-object-keys',
        omittedKeysAtLeast: 1,
        unavailable: true,
      };
    }
    return result;
  } finally {
    ancestors.delete(object);
  }
}

function snapshotProviderValue(value: unknown): {
  value: unknown;
  truncation?: RetrievalProviderTruncation;
} {
  const state: ProviderSerializationState = { nodes: 0, stringBytes: 0, reasons: new Set() };
  try {
    const snapshot = jsonSafeValue(value, state);
    const reasons = [...state.reasons];
    return {
      value: snapshot,
      ...(reasons.length > 0 ? {
        truncation: {
          truncated: true,
          reasons,
          retainedNodes: state.nodes,
          retainedStringBytes: state.stringBytes,
          limits: PROVIDER_SERIALIZATION_LIMITS,
        },
      } : {}),
    };
  } catch {
    return {
      value: { type: 'unreadable', unavailable: true },
      truncation: {
        truncated: true,
        reasons: ['serialization-error'],
        retainedNodes: state.nodes,
        retainedStringBytes: state.stringBytes,
        limits: PROVIDER_SERIALIZATION_LIMITS,
      },
    };
  }
}

function snapshotResponseContent(content: readonly unknown[]): {
  content: unknown[];
  truncation?: RetrievalProviderTruncation;
} {
  const snapshot = snapshotProviderValue(content);
  return {
    content: Array.isArray(snapshot.value) ? snapshot.value : [snapshot.value],
    ...(snapshot.truncation ? { truncation: snapshot.truncation } : {}),
  };
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

function candidateMatches(concepts: string[], lesson: Lesson): RetrievalCandidateMatch[] {
  const matches: RetrievalCandidateMatch[] = [];
  const content = new Set(tokenize(lesson.content));
  const tags = lesson.tags.map(tag => ({ original: tag, terms: new Set(tokenize(tag)) }));

  for (const concept of concepts) {
    for (const keyword of new Set(tokenize(concept))) {
      if (content.has(keyword)) {
        matches.push({ concept, keyword, field: 'content' });
      }
      for (const tag of tags) {
        if (tag.terms.has(keyword)) {
          matches.push({ concept, keyword, field: 'tag', tag: tag.original });
        }
      }
    }
  }

  return matches;
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

  startConceptExtraction(systemPrompt: string, input: string): void {
    this.update(trace => {
      trace.conceptExtraction = { systemPrompt, input };
    });
  }

  finishConceptExtraction(
    rawOutput: string,
    parsedValues: string[],
    parseMode: RetrievalStageTrace['parseMode'],
    responseContent: readonly unknown[] = [],
  ): void {
    this.update(trace => {
      const snapshot = snapshotResponseContent(responseContent);
      if (!trace.conceptExtraction) trace.conceptExtraction = { systemPrompt: '' };
      trace.conceptExtraction.rawOutput = rawOutput;
      trace.conceptExtraction.responseContent = snapshot.content;
      if (snapshot.truncation) {
        trace.conceptExtraction.responseContentTruncation = snapshot.truncation;
      }
      trace.conceptExtraction.parsedValues = [...parsedValues];
      trace.conceptExtraction.parseMode = parseMode;
    });
  }

  recordCandidates(
    concepts: string[],
    lessons: Lesson[],
    selection: { mode: 'full-library' | 'bm25'; eligible: number },
  ): void {
    this.update(trace => {
      trace.candidateSelection = { ...selection };
      trace.candidates = lessons.map(lesson => ({
        ...lessonSnapshot(lesson),
        matches: candidateMatches(concepts, lesson),
      }));
    });
  }

  recordRelevanceSkipped(reason: string): void {
    this.update(trace => {
      trace.relevance = {
        ran: false,
        skippedReason: reason,
        systemPrompt: '',
      };
    });
  }

  startRelevance(systemPrompt: string, input: string): void {
    this.update(trace => {
      trace.relevance = { ran: true, systemPrompt, input };
    });
  }

  finishRelevance(
    rawOutput: string,
    parsedIds: string[],
    parseMode: RetrievalStageTrace['parseMode'],
    responseContent: readonly unknown[] = [],
  ): void {
    this.update(trace => {
      const snapshot = snapshotResponseContent(responseContent);
      if (!trace.relevance) trace.relevance = { ran: true, systemPrompt: '' };
      trace.relevance.rawOutput = rawOutput;
      trace.relevance.responseContent = snapshot.content;
      if (snapshot.truncation) trace.relevance.responseContentTruncation = snapshot.truncation;
      trace.relevance.parsedValues = [...parsedIds];
      trace.relevance.parseMode = parseMode;
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

  recordStageError(stage: 'conceptExtraction' | 'relevance', error: unknown): void {
    this.update(trace => {
      const existing = trace[stage];
      if (stage === 'relevance') {
        trace.relevance = {
          ran: true,
          systemPrompt: existing?.systemPrompt ?? '',
          ...(existing?.input ? { input: existing.input } : {}),
          error: errorMessage(error),
        };
      } else {
        trace.conceptExtraction = {
          systemPrompt: existing?.systemPrompt ?? '',
          ...(existing?.input ? { input: existing.input } : {}),
          error: errorMessage(error),
        };
      }
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
    const providerParams = options.providerParams
      ? snapshotProviderValue(options.providerParams)
      : undefined;
    const trace: RetrievalTrace = {
      schemaVersion: RETRIEVAL_TRACE_SCHEMA_VERSION,
      id: this.nextId++,
      startedAt: new Date().toISOString(),
      agentName: options.agentName,
      config: {
        model: options.model,
        ...(options.requestedReasoning
          ? { requestedReasoning: { ...options.requestedReasoning } }
          : {}),
        ...(providerParams ? {
          providerParams: providerParams.value as Record<string, unknown>,
          ...(providerParams.truncation
            ? { providerParamsTruncation: providerParams.truncation }
            : {}),
        } : {}),
        minConfidence: options.minConfidence,
        maxCandidates: options.maxCandidates,
        maxInjectedLessons: options.maxInjectedLessons,
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
        model: truncateUtf8(trace.config.model, 128),
        minConfidence: trace.config.minConfidence,
        maxCandidates: trace.config.maxCandidates,
        maxInjectedLessons: trace.config.maxInjectedLessons,
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
      if (trace.conceptExtraction) delete trace.conceptExtraction.input;
      if (trace.relevance) delete trace.relevance.input;
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
