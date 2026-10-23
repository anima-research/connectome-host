/**
 * The launcher (contract.ts): what runs at every start of an install that
 * updates itself, before its host. The install's entry point imports it from
 * the release `current` names, so it's always the launcher of the release
 * that last committed on the install's data, never that of a release on
 * trial. It takes the install's lock, finishes or undoes whatever a start cut
 * off left, carries out a standing mark (a switch, or a Go back), and then
 * becomes the host it chose (execve), keeping the process, with the install's
 * root in CONNECTOME_INSTALL_ROOT.
 *
 * Every step leaves an outcome the filesystem shows, and the journal says
 * which request is under way, so a start that finds a step cut off finishes
 * it. A state it can't finish or undo stops the start, saying what it found:
 * the process exits without starting a host, and the supervisor's next start
 * meets the same report until someone acts. A mark it can't read, or one
 * asking for what this release doesn't know, has changed nothing, so it's
 * reported and the release `current` names starts.
 *
 * What a restore replaces it keeps, under the mark it acts on: a directory's
 * entries inside the directory (itemSetAsideDir, itemStagingDir), a file's
 * content or its absence in the root (setAsideDir). What's removed is only
 * what nothing needs: a Go back's own copy of the data it keeps, once that
 * Go back commits or falls back before its trial; the keeps of a putting back
 * that failed before a Go back's trial, which hold what the copy still holds;
 * the copy before the last, once the last is whole; and what a request cut
 * off before its first journal line had prepared, which no data depends on.
 */
import {
  accessSync, chmodSync, constants, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statfsSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  ContractError, INSTALL_ROOT_ENV, ITEM_UPDATE_DIR, appendJournal, childrenFilePath,
  copyItemName, copyLabelPath, goBackListPath, installPaths, isChildEntry, itemSetAsideDir, lastCopy, pendingGoBack,
  readCurrent, readGoBackList, readJournal, readMark, readRecord, realOrResolved, releaseDir, setAsideDir,
  unfinishedTrial, writeJsonAtomic,
  type ChildrenFile, type CopyLabel, type GoBackList, type InstallRecord, type JournalLine, type LockRecord, type Mark,
  type PlaceKind,
} from './contract.js';
import {
  PRIVATE_DIR_MODE, copyTree, drive, exists, keepFile, makeDirs, putFileBack, removeTree, replaceFile, sameContent,
  spaceTaken, syncEntries, syncPath, type FileKeep,
} from './data-swap.js';

/** Where a release's host is inside its directory, one npm install of the
 *  package. The entry point imports the launcher from here, so neither path
 *  ever moves. */
export const RELEASE_HOST = join('node_modules', '@animalabs', 'connectome-host');
export const HOST_ENTRY = join(RELEASE_HOST, 'src', 'index.ts');
export const LAUNCHER = join(RELEASE_HOST, 'src', 'update', 'launcher.ts');

/** Room a switch leaves free beyond what its copy and a fallback's restore
 *  of it need, so the trial and the host after it can still write. */
const ROOM_MARGIN = 256 * 2 ** 20;

/** What the launcher needs from the machine, given to it so tests can stand in. */
export interface LauncherOps {
  now(): Date;
  /** A line for the operator, in the host's log. */
  report(line: string): void;
  /** The data directory a host started here would serve. */
  dataDir(): string;
  cwd(): string;
  bootId(): string | null;
  pidAlive(pid: number): boolean;
  /** Whether the process group `pid` leads has a member, after `pid` itself
   *  has ended too. */
  groupAlive(pid: number): boolean;
  /** Load a module, to see that it loads. */
  importModule(path: string): Promise<unknown>;
  /** Bytes free to this user on the filesystem holding `path`. */
  freeBytes(path: string): number;
  /** Every mount point on the machine, as absolute paths, or null when its
   *  list couldn't be read. Anywhere but Linux and macOS the launcher has no
   *  list, and finds none. */
  mountPoints(): string[] | null;
  /** Wait `ms` milliseconds. */
  sleep(ms: number): void;
}

/** What a start decided to run: a release, on trial when it hasn't committed
 *  on this install's data yet. The host isn't told `trial`: it tells its own
 *  trial from `current`, which a trial doesn't name (host.ts). */
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

