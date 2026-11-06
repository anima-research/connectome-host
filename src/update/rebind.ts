import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ContractError, REBIND_PLAN, childrenFilePath, copyLabelPath, installPaths, isChildEntry, readRecord, syncDir,
  writeJsonAtomic, type ChildrenFile, type CopyLabel, type GoBackList, type InstallRecord, type LockRecord,
} from './contract.js';
import { RELEASE_HOST, isUnder, lockLive, takeLock, type LauncherOps } from './launcher.js';

export interface RebindPlan {
  v: 1;
  id: string;
  from: string | null;
  to: string;
  places: Array<{ from: string; to: string }>;
  record: InstallRecord;
}

export function rebindPath(root: string): string {
  return join(root, REBIND_PLAN);
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

export interface BoundFile {
  path: string;
  kind: 'label' | 'list' | 'children';
  value: CopyLabel | GoBackList | ChildrenFile;
  paths: string[];
}

const FILE_NAMES: Record<BoundFile['kind'], string> = {
  label: "copy's label", list: "Go back's list of places", children: "fleet's children file",
};

function pathsIn(value: BoundFile['value'], kind: BoundFile['kind']): string[] | null {
  if (kind === 'children') {
    const { children } = value as ChildrenFile;
    return Array.isArray(children) ? children.filter(isChildEntry).map((child) => child.dataDir) : null;
  }
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

export function boundFiles(root: string, dataDir: string | null, underWay: string | null = null): BoundFile[] {
  const unbindable = (why: string, path: string) => new ContractError(`${why}, so setup can't bind the places it ` +
    'names to this ' + (underWay === null ? 'directory, and has changed nothing.'
      : `directory. A binding of this install is under way, with its plan at ${underWay}: put ${path} right and run ` +
        'setup again, which finishes the binding or names what else stops it.'));
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
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw unbindable(`${setAside} can't be listed (${(error as Error).message})`, setAside);
    }
  }
  if (dataDir !== null) found.push({ path: childrenFilePath(dataDir), kind: 'children' });
  const files: BoundFile[] = [];
  for (const { path, kind } of found) {
    let value: BoundFile['value'] | null;
    try {
      value = readRecord<BoundFile['value']>(path, FILE_NAMES[kind]);
    } catch (error) {
      throw unbindable(error instanceof ContractError ? error.message.replace(/\.+$/, '')
        : `The ${FILE_NAMES[kind]} at ${path} can't be read (${(error as Error).message})`, path);
    }
    if (value === null) continue;
    const paths = pathsIn(value, kind);
    if (paths === null) throw unbindable(`${path} names its places in a form this release can't read`, path);
    files.push({ path, kind, value, paths });
  }
  return files;
}

export interface Place {
  path: string;
  data: boolean;
  extra: boolean;
  files: string[];
}

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

export function mapPath(path: string, plan: Pick<RebindPlan, 'from' | 'to' | 'places'>): string | null {
  let best: { from: string; to: string } | null = null;
  for (const place of plan.places) {
    if (isUnder(path, place.from) && (best === null || place.from.length > best.from.length)) best = place;
  }
  if (best === null && plan.from !== null && isUnder(path, plan.from)) best = { from: plan.from, to: plan.to };
  return best === null ? null : join(best.to, relative(best.from, path));
}

export type Binding =
  | { kind: 'bound'; to: string }
  | { kind: 'resume'; plan: RebindPlan }
  | {
    kind: 'bind'; from: string | null; to: string; places: Place[]; ask: Place[]; kept: RebindPlan['places'];
    files: BoundFile[]; served: string | null;
  };

function keptHere(path: string, to: string, rootName: string): string | null {
  for (let at = path; ; at = dirname(at)) {
    if (sameDirectory(at, to)) return join(to, relative(at, path));
    if (existsSync(join(at, rootName, 'install.json')) || dirname(at) === at) return null;
  }
}

export function bindingOf(root: string, record: InstallRecord, placed: RebindPlan['places'] = []): Binding {
  const plan = readPlan(root);
  if (plan !== null) return { kind: 'resume', plan };
  const to = workingDirOf(root);
  if (boundHere(record, root)) return { kind: 'bound', to };
  const from = typeof record.workingDir === 'string' ? record.workingDir : null;
  const dataKept = from === null ? keptHere(record.dataDir, to, basename(root)) : null;
  const served = mapPath(record.dataDir,
    { from, to, places: [...placed, ...dataKept === null ? [] : [{ from: record.dataDir, to: dataKept }]] });
  const files = boundFiles(root, served);
  const extraState = Array.isArray(record.extraState) ? record.extraState.filter((path) => typeof path === 'string') : [];
  const named = [
    ...[record.dataDir, ...extraState].map((path) => ({ path, by: `This install's record (${installPaths(root).install})` })),
    ...files.flatMap((file) => file.paths.map((path) => ({ path, by: file.path }))),
  ];
  const roundabout = named.find(({ path }) => resolve(path) !== path);
  if (roundabout !== undefined) {
    throw new ContractError(`${roundabout.by} names ${roundabout.path}, ` + (isAbsolute(roundabout.path)
      ? `which isn't in the plain form setup compares places in. Write it as ${resolve(roundabout.path)}`
      : 'which isn\'t an absolute path. Write the absolute path it means') +
      ', and run setup again. Setup has changed nothing.');
  }
  const places = placesOf(record, files);
  const kept = from === null
    ? places.flatMap((place) => {
      const here = keptHere(place.path, to, basename(root));
      return here === null ? [] : [{ from: place.path, to: here }];
    })
    : [];
  return {
    kind: 'bind', from, to, places, files, served,
    ask: places.filter((place) => from === null ? !kept.some((one) => one.from === place.path) : !isUnder(place.path, from)),
    kept,
  };
}

