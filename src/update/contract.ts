/**
 * The contract between a running host and the launcher of an install that
 * updates itself: every file one side writes and the other reads, where it
 * lives, and its form. Both halves import this module rather than restating
 * any of it.
 *
 * An install keeps each release side by side under one root, which the entry
 * point passes to the host as CONNECTOME_INSTALL_ROOT. A host started without
 * it, such as a checkout or an install that setup hasn't wrapped, writes none
 * of these files and behaves as it always has.
 *
 * The rule for changing it: a field never changes meaning in place. A new
 * meaning is a new field, and the old one keeps being written, so the release
 * before can still read everything a newer host writes, and its fallback never
 * strands. Added fields keep `v: 1`, and readers ignore fields they don't know.
 * A reader that meets any other `v` refuses, naming the file: that guards
 * against a mistake, not a planned break.
 *
 * Who writes what:
 * - the host: the mark (Update, Go back), the record of who was cut off (a
 *   stop that couldn't wait for quiet), the fleet's children file, and the
 *   commit, which moves `current`. It appends the journal's `commit` line
 *   after it moves `current`, never before, so a `commit` line always means
 *   `current` moved. It appends its `notes` line when it writes the
 *   residents' notes;
 * - the launcher: every other journal line, the lock, the copy and its label,
 *   and what a restore sets aside;
 * - setup: the install record;
 * - whichever release starts next: the residents' notes from the record of who
 *   was cut off, which it then clears;
 * - whichever half first reads a spent mark: removing it (readMark).
 *
 * The journal has one writer at a time: the launcher appends before it starts
 * a release and after one ends, and the host while it runs. A host writes a
 * mark only after its commit, so the launcher that acts on a mark is always
 * its own release's.
 */
import {
  closeSync, fsyncSync, lstatSync, openSync, readFileSync, readlinkSync, renameSync, symlinkSync, truncateSync,
  unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** The environment variable through which the entry point names the install's root. */
export const INSTALL_ROOT_ENV = 'CONNECTOME_INSTALL_ROOT';

/** The host's exit status when it stops so that its next start switches
 *  release or goes back: 75, EX_TEMPFAIL, "try again". It needs a supervisor
 *  that restarts a host exiting non-zero, as the units the deployment docs
 *  show do (systemd's Restart=on-failure, launchd's KeepAlive). */
export const RESTART_EXIT_CODE = 75;

/** The install's root, or null when the host wasn't started through the
 *  entry point, in which case it writes none of this contract's files. */
export function installRootFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const root = env[INSTALL_ROOT_ENV];
  return root ? resolve(root) : null;
}

export interface InstallPaths {
  root: string;
  /** One exact npm install per release, at `releases/<version>/`. */
  releases: string;
  /** A link to `releases/<version>`: the release that last committed on this install's data. */
  current: string;
  /** Setup's record of the data directory this install serves (InstallRecord). */
  install: string;
  /** The release to switch to, and why (Mark). */
  mark: string;
  /** One JournalLine per step, appended. */
  journal: string;
  /** The launcher's lock (LockRecord). */
  lock: string;
  /** The switch's copy: each item it holds, under the name copyItemName gives
   *  it, and its label (CopyLabel, at copyLabelPath). Taken as `copy.tmp` and
   *  renamed once whole. */
  copy: string;
  copyTmp: string;
  /** What a restore set aside of a file item, one directory per mark
   *  (setAsideDir), kept. A directory item's goes inside it (itemSetAsideDir). */
  setAside: string;
  /** Who was cut off mid-turn (MidTurnRecord). Outside the data, so a restore can't take it back. */
  midTurn: string;
}

export function installPaths(root: string): InstallPaths {
  return {
    root,
    releases: join(root, 'releases'),
    current: join(root, 'current'),
    install: join(root, 'install.json'),
    mark: join(root, 'mark.json'),
    journal: join(root, 'journal.jsonl'),
    lock: join(root, 'lock.json'),
    copy: join(root, 'copy'),
    copyTmp: join(root, 'copy.tmp'),
    setAside: join(root, 'set-aside'),
    midTurn: join(root, 'midturn.json'),
  };
}

