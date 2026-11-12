import { existsSync, linkSync, lstatSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ContractError, ITEM_UPDATE_DIR, VersionError, childrenFilePath, goBackListPath, installPaths, isChildEntry, itemSetAsideDir,
  markSpent, pendingGoBack, readCurrent, readGoBackList, readJournal, readRecord, realOrResolved, syncDir, unfinishedTrial,
  WRITE_RECORD_AGAIN, writeJsonAtomic, type ChildrenFile, type InstallRecord, type JournalLine, type LockRecord,
  type Mark,
} from './contract.js';
import { makeDirs } from './data-swap.js';
import { RELEASE_HOST, isUnder, itemStagingDir, lockLive, takeLock, type LauncherOps } from './launcher.js';

export interface Moved {
  from: string;
  to: string;
}

export interface Mapping {
  from: string | null;
  to: string;
  places: Moved[];
}

export function workingDirOf(root: string): string {
  return dirname(realpathSync(root));
}

export function sameDirectory(a: string, b: string): boolean {
  try {
    const one = statSync(a, { bigint: true });
    const other = statSync(b, { bigint: true });
    return one.dev === other.dev && one.ino === other.ino;
  } catch {
    return false;
  }
}

export function boundHere(record: InstallRecord, root: string): boolean {
  return typeof record.workingDir === 'string' && sameDirectory(record.workingDir, workingDirOf(root));
}

const CHILDREN_FILE = "fleet's children file";

class BoundElsewhere extends ContractError {}

export interface Children {
  path: string;
  value: ChildrenFile;
  paths: string[];
  bound: boolean;
}

export function childrenIn(dataDir: string, from: string | null, to: string): Children | null {
  const path = childrenFilePath(dataDir);
  const unbindable = (why: string, later = false) => new ContractError(`${why}, so setup can't bind the places it ` +
    `names to this directory, and has changed nothing. Put ${path} right, and run setup again.` +
    (later ? ' If a later release wrote it, run that release\'s setup instead.' : ''));
  let value: ChildrenFile | null;
  try {
    value = readRecord<ChildrenFile>(path, CHILDREN_FILE);
  } catch (error) {
    throw unbindable(error instanceof ContractError ? error.message.replace(/\.+$/, '')
      : `The ${CHILDREN_FILE} at ${path} can't be read (${(error as Error).message})`, error instanceof VersionError);
  }
  if (value === null) return null;
  const { children, boundTo } = value;
  if (!Array.isArray(children) || (boundTo !== undefined && typeof boundTo !== 'string')) {
    throw unbindable(`${path} names its places in a form this release can't read`, true);
  }
  if (!children.every(isChildEntry)) {
    throw unbindable(`${path} names a child in a form this release can't read`, true);
  }
  const bound = boundTo !== undefined && !(from !== null && (boundTo === from || sameDirectory(boundTo, from)));
  if (bound && !sameDirectory(boundTo, to)) {
    throw new BoundElsewhere(`The fleet's children file, ${path}, is bound to ${boundTo} by a setup run there, and this ` +
      'install\'s record doesn\'t say it was bound there: that run was cut off before it wrote the record, or the ' +
      'record was written again without its directory after that run, by the setup of a release from before this ' +
      `one after a Go back, or by hand. The install is in ${to} now, so the places that file names are ${boundTo}'s. ` +
      `Setup has changed nothing. Move the install back to ${boundTo}, run setup there, which binds it there again, ` +
      'and then move it.');
  }
  return { path, value, paths: children.filter(isChildEntry).map((child) => child.dataDir), bound };
}

export interface Place {
  path: string;
  data: boolean;
  extra: boolean;
  files: string[];
}

function recordedExtraState(record: InstallRecord): string[] {
  return Array.isArray(record.extraState) ? record.extraState.filter((path) => typeof path === 'string') : [];
}

