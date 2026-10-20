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
import {
  readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, chmodSync, statSync, lstatSync, realpathSync, accessSync,
  openSync, fsyncSync, closeSync, constants, type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { unknownToolResult } from './unknown-tool.js';
import { shown } from './shown.js';

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

/** A lesson as it's stored. A record an earlier version wrote, or one written
 *  by hand into the shared lessons file, can lack its content, tags or
 *  evidence, or hold a confidence outside 0 to 1, as text, or none that's a
 *  number, so every reader takes it through readable(), and the record stays
 *  as stored. */
type StoredLesson = Omit<Lesson, 'content' | 'tags' | 'evidence' | 'confidence'> &
  { content?: unknown; tags?: unknown; evidence?: unknown; confidence?: unknown };

interface LessonsState {
  lessons: StoredLesson[];
  /** The ids the last read that could read the shared file found it
   *  holding more than once, of lessons this host holds once. The first
   *  read that finds one held once again takes the file's copy, whatever
   *  the stamps (see mergeShared). */
  heldTwice?: string[];
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
  /** The shared file's problem this host last named, and whether reading or
   *  writing the file met it, so each is named once and its end is told. */
  private sharedProblem: { text: string; on: 'read' | 'write' } | null = null;
  /** The line the last save gave for this host's lessons it couldn't write,
   *  so each is said once. */
  private unwrittenLine = '';
  /** The line last given for the shared file's entries this host carries
   *  without loading, so it's said again only when they change. */
  private carriedSaid = '';
  /** The errors, by code, for which this host has said its writes of the
   *  shared file go in place, so each is said once. */
  private inPlaceSaid = new Set<string>();

  constructor(opts?: { globalPath?: string }) {
    this.globalPath = opts?.globalPath ?? null;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    const saved = ctx.getState<LessonsState>();
    if (saved) {
      this.state = saved;
    }
    // Merge in lessons from the shared file. Nothing is written at start.
    if (this.globalPath) {
      const read = readSharedFile(this.globalPath);
      this.noteRead(read);
      if (read.kind === 'read') {
        const { carried, changed } = this.mergeShared(read.entries);
        this.noteCarried(carried);
        if (changed) ctx.setState(this.state);
      }
    }
    // Each lesson stored with a fault is named once per load for whoever
    // runs the host, with the mark the agent's list gives it; see readable()
    // for how readers take it.
    for (const l of this.state.lessons) {
      if (l.deprecated) continue;
      const line = loadLine(l);
      if (line) console.warn(line);
    }
  }

  async stop(): Promise<void> {
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
            confidence: { type: 'number', description: 'Updated confidence, from 0 to 1' },
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
    const input: unknown = call.input ?? {};
    switch (call.name) {
      case 'create': return this.handleCreate(input as CreateInput);
      case 'update': return this.handleUpdate(input as UpdateInput);
      case 'deprecate': return this.handleDeprecate(input as DeprecateInput);
      case 'query': return this.handleQuery(input as QueryInput);
      case 'list': return this.handleList(input as ListInput);
      case 'boost': return this.handleBoost(input as IdInput);
      case 'demote': return this.handleDemote(input as IdInput);
      default:
        return unknownToolResult(this, call.name);
    }
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  // Lesson injection is handled solely by RetrievalModule (intelligent retrieval
  // pipeline). LessonsModule provides storage + CRUD tools only.

  // Public accessor for other modules (e.g., RetrievalModule)
  getLessons(): Lesson[] {
    return this.readableLessons();
  }

  /** Every lesson as readers see it; see readable(). */
  private readableLessons(): Lesson[] {
    return this.state.lessons.map(readable);
  }

  /** Each lesson as stored, with how readers see it and what the agent's
   *  mark says it needs. A filter or a sort carries each lesson's own
   *  record, so two that share an id don't take each other's. /export
   *  writes the stored records as data and shows the readable ones. */
  getLessonRecords(): Array<{ stored: unknown; lesson: Lesson; needsFix?: string }> {
    return this.state.lessons.map(stored => {
      const fix = stored.deprecated ? undefined : needsFix(stored);
      return { stored, lesson: readable(stored), ...(fix ? { needsFix: fix } : {}) };
    });
  }

  // =========================================================================
  // Tool Handlers
  // =========================================================================

  private handleCreate(input: CreateInput): ToolResult {
    // A lesson stored without its content or tags reads as having none, and
    // stays marked until it's fixed, so a call that would store one is refused.
    const problems = inputProblems(input, true);
    if (problems.length > 0) {
      return { success: false, isError: true, error: `Nothing was created: ${problems.join('; ')}.` };
    }

    const read = this.refresh();
    const lesson: Lesson = {
      id: this.freshId(read),
      content: input.content,
      confidence: input.confidence ?? 0.5,
      tags: input.tags,
      evidence: input.evidence ?? [],
      created: Date.now(),
      updated: Date.now(),
      deprecated: false,
    };

    this.state.lessons.push(lesson);
    this.save(read);

    return { success: true, data: { id: lesson.id, message: 'Lesson created' } };
  }

  private handleUpdate(input: UpdateInput): ToolResult {
    const read = this.refresh();
    const lesson = findLesson(this.state.lessons, input.id);
    const problems = inputProblems(input, false);
    if (!lesson) return notFound('updated', input.id, problems.join('; ') || undefined);
    const heldTwice = heldTwiceRefusal(read, lesson, 'updated', this.state.heldTwice);
    if (heldTwice) return heldTwice;
    if (problems.length > 0) {
      return { success: false, isError: true, error: `Nothing was updated: ${problems.join('; ')}.` };
    }

    if (input.content !== undefined) lesson.content = input.content;
    if (input.tags !== undefined) lesson.tags = input.tags;
    if (input.confidence !== undefined) lesson.confidence = input.confidence;
    if (input.evidence !== undefined) {
      // Merge evidence, dedup, keeping every stored value: a lone one is
      // the list's first entry
      const existing = new Set(storedEvidence(lesson.evidence));
      for (const e of input.evidence) existing.add(e);
      lesson.evidence = [...existing];
    }
    lesson.updated = laterStamp(lesson);
    this.save(read);

    return { success: true, data: { id: lesson.id, message: 'Lesson updated' } };
  }

  private handleDeprecate(input: DeprecateInput): ToolResult {
    const read = this.refresh();
    const lesson = findLesson(this.state.lessons, input.id);
    const reason: unknown = input.reason;
    const reasonProblem = typeof reason === 'string'
      ? reason.trim() === '' ? 'reason is blank: say why the lesson is no longer accurate' : undefined
      : reason === undefined
        ? 'reason is missing: say why the lesson is no longer accurate'
        : `reason must be text, not ${shown(reason)}`;
    if (!lesson) return notFound('deprecated', input.id, reasonProblem);
    const heldTwice = heldTwiceRefusal(read, lesson, 'deprecated', this.state.heldTwice);
    if (heldTwice) return heldTwice;
    if (reasonProblem) return { success: false, isError: true, error: `Nothing was deprecated: ${reasonProblem}.` };

    lesson.deprecated = true;
    lesson.deprecationReason = input.reason;
    lesson.updated = laterStamp(lesson);
    this.save(read);

    return { success: true, data: { id: lesson.id, message: 'Lesson deprecated' } };
  }

  private handleQuery(input: QueryInput): ToolResult {
    const limit = input.limit ?? 20;
    let results = this.getLessonRecords().filter(r => !r.lesson.deprecated);

    // Filter by minimum confidence
    if (input.minConfidence !== undefined) {
      results = results.filter(r => r.lesson.confidence >= input.minConfidence!);
    }

    // Filter by tags (any match)
    if (input.tags && input.tags.length > 0) {
      const tagSet = new Set(input.tags.map(t => t.toLowerCase()));
      results = results.filter(r =>
        r.lesson.tags.some(t => tagSet.has(t.toLowerCase()))
      );
    }

    // Text search (simple keyword matching)
    if (input.text) {
      const keywords = input.text.toLowerCase().split(/\s+/);
      results = results.filter(r => {
        const text = r.lesson.content.toLowerCase();
        return keywords.some(kw => text.includes(kw));
      });
    }

    // Sort by relevance (confidence descending)
    results.sort((a, b) => b.lesson.confidence - a.lesson.confidence);

    return {
      success: true,
      data: {
        count: results.length,
        lessons: results.slice(0, limit).map(({ stored, lesson: l, needsFix: fix }) => ({
          id: l.id,
          content: l.content,
          // As stored, so a confidence outside 0 to 1, or stored as text,
          // shows as it is.
          confidence: (stored as StoredLesson).confidence,
          tags: l.tags,
          evidence: l.evidence,
          ...(fix ? { needsFix: fix } : {}),
        })),
      },
    };
  }

  private handleList(input: ListInput): ToolResult {
    const limit = input.limit ?? 50;
    const all = this.getLessonRecords();
    let results = input.includeDeprecated ? all : all.filter(r => !r.lesson.deprecated);

    // Filter by tags
    if (input.tags && input.tags.length > 0) {
      const tagSet = new Set(input.tags.map(t => t.toLowerCase()));
      results = results.filter(r =>
        r.lesson.tags.some(t => tagSet.has(t.toLowerCase()))
      );
    }

    // Sort
    const sort = input.sort ?? 'confidence';
    switch (sort) {
      case 'confidence':
        results.sort((a, b) => b.lesson.confidence - a.lesson.confidence);
        break;
      case 'created':
        results.sort((a, b) => b.lesson.created - a.lesson.created);
        break;
      case 'updated':
        results.sort((a, b) => b.lesson.updated - a.lesson.updated);
        break;
    }

    return {
      success: true,
      data: {
        total: results.length,
        // A deprecated lesson has no mark: deprecating it is a fix.
        lessons: results.slice(0, limit).map(({ stored, lesson: l, needsFix: fix }) => ({
          id: l.id,
          content: l.content,
          // As stored, so a confidence outside 0 to 1, or stored as text,
          // shows as it is.
          confidence: (stored as StoredLesson).confidence,
          tags: l.tags,
          deprecated: l.deprecated,
          ...(fix ? { needsFix: fix } : {}),
        })),
      },
    };
  }

  private handleBoost(input: IdInput): ToolResult {
    const read = this.refresh();
    const lesson = findLesson(this.state.lessons, input.id);
    if (!lesson) return notFound('boosted', input.id);
    const heldTwice = heldTwiceRefusal(read, lesson, 'boosted', this.state.heldTwice);
    if (heldTwice) return heldTwice;

    const refused = adjustRefusal(lesson, 'boost');
    if (refused) return { success: false, error: refused, isError: true };

    // Diminishing returns boost; one stored as text that holds a number
    // starts from that number.
    const base = confidenceValue(lesson.confidence);
    lesson.confidence = Math.min(1, base + 0.1 * (1 - base));
    lesson.updated = laterStamp(lesson);
    this.save(read);

    return { success: true, data: { id: lesson.id, confidence: lesson.confidence } };
  }

  private handleDemote(input: IdInput): ToolResult {
    const read = this.refresh();
    const lesson = findLesson(this.state.lessons, input.id);
    if (!lesson) return notFound('demoted', input.id);
    const heldTwice = heldTwiceRefusal(read, lesson, 'demoted', this.state.heldTwice);
    if (heldTwice) return heldTwice;

    const refused = adjustRefusal(lesson, 'demote');
    if (refused) return { success: false, error: refused, isError: true };

    // Diminishing returns demote; one stored as text that holds a number
    // starts from that number.
    const base = confidenceValue(lesson.confidence);
    lesson.confidence = Math.max(0, base - 0.1 * base);
    lesson.updated = laterStamp(lesson);
    this.save(read);

    return { success: true, data: { id: lesson.id, confidence: lesson.confidence } };
  }

  /** Before a call changes a lesson: read the shared file and merge it in,
   *  so the change is made to the newest copy, and stamped past it (see
   *  laterStamp). The read is what the call's save writes back, with nothing
   *  awaited between. Another host that writes in between has its change
   *  written over, and its next change writes it back, unless this call
   *  changed the same lesson with the same or a later stamp. */
  private refresh(): SharedRead | null {
    if (!this.globalPath) return null;
    const read = readSharedFile(this.globalPath);
    this.noteRead(read);
    if (read.kind === 'read') {
      const { carried, changed } = this.mergeShared(read.entries);
      this.noteCarried(carried);
      // Kept now, so a call refused after this read doesn't lose what the
      // merge learned, such as an id the file holds twice.
      if (changed) this.ctx?.setState(this.state);
    }
    return read;
  }

  /** An id for a new lesson that neither this host nor the shared file, as
   *  this call read it, holds, so the merge doesn't take two lessons for
   *  one. When the call couldn't read the file, only this host's ids are
   *  checked. */
  private freshId(read: SharedRead | null): string {
    const taken = new Set(this.state.lessons.map(idOf));
    if (read?.kind === 'read') for (const e of read.entries) taken.add(idOf(e));
    let id: string;
    do id = randomUUID().slice(0, 8); while (taken.has(id));
    return id;
  }

  /** Keep the module's lessons, and with a shared file, write back the file
   *  as the call read it, with this host's lessons merged in: each entry
   *  where it stood, this host's copy in the place of each lesson it holds
   *  by a named id, its new lessons at the end, and the document's other
   *  keys as they were (see writeShared for how). A file the call couldn't
   *  read as a lessons file was named at that read, and isn't written over. */
  private save(read: SharedRead | null): void {
    this.ctx?.setState(this.state);
    if (!this.globalPath || !read || read.kind === 'unreadable') return;
    const doc: Record<string, unknown> = read.kind === 'read' ? read.doc : {};
    const entries: unknown[] = read.kind === 'read' ? read.entries : [];
    const named = namedIds(entries, this.state.lessons);
    const mine = new Map<string, StoredLesson>();
    for (const l of this.state.lessons) {
      const id = idOf(l);
      if (id !== undefined && named.has(id)) mine.set(id, l);
    }
    const lessons = entries.map((entry) => {
      const id = idOf(entry);
      const l = id === undefined ? undefined : mine.get(id);
      if (!l) return entry;
      mine.delete(id!);
      return l;
    });
    lessons.push(...mine.values());
    // Said before the write in place is tried, since it's there to explain
    // one that breaks the file.
    const inPlace = (key: string, why: string): void => {
      if (this.inPlaceSaid.has(key)) return;
      this.inPlaceSaid.add(key);
      console.warn(`[lessons] the shared lessons file ${this.globalPath} is written in place, since ${why}: a write that fails partway can leave it broken.`);
    };
    try {
      writeShared(this.globalPath, JSON.stringify({ ...doc, lessons }, null, 2), inPlace);
    } catch (err) {
      // A write in place that failed partway can have left the file broken,
      // and a file that doesn't read as a lessons file isn't written: named
      // as its read problem, so the next read finding it doesn't name it again.
      const after = readSharedFile(this.globalPath);
      if (after.kind === 'unreadable') this.sayShared(after.problem, 'read', `couldn't be written (${errorText(err)}), and now `);
      else this.sayShared(`couldn't be written (${errorText(err)})`, 'write');
      return;
    }
    const made = read.kind === 'absent';
    // A problem still standing here is a write's: a read's ended at the
    // call's read (noteRead).
    if (this.sharedProblem !== null) {
      this.sharedProblem = null;
      const how = made ? "it wasn't there, so this host wrote it with its lessons" : 'this host merged its lessons in and wrote it';
      console.warn(`[lessons] the shared lessons file ${this.globalPath} can be written again: ${how}.`);
    } else if (made) {
      console.warn(`[lessons] the shared lessons file ${this.globalPath} wasn't there: this host wrote it with its lessons.`);
    }
    // A lesson whose id another lesson holds too, in the file or on this
    // host, can't be told apart by the merge, so it isn't written. Nor is
    // one without a usable id, which the agent's list marks unless it's
    // deprecated (see needsFix).
    const unwritten = this.state.lessons.filter((l) => {
      const id = idOf(l);
      return id !== undefined && !named.has(id);
    });
    const one = unwritten.length === 1;
    const ids = [...new Set(unwritten.map(idOf))] as string[];
    // For an id the file holds more than once, what keeps every lesson.
    // Only for a lesson this host holds once: two it holds stay unwritten
    // however the file is resolved.
    const inFile = idCounts(entries);
    const onHost = idCounts(this.state.lessons);
    const advice = ids.filter((id) => (inFile.get(id) ?? 0) > 1 && onHost.get(id) === 1)
      .map((id) => ` To keep every lesson with the id ${shown(id)}, ${newIdAdvice(entries, id)}.`).join('');
    const line = unwritten.length === 0 ? '' :
      `[lessons] the shared lessons file ${this.globalPath}, or this host, holds another lesson with the id of ` +
      `${one ? 'a lesson' : `${unwritten.length} lessons`} this host holds (${ids.join(', ')}): ` +
      `this host keeps ${one ? 'it' : 'them'} in its own state and doesn't write ${one ? 'it' : 'them'} to the file.${advice}`;
    if (line !== this.unwrittenLine) {
      this.unwrittenLine = line;
      if (line) console.warn(line);
    }
  }

  /** Merge the shared file's entries into the module's lessons. An entry
   *  whose id is named (see namedIds) merges by it: the file's copy replaces
   *  this host's whole unless this host's is newer (see stampOf), so a hand
   *  edit that left `updated` as it was is what the host holds, and a lesson
   *  new to the host is added. Every other entry, one without a named id or
   *  one that isn't an object, is carried: kept out of the module's lessons
   *  and written back as JSON.parse read it, so no save adds or loses an
   *  entry.
   *
   *  While the file holds an id of this host's lessons twice, this host
   *  can't tell which entry its copy came from, so it changes neither (see
   *  heldTwiceRefusal) and keeps the id in heldTwice, which holds the ids
   *  the last read that could read the file found so; a read that finds no
   *  file, or can't read it, keeps them. The first read to find such an id
   *  held once takes the file's copy, whatever the stamps, so on a host
   *  that read the file while it held the id twice, the lesson left keeps
   *  the id however the operator resolved the two. A host that didn't
   *  merges by stamp.
   *  Giving all but one with the latest `updated` a new id (see
   *  newIdAdvice) keeps every lesson on each host that holds no change to
   *  the lesson the file lacks, such as one lost to a write at nearly the
   *  same moment. An id this host holds twice can't merge, so it isn't held. */
  private mergeShared(entries: unknown[]): { carried: unknown[]; named: Set<string>; changed: boolean } {
    const named = namedIds(entries, this.state.lessons);
    const inFile = idCounts(entries);
    const onHost = idCounts(this.state.lessons);
    const wasHeld = new Set(this.state.heldTwice ?? []);
    const held = new Set([...inFile].filter(([id, n]) => n > 1 && onHost.get(id) === 1).map(([id]) => id));
    const at = new Map<string, number>();
    this.state.lessons.forEach((l, i) => {
      const id = idOf(l);
      if (id !== undefined && named.has(id)) at.set(id, i);
    });
    const carried: unknown[] = [];
    let changed = held.size !== wasHeld.size || [...held].some((id) => !wasHeld.has(id));
    for (const entry of entries) {
      const id = idOf(entry);
      if (id === undefined || !named.has(id)) {
        carried.push(entry);
        continue;
      }
      const gl = entry as StoredLesson;
      const i = at.get(id);
      if (i === undefined) {
        at.set(id, this.state.lessons.push(gl) - 1);
        changed = true;
      } else if (wasHeld.has(id) || stampOf(gl) >= stampOf(this.state.lessons[i])) {
        this.state.lessons[i] = gl;
        changed = true;
      }
    }
    if (held.size > 0) this.state.heldTwice = [...held];
    else delete this.state.heldTwice;
    return { carried, named, changed };
  }

  /** Name a read of the shared file that failed, once, and say when a read
   *  succeeds after one did. A read problem ends at the read that finds it
   *  gone, so the same problem later is named again. A file that isn't there
   *  any more ends it too, and the write that makes the file again says so. */
  private noteRead(read: SharedRead): void {
    if (read.kind === 'unreadable') {
      this.sayShared(read.problem, 'read');
      return;
    }
    if (this.sharedProblem?.on !== 'read') return;
    this.sharedProblem = null;
    if (read.kind === 'read') console.warn(`[lessons] the shared lessons file ${this.globalPath} reads as a lessons file again.`);
  }

  /** Say the line for the entries this host carries, when it differs from
   *  the one last said: at start, and at a change's read, so entries added
   *  while the host runs are named too. */
  private noteCarried(carried: unknown[]): void {
    const line = carriedLine(this.globalPath!, carried) ?? '';
    if (line === this.carriedSaid) return;
    this.carriedSaid = line;
    if (line) console.warn(line);
  }

  /** Name a problem with the shared file once, until it changes or passes,
   *  after what led to it, if anything. */
  private sayShared(problem: string, on: 'read' | 'write', lead = ''): void {
    if (this.sharedProblem?.text === problem) return;
    this.sharedProblem = { text: problem, on };
    const then = on === 'read'
      ? "won't write the file until it reads as a lessons file again"
      : 'tries again at its next save';
    console.warn(`[lessons] the shared lessons file ${this.globalPath} ${lead}${problem}: this host keeps its lessons in its own state and ${then}.`);
  }
}

/** What a read of the shared lessons file finds. */
type SharedRead =
  | { kind: 'absent' }
  | { kind: 'unreadable'; problem: string }
  | { kind: 'read'; doc: Record<string, unknown>; entries: unknown[] };

/** Decodes strictly, so bytes that aren't UTF-8 make a file this host can't
 *  read, rather than text it would write back changed. A byte-order mark at
 *  the start is dropped, and a write leaves it out. */
const utf8 = new TextDecoder('utf-8', { fatal: true });

function readSharedFile(path: string): SharedRead {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable', problem: `can't be read (${errorText(err)})` };
  }
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return { kind: 'unreadable', problem: "isn't UTF-8 text" };
  }
  let doc: unknown;
  try {
    // A number JSON can't hold, such as 1e999, parses as Infinity, which
    // the module's store refuses to save. It's read as null wherever it
    // sits: a confidence of 1e999 reads as one that isn't a number, and an
    // id of 1e999 as one that isn't text. A save writes the null back.
    doc = JSON.parse(text, (_key, value: unknown) =>
      typeof value === 'number' && !Number.isFinite(value) ? null : value);
  } catch (err) {
    return { kind: 'unreadable', problem: `isn't valid JSON (${errorText(err)})` };
  }
  if (!isRecord(doc) || !Array.isArray(doc.lessons)) {
    return { kind: 'unreadable', problem: "isn't a lessons file (no object holding a lessons list)" };
  }
  return { kind: 'read', doc, entries: doc.lessons };
}

/** Where writing a shared file that's there through a temporary file is
 *  refused for permission or a mount, and writing it in place still works:
 *  a directory this host can't write in (EACCES), a rename over a file
 *  another user owns in a directory with the sticky bit (EPERM, or EACCES:
 *  rename(2)), a file mounted on its own (EBUSY; EXDEV), or one mounted on
 *  its own in a directory on a read-only mount (EROFS: the file itself
 *  passed the check of its permission). */
const IN_PLACE = new Set(['EACCES', 'EPERM', 'EBUSY', 'EXDEV', 'EROFS']);

/** Write the shared lessons file. A file that's there is replaced whole: the
 *  text goes to a temporary file beside the file the path names after its
 *  links, synced to disk and given that file's permissions, and is renamed
 *  over it. So a write that fails leaves the file as it was, a host that
 *  stops partway or a machine that goes down leaves it whole, with the old
 *  text or the new, a reader never meets half of one, and a link stays a
 *  link. The file is a new one, owned as any new file this host makes
 *  there, and an access control list or other extended attribute set on
 *  it isn't kept. A file not made yet is made the same way, with the mode a new file
 *  takes, so a first write that fails leaves no file, and two hosts making
 *  it at once leave one whole file. The temporary file is
 *  lessons-<random>.tmp beside the file, its name new at each write; a
 *  host that stops between making it and the rename leaves it there.
 *
 *  It's written in place instead, as on main: through a link to a file not
 *  made yet, which a rename would replace with a plain file; for a file
 *  this host can't write, which is refused as on main; for a file with a
 *  second name (a hard link), which a rename would leave holding the old
 *  text; and where, for a file that's there, making the temporary file or
 *  the rename is refused with an IN_PLACE error. For the last two, inPlace
 *  is called first, with a key and the reason, so the caller can say so: a
 *  write in place that fails partway can leave the file broken. Any other
 *  error is thrown, with the file as it was or not made. */
function writeShared(path: string, text: string, inPlace: (key: string, why: string) => void): void {
  mkdirSync(dirname(path), { recursive: true });
  const old = statIfThere(path);
  if (old === null ? statIfThere(path, lstatSync) !== null : !writable(path)) {
    writeFileSync(path, text);
    return;
  }
  if (old !== null && old.nlink > 1) {
    inPlace('a second name', 'it has another name, which replacing it would leave holding the old text');
    writeFileSync(path, text);
    return;
  }
  const target = old === null ? path : realpathSync(path);
  // Its length doesn't depend on the file's name, so a name up to the
  // longest a directory takes still leaves room for it.
  const tmp = join(dirname(target), `lessons-${randomUUID()}.tmp`);
  const mode = old === null ? 0o666 : old.mode & 0o777;
  try {
    const fd = openSync(tmp, 'w', mode);
    try {
      writeFileSync(fd, text);
      // So the file is whole before the rename puts it in place: a machine
      // that goes down finds the old file or this one, whole.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // The umask narrows the mode a file is made with: a file that's there
    // keeps its own, and a new one takes the umask's, as on main.
    if (old !== null) chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (err) {
    // A removal that fails doesn't replace the error named here: on a
    // read-only mount even a temporary file never made is refused (EROFS).
    // One that was made then stays beside the file.
    try { rmSync(tmp, { force: true }); } catch { /* the write's error is the one named */ }
    const code = codeOf(err);
    // An error's text can name the temporary file, whose name is new at
    // each write, and a problem is named once by its text.
    const said = errorText(err).replaceAll(tmp, join(dirname(target), 'lessons-<random>.tmp'));
    // With no file there, writing in place needs the same directory the
    // temporary file did, so there's nothing to fall back to.
    if (old === null || !IN_PLACE.has(code)) throw Object.assign(new Error(said), { code });
    inPlace(code, `this host can't replace it through a temporary file beside it (${said})`);
    writeFileSync(path, text);
  }
}

/** Whether this host may write the file, as far as its permission goes. A
 *  refusal for permission (EACCES, EPERM, EROFS) is no, so the write goes
 *  in place and is refused there, as on main; any other error from the
 *  check is thrown, so the file is left alone. */
function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch (err) {
    if (['EACCES', 'EPERM', 'EROFS'].includes(codeOf(err))) return false;
    throw err;
  }
}

function codeOf(err: unknown): string {
  return String((err as { code?: unknown }).code);
}

/** A refusal for a change to a lesson whose id the shared file, as this
 *  call read it, holds twice, or held twice when this host last read it
 *  and can't be read now: this host can't tell which entry its copy came
 *  from, so the change couldn't be shared, and the merge would drop it
 *  once the two are resolved (see mergeShared). */
function heldTwiceRefusal(
  read: SharedRead | null,
  l: StoredLesson,
  verb: 'updated' | 'deprecated' | 'boosted' | 'demoted',
  heldTwice: string[] | undefined,
): ToolResult | undefined {
  const id = idOf(l);
  if (read === null || id === undefined) return undefined;
  let holds: string;
  let advice: string;
  if (read.kind === 'read' && (idCounts(read.entries).get(id) ?? 0) > 1) {
    holds = 'holds';
    advice = newIdAdvice(read.entries, id);
  } else if (read.kind === 'unreadable' && heldTwice?.includes(id)) {
    holds = 'held, when this host last read it,';
    advice = ALL_BUT_ONE;
  } else {
    return undefined;
  }
  return {
    success: false,
    isError: true,
    error:
      `Nothing was ${verb}: the shared lessons file ${holds} another lesson with the id ${shown(id)}, so this host can't ` +
      'tell which of them this one is, and a change to it couldn\'t be shared. It waits on whoever runs the host, who can ' +
      `${advice}.`,
  };
}

/** What keeps every lesson when the file holds an id more than once: all
 *  entries but one with the latest `updated` take new ids, so the one left
 *  under the id is at least as new as the copy a host holds, unless that
 *  host holds a change the file lacks (see mergeShared). */
const ALL_BUT_ONE = 'give all but one of them a new id in the file, leaving the id on one with the latest updated';

/** ALL_BUT_ONE for the entries the file holds under an id, said of two by
 *  the one to give a new id, named by its `updated` as the file holds it. */
function newIdAdvice(entries: unknown[], id: string): string {
  const doubled = entries.filter((e) => idOf(e) === id) as Record<string, unknown>[];
  if (doubled.length !== 2) return ALL_BUT_ONE;
  const [a, b] = doubled;
  if (stampOf(a) === stampOf(b)) return 'give either one a new id in the file (neither\'s updated is later)';
  const u = (stampOf(a) < stampOf(b) ? a : b).updated;
  return `give the one with ${u === undefined ? 'no updated' : `updated ${shown(u)}`} a new id in the file`;
}

function statIfThere(path: string, stat: (path: string) => Stats = statSync): Stats | null {
  try {
    return stat(path);
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return null;
    throw err;
  }
}

/** A copy's `updated` as the merge ranks it: one that isn't a number no
 *  greater than Number.MAX_SAFE_INTEGER ranks below every one that is. Past
 *  that, adding one can give the same number, so a change couldn't always
 *  stamp past the copy; no clock gives one (a Date holds at most 8.64e15),
 *  and ranked by value, a hand edit's would outrank every change. */
function stampOf(l: unknown): number {
  const u = isRecord(l) ? l.updated : undefined;
  return typeof u === 'number' && Number.isFinite(u) && u <= Number.MAX_SAFE_INTEGER ? u : -Infinity;
}

/** The `updated` for a change made on a copy: now, or one past the copy's
 *  stamp when that's later, so the change outranks the copy it was made on
 *  in every host's merge, whatever the hosts' clocks say. A copy stamped
 *  Number.MAX_SAFE_INTEGER itself is the exception: the change takes the
 *  same stamp, and of the two, the one in the file wins, as for any tie. */
function laterStamp(l: StoredLesson): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(Date.now(), stampOf(l) + 1));
}

