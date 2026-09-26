/**
 * RetrievalModule — LLM-as-retriever for semantic memory.
 *
 * Three-step retrieval pipeline running in gatherContext():
 *   1. Flag concepts: identify concepts being discussed that might benefit
 *      from background knowledge
 *   2. Mechanical query: keyword-match against LessonsModule
 *   3. Validate relevance: filter to actually relevant lessons
 *
 * Candidates are ranked by rankScore (confidence discounted for disuse), and
 * every fresh injection is reported to LessonsModule.recordRetrieval so that
 * usage feeds back into that ranking. Cache hits are not counted again.
 *
 * Steps 1 and 3 use the configured retrieval model and optional reasoning.
 * Results are cached to avoid redundant calls on unchanged context.
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
import type { Membrane, NormalizedRequest } from '@animalabs/membrane';
import type { ContextInjection } from '@animalabs/context-manager';
import { rankScore, type LessonsModule, type Lesson } from './lessons-module.js';
import {
  RetrievalTraceStore,
  type RetrievalTraceListOptions,
  type RetrievalTraceRun,
} from './retrieval-trace.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type RetrievalReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RetrievalReasoningConfig {
  effort: RetrievalReasoningEffort;
}

interface RecentRetrievalContext {
  text: string;
  messageCount: number;
  messageIds: string[];
}

export interface RetrievalModuleConfig {
  /** Membrane instance for retrieval calls */
  membrane: Membrane;
  /** Model to use for retrieval calls (default: claude-haiku-4-5-20251001) */
  retrievalModel?: string;
  /** Optional OpenAI reasoning effort, applied to both retrieval LLM stages. */
  retrievalReasoning?: RetrievalReasoningConfig;
  /** Max lessons to inject (default: 5) */
  maxInjectedLessons?: number;
  /** Minimum lesson confidence for injection (default: 0.3) */
  minConfidence?: number;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const CONCEPT_FLAG_PROMPT = `You are a knowledge retrieval assistant. Given the recent conversation below, identify concepts, entities, topics, or themes that might benefit from background knowledge or lessons learned from previous research.

Return ONLY a JSON array of keyword strings, nothing else. Example: ["RFC process", "authentication", "team lead"]

If nothing would benefit from background knowledge, return an empty array: []`;

