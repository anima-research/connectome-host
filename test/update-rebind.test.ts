import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WRITE_RECORD_AGAIN, installPaths, readRecord, writeJsonAtomic, type CopyLabel, type GoBackList, type InstallRecord,
  type LockRecord,
} from '../src/update/contract.js';
import { decide, machineOps, releaseLock } from '../src/update/launcher.js';
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

function commandOf(at: string, ...argv: string[]): { exitCode: number; stderr: string } {
  const run = Bun.spawnSync([process.execPath, join(rootOf(at), 'connectome'), ...argv], { cwd: at, stderr: 'pipe' });
  return { exitCode: run.exitCode ?? -1, stderr: run.stderr.toString() };
}

function beforeTheLock(at: string, meanwhile: () => void): () => void {
  const lock = installPaths(rootOf(at)).lock;
  const realLink = fs.linkSync;
  let done = false;
  const links = spyOn(fs, 'linkSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === lock && !done) {
      done = true;
      const taking = readFileSync(from);
      meanwhile();
      writeFileSync(from, taking);
    }
    realLink(from, to);
  }) as typeof fs.linkSync);
  return () => links.mockRestore();
}

const SETUP_MODULE = join(import.meta.dir, '..', 'src', 'update', 'setup.ts');
const mountsAllowed = (() => {
  if (process.platform !== 'linux' || Bun.which('unshare') === null) return false;
  const probe = mkdtempSync(join(tmpdir(), 'update-rebind-mount-'));
  try {
    mkdirSync(join(probe, 'a'));
    mkdirSync(join(probe, 'b'));
    return Bun.spawnSync(['unshare', '-rm', 'mount', '--bind', join(probe, 'a'), join(probe, 'b')]).exitCode === 0;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();
const bindMounted = test.skipIf(!mountsAllowed);

function setupThroughMounts(mounts: Array<[string, string]>, at: string, over: Partial<SetupOptions> = {}): string {
  const code = `import { setup } from ${JSON.stringify(SETUP_MODULE)};\n` +
    'const given = JSON.parse(process.env.SETUP_OPTIONS);\n' +
    'try {\n' +
    '  setup({ ...given, say: () => {}, units: () => ({ found: [], unasked: [], unresolved: [], defaulted: [] }) });\n' +
    '  console.log("set up");\n' +
    '} catch (error) {\n' +
    '  console.log(error.message);\n' +
    '}\n';
  const { cwd, dataDir, root, extraState, hostRoot, places } = options(at, over);
  const given = { cwd, dataDir, root, extraState, hostRoot, places };
  const mount = mounts.map(([from, to]) => `mount --bind '${from}' '${to}'`).join(' && ');
  const run = Bun.spawnSync(['unshare', '-rm', 'sh', '-c', `${mount} && exec "$0" -e "$SETUP_CODE"`, process.execPath], {
    env: { ...process.env, SETUP_CODE: code, SETUP_OPTIONS: JSON.stringify(given) }, stdout: 'pipe', stderr: 'pipe',
  });
  return run.stdout.toString() + run.stderr.toString();
}

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

  test('a record from before workingDir takes each place under the directory that holds the install as its own, asking nothing about them, and asks about each place outside it', () => {
    const outside = join(dir, 'state.json');
    writeFileSync(outside, 'state');
    setup(options(install, { extraState: [outside] }));
    updated(install, [outside]);
    const root = rootOf(install);
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: join(install, 'data'), extraState: [outside] });
    const kept = tree(root);
    const why = refusal(() => setup(options(install)));
    expect(why).toContain(`This install's record is from a release that didn't record which directory an install is in. Setup takes each place under ${install}, other than inside another install's directory, as this install's`);
    expect(why.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim().split(' (')[0])).toEqual([outside]);
    expect(tree(root)).toEqual(kept);
    const labelled = readFileSync(join(root, 'copy', 'copy.json'), 'utf-8');
    setup(options(install, { places: [{ from: outside, to: outside }] }));
    expect(record(install)).toEqual({ v: 1, dataDir: join(install, 'data'), extraState: [outside], workingDir: install });
    expect(readFileSync(join(root, 'copy', 'copy.json'), 'utf-8')).toBe(labelled);
  });

  test('a record from before workingDir in a copy made above the original asks about the original\'s places, which lie below another install\'s root', () => {
    const above = join(dir, 'above');
    const original = join(above, 'service');
    mkdirSync(above);
    renameSync(install, original);
    setup(options(original));
    updated(original);
    writeJsonAtomic(installPaths(rootOf(original)).install, { v: 1, dataDir: join(original, 'data'), extraState: [] });
    for (const name of readdirSync(original)) copyOf(join(original, name), join(above, name));
    const kept = tree(rootOf(above));
    const why = refusal(() => setup(options(above)));
    const asked = why.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim().split(' (')[0]);
    expect(asked).toEqual([join(original, 'data'), join(original, 'mcpl-servers.agent.json'), join(original, 'mcpl-servers.json')]);
    expect(tree(rootOf(above))).toEqual(kept);
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
    expect(refusal(() => setup(options(install, { places: [{ from: join(install, 'data'), to: join(install, 'data') }] }))))
      .toContain('this install has no record yet, so there\'s nothing to bind');
    expect(existsSync(installPaths(rootOf(install)).install)).toBe(false);
    setup(options(install));
    expect(refusal(() => setup(options(install, { places: [{ from: join(install, 'data'), to: join(install, 'data') }] }))))
      .toContain(`this install's record is bound to ${install}, where it is, so there's nothing to bind`);
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const why = refusal(() => setup(options(moved, { places: [{ from: join(dir, 'elsewhere'), to: join(dir, 'other') }] })));
    expect(why).toContain(`--place ${join(dir, 'elsewhere')} names no place this install's record, its copy's label or its Go backs' lists name. Those it names:\n  ${join(install, 'data')} (its data directory; not there now)`);
    expect(record(moved)!.workingDir).toBe(install);
  });

  test('parseArgs reads --place as a path and its place, each resolved, and refuses one with no place', () => {
    expect(parseArgs(['--place', 'a', '/b', '--extra-state', 'c']).places).toEqual([{ from: join(process.cwd(), 'a'), to: '/b' }]);
    expect(() => parseArgs(['--place', 'a'])).toThrow('--place takes a path and its place, and only the path followed it');
  });

  test('a moved install whose record is written again as setup advises is bound, each place asked about, not taken as bound where it is', () => {
    setup(options(install));
    updated(install);
    const before = label(install)!;
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const advised = WRITE_RECORD_AGAIN.split('\n')[1]!.trim()
      .replace('<data directory>', join(moved, 'data')).replace('[<places>]', '[]').replace('<working directory>', moved);
    writeFileSync(installPaths(rootOf(moved)).install, advised);
    const kept = tree(rootOf(moved));
    const why = refusal(() => setup(options(moved)));
    expect(why).toContain('So it needs to be told where each of these is in this install');
    expect(why).toContain(join(install, 'data'));
    expect(tree(rootOf(moved))).toEqual(kept);
    setup(options(moved, { places: ['data', 'mcpl-servers.agent.json', 'mcpl-servers.json'].map((name) => ({ from: join(install, name), to: join(moved, name) })) }));
    expect(record(moved)).toEqual({ v: 1, dataDir: join(moved, 'data'), extraState: [], workingDir: moved });
    expect(label(moved)!.items).toEqual(before.items.map((item) => ({ ...item, path: item.path.replace(install, moved) })));
    expect(existsSync(join(rootOf(moved), REBIND_PLAN))).toBe(false);
  });

  test('a binding refuses while the record or a label names a place in a form other than its plain one, naming it and its plain form, and changes nothing', () => {
    setup(options(install));
    updated(install);
    const root = rootOf(install);
    const outside = join(dir, 'state.json');
    writeFileSync(outside, 'the original\'s state');
    const roundabout = `${install}/../state.json`;
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: join(install, 'data'), extraState: [roundabout], workingDir: install });
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const kept = tree(rootOf(copy));
    const why = refusal(() => setup(options(copy)));
    expect(why).toContain(`names ${roundabout}, which isn't in the plain form setup compares places in. Write it as ${outside}`);
    expect(why).toContain('Setup has changed nothing.');
    expect(tree(rootOf(copy))).toEqual(kept);

    const slashed = `${join(install, 'data')}/`;
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: slashed, extraState: [] });
    expect(refusal(() => setup(options(install, { places: parseArgs(['--place', slashed, slashed]).places }))))
      .toContain(`names ${slashed}, which isn't in the plain form setup compares places in. Write it as ${join(install, 'data')}`);

    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: join(install, 'data'), extraState: [], workingDir: install });
    const copyLabel = label(install)!;
    writeJsonAtomic(join(root, 'copy', 'copy.json'),
      { ...copyLabel, items: copyLabel.items.map((item, i) => i === 1 ? { ...item, path: `${install}/./mcpl-servers.json` } : item) });
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    expect(refusal(() => setup(options(moved))))
      .toContain(`${join(rootOf(moved), 'copy', 'copy.json')} names ${install}/./mcpl-servers.json, which isn't in the plain form`);
  });

  test('a record from before workingDir, its install moved and a link left at the old directory, is bound to the real directory: the record, the copy\'s label and the Go back\'s list all name the places there, and nothing is asked', () => {
    setup(options(install));
    updated(install);
    writeJsonAtomic(installPaths(rootOf(install)).install, { v: 1, dataDir: join(install, 'data'), extraState: [] });
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    symlinkSync(moved, install);
    setup(options(moved, { dataDir: join(install, 'data') }));
    const here = [join(moved, 'data'), join(moved, 'mcpl-servers.json')];
    expect(record(moved)).toEqual({ v: 1, dataDir: join(moved, 'data'), extraState: [], workingDir: moved });
    expect(label(moved)!.items.map((item) => item.path)).toEqual(here);
    expect(label(moved)!.absent!.map((item) => item.path)).toEqual([join(moved, 'mcpl-servers.agent.json')]);
    expect(list(moved)!.places.map((place) => place.path)).toEqual(here);
    expect(existsSync(join(rootOf(moved), REBIND_PLAN))).toBe(false);
  });

  test('a place given with --place that holds the install root is refused, as --extra-state is, and nothing changes', () => {
    const outside = join(dir, 'state.json');
    writeFileSync(outside, 'state');
    setup(options(install, { extraState: [outside] }));
    updated(install, [outside]);
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const kept = tree(rootOf(moved));
    const why = refusal(() => setup(options(moved, { places: [{ from: outside, to: moved }] })));
    expect(why).toBe(`The binding puts ${outside} at ${moved}, and that and the install root ${rootOf(moved)} are one inside ` +
      'the other, so a copy of the data would hold the copy itself. Give ' + outside + ' a place apart from the root with ' +
      '--place. Setup has changed nothing.');
    expect(tree(rootOf(moved))).toEqual(kept);
  });

  test('a place only a copy\'s label and a Go back\'s list name, given a place inside the install root, is refused as one the record names is, and nothing changes', () => {
    const outside = join(dir, 'state.json');
    writeFileSync(outside, 'state');
    setup(options(install));
    updated(install, [outside]);
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const kept = tree(rootOf(moved));
    const inside = join(rootOf(moved), 'state.json');
    const why = refusal(() => setup(options(moved, { places: [{ from: outside, to: inside }] })));
    expect(why).toBe(`The binding puts ${outside} at ${inside}, and that and the install root ${rootOf(moved)} are one ` +
      'inside the other, so a copy of the data would hold the copy itself. Give ' + outside + ' a place apart from the ' +
      'root with --place. Setup has changed nothing.');
    expect(tree(rootOf(moved))).toEqual(kept);
  });

  test('a place the binding moves under the new directory, there a link into the install root, is refused by where the link leads, and nothing changes', () => {
    const state = join(install, 'state.json');
    writeFileSync(state, 'state');
    setup(options(install, { extraState: [state] }));
    updated(install, [state]);
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const into = join(rootOf(moved), 'inside.json');
    writeFileSync(into, 'inside');
    rmSync(join(moved, 'state.json'));
    symlinkSync(into, join(moved, 'state.json'));
    const kept = tree(rootOf(moved));
    const why = refusal(() => setup(options(moved)));
    expect(why).toBe(`The binding puts ${state} at ${join(moved, 'state.json')}, and that, which is ${into} once its ` +
      `links are followed, and the install root ${rootOf(moved)} are one inside the other, so a copy of the data would ` +
      `hold the copy itself. Give ${state} a place apart from the root with --place. Setup has changed nothing.`);
    expect(tree(rootOf(moved))).toEqual(kept);
    expect(record(moved)!.workingDir).toBe(install);
  });

  test('a place kept where it was, which a copy\'s install root now holds, is refused, and nothing changes', () => {
    const copy = join(dir, 'copy');
    const state = join(rootOf(copy), 'keep.json');
    mkdirSync(rootOf(copy), { recursive: true });
    writeFileSync(state, 'state');
    setup(options(install, { extraState: [state] }));
    updated(install, [state]);
    expect(Bun.spawnSync(['cp', '-a', `${install}/.`, copy]).exitCode).toBe(0);
    const kept = tree(rootOf(copy));
    const why = refusal(() => setup(options(copy, { places: [{ from: state, to: state }] })));
    expect(why).toBe(`The binding puts ${state} at ${state}, and that and the install root ${rootOf(copy)} are one inside ` +
      `the other, so a copy of the data would hold the copy itself. Give ${state} a place apart from the root with ` +
      '--place. Setup has changed nothing.');
    expect(tree(rootOf(copy))).toEqual(kept);
  });

  test('setup run by hand says which of the places it asks about isn\'t there now, as connectome setup\'s question does', () => {
    const outside = join(dir, 'state.json');
    writeFileSync(outside, 'state');
    setup(options(install, { extraState: [outside] }));
    updated(install, [outside]);
    writeJsonAtomic(installPaths(rootOf(install)).install, { v: 1, dataDir: join(install, 'data'), extraState: [outside] });
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const asked = refusal(() => setup(options(moved))).split('\n').filter((line) => line.startsWith('  '));
    expect(asked.map((line) => line.trim().split(' (')[0]).sort()).toEqual([
      join(install, 'data'), outside, join(install, 'mcpl-servers.agent.json'), join(install, 'mcpl-servers.json'),
    ].sort());
    for (const line of asked) {
      expect(line.endsWith('; not there now)')).toBe(!line.startsWith(`  ${outside} (`));
    }
  });

  test('a place inside another is asked about with it, and the places of state outside the data directory are asked about in the record\'s order', () => {
    const [z, state, a] = ['z.json', 'state', 'a.json'].map((name) => join(dir, name));
    writeFileSync(z, z);
    mkdirSync(state);
    writeFileSync(a, a);
    setup(options(install, { extraState: [z, state, a] }));
    updated(install, [z, state, a]);
    const root = rootOf(install);
    const goBack = list(install)!;
    const sessions = join(state, 'sessions');
    writeJsonAtomic(join(root, 'set-aside', 'm2', 'places.json'),
      { ...goBack, places: [...goBack.places, { path: sessions, name: `${goBack.places.length}-sessions`, before: 'dir', target: 'dir' }] });
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: join(install, 'data'), extraState: [z, state, a] });
    const why = refusal(() => setup(options(install)));
    const asked = why.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim().split(' (')[0]);
    expect(asked).toEqual([z, state, a]);
    expect(why).toContain(`  ${state} (state kept outside its data directory; named by ${join(root, 'copy', 'copy.json')} and ${join(root, 'set-aside', 'm2', 'places.json')})`);
  });

  test('an install moved twice is bound each time: the second binding maps the places the first gave', () => {
    setup(options(install));
    updated(install);
    const first = join(dir, 'first');
    renameSync(install, first);
    setup(options(first));
    const second = join(dir, 'second');
    renameSync(first, second);
    setup(options(second));
    expect(label(second)!.items.map((item) => item.path)).toEqual([join(second, 'data'), join(second, 'mcpl-servers.json')]);
    expect(list(second)!.places.map((place) => place.path)).toEqual([join(second, 'data'), join(second, 'mcpl-servers.json')]);
  });

  test('a label with no list of absent places is bound without gaining one', () => {
    setup(options(install));
    updated(install);
    const bare: CopyLabel = { ...label(install)! };
    delete bare.absent;
    writeJsonAtomic(join(rootOf(install), 'copy', 'copy.json'), bare);
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    setup(options(moved));
    const bound = label(moved)!;
    expect(bound.items.map((item) => item.path)).toEqual([join(moved, 'data'), join(moved, 'mcpl-servers.json')]);
    expect('absent' in bound).toBe(false);
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

  test.skipIf(process.getuid?.() === 0)('a copy\'s label or the set-aside directory this user can\'t read is refused as one setup can\'t bind, saying why, and nothing changes', () => {
    setup(options(install));
    updated(install);
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const root = rootOf(moved);
    const unreadable = [join(root, 'copy', 'copy.json'), join(root, 'set-aside')];
    const said = unreadable.map((path) => {
      fs.chmodSync(path, 0o000);
      try {
        return refusal(() => setup(options(moved)));
      } finally {
        fs.chmodSync(path, path.endsWith('.json') ? 0o644 : 0o755);
      }
    });
    expect(said.map((why) => why.split(' (EACCES')[0])).toEqual([
      `The copy's label at ${unreadable[0]} can't be read`, `${unreadable[1]} can't be listed`,
    ]);
    for (const why of said) expect(why).toEndWith('so setup can\'t bind the places it names to this directory, and has changed nothing.');
    expect(record(moved)!.workingDir).toBe(install);
    expect(existsSync(join(root, REBIND_PLAN))).toBe(false);
  });
});

