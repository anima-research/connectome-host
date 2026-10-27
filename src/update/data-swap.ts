/**
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

export const PRIVATE_DIR_MODE = 0o700;

export function syncPath(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Sync the entries of a directory found there, passing over one this
 *  process may not open: no attempt could ever sync it. */
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

const BLOCK_BYTES = 4096;

export function spaceTaken(path: string): number {
  const stat = lstatSync(path);
  if (stat.isFile()) return Math.ceil(stat.size / BLOCK_BYTES) * BLOCK_BYTES;
  if (!stat.isDirectory()) return 0;
  let total = BLOCK_BYTES;
  for (const name of readdirSync(path)) {
    if (name !== ITEM_UPDATE_DIR) total += spaceTaken(join(path, name));
  }
  return total;
}

function moveEntries(from: string, to: string, item: string): void {
  for (const name of readdirSync(from)) {
    if (from === item && name === ITEM_UPDATE_DIR) continue;
    const source = join(from, name);
    const target = join(to, name);
    if (exists(target)) {
      throw new ContractError(`${target} is already there, so ${source} can't be moved to it without losing one of them.`);
    }
    // Moving a directory to another parent rewrites its `..`, which a
    // directory this process can't write refuses, so one it owns gets
    // owner write for the rename and its mode back after, even when the
    // rename fails.
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

export function drive(item: string, outgoing: string, incoming: string): void {
  const outFilling = `${outgoing}.filling`;
  const outEmptying = `${outgoing}.emptying`;
  const inFilling = `${incoming}.filling`;
  const inEmptying = `${incoming}.emptying`;
  if (exists(inFilling)) {
    moveEntries(inFilling, item, item);
    rmdirSync(inFilling);
    syncPath(dirname(inFilling));
    return;
  }
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

const CHUNK = 2 ** 20;

function writeAll(fd: number, data: Uint8Array): void {
  for (let at = 0; at < data.length;) at += writeSync(fd, data, at, data.length - at);
}

function readFull(fd: number, buffer: Buffer): number {
  let at = 0;
  for (let n; at < buffer.length && (n = readSync(fd, buffer, at, buffer.length - at, null)) > 0;) at += n;
  return at;
}

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

export function writeFileInPlace(file: string, source: string, mode: number, absentBefore: boolean): void {
  makeDirs(dirname(file));
  const there = exists(file);
  const same = there && sameContent(file, source);
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
  if (absentBefore || !there) syncPath(dirname(file));
}

/** A directory its owner can't write can't have its entries removed, so
 *  each directory is first made its owner's to change. */
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

export function removeFile(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (exists(dirname(file))) syncEntries(dirname(file));
    return;
  }
  syncPath(dirname(file));
}

export interface FileKeep {
  kept: string;
  absent: string;
}

export function keepFile(file: string, keep: FileKeep): void {
  for (const done of [keep.kept, keep.absent]) {
    if (!exists(done)) continue;
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
  const absentBefore = exists(keep.absent);
  writeFileInPlace(file, source,
    absentBefore ? lstatSync(source).mode & 0o7777 : ownMode ?? lstatSync(keep.kept).mode & 0o7777, absentBefore);
}

export function putFileBack(file: string, kept: FileKeep, keep: FileKeep): void {
  if (exists(kept.kept)) replaceFile(file, kept.kept, keep, lstatSync(kept.kept).mode & 0o7777);
  else if (exists(kept.absent)) replaceFile(file, null, keep);
  else throw new ContractError(`Nothing kept of ${file} is at ${kept.kept}, so it can't be put back.`);
}
