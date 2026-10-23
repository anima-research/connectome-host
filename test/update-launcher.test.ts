/**
 * The launcher (src/update/launcher.ts): what a start of an install decides
 * before its host runs. Each test builds an install on disk (a root with two
 * releases, the data directory, the MCPL settings file in the working
 * directory) and drives decide() with the machine's parts stood in, then
 * reads what the start left: which release it starts and whether on trial,
 * the data, the copy, what's kept aside, the journal and the mark.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  rmdirSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ContractError, ITEM_UPDATE_DIR, appendJournal, childrenFilePath, copyLabelPath, goBackListPath, installPaths,
  itemSetAsideDir, lastCopy,
  moveCurrent, readJournal, readRecord, setAsideDir, writeJsonAtomic, type CopyLabel, type InstallRecord, type Mark,
} from '../src/update/contract.js';
import {
  CHILDREN_WAIT_MS, HOST_ENTRY, LAUNCHER, dataItems, decide, itemStagingDir, linuxMountPoints, machineMountPoints,
  machineOps, macMountPoints, type LauncherOps,
} from '../src/update/launcher.js';
import { copyTree, removeTree, spaceTaken } from '../src/update/data-swap.js';

let dir: string;
let root: string;
let data: string;
let work: string;
let settings: string;
let alive: Set<number>;
/** The process groups with a member, by the pid that leads each. */
let groups: Set<number>;
let free: number;
let reports: string[];
let mounts: string[] | null;
let boot: string;
/** The stand-in clock, which only a wait moves. */
let clock: number;
let slept: number;

const ops = (): LauncherOps => ({
  now: () => new Date(clock),
  report: (line) => { reports.push(line); },
  dataDir: () => data,
  cwd: () => work,
  bootId: () => boot,
  // kill(0) and kill(-n) answer for a group of this process's own, so a pid
  // of 0 or less, or one that isn't a whole number, reads as alive.
  pidAlive: (pid) => !Number.isInteger(pid) || pid <= 0 || alive.has(pid),
  groupAlive: (pid) => !Number.isInteger(pid) || pid <= 0 || groups.has(pid),
  importModule: (path) => import(path),
  freeBytes: () => free,
  mountPoints: () => mounts,
  sleep: (ms) => { clock += ms; slept += ms; },
});

/** A release as an npm install of the host would leave it, as far as the
 *  launcher looks: its host's entry and its launcher. */
function release(version: string, launcher = 'export async function launch() {}\n'): void {
  const r = join(root, 'releases', version);
  mkdirSync(join(r, 'node_modules', '@animalabs', 'connectome-host', 'src', 'update'), { recursive: true });
  writeFileSync(join(r, HOST_ENTRY), '// host\n');
  writeFileSync(join(r, LAUNCHER), launcher);
}

function mark(fields: Partial<Mark> & Pick<Mark, 'to' | 'why'>): Mark {
  const m: Mark = { v: 1, id: 'm1', at: '2026-10-20T00:00:00Z', ...fields };
  writeJsonAtomic(installPaths(root).mark, m);
  return m;
}

const steps = () => readJournal(root).map((l) => `${l.step} ${l.outcome}${l.mark ? ` ${l.mark}` : ''}`);
const read = (path: string) => readFileSync(path, 'utf-8');
const store = () => read(join(data, 'sessions', 'store.txt'));

/** The children file, as the fleet writes it, listing one child. */
function child(name: string, path: string, pid: number | null = null, bootId: string | null = null): void {
  writeJsonAtomic(childrenFilePath(data), { v: 1, children: [{ name, pid, bootId, dataDir: path }] });
}

/** Stand in a read-only filesystem for `paths`: access with W_OK answers EROFS. */
function readOnlyFilesystem(paths: string[]): { mockRestore(): void } {
  const realAccess = fs.accessSync;
  return spyOn(fs, 'accessSync').mockImplementation(((path: fs.PathLike, mode?: number) => {
    if (paths.includes(String(path)) && mode !== undefined && (mode & fs.constants.W_OK) !== 0) {
      throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
    }
    return realAccess(path, mode);
  }) as typeof fs.accessSync);
}

/** Record the path each fsync in `body` went to, in order. */
async function syncedDuring(body: () => Promise<unknown>, seen?: (path: string) => void): Promise<string[]> {
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
    seen?.(paths.get(fd) ?? `fd ${fd}`);
    realFsync(fd);
  }) as typeof fs.fsyncSync);
  try {
    await body();
  } finally {
    opens.mockRestore();
    syncs.mockRestore();
  }
  return synced;
}

beforeEach(() => {
  clock = Date.parse('2026-10-20T00:00:00Z');
  slept = 0;
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'update-launcher-')));
  root = join(dir, 'root');
  data = join(dir, 'data');
  work = join(dir, 'work');
  settings = join(work, 'mcpl-servers.json');
  mkdirSync(root);
  mkdirSync(work);
  mkdirSync(join(data, 'sessions'), { recursive: true });
  writeFileSync(join(data, 'sessions', 'store.txt'), 'A wrote this');
  writeFileSync(settings, '{"a":1}');
  release('0.10.2');
  release('0.11.0');
  moveCurrent(root, '0.10.2');
  writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: data, extraState: [] } satisfies InstallRecord);
  alive = new Set();
  groups = new Set();
  free = 2 ** 40;
  reports = [];
  mounts = [];
  boot = 'boot-1';
});
afterEach(() => {
  // A test may leave a file unreadable or a directory read-only, which removeTree removes too.
  removeTree(dir);
});