describe('a binding cut off', () => {
  test('cut as the copy\'s label is rewritten: the plan stands, no file is bound yet, both entries refuse, and the next run finishes from the plan, asking nothing again', () => {
    const { a, b, c, places } = chained();
    const root = rootOf(install);
    mkdirSync(join(root, 'copy', 'copy.json.tmp'));
    expect(() => setup(options(install, { places }))).toThrow(/copy\.json\.tmp/);
    expect(existsSync(join(root, REBIND_PLAN))).toBe(true);
    expect(record(install)!.workingDir).toBeUndefined();
    expect(named(install)).toEqual([a, b]);
    expect(listed(install)).toEqual([a, b]);
    const refused = startOf(install);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('a setup binding this install was cut off before it finished');
    expect(refused.stderr).toContain('Setup, run again, finishes it from its plan without asking about its places again, or says what stops it');
    const command = commandOf(install, 'update');
    expect(command.exitCode).toBe(1);
    expect(command.stderr).toContain('a setup binding this install was cut off before it finished');
    rmSync(join(root, 'copy', 'copy.json.tmp'), { recursive: true });
    setup(options(install));
    expect(said).toContain(`Finished binding the install at ${root} to ${install}, which a setup run cut off had begun, with the places that run was given.`);
    expect(named(install)).toEqual([b, c]);
    expect(listed(install)).toEqual([b, c]);
    expect(record(install)).toEqual({ v: 1, dataDir: join(install, 'data'), extraState: [b, c], workingDir: install });
    expect(existsSync(join(root, REBIND_PLAN))).toBe(false);
  });

  test('cut as the entries are written, before the plan: no plan stands and nothing is bound, so the next run binds with the places it\'s given', () => {
    const { a, b, c, places } = chained();
    const root = rootOf(install);
    mkdirSync(join(root, `${ENTRY_POINT}.tmp`));
    expect(() => setup(options(install, { places }))).toThrow(/start\.js\.tmp/);
    expect(existsSync(join(root, REBIND_PLAN))).toBe(false);
    expect(named(install)).toEqual([a, b]);
    expect(record(install)!.workingDir).toBeUndefined();
    rmSync(join(root, `${ENTRY_POINT}.tmp`), { recursive: true });
    setup(options(install, { places }));
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
    expect(record(install)).toEqual({ v: 1, dataDir: join(install, 'data'), extraState: [b, c], workingDir: install });
    expect(startOf(install).exitCode).toBe(0);
  });

  test('cut after the files, before the record: each file is bound, the record is as it was, the plan stands, and the next run finishes it', () => {
    const { b, c, places } = chained();
    const root = rootOf(install);
    mkdirSync(`${installPaths(root).install}.tmp`);
    expect(() => setup(options(install, { places }))).toThrow(/install\.json\.tmp/);
    expect(named(install)).toEqual([b, c]);
    expect(listed(install)).toEqual([b, c]);
    expect(record(install)!.workingDir).toBeUndefined();
    expect(existsSync(join(root, REBIND_PLAN))).toBe(true);
    rmSync(`${installPaths(root).install}.tmp`, { recursive: true });
    setup(options(install));
    expect(record(install)).toEqual({ v: 1, dataDir: join(install, 'data'), extraState: [b, c], workingDir: install });
    expect(existsSync(join(root, REBIND_PLAN))).toBe(false);
  });

  test('cut just as its plan is on disk, a binding of an install whose entries an older release wrote has already put in the entries that refuse while the plan stands', () => {
    const { places } = chained();
    const root = rootOf(install);
    writeFileSync(join(root, ENTRY_POINT), '// an older release\'s entry\n');
    writeFileSync(join(root, 'connectome'), '// an older release\'s command\n');
    const plan = join(root, REBIND_PLAN);
    const realRename = fs.renameSync;
    const renames = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      realRename(from, to);
      if (String(to) === plan) throw new Error('cut just after the plan');
    }) as typeof fs.renameSync);
    try {
      expect(() => setup(options(install, { places }))).toThrow('cut just after the plan');
    } finally {
      renames.mockRestore();
    }
    expect(existsSync(plan)).toBe(true);
    const start = startOf(install);
    expect(start.exitCode).toBe(1);
    expect(start.stderr).toContain('a setup binding this install was cut off before it finished');
    const command = commandOf(install, 'update');
    expect(command.exitCode).toBe(1);
    expect(command.stderr).toContain('a setup binding this install was cut off before it finished');
  });

  test('a plan that isn\'t whole is refused as one this release can\'t finish, naming each file to put right, and nothing changes', () => {
    const { places } = chained();
    const root = rootOf(install);
    mkdirSync(join(root, 'copy', 'copy.json.tmp'));
    expect(() => setup(options(install, { places }))).toThrow(/copy\.json\.tmp/);
    rmSync(join(root, 'copy', 'copy.json.tmp'), { recursive: true });
    const plan = join(root, REBIND_PLAN);
    const whole = JSON.parse(readFileSync(plan, 'utf-8')) as Record<string, unknown> & { record: Record<string, unknown> };
    const damaged = [
      { ...whole, id: undefined }, { ...whole, from: 5 }, { ...whole, to: null }, { ...whole, places: {} },
      { ...whole, places: [{ from: join(dir, 'a.json') }] }, { ...whole, record: { ...whole.record, dataDir: 5 } },
      { ...whole, record: { ...whole.record, extraState: 'x' } }, { ...whole, record: { ...whole.record, v: undefined } },
      { ...whole, record: { ...whole.record, workingDir: undefined } },
    ];
    for (const value of damaged) {
      writeFileSync(plan, JSON.stringify(value));
      const kept = tree(root);
      const why = refusal(() => setup(options(install)));
      expect(why, JSON.stringify(value)).toContain('isn\'t one this release reads');
      expect(why).toContain('put this install\'s record, copy/copy.json, copy.prev/copy.json and each set-aside/*/places.json right');
      expect(tree(root)).toEqual(kept);
    }
  });

  test('a Go back\'s list that can\'t be read once a binding has begun is refused as a binding under way, naming its plan, not as nothing changed, and says to put that list right', () => {
    const { places } = chained();
    const root = rootOf(install);
    const second = join(root, 'set-aside', 'm2', 'places.json');
    mkdirSync(`${second}.tmp`);
    expect(() => setup(options(install, { places }))).toThrow(/places\.json\.tmp/);
    rmSync(`${second}.tmp`, { recursive: true });
    writeFileSync(second, 'not a list');
    const why = refusal(() => setup(options(install)));
    expect(why).toContain(second);
    expect(why).toContain(`A binding of this install is under way, with its plan at ${join(root, REBIND_PLAN)}: put ${second} right and run setup again, which finishes the binding or names what else stops it.`);
    expect(why).not.toContain('changed nothing');
    expect(existsSync(join(root, REBIND_PLAN))).toBe(true);
  });

  test('a run finishing a plan from a record before workingDir, with a running lock holder, is refused with both readings, and changes nothing', () => {
    const { places } = chained();
    const root = rootOf(install);
    mkdirSync(join(root, 'copy', 'copy.json.tmp'));
    expect(() => setup(options(install, { places }))).toThrow(/copy\.json\.tmp/);
    rmSync(join(root, 'copy', 'copy.json.tmp'), { recursive: true });
    lockHeldBy(install, live());
    const kept = tree(root);
    const why = refusal(() => setup(options(install)));
    expect(why).toContain('which is running, and this install\'s record is from a release that didn\'t record where the install was');
    expect(tree(root)).toEqual(kept);
  });

  test('a run finishing a plan takes no --place, and one in another directory than the plan binds to is refused', () => {
    const { places } = chained();
    const root = rootOf(install);
    mkdirSync(join(root, 'copy', 'copy.json.tmp'));
    expect(() => setup(options(install, { places }))).toThrow(/copy\.json\.tmp/);
    rmSync(join(root, 'copy', 'copy.json.tmp'), { recursive: true });
    expect(refusal(() => setup(options(install, { places })))).toContain(`A binding of this install that a setup run cut off has its plan at ${join(root, 'rebind.json')}, and setup, run again, finishes it from its plan with the places that run was given, or says what stops it, so it takes no --place: run it again without.`);
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const kept = tree(rootOf(moved));
    expect(refusal(() => setup(options(moved)))).toContain(`A setup run binding this install to ${install} was cut off before it finished, and the install is in ${moved} now`);
    expect(tree(rootOf(moved))).toEqual(kept);
  });

  test('a plan cut off, then the install moved again, is refused as moved even when the data directory its plan names is gone, and nothing changes', () => {
    const { places } = chained();
    const root = rootOf(install);
    mkdirSync(join(root, 'copy', 'copy.json.tmp'));
    expect(() => setup(options(install, { places }))).toThrow(/copy\.json\.tmp/);
    rmSync(join(root, 'copy', 'copy.json.tmp'), { recursive: true });
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const kept = tree(rootOf(moved));
    const why = refusal(() => setup(options(moved, { dataDir: join(install, 'data') })));
    expect(why).toContain(`A setup run binding this install to ${install} was cut off before it finished, and the install is in ${moved} now`);
    expect(tree(rootOf(moved))).toEqual(kept);
  });

  bindMounted('a plan cut off is finished through another name of the directory it binds to, a bind mount (where this user may bind-mount, as in a user namespace)', () => {
    const { b, c, places } = chained();
    const root = rootOf(install);
    mkdirSync(join(root, 'copy', 'copy.json.tmp'));
    expect(() => setup(options(install, { places }))).toThrow(/copy\.json\.tmp/);
    rmSync(join(root, 'copy', 'copy.json.tmp'), { recursive: true });
    const alias = join(dir, 'alias');
    mkdirSync(alias);
    expect(setupThroughMounts([[install, alias]], alias, { dataDir: join(install, 'data') })).toContain('set up');
    expect(named(install)).toEqual([b, c]);
    expect(existsSync(join(root, REBIND_PLAN))).toBe(false);
  });
});