/** The ids a merge with the shared file goes by: non-empty text that at most
 *  one entry of the file and at most one of the module's lessons holds. An
 *  id held twice on either side can't say which lessons match, and merging
 *  by it would overwrite one, or write a copy at every save. */
function namedIds(entries: unknown[], lessons: StoredLesson[]): Set<string> {
  const inFile = idCounts(entries);
  const inState = idCounts(lessons);
  const named = new Set<string>();
  for (const id of new Set([...inFile.keys(), ...inState.keys()])) {
    if ((inFile.get(id) ?? 0) <= 1 && (inState.get(id) ?? 0) <= 1) named.add(id);
  }
  return named;
}

/** How many entries of a list hold each id (see idOf). */
function idCounts(list: unknown[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const e of list) {
    const id = idOf(e);
    if (id !== undefined) n.set(id, (n.get(id) ?? 0) + 1);
  }
  return n;
}

/** An entry's id, when it's an object whose id is non-empty text. */
function idOf(entry: unknown): string | undefined {
  return isRecord(entry) && typeof entry.id === 'string' && entry.id !== '' ? entry.id : undefined;
}

/** The start's line for the shared file's entries this host carries without
 *  loading, if it has any. */
function carriedLine(path: string, carried: unknown[]): string | undefined {
  if (carried.length === 0) return undefined;
  const notObjects = carried.filter(e => !isRecord(e)).length;
  const unnamed = carried.length - notObjects;
  const parts = [
    ...(notObjects > 0 ? [notObjects === 1 ? "1 entry that isn't a lesson (not an object)" : `${notObjects} entries that aren't lessons (not objects)`] : []),
    ...(unnamed > 0 ? [`${unnamed} ${unnamed === 1 ? 'lesson' : 'lessons'} without a named id (text, not empty, held once at most in the file and once at most on this host)`] : []),
  ];
  const one = carried.length === 1;
  return `[lessons] the shared lessons file ${path} has ${parts.join(' and ')}. ` +
    `${one ? "It's" : "They're"} kept in the file, and this host doesn't load ${one ? 'it' : 'them'}.`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What's wrong with a stored lesson, field by field, or nothing when it's
 *  whole. The agent's mark, the operator's load line and boost and demote's
 *  refusals all say it from this. */
interface Faults {
  /** Content that isn't text, or is blank: queries find no words in it, and
   *  retrieval leaves the lesson out. */
  content: boolean;
  /** Tags that aren't a list ('missing'), read as none, or a list with
   *  entries that aren't text ('mixed'), read by the ones that are. */
  tags?: 'missing' | 'mixed';
  /** A confidence stored outside 0 to 1, as text, or as no number at all:
   *  what's stored, as a phrase after "with". */
  confidence?: string;
}

function faultsOf(l: StoredLesson): Faults | undefined {
  const content = typeof l.content !== 'string' || l.content.trim() === '';
  const tags = !Array.isArray(l.tags) ? 'missing' as const : isTextList(l.tags) ? undefined : 'mixed' as const;
  const confidence = confidenceFault(l.confidence);
  return content || tags || confidence ? { content, ...(tags ? { tags } : {}), ...(confidence ? { confidence } : {}) } : undefined;
}

/** A stored confidence as a number: a number as it is, text that holds a
 *  number as that number, and anything else, blank text included, as NaN. */
function confidenceValue(c: unknown): number {
  if (typeof c === 'number') return c;
  if (typeof c === 'string' && c.trim() !== '') return Number(c);
  return NaN;
}

/** A confidence as queries, lists and retrieval rank and filter by it: one
 *  outside 0 to 1 counts as the nearer end, and one that isn't a number as
 *  0. A lesson stored with 85 ranks as 1, the top of the range, with every
 *  lesson stored at 1, rather than as 85. */
function rankedConfidence(c: unknown): number {
  const v = confidenceValue(c);
  return Number.isNaN(v) ? 0 : Math.min(1, Math.max(0, v));
}

/** What's wrong with a stored confidence, as a phrase after "with", or
 *  nothing when it's a number from 0 to 1. */
function confidenceFault(c: unknown): string | undefined {
  const v = confidenceValue(c);
  const inRange = v >= 0 && v <= 1;
  if (typeof c === 'number' && inRange) return undefined;
  if (Number.isNaN(v)) return "a confidence that isn't a number";
  const asStored = typeof c === 'string' ? `confidence ${JSON.stringify(c)}, stored as text` : `confidence ${v}`;
  return inRange ? asStored : `${asStored}, outside 0 to 1`;
}

/** What a lesson is stored with, as a phrase after "stored". */
function storedPhrase(f: Faults): string {
  const missing = [...(f.content ? ['content'] : []), ...(f.tags === 'missing' ? ['tags'] : [])];
  return [
    ...(missing.length > 0 ? [`without usable ${missing.join(' or ')}`] : []),
    ...(f.tags === 'mixed' ? ["with tags that aren't all text"] : []),
    ...(f.confidence ? [`with ${f.confidence}`] : []),
  ].join(', and ');
}

/** What an update gives to fix it, and whether deprecating would do too. */
function fixPhrase(f: Faults): { give: string; orDeprecate: boolean } {
  const fields = f.content && f.tags ? ['its content and tags'] : f.content ? ['its content'] : f.tags ? ['its tags'] : [];
  const confidence = f.confidence ? ['a confidence from 0 to 1'] : [];
  return { give: [...fields, ...confidence].join(', and '), orDeprecate: fields.length > 0 };
}

/** The lesson a call's id names: only an id that's non-empty text names
 *  one. A call without an id used to find the first lesson stored without
 *  one, since undefined === undefined. */
function findLesson(lessons: StoredLesson[], id: unknown): StoredLesson | undefined {
  return idProblem(id) ? undefined : lessons.find(l => l.id === id);
}

/** Why a call's id can't name a lesson, if it can't. */
function idProblem(id: unknown): string | undefined {
  if (id === undefined) return 'id is missing: give the lesson\'s id';
  if (id === '') return 'id is empty: give the lesson\'s id';
  if (typeof id !== 'string') return `id must be text, such as the id lessons--list shows, not ${shown(id)}`;
  return undefined;
}

/** Why no call can name a stored lesson, as a phrase after "stored", if none
 *  can: lesson tools find a lesson by an id that's non-empty text. */
function idFault(l: StoredLesson): string | undefined {
  if (l.id === undefined) return 'without an id';
  if (l.id === '') return 'with an empty id';
  if (typeof l.id !== 'string') return `with an id that isn't text (${shown(l.id)})`;
  return undefined;
}

/** What the agent's list and query say a stored lesson needs, if anything.
 *  A lesson no call can name gets only that, since no lesson tool can act on
 *  its other faults. */
function needsFix(l: StoredLesson): string | undefined {
  const unnamed = idFault(l);
  if (unnamed) return `Stored ${unnamed}, so no lesson tool can name it.`;
  const f = faultsOf(l);
  if (!f) return undefined;
  const { give, orDeprecate } = fixPhrase(f);
  return `Stored ${storedPhrase(f)}: give ${give} with lessons--update${orDeprecate ? ', or deprecate this lesson' : ''}.`;
}

/** The line that gives a stored lesson's mark to whoever runs the host,
 *  once per load: the agent's words, naming the lesson by its id, or as "a
 *  lesson" when no call can name it. */
function loadLine(l: StoredLesson): string | undefined {
  const mark = needsFix(l);
  if (!mark) return undefined;
  return `[lessons] ${idFault(l) ? 'a lesson' : `lesson ${JSON.stringify(l.id)}`}: ${mark}`;
}

/** Why boost or demote leaves a lesson as it is: one whose stored confidence
 *  is outside 0 to 1 or isn't a number has no value to start from, and one
 *  taken from its rank would quietly decide it. */
function adjustRefusal(l: StoredLesson, verb: 'boost' | 'demote'): string | undefined {
  const fault = confidenceFault(l.confidence);
  const v = confidenceValue(l.confidence);
  if (!fault || (v >= 0 && v <= 1)) return undefined;
  const done = verb === 'boost' ? 'boosted' : 'demoted';
  return `Nothing was ${done}: lesson ${JSON.stringify(l.id)} is stored with ${fault}, so it has no ` +
    `confidence to ${verb} from. Give it one from 0 to 1 with lessons--update, then ${verb} it.`;
}

/** A stored lesson as every reader sees it: content it lacks reads as empty,
 *  of its tags and its evidence only the text entries count (evidence stored
 *  as one value counts as a list of that one), and its confidence is the one
 *  it's ranked by. The stored record isn't changed, so it stays as stored
 *  until someone updates it. */
function readable(l: StoredLesson): Lesson {
  if (typeof l.content === 'string' && isTextList(l.tags) && isTextList(l.evidence) && !confidenceFault(l.confidence)) {
    return l as Lesson;
  }
  return {
    // A bare value the state holds has no fields to keep: spread, text or a
    // list would give index keys.
    ...((isRecord(l) ? l : {}) as StoredLesson),
    content: typeof l.content === 'string' ? l.content : '',
    tags: textEntries(l.tags),
    evidence: textEntries(storedEvidence(l.evidence)),
    confidence: rankedConfidence(l.confidence),
  };
}

function isTextList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(t => typeof t === 'string');
}

