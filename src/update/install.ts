import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  ContractError, copyLabelPath, installPaths, lastCopy, readCurrent, readJournal, readMark, releaseDir,
} from './contract.js';
import { exists, syncPath } from './data-swap.js';
import type { ReleaseHere } from './host.js';
import { HOST_ENTRY, LAUNCHER, RELEASE_HOST } from './launcher.js';

export const PACKAGE = '@animalabs/connectome-host';

export const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const WORKING = '.tmp';

const LOCKFILES: Array<{ name: string; manager: 'npm' | 'bun' }> = [
  { name: 'package-lock.json', manager: 'npm' },
  { name: 'bun.lock', manager: 'bun' },
  { name: 'bun.lockb', manager: 'bun' },
];

const OUTPUT_TAIL = 2000;

export const SYNC_WIDTH = 16;

export interface InstallOps {
  run(manager: 'npm' | 'bun', args: string[], cwd: string): Promise<{ status: number | null; output: string }>;
  report(line: string): void;
}

let underWay: string | null = null;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
    syncPath(releases);
  } finally {
    underWay = null;
  }
}

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

/** A link is synced as its directory's entry. */
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
      : label === null ? (readJournal(here.root).some((line) => line.step === 'copy' && line.outcome === 'ok')
        ? 'the copy\'s label isn\'t there, though the journal records a copy taken, so it was lost and nothing says ' +
          'which release a Go back needs'
        : 'the copy\'s label isn\'t there, and the journal records no copy taken, so nothing says which release a Go ' +
          'back needs')
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
  const cut = names.filter((name) => name.endsWith(WORKING) && !keep.has(name));
  const unneeded = unknown === null ? names.filter((name) => !keep.has(name) &&
    existsSync(join(paths.releases, name, HOST_ENTRY))) : [];
  for (const name of new Set([...cut, ...unneeded])) {
    const path = join(paths.releases, name);
    const aside = name.endsWith(WORKING) ? path : `${path}${WORKING}`;
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
      const child = spawn(manager === 'bun' ? process.execPath : 'npm', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      child.on('error', (error) => { done({ status: null, output: `${output}${errorText(error)}` }); });
      child.on('close', (status) => { done({ status, output }); });
    }),
    report: (text) => { writeSync(2, `${text}\n`); },
  };
}
