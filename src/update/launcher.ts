import {
  accessSync, chmodSync, constants, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statfsSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  ContractError, ENTRY_POINT, INSTALL_ROOT_ENV, ITEM_UPDATE_DIR, appendJournal, childrenFilePath, connectedWhenMarked,
  copyItemName, copyLabelPath, goBackListPath, installPaths, isChildEntry, itemSetAsideDir, lastCopy, pendingGoBack,
  readCurrent, readGoBackList, readJournal, readMark, readRecord, realOrResolved, releaseDir, setAsideDir,
  unfinishedTrial, unsyncedText, writeJsonAtomic, writeMark,
  type ChildrenFile, type CopyLabel, type GoBackList, type InstallRecord, type JournalLine, type LockRecord, type Mark,
  type PlaceKind,
} from './contract.js';
import {
  PRIVATE_DIR_MODE, copyTree, drive, exists, keepFile, makeDirs, putFileBack, removeTree, replaceFile, sameContent,
  spaceTaken, syncEntries, syncPath, type FileKeep,
} from './data-swap.js';
import { agentOverlayPath } from './agent-overlay-path.js';

/** Where a release's host is inside its directory, one npm install of the
 *  package. The entry point imports the launcher from here, so neither path
 *  ever moves. */
export const RELEASE_HOST = join('node_modules', '@animalabs', 'connectome-host');
export const HOST_ENTRY = join(RELEASE_HOST, 'src', 'index.ts');
export const LAUNCHER = join(RELEASE_HOST, 'src', 'update', 'launcher.ts');

const ROOM_MARGIN = 256 * 2 ** 20;

export interface LauncherOps {
  now(): Date;
  report(line: string): void;
  dataDir(): string;
  agentOverlay(): string;
  cwd(): string;
  bootId(): string | null;
  pidAlive(pid: number): boolean;
  groupAlive(pid: number): boolean;
  importModule(path: string): Promise<unknown>;
  freeBytes(path: string): number;
  mountPoints(): string[] | null;
  sleep(ms: number): void;
}

export interface Start {
  release: string;
  trial: boolean;
}

export function releaseEntry(root: string, version: string): string {
  return join(releaseDir(root, version), HOST_ENTRY);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

function mayWrite(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return statSync(path).uid === process.getuid?.();
  }
}

/** Whether this process holds CAP_FOWNER, which lets it take an entry out of
 *  a directory with the sticky bit whatever their owners: bit 3 of the
 *  effective set in /proc/self/status. Where that isn't said, root is taken
 *  to hold it, as it does unless something dropped it. In a user namespace
 *  it covers only entries whose owner the namespace maps, which this doesn't
 *  ask. */
function holdsFowner(): boolean {
  let effective: string | undefined;
  try {
    effective = /^CapEff:\s*([0-9a-f]+)$/m.exec(readFileSync('/proc/self/status', 'utf-8'))?.[1];
  } catch {
    effective = undefined;
  }
  return effective === undefined ? process.getuid?.() === 0 : (BigInt(`0x${effective}`) & 8n) !== 0n;
}

/** The entries of `dir`, named by `names`, that its sticky bit keeps this
 *  process from taking out of it: when it has the bit, and this process
 *  neither owns it nor holds CAP_FOWNER, each entry this process doesn't own,
 *  as a link is owned in its own right; otherwise none. */
function stuckIn(dir: string, names: () => string[]): string[] {
  const stat = statSync(dir);
  const uid = process.getuid?.();
  if ((stat.mode & 0o1000) === 0 || stat.uid === uid || holdsFowner()) return [];
  return names().map((name) => join(dir, name)).filter((path) => lstatSync(path).uid !== uid);
}

/** What a drive of the directory `dir` couldn't move out of it, into an
 *  area inside it, and why: an entry its sticky bit keeps there (stuckIn),
 *  or a directory another owns that this process can't write, since the
 *  kernel asks for write on a directory moved to another parent (moveEntries
 *  gives owner write to one this process owns); null when it could move them
 *  all. */
function heldIn(dir: string): { path: string; why: 'sticky' | 'unwritable' } | null {
  const names = () => readdirSync(dir).filter((name) => name !== ITEM_UPDATE_DIR);
  const stuck = stuckIn(dir, names)[0];
  if (stuck !== undefined) return { path: stuck, why: 'sticky' };
  const uid = process.getuid?.();
  for (const path of names().map((name) => join(dir, name))) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.uid === uid) continue;
    try {
      accessSync(path, constants.W_OK);
    } catch {
      return { path, why: 'unwritable' };
    }
  }
  return null;
}

function heldText(held: { path: string; why: 'sticky' | 'unwritable' }, moves: string): string {
  const dir = dirname(held.path);
  return held.why === 'sticky'
    ? `${held.path} is in ${dir}, which has the sticky bit, and this process owns neither, so ${moves} couldn't ` +
      `move it. Make this user the owner of ${held.path} or of ${dir}, or take the sticky bit off ${dir}`
    : `${held.path} is a directory another owns that this process can't write, and ${moves} moves it out of ` +
      `${dir}, which a directory allows only to a process that may write it. Give this user write on ` +
      `${held.path}, or make this user its owner`;
}

function writableFilesystem(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'EROFS';
  }
  return true;
}