export function releaseDir(root: string, version: string): string {
  return join(root, 'releases', segment(version, 'release'));
}

/** A copy's label, in the copy itself: `copy.tmp/copy.json` while it's taken,
 *  then `copy/copy.json`. */
export function copyLabelPath(copyDir: string): string {
  return join(copyDir, 'copy.json');
}

/** The longest name a directory entry takes on Linux's and macOS's filesystems, in bytes. */
const NAME_MAX = 255;

/** The name a copy gives the item at `position` in its label, whose path is
 *  `path`: the position, a `-`, and the path's last part, cut at the end of a
 *  character to fit one directory entry. The position keeps any two names
 *  apart on every filesystem, one that ignores case or Unicode form included,
 *  and keeps every name from being the label's own; the last part lets an
 *  operator recognize the item. */
export function copyItemName(position: number, path: string): string {
  let name = `${position}-`;
  let room = NAME_MAX - Buffer.byteLength(name);
  for (const char of basename(path)) {
    room -= Buffer.byteLength(char);
    if (room < 0) break;
    name += char;
  }
  return name;
}

/** Where a restore sets aside a file item's newer content, named by the mark
 *  it acts on, so a retry finds the one it started. A Go back that keeps the
 *  newer data sets a copy of it aside here too, before the older release's
 *  trial, so that trial's fallback can put it back. Each file's content is
 *  copied there, since the item may be on another filesystem, under the
 *  item's name in the copy (copyItemName), so no two share an entry. A
 *  directory item's newer content is set aside inside it instead
 *  (itemSetAsideDir). */
export function setAsideDir(root: string, markId: string): string {
  return join(root, 'set-aside', segment(markId, 'mark id'));
}

/** Where a restore sets aside a directory item's newer content: inside the
 *  item, under the launcher's `.connectome-update/`, so no rename crosses
 *  a filesystem. A Go back that keeps the newer data sets a copy of it aside
 *  here too, before the older release's trial, so that trial's fallback can
 *  put it back. The launcher's copy of an item leaves that directory out. */
export function itemSetAsideDir(item: string, markId: string): string {
  return join(item, '.connectome-update', 'set-aside', segment(markId, 'mark id'));
}

/** The fleet's children file, in the parent's data directory: each child's
 *  process, boot and data directory, which the launcher checks before a
 *  switch. The launcher reads it before anything is copied or restored,
 *  since a restore puts back the data directory's earlier contents, this
 *  file's included. */
export function childrenFilePath(dataDir: string): string {
  return join(dataDir, 'fleet-children.json');
}

// ---------------------------------------------------------------------------
// The forms
// ---------------------------------------------------------------------------

/** install.json, written by setup. */
export interface InstallRecord {
  v: 1;
  /** The data directory this install serves; the entry point refuses another. */
  dataDir: string;
  /** Server state setup found outside the data directory, copied with it. */
  serverState: string[];
}

/** mark.json, written by the host. */
export interface Mark {
  v: 1;
  /** Names this request, so the journal lines that act on it can say so
   *  (JournalLine.mark): a random UUID, new for each request. */
  id: string;
  /** The release to switch to. */
  to: string;
  why: 'update' | 'go-back';
  at: string;
  /** A Go back that keeps the newer data instead of restoring the copy. */
  keepData?: boolean;
}

export const JOURNAL_STEPS = [
  'lock', 'children-check', 'audit', 'copy', 'trial-start', 'commit', 'fallback', 'go-back', 'notes',
] as const;
export type JournalStep = typeof JOURNAL_STEPS[number];

/** One line of journal.jsonl, written by the launcher, except `commit` and
 *  `notes`, which the host writes. The journal carries each request from the
 *  first change to its data on, so the line that lets the data change goes in
 *  before it does: a switch's `trial-start` before its trial starts, and a Go
 *  back's `go-back` once the Go back has prepared and synced everything it
 *  needs, such as a restore's staged items or the newer data's copy set
 *  aside, and before it changes any data. An ok `go-back` says the data may
 *  change from that line on: a start that finds it with no ok `trial-start`,
 *  `commit` or `fallback` after it resumes that Go back from the line,
 *  whatever the mark file holds.
 *  A `go-back` that isn't ok, refused or failed, says the data wasn't
 *  touched. */
