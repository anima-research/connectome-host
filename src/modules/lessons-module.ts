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

type StoredLesson = Omit<Lesson, 'content' | 'tags' | 'evidence' | 'confidence'> &
  { content?: unknown; tags?: unknown; evidence?: unknown; confidence?: unknown };

interface LessonsState {
  lessons: StoredLesson[];
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

export class LessonsModule implements Module {
  readonly name = 'lessons';

  private ctx: ModuleContext | null = null;
  private state: LessonsState = { lessons: [] };
  private globalPath: string | null;
  private sharedProblem: { text: string; on: 'read' | 'write' } | null = null;
  private unwrittenLine = '';
  private carriedSaid = '';
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
    if (this.globalPath) {
      const read = readSharedFile(this.globalPath);
      this.noteRead(read);
      if (read.kind === 'read') {
        const { carried, changed } = this.mergeShared(read.entries);
        this.noteCarried(carried);
        if (changed) ctx.setState(this.state);
      }
    }
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

  getLessons(): Lesson[] {
    return this.readableLessons();
  }

  private readableLessons(): Lesson[] {
    return this.state.lessons.map(readable);
  }

  getLessonRecords(): Array<{ stored: unknown; lesson: Lesson; needsFix?: string }> {
    return this.state.lessons.map(stored => {
      const fix = stored.deprecated ? undefined : needsFix(stored);
      return { stored, lesson: readable(stored), ...(fix ? { needsFix: fix } : {}) };
    });
  }

