/**
 * The launcher's work on an install's data (src/update/data-swap.ts): its
 * copies, and putting one set of an item's contents in place of another so
 * that a start cut off at any step can finish it in either direction.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractError, ITEM_UPDATE_DIR } from '../src/update/contract.js';
import {
  copyTree, drive, keepFile, makeDirs, putFileBack, removeFile, removeTree, replaceFile, spaceTaken, type FileKeep,
} from '../src/update/data-swap.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'update-data-swap-')); });
afterEach(() => { removeTree(dir); });

/** A directory's contents as a map of relative path to file text (links as
 *  `-> target`), leaving out ITEM_UPDATE_DIR at its top. */
function contents(root: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(root, rel)).sort()) {
    if (rel === '' && name === ITEM_UPDATE_DIR) continue;
    const path = join(root, rel, name);
    const relPath = rel ? `${rel}/${name}` : name;
    const stat = statSync(path, { throwIfNoEntry: false });
    if (readlinkOrNull(path) !== null) out[relPath] = `-> ${readlinkSync(path)}`;
    else if (stat?.isDirectory()) Object.assign(out, contents(root, relPath));
    else out[relPath] = readFileSync(path, 'utf-8');
  }
  return out;
}

/** The paths `run` syncs, in order: each fsync, named by the path its descriptor was opened on. */
function syncsOf(run: () => void): string[] {
  const paths = new Map<number, string>();
  const synced: string[] = [];
  const realOpen = fs.openSync;
  const realFsync = fs.fsyncSync;
  const opens = spyOn(fs, 'openSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
    const fd = (realOpen as (...args: unknown[]) => number)(path, ...rest);
    paths.set(fd, String(path));
    return fd;
  }) as typeof fs.openSync);
  const syncs = spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
    synced.push(paths.get(fd) ?? `fd ${fd}`);
    realFsync(fd);
  }) as typeof fs.fsyncSync);
  try {
    run();
  } finally {
    opens.mockRestore();
    syncs.mockRestore();
  }
  return synced;
}

function readlinkOrNull(path: string): string | null {
  try { return readlinkSync(path); } catch { return null; }
}

function write(path: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(path, rel, '..'), { recursive: true });
    writeFileSync(join(path, rel), text);
  }
}

describe('copyTree', () => {
  test('copies files, directories and links as they are, with their modes, and leaves out the update directory at any depth and anything else', async () => {
    const from = join(dir, 'data');
    write(from, { 'a.txt': 'a', 'sessions/s1/log': 'entries', 'child/state.bin': 'child' });
    write(join(from, ITEM_UPDATE_DIR), { 'set-aside/x/old': 'kept' });
    write(join(from, 'child', ITEM_UPDATE_DIR), { 'staging/m2/x': 'staged' });
    symlinkSync('sessions/s1', join(from, 'latest'));
    chmodSync(join(from, 'a.txt'), 0o600);
    chmodSync(join(from, 'sessions'), 0o750);
    const server: Server = createServer();
    await new Promise<void>((done) => server.listen(join(from, 'ipc.sock'), done));
    try {
      copyTree(from, join(dir, 'copy'));
    } finally {
      server.close();
    }
    expect(contents(join(dir, 'copy'))).toEqual({
      'a.txt': 'a', 'child/state.bin': 'child', latest: '-> sessions/s1', 'sessions/s1/log': 'entries',
    });
    expect(existsSync(join(dir, 'copy', ITEM_UPDATE_DIR))).toBe(false);
    expect(existsSync(join(dir, 'copy', 'child', ITEM_UPDATE_DIR))).toBe(false);
    expect(statSync(join(dir, 'copy', 'a.txt')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'copy', 'sessions')).mode & 0o777).toBe(0o750);
  });

  test('copies a file item, and refuses to write over what is there', () => {
    write(dir, { 'mcpl-servers.json': '{}', 'there': 'x' });
    copyTree(join(dir, 'mcpl-servers.json'), join(dir, 'copied'));
    expect(readFileSync(join(dir, 'copied'), 'utf-8')).toBe('{}');
    expect(() => copyTree(join(dir, 'mcpl-servers.json'), join(dir, 'there'))).toThrow();
    expect(readFileSync(join(dir, 'there'), 'utf-8')).toBe('x');
  });

  test('spaceTaken counts each file a copy writes in 4 KiB blocks, and nothing under the update directory', () => {
    write(join(dir, 'd'), { one: 'x', two: 'y'.repeat(5000) });
    write(join(dir, 'd', ITEM_UPDATE_DIR), { big: 'z'.repeat(100_000) });
    expect(spaceTaken(join(dir, 'd'))).toBe(4096 + 4096 + 8192);
    expect(spaceTaken(join(dir, 'd', 'two'))).toBe(8192);
  });
});

