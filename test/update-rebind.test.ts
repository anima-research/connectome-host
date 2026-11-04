import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installPaths, readRecord, writeJsonAtomic, type CopyLabel, type GoBackList, type InstallRecord, type LockRecord,
} from '../src/update/contract.js';
import { machineOps } from '../src/update/launcher.js';
import { ENTRY_POINT, parseArgs, setup, type ServiceUnits, type SetupOptions } from '../src/update/setup.js';

let dir: string;
let install: string;
let said: string[];
const REBIND_PLAN = 'rebind.json';
const units: ServiceUnits = { found: [], unasked: [], unresolved: [], defaulted: [] };
const stand: Bun.Subprocess[] = [];

const hostOf = (at: string) => join(at, 'node_modules', '@animalabs', 'connectome-host');
const rootOf = (at: string) => join(at, 'connectome-host');

function makeInstall(at: string): void {
  const host = hostOf(at);
  mkdirSync(join(host, 'src', 'update'), { recursive: true });
  writeFileSync(join(host, 'package.json'), JSON.stringify({ name: '@animalabs/connectome-host', version: '0.10.2' }));
  writeFileSync(join(host, 'src', 'index.ts'), '// host\n');
  writeFileSync(join(host, 'src', 'update', 'launcher.ts'), 'export async function launch() {}\n');
  writeFileSync(join(at, 'package.json'), JSON.stringify({ dependencies: { '@animalabs/connectome-host': '^0.10.2' } }));
  mkdirSync(join(at, 'data', 'sessions'), { recursive: true });
  writeFileSync(join(at, 'data', 'sessions', 'store.txt'), `the store of ${at}`);
  writeFileSync(join(at, 'mcpl-servers.json'), '{}');
}

const options = (at: string, over: Partial<SetupOptions> = {}): SetupOptions => ({
  cwd: at,
  dataDir: join(at, 'data'),
  root: rootOf(at),
  extraState: null,
  hostRoot: hostOf(at),
  say: (line) => { said.push(line); },
  units: () => units,
  ...over,
});

const record = (at: string) => readRecord<InstallRecord>(installPaths(rootOf(at)).install, 'install record');
const label = (at: string) => readRecord<CopyLabel>(join(rootOf(at), 'copy', 'copy.json'), 'label');
const list = (at: string, mark = 'm2') => readRecord<GoBackList>(join(rootOf(at), 'set-aside', mark, 'places.json'), 'list');
const refusal = (run: () => void): string => {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('no refusal');
};
const tree = (at: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (path: string, rel: string): void => {
    for (const name of readdirSync(path).sort()) {
      const here = join(path, name);
      const key = rel === '' ? name : `${rel}/${name}`;
      const stat = fs.lstatSync(here);
      if (stat.isSymbolicLink()) out[key] = `-> ${fs.readlinkSync(here)}`;
      else if (stat.isDirectory()) walk(here, key);
      else out[key] = readFileSync(here, 'base64');
    }
  };
  walk(at, '');
  return out;
};

function updated(at: string, extra: string[] = []): void {
  const root = rootOf(at);
  const items = [join(at, 'data'), join(at, 'mcpl-servers.json'), ...extra].map((path, i) =>
    ({ path, name: `${i}-${path.split('/').at(-1)}` }));
  const absent = [{ path: join(at, 'mcpl-servers.agent.json'), name: `${items.length}-mcpl-servers.agent.json` }];
  mkdirSync(join(root, 'copy'), { recursive: true });
  for (const item of items) writeFileSync(join(root, 'copy', item.name), 'copied');
  writeJsonAtomic(join(root, 'copy', 'copy.json'),
    { v: 1, from: '0.10.2', at: '2026-11-01T00:00:00Z', items, absent, mark: 'm1' } satisfies CopyLabel);
  mkdirSync(join(root, 'set-aside', 'm2'), { recursive: true });
  writeJsonAtomic(join(root, 'set-aside', 'm2', 'places.json'), {
    v: 1, places: items.map((item) => ({ ...item, before: 'dir' as const, target: 'dir' as const })),
  } satisfies GoBackList);
}

