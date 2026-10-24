/**
 * Installing a release beside the running one (contract.ts): the step of an
 * update that the host's Update takes while everything keeps running. It
 * installs one exact version of the package as `releases/<version>`, so the
 * release is there whole or isn't there at all, and writes no mark: Restart
 * writes it, once the host is quiet (update.ts), so no start before the
 * operator's Restart switches release.
 *
 * Which version to install is Update's to decide, from the registry's
 * manifest of it: Update refuses a release deprecated on npm, one no newer
 * than the running one, and one whose Bun floor is above the Bun running this
 * host, before it calls this.
 *
 * Only a host started through the install's entry point calls it, and that
 * host holds the install's lock while it runs (takeLock), so neither a
 * launcher nor another host writes `releases/` meanwhile. Within the host,
 * one install runs at a time. Its work on a release's whole tree, syncing one
 * and removing one, goes through fs/promises, so the host it runs in goes on
 * serving meanwhile: on the VPS, syncing a release of 21,784 entries by sync
 * calls held the event loop for 15 s (J29000).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  ContractError, copyLabelPath, installPaths, lastCopy, readCurrent, readMark, releaseDir,
} from './contract.js';
import { exists, syncPath } from './data-swap.js';
import type { ReleaseHere } from './host.js';
import { HOST_ENTRY, LAUNCHER, RELEASE_HOST } from './launcher.js';

export const PACKAGE = '@animalabs/connectome-host';

/** An exact version as npm publishes one: release numbers, then any prerelease.
 *  A release's directory in `releases/` is named by one. */
export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The suffix of unfinished work in `releases/`: an install under way,
 *  setup's first copy, and a release renamed aside for its removal. */
const WORKING = '.tmp';

/** The lockfiles a release may hold, each with the manager that writes it, in
 *  the order one is chosen when a release holds several. */
const LOCKFILES: Array<{ name: string; manager: 'npm' | 'bun' }> = [
  { name: 'package-lock.json', manager: 'npm' },
  { name: 'bun.lock', manager: 'bun' },
  { name: 'bun.lockb', manager: 'bun' },
];

/** How much of a failed manager's output a refusal quotes, from its end. */
const OUTPUT_TAIL = 2000;

/** How many of a release's files and directories are synced at once. */
const SYNC_WIDTH = 16;

/** What installing needs from the machine, given to it so tests can stand in. */
export interface InstallOps {
  /** Run a package manager, `npm` or `bun`, with `args` in `cwd`: its exit
   *  status, null when it couldn't start or ended on a signal, and its
   *  output, both streams. */
  run(manager: 'npm' | 'bun', args: string[], cwd: string): Promise<{ status: number | null; output: string }>;
  /** A line for the operator, in the host's log. */
  report(line: string): void;
}

/** The version an install of which is under way in this process. */
let underWay: string | null = null;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Install `version` as `releases/<version>`, beside the release `here` runs.
 * A ContractError says why the release isn't installed. Anything else thrown
 * is the filesystem's own error, and the release isn't installed then
 * either, except when the last sync of `releases/` failed: the release is in
 * place, and a retry reuses it and makes that sync again.
 */
export async function installRelease(here: ReleaseHere, version: string, ops: InstallOps = machineInstallOps()): Promise<void> {
  if (!EXACT_VERSION.test(version)) {
    throw new ContractError(`${JSON.stringify(version)} isn't an exact version of ${PACKAGE}, such as 0.12.0.`);
  }
  if (version.endsWith(WORKING)) {
    throw new ContractError(`${version} ends in ${WORKING}, which names unfinished work in releases/, so it ` +
      'can\'t be installed here.');
  }
  if (version === here.release) throw new ContractError(`This host already runs ${version}.`);
  if (underWay !== null) {
    throw new ContractError(`An install of ${underWay} is under way. Wait for it to end, or restart the host to end ` +
      'one that hangs, then ask again.');
  }
  underWay = version;
  try {
    const { releases } = installPaths(here.root);
    const release = releaseDir(here.root, version);
    await prune(here, version, ops);
    // Not following a link, so a dangling one gets the host check's refusal.
    if (exists(release)) {
      const problem = hostProblem(release, version);
      if (problem !== null) {
        throw new ContractError(`${release} is there, but ${problem}, so it isn't the release ${version}. Remove it, ` +
          'then update again.');
      }
      ops.report(`[update] ${version} is already installed in ${release}, so it isn't installed again.`);
    } else {
      const tmp = `${release}${WORKING}`;
      try {
        mkdirSync(tmp);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        throw new ContractError(`${tmp}, which an earlier install of ${version} left, couldn't be removed, so ` +
          `${version} can't be installed. Remove it, then update again.`);
      }
      try {
        await installInto(tmp, releaseDir(here.root, here.release), version, ops);
        await syncTree(tmp);
        renameSync(tmp, release);
      } catch (error) {
        try {
          await fsp.rm(tmp, { recursive: true, force: true });
        } catch (removal) {
          ops.report(`[update] ${tmp}, the install that failed, couldn't be removed, and the next install removes it: ` +
            errorText(removal));
        }
        throw error;
      }
    }
    // After a reuse too, so a retry makes the sync a failed call didn't.
    syncPath(releases);
  } finally {
    underWay = null;
  }
}

