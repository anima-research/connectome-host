/**
 * The ranges the host declares for the stack's release set (#291).
 *
 * context-manager's range takes only a release with the window APIs
 * agent-framework's presentation index calls. Main published context-manager
 * 0.23.0 without them, so the presentation release is 0.24.0, and a range
 * that admitted 0.23.0 would install a context-manager the host fails to load
 * on. Each @animalabs package agent-framework or context-manager depends on
 * too is declared within their range, so an install takes one copy of each:
 * two membrane copies make the host's `Membrane` a type agent-framework's and
 * context-manager's refuse, and hand context-manager's formatter to a
 * membrane none of the stack's suites run.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContextManager } from '@animalabs/context-manager';

type Manifest = { name: string; version: string; dependencies?: Record<string, string> };

const ROOT = join(import.meta.dir, '..');
const manifest = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf-8')) as Manifest;
const ours = manifest(join(ROOT, 'package.json'));
/** The release the host's tree resolves the package to, as its tests run. */
const installed = (name: string): Manifest => manifest(join(ROOT, 'node_modules', name, 'package.json'));

/** A caret range's floor (`^M.m.p`), the one form the release set declares. */
function floorOf(range: string): string {
  const parts = /^\^(\d+\.\d+\.\d+)$/.exec(range);
  if (!parts) throw new Error(`${range} is not a caret range on a release`);
  return parts[1]!;
}

/** Whether every release the caret range `inner` admits, `outer` admits:
 *  caret ranges nest or are apart, so whether `outer` takes `inner`'s floor. */
const within = (inner: string, outer: string): boolean => Bun.semver.satisfies(floorOf(inner), outer);

describe("the host's dependency ranges (#291's release set)", () => {
  test('the caret reading', () => {
    expect(Bun.semver.satisfies('0.23.0', '^0.24.0')).toBe(false);
    expect(Bun.semver.satisfies('0.24.3', '^0.24.0')).toBe(true);
    expect(within('^0.8.2', '^0.8.0')).toBe(true);
    expect(within('^0.7.2', '^0.8.0')).toBe(false);
    expect(within('^0.8.0', '^0.8.2')).toBe(false);
    expect(() => floorOf('>=0.8.0')).toThrow('not a caret range');
  });

  test("takes context-manager only at a release with the window APIs: not main's 0.23.0, which has none", () => {
    const range = ours.dependencies?.['@animalabs/context-manager'];
    expect(range).toBeDefined();
    expect(Bun.semver.satisfies('0.23.0', range!)).toBe(false);
    const linked = installed('@animalabs/context-manager');
    expect(Bun.semver.satisfies(linked.version, range!)).toBe(true);
    const proto = ContextManager.prototype as unknown as Record<string, unknown>;
    for (const method of ['windowStatusOf', 'presentRows', 'retractRows', 'getPresentedMessages']) {
      expect(typeof proto[method], method).toBe('function');
    }
  });

  test('declares each @animalabs package agent-framework and context-manager depend on within their range, so an install takes one copy of each', () => {
    const apart: string[] = [];
    let membrane = 0;
    for (const dependency of ['@animalabs/agent-framework', '@animalabs/context-manager']) {
      for (const [name, theirs] of Object.entries(installed(dependency).dependencies ?? {})) {
        const range = ours.dependencies?.[name];
        if (!name.startsWith('@animalabs/') || range === undefined) continue;
        if (name === '@animalabs/membrane') membrane++;
        if (!within(range, theirs)) apart.push(`${name}: ours ${range}, ${dependency}'s ${theirs}`);
      }
    }
    expect(membrane).toBe(2);
    expect(apart).toEqual([]);
  });

  test('takes the membrane the stack runs on', () => {
    const range = ours.dependencies?.['@animalabs/membrane'];
    expect(range).toBeDefined();
    expect(Bun.semver.satisfies(installed('@animalabs/membrane').version, range!)).toBe(true);
  });
});
