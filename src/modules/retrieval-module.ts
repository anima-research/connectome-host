/**
 * RetrievalModule — LLM-as-retriever for semantic memory.
 *
 * Three-step retrieval pipeline running in gatherContext():
 *   1. Flag concepts (Haiku): identify concepts being discussed that might
 *      benefit from background knowledge
 *   2. Mechanical query: keyword-match against LessonsModule
 *   3. Validate relevance (Haiku): filter to actually relevant lessons
 *
 * Steps 1 and 3 use cheap Haiku calls (~$0.001 each).
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
import type { LessonsModule, Lesson } from './lessons-module.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RetrievalModuleConfig {
  /** Membrane instance for Haiku calls */
  membrane: Membrane;
  /** Model to use for retrieval calls (default: claude-haiku-4-5-20251001) */
  retrievalModel?: string;
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

  /**
   * Run the 3-step retrieval pipeline before each inference.
   */
  async gatherContext(_agentName: string): Promise<ContextInjection[]> {
    if (!this.ctx) return [];

    // Get the LessonsModule to query
    const lessonsModule = this.ctx.getModule<LessonsModule>('lessons');
    if (!lessonsModule) return [];

    const lessons = lessonsModule.getLessons().filter(
      l => !l.deprecated && l.confidence >= (this.config.minConfidence ?? 0.3)
    );
    if (lessons.length === 0) return [];

    // Get recent context for concept extraction
    const recentMessages = this.getRecentContext();
    if (!recentMessages) return [];

    // Check cache: if context hasn't changed, reuse cached results
    const contextHash = this.hashContext(recentMessages);
    if (contextHash === this.lastContextHash && this.cachedInjections.length > 0) {
      return this.cachedInjections;
    }

    try {
      // Step 1: Flag concepts (Haiku call)
      const concepts = await this.flagConcepts(recentMessages);
      if (concepts.length === 0) {
        this.lastContextHash = contextHash;
        this.cachedInjections = [];
        return [];
      }

      // Step 2: Mechanical query (keyword matching)
      const candidates = this.queryCandidates(concepts, lessons);
      if (candidates.length === 0) {
        this.lastContextHash = contextHash;
        this.cachedInjections = [];
        return [];
      }

      // Step 3: Validate relevance (Haiku call)
      const relevant = await this.validateRelevance(recentMessages, candidates);

      // Build injection
      const maxLessons = this.config.maxInjectedLessons ?? 5;
      const injected = relevant.slice(0, maxLessons);

      if (injected.length === 0) {
        this.lastContextHash = contextHash;
        this.cachedInjections = [];
        return [];
      }

      const text = injected
        .map(l => `- [${(l.confidence * 100).toFixed(0)}%] ${l.content} (tags: ${l.tags.join(', ')})`)
        .join('\n');

      const injections: ContextInjection[] = [{
        namespace: 'retrieval',
        position: 'system',
        content: [{ type: 'text', text: `## Retrieved Knowledge\n${text}` }],
      }];

      this.lastContextHash = contextHash;
      this.cachedInjections = injections;
      return injections;
    } catch (err) {
      // Fail open — don't block inference if retrieval fails
      console.error('RetrievalModule: retrieval failed:', err);
      return [];
    }
  }

  // =========================================================================
  // Pipeline Steps
  // =========================================================================

  /**
   * Step 1: Use Haiku to identify concepts that might benefit from background knowledge.
   */
  private async flagConcepts(recentContext: string): Promise<string[]> {
    const model = this.config.retrievalModel ?? 'claude-haiku-4-5-20251001';

    const request: NormalizedRequest = {
      messages: [
        {
          participant: 'user',
          content: [{ type: 'text', text: `Recent conversation:\n${recentContext}` }],
        },
      ],
      system: CONCEPT_FLAG_PROMPT,
      config: { model, maxTokens: 500, temperature: 0 },
    };

    const response = await this.config.membrane.complete(request);
    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('');

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.filter((s): s is string => typeof s === 'string');
      }
    } catch {
      // Try to extract from markdown code block
      const match = text.match(/\[([^\]]*)\]/);
      if (match) {
        try {
          return JSON.parse(`[${match[1]}]`);
        } catch { /* fall through */ }
      }
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

    // Sort by confidence
    candidates.sort((a, b) => b.confidence - a.confidence);
    return candidates.slice(0, 20); // Cap at 20 candidates for validation
  }

  /**
   * Step 3: Use Haiku to validate which candidates are actually relevant.
   */
  private async validateRelevance(recentContext: string, candidates: Lesson[]): Promise<Lesson[]> {
    if (candidates.length <= 3) {
      // If only a few candidates, skip validation — they're probably all relevant
      return candidates;
    }

    const model = this.config.retrievalModel ?? 'claude-haiku-4-5-20251001';

    const candidateList = candidates.map(l =>
      `[${l.id}] (${l.confidence.toFixed(2)}) ${l.content}`
    ).join('\n');

    const request: NormalizedRequest = {
      messages: [
        {
          participant: 'user',
          content: [{ type: 'text', text: `Current conversation:\n${recentContext}\n\nCandidate lessons:\n${candidateList}` }],
        },
      ],
      system: RELEVANCE_VALIDATION_PROMPT,
      config: { model, maxTokens: 500, temperature: 0 },
    };

    const response = await this.config.membrane.complete(request);
    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text)
      .join('');

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const relevantIds = new Set(parsed.filter((s): s is string => typeof s === 'string'));
        return candidates.filter(l => relevantIds.has(l.id));
      }
    } catch {
      // On parse failure, return top 5 by confidence (fail open)
      return candidates.slice(0, 5);
    }
    return candidates.slice(0, 5);
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private getRecentContext(): string | null {
    if (!this.ctx) return null;

    // Get the last few messages from the conversation
    const { messages } = this.ctx.queryMessages({});
    if (messages.length === 0) return null;

    // Take the last 10 messages for context
    const recent = messages.slice(-10);
    return recent
      .map(m => {
        const text = m.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map(b => b.text)
          .join('\n');
        return `${m.participant}: ${text}`;
      })
      .join('\n\n');
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
