import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takeFileLock } from '../src/setup/file-lock.js';
import { holdFileLock } from './helpers/held-file-lock.js';

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function lockFile(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'file-lock-')));
  made.push(dir);
  return join(dir, 'operation.lock');
}

test('an exclusive file lock refuses a second connection until released', () => {
  const file = lockFile();
  const held = takeFileLock(file);
  expect(held).not.toBeNull();
  try { expect(takeFileLock(file)).toBeNull(); } finally { held?.release(); }
  const next = takeFileLock(file);
  expect(next).not.toBeNull();
  next?.release();
});

test('a file lock held by another process refuses acquisition, and SIGKILL releases it', async () => {
  const file = lockFile();
  const release = await holdFileLock(file);
  try { expect(takeFileLock(file)).toBeNull(); } finally { await release(); }
  const next = takeFileLock(file);
  expect(next).not.toBeNull();
  next?.release();
});
