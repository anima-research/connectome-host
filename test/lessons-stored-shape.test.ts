/**
 * Lessons stored without usable content or tags, as an earlier version could
 * write them and a hand edit of the shared lessons file can: every reader
 * reads that field as empty, the agent's list says what to fix, the operator's
 * log names each one once per load, and the stored record stays as stored.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModuleContext, ToolCall } from '@animalabs/agent-framework';
import type { Membrane } from '@animalabs/membrane';
import { LessonsModule } from '../src/modules/lessons-module.js';
import { RetrievalModule } from '../src/modules/retrieval-module.js';
import { handleCommand, handleExport } from '../src/commands.js';
import { WebUiModule, stopWebUiServer } from '../src/modules/web-ui-module.js';

type AnyObj = Record<string, any>;

const call = (name: string, input: AnyObj = {}): ToolCall => ({ id: `t-${name}`, name, input });

const stored = (id: string, fields: AnyObj): AnyObj =>
  ({ id, confidence: 0.6, evidence: [], created: 1, updated: 1, deprecated: false, ...fields });

/** The module's store (chronicle's setStateJson) refuses a number JSON can't
 *  hold, with this error (receipt chronicle-infinity-probe.txt); the
 *  stand-in context refuses it too, so no test holds state no host can. */
function storable(s: unknown): unknown {
  JSON.stringify(s, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Failed to convert js number to serde_json::Number');
    return value;
  });
  return structuredClone(s);
}

