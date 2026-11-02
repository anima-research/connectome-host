import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maskRunVarying, runVaryingMasker, sameBodies } from '../lib/strategies/compare.mjs';

const sameAcrossRuns = (a, b) => JSON.stringify(maskRunVarying(a)) === JSON.stringify(maskRunVarying(b));

const body = ({ nonce = '2ie66y', seq = 1, signature = 'fx1.AAAA', text = 'hello [[c:c.chat.in]]', model = 'claude-opus-4-6' } = {}) => ({
  model,
  max_tokens: 2048,
  messages: [
    { role: 'user', content: [{ type: 'text', text }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'about it', signature }, { type: 'tool_use', id: 'toolu_fx000001', name: 'mcpl--fixture--result', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fx000001', content: [{ type: 'text', text: `[image: image/png, ~9KB, ref img_${nonce}_${seq}]\n[[c:c.tool.call2]]` }] }] },
  ],
});

test('N12: two runs\' bodies that differ only in the image ledger\'s nonce and thinking signatures compare equal', { timeout: 30_000 }, () => {
  const a = body();
  const b = body({ nonce: 'nai651', signature: 'fx1.BBBB' });
  assert.notDeepEqual(a, b);
  assert.equal(sameAcrossRuns(a, b), true);
  assert.deepEqual(maskRunVarying(a), maskRunVarying(b));
  const record = (signature) => ({ kind: 'agent', messages: [{ role: 'assistant', blocks: [{ type: 'thinking', chars: 8, signature }] }] });
  assert.equal(sameAcrossRuns(record('fx1.AAAA'), record('fx1.CCCC')), true);
  assert.equal(a.messages[1].content[0].signature, 'fx1.AAAA');
  assert.match(a.messages[2].content[0].content[0].text, /img_2ie66y_1/);
});

test('N12: two runs\' bodies that differ only in a fork call\'s random UUID compare equal, and the fork\'s name still counts', () => {
  const fork = (name, uuid) => ({ role: 'assistant', content: [{ type: 'tool_use', id: `fork-${name}-${uuid}`, name: 'subagent--fork', input: { name } }] });
  assert.equal(sameAcrossRuns(fork('fork-321741', 'd5641659-0a1b-4c2d-8e3f-123456789abc'), fork('fork-321741', '7271e5fa-9f8e-4d7c-b6a5-cba987654321')), true);
  assert.equal(sameAcrossRuns(fork('fork-321741', 'd5641659-0a1b-4c2d-8e3f-123456789abc'), fork('fork-321742', 'd5641659-0a1b-4c2d-8e3f-123456789abc')), false);
  const result = (uuid) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `fork-w9-${uuid}`, content: 'forked' }] });
  assert.equal(sameAcrossRuns(result('d5641659-0a1b-4c2d-8e3f-123456789abc'), result('7271e5fa-9f8e-4d7c-b6a5-cba987654321')), true, 'its result names it the same way');
});

test('N12: any other difference compares unequal, the ref\'s sequence number and the order of keys included', { timeout: 30_000 }, () => {
  const a = body();
  for (const [what, b] of [
    ['the ref\'s sequence number', body({ seq: 2 })],
    ['a character of a message', body({ text: 'hellp [[c:c.chat.in]]' })],
    ['the model', body({ model: 'claude-opus-4-5' })],
  ]) assert.equal(sameAcrossRuns(a, b), false, what);
  const signed = (signature) => { const x = body(); x.messages[1].content[1].signature = signature; return x; };
  assert.equal(sameAcrossRuns(signed('fx1.YYYY'), signed('fx1.ZZZZ')), false, 'a signature on a block that isn\'t thinking');
  const { model, ...rest } = a;
  assert.equal(sameAcrossRuns(a, { ...rest, model }), false, 'the order of keys');
});

test('a fork\'s UUID is named by its first appearance in what one masker reads, so a call and a result that disagree still differ', () => {
  const pair = (callUuid, resultUuid) => [
    { role: 'assistant', content: [{ type: 'tool_use', id: `fork-w9-${callUuid}`, name: 'subagent--fork', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `fork-w9-${resultUuid}`, content: 'forked' }] },
  ];
  const a = 'd5641659-0a1b-4c2d-8e3f-123456789abc';
  const b = '7271e5fa-9f8e-4d7c-b6a5-cba987654321';
  const masked = (messages) => { const mask = runVaryingMasker(); return JSON.stringify(messages.map(mask)); };
  assert.equal(masked(pair(a, a)), masked(pair(b, b)), 'the same pairing under another run\'s UUID');
  assert.notEqual(masked(pair(a, a)), masked(pair(a, b)), 'a result naming another fork than its call');
});