function copyOf(from: string, to: string): void {
  expect(Bun.spawnSync(['cp', '-a', from, to]).exitCode).toBe(0);
}

function live(): number {
  const child = Bun.spawn(['sleep', '120']);
  stand.push(child);
  return child.pid;
}

function lockHeldBy(at: string, pid: number, when = '2026-11-04T00:00:00.000Z'): LockRecord {
  const lock: LockRecord = { v: 1, pid, bootId: machineOps().bootId(), at: when };
  writeFileSync(installPaths(rootOf(at)).lock, `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

function startOf(at: string): { exitCode: number; stderr: string } {
  const run = Bun.spawnSync([process.execPath, join(rootOf(at), ENTRY_POINT)], { cwd: at, stderr: 'pipe' });
  return { exitCode: run.exitCode ?? -1, stderr: run.stderr.toString() };
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'update-rebind-')));
  install = join(dir, 'service');
  makeInstall(install);
  said = [];
});
afterEach(() => {
  for (const child of stand.splice(0)) child.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe('binding an install to the directory it is in', () => {
  test('a setup run records the real path of the directory that holds the root, as the record\'s workingDir', () => {
    const linked = join(dir, 'linked');
    symlinkSync(install, linked);
    setup(options(linked));
    expect(record(install)).toEqual({ v: 1, dataDir: join(install, 'data'), extraState: [], workingDir: install });
  });

  test('a moved install is bound where it is: each place under the old directory goes to the same place under the new, in the record, the label and each Go back list, with positions, names and marks as they were', () => {
    setup(options(install));
    updated(install);
    const prev = join(rootOf(install), 'copy.prev');
    mkdirSync(prev);
    writeFileSync(join(prev, 'copy.json'), readFileSync(join(rootOf(install), 'copy', 'copy.json')));
    const before = { label: label(install)!, list: list(install)! };
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    said = [];
    setup(options(moved));
    expect(record(moved)).toEqual({ v: 1, dataDir: join(moved, 'data'), extraState: [], workingDir: moved });
    const at = (path: string) => path.replace(install, moved);
    const bound = label(moved)!;
    expect(bound.items).toEqual(before.label.items.map((item) => ({ ...item, path: at(item.path) })));
    expect(bound.absent).toEqual(before.label.absent!.map((item) => ({ ...item, path: at(item.path) })));
    expect({ from: bound.from, at: bound.at, mark: bound.mark }).toEqual({ from: '0.10.2', at: '2026-11-01T00:00:00Z', mark: 'm1' });
    expect(list(moved)!.places).toEqual(before.list.places.map((place) => ({ ...place, path: at(place.path) })));
    expect(readRecord<CopyLabel>(join(rootOf(moved), 'copy.prev', 'copy.json'), 'label')!.items)
      .toEqual(before.label.items.map((item) => ({ ...item, path: at(item.path) })));
    expect(typeof bound.rebound).toBe('string');
    expect(list(moved)!.rebound).toBe(bound.rebound);
    expect(existsSync(join(rootOf(moved), REBIND_PLAN))).toBe(false);
    expect(existsSync(installPaths(rootOf(moved)).lock)).toBe(false);
    expect(said[0]).toBe(`Bound the install at ${rootOf(moved)} to ${moved}, where it serves ${join(moved, 'data')} and runs 0.10.2.`);
  });

  test('a copy with a place outside its directory is refused until that place is given, changing nothing; given, the copy is bound to its own places and the original keeps its own', () => {
    const outside = join(dir, 'state.json');
    writeFileSync(outside, 'the original\'s state');
    setup(options(install, { extraState: [outside] }));
    updated(install, [outside]);
    const original = tree(rootOf(install));
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const kept = tree(rootOf(copy));
    const why = refusal(() => setup(options(copy)));
    expect(why).toContain(`This install's record is bound to ${install}, and the install is in ${copy}, so it was moved or copied here.`);
    expect(why).toContain(`  ${outside} (state kept outside its data directory; named by ${join(rootOf(copy), 'copy', 'copy.json')} and ` +
      `${join(rootOf(copy), 'set-aside', 'm2', 'places.json')})`);
    expect(why).toContain('Give each with --place PATH PLACE');
    expect(why).not.toContain(join(install, 'data'));
    expect(tree(rootOf(copy))).toEqual(kept);

    const own = join(dir, 'copy-state.json');
    writeFileSync(own, 'the copy\'s state');
    setup(options(copy, { places: [{ from: outside, to: own }] }));
    expect(record(copy)).toEqual({ v: 1, dataDir: join(copy, 'data'), extraState: [own], workingDir: copy });
    expect(label(copy)!.items.map((item) => item.path)).toEqual([join(copy, 'data'), join(copy, 'mcpl-servers.json'), own]);
    expect(list(copy)!.places.map((place) => place.path)).toEqual([join(copy, 'data'), join(copy, 'mcpl-servers.json'), own]);
    expect(tree(rootOf(install))).toEqual(original);
    expect(record(install)).toEqual({ v: 1, dataDir: join(install, 'data'), extraState: [outside], workingDir: install });
  });

  test('a record from before workingDir has no place bound by where it lies: each, its data directory too, needs an answer', () => {
    setup(options(install));
    updated(install);
    writeJsonAtomic(installPaths(rootOf(install)).install, { v: 1, dataDir: join(install, 'data'), extraState: [] });
    const kept = tree(rootOf(install));
    const why = refusal(() => setup(options(install)));
    expect(why).toContain('This install\'s record is from a release that didn\'t record which directory an install is in');
    const listed = why.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim().split(' (')[0]);
    expect(listed[0]).toBe(join(install, 'data'));
    expect(listed.slice(1).sort()).toEqual([join(install, 'mcpl-servers.agent.json'), join(install, 'mcpl-servers.json')]);
    expect(tree(rootOf(install))).toEqual(kept);
  });

  test('binding a record from before workingDir with every place kept rewrites nothing and leaves the lock alone; the guarded entries go in before the record', () => {
    setup(options(install));
    updated(install);
    const root = rootOf(install);
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: join(install, 'data'), extraState: [] });
    writeFileSync(join(root, ENTRY_POINT), '// an entry point from before the check\n');
    const lock = lockHeldBy(install, live());
    const files = { label: readFileSync(join(root, 'copy', 'copy.json'), 'utf-8'), list: readFileSync(join(root, 'set-aside', 'm2', 'places.json'), 'utf-8') };
    const places = [join(install, 'data'), join(install, 'mcpl-servers.json'), join(install, 'mcpl-servers.agent.json')]
      .map((path) => ({ from: path, to: path }));
    mkdirSync(`${installPaths(root).install}.tmp`);
    expect(() => setup(options(install, { places }))).toThrow(/install\.json\.tmp/);
    expect(readFileSync(join(root, ENTRY_POINT), 'utf-8')).toContain(REBIND_PLAN);
    expect(record(install)).toEqual({ v: 1, dataDir: join(install, 'data'), extraState: [] });
    rmSync(`${installPaths(root).install}.tmp`, { recursive: true });
    setup(options(install, { places }));
    expect(record(install)).toEqual({ v: 1, dataDir: join(install, 'data'), extraState: [], workingDir: install });
    expect(readFileSync(join(root, 'copy', 'copy.json'), 'utf-8')).toBe(files.label);
    expect(readFileSync(join(root, 'set-aside', 'm2', 'places.json'), 'utf-8')).toBe(files.list);
    expect(readRecord<LockRecord>(installPaths(root).lock, 'lock')).toEqual(lock);
    expect(existsSync(join(root, REBIND_PLAN))).toBe(false);
  });

  test('a record bound to another spelling of this directory, through a link, is bound: its entry starts, and setup runs as before, asking nothing', () => {
    setup(options(install));
    updated(install);
    const spelling = join(dir, 'spelling');
    symlinkSync(install, spelling);
    writeJsonAtomic(installPaths(rootOf(install)).install, { v: 1, dataDir: join(install, 'data'), extraState: [], workingDir: spelling });
    const files = readFileSync(join(rootOf(install), 'copy', 'copy.json'), 'utf-8');
    expect(startOf(install).exitCode).toBe(0);
    said = [];
    setup(options(install));
    expect(said[0]).toBe(`The install at ${rootOf(install)} serves ${join(install, 'data')} and runs 0.10.2, as before.`);
    expect(record(install)!.workingDir).toBe(spelling);
    expect(readFileSync(join(rootOf(install), 'copy', 'copy.json'), 'utf-8')).toBe(files);
  });

  test('a setup run on a record bound through a link keeps its spelling, so once the link is gone the entry refuses, and setup binds it, mapping its places', () => {
    setup(options(install));
    const spelling = join(dir, 'spelling');
    symlinkSync(install, spelling);
    writeJsonAtomic(installPaths(rootOf(install)).install, { v: 1, dataDir: join(spelling, 'data'), extraState: [], workingDir: spelling });
    setup(options(install));
    expect(record(install)).toEqual({ v: 1, dataDir: join(spelling, 'data'), extraState: [], workingDir: spelling });
    rmSync(spelling);
    const refused = startOf(install);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(`its record is bound to ${spelling}, and it's in ${install}, so it was moved or copied here`);
    setup(options(install));
    expect(record(install)).toEqual({ v: 1, dataDir: join(install, 'data'), extraState: [], workingDir: install });
    expect(startOf(install).exitCode).toBe(0);
  });

  test('--place is refused where there is nothing to bind, and where it names no place the install names', () => {
    setup(options(install));
    expect(refusal(() => setup(options(install, { places: [{ from: join(install, 'data'), to: join(install, 'data') }] }))))
      .toContain(`this install's record is bound to ${install}, where it is, so there's nothing to bind`);
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const why = refusal(() => setup(options(moved, { places: [{ from: join(dir, 'elsewhere'), to: join(dir, 'other') }] })));
    expect(why).toContain(`--place ${join(dir, 'elsewhere')} names no place this install's record, its copy's label or its Go backs' lists name. Those it names:\n  ${join(install, 'data')} (its data directory)`);
    expect(record(moved)!.workingDir).toBe(install);
  });

  test('parseArgs reads --place as a path and its place, each resolved, and refuses one with no place', () => {
    expect(parseArgs(['--place', 'a', '/b', '--extra-state', 'c']).places).toEqual([{ from: join(process.cwd(), 'a'), to: '/b' }]);
    expect(() => parseArgs(['--place', 'a'])).toThrow('--place takes a path and its place, and only the path followed it');
  });

  test('a DATA_DIR other than where the binding puts the recorded data directory is refused, naming that place', () => {
    setup(options(install));
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    mkdirSync(join(dir, 'other-data'));
    const why = refusal(() => setup(options(moved, { dataDir: join(dir, 'other-data') })));
    expect(why).toContain(`serves ${join(moved, 'data')}, the place of the data directory its record names, ${join(install, 'data')}, and setup was given DATA_DIR ${join(dir, 'other-data')}. Setup has changed nothing.`);
    expect(record(moved)!.workingDir).toBe(install);
  });
});

