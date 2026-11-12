import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installPaths, readCurrent, readRecord, writeJsonAtomic, writeMark, type ChildrenFile, type CopyLabel, type GoBackList,
  type InstallRecord, type LockRecord,
} from '../src/update/contract.js';
import { dataItems, liveChildren, machineOps } from '../src/update/launcher.js';
import { ENTRY_POINT, parseArgs, setup, type ServiceUnits, type SetupOptions } from '../src/update/setup.js';
import { modeTest } from './mode-test.js';

let dir: string;
let install: string;
let said: string[];
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

function throughMounts(mounts: Array<[string, string]>, code: string, given: unknown): string {
  const mount = mounts.map(([from, to]) => `mount --bind '${from}' '${to}'`).join(' && ');
  const run = Bun.spawnSync(['unshare', '-rm', 'sh', '-c', `${mount} && exec "$0" -e "$SETUP_CODE"`, process.execPath], {
    env: { ...process.env, SETUP_CODE: code, SETUP_OPTIONS: JSON.stringify(given) }, stdout: 'pipe', stderr: 'pipe',
  });
  return run.stdout.toString() + run.stderr.toString();
}

function setupThroughMounts(mounts: Array<[string, string]>, at: string, over: Partial<SetupOptions> = {}): string {
  const code = `import { setup } from ${JSON.stringify(SETUP_MODULE)};\n` +
    'const given = JSON.parse(process.env.SETUP_OPTIONS);\n' +
    'try {\n' +
    '  setup({ ...given, say: () => {}, units: () => ({ found: [], unasked: [], unresolved: [], defaulted: [] }) });\n' +
    '  console.log("set up");\n' +
    '} catch (error) {\n' +
    '  console.log(error.message);\n' +
    '}\n';
  const { cwd, dataDir, root, extraState, hostRoot, places, moveAside } = options(at, over);
  return throughMounts(mounts, code, { cwd, dataDir, root, extraState, hostRoot, places, moveAside });
}

const LAUNCHER_MODULE = join(import.meta.dir, '..', 'src', 'update', 'launcher.ts');

function startCheckThroughMounts(mounts: Array<[string, string]>, root: string, dataDir: string): string {
  const code = `import { machineOps, readInstall } from ${JSON.stringify(LAUNCHER_MODULE)};\n` +
    'const { root, dataDir } = JSON.parse(process.env.SETUP_OPTIONS);\n' +
    'try {\n' +
    '  readInstall(root, { ...machineOps(), dataDir: () => dataDir });\n' +
    '  console.log("starts");\n' +
    '} catch (error) {\n' +
    '  console.log(error.message);\n' +
    '}\n';
  return throughMounts(mounts, code, { root, dataDir });
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
  test('a data directory inside a place of state, after a move with another DATA_DIR, is told to the place that holds it, which --place then takes', () => {
    const state = join(dir, 'state');
    mkdirSync(join(state, 'data', 'sessions'), { recursive: true });
    setup(options(install, { dataDir: join(state, 'data'), extraState: [state] }));
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const state2 = join(dir, 'state2');
    fs.cpSync(state, state2, { recursive: true });
    const other = join(dir, 'other');
    mkdirSync(join(other, 'data', 'sessions'), { recursive: true });
    const why = refusal(() => setup(options(moved, { dataDir: join(other, 'data'), places: [{ from: state, to: state2 }] })));
    expect(why).toContain(`Run it with DATA_DIR ${join(state2, 'data')}, or with --place giving ${state} its place in this ` +
      `install, since ${state} holds ${join(state, 'data')}.`);
    setup(options(moved, { dataDir: join(other, 'data'), places: [{ from: state, to: other }] }));
    expect(record(moved)).toMatchObject({ dataDir: join(other, 'data'), extraState: [other], workingDir: moved });
  });

  test('a --place for a place of state the record lists, which this run\'s --extra-state replaces, is refused saying the binding leaves it out', () => {
    const ext = join(dir, 'ext-data');
    mkdirSync(join(ext, 'sessions'), { recursive: true });
    const old = join(dir, 'old-state');
    const fresh = join(dir, 'new-state');
    mkdirSync(old);
    mkdirSync(fresh);
    setup(options(install, { dataDir: ext, extraState: [old] }));
    writeJsonAtomic(installPaths(rootOf(install)).install, { v: 1, dataDir: ext, extraState: [old] });
    const why = refusal(() => setup(options(install, {
      dataDir: ext, extraState: [fresh], places: [{ from: ext, to: ext }, { from: old, to: old }],
    })));
    expect(why.split('\n')[0]).toBe(`--place ${old} names a place of state this install's record lists, but this run's ` +
      '--extra-state replaces the record\'s list, so the binding doesn\'t bind it, and the install goes on without it. Run ' +
      'setup again without that --place, or with no --extra-state to keep the record\'s list. The places it binds:');
  });

  test('a setup run records the real path of the directory that holds the root, as the record\'s workingDir', () => {
    const linked = join(dir, 'linked');
    symlinkSync(install, linked);
    setup(options(linked));
    expect(record(install)).toEqual({ v: 1, dataDir: join(install, 'data'), extraState: [], workingDir: install });
  });

  test('a moved install is bound where it is: each place under the old directory goes to the same place under the new, in the record, and its lock is free after', () => {
    const state = join(install, 'state');
    mkdirSync(state);
    setup(options(install, { extraState: [state] }));
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    said = [];
    setup(options(moved));
    expect(record(moved)).toEqual({ v: 1, dataDir: join(moved, 'data'), extraState: [join(moved, 'state')], workingDir: moved });
    expect(existsSync(installPaths(rootOf(moved)).lock)).toBe(false);
    expect(said[0]).toBe(`Bound the install at ${rootOf(moved)} to ${moved}, where it serves ${join(moved, 'data')} and runs 0.10.2. Start its service again if it stopped.`);
  });

  test('a copy with a place outside its directory is refused until that place is given, changing nothing; given, the copy is bound to its own places and the original keeps its own', () => {
    const outside = join(dir, 'state.json');
    writeFileSync(outside, 'the original\'s state');
    setup(options(install, { extraState: [outside] }));
    const original = tree(rootOf(install));
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const kept = tree(rootOf(copy));
    const why = refusal(() => setup(options(copy)));
    expect(why).toContain(`This install's record is bound to ${install}, and the install is in ${copy}, so it was moved or copied here.`);
    expect(why).toContain(`  ${outside} (state kept outside its data directory)`);
    expect(why).toContain('Give each with --place PATH PLACE');
    expect(why).not.toContain(join(install, 'data'));
    expect(tree(rootOf(copy))).toEqual(kept);

    const own = join(dir, 'copy-state.json');
    writeFileSync(own, 'the copy\'s state');
    setup(options(copy, { places: [{ from: outside, to: own }] }));
    expect(record(copy)).toEqual({ v: 1, dataDir: join(copy, 'data'), extraState: [own], workingDir: copy });
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

  test('a record from before workingDir given --extra-state in place of its list counts the list it replaces as moved, so it refuses while the root keeps what names that list', () => {
    const outside = join(dir, 'state.json');
    writeFileSync(outside, 'state');
    setup(options(install, { extraState: [outside] }));
    updated(install, [outside]);
    const root = rootOf(install);
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: join(install, 'data'), extraState: [outside] });
    const kept = tree(root);
    const own = join(install, 'state.json');
    writeFileSync(own, 'state');
    const why = refusal(() => setup(options(install, { extraState: [own] })));
    expect(why).toContain('This binding gives places of this install other places than its record names, so what its updates and Go backs keep in its root names the places as they were');
    expect(why).toContain('Setup has changed nothing. Run it again with --move-aside');
    expect(tree(root)).toEqual(kept);
  });

  test('a record from before workingDir in a copy made above the original asks about the original\'s places, which lie below another install\'s root', () => {
    const above = join(dir, 'above');
    const original = join(above, 'service');
    mkdirSync(above);
    renameSync(install, original);
    const state = join(original, 'state');
    mkdirSync(state);
    setup(options(original, { extraState: [state] }));
    writeJsonAtomic(installPaths(rootOf(original)).install, { v: 1, dataDir: join(original, 'data'), extraState: [state] });
    for (const name of readdirSync(original)) copyOf(join(original, name), join(above, name));
    const kept = tree(rootOf(above));
    const why = refusal(() => setup(options(above)));
    const asked = why.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim().split(' (')[0]);
    expect(asked).toEqual([join(original, 'data'), state]);
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
    const places = [{ from: join(install, 'data'), to: join(install, 'data') }];
    mkdirSync(`${installPaths(root).install}.tmp`);
    expect(() => setup(options(install, { places }))).toThrow(/install\.json\.tmp/);
    expect(readFileSync(join(root, ENTRY_POINT), 'utf-8')).toContain('its record is bound to');
    expect(record(install)).toEqual({ v: 1, dataDir: join(install, 'data'), extraState: [] });
    rmSync(`${installPaths(root).install}.tmp`, { recursive: true });
    setup(options(install, { places }));
    expect(record(install)).toEqual({ v: 1, dataDir: join(install, 'data'), extraState: [], workingDir: install });
    expect(readFileSync(join(root, 'copy', 'copy.json'), 'utf-8')).toBe(files.label);
    expect(readFileSync(join(root, 'set-aside', 'm2', 'places.json'), 'utf-8')).toBe(files.list);
    expect(readRecord<LockRecord>(installPaths(root).lock, 'lock')).toEqual(lock);
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
    expect(why).toContain(`--place ${join(dir, 'elsewhere')} names no place this install's record or the fleet's children file name. Those it names:\n  ${join(install, 'data')} (its data directory; not there now)`);
    expect(record(moved)!.workingDir).toBe(install);
  });

  test('parseArgs reads --place as a path and its place, each resolved, and refuses one with no place', () => {
    expect(parseArgs(['--place', 'a', '/b', '--extra-state', 'c']).places).toEqual([{ from: join(process.cwd(), 'a'), to: '/b' }]);
    expect(() => parseArgs(['--place', 'a'])).toThrow('--place takes a path and its place, and only the path followed it');
  });

  test('a binding refuses while the record names a place in a form other than its plain one, naming it and its plain form, and changes nothing', () => {
    setup(options(install));
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
  });

  test('a record from before workingDir, its install moved and a link left at the old directory, is bound to the real directory, nothing asked, and its copy and Go back, which name the same places through the link, stay', () => {
    setup(options(install));
    updated(install);
    writeJsonAtomic(installPaths(rootOf(install)).install, { v: 1, dataDir: join(install, 'data'), extraState: [] });
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    symlinkSync(moved, install);
    const files = tree(rootOf(moved));
    setup(options(moved, { dataDir: join(install, 'data') }));
    expect(record(moved)).toEqual({ v: 1, dataDir: join(moved, 'data'), extraState: [], workingDir: moved });
    for (const name of ['copy/copy.json', 'set-aside/m2/places.json']) expect(tree(rootOf(moved))[name]).toBe(files[name]);
  });

  test('a place given with --place that holds the install root is refused, as --extra-state is, and nothing changes', () => {
    const outside = join(dir, 'state.json');
    writeFileSync(outside, 'state');
    setup(options(install, { extraState: [outside] }));
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const kept = tree(rootOf(moved));
    const why = refusal(() => setup(options(moved, { places: [{ from: outside, to: moved }] })));
    expect(why).toBe(`The binding puts ${outside} at ${moved}, and that and the install root ${rootOf(moved)} are one inside ` +
      'the other, so a copy of the data would hold the copy itself. Give ' + outside + ' a place apart from the root with ' +
      '--place. Setup has changed nothing.');
    expect(tree(rootOf(moved))).toEqual(kept);
  });

  test('a place the binding moves under the new directory, there a link into the install root, is refused by where the link leads, and nothing changes', () => {
    const state = join(install, 'state.json');
    writeFileSync(state, 'state');
    setup(options(install, { extraState: [state] }));
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
    writeJsonAtomic(installPaths(rootOf(install)).install, { v: 1, dataDir: join(install, 'data'), extraState: [outside] });
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const asked = refusal(() => setup(options(moved))).split('\n').filter((line) => line.startsWith('  '));
    expect(asked.map((line) => line.trim().split(' (')[0]).sort()).toEqual([join(install, 'data'), outside].sort());
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
    const root = rootOf(install);
    const children = join(install, 'data', 'fleet-children.json');
    writeJsonAtomic(children,
      { v: 1, children: [{ name: 'c', pid: null, bootId: null, dataDir: join(state, 'kid') }] } satisfies ChildrenFile);
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: join(install, 'data'), extraState: [z, state, a] });
    const why = refusal(() => setup(options(install)));
    const asked = why.split('\n').filter((line) => line.startsWith('  ')).map((line) => line.trim().split(' (')[0]);
    expect(asked).toEqual([z, state, a]);
    expect(why).toContain(`  ${state} (state kept outside its data directory; named by ${children})`);
  });

  test('an install moved twice is bound each time: the second binding maps the places the first gave', () => {
    const state = join(install, 'state');
    mkdirSync(state);
    setup(options(install, { extraState: [state] }));
    const first = join(dir, 'first');
    renameSync(install, first);
    setup(options(first));
    const second = join(dir, 'second');
    renameSync(first, second);
    setup(options(second));
    expect(record(second)).toEqual({ v: 1, dataDir: join(second, 'data'), extraState: [join(second, 'state')], workingDir: second });
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

  test('a record whose workingDir is there but isn\'t an absolute path, as null or a relative path that a copy\'s directory would resolve to its own, is refused by its start and by setup, each naming it, and setup saying how to write the record again; nothing changes', () => {
    setup(options(install));
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const recordAt = installPaths(rootOf(copy)).install;
    for (const workingDir of [null, '.', 'service']) {
      writeFileSync(recordAt, JSON.stringify({ v: 1, dataDir: join(install, 'data'), extraState: [], workingDir }));
      const kept = tree(copy);
      const start = startOf(copy);
      expect(start.exitCode).toBe(1);
      expect(start.stderr).toContain(`nothing runs in this install, since its record, ${recordAt}, holds a "workingDir" ` +
        'that isn\'t an absolute path, so whether it was moved or copied here, and whose places its record names, can\'t ' +
        'be told.');
      const why = refusal(() => setup(options(copy)));
      expect(why).toStartWith(`This install's record (${recordAt}) holds a "workingDir" that isn't an absolute path ` +
        `(${JSON.stringify(workingDir)}), so setup can't tell whether the install was moved or copied here, or whose ` +
        'places its record names. Setup has changed nothing. To put it right, write the record again as\n');
      expect(tree(copy)).toEqual(kept);
    }
  });

  test.skipIf(process.getuid?.() === 0)('a set-aside directory this user can\'t list, in an install that was moved, is refused, saying why, and nothing changes', () => {
    setup(options(install));
    updated(install);
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const setAside = join(rootOf(moved), 'set-aside');
    fs.chmodSync(setAside, 0o000);
    let why: string;
    try {
      why = refusal(() => setup(options(moved)));
    } finally {
      fs.chmodSync(setAside, 0o755);
    }
    expect(why.split(' (EACCES')[0]).toBe(`${setAside} can't be listed`);
    expect(why).toEndWith('so setup can\'t tell whether a Go back kept anything there. Setup has changed nothing. Make ' +
      'it readable to this user, and run setup again.');
    expect(record(moved)!.workingDir).toBe(install);
  });
});

