/**
 * The shared lessons file, which several hosts write: a call that changes a
 * lesson reads it and merges it in first, so the change is made to the
 * newest copy and stamped past it, a file this host can't read as a lessons
 * file isn't written over, an entry without a named id is kept in the file
 * and not loaded, and a save replaces the file whole where it can, keeping
 * its other keys and each entry where it stood.
 */
import { describe, test, expect, spyOn } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ModuleContext, ToolCall } from '@animalabs/agent-framework';
import { LessonsModule } from '../src/modules/lessons-module.js';

type AnyObj = Record<string, any>;

const call = (name: string, input: AnyObj = {}): ToolCall => ({ id: `t-${name}`, name, input });

const lesson = (id: unknown, content: string, updated = 1): AnyObj => ({
  ...(id === undefined ? {} : { id }),
  content, tags: ['t'], confidence: 0.6, evidence: [], created: 1, updated, deprecated: false,
});

/** A host: its module state persists across restarts in `state`, and the
 *  shared file is `path`, its own unless another host's is given. Lines
 *  each start and each save logs are kept. The state the module starts from
 *  is a copy, so what it doesn't keep with setState is lost, as in a host. */
function host(shared?: string) {
  const dir = shared ? dirname(shared) : mkdtempSync(join(tmpdir(), 'lessons-shared-'));
  const path = shared ?? join(dir, 'lessons.json');
  let state: unknown = { lessons: [] };
  const lines: string[] = [];
  let m: LessonsModule | null = null;
  const logged = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    const warn = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    try { return await fn(); } finally { warn.mockRestore(); }
  };
  return {
    dir,
    path,
    lines,
    setLessons(lessons: unknown[]) { state = structuredClone({ lessons }); },
    lessons: () => (state as { lessons: unknown[] }).lessons,
    held: () => (state as { heldTwice?: string[] }).heldTwice,
    async start() {
      m = new LessonsModule({ globalPath: path });
      await logged(() => m!.start({ getState: () => structuredClone(state), setState: (s: unknown) => { state = structuredClone(s); } } as unknown as ModuleContext));
    },
    /** A tool call that saves: a new lesson, created with this content. */
    save(content = 'saved') { return logged(() => m!.handleToolCall(call('create', { content, tags: ['t'] }))); },
    update(id: string, content: string) { return logged(() => m!.handleToolCall(call('update', { id, content }))); },
    call(name: string, input: AnyObj) { return logged(() => m!.handleToolCall(call(name, input))); },
    file: () => (JSON.parse(readFileSync(path, 'utf-8')) as { lessons: unknown[] }).lessons,
    fileText: () => readFileSync(path, 'utf-8'),
    cleanup: () => { if (!shared) rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Entries other than the ones saves created, to compare a file before and after. */
const kept = (entries: unknown[]) =>
  entries.filter(e => !(typeof e === 'object' && e !== null && /^saved|^again/.test(String((e as AnyObj).content))));

/** The temporary file's name in an error's text, as a problem is named. */
const tmpOf = (file: string) => join(dirname(file), 'lessons-<random>.tmp');

/** Making the temporary file refused with `code`, while `refusing()`. */
function refuseTemporaryFile(code: string, refusing: () => boolean = () => true) {
  const realOpen = fs.openSync;
  return spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
    if (String(p).endsWith('.tmp') && refusing()) throw Object.assign(new Error(`${code}: refused, open '${p}'`), { code });
    return (realOpen as (...a: unknown[]) => number)(p, ...rest);
  }) as typeof fs.openSync);
}

const contents = (entries: unknown[]) =>
  entries.map(e => (typeof e === 'object' && e !== null && !Array.isArray(e) ? (e as AnyObj).content : e));

describe('a shared file this host can\'t read as a lessons file isn\'t written over', () => {
  test('one that doesn\'t parse: none of its lessons load, it\'s named once, and once it reads again a save merges it in', async () => {
    const h = host();
    try {
      const broken = `{"lessons": [${JSON.stringify(lesson('theirs', 'from another host'))},]}`;
      writeFileSync(h.path, broken);
      h.setLessons([lesson('mine', 'here')]);
      await h.start();
      expect(contents(h.lessons())).toEqual(['here']);
      expect(h.lines).toHaveLength(1);
      expect(h.lines[0]).toMatch(/^\[lessons\] the shared lessons file .+ isn't valid JSON \(.+\): this host keeps its lessons in its own state and won't write the file until it reads as a lessons file again\.$/);

      await h.update('mine', 'here, edited');
      await h.update('mine', 'here, edited again');
      expect(h.fileText()).toBe(broken);
      expect(h.lines).toHaveLength(1);
      expect(contents(h.lessons())).toEqual(['here, edited again']);

      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('theirs', 'from another host')] }));
      await h.update('mine', 'here, after the fix');
      expect(contents(h.lessons()).sort()).toEqual(['from another host', 'here, after the fix']);
      expect(contents(h.file()).sort()).toEqual(['from another host', 'here, after the fix']);
      expect(h.lines).toHaveLength(2);
      expect(h.lines[1]).toBe(`[lessons] the shared lessons file ${h.path} reads as a lessons file again.`);
    } finally { h.cleanup(); }
  });

  test('one of another shape, or an empty object, is named and left as it is', async () => {
    for (const text of ['{"lessns": [{"id": "theirs", "content": "from another host"}]}', '{}']) {
      const h = host();
      try {
        writeFileSync(h.path, text);
        h.setLessons([lesson('mine', 'here')]);
        await h.start();
        expect(h.lines).toEqual([expect.stringMatching(/ isn't a lessons file \(no object holding a lessons list\): /)]);
        await h.save();
        expect(h.fileText()).toBe(text);
      } finally { h.cleanup(); }
    }
  });

  test('one that can\'t be read is named with why, and a change leaves it as it was', async () => {
    const h = host();
    const real = fs.readFileSync;
    const refusal = `EACCES: permission denied, open '${h.path}'`;
    let refuse = true;
    // A read refused on a file a write would replace, so a write would show.
    const spy = spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (p === h.path && refuse) throw Object.assign(new Error(refusal), { code: 'EACCES' });
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readFileSync);
    try {
      const text = JSON.stringify({ lessons: [lesson('theirs', 'from another host')] });
      writeFileSync(h.path, text);
      h.setLessons([lesson('mine', 'here')]);
      await h.start();
      expect(h.lines).toEqual([
        `[lessons] the shared lessons file ${h.path} can't be read (${refusal}): ` +
          "this host keeps its lessons in its own state and won't write the file until it reads as a lessons file again.",
      ]);
      expect((await h.save()).success).toBe(true);
      refuse = false;
      expect(h.fileText()).toBe(text);
      expect(h.lines).toHaveLength(1);
    } finally { spy.mockRestore(); h.cleanup(); }
  });

  test('one that isn\'t UTF-8 text is named, and left as it is', async () => {
    const h = host();
    try {
      // "café" in Latin-1, where é is the lone byte 0xe9.
      const bytes = Buffer.concat([
        Buffer.from('{"lessons": [{"id": "theirs", "content": "caf'),
        Buffer.from([0xe9]),
        Buffer.from('", "tags": ["t"], "confidence": 0.6, "evidence": [], "created": 1, "updated": 1, "deprecated": false}]}'),
      ]);
      writeFileSync(h.path, bytes);
      h.setLessons([lesson('mine', 'here')]);
      await h.start();
      expect(h.lines).toEqual([
        `[lessons] the shared lessons file ${h.path} isn't UTF-8 text: ` +
          "this host keeps its lessons in its own state and won't write the file until it reads as a lessons file again.",
      ]);
      await h.save();
      expect(readFileSync(h.path).equals(bytes)).toBe(true);
    } finally { h.cleanup(); }
  });

  test('one that starts with a byte-order mark reads, and is written back without it', async () => {
    const h = host();
    try {
      writeFileSync(h.path, '\ufeff' + JSON.stringify({ lessons: [lesson('theirs', 'from another host')] }));
      await h.start();
      expect(h.lines).toEqual([]);
      await h.save('saved');
      expect(h.fileText().startsWith('{')).toBe(true);
      expect(contents(h.file())).toEqual(['from another host', 'saved']);
    } finally { h.cleanup(); }
  });

  test('one that reads again is said so at that read, and a later break the same way is named again', async () => {
    const h = host();
    try {
      const broken = '{"lessons": [';
      writeFileSync(h.path, broken);
      h.setLessons([lesson('mine', 'here')]);
      await h.start();
      writeFileSync(h.path, JSON.stringify({ lessons: [] }));
      // A call refused after its read, so nothing is written.
      expect((await h.update('nope', 'no such lesson')).success).toBe(false);
      writeFileSync(h.path, broken);
      await h.save('saved');
      expect(h.lines).toHaveLength(3);
      expect(h.lines[1]).toBe(`[lessons] the shared lessons file ${h.path} reads as a lessons file again.`);
      expect(h.lines[2]).toBe(h.lines[0]);
      expect(h.fileText()).toBe(broken);
    } finally { h.cleanup(); }
  });

  test('one moved aside: the next change makes a new file, and says it wasn\'t there', async () => {
    const h = host();
    try {
      writeFileSync(h.path, '{"lessons": [');
      h.setLessons([lesson('mine', 'here')]);
      await h.start();
      fs.renameSync(h.path, `${h.path}.broken`);
      await h.save('saved');
      expect(contents(h.file())).toEqual(['here', 'saved']);
      expect(h.lines.slice(1)).toEqual([`[lessons] the shared lessons file ${h.path} wasn't there: this host wrote it with its lessons.`]);
    } finally { h.cleanup(); }
  });
});

