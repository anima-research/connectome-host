/**
 * LessonsModule — persistent knowledge store backed by Chronicle.
 *
 * Lessons are units of extracted knowledge with:
 *   - Confidence scores (0–1)
 *   - Tags for categorization
 *   - Evidence links (source message references)
 *
 * The module also implements gatherContext() to auto-inject
 * relevant lessons into the agent's context before inference.
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
import { readFileSync, writeFileSync, mkdirSync, renameSync, copyFileSync } from 'node:fs';
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
}

interface LessonsState {
  lessons: Lesson[];
}

interface CreateInput {
  content: string;
  tags: string[];
  evidence?: string[];
  confidence?: number;
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
}

interface ListInput {
  tags?: string[];
  sort?: 'confidence' | 'created' | 'updated';
  limit?: number;
  includeDeprecated?: boolean;
}

interface IdInput {
  id: string;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class LessonsModule implements Module {
  readonly name = 'lessons';

  private ctx: ModuleContext | null = null;
  private state: LessonsState = { lessons: [] };
  private globalPath: string | null;

  /** Debounce timer for the global-file save (coalesces mutation bursts). */
  private globalSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** True when in-memory lessons have changed since the last global-file write. */
  private globalSaveDirty = false;
  /** Set once a corrupt global file has been backed up, to avoid re-backing-up on every flush. */
  private corruptBackupDone = false;

  private static readonly GLOBAL_SAVE_DEBOUNCE_MS = 100;

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
    // Flush any pending debounced global save so nothing is lost at shutdown.
    // framework.stop() awaits module.stop(), so this is a reliable flush point.
    this.flushGlobal();
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'create',
        description: 'Create a new lesson (unit of extracted knowledge).',
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
          },
          required: ['content', 'tags'],
        },
      },
      {
        name: 'update',
        description: 'Update an existing lesson.',
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
              description: 'Sort by: confidence, created, or updated (default: confidence)',
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

  // =========================================================================
  // Tool Handlers
  // =========================================================================

  private handleCreate(input: CreateInput): ToolResult {
    const lesson: Lesson = {
      // Full UUID: an 8-char prefix collides far too easily and silently
      // merges unrelated lessons across processes sharing the global file.
      id: randomUUID(),
      content: input.content,
      confidence: Math.max(0, Math.min(1, input.confidence ?? 0.5)),
      tags: input.tags,
      evidence: input.evidence ?? [],
      created: Date.now(),
      updated: Date.now(),
      deprecated: false,
    };

    this.state.lessons.push(lesson);
    this.save();

    return { success: true, data: { id: lesson.id, message: 'Lesson created' } };
  }

  private handleUpdate(input: UpdateInput): ToolResult {
    const lesson = this.state.lessons.find(l => l.id === input.id);
    if (!lesson) {
      return { success: false, error: `Lesson not found: ${input.id}`, isError: true };
    }

    if (input.content !== undefined) lesson.content = input.content;
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
    let results = this.state.lessons.filter(l => !l.deprecated);

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
      this.scheduleGlobalSave();
    }
  }

  /**
   * Debounced global save: coalesce mutation bursts into one write ~100ms
   * after the last mutation, so we don't do a full-file sync write (plus a
   * read-merge) on every single tool call. stop() flushes anything pending.
   */
  private scheduleGlobalSave(): void {
    this.globalSaveDirty = true;
    if (this.globalSaveTimer) return; // a flush is already scheduled
    this.globalSaveTimer = setTimeout(() => {
      this.globalSaveTimer = null;
      this.flushGlobal();
    }, LessonsModule.GLOBAL_SAVE_DEBOUNCE_MS);
  }

  /** Flush a pending global save immediately (no-op if nothing is dirty). */
  private flushGlobal(): void {
    if (this.globalSaveTimer) {
      clearTimeout(this.globalSaveTimer);
      this.globalSaveTimer = null;
    }
    if (!this.globalSaveDirty || !this.globalPath) return;
    this.globalSaveDirty = false;
    this.saveToGlobal();
  }

  /**
   * Read the global lessons file.
   * Returns null if the file simply doesn't exist yet (normal on first run).
   * If the file exists but can't be parsed, it is backed up to
   * `<path>.corrupt-<timestamp>` and a loud error is logged, then null is
   * returned — callers may proceed with in-memory data because the corrupt
   * original is preserved in the backup. If the backup itself fails, this
   * THROWS so callers refuse to overwrite the only copy of the data.
   */
  private readGlobal(): LessonsState | null {
    if (!this.globalPath) return null;
    let raw: string;
    try {
      raw = readFileSync(this.globalPath, 'utf-8');
    } catch {
      return null; // File doesn't exist yet — nothing to merge
    }
    try {
      const parsed = JSON.parse(raw) as LessonsState;
      if (!Array.isArray(parsed.lessons)) {
        throw new Error('parsed JSON has no "lessons" array');
      }
      return parsed;
    } catch (err) {
      if (this.corruptBackupDone) return null; // already backed up + logged
      const backupPath = `${this.globalPath}.corrupt-${Date.now()}`;
      try {
        copyFileSync(this.globalPath, backupPath);
      } catch (backupErr) {
        console.error(
          `[LessonsModule] CORRUPT global lessons file at ${this.globalPath} ` +
          `(${String(err)}) and the backup copy FAILED (${String(backupErr)}). ` +
          `Refusing to overwrite the corrupt file.`
        );
        throw backupErr;
      }
      this.corruptBackupDone = true;
      console.error(
        `[LessonsModule] CORRUPT global lessons file at ${this.globalPath}: ${String(err)}. ` +
        `Backed it up to ${backupPath} before any further writes. ` +
        `Proceeding with in-memory lessons only — recover manually from the backup if needed.`
      );
      return null;
    }
  }

  /** Merge lessons into in-memory state. Newer `updated` wins on ID conflicts. */
  private mergeLessons(incoming: Lesson[]): boolean {
    const byId = new Map(this.state.lessons.map(l => [l.id, l]));
    let merged = false;
    for (const gl of incoming) {
      const existing = byId.get(gl.id);
      if (!existing) {
        this.state.lessons.push(gl);
        byId.set(gl.id, gl);
        merged = true;
      } else if (gl.updated > existing.updated) {
        Object.assign(existing, gl);
        merged = true;
      }
    }
    return merged;
  }

  /** Merge lessons from the global JSON file (called at start()). */
  private mergeFromGlobal(): void {
    if (!this.globalPath) return;
    let global: LessonsState | null;
    try {
      global = this.readGlobal();
    } catch {
      return; // corrupt file whose backup failed — already logged loudly
    }
    if (!global) return;
    if (this.mergeLessons(global.lessons)) {
      this.ctx?.setState(this.state);
    }
  }

  /**
   * Write current lessons to the global JSON file.
   *
   * Read-merge-write: re-read the file first and merge (per-lesson, newer
   * `updated` wins) so lessons written by OTHER processes since our last read
   * aren't clobbered by a whole-file overwrite. NOTE: a small race window
   * remains between the read and the rename — two processes flushing within
   * that window can still lose one side's concurrent update to the SAME
   * lesson; closing it fully would need a cross-process lock. Read-merge-write
   * plus atomic rename covers the realistic failure mode (distinct lessons,
   * mutations spaced apart).
   */
  private saveToGlobal(): void {
    if (!this.globalPath) return;
    try {
      mkdirSync(dirname(this.globalPath), { recursive: true });

      // Merge in whatever is on disk right now. readGlobal() throws if the
      // file is corrupt and could not be backed up — in that case we abort
      // the write rather than destroy the only copy of the data.
      const global = this.readGlobal();
      if (global && this.mergeLessons(global.lessons)) {
        this.ctx?.setState(this.state);
      }

      // Atomic write: tmp file in the same directory + rename, so concurrent
      // readers never observe a partially written file.
      const tmpPath = `${this.globalPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
      writeFileSync(tmpPath, JSON.stringify({ lessons: this.state.lessons }, null, 2));
      renameSync(tmpPath, this.globalPath);
    } catch (err) {
      // Best-effort — don't break the module if the file can't be written,
      // but say so instead of failing silently.
      console.error(`[LessonsModule] failed to save global lessons file: ${String(err)}`);
    }
  }
}