/** Whether `path` is `dir` or inside it. */
export function isUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** Whether this process can write the file at `path`, or give itself write
 *  on it as its owner, as a write in place does. */
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

/** Why `held`, from heldIn or stuckIn, can't be moved, for a refusal that
 *  goes on with what moves it. */
function heldText(held: { path: string; why: 'sticky' | 'unwritable' }, moves: string): string {
  const dir = dirname(held.path);
  return held.why === 'sticky'
    ? `${held.path} is in ${dir}, which has the sticky bit, and this process owns neither, so ${moves} couldn't ` +
      `move it. Make this user the owner of ${held.path} or of ${dir}, or take the sticky bit off ${dir}`
    : `${held.path} is a directory another owns that this process can't write, and ${moves} moves it out of ` +
      `${dir}, which a directory allows only to a process that may write it. Give this user write on ` +
      `${held.path}, or make this user its owner`;
}

/** Whether the filesystem holding `path` can be written at all: not when it's
 *  mounted read-only, as a container's read-only file mount is. */
function writableFilesystem(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'EROFS';
  }
  return true;
}

/** Why an update can't change these directories, or null: each entry moves
 *  through an area inside its directory, and a place is made or taken away in
 *  its own, and each is synced after, so this process must be able to read,
 *  write and search each. It's
 *  checked at the request, before anything changes, for the request's sake
 *  and its fallback's, which would otherwise fail partway. */
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

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

/** Take the install's lock, which stays with this process as its host. The
 *  lock file is made by a hard link of a whole record, so two starts can't
 *  both make it. A lock left by a process that has ended, or by an earlier
 *  boot, is removed and taken once more. Two starts that find the same stale
 *  lock at the same moment can each remove it in turn, which one service
 *  starting one install never does. */
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
        // Written by a process that had this one's number and has ended: one
        // before a reboot, or one a container numbered the same. The lock is
        // this start's now, so it takes this start's record.
        renameSync(mine, lock);
        syncPath(dirname(lock));
        return;
      }
      if (ops.pidAlive(holder.pid) && (holder.bootId === null || bootId === null || holder.bootId === bootId)) {
        throw new ContractError(
          `Another start of this install holds its lock (${lock}): process ${holder.pid}, since ${holder.at}. ` +
          'An install runs one host at a time. If that process is this install\'s host, stop it first; if it\'s ' +
          'something else that reused the number, remove the lock file.',
        );
      }
      if (attempt > 0) {
        throw new ContractError(`The lock at ${lock} was left by process ${holder.pid}, which has ended, and taking it over failed twice.`);
      }
      rmSync(lock, { force: true });
    }
  } finally {
    rmSync(mine, { force: true });
  }
}

// ---------------------------------------------------------------------------
// What the install's data is
// ---------------------------------------------------------------------------

/** The install record, checked against the data directory a host started
 *  here would serve: an install serves one, the one setup recorded. */
export function readInstall(root: string, ops: LauncherOps): InstallRecord {
  const { install } = installPaths(root);
  const record = readRecord<InstallRecord>(install, 'install record');
  if (record === null) {
    throw new ContractError(`This install has no record at ${install}, so it can't tell what data it serves. Run setup again.`);
  }
  if (typeof record.dataDir !== 'string' || !Array.isArray(record.extraState) ||
    !record.extraState.every((path) => typeof path === 'string')) {
    throw new ContractError(`The install record at ${install} has no data directory or list of extra state this release can read. Run setup again.`);
  }
  const serving = realOrResolved(ops.dataDir());
  if (realOrResolved(record.dataDir) !== serving) {
    throw new ContractError(
      `This install serves the data directory ${record.dataDir}, and this start would serve ${serving}. Each ` +
      'service needs an install of its own: start this one with its own data directory, or run setup for the other.',
    );
  }
  return record;
}

/** The children file's children whose process may still be running, each
 *  named with its pid, and whether only the process group it led remains. */
