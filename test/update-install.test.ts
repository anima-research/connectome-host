/**
 * Installing a release beside the running one (src/update/install.ts). Each
 * test builds an install root whose running release holds a package.json,
 * a lockfile and the host, stands in for the package manager with one that
 * writes the host it was asked for, and reads what the install left.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContractError, copyLabelPath, installPaths, moveCurrent, releaseDir, writeJsonAtomic, type CopyLabel, type Mark,
} from '../src/update/contract.js';
import { installRelease, machineInstallOps, type InstallOps } from '../src/update/install.js';
import { HOST_ENTRY, LAUNCHER, RELEASE_HOST } from '../src/update/launcher.js';

let dir: string;
let root: string;
let said: string[];
let calls: Array<{ manager: string; args: string[]; cwd: string; files: Record<string, string> }>;

const here = () => ({ root, release: '0.11.0' });
const RUNNING_PACKAGE = '{"dependencies":{"@animalabs/connectome-host":"^0.11.0"}}\n';
const RUNNING_LOCK = '{"lockfileVersion":3,"of":"0.11.0"}\n';

/** A release in the root, its host at `version`, with the files named beside it. */
function release(name: string, version = name, files: Record<string, string> = {}): string {
  const path = releaseDir(root, name);
  mkdirSync(join(path, RELEASE_HOST, 'src', 'update'), { recursive: true });
  writeFileSync(join(path, RELEASE_HOST, 'package.json'), JSON.stringify({ name: '@animalabs/connectome-host', version }));
  writeFileSync(join(path, HOST_ENTRY), '// host\n');
  writeFileSync(join(path, LAUNCHER), '// launcher\n');
  for (const [file, text] of Object.entries(files)) writeFileSync(join(path, file), text);
  return path;
}

/** A package manager that installs the host the last argument asks for, and
 *  pins it in package.json as npm and bun do, unless `outcome` says
 *  otherwise. Each call records what it was given: the files in its
 *  directory, with their bytes. */
function manager(outcome: {
  status?: number | null; output?: string; version?: string; manifest?: string | null; entry?: boolean; launcher?: boolean;
  files?: number;
} = {}): InstallOps {
  return {
    run: async (manager, args, cwd) => {
      const files: Record<string, string> = {};
      for (const name of readdirSync(cwd).sort()) files[name] = readFileSync(join(cwd, name), 'utf-8');
      calls.push({ manager, args, cwd, files });
      const status = outcome.status === undefined ? 0 : outcome.status;
      if (status === 0) {
        const asked = args[args.length - 1]!.replace('@animalabs/connectome-host@', '');
        const pkg = JSON.parse(files['package.json']!) as { dependencies?: Record<string, string> };
        writeFileSync(join(cwd, 'package.json'),
          JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, '@animalabs/connectome-host': asked } }));
        const host = join(cwd, RELEASE_HOST);
        mkdirSync(join(host, 'src', 'update'), { recursive: true });
        if (outcome.manifest !== null) {
          writeFileSync(join(host, 'package.json'), outcome.manifest ?? JSON.stringify({ version: outcome.version ?? asked }));
        }
        if (outcome.entry !== false) writeFileSync(join(cwd, HOST_ENTRY), '// host\n');
        if (outcome.launcher !== false) writeFileSync(join(cwd, LAUNCHER), '// launcher\n');
        if (outcome.files) {
          mkdirSync(join(cwd, 'node_modules', 'many'));
          for (let i = 0; i < outcome.files; i++) writeFileSync(join(cwd, 'node_modules', 'many', `f${i}`), `${i}`);
        }
      }
      return { status, output: outcome.output ?? '' };
    },
    report: (line) => { said.push(line); },
  };
}

/** A copy whose label says it holds the data of `from`. */
function copyFrom(from: string): void {
  const { copy } = installPaths(root);
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, '0-data'), '');
  writeJsonAtomic(copyLabelPath(copy), { v: 1, from, at: new Date().toISOString(), items: [{ path: '/srv/data', name: '0-data' }] } satisfies CopyLabel);
}

/** Make fs/promises' rm of `path` fail as a busy directory does, until the spy is restored. */
function failRm(path: string) {
  const rm = fsp.rm;
  return spyOn(fsp, 'rm').mockImplementation((async (target: fs.PathLike, options?: fs.RmOptions) => {
    if (String(target) === path) throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${path}'`), { code: 'EBUSY' });
    return rm(target, options);
  }) as typeof fsp.rm);
}

/** Spy on renames, syncs and removals in order, for the length of `body`: a
 *  sync call's fsync as `sync`, and through fs/promises a sync once it has
 *  completed as `synced`, and its handle's close as `closed`. */