describe('a save reads the shared file again and merges it in', () => {
  test('with no file, the first save writes one, and says so', async () => {
    const h = host();
    try {
      h.setLessons([lesson('mine', 'here')]);
      await h.start();
      expect(h.lines).toEqual([]);
      await h.save();
      expect(contents(h.file())).toEqual(['here', 'saved']);
      expect(h.lines).toEqual([`[lessons] the shared lessons file ${h.path} wasn't there: this host wrote it with its lessons.`]);
    } finally { h.cleanup(); }
  });

  test('a lesson another host adds after this one starts reaches this host at its next save, and stays in the file', async () => {
    const h = host();
    try {
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('theirs', 'from another host')] }));
      h.setLessons([lesson('mine', 'here')]);
      await h.start();
      writeFileSync(h.path, JSON.stringify({ lessons: [...h.file(), lesson('later', 'added after this host started')] }));
      await h.update('mine', 'here, edited');
      expect(contents(h.file()).sort()).toEqual(['added after this host started', 'from another host', 'here, edited']);
      expect(contents(h.lessons()).sort()).toEqual(['added after this host started', 'from another host', 'here, edited']);
    } finally { h.cleanup(); }
  });

  test('the newer of two copies of a lesson wins, whichever side holds it', async () => {
    const h = host();
    try {
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('a', 'a, older in the file', 1), lesson('b', 'b, newer in the file', 9)] }));
      h.setLessons([lesson('a', 'a, newer here', 5), lesson('b', 'b, older here', 2)]);
      await h.start();
      await h.save();
      expect(contents(kept(h.file())).sort()).toEqual(['a, newer here', 'b, newer in the file']);
    } finally { h.cleanup(); }
  });

  test('a hand edit that left updated as it was is what the host holds and writes back', async () => {
    const h = host();
    try {
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'X', 5)] }));
      h.setLessons([lesson('x', 'X', 5)]);
      await h.start();
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'X, edited by hand', 5)] }));
      await h.save('saved');
      expect(contents(h.file())).toEqual(['X, edited by hand', 'saved']);
      expect(contents(h.lessons())).toEqual(['X, edited by hand', 'saved']);
    } finally { h.cleanup(); }
  });

  test('a newer copy in the file replaces the host\'s whole, so a field it left out is gone', async () => {
    const h = host();
    try {
      const deprecated = { ...lesson('x', 'X', 5), deprecated: true, deprecationReason: 'no longer true' };
      writeFileSync(h.path, JSON.stringify({ lessons: [deprecated] }));
      h.setLessons([deprecated]);
      await h.start();
      // Taken back by hand: not deprecated, and no reason.
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'X', 6)] }));
      await h.save('saved');
      expect((h.file() as AnyObj[])[0]).toEqual(lesson('x', 'X', 6));
      expect((h.lessons() as AnyObj[])[0]).toEqual(lesson('x', 'X', 6));
    } finally { h.cleanup(); }
  });

  test('a copy whose updated isn\'t a number ranks below one whose is, and a change stamps it', async () => {
    const h = host();
    try {
      const unstamped = lesson('x', 'X, here');
      delete unstamped.updated;
      const y = { ...lesson('y', 'Y'), updated: 'yesterday' };
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'X, in the file', 5), y] }));
      h.setLessons([unstamped, y]);
      await h.start();
      expect(contents(h.lessons())).toEqual(['X, in the file', 'Y']);
      expect((await h.call('boost', { id: 'y' })).success).toBe(true);
      expect(Number.isFinite((h.file() as AnyObj[])[1].updated)).toBe(true);
    } finally { h.cleanup(); }
  });

  test('a copy stamped past Number.MAX_SAFE_INTEGER, which a change can\'t stamp past, ranks below one stamped as a clock would', async () => {
    const h = host();
    try {
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'X, hand-edited', 1e20)] }));
      h.setLessons([lesson('x', 'X, here', 5)]);
      await h.start();
      expect(contents(h.lessons())).toEqual(['X, here']);
      await h.save('saved');
      expect(contents(h.file())).toEqual(['X, here', 'saved']);
    } finally { h.cleanup(); }
  });

  test('a change to a copy stamped past Number.MAX_SAFE_INTEGER outranks it, so a failed write doesn\'t lose it to the file\'s copy', async () => {
    const h = host();
    try {
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'X', 1e20)] }));
      h.setLessons([lesson('x', 'X', 1e20)]);
      await h.start();
      const refuse = refuseTemporaryFile('EIO');
      try {
        expect((await h.update('x', 'X, edited')).success).toBe(true);
      } finally { refuse.mockRestore(); }
      expect(contents(h.file())).toEqual(['X']);
      await h.save('saved');
      expect(contents(h.lessons())).toEqual(['X, edited', 'saved']);
      expect(contents(h.file())).toEqual(['X, edited', 'saved']);
    } finally { h.cleanup(); }
  });

  test('a change to a copy stamped Number.MAX_SAFE_INTEGER takes that same stamp, the largest one ranked', async () => {
    const h = host();
    try {
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'X', Number.MAX_SAFE_INTEGER)] }));
      await h.start();
      expect((await h.update('x', 'X, edited')).success).toBe(true);
      expect((h.file() as AnyObj[])[0]).toMatchObject({ content: 'X, edited', updated: Number.MAX_SAFE_INTEGER });
      expect((await h.update('x', 'X, edited again')).success).toBe(true);
      expect((h.file() as AnyObj[])[0]).toMatchObject({ content: 'X, edited again', updated: Number.MAX_SAFE_INTEGER });
    } finally { h.cleanup(); }
  });
});

