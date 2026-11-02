import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const localImports = (file, seen = new Set()) => {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const [, spec] of readFileSync(file, 'utf-8').matchAll(/^import [^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) localImports(resolve(dirname(file), spec), seen);
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
