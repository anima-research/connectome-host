/**
 * What the launcher does to an install's data (contract.ts): copy it, and put
 * one set of an item's contents in place of another, so that a start cut off
 * anywhere leaves a state the next start can finish, in either direction.
 *
 * An item is a directory, such as a data directory, or a file, such as an
 * MCPL settings file. A directory item may be a mount point, so nothing here
 * renames the item itself: its entries move, inside its own filesystem, into
 * and out of directories under its ITEM_UPDATE_DIR, which no copy holds and
 * no swap moves. A file item may be a mount point too, so its content is
 * written in place, and what it held before is kept elsewhere first.
 */
import {
  chmodSync, closeSync, constants, copyFileSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readdirSync, readlinkSync, readSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ContractError, ITEM_UPDATE_DIR } from './contract.js';

/** The mode of the directories an update keeps data in: what they hold is
 *  the install's data, so only its owner reads it. */
export const PRIVATE_DIR_MODE = 0o700;

/** Sync a file's data, or a directory's entries, to disk. */
export function syncPath(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Sync the entries of a directory found there, passing over one this
 *  process may not open: no attempt could ever sync it, so a stop there would
 *  last until someone changed its mode, while only an entry that an earlier
 *  attempt made or removed, and that stopped on this very sync, is left to a
 *  power cut. A directory this attempt has just changed is synced with
 *  syncPath, which passes over nothing. */
export function syncEntries(dir: string): void {
  try {
    syncPath(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') throw error;
  }
}

export function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Make `dir` and each of its missing ancestors with `mode`, and sync the
 *  parent of each directory on the way, made now or found, so no journal line
 *  written after it can outlive it on disk: one an earlier attempt made, cut
 *  off before its parent's sync, is found now. A found one's parent that this
 *  process may not open is passed over (syncEntries); one it has just made an
 *  entry in must be synced. */
export function makeDirs(dir: string, mode = 0o777): void {
  const chain: string[] = [];
  for (let at = resolve(dir); dirname(at) !== at; at = dirname(at)) chain.push(at);
  for (const path of chain.reverse()) {
    if (exists(path)) {
      syncEntries(dirname(path));
    } else {
      mkdirSync(path, { mode });
      syncPath(dirname(path));
    }
  }
}

/** Copy `from`, a directory, a file or a link, to `to`, which mustn't exist,
 *  and sync what it writes, so a power cut after it returns can't take any of
 *  it back. A file is cloned where the filesystem can clone, and keeps its
 *  mode; so does a directory. A link is copied as the link. Anything else,
 *  such as the socket a stopped host leaves, and every ITEM_UPDATE_DIR at any
 *  depth, are left out. */
export function copyTree(from: string, to: string): void {
  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) {
    symlinkSync(readlinkSync(from), to);
  } else if (stat.isDirectory()) {
    mkdirSync(to);
    for (const name of readdirSync(from)) {
      if (name === ITEM_UPDATE_DIR) continue;
      const entry = lstatSync(join(from, name));
      if (entry.isDirectory() || entry.isFile() || entry.isSymbolicLink()) copyTree(join(from, name), join(to, name));
    }
    chmodSync(to, stat.mode & 0o7777);
    syncPath(to);
  } else if (stat.isFile()) {
    copyFileSync(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    chmodSync(to, stat.mode & 0o7777);
    syncPath(to);
  }
}

/** The bytes a copy of `path` writes where it can't clone: each file's size,
 *  rounded up to a 4 KiB block, over what copyTree copies. */
export function spaceTaken(path: string): number {
  const stat = lstatSync(path);
  if (stat.isFile()) return Math.ceil(stat.size / 4096) * 4096;
  if (!stat.isDirectory()) return 0;
  let total = 4096;
  for (const name of readdirSync(path)) {
    if (name !== ITEM_UPDATE_DIR) total += spaceTaken(join(path, name));
  }
  return total;
}

/** Move every entry of `from` into `to` by renames, and sync both. Moving out
 *  of an item leaves its ITEM_UPDATE_DIR where it is. An entry already at the
 *  destination is a state no step of this module makes, so it stops here,
 *  since a rename would silently replace a file or an empty directory. */
function moveEntries(from: string, to: string, item: string): void {
  for (const name of readdirSync(from)) {
    if (from === item && name === ITEM_UPDATE_DIR) continue;
    const source = join(from, name);
    const target = join(to, name);
    if (exists(target)) {
      throw new ContractError(`${target} is already there, so ${source} can't be moved to it without losing one of them.`);
    }
    // Moving a directory to another parent rewrites its `..`, which a
    // directory this process can't write refuses, so one it owns gets owner
    // write for the rename and its mode back after, even when the rename
    // fails; a cut between the two leaves that one bit. One another owns
    // can't be given write, and the launcher refuses a request that would
    // move one before it changes anything.
    try {
      renameSync(source, target);
    } catch (error) {
      const stat = lstatSync(source);
      if ((error as NodeJS.ErrnoException).code !== 'EACCES' || !stat.isDirectory() || (stat.mode & 0o200) !== 0) {
        throw error;
      }
      const mode = stat.mode & 0o7777;
      chmodSync(source, mode | 0o200);
      let moved = false;
      try {
        renameSync(source, target);
        moved = true;
      } finally {
        chmodSync(moved ? target : source, mode);
      }
    }
  }
  syncPath(from);
  syncPath(to);
}

function renameAndSync(from: string, to: string): void {
  renameSync(from, to);
  syncPath(dirname(to));
}

/**
 * Put the entries `incoming` holds in `item`'s place, with those `item` holds
 * now kept in `outgoing`, both directories inside the item's ITEM_UPDATE_DIR.
 * Called again in the other direction, as drive(item, incoming, outgoing), it
 * puts them back. Each step is a rename, and whichever step a cut stops at,
 * a call in either direction finishes from there, since the names say which
 * set the item holds:
 * - the item is drained into an area under a `.filling` name, and that area
 *   takes its own name only once the item holds none of that set;
 * - an area is renamed to `.emptying` before its entries move into the item,
 *   and removed once it's empty.
 * So the item never holds entries of both sets, and `incoming` must be whole
 * (or under way, as the names say) when a drive in this direction starts.
 */
export function drive(item: string, outgoing: string, incoming: string): void {
  const outFilling = `${outgoing}.filling`;
  const outEmptying = `${outgoing}.emptying`;
  const inFilling = `${incoming}.filling`;
  const inEmptying = `${incoming}.emptying`;
  // The other direction was draining the item into `incoming`: what it moved
  // goes back, and the item holds `incoming`'s set again.
  if (exists(inFilling)) {
    moveEntries(inFilling, item, item);
    rmdirSync(inFilling);
    syncPath(dirname(inFilling));
    return;
  }
  // The other direction was filling the item from `outgoing`: drain it back.
  if (exists(outEmptying)) {
    moveEntries(item, outEmptying, item);
    renameAndSync(outEmptying, outgoing);
  }
  if (!exists(outgoing)) {
    if (!exists(incoming) && !exists(inEmptying)) {
      throw new ContractError(`${incoming} isn't there, so ${item} has nothing to take in its place.`);
    }
    makeDirs(outFilling, PRIVATE_DIR_MODE);
    moveEntries(item, outFilling, item);
    renameAndSync(outFilling, outgoing);
  }
  if (exists(incoming)) renameAndSync(incoming, inEmptying);
  if (exists(inEmptying)) {
    moveEntries(inEmptying, item, item);
    rmdirSync(inEmptying);
    syncPath(dirname(inEmptying));
  }
}

/** How much of a file a write in place reads at once, so a large file takes
 *  no more memory than this. */
const CHUNK = 2 ** 20;

function writeAll(fd: number, data: Uint8Array): void {
  for (let at = 0; at < data.length;) at += writeSync(fd, data, at, data.length - at);
}

/** Fill `buffer` from `fd` where it stands, or as much as is left: its byte count. */
function readFull(fd: number, buffer: Buffer): number {
  let at = 0;
  for (let n; at < buffer.length && (n = readSync(fd, buffer, at, buffer.length - at, null)) > 0;) at += n;
  return at;
}

/** Whether files `a` and `b` hold the same bytes. */
export function sameContent(a: string, b: string): boolean {
  if (lstatSync(a).size !== lstatSync(b).size) return false;
  const fa = openSync(a, 'r');
  try {
    const fb = openSync(b, 'r');
    try {
      const ba = Buffer.alloc(CHUNK);
      const bb = Buffer.alloc(CHUNK);
      for (;;) {
        const na = readFull(fa, ba);
        const nb = readFull(fb, bb);
        if (na !== nb || !ba.subarray(0, na).equals(bb.subarray(0, nb))) return false;
        if (na === 0) return true;
      }
    } finally {
      closeSync(fb);
    }
  } finally {
    closeSync(fa);
  }
}

/** Copy `from` to `to` so that `to` is whole or not there: a copy beside it,
 *  under a short fixed name (one writer at a time), synced, renamed over it.
 *  One a cut left is removed first, since it may have taken a mode that
 *  its owner can't write. */
export function copyFileWhole(from: string, to: string): void {
  const tmp = join(dirname(to), '.connectome-update.tmp');
  try {
    unlinkSync(tmp);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  copyFileSync(from, tmp, constants.COPYFILE_FICLONE);
  chmodSync(tmp, lstatSync(from).mode & 0o7777);
  syncPath(tmp);
  renameAndSync(tmp, to);
}

/** Open `file` to write it from the start, made with `mode` if it isn't
 *  there. One this process may not write, whose owner can't either, gets
 *  owner write first, which the caller's own mode puts back. */
function openForWriting(file: string, mode: number): number {
  try {
    return openSync(file, 'w', mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EACCES' || !exists(file)) throw error;
    const held = lstatSync(file).mode & 0o7777;
    if ((held & 0o200) !== 0) throw error;
    chmodSync(file, held | 0o200);
    return openSync(file, 'w', mode);
  }
}

/** Write `source`'s content into `file` in place: the same file, truncated
 *  and written a chunk at a time, so a file item that is a mount point, or
 *  has an owner of its own, stays as it is. A file that already holds that
 *  content isn't written, as a read-only one, which nothing could have
 *  changed, can't be. Either way the file is left with `mode` and synced
 *  before this returns, so a replay after a cut between a write and its sync
 *  syncs it too. A cut leaves it partly written, which a restore can afford
 *  only because the journal has the restore under way, so the next start
 *  writes it again before anything reads it. A file that isn't there is made
 *  in its directory, which is made too if something removed it. When `made`,
 *  the file wasn't there before the restore's first attempt, so each attempt
 *  syncs its directory, as the first would have. */
export function writeFileInPlace(file: string, source: string, mode: number, made: boolean): void {
  makeDirs(dirname(file));
  const there = exists(file);
  const same = there && sameContent(file, source);
  // The source first, so one that can't be read leaves the file as it is.
  const input = same ? null : openSync(source, 'r');
  try {
    const fd = same ? openSync(file, 'r') : openForWriting(file, mode);
    try {
      if (input !== null) {
        const chunk = Buffer.alloc(CHUNK);
        for (let n; (n = readFull(input, chunk)) > 0;) writeAll(fd, chunk.subarray(0, n));
      }
      // Its mode before its sync, so the sync holds it too.
      if ((fstatSync(fd).mode & 0o7777) !== mode) fchmodSync(fd, mode);
      try {
        fsyncSync(fd);
      } catch (error) {
        // A file on a read-only filesystem, never written, has nothing to sync.
        if (!same || (error as NodeJS.ErrnoException).code !== 'EROFS') throw error;
      }
    } finally {
      closeSync(fd);
    }
  } finally {
    if (input !== null) closeSync(input);
  }
  if (made || !there) syncPath(dirname(file));
}

/** Remove `path` and everything under it, if it's there. A copy keeps each
 *  directory's mode, and a directory its owner can't write can't have its
 *  entries removed, so each directory is first made its owner's to change. */
export function removeTree(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isDirectory()) {
    unlinkSync(path);
    return;
  }
  if ((stat.mode & 0o700) !== 0o700) chmodSync(path, (stat.mode & 0o7777) | 0o700);
  for (const name of readdirSync(path)) removeTree(join(path, name));
  rmdirSync(path);
}

/** Remove `file`, if it's there, and sync its directory, so the removal
 *  can't come undone once a later line says it happened. */
export function removeFile(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Also when it was gone: an earlier attempt's removal may not be synced.
    if (exists(dirname(file))) syncEntries(dirname(file));
    return;
  }
  syncPath(dirname(file));
}

/** Where a restore keeps what a file item held before it writes over it:
 *  its content at `kept`, or at `absent` an empty note that it wasn't there.
 *  Each restore of an item has its own pair, decided at its first attempt,
 *  so a replay after a cut reads what the item held before that attempt
 *  rather than what the attempt left. */
export interface FileKeep {
  kept: string;
  absent: string;
}

/** Keep what `file` holds now, or note that it isn't there, unless an
 *  earlier attempt of the same restore already did. */
export function keepFile(file: string, keep: FileKeep): void {
  for (const done of [keep.kept, keep.absent]) {
    if (!exists(done)) continue;
    // A cut may have come before its directory's sync.
    syncPath(dirname(done));
    return;
  }
  if (exists(file)) {
    makeDirs(dirname(keep.kept), PRIVATE_DIR_MODE);
    copyFileWhole(file, keep.kept);
  } else {
    makeDirs(dirname(keep.absent), PRIVATE_DIR_MODE);
    closeSync(openSync(keep.absent, 'w', 0o600));
    syncPath(dirname(keep.absent));
  }
}

/** Put `source`'s content in `file`'s place, or with null take the file
 *  away, after keeping what it holds now (keepFile). Called again after a
 *  cut, it does the same, and the keep still holds what came before. */
export function replaceFile(file: string, source: string | null, keep: FileKeep, ownMode?: number): void {
  if (exists(file) && lstatSync(file).isSymbolicLink()) {
    throw new ContractError(`${file} is a link now, and an update writes a file item in place, so it won't write through ` +
      'the link to what it names. Put the file itself there, and the next start tries again.');
  }
  keepFile(file, keep);
  if (source === null) {
    removeFile(file);
    return;
  }
  // A file that was there keeps its own mode, as its keep holds it, unless
  // the caller knows it better; one the restore makes takes the source's.
  const made = exists(keep.absent);
  writeFileInPlace(file, source, made ? lstatSync(source).mode & 0o7777 : ownMode ?? lstatSync(keep.kept).mode & 0o7777, made);
}

/** Put back in `file`'s place what `kept` holds of it, its content or its
 *  absence, and its mode, keeping what it holds now in `keep`: the file as it
 *  was before, whatever mode a restore that failed partway left it. */
export function putFileBack(file: string, kept: FileKeep, keep: FileKeep): void {
  if (exists(kept.kept)) replaceFile(file, kept.kept, keep, lstatSync(kept.kept).mode & 0o7777);
  else if (exists(kept.absent)) replaceFile(file, null, keep);
  else throw new ContractError(`Nothing kept of ${file} is at ${kept.kept}, so it can't be put back.`);
}
