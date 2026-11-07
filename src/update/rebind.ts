import { existsSync, linkSync, lstatSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ContractError, ITEM_UPDATE_DIR, VersionError, childrenFilePath, installPaths, isChildEntry, itemSetAsideDir, readRecord,
  syncDir, writeJsonAtomic, type ChildrenFile, type InstallRecord, type JournalLine, type LockRecord,
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

/** Whether two paths name one directory, by device and inode, so another spelling of it (its case on a volume that
 *  ignores case, a link, a bind mount) names it too. A path that can't be looked at names none. */
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
  const bound = boundTo !== undefined && boundTo !== from;
  if (bound && !sameDirectory(boundTo, to)) {
    throw new ContractError(`A setup run binding this install to ${boundTo} was cut off before it finished: the fleet's ` +
      `children file, ${path}, is bound to ${boundTo}, and the install is in ${to} now, so the places it names are that ` +
      `directory's. Setup has changed nothing. Move the install back to ${boundTo}, run setup there, which finishes that ` +
      'binding, and then move it.');
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
  const to = workingDirOf(root);
  if (boundHere(record, root)) return { kind: 'bound', to };
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

export function childrenMove(children: Children | null, mapping: Mapping): boolean {
  return children !== null && !children.bound && children.paths.some((path) => mapPath(path, mapping) !== path);
}

export function bindChildren(children: Children, mapping: Mapping): void {
  writeJsonAtomic(children.path, {
    ...children.value,
    children: children.value.children.map((child) => {
      if (!isChildEntry(child)) return child;
      const dataDir = mapPath(child.dataDir, mapping);
      if (dataDir === null) {
        throw new ContractError(`${children.path} names ${child.dataDir}, which this binding gives no place, so setup ` +
          'can\'t bind it.');
      }
      const other = existsSync(child.dataDir) && !sameDirectory(child.dataDir, dataDir);
      return other ? { ...child, dataDir, pid: null, bootId: null } : { ...child, dataDir };
    }),
    boundTo: mapping.to,
  } satisfies ChildrenFile);
}

export function movesPlaces(binding: Bind, places: Moved[]): boolean {
  return binding.from !== null || places.some((place) => place.from !== place.to);
}

export interface KeptInRoot {
  found: string[];
  marks: string[];
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
  const copies = [copy, copyPrev].filter((path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined);
  return { found: [...copies, ...marks.map((mark) => join(setAside, mark))], marks };
}

export const MOVE_ASIDE_REFUSED = '--move-aside moves aside what an install\'s updates and Go backs keep once the ' +
  'install\'s places have moved, and this run gives none of them another place, so what they keep still names this ' +
  'install\'s places. Run it again without.';

export const MOVED_ASIDE_AFTERWARDS = 'Nothing removes what\'s moved aside: it takes its space until you remove it. ' +
  'What a Go back kept holds the newer data it set aside, so move out what you want of it rather than deleting it. ' +
  'Until the next update takes a new copy, /update back restore isn\'t there, and each update says it removes no older ' +
  'release.';

export const MOVE_ASIDE_BY_HAND = 'each one listed, and in each directory an update copies, ' +
  '.connectome-update/set-aside/<mark> and .connectome-update/staging/<mark> for each mark listed, with or without ' +
  '.tmp, .filling or .emptying after it';

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

export function unfinishedTrialWords(trial: JournalLine): string {
  return `A trial is unfinished: the journal's last ok trial-start, to ${trial.to}, has no ok commit, ` +
    'fallback or go-back after it, and if it ends before its commit, its fallback puts the places back from what\'s ' +
    'listed here. Setup has changed nothing. Let that trial end where the install was, by starting it there, moving ' +
    'it back first if it was moved, and then move or copy it again.';
}

export interface MovedAside {
  moved: Moved[];
  outside: string[];
}

export function moveAside(root: string, to: string, places: string[], kept: KeptInRoot, now: Date): MovedAside {
  const time = now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  const there = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  const aside = join(root, 'moved-aside', time);
  const moves: Moved[] = [];
  const outside: string[] = [];
  for (const mark of kept.marks) {
    for (const place of places) {
      for (const area of [itemSetAsideDir(place, mark), itemStagingDir(place, mark)]) {
        for (const path of ['', '.tmp', '.filling', '.emptying'].map((suffix) => area + suffix).filter(there)) {
          const update = join(place, ITEM_UPDATE_DIR);
          if (isUnder(place, to)) moves.push({ from: path, to: join(update, 'moved-aside', time, relative(update, path)) });
          else outside.push(path);
        }
      }
    }
    moves.push({ from: join(installPaths(root).setAside, mark), to: join(aside, 'set-aside', mark) });
  }
  const { copy, copyPrev } = installPaths(root);
  for (const path of [copyPrev, copy].filter(there)) moves.push({ from: path, to: join(aside, basename(path)) });
  const moved: Moved[] = [];
  for (const move of moves) {
    try {
      makeDirs(dirname(move.to));
      renameSync(move.from, move.to);
      syncDir(dirname(move.from));
      syncDir(dirname(move.to));
    } catch (error) {
      throw new ContractError(`Moving ${move.from} to ${move.to} failed (${(error as Error).message}), so setup stops ` +
        `there. Setup has moved ${moved.length === 0 ? 'nothing else'
          : `only these:\n${moved.map((one) => `  ${one.from} → ${one.to}`).join('\n')}\nand nothing else`}, removes ` +
        `nothing it moved, and hasn't bound the install. Move ${move.from} out of the way yourself, keeping what you ` +
        'want of it, and run setup again with --move-aside, which moves what\'s left.');
    }
    moved.push(move);
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
        `run setup again; if the lock came with a copy, remove ${lock} and run setup again.`);
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
    }
  }
  rmSync(aside, { force: true });
  syncDir(dirname(lock));
}

export function bindingCheckLines(said: string, allowSetup: boolean, release: string | null): string[] {
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
    "const bound = record?.v === 1 && typeof record.workingDir === 'string' ? record.workingDir : null;",
    "const recorded = record?.v === 1 ? record.dataDir : null;",
    "const served = typeof recorded !== 'string' ? null : bound !== null &&",
    "  (recorded === bound || recorded.startsWith(`${bound}/`)) ? join(dirname(root), recorded.slice(bound.length)) : recorded;",
    'const byHand = ownSetup !== null && existsSync(ownSetup) && served !== null',
    "  ? `the setup of ${writer}, the release whose setup wrote this file: \\`cd ${quoted(dirname(root))} && ` +",
    "    `DATA_DIR=${quoted(served)} bun --no-env-file ${quoted(ownSetup)} --root ${quoted(root)}\\``",
    "  : 'its setup by hand again, as docs/DEPLOYMENTS.md shows';",
    '{',
    '  const sameDirectory = (a, b) => {',
    '    try {',
    '      const one = statSync(a, { bigint: true });',
    '      const other = statSync(b, { bigint: true });',
    '      return one.dev === other.dev && one.ino === other.ino;',
    '    } catch {',
    '      return false;',
    '    }',
    '  };',
    `  if (bound !== null && !sameDirectory(bound, dirname(root))${allowSetup ? " && process.argv[2] !== 'setup'" : ''}) {`,
    `    console.error(\`${said}: nothing runs in this install, since its record is bound to \${bound}, and it's in \` +`,
    "      `${dirname(root)}, so it was moved or copied here, and the places its record names may be another install's. ` +",
    "      `Setup binds it to this directory, asking about any place outside ${bound}: run ` +",
    "      `\\`${quoted(join(root, 'connectome'))} setup discord\\`, or, for an install set up by hand, ${byHand}. A ` +",
    "      'service that restarts the host will keep meeting this until setup has run: stop it first, and start it again after.');",
    '    process.exit(1);',
    '  }',
    '}',
  ];
}
