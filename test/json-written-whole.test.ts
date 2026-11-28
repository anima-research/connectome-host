/**
 * Every JSON file the host rewrites is written whole (writeJsonWhole: a file
 * beside it, renamed over it), so a host or a machine that stops mid-write
 * leaves what was there (#740). This test holds the rule over src/: a
 * writeFileSync whose content is JSON.stringify is allowed only where it
 * names a file written once, into a place of its own, with the reason here.
 */
import { describe, expect, test } from 'bun:test';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { writeJsonWhole } from '../src/write-json-whole.js';

const SRC = join(import.meta.dir, '..', 'src');

/** A direct JSON write, with why it isn't a rewrite. */
const WRITTEN_ONCE: Record<string, string> = {
  'commands.ts': "/export writes the conversation to a new file named for the moment; nothing reads it back.",
  'cli/setup.ts': 'setup writes the first recipe into a directory it found empty or its own.',
};

const DIRECT_JSON_WRITE = /\bwriteFileSync\(\s*[^,]+,\s*JSON\.stringify\(/g;

function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f));
}

describe('JSON the host rewrites is written whole', () => {
  test('no JSON file is written in place but the ones written once, named here with the reason', () => {
    const direct: Record<string, number> = {};
    for (const file of sources(SRC)) {
      if (relative(SRC, file) === 'write-json-whole.ts') continue; // the one write every rewrite goes through
      const matches = readFileSync(file, 'utf-8').match(DIRECT_JSON_WRITE);
      if (matches) direct[relative(SRC, file)] = matches.length;
    }
    expect(Object.keys(direct).sort()).toEqual(Object.keys(WRITTEN_ONCE).sort());
    for (const [file, reason] of Object.entries(WRITTEN_ONCE)) expect(reason, file).not.toBe('');
  });

  test('writeJsonWhole leaves the file and nothing beside it, follows a link to its target, and gives the mode on overwrite too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'json-whole-'));
    try {
      const path = join(dir, 'a.json');
      writeJsonWhole(path, { n: 1 });
      expect(readFileSync(path, 'utf-8')).toBe('{\n  "n": 1\n}\n');
      expect(readdirSync(dir)).toEqual(['a.json']);
      // Overwrite with a mode: the renamed file is new, so the mode holds without a chmod.
      writeJsonWhole(path, { n: 2 }, { mode: 0o600 });
      expect(readFileSync(path, 'utf-8')).toBe('{\n  "n": 2\n}\n');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      // A replacer is JSON.stringify's.
      writeJsonWhole(path, { n: Infinity }, { replacer: (_k, v) => (v === Infinity ? '1e309' : v) });
      expect(readFileSync(path, 'utf-8')).toBe('{\n  "n": "1e309"\n}\n');
      // A link: its target is written, and the link stays a link.
      const target = join(dir, 'real.json');
      writeFileSync(target, '{}\n');
      const link = join(dir, 'link.json');
      symlinkSync(target, link);
      writeJsonWhole(link, { via: 'link' });
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(target);
      expect(readFileSync(target, 'utf-8')).toBe('{\n  "via": "link"\n}\n');
      expect(readdirSync(dir).sort()).toEqual(['a.json', 'link.json', 'real.json']);
      // A path in a directory not yet there.
      writeJsonWhole(join(dir, 'deep', 'er', 'b.json'), []);
      expect(readFileSync(join(dir, 'deep', 'er', 'b.json'), 'utf-8')).toBe('[]\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
