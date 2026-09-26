/**
 * LessonsModule — persistent knowledge store backed by Chronicle.
 *
 * Lessons are units of extracted knowledge with:
 *   - Confidence scores (0–1)
 *   - Tags for categorization
 *   - Evidence links (source message references)
 *   - Usage strength: how often and how recently retrieval surfaced them
 *
 * Nothing is ever lost: `update` keeps prior wording in `previousContents`,
 * superseding deprecates rather than deletes, and `query` can search the
 * deprecated archive. What changes over time is salience — which lessons
 * retrieval ranks first — never whether they exist.
 *
 * `create` refuses near-duplicates of live lessons unless the caller
 * supersedes them or forces creation, so the store doesn't silently fill
 * with rephrasings of the same fact.
 *
 * Injection into the agent's context is RetrievalModule's job; it reports
 * each injection back via recordRetrieval().
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
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Lesson {
  id: string;
  content: string;
  confidence: number;
  tags: string[];
  evidence: string[];
  created: number;
  updated: number;
  deprecated: boolean;
  deprecationReason?: string;
  /** Prior wordings, oldest first, preserved when `update` changes content. */
  previousContents?: Array<{ content: string; replacedAt: number }>;
  /** ID of the lesson that replaced this one (set by create's `supersedes`). */
  supersededBy?: string;
  /** Times RetrievalModule injected this lesson. Absent = never. */
  retrievalCount?: number;
  /** Epoch ms of the most recent injection. */
  lastRetrieved?: number;
  /** Days until retrievability decays to 90%; grows with spaced retrievals. */
  stability?: number;
}

interface LessonsState {
  lessons: Lesson[];
}

interface CreateInput {
  content: string;
  tags: string[];
  evidence?: string[];
  confidence?: number;
  supersedes?: string[];
  force?: boolean;
}

interface UpdateInput {
  id: string;
  content?: string;
  tags?: string[];
  confidence?: number;
  evidence?: string[];
}

interface DeprecateInput {
  id: string;
  reason: string;
}

interface QueryInput {
  text?: string;
  tags?: string[];
  minConfidence?: number;
  limit?: number;
  includeDeprecated?: boolean;
}

interface ListInput {
  tags?: string[];
  sort?: 'confidence' | 'created' | 'updated' | 'strength';
  limit?: number;
  includeDeprecated?: boolean;
}

interface IdInput {
  id: string;
}

// ---------------------------------------------------------------------------
// Usage strength
// ---------------------------------------------------------------------------
//
// Power-law forgetting curve in the FSRS form R = (1 + t / 9S)^-1, where S is
// the number of days until R falls to 0.9. The FSRS-6 parameter fits are for
// humans reviewing flashcards and are deliberately not imported — only the
// shape and the spacing rule: a retrieval grows S in proportion to how much R
// had decayed, so injecting a lesson every turn of one session barely
// strengthens it while a lesson that keeps mattering across weeks does.
//
// Strength only ORDERS lessons. It never hides or deletes one: eligibility is
// still confidence >= minConfidence and !deprecated.

const DAY_MS = 86_400_000;
/** Stability of a lesson that has never been retrieved, in days. */
export const INITIAL_STABILITY_DAYS = 7;
/** Growth of S per retrieval, scaled by (1 - R): retrieving at R = 0.9 doubles S. */
const SPACING_GAIN = 10;
/** Share of rank that decay can never take away; confidence stays dominant. */
const STRENGTH_FLOOR = 0.5;

/** Current retrievability in (0, 1]; time is measured from the last retrieval, or creation. */
export function retrievability(lesson: Lesson, now: number): number {
  const since = lesson.lastRetrieved ?? lesson.created;
  const days = Math.max(0, now - since) / DAY_MS;
  const stability = lesson.stability ?? INITIAL_STABILITY_DAYS;
  return 1 / (1 + days / (9 * stability));
}

/** Ranking key: confidence, discounted by at most half for disuse. */
export function rankScore(lesson: Lesson, now: number): number {
  return lesson.confidence * (STRENGTH_FLOOR + (1 - STRENGTH_FLOOR) * retrievability(lesson, now));
}

// ---------------------------------------------------------------------------
// Near-duplicate detection
// ---------------------------------------------------------------------------
//
// Lexical, not semantic: Jaccard overlap of content words. It catches
// restatements and refinements that reuse the original's vocabulary; it misses
// paraphrases with disjoint wording. The creating agent judges each match — it
// either supersedes the old lesson, updates it instead, or forces creation.

/** Jaccard similarity at or above which a live lesson counts as a near-duplicate. */
export const DUPLICATE_THRESHOLD = 0.5;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'his', 'how', 'its', 'may', 'new',
  'now', 'see', 'two', 'way', 'who', 'did', 'get', 'let', 'say', 'she', 'too',
  'use', 'that', 'with', 'have', 'this', 'will', 'your', 'from', 'they', 'been',
  'were', 'when', 'what', 'which', 'their', 'there', 'than', 'then', 'them',
  'these', 'those', 'into', 'also', 'should', 'would', 'could', 'about',
]);

function contentWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

export function lexicalSimilarity(a: string, b: string): number {
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class LessonsModule implements Module {
  readonly name = 'lessons';

  private ctx: ModuleContext | null = null;
  private state: LessonsState = { lessons: [] };
  private globalPath: string | null;

  constructor(opts?: { globalPath?: string }) {
    this.globalPath = opts?.globalPath ?? null;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    const saved = ctx.getState<LessonsState>();
    if (saved) {
      this.state = saved;
    }
    // Merge in lessons from the global shared file
    if (this.globalPath) {
      this.mergeFromGlobal();
    }
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'create',
        description:
          'Create a new lesson (unit of extracted knowledge). Refused if it closely restates a live lesson: '
          + 'the refusal lists the matches, and you then either `update` the match, pass `supersedes` with '
          + 'the IDs it replaces, or pass `force: true` if it is genuinely distinct.',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The knowledge content' },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Categorization tags (e.g., people, process, decision, technical)',
            },
            evidence: {
              type: 'array',
              items: { type: 'string' },
              description: 'Source references (e.g., stream:topic:messageId)',
            },
            confidence: { type: 'number', description: 'Initial confidence 0–1 (default: 0.5)' },
            supersedes: {
              type: 'array',
              items: { type: 'string' },
              description: 'IDs of lessons this one replaces; they are deprecated and linked to it',
            },
            force: { type: 'boolean', description: 'Create even if near-duplicates exist' },
          },
          required: ['content', 'tags'],
        },
      },
      {
        name: 'update',
        description: 'Update an existing lesson. Changed content is kept in its revision history, not lost.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Lesson ID' },
            content: { type: 'string', description: 'Updated content' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Updated tags' },
            confidence: { type: 'number', description: 'Updated confidence' },
            evidence: { type: 'array', items: { type: 'string' }, description: 'Additional evidence' },
          },
          required: ['id'],
        },
      },
      {
        name: 'deprecate',
        description: 'Mark a lesson as deprecated (no longer considered accurate).',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Lesson ID' },
            reason: { type: 'string', description: 'Why this lesson is being deprecated' },
          },
          required: ['id', 'reason'],
        },
      },
      {
        name: 'query',
        description: 'Search lessons by text and/or tags.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text to search for (keyword matching)' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (any match)' },
            minConfidence: { type: 'number', description: 'Minimum confidence threshold' },
            limit: { type: 'number', description: 'Max results (default: 20)' },
            includeDeprecated: {
              type: 'boolean',
              description: 'Also search deprecated and superseded lessons (the archive)',
            },
          },
        },
      },
      {
        name: 'list',
        description: 'List all lessons, optionally filtered and sorted.',
        inputSchema: {
          type: 'object',
          properties: {
            tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
            sort: {
              type: 'string',
              description: 'Sort by: confidence, created, updated, or strength (confidence discounted for disuse) (default: confidence)',
            },
            limit: { type: 'number', description: 'Max results (default: 50)' },
            includeDeprecated: { type: 'boolean', description: 'Include deprecated lessons' },
          },
        },
      },
      {
        name: 'boost',
        description: 'Increase a lesson\'s confidence (it proved useful).',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Lesson ID' },
          },
          required: ['id'],
        },
      },
      {
        name: 'demote',
        description: 'Decrease a lesson\'s confidence (it was wrong or unhelpful).',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Lesson ID' },
          },
          required: ['id'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    switch (call.name) {
      case 'create': return this.handleCreate(call.input as CreateInput);
      case 'update': return this.handleUpdate(call.input as UpdateInput);
      case 'deprecate': return this.handleDeprecate(call.input as DeprecateInput);
      case 'query': return this.handleQuery(call.input as QueryInput);
      case 'list': return this.handleList(call.input as ListInput);
      case 'boost': return this.handleBoost(call.input as IdInput);
      case 'demote': return this.handleDemote(call.input as IdInput);
      default:
        return { success: false, error: `Unknown tool: ${call.name}`, isError: true };
    }
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  // Lesson injection is handled solely by RetrievalModule (intelligent retrieval
  // pipeline). LessonsModule provides storage + CRUD tools only.

  // Public accessor for other modules (e.g., RetrievalModule)
  getLessons(): Lesson[] {
    return this.state.lessons;
  }

  /**
   * Called by RetrievalModule for each lesson it injects. Deliberately leaves
   * `updated` alone: that field means "content changed" and decides conflicts
   * in mergeFromGlobal.
   */
  recordRetrieval(ids: string[], now = Date.now()): void {
    for (const id of ids) {
      const lesson = this.state.lessons.find(l => l.id === id);
      if (!lesson) throw new Error(`recordRetrieval: lesson not found: ${id}`);
      const r = retrievability(lesson, now);
      const stability = lesson.stability ?? INITIAL_STABILITY_DAYS;
      lesson.stability = stability * (1 + SPACING_GAIN * (1 - r));
      lesson.retrievalCount = (lesson.retrievalCount ?? 0) + 1;
      lesson.lastRetrieved = now;
    }
    this.save();
  }

  // =========================================================================
  // Tool Handlers
  // =========================================================================

  private handleCreate(input: CreateInput): ToolResult {
    const supersedes = input.supersedes ?? [];
    const superseded: Lesson[] = [];
    for (const id of supersedes) {
      const old = this.state.lessons.find(l => l.id === id);
      if (!old) return { success: false, error: `Lesson not found: ${id}`, isError: true };
      if (old.deprecated) return { success: false, error: `Lesson already deprecated: ${id}`, isError: true };
      superseded.push(old);
    }

    if (!input.force) {
      const duplicates = this.state.lessons
        .filter(l => !l.deprecated && !supersedes.includes(l.id))
        .map(l => ({ lesson: l, similarity: lexicalSimilarity(input.content, l.content) }))
        .filter(d => d.similarity >= DUPLICATE_THRESHOLD)
        .sort((a, b) => b.similarity - a.similarity);
      if (duplicates.length > 0) {
        const listing = duplicates
          .map(d => `[${d.lesson.id}] (similarity ${d.similarity.toFixed(2)}, confidence ${d.lesson.confidence.toFixed(2)}) ${d.lesson.content}`)
          .join('\n');
        return {
          success: false,
          isError: true,
          error:
            `Not created — near-duplicates of live lessons:\n${listing}\n`
            + 'Either retry with `supersedes: [ids]` if the new lesson replaces them (they stay searchable as '
            + 'deprecated), `update` one of these if it is a refinement, or retry with `force: true` if it is '
            + 'genuinely distinct.',
        };
      }
    }

    const lesson: Lesson = {
      id: randomUUID().slice(0, 8),
      content: input.content,
      confidence: input.confidence ?? 0.5,
      tags: input.tags,
      evidence: input.evidence ?? [],
      created: Date.now(),
      updated: Date.now(),
      deprecated: false,
    };

    this.state.lessons.push(lesson);
    for (const old of superseded) {
      old.deprecated = true;
      old.deprecationReason = `Superseded by ${lesson.id}`;
      old.supersededBy = lesson.id;
      old.updated = lesson.created;
    }
    this.save();

    return {
      success: true,
      data: {
        id: lesson.id,
        message: superseded.length > 0
          ? `Lesson created; superseded ${superseded.map(l => l.id).join(', ')}`
          : 'Lesson created',
      },
    };
  }

  private handleUpdate(input: UpdateInput): ToolResult {
    const lesson = this.state.lessons.find(l => l.id === input.id);
    if (!lesson) {
      return { success: false, error: `Lesson not found: ${input.id}`, isError: true };
    }

    if (input.content !== undefined && input.content !== lesson.content) {
      lesson.previousContents = [
        ...(lesson.previousContents ?? []),
        { content: lesson.content, replacedAt: Date.now() },
      ];
      lesson.content = input.content;
    }
    if (input.tags !== undefined) lesson.tags = input.tags;
    if (input.confidence !== undefined) lesson.confidence = Math.max(0, Math.min(1, input.confidence));
    if (input.evidence !== undefined) {
      // Merge evidence, dedup
      const existing = new Set(lesson.evidence);
      for (const e of input.evidence) existing.add(e);
      lesson.evidence = [...existing];
    }
    lesson.updated = Date.now();
    this.save();

    return { success: true, data: { id: lesson.id, message: 'Lesson updated' } };
  }

  private handleDeprecate(input: DeprecateInput): ToolResult {
    const lesson = this.state.lessons.find(l => l.id === input.id);
    if (!lesson) {
      return { success: false, error: `Lesson not found: ${input.id}`, isError: true };
    }

    lesson.deprecated = true;
    lesson.deprecationReason = input.reason;
    lesson.updated = Date.now();
    this.save();

    return { success: true, data: { id: lesson.id, message: 'Lesson deprecated' } };
  }

  private handleQuery(input: QueryInput): ToolResult {
    const limit = input.limit ?? 20;
    let results = input.includeDeprecated
      ? [...this.state.lessons]
      : this.state.lessons.filter(l => !l.deprecated);

    // Filter by minimum confidence
    if (input.minConfidence !== undefined) {
      results = results.filter(l => l.confidence >= input.minConfidence!);
    }

    // Filter by tags (any match)
    if (input.tags && input.tags.length > 0) {
      const tagSet = new Set(input.tags.map(t => t.toLowerCase()));
      results = results.filter(l =>
        l.tags.some(t => tagSet.has(t.toLowerCase()))
      );
    }

    // Text search (simple keyword matching)
    if (input.text) {
      const keywords = input.text.toLowerCase().split(/\s+/);
      results = results.filter(l => {
        const text = l.content.toLowerCase();
        return keywords.some(kw => text.includes(kw));
      });
    }

    // Sort by relevance (confidence descending)
    results.sort((a, b) => b.confidence - a.confidence);

    return {
      success: true,
      data: {
        count: results.length,
        lessons: results.slice(0, limit).map(l => ({
          id: l.id,
          content: l.content,
          confidence: l.confidence,
          tags: l.tags,
          evidence: l.evidence,
          retrievalCount: l.retrievalCount ?? 0,
          ...(l.deprecated
            ? { deprecated: true, deprecationReason: l.deprecationReason, supersededBy: l.supersededBy }
            : {}),
          ...(l.previousContents ? { previousContents: l.previousContents } : {}),
        })),
      },
    };
  }

  private handleList(input: ListInput): ToolResult {
    const limit = input.limit ?? 50;
    let results = input.includeDeprecated
      ? [...this.state.lessons]
      : this.state.lessons.filter(l => !l.deprecated);

    // Filter by tags
    if (input.tags && input.tags.length > 0) {
      const tagSet = new Set(input.tags.map(t => t.toLowerCase()));
      results = results.filter(l =>
        l.tags.some(t => tagSet.has(t.toLowerCase()))
      );
    }

    // Sort
    const sort = input.sort ?? 'confidence';
    switch (sort) {
      case 'confidence':
        results.sort((a, b) => b.confidence - a.confidence);
        break;
      case 'created':
        results.sort((a, b) => b.created - a.created);
        break;
      case 'updated':
        results.sort((a, b) => b.updated - a.updated);
        break;
      case 'strength': {
        const now = Date.now();
        results.sort((a, b) => rankScore(b, now) - rankScore(a, now));
        break;
      }
    }

    return {
      success: true,
      data: {
        total: results.length,
        lessons: results.slice(0, limit).map(l => ({
          id: l.id,
          content: l.content,
          confidence: l.confidence,
          tags: l.tags,
          deprecated: l.deprecated,
          retrievalCount: l.retrievalCount ?? 0,
        })),
      },
    };
  }

  private handleBoost(input: IdInput): ToolResult {
    const lesson = this.state.lessons.find(l => l.id === input.id);
    if (!lesson) {
      return { success: false, error: `Lesson not found: ${input.id}`, isError: true };
    }

    // Diminishing returns boost
    lesson.confidence = Math.min(1, lesson.confidence + 0.1 * (1 - lesson.confidence));
    lesson.updated = Date.now();
    this.save();

    return { success: true, data: { id: lesson.id, confidence: lesson.confidence } };
  }

  private handleDemote(input: IdInput): ToolResult {
    const lesson = this.state.lessons.find(l => l.id === input.id);
    if (!lesson) {
      return { success: false, error: `Lesson not found: ${input.id}`, isError: true };
    }

    // Diminishing returns demote
    lesson.confidence = Math.max(0, lesson.confidence - 0.1 * lesson.confidence);
    lesson.updated = Date.now();
    this.save();

    return { success: true, data: { id: lesson.id, confidence: lesson.confidence } };
  }

  private save(): void {
    this.ctx?.setState(this.state);
    if (this.globalPath) {
      this.saveToGlobal();
    }
  }

  /** Merge lessons from the global JSON file. Newer `updated` wins on ID conflicts. */
  private mergeFromGlobal(): void {
    if (!this.globalPath) return;
    let global: LessonsState;
    try {
      global = JSON.parse(readFileSync(this.globalPath, 'utf-8'));
    } catch {
      return; // File doesn't exist yet — nothing to merge
    }
    if (!Array.isArray(global.lessons)) return;

    const byId = new Map(this.state.lessons.map(l => [l.id, l]));
    let merged = false;
    for (const gl of global.lessons) {
      const existing = byId.get(gl.id);
      if (!existing) {
        this.state.lessons.push(gl);
        merged = true;
      } else if (gl.updated > existing.updated) {
        Object.assign(existing, gl);
        merged = true;
      }
    }
    if (merged) {
      this.ctx?.setState(this.state);
    }
  }

  /** Write current lessons to the global JSON file. */
  private saveToGlobal(): void {
    if (!this.globalPath) return;
    try {
      mkdirSync(dirname(this.globalPath), { recursive: true });
      writeFileSync(this.globalPath, JSON.stringify({ lessons: this.state.lessons }, null, 2));
    } catch {
      // Best-effort — don't break the module if the file can't be written
    }
  }
}