export function liveChildren(dataDir: string, ops: LauncherOps): string[] {
  const file = readRecord<ChildrenFile>(childrenFilePath(dataDir), "fleet's children file");
  if (file === null) return [];
  if (!Array.isArray(file.children)) {
    throw new ContractError(`The fleet's children file at ${childrenFilePath(dataDir)} has no list of children this release can read.`);
  }
  const bootId = ops.bootId();
  // The fleet keeps an entry it can't read as a child as it is, and such an
  // entry names no process.
  // A child runs in a group it leads, as a fleet child does, and a helper
  // left in that group can write where the child does, so the child counts
  // while its group has a member. The lock's
  // holder counts by its own process alone.
  // Only a positive pid names a process: 0 or less would signal this one's
  // own group.
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

/** Why a request can't go ahead while fleet children may be running, or
 *  null when none may: a child writes in its data directory, which an update
 *  must not change under it. A children file that can't be read can't say,
 *  so it's the reason. */
function childrenProblem(record: InstallRecord, ops: LauncherOps): string | null {
  const found = childrenFound(record, ops);
  return found === null ? null : `${found.reason.replace(/\.+$/, '')}. ${found.why}. To let it go ahead, ${found.remedy}`;
}

/** What childrenProblem finds: the reason, why it holds the update, and what
 *  would clear it. */
function childrenFound(record: InstallRecord, ops: LauncherOps): { reason: string; why: string; remedy: string } | null {
  const file = childrenFilePath(record.dataDir);
  const none = 'with nothing it lists, and no process in a group one led, still running';
  let children: string[];
  try {
    children = liveChildren(record.dataDir, ops);
  } catch (error) {
    // A file that can't be read, for whatever reason, can't say.
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

/** Wait while a fleet child may still be running (childrenProblem), and
 *  stop, saying why, if one still may after CHILDREN_WAIT_MS. */
function waitForChildren(record: InstallRecord, ops: LauncherOps, what: string): void {
  // Counted by the time slept, which a change to the clock can't stretch.
  for (let waited = 0, found = childrenFound(record, ops); found !== null; found = childrenFound(record, ops)) {
    if (waited >= CHILDREN_WAIT_MS) {
      throw new ContractError(`${what}, and it can't go on: ${found.reason.replace(/\.+$/, '')}. ${found.why}, so ` +
        `nothing starts until that changes: ${found.remedy}. The next start goes on.`);
    }
    ops.sleep(250);
    waited += 250;
  }
}

/** Everything a switch copies, as real paths: the data directory, each fleet
 *  child's, the MCPL settings files in the working directory, and the extra
 *  state setup recorded. `present` are those there now, none inside another,
 *  since copying the outer one covers it. `absent` are those that aren't,
 *  none inside a present one or another absent one, which a restore keeps
 *  empty of whatever a trial makes there. */
export function dataItems(root: string, record: InstallRecord, ops: LauncherOps): { present: string[]; absent: string[] } {
  const candidates = [record.dataDir];
  const children = readRecord<ChildrenFile>(childrenFilePath(record.dataDir), "fleet's children file");
  for (const child of Array.isArray(children?.children) ? children.children.filter(isChildEntry) : []) {
    candidates.push(resolve(ops.cwd(), child.dataDir));
  }
  candidates.push(join(ops.cwd(), 'mcpl-servers.json'), join(ops.cwd(), 'mcpl-servers.agent.json'), ...record.extraState);
  const there = new Set<string>();
  const missing = new Set<string>();
  for (const path of candidates) {
    // A path that can't be looked at isn't taken for absent: its error is the reason.
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

/** The mount points inside the directories `dirs`, not a directory itself,
 *  from the machine's list of mounts, or null when that list couldn't be
 *  read. A platform with no list (machineOps) has none. */
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

/** Why the machine's list of mounts is missing, and what to check. */
const MOUNTS_UNREAD = 'the machine\'s list of mounts couldn\'t be read (/proc/self/mountinfo on Linux, `mount` on macOS)';
const MOUNTS_CHECK = 'On Linux, /proc/self/mountinfo is this process\'s own, so check that /proc is mounted; on macOS, ' +
  'that `mount` runs';

/** Stop, saying why, before a restore moves the entries of `dir` while a
 *  mount may be inside it (mountProblem). */
function stopForMounts(dir: string, ops: LauncherOps): void {
  const problem = mountProblem([dir], ops);
  if (problem !== null) {
    throw new ContractError(`Restoring ${dir} can't go on: ${problem}`);
  }
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

/** Refuse, with the reason, a release that isn't installed whole: its host
 *  must be there, and its own launcher must load, since once it commits it
 *  decides every later start. */
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

/** Why the filesystems lack room for `needs` (bytes to write, each where it
 *  lands), with a margin left on each, or null when they have it. */
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

// ---------------------------------------------------------------------------
// Places, and putting data in place
// ---------------------------------------------------------------------------

/** What a place holds: a directory, a file, or nothing (PlaceKind). */
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

/** A place an update copies or restores: where it lives, and its name in the
 *  copy and in what a restore keeps of it (copyItemName). */
interface Place {
  path: string;
  name: string;
}

function placesOf(paths: string[], from = 0): Place[] {
  return paths.map((path, at) => ({ path, name: copyItemName(from + at, path) }));
}

/** Where a restore stages a directory's incoming content: in its
 *  ITEM_UPDATE_DIR, beside its set-aside, so it moves in by renames. Only
 *  this release's launcher reads it. */
export function itemStagingDir(item: string, markId: string): string {
  return join(dirname(dirname(itemSetAsideDir(item, markId))), 'staging', markId);
}

/** What a restore under `markId` keeps of a file it writes over (setAsideDir):
 *  a switch's fallback or a Go back keeps what it replaces under `restore`,
 *  and a Go back's own fallback what the older release's trial left under
 *  `put-back`. */
function fileKeep(root: string, markId: string, name: string, phase: 'restore' | 'put-back'): FileKeep {
  const base = phase === 'restore' ? setAsideDir(root, markId) : join(setAsideDir(root, markId), 'put-back');
  return { kept: join(base, 'kept', name), absent: join(base, 'absent', name) };
}

/** A directory's areas a drive under `markId` uses, with the names a cut can leave them under. */
function areas(dir: string, markId: string): { setAside: string; staging: string; any: boolean } {
  const setAside = itemSetAsideDir(dir, markId);
  const staging = itemStagingDir(dir, markId);
  const any = [setAside, staging].some((area) => ['', '.filling', '.emptying'].some((suffix) => exists(area + suffix)));
  return { setAside, staging, any };
}

/** Copy `source` to `target` so that `target` is whole or not there: under a
 *  `.tmp` name first. */
function copyWhole(source: string, target: string): void {
  const tmp = `${target}.tmp`;
  removeTree(tmp);
  makeDirs(dirname(tmp), PRIVATE_DIR_MODE);
  copyTree(source, tmp);
  // The area is the update's, whatever mode the copied directory had, so a
  // drive can empty it.
  chmodSync(tmp, PRIVATE_DIR_MODE);
  syncPath(tmp);
  renameSync(tmp, target);
  syncPath(dirname(target));
}

/** An empty area, for a drive whose incoming set is nothing. */
function emptyArea(dir: string): void {
  makeDirs(dirname(dir), PRIVATE_DIR_MODE);
  mkdirSync(dir, { mode: PRIVATE_DIR_MODE });
  syncPath(dirname(dir));
}

/** Take the switch's copy of `present` as copy.tmp, its label written last,
 *  then put it in place of the last copy, which is moved to copy.prev first
 *  and removed once the new one is in place (settleCopy). */
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
  // The new copy is in place, so the switch goes ahead: what's left of the
  // one before it only takes room, and a later start tries again.
  dropCopyPrev(root, ops);
}

/** Remove copy.prev once the copy is in place, saying so if that fails. */
function dropCopyPrev(root: string, ops: LauncherOps): void {
  try {
    removeTree(installPaths(root).copyPrev);
  } catch (error) {
    ops.report(`[update] Removing the copy before the last one (${installPaths(root).copyPrev}) failed, so it stays ` +
      `for now, and a later start tries again: ${errorText(error)}`);
  }
}

/** Remove copy.tmp, a copy a switch didn't finish. Nothing needs it, so a
 *  removal that fails is said, and a later start tries again. */
function dropUnfinishedCopy(root: string, ops: LauncherOps): void {
  const { copyTmp } = installPaths(root);
  try {
    removeTree(copyTmp);
  } catch (error) {
    ops.report(`[update] Removing a copy a switch left unfinished (${copyTmp}) failed, so it stays for now, and a ` +
      `later start tries again: ${errorText(error)}`);
  }
}

/** Finish or undo a replacement of the copy that a start cut off: with the
 *  new copy in place, the one before it goes; without, it comes back. */
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

/** The copy's places, each with what the copy holds for it: a directory or a
 *  file, or nothing for a place that wasn't there when it was taken. */
function copyTargets(copy: string, label: CopyLabel): Array<Place & { target: Kind }> {
  return [
    ...label.items.map(({ path, name }) => ({ path, name, target: kindOf(join(copy, name)) })),
    ...(label.absent ?? []).map(({ path, name }) => ({ path, name, target: 'none' as const })),
  ];
}

/** Make `place` hold what `from` holds for it, `target`, keeping what it
 *  holds now under `markId`: a directory's entries in its set-aside, by
 *  renames, once `from`'s are staged inside it; a file's content, or its
 *  absence, in the root (keepFile). A directory that isn't there is made, and
 *  one that should hold nothing is emptied rather than removed, since it may
 *  hold what's kept. Called again after a cut, it finishes from there. */
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
    // A replay after a cut before an earlier attempt's sync finds it gone.
    if (existsSync(dirname(place.path))) syncEntries(dirname(place.path));
    return;
  }
  // A directory that's there keeps its own mode, as a file item does. One
  // made here is made with the copy's, with rwx for its owner, since it holds
  // its update area, so a replay finds it with that mode. Only when the umask
  // takes bits from it, or setgid, which mkdir takes from the parent rather
  // than from the mode, differs, does the chmod after set it, and a cut
  // between the two leaves it with the mode mkdir gave it.
  const made = now === 'none';
  if (made) {
    makeDirs(dirname(place.path));
    const mode = (lstatSync(join(from, place.name)).mode & 0o7777) | 0o700;
    mkdirSync(place.path, { mode });
    if ((lstatSync(place.path).mode & 0o7777) !== mode) chmodSync(place.path, mode);
  } else {
    // One made here holds no mount; one that was there might.
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
    // One an earlier attempt made, cut before this sync, is found now.
    syncEntries(dirname(place.path));
  }
}

/** Remove what a Go back under `markId` kept: before its `go-back` line,
 *  what its preparation made, when it hasn't touched the data; and for a Go
 *  back that kept the newer data, the copy it kept for its trial, once that
 *  trial commits or the Go back falls back before its trial starts. */
function clearGoBack(root: string, markId: string, ops: LauncherOps): void {
  let places: GoBackList['places'] = [];
  // A Go back writes its list before anything else of it, so with none
  // there, nothing of it is outside the root. One that can't be read is the
  // only record of where its areas are, so it all stays, and the start says so.
  try {
    if (exists(goBackListPath(root, markId))) places = readGoBackList(root, markId);
  } catch (error) {
    ops.report(`[update] What the Go back under mark ${markId} kept stays where it is. ${errorText(error)} ` +
      `Its areas are inside each directory the update copies, in ${ITEM_UPDATE_DIR}, each named for that mark, with ` +
      `or without .tmp, .filling or .emptying after it; remove them and ${setAsideDir(root, markId)} when nothing ` +
      'there is wanted.');
    return;
  }
  // Nothing needs what's removed here, so a removal that fails is said and
  // left for a later start, which tries again. The areas go first, and the
  // set-aside directory, the list in it, after them, so while an area stays
  // the list still says where it is. The areas' removal is synced before the
  // list goes, so a power cut can't bring an area back with nothing to name
  // it; a sync that can't be made leaves the list, as a failed removal does.
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

/** Put back what a Go back under `markId` replaced, keeping what each place
 *  holds now, the older release's: a directory's in its staging, a file's
 *  under `put-back`. A directory with nothing set aside, which the Go back
 *  never reached or an earlier attempt already put back, holds the newer
 *  data, and is left as it is. */
function putBack(root: string, markId: string, ops: LauncherOps): void {
  for (const place of readGoBackList(root, markId)) {
    const now = kindOf(place.path);
    const keep = fileKeep(root, markId, place.name, 'put-back');
    if (place.before === 'file' || (place.before === 'none' && place.target === 'file')) {
      if (now === 'dir') throw new ContractError(`${place.path} is a directory now, and what's put back there is a file`);
      // Its content or absence was kept before the Go back's line.
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
    // Nothing was there before: keep aside whatever is there now.
    if (now === 'file') {
      replaceFile(place.path, null, keep);
    } else if (now === 'none') {
      // A replay after a cut before an earlier attempt's sync finds it gone.
      if (existsSync(dirname(place.path))) syncEntries(dirname(place.path));
    } else if (now === 'dir') {
      const { setAside, staging, any } = areas(place.path, markId);
      // A copy into the staging of one the restore made, cut off by its
      // failure, is nobody's. (One that was there was staged before the line.)
      removeTree(`${staging}.tmp`);
      // One the Go back made and never filled holds nothing to keep. It's
      // left holding only its update directory rather than driven, since a
      // drive would leave an empty staging area to stand in for the copy's at
      // a later restore; removing it would want a mount check of its own.
      if (!any && readdirSync(place.path).every((name) => name === ITEM_UPDATE_DIR)) continue;
      stopForMounts(place.path, ops);
      if (!any) emptyArea(setAside);
      drive(place.path, staging, setAside);
    }
  }
}

// ---------------------------------------------------------------------------
// The requests
// ---------------------------------------------------------------------------

function line(ops: LauncherOps, fields: Omit<JournalLine, 'v' | 'at'>): Omit<JournalLine, 'v'> {
  return { at: ops.now().toISOString(), ...fields };
}

/** A request refused before it touched the data: the journal says why, the
 *  mark stands, and the release that runs now starts as it was. */
function refuse(root: string, ops: LauncherOps, step: JournalLine['step'], current: string, mark: Mark, reason: string,
  outcome: 'refused' | 'failed' = 'refused'): Start {
  appendJournal(root, line(ops, { step, from: current, to: mark.to, outcome, reason, mark: mark.id }));
  const what = mark.why === 'go-back' ? 'Go back' : 'switch';
  ops.report(`[update] The ${what} to ${mark.to} didn't go ahead, so ${current} starts as it was: ` +
    `${reason.replace(/\.+$/, '')}. The request stands, and each start tries it again until it goes ahead, or until ` +
    `removing ${installPaths(root).mark} drops it.`);
  return { release: current, trial: false };
}

/** What a request's checks refuse it for: the journal step it's recorded
 *  under, and why. */
interface Refusal {
  step: JournalLine['step'];
  reason: string;
}

/** A request whose checks threw is refused, with the reason: nothing before
 *  its first journal line changes the data, so the release that runs now
 *  starts as it was. */
function refuseThrown(root: string, ops: LauncherOps, step: JournalLine['step'], current: string, mark: Mark,
  error: unknown): Start {
  return error instanceof ContractError
    ? refuse(root, ops, step, current, mark, error.message)
    : refuse(root, ops, step, current, mark, `checking it failed: ${errorText(error)}`, 'failed');
}

/** Why a switch to `mark.to` can't go ahead, or the places it copies: those
 *  there now, and those that aren't. It changes nothing. */
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
  // A fallback's restore moves each directory's entries into its set-aside.
  for (const dir of dirs) {
    const held = heldIn(dir);
    if (held !== null) return { step: 'copy', reason: heldText(held, `the fallback, if ${mark.to} fails before it commits,`) };
  }
  const places = placesOf(present);
  // The copy, in the root; and a fallback's restore of it: a directory's
  // staged inside it, a file's present content kept in the root and the
  // copy's written over it in place.
  const room = roomProblem(root, places.flatMap((place) => {
    const bytes = spaceTaken(place.path);
    if (statSync(place.path).isDirectory()) return [{ path: root, bytes }, { path: place.path, bytes }];
    // A file on a filesystem no one can write is never written in place.
    const needs = [{ path: root, bytes }, { path: root, bytes }];
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
  ops.report(`[update] Starting ${mark.to} on trial, from ${current}. It commits once it has opened its stores and ` +
    `connected its servers; if it ends before that, the next start goes back to ${current} and its data.`);
  return { release: mark.to, trial: true };
}

/** Why a Go back to `mark.to` can't go ahead, or its places, each with what
 *  it holds now and what the Go back puts there, and the copy it restores
 *  them from, or null for a Go back that keeps the newer data. It changes
 *  nothing. */
async function checkGoBack(root: string, record: InstallRecord, mark: Mark, ops: LauncherOps):
  Promise<Refusal | { places: GoBackList['places']; source: string | null }> {
  await checkRelease(root, mark.to, ops);
  const children = childrenProblem(record, ops);
  if (children !== null) return { step: 'children-check', reason: children };
  // A start's cleanup removes an earlier attempt's preparation, unless the
  // list that says where its areas are can't be read, the set-aside
  // directory can't be listed, or a removal fails, each of which that start
  // reports. Its keeps would then stand for what the data holds now, so the
  // Go back waits for them to go.
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
    // Its fallback puts back the newer data it keeps, which must be there.
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
    // The copy took each place by its real path. One whose path leads
    // elsewhere now, through a link a move left, would be put back where
    // the link leads, beside the place found there in its own right.
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
    // A place recorded since the switch that holds one the copy took on its
    // own, such as a directory given where the copy took a file inside it,
    // can't be put back from the copy whole, nor kept whole beside it.
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
    // A data item the copy doesn't list, such as a child added since the
    // switch, wasn't there in the older release's time: the Go back keeps
    // what it holds aside, and its fallback puts that back.
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
  // A file place it writes in place mustn't be a link, which the write would
  // go through: one that leads somewhere is a place that moved, refused
  // above, so this is one that leads nowhere, which the record no longer
  // lists. And one it takes away mustn't be a mount, which can't go.
  const link = places.find((place) => place.before === 'file' && lstatSync(place.path).isSymbolicLink());
  if (link) {
    return { step: 'go-back', reason: `${link.path} is a link now, and a Go back writes a file in place, so it won't write ` +
      'through the link to what it names. Put the file itself there' };
  }
  // A file it would change, refused before its line rather than failing
  // after it: on a filesystem no one can write, or, written in place, one
  // this process may neither write nor give itself write on, not being its
  // owner. Taking one away, or replacing it with a directory, needs its
  // directory, which the checks after these cover. Whether it would change a
  // file is asked last, since that reads the copy's content.
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
  // A directory's entries move inside it; a file it makes or takes away, or
  // a directory it makes, is an entry of its parent.
  const unwritable = unwritableDirectory([
    ...places.filter((place) => place.before === 'dir').map((place) => place.path),
    ...places.filter((place) => (place.before !== place.target && (place.before === 'file' || place.target === 'file')) ||
      (place.before === 'none' && place.target === 'dir')).map((place) => existingAncestor(dirname(place.path))),
  ]);
  if (unwritable !== null) return { step: 'go-back', reason: unwritable };
  const mounts = mountProblem(places.filter((place) => place.before === 'dir').map((place) => place.path), ops);
  if (mounts !== null) return { step: 'go-back', reason: mounts };
  // What it moves out of a directory, whatever the directory's write: a
  // file it takes away, which the sticky bit may keep there, and each entry
  // of a directory, which a restore drives into the directory's set-aside,
  // and a fallback's putting back, a Go back that keeps the newer data's
  // included, into its staging (heldIn).
  for (const place of places) {
    const held = place.before === 'file' && place.target !== 'file'
      ? stuckIn(dirname(place.path), () => [basename(place.path)]).map((path) => ({ path, why: 'sticky' as const }))[0] ?? null
      : place.before === 'dir' ? heldIn(place.path) : null;
    if (held === null) continue;
    // Going back keeping the newer data isn't offered: its fallback drives
    // the same directories, so whether it could go on depends on every place.
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
  // What the Go back writes before its line and after it: a restore's
  // staged directories inside each, or its kept copy of the newer data
  // there; each file's newer content kept in the root, and at a fallback
  // the older release's too; and each file's restored content written over
  // it in place.
  // A file on a filesystem no one can write is never written in place.
  const room = roomProblem(root, places.flatMap((place) => {
    const needs: Array<{ path: string; bytes: number }> = [];
    const content = () => spaceTaken(source !== null ? join(source, place.name) : place.path);
    const inPlace = place.before !== 'file' || writableFilesystem(place.path);
    if (place.target === 'dir') needs.push({ path: place.path, bytes: content() });
    if (place.before === 'file') {
      needs.push({ path: root, bytes: spaceTaken(place.path) });
      // The fallback's writing it back.
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

/** Carry a Go back on from its `go-back` line: its restore of the copy, when
 *  it restores one, then the older release's start on trial. If it can't,
 *  what it replaced goes back, and the release that runs now starts. */
async function finishGoBack(root: string, record: InstallRecord, goBackLine: JournalLine, current: string,
  ops: LauncherOps): Promise<Start> {
  const markId = goBackLine.mark;
  if (typeof markId !== 'string') {
    throw new ContractError(`The journal's go-back line to ${goBackLine.to} names no mark, so what it set aside can't be found.`);
  }
  waitForChildren(record, ops, `The Go back to ${goBackLine.to} is under way`);
  // A putting back that failed before this Go back's trial kept, of each
  // file, only what this restore wrote, which the copy still holds. Its keeps
  // go, so the trial's fallback keeps what the trial leaves.
  removeTree(join(setAsideDir(root, markId), 'put-back'));
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

/** A Go back that couldn't start the older release: what it replaced goes
 *  back, unless it kept the newer data, in which case it replaced nothing. */
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
  // A Go back that kept the newer data kept a copy of it only for its trial's
  // fallback, and its trial never started.
  if (goBackLine.keptData) clearGoBack(root, markId, ops);
  ops.report(`[update] The Go back to ${goBackLine.to} didn't go ahead (${why}), so ` +
    (goBackLine.keptData ? `${current} starts on its data as it was.` : `${current}'s data is back and it starts.`));
  return { release: current, trial: false };
}

/** Fall back from a trial that ended before its commit: a switch's by
 *  restoring its copy, a Go back's by putting back what it replaced. */
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

/** Remove what requests left that nothing needs: a switch's copy.tmp, each
 *  Go back's preparation under an id that no successful journal line names,
 *  which a later attempt makes again from the data as it is then, and the
 *  copy a Go back that kept the newer data took for its trial, once that
 *  trial committed or the Go back fell back before it. Only a start with no
 *  request under way calls it. */
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
    // Its copy is needed only while its trial may fall back: not once that
    // trial has ended without a fallback, which with no trial unfinished
    // (decide calls this only then) is its commit, nor once it fell back
    // before its trial started.
    const trialEndedWithoutFallback = ok('trial-start', id) && !ok('fallback', id);
    const neverTried = ok('fallback', id) && !ok('trial-start', id);
    if (ids.includes(id) && (trialEndedWithoutFallback || neverTried)) clearGoBack(root, id, ops);
  }
}

// ---------------------------------------------------------------------------
// A start
// ---------------------------------------------------------------------------

/** Everything a start does before its host: what to run, and whether on
 *  trial. A ContractError says why nothing can start. */
export async function decide(root: string, ops: LauncherOps): Promise<Start> {
  takeLock(root, ops);
  settleCopy(root, ops);
  const record = readInstall(root, ops);
  // A start cut between a line's write and its sync leaves it in the page
  // cache, where this start would read it and a power cut could still take
  // it: synced first, nothing acts on a line that can be lost after.
  if (exists(installPaths(root).journal)) syncPath(installPaths(root).journal);
  const lines = readJournal(root);
  // The entry point loads the launcher through current, so a current that
  // isn't a link gets here only as a directory holding a release, copied in
  // place of the link.
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
  // The request as written, cut short, by code points, with a mark that says so.
  const asked = JSON.stringify(mark.why);
  const points = asked === undefined ? [] : [...asked];
  const request = asked === undefined ? 'names no request'
    : `asks for ${points.length > 80 ? `${points.slice(0, 80).join('')}… (cut)` : asked}`;
  ops.report(`[update] The mark at ${installPaths(root).mark} ${request}, which this release doesn't know, so ` +
    `${current} starts as it was. The mark stands, and each start says this again until it's removed.`);
  return { release: current, trial: false };
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

/** The entry point's call: decide, then become the release's host, keeping
 *  the process. When nothing can start, say why and exit non-zero, so the
 *  supervisor tries again. */
export async function launch(root: string, argv: string[]): Promise<never> {
  const ops = machineOps();
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
