/**
 * Binding an install to the directory it's in. Setup records the real path of the directory that holds the
 * install's root (InstallRecord.workingDir), and the entry point and the install's own command refuse a record
 * bound to another directory: the install was moved or copied there, and its record, its copy's labels and its Go
 * backs' lists still name the places of the install it was. Setup then binds it. Each place under the directory it
 * was bound to becomes the same place under this one, and each other place takes the answer setup is given for it,
 * since only the person can say whether a place outside came with the install, as after a move, or is still
 * another's, as after a copy. A record without workingDir, from a release before it, says nothing of where it was set
 * up, so binding one takes every place from an answer.
 *
 * A binding that changes a path in a label or a list writes its plan first, under the install's lock, then the
 * guarded entry point and command, then each file, stamped with the plan's id, then the record, and removes the plan
 * last. While the plan is there the entries refuse, so no host starts on places half bound, and the next setup
 * finishes a binding cut off from its plan, without asking again.
 */
import { randomUUID } from 'node:crypto';
import { linkSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import {
  ContractError, copyLabelPath, installPaths, readRecord, realOrResolved, syncDir, writeJsonAtomic,
  type CopyLabel, type GoBackList, type InstallRecord, type LockRecord,
} from './contract.js';
import { isUnder, lockLive, takeLock, type LauncherOps } from './launcher.js';

/** The plan of a binding under way, in the install's root (RebindPlan). */
export const REBIND_PLAN = 'rebind.json';

export interface RebindPlan {
  v: 1;
  /** Names this binding: each file it rewrites carries it as `rebound`. */
  id: string;
  /** The directory the record was bound to, or null for a record from before workingDir. */
  from: string | null;
  /** The directory the binding binds the install to. */
  to: string;
  /** Each place given its place in this install: its path as the record and the files name it, and where it is. */
  places: Array<{ from: string; to: string }>;
  /** The record the binding writes last. */
  record: InstallRecord;
}

export function rebindPath(root: string): string {
  return join(root, REBIND_PLAN);
}

/** The directory an install at `root` is bound to: the real path of the directory that holds its root. */
export function workingDirOf(root: string): string {
  return dirname(realpathSync(root));
}

/** A file of the install's root whose paths a binding maps: a copy's label, or a Go back's list of its places. */
export interface BoundFile {
  path: string;
  kind: 'label' | 'list';
  value: CopyLabel | GoBackList;
  /** Each path it names. */
  paths: string[];
}

function pathsIn(value: CopyLabel | GoBackList, kind: BoundFile['kind']): string[] | null {
  const lists = kind === 'label'
    ? [(value as CopyLabel).items, (value as CopyLabel).absent ?? []]
    : [(value as GoBackList).places];
  const paths: string[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) return null;
    for (const entry of list as unknown[]) {
      const path = (entry as { path?: unknown } | null)?.path;
      if (typeof path !== 'string') return null;
      paths.push(path);
    }
  }
  return paths;
}

/** The copy's labels a start can still read (the copy's, and the one before it, which a start puts back when the
 *  copy is gone) and each Go back's list. An unfinished copy's label isn't among them: a start removes that copy
 *  before it reads anything of it. */