describe('a binding cut off', () => {
  function chained(): { a: string; b: string; c: string; places: Array<{ from: string; to: string }> } {
    const [a, b, c] = ['a.json', 'b.json', 'c.json'].map((name) => join(dir, name));
    for (const path of [a, b, c]) writeFileSync(path, path);
    setup(options(install, { extraState: [a, b] }));
    updated(install, [a, b]);
    writeJsonAtomic(installPaths(rootOf(install)).install, { v: 1, dataDir: join(install, 'data'), extraState: [a, b] });
    const keep = [join(install, 'data'), join(install, 'mcpl-servers.json'), join(install, 'mcpl-servers.agent.json')];
    return { a, b, c, places: [...keep.map((path) => ({ from: path, to: path })), { from: a, to: b }, { from: b, to: c }] };
  }
  const named = (at: string) => label(at)!.items.slice(2).map((item) => item.path);
  const listed = (at: string) => list(at)!.places.slice(2).map((place) => place.path);

  test('cut while the guarded entries are written: the plan stands, the entries refuse, and the next run finishes from the plan, asking nothing again', () => {
    const { b, c, places } = chained();
    const root = rootOf(install);
    mkdirSync(join(root, 'connectome.tmp'));
    expect(() => setup(options(install, { places }))).toThrow(/connectome\.tmp/);
    expect(existsSync(join(root, REBIND_PLAN))).toBe(true);
    expect(record(install)!.workingDir).toBeUndefined();
    const refused = startOf(install);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(`a setup binding this install to ${install} was cut off before it finished`);
    expect(refused.stderr).toContain('Setup finishes it, without asking about its places again');
    rmSync(join(root, 'connectome.tmp'), { recursive: true });
    setup(options(install));
    expect(said).toContain(`Finished binding the install at ${root} to ${install}, which a setup run cut off had begun, with the places that run was given.`);
    expect(named(install)).toEqual([b, c]);
    expect(listed(install)).toEqual([b, c]);
    expect(record(install)).toEqual({ v: 1, dataDir: join(install, 'data'), extraState: [b, c], workingDir: install });
    expect(existsSync(join(root, REBIND_PLAN))).toBe(false);
  });

  test('cut after the plan, before the entries: the next run finishes it', () => {
    const { b, c, places } = chained();
    const root = rootOf(install);
    mkdirSync(join(root, `${ENTRY_POINT}.tmp`));
    expect(() => setup(options(install, { places }))).toThrow(/start\.js\.tmp/);
    expect(existsSync(join(root, REBIND_PLAN))).toBe(true);
    rmSync(join(root, `${ENTRY_POINT}.tmp`), { recursive: true });
    setup(options(install));
    expect(named(install)).toEqual([b, c]);
    expect(record(install)!.extraState).toEqual([b, c]);
  });

  test('cut after one file: the next run maps only the files the plan hasn\'t, so none is mapped twice', () => {
    const { a, b, c, places } = chained();
    const root = rootOf(install);
    const second = join(root, 'set-aside', 'm2', 'places.json');
    mkdirSync(`${second}.tmp`);
    expect(() => setup(options(install, { places }))).toThrow(/places\.json\.tmp/);
    expect(named(install)).toEqual([b, c]);
    expect(listed(install)).toEqual([a, b]);
    rmSync(`${second}.tmp`, { recursive: true });
    setup(options(install));
    expect(named(install)).toEqual([b, c]);
    expect(listed(install)).toEqual([b, c]);
  });

  test('cut after the record: the plan still stands, so starts refuse, until the next run removes it', () => {
    const { b, c, places } = chained();
    const root = rootOf(install);
    const plan = join(root, REBIND_PLAN);
    const realUnlink = fs.unlinkSync;
    const unlinks = spyOn(fs, 'unlinkSync').mockImplementation(((path: fs.PathLike) => {
      if (String(path) === plan) throw new Error('cut');
      realUnlink(path);
    }) as typeof fs.unlinkSync);
    try {
      expect(() => setup(options(install, { places }))).toThrow('cut');
    } finally {
      unlinks.mockRestore();
    }
    expect(record(install)).toEqual({ v: 1, dataDir: join(install, 'data'), extraState: [b, c], workingDir: install });
    expect(existsSync(plan)).toBe(true);
    expect(startOf(install).exitCode).toBe(1);
    setup(options(install));
    expect(existsSync(plan)).toBe(false);
    expect(named(install)).toEqual([b, c]);
    expect(startOf(install).exitCode).toBe(0);
  });

  test('a run finishing a plan takes no --place, and one in another directory than the plan binds to is refused', () => {
    const { places } = chained();
    const root = rootOf(install);
    mkdirSync(join(root, 'connectome.tmp'));
    expect(() => setup(options(install, { places }))).toThrow(/connectome\.tmp/);
    rmSync(join(root, 'connectome.tmp'), { recursive: true });
    expect(refusal(() => setup(options(install, { places })))).toContain('so it takes no --place: run it again without.');
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const kept = tree(rootOf(moved));
    expect(refusal(() => setup(options(moved)))).toContain(`A setup run binding this install to ${install} was cut off before it finished, and the install is in ${moved} now`);
    expect(tree(rootOf(moved))).toEqual(kept);
  });
});