describe('drive', () => {
  const NEWER = { a: 'newer a', 'b/x': 'newer x', 'only-newer': 'n' };
  const OLDER = { a: 'older a', 'b/x': 'older x', 'only-older': 'o' };
  let item: string;
  let aside: string;
  let staging: string;
  beforeEach(() => {
    item = join(dir, 'data');
    aside = join(item, ITEM_UPDATE_DIR, 'set-aside', 'm1');
    staging = join(item, ITEM_UPDATE_DIR, 'staging', 'm1');
    write(item, NEWER);
    write(join(item, ITEM_UPDATE_DIR), { 'other/keep': 'something else of an update' });
    write(staging, OLDER);
  });
  const forward = () => drive(item, aside, staging);
  const backward = () => drive(item, staging, aside);
  const update = () => contents(join(item, ITEM_UPDATE_DIR));

  function expectForwardDone(): void {
    expect(contents(item)).toEqual(OLDER);
    expect(contents(aside)).toEqual(NEWER);
    expect(update()['other/keep']).toBe('something else of an update');
    expect(readdirSync(join(item, ITEM_UPDATE_DIR, 'staging'))).toEqual([]);
  }
  function expectBackwardDone(): void {
    expect(contents(item)).toEqual(NEWER);
    expect(contents(staging)).toEqual(OLDER);
    expect(update()['other/keep']).toBe('something else of an update');
    expect(readdirSync(join(item, ITEM_UPDATE_DIR, 'set-aside'))).toEqual([]);
  }

  test('puts the incoming set in place and keeps the one it replaces, and back again; a repeat changes nothing', () => {
    forward();
    expectForwardDone();
    expect(statSync(join(item, ITEM_UPDATE_DIR, 'set-aside')).mode & 0o777).toBe(0o700);
    forward();
    expectForwardDone();
    backward();
    expectBackwardDone();
    backward();
    expectBackwardDone();
  });

  // Each state below is where a cut leaves a drive: the set it was moving is
  // split between the item and an area named for that step.
  const cuts: Array<{ name: string; make(): void }> = [
    {
      name: 'a forward drive cut while draining the item',
      make: () => {
        mkdirSync(`${aside}.filling`, { recursive: true });
        renameSync(join(item, 'a'), join(`${aside}.filling`, 'a'));
      },
    },
    {
      name: 'a forward drive cut while filling the item',
      make: () => {
        mkdirSync(`${aside}.filling`, { recursive: true });
        for (const name of ['a', 'b', 'only-newer']) renameSync(join(item, name), join(`${aside}.filling`, name));
        renameSync(`${aside}.filling`, aside);
        renameSync(staging, `${staging}.emptying`);
        renameSync(join(`${staging}.emptying`, 'a'), join(item, 'a'));
      },
    },
    {
      name: 'a backward drive cut while draining the item',
      make: () => {
        forward();
        mkdirSync(`${staging}.filling`, { recursive: true });
        renameSync(join(item, 'b'), join(`${staging}.filling`, 'b'));
      },
    },
    {
      name: 'a backward drive cut while filling the item',
      make: () => {
        forward();
        mkdirSync(`${staging}.filling`, { recursive: true });
        for (const name of ['a', 'b', 'only-older']) renameSync(join(item, name), join(`${staging}.filling`, name));
        renameSync(`${staging}.filling`, staging);
        renameSync(aside, `${aside}.emptying`);
        renameSync(join(`${aside}.emptying`, 'only-newer'), join(item, 'only-newer'));
      },
    },
  ];
  for (const cut of cuts) {
    test(`${cut.name}: a forward drive finishes it`, () => {
      cut.make();
      forward();
      expectForwardDone();
    });
    test(`${cut.name}: a backward drive finishes it`, () => {
      cut.make();
      backward();
      expectBackwardDone();
    });
  }

  test("moves a directory its owner can't write, each way, and leaves its mode as it was", () => {
    // Renaming a directory to another parent rewrites its `..`, which its own mode refuses.
    chmodSync(join(item, 'b'), 0o555);
    chmodSync(join(staging, 'b'), 0o500);
    forward();
    expectForwardDone();
    expect(statSync(join(item, 'b')).mode & 0o777).toBe(0o500);
    expect(statSync(join(aside, 'b')).mode & 0o777).toBe(0o555);
    backward();
    expectBackwardDone();
    expect(statSync(join(item, 'b')).mode & 0o777).toBe(0o555);
  });

  test("a directory whose rename fails again after it was given owner write gets its mode back", () => {
    chmodSync(join(staging, 'b'), 0o500);
    const realRename = fs.renameSync;
    let calls = 0;
    const fails = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      // The entry moves out of the incoming area, by then named .emptying.
      if (String(from).startsWith(staging) && String(from).endsWith('/b') && ++calls <= 2) {
        throw Object.assign(new Error(calls === 1 ? 'EACCES' : 'EIO'), { code: calls === 1 ? 'EACCES' : 'EIO' });
      }
      realRename(from, to);
    }) as typeof fs.renameSync);
    try {
      expect(forward).toThrow(/EIO/);
    } finally {
      fails.mockRestore();
    }
    const left = join(`${staging}.emptying`, 'b');
    expect(statSync(left).mode & 0o777).toBe(0o500);
    chmodSync(left, 0o755);
  });

  test('syncs both directories of each move, and the parent of each area it renames, before it returns', () => {
    const synced = syncsOf(forward);
    const areas = join(item, ITEM_UPDATE_DIR);
    for (const path of [item, `${aside}.filling`, join(areas, 'set-aside'), `${staging}.emptying`, join(areas, 'staging')]) {
      expect(synced).toContain(path);
    }
    // The item, drained into the outgoing area, is synced before that area takes its name.
    expect(synced.indexOf(item)).toBeLessThan(synced.lastIndexOf(join(areas, 'set-aside')));
  });

  test('with nothing to take in, it stops before moving anything', () => {
    rmSync(staging, { recursive: true });
    expect(() => forward()).toThrow(ContractError);
    expect(contents(item)).toEqual(NEWER);
  });

  test('an entry already where one would move stops it, rather than a rename replacing it', () => {
    renameSync(staging, `${staging}.emptying`);
    mkdirSync(aside, { recursive: true });
    expect(() => forward()).toThrow(/already there/);
    expect(readFileSync(join(item, 'a'), 'utf-8')).toBe('newer a');
  });
});

