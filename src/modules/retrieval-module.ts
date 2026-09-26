/**
 * RetrievalModule — local-model retrieval of lessons into context.
 *
 * Runs in gatherContext() before each inference, with no API calls:
 *   1. Search: several short queries from the recent conversation (latest
 *      incoming message, latest own message, chunks of the recent window),
 *      each run against the lesson library by BM25 and by dense embedding
 *      similarity; all lists merged by reciprocal rank fusion.
 *   2. Rerank: a cross-encoder scores the top candidates against the tail of
 *      the conversation; lessons at or above relevanceThreshold are relevant.
 *   3. Inject: relevant lessons in rankScore order (confidence discounted for
 *      disuse), up to maxInjectedLessons.
 *
 * The reranker decides what is relevant; salience decides what comes to mind
 * first. Each fresh injection is reported to LessonsModule.recordRetrieval so
 * usage feeds back into salience. Results are cached per context hash, and
 * cache hits are not counted as retrievals.
 */

import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '@animalabs/agent-framework';
import type { ContextInjection } from '@animalabs/context-manager';
import { rankScore, type LessonsModule, type Lesson } from './lessons-module.js';
import { bm25Scores } from './lesson-search.js';
import { dot, type RetrievalModels } from './retrieval-models.js';
import {
  RetrievalTraceStore,
  type RetrievalCandidateScores,
  type RetrievalTraceListOptions,
  type RetrievalTraceRun,
} from './retrieval-trace.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RetrievalModuleConfig {
  models: RetrievalModels;
  /** Max lessons to inject (default: 5) */
  maxInjectedLessons?: number;
  /** Minimum lesson confidence for eligibility (default: 0.3) */
  minConfidence?: number;
  /** Candidates passed from search to the reranker (default: 16). Rerank cost is linear in this. */
  maxCandidates?: number;
  /** Reranker score at or above which a candidate is relevant (default: DEFAULT_RELEVANCE_THRESHOLD). */
  relevanceThreshold?: number;
}

const DEFAULT_MAX_CANDIDATES = 16;
/**
 * Qwen3-Reranker scores are strongly bimodal. On the synthetic set in
 * scripts/retrieval-calibration (2026-09-26), F1 was flat at ~0.83 for
 * thresholds 0.25–0.40 and fell to 0.79 at 0.5; 0.3 sits mid-plateau.
 * Re-run that script against real labelled turns before trusting it further.
 */
export const DEFAULT_RELEVANCE_THRESHOLD = 0.3;

/** Messages of recent context considered. */
const RECENT_MESSAGES = 10;
/** Characters per search query (~500 tokens), so no single query averages many topics. */
const QUERY_CHARS = 2000;
/** Window chunks searched, newest first. */
const MAX_WINDOW_CHUNKS = 4;
/** Characters of conversation tail given to the reranker (~300 tokens); rerank cost scales with it per candidate. */
const RERANK_QUERY_CHARS = 1200;
/** Characters of a lesson embedded or reranked (~1500 tokens), within the models' 2048-token contexts. */
const DOCUMENT_CHARS = 6000;
/** Standard reciprocal-rank-fusion damping constant. */
const RRF_K = 60;

// ---------------------------------------------------------------------------
// Query construction and fusion (pure, exported for tests)
// ---------------------------------------------------------------------------

export interface RecentMessage {
  participant: string;
  text: string;
}

function tail(text: string, chars: number): string {
  return text.length <= chars ? text : text.slice(text.length - chars);
}

function render(messages: RecentMessage[]): string {
  return messages.map(m => `${m.participant}: ${m.text}`).join('\n\n');
}

/** Short search queries: latest incoming message, latest own message, then window chunks newest-first. */
export function searchQueries(messages: RecentMessage[], agentName: string): string[] {
  const latestIncoming = [...messages].reverse().find(m => m.participant !== agentName && m.text.trim());
  const latestOwn = [...messages].reverse().find(m => m.participant === agentName && m.text.trim());
  const queries = [latestIncoming, latestOwn].flatMap(m => (m ? [tail(m.text, QUERY_CHARS)] : []));

  let window = render(messages);
  for (let i = 0; i < MAX_WINDOW_CHUNKS && window.trim(); i++) {
    queries.push(tail(window, QUERY_CHARS));
    window = window.slice(0, Math.max(0, window.length - QUERY_CHARS));
  }
  return [...new Set(queries)];
}

/** The conversation tail the reranker judges lessons against. */
export function rerankQuery(messages: RecentMessage[]): string {
  return tail(render(messages), RERANK_QUERY_CHARS);
}

export function lessonDocument(lesson: Lesson): string {
  const text = lesson.tags.length > 0 ? `${lesson.content}\nTags: ${lesson.tags.join(', ')}` : lesson.content;
  return text.slice(0, DOCUMENT_CHARS);
}