export function readPlan(root: string): RebindPlan | null {
  const path = rebindPath(root);
  const damaged = (why: string) => new ContractError(`The plan of a binding of this install that was cut off, at ${path}, ` +
    `${why}, so setup can't tell which place it gave each place this install names, and can't finish it. Setup has ` +
    'changed nothing. If you know the place each should name, put this install\'s record, copy/copy.json, ' +
    'copy.prev/copy.json and each set-aside/*/places.json right, and remove the plan.');
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
    record?.v === 1 && typeof record.dataDir === 'string' && Array.isArray(record.extraState) &&
    record.extraState.every((place) => typeof place === 'string') && typeof record.workingDir === 'string';
  if (!readable) throw damaged('isn\'t one this release reads');
  return plan;
}

export function newPlan(from: string | null, to: string, places: RebindPlan['places'], record: InstallRecord): RebindPlan {
  return { v: 1, id: randomUUID(), from, to, places, record };
}

export function changesFiles(plan: RebindPlan, files: BoundFile[]): boolean {
  return files.some((file) => file.paths.some((path) => mapPath(path, plan) !== path));
}

export function writePlan(root: string, plan: RebindPlan): void {
  writeJsonAtomic(rebindPath(root), plan);
}

export function rewriteFiles(root: string, plan: RebindPlan): void {
  for (const file of boundFiles(root, plan.record.dataDir, rebindPath(root))) {
    if (file.value.rebound === plan.id) {
      syncDir(dirname(file.path));
      continue;
    }
    const placeOf = (was: string): string => {
      const path = mapPath(was, plan);
      if (path === null) {
        throw new ContractError(`${file.path} names ${was}, which the plan at ${rebindPath(root)} gives no place ` +
          'in this install, so setup can\'t bind it.');
      }
      return path;
    };
    const map = <T extends { path: string }>(place: T): T => ({ ...place, path: placeOf(place.path) });
    if (file.kind === 'children') {
      const children = file.value as ChildrenFile;
      writeJsonAtomic(file.path, {
        ...children,
        children: children.children.map((child) => {
          if (!isChildEntry(child)) return child;
          const dataDir = placeOf(child.dataDir);
          const other = existsSync(child.dataDir) && !sameDirectory(child.dataDir, dataDir);
          return other ? { ...child, dataDir, pid: null, bootId: null } : { ...child, dataDir };
        }),
        rebound: plan.id,
      } satisfies ChildrenFile);
    } else if (file.kind === 'label') {
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
    `const plan = join(root, ${JSON.stringify(REBIND_PLAN)});`,
    "const record = readJson(join(root, 'install.json'));",
    "const bound = record?.v === 1 && typeof record.workingDir === 'string' ? record.workingDir : null;",
    "const recorded = existsSync(plan) ? readJson(plan)?.record?.dataDir : record?.v === 1 ? record.dataDir : null;",
    "const served = typeof recorded !== 'string' ? null : !existsSync(plan) && bound !== null &&",
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
    '  let refused = null;',
    '  if (existsSync(plan)) {',
    '    refused = `a setup binding this install was cut off before it finished (${plan} is its plan), so the places ` +',
    "      'it names may be half bound. Setup, run again, finishes it from its plan without asking about its places ' +",
    "      'again, or says what stops it';",
    '  } else if (bound !== null && !sameDirectory(bound, dirname(root))) {',
    '    refused = `its record is bound to ${bound}, and it\'s in ${dirname(root)}, so it was moved or copied here, ` +',
    "      'and the places its record names may be another install\\'s. Setup binds it to this directory, asking about ' +",
    '      `any place outside ${bound}`;',
    '  }',
    `  if (refused !== null${allowSetup ? " && process.argv[2] !== 'setup'" : ''}) {`,
    `    console.error(\`${said}: nothing runs in this install, since \${refused}: run \\\`\${quoted(join(root, 'connectome'))} \` +`,
    "      `setup discord\\`, or, for an install set up by hand, ${byHand}. A service that restarts the host will keep ` +",
    "      'meeting this until setup has run: stop it first, and start it again after.');",
    '    process.exit(1);',
    '  }',
    '}',
  ];
}