describe('a file item', () => {
  let file: string;
  let source: string;
  let keep: FileKeep;
  let back: FileKeep;
  beforeEach(() => {
    file = join(dir, 'work', 'mcpl-servers.json');
    source = join(dir, 'copy', '1-mcpl-servers.json');
    write(dir, { 'work/mcpl-servers.json': 'newer', 'copy/1-mcpl-servers.json': 'older' });
    keep = { kept: join(dir, 'set-aside', 'm1', 'kept', '1-mcpl-servers.json'), absent: join(dir, 'set-aside', 'm1', 'absent', '1-mcpl-servers.json') };
    back = { kept: join(dir, 'set-aside', 'm1', 'put-back', 'kept', '1-mcpl-servers.json'), absent: join(dir, 'set-aside', 'm1', 'put-back', 'absent', '1-mcpl-servers.json') };
  });

  test("is written in place, the same file, its mode its own, after its content is kept whole; a repeat keeps what came first", () => {
    const inode = statSync(file).ino;
    chmodSync(file, 0o600);
    chmodSync(source, 0o644);
    replaceFile(file, source, keep);
    expect(readFileSync(file, 'utf-8')).toBe('older');
    expect(statSync(file).ino).toBe(inode);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(keep.kept, 'utf-8')).toBe('newer');
    expect(statSync(join(dir, 'set-aside', 'm1')).mode & 0o777).toBe(0o700);
    replaceFile(file, source, keep);
    expect(readFileSync(keep.kept, 'utf-8')).toBe('newer');
    expect(existsSync(keep.absent)).toBe(false);
    expect(readdirSync(join(dir, 'set-aside', 'm1', 'kept'))).toEqual(['1-mcpl-servers.json']);
  });

  test('one that is missing is made with the source\'s mode, in a directory made for it, and its absence is noted', () => {
    rmSync(join(dir, 'work'), { recursive: true });
    // A mode the usual umasks (022, 002, 077) would each cut.
    chmodSync(source, 0o666);
    replaceFile(file, source, keep);
    expect(readFileSync(file, 'utf-8')).toBe('older');
    expect(statSync(file).mode & 0o777).toBe(0o666);
    expect(existsSync(keep.kept)).toBe(false);
    expect(existsSync(keep.absent)).toBe(true);
    // A replay after a cut reads the note, so it doesn't keep the restored
    // file as what was there before.
    replaceFile(file, source, keep);
    expect(existsSync(keep.kept)).toBe(false);
    // Putting back puts back the absence, keeping what's there now.
    putFileBack(file, keep, back);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(back.kept, 'utf-8')).toBe('older');
  });

  test('null takes it away, kept; putting back writes the kept content in place again', () => {
    replaceFile(file, null, keep);
    expect(existsSync(file)).toBe(false);
    replaceFile(file, null, keep);
    expect(readFileSync(keep.kept, 'utf-8')).toBe('newer');
    putFileBack(file, keep, back);
    expect(readFileSync(file, 'utf-8')).toBe('newer');
    expect(existsSync(back.absent)).toBe(true);
  });

  // Each state below is where a cut leaves a replace: its keep written and
  // the file not yet, the file torn halfway, or a keep's own temporary file.
  const cuts: Array<{ name: string; make(): void }> = [
    { name: 'kept, not yet written', make: () => { keepFile(file, keep); } },
    { name: 'kept, and the file torn', make: () => { keepFile(file, keep); writeFileSync(file, 'old'); } },
    { name: "a keep's temporary file left beside it, with a mode its owner can't write", make: () => {
      mkdirSync(join(keep.kept, '..'), { recursive: true });
      writeFileSync(join(keep.kept, '..', '.connectome-update.tmp'), 'ne');
      chmodSync(join(keep.kept, '..', '.connectome-update.tmp'), 0o444);
    } },
  ];
  for (const cut of cuts) {
    test(`${cut.name}: a replay finishes it, keeping what came first`, () => {
      cut.make();
      replaceFile(file, source, keep);
      expect(readFileSync(file, 'utf-8')).toBe('older');
      expect(readFileSync(keep.kept, 'utf-8')).toBe('newer');
      expect(readdirSync(join(keep.kept, '..'))).toEqual(['1-mcpl-servers.json']);
    });
  }

  test("one its owner can't write: left alone when it holds the content already, written otherwise, its mode kept", () => {
    chmodSync(file, 0o444);
    writeFileSync(source, 'newer');
    const before = statSync(file).mtimeMs;
    replaceFile(file, source, keep);
    expect(statSync(file).mtimeMs).toBe(before);
    writeFileSync(source, 'older');
    replaceFile(file, source, { kept: `${keep.kept}-2`, absent: `${keep.absent}-2` });
    expect(readFileSync(file, 'utf-8')).toBe('older');
    expect(statSync(file).mode & 0o777).toBe(0o444);
  });

  test("one a cut left made, but not yet given its mode: a replay gives it the source's", () => {
    rmSync(join(dir, 'work'), { recursive: true });
    chmodSync(source, 0o666);
    keepFile(file, keep);
    mkdirSync(join(dir, 'work'));
    writeFileSync(file, '', { mode: 0o600 });
    replaceFile(file, source, keep);
    expect(readFileSync(file, 'utf-8')).toBe('older');
    expect(statSync(file).mode & 0o777).toBe(0o666);
  });

  test('a link where the file was is refused, naming it, and what it names is left alone', () => {
    const elsewhere = join(dir, 'elsewhere.json');
    writeFileSync(elsewhere, 'not the item');
    rmSync(file);
    symlinkSync(elsewhere, file);
    expect(() => replaceFile(file, source, keep)).toThrow(new RegExp(`${file} is a link now`));
    expect(readFileSync(elsewhere, 'utf-8')).toBe('not the item');
    expect(existsSync(keep.kept) || existsSync(keep.absent)).toBe(false);
  });

  test('one that is made is synced, and so are its directory and the note of its absence, before it returns', () => {
    rmSync(join(dir, 'work'), { recursive: true });
    const synced = syncsOf(() => replaceFile(file, source, keep));
    for (const path of [join(keep.absent, '..'), file, join(dir, 'work'), dir]) expect(synced).toContain(path);
    expect(synced.indexOf(join(keep.absent, '..'))).toBeLessThan(synced.indexOf(file));
  });

  test("a kept file's content is synced, and its directory once it has its name", () => {
    const synced = syncsOf(() => keepFile(file, keep));
    const tmp = join(keep.kept, '..', '.connectome-update.tmp');
    expect(synced.indexOf(tmp)).toBeGreaterThan(-1);
    expect(synced.indexOf(tmp)).toBeLessThan(synced.lastIndexOf(join(keep.kept, '..')));
    // A replay finds the keep, and syncs its directory again.
    expect(syncsOf(() => keepFile(file, keep))).toEqual([join(keep.kept, '..')]);
  });

  test("a replay after a cut between the write and its sync, which finds the content there, still syncs the file", () => {
    replaceFile(file, source, keep);
    // As a cut before the sync leaves it: the content is there, and the replay
    // has nothing to write.
    const synced = syncsOf(() => replaceFile(file, source, keep));
    expect(synced).toContain(file);
    expect(readFileSync(file, 'utf-8')).toBe('older');
  });

  test("a replay after a cut that left owner write on a read-only file gives it back its own mode, from its keep", () => {
    chmodSync(file, 0o444);
    keepFile(file, keep);
    // As a cut between the added write bit and the write leaves it.
    chmodSync(file, 0o644);
    writeFileSync(file, 'ol');
    replaceFile(file, source, keep);
    expect(readFileSync(file, 'utf-8')).toBe('older');
    expect(statSync(file).mode & 0o777).toBe(0o444);
  });

  test('a replay over a file the restore made syncs its directory again, as the first attempt did', () => {
    rmSync(file);
    replaceFile(file, source, keep);
    expect(syncsOf(() => replaceFile(file, source, keep))).toContain(join(dir, 'work'));
  });

  test("past one chunk: one that already holds the content is left alone, and one that differs only past the first chunk is written whole", () => {
    const big = 'x'.repeat(2 ** 20 + 4096);
    writeFileSync(source, big);
    writeFileSync(file, big);
    const before = statSync(file).mtimeMs;
    Bun.sleepSync(20);
    replaceFile(file, source, keep);
    expect(statSync(file).mtimeMs).toBe(before);
    writeFileSync(source, `${'x'.repeat(2 ** 20 + 4000)}${'y'.repeat(96)}`);
    replaceFile(file, source, { kept: `${keep.kept}-2`, absent: `${keep.absent}-2` });
    expect(readFileSync(file, 'utf-8')).toBe(readFileSync(source, 'utf-8'));
  });

  test("taking away one that's already gone still syncs its directory, as an earlier attempt's removal may not be", () => {
    replaceFile(file, null, keep);
    expect(existsSync(file)).toBe(false);
    expect(syncsOf(() => replaceFile(file, null, keep))).toContain(join(dir, 'work'));
  });

  test("a source that can't be read leaves the file as it was", () => {
    // Of another size, so the content comparison never opens it.
    writeFileSync(source, 'older, and longer');
    chmodSync(source, 0o000);
    try {
      expect(() => replaceFile(file, source, keep)).toThrow(expect.objectContaining({ code: 'EACCES' }));
    } finally {
      chmodSync(source, 0o644);
    }
    expect(readFileSync(file, 'utf-8')).toBe('newer');
  });

  test("the file's mode is set before its sync, so the sync holds it", () => {
    chmodSync(file, 0o444);
    const events: string[] = [];
    const realFchmod = fs.fchmodSync;
    const realFsync = fs.fsyncSync;
    const chmods = spyOn(fs, 'fchmodSync').mockImplementation(((fd: number, mode: fs.Mode) => {
      events.push('mode');
      realFchmod(fd, mode);
    }) as typeof fs.fchmodSync);
    const syncs = spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
      events.push('sync');
      realFsync(fd);
    }) as typeof fs.fsyncSync);
    try {
      replaceFile(file, source, keep);
    } finally {
      chmods.mockRestore();
      syncs.mockRestore();
    }
    expect(statSync(file).mode & 0o777).toBe(0o444);
    expect(events.lastIndexOf('mode')).toBeGreaterThan(-1);
    expect(events.lastIndexOf('mode')).toBeLessThan(events.lastIndexOf('sync'));
  });

  test("on a read-only filesystem, a file that already holds the content passes over its sync's EROFS; one written doesn't", () => {
    writeFileSync(file, 'older');
    const realFsync = fs.fsyncSync;
    const rofs = spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
      if (fs.fstatSync(fd).ino === statSync(file).ino) throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
      realFsync(fd);
    }) as typeof fs.fsyncSync);
    try {
      replaceFile(file, source, keep);
      writeFileSync(file, 'other');
      expect(() => replaceFile(file, source, { kept: `${keep.kept}-2`, absent: `${keep.absent}-2` })).toThrow(/EROFS/);
    } finally {
      rofs.mockRestore();
    }
  });

  test("putting back gives the file the mode it had before the restore, not one a restore that failed partway left", () => {
    chmodSync(file, 0o444);
    keepFile(file, keep);
    // As a restore that failed after adding owner write leaves it.
    chmodSync(file, 0o644);
    writeFileSync(file, 'ol');
    putFileBack(file, keep, back);
    expect(readFileSync(file, 'utf-8')).toBe('newer');
    expect(statSync(file).mode & 0o777).toBe(0o444);
  });

  test('a write that comes back short is finished from where it stopped', () => {
    writeFileSync(source, 'x'.repeat(10_000));
    const realWrite = fs.writeSync;
    let shortened = false;
    const short = spyOn(fs, 'writeSync').mockImplementation(((fd: number, data: Uint8Array, offset?: number, length?: number) => {
      if (!shortened && typeof length === 'number' && length > 100) {
        shortened = true;
        return realWrite(fd, data, offset, 100);
      }
      return realWrite(fd, data, offset, length);
    }) as typeof fs.writeSync);
    try {
      replaceFile(file, source, keep);
    } finally {
      short.mockRestore();
    }
    expect(shortened).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe('x'.repeat(10_000));
  });

  test('putting back with nothing kept stops, leaving the file as it is', () => {
    expect(() => putFileBack(file, keep, back)).toThrow(/Nothing kept/);
    expect(readFileSync(file, 'utf-8')).toBe('newer');
  });

  test("a keep's name can be as long as a directory entry's", () => {
    const long = 'x'.repeat(255);
    const kept = { kept: join(dir, 'set-aside', 'm1', 'kept', long), absent: join(dir, 'set-aside', 'm1', 'absent', long) };
    replaceFile(file, source, kept);
    expect(readFileSync(kept.kept, 'utf-8')).toBe('newer');
  });
});