/** Stored evidence as a list: a list as it is, a lone value as a list of
 *  that one, and none when nothing is stored. */
function storedEvidence(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

/** The text entries of a list, or none when it isn't one. */
function textEntries(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What's wrong with the fields a create or update gives, each named with the
 *  value given. create needs content and tags; update takes any of them. */
function inputProblems(
  input: { content?: unknown; tags?: unknown; confidence?: unknown; evidence?: unknown },
  isCreate: boolean,
): string[] {
  const problems: string[] = [];
  const textList = (value: unknown) => Array.isArray(value) && value.every(t => typeof t === 'string');
  // A field left out keeps its value on update; null is a value, and not
  // one any field takes.
  const orKeep = (what: string) => (isCreate ? '' : `, or leave it out to keep the current ${what}`);
  if (input.content === undefined) {
    if (isCreate) problems.push('content is missing: give the lesson as text');
  } else if (typeof input.content !== 'string') {
    problems.push(`content must be the lesson as text${orKeep('text')}, not ${shown(input.content)}`);
  } else if (input.content.trim() === '') {
    problems.push(`content is blank: give the lesson as text${orKeep('text')}`);
  }
  if (input.tags === undefined) {
    if (isCreate) problems.push('tags is missing: give a list of tags, such as ["process"]');
  } else if (!textList(input.tags)) {
    problems.push(`tags must be a list of text, such as ["process"]${orKeep('tags')}, not ${shown(input.tags)}`);
  }
  if (input.confidence !== undefined
    && !(typeof input.confidence === 'number' && input.confidence >= 0 && input.confidence <= 1)) {
    problems.push(`confidence must be a number from 0 to 1, such as 0.8, not ${shown(input.confidence)}`);
  }
  if (input.evidence !== undefined && !textList(input.evidence)) {
    problems.push(`evidence must be a list of text, such as ["stream:topic:messageId"], not ${shown(input.evidence)}`);
  }
  return problems;
}

/** An update, deprecate, boost or demote whose id matches no lesson, with
 *  any other problem in the call named beside it. */
function notFound(verb: 'updated' | 'deprecated' | 'boosted' | 'demoted', id: unknown, also?: string): ToolResult {
  const which = idProblem(id) ?? `no lesson has the id ${shown(id)}`;
  return {
    success: false,
    isError: true,
    error:
      `Nothing was ${verb}: ${which}${also ? `; ${also}` : ''}. ` +
      'lessons--list shows lessons with their ids, the first 50 unless you give a larger limit (deprecated ' +
      'ones too, with includeDeprecated: true), and lessons--query finds lessons by text or tags.',
  };
}
