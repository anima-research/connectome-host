import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blobStore, compiledLine, storeDelta } from '../lib/strategies/recorder.mjs';
const manager = (messages) => ({
  getAllMessages: () => messages,
  getSummariesInRange: () => [],
  getSummary: () => null,
  getStrategy: () => ({}),
});
const text = (t) => ({ type: 'text', text: t });
const thinking = { type: 'thinking', thinking: 'why', signature: 'sig' };

test('storeDelta: a stored message holding thinking is added with the bit; one without, as before; a bit that changes is sent again', () => {
  const blobs = blobStore();
  const plainReply = { id: 1, content: [text('[[c:a.r1]] hello')] };
  const thought = { id: 2, content: [thinking, text('[[c:a.r2]] then')] };
  const first = storeDelta(manager([plainReply, thought]), undefined, blobs);
  assert.deepEqual(first.out.messages, [['1', ['[[c:a.r1]]']], ['2', ['[[c:a.r2]]'], { thinking: true }]]);
  const again = storeDelta(manager([plainReply, thought]), first.seen, blobs);
  assert.equal(again.out.messages, undefined, 'nothing new and no bit changed');
  const stripped = storeDelta(manager([plainReply, { ...thought, content: [text('[[c:a.r2]] then')] }]), first.seen, blobs);
  assert.deepEqual(stripped.out.messages, [['2', ['[[c:a.r2]]'], { thinking: false }]], 'thinking gone from the stored copy');
  const redacted = storeDelta(manager([{ ...plainReply, content: [{ type: 'redacted_thinking', data: 'x' }, text('[[c:a.r1]] hello')] }]), first.seen, blobs);
  assert.deepEqual(redacted.out.messages, [['1', ['[[c:a.r1]]'], { thinking: true }]], 'redacted thinking counts');
});

test('storeDelta: context-manager\'s quarantines, compression spans and merges, are reported when they move', () => {
  const blobs = blobStore();
  let status = { count: 0, keys: [], spans: [] };
  let merges = 0;
  const strategy = { getCompressionQuarantineStatus: () => status, getMergeQuarantineStatus: () => ({ count: merges, records: [] }) };
  const m = { ...manager([]), getStrategy: () => strategy };
  const first = storeDelta(m, undefined, blobs);
  assert.deepEqual(first.out.quarantine, { compression: 0, merge: 0 });
  assert.equal(storeDelta(m, first.seen, blobs).out.quarantine, undefined, 'unmoved');
  status = { count: 3, keys: ['a', 'b', 'c'], spans: [{}] };
  merges = 1;
  assert.deepEqual(storeDelta(m, first.seen, blobs).out.quarantine, { compression: 1, merge: 1 }, 'spans, each once however many records it holds');
  status = { count: 0, keys: [], spans: [], unreadable: true };
  assert.deepEqual(storeDelta(m, first.seen, blobs).out.quarantine, { compression: null, merge: 1 }, 'a quarantine context-manager couldn\'t read is unknown, not none');
  assert.equal(storeDelta(manager([]), undefined, blobs).out.quarantine, undefined, 'a strategy with no quarantine reports none');
});

test('storeDelta: a strategy that can\'t be read when the quarantine is first sampled is reported unreadable, not as none', () => {
  const failing = { ...manager([]), getStrategy: () => { throw new Error('gone'); } };
  assert.deepEqual(storeDelta(failing, undefined, blobStore()).out.quarantine, { unreadable: 'gone' });
});

test('storeDelta: a summary read that fails keeps the summaries last read, so a later removal is still reported', () => {
  const blobs = blobStore();
  let listed = [{ id: 'S' }];
  let failing = false;
  const m = { ...manager([]), getSummariesInRange: () => { if (failing) throw new Error('gone'); return listed; }, getSummary: (id) => ({ id, level: 1, sourceLevel: 0, sourceIds: [], content: 'c' }) };
  const first = storeDelta(m, undefined, blobs);
  assert.deepEqual(first.out.summaries.map((s) => s.id), ['S']);
  failing = true;
  const unread = storeDelta(m, first.seen, blobs);
  assert.deepEqual(unread.out.summaries, { unreadable: 'gone' });
  failing = false;
  listed = [];
  assert.deepEqual(storeDelta(m, unread.seen, blobs).out.removed, ['S']);
});

test('storeDelta: a stored message whose canaries change is reported again, its thinking bit with it', () => {
  const blobs = blobStore();
  const first = storeDelta(manager([{ id: 9, content: [text('[[c:a.in]] hi')] }]), undefined, blobs);
  assert.deepEqual(first.out.messages, [['9', ['[[c:a.in]]']]]);
  assert.deepEqual(storeDelta(manager([{ id: 9, content: [text('[[c:b.in]] hi')] }]), first.seen, blobs).out.messages, [['9', ['[[c:b.in]]']]]);
  const thought = storeDelta(manager([{ id: 9, content: [thinking, text('[[c:a.in]] hi')] }]), undefined, blobs);
  assert.deepEqual(storeDelta(manager([{ id: 9, content: [thinking, text('[[c:c.in]] hi')] }]), thought.seen, blobs).out.messages, [['9', ['[[c:c.in]]'], { thinking: true }]]);
});

test('storeDelta: a stored message gone from the store is reported removed and forgotten, so it can be reported again if it returns', () => {
  const blobs = blobStore();
  const a = { id: 1, content: [text('[[c:a.in]] one')] }, b = { id: 2, content: [text('[[c:b.in]] two')] };
  const first = storeDelta(manager([a, b]), undefined, blobs);
  const undone = storeDelta(manager([a]), first.seen, blobs);
  assert.deepEqual([undone.out.messages, undone.out.removedMessages], [undefined, ['2']]);
  assert.equal(storeDelta(manager([a]), undone.seen, blobs).out.removedMessages, undefined, 'reported once');
  assert.deepEqual(storeDelta(manager([a, b]), undone.seen, blobs).out.messages, [['2', ['[[c:b.in]]']]]);
});

test('compiledLine: a compile whose strategy gives no render stats carries its unjudged budget on the line; one with its own stats carries them and nothing unjudged', () => {
  class PassthroughStrategy { config = {}; }
  class AutobiographicalStrategy { config = {}; getRenderStats() { return { total: { tokens: 99_999 } }; } }
  const stored = [{ id: '1', sequence: 1, role: 'user', content: [text('one')] }];
  const line = (strategy, renderStats) => compiledLine(
    { ...manager(stored), getStrategy: () => strategy, listPins: () => [], getRenderStats: () => strategy.getRenderStats?.() ?? null },
    { maxTokens: 1_000, reserveForResponse: 0 },
    { messages: [{ role: 'user', content: [text('one')] }], provenance: { messages: [{ kind: 'raw', bodies: [{ messageId: '1', complete: true }] }], layout: { memberIds: ['1'], units: [{ k: 'r', t: 1 }] } }, ...(renderStats ? { renderStats } : {}) },
    blobStore(),
  );
  const passthrough = line(new PassthroughStrategy());
  assert.deepEqual([passthrough.unjudged, passthrough.stats, passthrough.violations], [['budget: PassthroughStrategy gives no render stats'], null, []]);
  const own = line(new AutobiographicalStrategy(), { total: { tokens: 10 } });
  assert.deepEqual([own.unjudged, own.stats, own.violations], [undefined, { total: { tokens: 10 } }, []]);
});