describe('an entry without a named id is kept in the file, and isn\'t loaded', () => {
  // Each case: what the module's state and the shared file hold at start. A
  // named id is non-empty text that at most one entry of the file and at most
  // one of the module's lessons holds. Some of these, the start merge on main
  // overwrote or dropped.
  const cases: Array<{ name: string; state: unknown[]; file: unknown[]; loaded: string[] }> = [
    { name: 'two lessons without an id', state: [], file: [lesson(undefined, 'X'), lesson(undefined, 'Y', 2)], loaded: [] },
    { name: 'one without an id here, and it and another in the file', state: [lesson(undefined, 'X')], file: [lesson(undefined, 'X'), lesson(undefined, 'Y', 2)], loaded: ['X'] },
    { name: 'a bare value here, and a lesson without an id in the file', state: [5], file: [lesson(undefined, 'Y', 2)], loaded: [] },
    { name: 'an id the file holds twice', state: [], file: [lesson('dup', 'D1'), lesson('dup', 'D2', 2)], loaded: [] },
    { name: 'an id held once here and twice in the file', state: [lesson('dup', 'D1')], file: [lesson('dup', 'D1'), lesson('dup', 'D2', 2)], loaded: ['D1'] },
    { name: 'an id held twice here and once in the file', state: [lesson('dup', 'D1'), lesson('dup', 'D2', 2)], file: [lesson('dup', 'D3', 3)], loaded: ['D1', 'D2'] },
    { name: 'an empty id twice, and entries that aren\'t objects', state: [], file: [lesson('', 'E1'), lesson('', 'E2', 2), null, 'note'], loaded: [] },
    { name: 'ids that aren\'t text', state: [], file: [lesson(5, 'F'), lesson(true, 'G', 2)], loaded: [] },
  ];

  for (const c of cases) {
    test(`${c.name}: no save adds or loses an entry, across a restart`, async () => {
      const h = host();
      try {
        writeFileSync(h.path, JSON.stringify({ lessons: c.file }));
        h.setLessons(c.state);
        await h.start();
        // The module holds what it held, and nothing from the file.
        expect(contents(h.lessons()).filter(x => x !== 5)).toEqual(c.loaded);
        await h.save('saved');
        const first = h.file();
        // Every entry of the file, once, beside the lesson this save created.
        expect(kept(first)).toEqual(c.file);
        await h.start();
        await h.save('again');
        expect(kept(h.file())).toEqual(c.file);
        expect(contents(h.lessons()).filter(x => x !== 5).sort()).toEqual([...c.loaded, 'again', 'saved'].sort());
      } finally { h.cleanup(); }
    });
  }

  test('the start line counts them, and entries that aren\'t objects, and says they\'re kept', async () => {
    const h = host();
    try {
      writeFileSync(h.path, JSON.stringify({ lessons: [5, lesson(undefined, 'X'), lesson('', 'E'), lesson('named', 'N')] }));
      await h.start();
      expect(h.lines).toEqual([
        "[lessons] the shared lessons file " + h.path + " has 1 entry that isn't a lesson (not an object) and 2 lessons " +
          'without a named id (text, not empty, held once at most in the file and once at most on this host). ' +
          "They're kept in the file, and this host doesn't load them.",
      ]);
      expect(contents(h.lessons())).toEqual(['N']);
    } finally { h.cleanup(); }
  });

  test('one added while the host runs is named at its next change, and only when what it carries changes', async () => {
    const h = host();
    try {
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('named', 'N')] }));
      await h.start();
      expect(h.lines).toEqual([]);
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('named', 'N'), lesson(undefined, 'X')] }));
      await h.save('saved');
      await h.save('saved again');
      expect(h.lines).toEqual([
        `[lessons] the shared lessons file ${h.path} has 1 lesson without a named id (text, not empty, held once at most in the file and once at most on this host). ` +
          "It's kept in the file, and this host doesn't load it.",
      ]);
      expect(contents(h.file())).toEqual(['N', 'X', 'saved', 'saved again']);
    } finally { h.cleanup(); }
  });
});

