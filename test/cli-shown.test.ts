import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHOWN_FILE, shownToPerson } from '../src/cli/shown.js';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-shown-'));
  made.push(dir);
  return dir;
}

function context() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, ctx: { out: (line: string) => { out.push(line); }, err: (line: string) => { err.push(line); } } };
}

test('where setup\'s agent names a file, each line a command prints reaches its own output and that file, in the order printed', () => {
  const file = join(directory(), 'shown');
  writeFileSync(file, '');
  const { out, err, ctx } = context();
  const shown = shownToPerson(ctx, { [SHOWN_FILE]: file });
  shown.out('first, to stdout');
  shown.err('then a warning, to stderr');
  shown.out('last, to stdout');
  expect(out).toEqual(['first, to stdout', 'last, to stdout']);
  expect(err).toEqual(['then a warning, to stderr']);
  expect(readFileSync(file, 'utf-8')).toBe('first, to stdout\nthen a warning, to stderr\nlast, to stdout\n');
});

test('where no file is named, or the name is empty, a command prints as before and nothing more', () => {
  for (const env of [{}, { [SHOWN_FILE]: '' }]) {
    const { out, err, ctx } = context();
    const shown = shownToPerson(ctx, env);
    shown.out('a line');
    shown.err('a warning');
    expect(out).toEqual(['a line']);
    expect(err).toEqual(['a warning']);
  }
});

test('a named file that can\'t be written leaves the command\'s output whole, and says so once, naming the file', () => {
  const file = join(directory(), 'shown');
  mkdirSync(file);
  const { out, err, ctx } = context();
  const shown = shownToPerson(ctx, { [SHOWN_FILE]: file });
  shown.out('first');
  shown.err('a warning');
  shown.out('last');
  expect(out).toEqual(['first', 'last']);
  const notes = err.filter((line) => line !== 'a warning');
  expect(err).toContain('a warning');
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain(file);
});
