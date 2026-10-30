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
import { unknownToolResult } from './unknown-tool.js';
import type { Membrane, NormalizedRequest } from '@animalabs/membrane';
import { bodyBoundsIn, type BodyShard, type ContextInjection } from '@animalabs/context-manager';
import type { LessonsModule, Lesson } from './lessons-module.js';
import { storedInjectionMarkOf } from '@animalabs/agent-framework';
import {
  RetrievalTraceStore,
  type RetrievalTraceListOptions,
  type RetrievalTraceRun,
} from './retrieval-trace.js';

export type RetrievalReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RetrievalReasoningConfig {
  effort: RetrievalReasoningEffort;
}

interface RecentRetrievalContext {
  text: string;
  messageCount: number;
  messageIds: string[];
  opening: OpeningMessage | undefined;
}

interface OpeningMessage {
  key: string | null;
  excerpt: string | undefined;
}

interface TurnBlock {
  key: string | null;
  injections: ContextInjection[];
  lessonIds: string[];
  lessons: Lesson[];
  sourceTraceId: number | undefined;
}

const TURN_BLOCKS_MAX = 64;

const EXCERPT_CHARS = 60;

export interface RetrievalModuleConfig {
  membrane: Membrane;
  retrievalModel?: string;
  retrievalReasoning?: RetrievalReasoningConfig;
  maxInjectedLessons?: number;
  maxMessageTokens?: number;
  minConfidence?: number;
}

const CONCEPT_FLAG_PROMPT = `You are a knowledge retrieval assistant. Given the recent conversation below, identify concepts, entities, topics, or themes that might benefit from background knowledge or lessons learned from previous research.

Return ONLY a JSON array of keyword strings, nothing else. Example: ["RFC process", "authentication", "team lead"]

If nothing would benefit from background knowledge, return an empty array: []`;

const RELEVANCE_VALIDATION_PROMPT = `You are a relevance filter. Given the current conversation context and a set of candidate knowledge lessons, determine which lessons are actually relevant to the current discussion.

Return ONLY a JSON array of lesson IDs that are relevant, nothing else. Example: ["a1b2c3d4", "e5f6g7h8"]

If none are relevant, return an empty array: []`;


interface ShownRow {
  id?: unknown;
  participant: string;
  content: ReadonlyArray<{ type: string; text?: unknown }>;
  metadata?: unknown;
  bodyGroupId?: unknown;
  shardIndex?: unknown;
}

// context-manager's shard group id names the text, so two messages of the
// same text share it: `bodyBoundsIn` tells them apart by store order and
// shard index.
function bodyShardsOf(shown: readonly ShownRow[]): BodyShard[] {
  return shown.map(r => ({
    bodyGroupId: typeof r.bodyGroupId === 'string' ? r.bodyGroupId : undefined,
    shardIndex: typeof r.shardIndex === 'number' ? r.shardIndex : undefined,
  }));
}

const holdsATool = (row: ShownRow): boolean => row.content.some(b => b.type === 'tool_use' || b.type === 'tool_result');

const SELF_WAKE_SOURCE = 'gate:self-wake';

const TUNE_OUT_RELEASE_KIND = 'tune-out-cancel';

function openingMessageOf(shown: readonly ShownRow[], agentName: string): OpeningMessage | undefined {
  const bodies = bodyShardsOf(shown);
  for (let i = shown.length - 1; i >= 0; i--) {
    const row = shown[i]!;
    const { from, to } = bodyBoundsIn(bodies, i);
    if (!isAMessageTo(row, agentName) || shown.slice(from, to + 1).some(holdsATool)) {
      i = from;
      continue;
    }
    let id: unknown;
    try {
      id = row.id;
    } catch {
      return undefined;
    }
    if (typeof id !== 'string' && typeof id !== 'number') return undefined;
    return { key: String(id), excerpt: excerptOf(textOfMessage(shown, bodyBoundsIn(bodies, i))) };
  }
  return { key: null, excerpt: undefined };
}

function isAMessageTo(row: ShownRow, agentName: string): boolean {
  if (row.participant === agentName || row.participant === 'system') return false;
  const metadata = row.metadata as { system?: unknown; source?: unknown; kind?: unknown } | undefined;
  // agent-framework writes a tune-out's release into the residents' window as a system-marked row of this kind, and wakes the primary for it.
  if (metadata?.kind === TUNE_OUT_RELEASE_KIND) return true;
  return metadata?.system !== true && metadata?.source !== SELF_WAKE_SOURCE;
}

function textOfMessage(shown: readonly ShownRow[], { from, to }: { from: number; to: number }): string {
  const textOf = (r: ShownRow): string => r.content
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join(' ');
  return shown.slice(from, to + 1).map(textOf).join('');
}

function lessonLine(l: Lesson): string {
  return `- [${(l.confidence * 100).toFixed(0)}%] ${l.content} (tags: ${l.tags.join(', ')})`;
}