async function steps(body: () => Promise<void>): Promise<string[]> {
  const paths = new Map<number, string>();
  const seen: string[] = [];
  const realOpen = fs.openSync;
  const realFsync = fs.fsyncSync;
  const realRename = fs.renameSync;
  const realUnlink = fs.unlinkSync;
  const realOpenP = fsp.open;
  const realRm = fsp.rm;
  const spies = [
    spyOn(fs, 'openSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      const fd = (realOpen as (...args: unknown[]) => number)(path, ...rest);
      paths.set(fd, String(path));
      return fd;
    }) as typeof fs.openSync),
    spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
      seen.push(`sync ${paths.get(fd) ?? fd}`);
      realFsync(fd);
    }) as typeof fs.fsyncSync),
    spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      seen.push(`rename ${from}`);
      realRename(from, to);
    }) as typeof fs.renameSync),
    spyOn(fs, 'unlinkSync').mockImplementation(((path: fs.PathLike) => {
      seen.push(`unlink ${path}`);
      realUnlink(path);
    }) as typeof fs.unlinkSync),
    spyOn(fsp, 'open').mockImplementation((async (path: fs.PathLike, ...rest: unknown[]) => {
      const handle = await (realOpenP as (...args: unknown[]) => Promise<fsp.FileHandle>)(path, ...rest);
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      handle.sync = async () => {
        await sync();
        seen.push(`synced ${path}`);
      };
      handle.close = async () => {
        await close();
        seen.push(`closed ${path}`);
      };
      return handle;
    }) as typeof fsp.open),
    spyOn(fsp, 'rm').mockImplementation((async (path: fs.PathLike, options?: fs.RmOptions) => {
      seen.push(`rm ${path}`);
      return realRm(path, options);
    }) as typeof fsp.rm),
  ];
  try {
    await body();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return seen;
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'update-install-')));
  root = join(dir, 'connectome-host');
  release('0.11.0', '0.11.0', { 'package.json': RUNNING_PACKAGE, 'package-lock.json': RUNNING_LOCK });
  moveCurrent(root, '0.11.0');
  // A labelled copy, as there is from an install's first switch on.
  copyFrom('0.11.0');
  said = [];
  calls = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const installed = () => readdirSync(installPaths(root).releases).sort();
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected a refusal'); }, (e: unknown) => e as Error);

/** Run `body` with a PATH that finds nothing, so only what the ops find
 *  without it can start. */
async function withoutPath(body: () => Promise<void>): Promise<void> {
  const path = process.env.PATH;
  process.env.PATH = join(dir, 'nothing-here');
  try {
    await body();
  } finally {
    process.env.PATH = path;
  }
}