describe('what setup read before it held the lock', () => {
  test('a binding that finds a plan another setup wrote meanwhile refuses, and leaves that plan as it was', () => {
    const { places } = chained();
    const root = rootOf(install);
    const other = {
      v: 1, id: 'another-setup', from: null, to: install, places: [],
      record: { v: 1, dataDir: join(install, 'data'), extraState: [], workingDir: install },
    };
    const restore = beforeTheLock(install, () => writeJsonAtomic(join(root, REBIND_PLAN), other));
    const why = (() => {
      try {
        return refusal(() => setup(options(install, { places })));
      } finally {
        restore();
      }
    })();
    expect(why).toContain('isn\'t what setup read before it held the lock, so setup has changed none of them.');
    expect(JSON.parse(readFileSync(join(root, REBIND_PLAN), 'utf-8'))).toEqual(other);
  });

  test('a binding whose install another setup bound meanwhile refuses, changing nothing more, and the install starts', () => {
    setup(options(install));
    updated(install);
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const restore = beforeTheLock(moved, () => setup(options(moved)));
    const why = (() => {
      try {
        return refusal(() => setup(options(moved)));
      } finally {
        restore();
      }
    })();
    expect(why).toContain('isn\'t what setup read before it held the lock, so setup has changed none of them.');
    expect(existsSync(join(rootOf(moved), REBIND_PLAN))).toBe(false);
    expect(label(moved)!.items.map((item) => item.path)).toEqual([join(moved, 'data'), join(moved, 'mcpl-servers.json')]);
    expect(startOf(moved).exitCode).toBe(0);
  });

  test('a run finishing a plan that another setup finished meanwhile refuses, changing nothing more', () => {
    const { b, c, places } = chained();
    const root = rootOf(install);
    mkdirSync(join(root, 'copy', 'copy.json.tmp'));
    expect(() => setup(options(install, { places }))).toThrow(/copy\.json\.tmp/);
    rmSync(join(root, 'copy', 'copy.json.tmp'), { recursive: true });
    const restore = beforeTheLock(install, () => setup(options(install)));
    const why = (() => {
      try {
        return refusal(() => setup(options(install)));
      } finally {
        restore();
      }
    })();
    expect(why).toContain('isn\'t what setup read before it held the lock, so setup has changed none of them.');
    expect(named(install)).toEqual([b, c]);
    expect(record(install)).toEqual({ v: 1, dataDir: join(install, 'data'), extraState: [b, c], workingDir: install });
  });

  test('a label naming a place the binding has no place for, written after setup read the install, is refused before any plan is written', () => {
    setup(options(install));
    updated(install);
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const root = rootOf(moved);
    const realReadlink = fs.readlinkSync;
    let written = false;
    const reads = spyOn(fs, 'readlinkSync').mockImplementation(((...args: Parameters<typeof fs.readlinkSync>) => {
      if (!written) {
        written = true;
        mkdirSync(join(root, 'copy.prev'));
        writeJsonAtomic(join(root, 'copy.prev', 'copy.json'),
          { ...label(moved)!, items: [{ path: join(dir, 'elsewhere.json'), name: '0-elsewhere.json' }], absent: [] });
      }
      return Reflect.apply(realReadlink, fs, args);
    }) as typeof fs.readlinkSync);
    const why = (() => {
      try {
        return refusal(() => setup(options(moved)));
      } finally {
        reads.mockRestore();
      }
    })();
    expect(why).toContain('isn\'t what setup read before it held the lock, so setup has changed none of them.');
    expect(existsSync(join(root, REBIND_PLAN))).toBe(false);
    expect(record(moved)!.workingDir).toBe(install);
  });

  test('a record from before workingDir, with an answer that moves a place no file names, takes the lock: a running holder is refused with both readings, and nothing changes', () => {
    setup(options(install));
    const theirs = join(dir, 'state.json');
    const own = join(dir, 'own.json');
    writeFileSync(theirs, 'the original\'s state');
    writeFileSync(own, 'this install\'s state');
    writeJsonAtomic(installPaths(rootOf(install)).install, { v: 1, dataDir: join(install, 'data'), extraState: [theirs] });
    lockHeldBy(install, live());
    const kept = tree(rootOf(install));
    const places = [{ from: join(install, 'data'), to: join(install, 'data') }, { from: theirs, to: own }];
    const why = refusal(() => setup(options(install, { places })));
    expect(why).toContain('which is running, and this install\'s record is from a release that didn\'t record where the install was');
    expect(why).toContain('If that process is this install\'s host, stop it and run setup again; if the lock came with a copy');
    expect(tree(rootOf(install))).toEqual(kept);
  });
});