// Tokens are counted as context-manager's estimateTextOnlyTokens counts a
// text block (its length in UTF-16 code units / 4, rounded up), and a cap
// that isn't a positive number is none, as its capContent reads it, so the
// block fits exactly when the strategy wouldn't cut it.
function fitUnderCap(heading: string, lessons: Lesson[], cap: number | undefined): { text: string; lessons: Lesson[] } {
  const compose = (kept: string[], leftOut: number): string => [
    heading,
    ...kept,
    ...(leftOut > 0 ? [`(${leftOut} more relevant lesson${leftOut === 1 ? '' : 's'} left out, to keep this message under its size limit)`] : []),
  ].join('\n');
  const fits = (text: string): boolean => !(cap !== undefined && cap > 0) || Math.ceil(text.length / 4) <= cap;
  const all = compose(lessons.map(lessonLine), 0);
  if (fits(all)) return { text: all, lessons };
  const kept: Lesson[] = [];
  const lines: string[] = [];
  for (const lesson of lessons) {
    const line = lessonLine(lesson);
    if (fits(compose([...lines, line], lessons.length - kept.length - 1))) {
      kept.push(lesson);
      lines.push(line);
    }
  }
  return { text: compose(lines, lessons.length - kept.length), lessons: kept };
}

function excerptOf(text: string): string | undefined {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line === '') return undefined;
  const chars = Array.from(line);
  return chars.length <= EXCERPT_CHARS ? line : `${chars.slice(0, EXCERPT_CHARS).join('').trimEnd()}…`;
}

export class RetrievalModule implements Module {
  readonly name = 'retrieval';

  private ctx: ModuleContext | null = null;
  private config: RetrievalModuleConfig;
  private readonly turnBlocks = new Map<string, TurnBlock>();
  private starts = 0;
  private readonly latestStarts = new Map<string, number>();
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
    return [];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return unknownToolResult(this, call.name);
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

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

  async gatherContext(agentName: string): Promise<ContextInjection[]> {
    const start = ++this.starts;
    this.latestStarts.set(agentName, start);
    try {
      return await this.gather(agentName, start);
    } finally {
      if (this.latestStarts.get(agentName) === start) this.latestStarts.delete(agentName);
    }
  }

  private async gather(agentName: string, start: number): Promise<ContextInjection[]> {
    const trace = this.beginTrace(agentName);
    if (!this.ctx) {
      trace?.finish('not-started');
      return [];
    }

    let lessons: Lesson[];
    let recentMessages: string;
    let opening: OpeningMessage | undefined;
    try {
      const lessonsModule = this.ctx.getModule<LessonsModule>('lessons');
      if (!lessonsModule) {
        trace?.finish('no-lessons-module');
        return [];
      }

      lessons = lessonsModule.getLessons().filter(
        l => !l.deprecated && l.confidence >= (this.config.minConfidence ?? 0.3) && l.content.trim() !== ''
      );
      if (lessons.length === 0) {
        trace?.finish('no-eligible-lessons');
        return [];
      }

      const recent = this.getRecentContext(agentName);
      if (!recent) {
        trace?.finish('no-recent-context');
        return [];
      }
      recentMessages = recent.text;
      opening = recent.opening;

      trace?.setContext(this.hashContext(recentMessages), recentMessages, recent.messageCount, recent.messageIds);
      const kept = this.turnBlocks.get(agentName);
      if (opening && kept && kept.key === opening.key) {
        this.turnBlocks.delete(agentName);
        this.turnBlocks.set(agentName, kept);
        trace?.recordCacheHit(kept.sourceTraceId, kept.lessonIds, kept.lessons, kept.injections);
        trace?.finish('cache-hit');
        return kept.injections;
      }
    } catch (error) {
      trace?.finish('error', error);
      throw error;
    }

    try {
      const concepts = await this.flagConcepts(recentMessages, trace);
      if (concepts === null || concepts.length === 0) {
        if (concepts !== null) this.keepTurnBlock(agentName, start, opening, [], []);
        trace?.finish('no-concepts');
        return [];
      }

      const candidates = this.queryCandidates(concepts, lessons);
      trace?.recordCandidates(concepts, candidates);
      if (candidates.length === 0) {
        this.keepTurnBlock(agentName, start, opening, [], []);
        trace?.finish('no-candidates');
        return [];
      }

      const { lessons: relevant, validated } = await this.validateRelevance(recentMessages, candidates, trace);
      trace?.recordRelevant(relevant);

      const maxLessons = this.config.maxInjectedLessons ?? 5;
      const injected = relevant.slice(0, maxLessons);

      if (injected.length === 0) {
        if (validated) this.keepTurnBlock(agentName, start, opening, [], []);
        trace?.finish('no-relevant-lessons');
        return [];
      }

      const heading = opening?.excerpt !== undefined
        ? `## Retrieved Knowledge, for the message beginning "${opening.excerpt}"`
        : '## Retrieved Knowledge';
      const fitted = fitUnderCap(heading, injected, this.config.maxMessageTokens);
      if (fitted.lessons.length === 0) {
        if (validated) this.keepTurnBlock(agentName, start, opening, [], []);
        trace?.finish('too-large');
        return [];
      }
      const injections: ContextInjection[] = [{
        namespace: 'retrieval',
        // Not 'system': this changes every turn, and a provider caches a prompt
        // by its prefix, so a changing system prompt would lose the whole
        // cached prefix each turn.
        position: 'afterUser',
        content: [{ type: 'text', text: fitted.text }],
      }];

      if (validated) this.keepTurnBlock(agentName, start, opening, injections, this.safeLessonSnapshots(fitted.lessons), trace?.id);
      trace?.recordInjection(fitted.lessons, injections);
      trace?.finish('injected');
      return injections;
    } catch (err) {
      trace?.finish('error', err);
      console.error('RetrievalModule: retrieval failed:', err);
      return [];
    }
  }

