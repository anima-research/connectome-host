import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shares } from '../lib/shares.mjs';

test('shares balance runs by their seconds, paying for a checkpoint once a share, and cover every run once', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const table = { runs: { a: 100, b: 10, c: 60, d: 50, e: 10 }, checkpoints: { k: 40 } };
  const key = (id) => (['c', 'd'].includes(id) ? 'k' : null);
  const out = shares(ids, 2, table, key);
  assert.deepEqual(out.map((x) => x.ids), [['a', 'b', 'e'], ['c', 'd']], 'd joins c, whose checkpoint its share already pays for');
  assert.deepEqual(out.map((x) => x.seconds), [120, 150]);
  assert.deepEqual([...out.flatMap((x) => x.ids)].sort(), ids);
  assert.deepEqual(shares(ids, 2, table, key), out, 'the same inputs give the same shares');
});

test('a run with no recorded seconds counts as the median of those recorded, and one share holds them all', () => {
  const out = shares(['x', 'y', 'z'], 1, { runs: { x: 5, y: 7 } });
  assert.deepEqual(out, [{ seconds: 19, ids: ['x', 'y', 'z'] }]);
});

test('a checkpoint with no recorded seconds counts as the median of the checkpoints recorded', () => {
  assert.deepEqual(shares(['a'], 1, { runs: { a: 10 }, checkpoints: { k: 40, m: 20 } }, () => 'q'), [{ seconds: 50, ids: ['a'] }]);
});