/** Install `version` in `tmp` from the running release's package.json and
 *  lockfile with the manager that wrote the lockfile, as an operator updating
 *  by hand would (docs/DEPLOYMENTS.md, "Updating an install"), so the
 *  operator's other packages keep their locked versions when the release has
 *  a lockfile. Unlike by hand, the exact version is pinned in package.json,
 *  so it names the release it holds. Then check that the host is in place at
 *  `version`. */
async function installInto(tmp: string, running: string, version: string, ops: InstallOps): Promise<void> {
  const lock = LOCKFILES.find(({ name }) => existsSync(join(running, name)));
  copyFileSync(join(running, 'package.json'), join(tmp, 'package.json'));
  if (lock) copyFileSync(join(running, lock.name), join(tmp, lock.name));
  const manager = lock?.manager ?? 'npm';
  const args = manager === 'npm'
    ? ['install', '--save-exact', '--no-audit', '--no-fund', `${PACKAGE}@${version}`]
    : ['add', '--exact', `${PACKAGE}@${version}`];
  const { status, output } = await ops.run(manager, args, tmp);
  const command = `${manager} ${args.join(' ')}`;
  if (status !== 0) {
    const tail = output.length > OUTPUT_TAIL ? `…${output.slice(-OUTPUT_TAIL)}` : output;
    const how = status !== null ? `exited ${status}`
      : 'gave no exit status, so it couldn\'t start or was stopped by a signal' +
        (manager === 'npm' ? ' (if its output says npm isn\'t in the PATH, as Bun\'s "Executable not found in $PATH" ' +
          'does, the service that runs the host needs a PATH that has npm)' : '');
    throw new ContractError(`Installing ${version} failed, so it isn't installed: \`${command}\` ${how}. Its output ` +
      `ends:\n${tail.trimEnd()}`);
  }
  const problem = hostProblem(tmp, version);
  if (problem !== null) {
    throw new ContractError(`Installing ${version} with \`${command}\` didn't put its host in place: ${problem}, so it ` +
      "isn't installed.");
  }
}

/** What keeps the host in `dir`, a release's directory, from being `version`'s,
 *  or null when nothing does: its package.json says `version`, and its entry
 *  and its launcher, which a switch imports (checkRelease), are there.
 *  Restart switches only to a release this passes (update.ts). */
export function hostProblem(dir: string, version: string): string | null {
  const manifest = join(dir, RELEASE_HOST, 'package.json');
  let installed: unknown;
  try {
    installed = (JSON.parse(readFileSync(manifest, 'utf-8')) as { version?: unknown } | null)?.version;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? `${manifest} isn't there`
      : `${manifest} can't be read (${errorText(error)})`;
  }
  if (installed !== version) {
    return typeof installed === 'string' ? `its host is ${installed}` : `${manifest} names no version`;
  }
  for (const file of [HOST_ENTRY, LAUNCHER]) {
    if (!existsSync(join(dir, file))) return `${join(dir, file)} isn't there`;
  }
  return null;
}

/** Sync each file and directory under `dir`, and `dir`, so a rename of `dir`
 *  can't outlive on disk what it holds, as setup's copy of its first release
 *  does (copyTree). A link is synced as its directory's entry. SYNC_WIDTH at
 *  a time: on the VPS, a release of 21,784 entries took 5 s so, and 29 s one
 *  at a time (J29000). */
