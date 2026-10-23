/**
 * Setup (src/update/setup.ts): the one step by hand that makes an npm install
 * of the host update itself, and the entry point it writes. Each test builds
 * an install on disk (its package.json, lockfile and node_modules holding the
 * host) and a data directory, runs setup with the service's units stood in,
 * and reads what it left.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ContractError, appendJournal, installPaths, moveCurrent, readCurrent, readRecord, releaseDir, writeJsonAtomic,
  type InstallRecord,
} from '../src/update/contract.js';
import { HOST_ENTRY, LAUNCHER } from '../src/update/launcher.js';
import { ENTRY_POINT, parseArgs, passwdHome, setup, systemdUnits, type ServiceUnits, type SetupOptions } from '../src/update/setup.js';

let dir: string;
let install: string;
let data: string;
let root: string;
let said: string[];
let units: ServiceUnits;

const options = (over: Partial<SetupOptions> = {}): SetupOptions => ({
  cwd: install,
  dataDir: data,
  root,
  extraState: null,
  hostRoot: join(install, 'node_modules', '@animalabs', 'connectome-host'),
  say: (line) => { said.push(line); },
  units: () => units,
  ...over,
});

const record = () => readRecord<InstallRecord>(installPaths(root).install, 'install record');

/** A release in the root as an update would install it, with a launcher that writes `out`. */
function laterRelease(version: string, out: string): void {
  const host = join(releaseDir(root, version), 'node_modules', '@animalabs', 'connectome-host');
  mkdirSync(join(host, 'src', 'update'), { recursive: true });
  writeFileSync(join(host, 'src', 'index.ts'), '// host\n');
  writeFileSync(join(host, 'src', 'update', 'launcher.ts'),
    `import { writeFileSync } from 'node:fs';\nexport async function launch(root) { writeFileSync(${JSON.stringify(out)}, ${JSON.stringify(version)}); }\n`);
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'update-setup-')));
  install = join(dir, 'service');
  data = join(install, 'data');
  root = join(install, 'connectome-host');
  const host = join(install, 'node_modules', '@animalabs', 'connectome-host');
  mkdirSync(join(host, 'src', 'update'), { recursive: true });
  writeFileSync(join(host, 'package.json'), JSON.stringify({ name: '@animalabs/connectome-host', version: '0.10.2' }));
  writeFileSync(join(host, 'src', 'index.ts'), '// host\n');
  writeFileSync(join(host, 'src', 'update', 'launcher.ts'), 'export async function launch() {}\n');
  mkdirSync(join(install, 'node_modules', '.bin'));
  symlinkSync('../@animalabs/connectome-host/src/index.ts', join(install, 'node_modules', '.bin', 'connectome-host'));
  writeFileSync(join(install, 'package.json'), JSON.stringify({ dependencies: { '@animalabs/connectome-host': '^0.10.2' } }));
  writeFileSync(join(install, 'package-lock.json'), '{"lockfileVersion":3}');
  mkdirSync(join(data, 'sessions'), { recursive: true });
  said = [];
  units = { found: [{ id: 'connectome.service', settings: 'Restart=on-failure', restarts: true }], unasked: [], unresolved: [], defaulted: [] };
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const NEEDED = "by Restart=always, by Restart=on-failure while it isn't in SuccessExitStatus=, or by RestartForceExitStatus=, and neither in RestartPreventExitStatus=";