  private retrievalProviderParams(): Record<string, unknown> | undefined {
    const reasoning = this.config.retrievalReasoning;
    if (!reasoning) return undefined;
    return { reasoning: { effort: reasoning.effort } };
  }

  private async flagConcepts(
    recentContext: string,
    trace?: RetrievalTraceRun,
  ): Promise<string[] | null> {
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
      const match = text.match(/\[([^\]]*)\]/);
      if (match) {
        try {
          const parsed = JSON.parse(`[${match[1]}]`);
          if (Array.isArray(parsed)) {
            const traceValues = parsed.filter((value): value is string => typeof value === 'string');
            trace?.finishConceptExtraction(text, traceValues, 'array-extraction', response.content);
            return parsed as string[];
          }
        } catch { }
      }
      trace?.finishConceptExtraction(text, [], 'invalid', response.content);
    }
    return null;
  }

  private queryCandidates(concepts: string[], lessons: Lesson[]): Lesson[] {
    const seen = new Set<string>();
    const candidates: Lesson[] = [];

    for (const concept of concepts) {
      const keywords = concept.toLowerCase().split(/\s+/);

      for (const lesson of lessons) {
        if (seen.has(lesson.id)) continue;

        const text = lesson.content.toLowerCase();
        const tags = lesson.tags.map(t => t.toLowerCase());

        const matches = keywords.some(kw =>
          text.includes(kw) || tags.some(tag => tag.includes(kw))
        );

        if (matches) {
          seen.add(lesson.id);
          candidates.push(lesson);
        }
      }
    }

    candidates.sort((a, b) => b.confidence - a.confidence);
    return candidates.slice(0, 20);
  }

  private async validateRelevance(
    recentContext: string,
    candidates: Lesson[],
    trace?: RetrievalTraceRun,
  ): Promise<{ lessons: Lesson[]; validated: boolean }> {
    if (candidates.length <= 3) {
      trace?.recordRelevanceSkipped('three-or-fewer-candidates');
      return { lessons: candidates, validated: true };
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
        return { lessons: candidates.filter(l => relevantIds.has(l.id)), validated: true };
      }
    } catch {
    }

    const fallback = candidates.slice(0, 5);
    trace?.finishRelevance(text, [], 'fallback', response.content);
    return { lessons: fallback, validated: false };
  }

  private keepTurnBlock(
    agentName: string,
    start: number,
    opening: OpeningMessage | undefined,
    injections: ContextInjection[],
    lessons: Lesson[],
    sourceTraceId?: number,
  ): void {
    if (!opening || this.latestStarts.get(agentName) !== start) return;
    this.turnBlocks.delete(agentName);
    this.turnBlocks.set(agentName, {
      key: opening.key,
      injections,
      lessons,
      lessonIds: this.safeLessonIds(lessons),
      sourceTraceId,
    });
    while (this.turnBlocks.size > TURN_BLOCKS_MAX) {
      const oldest = this.turnBlocks.keys().next().value as string;
      this.turnBlocks.delete(oldest);
    }
  }

  private getRecentContext(agentName: string): RecentRetrievalContext | null {
    if (!this.ctx) return null;

    // agent-framework marks a write it still holds `held`, and a row a tune-out
    // holds from the residents `heldFromResidents` (stamped
    // `metadata.tuneOut`), and shows a resident neither.
    const { messages } = this.ctx.queryMessages({}, { forAgent: agentName });
    const shown = messages.filter(m =>
      m.held !== true && m.heldFromResidents !== true && !(m.metadata as { tuneOut?: unknown } | undefined)?.tuneOut
      && storedInjectionMarkOf(m.metadata) === undefined);
    if (shown.length === 0) return null;

    const recent = shown.slice(-10);
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
        return [];
      }
    });

    return { text, messageCount: recent.length, messageIds, opening: openingMessageOf(shown, agentName) };
  }

  private safeLessonIds(lessons: Lesson[]): string[] {
    const ids: string[] = [];
    for (const lesson of lessons) {
      try {
        if (typeof lesson.id === 'string') ids.push(lesson.id);
      } catch {
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
      }
    }
    return snapshots;
  }

  private hashContext(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const chr = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return hash.toString(36);
  }
}