describe('a call that changes a lesson reads the file first, so it changes the newest copy', () => {
  // Host A edits X's content, then host B, whose copy of X is older, changes
  // X another way. B's change has the newer stamp, so made to its own copy it
  // would write A's edit away.
  const cases: Array<{ name: string; input: AnyObj; check: (x: AnyObj) => void }> = [
    { name: 'update', input: { id: 'x', tags: ['u'] }, check: (x) => expect(x.tags).toEqual(['u']) },
    { name: 'deprecate', input: { id: 'x', reason: 'no longer true' }, check: (x) => expect(x.deprecated).toBe(true) },
    { name: 'boost', input: { id: 'x' }, check: (x) => expect(x.confidence).toBeCloseTo(0.64) },
    { name: 'demote', input: { id: 'x' }, check: (x) => expect(x.confidence).toBeCloseTo(0.54) },
  ];
  for (const c of cases) {
    test(`${c.name} after another host's edit keeps the edit`, async () => {
      const a = host();
      const b = host(a.path);
      try {
        writeFileSync(a.path, JSON.stringify({ lessons: [lesson('x', 'X')] }));
        await a.start();
        await b.start();
        expect((await a.update('x', 'X, edited by A')).success).toBe(true);
        expect((await b.call(c.name, c.input)).success).toBe(true);
        const [x] = a.file() as AnyObj[];
        expect(x.content).toBe('X, edited by A');
        c.check(x);
      } finally { a.cleanup(); }
    });
  }

  test('a change lost to another host\'s write at nearly the same moment comes back at this host\'s next change', async () => {
    const a = host();
    const b = host(a.path);
    try {
      writeFileSync(a.path, JSON.stringify({ lessons: [lesson('x', 'X'), lesson('y', 'Y')] }));
      await a.start();
      await b.start();
      const before = a.fileText();
      expect((await b.call('boost', { id: 'y' })).success).toBe(true);
      // Another host read the file before B's write and wrote it after:
      // Y is back as it was before B's boost.
      writeFileSync(a.path, before);
      expect((a.file() as AnyObj[])[1].confidence).toBe(0.6);
      expect((await b.call('demote', { id: 'x' })).success).toBe(true);
      const [x, y] = a.file() as AnyObj[];
      expect(x.confidence).toBeCloseTo(0.54);
      expect(y.confidence).toBeCloseTo(0.64);
    } finally { a.cleanup(); }
  });

  test('a change made on a copy outranks it, whatever the hosts\' clocks say', async () => {
    const a = host();
    const b = host(a.path);
    const realNow = Date.now;
    const at = async <T>(ms: number, fn: () => Promise<T>): Promise<T> => {
      Date.now = () => ms;
      try { return await fn(); } finally { Date.now = realNow; }
    };
    try {
      const now = realNow();
      writeFileSync(a.path, JSON.stringify({ lessons: [lesson('x', 'X')] }));
      await a.start();
      await b.start();
      // A's clock runs a minute ahead of B's. A's change takes A's time, and
      // B's, one past the copy B made it on.
      expect((await at(now + 60_000, () => a.update('x', 'X, edited by A'))).success).toBe(true);
      expect((a.file() as AnyObj[])[0].updated).toBe(now + 60_000);
      expect((await at(now, () => b.call('update', { id: 'x', tags: ['b'] }))).success).toBe(true);
      expect((a.file() as AnyObj[])[0].updated).toBe(now + 60_001);
      // A's next change reads B's, made on A's copy, and keeps it.
      expect((await at(now + 60_001, () => a.save('saved'))).success).toBe(true);
      const [x] = a.file() as AnyObj[];
      expect(x.content).toBe('X, edited by A');
      expect(x.tags).toEqual(['b']);
    } finally { a.cleanup(); }
  });

  test('a new lesson takes an id neither the file nor this host holds', async () => {
    const h = host();
    const ids = ['aaaaaaaa-0000-4000-8000-000000000000', 'bbbbbbbb-0000-4000-8000-000000000000', 'cccccccc-0000-4000-8000-000000000000'];
    const spy = spyOn(crypto, 'randomUUID').mockImplementation(() => ids.shift() as ReturnType<typeof crypto.randomUUID>);
    try {
      // The file holds aaaaaaaa twice, so the merge carries both and the host
      // never holds that id; this host holds bbbbbbbb.
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('aaaaaaaa', 'theirs'), lesson('aaaaaaaa', 'theirs too', 2)] }));
      h.setLessons([lesson('bbbbbbbb', 'mine')]);
      await h.start();
      expect(((await h.save('new')).data as AnyObj).id).toBe('cccccccc');
      expect((h.file() as AnyObj[]).map(l => l.id)).toEqual(['aaaaaaaa', 'aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
    } finally { spy.mockRestore(); h.cleanup(); }
  });

  test('a lesson of this host\'s whose id the file holds twice is named once, and isn\'t written', async () => {
    const h = host();
    try {
      const file = [lesson('dup', 'D1'), lesson('dup', 'D2', 2)];
      writeFileSync(h.path, JSON.stringify({ lessons: file }));
      h.setLessons([lesson('dup', 'mine')]);
      await h.start();
      h.lines.length = 0;
      // Changes to other lessons write the file; one to it is refused.
      await h.save('saved');
      await h.save('saved again');
      expect(h.lines).toEqual([
        `[lessons] the shared lessons file ${h.path}, or this host, holds another lesson with the id of a lesson this host holds (dup): ` +
          "this host keeps it in its own state and doesn't write it to the file. " +
          'To keep every lesson with the id "dup", give the one with updated 1 a new id in the file.',
      ]);
      expect(kept(h.file())).toEqual(file);
      expect((h.lessons() as AnyObj[])[0]).toEqual(lesson('dup', 'mine'));
    } finally { h.cleanup(); }
  });

  test('two of this host\'s lessons with one id are counted as two', async () => {
    const h = host();
    try {
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('dup', 'D3', 3)] }));
      h.setLessons([lesson('dup', 'D1'), lesson('dup', 'D2', 2)]);
      await h.start();
      h.lines.length = 0;
      await h.save('saved');
      expect(h.lines).toEqual([
        `[lessons] the shared lessons file ${h.path}, or this host, holds another lesson with the id of 2 lessons this host holds (dup): ` +
          "this host keeps them in its own state and doesn't write them to the file.",
      ]);
    } finally { h.cleanup(); }
  });
});