async function syncTree(dir: string): Promise<void> {
  const paths: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await fsp.readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
    }
    paths.push(at);
  };
  await walk(dir);
  let next = 0;
  await Promise.all(Array.from({ length: SYNC_WIDTH }, async () => {
    while (next < paths.length) {
      const handle = await fsp.open(paths[next++]!, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }));
}

/** Remove what installs cut off left, and each release nothing names: an
 *  entry holding its host that's none of the release `current` names, the
 *  running one, the one the copy holds the data of, which a Go back returns
 *  to, the one a standing mark asks for, and the one being installed. After a
 *  switch, releases/ then holds the running release, the one a Go back
 *  returns to, and, until the next install removes it, the one before that.
 *
 *  A release is removed only when `current` and the copy's label are both
 *  there, and the label names a release, to say what a start and a Go back
 *  need. A labelled copy is there from an install's first switch on, and a
 *  start settles a switch cut off while it moved one before any host runs
 *  (settleCopy), so without one there has been no switch yet, or something
 *  has damaged it. Then, or when one of them can't be read, it says so and
 *  removes only what cuts left, keeping the names it could read.
 *
 *  A `.tmp` nothing keeps is what an install, a removal or setup's first copy
 *  cut off left, and is removed whatever it holds. installRelease refuses a
 *  version so named, so only setup could make a release that is, and one
 *  that's kept stays. A release is renamed to a `.tmp` before its removal,
 *  and the rename synced, so a removal cut short never leaves part of a
 *  release under its own name; and releases/ is synced before a `.tmp` is
 *  removed, since its rename aside may not have been. A removal that fails
 *  is reported where what's left stands, and the install goes on, since
 *  nothing needs what it would have removed. Anything else in `releases/`,
 *  which nothing the update does puts there, is left alone. */
async function prune(here: ReleaseHere, version: string, ops: InstallOps): Promise<void> {
  const paths = installPaths(here.root);
  const keep = new Set([here.release, version]);
  let unknown: string | null;
  try {
    const current = readCurrent(here.root);
    if (current !== null) keep.add(current);
    const label = lastCopy(here.root);
    if (typeof label?.from === 'string') keep.add(label.from);
    const to = readMark(here.root)?.to;
    if (typeof to === 'string') keep.add(to);
    unknown = current === null ? `${paths.current} isn't there`
      : label === null ? 'the copy\'s label isn\'t there, since no switch has taken a copy yet or it was lost, so nothing ' +
        'says which release a Go back needs'
      : typeof label.from !== 'string' ? `the copy's label at ${copyLabelPath(paths.copy)} names no release` : null;
  } catch (error) {
    unknown = `which releases a start, a Go back or a request needs can't be told (${errorText(error)})`;
  }
  if (unknown !== null) ops.report(`[update] No older release is removed this time: ${unknown}.`);
  let names: string[];
  try {
    names = readdirSync(paths.releases);
  } catch (error) {
    ops.report(`[update] Nothing in ${paths.releases} is removed this time: it can't be listed (${errorText(error)}).`);
    return;
  }
  // What cuts left first, so a release's rename aside doesn't meet it.
  const cut = names.filter((name) => name.endsWith(WORKING) && !keep.has(name));
  const unneeded = unknown === null ? names.filter((name) => !keep.has(name) &&
    existsSync(join(paths.releases, name, HOST_ENTRY))) : [];
  for (const name of new Set([...cut, ...unneeded])) {
    const path = join(paths.releases, name);
    const aside = name.endsWith(WORKING) ? path : `${path}${WORKING}`;
    // Where it stands, which a failure reports.
    let at = path;
    try {
      if (aside !== path) renameSync(path, aside);
      at = aside;
      syncPath(paths.releases);
      await fsp.rm(aside, { recursive: true, force: true });
    } catch (error) {
      ops.report(`[update] ${at}, which nothing needs, couldn't be removed, and the next install tries again: ` +
        errorText(error));
    }
  }
}

export function machineInstallOps(): InstallOps {
  return {
    run: (manager, args, cwd) => new Promise((done) => {
      let output = '';
      const keep = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-2 * OUTPUT_TAIL); };
      // The Bun running this host, rather than whichever is first on PATH.
      const child = spawn(manager === 'bun' ? process.execPath : 'npm', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      child.on('error', (error) => { done({ status: null, output: `${output}${errorText(error)}` }); });
      child.on('close', (status) => { done({ status, output }); });
    }),
    report: (text) => { writeSync(2, `${text}\n`); },
  };
}