describe('a start', () => {
  test('the launcher refuses a binding\'s plan it finds once it holds the lock', async () => {
    setup(options(install));
    const root = rootOf(install);
    const lock = installPaths(root).lock;
    const realLink = fs.linkSync;
    const links = spyOn(fs, 'linkSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      realLink(from, to);
      if (String(to) === lock) writeFileSync(join(root, REBIND_PLAN), '{}');
    }) as typeof fs.linkSync);
    try {
      await expect(decide(root, machineOps())).rejects.toThrow(`Nothing runs in this install, since a setup binding this install was cut off before it finished (${join(root, REBIND_PLAN)} is its plan), so the places it names may be half bound. Setup, run again, finishes it from its plan without asking about its places again, or says what stops it`);
    } finally {
      links.mockRestore();
      releaseLock(root);
    }
  });
});

describe('the lock across a move or a copy', () => {
  test('a copy made while the original\'s host runs brought its lock: setup finds the same lock where the install was, sets the copy\'s aside, and binds; the original\'s stays', () => {
    setup(options(install));
    updated(install);
    const lock = lockHeldBy(install, live());
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const copyLock = installPaths(rootOf(copy)).lock;
    const bound = [join(rootOf(copy), 'copy', 'copy.json'), join(rootOf(copy), 'set-aside', 'm2', 'places.json')];
    const holders: Array<number | undefined> = [];
    const realRename = fs.renameSync;
    const renames = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (bound.includes(String(to))) holders.push(readRecord<LockRecord>(copyLock, 'lock')?.pid);
      realRename(from, to);
    }) as typeof fs.renameSync);
    try {
      setup(options(copy));
    } finally {
      renames.mockRestore();
    }
    expect(holders).toEqual([process.pid, process.pid]);
    expect(record(copy)!.workingDir).toBe(copy);
    expect(existsSync(copyLock)).toBe(false);
    expect(readRecord<LockRecord>(installPaths(rootOf(install)).lock, 'lock')).toEqual(lock);
  });

  bindMounted('where the root where the install was is this root through a bind mount, the lock there is this lock, and shows no copy (where this user may bind-mount, as in a user namespace)', () => {
    setup(options(install));
    lockHeldBy(install, live());
    const other = join(dir, 'other');
    mkdirSync(rootOf(other), { recursive: true });
    writeJsonAtomic(installPaths(rootOf(install)).install, { v: 1, dataDir: join(install, 'data'), extraState: [], workingDir: other });
    const places = [{ from: join(install, 'data'), to: join(install, 'data') }];
    expect(setupThroughMounts([[rootOf(install), rootOf(other)]], install, { places }))
      .toContain(`and ${rootOf(other)}, where the install was, leads to this same directory.`);
    expect(record(install)!.workingDir).toBe(other);
    expect(existsSync(installPaths(rootOf(install)).lock)).toBe(true);
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
