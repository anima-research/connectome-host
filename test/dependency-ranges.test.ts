/**
 * The ranges the host declares for the stack's release set (#291).
 *
 * agent-framework's range takes only the presentation release: main published
 * 0.30.0 (Dendrite) without the presentation index and the exports the host
 * imports from it. context-manager's range takes only a release with the
 * window APIs agent-framework's presentation index calls. Main published
 * context-manager 0.23.0, then 0.24.0 (Dendrite's derive), without them, so
 * the presentation release is 0.25.0, and a range that admitted 0.24.0 would
 * install a context-manager the host fails to load on. chronicle's range takes
 * only a release with the identity-stamped batched append context-manager
 * writes a window with: the published 0.5.0 (Dendrite's branch views) has none
 * of the batched calls, so the presentation release is 0.6.0, and
 * agent-framework's create() refuses a store from 0.5.0. Each @animalabs
 * package agent-framework or context-manager depends on too is declared
 * within their range, so an install takes one copy of each: two membrane
 * copies make the host's `Membrane` a type agent-framework's and
 * context-manager's refuse, and hand context-manager's formatter to a
 * membrane none of the stack's suites run; two chronicle copies give
 * context-manager a store handle from a chronicle it doesn't load.
 *
 * Whether a range admits the installed version is asked only of a package
 * installed from the registry. A sibling tree linked into node_modules (a
 * presentation branch built beside this one) keeps its main's version number
 * until its release is cut, so it is checked by the calls it has instead.
 */
import { describe, test, expect } from 'bun:test';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';

type Manifest = { name: string; version: string; dependencies?: Record<string, string> };

const ROOT = join(import.meta.dir, '..');
const manifest = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf-8')) as Manifest;
const ours = manifest(join(ROOT, 'package.json'));
/** The release the host's tree resolves the package to, as its tests run. */
const installed = (name: string): Manifest => manifest(join(ROOT, 'node_modules', name, 'package.json'));
/** Whether `name` is a sibling tree linked into node_modules, which keeps its main's version until its release is cut. */
const linked = (name: string): boolean => lstatSync(join(ROOT, 'node_modules', name)).isSymbolicLink();
/** That `range` admits the installed `name`, asked only of a package installed from the registry (not `linked`). */
function admitsInstalled(name: string, range: string): void {
  if (linked(name)) return;
  const version = installed(name).version;
  expect(Bun.semver.satisfies(version, range), `${range} admits the ${name} the suite runs on (${version})`).toBe(true);
}

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
    expect(Bun.semver.satisfies('0.24.0', '^0.25.0')).toBe(false);
    expect(Bun.semver.satisfies('0.25.3', '^0.25.0')).toBe(true);
    expect(within('^0.8.2', '^0.8.0')).toBe(true);
    expect(within('^0.7.2', '^0.8.0')).toBe(false);
    expect(within('^0.8.0', '^0.8.2')).toBe(false);
    expect(() => floorOf('>=0.8.0')).toThrow('not a caret range');
  });

  test("takes agent-framework only at the presentation release: not main's 0.30.0, which has no presentation index", () => {
    const range = ours.dependencies?.['@animalabs/agent-framework'];
    expect(range).toBe('^0.31.0');
    for (const published of ['0.29.0', '0.30.0']) expect(Bun.semver.satisfies(published, range!)).toBe(false);
    admitsInstalled('@animalabs/agent-framework', range!);
  });

  test("takes context-manager only at a release with the window APIs: not main's 0.23.0 or 0.24.0, which have none", () => {
    const range = ours.dependencies?.['@animalabs/context-manager'];
    expect(range).toBe('^0.25.0');
    for (const published of ['0.23.0', '0.24.0']) expect(Bun.semver.satisfies(published, range!)).toBe(false);
    const proto = ContextManager.prototype as unknown as Record<string, unknown>;
    for (const method of ['windowStatusOf', 'presentRows', 'retractRows', 'getPresentedMessages']) {
      expect(typeof proto[method], method).toBe('function');
    }
    admitsInstalled('@animalabs/context-manager', range!);
  });

  test('takes chronicle only at a release with the batched append: not 0.4.0, or the published 0.5.0, which has none', () => {
    const range = ours.dependencies?.['@animalabs/chronicle'];
    expect(range).toBe('^0.6.0');
    for (const published of ['0.4.0', '0.5.0']) expect(Bun.semver.satisfies(published, range!)).toBe(false);
    const proto = JsStore.prototype as unknown as Record<string, unknown>;
    for (const method of ['appendManyToStateJsonWithIdentity', 'appendManyToStateJson', 'getStateItemsJson', 'getRecords']) {
      expect(typeof proto[method], method).toBe('function');
    }
    admitsInstalled('@animalabs/chronicle', range!);
  });

  test('declares each @animalabs package agent-framework and context-manager depend on within their range, so an install takes one copy of each', () => {
    const apart: string[] = [];
    const shared = { '@animalabs/membrane': 0, '@animalabs/chronicle': 0 } as Record<string, number>;
    for (const dependency of ['@animalabs/agent-framework', '@animalabs/context-manager']) {
      for (const [name, theirs] of Object.entries(installed(dependency).dependencies ?? {})) {
        const range = ours.dependencies?.[name];
        if (!name.startsWith('@animalabs/') || range === undefined) continue;
        if (Object.hasOwn(shared, name)) shared[name]!++;
        if (!within(range, theirs)) apart.push(`${name}: ours ${range}, ${dependency}'s ${theirs}`);
      }
    }
    expect(shared).toEqual({ '@animalabs/membrane': 2, '@animalabs/chronicle': 2 });
    expect(apart).toEqual([]);
  });

  test('takes the membrane the stack runs on', () => {
    const range = ours.dependencies?.['@animalabs/membrane'];
    expect(range).toBe('^0.8.0');
    admitsInstalled('@animalabs/membrane', range!);
  });
});
