import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutError, cutMessage, cutText } from '../lib/strategies/cut.mjs';

test('a cut text is shown as it was, and its whole is kept only where the cut removed something', () => {
  assert.deepEqual(cutText((cut) => `x: ${cut('abc', 5)}`), { shown: 'x: abc' });
  assert.deepEqual(cutText((cut) => `x: ${cut('abcdefgh', 5)}`), { shown: 'x: abcde', full: 'x: abcdefgh' });
});

test('a cut list shows its first names, and its whole is every name with no mark that names were left out', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const write = (cut, whole) => `${names.length} missing: ${cut(names, 5, ' ')}${!whole && names.length > 5 ? ' …' : ''}`;
  assert.deepEqual(cutText(write), { shown: '7 missing: a b c d e …', full: '7 missing: a b c d e f g' });
  assert.deepEqual(cutText((cut) => cut(['a', 'b'], 5)), { shown: 'a, b' });
});

test('an error\'s message is cut to its bound, with the whole message kept beside it', () => {
  const long = new Error(`${'x'.repeat(250)}END`);
  const { shown, full } = cutError(long, 200);
  assert.equal(shown.length, 200);
  assert.ok(full.endsWith('END'));
  assert.deepEqual(cutError(new Error('short'), 200), { shown: 'short' });
});

test('a flag\'s message is the shown text, with the whole as full only where they differ', () => {
  assert.deepEqual(cutMessage((cut) => cut('abcdef', 3)), { message: 'abc', full: 'abcdef' });
  assert.deepEqual(cutMessage((cut) => cut('ab', 3)), { message: 'ab' });
});