describe('a start with nothing asked', () => {
  test('starts the release current names, holding the lock', async () => {
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(readRecord<{ pid: number }>(installPaths(root).lock, 'lock')!.pid).toBe(process.pid);
    expect(readJournal(root)).toEqual([]);
  });

  test('refuses while another live process holds the lock, and takes over one whose process has ended', async () => {
    writeJsonAtomic(installPaths(root).lock, { v: 1, pid: 4242, bootId: 'boot-1', at: 'x' });
    alive.add(4242);
    await expect(decide(root, ops())).rejects.toThrow(/process 4242/);
    alive.delete(4242);
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(readRecord<{ pid: number }>(installPaths(root).lock, 'lock')!.pid).toBe(process.pid);
  });

  test('takes over a lock from an earlier boot whose process number is running again', async () => {
    writeJsonAtomic(installPaths(root).lock, { v: 1, pid: 4242, bootId: 'boot-0', at: 'x' });
    alive.add(4242);
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(readRecord<{ pid: number }>(installPaths(root).lock, 'lock')!.pid).toBe(process.pid);
  });

  test("takes a lock that holds this process's own number, from an earlier process, with this start's record", async () => {
    alive.add(process.pid);
    for (const bootId of ['boot-0', 'boot-1']) {
      writeJsonAtomic(installPaths(root).lock, { v: 1, pid: process.pid, bootId, at: 'x' });
      await decide(root, ops());
      expect(readRecord<{ pid: number; bootId: string; at: string }>(installPaths(root).lock, 'lock')).toMatchObject(
        { pid: process.pid, bootId: 'boot-1', at: '2026-10-20T00:00:00.000Z' });
    }
  });

  test('refuses a data directory other than the one the install serves', async () => {
    mkdirSync(join(dir, 'other'));
    const o = { ...ops(), dataDir: () => join(dir, 'other') };
    await expect(decide(root, o)).rejects.toThrow(ContractError);
  });

  test("refuses a current that's a directory holding a release, copied in place of the link, saying to run setup again", async () => {
    rmSync(installPaths(root).current);
    fs.cpSync(join(root, 'releases', '0.10.2'), installPaths(root).current, { recursive: true });
    const thrown = await decide(root, ops()).catch((error) => error);
    expect(thrown).toBeInstanceOf(ContractError);
    expect(thrown.message).toMatch(/current is there and isn't a link\. Run setup again, which says how to put it right/);
  });

  test("a current that can't be read for another reason gives that error as it is", async () => {
    const real = fs.readlinkSync;
    const spy = spyOn(fs, 'readlinkSync').mockImplementation(((path: fs.PathLike, options?: unknown) => {
      if (String(path) === installPaths(root).current) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      return real(path, options as never);
    }) as typeof fs.readlinkSync);
    try {
      const thrown = await decide(root, ops()).catch((error) => error);
      expect(thrown).not.toBeInstanceOf(ContractError);
      expect(thrown.code).toBe('EIO');
    } finally {
      spy.mockRestore();
    }
  });

  for (const [name, record] of [
    ['no data directory', { v: 1, dataDir: 5, extraState: [] }],
    ['no list of extra state', { v: 1, dataDir: 'x', extraState: 5 }],
    ['a list of extra state that holds something else', { v: 1, dataDir: 'x', extraState: [5] }],
    ['the field an earlier draft named', { v: 1, dataDir: 'x', serverState: [] }],
  ] as const) {
    test(`refuses an install record with ${name}, saying to run setup again`, async () => {
      writeJsonAtomic(installPaths(root).install, record);
      await expect(decide(root, ops())).rejects.toThrow(/has no data directory or list of extra state this release can read\. Run setup again/);
    });
  }

  for (const [name, fields, says] of [
    ['an id that is no path segment', { id: 'a/b', to: '0.11.0', why: 'update' }, /has no id this release can use/],
    ['a release that is no path segment', { to: '../0.11.0', why: 'update' }, /names no release this release can use/],
    ['a request it does not know', { to: '0.11.0', why: 'sideways' as Mark['why'] }, /asks for "sideways", which this release doesn't know/],
    ['no request', { to: '0.11.0', why: undefined as unknown as Mark['why'] }, /names no request, which this release doesn't know/],
    ['a long request', { to: '0.11.0', why: 'x'.repeat(100) as Mark['why'] }, new RegExp(`asks for "${'x'.repeat(79)}… \\(cut\\), which`)],
    ['a long request cut by code points', { to: '0.11.0', why: ('x'.repeat(78) + '😀'.repeat(5)) as Mark['why'] }, new RegExp(`asks for "${'x'.repeat(78)}😀… \\(cut\\), which`, 'u')],
    ['a request of fewer code points than its cut, in more UTF-16 units', { to: '0.11.0', why: '😀'.repeat(50) as Mark['why'] }, new RegExp(`asks for "${'😀'.repeat(50)}", which`, 'u')],
  ] as const) {
    test(`a mark with ${name}: starts the release current names, says why, and keeps the mark`, async () => {
      mark(fields);
      const before = read(installPaths(root).mark);
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
      expect(reports.some((line) => says.test(line))).toBe(true);
      expect(read(installPaths(root).mark)).toBe(before);
      expect(readJournal(root)).toEqual([]);
    });
  }
});

describe('what a switch copies', () => {
  test("the data directory, the settings files, each child's directory and the extra state recorded, each once", () => {
    writeFileSync(join(work, 'mcpl-servers.agent.json'), '{"agent":1}');
    writeFileSync(join(dir, 'state.json'), 'server state');
    writeFileSync(join(data, 'inner.json'), 'inside the data');
    symlinkSync(data, join(dir, 'data-link'));
    mkdirSync(join(dir, 'kid'));
    child('kid', join(dir, 'kid'));
    const record: InstallRecord = {
      v: 1, dataDir: data,
      extraState: [join(dir, 'state.json'), join(data, 'inner.json'), join(dir, 'data-link'), join(dir, 'gone.json'), join(data, 'missing.json')],
    };
    expect(dataItems(root, record, ops())).toEqual({
      present: [data, join(dir, 'kid'), join(dir, 'state.json'), settings, join(work, 'mcpl-servers.agent.json')].sort(),
      absent: [join(dir, 'gone.json')],
    });
  });

  test("a child's data directory written relative to the working directory is the one there", () => {
    mkdirSync(join(work, 'kids', 'kid'), { recursive: true });
    child('kid', join('kids', 'kid'));
    expect(dataItems(root, { v: 1, dataDir: data, extraState: [] }, ops()).present).toContain(join(work, 'kids', 'kid'));
  });

  test("places that aren't there, named twice or one inside another, are one place, the outermost", () => {
    writeJsonAtomic(childrenFilePath(data), { v: 1, children: [
      { name: 'a', pid: null, bootId: null, dataDir: join(dir, 'kids') },
      { name: 'b', pid: null, bootId: null, dataDir: join(dir, 'kids', 'b') },
      { name: 'c', pid: null, bootId: null, dataDir: join(dir, 'kids') },
    ] });
    expect(dataItems(root, { v: 1, dataDir: data, extraState: [] }, ops()).absent)
      .toEqual([join(dir, 'kids'), join(work, 'mcpl-servers.agent.json')]);
  });

  test('refuses a root inside the data, and data inside the root', () => {
    const record: InstallRecord = { v: 1, dataDir: data, extraState: [] };
    expect(() => dataItems(join(data, 'root'), record, ops())).toThrow(/one inside the other/);
    writeFileSync(join(root, 'state.json'), 'x');
    expect(() => dataItems(root, { ...record, extraState: [join(root, 'state.json')] }, ops())).toThrow(/one inside the other/);
  });

  test("the machine's own list of mounts on Linux holds /, and a platform with no list has none", () => {
    if (process.platform === 'linux') expect(machineMountPoints('linux')).toContain('/');
    expect(machineMountPoints('win32')).toEqual([]);
  });

  test("the machine tells a process from the group it leads: the group has a member after its leader has ended", async () => {
    const group = Bun.spawn(['sh', '-c', 'sleep 300 & exit 0'], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
    try {
      await group.exited;
      // The leader has ended and been reaped; its sleep runs on in its group.
      expect(machineOps().pidAlive(group.pid)).toBe(false);
      expect(machineOps().groupAlive(group.pid)).toBe(true);
      process.kill(-group.pid, 'SIGKILL');
      for (let tries = 0; tries < 500 && machineOps().groupAlive(group.pid); tries++) Bun.sleepSync(10);
      expect(machineOps().groupAlive(group.pid)).toBe(false);
    } finally {
      try { process.kill(-group.pid, 'SIGKILL'); } catch { /* it has ended */ }
    }
  });

  test("a child whose process has ended holds a fallback while its group has a member; the lock goes by its holder alone", async () => {
    mark({ to: '0.11.0', why: 'update' });
    await decide(root, ops());
    child("kid's job", join(dir, 'kid'), 778, boot);
    groups.add(778);
    let waits = 0;
    const o: LauncherOps = { ...ops(), sleep: (ms) => { clock += ms; if (++waits === 2) groups.delete(778); } };
    expect(await decide(root, o)).toEqual({ release: '0.10.2', trial: false });
    expect(waits).toBe(2);
    // A lock whose holder has ended is taken, though the group it led runs on.
    writeJsonAtomic(installPaths(root).lock, { v: 1, pid: 4242, bootId: boot, at: 'x' });
    groups.add(4242);
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
  });

  test("the machine's list of mounts is null when it can't be read: on Linux, mountinfo; on macOS, mount", () => {
    const readFails = spyOn(fs, 'readFileSync').mockImplementation((() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }) as typeof fs.readFileSync);
    try {
      expect(machineMountPoints('linux')).toBeNull();
    } finally {
      readFails.mockRestore();
    }
    const mountFails = spyOn(Bun, 'spawnSync').mockImplementation((() => ({ exitCode: 1, stdout: Buffer.from('') })) as unknown as typeof Bun.spawnSync);
    try {
      expect(machineMountPoints('darwin')).toBeNull();
    } finally {
      mountFails.mockRestore();
    }
  });

  test("reads Linux's and macOS's lists of mounts", () => {
    expect(linuxMountPoints('36 35 98:0 / /data/vol\\040one rw,noatime master:1 - ext4 /dev/root rw\n37 35 0:5 / /proc rw - proc proc rw\n'))
      .toEqual(['/data/vol one', '/proc']);
    expect(macMountPoints('/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n' +
      '/dev/disk4s1 on /Volumes/Data Two (apfs, local, nodev, nosuid, journaled)\n'))
      .toEqual(['/', '/Volumes/Data Two']);
  });
});

describe('a switch', () => {
  test('takes a copy of the data, kept private, then starts the new release on trial', async () => {
    mark({ to: '0.11.0', why: 'update' });
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: true });
    expect(steps()).toEqual(['copy ok m1', 'trial-start ok m1']);
    const label = lastCopy(root)!;
    expect(label).toMatchObject({ from: '0.10.2', mark: 'm1' });
    expect(label.items.map((i) => i.path)).toEqual([data, settings]);
    expect(label.absent!.map((i) => i.path)).toEqual([join(work, 'mcpl-servers.agent.json')]);
    expect(read(join(installPaths(root).copy, label.items[0]!.name, 'sessions', 'store.txt'))).toBe('A wrote this');
    expect(statSync(installPaths(root).copy).mode & 0o777).toBe(0o700);
  });

  test("a trial that ends before its commit: the next start puts the old data back, keeps the trial's aside, and the mark is spent", async () => {
    mark({ to: '0.11.0', why: 'update' });
    await decide(root, ops());
    writeFileSync(join(data, 'sessions', 'store.txt'), 'B wrote this');
    writeFileSync(join(data, 'new.txt'), 'only B');
    writeFileSync(settings, '{"b":2}');
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(store()).toBe('A wrote this');
    expect(existsSync(join(data, 'new.txt'))).toBe(false);
    expect(read(settings)).toBe('{"a":1}');
    expect(read(join(itemSetAsideDir(data, 'm1'), 'new.txt'))).toBe('only B');
    expect(read(join(setAsideDir(root, 'm1'), 'kept', '1-mcpl-servers.json'))).toBe('{"b":2}');
    expect(steps()).toEqual(['copy ok m1', 'trial-start ok m1', 'fallback ok m1']);
    expect(reports.at(-1)).toContain(`${ITEM_UPDATE_DIR}/set-aside/m1`);
    // The mark is spent: the next start starts the old release and drops it,
    // and what the trial left stays aside under the id a line names.
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(existsSync(installPaths(root).mark)).toBe(false);
    expect(read(join(itemSetAsideDir(data, 'm1'), 'new.txt'))).toBe('only B');
    expect(read(join(setAsideDir(root, 'm1'), 'kept', '1-mcpl-servers.json'))).toBe('{"b":2}');
  });

  test("a trial's fallback keeps aside what the trial made where nothing was: a file goes, and a directory is left empty", async () => {
    const kid = join(dir, 'kid');
    child('kid', kid);
    mark({ to: '0.11.0', why: 'update' });
    await decide(root, ops());
    const label = lastCopy(root)!;
    expect(label.absent!.map((i) => i.path)).toEqual([kid, join(work, 'mcpl-servers.agent.json')]);
    mkdirSync(kid);
    writeFileSync(join(kid, 'store.txt'), 'the trial made this');
    writeFileSync(join(work, 'mcpl-servers.agent.json'), '{"trial":1}');
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(readdirSync(kid)).toEqual([ITEM_UPDATE_DIR]);
    expect(read(join(itemSetAsideDir(kid, 'm1'), 'store.txt'))).toBe('the trial made this');
    expect(existsSync(join(work, 'mcpl-servers.agent.json'))).toBe(false);
    const overlay = label.absent!.find((i) => i.path.endsWith('agent.json'))!;
    expect(read(join(setAsideDir(root, 'm1'), 'kept', overlay.name))).toBe('{"trial":1}');
  });

  test('a trial that commits: the next start starts the new release, and the mark is spent', async () => {
    mark({ to: '0.11.0', why: 'update' });
    await decide(root, ops());
    moveCurrent(root, '0.11.0');
    appendJournal(root, { at: 'x', step: 'commit', from: '0.10.2', to: '0.11.0', outcome: 'ok' });
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(existsSync(installPaths(root).mark)).toBe(false);
  });

  const refusals: Array<{ name: string; step: string; says: RegExp; arrange(): void }> = [
    { name: 'a fleet child still running', step: 'children-check', says: /fleet children are still running: kid/, arrange: () => {
      child('kid', join(dir, 'kid'), 777, 'boot-1');
      alive.add(777);
    } },
    { name: 'a release not installed', step: 'trial-start', says: /0\.12\.0 isn't installed here/, arrange: () => {
      mark({ to: '0.12.0', why: 'update' });
    } },
    { name: 'a release whose launcher does not load', step: 'trial-start', says: /launcher doesn't load/, arrange: () => {
      release('0.12.0', 'export async function launch( {\n');
      mark({ to: '0.12.0', why: 'update' });
    } },
    { name: 'a release whose launcher has no launch function', step: 'trial-start', says: /has no launch function/, arrange: () => {
      release('0.12.1', 'export const launcher = 1;\n');
      mark({ to: '0.12.1', why: 'update' });
    } },
    { name: 'too little room for a copy and its restore', step: 'copy', says: /GiB free/, arrange: () => { free = 1024; } },
    { name: 'a mount inside the data directory', step: 'copy', says: /sessions is a mount inside \/\S*data\. /, arrange: () => {
      mounts = ['/', data, join(data, 'sessions')];
    } },
  ];
  for (const r of refusals) {
    test(`refused for ${r.name}: the data, the copy and the mark stay, and the release current names starts`, async () => {
      mark({ to: '0.11.0', why: 'update' });
      r.arrange();
      const before = read(installPaths(root).mark);
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
      expect(steps()).toEqual([`${r.step} refused ${JSON.parse(before).id}`]);
      expect(read(installPaths(root).mark)).toBe(before);
      expect(store()).toBe('A wrote this');
      expect(existsSync(installPaths(root).copy)).toBe(false);
      const said = reports.find((l) => l.includes("didn't go ahead"))!;
      expect(said).toMatch(r.says);
      expect(said).toContain(`removing ${installPaths(root).mark} drops it`);
      expect(said).not.toContain('..');
    });
  }

  test('a data directory that is itself a mount is served', async () => {
    mounts = ['/', data];
    mark({ to: '0.11.0', why: 'update' });
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: true });
  });

  test('a fallback that meets a place of another kind than the copy holds stops, naming it, and starts nothing', async () => {
    mark({ to: '0.11.0', why: 'update' });
    await decide(root, ops());
    rmSync(settings);
    mkdirSync(settings);
    await expect(decide(root, ops())).rejects.toThrow(/mcpl-servers\.json is a directory, and what's restored there is a file/);
    expect(steps().at(-1)).toBe('fallback failed m1');
  });

  test("a fallback whose copy is another switch's stops, and starts nothing", async () => {
    mark({ to: '0.11.0', why: 'update' });
    await decide(root, ops());
    writeJsonAtomic(copyLabelPath(installPaths(root).copy), { ...lastCopy(root)!, mark: 'm0' } satisfies CopyLabel);
    await expect(decide(root, ops())).rejects.toThrow(/holds 0\.10\.2's data for mark m0, not 0\.10\.2's for this switch's mark m1/);
    expect(steps().at(-1)).toBe('fallback failed m1');
    expect(store()).toBe('A wrote this');
  });

  test('refused when a check fails: the data, the copy and the mark stay, and the release current names starts', async () => {
    mark({ to: '0.11.0', why: 'update' });
    const before = read(installPaths(root).mark);
    const o: LauncherOps = { ...ops(), freeBytes: () => { throw new Error('statfs failed'); } };
    expect(await decide(root, o)).toEqual({ release: '0.10.2', trial: false });
    expect(steps()).toEqual(['copy failed m1']);
    expect(read(installPaths(root).mark)).toBe(before);
    expect(existsSync(installPaths(root).copy)).toBe(false);
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain('checking it failed: statfs failed');
  });

  test("refused when a fleet child's data directory is inside the install's root, saying so", async () => {
    child('kid', join(root, 'kid'));
    mark({ to: '0.11.0', why: 'update' });
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(steps()).toEqual(['copy refused m1']);
    expect(reports.find((l) => l.includes("didn't go ahead"))).toMatch(/are one inside the other/);
  });

  test("refused when the data directory isn't there, with nothing copied", async () => {
    rmSync(data, { recursive: true });
    mark({ to: '0.11.0', why: 'update' });
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(steps()).toEqual(['copy refused m1']);
    expect(existsSync(installPaths(root).copy)).toBe(false);
  });

  test("copies each fleet child's data directory with the host's, from the fleet's children file", async () => {
    mkdirSync(join(dir, 'kid'));
    writeFileSync(join(dir, 'kid', 'store.txt'), 'the child wrote this');
    child('kid', join(dir, 'kid'));
    mark({ to: '0.11.0', why: 'update' });
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: true });
    const kid = lastCopy(root)!.items.find((i) => i.path === join(dir, 'kid'))!;
    expect(read(join(installPaths(root).copy, kid.name, 'store.txt'))).toBe('the child wrote this');
  });

  test("a children file's entries that aren't children, which the fleet keeps as they are, are passed over", async () => {
    writeJsonAtomic(childrenFilePath(data), {
      v: 1, children: [null, 7, { name: 'x' }, { name: 'kid', pid: null, bootId: null, dataDir: join(dir, 'kid') }],
    });
    mark({ to: '0.11.0', why: 'update' });
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: true });
    expect(lastCopy(root)!.absent!.map((i) => i.path)).toEqual([join(dir, 'kid'), join(work, 'mcpl-servers.agent.json')]);
  });

  test("a live process counts only under an entry with a child's whole shape, and a positive pid", async () => {
    alive.add(778);
    const kid = join(dir, 'kid');
    const whole = { name: 'kid', pid: 778, bootId: boot, dataDir: kid };
    for (const entry of [{ ...whole, name: 7 }, { ...whole, dataDir: 7 }, { ...whole, pid: '778' }, { ...whole, bootId: 7 },
      { ...whole, pid: 0 }, { ...whole, pid: -778 }, { ...whole, pid: 7.5 }]) {
      writeJsonAtomic(childrenFilePath(data), { v: 1, children: [entry] });
      reports = [];
      mark({ id: 'm1', to: '0.11.0', why: 'update' });
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: true });
      // Undo the switch, for the next entry.
      moveCurrent(root, '0.10.2');
      rmSync(installPaths(root).journal);
    }
    writeJsonAtomic(childrenFilePath(data), { v: 1, children: [whole] });
    mark({ id: 'm1', to: '0.11.0', why: 'update' });
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain('kid (pid 778). A fleet child writes in its data directory');
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain('To let it go ahead, stop each, ending its process group');
  });

  test("the wait lasts two minutes of sleeping, whatever the clock does meanwhile", async () => {
    mark({ to: '0.11.0', why: 'update' });
    await decide(root, ops());
    child('kid', join(dir, 'kid'), 778, boot);
    alive.add(778);
    const jumping: LauncherOps = { ...ops(), sleep: (ms) => { slept += ms; clock += 3_600_000; } };
    await expect(decide(root, jumping)).rejects.toThrow(/fleet children are still running: kid \(pid 778\)/);
    expect(slept).toBe(120_000);
  });

  test("a children file the system can't read is the reason to wait, and then to stop, saying how to clear it", async () => {
    mark({ to: '0.11.0', why: 'update' });
    await decide(root, ops());
    writeFileSync(childrenFilePath(data), '{"v":1,"children":[]}');
    chmodSync(childrenFilePath(data), 0o000);
    try {
      await expect(decide(root, ops())).rejects.toThrow(/can't be read: EACCES.*That file says which fleet children may still be writing.*make it readable to this user, or, with nothing it lists, and no process in a group one led, still running, remove it/);
      expect(slept).toBe(120_000);
    } finally {
      chmodSync(childrenFilePath(data), 0o644);
    }
  });

  test("a child of which only its process group remains is named so, with how to end the group", async () => {
    mark({ to: '0.11.0', why: 'update' });
    await decide(root, ops());
    child('kid', join(dir, 'kid'), 778, boot);
    groups.add(778);
    await expect(decide(root, ops())).rejects.toThrow(/kid \(pid 778 has ended, and its process group 778 still has a member\).*kill -- -PID/);
  });

  test("a children file that can't be read: a switch is refused, saying so, and a trial's fallback starts nothing until it can be", async () => {
    writeFileSync(childrenFilePath(data), 'not json');
    mark({ to: '0.11.0', why: 'update' });
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(steps()).toEqual(['children-check refused m1']);
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain("isn't JSON");
    rmSync(childrenFilePath(data));
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: true });
    writeFileSync(childrenFilePath(data), 'not json');
    await expect(decide(root, ops())).rejects.toThrow(/ended before its commit, and it can't go on: The fleet's children file at .* isn't JSON.*repair it, or, with nothing it lists/);
    expect(steps().at(-1)).toBe('trial-start ok m1');
  });

  test('a child of another boot is not running, whatever its process number', async () => {
    child('kid', join(dir, 'kid'), 777, 'boot-0');
    alive.add(777);
    mark({ to: '0.11.0', why: 'update' });
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: true });
  });

  test("refused when the machine's list of mounts can't be read, saying so", async () => {
    mounts = null;
    mark({ to: '0.11.0', why: 'update' });
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(steps()).toEqual(['copy refused m1']);
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain("list of mounts couldn't be read");
  });

  test("a fallback waits while a listed process under a data directory runs, and goes on once it ends", async () => {
    const kid = join(dir, 'kid');
    mkdirSync(kid);
    mark({ to: '0.11.0', why: 'update' });
    await decide(root, ops());
    writeFileSync(join(data, 'sessions', 'store.txt'), 'B wrote this');
    // A trial host that died leaves a process it listed there.
    child("kid's job", kid, 778, boot);
    alive.add(778);
    let waits = 0;
    const o: LauncherOps = { ...ops(), sleep: (ms) => {
      clock += ms;
      // The data stays as the trial left it while that process runs.
      expect(store()).toBe('B wrote this');
      if (++waits === 8) alive.delete(778);
    } };
    expect(await decide(root, o)).toEqual({ release: '0.10.2', trial: false });
    expect(waits).toBe(8);
    expect(store()).toBe('A wrote this');
  });

  test('a fallback whose listed process outlives the wait stops, naming it, and the next start goes on once it has ended', async () => {
    mark({ to: '0.11.0', why: 'update' });
    await decide(root, ops());
    child('kid', join(dir, 'kid'), 778, boot);
    alive.add(778);
    await expect(decide(root, ops())).rejects.toThrow(/ended before its commit, and it can't go on: fleet children are still running: kid \(pid 778\)\. .*stop each, .*The next start goes on/);
    expect(slept).toBe(CHILDREN_WAIT_MS);
    expect(CHILDREN_WAIT_MS).toBe(120_000);
    expect(steps().at(-1)).toBe('trial-start ok m1');
    alive.delete(778);
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
  });

  test("a fallback restores a directory the copy holds read-only inside a data directory, and makes each staging area the update's own before syncing it", async () => {
    const ro = join(data, 'ro');
    mkdirSync(ro);
    writeFileSync(join(ro, 'f'), 'A');
    chmodSync(ro, 0o555);
    const kid = join(dir, 'kid');
    mkdirSync(kid);
    writeFileSync(join(kid, 'g'), 'A');
    child('kid', kid);
    mark({ to: '0.11.0', why: 'update' });
    await decide(root, ops());
    // The trial makes it writable and writes in both.
    chmodSync(ro, 0o755);
    writeFileSync(join(ro, 'f'), 'B');
    writeFileSync(join(kid, 'g'), 'B');
    // The staging area's mode is set before it's synced.
    const staged = `${itemStagingDir(kid, 'm1')}.tmp`;
    const events: string[] = [];
    const paths = new Map<number, string>();
    const realOpen = fs.openSync;
    const realFsync = fs.fsyncSync;
    const realChmod = fs.chmodSync;
    const spies = [
      spyOn(fs, 'openSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
        const fd = (realOpen as (...args: unknown[]) => number)(path, ...rest);
        paths.set(fd, String(path));
        return fd;
      }) as typeof fs.openSync),
      spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
        if (paths.get(fd) === staged) events.push(`sync ${(fs.fstatSync(fd).mode & 0o777).toString(8)}`);
        realFsync(fd);
      }) as typeof fs.fsyncSync),
      spyOn(fs, 'chmodSync').mockImplementation(((path: fs.PathLike, mode: fs.Mode) => {
        if (String(path) === staged) events.push('mode');
        realChmod(path, mode);
      }) as typeof fs.chmodSync),
    ];
    try {
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
      expect(read(join(ro, 'f'))).toBe('A');
      expect(read(join(kid, 'g'))).toBe('A');
    } finally {
      for (const spy of spies) spy.mockRestore();
      for (const path of [ro, kid]) chmodSync(path, 0o755);
    }
    // At its last sync, before it's renamed into place, it's the update's alone.
    expect(events.filter((event) => event.startsWith('sync')).at(-1)).toBe('sync 700');
  });

  test("refused when a place can't be looked at, with the filesystem's error, rather than copied as absent", async () => {
    const shut = join(dir, 'shut');
    mkdirSync(join(shut, 'kid'), { recursive: true });
    child('kid', join(shut, 'kid'));
    chmodSync(shut, 0o000);
    try {
      mark({ to: '0.11.0', why: 'update' });
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
      expect(steps()).toEqual(['copy failed m1']);
      expect(reports.find((l) => l.includes("didn't go ahead"))).toMatch(/EACCES/);
    } finally {
      chmodSync(shut, 0o755);
    }
  });

  test("a fallback's replay that finds a place the trial made already taken away syncs its directory", async () => {
    mark({ to: '0.11.0', why: 'update' });
    await decide(root, ops());
    // As a cut leaves it: the trial's file taken away, the line not written.
    const agent = join(work, 'mcpl-servers.agent.json');
    expect(existsSync(agent)).toBe(false);
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
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    } finally {
      opens.mockRestore();
      syncs.mockRestore();
    }
    expect(synced).toContain(work);
  });

  test("a fallback passes over syncing a gone place's parent that it may neither open nor write", async () => {
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    writeJsonAtomic(installPaths(root).install,
      { v: 1, dataDir: data, extraState: [join(locked, 'state.json')] } satisfies InstallRecord);
    chmodSync(locked, 0o111);
    try {
      mark({ to: '0.11.0', why: 'update' });
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: true });
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test("a switch is refused while a data directory can't be written, since its fallback moves entries through an area inside it", async () => {
    chmodSync(data, 0o555);
    try {
      mark({ to: '0.11.0', why: 'update' });
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    } finally {
      chmodSync(data, 0o755);
    }
    expect(steps().at(-1)).toBe('copy refused m1');
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${data} can't be read, written and searched by this process (EACCES)`);
  });

  test("a switch is refused while a child's directory can't be written, or the data directory is on a read-only filesystem", async () => {
    const kid = join(dir, 'kid');
    mkdirSync(kid);
    child('kid', kid);
    chmodSync(kid, 0o555);
    try {
      mark({ to: '0.11.0', why: 'update' });
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    } finally {
      chmodSync(kid, 0o755);
    }
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${kid} can't be read, written and searched`);
    reports = [];
    const ro = readOnlyFilesystem([data]);
    try {
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    } finally {
      ro.mockRestore();
    }
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${data} is on a read-only filesystem, and an update changes what's in it`);
  });

  test("a switch is refused while a child's directory can be read and written but not searched", async () => {
    const kid = join(dir, 'kid');
    mkdirSync(kid);
    child('kid', kid);
    chmodSync(kid, 0o666);
    try {
      mark({ to: '0.11.0', why: 'update' });
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    } finally {
      chmodSync(kid, 0o755);
    }
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${kid} can't be read, written and searched by this process (EACCES)`);
  });

  test("a fallback that makes a directory its trial removed stops while it can't sync that directory's parent", async () => {
    const locked = join(dir, 'locked');
    const kid = join(locked, 'kid');
    mkdirSync(kid, { recursive: true });
    writeFileSync(join(kid, 'g'), 'A');
    child('kid', kid);
    mark({ to: '0.11.0', why: 'update' });
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: true });
    // The trial removed it, and the parent can't be opened now.
    rmSync(kid, { recursive: true });
    chmodSync(locked, 0o311);
    try {
      await expect(decide(root, ops())).rejects.toThrow(/EACCES/);
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(read(join(kid, 'g'))).toBe('A');
  });

  test("a restore of a directory that was there passes over syncing a parent it may not open, which it didn't change", async () => {
    const locked = join(dir, 'locked');
    const kid = join(locked, 'kid');
    mkdirSync(kid, { recursive: true });
    writeFileSync(join(kid, 'g'), 'A');
    child('kid', kid);
    chmodSync(locked, 0o311);
    try {
      mark({ to: '0.11.0', why: 'update' });
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: true });
      writeFileSync(join(kid, 'g'), 'B');
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
      expect(read(join(kid, 'g'))).toBe('A');
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test("a start syncs the journal before it reads it", async () => {
    mark({ to: '0.11.0', why: 'update' });
    await decide(root, ops());
    // This start falls back: the journal's sync comes before its read, and
    // before anything of the restore's.
    const journal = installPaths(root).journal;
    const events: string[] = [];
    const paths = new Map<number, string>();
    const realOpen = fs.openSync;
    const realFsync = fs.fsyncSync;
    const realRead = fs.readFileSync;
    const spies = [
      spyOn(fs, 'openSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
        const fd = (realOpen as (...args: unknown[]) => number)(path, ...rest);
        paths.set(fd, String(path));
        return fd;
      }) as typeof fs.openSync),
      spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
        events.push(`sync ${paths.get(fd)}`);
        realFsync(fd);
      }) as typeof fs.fsyncSync),
      spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (String(path) === journal) events.push(`read ${journal}`);
        return (realRead as (...args: unknown[]) => unknown)(path, ...rest);
      }) as typeof fs.readFileSync),
    ];
    try {
      await decide(root, ops());
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const synced = events.indexOf(`sync ${journal}`);
    expect(synced).toBeGreaterThan(-1);
    expect(synced).toBeLessThan(events.indexOf(`read ${journal}`));
    expect(synced).toBeLessThan(events.findIndex((event) => event.startsWith(`sync ${data}`)));
  });

  test("a mark the system won't read is reported, and the release current names starts", async () => {
    mark({ to: '0.11.0', why: 'update' });
    chmodSync(installPaths(root).mark, 0o000);
    try {
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    } finally {
      chmodSync(installPaths(root).mark, 0o644);
    }
    expect(reports.find((l) => l.includes("couldn't be read, or cleared once spent: EACCES"))).toContain('0.10.2 starts as it was');
  });

  test('a fallback that finds a mount inside a data directory stops, naming it, until the mount goes', async () => {
    mark({ to: '0.11.0', why: 'update' });
    await decide(root, ops());
    mounts = [join(data, 'sessions')];
    await expect(decide(root, ops())).rejects.toThrow(/sessions is a mount inside \/\S*data\. /);
    expect(steps().at(-1)).toBe('fallback failed m1');
    mounts = [];
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(store()).toBe('A wrote this');
  });

  test("refused when a settings file is a link to something that isn't there, naming it", async () => {
    rmSync(settings);
    symlinkSync(join(dir, 'nowhere.json'), settings);
    mark({ to: '0.11.0', why: 'update' });
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(steps()).toEqual(['copy refused m1']);
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${settings} is a link to something that isn't there`);
  });

  test('refused when recorded extra state is neither a file nor a directory', async () => {
    const fifo = join(dir, 'state.fifo');
    Bun.spawnSync(['mkfifo', fifo]);
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: data, extraState: [fifo] } satisfies InstallRecord);
    mark({ to: '0.11.0', why: 'update' });
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain('is neither a file nor a directory');
  });

  test("a settings file on a read-only filesystem needs no room for its writing in place", async () => {
    const need = 2 * spaceTaken(data) + 2 * spaceTaken(settings) + 256 * 2 ** 20;
    mark({ to: '0.11.0', why: 'update' });
    free = need;
    const ro = readOnlyFilesystem([settings]);
    try {
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: true });
    } finally {
      ro.mockRestore();
    }
  });

  test('refused one byte short of the room for the copy and its restore, summed on one filesystem, and goes ahead with it', async () => {
    // The copy and the staged restore of the data directory, and of the settings
    // file the copy, the kept content and the content written back in place.
    const need = 2 * spaceTaken(data) + 3 * spaceTaken(settings) + 256 * 2 ** 20;
    mark({ to: '0.11.0', why: 'update' });
    free = need - 1;
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(reports.find((l) => l.includes("didn't go ahead"))).toMatch(/needs .* GiB there, for a copy of the data and room to restore it/);
    free = need;
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: true });
  });

  test("a second switch replaces the first one's copy whole", async () => {
    await committedSwitch();
    release('0.12.0');
    mark({ id: 'm2', to: '0.12.0', why: 'update' });
    expect(await decide(root, ops())).toEqual({ release: '0.12.0', trial: true });
    const label = lastCopy(root)!;
    expect(label).toMatchObject({ from: '0.11.0', mark: 'm2' });
    expect(read(join(installPaths(root).copy, label.items[0]!.name, 'sessions', 'store.txt'))).toBe('B wrote this');
    expect(existsSync(installPaths(root).copyPrev)).toBe(false);
    expect(existsSync(installPaths(root).copyTmp)).toBe(false);
  });

  test('a second switch replaces a copy holding a directory its owner cannot write', async () => {
    mkdirSync(join(data, 'ro'));
    writeFileSync(join(data, 'ro', 'f'), 'x');
    chmodSync(join(data, 'ro'), 0o500);
    await committedSwitch();
    release('0.12.0');
    mark({ id: 'm2', to: '0.12.0', why: 'update' });
    expect(await decide(root, ops())).toEqual({ release: '0.12.0', trial: true });
    expect(lastCopy(root)).toMatchObject({ from: '0.11.0', mark: 'm2' });
    expect(existsSync(installPaths(root).copyPrev)).toBe(false);
  });

  test("a second switch whose last copy can't be removed goes ahead, and a later start that can removes it", async () => {
    await committedSwitch();
    release('0.12.0');
    mark({ id: 'm2', to: '0.12.0', why: 'update' });
    const { copyPrev } = installPaths(root);
    const realRmdir = fs.rmdirSync;
    const stuck = spyOn(fs, 'rmdirSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      if (String(path) === copyPrev) throw Object.assign(new Error('EIO: i/o error, rmdir'), { code: 'EIO' });
      return (realRmdir as (...args: unknown[]) => void)(path, ...rest);
    }) as typeof fs.rmdirSync);
    try {
      expect(await decide(root, ops())).toEqual({ release: '0.12.0', trial: true });
      expect(lastCopy(root)).toMatchObject({ from: '0.11.0', mark: 'm2' });
      expect(reports.at(-2)).toContain('Removing the copy before the last one');
      // The next start meets it too, says so, and goes on: here, to the trial's fallback.
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
      expect(existsSync(copyPrev)).toBe(true);
    } finally {
      stuck.mockRestore();
    }
    await decide(root, ops());
    expect(existsSync(copyPrev)).toBe(false);
  });

  test("a copy that fails, and whose unfinished copy can't be removed: both are said, the mark stands, and the next start removes it", async () => {
    await committedSwitch();
    release('0.12.0');
    mark({ id: 'm2', to: '0.12.0', why: 'update' });
    chmodSync(join(data, 'sessions', 'store.txt'), 0o000);
    const failing = (real: (...a: never[]) => unknown) => ((path: fs.PathLike, ...rest: never[]) => {
      if (String(path).startsWith(installPaths(root).copyTmp)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real(path as never, ...rest);
    });
    const [realRm, realRmdir] = [fs.rmSync, fs.rmdirSync];
    const rm = spyOn(fs, 'rmSync').mockImplementation(failing(realRm as never) as typeof fs.rmSync);
    const rmdir = spyOn(fs, 'rmdirSync').mockImplementation(failing(realRmdir as never) as typeof fs.rmdirSync);
    try {
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    } finally {
      rm.mockRestore();
      rmdir.mockRestore();
      chmodSync(join(data, 'sessions', 'store.txt'), 0o644);
    }
    expect(steps().at(-1)).toBe('copy failed m2');
    expect(reports.find((l) => l.includes('Removing a copy a switch left unfinished'))).toContain('a later start tries again');
    expect(reports.at(-1)).toMatch(/the copy failed/);
    expect(existsSync(installPaths(root).copyTmp)).toBe(true);
    expect(existsSync(installPaths(root).mark)).toBe(true);
    rmSync(installPaths(root).mark);
    reports = [];
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(existsSync(installPaths(root).copyTmp)).toBe(false);
  });

  test('a copy that fails: the copy before it stays whole, the mark stands, and nothing of the new one stays', async () => {
    await committedSwitch();
    release('0.12.0');
    mark({ id: 'm2', to: '0.12.0', why: 'update' });
    chmodSync(join(data, 'sessions', 'store.txt'), 0o000);
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    chmodSync(join(data, 'sessions', 'store.txt'), 0o644);
    expect(steps().at(-1)).toBe('copy failed m2');
    expect(reports.at(-1)).toMatch(/the copy failed/);
    expect(lastCopy(root)).toMatchObject({ from: '0.10.2', mark: 'm1' });
    expect(existsSync(installPaths(root).copyTmp)).toBe(false);
    expect(existsSync(installPaths(root).mark)).toBe(true);
  });

  test('a start that finds the last copy moved aside and the new one not in place puts the last one back', async () => {
    await committedSwitch();
    const { copy, copyPrev, copyTmp } = installPaths(root);
    renameSync(copy, copyPrev);
    mkdirSync(copyTmp);
    await decide(root, ops());
    expect(lastCopy(root)).toMatchObject({ from: '0.10.2' });
    expect(existsSync(copyPrev)).toBe(false);
    expect(existsSync(copyTmp)).toBe(false);
  });

  test('a start that finds the new copy in place and the last one still moved aside removes the last one', async () => {
    await committedSwitch();
    const { copy, copyPrev } = installPaths(root);
    copyTree(copy, copyPrev);
    writeJsonAtomic(copyLabelPath(copyPrev), { ...lastCopy(root)!, from: '0.9.0' } satisfies CopyLabel);
    await decide(root, ops());
    expect(existsSync(copyPrev)).toBe(false);
    expect(lastCopy(root)).toMatchObject({ from: '0.10.2' });
  });

  test("a fallback while a fleet child is still running: nothing starts, and the data stays as the trial left it until it stops", async () => {
    mark({ to: '0.11.0', why: 'update' });
    await decide(root, ops());
    writeFileSync(join(data, 'sessions', 'store.txt'), 'B wrote this');
    child('kid', join(dir, 'kid'), 777, 'boot-1');
    alive.add(777);
    await expect(decide(root, ops())).rejects.toThrow(/0\.11\.0 ended before its commit, and it can't go on: fleet children are still running: kid \(pid 777\)\./);
    expect(store()).toBe('B wrote this');
    expect(steps().at(-1)).toBe('trial-start ok m1');
    alive.delete(777);
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(store()).toBe('A wrote this');
  });

  test('a fallback that cannot restore: nothing starts, the journal says so, and each start tries again', async () => {
    mark({ to: '0.11.0', why: 'update' });
    await decide(root, ops());
    const labelPath = copyLabelPath(installPaths(root).copy);
    const label = read(labelPath);
    rmSync(labelPath);
    await expect(decide(root, ops())).rejects.toThrow(/going back to 0\.10\.2 and its data failed/);
    expect(steps().at(-1)).toBe('fallback failed m1');
    writeFileSync(labelPath, label);
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(steps().at(-1)).toBe('fallback ok m1');
  });
});

