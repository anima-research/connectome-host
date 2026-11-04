import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const localImports = (file, seen = new Set()) => {
  if (seen.has(file)) return seen;
  seen.add(file);
  const source = readFileSync(file, 'utf-8');
  const specs = [
    ...source.matchAll(/^(?:import|export)\b[^'";]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/gm),
    ...source.matchAll(/^import\s*['"](\.{1,2}\/[^'"]+)['"]/gm),
    ...source.matchAll(/\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g),
  ].map(([, spec]) => spec);
  for (const spec of specs) localImports(resolve(dirname(file), spec), seen);
  return seen;
};

const pullRequestPaths = (yaml) => {
  const lines = yaml.split('\n');
  const on = lines.indexOf('on:');
  const pr = lines.indexOf('  pull_request:', on);
  const at = lines.indexOf('    paths:', pr);
  assert.ok(on >= 0 && pr > on && at > pr, 'the workflow has on.pull_request.paths');
  const paths = [];
  for (const line of lines.slice(at + 1)) {
    const m = /^      - (\S+)$/.exec(line);
    if (!m) break;
    paths.push(m[1]);
  }
  return paths;
};

test('pullRequestPaths reads the paths under on.pull_request.paths and nothing else', () => {
  const yaml = ['name: x', 'on:', '  pull_request:', '    paths:', '      - a.mjs', '      - b.mjs', 'jobs:', '  y:', '    steps:', '      - test/whole-host/c.mjs', ''].join('\n');
  assert.deepEqual(pullRequestPaths(yaml), ['a.mjs', 'b.mjs']);
});

test('the self-check runs on a change to any file the test module loads, which the host loads into itself', () => {
  const loaded = [...localImports(join(ROOT, 'test/whole-host/lib/strategies/module.mjs'))].map((f) => relative(ROOT, f)).sort();
  const workflow = readFileSync(join(ROOT, '.github/workflows/whole-host-self-check.yml'), 'utf-8');
  const paths = pullRequestPaths(workflow);
  assert.ok(paths.includes('.github/workflows/whole-host-self-check.yml'), 'the block read is the one that schedules the check');
  assert.ok(loaded.length > 1, 'the module\'s imports were followed');
  assert.deepEqual(loaded.filter((f) => !paths.includes(f)), [], 'each loaded file is a path that schedules the check');
});

test('the self-check also runs on a change to what chooses the stack the module runs beside, and to what sets up, drives and compares its two arms', () => {
  const paths = pullRequestPaths(readFileSync(join(ROOT, '.github/workflows/whole-host-self-check.yml'), 'utf-8'));
  for (const p of ['package.json', 'package-lock.json', 'bun.lock', 'test/whole-host/run.mjs', 'test/whole-host/lib/strategies/driver.mjs', 'test/whole-host/lib/common.mjs']) assert.ok(paths.includes(p), `${p} schedules the self-check`);
});

test('the files the test module loads are followed through re-exports, dynamic imports and imports over several lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imports-'));
  try {
    const files = {
      'a.mjs': "import {\n  one,\n  two,\n} from './b.mjs';\nexport { three } from './c.mjs';\nexport * from './d.mjs';\nconst late = await import('./e.mjs');\nimport './f.mjs';\n",
      'b.mjs': "export const notAnImport = './g.mjs';\n", 'c.mjs': '', 'd.mjs': '', 'e.mjs': '', 'f.mjs': "import { x } from 'node:fs';\n",
    };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    assert.deepEqual([...localImports(join(dir, 'a.mjs'))].map((f) => relative(dir, f)).sort(), ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs', 'e.mjs', 'f.mjs']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