describe('the lock across a move or a copy', () => {
  test('a copy made while the original\'s host runs brought its lock: setup finds the same lock where the install was, sets the copy\'s aside, and binds; the original\'s stays', () => {
    setup(options(install));
    updated(install);
    const lock = lockHeldBy(install, live());
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    setup(options(copy));
    expect(record(copy)!.workingDir).toBe(copy);
    expect(existsSync(installPaths(rootOf(copy)).lock)).toBe(false);
    expect(readRecord<LockRecord>(installPaths(rootOf(install)).lock, 'lock')).toEqual(lock);
  });

  test('a move with its host still running is refused, saying what is known and both ways out', () => {
    setup(options(install));
    updated(install);
    const pid = live();
    lockHeldBy(install, pid);
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const kept = tree(rootOf(moved));
    const why = refusal(() => setup(options(moved)));
    expect(why).toContain(`This install's lock (${installPaths(rootOf(moved)).lock}) is held by process ${pid}, since 2026-11-04T00:00:00.000Z, which is running, and there's no lock where the install was, at ${installPaths(rootOf(install)).lock}.`);
    expect(why).toContain('So it may be this install\'s own host, or a lock that came with this install when it was copied while another install\'s host ran.');
    expect(why).toContain(`If that process is this install's host, stop it and run setup again; if the lock came with a copy, remove ${installPaths(rootOf(moved)).lock} and run setup again.`);
    expect(tree(rootOf(moved))).toEqual(kept);
  });

  test('where the root where the install was leads back to this one, the lock there is this lock, and shows no copy', () => {
    setup(options(install));
    lockHeldBy(install, live());
    const other = join(dir, 'other');
    mkdirSync(other);
    symlinkSync(rootOf(install), rootOf(other));
    writeJsonAtomic(installPaths(rootOf(install)).install, { v: 1, dataDir: join(install, 'data'), extraState: [], workingDir: other });
    const places = [{ from: join(install, 'data'), to: join(install, 'data') }];
    expect(refusal(() => setup(options(install, { places })))).toContain(`and ${rootOf(other)}, where the install was, leads to this same directory.`);
    expect(record(install)!.workingDir).toBe(other);
  });

  test('a lock where the install was that names another holder shows no copy', () => {
    setup(options(install));
    lockHeldBy(install, live());
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    lockHeldBy(install, live(), '2026-11-04T00:00:01.000Z');
    expect(refusal(() => setup(options(copy)))).toContain(`and the lock where the install was, ${installPaths(rootOf(install)).lock}, names another.`);
  });

  test('a copied lock replaced between the comparison and its setting aside goes back, and is refused as held', () => {
    setup(options(install));
    lockHeldBy(install, live());
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const lock = installPaths(rootOf(copy)).lock;
    const other = live();
    const realRename = fs.renameSync;
    const renames = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === lock) lockHeldBy(copy, other, '2026-11-04T00:00:02.000Z');
      realRename(from, to);
    }) as typeof fs.renameSync);
    try {
      expect(refusal(() => setup(options(copy)))).toContain(`Another start of this install holds its lock (${lock}): process ${other}`);
    } finally {
      renames.mockRestore();
    }
    expect(readRecord<LockRecord>(lock, 'lock')!.pid).toBe(other);
  });

  test('a record from before workingDir, with a rewrite and a running lock holder, is refused with both readings', () => {
    setup(options(install));
    updated(install);
    writeJsonAtomic(installPaths(rootOf(install)).install, { v: 1, dataDir: join(install, 'data'), extraState: [] });
    lockHeldBy(install, live());
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const places = [join(install, 'data'), join(install, 'mcpl-servers.json'), join(install, 'mcpl-servers.agent.json')]
      .map((path) => ({ from: path, to: path.replace(install, copy) }));
    const why = refusal(() => setup(options(copy, { places })));
    expect(why).toContain('which is running, and this install\'s record is from a release that didn\'t record where the install was, so setup can\'t look for that lock there.');
    expect(why).toContain('If that process is this install\'s host, stop it and run setup again; if the lock came with a copy');
    expect(existsSync(join(rootOf(copy), REBIND_PLAN))).toBe(false);
  });
});