/** An install that switched from 0.10.2 to 0.11.0 and committed, with
 *  0.10.2's data in the copy and 0.11.0's in place. */
async function committedSwitch(): Promise<void> {
  mark({ to: '0.11.0', why: 'update' });
  await decide(root, ops());
  writeFileSync(join(data, 'sessions', 'store.txt'), 'B wrote this');
  writeFileSync(settings, '{"b":2}');
  moveCurrent(root, '0.11.0');
  appendJournal(root, { at: 'x', step: 'commit', from: '0.10.2', to: '0.11.0', outcome: 'ok' });
  await decide(root, ops());
}

/** Load the older release's launcher until the Go back's line is in, and then fail to. */
/** Whether the Go back's line is in. */
const LINE_OK = () => readJournal(root).some((l) => l.step === 'go-back' && l.outcome === 'ok');

const failingAfterLine = (): LauncherOps => ({
  ...ops(),
  importModule: async (path: string) => {
    if (readJournal(root).some((l) => l.step === 'go-back' && l.outcome === 'ok')) throw new Error('gone');
    return import(path);
  },
});

describe('a Go back', () => {
  test("restoring the copy: puts the older release's data in place, keeps the newer aside, and starts the older on trial", async () => {
    await committedSwitch();
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    // What's there when its line is written: everything prepared, and the
    // data untouched. The start reads the children file just after the line,
    // and asks the boot's id when the file lists a child.
    child('kid', join(dir, 'kid'));
    let atLine: { staged: boolean; kept: boolean; data: string } | null = null;
    const o = { ...ops(), bootId: () => {
      if (atLine === null && readJournal(root).some((l) => l.step === 'go-back' && l.outcome === 'ok')) {
        atLine = {
          staged: existsSync(join(itemStagingDir(data, 'g1'), 'sessions', 'store.txt')),
          kept: existsSync(join(setAsideDir(root, 'g1'), 'kept', '1-mcpl-servers.json')),
          data: store(),
        };
      }
      return boot;
    } };
    expect(await decide(root, o)).toEqual({ release: '0.10.2', trial: true });
    expect(atLine).toEqual({ staged: true, kept: true, data: 'B wrote this' });
    expect(store()).toBe('A wrote this');
    expect(read(settings)).toBe('{"a":1}');
    expect(read(join(itemSetAsideDir(data, 'g1'), 'sessions', 'store.txt'))).toBe('B wrote this');
    expect(read(join(setAsideDir(root, 'g1'), 'kept', '1-mcpl-servers.json'))).toBe('{"b":2}');
    expect(steps().slice(-2)).toEqual(['go-back ok g1', 'trial-start ok g1']);
    expect(reports.at(-1)).toContain('the newer data kept aside under mark g1');
  });

  test("whose trial ends before its commit: the next start puts the newer data back, keeps the older trial's aside, and starts the newer release", async () => {
    await committedSwitch();
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    await decide(root, ops());
    writeFileSync(join(data, 'sessions', 'store.txt'), 'A wrote this on its trial');
    writeFileSync(settings, '{"a":"trial"}');
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(store()).toBe('B wrote this');
    expect(read(settings)).toBe('{"b":2}');
    expect(read(join(itemStagingDir(data, 'g1'), 'sessions', 'store.txt'))).toBe('A wrote this on its trial');
    expect(read(join(setAsideDir(root, 'g1'), 'put-back', 'kept', '1-mcpl-servers.json'))).toBe('{"a":"trial"}');
    expect(steps().slice(-1)).toEqual(['fallback ok g1']);
    expect(reports.at(-1)).toContain(join(setAsideDir(root, 'g1'), 'put-back', 'kept'));
  });

  test("restoring the copy, with a data item the copy doesn't list: keeps what it holds aside on the trial, and the trial's fallback puts it back", async () => {
    await committedSwitch();
    // A child added after the switch, so the copy has no place for it.
    const kid = join(dir, 'kid');
    mkdirSync(kid);
    writeFileSync(join(kid, 'store.txt'), 'the newer child wrote this');
    child('kid', kid);
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    expect(readdirSync(kid).filter((name) => name !== ITEM_UPDATE_DIR)).toEqual([]);
    expect(read(join(itemSetAsideDir(kid, 'g1'), 'store.txt'))).toBe('the newer child wrote this');
    writeFileSync(join(kid, 'store.txt'), 'the older release wrote this on its trial');
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(read(join(kid, 'store.txt'))).toBe('the newer child wrote this');
    expect(read(join(itemStagingDir(kid, 'g1'), 'store.txt'))).toBe('the older release wrote this on its trial');
  });

  test('keeping the newer data: keeps a copy of the data aside, and leaves the data in place', async () => {
    await committedSwitch();
    mark({ id: 'g1', to: '0.10.2', why: 'go-back', keepData: true });
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    expect(store()).toBe('B wrote this');
    expect(read(join(itemSetAsideDir(data, 'g1'), 'sessions', 'store.txt'))).toBe('B wrote this');
    expect(readJournal(root).at(-2)).toMatchObject({ step: 'go-back', outcome: 'ok', keptData: true });
  });

  test('keeping the newer data, whose trial ends before its commit: the next start puts the newer data back as it was and starts the newer release', async () => {
    await committedSwitch();
    const kid = join(dir, 'kid');
    child('kid', kid);
    mark({ id: 'g1', to: '0.10.2', why: 'go-back', keepData: true });
    await decide(root, ops());
    writeFileSync(join(data, 'sessions', 'store.txt'), 'A opened this on its trial');
    writeFileSync(settings, '{"a":"opened"}');
    // What the older release's trial made where nothing was.
    writeFileSync(join(work, 'mcpl-servers.agent.json'), '{"trial":1}');
    mkdirSync(kid);
    writeFileSync(join(kid, 'store.txt'), 'the trial made this');
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(store()).toBe('B wrote this');
    expect(read(settings)).toBe('{"b":2}');
    expect(existsSync(join(work, 'mcpl-servers.agent.json'))).toBe(false);
    expect(readdirSync(kid)).toEqual([ITEM_UPDATE_DIR]);
    expect(read(join(itemStagingDir(kid, 'g1'), 'store.txt'))).toBe('the trial made this');
    expect(steps().slice(-1)).toEqual(['fallback ok g1']);
    // The request is spent: the start after starts the newer release as it
    // was and drops the mark.
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(existsSync(installPaths(root).mark)).toBe(false);
    // What the trial left stays kept after that start's sweep.
    expect(read(join(itemStagingDir(kid, 'g1'), 'store.txt'))).toBe('the trial made this');
  });

  test('keeping the newer data, once the older release commits: the next start removes the copy it kept for that trial', async () => {
    await committedSwitch();
    mark({ id: 'g1', to: '0.10.2', why: 'go-back', keepData: true });
    await decide(root, ops());
    moveCurrent(root, '0.10.2');
    appendJournal(root, { at: 'x', step: 'commit', from: '0.11.0', to: '0.10.2', outcome: 'ok' });
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
    expect(existsSync(itemSetAsideDir(data, 'g1'))).toBe(false);
    expect(existsSync(setAsideDir(root, 'g1'))).toBe(false);
    expect(store()).toBe('B wrote this');
  });

  test('keeping the newer data, whose release stops loading after its line: falls back without touching the data', async () => {
    await committedSwitch();
    const sessions = statSync(join(data, 'sessions')).ino;
    mark({ id: 'g1', to: '0.10.2', why: 'go-back', keepData: true });
    expect(await decide(root, failingAfterLine())).toEqual({ release: '0.11.0', trial: false });
    expect(statSync(join(data, 'sessions')).ino).toBe(sessions);
    expect(steps().slice(-3)).toEqual(['go-back ok g1', 'trial-start refused g1', 'fallback ok g1']);
    expect(store()).toBe('B wrote this');
    expect(existsSync(itemStagingDir(data, 'g1'))).toBe(false);
    expect(existsSync(itemSetAsideDir(data, 'g1'))).toBe(false);
    expect(existsSync(setAsideDir(root, 'g1'))).toBe(false);
  });

  test('restoring, whose release stops loading after its line: the start puts the newer data back and starts the newer release', async () => {
    await committedSwitch();
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    expect(await decide(root, failingAfterLine())).toEqual({ release: '0.11.0', trial: false });
    expect(steps().slice(-3)).toEqual(['go-back ok g1', 'trial-start refused g1', 'fallback ok g1']);
    expect(store()).toBe('B wrote this');
    expect(read(settings)).toBe('{"b":2}');
  });

  const guards: Array<{ name: string; step: string; says: RegExp; arrange(): void }> = [
    { name: 'a release not installed', step: 'go-back', says: /isn't installed here/, arrange: () => {
      rmSync(join(root, 'releases', '0.10.2'), { recursive: true });
    } },
    { name: 'a fleet child still running', step: 'children-check', says: /fleet children are still running: kid/, arrange: () => {
      child('kid', join(dir, 'kid'), 777, 'boot-1');
      alive.add(777);
    } },
    { name: 'no copy', step: 'go-back', says: /there's no copy of 0\.10\.2's data/, arrange: () => {
      rmSync(installPaths(root).copy, { recursive: true });
    } },
    { name: "a copy of another release's data", step: 'go-back', says: /the copy holds 0\.9\.0's/, arrange: () => {
      writeJsonAtomic(copyLabelPath(installPaths(root).copy), { ...lastCopy(root)!, from: '0.9.0' } satisfies CopyLabel);
    } },
    { name: 'a copy that has lost an item', step: 'go-back', says: /has lost 1-mcpl-servers\.json/, arrange: () => {
      rmSync(join(installPaths(root).copy, '1-mcpl-servers.json'));
    } },
    { name: 'too little room', step: 'go-back', says: /GiB free/, arrange: () => { free = 1024; } },
    { name: 'a mount inside the data directory', step: 'go-back', says: /is a mount inside \/\S*data\. /, arrange: () => {
      mounts = [join(data, 'sessions')];
    } },
    { name: 'a place whose kind changed', step: 'go-back', says: /is a directory now, and a file in the copy/, arrange: () => {
      rmSync(settings);
      mkdirSync(settings);
    } },
  ];
  for (const g of guards) {
    test(`refused for ${g.name}: nothing changes, and the newer release starts`, async () => {
      await committedSwitch();
      g.arrange();
      mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
      expect(steps().slice(-1)).toEqual([`${g.step} refused g1`]);
      const said = reports.find((l) => l.includes("didn't go ahead"))!;
      expect(said).toMatch(g.says);
      expect(said).not.toContain('..');
      expect(store()).toBe('B wrote this');
      expect(existsSync(setAsideDir(root, 'g1'))).toBe(false);
      expect(existsSync(itemStagingDir(data, 'g1'))).toBe(false);
    });
  }

  test('refused when a check fails: nothing changes, and the newer release starts', async () => {
    await committedSwitch();
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    const o: LauncherOps = { ...ops(), freeBytes: () => { throw new Error('statfs failed'); } };
    expect(await decide(root, o)).toEqual({ release: '0.11.0', trial: false });
    expect(steps().slice(-1)).toEqual(['go-back failed g1']);
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain('checking it failed: statfs failed');
    expect(store()).toBe('B wrote this');
    expect(existsSync(setAsideDir(root, 'g1'))).toBe(false);
  });

  test("a place the newer release removed: the Go back puts it back from the copy, and makes nothing before its line", async () => {
    const kid = join(dir, 'kid');
    mkdirSync(kid);
    // A mode the usual umasks (022, 002, 077) would each cut.
    chmodSync(kid, 0o777);
    writeFileSync(join(kid, 'store.txt'), 'the child wrote this');
    child('kid', kid);
    await committedSwitch();
    rmSync(kid, { recursive: true });
    // A preparation that fails leaves the place as it was.
    const copied = join(installPaths(root).copy, lastCopy(root)!.items[0]!.name, 'sessions', 'store.txt');
    chmodSync(copied, 0o000);
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    chmodSync(copied, 0o644);
    expect(steps().slice(-1)).toEqual(['go-back failed g1']);
    expect(existsSync(kid)).toBe(false);
    expect(existsSync(setAsideDir(root, 'g1'))).toBe(false);
    // Once it can, the Go back makes the place and fills it from the copy,
    // after its line: nothing is made before it.
    let madeByLine: boolean | null = null;
    const o: LauncherOps = { ...ops(), bootId: () => {
      if (madeByLine === null && LINE_OK()) madeByLine = existsSync(kid);
      return boot;
    } };
    // It has the copy's mode before anything is staged or moved in it, so a
    // cut there leaves it with that mode for the replay.
    const realRename = fs.renameSync;
    const realMkdir = fs.mkdirSync;
    let modeAtFirstMove: number | null = null;
    let madeWith: unknown = null;
    const renames = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (modeAtFirstMove === null && String(to).startsWith(`${kid}/`)) modeAtFirstMove = statSync(kid).mode & 0o777;
      return realRename(from, to);
    }) as typeof fs.renameSync);
    // It's made with that mode, so only what the umask takes waits for the chmod.
    const mkdirs = spyOn(fs, 'mkdirSync').mockImplementation(((path: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      if (String(path) === kid) madeWith = options?.mode;
      return (realMkdir as (...args: unknown[]) => unknown)(path, options);
    }) as typeof fs.mkdirSync);
    try {
      expect(await decide(root, o)).toEqual({ release: '0.10.2', trial: true });
    } finally {
      renames.mockRestore();
      mkdirs.mockRestore();
    }
    expect(madeWith).toBe(0o777);
    expect(modeAtFirstMove).toBe(0o777);
    expect(madeByLine).toBe(false);
    expect(read(join(kid, 'store.txt'))).toBe('the child wrote this');
    expect(statSync(kid).mode & 0o777).toBe(0o777);
  });

  test('whose restore fails at a later place: the start puts back what it changed, leaves what it never reached, and starts the newer release', async () => {
    // A child that hadn't run when the copy was taken, and has since.
    const kid = join(dir, 'kid');
    child('kid', kid);
    await committedSwitch();
    mkdirSync(kid);
    writeFileSync(join(kid, 'store.txt'), 'the newer release made this');
    const copiedSettings = join(installPaths(root).copy, '1-mcpl-servers.json');
    chmodSync(copiedSettings, 0o000);
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    chmodSync(copiedSettings, 0o644);
    expect(steps().slice(-3)).toEqual(['go-back ok g1', 'trial-start refused g1', 'fallback ok g1']);
    expect(store()).toBe('B wrote this');
    expect(read(settings)).toBe('{"b":2}');
    expect(read(join(kid, 'store.txt'))).toBe('the newer release made this');
  });

  test("whose put-back fails: nothing starts, and the next start goes on putting back", async () => {
    await committedSwitch();
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    await decide(root, ops());
    // A directory where the settings file was: no file can be put back there.
    rmSync(settings);
    mkdirSync(settings);
    await expect(decide(root, ops())).rejects.toThrow(/going back to 0\.11\.0 and its data failed: .*is a directory now/);
    expect(steps().at(-1)).toBe('fallback failed g1');
    rmdirSync(settings);
    writeFileSync(settings, '{"a":1}');
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(store()).toBe('B wrote this');
    expect(read(settings)).toBe('{"b":2}');
    expect(steps().at(-1)).toBe('fallback ok g1');
  });

  test("whose release stops loading after its line, and whose putting back fails: nothing starts, and the next start goes on with the Go back", async () => {
    await committedSwitch();
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    const o: LauncherOps = { ...ops(), importModule: async (path) => {
      if (LINE_OK()) {
        // A directory where the settings file was: no file can be put back there.
        if (statSync(settings).isFile()) {
          rmSync(settings);
          mkdirSync(settings);
        }
        throw new Error('gone');
      }
      return import(path);
    } };
    await expect(decide(root, o)).rejects.toThrow(/couldn't go on .*and putting 0\.11\.0's data back failed too/);
    expect(steps().at(-1)).toBe('fallback failed g1');
    rmdirSync(settings);
    writeFileSync(settings, '{"a":1}');
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    expect(store()).toBe('A wrote this');
    expect(read(settings)).toBe('{"a":1}');
  });

  test('going on after a putting back that failed before its trial keeps what the trial then leaves, not what that putting back kept', async () => {
    await committedSwitch();
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    // A start that stops after the Go back's line, before its restore.
    child('kid', join(dir, 'kid'), 777, 'boot-1');
    await expect(decide(root, { ...ops(), pidAlive: () => LINE_OK() })).rejects.toThrow(/is under way, and it can't go on/);
    // What a putting back that failed there would have kept of the settings file.
    const putBackKept = join(setAsideDir(root, 'g1'), 'put-back', 'kept', lastCopy(root)!.items.find((i) => i.path === settings)!.name);
    mkdirSync(join(putBackKept, '..'), { recursive: true });
    writeFileSync(putBackKept, 'stale');
    rmSync(childrenFilePath(data));
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    writeFileSync(settings, '{"trial":1}');
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(read(putBackKept)).toBe('{"trial":1}');
    expect(read(settings)).toBe('{"b":2}');
  });

  test("a restore that fails filling a place it made: putting back makes no staging area for it", async () => {
    const kid = join(dir, 'kid');
    mkdirSync(kid);
    writeFileSync(join(kid, 'store.txt'), 'the child wrote this');
    child('kid', kid);
    await committedSwitch();
    rmSync(kid, { recursive: true });
    const copied = join(installPaths(root).copy, lastCopy(root)!.items.find((i) => i.path === kid)!.name, 'store.txt');
    chmodSync(copied, 0o000);
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    chmodSync(copied, 0o644);
    expect(steps().slice(-2)).toEqual(['trial-start refused g1', 'fallback ok g1']);
    expect(existsSync(itemStagingDir(kid, 'g1'))).toBe(false);
    // The unfinished copy goes, and the place it made stays, empty.
    expect(existsSync(`${itemStagingDir(kid, 'g1')}.tmp`)).toBe(false);
    expect(readdirSync(kid).filter((name) => name !== ITEM_UPDATE_DIR)).toEqual([]);
    expect(store()).toBe('B wrote this');
  });

  test('a putting back cut off after what was set aside began to come back finishes on the next start', async () => {
    await committedSwitch();
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    await decide(root, ops());
    writeFileSync(join(data, 'sessions', 'store.txt'), 'A wrote this on its trial');
    // As a cut leaves it: the trial's data moved out, and the set-aside renamed to come back in.
    const aside = itemSetAsideDir(data, 'g1');
    const staging = itemStagingDir(data, 'g1');
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(data).filter((n) => n !== ITEM_UPDATE_DIR)) renameSync(join(data, name), join(staging, name));
    renameSync(aside, `${aside}.emptying`);
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(store()).toBe('B wrote this');
    expect(read(join(staging, 'sessions', 'store.txt'))).toBe('A wrote this on its trial');
  });

  test("a file the copy holds that isn't there before the Go back: its absence is noted by the line, and a fallback takes the file away", async () => {
    await committedSwitch();
    rmSync(settings);
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    const name = lastCopy(root)!.items.find((i) => i.path === settings)!.name;
    child('kid', join(dir, 'kid'));
    let noted: boolean | null = null;
    const o: LauncherOps = { ...ops(), bootId: () => {
      if (noted === null && LINE_OK()) noted = existsSync(join(setAsideDir(root, 'g1'), 'absent', name));
      return boot;
    } };
    expect(await decide(root, o)).toEqual({ release: '0.10.2', trial: true });
    expect(noted).toBe(true);
    expect(read(settings)).toBe('{"a":1}');
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(existsSync(settings)).toBe(false);
  });

  test('keeping the newer data needs no copy', async () => {
    await committedSwitch();
    rmSync(installPaths(root).copy, { recursive: true });
    mark({ id: 'g1', to: '0.10.2', why: 'go-back', keepData: true });
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    expect(store()).toBe('B wrote this');
  });

  test("keeping the newer data, falling back before its trial: a start after a cut before its cleanup removes its copy", async () => {
    await committedSwitch();
    mark({ id: 'g1', to: '0.10.2', why: 'go-back', keepData: true });
    expect(await decide(root, failingAfterLine())).toEqual({ release: '0.11.0', trial: false });
    // As a cut between its fallback's line and its cleanup leaves it.
    expect(existsSync(setAsideDir(root, 'g1'))).toBe(false);
    mkdirSync(itemSetAsideDir(data, 'g1'), { recursive: true });
    writeFileSync(join(itemSetAsideDir(data, 'g1'), 'kept.txt'), 'x');
    mkdirSync(setAsideDir(root, 'g1'), { recursive: true });
    writeJsonAtomic(goBackListPath(root, 'g1'), { v: 1, places: [{ path: data, name: '0-data', before: 'dir', target: 'dir' }] });
    await decide(root, ops());
    expect(existsSync(setAsideDir(root, 'g1'))).toBe(false);
    expect(existsSync(itemSetAsideDir(data, 'g1'))).toBe(false);
  });

  test('a Go back checks its release before anything else', async () => {
    await committedSwitch();
    child('kid', join(dir, 'kid'), 777, 'boot-1');
    alive.add(777);
    mark({ id: 'g1', to: '0.9.0', why: 'go-back' });
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(steps().at(-1)).toBe('go-back refused g1');
    expect(reports.find((l) => l.includes("didn't go ahead"))).toMatch(/0\.9\.0 isn't installed here/);
  });

  test("a Go back refuses a file place that is a link now, and one it would take away that is a mount", async () => {
    const statePath = join(dir, 'state.json');
    writeFileSync(statePath, '{"s":1}');
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: data, extraState: [statePath] } satisfies InstallRecord);
    await committedSwitch();
    writeFileSync(join(dir, 'real.json'), '{}');
    rmSync(settings);
    symlinkSync(join(dir, 'real.json'), settings);
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${settings}, where the copy of 0.10.2's data took ` +
      `a place, leads to ${join(realpathSync(dir), 'real.json')} now, through a link`);
    // One that leads nowhere, which the record no longer lists, isn't written through either.
    rmSync(settings);
    writeFileSync(settings, '{"b":2}');
    rmSync(join(dir, 'real.json'));
    rmSync(statePath);
    symlinkSync(join(dir, 'nowhere.json'), statePath);
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: data, extraState: [] } satisfies InstallRecord);
    reports = [];
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${statePath} is a link now`);
    rmSync(statePath);
    writeFileSync(statePath, '{"s":1}');
    rmSync(settings);
    writeFileSync(settings, '{"b":2}');
    const agent = join(work, 'mcpl-servers.agent.json');
    writeFileSync(agent, '{"agent":1}');
    mounts = [agent];
    reports = [];
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${agent} is a mount, which a Go back can't take away`);
  });

  test("a Go back is refused while a data directory can't be written", async () => {
    await committedSwitch();
    chmodSync(data, 0o555);
    try {
      mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    } finally {
      chmodSync(data, 0o755);
    }
    expect(steps().at(-1)).toBe('go-back refused g1');
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${data} can't be read, written and searched by this process`);
  });

  test("a Go back is refused while the directory of a file it would make can't be written", async () => {
    await committedSwitch();
    // The newer release removed it, so the restore would make it.
    rmSync(settings);
    chmodSync(work, 0o555);
    try {
      mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    } finally {
      chmodSync(work, 0o755);
    }
    expect(steps().at(-1)).toBe('go-back refused g1');
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${work} can't be read, written and searched`);
  });

  test("a Go back whose earlier preparation couldn't be cleared waits for it to go, rather than reuse its keeps", async () => {
    await committedSwitch();
    // An earlier attempt's preparation, whose list can't be read, holding a
    // keep of what the settings file held then.
    mkdirSync(join(setAsideDir(root, 'g1'), 'kept'), { recursive: true });
    writeFileSync(goBackListPath(root, 'g1'), '{');
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(steps().at(-1)).toBe('go-back refused g1');
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`an earlier attempt's preparation under mark g1 is still at ${setAsideDir(root, 'g1')}`);
    rmSync(setAsideDir(root, 'g1'), { recursive: true });
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
  });

  test("a Go back is refused while the directory of a file it would take away can't be written", async () => {
    await committedSwitch();
    // Made since the switch, so the copy doesn't list it and the Go back takes it away.
    const agent = join(work, 'mcpl-servers.agent.json');
    writeFileSync(agent, '{}');
    chmodSync(work, 0o555);
    try {
      mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    } finally {
      chmodSync(work, 0o755);
    }
    expect(steps().at(-1)).toBe('go-back refused g1');
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${work} can't be read, written and searched`);
  });

  test("a Go back checks the nearest directory that's there when a directory it would make has no parent yet", async () => {
    const locked = join(dir, 'locked');
    const kid = join(locked, 'sub', 'kid');
    mkdirSync(kid, { recursive: true });
    child('kid', kid);
    await committedSwitch();
    // The newer release removed its parent too.
    rmSync(join(locked, 'sub'), { recursive: true });
    chmodSync(locked, 0o311);
    try {
      mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${locked} can't be read, written and searched`);
  });

  test("a Go back is refused while the parent of a directory it would make can't be read", async () => {
    const locked = join(dir, 'locked');
    const kid = join(locked, 'kid');
    mkdirSync(kid, { recursive: true });
    child('kid', kid);
    await committedSwitch();
    // The newer release removed it, so the restore would make it.
    rmSync(kid, { recursive: true });
    chmodSync(locked, 0o311);
    try {
      mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${locked} can't be read, written and searched`);
  });

  test("a Go back refuses, before its line, to make a file on a read-only filesystem", async () => {
    await committedSwitch();
    // The newer release removed it, so the restore would make it.
    rmSync(settings);
    const ro = readOnlyFilesystem([work]);
    try {
      mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    } finally {
      ro.mockRestore();
    }
    expect(steps().at(-1)).toBe('go-back refused g1');
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${settings} is on a read-only filesystem`);
    expect(existsSync(settings)).toBe(false);
  });

  test("putting back that finds a file the trial made already taken away syncs its directory", async () => {
    await committedSwitch();
    // Not there before the Go back, nor in the copy.
    const agent = join(work, 'mcpl-servers.agent.json');
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    // The trial made it; as a cut leaves it, putting back took it away, and
    // its directory's sync wasn't reached.
    expect(existsSync(agent)).toBe(false);
    let start: unknown;
    const synced = await syncedDuring(async () => { start = await decide(root, ops()); });
    expect(start).toEqual({ release: '0.11.0', trial: false });
    expect(existsSync(agent)).toBe(false);
    expect(synced).toContain(work);
  });

  test("putting back with nothing kept of a file place stops, naming it, and leaves the file as it is", async () => {
    await committedSwitch();
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    writeFileSync(settings, '{"trial":1}');
    for (const what of ['kept', 'absent']) rmSync(join(setAsideDir(root, 'g1'), what), { recursive: true, force: true });
    await expect(decide(root, ops())).rejects.toThrow(/Nothing kept of .*mcpl-servers\.json .* so it can't be put back/);
    expect(read(settings)).toBe('{"trial":1}');
  });

  test("a Go back refuses, before its line, to change a file this process may not write and doesn't own", async () => {
    await committedSwitch();
    chmodSync(settings, 0o444);
    const realStat = fs.statSync;
    const stat = spyOn(fs, 'statSync').mockImplementation(((path: fs.PathLike, options?: fs.StatSyncOptions) => {
      const found = realStat(path, options as never) as fs.Stats;
      if (String(path) === settings) return Object.assign(Object.create(Object.getPrototypeOf(found)), found, { uid: found.uid + 1 });
      return found;
    }) as typeof fs.statSync);
    try {
      mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    } finally {
      stat.mockRestore();
      chmodSync(settings, 0o644);
    }
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${settings} can't be written by this process, which doesn't own it`);
    expect(readJournal(root).some((l) => l.step === 'go-back' && l.outcome === 'ok')).toBe(false);
    expect(read(settings)).toBe('{"b":2}');
    // Its owner gives itself write for the write, so the same file it owns goes ahead.
    chmodSync(settings, 0o444);
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    expect(read(settings)).toBe('{"a":1}');
  });

  /** Run `body` as uid `self`, holding the effective capabilities `caps` as
   *  /proc/self/status gives them (null: no such file), with each path under
   *  `under` owned by `self`, but those in `others`, which another owns, and
   *  those in `sticky` given the sticky bit. */
  async function owned(arrangement: { self?: number; under: string[]; others?: string[]; linkOthers?: string[]; sticky?: string[];
    unwritable?: string[]; caps: string | null }, body: () => Promise<void>): Promise<void> {
    const { self = 4242, under, others = [], linkOthers = [], sticky = [], unwritable = [], caps } = arrangement;
    const realAccess = fs.accessSync;
    const realStat = fs.statSync;
    const realLstat = fs.lstatSync;
    const realRead = fs.readFileSync;
    const shape = (path: fs.PathLike, found: fs.Stats | undefined, link: boolean) => {
      const p = String(path);
      if (found === undefined || typeof found.mode !== 'number' || !under.some((u) => p === u || p.startsWith(`${u}/`))) return found;
      const other = others.includes(p) || (link && linkOthers.includes(p));
      return Object.assign(Object.create(Object.getPrototypeOf(found)), found,
        { uid: other ? self + 1 : self, mode: sticky.includes(p) ? found.mode | 0o1000 : found.mode });
    };
    const spies = [
      spyOn(process, 'getuid').mockImplementation(() => self),
      spyOn(fs, 'statSync').mockImplementation(((path: fs.PathLike, options?: fs.StatSyncOptions) =>
        shape(path, realStat(path, options as never) as fs.Stats, false)) as typeof fs.statSync),
      spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike, options?: fs.StatSyncOptions) =>
        shape(path, realLstat(path, options as never) as fs.Stats, true)) as typeof fs.lstatSync),
      spyOn(fs, 'readFileSync').mockImplementation(((path: fs.PathOrFileDescriptor, options?: unknown) => {
        if (String(path) !== '/proc/self/status') return (realRead as (...args: unknown[]) => unknown)(path, options);
        if (caps === null) throw Object.assign(new Error("ENOENT: no such file or directory, open '/proc/self/status'"), { code: 'ENOENT' });
        return caps === '' ? 'Name:\tbun\n' : `Name:\tbun\nCapEff:\t${caps}\n`;
      }) as typeof fs.readFileSync),
      spyOn(fs, 'accessSync').mockImplementation(((path: fs.PathLike, mode?: number) => {
        if (unwritable.includes(String(path)) && ((mode ?? 0) & fs.constants.W_OK) !== 0) {
          throw Object.assign(new Error(`EACCES: permission denied, access '${String(path)}'`), { code: 'EACCES' });
        }
        return realAccess(path, mode);
      }) as typeof fs.accessSync),
    ];
    try {
      await body();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  }
  // Every capability but CAP_FOWNER, bit 3.
  const NO_CAPS = '000001fffffffff7';
  const FOWNER = '0000000000000008';

  test("a Go back refuses, before its line, to take away a file another owns from a sticky directory another owns, unless it holds CAP_FOWNER", async () => {
    await committedSwitch();
    const agent = join(work, 'mcpl-servers.agent.json');
    writeFileSync(agent, '{"agent":1}');
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    await owned({ under: [work], others: [work, agent], sticky: [work], caps: NO_CAPS }, async () => {
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    });
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${agent} is in ${work}, which has the sticky bit, and ` +
      `this process owns neither, so the Go back couldn't move it. Make this user the owner of ${agent} or of ${work}, or take the ` +
      `sticky bit off ${work}`);
    expect(reports.find((l) => l.includes("didn't go ahead"))).not.toContain('go back keeping the newer data');
    expect(readJournal(root).some((l) => l.step === 'go-back' && l.outcome === 'ok')).toBe(false);
    expect(read(agent)).toBe('{"agent":1}');
    // CAP_FOWNER takes it away whatever its owners, so the same Go back goes ahead holding it.
    reports = [];
    await owned({ under: [work], others: [work, agent], sticky: [work], caps: FOWNER }, async () => {
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    });
    expect(reports.some((l) => l.includes('sticky bit'))).toBe(false);
    expect(existsSync(agent)).toBe(false);
  });

  test("root is taken to hold CAP_FOWNER only where its capabilities aren't said, and anyone else never", async () => {
    await committedSwitch();
    const agent = join(work, 'mcpl-servers.agent.json');
    writeFileSync(agent, '{"agent":1}');
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    for (const [self, caps] of [[4242, null], [4242, ''], [0, NO_CAPS]] as const) {
      reports = [];
      await owned({ self, under: [work], others: [work, agent], sticky: [work], caps }, async () => {
        expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
      });
      expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${agent} is in ${work}, which has the sticky bit`);
    }
    // Root, where /proc/self/status says no CapEff, goes ahead.
    reports = [];
    await owned({ self: 0, under: [work], others: [work, agent], sticky: [work], caps: '' }, async () => {
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    });
    expect(reports.some((l) => l.includes('sticky bit'))).toBe(false);
  });

  test("root goes ahead where its capabilities can't be read at all", async () => {
    await committedSwitch();
    const agent = join(work, 'mcpl-servers.agent.json');
    writeFileSync(agent, '{"agent":1}');
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    await owned({ self: 0, under: [work], others: [work, agent], sticky: [work], caps: null }, async () => {
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    });
  });

  for (const [name, others] of [
    ['a file this process owns from a sticky directory another owns', (agent: string) => [work]],
    ['a file another owns from a sticky directory this process owns', (agent: string) => [agent]],
    ['a file another owns from a directory another owns without the sticky bit', (agent: string) => [work, agent]],
  ] as const) {
    test(`a Go back takes away ${name}`, async () => {
      await committedSwitch();
      const agent = join(work, 'mcpl-servers.agent.json');
      writeFileSync(agent, '{"agent":1}');
      mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
      const sticky = name.includes('without the sticky bit') ? [] : [work];
      await owned({ under: [work], others: others(agent), sticky, caps: NO_CAPS }, async () => {
        expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
      });
      expect(reports.some((l) => l.includes('sticky bit'))).toBe(false);
      expect(existsSync(agent)).toBe(false);
    });
  }

  test("a Go back that restores a directory refuses, before its line, when an entry another owns is in it, with the sticky bit, and it's another's", async () => {
    await committedSwitch();
    const sessions = join(data, 'sessions');
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    await owned({ under: [data], others: [data, sessions], sticky: [data], caps: NO_CAPS }, async () => {
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    });
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${sessions} is in ${data}, which has the sticky bit, and ` +
      "this process owns neither, so the Go back couldn't move it");
    expect(readJournal(root).some((l) => l.step === 'go-back' && l.outcome === 'ok')).toBe(false);
    expect(store()).toBe('B wrote this');
    // The entries it owns move whatever the bit.
    reports = [];
    await owned({ under: [data], others: [data], sticky: [data], caps: NO_CAPS }, async () => {
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    });
    expect(reports.some((l) => l.includes('sticky bit'))).toBe(false);
  });

  test("a Go back that restores a directory refuses, before its line, when a directory in it is another's and this process can't write it", async () => {
    await committedSwitch();
    const sessions = join(data, 'sessions');
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    await owned({ under: [data], others: [sessions], unwritable: [sessions], caps: FOWNER }, async () => {
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    });
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${sessions} is a directory another owns that this ` +
      `process can't write, and the Go back moves it out of ${data}, which a directory allows only to a process that may write ` +
      `it. Give this user write on ${sessions}, or make this user its owner`);
    // Going back keeping the newer data isn't offered, since its fallback drives the same directory.
    expect(reports.find((l) => l.includes("didn't go ahead"))).not.toContain('go back keeping the newer data');
    expect(readJournal(root).some((l) => l.step === 'go-back' && l.outcome === 'ok')).toBe(false);
    expect(store()).toBe('B wrote this');
    // One it owns gets owner write for the move, so the same Go back goes ahead.
    reports = [];
    await owned({ under: [data], unwritable: [sessions], caps: NO_CAPS }, async () => {
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    });
    expect(store()).toBe('A wrote this');
  });

  test("a Go back that keeps the newer data refuses, before its line, what its fallback's putting back couldn't move", async () => {
    await committedSwitch();
    const sessions = join(data, 'sessions');
    mark({ id: 'g1', to: '0.10.2', why: 'go-back', keepData: true });
    await owned({ under: [data], others: [sessions], unwritable: [sessions], caps: NO_CAPS }, async () => {
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    });
    const said = reports.find((l) => l.includes("didn't go ahead"))!;
    expect(said).toContain(`${sessions} is a directory another owns that this process can't write, and the fallback, if 0.10.2 ` +
      `fails before it commits, moves it out of ${data}`);
    expect(said).not.toContain('go back keeping the newer data');
    expect(readJournal(root).some((l) => l.step === 'go-back' && l.outcome === 'ok')).toBe(false);
  });

  test("what a drive may move whatever its owner: a file another owns that this process can't write, and a directory another owns that it can", async () => {
    await committedSwitch();
    const loose = join(data, 'loose.txt');
    writeFileSync(loose, 'newer');
    const sessions = join(data, 'sessions');
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    await owned({ under: [data], others: [loose, sessions], unwritable: [loose], caps: NO_CAPS }, async () => {
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    });
    expect(store()).toBe('A wrote this');
  });

  test("a link another owns in a sticky directory another owns is held by its own owner, not its target's", async () => {
    await committedSwitch();
    const link = join(data, 'link');
    symlinkSync(join(data, 'sessions'), link);
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    await owned({ under: [data], others: [data], linkOthers: [link], sticky: [data], caps: NO_CAPS }, async () => {
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    });
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${link} is in ${data}, which has the sticky bit`);
  });

  for (const [name, arrangement, says] of [
    ['a directory in the data directory that another owns and this process can\'t write',
      () => ({ under: [data], others: [join(data, 'sessions')], unwritable: [join(data, 'sessions')], caps: NO_CAPS }),
      () => `${join(data, 'sessions')} is a directory another owns that this process can't write, and the fallback, if 0.11.0 ` +
        `fails before it commits, moves it out of ${data}, which a directory allows only to a process that may write it. Give ` +
        `this user write on ${join(data, 'sessions')}, or make this user its owner`],
    ['an entry another owns in a sticky data directory another owns',
      () => ({ under: [data], others: [data, join(data, 'sessions')], sticky: [data], caps: NO_CAPS }),
      () => `${join(data, 'sessions')} is in ${data}, which has the sticky bit, and this process owns neither, so the fallback, ` +
        `if 0.11.0 fails before it commits, couldn't move it. Make this user the owner of ${join(data, 'sessions')} or of ` +
        `${data}, or take the sticky bit off ${data}`],
    ['a directory another owns in a fleet child\'s data directory that this process can\'t write',
      () => {
        const kid = join(dir, 'kid');
        mkdirSync(join(kid, 'store'), { recursive: true });
        child('kid', kid);
        return { under: [kid], others: [join(kid, 'store')], unwritable: [join(kid, 'store')], caps: NO_CAPS };
      },
      () => `${join(dir, 'kid', 'store')} is a directory another owns that this process can't write, and the fallback`],
  ] as const) {
    test(`a switch is refused, before its copy, when its fallback couldn't restore the data: ${name}`, async () => {
      mark({ to: '0.11.0', why: 'update' });
      await owned(arrangement(), async () => {
        expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: false });
      });
      expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(says());
      expect(lastCopy(root)).toBe(null);
      expect(existsSync(installPaths(root).mark)).toBe(true);
    });
  }

  for (const [name, others, caps] of [
    ['while it holds CAP_FOWNER', () => [data, join(data, 'sessions')], FOWNER],
    ['while it owns the entries', () => [data], NO_CAPS],
  ] as const) {
    test(`a switch goes ahead over a sticky data directory another owns ${name}`, async () => {
      mark({ to: '0.11.0', why: 'update' });
      await owned({ under: [data], others: others(), sticky: [data], caps }, async () => {
        expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: true });
      });
      expect(reports.some((l) => l.includes('sticky bit'))).toBe(false);
    });
  }

  test("a Go back names a mount inside a directory it restores before what it couldn't move there", async () => {
    await committedSwitch();
    const sessions = join(data, 'sessions');
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    mounts = ['/', sessions];
    await owned({ under: [data], others: [sessions], unwritable: [sessions], caps: NO_CAPS }, async () => {
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    });
    const said = reports.find((l) => l.includes("didn't go ahead"))!;
    expect(said).toContain(`${sessions} is a mount inside ${data}`);
    expect(said).not.toContain("can't write");
  });

  for (const [name, arrange, refused] of [
    ["a file it may write, though another owns it, is restored", () => chmodSync(settings, 0o666), false],
    ["a file it may neither write nor own that already holds the copy's content goes ahead", () => {
      writeFileSync(settings, '{"a":1}');
      chmodSync(settings, 0o444);
    }, false],
    ["a file it would only take away needs no write on itself", () => {
      writeFileSync(join(work, 'mcpl-servers.agent.json'), '{"agent":1}');
      chmodSync(join(work, 'mcpl-servers.agent.json'), 0o444);
    }, false],
  ] as const) {
    test(`a Go back and a file another owns: ${name}`, async () => {
      await committedSwitch();
      arrange();
      const realStat = fs.statSync;
      const stat = spyOn(fs, 'statSync').mockImplementation(((path: fs.PathLike, options?: fs.StatSyncOptions) => {
        const found = realStat(path, options as never) as fs.Stats;
        if (String(path).startsWith(work)) return Object.assign(Object.create(Object.getPrototypeOf(found)), found, { uid: found.uid + 1 });
        return found;
      }) as typeof fs.statSync);
      try {
        mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
        expect(await decide(root, ops())).toEqual(refused ? { release: '0.11.0', trial: false } : { release: '0.10.2', trial: true });
      } finally {
        stat.mockRestore();
        for (const f of [settings, join(work, 'mcpl-servers.agent.json')]) if (existsSync(f)) chmodSync(f, 0o644);
      }
      expect(reports.some((l) => l.includes("can't be written by this process"))).toBe(refused);
    });
  }

  test("a Go back refuses, before its line, to change a file on a read-only filesystem, and goes ahead when the file holds the copy's content", async () => {
    await committedSwitch();
    const ro = readOnlyFilesystem([settings]);
    try {
      mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
      expect(steps().at(-1)).toBe('go-back refused g1');
      expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${settings} is on a read-only filesystem, and the Go back would change it`);
      // The older content is already there: nothing to write.
      writeFileSync(settings, '{"a":1}');
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    } finally {
      ro.mockRestore();
    }
  });

  test("a Go back that would take away a file refuses when the list of mounts can't be read", async () => {
    await committedSwitch();
    // With no directory to check, the file is what needs the list.
    rmSync(data, { recursive: true });
    writeFileSync(join(work, 'mcpl-servers.agent.json'), '{"agent":1}');
    mounts = null;
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain('whether a file the Go back takes away is a mount');
  });

  test("a restoring Go back over a data directory that isn't there needs no list of mounts, since it moves nothing out", async () => {
    await committedSwitch();
    rmSync(data, { recursive: true });
    mounts = null;
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    expect(store()).toBe('A wrote this');
  });

  test("keeping the newer data is refused when the data directory isn't there", async () => {
    await committedSwitch();
    rmSync(data, { recursive: true });
    mark({ id: 'g1', to: '0.10.2', why: 'go-back', keepData: true });
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`the data directory ${data} isn't there`);
  });

  test("an existing data directory keeps its own mode through a Go back and its fallback", async () => {
    await committedSwitch();
    chmodSync(data, 0o750);
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    expect(statSync(data).mode & 0o777).toBe(0o750);
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(statSync(data).mode & 0o777).toBe(0o750);
    expect(store()).toBe('B wrote this');
  });

  test("a Go back's putting back stops, naming it, when a mount has come inside a data directory, and goes on once it's gone", async () => {
    await committedSwitch();
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    await decide(root, ops());
    mounts = [join(data, 'sessions')];
    await expect(decide(root, ops())).rejects.toThrow(/Restoring .*data can't go on: .*sessions is a mount inside \/\S*data\. /);
    expect(steps().at(-1)).toBe('fallback failed g1');
    mounts = [];
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(store()).toBe('B wrote this');
  });

  test("a Go back whose place leads elsewhere now, through a link a move left, is refused before its line", async () => {
    const cfg = join(dir, 'cfg');
    mkdirSync(cfg);
    writeFileSync(join(cfg, 'state.json'), '{"a":1}');
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: data, extraState: [join(cfg, 'state.json')] } satisfies InstallRecord);
    await committedSwitch();
    // Its directory moved, with a link left where it was: the file is found
    // at its new path in its own right, beside the copy's.
    renameSync(cfg, join(dir, 'cfg-moved'));
    symlinkSync(join(dir, 'cfg-moved'), cfg);
    writeFileSync(join(dir, 'cfg-moved', 'state.json'), '{"b":2}');
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${join(cfg, 'state.json')}, where the copy of ` +
      `0.10.2's data took a place, leads to ${join(realpathSync(join(dir, 'cfg-moved')), 'state.json')} now, through a link, ` +
      'and a Go back that restores the copy puts each place back where the copy took it. Put the place back there in place ' +
      'of the link, or go back keeping the newer data');
    expect(readJournal(root).some((l) => l.step === 'go-back' && l.outcome === 'ok')).toBe(false);
    expect(read(join(dir, 'cfg-moved', 'state.json'))).toBe('{"b":2}');
  });

  test("a Go back is refused while a place recorded since the switch, and not there now, holds one the copy took", async () => {
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, 'config.json'), '{"a":1}');
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: data, extraState: [join(stateDir, 'config.json')] } satisfies InstallRecord);
    await committedSwitch();
    rmSync(stateDir, { recursive: true });
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: data, extraState: [stateDir] } satisfies InstallRecord);
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`${stateDir} is recorded now, and ${join(stateDir, 'config.json')}, ` +
      "which the copy of 0.10.2's data took on its own, is inside it, so the copy can't put it back whole. Go back keeping the newer data, " +
      `or, if it's extra state the record gained since the switch, take it out of extraState in ${installPaths(root).install}`);
  });

  test("a Go back is refused while a place recorded since the switch holds one the copy took on its own", async () => {
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir);
    writeFileSync(join(stateDir, 'config.json'), '{"a":1}');
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: data, extraState: [join(stateDir, 'config.json')] } satisfies InstallRecord);
    await committedSwitch();
    writeFileSync(join(stateDir, 'other.json'), 'newer');
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: data, extraState: [stateDir] } satisfies InstallRecord);
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(
      `${stateDir} is recorded now, and ${join(stateDir, 'config.json')}, which the copy of 0.10.2's data took on its own, is inside it`);
    expect(readJournal(root).some((l) => l.step === 'go-back' && l.outcome === 'ok')).toBe(false);
    expect(read(join(stateDir, 'other.json'))).toBe('newer');
    // Its remedy: taken out of extraState, the Go back restores the copy's file.
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: data, extraState: [] } satisfies InstallRecord);
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    expect(read(join(stateDir, 'config.json'))).toBe('{"a":1}');
  });

  test("a restore that fails before a later file place: putting back puts that file back from what the Go back kept before its line", async () => {
    const kid = join(dir, 'kid');
    mkdirSync(kid);
    writeFileSync(join(kid, 'store.txt'), 'the child wrote this');
    child('kid', kid);
    await committedSwitch();
    rmSync(kid, { recursive: true });
    // Extra state recorded since the switch: a place the copy doesn't list,
    // after every place it does.
    const state = join(dir, 'state.json');
    writeFileSync(state, '{"state":1}');
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: data, extraState: [state] } satisfies InstallRecord);
    const copied = join(installPaths(root).copy, lastCopy(root)!.items.find((i) => i.path === kid)!.name, 'store.txt');
    chmodSync(copied, 0o000);
    try {
      mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    } finally {
      chmodSync(copied, 0o644);
    }
    expect(steps().slice(-2)).toEqual(['trial-start refused g1', 'fallback ok g1']);
    expect(read(state)).toBe('{"state":1}');
  });

  test("refused one byte short of the room a Go back and its fallback write, and goes ahead with it", async () => {
    await committedSwitch();
    const label = lastCopy(root)!;
    const copied = (path: string) => join(installPaths(root).copy, label.items.find((i) => i.path === path)!.name);
    // The data's staging; the settings file's newer content kept and written
    // back by a fallback, and the older content kept and written in place.
    const need = spaceTaken(copied(data)) + 2 * spaceTaken(settings) + 2 * spaceTaken(copied(settings)) + 256 * 2 ** 20;
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    free = need - 1;
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(reports.find((l) => l.includes("didn't go ahead"))).toMatch(/what the Go back stages and keeps, and what it and its fallback would write/);
    free = need;
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
  });

  test("going on with a Go back syncs the removal of a failed putting back's keeps before its trial-start", async () => {
    await committedSwitch();
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    child('kid', join(dir, 'kid'), 777, 'boot-1');
    await expect(decide(root, { ...ops(), pidAlive: () => LINE_OK() })).rejects.toThrow(/is under way, and it can't go on/);
    mkdirSync(join(setAsideDir(root, 'g1'), 'put-back', 'kept'), { recursive: true });
    rmSync(childrenFilePath(data));
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
      expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    } finally {
      opens.mockRestore();
      syncs.mockRestore();
    }
    expect(existsSync(join(setAsideDir(root, 'g1'), 'put-back'))).toBe(false);
    // Before the trial-start line, the journal's last write.
    expect(synced.indexOf(setAsideDir(root, 'g1'))).toBeGreaterThan(-1);
    expect(synced.indexOf(setAsideDir(root, 'g1'))).toBeLessThan(synced.lastIndexOf(installPaths(root).journal));
  });

  test('a Go back cut off after its line waits while a listed process runs, and goes on once it ends', async () => {
    await committedSwitch();
    mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
    child('kid', join(dir, 'kid'), 777, 'boot-1');
    await expect(decide(root, { ...ops(), pidAlive: () => LINE_OK() })).rejects.toThrow(/is under way, and it can't go on/);
    let waits = 0;
    const o: LauncherOps = { ...ops(), pidAlive: () => waits < 3, sleep: (ms) => { clock += ms; waits++; } };
    expect(await decide(root, o)).toEqual({ release: '0.10.2', trial: true });
    expect(waits).toBe(3);
  });

  test('a go-back line with no trial-start after it: the next start finishes the restore and starts the older release on trial', async () => {
    await committedSwitch();
    const label = lastCopy(root)!;
    // What a Go back leaves at its line: its list, the copy staged in each
    // directory, and each file's newer content kept.
    const places = label.items.map((i) => ({ ...i, before: i.path === data ? 'dir' : 'file', target: i.path === data ? 'dir' : 'file' }));
    mkdirSync(setAsideDir(root, 'g1'), { recursive: true });
    writeJsonAtomic(join(setAsideDir(root, 'g1'), 'places.json'), { v: 1, places });
    mkdirSync(join(itemStagingDir(data, 'g1'), '..'), { recursive: true });
    copyTree(join(installPaths(root).copy, label.items[0]!.name), itemStagingDir(data, 'g1'));
    mkdirSync(join(setAsideDir(root, 'g1'), 'kept'));
    copyTree(settings, join(setAsideDir(root, 'g1'), 'kept', '1-mcpl-servers.json'));
    appendJournal(root, { at: 'x', step: 'go-back', from: '0.11.0', to: '0.10.2', outcome: 'ok', mark: 'g1', keptData: false });
    // Not while a fleet child runs: its data mustn't change under it.
    child('kid', join(dir, 'kid'), 777, 'boot-1');
    alive.add(777);
    await expect(decide(root, ops())).rejects.toThrow(/The Go back to 0\.10\.2 is under way, and it can't go on: fleet children are still running: kid \(pid 777\)\./);
    expect(store()).toBe('B wrote this');
    alive.delete(777);
    expect(await decide(root, ops())).toEqual({ release: '0.10.2', trial: true });
    expect(store()).toBe('A wrote this');
    expect(read(settings)).toBe('{"a":1}');
    expect(steps().slice(-1)).toEqual(['trial-start ok g1']);
    expect(reports.some((l) => l.includes('Going on with the Go back to 0.10.2'))).toBe(true);
  });
});