export function boundFiles(root: string): BoundFile[] {
  const { copy, copyPrev, setAside } = installPaths(root);
  const found: Array<{ path: string; kind: BoundFile['kind'] }> = [
    { path: copyLabelPath(copy), kind: 'label' },
    { path: copyLabelPath(copyPrev), kind: 'label' },
  ];
  try {
    for (const entry of readdirSync(setAside, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) found.push({ path: join(setAside, entry.name, 'places.json'), kind: 'list' });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const files: BoundFile[] = [];
  for (const { path, kind } of found) {
    let value: CopyLabel | GoBackList | null;
    try {
      value = readRecord<CopyLabel | GoBackList>(path, kind === 'label' ? "copy's label" : "Go back's list of places");
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      throw new ContractError(`${error.message.replace(/\.+$/, '')}, so setup can't bind the places it names to this ` +
        'directory, and has changed nothing.');
    }
    if (value === null) continue;
    const paths = pathsIn(value, kind);
    if (paths === null) {
      throw new ContractError(`${path} names its places in a form this release can't read, so setup can't bind them to ` +
        'this directory, and has changed nothing.');
    }
    files.push({ path, kind, value, paths });
  }
  return files;
}

/** A place the record or a label or list names, with whatever inside it they name too. */
export interface Place {
  path: string;
  /** The record names it, or a place inside it, as its data directory. */
  data: boolean;
  /** The record names it, or a place inside it, as state kept outside the data directory. */
  extra: boolean;
  /** The labels and lists that name it, or a place inside it. */
  files: string[];
}

/** Every place the record and the files name, outermost only, since a place inside another goes where it goes: the
 *  data directory's first, then the extra state's in the record's order, then the rest. */
export function placesOf(record: InstallRecord, files: BoundFile[]): Place[] {
  const named = new Map<string, Place>();
  const at = (path: string): Place => {
    let place = named.get(path);
    if (place === undefined) named.set(path, place = { path, data: false, extra: false, files: [] });
    return place;
  };
  at(record.dataDir).data = true;
  const extraState = Array.isArray(record.extraState) ? record.extraState.filter((path) => typeof path === 'string') : [];
  for (const path of extraState) at(path).extra = true;
  for (const file of files) for (const path of file.paths) if (!at(path).files.includes(file.path)) at(path).files.push(file.path);
  const all = [...named.values()];
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

/** Where a binding puts `path`: by the answer for the innermost place given one that holds it, or else, under the
 *  directory the record was bound to, at the same place under this one; null when neither holds it. */
export function mapPath(path: string, plan: Pick<RebindPlan, 'from' | 'to' | 'places'>): string | null {
  let best: { from: string; to: string } | null = null;
  for (const place of plan.places) {
    if (isUnder(path, place.from) && (best === null || place.from.length > best.from.length)) best = place;
  }
  if (best === null && plan.from !== null && isUnder(path, plan.from)) best = { from: plan.from, to: plan.to };
  return best === null ? null : join(best.to, relative(best.from, path));
}

/** What setup finds of an install's binding: its record names this directory; a binding cut off left its plan; or
 *  it's to be bound, with the places it names and those of them that need an answer. */
export type Binding =
  | { kind: 'bound'; to: string }
  | { kind: 'resume'; plan: RebindPlan }
  | { kind: 'bind'; from: string | null; to: string; places: Place[]; ask: Place[] };

export function bindingOf(root: string, record: InstallRecord): Binding {
  const plan = readPlan(root);
  if (plan !== null) return { kind: 'resume', plan };
  const to = workingDirOf(root);
  if (record.workingDir === to) return { kind: 'bound', to };
  const from = typeof record.workingDir === 'string' ? record.workingDir : null;
  const places = placesOf(record, boundFiles(root));
  return { kind: 'bind', from, to, places, ask: places.filter((place) => from === null || !isUnder(place.path, from)) };
}

/** The plan a binding cut off left, or null when there is none. */
export function readPlan(root: string): RebindPlan | null {
  const path = rebindPath(root);
  const damaged = (why: string) => new ContractError(`The plan of a binding of this install that was cut off, at ${path}, ` +
    `${why}, so setup can't tell which place it gave each place this install names, and can't finish it. Setup has ` +
    'changed nothing. If you know the place each should name, put this install\'s record, copy/copy.json and each ' +
    'set-aside/*/places.json right, and remove the plan.');
  let plan: RebindPlan | null;
  try {
    plan = readRecord<RebindPlan>(path, 'plan of a binding');
  } catch (error) {
    throw damaged(error instanceof ContractError ? 'isn\'t one this release reads' : `can't be read (${(error as Error).message})`);
  }
  if (plan === null) return null;
  const record = plan.record as Partial<InstallRecord> | undefined;
  const readable = typeof plan.id === 'string' && plan.id !== '' && (plan.from === null || typeof plan.from === 'string') &&
    typeof plan.to === 'string' && Array.isArray(plan.places) &&
    plan.places.every((place) => typeof place?.from === 'string' && typeof place.to === 'string') &&
    typeof record?.dataDir === 'string' && Array.isArray(record.extraState) &&
    record.extraState.every((place) => typeof place === 'string');
  if (!readable) throw damaged('isn\'t one this release reads');
  return plan;
}

export function newPlan(from: string | null, to: string, places: RebindPlan['places'], record: InstallRecord): RebindPlan {
  return { v: 1, id: randomUUID(), from, to, places, record };
}

/** Whether binding by `plan` changes a path in any of `files`. */
export function changesFiles(plan: RebindPlan, files: BoundFile[]): boolean {
  return files.some((file) => file.paths.some((path) => mapPath(path, plan) !== path));
}

export function writePlan(root: string, plan: RebindPlan): void {
  writeJsonAtomic(rebindPath(root), plan);
}

/** Rewrite each label and list the plan hasn't yet, each stamped with its id in the same write. */
export function rewriteFiles(root: string, plan: RebindPlan): void {
  for (const file of boundFiles(root)) {
    if (file.value.rebound === plan.id) continue;
    const map = <T extends { path: string }>(place: T): T => {
      const path = mapPath(place.path, plan);
      if (path === null) {
        throw new ContractError(`${file.path} names ${place.path}, which the plan at ${rebindPath(root)} gives no place ` +
          'in this install, so setup can\'t bind it.');
      }
      return { ...place, path };
    };
    if (file.kind === 'label') {
      const label = file.value as CopyLabel;
      writeJsonAtomic(file.path, {
        ...label, items: label.items.map(map), ...(label.absent === undefined ? {} : { absent: label.absent.map(map) }),
        rebound: plan.id,
      } satisfies CopyLabel);
    } else {
      const list = file.value as GoBackList;
      writeJsonAtomic(file.path, { ...list, places: list.places.map(map), rebound: plan.id } satisfies GoBackList);
    }
  }
}

export function removePlan(root: string): void {
  unlinkSync(rebindPath(root));
  syncDir(root);
}

/** Take the install's lock for a binding. `from` is the directory the record was bound to, or null for a record
 *  from before that was recorded. A running holder whose lock the root where the install was holds as well, the
 *  same process since the same time, came with a copy, and is set aside, if it's still the one compared. Any other
 *  running holder is refused, saying only what's known. */
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
  let wasReal: string;
  try {
    wasReal = realOrResolved(was);
  } catch (error) {
    return `${was}, where the install was, can't be followed (${(error as Error).message})`;
  }
  if (wasReal === here) return `${was}, where the install was, leads to this same directory`;
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

/** The lines each setup-written entry, the entry point and the install's command, runs before it imports anything
 *  of a release, with `root` its install's root, as it found it, and `existsSync`, `readFileSync`, `dirname` and
 *  `join` in scope. `allowSetup` lets the command's `setup` through, since setup is what binds. */
export function bindingCheckLines(said: string, allowSetup: boolean): string[] {
  return [
    '{',
    `  const plan = join(root, ${JSON.stringify(REBIND_PLAN)});`,
    '  let refused = null;',
    '  if (existsSync(plan)) {',
    '    refused = `a setup binding this install to ${dirname(root)} was cut off before it finished (${plan} is its ` +',
    "      'plan), so the places it names may be half bound. Setup finishes it, without asking about its places again';",
    '  } else {',
    '    let bound;',
    '    try {',
    "      bound = JSON.parse(readFileSync(join(root, 'install.json'), 'utf-8'))?.workingDir;",
    '    } catch {',
    '    }',
    "    if (typeof bound === 'string' && bound !== dirname(root)) {",
    '      refused = `its record is bound to ${bound}, and it\'s in ${dirname(root)}, so it was moved or copied here, ` +',
    "        'and the places its record names may be another install\\'s. Setup binds it to this directory, asking about ' +",
    '        `any place outside ${bound}`;',
    '    }',
    '  }',
    `  if (refused !== null${allowSetup ? " && process.argv[2] !== 'setup'" : ''}) {`,
    "    const quoted = (path) => /^[\\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\\\''`)}'`;",
    `    console.error(\`${said}: nothing runs in this install, since \${refused}: run \\\`\${quoted(join(root, 'connectome'))} \` +`,
    "      'setup discord\\`, or, for an install set up by hand, its setup by hand again, as docs/DEPLOYMENTS.md shows.');",
    '    process.exit(1);',
    '  }',
    '}',
  ];
}