bindMounted('a DATA_DIR that is the recorded data directory through a bind mount is refused by setup, naming the recorded one, as a start with it is refused (where this user may bind-mount, as in a user namespace)', () => {
  setup(options(install));
  const alias = join(dir, 'alias');
  mkdirSync(alias);
  const recorded = join(install, 'data');
  const before = tree(install);
  expect(setupThroughMounts([[install, alias]], alias)).toContain(`The install at ${rootOf(alias)} serves ${recorded}, ` +
    `and setup was given DATA_DIR ${join(alias, 'data')}, which leads to that same directory by another path, as through ` +
    'a bind mount. A start compares the two paths once links are followed, so its host wouldn\'t start with that ' +
    `DATA_DIR. Setup has changed nothing. Run it, and have the service start the host, with DATA_DIR ${recorded}.`);
  expect(startCheckThroughMounts([[install, alias]], rootOf(alias), join(alias, 'data'))).toContain(`This install ` +
    `serves the data directory ${recorded}, and this start would serve ${join(alias, 'data')}.`);
  expect(tree(install)).toEqual(before);
});

bindMounted('a binding given a DATA_DIR that is the mapped data directory through a bind mount is refused, naming the mapped one, since the record keeps the spelling it can map (where this user may bind-mount, as in a user namespace)', () => {
  setup(options(install));
  const copy = join(dir, 'copy');
  copyOf(install, copy);
  const alias = join(dir, 'alias');
  mkdirSync(alias);
  expect(setupThroughMounts([[copy, alias]], copy, { dataDir: join(alias, 'data') })).toContain(`Bound to ${copy}, the ` +
    `install at ${rootOf(copy)} serves ${join(copy, 'data')}, the place of the data directory its record names, ` +
    `${join(install, 'data')}, and setup was given DATA_DIR ${join(alias, 'data')}. Setup has changed nothing. Run it ` +
    `with DATA_DIR ${join(copy, 'data')}`);
  expect(record(copy)!.workingDir).toBe(install);
});