describe('removeTree', () => {
  test('removes a tree whose directories its owner cannot write, a file, and nothing where nothing is', () => {
    const tree = join(dir, 'tree');
    mkdirSync(join(tree, 'ro', 'deeper'), { recursive: true });
    writeFileSync(join(tree, 'ro', 'deeper', 'f'), 'x');
    writeFileSync(join(tree, 'ro', 'g'), 'y');
    // Read and search only, as a copy keeps such a directory's mode.
    chmodSync(join(tree, 'ro', 'deeper'), 0o500);
    chmodSync(join(tree, 'ro'), 0o500);
    removeTree(tree);
    expect(existsSync(tree)).toBe(false);
    removeTree(tree);
    writeFileSync(join(dir, 'file'), 'z');
    removeTree(join(dir, 'file'));
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('makeDirs', () => {
  test('makes each missing directory with the mode asked, and leaves those there as they are', () => {
    mkdirSync(join(dir, 'a'), { mode: 0o755 });
    // The parent of each directory on the way is synced, outermost first, a
    // new one's once it's made.
    expect(syncsOf(() => makeDirs(join(dir, 'a', 'b', 'c'), 0o700)).slice(-3)).toEqual([dir, join(dir, 'a'), join(dir, 'a', 'b')]);
    // One that's there, as an attempt cut off before its parent's sync leaves
    // it, has its parent synced too.
    expect(syncsOf(() => makeDirs(join(dir, 'a', 'b'))).slice(-2)).toEqual([dir, join(dir, 'a')]);
    expect(statSync(join(dir, 'a')).mode & 0o777).toBe(0o755);
    expect(statSync(join(dir, 'a', 'b')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'a', 'b', 'c')).mode & 0o777).toBe(0o700);
    makeDirs(join(dir, 'a', 'b', 'c'), 0o700);
    expect(readdirSync(join(dir, 'a', 'b'))).toEqual(['c']);
  });

  test("passes over a found directory's parent it may not open, but not one it has just made an entry in", () => {
    const shut = join(dir, 'shut');
    mkdirSync(join(shut, 'a'), { recursive: true });
    for (const mode of [0o111, 0o311]) {
      chmodSync(shut, mode);
      try {
        makeDirs(join(shut, 'a', `b${mode}`));
        expect(existsSync(join(shut, 'a', `b${mode}`))).toBe(true);
      } finally {
        chmodSync(shut, 0o755);
      }
    }
    chmodSync(shut, 0o311);
    try {
      expect(() => makeDirs(join(shut, 'd'))).toThrow(expect.objectContaining({ code: 'EACCES' }));
    } finally {
      chmodSync(shut, 0o755);
    }
  });

  test("taking a file away stops on a directory it can't open to sync when it removed the file there, and passes it over when the file was gone", () => {
    const shut = join(dir, 'shut');
    mkdirSync(shut);
    writeFileSync(join(shut, 'f'), 'x');
    chmodSync(shut, 0o311);
    try {
      expect(() => removeFile(join(shut, 'f'))).toThrow(expect.objectContaining({ code: 'EACCES' }));
      expect(existsSync(join(shut, 'f'))).toBe(false);
      removeFile(join(shut, 'f'));
    } finally {
      chmodSync(shut, 0o755);
    }
  });

  test("a found directory's parent whose sync fails otherwise isn't passed over", () => {
    const realFsync = fs.fsyncSync;
    const failing = spyOn(fs, 'fsyncSync').mockImplementation((() => {
      throw Object.assign(new Error('EIO'), { code: 'EIO' });
    }) as typeof fs.fsyncSync);
    try {
      expect(() => makeDirs(dir)).toThrow(/EIO/);
    } finally {
      failing.mockRestore();
    }
    expect(realFsync).toBe(fs.fsyncSync);
  });
});