async function loaded(lessons: AnyObj[], globalLessons?: AnyObj[] | string) {
  let state: unknown = storable({ lessons });
  const dir = mkdtempSync(join(tmpdir(), 'lessons-shape-'));
  const globalPath = join(dir, 'lessons.json');
  if (globalLessons !== undefined) {
    writeFileSync(globalPath, typeof globalLessons === 'string' ? globalLessons : JSON.stringify({ lessons: globalLessons }));
  }
  const warnings: string[] = [];
  const warn = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.join(' ')); });
  const m = new LessonsModule(globalLessons !== undefined ? { globalPath } : undefined);
  try {
    await m.start({
      getState: () => state,
      setState: (s: unknown) => { state = storable(s); },
    } as unknown as ModuleContext);
  } finally {
    warn.mockRestore();
  }
  return {
    m,
    warnings,
    stored: () => (state as { lessons: AnyObj[] }).lessons,
    file: () => JSON.parse(readFileSync(globalPath, 'utf-8')) as { lessons: AnyObj[] },
    fileText: () => readFileSync(globalPath, 'utf-8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const ids = (r: { data?: unknown }) => ((r.data as { lessons: AnyObj[] }).lessons).map(l => l.id).sort();

const isObject = (v: unknown): v is AnyObj => typeof v === 'object' && v !== null && !Array.isArray(v);

describe('a lesson stored without usable content or tags', () => {
  const lessons = [
    stored('notags', { content: 'alpha beta' }),
    stored('nocontent', { tags: ['process'] }),
    stored('whole', { content: 'gamma', tags: ['process'] }),
  ];

  test('queries and lists by tag and by text read it as empty, where they threw', async () => {
    const h = await loaded(lessons);
    try {
      const byTag = await h.m.handleToolCall(call('query', { tags: ['process'] }));
      expect(byTag.success).toBe(true);
      expect(ids(byTag)).toEqual(['nocontent', 'whole']);
      const byText = await h.m.handleToolCall(call('query', { text: 'alpha' }));
      expect(ids(byText)).toEqual(['notags']);
      expect(ids(await h.m.handleToolCall(call('list', { tags: ['process'] })))).toEqual(['nocontent', 'whole']);
      const read = Object.fromEntries(h.m.getLessons().map(l => [l.id, l]));
      expect(read.notags!.tags).toEqual([]);
      expect(read.nocontent!.content).toBe('');
    } finally { h.cleanup(); }
  });

  test('the list marks it with what is missing and how to fix it, until it is fixed', async () => {
    const h = await loaded([...lessons, stored('blank', { content: '  ', tags: 'process' })]);
    try {
      const marks = async () => Object.fromEntries(
        ((await h.m.handleToolCall(call('list'))).data as { lessons: AnyObj[] }).lessons.map(l => [l.id, l.needsFix]),
      );
      expect(await marks()).toEqual({
        notags: 'Stored without usable tags: give its tags with lessons--update, or deprecate this lesson.',
        nocontent: 'Stored without usable content: give its content with lessons--update, or deprecate this lesson.',
        blank: 'Stored without usable content or tags: give its content and tags with lessons--update, or deprecate this lesson.',
        whole: undefined,
      });
      await h.m.handleToolCall(call('update', { id: 'notags', tags: ['greek'] }));
      await h.m.handleToolCall(call('update', { id: 'nocontent', content: 'delta' }));
      const after = await marks();
      expect(after.notags).toBeUndefined();
      expect(after.nocontent).toBeUndefined();
    } finally { h.cleanup(); }
  });

  test('a deprecated one is listed without a mark, since deprecating it is a fix', async () => {
    const h = await loaded([stored('gone', { content: 'old', deprecated: true })]);
    try {
      const listed = ((await h.m.handleToolCall(call('list', { includeDeprecated: true }))).data as { lessons: AnyObj[] }).lessons;
      expect(listed.map(l => [l.id, l.deprecated, l.needsFix])).toEqual([['gone', true, undefined]]);
    } finally { h.cleanup(); }
  });

  test('the operator log names each one once per load, and not a deprecated one', async () => {
    const h = await loaded([...lessons, stored('blank', { content: '  ', tags: 'process' }), stored('gone', { deprecated: true })]);
    try {
      expect(h.warnings).toEqual([
        '[lessons] lesson "notags": Stored without usable tags: give its tags with lessons--update, or deprecate this lesson.',
        '[lessons] lesson "nocontent": Stored without usable content: give its content with lessons--update, ' +
          'or deprecate this lesson.',
        '[lessons] lesson "blank": Stored without usable content or tags: give its content and tags with ' +
          'lessons--update, or deprecate this lesson.',
      ]);
    } finally { h.cleanup(); }
  });

  test('the stored record stays as written while other lessons are edited', async () => {
    const h = await loaded(lessons);
    try {
      await h.m.handleToolCall(call('boost', { id: 'whole' }));
      const records = Object.fromEntries(h.stored().map(l => [l.id, l]));
      expect('tags' in records.notags!).toBe(false);
      expect('content' in records.nocontent!).toBe(false);
    } finally { h.cleanup(); }
  });

  test('one from the shared lessons file is read the same way, and the file keeps it as written', async () => {
    const written = stored('shared', { content: 'from the file' });
    const h = await loaded([stored('local', { content: 'here', tags: ['x'] })], [written]);
    try {
      expect((await h.m.handleToolCall(call('query', { tags: ['x'] }))).success).toBe(true);
      expect(h.warnings[0]).toContain('"shared"');
      // Saving another lesson writes the file again, with this one as written.
      await h.m.handleToolCall(call('boost', { id: 'local' }));
      expect(h.file().lessons.find(l => l.id === 'shared')).toEqual(written);
    } finally { h.cleanup(); }
  });
});

describe('a lesson stored with a confidence outside 0 to 1, or one that isn\'t a number', () => {
  const lessons = [
    stored('percent', { content: 'alpha', tags: ['process'], confidence: 85 }),
    stored('nan', { content: 'beta', tags: ['process'], confidence: null }),
    stored('negative', { content: 'gamma', tags: ['process'], confidence: -0.5 }),
    stored('whole', { content: 'delta', tags: ['process'], confidence: 0.95 }),
  ];

  test('the list and query show it as stored and say how to fix it; ranking reads it clamped', async () => {
    const h = await loaded(lessons);
    try {
      const listed = Object.fromEntries(
        ((await h.m.handleToolCall(call('list'))).data as { lessons: AnyObj[] }).lessons.map(l => [l.id, l]),
      );
      expect(listed.percent).toMatchObject({
        confidence: 85,
        needsFix: 'Stored with confidence 85, outside 0 to 1: give a confidence from 0 to 1 with lessons--update.',
      });
      expect(listed.nan).toMatchObject({
        confidence: null,
        needsFix: "Stored with a confidence that isn't a number: give a confidence from 0 to 1 with lessons--update.",
      });
      expect(listed.negative!.needsFix).toStartWith('Stored with confidence -0.5, outside 0 to 1:');
      expect(listed.whole!.needsFix).toBeUndefined();

      // Ranked clamped: 85 counts as 1, no more, and one that isn't a number as 0.
      const ranked = (await h.m.handleToolCall(call('query', { tags: ['process'] }))).data as { lessons: AnyObj[] };
      expect(ranked.lessons.map(l => l.id)).toEqual(['percent', 'whole', 'nan', 'negative']);
      expect(ranked.lessons[0]).toMatchObject({ confidence: 85, needsFix: expect.stringContaining('confidence 85, outside 0 to 1') });
      const sure = (await h.m.handleToolCall(call('query', { minConfidence: 0.9 }))).data as { lessons: AnyObj[] };
      expect(sure.lessons.map(l => l.id).sort()).toEqual(['percent', 'whole']);
      // At 0, every lesson's ranked value passes, -0.5 and null included,
      // where their stored values wouldn't.
      const all = (await h.m.handleToolCall(call('query', { minConfidence: 0 }))).data as { lessons: AnyObj[] };
      expect(all.lessons.map(l => l.id).sort()).toEqual(['nan', 'negative', 'percent', 'whole']);
      expect(Object.fromEntries(h.m.getLessons().map(l => [l.id, l.confidence]))).toEqual({ percent: 1, nan: 0, negative: 0, whole: 0.95 });

      // The stored record stays as written until the lesson is updated.
      expect(h.stored().find(l => l.id === 'percent')!.confidence).toBe(85);
      await h.m.handleToolCall(call('update', { id: 'percent', confidence: 0.85 }));
      const after = ((await h.m.handleToolCall(call('list'))).data as { lessons: AnyObj[] }).lessons.find(l => l.id === 'percent')!;
      expect(after).toMatchObject({ confidence: 0.85 });
      expect(after.needsFix).toBeUndefined();
    } finally { h.cleanup(); }
  });

  test('the operator log names each one once per load, with the mark the agent\'s list gives it', async () => {
    const h = await loaded(lessons);
    try {
      expect(h.warnings).toEqual([
        '[lessons] lesson "percent": Stored with confidence 85, outside 0 to 1: give a confidence from 0 to 1 with lessons--update.',
        '[lessons] lesson "nan": Stored with a confidence that isn\'t a number: give a confidence from 0 to 1 with lessons--update.',
        '[lessons] lesson "negative": Stored with confidence -0.5, outside 0 to 1: give a confidence from 0 to 1 with lessons--update.',
      ]);
    } finally { h.cleanup(); }
  });

  test('a lesson missing its tags and with confidence out of range names both', async () => {
    const h = await loaded([stored('both', { content: 'epsilon', confidence: 60 })]);
    try {
      const listed = ((await h.m.handleToolCall(call('list'))).data as { lessons: AnyObj[] }).lessons[0]!;
      const mark = 'Stored without usable tags, and with confidence 60, outside 0 to 1: give its tags, and a confidence ' +
        'from 0 to 1 with lessons--update, or deprecate this lesson.';
      expect(listed.needsFix).toBe(mark);
      expect(h.warnings).toEqual([`[lessons] lesson "both": ${mark}`]);
    } finally { h.cleanup(); }
  });

  test('boost and demote leave it as stored, and say to give it a confidence first', async () => {
    const h = await loaded([...lessons, stored('word', { content: 'zeta', tags: ['process'], confidence: 'high' })]);
    const live = () => Object.fromEntries(h.m.getLessonRecords().map(r => [(r.stored as AnyObj).id, structuredClone(r.stored)]));
    const before = live();
    try {
      const boosted = await h.m.handleToolCall(call('boost', { id: 'percent' }));
      expect(boosted).toMatchObject({ success: false, isError: true });
      expect(boosted.error).toBe(
        'Nothing was boosted: lesson "percent" is stored with confidence 85, outside 0 to 1, so it has no confidence ' +
        'to boost from. Give it one from 0 to 1 with lessons--update, then boost it.',
      );
      expect((await h.m.handleToolCall(call('boost', { id: 'word' }))).error).toBe(
        'Nothing was boosted: lesson "word" is stored with a confidence that isn\'t a number, so it has no confidence ' +
        'to boost from. Give it one from 0 to 1 with lessons--update, then boost it.',
      );
      expect((await h.m.handleToolCall(call('demote', { id: 'word' }))).error).toEndWith('then demote it.');
      expect((await h.m.handleToolCall(call('demote', { id: 'negative' }))).success).toBe(false);
      expect((await h.m.handleToolCall(call('demote', { id: 'nan' }))).success).toBe(false);
      // The records the module holds are as they were, updated included.
      expect(live()).toEqual(before);
      const records = Object.fromEntries(h.stored().map(l => [l.id, l.confidence]));
      expect(records.percent).toBe(85);
      expect(records.word).toBe('high');
      expect(records.negative).toBe(-0.5);
      expect(records.nan).toBeNull();
      // One from 0 to 1 still moves.
      expect(((await h.m.handleToolCall(call('boost', { id: 'whole' }))).data as AnyObj).confidence).toBeCloseTo(0.955);
    } finally { h.cleanup(); }
  });
});

describe('a confidence stored as text, or out of range', () => {
  const lessons = [
    stored('text', { content: 'alpha', tags: ['process'], confidence: '0.9' }),
    stored('textpercent', { content: 'beta', tags: ['process'], confidence: '85' }),
    stored('blanktext', { content: 'gamma', tags: ['process'], confidence: ' ' }),
    stored('onehalf', { content: 'epsilon', tags: ['process'], confidence: 1.5 }),
  ];

  test('text that holds a number reads as that number, and the mark says how it\'s stored', async () => {
    const h = await loaded(lessons);
    try {
      expect(Object.fromEntries(h.m.getLessons().map(l => [l.id, l.confidence]))).toEqual({
        text: 0.9, textpercent: 1, blanktext: 0, onehalf: 1,
      });
      const listed = Object.fromEntries(
        ((await h.m.handleToolCall(call('list'))).data as { lessons: AnyObj[] }).lessons.map(l => [l.id, [l.confidence, l.needsFix]]),
      );
      expect(listed).toEqual({
        text: ['0.9', 'Stored with confidence "0.9", stored as text: give a confidence from 0 to 1 with lessons--update.'],
        textpercent: ['85', 'Stored with confidence "85", stored as text, outside 0 to 1: give a confidence from 0 to 1 with lessons--update.'],
        blanktext: [' ', "Stored with a confidence that isn't a number: give a confidence from 0 to 1 with lessons--update."],
        onehalf: [1.5, 'Stored with confidence 1.5, outside 0 to 1: give a confidence from 0 to 1 with lessons--update.'],
      });
      const sure = (await h.m.handleToolCall(call('query', { minConfidence: 0.9 }))).data as { lessons: AnyObj[] };
      expect(sure.lessons.map(l => l.id).sort()).toEqual(['onehalf', 'text', 'textpercent']);
      expect(h.warnings[0]).toBe(
        '[lessons] lesson "text": Stored with confidence "0.9", stored as text: give a confidence from 0 to 1 with lessons--update.',
      );
    } finally { h.cleanup(); }
  });

  test('boost and demote start from the number text holds and store a number; one outside 0 to 1 is refused', async () => {
    const h = await loaded(lessons);
    try {
      expect(((await h.m.handleToolCall(call('boost', { id: 'text' }))).data as AnyObj).confidence).toBeCloseTo(0.91);
      const boosted = h.stored().find(l => l.id === 'text')!.confidence;
      expect(typeof boosted).toBe('number');
      expect(boosted).toBeCloseTo(0.91);
      expect((await h.m.handleToolCall(call('boost', { id: 'textpercent' }))).success).toBe(false);
      expect((await h.m.handleToolCall(call('boost', { id: 'onehalf' }))).success).toBe(false);
    } finally { h.cleanup(); }
    const d = await loaded(lessons);
    try {
      expect(((await d.m.handleToolCall(call('demote', { id: 'text' }))).data as AnyObj).confidence).toBeCloseTo(0.81);
      const demoted = d.stored().find(l => l.id === 'text')!.confidence;
      expect(typeof demoted).toBe('number');
      expect(demoted).toBeCloseTo(0.81);
    } finally { d.cleanup(); }
  });

  test('a number JSON can\'t hold in the shared file, such as 1e999, reads as one that isn\'t a number, and lessons load', async () => {
    const huge = (id: string, n: string) =>
      `{"id": "${id}", "content": "zeta", "tags": ["process"], "confidence": ${n}, "evidence": [], "created": 1, "updated": 1, "deprecated": false}`;
    const h = await loaded([stored('local', { content: 'here', tags: ['x'] })], `{"lessons": [${huge('huge', '1e999')}, ${huge('tiny', '-1e999')}]}`);
    try {
      const listed = Object.fromEntries(
        ((await h.m.handleToolCall(call('list'))).data as { lessons: AnyObj[] }).lessons.map(l => [l.id, [l.confidence, l.needsFix]]),
      );
      const mark = "Stored with a confidence that isn't a number: give a confidence from 0 to 1 with lessons--update.";
      expect(listed.huge).toEqual([null, mark]);
      expect(listed.tiny).toEqual([null, mark]);
      expect(h.warnings).toEqual([`[lessons] lesson "huge": ${mark}`, `[lessons] lesson "tiny": ${mark}`]);
      // The file keeps 1e999 until a save writes the lessons as the module holds them.
      expect(h.fileText()).toContain('1e999');
      await h.m.handleToolCall(call('boost', { id: 'local' }));
      expect(h.file().lessons.find(l => l.id === 'huge')!.confidence).toBeNull();
    } finally { h.cleanup(); }
  });
});

describe('a tags list with entries that aren\'t text', () => {
  test('is read by its text entries: a query by tag finds it, and the mark and the log name its tags', async () => {
    const h = await loaded([stored('mixed', { content: 'memory notes', tags: ['memory', 5, null] })]);
    try {
      const byTag = await h.m.handleToolCall(call('query', { tags: ['memory'] }));
      expect(byTag.success).toBe(true);
      expect(ids(byTag)).toEqual(['mixed']);
      expect(h.m.getLessons()[0]!.tags).toEqual(['memory']);
      const mark = "Stored with tags that aren't all text: give its tags with " +
        'lessons--update, or deprecate this lesson.';
      expect(((byTag.data as { lessons: AnyObj[] }).lessons[0]!).needsFix).toBe(mark);
      expect(h.warnings).toEqual([`[lessons] lesson "mixed": ${mark}`]);
      expect(h.stored()[0]!.tags).toEqual(['memory', 5, null]);
    } finally { h.cleanup(); }
  });
});

describe('two stored lessons that share an id', () => {
  test('each is listed and queried with its own stored confidence and mark', async () => {
    const h = await loaded([
      stored('dup', { content: 'first', tags: ['process'], confidence: 0.9 }),
      stored('dup', { content: 'second', tags: ['process'], confidence: 85 }),
    ]);
    try {
      for (const name of ['list', 'query'] as const) {
        const got = ((await h.m.handleToolCall(call(name, { tags: ['process'] }))).data as { lessons: AnyObj[] }).lessons;
        expect(got.map(l => [l.content, l.confidence, l.needsFix === undefined])).toEqual([['second', 85, false], ['first', 0.9, true]]);
      }
    } finally { h.cleanup(); }
  });

  test('the lesson tools reach the first of them', async () => {
    const h = await loaded([
      stored('dup', { content: 'first', tags: ['process'], confidence: 0.9 }),
      stored('dup', { content: 'second', tags: ['process'], confidence: 85 }),
    ]);
    try {
      expect((await h.m.handleToolCall(call('update', { id: 'dup', confidence: 0.85 }))).success).toBe(true);
      expect(h.stored().map(l => [l.content, l.confidence])).toEqual([['first', 0.85], ['second', 85]]);
    } finally { h.cleanup(); }
  });
});

describe('evidence, and entries in the shared file that aren\'t lessons', () => {
  test('evidence reads as its text entries, a lone value as a list of that one, and an update keeps what is stored', async () => {
    const noEvidence = stored('noevidence', { content: 'alpha', tags: ['process'] });
    delete noEvidence.evidence;
    const h = await loaded([
      noEvidence,
      stored('null', { content: 'beta', tags: ['process'], evidence: null }),
      stored('number', { content: 'gamma', tags: ['process'], evidence: 5 }),
      stored('text', { content: 'delta', tags: ['process'], evidence: 'https://example.com/a' }),
      stored('mixed', { content: 'epsilon', tags: ['process'], evidence: ['s:0', 7] }),
    ]);
    try {
      expect(h.m.getLessons().map(l => [l.id, l.evidence])).toEqual([
        ['noevidence', []], ['null', []], ['number', []], ['text', ['https://example.com/a']], ['mixed', ['s:0']],
      ]);
      for (const id of ['noevidence', 'null', 'number', 'text', 'mixed']) {
        await h.m.handleToolCall(call('update', { id, evidence: ['s:1', 'https://example.com/a'] }));
      }
      expect(Object.fromEntries(h.stored().map(l => [l.id, l.evidence]))).toEqual({
        noevidence: ['s:1', 'https://example.com/a'],
        null: ['s:1', 'https://example.com/a'],
        number: [5, 's:1', 'https://example.com/a'],
        text: ['https://example.com/a', 's:1'],
        mixed: ['s:0', 7, 's:1', 'https://example.com/a'],
      });
      // No mark or log line: nothing ranks, filters or searches by evidence.
      expect(h.warnings).toEqual([]);
    } finally { h.cleanup(); }
  });

  test('a bare value already in the module\'s own state is listed, marked and logged as a lesson no call can name', async () => {
    // main's merge could have saved any value but null from the shared file
    // into the state: it threw reading a null entry's id before saving it.
    // Such a value is left there, and read rather than thrown on.
    for (const value of [5, 'note', true, []]) {
      const h = await loaded([value] as unknown as AnyObj[]);
      try {
        const listed = await h.m.handleToolCall(call('list'));
        expect(listed.success).toBe(true);
        expect((listed.data as { lessons: AnyObj[] }).lessons).toEqual([{
          id: undefined,
          content: '',
          confidence: undefined,
          tags: [],
          deprecated: undefined,
          needsFix: 'Stored without an id, so no lesson tool can name it.',
        }]);
        expect((await h.m.handleToolCall(call('query', { tags: ['x'], text: 'y' }))).success).toBe(true);
        // Readers get its read fields alone: no index keys from text or a list.
        expect(h.m.getLessons()).toEqual([{ content: '', tags: [], evidence: [], confidence: 0 }]);
        expect(h.warnings).toEqual(['[lessons] a lesson: Stored without an id, so no lesson tool can name it.']);
        expect(h.stored()).toEqual([value]);
      } finally { h.cleanup(); }
    }
  });

  test('an entry that isn\'t an object isn\'t loaded, is named by count, and stays in the file after a save', async () => {
    const h = await loaded([], [null, 5, stored('shared', { content: 'from the file', tags: ['x'] })] as AnyObj[]);
    try {
      expect(h.m.getLessons().map(l => l.id)).toEqual(['shared']);
      expect(h.warnings).toHaveLength(1);
      expect(h.warnings[0]).toMatch(/^\[lessons\] the shared lessons file .+ has 2 entries that aren't lessons \(not objects\)\. They're kept in the file, and this host doesn't load them\.$/);
      await h.m.handleToolCall(call('boost', { id: 'shared' }));
      expect(h.file().lessons.map(l => (isObject(l) ? l.id : l))).toEqual([null, 5, 'shared']);
    } finally { h.cleanup(); }
  });

  test('one the module\'s own state also holds stays in the file once after a save, with the lessons this host holds', async () => {
    // An older host's merge saved the file's 5 into the module's state. This
    // load keeps the file's copy as it is, and a save writes that copy back;
    // the state's own 5 has no named id, so it isn't written beside it.
    const h = await loaded([5, stored('local', { content: 'here', tags: ['x'] })] as unknown as AnyObj[],
      [5, stored('shared', { content: 'from the file', tags: ['x'] })] as AnyObj[]);
    try {
      // The carried entry's line, then the state's 5's own, each once.
      expect(h.warnings).toHaveLength(2);
      expect(h.warnings[0]).toMatch(/has 1 entry that isn't a lesson \(not an object\)\. It's kept in the file, and this host doesn't load it\.$/);
      expect(h.warnings[1]).toBe('[lessons] a lesson: Stored without an id, so no lesson tool can name it.');
      await h.m.handleToolCall(call('boost', { id: 'local' }));
      expect(h.file().lessons.map(l => (isObject(l) ? l.id : l))).toEqual([5, 'shared', 'local']);
    } finally { h.cleanup(); }
  });

  test('a lesson no call can name is marked and logged without a remedy: without an id, with an empty one, or one that isn\'t text', async () => {
    const noId = stored('x', { content: 'alpha' });
    delete noId.id;
    const h = await loaded([noId, stored('', { content: 'beta' }), stored(5 as unknown as string, { content: 'gamma' }), stored('withid', { content: 'delta' })]);
    const marks = [
      'Stored without an id, so no lesson tool can name it.',
      'Stored with an empty id, so no lesson tool can name it.',
      "Stored with an id that isn't text (5), so no lesson tool can name it.",
    ];
    const withId = 'Stored without usable tags: give its tags with lessons--update, or deprecate this lesson.';
    try {
      const listed = ((await h.m.handleToolCall(call('list'))).data as { lessons: AnyObj[] }).lessons;
      expect(listed.map(l => [l.id, l.needsFix])).toEqual([[undefined, marks[0]], ['', marks[1]], [5, marks[2]], ['withid', withId]]);
      // Three unnamed lines, then the named lesson's own, each once.
      expect(h.warnings).toEqual([...marks.map(m => `[lessons] a lesson: ${m}`), `[lessons] lesson "withid": ${withId}`]);
    } finally { h.cleanup(); }
  });

  test('a whole lesson no call can name is marked and logged too', async () => {
    const noId = stored('x', { content: 'alpha', tags: ['t'] });
    delete noId.id;
    const h = await loaded([noId, stored('', { content: 'beta', tags: ['t'] }), stored(5 as unknown as string, { content: 'gamma', tags: ['t'] })]);
    const marks = [
      'Stored without an id, so no lesson tool can name it.',
      'Stored with an empty id, so no lesson tool can name it.',
      "Stored with an id that isn't text (5), so no lesson tool can name it.",
    ];
    try {
      const listed = ((await h.m.handleToolCall(call('list'))).data as { lessons: AnyObj[] }).lessons;
      expect(listed.map(l => [l.id, l.needsFix])).toEqual([[undefined, marks[0]], ['', marks[1]], [5, marks[2]]]);
      expect(h.warnings).toEqual(marks.map(m => `[lessons] a lesson: ${m}`));
    } finally { h.cleanup(); }
  });

  test('update, deprecate, boost and demote refuse an id that\'s missing, empty or not text, before looking a lesson up', async () => {
    const noId = stored('x', { content: 'alpha', tags: ['t'] });
    delete noId.id;
    const h = await loaded([noId, stored('', { content: 'beta', tags: ['t'] }), stored(5 as unknown as string, { content: 'gamma', tags: ['t'] })]);
    const before = structuredClone(h.m.getLessonRecords().map(r => r.stored));
    const calls = [
      ['update', 'updated', { content: 'given with no id' }],
      ['deprecate', 'deprecated', { reason: 'given with no id' }],
      ['boost', 'boosted', {}],
      ['demote', 'demoted', {}],
    ] as const;
    try {
      for (const [tool, done, extra] of calls) {
        for (const [id, why] of [
          [undefined, "id is missing: give the lesson's id"],
          ['', "id is empty: give the lesson's id"],
          [5, 'id must be text, such as the id lessons--list shows, not 5'],
        ] as const) {
          const input = id === undefined ? { ...extra } : { id, ...extra };
          const r = await h.m.handleToolCall(call(tool, input));
          expect(r).toMatchObject({ success: false, isError: true });
          expect(r.error).toStartWith(`Nothing was ${done}: ${why}. lessons--list shows lessons with their ids`);
        }
      }
      // Nothing was changed by any of them.
      expect(h.m.getLessonRecords().map(r => r.stored)).toEqual(before);
    } finally { h.cleanup(); }
  });
});

describe('a shared file that holds one entry that isn\'t a lesson, or no lessons at all', () => {
  test('one such entry is named in the singular', async () => {
    const h = await loaded([], [null, stored('shared', { content: 'from the file', tags: ['x'] })] as AnyObj[]);
    try {
      expect(h.m.getLessons().map(l => l.id)).toEqual(['shared']);
      expect(h.warnings).toHaveLength(1);
      expect(h.warnings[0]).toMatch(/^\[lessons\] the shared lessons file .+ has 1 entry that isn't a lesson \(not an object\)\. It's kept in the file, and this host doesn't load it\.$/);
    } finally { h.cleanup(); }
  });

  test('a file that holds just null is named, lessons load, and a save leaves it as it is', async () => {
    const h = await loaded([stored('local', { content: 'here', tags: ['x'] })], 'null');
    try {
      expect(h.m.getLessons().map(l => l.id)).toEqual(['local']);
      expect(h.warnings).toHaveLength(1);
      expect(h.warnings[0]).toMatch(/^\[lessons\] the shared lessons file .+ isn't a lessons file \(no object holding a lessons list\): this host keeps its lessons in its own state and won't write the file until it reads as a lessons file again\.$/);
      await h.m.handleToolCall(call('boost', { id: 'local' }));
      expect(h.fileText()).toBe('null');
    } finally { h.cleanup(); }
  });
});

describe('/export', () => {
  test('writes the lessons as stored in its JSON, and its markdown shows each as ranked with its mark', async () => {
    const noEvidence = stored('noevidence', { content: 'beta', tags: ['process'] });
    delete noEvidence.evidence;
    const h = await loaded([
      stored('percent', { content: 'alpha', tags: ['process'], confidence: 85, evidence: ['s:1'] }),
      noEvidence,
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'lessons-export-'));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const r = handleExport({
        framework: { getAllModules: () => [h.m] },
        sessionManager: { getActiveSession: () => ({ name: 'session' }) },
        recipe: { name: 'recipe' },
      } as never);
      expect(r.lines[0]!.text).toBe('Exported 2 lessons (0 deprecated) to:');
      const json = JSON.parse(readFileSync(join(dir, 'output', 'lessons-export.json'), 'utf-8')) as { lessons: AnyObj[] };
      expect(json.lessons).toEqual(h.stored());
      const md = readFileSync(join(dir, 'output', 'lessons-export.md'), 'utf-8');
      expect(md).toContain(
        '- **[100%]** alpha  \n  _Sources: s:1_  \n  _Stored with confidence 85, outside 0 to 1: give a ' +
        'confidence from 0 to 1 with lessons--update._\n',
      );
      expect(md).toContain('- **[60%]** beta\n');
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
      h.cleanup();
    }
  });
});

// HO-git's regression case, from a pull request to this repository that
// first reported and fixed this crash: a store saved with a lesson that has
// no tags. Here it's read with none and left as stored.
describe('a store saved with a lesson that has no tags', () => {
  test('reads it with no tags beside a tagged one, and a list by tag works', async () => {
    const h = await loaded([
      stored('old1', { content: 'legacy', confidence: 0.5 }),
      stored('old2', { content: 'tagged', confidence: 0.5, tags: ['keep'] }),
    ]);
    try {
      expect(h.m.getLessons().map((l) => l.tags)).toEqual([[], ['keep']]);
      expect(ids(await h.m.handleToolCall(call('list', { tags: ['keep'] })))).toEqual(['old2']);
      expect('tags' in h.stored()[0]!).toBe(false);
    } finally { h.cleanup(); }
  });
});

describe('readers in other modules', () => {
  test("the TUI's /lessons command lists a lesson stored without tags, and one stored at 85 as ranked", async () => {
    const h = await loaded([stored('old1', { content: 'legacy' }), stored('pct', { content: 'percent', tags: ['x'], confidence: 85 })]);
    try {
      const r = handleCommand('/lessons', { framework: { getAllModules: () => [h.m] } } as never);
      expect(r.lines.map((l) => l.text)).toContain('  [60%] old1: legacy ()');
      expect(r.lines.map((l) => l.text)).toContain('  [100%] pct: percent (x)');
    } finally { h.cleanup(); }
  });

  test("the web viewer's lessons list sends [] for a lesson stored without tags, and 1 for one stored at 85", async () => {
    const h = await loaded([stored('old1', { content: 'legacy' }), stored('pct', { content: 'percent', tags: ['x'], confidence: 85 })]);
    const dir = mkdtempSync(join(tmpdir(), 'lessons-webui-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
    const web = new WebUiModule({ port: 0, host: '127.0.0.1', staticDir: dir });
    try {
      await web.start({} as ModuleContext);
      web.setApp({
        framework: { getAllModules: () => [h.m], getAllAgents: () => [], getSessionUsage: () => null, onTrace: () => {} },
      } as never);
      const sent: string[] = [];
      (web as unknown as { sendLessonsList(c: unknown): void }).sendLessonsList({ ws: { send: (s: string) => sent.push(s) } });
      const msg = JSON.parse(sent[0]!);
      expect(msg).toMatchObject({ type: 'lessons-list', loaded: true });
      expect(msg.lessons.map((l: AnyObj) => [l.id, l.tags, l.confidence])).toEqual([['old1', [], 0.6], ['pct', ['x'], 1]]);
    } finally {
      await web.stop();
      await stopWebUiServer();
      rmSync(dir, { recursive: true, force: true });
      h.cleanup();
    }
  });
});

describe('retrieval', () => {
  /** What retrieval injects for these lessons when the recent context asks
   *  about memory: its entries, and the retrieval module for its traces. */
  async function retrieve(h: Awaited<ReturnType<typeof loaded>>) {
    const responses = ['["memory"]'];
    const membrane = {
      complete: async () => ({ content: [{ type: 'text', text: responses.shift() ?? '[]' }] }),
    } as unknown as Membrane;
    const retrieval = new RetrievalModule({ membrane, retrievalModel: 'test-model' });
    (retrieval as unknown as { ctx: unknown }).ctx = {
      getModule: (name: string) => (name === 'lessons' ? h.m : null),
      queryMessages: () => ({
        messages: [{ participant: 'user', content: [{ type: 'text', text: 'Please recall the relevant memory context.' }] }],
        totalCount: 1,
      }),
    };
    const injections = await retrieval.gatherContext('agent');
    const text = (injections[0]!.content[0] as { text: string }).text;
    return { retrieval, entries: text.split('\n').filter(line => line.startsWith('- ')) };
  }

  test('leaves out a lesson with no content, though its tags match, and traces evidence that isn\'t a list as none', async () => {
    const h = await loaded([
      stored('missing', { tags: ['memory'] }),
      stored('blank', { content: ' ', tags: ['memory'] }),
      stored('whole', { content: 'memory detail', tags: ['memory'], evidence: 5 }),
    ]);
    try {
      const { retrieval, entries } = await retrieve(h);
      expect(entries).toEqual(['- [60%] memory detail (tags: memory)']);
      // Its evidence, stored as 5, reaches the trace as none.
      const [run] = retrieval.getRetrievalTraces();
      expect(run!.outcome).toBe('injected');
      expect(run!.injected.lessons.map(l => [l.id, l.evidence])).toEqual([['whole', []]]);
    } finally { h.cleanup(); }
  });

  test('injects a confidence outside 0 to 1 as the one it is ranked by', async () => {
    const h = await loaded([
      stored('percent', { content: 'memory percent', tags: ['memory'], confidence: 85 }),
      stored('whole', { content: 'memory detail', tags: ['memory'] }),
    ]);
    try {
      const { entries } = await retrieve(h);
      expect(entries).toEqual(['- [100%] memory percent (tags: memory)', '- [60%] memory detail (tags: memory)']);
    } finally { h.cleanup(); }
  });
});