describe('what setup read before it held the lock', () => {
  const changedMeanwhile = 'This install\'s record, the fleet\'s children file, what its root keeps from updates and Go ' +
    'backs, the trial or Go back its journal leaves unfinished, or the Go back its mark asks for isn\'t what setup read ' +
    'before it held the lock, so setup has changed none of them. Run it again, and it reads them afresh.';

  test('a children file replaced after setup read it, before the lock, is refused as changed meanwhile, and nothing is rewritten', () => {
    setup(options(install));
    const children = (at: string) => join(at, 'data', 'fleet-children.json');
    writeJsonAtomic(children(install),
      { v: 1, children: [{ name: 'c', pid: null, bootId: null, dataDir: join(install, 'data', 'kid') }] } satisfies ChildrenFile);
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const replaced: ChildrenFile = { v: 1, children: [{ name: 'd', pid: null, bootId: null, dataDir: join(install, 'data', 'other') }] };
    const restore = beforeTheLock(moved, () => writeJsonAtomic(children(moved), replaced));
    try {
      expect(refusal(() => setup(options(moved)))).toBe(changedMeanwhile);
    } finally {
      restore();
    }
    expect(readRecord<ChildrenFile>(children(moved), 'children file')).toEqual(replaced);
    expect(record(moved)!.workingDir).toBe(install);
  });

  test('a copy that appears in the root after setup read it, or a trial begun meanwhile, is refused as changed meanwhile, and nothing is moved or bound', () => {
    setup(options(install));
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const root = rootOf(moved);
    const appears = beforeTheLock(moved, () => {
      mkdirSync(join(root, 'copy'));
      writeFileSync(join(root, 'copy', 'copy.json'), '{}');
    });
    try {
      expect(refusal(() => setup(options(moved)))).toBe(changedMeanwhile);
    } finally {
      appears();
    }
    expect(record(moved)!.workingDir).toBe(install);
    const kept = tree(moved);
    const begun = beforeTheLock(moved, () => writeFileSync(installPaths(root).journal, `${JSON.stringify({
      v: 1, at: '2026-11-01T00:00:00Z', step: 'trial-start', from: '0.10.2', to: '0.11.0', outcome: 'ok', mark: 'm1',
    })}\n`));
    try {
      expect(refusal(() => setup(options(moved, { moveAside: true })))).toBe(changedMeanwhile);
    } finally {
      begun();
    }
    const now = tree(moved);
    delete now['connectome-host/journal.jsonl'];
    expect(now).toEqual(kept);
    expect(record(moved)!.workingDir).toBe(install);
  });

  test('a Go back asked for after setup read the install, before the lock, is refused as changed meanwhile, and nothing is moved or bound', () => {
    setup(options(install));
    updated(install);
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const root = rootOf(moved);
    const kept = tree(moved);
    const asked = beforeTheLock(moved, () => writeMark(root, { to: '0.10.1', why: 'go-back' }));
    try {
      expect(refusal(() => setup(options(moved, { moveAside: true })))).toBe(changedMeanwhile);
    } finally {
      asked();
    }
    const now = tree(moved);
    delete now['connectome-host/mark.json'];
    expect(now).toEqual(kept);
    expect(record(moved)!.workingDir).toBe(install);
  });

  test('a binding whose install another setup bound meanwhile refuses, changing nothing more, and the install starts', () => {
    setup(options(install));
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
    expect(why).toBe(changedMeanwhile);
    expect(record(moved)!.workingDir).toBe(moved);
    expect(startOf(moved).exitCode).toBe(0);
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

describe('the lock across a move or a copy', () => {
  test('a copy made while the original\'s host runs brought its lock: setup finds the same lock where the install was, sets the copy\'s aside, and binds; the original\'s stays', () => {
    setup(options(install));
    writeJsonAtomic(join(install, 'data', 'fleet-children.json'),
      { v: 1, children: [{ name: 'c', pid: null, bootId: null, dataDir: join(install, 'data', 'kid') }] } satisfies ChildrenFile);
    const lock = lockHeldBy(install, live());
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const copyLock = installPaths(rootOf(copy)).lock;
    const bound = [join(copy, 'data', 'fleet-children.json'), installPaths(rootOf(copy)).install];
    const holders: Array<number | undefined> = [];
    const renamed: string[] = [];
    const realRename = fs.renameSync;
    const renames = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      renamed.push(String(to));
      if (bound.includes(String(to))) holders.push(readRecord<LockRecord>(copyLock, 'lock')?.pid);
      realRename(from, to);
    }) as typeof fs.renameSync);
    try {
      setup(options(copy));
    } finally {
      renames.mockRestore();
    }
    expect(renamed).toContain(`${copyLock}.${process.pid}.copied`);
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
    const pid = live();
    lockHeldBy(install, pid);
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const kept = tree(rootOf(moved));
    const why = refusal(() => setup(options(moved)));
    expect(why).toContain(`This install's lock (${installPaths(rootOf(moved)).lock}) is held by process ${pid}, since 2026-11-04T00:00:00.000Z, which is running, and there's no lock where the install was, at ${installPaths(rootOf(install)).lock}.`);
    expect(why).toContain('So it may be this install\'s own host, or a lock that came with this install when it was copied while another install\'s host ran.');
    expect(why).toContain(`If that process is this install's host, stop it and run setup again; if the lock came with a copy, remove ${installPaths(rootOf(moved)).lock} if it still names process ${pid} since 2026-11-04T00:00:00.000Z, and run setup again.`);
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
      expect(refusal(() => setup(options(copy)))).toContain(`Another process holds this install's lock (${lock}): process ${other}`);
    } finally {
      renames.mockRestore();
    }
    expect(readRecord<LockRecord>(lock, 'lock')!.pid).toBe(other);
  });

  test('a copied lock replaced before its setting aside, and taken again before it can go back, is left where it was set aside, and setup refuses naming both locks', () => {
    setup(options(install));
    lockHeldBy(install, live());
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const lock = installPaths(rootOf(copy)).lock;
    const aside = `${lock}.${process.pid}.copied`;
    const second = live();
    const third = live();
    const realRename = fs.renameSync;
    const realLink = fs.linkSync;
    const renames = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === lock) lockHeldBy(copy, second, '2026-11-04T00:00:02.000Z');
      realRename(from, to);
    }) as typeof fs.renameSync);
    const links = spyOn(fs, 'linkSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === aside && String(to) === lock) lockHeldBy(copy, third, '2026-11-04T00:00:03.000Z');
      realLink(from, to);
    }) as typeof fs.linkSync);
    let why: string;
    try {
      why = refusal(() => setup(options(copy)));
    } finally {
      renames.mockRestore();
      links.mockRestore();
    }
    expect(why).toContain(`setup moved that process's lock to ${aside}, and couldn't put it back, since ${lock} is there again.`);
    expect(readRecord<LockRecord>(aside, 'lock')!.pid).toBe(second);
    expect(readRecord<LockRecord>(lock, 'lock')!.pid).toBe(third);
    expect(record(copy)!.workingDir).toBe(install);
  });

  test('a binding takes the lock from a holder whose process has ended, and binds', () => {
    setup(options(install));
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const ended = Bun.spawnSync(['sh', '-c', 'echo $$']);
    const pid = Number(ended.stdout.toString().trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    lockHeldBy(copy, pid);
    setup(options(copy));
    expect(record(copy)!.workingDir).toBe(copy);
    expect(existsSync(installPaths(rootOf(copy)).lock)).toBe(false);
  });

  test('a record from before workingDir, with a place moved and a running lock holder, is refused with both readings', () => {
    setup(options(install));
    writeJsonAtomic(installPaths(rootOf(install)).install, { v: 1, dataDir: join(install, 'data'), extraState: [] });
    lockHeldBy(install, live());
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const kept = tree(rootOf(copy));
    const why = refusal(() => setup(options(copy, { places: [{ from: join(install, 'data'), to: join(copy, 'data') }] })));
    expect(why).toContain('which is running, and this install\'s record is from a release that didn\'t record where the install was, so setup can\'t look for that lock there.');
    expect(why).toContain('If that process is this install\'s host, stop it and run setup again; if the lock came with a copy');
    expect(tree(rootOf(copy))).toEqual(kept);
  });
});