describe('setup', () => {
  test("copies the install's code as its first release, records the data it serves, points current at it and writes the entry point", () => {
    setup(options());
    const release = releaseDir(root, '0.10.2');
    expect(existsSync(join(release, HOST_ENTRY))).toBe(true);
    expect(readFileSync(join(release, 'package-lock.json'), 'utf-8')).toBe('{"lockfileVersion":3}');
    expect(existsSync(join(release, 'package.json'))).toBe(true);
    expect(readlinkSync(join(release, 'node_modules', '.bin', 'connectome-host'))).toBe('../@animalabs/connectome-host/src/index.ts');
    expect(readCurrent(root)).toBe('0.10.2');
    expect(record()).toEqual({ v: 1, dataDir: data, extraState: [] });
    expect(existsSync(join(root, ENTRY_POINT))).toBe(true);
    expect(said[0]).toBe(`Set up ${root} as the install of 0.10.2 that serves ${data}.`);
    expect(said.some((l) => l.includes('connectome.service restarts the host when it exits with 75 or 1 (Restart=on-failure)'))).toBe(true);
  });

  test("says when the service wouldn't restart the host, and when it couldn't check", () => {
    const unit = { id: 'connectome.service', settings: 'Restart=on-failure, SuccessExitStatus includes 75', restarts: false };
    units = { found: [unit], unasked: [], unresolved: [], defaulted: [] };
    setup(options());
    expect(said.some((l) => l.includes("won't restart the host on both 75 and 1 (Restart=on-failure, SuccessExitStatus includes 75)") &&
      l.includes(`Before you update, have each of the two restarted, ${NEEDED}.`))).toBe(true);
    for (const [unasked, says] of [[[], 'No loaded systemd service that this user can see is set to run from this directory'],
      [['user', 'system'], "Setup couldn't ask systemd's user manager or systemd's system manager"]] as const) {
      said = [];
      units = { found: [], unasked: [...unasked], unresolved: [], defaulted: [] };
      setup(options());
      expect(said.some((l) => l.includes(says) && l.includes("couldn't check that") &&
        l.includes(`must restart the host when it exits with 75, as a switch's restart does, and with 1, as a trial that ends before its commit does, so its fallback runs: under systemd, each of the two restarted, ${NEEDED}; or launchd's KeepAlive.`))).toBe(true);
    }
    // One manager couldn't be asked, and the other found a unit: both are said.
    said = [];
    units = { found: [unit], unasked: ['user'], unresolved: [], defaulted: [] };
    setup(options());
    expect(said.some((l) => l.includes("Setup couldn't ask systemd's user manager, so a service of its that runs from this directory isn't checked"))).toBe(true);
    expect(said.some((l) => l.includes("connectome.service won't restart the host"))).toBe(true);
  });

  test('records extra state given outside the data directory; a later run without any keeps it, and one with some records those instead', () => {
    const state = join(install, 'mcpl-state');
    const other = join(install, 'other-state.json');
    mkdirSync(state);
    writeFileSync(other, '{}');
    setup(options({ extraState: [state] }));
    expect(record()!.extraState).toEqual([state]);
    setup(options());
    expect(record()!.extraState).toEqual([state]);
    said = [];
    setup(options({ extraState: [other] }));
    expect(record()!.extraState).toEqual([other]);
    expect(said[0]).toBe(`The install at ${root} serves ${data} and runs 0.10.2, as before.`);
    expect(said[1]).toBe(`State kept outside the data directory, which each update copies with it: ${other}.`);
  });

  test('a later run leaves the release current names as it is, however the install has moved on', () => {
    setup(options());
    laterRelease('0.11.0', join(dir, 'ran'));
    moveCurrent(root, '0.11.0');
    said = [];
    setup(options());
    expect(readCurrent(root)).toBe('0.11.0');
    expect(said[0]).toContain('runs 0.11.0, as before');
    expect(existsSync(join(releaseDir(root, '0.10.2'), HOST_ENTRY))).toBe(true);
  });

  test('a run cut off finishes on the next: after its release copy, after current, and after its record', () => {
    setup(options());
    const entry = join(root, ENTRY_POINT);
    // After its release copy: no current, record or entry point.
    rmSync(installPaths(root).install);
    unlinkSync(installPaths(root).current);
    rmSync(entry);
    setup(options());
    expect(readCurrent(root)).toBe('0.10.2');
    expect(record()).toEqual({ v: 1, dataDir: data, extraState: [] });
    expect(existsSync(entry)).toBe(true);
    // After current: no record or entry point, and current names a release
    // this install's code no longer is.
    laterRelease('0.11.0', join(dir, 'ran'));
    moveCurrent(root, '0.11.0');
    rmSync(installPaths(root).install);
    rmSync(entry);
    setup(options());
    expect(readCurrent(root)).toBe('0.11.0');
    expect(record()).toEqual({ v: 1, dataDir: data, extraState: [] });
    expect(existsSync(entry)).toBe(true);
    // After its record: no entry point.
    rmSync(entry);
    setup(options());
    expect(existsSync(entry)).toBe(true);
    expect(readCurrent(root)).toBe('0.11.0');
  });

  test("refuses an install whose copy would have no host, publishing no release, and a later run finishes", () => {
    const entry = join(install, 'node_modules', '@animalabs', 'connectome-host', 'src', 'index.ts');
    rmSync(entry);
    expect(() => setup(options())).toThrow(/has no host at/);
    expect(existsSync(releaseDir(root, '0.10.2'))).toBe(false);
    expect(existsSync(releaseDir(root, '0.10.2') + '.tmp')).toBe(false);
    writeFileSync(entry, '// host\n');
    setup(options());
    expect(readCurrent(root)).toBe('0.10.2');
  });

  test("refuses a current whose release has no host, naming it", () => {
    setup(options());
    rmSync(join(releaseDir(root, '0.10.2'), 'node_modules', '@animalabs', 'connectome-host', 'src', 'index.ts'));
    expect(() => setup(options())).toThrow(/current names 0\.10\.2, and there's no host at .*Put .*releases\/0\.10\.2 back as it was, or point current at the release the data last committed on with `ln -sfn /);
  });

  test("a run whose record's write fails leaves current, so the next run finishes", () => {
    // A directory where the record's temporary file goes, so its write fails.
    mkdirSync(join(root, 'releases'), { recursive: true });
    mkdirSync(join(root, 'install.json.tmp'));
    expect(() => setup(options())).toThrow(/install\.json\.tmp/);
    expect(readCurrent(root)).toBe('0.10.2');
    expect(record()).toBeNull();
    rmSync(join(root, 'install.json.tmp'), { recursive: true });
    setup(options());
    expect(record()).toEqual({ v: 1, dataDir: data, extraState: [] });
  });

  test('a resumed run syncs the releases directory before it moves current, also when its release was renamed already', () => {
    setup(options());
    rmSync(installPaths(root).install);
    unlinkSync(installPaths(root).current);
    rmSync(join(root, ENTRY_POINT));
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
    const realRename = fs.renameSync;
    const renames = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === installPaths(root).current) synced.push('current renamed');
      realRename(from, to);
    }) as typeof fs.renameSync);
    try {
      setup(options());
    } finally {
      opens.mockRestore();
      syncs.mockRestore();
      renames.mockRestore();
    }
    // The releases directory, before current names what's in it.
    expect(synced.indexOf(installPaths(root).releases)).toBeGreaterThan(-1);
    expect(synced.indexOf(installPaths(root).releases)).toBeLessThan(synced.indexOf('current renamed'));
    expect(readCurrent(root)).toBe('0.10.2');
  });

  test("a current that can't be followed is refused with its error", () => {
    setup(options());
    const loopy = join(dir, 'loopy', '0.10.2');
    mkdirSync(dirname(loopy), { recursive: true });
    symlinkSync(loopy, loopy);
    unlinkSync(installPaths(root).current);
    symlinkSync(loopy, installPaths(root).current);
    expect(() => setup(options())).toThrow(/current can't be followed: .*ELOOP.*Point it at the release the data last committed on with `ln -sfn /);
  });

  test("a current that leads where this user can't search is refused with that to fix", () => {
    setup(options());
    const hidden = join(dir, 'hidden');
    mkdirSync(join(hidden, '0.10.2'), { recursive: true });
    unlinkSync(installPaths(root).current);
    symlinkSync(join(hidden, '0.10.2'), installPaths(root).current);
    chmodSync(hidden, 0o600);
    try {
      expect(() => setup(options())).toThrow(/current can't be followed: .*EACCES.*Give this user search on each directory on the way to where it leads/);
    } finally {
      chmodSync(hidden, 0o755);
    }
  });

  test("a current that leads to another directory of the same name is refused too", () => {
    setup(options());
    const other = join(dir, 'elsewhere', '0.10.2');
    mkdirSync(other, { recursive: true });
    unlinkSync(installPaths(root).current);
    symlinkSync(other, installPaths(root).current);
    expect(() => setup(options())).toThrow(/current names 0\.10\.2 but leads to .*elsewhere\/0\.10\.2, not /);
  });

  test("a current that doesn't lead to releases/<the release it names> is refused with how to point it there", () => {
    setup(options());
    laterRelease('0.11.0', join(dir, 'ran'));
    // A link that names 0.10.2 by its last segment but leads nowhere.
    unlinkSync(installPaths(root).current);
    symlinkSync(join('elsewhere', '0.10.2'), installPaths(root).current);
    expect(readCurrent(root)).toBe('0.10.2');
    expect(() => setup(options())).toThrow(/current names 0\.10\.2 but leads to elsewhere\/0\.10\.2, not .*releases\/0\.10\.2, where the launcher starts 0\.10\.2 from\. Point it there with `ln -sfn releases\/0\.10\.2 /);
  });

  test("a run that finds current there and no record syncs the root before it writes the record", () => {
    setup(options());
    rmSync(installPaths(root).install);
    rmSync(join(root, ENTRY_POINT));
    const paths = new Map<number, string>();
    const events: string[] = [];
    const realOpen = fs.openSync;
    const realFsync = fs.fsyncSync;
    const realRename = fs.renameSync;
    const opens = spyOn(fs, 'openSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
      const fd = (realOpen as (...args: unknown[]) => number)(path, ...rest);
      paths.set(fd, String(path));
      return fd;
    }) as typeof fs.openSync);
    const syncs = spyOn(fs, 'fsyncSync').mockImplementation(((fd: number) => {
      events.push(paths.get(fd) ?? `fd ${fd}`);
      realFsync(fd);
    }) as typeof fs.fsyncSync);
    const renames = spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === installPaths(root).install) events.push('record renamed');
      realRename(from, to);
    }) as typeof fs.renameSync);
    try {
      setup(options());
    } finally {
      opens.mockRestore();
      syncs.mockRestore();
      renames.mockRestore();
    }
    expect(events.indexOf(root)).toBeGreaterThan(-1);
    expect(events.indexOf(root)).toBeLessThan(events.indexOf('record renamed'));
  });

  test('the advice for a record with no current quotes a root a shell would split', () => {
    root = join(dir, "the host's root");
    setup(options());
    unlinkSync(installPaths(root).current);
    expect(() => setup(options())).toThrow(`\`ln -s 'releases/<that release>' '${dir}/the host'\\''s root/current'\``);
  });

  test("refuses an install whose record is there and current isn't, naming the release the journal says last committed", () => {
    setup(options());
    unlinkSync(installPaths(root).current);
    expect(() => setup(options())).toThrow(/has its record and no .*current.*never remove it.*By the journal, that release is the release setup installed, since the journal has no line, which unless it's gone is 0\.10\.2, in .*releases\. Point current at it with `ln -s 'releases\/<that release>' /);
    // A release's staging name isn't one, and with two, both are named.
    mkdirSync(join(installPaths(root).releases, '0.11.0.tmp'));
    laterRelease('0.11.0', join(dir, 'ran'));
    expect(() => setup(options())).toThrow(/which unless it's gone is one of 0\.10\.2, 0\.11\.0, in /);
    rmSync(join(installPaths(root).releases, '0.11.0'), { recursive: true });
    rmSync(join(installPaths(root).releases, '0.11.0.tmp'), { recursive: true });
    appendJournal(root, { v: 1, at: 'T0', step: 'copy', from: '0.10.2', to: '0.11.0', outcome: 'refused', reason: 'x', mark: 'm0' });
    expect(() => setup(options())).toThrow(/that release is 0\.10\.2, which the journal's last line leaves it naming\. Point/);
    appendJournal(root, { v: 1, at: 'T1', step: 'trial-start', from: '0.10.2', to: '0.11.0', outcome: 'ok', mark: 'm1' });
    expect(() => setup(options())).toThrow(/that release is 0\.10\.2, which the journal's last line leaves it naming, or 0\.11\.0 if its trial committed: .*no line after that trial says how it ended\. Point/);
    appendJournal(root, { v: 1, at: 'T2', step: 'commit', from: '0.10.2', to: '0.11.0', outcome: 'ok' });
    appendJournal(root, { v: 1, at: 'T3', step: 'trial-start', from: '0.11.0', to: '0.12.0', outcome: 'ok', mark: 'm2' });
    appendJournal(root, { v: 1, at: 'T4', step: 'fallback', from: '0.12.0', to: '0.11.0', outcome: 'ok', mark: 'm2' });
    // A trial that fell back didn't commit.
    expect(() => setup(options())).toThrow(/that release is 0\.11\.0, which the journal's last line leaves it naming\. Point/);
    appendJournal(root, { v: 1, at: 'T5', step: 'trial-start', from: '0.11.0', to: '0.13.0', outcome: 'ok', mark: 'm3' });
    appendJournal(root, { v: 1, at: 'T6', step: 'fallback', from: '0.13.0', to: '0.11.0', outcome: 'failed', reason: 'x', mark: 'm3' });
    // Nor did one whose fallback failed: nothing starts after it.
    expect(() => setup(options())).toThrow(/that release is 0\.11\.0, which the journal's last line leaves it naming\. Point/);
    appendJournal(root, { v: 1, at: 'T7', step: 'trial-start', from: '0.11.0', to: '0.10.2', outcome: 'ok', mark: 'g1' });
    expect(() => setup(options())).toThrow(/last line leaves it naming, or 0\.10\.2 if its trial committed/);
    // A later line written with current naming 0.11.0 says that trial didn't commit.
    appendJournal(root, { v: 1, at: 'T8', step: 'copy', from: '0.11.0', to: '0.14.0', outcome: 'refused', reason: 'x', mark: 'm4' });
    expect(() => setup(options())).toThrow(/that release is 0\.11\.0, which the journal's last line leaves it naming\. Point/);
    expect(readCurrent(root)).toBeNull();
  });

  test("a current that isn't a link to a release is refused with how to point it", () => {
    setup(options());
    unlinkSync(installPaths(root).current);
    mkdirSync(installPaths(root).current);
    expect(() => setup(options())).toThrow(/current is there and isn't a link, so it can't say which release this install runs\. Move it aside, and point current at the release the data last committed on with `ln -s /);
    rmdirSync(installPaths(root).current);
    // A link whose last part names no release.
    symlinkSync('releases/..', installPaths(root).current);
    expect(() => setup(options())).toThrow(/current is a link to releases\/\.\., which names no release, .*`ln -sfn /);
  });

  test("with no commit line, the release named is the one the journal's last line leaves current naming", () => {
    setup(options());
    unlinkSync(installPaths(root).current);
    // A trial whose commit moved current and was cut before its line, and a
    // later request from the release it committed.
    appendJournal(root, { v: 1, at: 'T1', step: 'trial-start', from: '0.10.2', to: '0.11.0', outcome: 'ok', mark: 'm1' });
    appendJournal(root, { v: 1, at: 'T2', step: 'copy', from: '0.11.0', to: '0.12.0', outcome: 'refused', reason: 'x', mark: 'm2' });
    expect(() => setup(options())).toThrow(/that release is 0\.11\.0, which the journal's last line leaves it naming\. Point/);
  });

  test("an empty journal with no record or entry point is a lost record too", () => {
    setup(options());
    rmSync(installPaths(root).install);
    rmSync(join(root, ENTRY_POINT));
    writeFileSync(installPaths(root).journal, '');
    expect(() => setup(options())).toThrow(/has a journal and no record at /);
  });

  test("a record the system won't read is to be made readable, and one of another version is left to the release that reads it", () => {
    setup(options());
    chmodSync(installPaths(root).install, 0o000);
    try {
      expect(() => setup(options())).toThrow(/install record at .* can't be read: EACCES.*Make it a file this user can read/);
    } finally {
      chmodSync(installPaths(root).install, 0o644);
    }
    writeJsonAtomic(installPaths(root).install, { v: 2, dataDir: data, extraState: [] });
    let message = '';
    try {
      setup(options());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/has version 2, and this release reads only version 1\.$/);
  });

  test("an entry point with no record, and no journal, is an install whose record is gone too", () => {
    setup(options());
    rmSync(installPaths(root).install);
    expect(() => setup(options())).toThrow(/has its entry point and no record at .*, so its record is gone/);
  });

  test("with no current and no journal line, a releases/ that can't be listed, or holds none, gets its own advice", () => {
    setup(options());
    unlinkSync(installPaths(root).current);
    chmodSync(installPaths(root).releases, 0o300);
    try {
      expect(() => setup(options())).toThrow(/releases can't be listed to say which: .*EACCES.*Make it readable to this user/);
      // A journal with a line names the release without the listing.
      appendJournal(root, { v: 1, at: 'T1', step: 'copy', from: '0.10.2', to: '0.11.0', outcome: 'refused', reason: 'x', mark: 'm1' });
      expect(() => setup(options())).toThrow(/that release is 0\.10\.2, which the journal's last line leaves it naming/);
    } finally {
      chmodSync(installPaths(root).releases, 0o755);
    }
    rmSync(installPaths(root).journal);
    // A releases/ that's a file isn't mended by permissions.
    renameSync(installPaths(root).releases, join(dir, 'releases-aside'));
    writeFileSync(installPaths(root).releases, '');
    expect(() => setup(options())).toThrow(/releases can't be listed to say which: .*ENOTDIR.*Repair what that path runs through/);
    rmSync(installPaths(root).releases);
    renameSync(join(dir, 'releases-aside'), installPaths(root).releases);
    rmSync(releaseDir(root, '0.10.2'), { recursive: true });
    expect(() => setup(options())).toThrow(/releases holds no release\. Put that release back in .*releases from a backup, point current at it with `ln -s /);
    // A releases/ that isn't there holds none either.
    rmSync(installPaths(root).releases, { recursive: true });
    expect(() => setup(options())).toThrow(/releases holds no release\. Put that release back/);
  });

  test("a host that's a link to nothing is no host, as the launcher's start finds it", () => {
    setup(options());
    const host = join(releaseDir(root, '0.10.2'), HOST_ENTRY);
    rmSync(host);
    symlinkSync(join(dir, 'nowhere.ts'), host);
    expect(() => setup(options())).toThrow(/current names 0\.10\.2, and there's no host at /);
  });

  test("a host that's a loop of links can't be looked at, and gets a repair, not a permission", () => {
    setup(options());
    const host = join(releaseDir(root, '0.10.2'), HOST_ENTRY);
    rmSync(host);
    symlinkSync(host, host);
    expect(() => setup(options())).toThrow(/its host at .* can't be looked at: .*ELOOP.*Repair what that path runs through, and run setup again/);
  });

  test("extra state that can't be looked at is refused with its error, not taken for absent", () => {
    const shut = join(dir, 'shut');
    mkdirSync(shut);
    writeFileSync(join(shut, 'state.json'), '{}');
    chmodSync(shut, 0o600);
    try {
      expect(() => setup(options({ extraState: [join(shut, 'state.json')] }))).toThrow(/The extra state .*state\.json can't be looked at: .*EACCES.*Give this user search on each directory on the way to it/);
    } finally {
      chmodSync(shut, 0o755);
    }
  });

  test("units whose directory this user can't resolve are named, each, beside those found, beside none, and beside a manager not asked", () => {
    const unit = { id: 'connectome.service', settings: 'Restart=on-failure', restarts: true };
    const note = (names: string, they: boolean) => `Setup couldn't resolve the working directory of ${names} (one under a ` +
      "directory this user can't search, or a system unit's ~ whose User= /etc/passwd doesn't name), so it can't tell whether " +
      `${they ? 'they run' : 'it runs'} from this directory, and doesn't check ${they ? 'them' : 'it'}. If ` +
      `${they ? 'one of them runs' : 'it runs'} the host, check its restart settings by hand, or run setup as a user who can ` +
      'reach its working directory.';
    units = { found: [unit], unasked: [], unresolved: ['a.service', 'b.service'], defaulted: [] };
    setup(options());
    expect(said.some((l) => l.startsWith(note('a.service, b.service', true)))).toBe(true);
    said = [];
    units = { found: [], unasked: [], unresolved: ['1', '2', '3', '4', '5', '6', '7'], defaulted: [] };
    setup(options());
    expect(said.some((l) => l.includes('No loaded systemd service whose working directory setup could resolve is set to run from this directory') &&
      l.includes(note('1, 2, 3, 4, 5, 6, 7', true)))).toBe(true);
    said = [];
    units = { found: [], unasked: ['user'], unresolved: ['a.service'], defaulted: [] };
    setup(options());
    expect(said.some((l) => l.includes("Setup couldn't ask systemd's user manager which service runs from this directory") &&
      l.includes(note('a.service', false)))).toBe(true);
    said = [];
    units = { found: [unit], unasked: ['system'], unresolved: ['a.service'], defaulted: [] };
    setup(options());
    expect(said.some((l) => l.includes("Setup couldn't ask systemd's system manager, so a service of its that runs from this directory isn't checked.") &&
      l.includes(note('a.service', false)))).toBe(true);
  });

  test("units that set no working directory and run here by default are named, with what to do, beside those found and beside none", () => {
    const note = (names: string, few: boolean) => `${names} ${few ? 'sets' : 'set'} no working directory, so ${few ? 'it runs' : 'they run'} ` +
      `in ${few ? 'its' : 'their'} systemd manager's default, which is this directory. Most units that do are no host's, so setup doesn't ` +
      `check ${few ? 'it' : 'them'}. If ${few ? 'it runs' : 'one of them runs'} the host, give the service WorkingDirectory=` +
      `${options().cwd} and run setup again, or check its restart settings by hand.`;
    units = { found: [], unasked: [], unresolved: [], defaulted: ['a.service'] };
    setup(options());
    expect(said.some((l) => l.includes("No loaded systemd service that this user can see is set to run from this directory, so setup couldn't check that.") &&
      l.includes(note('a.service', true)))).toBe(true);
    said = [];
    units = { found: [{ id: 'connectome.service', settings: 'Restart=on-failure', restarts: true }], unasked: [], unresolved: [], defaulted: ['a.service', 'b.service'] };
    setup(options());
    expect(said.some((l) => l.startsWith(note('a.service, b.service', false)))).toBe(true);
    // A % in the directory is doubled, as a unit file's value needs.
    const percent = join(dir, '50%h');
    symlinkSync(install, percent);
    said = [];
    units = { found: [], unasked: [], unresolved: [], defaulted: ['a.service'] };
    setup(options({ cwd: percent }));
    expect(said.some((l) => l.includes(`give the service WorkingDirectory=${join(dir, '50%%h')} and run setup again`))).toBe(true);
    // Beside a manager it couldn't ask, found or not.
    for (const found of [[], [{ id: 'connectome.service', settings: 'Restart=on-failure', restarts: true }]]) {
      said = [];
      units = { found, unasked: ['system'], unresolved: [], defaulted: ['a.service'] };
      setup(options());
      expect(said.some((l) => l.includes("Setup couldn't ask systemd's system manager") && l.includes(note('a.service', true)))).toBe(true);
    }
  });

  test("extra state that isn't there is said to be absent, and one whose path can't be followed gets a repair, not a permission", () => {
    expect(() => setup(options({ extraState: [join(dir, 'nowhere.json')] }))).toThrow(/The extra state .*nowhere\.json isn't there\.$/);
    const loop = join(dir, 'loop');
    symlinkSync(loop, loop);
    expect(() => setup(options({ extraState: [loop] }))).toThrow(/The extra state .*loop can't be looked at: .*ELOOP.*Repair what that path runs through, and run setup again\./);
  });

  test("a current that can't be looked at says what to do for its error: search for a permission, a repair for anything else", () => {
    setup(options());
    const real = fs.readlinkSync;
    for (const [code, advice] of [['EACCES', /can't be looked at: .*EACCES.*Give this user search on each directory on the way to .*, and run setup again\./],
      ['EPERM', /can't be looked at: .*EPERM.*Give this user search on each directory on the way to .*, and run setup again\./],
      ['EIO', /can't be looked at: .*EIO.*Repair what that path runs through, and run setup again\./]] as const) {
      const spy = spyOn(fs, 'readlinkSync').mockImplementation(((path: fs.PathLike, options?: unknown) => {
        if (String(path) === installPaths(root).current) throw Object.assign(new Error(code), { code });
        return real(path, options as never);
      }) as typeof fs.readlinkSync);
      try {
        expect(() => setup(options())).toThrow(advice);
      } finally {
        spy.mockRestore();
      }
    }
  });

  test("a current whose release's host can't be looked at is refused with its error", () => {
    setup(options());
    chmodSync(releaseDir(root, '0.10.2'), 0o600);
    try {
      expect(() => setup(options())).toThrow(/current names 0\.10\.2, and its host at .* can't be looked at: .*EACCES.*Give this user search on each directory on the way, and run setup again/);
    } finally {
      chmodSync(releaseDir(root, '0.10.2'), 0o755);
    }
  });

  test("a record with no version is refused with how to write it again", () => {
    setup(options());
    writeFileSync(installPaths(root).install, JSON.stringify({ dataDir: data, extraState: [] }));
    expect(() => setup(options())).toThrow(/has version undefined, and this release reads only version 1\. Write it again as /);
  });

  test("a record that isn't JSON is refused with how to write it again", () => {
    setup(options());
    writeFileSync(installPaths(root).install, '{');
    expect(() => setup(options())).toThrow(/install record at .* isn't JSON, so this release can't read it\. Write it again as \{"v": 1, "dataDir": .*listing in extraState the paths it listed, where they can still be read/);
  });

  test("a journal with lines and no record is an install whose record is gone, refused with how to write it again", () => {
    setup(options());
    appendJournal(root, { v: 1, at: 'T1', step: 'commit', from: '0.10.2', to: '0.11.0', outcome: 'ok' });
    rmSync(installPaths(root).install);
    expect(() => setup(options())).toThrow(/has a journal and no record at .*, so its record is gone, and with it the extra state it listed\. Write it again as /);
  });

  test("refuses a record it can't read the extra state of, unless --extra-state says what to record", () => {
    setup(options());
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: data, extraState: 'none' });
    expect(() => setup(options())).toThrow(/has no list of extra state this release can read/);
    writeJsonAtomic(installPaths(root).install, { v: 1, dataDir: data, extraState: ['/srv/state.json', 7] });
    expect(() => setup(options())).toThrow(/has no list of extra state this release can read/);
    const state = join(install, 'state.json');
    writeFileSync(state, '{}');
    setup(options({ extraState: [state] }));
    expect(record()).toEqual({ v: 1, dataDir: data, extraState: [state] });
    writeJsonAtomic(installPaths(root).install, { v: 1, extraState: [] });
    expect(() => setup(options())).toThrow(/names no data directory this release can read/);
  });

  test('says the service command with each path quoted that needs it', () => {
    root = join(dir, "the host's root");
    setup(options({ root }));
    expect(said.some((l) => l.includes(`'${dir}/the host'\\''s root/start.js'`))).toBe(true);
  });

  test("a run cut off while copying: the next removes the partial copy and copies again", () => {
    mkdirSync(join(releaseDir(root, '0.10.2') + '.tmp', 'node_modules'), { recursive: true });
    setup(options());
    expect(existsSync(releaseDir(root, '0.10.2') + '.tmp')).toBe(false);
    expect(existsSync(join(releaseDir(root, '0.10.2'), HOST_ENTRY))).toBe(true);
  });

  test('refuses a root whose releases directory holds something setup never made', () => {
    mkdirSync(join(installPaths(root).releases, 'notes'), { recursive: true });
    expect(() => setup(options())).toThrow(/isn't empty, and holds no install record/);
    expect(existsSync(installPaths(root).install)).toBe(false);
  });

  test('refuses another data directory on a later run', () => {
    setup(options());
    mkdirSync(join(install, 'other-data'));
    expect(() => setup(options({ dataDir: join(install, 'other-data') }))).toThrow(/serves/);
  });

  const refusals: Array<[string, () => Partial<SetupOptions>, RegExp]> = [
    ['a root inside the data directory', () => ({ root: join(data, 'connectome-host') }), /one inside the other/],
    ['a data directory inside the root', () => {
      mkdirSync(join(dir, 'outer', 'data'), { recursive: true });
      return { root: join(dir, 'outer'), dataDir: join(dir, 'outer', 'data') };
    }, /^The install root .* and .* are one inside the other/],
    ['a root reached through a link into the data directory', () => {
      symlinkSync(data, join(dir, 'link'));
      return { root: join(dir, 'link', 'connectome-host') };
    }, /one inside the other/],
    ['extra state that holds the root', () => ({ extraState: ['/'] }), /one inside the other/],
    ['a data directory that is not there', () => ({ dataDir: join(install, 'nowhere') }), /isn't there/],
    ['a data directory that is a file', () => {
      writeFileSync(join(install, 'data-file'), 'x');
      return { dataDir: join(install, 'data-file') };
    }, /isn't a directory/],
    ['a host that is not installed in a node_modules', () => {
      const clone = join(dir, 'clone');
      mkdirSync(join(clone, 'src'), { recursive: true });
      writeFileSync(join(clone, 'package.json'), JSON.stringify({ version: '0.10.2' }));
      return { hostRoot: clone };
    }, /isn't installed in a node_modules/],
    ['a root inside what it copies', () => ({ root: join(install, 'node_modules', 'connectome-host-root') }), /inside .*node_modules, which setup copies/],
    ['an install that links outside itself', () => {
      mkdirSync(join(dir, 'checkout'));
      symlinkSync(join(dir, 'checkout'), join(install, 'node_modules', 'linked'));
      symlinkSync('../../outside', join(install, 'node_modules', '.bin', 'up'));
      // A link by its full path leads into the install, not the release copied from it.
      symlinkSync(join(install, 'node_modules', '@animalabs'), join(install, 'node_modules', 'by-path'));
      return {};
    }, /^node_modules\/\.bin\/up links to \.\.\/\.\.\/outside; node_modules\/by-path links to .*node_modules\/@animalabs; node_modules\/linked links to .*checkout: outside this install/],
    ['a root that holds something else', () => {
      mkdirSync(root);
      writeFileSync(join(root, 'notes.txt'), 'mine');
      return {};
    }, /isn't empty/],
    ['a root that holds only names setup writes, with no releases directory setup makes first', () => {
      mkdirSync(root);
      writeFileSync(join(root, ENTRY_POINT), '// the operator\'s own\n');
      return {};
    }, /isn't empty/],
    ["a host in this directory's node_modules that leads through a link into another install's", () => {
      // The other install is whole, so only this check stands between setup and copying it.
      const other = join(dir, 'other');
      const host = join(install, 'node_modules', '@animalabs', 'connectome-host');
      mkdirSync(join(other, 'node_modules', '@animalabs'), { recursive: true });
      writeFileSync(join(other, 'package.json'), '{}');
      renameSync(host, join(other, 'node_modules', '@animalabs', 'connectome-host'));
      symlinkSync(join(other, 'node_modules', '@animalabs', 'connectome-host'), host);
      return { hostRoot: join(other, 'node_modules', '@animalabs', 'connectome-host') };
    }, /leads to .*other\/node_modules\/@animalabs\/connectome-host, outside this install's own node_modules/],
    ["a host in this directory's node_modules that is a link to nothing", () => {
      const host = join(install, 'node_modules', '@animalabs', 'connectome-host');
      renameSync(host, join(dir, 'gone-host'));
      symlinkSync(join(dir, 'nowhere'), host);
      return { hostRoot: join(dir, 'gone-host') };
    }, /connectome-host is a link to something that isn't there/],
    ["a host in this directory's node_modules that is a link that can't be followed", () => {
      const host = join(install, 'node_modules', '@animalabs', 'connectome-host');
      renameSync(host, join(dir, 'loop-host'));
      symlinkSync(host, host);
      return { hostRoot: join(dir, 'loop-host') };
    }, /connectome-host can't be followed to the host it names: .*ELOOP/],
    ['extra state that is neither a file nor a directory', () => {
      const fifo = join(install, 'state.fifo');
      Bun.spawnSync(['mkfifo', fifo]);
      return { extraState: [fifo] };
    }, /is neither a file nor a directory/],
    ['an install with a link that leads outside through another link', () => {
      mkdirSync(join(dir, 'outside', 'deep'), { recursive: true });
      writeFileSync(join(dir, 'outside', 'y'), 'outside');
      symlinkSync('../../outside/deep', join(install, 'node_modules', 'inner'));
      // As written it reads node_modules/y, inside; through `inner` it's outside.
      symlinkSync('inner/../y', join(install, 'node_modules', 'x'));
      return {};
    }, /node_modules\/x links to inner\/\.\.\/y/],
  ];
  for (const [name, over, why] of refusals) {
    test(`refuses ${name}, leaving no install`, () => {
      const o = options(over());
      expect(() => setup(o)).toThrow(ContractError);
      expect(() => setup(o)).toThrow(why);
      expect(existsSync(installPaths(o.root).install)).toBe(false);
      expect(existsSync(installPaths(o.root).releases)).toBe(false);
    });
  }
});

describe("setup's arguments", () => {
  test('takes a root and any number of extra states, and keeps the recorded ones when given none', () => {
    expect(parseArgs([])).toEqual({ extraState: null });
    expect(parseArgs(['--root', 'r', '--extra-state', 'a', '--extra-state', '/b'])).toEqual({ root: 'r', extraState: [join(process.cwd(), 'a'), '/b'] });
  });

  test('says which flag lacks its value, and names what it does not take', () => {
    expect(() => parseArgs(['--root'])).toThrow("Setup's --root takes a directory, and none followed it.");
    expect(() => parseArgs(['--extra-state'])).toThrow("Setup's --extra-state takes a path, and none followed it.");
    expect(() => parseArgs(['--data', 'x'])).toThrow('Setup takes --root DIR and --extra-state PATH, not "--data".');
  });
});

describe('the entry point', () => {
  test("hands the start to the launcher of the release current names, with the install's root and the service's arguments", () => {
    setup(options());
    const out = join(dir, 'launched.json');
    writeFileSync(join(releaseDir(root, '0.10.2'), LAUNCHER),
      `import { writeFileSync } from 'node:fs';\nexport async function launch(root, argv) { writeFileSync(${JSON.stringify(out)}, JSON.stringify({ root, argv })); }\n`);
    const run = Bun.spawnSync([process.execPath, join(root, ENTRY_POINT), '--recipe', 'r.json'], { cwd: install });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf-8'))).toEqual({ root, argv: ['--recipe', 'r.json'] });
  });

  test('once current names a later release, hands the start to that release\'s launcher', () => {
    setup(options());
    const out = join(dir, 'ran');
    laterRelease('0.11.0', out);
    moveCurrent(root, '0.11.0');
    const run = Bun.spawnSync([process.execPath, join(root, ENTRY_POINT)], { cwd: install });
    expect(run.exitCode).toBe(0);
    expect(readFileSync(out, 'utf-8')).toBe('0.11.0');
  });

  test('with no release to start, says so and exits non-zero', () => {
    setup(options());
    unlinkSync(installPaths(root).current);
    const run = Bun.spawnSync([process.execPath, join(root, ENTRY_POINT)], { cwd: install, stderr: 'pipe' });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain("doesn't load");
    expect(run.stderr.toString()).toContain('run setup again');
    // One that's there and isn't a link is named the same way, and setup says which.
    writeFileSync(installPaths(root).current, '');
    const file = Bun.spawnSync([process.execPath, join(root, ENTRY_POINT)], { cwd: install, stderr: 'pipe' });
    expect(file.exitCode).toBe(1);
    expect(file.stderr.toString()).toMatch(/isn't there, or isn't a link to a release, run setup again .*how to put it right/);
    expect(() => setup(options())).toThrow(/current is there and isn't a link/);
  });
});

describe('the service check', () => {
  const query = ['show', '--property=Id,WorkingDirectory,User,Restart,SuccessExitStatus,RestartPreventExitStatus,RestartForceExitStatus', '--', '*.service'];

  test("finds the units whose working directory is the install's, and whether each restarts the host on 75 and on 1", () => {
    const unit = (id: string, restart: string, where: string, success = '', prevent = '', force = '') =>
      `Id=${id}\nWorkingDirectory=${where}\nRestart=${restart}\nSuccessExitStatus=${success}\n` +
      `RestartPreventExitStatus=${prevent}\nRestartForceExitStatus=${force}`;
    const shown = [
      unit('connectome.service', 'on-failure', `!${install}`),
      unit('other.service', 'always', '/elsewhere'),
      unit('second.service', 'always', `-${install}`),
      unit('third.service', 'no', install),
      unit('clean.service', 'on-failure', install, '75 SIGTERM'),
      unit('prevented.service', 'always', install, '', '75'),
      // A switch's restart, but not a failed trial's.
      unit('success.service', 'on-success', install, '75'),
      // Both, when each counts as a success.
      unit('both-success.service', 'on-success', install, '75 1'),
      unit('forced.service', 'no', install, '', '', '75 1'),
      unit('half-forced.service', 'no', install, '', '', '75'),
      // A status both prevented and forced is read as prevented.
      unit('both-lists.service', 'always', install, '', '1', '1'),
      // Prevented on 1 alone: a failed trial's exit leaves it stopped.
      unit('prevent-1.service', 'on-failure', install, '', '1'),
    ].join('\n\n');
    const calls: string[][] = [];
    const found = systemdUnits(install, (args) => {
      calls.push(args);
      const asked = args[0] === '--user' ? args.slice(1) : args;
      return { exitCode: args[0] === '--user' && JSON.stringify(asked) === JSON.stringify(query) ? 0 : 1, stdout: Buffer.from(shown) };
    });
    expect(found.unasked).toEqual(['system']);
    expect(found.found).toEqual([
      { id: 'connectome.service', settings: 'Restart=on-failure', restarts: true },
      { id: 'second.service', settings: 'Restart=always', restarts: true },
      { id: 'third.service', settings: 'Restart=no', restarts: false },
      { id: 'clean.service', settings: 'Restart=on-failure, SuccessExitStatus includes 75', restarts: false },
      { id: 'prevented.service', settings: 'Restart=always, RestartPreventExitStatus includes 75', restarts: false },
      { id: 'success.service', settings: 'Restart=on-success, SuccessExitStatus includes 75', restarts: false },
      { id: 'both-success.service', settings: 'Restart=on-success, SuccessExitStatus includes 75 and 1', restarts: true },
      { id: 'forced.service', settings: 'Restart=no, RestartForceExitStatus includes 75 and 1', restarts: true },
      { id: 'half-forced.service', settings: 'Restart=no, RestartForceExitStatus includes 75', restarts: false },
      { id: 'both-lists.service', settings: 'Restart=always, RestartPreventExitStatus includes 1, RestartForceExitStatus includes 1', restarts: false },
      { id: 'prevent-1.service', settings: 'Restart=on-failure, RestartPreventExitStatus includes 1', restarts: false },
    ]);
    expect(calls).toEqual([['--user', ...query], query]);
  });

  test("a unit only the system's query finds is found, and the manager that didn't answer is named", () => {
    const shown = `Id=connectome.service\nWorkingDirectory=${install}\nRestart=always`;
    const systemOnly = (args: string[]) => ({ exitCode: args[0] === '--user' ? 1 : 0, stdout: Buffer.from(shown) });
    expect(systemdUnits(install, systemOnly)).toEqual({
      found: [{ id: 'connectome.service', settings: 'Restart=always', restarts: true }], unasked: ['user'], unresolved: [], defaulted: [],
    });
    const elsewhere = `Id=other.service\nWorkingDirectory=/elsewhere\nRestart=always`;
    expect(systemdUnits(install, (args) => ({ exitCode: args[0] === '--user' ? 0 : 1, stdout: Buffer.from(elsewhere) })))
      .toEqual({ found: [], unasked: ['system'], unresolved: [], defaulted: [] });
    expect(systemdUnits(install, () => ({ exitCode: 0, stdout: Buffer.from(elsewhere) }))).toEqual({ found: [], unasked: [], unresolved: [], defaulted: [] });
  });

  test("a unit whose directory this user can't resolve is named as such, and the rest are still read", () => {
    const shut = join(dir, 'shut');
    mkdirSync(join(shut, 'svc'), { recursive: true });
    chmodSync(shut, 0o600);
    const shown = [
      `Id=private.service\nWorkingDirectory=${join(shut, 'svc')}\nRestart=always`,
      `Id=connectome.service\nWorkingDirectory=${install}\nRestart=always`,
    ].join('\n\n');
    try {
      expect(systemdUnits(install, (args) => ({ exitCode: args[0] === '--user' ? 0 : 1, stdout: Buffer.from(shown) }))).toEqual({
        found: [{ id: 'connectome.service', settings: 'Restart=always', restarts: true }], unasked: ['system'],
        unresolved: ['private.service'], defaulted: [],
      });
    } finally {
      chmodSync(shut, 0o755);
    }
  });

  test("a unit that sets no working directory runs in its manager's default, and is named, not checked, when setup runs there; ~ is a home", () => {
    {
      const user = [
        `Id=sets-none.service\nWorkingDirectory=!${install}\nRestart=no`,
        'Id=tilde.service\nWorkingDirectory=!~\nRestart=always',
        'Id=elsewhere.service\nWorkingDirectory=/elsewhere\nRestart=always',
      ].join('\n\n');
      const system = 'Id=system-none.service\nWorkingDirectory=\nRestart=always\n\nId=system-tilde.service\nWorkingDirectory=!~\nRestart=always';
      for (const home of [install, `${install}/`]) {
        expect(systemdUnits(install, (args) => ({ exitCode: 0, stdout: Buffer.from(args[0] === '--user' ? user : system) }), home, () => null)).toEqual({
          found: [{ id: 'tilde.service', settings: 'Restart=always', restarts: true }], unasked: [],
          unresolved: ['system-tilde.service'], defaulted: ['sets-none.service'],
        });
      }
      // A home given through a link is the same home.
      const linked = join(dir, 'home-link');
      symlinkSync(install, linked);
      expect(systemdUnits(install, (args) => ({ exitCode: 0, stdout: Buffer.from(args[0] === '--user' ? user : '') }), linked,
        () => null).defaulted).toEqual(['sets-none.service']);
      // A home that can't be resolved leaves the rule off: the unit's directory is read as set, and named as unresolved.
      const shut = join(dir, 'shut-home');
      mkdirSync(join(shut, 'home'), { recursive: true });
      chmodSync(shut, 0o600);
      try {
        const behind = `Id=behind.service\nWorkingDirectory=!${join(shut, 'home')}\nRestart=always`;
        expect(systemdUnits(install, (args) => ({ exitCode: 0, stdout: Buffer.from(args[0] === '--user' ? behind : '') }),
          join(shut, 'home'), () => null)).toEqual({ found: [], unasked: [], unresolved: ['behind.service'], defaulted: [] });
      } finally {
        chmodSync(shut, 0o755);
      }
      // One that sets the home itself, without the `!`, is found.
      const explicit = `Id=explicit.service\nWorkingDirectory=${install}\nRestart=no`;
      expect(systemdUnits(install, (args) => ({ exitCode: 0, stdout: Buffer.from(args[0] === '--user' ? explicit : '') }), install).found)
        .toEqual([{ id: 'explicit.service', settings: 'Restart=no', restarts: false }]);
      // A system unit's ~ is its User='s home, root's when it names none, found when it's this directory.
      const homes: Record<string, string> = { connectome: install, root: '/root' };
      const system2 = 'Id=as-user.service\nWorkingDirectory=!~\nUser=connectome\nRestart=always\n\n' +
        'Id=as-root.service\nWorkingDirectory=!~\nUser=\nRestart=always';
      expect(systemdUnits(install, (args) => ({ exitCode: 0, stdout: Buffer.from(args[0] === '--user' ? '' : system2) }), dir,
        (name) => homes[name] ?? null)).toEqual({
        found: [{ id: 'as-user.service', settings: 'Restart=always', restarts: true }], unasked: [], unresolved: [], defaulted: [],
      });
    }
    // Run elsewhere, a unit that sets none is neither found nor named.
    const none = `Id=sets-none.service\nWorkingDirectory=!${dir}\nRestart=no`;
    expect(systemdUnits(install, (args) => ({ exitCode: 0, stdout: Buffer.from(args[0] === '--user' ? none : '') }), dir)).toEqual({
      found: [], unasked: [], unresolved: [], defaulted: [],
    });
  });

  test("run from /, a system unit that sets no working directory is named; an empty answer names no unit", () => {
    const system = 'Id=sets-none.service\nWorkingDirectory=\nRestart=always';
    expect(systemdUnits('/', (args) => ({ exitCode: 0, stdout: Buffer.from(args[0] === '--user' ? '' : system) }), dir)).toEqual({
      found: [], unasked: [], unresolved: [], defaulted: ['sets-none.service'],
    });
    expect(systemdUnits('/', () => ({ exitCode: 0, stdout: Buffer.from('') }), dir)).toEqual({ found: [], unasked: [], unresolved: [], defaulted: [] });
  });

  test("a user's home from /etc/passwd, and none for a user it doesn't name, or where it can't be read", () => {
    const passwd = join(dir, 'passwd');
    writeFileSync(passwd, 'root:x:0:0:root:/root:/bin/sh\nconnectome:x:1001:1001::/srv/connectome:/usr/sbin/nologin\nnohome:x:1002:1002:::\n');
    expect(passwdHome('connectome', passwd)).toBe('/srv/connectome');
    expect(passwdHome('root', passwd)).toBe('/root');
    expect(passwdHome('nohome', passwd)).toBe(null);
    expect(passwdHome('no-such-user-here', passwd)).toBe(null);
    expect(passwdHome('connectome', join(dir, 'nowhere'))).toBe(null);
  });

  test("names both managers when neither of systemd's queries answers", () => {
    const neither = { found: [], unasked: ['user', 'system'], unresolved: [], defaulted: [] };
    expect(systemdUnits(install, () => ({ exitCode: 1, stdout: Buffer.from('') }))).toEqual(neither);
    expect(systemdUnits(install, () => { throw new Error('no systemctl'); })).toEqual(neither);
  });
});