export function placesOf(record: InstallRecord, named: { path: string; paths: string[] } | null): Place[] {
  const known = new Map<string, Place>();
  const at = (path: string): Place => {
    let place = known.get(path);
    if (place === undefined) known.set(path, place = { path, data: false, extra: false, files: [] });
    return place;
  };
  at(record.dataDir).data = true;
  const extraState = recordedExtraState(record);
  for (const path of extraState) at(path).extra = true;
  for (const path of named?.paths ?? []) if (!at(path).files.includes(named!.path)) at(path).files.push(named!.path);
  const all = [...known.values()];
  const outer = all.filter((place) => !all.some((other) => other !== place && isUnder(place.path, other.path)));
  for (const place of outer) {
    for (const inner of all.filter((other) => other !== place && isUnder(other.path, place.path))) {
      place.data ||= inner.data;
      place.extra ||= inner.extra;
      for (const file of inner.files) if (!place.files.includes(file)) place.files.push(file);
    }
  }
  const rank = (place: Place) => place.data ? 0 : place.extra ? 1 : 2;
  const order = (place: Place) => extraState.findIndex((path) => isUnder(path, place.path));
  return outer.sort((a, b) => rank(a) - rank(b) || order(a) - order(b) || a.path.localeCompare(b.path));
}

export function mapPath(path: string, mapping: Mapping): string | null {
  let best: Moved | null = null;
  for (const place of mapping.places) {
    if (isUnder(path, place.from) && (best === null || place.from.length > best.from.length)) best = place;
  }
  if (best === null && mapping.from !== null && isUnder(path, mapping.from)) best = { from: mapping.from, to: mapping.to };
  return best === null ? null : join(best.to, relative(best.from, path));
}

export type Binding =
  | { kind: 'bound'; to: string }
  | {
    kind: 'bind'; from: string | null; to: string; places: Place[]; ask: Place[]; kept: Moved[];
    children: Children | null; served: string | null;
  };

export type Bind = Extract<Binding, { kind: 'bind' }>;

function keptHere(path: string, to: string, rootName: string): string | null {
  for (let at = path; ; at = dirname(at)) {
    if (sameDirectory(at, to)) return join(to, relative(at, path));
    if (existsSync(join(at, rootName, 'install.json')) || dirname(at) === at) return null;
  }
}

export function childPathsOf(binding: Bind): string[] {
  return binding.children === null || binding.children.bound ? [] : binding.children.paths;
}

export function bindingOf(root: string, record: InstallRecord, placed: Moved[] = []): Binding {
  if (record.workingDir !== undefined && (typeof record.workingDir !== 'string' || !isAbsolute(record.workingDir))) {
    throw new ContractError(`This install's record (${installPaths(root).install}) holds a "workingDir" that isn't an ` +
      `absolute path (${JSON.stringify(record.workingDir)}), so setup can't tell whether the install was moved or ` +
      `copied here, or whose places its record names. Setup has changed nothing. ${WRITE_RECORD_AGAIN}`);
  }
  const to = workingDirOf(root);
  if (boundHere(record, root)) {
    try {
      childrenIn(record.dataDir, record.workingDir ?? null, to);
    } catch (error) {
      if (error instanceof BoundElsewhere) throw error;
    }
    return { kind: 'bound', to };
  }
  const from = typeof record.workingDir === 'string' ? record.workingDir : null;
  const dataKept = from === null ? keptHere(record.dataDir, to, basename(root)) : null;
  const served = mapPath(record.dataDir,
    { from, to, places: [...placed, ...dataKept === null ? [] : [{ from: record.dataDir, to: dataKept }]] });
  const children = served === null ? null : childrenIn(served, from, to);
  const childPaths = children === null || children.bound ? [] : children.paths;
  const named = [
    ...[record.dataDir, ...recordedExtraState(record)]
      .map((path) => ({ path, by: `This install's record (${installPaths(root).install})` })),
    ...childPaths.map((path) => ({ path, by: children!.path })),
  ];
  const roundabout = named.find(({ path }) => resolve(path) !== path);
  if (roundabout !== undefined) {
    throw new ContractError(`${roundabout.by} names ${roundabout.path}, ` + (isAbsolute(roundabout.path)
      ? `which isn't in the plain form setup compares places in. Write it as ${resolve(roundabout.path)}`
      : 'which isn\'t an absolute path. Write the absolute path it means') +
      ', and run setup again. Setup has changed nothing.');
  }
  const places = placesOf(record, children === null ? null : { path: children.path, paths: childPaths });
  const kept = from === null
    ? places.flatMap((place) => {
      const here = keptHere(place.path, to, basename(root));
      return here === null ? [] : [{ from: place.path, to: here }];
    })
    : [];
  return {
    kind: 'bind', from, to, places, children, served,
    ask: places.filter((place) => from === null ? !kept.some((one) => one.from === place.path) : !isUnder(place.path, from)),
    kept,
  };
}