describe('while the file holds an id of this host\'s lessons twice, the host changes neither, and once that\'s resolved, the file\'s copy wins once', () => {
  const refusal = (verb: string, holds = 'holds', advice = 'give the one with updated 1 a new id in the file') =>
    `Nothing was ${verb}: the shared lessons file ${holds} another lesson with the id "x", so this host can't tell which of them this one is, ` +
    `and a change to it couldn't be shared. It waits on whoever runs the host, who can ${advice}.`;
  const allButOne = 'give all but one of them a new id in the file, leaving the id on one with the latest updated';
  const calls: Array<{ name: string; input: AnyObj; verb: string }> = [
    { name: 'update', input: { id: 'x', content: 'one, edited' }, verb: 'updated' },
    { name: 'deprecate', input: { id: 'x', reason: 'no longer true' }, verb: 'deprecated' },
    { name: 'boost', input: { id: 'x' }, verb: 'boosted' },
    { name: 'demote', input: { id: 'x' }, verb: 'demoted' },
  ];
  for (const c of calls) {
    test(`${c.name} is refused, and names the entry to give a new id`, async () => {
      const h = host();
      try {
        writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one', 5)] }));
        await h.start();
        writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one', 5), lesson('x', 'two', 1)] }));
        const r = await h.call(c.name, c.input);
        expect(r).toEqual({ success: false, isError: true, error: refusal(c.verb) });
        expect(h.lessons()).toEqual([lesson('x', 'one', 5)]);
      } finally { h.cleanup(); }
    });
  }

  test('on a tie, the refusal says either one can take the new id', async () => {
    const h = host();
    try {
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one')] }));
      await h.start();
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one'), lesson('x', 'two')] }));
      const r = await h.call('update', { id: 'x', content: 'one, edited' });
      expect(r.error).toBe(refusal('updated', 'holds', 'give either one a new id in the file (neither\'s updated is later)'));
    } finally { h.cleanup(); }
  });

  test('of two, one with no updated is the one to give a new id', async () => {
    const h = host();
    try {
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one', 5)] }));
      await h.start();
      const { updated: _, ...two } = lesson('x', 'two');
      writeFileSync(h.path, JSON.stringify({ lessons: [two, lesson('x', 'one', 5)] }));
      const r = await h.call('update', { id: 'x', content: 'one, edited' });
      expect(r.error).toBe(refusal('updated', 'holds', 'give the one with no updated a new id in the file'));
    } finally { h.cleanup(); }
  });

  // All tied, and one later than the other two.
  for (const stamps of [[5, 5, 5], [5, 1, 1]]) {
    test(`of three with updated ${stamps.join(', ')}, the refusal says to give all but one a new id`, async () => {
      const h = host();
      try {
        writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one', 5)] }));
        await h.start();
        writeFileSync(h.path, JSON.stringify({ lessons: ['one', 'two', 'three'].map((c, i) => lesson('x', c, stamps[i])) }));
        const r = await h.call('update', { id: 'x', content: 'one, edited' });
        expect(r.error).toBe(refusal('updated', 'holds', allButOne));
      } finally { h.cleanup(); }
    });
  }

  test('while the file can\'t be read, a change to a lesson whose id it last held twice is refused too', async () => {
    const h = host();
    try {
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one', 5)] }));
      await h.start();
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one', 5), lesson('x', 'two', 1)] }));
      expect((await h.call('boost', { id: 'x' })).success).toBe(false);
      writeFileSync(h.path, '{"lessons": [');
      const r = await h.call('update', { id: 'x', content: 'one, edited' });
      expect(r.error).toBe(refusal('updated', 'held, when this host last read it,', allButOne));
      expect(h.lessons()).toEqual([lesson('x', 'one', 5)]);
    } finally { h.cleanup(); }
  });

  test('an id the file no longer holds is let go at that read, so a change while the file can\'t be read is made', async () => {
    const h = host();
    try {
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one', 5)] }));
      await h.start();
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one', 5), lesson('x', 'two', 1)] }));
      expect((await h.call('boost', { id: 'x' })).success).toBe(false);
      // Both taken out by hand: the next change's read finds neither.
      writeFileSync(h.path, JSON.stringify({ lessons: [] }));
      await h.save('saved');
      writeFileSync(h.path, '{"lessons": [');
      expect((await h.update('x', 'one, edited')).success).toBe(true);
    } finally { h.cleanup(); }
  });

  test('an id this host itself holds twice isn\'t held, so a change while the file can\'t be read is made', async () => {
    const h = host();
    try {
      h.setLessons([lesson('x', 'mine'), lesson('x', 'mine too')]);
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one'), lesson('x', 'two')] }));
      await h.start();
      writeFileSync(h.path, '{"lessons": [');
      expect((await h.update('x', 'mine, edited')).success).toBe(true);
    } finally { h.cleanup(); }
  });

  test('an id let go and another held in one read: the new one is kept, and refused after a restart while the file can\'t be read', async () => {
    const h = host();
    try {
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one'), lesson('y', 'why')] }));
      await h.start();
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one'), lesson('x', 'two'), lesson('y', 'why')] }));
      expect((await h.call('boost', { id: 'x' })).success).toBe(false);
      // x is gone from the file and y is doubled, both by hand. The call is
      // refused, so only its read keeps the state.
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('y', 'why'), lesson('y', 'why too')] }));
      expect((await h.call('boost', { id: 'y' })).success).toBe(false);
      // The restart can't read the file, so the host goes by what it kept.
      writeFileSync(h.path, '{"lessons": [');
      await h.start();
      const r = await h.call('update', { id: 'y', content: 'why, edited' });
      expect(r.error).toBe(refusal('updated', 'held, when this host last read it,', allButOne).replace('"x"', '"y"'));
      expect((await h.update('x', 'one, edited')).success).toBe(true);
    } finally { h.cleanup(); }
  });

  test('a change made while the file is away, whose write fails, is dropped once the file comes back resolved as the refusal advises, and both lessons are kept', async () => {
    const h = host();
    try {
      // This host's copy is the one the refusal says to give a new id.
      h.setLessons([lesson('x', 'two', 3)]);
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one', 5), lesson('x', 'two', 3)] }));
      await h.start();
      expect(h.held()).toEqual(['x']);
      rmSync(h.path);
      // The write that would make the file again fails.
      const refuse = refuseTemporaryFile('EACCES');
      try {
        expect((await h.update('x', 'two, edited while the file was away')).success).toBe(true);
      } finally { refuse.mockRestore(); }
      expect(h.held()).toEqual(['x']);
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one', 5), lesson('y', 'two', 3)] }));
      await h.save('saved');
      expect(contents(h.lessons())).toEqual(['one', 'two', 'saved']);
      expect(contents(h.file())).toEqual(['one', 'two', 'saved']);
    } finally { h.cleanup(); }
  });

  test('the advice isn\'t given for an id this host itself holds twice, which no fix in the file lets it write', async () => {
    const h = host();
    try {
      h.setLessons([lesson('x', 'mine'), lesson('x', 'mine too')]);
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one', 5), lesson('x', 'two', 1)] }));
      await h.start();
      h.lines.length = 0;
      await h.save('saved');
      expect(h.lines).toEqual([
        `[lessons] the shared lessons file ${h.path}, or this host, holds another lesson with the id of 2 lessons this host holds (x): ` +
          "this host keeps them in its own state and doesn't write them to the file.",
      ]);
    } finally { h.cleanup(); }
  });

  // The instruction followed, on a host that never read the file while it
  // held the id twice, and one that did.
  for (const two of [lesson('x', 'two', 1), lesson('x', 'two', 9)]) {
    test(`giving the entry with the earlier updated a new id keeps both on every host, with the other entry ${two.updated === 1 ? 'older' : 'newer'}`, async () => {
      const a = host();
      const b = host(a.path);
      try {
        writeFileSync(a.path, JSON.stringify({ lessons: [lesson('x', 'one', 5)] }));
        await a.start();
        await b.start();
        writeFileSync(a.path, JSON.stringify({ lessons: [lesson('x', 'one', 5), two] }));
        await a.save('a saved');
        const resolved = (a.file() as AnyObj[]).map((e) =>
          e.id === 'x' && e.updated === Math.min(5, two.updated) ? { ...e, id: 'renamed' } : e);
        writeFileSync(a.path, JSON.stringify({ lessons: resolved }));
        await b.save('b saved');
        await a.save('a saved again');
        const held = (h: ReturnType<typeof host>) => contents(h.lessons()).filter((c) => c === 'one' || c === 'two').sort();
        expect(held(a)).toEqual(['one', 'two']);
        expect(held(b)).toEqual(['one', 'two']);
        expect(contents(a.file()).filter((c) => c === 'one' || c === 'two').sort()).toEqual(['one', 'two']);
      } finally { a.cleanup(); }
    });
  }

  // Each: the file holds x = "one", which the host merges; "two" lands beside
  // it under x; the host's call is refused; the operator resolves the two.
  const resolutions: Array<{ name: string; two: AnyObj; resolved: AnyObj[]; file: string[] }> = [
    { name: 'a copy, and the original removed', two: lesson('x', 'two'), resolved: [lesson('x', 'two')], file: ['x:two'] },
    { name: 'a copy, and the original given a new id', two: lesson('x', 'two'), resolved: [lesson('z', 'one'), lesson('x', 'two')], file: ['z:one', 'x:two'] },
    { name: 'a copy, and the copy given a new id', two: lesson('x', 'two'), resolved: [lesson('x', 'one'), lesson('y', 'two')], file: ['x:one', 'y:two'] },
    { name: 'an older lesson, and the original removed', two: lesson('x', 'two', 0), resolved: [lesson('x', 'two', 0)], file: ['x:two'] },
  ];
  for (const c of resolutions) {
    test(`${c.name}: the lesson left keeps the id, across a restart after it's resolved`, async () => {
      const h = host();
      try {
        writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one')] }));
        await h.start();
        writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one'), c.two] }));
        expect((await h.call('update', { id: 'x', content: 'one, edited' })).success).toBe(false);
        writeFileSync(h.path, JSON.stringify({ lessons: c.resolved }));
        // The host restarts before it reads the resolved file.
        await h.start();
        await h.save('saved');
        await h.save('saved again');
        const ids = (h.file() as AnyObj[]).map(l => `${l.id}:${l.content}`);
        expect(ids).toEqual([...c.file, expect.stringMatching(/:saved$/), expect.stringMatching(/:saved again$/)]);
      } finally { h.cleanup(); }
    });
  }

  test('once resolved, the id merges as any other: a change lost to a race comes back', async () => {
    const h = host();
    try {
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one')] }));
      await h.start();
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one'), lesson('x', 'two')] }));
      expect((await h.call('update', { id: 'x', content: 'one, edited' })).success).toBe(false);
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('x', 'one'), lesson('y', 'two')] }));
      await h.save('saved');
      const before = h.fileText();
      expect((await h.update('x', 'one, edited')).success).toBe(true);
      // Another host read the file before that write and wrote it after.
      writeFileSync(h.path, before);
      await h.save('saved again');
      expect(contents(h.file())).toEqual(['one, edited', 'two', 'saved', 'saved again']);
    } finally { h.cleanup(); }
  });
});