  private handleCreate(input: CreateInput): ToolResult {
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

    if (input.minConfidence !== undefined) {
      results = results.filter(r => r.lesson.confidence >= input.minConfidence!);
    }

    if (input.tags && input.tags.length > 0) {
      const tagSet = new Set(input.tags.map(t => t.toLowerCase()));
      results = results.filter(r =>
        r.lesson.tags.some(t => tagSet.has(t.toLowerCase()))
      );
    }

    if (input.text) {
      const keywords = input.text.toLowerCase().split(/\s+/);
      results = results.filter(r => {
        const text = r.lesson.content.toLowerCase();
        return keywords.some(kw => text.includes(kw));
      });
    }

    results.sort((a, b) => b.lesson.confidence - a.lesson.confidence);

    return {
      success: true,
      data: {
        count: results.length,
        lessons: results.slice(0, limit).map(({ stored, lesson: l, needsFix: fix }) => ({
          id: l.id,
          content: l.content,
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

    if (input.tags && input.tags.length > 0) {
      const tagSet = new Set(input.tags.map(t => t.toLowerCase()));
      results = results.filter(r =>
        r.lesson.tags.some(t => tagSet.has(t.toLowerCase()))
      );
    }

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
        lessons: results.slice(0, limit).map(({ stored, lesson: l, needsFix: fix }) => ({
          id: l.id,
          content: l.content,
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

    const base = confidenceValue(lesson.confidence);
    lesson.confidence = Math.max(0, base - 0.1 * base);
    lesson.updated = laterStamp(lesson);
    this.save(read);

    return { success: true, data: { id: lesson.id, confidence: lesson.confidence } };
  }

  private refresh(): SharedRead | null {
    if (!this.globalPath) return null;
    const read = readSharedFile(this.globalPath);
    this.noteRead(read);
    if (read.kind === 'read') {
      const { carried, changed } = this.mergeShared(read.entries);
      this.noteCarried(carried);
      if (changed) this.ctx?.setState(this.state);
    }
    return read;
  }

  private freshId(read: SharedRead | null): string {
    const taken = new Set(this.state.lessons.map(idOf));
    if (read?.kind === 'read') for (const e of read.entries) taken.add(idOf(e));
    let id: string;
    do id = randomUUID().slice(0, 8); while (taken.has(id));
    return id;
  }

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
    const inPlace = (key: string, why: string): void => {
      if (this.inPlaceSaid.has(key)) return;
      this.inPlaceSaid.add(key);
      console.warn(`[lessons] the shared lessons file ${this.globalPath} is written in place, since ${why}: a write that fails partway can leave it broken.`);
    };
    try {
      writeShared(this.globalPath, JSON.stringify({ ...doc, lessons }, null, 2), inPlace);
    } catch (err) {
      const after = readSharedFile(this.globalPath);
      if (after.kind === 'unreadable') this.sayShared(after.problem, 'read', `couldn't be written (${errorText(err)}), and now `);
      else this.sayShared(`couldn't be written (${errorText(err)})`, 'write');
      return;
    }
    const made = read.kind === 'absent';
    if (this.sharedProblem !== null) {
      this.sharedProblem = null;
      const how = made ? "it wasn't there, so this host wrote it with its lessons" : 'this host merged its lessons in and wrote it';
      console.warn(`[lessons] the shared lessons file ${this.globalPath} can be written again: ${how}.`);
    } else if (made) {
      console.warn(`[lessons] the shared lessons file ${this.globalPath} wasn't there: this host wrote it with its lessons.`);
    }
    const unwritten = this.state.lessons.filter((l) => {
      const id = idOf(l);
      return id !== undefined && !named.has(id);
    });
    const one = unwritten.length === 1;
    const ids = [...new Set(unwritten.map(idOf))] as string[];
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

  private noteRead(read: SharedRead): void {
    if (read.kind === 'unreadable') {
      this.sayShared(read.problem, 'read');
      return;
    }
    if (this.sharedProblem?.on !== 'read') return;
    this.sharedProblem = null;
    if (read.kind === 'read') console.warn(`[lessons] the shared lessons file ${this.globalPath} reads as a lessons file again.`);
  }

  private noteCarried(carried: unknown[]): void {
    const line = carriedLine(this.globalPath!, carried) ?? '';
    if (line === this.carriedSaid) return;
    this.carriedSaid = line;
    if (line) console.warn(line);
  }

  private sayShared(problem: string, on: 'read' | 'write', lead = ''): void {
    if (this.sharedProblem?.text === problem) return;
    this.sharedProblem = { text: problem, on };
    const then = on === 'read'
      ? "won't write the file until it reads as a lessons file again"
      : 'tries again at its next save';
    console.warn(`[lessons] the shared lessons file ${this.globalPath} ${lead}${problem}: this host keeps its lessons in its own state and ${then}.`);
  }
}

type SharedRead =
  | { kind: 'absent' }
  | { kind: 'unreadable'; problem: string }
  | { kind: 'read'; doc: Record<string, unknown>; entries: unknown[] };

/** TextDecoder drops a byte-order mark at the start. */
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
    // JSON.parse reads a number JSON can't hold, such as 1e999, as Infinity,
    // which the module's store refuses to save: chronicle's setStateJson takes
    // only numbers JSON can hold.
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

/** A rename over a file makes it a new file, owned as any new file this host
 *  makes there, without an access control list or other extended attribute
 *  the old one had, and a second name (a hard link) keeps the old text. A
 *  rename onto a link to a file not made yet replaces the link with a plain
 *  file. */
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
  const tmp = join(dirname(target), `lessons-${randomUUID()}.tmp`);
  const mode = old === null ? 0o666 : old.mode & 0o777;
  try {
    const fd = openSync(tmp, 'w', mode);
    try {
      writeFileSync(fd, text);
      // Synced before the rename, so a machine that goes down finds the old file
      // or this one, whole.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // The umask narrows the mode a file is made with.
    if (old !== null) chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { }
    const code = codeOf(err);
    const said = errorText(err).replaceAll(tmp, join(dirname(target), 'lessons-<random>.tmp'));
    if (old === null || !IN_PLACE.has(code)) throw Object.assign(new Error(said), { code });
    inPlace(code, `this host can't replace it through a temporary file beside it (${said})`);
    writeFileSync(path, text);
  }
}

/** access(2) refuses for permission with EACCES, EPERM or EROFS. */
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

const ALL_BUT_ONE = 'give all but one of them a new id in the file, leaving the id on one with the latest updated';

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

/** Past Number.MAX_SAFE_INTEGER, adding one can give the same number, and
 *  no clock gives a stamp that large: a Date holds at most 8.64e15. */
function stampOf(l: unknown): number {
  const u = isRecord(l) ? l.updated : undefined;
  return typeof u === 'number' && Number.isFinite(u) && u <= Number.MAX_SAFE_INTEGER ? u : -Infinity;
}

function laterStamp(l: StoredLesson): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(Date.now(), stampOf(l) + 1));
}

function namedIds(entries: unknown[], lessons: StoredLesson[]): Set<string> {
  const inFile = idCounts(entries);
  const inState = idCounts(lessons);
  const named = new Set<string>();
  for (const id of new Set([...inFile.keys(), ...inState.keys()])) {
    if ((inFile.get(id) ?? 0) <= 1 && (inState.get(id) ?? 0) <= 1) named.add(id);
  }
  return named;
}

function idCounts(list: unknown[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const e of list) {
    const id = idOf(e);
    if (id !== undefined) n.set(id, (n.get(id) ?? 0) + 1);
  }
  return n;
}

function idOf(entry: unknown): string | undefined {
  return isRecord(entry) && typeof entry.id === 'string' && entry.id !== '' ? entry.id : undefined;
}

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

interface Faults {
  content: boolean;
  tags?: 'missing' | 'mixed';
  confidence?: string;
}

function faultsOf(l: StoredLesson): Faults | undefined {
  const content = typeof l.content !== 'string' || l.content.trim() === '';
  const tags = !Array.isArray(l.tags) ? 'missing' as const : isTextList(l.tags) ? undefined : 'mixed' as const;
  const confidence = confidenceFault(l.confidence);
  return content || tags || confidence ? { content, ...(tags ? { tags } : {}), ...(confidence ? { confidence } : {}) } : undefined;
}

function confidenceValue(c: unknown): number {
  if (typeof c === 'number') return c;
  if (typeof c === 'string' && c.trim() !== '') return Number(c);
  return NaN;
}

function rankedConfidence(c: unknown): number {
  const v = confidenceValue(c);
  return Number.isNaN(v) ? 0 : Math.min(1, Math.max(0, v));
}

function confidenceFault(c: unknown): string | undefined {
  const v = confidenceValue(c);
  const inRange = v >= 0 && v <= 1;
  if (typeof c === 'number' && inRange) return undefined;
  if (Number.isNaN(v)) return "a confidence that isn't a number";
  const asStored = typeof c === 'string' ? `confidence ${JSON.stringify(c)}, stored as text` : `confidence ${v}`;
  return inRange ? asStored : `${asStored}, outside 0 to 1`;
}

function storedPhrase(f: Faults): string {
  const missing = [...(f.content ? ['content'] : []), ...(f.tags === 'missing' ? ['tags'] : [])];
  return [
    ...(missing.length > 0 ? [`without usable ${missing.join(' or ')}`] : []),
    ...(f.tags === 'mixed' ? ["with tags that aren't all text"] : []),
    ...(f.confidence ? [`with ${f.confidence}`] : []),
  ].join(', and ');
}

function fixPhrase(f: Faults): { give: string; orDeprecate: boolean } {
  const fields = f.content && f.tags ? ['its content and tags'] : f.content ? ['its content'] : f.tags ? ['its tags'] : [];
  const confidence = f.confidence ? ['a confidence from 0 to 1'] : [];
  return { give: [...fields, ...confidence].join(', and '), orDeprecate: fields.length > 0 };
}

function findLesson(lessons: StoredLesson[], id: unknown): StoredLesson | undefined {
  return idProblem(id) ? undefined : lessons.find(l => l.id === id);
}

function idProblem(id: unknown): string | undefined {
  if (id === undefined) return 'id is missing: give the lesson\'s id';
  if (id === '') return 'id is empty: give the lesson\'s id';
  if (typeof id !== 'string') return `id must be text, such as the id lessons--list shows, not ${shown(id)}`;
  return undefined;
}

function idFault(l: StoredLesson): string | undefined {
  if (l.id === undefined) return 'without an id';
  if (l.id === '') return 'with an empty id';
  if (typeof l.id !== 'string') return `with an id that isn't text (${shown(l.id)})`;
  return undefined;
}

function needsFix(l: StoredLesson): string | undefined {
  const unnamed = idFault(l);
  if (unnamed) return `Stored ${unnamed}, so no lesson tool can name it.`;
  const f = faultsOf(l);
  if (!f) return undefined;
  const { give, orDeprecate } = fixPhrase(f);
  return `Stored ${storedPhrase(f)}: give ${give} with lessons--update${orDeprecate ? ', or deprecate this lesson' : ''}.`;
}

function loadLine(l: StoredLesson): string | undefined {
  const mark = needsFix(l);
  if (!mark) return undefined;
  return `[lessons] ${idFault(l) ? 'a lesson' : `lesson ${JSON.stringify(l.id)}`}: ${mark}`;
}

function adjustRefusal(l: StoredLesson, verb: 'boost' | 'demote'): string | undefined {
  const fault = confidenceFault(l.confidence);
  const v = confidenceValue(l.confidence);
  if (!fault || (v >= 0 && v <= 1)) return undefined;
  const done = verb === 'boost' ? 'boosted' : 'demoted';
  return `Nothing was ${done}: lesson ${JSON.stringify(l.id)} is stored with ${fault}, so it has no ` +
    `confidence to ${verb} from. Give it one from 0 to 1 with lessons--update, then ${verb} it.`;
}

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

function storedEvidence(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function textEntries(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inputProblems(
  input: { content?: unknown; tags?: unknown; confidence?: unknown; evidence?: unknown },
  isCreate: boolean,
): string[] {
  const problems: string[] = [];
  const textList = (value: unknown) => Array.isArray(value) && value.every(t => typeof t === 'string');
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
