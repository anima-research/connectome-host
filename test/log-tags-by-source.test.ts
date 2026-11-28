/**
 * The log tags a bug report counts by name come from the host and the
 * packages it depends on. `bug-report.test.ts` holds HOST_LOG_TAGS to the
 * host's own source; this holds it to the packages: it reads each
 * `@animalabs` dependency's installed `dist` with the same rule — a string
 * literal that begins with a bracketed tag — and fails with the name and
 * package of a tag the list lacks, so a tag a package release adds is named
 * in a report rather than counted as "other". A dependency whose `dist` is
 * missing fails too, rather than passing unscanned. A static scan has a
 * limit: a tag built by interpolation, or one that starts a later line of
 * one string, is counted by the report at runtime but not seen here.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HOST_LOG_TAGS } from '../src/bug-report.js';

const ROOT = join(import.meta.dir, '..');
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
/** The first-party packages the host depends on, from package.json: not a list kept here. */
const PACKAGES = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith('@animalabs/'));
/** A logging call — console.* or a helper named log / warn / error / info / debug — whose first argument is a string
 *  literal that begins with a bracketed tag; the tag's characters are the report's TAG regex's, lowercased as it does. */
const TAG_LITERAL = /\b(?:console\.(?:log|error|warn|info|debug)|log|warn|error|info|debug)\(\s*[`'"]\[([A-Za-z0-9:_./-]{1,40})\][ `'"]/g;
const SOURCE = /\.(?:js|mjs|cjs)$/;

/** Tags a package writes that the report counts as "other" on purpose, each with its reason. */
const OTHER_BY_CHOICE: Record<string, string> = {};

function tagsIn(dir: string, out: Map<string, Set<string>>, pkg: string): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== 'node_modules') tagsIn(path, out, pkg); continue; }
    if (!SOURCE.test(name)) continue;
    for (const m of readFileSync(path, 'utf8').matchAll(TAG_LITERAL)) {
      const tag = m[1]!.toLowerCase();
      if (!out.has(tag)) out.set(tag, new Set());
      out.get(tag)!.add(pkg);
    }
  }
}

const emitted = new Map<string, Set<string>>();
const unscanned: string[] = [];
for (const pkg of PACKAGES) {
  // The package's built code: the directory of its main entry — dist/ for four packages, the package root for
  // chronicle, whose main is index.js beside its native binaries.
  const dir = join(ROOT, 'node_modules', pkg);
  let entry = 'dist';
  try { const main = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { main?: string }).main; if (main) entry = main.includes('/') ? main.split('/')[0]! : '.'; } catch {}
  const built = join(dir, entry);
  if (existsSync(built) && statSync(built).isDirectory()) tagsIn(built, emitted, pkg); else unscanned.push(`${pkg} (${entry})`);
}

describe('the log tags a bug report names, against the tags the packages write', () => {
  test("every @animalabs dependency's dist is there to scan", () => {
    expect(PACKAGES.length).toBeGreaterThan(0);
    expect(unscanned).toEqual([]);
  });

  test('the scan reads the packages: it finds tags the report has always named', () => {
    for (const tag of ['mcpl', 'membrane:cost', 'framework']) expect(emitted.has(tag)).toBe(true);
    expect(emitted.size).toBeGreaterThan(50);
  });

  test('every tag a package writes is named in HOST_LOG_TAGS, or listed as other by choice', () => {
    const other = [...emitted].filter(([tag]) => !HOST_LOG_TAGS.has(tag) && !Object.hasOwn(OTHER_BY_CHOICE, tag))
      .map(([tag, pkgs]) => `${tag} (${[...pkgs].join(', ')})`).sort();
    expect(other).toEqual([]);
  });

  test('a tag listed as other by choice is still written by a package', () => {
    const stale = Object.keys(OTHER_BY_CHOICE).filter((tag) => !emitted.has(tag));
    expect(stale).toEqual([]);
  });
});