function unwritableDirectory(dirs: string[]): string | null {
  for (const dir of dirs) {
    try {
      accessSync(dir, constants.R_OK | constants.W_OK | constants.X_OK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === 'EROFS'
        ? `${dir} is on a read-only filesystem, and an update changes what's in it`
        : `${dir} can't be read, written and searched by this process (${code}), and an update changes what's in ` +
          'it, and syncs it. Give this user read, write and search on it';
    }
  }
  return null;
}

export class LockHeld extends ContractError {}

export function takeLock(root: string, ops: LauncherOps): void {
  const { lock } = installPaths(root);
  const bootId = ops.bootId();
  const mine = `${lock}.${process.pid}.tmp`;
  writeFileSync(mine, `${JSON.stringify({ v: 1, pid: process.pid, bootId, at: ops.now().toISOString() } satisfies LockRecord, null, 2)}\n`);
  try {
    syncPath(mine);
    for (let attempt = 0; ; attempt++) {
      try {
        linkSync(mine, lock);
        syncPath(dirname(lock));
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const holder = readRecord<LockRecord>(lock, 'lock');
      if (holder === null) continue;
      if (holder.pid === process.pid) {
        renameSync(mine, lock);
        syncPath(dirname(lock));
        return;
      }
      if (ops.pidAlive(holder.pid) && (holder.bootId === null || bootId === null || holder.bootId === bootId)) {
        throw new LockHeld(
          `Another start of this install holds its lock (${lock}): process ${holder.pid}, since ${holder.at}. ` +
          'An install runs one host at a time. If that process is this install\'s host, stop it first; if it\'s ' +
          'something else that reused the number, remove the lock file.',
        );
      }
      if (attempt > 0) {
        throw new ContractError(`The lock at ${lock} was left by process ${holder.pid}, which has ended, and taking it over failed twice.`);
      }
      const aside = `${lock}.${process.pid}.stale`;
      try {
        renameSync(lock, aside);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        continue;
      }
      const moved = readRecord<LockRecord>(aside, 'lock');
      if (moved?.pid !== holder.pid || moved.at !== holder.at) {
        try {
          linkSync(aside, lock);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      rmSync(aside, { force: true });
    }
  } finally {
    rmSync(mine, { force: true });
  }
}

export function readInstallRecord(root: string): InstallRecord {
  const { install } = installPaths(root);
  const record = readRecord<InstallRecord>(install, 'install record');
  if (record === null) {
    throw new ContractError(`This install has no record at ${install}, so it can't tell what data it serves. Run setup again.`);
  }
  if (typeof record.dataDir !== 'string' || !Array.isArray(record.extraState) ||
    !record.extraState.every((path) => typeof path === 'string')) {
    throw new ContractError(`The install record at ${install} has no data directory or list of extra state this release can read. Run setup again.`);
  }
  return record;
}

/** The install record, checked against the data directory a host started
 *  here would serve: an install serves one, the one setup recorded. */
export function readInstall(root: string, ops: LauncherOps): InstallRecord {
  const record = readInstallRecord(root);
  const serving = realOrResolved(ops.dataDir());
  if (realOrResolved(record.dataDir) !== serving) {
    throw new ContractError(
      `This install serves the data directory ${record.dataDir}, and this start would serve ${serving}. Each ` +
      'service needs an install of its own: start this one with its own data directory, or run setup for the other.',
    );
  }
  return record;
}

export function liveChildren(dataDir: string, ops: LauncherOps): string[] {
  const file = readRecord<ChildrenFile>(childrenFilePath(dataDir), "fleet's children file");
  if (file === null) return [];
  if (!Array.isArray(file.children)) {
    throw new ContractError(`The fleet's children file at ${childrenFilePath(dataDir)} has no list of children this release can read.`);
  }
  const bootId = ops.bootId();
  // Only a positive pid names one process: kill() takes 0 as this process's
  // group, -1 as every process it may signal, and another negative pid as
  // that group.
  const live: string[] = [];
  for (const child of file.children.filter(isChildEntry)) {
    const pid = child.pid;
    if (pid === null || !Number.isInteger(pid) || pid <= 0) continue;
    if (child.bootId !== null && bootId !== null && child.bootId !== bootId) continue;
    if (ops.pidAlive(pid)) live.push(`${child.name} (pid ${pid})`);
    else if (ops.groupAlive(pid)) live.push(`${child.name} (pid ${pid} has ended, and its process group ${pid} still has a member)`);
  }
  return live;
}

function childrenProblem(record: InstallRecord, ops: LauncherOps): string | null {
  const found = childrenFound(record, ops);
  return found === null ? null : `${found.reason.replace(/\.+$/, '')}. ${found.why}. To let it go ahead, ${found.remedy}`;
}

function childrenFound(record: InstallRecord, ops: LauncherOps): { reason: string; why: string; remedy: string } | null {
  const file = childrenFilePath(record.dataDir);
  const none = 'with nothing it lists, and no process in a group one led, still running';
  let children: string[];
  try {
    children = liveChildren(record.dataDir, ops);
  } catch (error) {
    const content = error instanceof ContractError;
    return {
      reason: content ? error.message : `the fleet's children file at ${file} can't be read: ${errorText(error)}`,
      why: 'That file says which fleet children may still be writing in their data directories',
      remedy: content ? `repair it, or, ${none}, remove it` : `make it readable to this user, or, ${none}, remove it`,
    };
  }
  if (children.length === 0) return null;
  return {
    reason: `fleet children are still running: ${children.join(', ')}`,
    why: 'A fleet child writes in its data directory, which an update mustn\'t change under it',
    remedy: 'stop each, ending its process group (kill -- -PID) where only that remains; if a pid is no longer the ' +
      `child's, remove its entry from ${file}`,
  };
}

/** How long a fallback or a resumed Go back waits for listed fleet children
 *  to end before it stops: long enough for one whose host has gone to finish
 *  what it's doing and end. A start that
 *  stops at once would be restarted at once, and a supervisor with a limit
 *  on starts, as systemd's is by default, would give up on the service. */
export const CHILDREN_WAIT_MS = 120_000;

function waitForChildren(record: InstallRecord, ops: LauncherOps, what: string): void {
  for (let waited = 0, found = childrenFound(record, ops); found !== null; found = childrenFound(record, ops)) {
    if (waited >= CHILDREN_WAIT_MS) {
      throw new ContractError(`${what}, and it can't go on: ${found.reason.replace(/\.+$/, '')}. ${found.why}, so ` +
        `nothing starts until that changes: ${found.remedy}. The next start goes on.`);
    }
    ops.sleep(250);
    waited += 250;
  }
}

export function dataItems(root: string, record: InstallRecord, ops: LauncherOps): { present: string[]; absent: string[] } {
  const candidates = [record.dataDir];
  const children = readRecord<ChildrenFile>(childrenFilePath(record.dataDir), "fleet's children file");
  for (const child of Array.isArray(children?.children) ? children.children.filter(isChildEntry) : []) {
    candidates.push(resolve(ops.cwd(), child.dataDir));
  }
  candidates.push(join(ops.cwd(), 'mcpl-servers.json'), ops.agentOverlay(), ...record.extraState);
  const there = new Set<string>();
  const missing = new Set<string>();
  for (const path of candidates) {
    if (!exists(path)) {
      missing.add(realOrResolved(path));
      continue;
    }
    let real: string;
    try {
      real = realpathSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new ContractError(`${path} is a link to something that isn't there, so it can't be copied as what it stands ` +
        'for. Point it at what it should name, or remove it');
    }
    const stat = lstatSync(real);
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new ContractError(`${real} is neither a file nor a directory, so a copy can't hold it. Move it out of the ` +
        'data, or remove it');
    }
    there.add(real);
  }
  const outermost = (paths: string[]) => paths.filter((path) => !paths.some((other) => other !== path && isUnder(path, other)));
  const present = outermost([...there].sort());
  const absent = outermost([...missing].sort().filter((path) => !present.some((item) => isUnder(path, item))));
  const rootReal = realOrResolved(root);
  for (const item of [...present, ...absent]) {
    if (isUnder(rootReal, item) || isUnder(item, rootReal)) {
      throw new ContractError(
        `The install's root ${rootReal} and its data ${item} are one inside the other, so a copy of the data ` +
        'would hold the copy itself. Keep the root apart from the data.',
      );
    }
  }
  return { present, absent };
}

export function mountsInside(dirs: string[], ops: LauncherOps): string[] | null {
  if (dirs.length === 0) return [];
  const listed = ops.mountPoints();
  if (listed === null) return null;
  return listed.filter((mount) => dirs.some((dir) => mount !== dir && isUnder(mount, dir))).sort();
}

/** Why a request can't go ahead while a mount is inside a data directory,
 *  or null when none is: an update moves a data directory's entries by
 *  renames, which would move a mount below one with it, or stop at one that
 *  is itself an entry. A list of mounts that couldn't be read can't say, so
 *  it's the reason. */
function mountProblem(dirs: string[], ops: LauncherOps): string | null {
  const mounts = mountsInside(dirs, ops);
  if (mounts === null) {
    return `${MOUNTS_UNREAD}, so whether a mount is inside a directory the update copies can't be told. An update ` +
      'moves such a directory\'s contents by renames, which would move a mount below one with it, or stop at one that ' +
      `is an entry itself, so it needs that list. ${MOUNTS_CHECK}`;
  }
  if (mounts.length === 0) return null;
  const inside = mounts.map((mount) => `${mount} is a mount inside ${dirs.find((dir) => isUnder(mount, dir))}`);
  return `${inside.join('; ')}. An update moves that directory's contents by renames, which would move a mount ` +
    'below one with it, or stop at one that is an entry itself, so this install can\'t update itself until it\'s ' +
    'mounted outside that directory';
}

const MOUNTS_UNREAD = 'the machine\'s list of mounts couldn\'t be read (/proc/self/mountinfo on Linux, `mount` on macOS)';
const MOUNTS_CHECK = 'On Linux, /proc/self/mountinfo is this process\'s own, so check that /proc is mounted; on macOS, ' +
  'that `mount` runs';

function stopForMounts(dir: string, ops: LauncherOps): void {
  const problem = mountProblem([dir], ops);
  if (problem !== null) {
    throw new ContractError(`Restoring ${dir} can't go on: ${problem}`);
  }
}

export async function checkRelease(root: string, version: string, ops: LauncherOps): Promise<void> {
  const entry = releaseEntry(root, version);
  if (!existsSync(entry)) throw new ContractError(`${version} isn't installed here: ${entry} isn't there`);
  const path = join(releaseDir(root, version), LAUNCHER);
  let launcher: unknown;
  try {
    launcher = await ops.importModule(path);
  } catch (error) {
    throw new ContractError(`${version}'s launcher doesn't load (${path}): ${errorText(error)}`);
  }
  if (typeof (launcher as { launch?: unknown } | null)?.launch !== 'function') {
    throw new ContractError(`${version}'s launcher (${path}) has no launch function`);
  }
}

function existingAncestor(path: string): string {
  let at = path;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  return at;
}

function roomProblem(root: string, needs: Array<{ path: string; bytes: number }>, purpose: string,
  ops: LauncherOps): string | null {
  const byDevice = new Map<number, { path: string; bytes: number }>();
  for (const { path, bytes } of needs) {
    const at = existingAncestor(path);
    const dev = statSync(at).dev;
    const entry = byDevice.get(dev) ?? { path: at, bytes: 0 };
    entry.bytes += bytes;
    byDevice.set(dev, entry);
  }
  for (const { path, bytes } of byDevice.values()) {
    const free = ops.freeBytes(path);
    if (free < bytes + ROOM_MARGIN) {
      const gib = (n: number) => `${(n / 2 ** 30).toFixed(1)} GiB`;
      return `the filesystem holding ${path} has ${gib(free)} free, and this needs ${gib(bytes + ROOM_MARGIN)} there, ` +
        `for ${purpose}. What earlier updates set aside stays until someone removes it: inside each directory the update copies, in ` +
        `${ITEM_UPDATE_DIR}/, and in ${installPaths(root).setAside}`;
    }
  }
  return null;
}

type Kind = PlaceKind;

function kindOf(path: string): Kind {
  try {
    return lstatSync(path).isDirectory() ? 'dir' : 'file';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    throw error;
  }
}

function kindWord(kind: Kind): string {
  return kind === 'dir' ? 'directory' : 'file';
}

interface Place {
  path: string;
  name: string;
}

function placesOf(paths: string[], from = 0): Place[] {
  return paths.map((path, at) => ({ path, name: copyItemName(from + at, path) }));
}

export function itemStagingDir(item: string, markId: string): string {
  return join(dirname(dirname(itemSetAsideDir(item, markId))), 'staging', markId);
}

function fileKeep(root: string, markId: string, name: string, phase: 'restore' | 'put-back'): FileKeep {
  const base = phase === 'restore' ? setAsideDir(root, markId) : join(setAsideDir(root, markId), 'put-back');
  return { kept: join(base, 'kept', name), absent: join(base, 'absent', name) };
}

function areas(dir: string, markId: string): { setAside: string; staging: string; any: boolean } {
  const setAside = itemSetAsideDir(dir, markId);
  const staging = itemStagingDir(dir, markId);
  const any = [setAside, staging].some((area) => ['', '.filling', '.emptying'].some((suffix) => exists(area + suffix)));
  return { setAside, staging, any };
}

function copyWhole(source: string, target: string): void {
  const tmp = `${target}.tmp`;
  removeTree(tmp);
  makeDirs(dirname(tmp), PRIVATE_DIR_MODE);
  copyTree(source, tmp);
  chmodSync(tmp, PRIVATE_DIR_MODE);
  syncPath(tmp);
  renameSync(tmp, target);
  syncPath(dirname(target));
}

function emptyArea(dir: string): void {
  makeDirs(dirname(dir), PRIVATE_DIR_MODE);
  mkdirSync(dir, { mode: PRIVATE_DIR_MODE });
  syncPath(dirname(dir));
}

function takeCopy(root: string, present: Place[], absent: Place[], from: string, mark: Mark, ops: LauncherOps): void {
  const { copy, copyTmp, copyPrev } = installPaths(root);
  removeTree(copyTmp);
  mkdirSync(copyTmp, { mode: PRIVATE_DIR_MODE });
  for (const place of present) copyTree(place.path, join(copyTmp, place.name));
  syncPath(copyTmp);
  const label: CopyLabel = {
    v: 1, from, at: ops.now().toISOString(), items: present, ...(absent.length > 0 ? { absent } : {}), mark: mark.id,
  };
  writeJsonAtomic(copyLabelPath(copyTmp), label);
  if (existsSync(copy)) {
    removeTree(copyPrev);
    renameSync(copy, copyPrev);
    syncPath(root);
  }
  renameSync(copyTmp, copy);
  syncPath(root);
  dropCopyPrev(root, ops);
}

function dropCopyPrev(root: string, ops: LauncherOps): void {
  try {
    removeTree(installPaths(root).copyPrev);
  } catch (error) {
    ops.report(`[update] Removing the copy before the last one (${installPaths(root).copyPrev}) failed, so it stays ` +
      `for now, and a later start tries again: ${errorText(error)}`);
  }
}

function dropUnfinishedCopy(root: string, ops: LauncherOps): void {
  const { copyTmp } = installPaths(root);
  try {
    removeTree(copyTmp);
  } catch (error) {
    ops.report(`[update] Removing a copy a switch left unfinished (${copyTmp}) failed, so it stays for now, and a ` +
      `later start tries again: ${errorText(error)}`);
  }
}

function settleCopy(root: string, ops: LauncherOps): void {
  const { copy, copyPrev } = installPaths(root);
  if (!existsSync(copyPrev)) return;
  if (existsSync(copy)) {
    dropCopyPrev(root, ops);
  } else {
    renameSync(copyPrev, copy);
    syncPath(root);
  }
}

function copyTargets(copy: string, label: CopyLabel): Array<Place & { target: Kind }> {
  return [
    ...label.items.map(({ path, name }) => ({ path, name, target: kindOf(join(copy, name)) })),
    ...(label.absent ?? []).map(({ path, name }) => ({ path, name, target: 'none' as const })),
  ];
}

function restorePlace(root: string, from: string, place: Place, target: Kind, markId: string, ops: LauncherOps): void {
  const now = kindOf(place.path);
  if (now !== 'none' && target !== 'none' && now !== target) {
    throw new ContractError(`${place.path} is a ${kindWord(now)}, and what's restored there is a ${kindWord(target)}, so ` +
      'one can\'t take the other\'s place');
  }
  if (target === 'file' || (target === 'none' && now === 'file')) {
    replaceFile(place.path, target === 'file' ? join(from, place.name) : null, fileKeep(root, markId, place.name, 'restore'));
    return;
  }
  if (target === 'none' && now === 'none') {
    if (existsSync(dirname(place.path))) syncEntries(dirname(place.path));
    return;
  }
  // mkdir's mode loses the bits the umask takes, and its setgid comes from
  // the parent rather than from the mode, so the chmod after sets it.
  const made = now === 'none';
  if (made) {
    makeDirs(dirname(place.path));
    const mode = (lstatSync(join(from, place.name)).mode & 0o7777) | 0o700;
    mkdirSync(place.path, { mode });
    if ((lstatSync(place.path).mode & 0o7777) !== mode) chmodSync(place.path, mode);
  } else {
    stopForMounts(place.path, ops);
  }
  const { setAside, staging, any } = areas(place.path, markId);
  if (!any) {
    if (target === 'dir') copyWhole(join(from, place.name), staging);
    else emptyArea(staging);
  }
  drive(place.path, setAside, staging);
  if (made) {
    syncPath(place.path);
    syncPath(dirname(place.path));
  } else {
    syncEntries(dirname(place.path));
  }
}

function clearGoBack(root: string, markId: string, ops: LauncherOps): void {
  let places: GoBackList['places'] = [];
  try {
    if (exists(goBackListPath(root, markId))) places = readGoBackList(root, markId);
  } catch (error) {
    ops.report(`[update] What the Go back under mark ${markId} kept stays where it is. ${errorText(error)} ` +
      `Its areas are inside each directory the update copies, in ${ITEM_UPDATE_DIR}, each named for that mark, with ` +
      `or without .tmp, .filling or .emptying after it; remove them and ${setAsideDir(root, markId)} when nothing ` +
      'there is wanted.');
    return;
  }
  // The areas' removal is synced before the list goes, so a power cut can't
  // bring an area back with nothing to name it.
  try {
    for (const place of places.filter((p) => kindOf(p.path) === 'dir')) {
      for (const area of [itemSetAsideDir(place.path, markId), itemStagingDir(place.path, markId)]) {
        for (const suffix of ['', '.tmp', '.filling', '.emptying']) removeTree(area + suffix);
        if (existsSync(dirname(area))) syncPath(dirname(area));
      }
    }
    removeTree(setAsideDir(root, markId));
  } catch (error) {
    ops.report(`[update] Removing what the Go back under mark ${markId} kept, or syncing its removal, failed, so ` +
      `what's left of it stays for now, and a later start tries again: ${errorText(error)}`);
  }
}

function putBack(root: string, markId: string, ops: LauncherOps): void {
  for (const place of readGoBackList(root, markId)) {
    const now = kindOf(place.path);
    const keep = fileKeep(root, markId, place.name, 'put-back');
    if (place.before === 'file' || (place.before === 'none' && place.target === 'file')) {
      if (now === 'dir') throw new ContractError(`${place.path} is a directory now, and what's put back there is a file`);
      putFileBack(place.path, fileKeep(root, markId, place.name, 'restore'), keep);
      continue;
    }
    if (place.before === 'dir') {
      if (now !== 'dir') {
        throw new ContractError(`${place.path} isn't a directory now, and what the Go back set aside was inside it`);
      }
      const { setAside, staging } = areas(place.path, markId);
      if (!['', '.filling', '.emptying'].some((suffix) => exists(setAside + suffix)) &&
        !['.filling', '.emptying'].some((suffix) => exists(staging + suffix))) continue;
      stopForMounts(place.path, ops);
      drive(place.path, staging, setAside);
      continue;
    }
    if (now === 'file') {
      replaceFile(place.path, null, keep);
    } else if (now === 'none') {
      if (existsSync(dirname(place.path))) syncEntries(dirname(place.path));
    } else if (now === 'dir') {
      const { setAside, staging, any } = areas(place.path, markId);
      removeTree(`${staging}.tmp`);
      const madeAndNeverFilled = !any && readdirSync(place.path).every((name) => name === ITEM_UPDATE_DIR);
      if (madeAndNeverFilled) continue;
      stopForMounts(place.path, ops);
      if (!any) emptyArea(setAside);
      drive(place.path, staging, setAside);
    }
  }
}

function line(ops: LauncherOps, fields: Omit<JournalLine, 'v' | 'at'>): Omit<JournalLine, 'v'> {
  return { at: ops.now().toISOString(), ...fields };
}

function refuse(root: string, ops: LauncherOps, step: JournalLine['step'], current: string, mark: Mark, reason: string,
  outcome: 'refused' | 'failed' = 'refused'): Start {
  appendJournal(root, line(ops, { step, from: current, to: mark.to, outcome, reason, mark: mark.id }));
  const what = mark.why === 'go-back' ? 'Go back' : 'switch';
  const { mark: markPath } = installPaths(root);
  const again = mark.why === 'go-back' ? `/update back, or \`${GO_BACK_FLAG}\` from a shell` : '/update restart';
  let dropped = `The request is dropped: once what refused it has cleared, ask again with ${again}.`;
  try {
    rmSync(markPath, { force: true });
  } catch (error) {
    dropped = `Its mark couldn't be removed (${errorText(error)}), so the next start tries it again: remove ` +
      `${markPath} to drop it.`;
  }
  try {
    if (!existsSync(markPath)) syncPath(root);
  } catch (error) {
    dropped += ` Syncing its removal failed (${errorText(error)}), so a power cut could bring the mark back, for the ` +
      'next start to try the request once more.';
  }
  ops.report(`[update] The ${what} to ${mark.to} didn't go ahead, so ${current} starts as it was: ` +
    `${reason.replace(/\.+$/, '')}. ${dropped}`);
  return { release: current, trial: false };
}

interface Refusal {
  step: JournalLine['step'];
  reason: string;
}

function refuseThrown(root: string, ops: LauncherOps, step: JournalLine['step'], current: string, mark: Mark,
  error: unknown): Start {
  return error instanceof ContractError
    ? refuse(root, ops, step, current, mark, error.message)
    : refuse(root, ops, step, current, mark, `checking it failed: ${errorText(error)}`, 'failed');
}

async function checkSwitch(root: string, record: InstallRecord, mark: Mark, ops: LauncherOps):
  Promise<Refusal | { present: Place[]; absent: Place[] }> {
  const children = childrenProblem(record, ops);
  if (children !== null) return { step: 'children-check', reason: children };
  try {
    await checkRelease(root, mark.to, ops);
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    return { step: 'trial-start', reason: error.message };
  }
  if (!existsSync(record.dataDir)) return { step: 'copy', reason: `the data directory ${record.dataDir} isn't there` };
  const { present, absent } = dataItems(root, record, ops);
  const dirs = present.filter((path) => statSync(path).isDirectory());
  const unwritable = unwritableDirectory(dirs);
  if (unwritable !== null) return { step: 'copy', reason: unwritable };
  const mounts = mountProblem(dirs, ops);
  if (mounts !== null) return { step: 'copy', reason: mounts };
  for (const dir of dirs) {
    const held = heldIn(dir);
    if (held !== null) return { step: 'copy', reason: heldText(held, `the fallback, if ${mark.to} fails before it commits,`) };
  }
  const places = placesOf(present);
  const room = roomProblem(root, places.flatMap((place) => {
    const bytes = spaceTaken(place.path);
    const copied = { path: root, bytes };
    if (statSync(place.path).isDirectory()) return [copied, { path: place.path, bytes }];
    const keptAtFallback = { path: root, bytes };
    const needs = [copied, keptAtFallback];
    return writableFilesystem(place.path) ? [...needs, { path: place.path, bytes }] : needs;
  }), `a copy of the data and room to restore it if ${mark.to} fails before it commits`, ops);
  if (room !== null) return { step: 'copy', reason: room };
  return { present: places, absent: placesOf(absent, present.length) };
}

async function switchTo(root: string, record: InstallRecord, mark: Mark, current: string, ops: LauncherOps): Promise<Start> {
  let checked: Refusal | { present: Place[]; absent: Place[] };
  try {
    checked = await checkSwitch(root, record, mark, ops);
  } catch (error) {
    return refuseThrown(root, ops, 'copy', current, mark, error);
  }
  if ('reason' in checked) return refuse(root, ops, checked.step, current, mark, checked.reason);
  try {
    takeCopy(root, checked.present, checked.absent, current, mark, ops);
  } catch (error) {
    settleCopy(root, ops);
    dropUnfinishedCopy(root, ops);
    return refuse(root, ops, 'copy', current, mark, `the copy failed: ${errorText(error)}`, 'failed');
  }
  appendJournal(root, line(ops, { step: 'copy', from: current, to: mark.to, outcome: 'ok', mark: mark.id }));
  appendJournal(root, line(ops, { step: 'trial-start', from: current, to: mark.to, outcome: 'ok', mark: mark.id }));
  const asked = connectedWhenMarked(mark);
  const commits = asked === null ? 'opened its stores and connected its servers, closed tabs aside'
    : asked.length === 0 ? `opened its stores, since ${current} had no server connected when it stopped`
    : `opened its stores and connected whichever of ${asked.join(', ')} it's configured with, the servers ${current} ` +
      'had connected when it stopped, closed tabs aside';
  ops.report(`[update] Starting ${mark.to} on trial, from ${current}. It commits once it has ${commits}; if it ends ` +
    `before that, the next start goes back to ${current} and its data.`);
  return { release: mark.to, trial: true };
}

async function checkGoBack(root: string, record: InstallRecord, mark: Mark, ops: LauncherOps):
  Promise<Refusal | { places: GoBackList['places']; source: string | null }> {
  await checkRelease(root, mark.to, ops);
  const children = childrenProblem(record, ops);
  if (children !== null) return { step: 'children-check', reason: children };
  const earlier = setAsideDir(root, mark.id);
  if (exists(earlier)) {
    return {
      step: 'go-back',
      reason: `an earlier attempt's preparation under mark ${mark.id} is still at ${earlier}, since a start ` +
        `couldn't clear it, and each start that tried says why. Remove it, and its areas inside each directory the update copies, in ${ITEM_UPDATE_DIR}, each named for that mark, with or without .tmp, .filling or .emptying after it`,
    };
  }
  let places: GoBackList['places'];
  let from: string | null = null;
  if (mark.keepData) {
    if (!existsSync(record.dataDir)) return { step: 'go-back', reason: `the data directory ${record.dataDir} isn't there` };
    const { present, absent } = dataItems(root, record, ops);
    places = [
      ...placesOf(present).map((place) => ({ ...place, before: kindOf(place.path), target: kindOf(place.path) })),
      ...placesOf(absent, present.length).map((place) => ({ ...place, before: 'none' as const, target: 'none' as const })),
    ];
  } else {
    const label = lastCopy(root);
    if (label === null || label.from !== mark.to) {
      return {
        step: 'go-back',
        reason: `there's no copy of ${mark.to}'s data to restore${label ? ` (the copy holds ${label.from}'s)` : ''}; ` +
          'a Go back that keeps the newer data needs none',
      };
    }
    from = installPaths(root).copy;
    const listed = copyTargets(from, label);
    const moved = listed.find((place) => realOrResolved(place.path) !== place.path);
    if (moved) {
      return {
        step: 'go-back',
        reason: `${moved.path}, where the copy of ${mark.to}'s data took a place, leads to ` +
          `${realOrResolved(moved.path)} now, through a link, and a Go back that restores the copy puts each place back ` +
          'where the copy took it. Put the place back there in place of the link, or go back keeping the newer data',
      };
    }
    const { present, absent } = dataItems(root, record, ops);
    const outer = [...present, ...absent].find((path) =>
      listed.some((place) => place.path !== path && isUnder(place.path, path)));
    if (outer) {
      const inner = listed.find((place) => place.path !== outer && isUnder(place.path, outer))!;
      return {
        step: 'go-back',
        reason: `${outer} is recorded now, and ${inner.path}, which the copy of ${mark.to}'s data took on its own, is ` +
          'inside it, so the copy can\'t put it back whole. Go back keeping the newer data, or, if it\'s extra state ' +
          `the record gained since the switch, take it out of extraState in ${installPaths(root).install}`,
      };
    }
    const added = [...present, ...absent].filter((path) =>
      !listed.some((place) => isUnder(path, place.path) || isUnder(place.path, path)));
    places = [
      ...listed.map((place) => ({ ...place, before: kindOf(place.path) })),
      ...placesOf(added, listed.length).map((place) => ({ ...place, before: kindOf(place.path), target: 'none' as const })),
    ];
    const clash = places.find((place) => place.before !== 'none' && place.target !== 'none' && place.before !== place.target);
    if (clash) {
      return {
        step: 'go-back',
        reason: `${clash.path} is a ${kindWord(clash.before)} now, and a ${kindWord(clash.target)} in the copy of ` +
          `${mark.to}'s data, so one can't take the other's place`,
      };
    }
  }
  // A file place it writes in place mustn't be a link, which the write
  // would go through. And one it takes away mustn't be a mount, which
  // can't go.
  const link = places.find((place) => place.before === 'file' && lstatSync(place.path).isSymbolicLink());
  if (link) {
    return { step: 'go-back', reason: `${link.path} is a link now, and a Go back writes a file in place, so it won't write ` +
      'through the link to what it names. Put the file itself there' };
  }
  const changes = (place: GoBackList['places'][number]) => (place.before === 'file' || place.target === 'file') &&
    (place.before !== place.target || (from !== null && !sameContent(place.path, join(from, place.name))));
  const fixed = places.find((place) => !writableFilesystem(existingAncestor(place.path)) && changes(place));
  if (fixed) {
    return { step: 'go-back', reason: `${fixed.path} is on a read-only filesystem, and the Go back would change it. ` +
      'Make that filesystem writable, or go back keeping the newer data' };
  }
  const locked = places.find((place) => place.before === 'file' && place.target === 'file' && !mayWrite(place.path) &&
    changes(place));
  if (locked) {
    return { step: 'go-back', reason: `${locked.path} can't be written by this process, which doesn't own it, and the ` +
      'Go back would change it. Give this user write on it, or go back keeping the newer data' };
  }
  const unwritable = unwritableDirectory([
    ...places.filter((place) => place.before === 'dir').map((place) => place.path),
    ...places.filter((place) => (place.before !== place.target && (place.before === 'file' || place.target === 'file')) ||
      (place.before === 'none' && place.target === 'dir')).map((place) => existingAncestor(dirname(place.path))),
  ]);
  if (unwritable !== null) return { step: 'go-back', reason: unwritable };
  const mounts = mountProblem(places.filter((place) => place.before === 'dir').map((place) => place.path), ops);
  if (mounts !== null) return { step: 'go-back', reason: mounts };
  for (const place of places) {
    const held = place.before === 'file' && place.target !== 'file'
      ? stuckIn(dirname(place.path), () => [basename(place.path)]).map((path) => ({ path, why: 'sticky' as const }))[0] ?? null
      : place.before === 'dir' ? heldIn(place.path) : null;
    if (held === null) continue;
    return { step: 'go-back', reason: heldText(held, from === null
      ? `the fallback, if ${mark.to} fails before it commits,` : 'the Go back') };
  }
  const takenAway = places.filter((place) => place.before === 'file' && place.target === 'none');
  if (takenAway.length > 0) {
    const listed = ops.mountPoints();
    if (listed === null) {
      return { step: 'go-back', reason: `${MOUNTS_UNREAD}, so whether a file the Go back takes away is a mount can't be ` +
        `told. ${MOUNTS_CHECK}` };
    }
    const mounted = takenAway.find((place) => listed.includes(place.path));
    if (mounted) {
      return { step: 'go-back', reason: `${mounted.path} is a mount, which a Go back can't take away. Unmount it, or go ` +
        'back keeping the newer data, which leaves it' };
    }
  }
  const source = from;
  const room = roomProblem(root, places.flatMap((place) => {
    const needs: Array<{ path: string; bytes: number }> = [];
    const content = () => spaceTaken(source !== null ? join(source, place.name) : place.path);
    const inPlace = place.before !== 'file' || writableFilesystem(place.path);
    if (place.target === 'dir') needs.push({ path: place.path, bytes: content() });
    if (place.before === 'file') {
      needs.push({ path: root, bytes: spaceTaken(place.path) });
      if (inPlace) needs.push({ path: place.path, bytes: spaceTaken(place.path) });
    }
    if (place.target === 'file') {
      needs.push({ path: root, bytes: content() });
      if (inPlace) needs.push({ path: place.path, bytes: content() });
    }
    return needs;
  }), 'what the Go back stages and keeps, and what it and its fallback would write', ops);
  if (room !== null) return { step: 'go-back', reason: room };
  return { places, source };
}

async function goBack(root: string, record: InstallRecord, mark: Mark, current: string, ops: LauncherOps): Promise<Start> {
  let checked: Refusal | { places: GoBackList['places']; source: string | null };
  try {
    checked = await checkGoBack(root, record, mark, ops);
  } catch (error) {
    return refuseThrown(root, ops, 'go-back', current, mark, error);
  }
  if ('reason' in checked) return refuse(root, ops, checked.step, current, mark, checked.reason);
  const { places, source } = checked;
  try {
    makeDirs(setAsideDir(root, mark.id), PRIVATE_DIR_MODE);
    writeJsonAtomic(goBackListPath(root, mark.id), { v: 1, places } satisfies GoBackList);
    for (const place of places) {
      const keep = fileKeep(root, mark.id, place.name, 'restore');
      if (source !== null) {
        if (place.before === 'dir' && place.target === 'dir') copyWhole(join(source, place.name), itemStagingDir(place.path, mark.id));
        if (place.before === 'file' || (place.before === 'none' && place.target === 'file')) keepFile(place.path, keep);
      } else {
        if (place.before === 'dir') copyWhole(place.path, itemSetAsideDir(place.path, mark.id));
        if (place.before === 'file') keepFile(place.path, keep);
      }
    }
  } catch (error) {
    clearGoBack(root, mark.id, ops);
    return refuse(root, ops, 'go-back', current, mark, `preparing it failed: ${errorText(error)}`, 'failed');
  }
  const goBackLine = line(ops, { step: 'go-back', from: current, to: mark.to, outcome: 'ok', mark: mark.id, keptData: Boolean(mark.keepData) });
  appendJournal(root, goBackLine);
  return finishGoBack(root, record, { v: 1, ...goBackLine }, current, ops);
}

async function finishGoBack(root: string, record: InstallRecord, goBackLine: JournalLine, current: string,
  ops: LauncherOps): Promise<Start> {
  const markId = goBackLine.mark;
  if (typeof markId !== 'string') {
    throw new ContractError(`The journal's go-back line to ${goBackLine.to} names no mark, so what it set aside can't be found.`);
  }
  waitForChildren(record, ops, `The Go back to ${goBackLine.to} is under way`);
  const failedPutBackKeeps = join(setAsideDir(root, markId), 'put-back');
  removeTree(failedPutBackKeeps);
  if (existsSync(setAsideDir(root, markId))) syncPath(setAsideDir(root, markId));
  try {
    if (!goBackLine.keptData) {
      const { copy } = installPaths(root);
      for (const place of readGoBackList(root, markId)) restorePlace(root, copy, place, place.target, markId, ops);
    }
    await checkRelease(root, goBackLine.to, ops);
  } catch (error) {
    appendJournal(root, line(ops, { step: 'trial-start', from: current, to: goBackLine.to, outcome: 'refused', reason: errorText(error), mark: markId }));
    return fallBackGoBack(root, goBackLine, current, `${goBackLine.to} couldn't start: ${errorText(error)}`, ops);
  }
  appendJournal(root, line(ops, { step: 'trial-start', from: current, to: goBackLine.to, outcome: 'ok', mark: markId }));
  ops.report(`[update] Starting ${goBackLine.to} on trial, going back from ${current}` +
    (goBackLine.keptData
      ? ' with the newer data kept'
      : ` with its own data restored, and the newer data kept aside under mark ${markId}`) +
    `. If it ends before it commits, the next start puts ${current}'s data back and starts it.`);
  return { release: goBackLine.to, trial: true };
}

function fallBackGoBack(root: string, goBackLine: JournalLine, current: string, why: string, ops: LauncherOps): Start {
  const markId = goBackLine.mark!;
  if (!goBackLine.keptData) {
    try {
      putBack(root, markId, ops);
    } catch (error) {
      appendJournal(root, line(ops, { step: 'fallback', from: goBackLine.to, to: current, outcome: 'failed', reason: errorText(error), mark: markId }));
      throw new ContractError(`The Go back to ${goBackLine.to} couldn't go on (${why}), and putting ${current}'s data back ` +
        `failed too (${errorText(error)}), so nothing starts: a release started now would run on data that's partly each. ` +
        'Each start tries again, going on with the Go back.');
    }
  }
  appendJournal(root, line(ops, { step: 'fallback', from: goBackLine.to, to: current, outcome: 'ok', reason: why, mark: markId }));
  if (goBackLine.keptData) clearGoBack(root, markId, ops);
  ops.report(`[update] The Go back to ${goBackLine.to} didn't go ahead (${why}), so ` +
    (goBackLine.keptData ? `${current} starts on its data as it was.` : `${current}'s data is back and it starts.`));
  return { release: current, trial: false };
}

function fallBackTrial(root: string, record: InstallRecord, trial: JournalLine, current: string, lines: JournalLine[],
  ops: LauncherOps): Start {
  const markId = trial.mark;
  const why = `${trial.to} ended before its commit`;
  waitForChildren(record, ops, why);
  const wasGoBack = typeof markId === 'string' &&
    lines.some((l) => l.step === 'go-back' && l.outcome === 'ok' && l.mark === markId);
  try {
    if (typeof markId !== 'string') throw new ContractError(`the journal's trial-start line for ${trial.to} names no mark`);
    if (wasGoBack) {
      putBack(root, markId, ops);
    } else {
      const label = lastCopy(root);
      const { copy } = installPaths(root);
      if (label === null) throw new ContractError(`there's no copy at ${copy} to restore`);
      if (label.from !== current || label.mark !== markId) {
        throw new ContractError(`the copy at ${copy} holds ${label.from}'s data for mark ${label.mark}, ` +
          `not ${current}'s for this switch's mark ${markId}`);
      }
      for (const place of copyTargets(copy, label)) restorePlace(root, copy, place, place.target, markId, ops);
    }
  } catch (error) {
    appendJournal(root, line(ops, { step: 'fallback', from: trial.to, to: current, outcome: 'failed', reason: errorText(error), ...(typeof markId === 'string' ? { mark: markId } : {}) }));
    throw new ContractError(`${why}, and going back to ${current} and its data failed: ${errorText(error)}. Nothing starts, ` +
      `since ${current} would run on ${trial.to}'s data. Each start tries the fallback again.`);
  }
  appendJournal(root, line(ops, { step: 'fallback', from: trial.to, to: current, outcome: 'ok', reason: why, mark: markId }));
  const kept = wasGoBack
    ? `inside each directory the update copies, in ${ITEM_UPDATE_DIR}/staging/${markId}, and its files under ` +
      `${join(setAsideDir(root, markId!), 'put-back', 'kept')}`
    : `inside each directory the update copies, in ${ITEM_UPDATE_DIR}/set-aside/${markId}, and its files under ${join(setAsideDir(root, markId!), 'kept')}`;
  ops.report(`[update] ${why}, so ${current}'s data is back and it starts. What ${trial.to} left is kept aside: ${kept}.`);
  return { release: current, trial: false };
}

function clearLeftovers(root: string, lines: JournalLine[], ops: LauncherOps): void {
  const { setAside } = installPaths(root);
  dropUnfinishedCopy(root, ops);
  const named = new Set(lines.filter((l) => l.outcome === 'ok' && typeof l.mark === 'string').map((l) => l.mark));
  let ids: string[] = [];
  try {
    ids = readdirSync(setAside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      ops.report(`[update] What earlier requests kept in ${setAside} can't be listed, so it stays for now: ` +
        `${errorText(error)}`);
    }
  }
  for (const id of ids) {
    if (!named.has(id)) clearGoBack(root, id, ops);
  }
  const ok = (step: JournalLine['step'], id: string) => lines.some((l) => l.step === step && l.outcome === 'ok' && l.mark === id);
  for (const goBackLine of lines) {
    const id = goBackLine.mark;
    if (goBackLine.step !== 'go-back' || goBackLine.outcome !== 'ok' || !goBackLine.keptData || typeof id !== 'string') continue;
    const trialEndedWithoutFallback = ok('trial-start', id) && !ok('fallback', id);
    const neverTried = ok('fallback', id) && !ok('trial-start', id);
    if (ids.includes(id) && (trialEndedWithoutFallback || neverTried)) clearGoBack(root, id, ops);
  }
}

export async function decide(root: string, ops: LauncherOps): Promise<Start> {
  takeLock(root, ops);
  settleCopy(root, ops);
  const record = readInstall(root, ops);
  // A start cut between a line's write and its sync leaves it in the page
  // cache, where this start would read it and a power cut could still take
  // it: synced first, nothing acts on a line that can be lost after.
  if (exists(installPaths(root).journal)) syncPath(installPaths(root).journal);
  const lines = readJournal(root);
  let current: string | null;
  try {
    current = readCurrent(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EINVAL') throw error;
    throw new ContractError(`This install has no release to start: ${installPaths(root).current} is there and isn't a ` +
      'link. Run setup again, which says how to put it right.');
  }
  if (current === null) {
    throw new ContractError(`This install has no release to start: ${installPaths(root).current} isn't there. Run setup again.`);
  }
  const trial = unfinishedTrial(lines, current);
  if (trial !== null) return fallBackTrial(root, record, trial, current, lines, ops);
  const pending = pendingGoBack(lines);
  if (pending !== null) {
    ops.report(`[update] Going on with the Go back to ${pending.to} that a start cut off.`);
    return finishGoBack(root, record, pending, current, ops);
  }
  clearLeftovers(root, lines, ops);
  let mark: Mark | null;
  try {
    mark = readMark(root);
  } catch (error) {
    const why = error instanceof ContractError ? error.message
      : `The mark at ${installPaths(root).mark} couldn't be read, or cleared once spent: ${errorText(error)}.`;
    ops.report(`[update] ${why} ${current} starts as it was.`);
    return { release: current, trial: false };
  }
  if (mark === null) return { release: current, trial: false };
  if (mark.why === 'update') return switchTo(root, record, mark, current, ops);
  if (mark.why === 'go-back') return goBack(root, record, mark, current, ops);
  const asked = JSON.stringify(mark.why);
  const points = asked === undefined ? [] : [...asked];
  const request = asked === undefined ? 'names no request'
    : `asks for ${points.length > 80 ? `${points.slice(0, 80).join('')}… (cut)` : asked}`;
  ops.report(`[update] The mark at ${installPaths(root).mark} ${request}, which this release doesn't know, so ` +
    `${current} starts as it was. The mark stands, and each start says this again until it's removed.`);
  return { release: current, trial: false };
}

/** The entry point's flag for a Go back asked from a shell, and its choice to
 *  keep the newer data rather than restore the copy. */
export const GO_BACK_FLAG = '--go-back';
export const KEEP_DATA_FLAG = '--keep-data';

/** How long a Go back from a shell waits for the install's lock. A host
 *  that keeps exiting gives it up between its exit and the service's next
 *  start, five seconds apart in the documented unit. */
export const GO_BACK_LOCK_WAIT_MS = 60_000;

export function goBackOffer(root: string, running: string): { to: string; since: string } | null {
  const label = lastCopy(root);
  if (label === null || typeof label.from !== 'string' || label.from === running) return null;
  if (!existsSync(releaseEntry(root, label.from))) return null;
  return { to: label.from, since: typeof label.at === 'string' ? label.at : 'at a time its label doesn\'t say' };
}

export function goBackLine(root: string, offer: { to: string; since: string }): string {
  return `[update] Going back to ${offer.to} is offered, with the copy of its data taken ${offer.since}. If this ` +
    `release keeps exiting, \`bun ${shellWord(join(root, ENTRY_POINT))} ${GO_BACK_FLAG}\` asks the next start to go ` +
    `back, restoring that copy and keeping what changed since aside, or with ${KEEP_DATA_FLAG} keeping the newer data.`;
}

export function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * `start.js --go-back [--keep-data]`, run from a shell: ask the next start to
 * go back, for an operator whose host doesn't stay up to ask it, as when the
 * release it committed keeps exiting. Returns the exit status.
 *
 * It waits up to GO_BACK_LOCK_WAIT_MS for the install's lock, which the
 * install's host holds while it runs. A host that keeps exiting gives it up
 * between its exit and the service's next start. With the lock, it checks
 * that a Go back is offered, to `expected` when that's given, and that no
 * request is under way, writes the mark, and gives the lock up: the
 * service's next start goes back. A host that holds the lock the whole time
 * is up, so its own Go back, which
 * quiesces first, is the way.
 */
export function goBackFromShell(root: string, args: string[], ops: LauncherOps, expected?: string): number {
  const unknown = args.filter((arg) => arg !== KEEP_DATA_FLAG);
  if (unknown.length > 0) {
    ops.report(`[update] ${GO_BACK_FLAG} takes only ${KEEP_DATA_FLAG}, and was given ${unknown.join(' ')}. Nothing ` +
      'was asked for.');
    return 2;
  }
  const keepData = args.includes(KEEP_DATA_FLAG);
  const until = ops.now().getTime() + GO_BACK_LOCK_WAIT_MS;
  for (let waiting = false; ;) {
    try {
      takeLock(root, ops);
      break;
    } catch (error) {
      if (!(error instanceof LockHeld)) {
        ops.report(`[update] Nothing was asked for: ${errorText(error)}`);
        return 1;
      }
      if (ops.now().getTime() >= until) {
        ops.report(`[update] Nothing was asked for: this install's lock has been held for the last ` +
          `${GO_BACK_LOCK_WAIT_MS / 1000} s. ${errorText(error)} A host that's up goes back with \`/update back\`, ` +
          'which lets its turns end first. Otherwise stop the service, run this again, and start the service.');
        return 1;
      }
      if (!waiting) {
        waiting = true;
        ops.report(`[update] Waiting up to ${GO_BACK_LOCK_WAIT_MS / 1000} s for this install's host to give up its ` +
          'lock, as one that keeps exiting does between its exit and its next start.');
      }
      ops.sleep(1_000);
    }
  }
  try {
    const current = readCurrent(root);
    if (current === null) throw new ContractError(`this install has no ${installPaths(root).current}; run setup again`);
    const lines = readJournal(root);
    const underWay = unfinishedTrial(lines, current) ?? pendingGoBack(lines);
    if (underWay !== null) {
      throw new ContractError(`the request to ${underWay.to} is under way, and the next start carries it on before ` +
        'anything else. Start the service, then ask again if it\'s still needed');
    }
    const offer = goBackOffer(root, current);
    if (offer === null) {
      throw new ContractError(`no Go back is offered: ${current} runs, and the copy doesn't hold another installed ` +
        'release\'s data');
    }
    if (expected !== undefined && offer.to !== expected) {
      throw new ContractError(`the Go back offered is to ${offer.to}, not ${expected}`);
    }
    let standing: string | null;
    try {
      standing = readMark(root)?.to ?? null;
    } catch {
      standing = 'a release this release can\'t read';
    }
    const { mark, unsynced } = writeMark(root, { to: offer.to, why: 'go-back', keepData }, ops.now());
    ops.report(`[update] The next start goes back to ${offer.to}, ` +
      (keepData ? 'keeping the newer data' : `restoring the copy of its data taken ${offer.since}, with what ` +
        'changed since kept aside') +
      (standing !== null ? `. This replaces the request to ${standing} that stood` : '') +
      `. Start the service if it isn't running, and it goes back as it starts (mark ${mark.id}).` +
      (unsynced !== null ? ` ${unsyncedText(unsynced)}` : ''));
    return 0;
  } catch (error) {
    ops.report(`[update] Nothing was asked for: ${errorText(error)}`);
    return 1;
  } finally {
    releaseLock(root);
  }
}

function releaseLock(root: string): void {
  const { lock } = installPaths(root);
  try {
    if (readRecord<LockRecord>(lock, 'lock')?.pid === process.pid) rmSync(lock, { force: true });
  } catch {
  }
}

/** The mount points in Linux's /proc/self/mountinfo, each with its escapes
 *  (`\040` for a space) read back. */
export function linuxMountPoints(text: string): string[] {
  return text.split('\n').filter(Boolean).map((row) =>
    (row.split(' ')[4] ?? '').replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))));
}

/** The mount points in what macOS's `mount` prints, one per line as
 *  "DEVICE on PATH (OPTIONS)". */
export function macMountPoints(text: string): string[] {
  return text.split('\n').flatMap((row) => {
    const found = /^.*? on (.*) \([^()]*\)$/.exec(row);
    return found ? [found[1]!] : [];
  });
}

export function machineMountPoints(platform: string = process.platform): string[] | null {
  try {
    if (platform === 'linux') return linuxMountPoints(readFileSync('/proc/self/mountinfo', 'utf-8'));
    if (platform === 'darwin') {
      const run = Bun.spawnSync(['mount'], { stdout: 'pipe', stderr: 'pipe' });
      return run.exitCode === 0 ? macMountPoints(run.stdout.toString()) : null;
    }
  } catch {
    return null;
  }
  return [];
}

/** Whether a signal sent to `target`, a process or with a minus a process
 *  group, would reach anything: one that exists but isn't this user's counts. */
function signalReaches(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function machineOps(): LauncherOps {
  return {
    now: () => new Date(),
    report: (text) => { writeSync(2, `${text}\n`); },
    dataDir: () => resolve(process.env.DATA_DIR || './data'),
    agentOverlay: () => agentOverlayPath(process.cwd(), process.env),
    cwd: () => process.cwd(),
    bootId: () => {
      try {
        return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null;
      } catch {
        return null;
      }
    },
    pidAlive: (pid) => signalReaches(pid),
    groupAlive: (pid) => signalReaches(-pid),
    importModule: (path) => import(path),
    sleep: (ms) => Bun.sleepSync(ms),
    freeBytes: (path) => {
      const s = statfsSync(path);
      return Number(s.bavail) * Number(s.bsize);
    },
    mountPoints: machineMountPoints,
  };
}

export async function launch(root: string, argv: string[]): Promise<never> {
  const ops = machineOps();
  if (argv[0] === GO_BACK_FLAG) process.exit(goBackFromShell(root, argv.slice(1), ops));
  if (typeof process.execve !== 'function') {
    ops.report(`[update] Nothing started: this runtime has no process.execve, which the launcher needs to become the host (Bun ${process.versions.bun}).`);
    process.exit(1);
  }
  let start: Start;
  try {
    start = await decide(root, ops);
  } catch (error) {
    ops.report(`[update] Nothing started: ${errorText(error)}`);
    process.exit(1);
  }
  const entry = releaseEntry(root, start.release);
  if (!existsSync(entry)) {
    ops.report(`[update] Nothing started: ${start.release}'s host isn't at ${entry}.`);
    process.exit(1);
  }
  if (!start.trial) {
    try {
      const offer = goBackOffer(root, start.release);
      if (offer !== null) ops.report(goBackLine(root, offer));
    } catch (error) {
      ops.report(`[update] Whether a Go back is offered can't be told: ${errorText(error)}`);
    }
  }
  try {
    // The runtime's own flags, as the service gave them, go to the host too,
    // so a --preload runs in the host as it did in the launcher, once each.
    process.execve(process.execPath, [process.execPath, ...process.execArgv, entry, ...argv],
      { ...process.env, [INSTALL_ROOT_ENV]: root });
  } catch (error) {
    ops.report(`[update] Nothing started: ${entry} couldn't run: ${errorText(error)}`);
  }
  // execve replaces the process, so this is reached only when it couldn't.
  process.exit(1);
}