describe('leftovers', () => {
  test('a start removes what a request prepared under an id no successful line names, and nothing else', async () => {
    await committedSwitch();
    mkdirSync(join(setAsideDir(root, 'stale'), 'x'), { recursive: true });
    writeJsonAtomic(join(setAsideDir(root, 'stale'), 'places.json'), { v: 1, places: [{ path: data, name: '0-data', before: 'dir', target: 'dir' }] });
    mkdirSync(itemSetAsideDir(data, 'stale'), { recursive: true });
    mkdirSync(itemStagingDir(data, 'stale'), { recursive: true });
    mkdirSync(join(data, ITEM_UPDATE_DIR, 'unrelated'), { recursive: true });
    mkdirSync(installPaths(root).copyTmp, { recursive: true });
    await decide(root, ops());
    expect(existsSync(setAsideDir(root, 'stale'))).toBe(false);
    expect(existsSync(itemSetAsideDir(data, 'stale'))).toBe(false);
    expect(existsSync(itemStagingDir(data, 'stale'))).toBe(false);
    expect(existsSync(installPaths(root).copyTmp)).toBe(false);
    expect(existsSync(join(data, ITEM_UPDATE_DIR, 'unrelated'))).toBe(true);
    expect(lastCopy(root)).not.toBeNull();
  });

  test("a Go back's preparation whose list can't be read stays, every part of it, and the start says where", async () => {
    await committedSwitch();
    mkdirSync(setAsideDir(root, 'stale'), { recursive: true });
    writeFileSync(join(setAsideDir(root, 'stale'), 'places.json'), '{"v":1,"places":"some"}');
    mkdirSync(itemStagingDir(data, 'stale'), { recursive: true });
    await decide(root, ops());
    expect(existsSync(join(setAsideDir(root, 'stale'), 'places.json'))).toBe(true);
    expect(existsSync(itemStagingDir(data, 'stale'))).toBe(true);
    expect(reports.find((l) => l.includes('under mark stale kept stays where it is'))).toContain(`in ${ITEM_UPDATE_DIR}, each named ` +
      `for that mark, with or without .tmp, .filling or .emptying after it; remove them and ${setAsideDir(root, 'stale')}`);
  });

  test("a leftover that can't be removed is said, and the start goes on with the release current names", async () => {
    await committedSwitch();
    mkdirSync(setAsideDir(root, 'stale'), { recursive: true });
    writeJsonAtomic(join(setAsideDir(root, 'stale'), 'places.json'), { v: 1, places: [{ path: data, name: '0-data', before: 'dir', target: 'dir' }] });
    mkdirSync(join(installPaths(root).copyTmp, 'x'), { recursive: true });
    chmodSync(installPaths(root).setAside, 0o555);
    const realRm = fs.rmSync;
    const rm = spyOn(fs, 'rmSync').mockImplementation(((path: fs.PathLike, options?: fs.RmOptions) => {
      if (String(path).startsWith(installPaths(root).copyTmp)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return realRm(path, options);
    }) as typeof fs.rmSync);
    const realRmdir = fs.rmdirSync;
    const rmdir = spyOn(fs, 'rmdirSync').mockImplementation(((path: fs.PathLike, options?: fs.RmDirOptions) => {
      if (String(path).startsWith(installPaths(root).copyTmp)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return realRmdir(path, options);
    }) as typeof fs.rmdirSync);
    try {
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    } finally {
      rm.mockRestore();
      rmdir.mockRestore();
      chmodSync(installPaths(root).setAside, 0o755);
    }
    expect(reports.find((l) => l.includes('Removing what the Go back under mark stale kept, or syncing its removal, failed'))).toContain('a later start tries again');
    expect(reports.find((l) => l.includes('Removing a copy a switch left unfinished'))).toContain('a later start tries again');
    expect(existsSync(setAsideDir(root, 'stale'))).toBe(true);
    // The next start, with nothing in the way, removes both.
    reports = [];
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(existsSync(setAsideDir(root, 'stale'))).toBe(false);
    expect(existsSync(installPaths(root).copyTmp)).toBe(false);
  });

  test("a set-aside directory that can't be listed is said, and nothing in it is removed", async () => {
    await committedSwitch();
    mkdirSync(setAsideDir(root, 'stale'), { recursive: true });
    writeJsonAtomic(join(setAsideDir(root, 'stale'), 'places.json'), { v: 1, places: [{ path: data, name: '0-data', before: 'dir', target: 'dir' }] });
    chmodSync(installPaths(root).setAside, 0o300);
    try {
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    } finally {
      chmodSync(installPaths(root).setAside, 0o755);
    }
    expect(reports.find((l) => l.includes("can't be listed, so it stays for now"))).toContain('EACCES');
    expect(existsSync(join(setAsideDir(root, 'stale'), 'places.json'))).toBe(true);
  });

  test("an area of a Go back's preparation that can't be removed is said, its list stays to name it, and a later start removes both", async () => {
    await committedSwitch();
    mkdirSync(setAsideDir(root, 'stale'), { recursive: true });
    writeJsonAtomic(join(setAsideDir(root, 'stale'), 'places.json'), { v: 1, places: [{ path: data, name: '0-data', before: 'dir', target: 'dir' }] });
    const area = itemSetAsideDir(data, 'stale');
    mkdirSync(area, { recursive: true });
    writeFileSync(join(area, 'kept.txt'), 'kept');
    const failing = (real: (...a: never[]) => unknown) => ((path: fs.PathLike, ...rest: never[]) => {
      if (String(path).startsWith(area)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real(path as never, ...rest);
    });
    const [realRm, realRmdir] = [fs.rmSync, fs.rmdirSync];
    const rm = spyOn(fs, 'rmSync').mockImplementation(failing(realRm as never) as typeof fs.rmSync);
    const rmdir = spyOn(fs, 'rmdirSync').mockImplementation(failing(realRmdir as never) as typeof fs.rmdirSync);
    try {
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    } finally {
      rm.mockRestore();
      rmdir.mockRestore();
    }
    expect(reports.find((l) => l.includes('Removing what the Go back under mark stale kept, or syncing its removal, failed'))).toContain('a later start tries again');
    expect(existsSync(join(setAsideDir(root, 'stale'), 'places.json'))).toBe(true);
    expect(existsSync(area)).toBe(true);
    reports = [];
    expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    expect(existsSync(area)).toBe(false);
    expect(existsSync(setAsideDir(root, 'stale'))).toBe(false);
  });

  test("a Go back whose earlier preparation a start couldn't clear is refused, saying so", async () => {
    await committedSwitch();
    mkdirSync(setAsideDir(root, 'g1'), { recursive: true });
    writeJsonAtomic(join(setAsideDir(root, 'g1'), 'places.json'), { v: 1, places: [{ path: data, name: '0-data', before: 'dir', target: 'dir' }] });
    const area = itemSetAsideDir(data, 'g1');
    mkdirSync(area, { recursive: true });
    const [realRm, realRmdir] = [fs.rmSync, fs.rmdirSync];
    const failing = (real: (...a: never[]) => unknown) => ((path: fs.PathLike, ...rest: never[]) => {
      if (String(path).startsWith(area)) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real(path as never, ...rest);
    });
    const rm = spyOn(fs, 'rmSync').mockImplementation(failing(realRm as never) as typeof fs.rmSync);
    const rmdir = spyOn(fs, 'rmdirSync').mockImplementation(failing(realRmdir as never) as typeof fs.rmdirSync);
    try {
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
      mark({ id: 'g1', to: '0.10.2', why: 'go-back' });
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    } finally {
      rm.mockRestore();
      rmdir.mockRestore();
    }
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(
      `an earlier attempt's preparation under mark g1 is still at ${setAsideDir(root, 'g1')}, since a start couldn't clear it`);
    expect(reports.find((l) => l.includes("didn't go ahead"))).toContain(`Remove it, and its areas inside each directory the update ` +
      `copies, in ${ITEM_UPDATE_DIR}, each named for that mark, with or without .tmp, .filling or .emptying after it`);
  });

  test("a leftover preparation whose areas' removal can't be synced keeps its list, and the start says so", async () => {
    await committedSwitch();
    mkdirSync(setAsideDir(root, 'stale'), { recursive: true });
    writeJsonAtomic(join(setAsideDir(root, 'stale'), 'places.json'), { v: 1, places: [{ path: data, name: '0-data', before: 'dir', target: 'dir' }] });
    mkdirSync(itemSetAsideDir(data, 'stale'), { recursive: true });
    const parent = dirname(itemSetAsideDir(data, 'stale'));
    chmodSync(parent, 0o300);
    try {
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    } finally {
      chmodSync(parent, 0o755);
    }
    expect(reports.find((l) => l.includes('Removing what the Go back under mark stale kept, or syncing its removal, failed'))).toContain('EACCES');
    expect(existsSync(join(setAsideDir(root, 'stale'), 'places.json'))).toBe(true);
  });

  test("a leftover preparation's areas are removed, and their removal synced, before its list goes", async () => {
    await committedSwitch();
    const list = join(setAsideDir(root, 'stale'), 'places.json');
    mkdirSync(setAsideDir(root, 'stale'), { recursive: true });
    writeJsonAtomic(list, { v: 1, places: [{ path: data, name: '0-data', before: 'dir', target: 'dir' }] });
    const aside = itemSetAsideDir(data, 'stale');
    const staging = itemStagingDir(data, 'stale');
    mkdirSync(aside, { recursive: true });
    mkdirSync(`${staging}.filling`, { recursive: true });
    // At each sync of an area's directory: whether the area is still there, and the list.
    const seen = new Map<string, { area: boolean; list: boolean }>();
    const synced = await syncedDuring(() => decide(root, ops()), (path) => {
      if (path === dirname(aside)) seen.set(path, { area: existsSync(aside), list: existsSync(list) });
      if (path === dirname(staging)) seen.set(path, { area: existsSync(`${staging}.filling`), list: existsSync(list) });
    });
    expect(synced).toContain(dirname(aside));
    expect(synced).toContain(dirname(staging));
    expect([...seen.values()]).toEqual([{ area: false, list: true }, { area: false, list: true }]);
    expect(existsSync(setAsideDir(root, 'stale'))).toBe(false);
  });

  test("one whose directory the system won't search stays too, and the start says so", async () => {
    await committedSwitch();
    mkdirSync(setAsideDir(root, 'stale'), { recursive: true });
    writeFileSync(join(setAsideDir(root, 'stale'), 'places.json'), '{"v":1,"places":[]}');
    chmodSync(setAsideDir(root, 'stale'), 0o600);
    try {
      expect(await decide(root, ops())).toEqual({ release: '0.11.0', trial: false });
    } finally {
      chmodSync(setAsideDir(root, 'stale'), 0o755);
    }
    expect(reports.find((l) => l.includes('under mark stale kept stays where it is'))).toContain('EACCES');
  });

  test("one whose list the system won't read stays too, and the start says where", async () => {
    await committedSwitch();
    const list = join(setAsideDir(root, 'stale'), 'places.json');
    mkdirSync(setAsideDir(root, 'stale'), { recursive: true });
    writeFileSync(list, '{"v":1,"places":[]}');
    chmodSync(list, 0o000);
    mkdirSync(itemStagingDir(data, 'stale'), { recursive: true });
    try {
      await decide(root, ops());
    } finally {
      chmodSync(list, 0o644);
    }
    expect(existsSync(itemStagingDir(data, 'stale'))).toBe(true);
    expect(reports.find((l) => l.includes('under mark stale kept stays where it is'))).toContain('EACCES');
  });
});