export function childrenRewrite(children: Children | null, mapping: Mapping): boolean {
  return children !== null && !children.bound &&
    (children.value.boundTo !== undefined || children.paths.some((path) => mapPath(path, mapping) !== path));
}

export function bindChildren(children: Children, mapping: Mapping): void {
  const copied: string[] = [];
  const bound = children.value.children.map((child) => {
    if (!isChildEntry(child)) return child;
    const dataDir = mapPath(child.dataDir, mapping);
    if (dataDir === null) {
      throw new ContractError(`${children.path} names ${child.dataDir}, which this binding gives no place, so setup ` +
        'can\'t bind it.');
    }
    let other = false;
    try {
      statSync(child.dataDir);
      other = !sameDirectory(child.dataDir, dataDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && child.pid !== null) {
        throw new ContractError(`${children.path} names ${child.dataDir} for its child ${child.name}, with process ` +
          `${child.pid}, and setup can't look at that directory (${code ?? (error as Error).message}), so it can't tell ` +
          'whether that process is the original install\'s child, still running there, as after a copy, or this ' +
          'install\'s own. Setup stopped before it bound the install. Make that directory searchable to this user, ' +
          `and run setup again; or, if this install is a copy, remove ipc.sock and headless.pid from ${dataDir}, this ` +
          `copy's directory for that child, then set that child's "pid" to null in ${children.path}, and run setup ` +
          'again.');
      }
    }
    if (other) copied.push(dataDir);
    return other ? { ...child, dataDir, pid: null, bootId: null } : { ...child, dataDir };
  });
  for (const file of copied.flatMap((dataDir) => [join(dataDir, 'ipc.sock'), join(dataDir, 'headless.pid')])) {
    try {
      rmSync(file, { force: true });
    } catch (error) {
      throw new ContractError(`${file} came with this copy from the original's child, and setup can't remove it ` +
        `(${(error as Error).message}), so the copy's fleet couldn't start that child there. Setup stopped before it ` +
        'bound the install. Remove it, and run setup again.');
    }
  }
  for (const dataDir of copied) {
    try {
      syncDir(dataDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new ContractError(`Setup removed what came with this copy in ${dataDir}, and can't sync that directory ` +
        `(${(error as Error).message}), so a power loss could bring it back. Setup stopped before it bound the ` +
        'install. Run setup again.');
    }
  }
  writeJsonAtomic(children.path, { ...children.value, children: bound, boundTo: mapping.to } satisfies ChildrenFile);
}

export function movesPlaces(binding: Bind, places: Moved[]): boolean {
  return binding.from !== null || places.some((place) => place.from !== place.to);
}

export interface KeptInRoot {
  found: string[];
  marks: string[];
  listed: string[];
}

export function keptInRoot(root: string): KeptInRoot {
  const { copy, copyPrev, setAside } = installPaths(root);
  let marks: string[] = [];
  try {
    marks = readdirSync(setAside).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ContractError(`${setAside} can't be listed (${(error as Error).message}), so setup can't tell whether a ` +
        'Go back kept anything there. Setup has changed nothing. Make it readable to this user, and run setup again.');
    }
  }
  const listed = marks.flatMap((mark) => {
    const list = goBackListPath(root, mark);
    try {
      if (lstatSync(list, { throwIfNoEntry: false }) === undefined) return [];
      return readGoBackList(root, mark).map((place) => place.path);
    } catch (error) {
      throw new ContractError(`${list} can't be read (${(error as Error).message.replace(/\.+$/, '')}), so setup can't ` +
        'tell which places hold what that Go back kept. Setup has changed nothing. Put it right, or move ' +
        `${join(setAside, mark)} out of the root yourself with that Go back's areas (${MOVE_ASIDE_BY_HAND}, and the ` +
        `same in each place ${list} names, which can't be named here while it can't be read), and run setup again.`);
    }
  });
  const copies = [copy, copyPrev].filter((path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined);
  return { found: [...copies, ...marks.map((mark) => join(setAside, mark))], marks, listed };
}

export const MOVE_ASIDE_REFUSED = '--move-aside moves aside what an install\'s updates and Go backs keep once the ' +
  'install\'s places have moved, and this run gives none of them another place, so what they keep still names this ' +
  'install\'s places. Run it again without.';

export const MOVED_ASIDE_AFTERWARDS = 'Nothing removes what\'s moved aside: it takes its space until you remove it. ' +
  'What a Go back kept holds the newer data it set aside, so move out what you want of it rather than deleting it. ' +
  'Until the next update takes a new copy, /update back restore isn\'t there, and each update says it removes no older ' +
  'release.';

const MOVE_ASIDE_BY_HAND = 'each one listed, and in each directory an update copies that\'s under this install\'s directory, ' +
  '.connectome-update/set-aside/<mark> and .connectome-update/staging/<mark> for each mark listed, with or without ' +
  '.tmp, .filling or .emptying after it';

export function moveAsideByHand(to: string, listed: string[], named: string[]): string {
  const places = [...new Set(listed)].filter((path) => !named.includes(path) && isUnder(path, to) && isDirectory(path));
  return MOVE_ASIDE_BY_HAND + (places.length === 0 ? ''
    : `, and the same in each of these, which a Go back's list names: ${places.join(', ')}`);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function keptAccount(root: string, from: string | null, kept: KeptInRoot): string {
  return (from === null
    ? 'This binding gives places of this install other places than its record names, so what its updates and Go ' +
      'backs keep in its root names the places as they were'
    : `This install was moved or copied here from ${from}, so what its updates and Go backs keep in its root names ` +
      'that directory\'s places') +
    `, and restoring from it here would write them:\n${kept.found.map((path) => `  ${path}`).join('\n')}`;
}

export function movingAside(root: string, to: string): string {
  return `moves each into ${join(root, 'moved-aside')}, under the time it runs, and the areas each Go back keeps ` +
    `inside a place this binding puts under ${to} into that place's ${ITEM_UPDATE_DIR}/moved-aside`;
}

function unfinishedTrialWords(trial: JournalLine): string {
  return `A trial is unfinished: the journal's last ok trial-start, to ${trial.to}, has no ok commit, ` +
    'fallback or go-back after it, and if it ends before its commit, its fallback puts the places back from what\'s ' +
    'listed here. Setup has changed nothing. Let that trial end where the install was, by starting it there, moving ' +
    'it back first if it was moved, and then move or copy it again.';
}

function unfinishedGoBackWords(goBack: JournalLine): string {
  return `A Go back is unfinished: the journal's last ok go-back, to ${goBack.to}, has no ok trial-start, commit or ` +
    'fallback after it, and the next start goes on with it from what\'s listed here. Setup has changed nothing. Let ' +
    'that Go back end where the install was, by starting it there, moving it back first if it was moved, and then ' +
    'move or copy it again.';
}

export function unfinishedWords(root: string): string | null {
  let lines: JournalLine[];
  try {
    lines = readJournal(root);
  } catch (error) {
    return `The journal at ${installPaths(root).journal} can't be read (${(error as Error).message.replace(/\.+$/, '')}), ` +
      'so setup can\'t tell whether a trial or a Go back is unfinished there. Setup has changed nothing. Make it ' +
      'readable to this user, or put it right, and run setup again.';
  }
  const current = readCurrent(root);
  const trial = unfinishedTrial(lines, current);
  if (trial !== null) return unfinishedTrialWords(trial);
  const goBack = pendingGoBack(lines);
  if (goBack !== null) return unfinishedGoBackWords(goBack);
  const path = installPaths(root).mark;
  let mark: Mark | null;
  try {
    mark = readRecord<Mark>(path, 'mark');
  } catch (error) {
    return `The mark at ${path} can't be read (${(error as Error).message.replace(/\.+$/, '')}), so setup can't tell ` +
      'whether a Go back is asked for there. Setup has changed nothing. Make it readable to this user, or remove it, ' +
      'which drops the request, and run setup again.';
  }
  if (mark === null || mark.why !== 'go-back' || markSpent(mark, lines, current)) return null;
  return `A Go back is asked for: the mark at ${path} asks the next start to go back to ${mark.to}, and that start ` +
    'goes back from what\'s listed here. Setup has changed nothing. Let that Go back run where the install was, by ' +
    'starting it there, moving it back first if it was moved, and then move or copy it again. Or remove the mark ' +
    'file, which drops the request.';
}

export interface MovedAside {
  moved: Moved[];
  outside: string[];
}

export function moveAside(root: string, to: string, places: string[], kept: KeptInRoot, now: Date): MovedAside {
  const time = now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  const there = (path: string) => {
    try {
      return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
      throw error;
    }
  };
  const aside = join(root, 'moved-aside', time);
  const moves: Moved[] = [];
  const outside: string[] = [];
  const moved: Moved[] = [];
  const stopped = (what: string, then: string) => new ContractError(`${what}, so setup stops there. Setup has moved ` +
    `${moved.length === 0 ? 'nothing else'
      : `only these:\n${moved.map((one) => `  ${one.from} → ${one.to}`).join('\n')}\nand nothing else`}, removes ` +
    `nothing it moved, and hasn't bound the install. ${then}`);
  const here = realOrResolved(to);
  const scheduled = new Set<string>();
  for (const mark of kept.marks) {
    for (const place of places) {
      for (const area of [itemSetAsideDir(place, mark), itemStagingDir(place, mark)]) {
        for (const path of ['', '.tmp', '.filling', '.emptying'].map((suffix) => area + suffix).filter(there)) {
          const real = realOrResolved(path);
          if (scheduled.has(real)) continue;
          scheduled.add(real);
          if (!isUnder(real, here)) {
            outside.push(real);
            continue;
          }
          const update = join(place, ITEM_UPDATE_DIR);
          const target = join(update, 'moved-aside', time, relative(update, path));
          const lands = realOrResolved(dirname(target));
          if (!isUnder(lands, realOrResolved(place))) {
            throw stopped(`${dirname(target)}, where setup would move ${path}, leads to ${lands}, outside ${place}, ` +
              'which holds it', `Put ${join(update, 'moved-aside')} right, as a directory in ${place} or not there at ` +
              'all, and run setup again (by hand, with --move-aside again).');
          }
          moves.push({ from: path, to: target });
        }
      }
    }
    moves.push({ from: join(installPaths(root).setAside, mark), to: join(aside, 'set-aside', mark) });
  }
  const { copy, copyPrev } = installPaths(root);
  for (const path of [copyPrev, copy].filter(there)) moves.push({ from: path, to: join(aside, basename(path)) });
  for (const move of moves) {
    try {
      makeDirs(dirname(move.to));
      renameSync(move.from, move.to);
    } catch (error) {
      throw stopped(`Moving ${move.from} to ${move.to} failed (${(error as Error).message})`, `Move ${move.from} out of ` +
        'the way yourself, keeping what you want of it, and run setup again, which moves what\'s left (by hand, with ' +
        '--move-aside again).');
    }
    moved.push(move);
    try {
      syncDir(dirname(move.from));
      syncDir(dirname(move.to));
    } catch (error) {
      throw stopped(`Moving ${move.from} to ${move.to} was done, but saving that move to disk failed ` +
        `(${(error as Error).message})`, 'Run setup again, which moves what\'s left (by hand, with --move-aside again).');
    }
  }
  return { moved, outside };
}

export function lockForBinding(root: string, from: string | null, ops: LauncherOps): void {
  const { lock } = installPaths(root);
  let holder: LockRecord | null = null;
  try {
    holder = readRecord<LockRecord>(lock, 'lock');
  } catch {
  }
  if (holder !== null && typeof holder.pid === 'number' && lockLive(holder, ops)) {
    const unproved = from === null
      ? 'this install\'s record is from a release that didn\'t record where the install was, so setup can\'t look for ' +
        'that lock there'
      : copiedFrom(root, from, holder);
    if (unproved !== null) {
      throw new ContractError(`This install's lock (${lock}) is held by process ${holder.pid}, since ${holder.at}, ` +
        `which is running, and ${unproved}. So it may be this install's own host, or a lock that came with this ` +
        'install when it was copied while another install\'s host ran. Setup binds this install\'s places only ' +
        'while it holds the lock, so it has changed nothing. If that process is this install\'s host, stop it and ' +
        `run setup again; if the lock came with a copy, remove ${lock} if it still names process ${holder.pid} since ` +
        `${holder.at}, and run setup again.`);
    }
    setAsideCopied(lock, holder);
  }
  takeLock(root, ops);
}

function copiedFrom(root: string, from: string, holder: LockRecord): string | null {
  const here = realpathSync(root);
  const was = join(from, basename(here));
  const wasLock = installPaths(was).lock;
  if (sameDirectory(was, here)) return `${was}, where the install was, leads to this same directory`;
  let there: LockRecord | null;
  try {
    there = readRecord<LockRecord>(wasLock, 'lock');
  } catch (error) {
    return `the lock where the install was, ${wasLock}, can't be read (${(error as Error).message.replace(/\.+$/, '')})`;
  }
  if (there === null) return `there's no lock where the install was, at ${wasLock}`;
  if (there.pid !== holder.pid || there.at !== holder.at) return `the lock where the install was, ${wasLock}, names another`;
  return null;
}

function setAsideCopied(lock: string, holder: LockRecord): void {
  const aside = `${lock}.${process.pid}.copied`;
  try {
    renameSync(lock, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  let moved: LockRecord | null = null;
  try {
    moved = readRecord<LockRecord>(aside, 'lock');
  } catch {
  }
  if (moved?.pid !== holder.pid || moved.at !== holder.at) {
    try {
      linkSync(aside, lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new ContractError(`While setup set aside the lock that came with this copy, another process took this ` +
        `install's lock, and setup moved that process's lock to ${aside}, and couldn't put it back, since ${lock} is ` +
        'there again. Setup has changed nothing else, and hasn\'t bound the install. Each of the two files names a ' +
        'process that may be running in this install: stop each that is, remove both files, and run setup again.');
    }
  }
  rmSync(aside, { force: true });
  syncDir(dirname(lock));
}

export function bindingCheckLines(said: string, allowSetup: boolean, release: string | null, report = 'console.error'): string[] {
  const setupInRelease = [...RELEASE_HOST.split(sep), 'src', 'update', 'setup.ts'].map((part) => `'${part}'`).join(', ');
  return [
    "const quoted = (path) => /^[\\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\\\''`)}'`;",
    `const writer = ${JSON.stringify(release)};`,
    `const ownSetup = writer === null ? null : join(root, 'releases', writer, ${setupInRelease});`,
    "const readJson = (path) => {",
    '  try {',
    "    return JSON.parse(readFileSync(path, 'utf-8'));",
    '  } catch {',
    '    return null;',
    '  }',
    '};',
    "const record = readJson(join(root, 'install.json'));",
    "const bound = record?.v === 1 && typeof record.workingDir === 'string' && isAbsolute(record.workingDir)",
    '  ? record.workingDir : null;',
    "const damaged = record?.v === 1 && record.workingDir !== undefined && bound === null;",
    "const recorded = record?.v === 1 ? record.dataDir : null;",
    "const under = bound === null || bound.endsWith('/') ? bound : `${bound}/`;",
    "const inside = typeof recorded === 'string' && bound !== null && (recorded === bound || recorded.startsWith(under));",
    "const now = '<where its data directory is now>';",
    "const sameDirectory = (a, b) => {",
    '  try {',
    '    const one = statSync(a, { bigint: true });',
    '    const other = statSync(b, { bigint: true });',
    '    return one.dev === other.dev && one.ino === other.ino;',
    '  } catch {',
    '    return false;',
    '  }',
    '};',
    "const elsewhere = bound !== null && !sameDirectory(bound, dirname(root));",
    "const served = typeof recorded !== 'string' ? null : inside ? join(dirname(root), recorded.slice(bound.length))",
    "  : bound !== null && !elsewhere ? recorded : now;",
    "const place = typeof recorded === 'string' && !inside && (bound === null || elsewhere) ? " +
      "` --place ${quoted(recorded)} ${quoted(now)}` : '';",
    "const notHeld = `the setup of ${writer}, the release whose setup wrote this file, which this install's releases don't hold now: ` +",
    "  `install exactly ${writer} in ${quoted(dirname(root))} first, as docs/DEPLOYMENTS.md shows, and run its setup by hand`;",
    "const byHand = served === null || writer === null ? 'its setup by hand again, as docs/DEPLOYMENTS.md shows'",
    "  : existsSync(ownSetup) ? `the setup of ${writer}, the release whose setup wrote this file: \\`cd ${quoted(dirname(root))} && ` +",
    "    `DATA_DIR=${quoted(served)} bun --no-env-file ${quoted(ownSetup)} --root ${quoted(root)}${place}\\``",
    "  : notHeld;",
    "const rewriteByHand = writer === null ? 'its setup by hand again, as docs/DEPLOYMENTS.md shows'",
    "  : existsSync(ownSetup) ? `the setup of ${writer}, the release whose setup wrote this file, ${quoted(ownSetup)}, ` +",
    "    'run by hand as docs/DEPLOYMENTS.md shows' : notHeld;",
    `if (damaged${allowSetup ? " && process.argv[2] !== 'setup'" : ''}) {`,
    `  ${report}(\`${said}: nothing runs in this install, since its record, \${join(root, 'install.json')}, holds a \` +`,
    "    '\"workingDir\" that isn\\'t an absolute path, so whether it was moved or copied here, and whose places its ' +",
    "    `record names, can't be told. Setup says how to write the record again: run \\`${quoted(join(root, 'connectome'))} setup discord\\`, ` +",
    "    `or, for an install set up by hand, ${rewriteByHand}. A service that ` +",
    "    'restarts the host will keep meeting this until the record is written again: stop it first, and start it again after.');",
    '  process.exit(1);',
    '}',
    `if (elsewhere${allowSetup ? " && process.argv[2] !== 'setup'" : ''}) {`,
    `  ${report}(\`${said}: nothing runs in this install, since its record is bound to \${bound}, and it's in \` +`,
    "    `${dirname(root)}, so it was moved or copied here, and the places its record names may be another install's. ` +",
    "    `Setup binds it to this directory, asking about any place outside ${bound}: run ` +",
    "    `\\`${quoted(join(root, 'connectome'))} setup discord\\`, or, for an install set up by hand, ${byHand}. A ` +",
    "    'service that restarts the host will keep meeting this until setup has run: stop it first, and start it again after.');",
    '  process.exit(1);',
    '}',
  ];
}