describe('what a moved or copied install\'s root keeps', () => {
  const area = (place: string, kind: 'set-aside' | 'staging', mark: string) => join(place, '.connectome-update', kind, mark);
  const aside = (root: string) => {
    const times = readdirSync(join(root, 'moved-aside'));
    expect(times).toHaveLength(1);
    return times[0]!;
  };
  const afterwards = 'Nothing removes what\'s moved aside: it takes its space until you remove it. What a Go back kept ' +
    'holds the newer data it set aside, so move out what you want of it rather than deleting it. Until the next update ' +
    'takes a new copy, /update back restore isn\'t there, and each update says it removes no older release.';

  test('a moved install whose root holds a copy, the copy before it and a Go back\'s area is refused, naming each, how to move them aside and what that loses, and nothing changes', () => {
    setup(options(install));
    updated(install);
    mkdirSync(join(rootOf(install), 'copy.prev'));
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const root = rootOf(moved);
    const kept = tree(moved);
    const why = refusal(() => setup(options(moved)));
    expect(why).toBe(`This install was moved or copied here from ${install}, so what its updates and Go backs keep in its ` +
      'root names that directory\'s places, and restoring from it here would write them:\n' +
      `  ${join(root, 'copy')}\n  ${join(root, 'copy.prev')}\n  ${join(root, 'set-aside', 'm2')}\n` +
      `Setup has changed nothing. Run it again with --move-aside, which moves each into ${join(root, 'moved-aside')}, ` +
      'under the time it runs, and the areas each Go back keeps inside a place this binding puts under ' +
      `${moved} into that place's .connectome-update/moved-aside, or move them out yourself: each one listed, and in ` +
      'each directory an update copies that\'s under this install\'s directory, .connectome-update/set-aside/<mark> and .connectome-update/staging/<mark> for ' +
      `each mark listed, with or without .tmp, .filling or .emptying after it. ${afterwards}`);
    expect(tree(moved)).toEqual(kept);
  });

  test('--move-aside moves each into moved-aside under the time it runs, and each Go back\'s areas inside a place under this directory into its own; it names an area outside and leaves it, says each move, and binds the install', () => {
    const outside = join(dir, 'state');
    mkdirSync(outside);
    setup(options(install, { extraState: [outside] }));
    updated(install, [outside]);
    const data = join(install, 'data');
    const areas = [area(data, 'set-aside', 'm2'), area(data, 'staging', 'm2.filling'), area(outside, 'set-aside', 'm2')];
    for (const path of areas) {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'newer.txt'), path);
    }
    writeJsonAtomic(join(data, 'fleet-children.json'),
      { v: 1, children: [{ name: 'c', pid: null, bootId: null, dataDir: outside }] } satisfies ChildrenFile);
    const original = tree(install);
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const root = rootOf(copy);
    said = [];
    setup(options(copy, { places: [{ from: outside, to: outside }], moveAside: true }));
    const time = aside(root);
    expect(readdirSync(root).filter((name) => name.startsWith('copy') || name === 'set-aside')).toEqual(['set-aside']);
    expect(readdirSync(join(root, 'set-aside'))).toEqual([]);
    const movedTo = join(root, 'moved-aside', time);
    expect(readRecord<CopyLabel>(join(movedTo, 'copy', 'copy.json'), 'label')!.from).toBe('0.10.2');
    expect(readRecord<GoBackList>(join(movedTo, 'set-aside', 'm2', 'places.json'), 'list')!.places[0]!.path).toBe(data);
    const copied = join(copy, 'data');
    const inData = join(copied, '.connectome-update', 'moved-aside', time);
    expect(readFileSync(join(inData, 'set-aside', 'm2', 'newer.txt'), 'utf-8')).toBe(areas[0]);
    expect(readFileSync(join(inData, 'staging', 'm2.filling', 'newer.txt'), 'utf-8')).toBe(areas[1]);
    expect(existsSync(area(copied, 'set-aside', 'm2'))).toBe(false);
    expect(existsSync(areas[2]!)).toBe(true);
    expect(said.slice(0, 7)).toEqual([
      'Moved aside what this install\'s updates and Go backs kept, which names places that aren\'t this install\'s now:',
      `  ${area(copied, 'set-aside', 'm2')} → ${join(inData, 'set-aside', 'm2')}`,
      `  ${area(copied, 'staging', 'm2.filling')} → ${join(inData, 'staging', 'm2.filling')}`,
      `  ${join(root, 'set-aside', 'm2')} → ${join(movedTo, 'set-aside', 'm2')}`,
      `  ${join(root, 'copy')} → ${join(movedTo, 'copy')}`,
      afterwards,
      `Setup left these where they are, since they're outside ${copy}: each is what a Go back kept inside a place ` +
        'outside it, which may be another install\'s. Where the place is this install\'s own, move it out yourself, ' +
        'keeping what you want of it:',
    ]);
    expect(said[7]).toBe(`  ${areas[2]}`);
    expect(said[8]).not.toBe(`  ${areas[2]}`);
    expect(record(copy)).toEqual({ v: 1, dataDir: copied, extraState: [outside], workingDir: copy });
    expect(tree(install)).toEqual(original);
  });

  test('--move-aside is refused where this run gives no place of the install another place: an install bound where it is, and a record from before workingDir whose places all stay, which gets its stamp with its copy and Go back in place', () => {
    setup(options(install));
    updated(install);
    const refused = '--move-aside moves aside what an install\'s updates and Go backs keep once the install\'s places ' +
      'have moved, and this run gives none of them another place, so what they keep still names this install\'s ' +
      'places. Run it again without.';
    expect(refusal(() => setup(options(install, { moveAside: true })))).toBe(refused);
    const root = rootOf(install);
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: join(install, 'data'), extraState: [] });
    const kept = tree(root);
    expect(refusal(() => setup(options(install, { moveAside: true })))).toBe(refused);
    expect(tree(root)).toEqual(kept);
    setup(options(install));
    expect(record(install)).toEqual({ v: 1, dataDir: join(install, 'data'), extraState: [], workingDir: install });
    expect(existsSync(join(root, 'copy', 'copy.json'))).toBe(true);
    expect(existsSync(join(root, 'set-aside', 'm2', 'places.json'))).toBe(true);
    expect(existsSync(join(root, 'moved-aside'))).toBe(false);
  });

  test('while a trial is unfinished, a moved install is refused with --move-aside or without, saying to let the trial end where the install was, and nothing changes', () => {
    setup(options(install));
    updated(install);
    const root = rootOf(install);
    writeFileSync(installPaths(root).journal, `${JSON.stringify({
      v: 1, at: '2026-11-01T00:00:00Z', step: 'trial-start', from: '0.10.2', to: '0.11.0', outcome: 'ok', mark: 'm1',
    })}\n`);
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const kept = tree(moved);
    const trial = 'A trial is unfinished: the journal\'s last ok trial-start, to 0.11.0, has no ok commit, ' +
      'fallback or go-back after it, and if it ends before its commit, its fallback puts the places back from what\'s ' +
      'listed here. Setup has changed nothing. Let that trial end where the install was, by starting it there, moving ' +
      'it back first if it was moved, and then move or copy it again.';
    for (const moveAside of [false, true]) {
      const why = refusal(() => setup(options(moved, { moveAside })));
      expect(why).toEndWith(`\n  ${join(rootOf(moved), 'copy')}\n  ${join(rootOf(moved), 'set-aside', 'm2')}\n${trial}`);
    }
    expect(tree(moved)).toEqual(kept);
  });

  test('a move aside whose directory sync fails after its rename counts that move as made, and says so', () => {
    setup(options(install));
    updated(install);
    const data = join(install, 'data');
    mkdirSync(area(data, 'set-aside', 'm2'), { recursive: true });
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const held = area(join(moved, 'data'), 'set-aside', 'm2');
    const realRename = fs.renameSync;
    const realSync = fs.fsyncSync;
    let renamed: string | null = null;
    let failed = false;
    const rename = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      realRename(from, to);
      if (String(from) === held) renamed = String(to);
    }) as typeof fs.renameSync);
    const sync = spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
      if (renamed !== null && !failed) {
        failed = true;
        throw new Error('EIO: i/o error, fsync');
      }
      return realSync(fd);
    }) as typeof fs.fsyncSync);
    let why: string;
    try {
      why = refusal(() => setup(options(moved, { moveAside: true })));
    } finally {
      rename.mockRestore();
      sync.mockRestore();
    }
    expect(renamed).not.toBeNull();
    expect(existsSync(renamed!)).toBe(true);
    expect(why).toContain(`Setup has moved only these:\n  ${held} → ${renamed}\nand nothing else`);
    expect(why).not.toContain('Setup has moved nothing else');
  });

  bindMounted('a move aside whose first move fails stops there, saying it moved nothing else and removed nothing, and run again once that one is moved by hand, it finishes', () => {
    setup(options(install));
    updated(install);
    const data = join(install, 'data');
    mkdirSync(area(data, 'set-aside', 'm2'), { recursive: true });
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const root = rootOf(moved);
    const held = join(moved, 'data', '.connectome-update', 'set-aside');
    const said = setupThroughMounts([[held, held]], moved, { moveAside: true });
    expect(said).toContain(`Moving ${join(held, 'm2')} to `);
    expect(said).toContain('EXDEV');
    expect(said).toContain('Setup has moved nothing else, removes nothing it moved, and hasn\'t bound the install. ' +
      `Move ${join(held, 'm2')} out of the way yourself, keeping what you want of it, and run setup again, which moves ` +
      'what\'s left (by hand, with --move-aside again).');
    expect(existsSync(join(held, 'm2'))).toBe(true);
    expect(existsSync(join(root, 'set-aside', 'm2'))).toBe(true);
    expect(record(moved)!.workingDir).toBe(install);
    renameSync(join(held, 'm2'), join(dir, 'kept-by-hand'));
    setup(options(moved, { moveAside: true }));
    expect(existsSync(join(root, 'set-aside', 'm2'))).toBe(false);
    expect(record(moved)!.workingDir).toBe(moved);
  });

  test('what was moved aside is said as soon as it is moved, so a binding stopped after the moves still names where each went', () => {
    setup(options(install));
    updated(install);
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const root = rootOf(moved);
    mkdirSync(`${installPaths(root).install}.tmp`);
    said = [];
    expect(() => setup(options(moved, { moveAside: true }))).toThrow(/install\.json\.tmp/);
    const time = aside(root);
    expect(said).toEqual([
      'Moved aside what this install\'s updates and Go backs kept, which names places that aren\'t this install\'s now:',
      `  ${join(root, 'set-aside', 'm2')} → ${join(root, 'moved-aside', time, 'set-aside', 'm2')}`,
      `  ${join(root, 'copy')} → ${join(root, 'moved-aside', time, 'copy')}`,
      afterwards,
    ]);
    expect(record(moved)!.workingDir).toBe(install);
  });

  test('--move-aside takes a place by where it leads: an area that a copied link reaches in the original is named and left, and the original is as it was', () => {
    setup(options(install));
    const real = join(install, 'kid-real');
    mkdirSync(real);
    const kid = join(install, 'data', 'kid');
    symlinkSync(real, kid);
    writeJsonAtomic(join(install, 'data', 'fleet-children.json'),
      { v: 1, children: [{ name: 'c', pid: null, bootId: null, dataDir: kid }] } satisfies ChildrenFile);
    updated(install, [kid]);
    const held = area(kid, 'set-aside', 'm2');
    mkdirSync(held, { recursive: true });
    writeFileSync(join(held, 'newer.txt'), 'the original\'s');
    const original = tree(install);
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    said = [];
    setup(options(copy, { moveAside: true }));
    expect(tree(install)).toEqual(original);
    expect(said).toContain(`  ${area(real, 'set-aside', 'm2')}`);
    expect(record(copy)!.workingDir).toBe(copy);
  });

  test('while a Go back is unfinished, a moved install is refused with --move-aside or without, saying to let it end where the install was, and nothing changes', () => {
    setup(options(install));
    updated(install);
    writeFileSync(installPaths(rootOf(install)).journal, `${JSON.stringify({
      v: 1, at: '2026-11-01T00:00:00Z', step: 'go-back', from: '0.11.0', to: '0.10.2', outcome: 'ok', mark: 'm2',
    })}\n`);
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const kept = tree(moved);
    const goBack = 'A Go back is unfinished: the journal\'s last ok go-back, to 0.10.2, has no ok trial-start, commit or ' +
      'fallback after it, and the next start goes on with it from what\'s listed here. Setup has changed nothing. Let ' +
      'that Go back end where the install was, by starting it there, moving it back first if it was moved, and then ' +
      'move or copy it again.';
    for (const moveAside of [false, true]) {
      const why = refusal(() => setup(options(moved, { moveAside })));
      expect(why).toEndWith(`\n  ${join(rootOf(moved), 'copy')}\n  ${join(rootOf(moved), 'set-aside', 'm2')}\n${goBack}`);
    }
    expect(tree(moved)).toEqual(kept);
  });

  test('while a Go back is asked for and no start has begun it, a moved install is refused with --move-aside or without, saying to let it run where the install was or to remove its mark, and nothing changes', () => {
    setup(options(install));
    updated(install);
    writeMark(rootOf(install), { to: '0.10.1', why: 'go-back' });
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const root = rootOf(moved);
    const kept = tree(moved);
    const asked = `A Go back is asked for: the mark at ${installPaths(root).mark} asks the next start to go back to ` +
      '0.10.1, and that start goes back from what\'s listed here. Setup has changed nothing. Let that Go back run where ' +
      'the install was, by starting it there, moving it back first if it was moved, and then move or copy it again. Or ' +
      'remove the mark file, which drops the request.';
    for (const moveAside of [false, true]) {
      const why = refusal(() => setup(options(moved, { moveAside })));
      expect(why).toEndWith(`\n  ${join(root, 'copy')}\n  ${join(root, 'set-aside', 'm2')}\n${asked}`);
    }
    expect(tree(moved)).toEqual(kept);
  });

  test('a Go back\'s mark that is spent, since the release it asks for runs, doesn\'t stop a moved install\'s binding, and setup leaves the mark file for the next start to clear', () => {
    setup(options(install));
    updated(install);
    writeMark(rootOf(install), { to: readCurrent(rootOf(install))!, why: 'go-back' });
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    setup(options(moved, { moveAside: true }));
    expect(record(moved)!.workingDir).toBe(moved);
    expect(existsSync(installPaths(rootOf(moved)).mark)).toBe(true);
  });

  test('an update asked for doesn\'t stop a moved install\'s binding, since its start takes a copy of its own', () => {
    setup(options(install));
    updated(install);
    writeMark(rootOf(install), { to: '0.11.0', why: 'update' });
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    setup(options(moved, { moveAside: true }));
    expect(record(moved)!.workingDir).toBe(moved);
  });

  test('--move-aside takes the areas a Go back kept in a place its own list names, though this run\'s record no longer names it', () => {
    const old = join(install, 'old-state');
    mkdirSync(old);
    setup(options(install, { extraState: [old] }));
    updated(install, [old]);
    mkdirSync(area(old, 'set-aside', 'm2'), { recursive: true });
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    setup(options(copy, { extraState: [], moveAside: true }));
    const copied = join(copy, 'old-state');
    expect(existsSync(area(copied, 'set-aside', 'm2'))).toBe(false);
    const time = aside(rootOf(copy));
    expect(existsSync(join(copied, '.connectome-update', 'moved-aside', time, 'set-aside', 'm2'))).toBe(true);
    expect(record(copy)).toEqual({ v: 1, dataDir: join(copy, 'data'), extraState: [], workingDir: copy });
  });

  test('--move-aside binds an install whose places of state include a file, which holds no area', () => {
    const state = join(install, 'state.json');
    writeFileSync(state, '{}');
    setup(options(install, { extraState: [state] }));
    updated(install, [state]);
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    setup(options(copy, { moveAside: true }));
    expect(record(copy)).toEqual({ v: 1, dataDir: join(copy, 'data'), extraState: [join(copy, 'state.json')], workingDir: copy });
    expect(readdirSync(join(rootOf(copy), 'set-aside'))).toEqual([]);
  });

  test('a Go back\'s list that this release can\'t read stops a binding before it changes anything, naming the list; with no list, the binding goes on', () => {
    setup(options(install));
    updated(install);
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const list = join(rootOf(copy), 'set-aside', 'm2', 'places.json');
    writeFileSync(list, '{ not json');
    const kept = tree(copy);
    for (const moveAside of [false, true]) {
      const why = refusal(() => setup(options(copy, { moveAside })));
      expect(why).toStartWith(`${list} can't be read (`);
      expect(why).toContain(`with or without .tmp, .filling or .emptying after it, and the same in each place ${list} ` +
        'names, which can\'t be named here while it can\'t be read), and run setup again.');
    }
    expect(tree(copy)).toEqual(kept);
    rmSync(list);
    setup(options(copy, { moveAside: true }));
    expect(record(copy)!.workingDir).toBe(copy);
  });

  test('a binding refused for what the root keeps names, among what to move by hand, each place a Go back\'s list names that the record doesn\'t and that is a directory under this install\'s directory', () => {
    const old = join(install, 'old-state');
    mkdirSync(old);
    setup(options(install, { extraState: [old] }));
    updated(install, [old]);
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    expect(refusal(() => setup(options(copy, { extraState: [] })))).toContain('with or without .tmp, .filling or ' +
      `.emptying after it, and the same in each of these, which a Go back's list names: ${join(copy, 'old-state')}. ` +
      'Nothing removes what\'s moved aside');
  });

  test.skipIf(process.getuid?.() === 0)('a Go back\'s mark this user can\'t search stops a binding before it changes anything, naming its list', () => {
    setup(options(install));
    updated(install);
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const mark = join(rootOf(copy), 'set-aside', 'm2');
    const kept = tree(copy);
    fs.chmodSync(mark, 0o000);
    let why: string;
    try {
      why = refusal(() => setup(options(copy, { moveAside: true })));
    } finally {
      fs.chmodSync(mark, 0o755);
    }
    expect(why).toStartWith(`${join(mark, 'places.json')} can't be read (EACCES`);
    expect(tree(copy)).toEqual(kept);
  });

  test.skipIf(process.getuid?.() === 0)('a journal this user can\'t read stops a binding whose root keeps something, naming the journal and saying setup can\'t tell whether a trial or a Go back is unfinished, and nothing changes', () => {
    setup(options(install));
    updated(install);
    writeFileSync(installPaths(rootOf(install)).journal, '');
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    const journal = installPaths(rootOf(moved)).journal;
    const kept = tree(moved);
    fs.chmodSync(journal, 0o000);
    let why: string;
    try {
      why = refusal(() => setup(options(moved, { moveAside: true })));
    } finally {
      fs.chmodSync(journal, 0o644);
    }
    expect(why).toContain(`\n  ${join(rootOf(moved), 'set-aside', 'm2')}\nThe journal at ${journal} can't be read (EACCES`);
    expect(why).toEndWith('so setup can\'t tell whether a trial or a Go back is unfinished there. Setup has changed ' +
      'nothing. Make it readable to this user, or put it right, and run setup again.');
    expect(tree(moved)).toEqual(kept);
  });

  test('--move-aside moves an area once where two of the places it looks in are one directory by two paths', () => {
    setup(options(install));
    symlinkSync('data', join(install, 'alias'));
    updated(install, [join(install, 'alias')]);
    mkdirSync(area(join(install, 'data'), 'set-aside', 'm2'), { recursive: true });
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    said = [];
    setup(options(copy, { moveAside: true }));
    expect(said.filter((line) => line.includes(`${join('.connectome-update', 'set-aside', 'm2')} → `))).toHaveLength(1);
    expect(existsSync(area(join(copy, 'data'), 'set-aside', 'm2'))).toBe(false);
    expect(record(copy)!.workingDir).toBe(copy);
  });

  test('--move-aside refuses where the place it would move an area to leads outside that area\'s place, as a link into the original does, and the original is as it was', () => {
    setup(options(install));
    updated(install);
    const held = area(join(install, 'data'), 'set-aside', 'm2');
    mkdirSync(held, { recursive: true });
    const theirs = join(install, 'data', '.connectome-update', 'moved-aside');
    mkdirSync(theirs);
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const ours = join(copy, 'data', '.connectome-update', 'moved-aside');
    rmSync(ours, { recursive: true });
    symlinkSync(theirs, ours);
    const original = tree(install);
    const why = refusal(() => setup(options(copy, { moveAside: true })));
    expect(why).toContain(`, where setup would move ${area(join(copy, 'data'), 'set-aside', 'm2')}, leads to ${theirs}/`);
    expect(why).toContain(`outside ${join(copy, 'data')}, which holds it, so setup stops there. Setup has moved nothing ` +
      `else, removes nothing it moved, and hasn't bound the install. Put ${ours} right, as a directory in ` +
      `${join(copy, 'data')} or not there at all, and run setup again (by hand, with --move-aside again).`);
    expect(tree(install)).toEqual(original);
    expect(existsSync(area(join(copy, 'data'), 'set-aside', 'm2'))).toBe(true);
    expect(record(copy)!.workingDir).toBe(install);
  });

  test('parseArgs reads --move-aside, which takes no value', () => {
    expect(parseArgs(['--move-aside', '--root', 'r']).moveAside).toBe(true);
    expect(parseArgs(['--root', 'r']).moveAside).toBe(false);
  });
});