export interface JournalLine {
  v: 1;
  at: string;
  step: JournalStep;
  from: string;
  to: string;
  outcome: 'ok' | 'refused' | 'failed';
  /** Why, for `refused` and `failed`. */
  reason?: string;
  /** The id of the mark a launcher's line acts on: every step of the switch
   *  it asks for, its fallback included, and a Go back's. */
  mark?: string;
  /** On every ok `go-back` line: whether the Go back keeps the newer data
   *  rather than restoring the copy, as its mark's `keepData` asked. A start
   *  that resumes the Go back reads it here, since it goes on whatever the
   *  mark file holds. */
  keptData?: boolean;
}

/** lock.json, written by the launcher. Its holder is gone when its pid isn't
 *  running, or when the machine has booted since (bootId). */
export interface LockRecord {
  v: 1;
  pid: number;
  bootId: string | null;
  at: string;
}

/** midturn.json, written by the host at a stop that couldn't wait for quiet. */
export interface MidTurnRecord {
  v: 1;
  at: string;
  from: string;
  to: string;
  /** The residents whose turn the stop cut off. */
  residents: string[];
}

/** copy.json, the copy's label, written by the launcher as the last file of a
 *  copy it takes, once every item is copied and synced, and removed as the
 *  first when the copy goes. */
export interface CopyLabel {
  v: 1;
  /** The release whose data the copy holds. */
  from: string;
  at: string;
  /** Each item the copy holds, one at least: where it lives, as an absolute
   *  path, and its name in the copy, which copyItemName gives from its
   *  position in this list and that path. A reader checks that the name is one
   *  path segment starting with that position and a `-`, and nothing after
   *  that, so a later release can change what follows the `-`. The `-` keeps
   *  position 1 from taking position 10's name. */
  items: Array<{ path: string; name: string }>;
}

/** fleet-children.json, written by the fleet. */
export interface ChildrenFile {
  v: 1;
  children: Array<{ name: string; pid: number | null; bootId: string | null; dataDir: string }>;
}

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractError';
  }
}

/** Whether `value` can name one entry of a directory: a non-empty string with
 *  no separator or NUL, neither `.` nor `..`, and no longer than an entry's
 *  name can be (NAME_MAX). */
function pathSegment(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value !== '.' && value !== '..' &&
    !value.includes('/') && !value.includes('\0') && Buffer.byteLength(value) <= NAME_MAX;
}

/** `value`, when it is one path segment, or a ContractError: every path this
 *  module builds from a release or a mark id takes it as one entry of a
 *  directory, wherever the value came from. */
function segment(value: string, what: string): string {
  if (!pathSegment(value)) {
    throw new ContractError(`The ${what} ${JSON.stringify(value)} isn't one path segment, so it can't name a directory.`);
  }
  return value;
}

function syncDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Write all of `text`. A write can come back short, as when the disk fills
 *  or the file reaches its size limit, so each write goes on from where the
 *  last one stopped, until every byte is written or a write fails with the
 *  reason. */
function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text, 'utf-8');
  for (let done = 0; done < bytes.length;) done += writeSync(fd, bytes, done, bytes.length - done);
}

/** Write `value` as JSON at `path` so that a reader sees the old file or the
 *  new one, never part of either: a temporary file, synced, renamed over it.
 *  Each file has one writer at a time, so the temporary file's name is fixed,
 *  and one a crash left is overwritten by the next write. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeAll(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  syncDir(dirname(path));
}

/** Read one of this contract's files: null when it doesn't exist, the record
 *  when its `v` is 1, and a ContractError naming the file when what it holds
 *  isn't a record this release reads. Any other failure to read it is the
 *  filesystem's own error. */
export function readRecord<T extends { v: 1 }>(path: string, what: string): T | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ContractError(`The ${what} at ${path} isn't JSON, so this release can't read it.`);
  }
  return checkVersion<T>(value, `The ${what} at ${path}`);
}

