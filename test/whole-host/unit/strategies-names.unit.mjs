import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canariesOf, messageNames, namingCanaries, spanName } from '../lib/strategies/names.mjs';

const canaries = (map) => (id) => map[id] ?? null;

test('a stored message is named by its first canary, or by the nearest earlier message with one and its place after it, or by its place from the store\'s start', () => {
  const nameOf = messageNames([3, 7, 9, 12, 14], canaries({ 7: '[[c:a.in]]', 14: '[[c:a.r1]]' }));
  assert.deepEqual([3, 7, 9, 12, 14, 99].map(nameOf), ['start+1', 'a.in', 'a.in+1', 'a.in+2', 'a.r1', null]);
});

test('a write before a name\'s anchor, or in another store, renames nothing; a write between the anchor and the message does', () => {
  const map = { 7: '[[c:a.in]]', 14: '[[c:a.r1]]' };
  const before = messageNames([7, 9, 12, 14], canaries(map));
  const earlier = messageNames([5, 7, 9, 12, 14], canaries(map));
  assert.deepEqual([9, 12, 14].map(earlier), [9, 12, 14].map(before), 'one more id ahead of the anchor, as a shifted id count would make');
  const between = messageNames([7, 8, 9, 12, 14], canaries(map));
  assert.deepEqual([9, 12].map(between), ['a.in+2', 'a.in+3']);
});

test('canariesOf reads text and tool results in order, not a call\'s input; namingCanaries reads the input too', () => {
  const content = [
    { type: 'text', text: '[[c:a.r1]] and [[c:a.r1b]]' },
    { type: 'tool_use', id: 't1', input: { canary: '[[c:a.call1]]' } },
    { type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: '[[c:a.call1]] seen' }] },
  ];
  assert.deepEqual(canariesOf(content), ['[[c:a.r1]]', '[[c:a.r1b]]', '[[c:a.call1]]']);
  assert.deepEqual(canariesOf(undefined), []);
  assert.deepEqual(namingCanaries(content), ['[[c:a.r1]]', '[[c:a.r1b]]', '[[c:a.call1]]', '[[c:a.call1]]'], 'names read a call\'s input too, in content order');
  assert.deepEqual(namingCanaries([{ type: 'tool_use', id: 't2', name: 'deliver_summary', input: { text: '[[c:h1.read]] words' } }]), ['[[c:h1.read]]'], 'so a message that is only a call has its call\'s canary');
});

test('spanName names one message alone and a range by its ends', () => {
  assert.equal(spanName('L1', 'a.in', 'a.in'), 'L1(a.in)');
  assert.equal(spanName('pin', 'a.in', 'a.r1+2'), 'pin(a.in-a.r1+2)');
});

test('a canary a later message carries again names it by its occurrence, so two stored messages never share a name', () => {
  const nameOf = messageNames([1, 2, 3, 4, 5], canaries({ 1: '[[c:a.in]]', 3: '[[c:a.in]]', 5: '[[c:b.in]]' }));
  assert.deepEqual([1, 2, 3, 4, 5].map(nameOf), ['a.in', 'a.in+1', 'a.in:2', 'a.in:2+1', 'b.in']);
});
