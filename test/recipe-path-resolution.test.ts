/**
 * Tests for parent-recipe-dir-relative resolution of
 * `modules.fleet.children[].recipe`.
 *
 * Runtime paths (workspace mounts, dataDir) stay CWD-relative — those are
 * intentionally NOT touched by this resolver and are covered elsewhere.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRecipe, resolveRecipeRelative, type Recipe } from '../src/recipe.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '..');

function writeParent(dir: string, children: Array<Record<string, unknown>>): string {
  const path = join(dir, 'parent.json');
  const recipe = {
    name: 'Parent',
    agent: { systemPrompt: 'x' },
    modules: { fleet: { children } },
  };
  writeFileSync(path, JSON.stringify(recipe), 'utf-8');
  return path;
}

function fleetChildren(recipe: Recipe) {
  const fleet = recipe.modules?.fleet;
  if (!fleet || typeof fleet !== 'object' || !fleet.children) {
    throw new Error('recipe has no fleet.children');
  }
  return fleet.children;
}

describe('resolveRecipeRelative', () => {
  test('absolute path passes through unchanged', () => {
    expect(resolveRecipeRelative('/abs/miner.json', { kind: 'file', dir: '/anywhere' }))
      .toBe('/abs/miner.json');
  });

  test('http URL passes through unchanged', () => {
    expect(resolveRecipeRelative('https://ex.com/a.json', { kind: 'file', dir: '/anywhere' }))
      .toBe('https://ex.com/a.json');
    expect(resolveRecipeRelative('http://ex.com/a.json', { kind: 'url', base: 'https://other.com/' }))
      .toBe('http://ex.com/a.json');
  });

  test('bare filename resolves against parent dir', () => {
    expect(resolveRecipeRelative('child.json', { kind: 'file', dir: '/opt/recipes' }))
      .toBe('/opt/recipes/child.json');
  });

  test('dotted prefix resolves against parent dir', () => {
    expect(resolveRecipeRelative('./child.json', { kind: 'file', dir: '/opt/recipes' }))
      .toBe('/opt/recipes/child.json');
    expect(resolveRecipeRelative('../other/child.json', { kind: 'file', dir: '/opt/recipes' }))
      .toBe('/opt/other/child.json');
  });

  test('URL base resolves relative child to sibling URL', () => {
    expect(resolveRecipeRelative('child.json', { kind: 'url', base: 'https://ex.com/dir/parent.json' }))
      .toBe('https://ex.com/dir/child.json');
  });
});

describe('loadRecipe — children[].recipe resolution', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'conhost-recipe-resolve-'));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  test('external bundle: bare filename resolves to sibling of parent', async () => {
    const parentPath = writeParent(tmpDir, [
      { name: 'kid', recipe: 'child.json', autoStart: true },
    ]);
    writeFileSync(join(tmpDir, 'child.json'), JSON.stringify({
      name: 'Child', agent: { systemPrompt: 'y' },
    }), 'utf-8');

    const recipe = await loadRecipe(parentPath);
    const [child] = fleetChildren(recipe);
    expect(child.recipe).toBe(resolve(tmpDir, 'child.json'));
  });

  test('CWD-independence: same parent, different CWDs, same resolution', async () => {
    const parentPath = writeParent(tmpDir, [
      { name: 'kid', recipe: './child.json', autoStart: true },
    ]);
    const expected = resolve(tmpDir, 'child.json');

    const originalCwd = process.cwd();
    try {
      process.chdir('/tmp');
      const a = await loadRecipe(parentPath);
      process.chdir(tmpDir);
      const b = await loadRecipe(parentPath);
      process.chdir(REPO_ROOT);
      const c = await loadRecipe(parentPath);

      expect(fleetChildren(a)[0].recipe).toBe(expected);
      expect(fleetChildren(b)[0].recipe).toBe(expected);
      expect(fleetChildren(c)[0].recipe).toBe(expected);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test('absolute child path passes through', async () => {
    const absChild = join(tmpDir, 'elsewhere.json');
    const parentPath = writeParent(tmpDir, [
      { name: 'kid', recipe: absChild, autoStart: true },
    ]);

    const recipe = await loadRecipe(parentPath);
    expect(fleetChildren(recipe)[0].recipe).toBe(absChild);
  });

  test('URL child path passes through', async () => {
    const parentPath = writeParent(tmpDir, [
      { name: 'kid', recipe: 'https://example.com/child.json', autoStart: true },
    ]);

    const recipe = await loadRecipe(parentPath);
    expect(fleetChildren(recipe)[0].recipe).toBe('https://example.com/child.json');
  });

  test('nested parent dir: child resolves relative to the parent file, not CWD', async () => {
    const nested = join(tmpDir, 'bundle');
    mkdirSync(nested, { recursive: true });
    const parentPath = writeParent(nested, [
      { name: 'kid', recipe: 'child.json', autoStart: true },
    ]);

    const originalCwd = process.cwd();
    try {
      process.chdir(tmpDir); // NOT the bundle dir
      const recipe = await loadRecipe(parentPath);
      expect(fleetChildren(recipe)[0].recipe).toBe(resolve(nested, 'child.json'));
    } finally {
      process.chdir(originalCwd);
    }
  });

  test('in-tree triumvirate: children resolve to siblings in recipes/', async () => {
    const triumviratePath = join(REPO_ROOT, 'recipes', 'triumvirate.json');
    const recipe = await loadRecipe(triumviratePath);
    const children = fleetChildren(recipe);
    const byName = Object.fromEntries(children.map((c) => [c.name, c.recipe]));
    expect(byName.miner).toBe(join(REPO_ROOT, 'recipes', 'knowledge-miner.json'));
    expect(byName.reviewer).toBe(join(REPO_ROOT, 'recipes', 'knowledge-reviewer.json'));
    expect(byName.clerk).toBe(join(REPO_ROOT, 'recipes', 'clerk.json'));
  });
});