function checkVersion<T>(value: unknown, named: string): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractError(`${named} isn't an object, so this release can't read it.`);
  }
  const v = (value as { v?: unknown }).v;
  if (v !== 1) {
    throw new ContractError(`${named} has version ${JSON.stringify(v)}, and this release reads only version 1.`);
  }
  return value as T;
}

/** Append one line to the journal and sync it, and the root, so a later start
 *  can trust it whichever append created the journal. A last line without its
 *  newline was cut off as it was written, and readJournal takes it as not
 *  recorded. It's cut away first: this line would otherwise join it, and no
 *  later read could get past the two. */
export function appendJournal(root: string, line: Omit<JournalLine, 'v'>): void {
  const path = installPaths(root).journal;
  cutTornTail(path);
  const fd = openSync(path, 'a');
  try {
    writeAll(fd, `${JSON.stringify({ v: 1, ...line })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDir(root);
}

/** Cut a last line left without its newline back to the line before it. */
function cutTornTail(path: string): void {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) truncateSync(path, bytes.lastIndexOf(0x0a) + 1);
}

/** The journal's lines, oldest first, and none when there's no journal. A
 *  journal that is there but can't be read is the filesystem's own error, so a
 *  start never takes it for an empty history. A last line without its newline
 *  was cut off as it was written, so its step is taken as not recorded. Any
 *  other line that can't be read is a ContractError naming it. */
export function readJournal(root: string): JournalLine[] {
  const path = installPaths(root).journal;
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
  const lines: JournalLine[] = [];
  complete.split('\n').forEach((raw, i) => {
    if (!raw) return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ContractError(`Line ${i + 1} of the journal at ${path} isn't JSON, so this release can't read it.`);
    }
    lines.push(checkVersion<JournalLine>(value, `Line ${i + 1} of the journal at ${path}`));
  });
  return lines;
}

/** The release `current` names, or null when there's no link yet. */
export function readCurrent(root: string): string | null {
  try {
    return basename(readlinkSync(installPaths(root).current));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Point `current` at a release in one step: a new link renamed over the old.
 *  At a switch, this is the commit. */
export function moveCurrent(root: string, version: string): void {
  const { current } = installPaths(root);
  const target = join('releases', segment(version, 'release'));
  // Fixed, since there is one writer at a time. A link can't be made over one
  // a crash left, so that one is removed first; only its absence is no error.
  const tmp = `${current}.tmp`;
  try {
    unlinkSync(tmp);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  symlinkSync(target, tmp);
  renameSync(tmp, current);
  syncDir(root);
}

/** The trial a start must fall back from: the journal's last successful
 *  `trial-start` with no successful `commit`, `fallback` or `go-back` after
 *  it, while `current` doesn't name the release it tried. A `current` that
 *  does name it means the trial committed, whatever the journal managed to
 *  record, and a Go back comes only after a commit. A fallback that failed
 *  leaves the trial unfinished, for the next start. */
export function unfinishedTrial(lines: JournalLine[], current: string | null): JournalLine | null {
  let trial: JournalLine | null = null;
  for (const line of lines) {
    if (line.outcome !== 'ok') continue;
    if (line.step === 'trial-start') trial = line;
    else if (line.step === 'commit' || line.step === 'fallback' || line.step === 'go-back') trial = null;
  }
  return trial && current !== trial.to ? trial : null;
}

/** Whether a mark's request has run its course: its switch committed, so
 *  `current` names its `to`, or a fallback that names it succeeded, so the
 *  same failing request isn't run again. A switch refused before its trial
 *  leaves the mark standing, and the next start tries it again. A Go back's
 *  `go-back` line doesn't spend its mark, since the Go back is under way from
 *  there, not done. Like any mark, it's spent by its commit, the older
 *  release's, or by a successful fallback that names it. It needs no clock,
 *  since a new request to the same release has a new id. */
export function markSpent(mark: Mark, lines: JournalLine[], current: string | null): boolean {
  // No line can say that a mark without an id has run, though a line that
  // names no mark has no id either.
  return current === mark.to || (typeof mark.id === 'string' &&
    lines.some((line) => line.step === 'fallback' && line.outcome === 'ok' && line.mark === mark.id));
}

/** The mark standing at this install, or null when there is none. A spent
 *  mark (markSpent) is removed here, so whichever half reads it first clears
 *  it, and both decide the same way. A mark this release can't use is
 *  refused, spent or not, and kept for whoever reads the refusal: no line can
 *  say that a mark without a usable id has run. */
export function readMark(root: string): Mark | null {
  const path = installPaths(root).mark;
  const mark = readRecord<Mark>(path, 'mark');
  if (mark === null) return null;
  const remedy = 'Removing the mark file drops its request, which can then be made again, unless the request is ' +
    'under way: a switch from its ok trial-start line, or a Go back from its ok go-back line, until current ' +
    'names the release it asked for or an ok fallback line follows. A request under way goes on from the ' +
    "journal whatever the mark file holds, and before those lines a request hasn't changed the data.";
  if (!pathSegment(mark.id)) {
    throw new ContractError(
      `The mark at ${path} has no id this release can use: an id names the request and the directory a restore ` +
      `sets aside into, so it is one path segment (the host writes a random UUID). ${remedy}`,
    );
  }
  if (!pathSegment(mark.to)) {
    throw new ContractError(
      `The mark at ${path} names no release this release can use: its \`to\` names the release's directory, so it ` +
      `is one path segment. ${remedy}`,
    );
  }
  if (!markSpent(mark, readJournal(root), readCurrent(root))) return mark;
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return null;
}