describe('installing a release beside the running one', () => {
  test('installs the exact version with npm from the running release\'s package.json and lockfile, then renames it in', async () => {
    await installRelease(here(), '0.12.0', manager());
    expect(calls).toEqual([{
      manager: 'npm',
      args: ['install', '--save-exact', '--no-audit', '--no-fund', '@animalabs/connectome-host@0.12.0'],
      cwd: `${releaseDir(root, '0.12.0')}.tmp`,
      files: { 'package-lock.json': RUNNING_LOCK, 'package.json': RUNNING_PACKAGE },
    }]);
    expect(installed()).toEqual(['0.11.0', '0.12.0']);
    expect(JSON.parse(readFileSync(join(releaseDir(root, '0.12.0'), RELEASE_HOST, 'package.json'), 'utf-8')).version).toBe('0.12.0');
    expect(JSON.parse(readFileSync(join(releaseDir(root, '0.12.0'), 'package.json'), 'utf-8')).dependencies)
      .toEqual({ '@animalabs/connectome-host': '0.12.0' });
  });

  test('takes the running release\'s package.json and lockfile when current names another', async () => {
    release('0.10.2', '0.10.2', { 'package.json': '{"of":"0.10.2"}\n', 'package-lock.json': '{"of":"0.10.2"}\n' });
    moveCurrent(root, '0.10.2');
    await installRelease(here(), '0.12.0', manager());
    expect(calls.map(({ files }) => files)).toEqual([{ 'package-lock.json': RUNNING_LOCK, 'package.json': RUNNING_PACKAGE }]);
  });

  test('uses bun when the running release holds only a bun lockfile', async () => {
    rmSync(join(releaseDir(root, '0.11.0'), 'package-lock.json'));
    writeFileSync(join(releaseDir(root, '0.11.0'), 'bun.lock'), '{"bun":"text"}\n');
    await installRelease(here(), '0.12.0', manager());
    expect(calls.map(({ manager, args, files }) => ({ manager, args, files }))).toEqual([{
      manager: 'bun', args: ['add', '--exact', '@animalabs/connectome-host@0.12.0'],
      files: { 'bun.lock': '{"bun":"text"}\n', 'package.json': RUNNING_PACKAGE },
    }]);
    expect(installed()).toEqual(['0.11.0', '0.12.0']);
  });

  test('a binary bun lockfile means bun too', async () => {
    rmSync(join(releaseDir(root, '0.11.0'), 'package-lock.json'));
    writeFileSync(join(releaseDir(root, '0.11.0'), 'bun.lockb'), 'binary lock');
    await installRelease(here(), '0.12.0', manager());
    expect(calls.map(({ manager, files }) => ({ manager, files })))
      .toEqual([{ manager: 'bun', files: { 'bun.lockb': 'binary lock', 'package.json': RUNNING_PACKAGE } }]);
  });

  test('with both bun lockfiles, the text one alone', async () => {
    rmSync(join(releaseDir(root, '0.11.0'), 'package-lock.json'));
    writeFileSync(join(releaseDir(root, '0.11.0'), 'bun.lock'), '{"bun":"text"}\n');
    writeFileSync(join(releaseDir(root, '0.11.0'), 'bun.lockb'), 'binary lock');
    await installRelease(here(), '0.12.0', manager());
    expect(calls.map(({ manager, files }) => ({ manager, files })))
      .toEqual([{ manager: 'bun', files: { 'bun.lock': '{"bun":"text"}\n', 'package.json': RUNNING_PACKAGE } }]);
  });

  test('with npm\'s and bun\'s lockfiles, npm and its lockfile alone', async () => {
    writeFileSync(join(releaseDir(root, '0.11.0'), 'bun.lock'), '{"bun":"text"}\n');
    await installRelease(here(), '0.12.0', manager());
    expect(calls.map(({ manager, files }) => ({ manager, files })))
      .toEqual([{ manager: 'npm', files: { 'package-lock.json': RUNNING_LOCK, 'package.json': RUNNING_PACKAGE } }]);
  });

  test('with no lockfile, npm from the package.json alone', async () => {
    rmSync(join(releaseDir(root, '0.11.0'), 'package-lock.json'));
    await installRelease(here(), '0.12.0', manager());
    expect(calls.map(({ manager, files }) => ({ manager, files }))).toEqual([{ manager: 'npm', files: { 'package.json': RUNNING_PACKAGE } }]);
  });

  test('a manager that fails leaves nothing, and the refusal quotes the command, its exit and the end of its output', async () => {
    const output = `${'x'.repeat(3000)}\nnpm error notarget No matching version found for @animalabs/connectome-host@0.12.0.\n`;
    const error = await failure(installRelease(here(), '0.12.0', manager({ status: 1, output })));
    expect(error).toBeInstanceOf(ContractError);
    expect(error.message).toStartWith("Installing 0.12.0 failed, so it isn't installed: `npm install --save-exact --no-audit " +
      '--no-fund @animalabs/connectome-host@0.12.0` exited 1. Its output ends:\n…');
    expect(error.message.endsWith('No matching version found for @animalabs/connectome-host@0.12.0.')).toBe(true);
    expect(error.message.length).toBeLessThan(2300);
    expect(installed()).toEqual(['0.11.0']);
  });

  test('npm with no exit status says it couldn\'t start or was stopped, and where npm is looked for', async () => {
    const error = await failure(installRelease(here(), '0.12.0', manager({ status: null, output: 'Executable not found in $PATH: "npm"' })));
    expect(error.message).toContain("`npm install --save-exact --no-audit --no-fund @animalabs/connectome-host@0.12.0` gave no " +
      "exit status, so it couldn't start or was stopped by a signal (if its output says npm isn't in the PATH, as Bun's " +
      '"Executable not found in $PATH" does, the service that runs the host needs a PATH that has npm). Its output ends:\n' +
      'Executable not found in $PATH: "npm"');
    expect(installed()).toEqual(['0.11.0']);
  });

  test('bun with no exit status names no PATH, since it\'s the Bun running the host', async () => {
    rmSync(join(releaseDir(root, '0.11.0'), 'package-lock.json'));
    writeFileSync(join(releaseDir(root, '0.11.0'), 'bun.lock'), '{}\n');
    const error = await failure(installRelease(here(), '0.12.0', manager({ status: null, output: 'killed' })));
    expect(error.message).toContain("gave no exit status, so it couldn't start or was stopped by a signal. Its output ends:\nkilled");
  });

  test('a failed install whose tmp can\'t be removed refuses with the manager\'s failure, and says so', async () => {
    const tmp = `${releaseDir(root, '0.12.0')}.tmp`;
    const spy = failRm(tmp);
    let error: Error;
    try {
      error = await failure(installRelease(here(), '0.12.0', manager({ status: 1, output: 'ETARGET' })));
    } finally {
      spy.mockRestore();
    }
    expect(error).toBeInstanceOf(ContractError);
    expect(error.message).toContain('exited 1. Its output ends:\nETARGET');
    expect(said).toEqual([`[update] ${tmp}, the install that failed, couldn't be removed, and the next install removes it: ` +
      `EBUSY: resource busy or locked, rmdir '${tmp}'`]);
  });

  test('a host at another version is refused, and nothing is put in place', async () => {
    const error = await failure(installRelease(here(), '0.12.0', manager({ version: '0.12.1' })));
    expect(error).toBeInstanceOf(ContractError);
    expect(error.message).toBe('Installing 0.12.0 with `npm install --save-exact --no-audit --no-fund ' +
      "@animalabs/connectome-host@0.12.0` didn't put its host in place: its host is 0.12.1, so it isn't installed.");
    expect(installed()).toEqual(['0.11.0']);
  });

  test('a host whose package.json isn\'t there, can\'t be read or names no version is refused', async () => {
    const manifest = join(`${releaseDir(root, '0.12.0')}.tmp`, RELEASE_HOST, 'package.json');
    const cases: Array<[string | null, RegExp]> = [
      [null, new RegExp(`didn't put its host in place: ${manifest.replace(/[.]/g, '\\.')} isn't there, so`)],
      ['{not json', /didn't put its host in place: .*package\.json can't be read \(.*\), so/],
      ['{"version":12}', /didn't put its host in place: .*package\.json names no version, so/],
      ['null', /didn't put its host in place: .*package\.json names no version, so/],
    ];
    for (const [text, expected] of cases) {
      const error = await failure(installRelease(here(), '0.12.0', manager({ manifest: text })));
      expect(error).toBeInstanceOf(ContractError);
      expect(error.message).toMatch(expected);
    }
    expect(installed()).toEqual(['0.11.0']);
  });

  test('a host without its entry, or without its launcher, is refused', async () => {
    const tmp = `${releaseDir(root, '0.12.0')}.tmp`;
    const entry = await failure(installRelease(here(), '0.12.0', manager({ entry: false })));
    expect(entry.message).toContain(`didn't put its host in place: ${join(tmp, HOST_ENTRY)} isn't there, so`);
    const launcher = await failure(installRelease(here(), '0.12.0', manager({ launcher: false })));
    expect(launcher.message).toContain(`didn't put its host in place: ${join(tmp, LAUNCHER)} isn't there, so`);
    expect(installed()).toEqual(['0.11.0']);
  });

  test('a release already in place is kept, and nothing is installed', async () => {
    release('0.12.0');
    await installRelease(here(), '0.12.0', manager());
    expect(calls).toEqual([]);
    expect(said).toEqual([`[update] 0.12.0 is already installed in ${releaseDir(root, '0.12.0')}, so it isn't installed again.`]);
  });

  test('a release in place whose host isn\'t that version\'s is refused, and stays', async () => {
    release('0.12.0', '0.12.0-rc.1');
    const error = await failure(installRelease(here(), '0.12.0', manager()));
    expect(error).toBeInstanceOf(ContractError);
    expect(error.message).toBe(`${releaseDir(root, '0.12.0')} is there, but its host is 0.12.0-rc.1, so it isn't the release ` +
      '0.12.0. Remove it, then update again.');
    rmSync(join(releaseDir(root, '0.12.0'), LAUNCHER));
    writeFileSync(join(releaseDir(root, '0.12.0'), RELEASE_HOST, 'package.json'), '{"version":"0.12.0"}');
    const launcher = await failure(installRelease(here(), '0.12.0', manager()));
    expect(launcher.message).toContain(`but ${join(releaseDir(root, '0.12.0'), LAUNCHER)} isn't there, so it isn't the release`);
    expect(calls).toEqual([]);
    expect(installed()).toEqual(['0.11.0', '0.12.0']);
  });

  test('a dangling link where the release would be is refused by the host check, before any manager runs', async () => {
    symlinkSync(join(dir, 'gone'), releaseDir(root, '0.12.0'));
    const error = await failure(installRelease(here(), '0.12.0', manager()));
    expect(error).toBeInstanceOf(ContractError);
    expect(error.message).toBe(`${releaseDir(root, '0.12.0')} is there, but ` +
      `${join(releaseDir(root, '0.12.0'), RELEASE_HOST, 'package.json')} isn't there, so it isn't the release 0.12.0. Remove it, ` +
      'then update again.');
    expect(calls).toEqual([]);
  });

  test('links the manager wrote are left to their directory\'s sync, a dangling one included', async () => {
    const tmp = `${releaseDir(root, '0.12.0')}.tmp`;
    const linking = manager();
    const run = linking.run;
    linking.run = async (...args) => {
      const ran = await run(...args);
      mkdirSync(join(tmp, 'node_modules', '.bin'), { recursive: true });
      symlinkSync('../@animalabs/connectome-host/src/index.ts', join(tmp, 'node_modules', '.bin', 'host'));
      symlinkSync('../nowhere', join(tmp, 'node_modules', '.bin', 'dangling'));
      return ran;
    };
    const seen = await steps(() => installRelease(here(), '0.12.0', linking));
    expect(seen.filter((step) => step.includes('.bin/'))).toEqual([]);
    expect(seen).toContain(`synced ${join(tmp, 'node_modules', '.bin')}`);
    expect(installed()).toEqual(['0.11.0', '0.12.0']);
  });

  test('with the machine\'s own manager and no npm to be found, the refusal says so', async () => {
    await withoutPath(async () => {
      const error = await failure(installRelease(here(), '0.12.0'));
      expect(error).toBeInstanceOf(ContractError);
      expect(error.message).toEndWith('(if its output says npm isn\'t in the PATH, as Bun\'s "Executable not found in $PATH" ' +
        'does, the service that runs the host needs a PATH that has npm). Its output ends:\nExecutable not found in $PATH: "npm"');
    });
    expect(installed()).toEqual(['0.11.0']);
  });

  test('refuses a version that isn\'t exact, one ending in .tmp, and the release running, before anything', async () => {
    release('0.9.0');
    copyFrom('0.11.0');
    for (const version of ['latest', '^0.12.0', '0.12', '0.12.0+build', '../0.12.0', '0.12.0 ']) {
      const error = await failure(installRelease(here(), version, manager()));
      expect(error).toBeInstanceOf(ContractError);
      expect(error.message).toBe(`${JSON.stringify(version)} isn't an exact version of @animalabs/connectome-host, such as 0.12.0.`);
    }
    const working = await failure(installRelease(here(), '0.12.0-rc.tmp', manager()));
    expect(working.message).toBe("0.12.0-rc.tmp ends in .tmp, which names unfinished work in releases/, so it can't be " +
      'installed here.');
    const running = await failure(installRelease(here(), '0.11.0', manager()));
    expect(running.message).toBe('This host already runs 0.11.0.');
    expect(calls).toEqual([]);
    expect(installed()).toEqual(['0.11.0', '0.9.0']);
  });

  test('syncs every file and directory it installed before its rename, and the releases directory after', async () => {
    const tmp = `${releaseDir(root, '0.12.0')}.tmp`;
    const seen = await steps(() => installRelease(here(), '0.12.0', manager({ files: 40 })));
    const at = (step: string) => seen.indexOf(step);
    const renamed = at(`rename ${tmp}`);
    for (const path of [join(tmp, 'package.json'), join(tmp, 'package-lock.json'), join(tmp, HOST_ENTRY), join(tmp, LAUNCHER),
      join(tmp, RELEASE_HOST, 'package.json'), join(tmp, RELEASE_HOST, 'src', 'update'), join(tmp, 'node_modules'), tmp]) {
      expect(at(`synced ${path}`)).toBeGreaterThan(-1);
      expect(at(`synced ${path}`)).toBeLessThan(renamed);
    }
    // More entries than SYNC_WIDTH, each synced through fs/promises and its handle closed, all before the rename,
    // and no entry of the tree by a sync call.
    const extra = Array.from({ length: 40 }, (_, i) => join(tmp, 'node_modules', 'many', `f${i}`));
    for (const path of extra) {
      expect(at(`synced ${path}`)).toBeGreaterThan(-1);
      expect(at(`synced ${path}`)).toBeLessThan(renamed);
    }
    const synced = seen.filter((step) => step.startsWith('synced '));
    expect(synced.length).toBeGreaterThan(40);
    for (const step of synced) {
      expect(at(step.replace('synced', 'closed'))).toBeGreaterThan(-1);
      expect(at(step.replace('synced', 'closed'))).toBeLessThan(renamed);
    }
    expect(seen.filter((step) => step.startsWith(`sync ${tmp}`))).toEqual([]);
    expect(seen.slice(renamed + 1)).toEqual([`sync ${installPaths(root).releases}`]);
  });

  test('a sync that fails leaves no tmp, and throws its own error', async () => {
    const tmp = `${releaseDir(root, '0.12.0')}.tmp`;
    const open = fsp.open;
    const spy = spyOn(fsp, 'open').mockImplementation((async (path: fs.PathLike, ...rest: unknown[]) => {
      if (String(path) === join(tmp, HOST_ENTRY)) throw Object.assign(new Error('EIO: i/o error, open'), { code: 'EIO' });
      return (open as (...a: unknown[]) => Promise<fsp.FileHandle>)(path, ...rest);
    }) as typeof fsp.open);
    let error: Error;
    try {
      error = await failure(installRelease(here(), '0.12.0', manager()));
    } finally {
      spy.mockRestore();
    }
    expect(error).not.toBeInstanceOf(ContractError);
    expect(error.message).toBe('EIO: i/o error, open');
    await Bun.sleep(50);
    expect(installed()).toEqual(['0.11.0']);
  });

  test('a reuse syncs the releases directory, so a retry makes the sync a failed call didn\'t', async () => {
    release('0.12.0');
    const seen = await steps(() => installRelease(here(), '0.12.0', manager()));
    expect(seen).toEqual([`sync ${installPaths(root).releases}`]);
  });

  test('takes a prerelease', async () => {
    await installRelease(here(), '0.13.0-rc.1', manager());
    expect(installed()).toEqual(['0.11.0', '0.13.0-rc.1']);
  });

  test('runs one install at a time', async () => {
    let finish!: () => void;
    let entered!: () => void;
    const inRun = new Promise<void>((done) => { entered = done; });
    const slow = manager();
    const run = slow.run;
    slow.run = async (...args) => {
      entered();
      await new Promise<void>((done) => { finish = done; });
      return run(...args);
    };
    const first = installRelease(here(), '0.12.0', slow);
    try {
      await inRun;
      const second = await failure(installRelease(here(), '0.12.1', manager()));
      expect(second.message).toBe('An install of 0.12.0 is under way. Wait for it to end, or restart the host to end one ' +
        'that hangs, then ask again.');
    } finally {
      finish();
      await first;
    }
    await installRelease(here(), '0.12.1', manager());
    // 0.12.0 went, since nothing names it.
    expect(installed()).toEqual(['0.11.0', '0.12.1']);
  });

  test('an install that failed doesn\'t hold the next one back', async () => {
    const error = await failure(installRelease(here(), '0.12.0', manager({ status: 1 })));
    expect(error.message).toContain('exited 1');
    expect(installed()).toEqual(['0.11.0']);
    await installRelease(here(), '0.12.0', manager());
    expect(installed()).toEqual(['0.11.0', '0.12.0']);
  });
});

describe('removing releases nothing needs', () => {
  test('keeps current, the running release, the copy\'s, the mark\'s and the one being installed; removes the rest and cut installs', async () => {
    for (const name of ['0.9.0', '0.10.0', '0.10.2', '0.13.0']) release(name);
    mkdirSync(join(installPaths(root).releases, 'notes'));
    mkdirSync(join(installPaths(root).releases, '0.12.0.tmp', 'node_modules'), { recursive: true });
    // A removal of 0.10.0 cut short, beside the release itself, and one of 0.8.0 that hadn't started.
    mkdirSync(join(installPaths(root).releases, '0.10.0.tmp', 'node_modules'), { recursive: true });
    release('0.8.0.tmp');
    copyFrom('0.10.2');
    writeJsonAtomic(installPaths(root).mark, { v: 1, id: 'b9c3a1de-0000-4000-8000-000000000000', to: '0.13.0', why: 'update', at: new Date().toISOString() } satisfies Mark);
    await installRelease(here(), '0.12.0', manager());
    expect(installed()).toEqual(['0.10.2', '0.11.0', '0.12.0', '0.13.0', 'notes']);
    expect(said).toEqual([]);
  });

  test('keeps the running release when current names another, as on a trial', async () => {
    release('0.10.2');
    release('0.9.0');
    moveCurrent(root, '0.10.2');
    copyFrom('0.10.2');
    await installRelease(here(), '0.12.0', manager());
    expect(installed()).toEqual(['0.10.2', '0.11.0', '0.12.0']);
  });

  test('keeps current on a Go back\'s trial, which runs the release the copy holds the data of', async () => {
    release('0.12.0');
    release('0.9.0');
    moveCurrent(root, '0.12.0');
    copyFrom('0.11.0');
    await installRelease(here(), '0.13.0', manager());
    expect(installed()).toEqual(['0.11.0', '0.12.0', '0.13.0']);
  });

  test('keeps a kept release whose name ends in .tmp', async () => {
    release('0.11.0-rc.tmp', '0.11.0-rc.tmp', { 'package.json': RUNNING_PACKAGE });
    moveCurrent(root, '0.11.0-rc.tmp');
    copyFrom('0.11.0-rc.tmp');
    await installRelease({ root, release: '0.11.0-rc.tmp' }, '0.12.0', manager());
    expect(installed()).toEqual(['0.11.0-rc.tmp', '0.12.0']);
  });

  test('with no copy\'s label, a label naming no release, or no current, removes no release, only what cuts left, and says why', async () => {
    release('0.9.0');
    rmSync(installPaths(root).copy, { recursive: true });
    mkdirSync(join(installPaths(root).releases, '0.9.1.tmp'));
    await installRelease(here(), '0.12.0', manager());
    expect(installed()).toEqual(['0.11.0', '0.12.0', '0.9.0']);
    expect(said).toEqual(["[update] No older release is removed this time: the copy's label isn't there, since no switch " +
      'has taken a copy yet or it was lost, so nothing says which release a Go back needs.']);
    copyFrom('0.11.0');
    const label = copyLabelPath(installPaths(root).copy);
    const fromless = JSON.parse(readFileSync(label, 'utf-8')) as Record<string, unknown>;
    delete fromless.from;
    writeJsonAtomic(label, fromless);
    said = [];
    await installRelease(here(), '0.12.1', manager());
    expect(installed()).toEqual(['0.11.0', '0.12.0', '0.12.1', '0.9.0']);
    expect(said).toEqual([`[update] No older release is removed this time: the copy's label at ${label} names no release.`]);
    copyFrom('0.11.0');
    unlinkSync(installPaths(root).current);
    mkdirSync(join(installPaths(root).releases, '0.9.1.tmp'));
    said = [];
    await installRelease(here(), '0.12.2', manager());
    expect(installed()).toEqual(['0.11.0', '0.12.0', '0.12.1', '0.12.2', '0.9.0']);
    expect(said).toEqual([`[update] No older release is removed this time: ${installPaths(root).current} isn't there.`]);
  });

  test('a mark that can\'t be read leaves current\'s and the copy\'s names kept', async () => {
    release('0.11.0-rc.tmp', '0.11.0-rc.tmp', { 'package.json': RUNNING_PACKAGE });
    release('0.10.0-rc.tmp');
    moveCurrent(root, '0.11.0-rc.tmp');
    copyFrom('0.10.0-rc.tmp');
    writeJsonAtomic(installPaths(root).mark, { v: 1, id: '../x', to: '0.13.0', why: 'update', at: new Date().toISOString() });
    await installRelease(here(), '0.12.0', manager());
    expect(installed()).toEqual(['0.10.0-rc.tmp', '0.11.0', '0.11.0-rc.tmp', '0.12.0']);
    expect(said[0]).toContain('No older release is removed this time');
  });

  test('a refused request removes nothing, and a reuse still removes what nothing needs', async () => {
    release('0.9.0');
    copyFrom('0.11.0');
    await failure(installRelease(here(), '0.11.0', manager()));
    await failure(installRelease(here(), 'latest', manager()));
    expect(installed()).toEqual(['0.11.0', '0.9.0']);
    release('0.12.0');
    await installRelease(here(), '0.12.0', manager());
    expect(calls).toEqual([]);
    expect(installed()).toEqual(['0.11.0', '0.12.0']);
  });

  test('removes no release when the copy\'s label can\'t be read, still removes what cuts left, and installs', async () => {
    release('0.9.0');
    mkdirSync(join(installPaths(root).releases, '0.12.0.tmp'));
    copyFrom('0.10.2');
    writeFileSync(copyLabelPath(installPaths(root).copy), '{"v":1,"from":"0.10.2","items":[]}');
    await installRelease(here(), '0.12.0', manager());
    expect(installed()).toEqual(['0.11.0', '0.12.0', '0.9.0']);
    expect(said).toHaveLength(1);
    expect(said[0]).toStartWith("[update] No older release is removed this time: which releases a start, a Go back or a " +
      "request needs can't be told (The copy's label at ");
  });

  test('removes no release when the mark can\'t be used, or current can\'t be read', async () => {
    release('0.9.0');
    copyFrom('0.11.0');
    writeJsonAtomic(installPaths(root).mark, { v: 1, id: '../x', to: '0.13.0', why: 'update', at: new Date().toISOString() });
    await installRelease(here(), '0.12.0', manager());
    expect(installed()).toEqual(['0.11.0', '0.12.0', '0.9.0']);
    expect(said[0]).toContain('No older release is removed this time');
    rmSync(installPaths(root).mark);
    unlinkSync(installPaths(root).current);
    writeFileSync(installPaths(root).current, 'not a link');
    said = [];
    await installRelease(here(), '0.12.1', manager());
    expect(installed()).toEqual(['0.11.0', '0.12.0', '0.12.1', '0.9.0']);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('No older release is removed this time');
  });

  test('a releases directory that can\'t be listed is said, and the install goes on', async () => {
    release('0.9.0');
    copyFrom('0.11.0');
    const releases = installPaths(root).releases;
    const readdir = fs.readdirSync;
    const spy = spyOn(fs, 'readdirSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      if (String(path) === releases) throw Object.assign(new Error(`EACCES: permission denied, scandir '${releases}'`), { code: 'EACCES' });
      return (readdir as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readdirSync);
    try {
      await installRelease(here(), '0.12.0', manager());
    } finally {
      spy.mockRestore();
    }
    expect(said).toEqual([`[update] Nothing in ${releases} is removed this time: it can't be listed (EACCES: permission denied, ` +
      `scandir '${releases}').`]);
    expect(installed()).toEqual(['0.11.0', '0.12.0', '0.9.0']);
  });

  test('a release is renamed aside, and the rename synced, before anything under it is removed', async () => {
    release('0.9.0');
    copyFrom('0.11.0');
    const aside = `${releaseDir(root, '0.9.0')}.tmp`;
    const seen = await steps(() => installRelease(here(), '0.12.0', manager()));
    const renamed = seen.indexOf(`rename ${releaseDir(root, '0.9.0')}`);
    expect(renamed).toBeGreaterThan(-1);
    expect(seen[renamed + 1]).toBe(`sync ${installPaths(root).releases}`);
    expect(seen[renamed + 2]).toBe(`rm ${aside}`);
    expect(installed()).toEqual(['0.11.0', '0.12.0']);
  });

  test('a .tmp is removed after releases/ is synced, and once though it holds a host', async () => {
    release('0.9.0');
    release('0.8.0.tmp');
    const cut = join(installPaths(root).releases, '0.8.0.tmp');
    const seen = await steps(() => installRelease(here(), '0.12.0', manager()));
    const removals = seen.flatMap((step, at) => step === `rm ${cut}` ? [at] : []);
    expect(removals).toHaveLength(1);
    expect(seen[removals[0]! - 1]).toBe(`sync ${installPaths(root).releases}`);
    expect(installed()).toEqual(['0.11.0', '0.12.0']);
    expect(said).toEqual([]);
  });

  test('a second install while the first is in its prune is refused and removes nothing', async () => {
    release('0.9.0');
    release('0.8.0');
    let hold!: () => void;
    let held!: () => void;
    const inRm = new Promise<void>((done) => { held = done; });
    const rm = fsp.rm;
    let first = true;
    const spy = spyOn(fsp, 'rm').mockImplementation((async (target: fs.PathLike, options?: fs.RmOptions) => {
      if (first) {
        first = false;
        held();
        await new Promise<void>((done) => { hold = done; });
      }
      return rm(target, options);
    }) as typeof fsp.rm);
    try {
      const installing = installRelease(here(), '0.12.0', manager());
      await inRm;
      const before = installed();
      const second = await failure(installRelease(here(), '0.13.0', manager()));
      expect(second.message).toStartWith('An install of 0.12.0 is under way.');
      expect(installed()).toEqual(before);
      expect(calls).toEqual([]);
      hold();
      await installing;
    } finally {
      spy.mockRestore();
    }
    expect(installed()).toEqual(['0.11.0', '0.12.0']);
  });

  test('a release that can\'t be removed is reported and never taken for a release, and the next install removes it', async () => {
    release('0.9.0');
    release('0.10.0');
    copyFrom('0.11.0');
    const stuck = `${releaseDir(root, '0.9.0')}.tmp`;
    const spy = failRm(stuck);
    try {
      await installRelease(here(), '0.12.0', manager());
    } finally {
      spy.mockRestore();
    }
    expect(installed()).toEqual(['0.11.0', '0.12.0', '0.9.0.tmp']);
    expect(said).toEqual([`[update] ${stuck}, which nothing needs, couldn't be removed, and the next install tries again: ` +
      `EBUSY: resource busy or locked, rmdir '${stuck}'`]);
    // What the removal left isn't a release, so installing 0.9.0 installs it whole.
    await installRelease(here(), '0.9.0', manager());
    expect(calls.map(({ cwd }) => cwd)).toEqual([`${releaseDir(root, '0.12.0')}.tmp`, stuck]);
    expect(installed()).toEqual(['0.11.0', '0.9.0']);
  });

  test('a cut install of the same version that can\'t be removed is a refusal naming it', async () => {
    copyFrom('0.11.0');
    const tmp = `${releaseDir(root, '0.12.0')}.tmp`;
    mkdirSync(join(tmp, 'node_modules'), { recursive: true });
    const spy = failRm(tmp);
    let error: Error;
    try {
      error = await failure(installRelease(here(), '0.12.0', manager()));
    } finally {
      spy.mockRestore();
    }
    expect(error).toBeInstanceOf(ContractError);
    expect(error.message).toBe(`${tmp}, which an earlier install of 0.12.0 left, couldn't be removed, so 0.12.0 can't be ` +
      'installed. Remove it, then update again.');
    expect(calls).toEqual([]);
  });

  test('a tmp that can\'t be made otherwise than being there throws its own error', async () => {
    const tmp = `${releaseDir(root, '0.12.0')}.tmp`;
    const mkdir = fs.mkdirSync;
    const spy = spyOn(fs, 'mkdirSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      if (String(path) === tmp) throw Object.assign(new Error(`EACCES: permission denied, mkdir '${tmp}'`), { code: 'EACCES' });
      return (mkdir as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.mkdirSync);
    let error: Error;
    try {
      error = await failure(installRelease(here(), '0.12.0', manager()));
    } finally {
      spy.mockRestore();
    }
    expect(error).not.toBeInstanceOf(ContractError);
    expect(error.message).toBe(`EACCES: permission denied, mkdir '${tmp}'`);
    expect(calls).toEqual([]);
  });

  test('a release that can\'t be renamed aside stays whole, and the install goes on', async () => {
    release('0.9.0');
    copyFrom('0.11.0');
    const rename = fs.renameSync;
    const spy = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === releaseDir(root, '0.9.0')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return rename(from, to);
    }) as typeof fs.renameSync);
    try {
      await installRelease(here(), '0.12.0', manager());
    } finally {
      spy.mockRestore();
    }
    expect(installed()).toEqual(['0.11.0', '0.12.0', '0.9.0']);
    expect(existsSync(join(releaseDir(root, '0.9.0'), HOST_ENTRY))).toBe(true);
    expect(said).toEqual([`[update] ${releaseDir(root, '0.9.0')}, which nothing needs, couldn't be removed, and the next ` +
      'install tries again: EACCES: permission denied']);
  });
});

describe('the machine\'s package manager', () => {
  test('runs the Bun running this host in the directory given, and gives its exit status and the end of both streams', async () => {
    const ops = machineInstallOps();
    await withoutPath(async () => {
      const ran = await ops.run('bun', ['-e', 'process.stdout.write("a".repeat(9000) + "end"); process.exit(3)'], dir);
      expect(ran.status).toBe(3);
      expect(ran.output.length).toBe(4000);
      expect(ran.output.endsWith('aend')).toBe(true);
      // Two pipes keep no order between them, so stderr gets a run of its own.
      expect(await ops.run('bun', ['-e', 'process.stderr.write(process.cwd())'], dir)).toEqual({ status: 0, output: dir });
      const version = await ops.run('bun', ['--version'], dir);
      expect(version).toEqual({ status: 0, output: `${Bun.version}\n` });
    });
  });

  test('one that can\'t start says why', async () => {
    await withoutPath(async () => {
      const ran = await machineInstallOps().run('npm', ['--version'], dir);
      expect(ran).toEqual({ status: null, output: 'Executable not found in $PATH: "npm"' });
    });
  });

  test('its report goes to stderr as a line', () => {
    const write = fs.writeSync;
    const lines: unknown[][] = [];
    const spy = spyOn(fs, 'writeSync').mockImplementation(((...args: unknown[]) => {
      lines.push(args);
      return 0;
    }) as typeof fs.writeSync);
    try {
      machineInstallOps().report('[update] a line');
    } finally {
      spy.mockRestore();
    }
    expect(lines).toEqual([[2, '[update] a line\n']]);
    expect(fs.writeSync).toBe(write);
  });
});