/** Reciprocal rank fusion of ranked ID lists; returns IDs by fused score, highest first. */
export function fuse(lists: string[][]): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1)));
  }
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class RetrievalModule implements Module {
  readonly name = 'retrieval';

  private ctx: ModuleContext | null = null;
  private config: RetrievalModuleConfig;
  private lastContextHash = '';
  private cachedInjections: ContextInjection[] = [];
  private cachedLessonIds: string[] = [];
  private cachedLessons: Lesson[] = [];
  private cachedSourceTraceId: number | undefined;
  /** Document embeddings keyed by lessonDocument() text, pruned to the live library each run. */
  private readonly documentVectors = new Map<string, Float32Array>();
  private readonly traceStore = new RetrievalTraceStore();

  constructor(config: RetrievalModuleConfig) {
    this.config = config;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }

  async stop(): Promise<void> {
    this.ctx = null;
    await this.config.models.dispose();
  }

  getTools(): ToolDefinition[] {
    // RetrievalModule is passive — no tools, only gatherContext
    return [];
  }

  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    return { success: false, error: 'RetrievalModule has no tools', isError: true };
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  /** Recent retrieval runs, newest first. Exact conversation inputs are opt-in. */
  getRetrievalTraces(options?: RetrievalTraceListOptions) {
    return this.traceStore.list(options);
  }

  private beginTrace(agentName: string): RetrievalTraceRun | undefined {
    try {
      return this.traceStore.begin({
        agentName,
        embeddingModel: this.config.models.embeddingModel,
        rerankerModel: this.config.models.rerankerModel,
        minConfidence: this.config.minConfidence ?? 0.3,
        maxCandidates: this.config.maxCandidates ?? DEFAULT_MAX_CANDIDATES,
        maxInjectedLessons: this.config.maxInjectedLessons ?? 5,
        relevanceThreshold: this.config.relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD,
      });
    } catch {
      return undefined;
    }
  }

  async gatherContext(agentName: string): Promise<ContextInjection[]> {
    const trace = this.beginTrace(agentName);
    if (!this.ctx) {
      trace?.finish('not-started');
      return [];
    }

    let lessonsModule: LessonsModule | null;
    let lessons: Lesson[];
    let messages: RecentMessage[];
    let contextHash: string;
    try {
      // These lookups, eligibility checks, context rendering, and hashing are
      // pre-existing throwing paths. Record their failure, then preserve the
      // upstream rejection rather than applying the model-stage fail-open.
      lessonsModule = this.ctx.getModule<LessonsModule>('lessons');
      if (!lessonsModule) {
        trace?.finish('no-lessons-module');
        return [];
      }

      lessons = lessonsModule.getLessons().filter(
        l => !l.deprecated && l.confidence >= (this.config.minConfidence ?? 0.3)
      );
      if (lessons.length === 0) {
        trace?.finish('no-eligible-lessons');
        return [];
      }

      const recent = this.getRecentContext();
      if (!recent) {
        trace?.finish('no-recent-context');
        return [];
      }
      messages = recent.messages;

      // Check cache: if context hasn't changed, reuse cached results.
      const rendered = render(messages);
      contextHash = this.hashContext(rendered);
      trace?.setContext(contextHash, rendered, recent.messages.length, recent.messageIds);
      if (contextHash === this.lastContextHash && this.cachedInjections.length > 0) {
        trace?.recordCacheHit(
          this.cachedSourceTraceId,
          this.cachedLessonIds,
          this.cachedLessons,
          this.cachedInjections,
        );
        trace?.finish('cache-hit');
        return this.cachedInjections;
      }
    } catch (error) {
      trace?.finish('error', error);
      throw error;
    }

    try {
      // Step 1: Search
      const queries = searchQueries(messages, agentName);
      const judgedAgainst = rerankQuery(messages);
      trace?.recordQueries(queries, judgedAgainst);
      const candidates = await this.search(queries, lessons);

      // Step 2: Rerank
      const scores = await this.config.models.rerank(judgedAgainst, candidates.map(c => lessonDocument(c.lesson)));
      if (scores.length !== candidates.length) {
        throw new Error(`reranker returned ${scores.length} scores for ${candidates.length} candidates`);
      }
      trace?.recordCandidates(candidates.map((c, i) => ({ ...c, rerankScore: scores[i] })));
      const threshold = this.config.relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD;
      const relevant = candidates.filter((_, i) => scores[i] >= threshold).map(c => c.lesson);
      trace?.recordRelevant(relevant);

      // Step 3: Inject — what comes to mind first among the relevant
      const maxLessons = this.config.maxInjectedLessons ?? 5;
      const now = Date.now();
      const injected = [...relevant]
        .sort((a, b) => rankScore(b, now) - rankScore(a, now))
        .slice(0, maxLessons);

      if (injected.length === 0) {
        this.cacheEmpty(contextHash);
        trace?.finish('no-relevant-lessons');
        return [];
      }

      const text = injected
        .map(l => `- [${(l.confidence * 100).toFixed(0)}%] ${l.content} (tags: ${l.tags.join(', ')})`)
        .join('\n');

      const injections: ContextInjection[] = [{
        namespace: 'retrieval',
        // 'afterUser', NOT 'system': retrieval content changes with recent
        // context (contextHash above), so injecting it into the system prompt
        // churns the very front of the KV cache and invalidates the entire
        // prefix every turn. Tail injection keeps the stable prefix cached.
        position: 'afterUser',
        content: [{ type: 'text', text: `## Retrieved Knowledge\n${text}` }],
      }];

      this.lastContextHash = contextHash;
      this.cachedInjections = injections;
      this.cachedLessons = this.safeLessonSnapshots(injected);
      this.cachedLessonIds = this.safeLessonIds(this.cachedLessons);
      this.cachedSourceTraceId = trace?.id;
      lessonsModule.recordRetrieval(injected.map(l => l.id));
      trace?.recordInjection(injected, injections);
      trace?.finish('injected');
      return injections;
    } catch (err) {
      // Fail open — don't block inference if retrieval fails
      trace?.finish('error', err);
      console.error('RetrievalModule: retrieval failed:', err);
      return [];
    }
  }

  // =========================================================================
  // Pipeline
  // =========================================================================

  /** BM25 and dense lists per query, fused; the top maxCandidates go to the reranker. */
  private async search(queries: string[], lessons: Lesson[]): Promise<RetrievalCandidateScores[]> {
    const byId = new Map(lessons.map(l => [l.id, l]));
    const documents = lessons.map(lessonDocument);

    const missing = [...new Set(documents.filter(d => !this.documentVectors.has(d)))];
    const fresh = await this.config.models.embed(missing, 'document');
    missing.forEach((d, i) => this.documentVectors.set(d, fresh[i]));
    const live = new Set(documents);
    for (const key of this.documentVectors.keys()) if (!live.has(key)) this.documentVectors.delete(key);

    const queryVectors = await this.config.models.embed(queries, 'query');
    const lexicalLists: string[][] = [];
    const denseLists: string[][] = [];
    queries.forEach((query, q) => {
      const bm25 = bm25Scores(query, lessons);
      lexicalLists.push(lessons
        .map((l, i) => ({ id: l.id, score: bm25[i] }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(x => x.id));
      denseLists.push(lessons
        .map((l, i) => ({ id: l.id, score: dot(queryVectors[q], this.documentVectors.get(documents[i])!) }))
        .sort((a, b) => b.score - a.score)
        .map(x => x.id));
    });

    const bestRank = (lists: string[][], id: string): number | undefined => {
      const ranks = lists.map(list => list.indexOf(id)).filter(r => r >= 0);
      return ranks.length > 0 ? Math.min(...ranks) + 1 : undefined;
    };
    return fuse([...lexicalLists, ...denseLists])
      .slice(0, this.config.maxCandidates ?? DEFAULT_MAX_CANDIDATES)
      .map(({ id, score }) => ({
        lesson: byId.get(id)!,
        fusedScore: score,
        lexicalRank: bestRank(lexicalLists, id),
        denseRank: bestRank(denseLists, id),
      }));
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private cacheEmpty(contextHash: string): void {
    this.lastContextHash = contextHash;
    this.cachedInjections = [];
    this.cachedLessonIds = [];
    this.cachedLessons = [];
    this.cachedSourceTraceId = undefined;
  }

  private getRecentContext(): { messages: RecentMessage[]; messageIds: string[] } | null {
    if (!this.ctx) return null;

    const { messages } = this.ctx.queryMessages({});
    if (messages.length === 0) return null;

    const recent = messages.slice(-RECENT_MESSAGES);
    const rendered = recent.map(m => ({
      participant: m.participant,
      text: m.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('\n'),
    }));
    const messageIds = recent.flatMap(message => {
      try {
        const candidate = (message as unknown as { id?: unknown }).id;
        return typeof candidate === 'string' || typeof candidate === 'number'
          ? [String(candidate)]
          : [];
      } catch {
        // Trace-only metadata must never alter retrieval behavior.
        return [];
      }
    });

    return { messages: rendered, messageIds };
  }

  private safeLessonIds(lessons: Lesson[]): string[] {
    const ids: string[] = [];
    for (const lesson of lessons) {
      try {
        if (typeof lesson.id === 'string') ids.push(lesson.id);
      } catch {
        // Cache provenance is observability metadata; omit unreadable IDs.
      }
    }
    return ids;
  }

  private safeLessonSnapshots(lessons: Lesson[]): Lesson[] {
    const snapshots: Lesson[] = [];
    for (const item of lessons) {
      try {
        snapshots.push({
          id: item.id,
          content: item.content,
          confidence: item.confidence,
          tags: [...item.tags],
          evidence: [...item.evidence],
          created: item.created,
          updated: item.updated,
          deprecated: item.deprecated,
          ...(item.deprecationReason !== undefined
            ? { deprecationReason: item.deprecationReason }
            : {}),
        });
      } catch {
        // Trace-only lesson snapshots must not alter retrieval behavior.
      }
    }
    return snapshots;
  }

  private hashContext(text: string): string {
    // Simple hash for cache invalidation
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const chr = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return hash.toString(36);
  }
}