const RELEVANCE_VALIDATION_PROMPT = `You are a relevance filter. Given the current conversation context and a set of candidate knowledge lessons, determine which lessons are actually relevant to the current discussion.

Return ONLY a JSON array of lesson IDs that are relevant, nothing else. Example: ["a1b2c3d4", "e5f6g7h8"]

If none are relevant, return an empty array: []`;

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
  private readonly traceStore = new RetrievalTraceStore();

  constructor(config: RetrievalModuleConfig) {
    this.config = config;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }

  async stop(): Promise<void> {
    this.ctx = null;
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
      const providerParams = this.retrievalProviderParams();
      return this.traceStore.begin({
        agentName,
        model: this.config.retrievalModel ?? 'claude-haiku-4-5-20251001',
        ...(this.config.retrievalReasoning
          ? { requestedReasoning: this.config.retrievalReasoning }
          : {}),
        ...(providerParams ? { providerParams } : {}),
        minConfidence: this.config.minConfidence ?? 0.3,
        maxCandidates: 20,
        maxInjectedLessons: this.config.maxInjectedLessons ?? 5,
      });
    } catch {
      return undefined;
    }
  }

  /**
   * Run the 3-step retrieval pipeline before each inference.
   */
  async gatherContext(agentName: string): Promise<ContextInjection[]> {
    const trace = this.beginTrace(agentName);
    if (!this.ctx) {
      trace?.finish('not-started');
      return [];
    }

    let lessonsModule: LessonsModule | null;
    let lessons: Lesson[];
    let recentMessages: string;
    let contextHash: string;
    try {
      // These lookups, eligibility checks, context rendering, and hashing are
      // pre-existing throwing paths. Record their failure, then preserve the
      // upstream rejection rather than applying the provider-stage fail-open.
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
      recentMessages = recent.text;

      // Check cache: if context hasn't changed, reuse cached results.
      contextHash = this.hashContext(recentMessages);
      trace?.setContext(contextHash, recentMessages, recent.messageCount, recent.messageIds);
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
      // Step 1: Flag concepts
      const concepts = await this.flagConcepts(recentMessages, trace);
      if (concepts.length === 0) {
        this.lastContextHash = contextHash;
        this.cachedInjections = [];
        this.cachedLessonIds = [];
        this.cachedLessons = [];
        this.cachedSourceTraceId = undefined;
        trace?.finish('no-concepts');
        return [];
      }

      // Step 2: Mechanical query (keyword matching)
      const candidates = this.queryCandidates(concepts, lessons);
      trace?.recordCandidates(concepts, candidates);
      if (candidates.length === 0) {
        this.lastContextHash = contextHash;
        this.cachedInjections = [];
        this.cachedLessonIds = [];
        this.cachedLessons = [];
        this.cachedSourceTraceId = undefined;
        trace?.finish('no-candidates');
        return [];
      }

      // Step 3: Validate relevance
      const relevant = await this.validateRelevance(recentMessages, candidates, trace);
      trace?.recordRelevant(relevant);

      // Build injection
      const maxLessons = this.config.maxInjectedLessons ?? 5;
      const injected = relevant.slice(0, maxLessons);

      if (injected.length === 0) {
        this.lastContextHash = contextHash;
        this.cachedInjections = [];
        this.cachedLessonIds = [];
        this.cachedLessons = [];
        this.cachedSourceTraceId = undefined;
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
  // Pipeline Steps
  // =========================================================================

  /** Build OpenAI request parameters for configured retrieval reasoning effort. */
  private retrievalProviderParams(): Record<string, unknown> | undefined {
    const reasoning = this.config.retrievalReasoning;
    if (!reasoning) return undefined;
    return { reasoning: { effort: reasoning.effort } };
  }

  /**
   * Step 1: Use the configured retrieval model to identify concepts that might benefit from background knowledge.
   */
  private async flagConcepts(
    recentContext: string,
    trace?: RetrievalTraceRun,
  ): Promise<string[]> {
    const model = this.config.retrievalModel ?? 'claude-haiku-4-5-20251001';
    const providerParams = this.retrievalProviderParams();
    const input = `Recent conversation:\n${recentContext}`;

    const request: NormalizedRequest = {
      messages: [
        {
          participant: 'user',
          content: [{ type: 'text', text: input }],
        },
      ],
      system: CONCEPT_FLAG_PROMPT,
      config: { model, maxTokens: 500, temperature: 0 },
      ...(providerParams ? { providerParams } : {}),
    };

    trace?.startConceptExtraction(CONCEPT_FLAG_PROMPT, input);
    let response;
    try {
      response = await this.config.membrane.complete(request);
    } catch (error) {
      trace?.recordStageError('conceptExtraction', error);
      throw error;
    }
    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('');

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const concepts = parsed.filter((value): value is string => typeof value === 'string');
        trace?.finishConceptExtraction(text, concepts, 'json', response.content);
        return concepts;
      }
      trace?.finishConceptExtraction(text, [], 'invalid', response.content);
    } catch {
      // Try to extract an array from a prose/markdown wrapper.
      const match = text.match(/\[([^\]]*)\]/);
      if (match) {
        try {
          const parsed = JSON.parse(`[${match[1]}]`);
          if (Array.isArray(parsed)) {
            const traceValues = parsed.filter((value): value is string => typeof value === 'string');
            trace?.finishConceptExtraction(text, traceValues, 'array-extraction', response.content);
            // Preserve the historical malformed-wrapper behavior exactly: mixed
            // arrays proceed to queryCandidates(), which then fails open rather
            // than silently becoming a different, partially valid concept set.
            return parsed as string[];
          }
        } catch { /* fall through */ }
      }
      trace?.finishConceptExtraction(text, [], 'invalid', response.content);
    }
    return [];
  }

  /**
   * Step 2: Mechanical keyword matching against lessons.
   */
  private queryCandidates(concepts: string[], lessons: Lesson[]): Lesson[] {
    const seen = new Set<string>();
    const candidates: Lesson[] = [];

    for (const concept of concepts) {
      const keywords = concept.toLowerCase().split(/\s+/);

      for (const lesson of lessons) {
        if (seen.has(lesson.id)) continue;

        const text = lesson.content.toLowerCase();
        const tags = lesson.tags.map(t => t.toLowerCase());

        // Match if any keyword appears in content or tags
        const matches = keywords.some(kw =>
          text.includes(kw) || tags.some(tag => tag.includes(kw))
        );

        if (matches) {
          seen.add(lesson.id);
          candidates.push(lesson);
        }
      }
    }

    const now = Date.now();
    candidates.sort((a, b) => rankScore(b, now) - rankScore(a, now));
    return candidates.slice(0, 20); // Cap at 20 candidates for validation
  }

  /**
   * Step 3: Use the configured retrieval model to validate which candidates are actually relevant.
   */
  private async validateRelevance(
    recentContext: string,
    candidates: Lesson[],
    trace?: RetrievalTraceRun,
  ): Promise<Lesson[]> {
    if (candidates.length <= 3) {
      // If only a few candidates, skip validation — they're probably all relevant.
      trace?.recordRelevanceSkipped('three-or-fewer-candidates');
      return candidates;
    }

    const model = this.config.retrievalModel ?? 'claude-haiku-4-5-20251001';
    const providerParams = this.retrievalProviderParams();

    const candidateList = candidates.map(l =>
      `[${l.id}] (${l.confidence.toFixed(2)}) ${l.content}`
    ).join('\n');
    const input = `Current conversation:\n${recentContext}\n\nCandidate lessons:\n${candidateList}`;

    const request: NormalizedRequest = {
      messages: [
        {
          participant: 'user',
          content: [{ type: 'text', text: input }],
        },
      ],
      system: RELEVANCE_VALIDATION_PROMPT,
      config: { model, maxTokens: 500, temperature: 0 },
      ...(providerParams ? { providerParams } : {}),
    };

    trace?.startRelevance(RELEVANCE_VALIDATION_PROMPT, input);
    let response;
    try {
      response = await this.config.membrane.complete(request);
    } catch (error) {
      trace?.recordStageError('relevance', error);
      throw error;
    }
    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('');

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const parsedIds = parsed.filter((value): value is string => typeof value === 'string');
        trace?.finishRelevance(text, parsedIds, 'json', response.content);
        const relevantIds = new Set(parsedIds);
        return candidates.filter(l => relevantIds.has(l.id));
      }
    } catch {
      // Fall through to confidence-ordered fallback.
    }

    const fallback = candidates.slice(0, 5);
    trace?.finishRelevance(text, [], 'fallback', response.content);
    return fallback;
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private getRecentContext(): RecentRetrievalContext | null {
    if (!this.ctx) return null;

    // Get the last few messages from the conversation.
    const { messages } = this.ctx.queryMessages({});
    if (messages.length === 0) return null;

    // Take the last 10 messages for context.
    const recent = messages.slice(-10);
    const text = recent
      .map(m => {
        const messageText = m.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map(b => b.text)
          .join('\n');
        return `${m.participant}: ${messageText}`;
      })
      .join('\n\n');
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

    return { text, messageCount: recent.length, messageIds };
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