describe('a save replaces the file whole where it can', () => {
  test('it keeps the file\'s other keys, and each entry where it stood', async () => {
    const h = host();
    try {
      writeFileSync(h.path, JSON.stringify({ version: 2, note: 'by hand', lessons: [lesson('b', 'B'), 5, lesson('a', 'A')] }));
      await h.start();
      await h.update('a', 'A, edited');
      await h.save('new');
      const doc = JSON.parse(h.fileText()) as AnyObj;
      expect(doc.version).toBe(2);
      expect(doc.note).toBe('by hand');
      expect(contents(doc.lessons)).toEqual(['B', 5, 'A, edited', 'new']);
    } finally { h.cleanup(); }
  });

  test('a carried entry is written back as JSON.parse reads it', async () => {
    const h = host();
    try {
      writeFileSync(h.path, '{"lessons": [{"content": "no id", "confidence": 1e999, "n": 1234567890123456789}]}');
      await h.start();
      await h.save('saved');
      expect(h.file()[0]).toEqual({ content: 'no id', confidence: null, n: 1234567890123456800 });
    } finally { h.cleanup(); }
  });

  test('a link to the file stays a link, and the save reaches the file it points to', async () => {
    const h = host();
    try {
      mkdirSync(join(h.dir, 'real'));
      const target = join(h.dir, 'real', 'lessons.json');
      writeFileSync(target, JSON.stringify({ lessons: [lesson('theirs', 'from another host')] }));
      fs.symlinkSync(target, h.path);
      await h.start();
      await h.save('saved');
      expect(fs.lstatSync(h.path).isSymbolicLink()).toBe(true);
      expect(contents((JSON.parse(readFileSync(target, 'utf-8')) as { lessons: unknown[] }).lessons)).toEqual(['from another host', 'saved']);
    } finally { h.cleanup(); }
  });

  test('a link to a file not made yet: the first save makes the file it points to, and the link stays a link', async () => {
    const h = host();
    try {
      mkdirSync(join(h.dir, 'real'));
      const target = join(h.dir, 'real', 'lessons.json');
      fs.symlinkSync(target, h.path);
      h.setLessons([lesson('mine', 'here')]);
      await h.start();
      await h.save('saved');
      expect(fs.lstatSync(h.path).isSymbolicLink()).toBe(true);
      expect(contents((JSON.parse(readFileSync(target, 'utf-8')) as { lessons: unknown[] }).lessons)).toEqual(['here', 'saved']);
    } finally { h.cleanup(); }
  });

  test('a file with a second name is written in place, so both names keep sharing it, and says so once', async () => {
    const h = host();
    try {
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('theirs', 'from another host')] }));
      const other = join(h.dir, 'other-name.json');
      fs.linkSync(h.path, other);
      await h.start();
      await h.save('saved');
      await h.save('saved again');
      expect(contents(h.file())).toEqual(['from another host', 'saved', 'saved again']);
      expect(readFileSync(other, 'utf-8')).toBe(h.fileText());
      expect(h.lines).toEqual([
        `[lessons] the shared lessons file ${h.path} is written in place, since it has another name, which replacing it would leave holding the old text: ` +
          'a write that fails partway can leave it broken.',
      ]);
    } finally { h.cleanup(); }
  });

  test('the file keeps its permissions, and the temporary file is made no more open than it', async () => {
    for (const mode of [0o666, 0o600]) {
      const h = host();
      const real = fs.chmodSync;
      writeFileSync(h.path, JSON.stringify({ lessons: [] }));
      real(h.path, mode);
      const atMaking: number[] = [];
      const spy = spyOn(fs, 'chmodSync').mockImplementation(((p: fs.PathLike, m: fs.Mode) => {
        if (String(p).endsWith('.tmp')) atMaking.push(fs.statSync(p).mode & 0o777);
        return real(p, m);
      }) as typeof fs.chmodSync);
      // A umask that narrows 0666, so the file's mode is the module's doing.
      const umask = process.umask(0o022);
      try {
        await h.start();
        await h.save('saved');
        expect(fs.statSync(h.path).mode & 0o777).toBe(mode);
        expect(contents(h.file())).toEqual(['saved']);
        expect(atMaking).toHaveLength(1);
        expect(atMaking[0] & ~mode).toBe(0);
      } finally { process.umask(umask); spy.mockRestore(); h.cleanup(); }
    }
  });

  // Root writes it anyway. With a second name too, it's refused, not said
  // to be written in place.
  for (const secondName of [false, true]) {
    test.skipIf(process.getuid?.() === 0)(`a file this host can't write${secondName ? ', with a second name,' : ''} is refused, and named, as on main`, async () => {
      const h = host();
      try {
        const text = JSON.stringify({ lessons: [lesson('theirs', 'from another host')] });
        writeFileSync(h.path, text);
        if (secondName) fs.linkSync(h.path, join(h.dir, 'other-name.json'));
        fs.chmodSync(h.path, 0o444);
        await h.start();
        await h.save('saved');
        await h.save('saved again');
        expect(h.fileText()).toBe(text);
        expect(fs.statSync(h.path).mode & 0o777).toBe(0o444);
        expect(h.lines).toEqual([
          `[lessons] the shared lessons file ${h.path} couldn't be written (EACCES: permission denied, open '${h.path}'): ` +
            'this host keeps its lessons in its own state and tries again at its next save.',
        ]);
      } finally { h.cleanup(); }
    });
  }

  for (const code of ['EACCES', 'EPERM', 'EROFS']) {
    test(`a check of the file's permission refused with ${code} writes it in place, as on main`, async () => {
      const h = host();
      const realAccess = fs.accessSync;
      const spy = spyOn(fs, 'accessSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        if (p === h.path) throw Object.assign(new Error(`${code}: refused, access '${p}'`), { code });
        return (realAccess as (...a: unknown[]) => void)(p, ...rest);
      }) as typeof fs.accessSync);
      try {
        writeFileSync(h.path, JSON.stringify({ lessons: [lesson('theirs', 'from another host')] }));
        const ino = fs.statSync(h.path).ino;
        await h.start();
        await h.save('saved');
        expect(contents(h.file())).toEqual(['from another host', 'saved']);
        // The same file, not one renamed over it.
        expect(fs.statSync(h.path).ino).toBe(ino);
        expect(h.lines).toEqual([]);
      } finally { spy.mockRestore(); h.cleanup(); }
    });
  }

  test('a check of the file\'s permission that fails another way leaves the file as it was, and is named', async () => {
    const h = host();
    const realAccess = fs.accessSync;
    const spy = spyOn(fs, 'accessSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (p === h.path) throw Object.assign(new Error(`EIO: i/o error, access '${p}'`), { code: 'EIO' });
      return (realAccess as (...a: unknown[]) => void)(p, ...rest);
    }) as typeof fs.accessSync);
    try {
      const text = JSON.stringify({ lessons: [lesson('theirs', 'from another host')] });
      writeFileSync(h.path, text);
      await h.start();
      await h.save('saved');
      await h.save('saved again');
      expect(h.fileText()).toBe(text);
      expect(h.lines).toEqual([
        `[lessons] the shared lessons file ${h.path} couldn't be written (EIO: i/o error, access '${h.path}'): ` +
          'this host keeps its lessons in its own state and tries again at its next save.',
      ]);
    } finally { spy.mockRestore(); h.cleanup(); }
  });

  // Each way the write goes in place by its own line: the line is in the
  // log as the write in place starts, and a write that breaks the file
  // partway is named as that, so the host doesn't promise to try again.
  const inPlaceWays: Array<{ name: string; setup: (h: ReturnType<typeof host>) => () => void; why: (h: ReturnType<typeof host>) => string }> = [
    {
      name: 'a refused temporary file',
      setup: () => {
        const realOpen = fs.openSync;
        const open = spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
          if (String(p).endsWith('.tmp')) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' });
          return (realOpen as (...a: unknown[]) => number)(p, ...rest);
        }) as typeof fs.openSync);
        return () => open.mockRestore();
      },
      why: (h) => `this host can't replace it through a temporary file beside it (EACCES: permission denied, open '${tmpOf(fs.realpathSync(h.path))}')`,
    },
    {
      name: 'a second name',
      setup: (h) => { fs.linkSync(h.path, join(h.dir, 'other-name.json')); return () => {}; },
      why: () => 'it has another name, which replacing it would leave holding the old text',
    },
  ];
  for (const way of inPlaceWays) {
    test(`for ${way.name}, the line that writes go in place is in the log before the write in place, and one that breaks the file is named so`, async () => {
      const h = host();
      const realWrite = fs.writeFileSync;
      const atWrite: string[][] = [];
      let restore = () => {};
      try {
        writeFileSync(h.path, JSON.stringify({ lessons: [lesson('theirs', 'from another host')] }));
        restore = way.setup(h);
        await h.start();
        // The write in place breaks partway, as past a file size limit.
        const write = spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, data: string, ...rest: unknown[]) => {
          if (p !== h.path) return (realWrite as (...a: unknown[]) => void)(p, data, ...rest);
          atWrite.push([...h.lines]);
          (realWrite as (...a: unknown[]) => void)(p, data.slice(0, data.length >> 1));
          throw Object.assign(new Error('EFBIG: file too large, write'), { code: 'EFBIG' });
        }) as typeof fs.writeFileSync);
        try { await h.save('saved'); } finally { write.mockRestore(); }
        const inPlace = `[lessons] the shared lessons file ${h.path} is written in place, since ${way.why(h)}: a write that fails partway can leave it broken.`;
        expect(atWrite).toEqual([[inPlace]]);
        expect(h.lines).toHaveLength(2);
        expect(h.lines[0]).toBe(inPlace);
        expect(h.lines[1]).toMatch(/^\[lessons\] the shared lessons file .+ couldn't be written \(EFBIG: file too large, write\), and now isn't valid JSON \(.+\): this host keeps its lessons in its own state and won't write the file until it reads as a lessons file again\.$/);
        // The next change finds it so, and neither writes it nor names it again.
        const broken = h.fileText();
        await h.save('saved again');
        expect(h.fileText()).toBe(broken);
        expect(h.lines).toHaveLength(2);
      } finally { restore(); h.cleanup(); }
    });
  }

  test('the temporary file is synced to disk before the rename', async () => {
    const h = host();
    const order: string[] = [];
    const realSync = fs.fsyncSync;
    const realRename = fs.renameSync;
    const sync = spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => { order.push('sync'); return realSync(fd); }) as typeof fs.fsyncSync);
    const rename = spyOn(fs, 'renameSync').mockImplementation(((a: fs.PathLike, b: fs.PathLike) => { order.push('rename'); return realRename(a, b); }) as typeof fs.renameSync);
    try {
      writeFileSync(h.path, JSON.stringify({ lessons: [] }));
      await h.start();
      await h.save('saved');
      expect(order).toEqual(['sync', 'rename']);
      expect(contents(h.file())).toEqual(['saved']);
    } finally { sync.mockRestore(); rename.mockRestore(); h.cleanup(); }
  });

  test('a write that fails partway leaves the file as it was, and the next change tries again', async () => {
    const h = host();
    const real = fs.writeFileSync;
    let failures = 2;
    // The temporary file is written through its descriptor; the module's
    // other writes, and the test's, name a path.
    const spy = spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, data: string, ...rest: unknown[]) => {
      if (typeof p === 'number' && failures-- > 0) {
        (real as (...a: unknown[]) => void)(p, data.slice(0, data.length >> 1), ...rest);
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      return (real as (...a: unknown[]) => void)(p, data, ...rest);
    }) as typeof fs.writeFileSync);
    try {
      const text = JSON.stringify({ lessons: [lesson('theirs', 'from another host')] });
      writeFileSync(h.path, text);
      await h.start();
      await h.save('saved');
      await h.save('saved again');
      expect(h.fileText()).toBe(text);
      expect(readdirSync(h.dir)).toEqual(['lessons.json']);
      expect(h.lines).toEqual([
        `[lessons] the shared lessons file ${h.path} couldn't be written (ENOSPC: no space left on device, write): ` +
          'this host keeps its lessons in its own state and tries again at its next save.',
      ]);
      await h.save('saved a third time');
      expect(contents(h.file())).toEqual(['from another host', 'saved', 'saved again', 'saved a third time']);
      expect(h.lines[1]).toBe(`[lessons] the shared lessons file ${h.path} can be written again: this host merged its lessons in and wrote it.`);
    } finally { spy.mockRestore(); h.cleanup(); }
  });

  // Refused for permission or a mount, the rename's way gives way to a write
  // in place; refused any other way, the file is left as it was.
  const refusals: Array<{ code: string; inPlace: boolean }> = [
    { code: 'EACCES', inPlace: true },
    { code: 'EPERM', inPlace: true },
    { code: 'EBUSY', inPlace: true },
    { code: 'EXDEV', inPlace: true },
    { code: 'EIO', inPlace: false },
  ];
  for (const r of refusals) {
    test(`a rename refused with ${r.code} ${r.inPlace ? 'writes the file in place, and says so once' : 'leaves the file as it was, and is named once'}`, async () => {
      const h = host();
      // As the runtime's errors do, the text names both paths, the
      // temporary file's new at each write.
      const spy = spyOn(fs, 'renameSync').mockImplementation(((a: fs.PathLike, b: fs.PathLike) => {
        throw Object.assign(new Error(`${r.code}: refused, rename '${a}' -> '${b}'`), { code: r.code });
      }) as typeof fs.renameSync);
      try {
        const text = JSON.stringify({ lessons: [lesson('theirs', 'from another host')] });
        writeFileSync(h.path, text);
        const real = fs.realpathSync(h.path);
        const refusal = `${r.code}: refused, rename '${tmpOf(real)}' -> '${real}'`;
        await h.start();
        await h.save('saved');
        await h.save('saved again');
        expect(readdirSync(h.dir)).toEqual(['lessons.json']);
        if (r.inPlace) {
          expect(contents(h.file())).toEqual(['from another host', 'saved', 'saved again']);
          expect(h.lines).toEqual([
            `[lessons] the shared lessons file ${h.path} is written in place, since this host can't replace it through a temporary file beside it (${refusal}): ` +
              'a write that fails partway can leave it broken.',
          ]);
        } else {
          expect(h.fileText()).toBe(text);
          expect(h.lines).toEqual([
            `[lessons] the shared lessons file ${h.path} couldn't be written (${refusal}): ` +
              'this host keeps its lessons in its own state and tries again at its next save.',
          ]);
        }
      } finally { spy.mockRestore(); h.cleanup(); }
    });
  }

  // EROFS: a file mounted on its own in a directory on a read-only mount,
  // where removing even a temporary file never made is refused as well
  // (receipt shared-write-erofs-rm.txt).
  for (const code of ['EACCES', 'EROFS', 'EIO']) {
    const inPlace = code !== 'EIO';
    test(`making the temporary file refused with ${code} ${inPlace ? 'writes the file in place, and says so once' : 'leaves the file as it was, and is named once'}`, async () => {
      const h = host();
      const realOpen = fs.openSync;
      const realRm = fs.rmSync;
      const spy = spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        if (String(p).endsWith('.tmp')) throw Object.assign(new Error(`${code}: refused, open '${p}'`), { code });
        return (realOpen as (...a: unknown[]) => number)(p, ...rest);
      }) as typeof fs.openSync);
      const rm = spyOn(fs, 'rmSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
        if (code === 'EROFS' && String(p).endsWith('.tmp')) throw Object.assign(new Error(`EROFS: read-only file system, rm '${p}'`), { code: 'EROFS' });
        return (realRm as (...a: unknown[]) => void)(p, ...rest);
      }) as typeof fs.rmSync);
      try {
        const text = JSON.stringify({ lessons: [lesson('theirs', 'from another host')] });
        writeFileSync(h.path, text);
        const refusal = `${code}: refused, open '${tmpOf(fs.realpathSync(h.path))}'`;
        await h.start();
        await h.save('saved');
        await h.save('saved again');
        expect(readdirSync(h.dir)).toEqual(['lessons.json']);
        if (inPlace) {
          expect(contents(h.file())).toEqual(['from another host', 'saved', 'saved again']);
          expect(h.lines).toEqual([
            `[lessons] the shared lessons file ${h.path} is written in place, since this host can't replace it through a temporary file beside it (${refusal}): ` +
              'a write that fails partway can leave it broken.',
          ]);
        } else {
          expect(h.fileText()).toBe(text);
          expect(h.lines).toEqual([
            `[lessons] the shared lessons file ${h.path} couldn't be written (${refusal}): ` +
              'this host keeps its lessons in its own state and tries again at its next save.',
          ]);
        }
      } finally { spy.mockRestore(); rm.mockRestore(); h.cleanup(); }
    });
  }

  test('a file whose name is near the longest a directory takes still saves, since the temporary file\'s name doesn\'t grow with it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lessons-shared-'));
    try {
      // 225 bytes: 41 more, as the file's name and a UUID, would pass 255.
      const h = host(join(dir, `${'l'.repeat(220)}.json`));
      writeFileSync(h.path, JSON.stringify({ lessons: [lesson('theirs', 'from another host')] }));
      await h.start();
      await h.save('saved');
      expect(contents(h.file())).toEqual(['from another host', 'saved']);
      expect(h.lines).toEqual([]);
      expect(readdirSync(dir)).toEqual([`${'l'.repeat(220)}.json`]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a first save into a directory that doesn\'t exist yet makes it', async () => {
    const base = host();
    const h = host(join(base.dir, 'missing', 'deeper', 'lessons.json'));
    try {
      h.setLessons([lesson('mine', 'here')]);
      await h.start();
      await h.save('saved');
      expect(contents(h.file())).toEqual(['here', 'saved']);
      expect(h.lines).toEqual([`[lessons] the shared lessons file ${h.path} wasn't there: this host wrote it with its lessons.`]);
    } finally { base.cleanup(); }
  });

  test('a first write that breaks partway leaves no file, and the next makes it whole', async () => {
    const h = host();
    let failures = 1;
    const real = fs.writeFileSync;
    // The new file is written through the temporary file's descriptor.
    const spy = spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, data: string, ...rest: unknown[]) => {
      if (typeof p === 'number' && failures-- > 0) {
        (real as (...a: unknown[]) => void)(p, data.slice(0, data.length >> 1), ...rest);
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      }
      return (real as (...a: unknown[]) => void)(p, data, ...rest);
    }) as typeof fs.writeFileSync);
    try {
      h.setLessons([lesson('mine', 'here')]);
      await h.start();
      await h.save('saved');
      expect(readdirSync(h.dir)).toEqual([]);
      expect(h.lines).toEqual([
        `[lessons] the shared lessons file ${h.path} couldn't be written (ENOSPC: no space left on device, write): ` +
          'this host keeps its lessons in its own state and tries again at its next save.',
      ]);
      await h.save('saved again');
      expect(contents(h.file())).toEqual(['here', 'saved', 'saved again']);
      expect(h.lines[1]).toBe(`[lessons] the shared lessons file ${h.path} can be written again: it wasn't there, so this host wrote it with its lessons.`);
    } finally { spy.mockRestore(); h.cleanup(); }
  });

  test('a first write makes the file with the mode a new file takes', async () => {
    const h = host();
    const umask = process.umask(0o022);
    try {
      await h.start();
      await h.save('saved');
      expect(fs.statSync(h.path).mode & 0o777).toBe(0o644);
      expect(readdirSync(h.dir)).toEqual(['lessons.json']);
    } finally { process.umask(umask); h.cleanup(); }
  });

  test('a first write that fails is named once, and the next save tries again', async () => {
    const h = host();
    let failures = 2;
    const realOpen = fs.openSync;
    const spy = spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p).endsWith('.tmp') && failures-- > 0) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' });
      return (realOpen as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);
    const refusal = `EACCES: permission denied, open '${tmpOf(h.path)}'`;
    try {
      h.setLessons([lesson('mine', 'here')]);
      await h.start();
      expect((await h.save('saved')).success).toBe(true);
      await h.save('saved again');
      expect(h.lines).toEqual([
        `[lessons] the shared lessons file ${h.path} couldn't be written (${refusal}): ` +
          'this host keeps its lessons in its own state and tries again at its next save.',
      ]);
      expect(readdirSync(h.dir)).toEqual([]);
      await h.save('saved a third time');
      expect(contents(h.file())).toEqual(['here', 'saved', 'saved again', 'saved a third time']);
      expect(h.lines[1]).toBe(`[lessons] the shared lessons file ${h.path} can be written again: it wasn't there, so this host wrote it with its lessons.`);
    } finally { spy.mockRestore(); h.cleanup(); }
  });
});