/** The switch's copy, as its label says: the release whose data it holds,
 *  when it was taken, and its items. The launcher writes the label once every
 *  item is copied and synced, and removes it first when the copy goes, so a
 *  copy with its label holds every item the label lists. Null when there's no
 *  label: no copy is there to use. A start finds that before any copy is
 *  taken, while a copy is being removed, and after damage that took the
 *  label, which this can't tell apart; the journal can. While a switch's
 *  trial is unfinished there is always a copy, since the switch took one
 *  before it, so null then is damage. (A Go back's trial took no copy: its
 *  fallback puts back what the Go back set aside, and doesn't read this.) A
 *  copy whose label lists an item that isn't there has been damaged too,
 *  since nothing the launcher does removes one item alone, so that is a
 *  ContractError naming the item. Either way a switch's fallback can't
 *  restore, and must stop rather than start the older release on the trial's
 *  data. A label whose contents this release can't read is a ContractError
 *  naming it, and a failure to read the label at all is the filesystem's own
 *  error.
 *
 *  A restore copies the items back and leaves the copy whole, so the copy
 *  still reads here after it. Which restore may use it is decided from its
 *  `from`: a fallback's, when that is the release `current` names, whose data
 *  the trial started from; a Go back's, when that is the release the Go back
 *  goes back to. The journal's `copy` lines are the step's record, and
 *  nothing reads them for this. */
export function lastCopy(root: string): CopyLabel | null {
  const { copy } = installPaths(root);
  const path = copyLabelPath(copy);
  const label = readRecord<CopyLabel>(path, "copy's label");
  if (label === null) return null;
  const readable = Array.isArray(label.items) && label.items.length > 0 && label.items.every((item, position) =>
    typeof item?.path === 'string' && isAbsolute(item.path) && pathSegment(item.name) &&
    item.name.startsWith(`${position}-`));
  if (!readable) {
    throw new ContractError(
      `The copy's label at ${path} has no list of items this release can read: it lists one or more, each with an ` +
      'absolute path and a name in the copy that is one path segment and starts with its position in the list ' +
      'and a "-", as copyItemName gives it.',
    );
  }
  for (const item of label.items) {
    try {
      lstatSync(join(copy, item.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new ContractError(
        `The copy at ${copy} has lost ${item.name}, its copy of ${item.path}, so it's damaged and no restore can ` +
        'use it.',
      );
    }
  }
  return label;
}