test('the self-check compares two arms\' request bodies in order, and names the pair where they first differ', () => {
  const arm = (bodies) => { const d = mkdtempSync(join(tmpdir(), 'arm-')); bodies.forEach((b, i) => writeFileSync(join(d, `r${i + 1}.json`), JSON.stringify(b))); writeFileSync(join(d, 'r1.answer.json'), '[]'); return d; };
  const on = arm([body(), body({ text: 'two [[c:c.chat.in]]' })]);
  const same = arm([body({ nonce: 'nai651' }), body({ text: 'two [[c:c.chat.in]]', nonce: 'q0q0q0' })]);
  const off = arm([body(), body({ text: 'twO [[c:c.chat.in]]' })]);
  try {
    assert.deepEqual(sameBodies(on, same), { outcome: 'same', requests: 2 }, 'answers aren\'t compared, and what differs by design is masked');
    const differs = sameBodies(on, off);
    assert.equal(differs.outcome, 'differs');
    assert.equal(differs.at, 1);
    assert.deepEqual(differs.files, ['r2.json', 'r2.json'], 'the pair a failing job keeps');
  } finally { for (const d of [on, same, off]) rmSync(d, { recursive: true, force: true }); }
});

test('image nonces are named by their first appearance in what one masker reads, so refs to two ledgers differ from refs to one', () => {
  const refs = (...nonces) => ({ role: 'user', content: nonces.map((n) => ({ type: 'text', text: `[ref img_${n}_1]` })) });
  assert.equal(sameAcrossRuns(refs('aaaaaa', 'bbbbbb'), refs('cccccc', 'dddddd')), true, 'two ledgers under other nonces');
  assert.equal(sameAcrossRuns(refs('aaaaaa', 'bbbbbb'), refs('cccccc', 'cccccc')), false, 'two ledgers against one');
  assert.match(JSON.stringify(maskRunVarying(refs('aaaaaa', 'bbbbbb', 'aaaaaa'))), /img_N1_1.*img_N2_1.*img_N1_1/);
});

test('the self-check counts an extra, a missing and an empty arm\'s bodies as differing, naming where', () => {
  const arm = (bodies) => { const d = mkdtempSync(join(tmpdir(), 'arm-')); bodies.forEach((b, i) => writeFileSync(join(d, `r${i + 1}.json`), JSON.stringify(b))); return d; };
  const two = arm([body(), body({ text: 'two [[c:c.chat.in]]' })]);
  const three = arm([body(), body({ text: 'two [[c:c.chat.in]]' }), body({ text: 'three [[c:c.chat.in]]' })]);
  const none = arm([]);
  try {
    const extra = sameBodies(three, two);
    assert.deepEqual([extra.outcome, extra.at, extra.files[0]], ['differs', 2, 'r3.json'], 'recording on sent one more');
    assert.match(extra.detail, /3 requests with recording on, 2 with it off/);
    const missing = sameBodies(two, three);
    assert.deepEqual([missing.outcome, missing.at], ['differs', 2], 'recording off sent one more');
    assert.match(sameBodies(none, two).detail, /no request bodies were saved/);
    assert.deepEqual([sameBodies(two, none).outcome, sameBodies(two, none).at], ['differs', 0], 'an arm with none differs at its first');
  } finally { for (const d of [two, three, none]) rmSync(d, { recursive: true, force: true }); }
});

test('the mask keeps a key named __proto__ as the body has it, so a change to it still shows', () => {
  const a = maskRunVarying(JSON.parse('{"tools":[{"input_schema":{"properties":{"__proto__":{"type":"string"}}}}]}'));
  const b = maskRunVarying(JSON.parse('{"tools":[{"input_schema":{"properties":{"__proto__":{"type":"number"}}}}]}'));
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
  assert.match(JSON.stringify(a), /"__proto__":\{"type":"string"\}/);
});