describe('the fleet\'s children file', () => {
  const childrenOf = (at: string, data = join(at, 'data')) =>
    readRecord<ChildrenFile>(join(data, 'fleet-children.json'), 'children file')!.children;
  const withChild = (at: string, dataDir: string, pid: number | null) => {
    mkdirSync(dataDir, { recursive: true });
    writeJsonAtomic(join(at, 'data', 'fleet-children.json'),
      { v: 1, children: [{ name: 'c', pid, bootId: pid === null ? null : machineOps().bootId(), dataDir }] } satisfies ChildrenFile);
  };
  const opsIn = (at: string) => ({
    ...machineOps(), cwd: () => at, dataDir: () => join(at, 'data'), agentOverlay: () => join(at, 'mcpl-servers.agent.json'),
  });

  test('a copy binds its children file: a child\'s data directory under the old directory goes to the same place under the new, and a child the original runs is no process of the copy\'s, so its updates are neither refused for it nor copy the original\'s', () => {
    setup(options(install));
    const pid = live();
    withChild(install, join(install, 'data', 'kids', 'c'), pid);
    const original = readFileSync(join(install, 'data', 'fleet-children.json'), 'utf-8');
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    setup(options(copy));
    expect(childrenOf(copy)).toEqual([{ name: 'c', pid: null, bootId: null, dataDir: join(copy, 'data', 'kids', 'c') }]);
    expect(readFileSync(join(install, 'data', 'fleet-children.json'), 'utf-8')).toBe(original);
    expect(liveChildren(join(copy, 'data'), opsIn(copy))).toEqual([]);
    const { present, absent } = dataItems(rootOf(copy), record(copy)!, opsIn(copy));
    expect([...present, ...absent].filter((path) => path === install || path.startsWith(`${install}/`))).toEqual([]);
    expect(present).toContain(join(copy, 'data'));
  });

  test('a copy\'s binding removes the socket and pid file that came with the copy in the directory of a child the original runs, where it clears that child\'s pid, so the copy\'s fleet can start the child there; the original keeps its own', () => {
    setup(options(install));
    const kid = join(install, 'data', 'kids', 'c');
    withChild(install, kid, live());
    for (const name of ['ipc.sock', 'headless.pid']) writeFileSync(join(kid, name), 'the original child\'s');
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    setup(options(copy));
    const copied = join(copy, 'data', 'kids', 'c');
    expect(childrenOf(copy)).toEqual([{ name: 'c', pid: null, bootId: null, dataDir: copied }]);
    expect(readdirSync(copied)).toEqual([]);
    expect(readdirSync(kid).sort()).toEqual(['headless.pid', 'ipc.sock']);
  });

  modeTest('a copy whose original child directory this user can\'t look at, while its entry names a process, is refused, naming the directory, its error and both ways out, and nothing changes; following the copy\'s way out, removing the socket and pid file the copy brought and taking the process out of the entry, it binds, and the copy\'s child directory holds neither', () => {
    setup(options(install));
    const kids = join(install, 'data', 'kids');
    const kid = join(kids, 'c');
    const pid = live();
    withChild(install, kid, pid);
    writeFileSync(join(kid, 'headless.pid'), String(pid));
    writeFileSync(join(kid, 'ipc.sock'), 'the original child\'s');
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const copied = join(copy, 'data', 'kids', 'c');
    const children = join(copy, 'data', 'fleet-children.json');
    const kept = tree(copy);
    let why = '';
    fs.chmodSync(kids, 0o000);
    try {
      why = refusal(() => setup(options(copy)));
      expect(tree(copy)).toEqual(kept);
      for (const name of ['ipc.sock', 'headless.pid']) rmSync(join(copied, name));
      writeJsonAtomic(children, { v: 1, children: [{ name: 'c', pid: null, bootId: null, dataDir: kid }] } satisfies ChildrenFile);
      setup(options(copy));
    } finally {
      fs.chmodSync(kids, 0o755);
    }
    expect(why.split(' (EACCES')[0]).toBe(`${children} names ${kid} for its child c, with process ${pid}, and setup can't ` +
      'look at that directory');
    expect(why).toEndWith('whether that process is the original install\'s child, still running there, as after a copy, ' +
      'or this install\'s own. Setup stopped before it bound the install. Make that directory searchable to this user, ' +
      `and run setup again; or, if this install is a copy, remove ipc.sock and headless.pid from ${copied}, this copy's ` +
      `directory for that child, then set that child's "pid" to null in ${children}, and run setup again.`);
    expect(childrenOf(copy)).toEqual([{ name: 'c', pid: null, bootId: null, dataDir: copied }]);
    expect(readdirSync(copied)).toEqual([]);
    expect(readdirSync(kid).sort()).toEqual(['headless.pid', 'ipc.sock']);
    expect(record(copy)!.workingDir).toBe(copy);
  });

  test('a copy\'s binding syncs each child directory it removed the copied files from before it stamps the children file, so a power loss can\'t keep the stamp without the removals', () => {
    setup(options(install));
    const kid = join(install, 'data', 'kids', 'c');
    withChild(install, kid, live());
    for (const name of ['ipc.sock', 'headless.pid']) writeFileSync(join(kid, name), 'the original child\'s');
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const copied = join(copy, 'data', 'kids', 'c');
    const children = join(copy, 'data', 'fleet-children.json');
    const events: string[] = [];
    const realRm = fs.rmSync;
    const realOpen = fs.openSync;
    const realRename = fs.renameSync;
    const rm = spyOn(fs, 'rmSync').mockImplementation(((path: fs.PathLike, options?: fs.RmOptions) => {
      events.push(`rm ${String(path)}`);
      realRm(path, options);
    }) as typeof fs.rmSync);
    const open = spyOn(fs, 'openSync').mockImplementation(((path: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode | null) => {
      if (String(path) === copied) events.push(`sync ${copied}`);
      return realOpen(path, flags, mode);
    }) as typeof fs.openSync);
    const rename = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === children) events.push('stamp');
      realRename(from, to);
    }) as typeof fs.renameSync);
    try {
      setup(options(copy));
    } finally {
      rm.mockRestore();
      open.mockRestore();
      rename.mockRestore();
    }
    const removed = events.filter((event) => event.startsWith(`rm ${copied}/`));
    expect(removed).toEqual([`rm ${join(copied, 'ipc.sock')}`, `rm ${join(copied, 'headless.pid')}`]);
    expect(events.indexOf(`sync ${copied}`)).toBeGreaterThan(Math.max(...removed.map((event) => events.indexOf(event))));
    expect(events.indexOf('stamp')).toBeGreaterThan(events.indexOf(`sync ${copied}`));
  });

  test('a copy whose child is given a place that isn\'t there yet binds, with nothing there to remove or sync', () => {
    setup(options(install));
    const kid = join(dir, 'kid');
    withChild(install, kid, null);
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const own = join(dir, 'copy-kid-later');
    setup(options(copy, { places: [{ from: kid, to: own }] }));
    expect(childrenOf(copy)).toEqual([{ name: 'c', pid: null, bootId: null, dataDir: own }]);
  });

  test('a copy of an install whose record is from before workingDir binds its children file as a copy does: given the data directory\'s place, the child\'s directory goes under it, and a child the original runs is no process of the copy\'s', () => {
    setup(options(install));
    withChild(install, join(install, 'data', 'kids', 'c'), live());
    writeJsonAtomic(installPaths(rootOf(install)).install, { v: 1, dataDir: join(install, 'data'), extraState: [] });
    const original = readFileSync(join(install, 'data', 'fleet-children.json'), 'utf-8');
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    setup(options(copy, { places: [{ from: join(install, 'data'), to: join(copy, 'data') }] }));
    expect(childrenOf(copy)).toEqual([{ name: 'c', pid: null, bootId: null, dataDir: join(copy, 'data', 'kids', 'c') }]);
    expect(readFileSync(join(install, 'data', 'fleet-children.json'), 'utf-8')).toBe(original);
    expect(record(copy)!.workingDir).toBe(copy);
  });

  test('a moved install\'s binding leaves its child\'s socket and pid file, which are its own child\'s', () => {
    setup(options(install));
    const kid = join(install, 'data', 'kids', 'c');
    withChild(install, kid, live());
    for (const name of ['ipc.sock', 'headless.pid']) writeFileSync(join(kid, name), 'the child\'s');
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    setup(options(moved));
    expect(readdirSync(join(moved, 'data', 'kids', 'c')).sort()).toEqual(['headless.pid', 'ipc.sock']);
  });

  test('a moved install binds its children file and keeps the pid of a child still running, which is its own, so its updates are still refused while it runs', () => {
    setup(options(install));
    const pid = live();
    withChild(install, join(install, 'data', 'kids', 'c'), pid);
    const bootId = machineOps().bootId();
    const moved = join(dir, 'moved');
    renameSync(install, moved);
    setup(options(moved));
    expect(childrenOf(moved)).toEqual([{ name: 'c', pid, bootId, dataDir: join(moved, 'data', 'kids', 'c') }]);
    expect(liveChildren(join(moved, 'data'), opsIn(moved))).toEqual([`c (pid ${pid})`]);
  });

  test('a child\'s data directory outside the install is asked about as other places are, named by the children file, and once given, the copy\'s children file names the place given', () => {
    setup(options(install));
    const kid = join(dir, 'kid');
    withChild(install, kid, null);
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const kept = tree(rootOf(copy));
    const why = refusal(() => setup(options(copy)));
    expect(why).toContain(`  ${kid} (named by ${join(copy, 'data', 'fleet-children.json')})`);
    expect(why).toContain('Give each with --place PATH PLACE');
    expect(tree(rootOf(copy))).toEqual(kept);
    expect(childrenOf(copy)[0]!.dataDir).toBe(kid);
    const own = join(dir, 'copy-kid');
    mkdirSync(own);
    setup(options(copy, { places: [{ from: kid, to: own }] }));
    expect(childrenOf(copy)).toEqual([{ name: 'c', pid: null, bootId: null, dataDir: own }]);
    expect(childrenOf(install)[0]!.dataDir).toBe(kid);
  });

  test('a --place for a child\'s data directory, given before the data directory\'s place, is refused saying the children file is read once that place is given; given both, the binding takes both', () => {
    const data = join(dir, 'data');
    mkdirSync(join(data, 'sessions'), { recursive: true });
    setup(options(install, { dataDir: data }));
    const kid = join(dir, 'kid');
    mkdirSync(kid);
    writeJsonAtomic(join(data, 'fleet-children.json'),
      { v: 1, children: [{ name: 'c', pid: null, bootId: null, dataDir: kid }] } satisfies ChildrenFile);
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const why = refusal(() => setup(options(copy, { dataDir: data, places: [{ from: kid, to: kid }] })));
    expect(why).toContain(`--place ${kid} names no place this install's record names. The fleet's children file, in ` +
      'the data directory, is read once the data directory\'s place is given: give that with --place too. The places ' +
      'named:\n');
    setup(options(copy, { dataDir: data, places: [{ from: data, to: data }, { from: kid, to: kid }] }));
    expect(record(copy)).toEqual({ v: 1, dataDir: data, extraState: [], workingDir: copy });
  });

  test('a children file that isn\'t JSON stops a binding before it changes anything, naming the file', () => {
    setup(options(install));
    writeFileSync(join(install, 'data', 'fleet-children.json'), '{ not json');
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const kept = tree(rootOf(copy));
    const why = refusal(() => setup(options(copy)));
    expect(why).toContain(`The fleet's children file at ${join(copy, 'data', 'fleet-children.json')} isn't JSON`);
    expect(why).toEndWith('so setup can\'t bind the places it names to this directory, and has changed nothing. Put ' +
      `${join(copy, 'data', 'fleet-children.json')} right, and run setup again.`);
    expect(tree(rootOf(copy))).toEqual(kept);
  });

  test('a children file with an entry whose fields this release can\'t read stops a binding before it changes anything, naming the file', () => {
    setup(options(install));
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const children = join(copy, 'data', 'fleet-children.json');
    writeFileSync(children, JSON.stringify({ v: 1, children: [{ name: 'c', pid: 'x', bootId: null, dataDir: join(install, 'data', 'kid') }] }));
    const kept = tree(copy);
    expect(refusal(() => setup(options(copy)))).toEndWith('and has changed nothing. Put ' +
      `${children} right, and run setup again. If a later release wrote it, run that release's setup instead.`);
    expect(tree(copy)).toEqual(kept);
  });

  test('a children file a later release may have written, of a later version or naming its places in a form this release can\'t read, is refused saying to put it right or run that release\'s setup', () => {
    setup(options(install));
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const later = (path: string) => `and has changed nothing. Put ${path} right, and run setup again. If a later ` +
      'release wrote it, run that release\'s setup instead.';
    const children = join(copy, 'data', 'fleet-children.json');
    for (const written of [{ v: 2, children: [] }, { v: 1, children: {} }, { v: 1, children: [], boundTo: 5 }]) {
      writeFileSync(children, JSON.stringify(written));
      expect(refusal(() => setup(options(copy)))).toEndWith(later(children));
    }
  });

  const stampOf = (at: string) => readRecord<ChildrenFile>(join(at, 'data', 'fleet-children.json'), 'children file')!.boundTo;
  const cutBeforeRecord = (at: string): () => void => {
    const recordAt = installPaths(rootOf(at)).install;
    mkdirSync(`${recordAt}.tmp`);
    expect(() => setup(options(at))).toThrow(/install\.json\.tmp/);
    return () => rmSync(`${recordAt}.tmp`, { recursive: true });
  };

  test('cut after the children file, before the record: the file is stamped with the directory it was bound to, and the next run there leaves it as it is', () => {
    setup(options(install));
    withChild(install, join(install, 'data', 'kids', 'c'), live());
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const uncut = cutBeforeRecord(copy);
    const bound = [{ name: 'c', pid: null, bootId: null, dataDir: join(copy, 'data', 'kids', 'c') }];
    expect(childrenOf(copy)).toEqual(bound);
    expect(stampOf(copy)).toBe(copy);
    uncut();
    setup(options(copy));
    expect(childrenOf(copy)).toEqual(bound);
    expect(record(copy)!.workingDir).toBe(copy);
  });

  test('cut after the children file, before the record: the same --place for a child outside, run again, is taken as done, since the stamped file already names its new place', () => {
    setup(options(install));
    const outside = join(dir, 'kids', 'c');
    withChild(install, outside, null);
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const own = join(copy, 'kids', 'c');
    mkdirSync(own, { recursive: true });
    const placed = { places: [{ from: outside, to: own }] };
    const recordAt = installPaths(rootOf(copy)).install;
    mkdirSync(`${recordAt}.tmp`);
    expect(() => setup(options(copy, placed))).toThrow(/install\.json\.tmp/);
    rmSync(`${recordAt}.tmp`, { recursive: true });
    expect(stampOf(copy)).toBe(copy);
    expect(childrenOf(copy)).toEqual([{ name: 'c', pid: null, bootId: null, dataDir: own }]);
    setup(options(copy, placed));
    expect(record(copy)!.workingDir).toBe(copy);
    expect(childrenOf(copy)).toEqual([{ name: 'c', pid: null, bootId: null, dataDir: own }]);
  });

  test('a --place known only by its place, a child\'s in the stamped children file, is refused where it holds a place the record or a Go back\'s list names, naming both, and nothing changes', () => {
    const state = join(install, 'state');
    mkdirSync(state);
    writeFileSync(join(state, 'settings.json'), '{}');
    const old = join(install, 'old');
    mkdirSync(old);
    setup(options(install, { extraState: [join(state, 'settings.json')] }));
    updated(install, [old]);
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const child = join(copy, 'data', 'child');
    mkdirSync(child);
    writeJsonAtomic(join(copy, 'data', 'fleet-children.json'),
      { v: 1, children: [{ name: 'c', pid: null, bootId: null, dataDir: child }], boundTo: copy } satisfies ChildrenFile);
    const kept = tree(copy);
    expect(refusal(() => setup(options(copy, { places: [{ from: state, to: child }], moveAside: true })))).toBe(
      `--place ${state} names no place this install's record names, and it holds ${join(state, 'settings.json')}, ` +
      `which this install's record names, so the binding would put that at ${join(child, 'settings.json')}. Setup has ` +
      'changed nothing. Run it again without that --place.');
    expect(refusal(() => setup(options(copy, { places: [{ from: old, to: child }], moveAside: true })))).toBe(
      `--place ${old} names no place this install's record names, and it holds ${old}, which a Go back's list in this ` +
      `install's root names, so the binding would put that at ${child}. Setup has changed nothing. Run it again ` +
      'without that --place.');
    expect(tree(copy)).toEqual(kept);
  });

  test('cut after the children file, before the record: a --place for state the record lists that is also a child\'s data directory, run again, still gives that state its place in the record', () => {
    const state = join(dir, 'state');
    mkdirSync(state);
    setup(options(install, { extraState: [state] }));
    writeJsonAtomic(join(install, 'data', 'fleet-children.json'),
      { v: 1, children: [{ name: 'c', pid: null, bootId: null, dataDir: state }] } satisfies ChildrenFile);
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const own = join(dir, 'own');
    mkdirSync(own);
    const placed = { places: [{ from: state, to: own }] };
    const recordAt = installPaths(rootOf(copy)).install;
    mkdirSync(`${recordAt}.tmp`);
    expect(() => setup(options(copy, placed))).toThrow(/install\.json\.tmp/);
    rmSync(`${recordAt}.tmp`, { recursive: true });
    expect(childrenOf(copy)).toEqual([{ name: 'c', pid: null, bootId: null, dataDir: own }]);
    setup(options(copy, placed));
    expect(record(copy)).toEqual({ v: 1, dataDir: join(copy, 'data'), extraState: [own], workingDir: copy });
  });

  test('a move aside, where the children file is already stamped for this directory, takes the areas a Go back kept in each child directory it names', () => {
    setup(options(install));
    const kid = join(install, 'data', 'kids', 'c');
    withChild(install, kid, null);
    updated(install);
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const copiedKid = join(copy, 'data', 'kids', 'c');
    const held = join(copiedKid, '.connectome-update', 'set-aside', 'm2');
    mkdirSync(held, { recursive: true });
    writeJsonAtomic(join(copy, 'data', 'fleet-children.json'),
      { v: 1, children: [{ name: 'c', pid: null, bootId: null, dataDir: copiedKid }], boundTo: copy } satisfies ChildrenFile);
    setup(options(copy, { moveAside: true }));
    expect(record(copy)!.workingDir).toBe(copy);
    expect(existsSync(held)).toBe(false);
    expect(readdirSync(join(copiedKid, '.connectome-update', 'moved-aside'))).toHaveLength(1);
  });

  test('a stamp a finished binding left, which names the directory the record is bound to, doesn\'t stop the next move from binding the file', () => {
    setup(options(install));
    withChild(install, join(install, 'data', 'kids', 'c'), null);
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    setup(options(copy));
    expect(stampOf(copy)).toBe(copy);
    const moved = join(dir, 'moved');
    renameSync(copy, moved);
    setup(options(moved));
    expect(childrenOf(moved)).toEqual([{ name: 'c', pid: null, bootId: null, dataDir: join(moved, 'data', 'kids', 'c') }]);
    expect(stampOf(moved)).toBe(moved);
  });

  test('a move that keeps each child where it is stamps the children file for its new directory, so the next move binds it', () => {
    setup(options(install));
    const outside = join(dir, 'kids', 'c');
    withChild(install, outside, null);
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    const own = join(dir, 'own', 'c');
    mkdirSync(own, { recursive: true });
    setup(options(copy, { places: [{ from: outside, to: own }] }));
    expect(stampOf(copy)).toBe(copy);
    const moved = join(dir, 'moved');
    renameSync(copy, moved);
    setup(options(moved, { places: [{ from: own, to: own }] }));
    expect(stampOf(moved)).toBe(moved);
    const again = join(dir, 'again');
    renameSync(moved, again);
    setup(options(again, { places: [{ from: own, to: own }] }));
    expect(record(again)!.workingDir).toBe(again);
    expect(childrenOf(again)).toEqual([{ name: 'c', pid: null, bootId: null, dataDir: own }]);
  });

  const boundElsewhere = (at: string, to: string) => `The fleet's children file, ${join(at, 'data', 'fleet-children.json')}, ` +
    `is bound to ${to} by a setup run there, and this install's record doesn't say it was bound there: that run was ` +
    'cut off before it wrote the record, or the record was written again without its directory after that run, by ' +
    'the setup of a release from before this one after a Go back, or by hand. ' +
    `The install is in ${at} now, so the places that file names are ${to}'s. Setup has changed ` +
    `nothing. Move the install back to ${to}, run setup there, which binds it there again, and then move it.`;

  test('a stamp naming another spelling of the directory the record is bound to, through a link, is a finished binding\'s, so a copy binds the file', () => {
    setup(options(install));
    withChild(install, join(install, 'data', 'kids', 'c'), null);
    const first = join(dir, 'first');
    copyOf(install, first);
    setup(options(first));
    const spelling = join(dir, 'spelling');
    symlinkSync(first, spelling);
    writeJsonAtomic(installPaths(rootOf(first)).install,
      { v: 1, dataDir: join(spelling, 'data'), extraState: [], workingDir: spelling });
    const second = join(dir, 'second');
    copyOf(first, second);
    const kid = join(first, 'data', 'kids', 'c');
    setup(options(second, { places: [{ from: kid, to: join(second, 'data', 'kids', 'c') }] }));
    expect(childrenOf(second)).toEqual([{ name: 'c', pid: null, bootId: null, dataDir: join(second, 'data', 'kids', 'c') }]);
    expect(stampOf(second)).toBe(second);
  });

  test('cut after the children file, before the record, and then moved back where its record is bound: setup refuses the file stamped for the other directory, saying to move the install back there, and nothing changes', () => {
    setup(options(install));
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    const children = join(install, 'data', 'fleet-children.json');
    writeJsonAtomic(children, { v: 1, children: [], boundTo: elsewhere } satisfies ChildrenFile);
    const kept = tree(install);
    const why = refusal(() => setup(options(install)));
    expect(why).toStartWith(`The fleet's children file, ${children}, is bound to ${elsewhere} by a setup run there`);
    expect(why).toContain(`Move the install back to ${elsewhere}, run setup there`);
    expect(tree(install)).toEqual(kept);
  });

  test('setup on an install bound where it is goes on past a children file it can\'t read, which it has no use for', () => {
    setup(options(install));
    writeFileSync(join(install, 'data', 'fleet-children.json'), '{ not json');
    setup(options(install));
    expect(record(install)!.workingDir).toBe(install);
  });

  test('a binding cut off after the children file, and the install then moved again, is refused as bound elsewhere, saying to bind it there again, and nothing changes', () => {
    setup(options(install));
    withChild(install, join(install, 'data', 'kids', 'c'), null);
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    cutBeforeRecord(copy)();
    const moved = join(dir, 'moved');
    renameSync(copy, moved);
    const kept = tree(moved);
    expect(refusal(() => setup(options(moved)))).toBe(boundElsewhere(moved, copy));
    expect(tree(moved)).toEqual(kept);
  });

  test('a stamp a finished binding left, once an older release\'s setup has written the record without its directory, is refused the same way when the install moves, and setup run back there binds it again', () => {
    setup(options(install));
    withChild(install, join(install, 'data', 'kids', 'c'), null);
    const copy = join(dir, 'copy');
    copyOf(install, copy);
    setup(options(copy));
    writeJsonAtomic(installPaths(rootOf(copy)).install, { v: 1, dataDir: join(copy, 'data'), extraState: [] });
    const moved = join(dir, 'moved');
    renameSync(copy, moved);
    const kept = tree(moved);
    const places = [{ from: join(copy, 'data'), to: join(moved, 'data') }];
    expect(refusal(() => setup(options(moved, { places })))).toBe(boundElsewhere(moved, copy));
    expect(tree(moved)).toEqual(kept);
    renameSync(moved, copy);
    setup(options(copy));
    expect(record(copy)!.workingDir).toBe(copy);
  });
});
