import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedRequests, movedIn, STEP_SUMMARY_BYTES, stepSummary, summaryTable, viewOf } from '../lib/view.mjs';

const lines = (...xs) => xs.map(([text, request = null]) => ({ text, request }));
const text = (...xs) => `${xs.join('\n')}\n`;
const counts = ({ requests, added, removed, unattributed }) => ({ requests, added, removed, unattributed });

test('the requests a change moved are those whose lines differ from the committed record, in the run\'s order', () => {
  const committed = text('# h', 'step a', '  compile p.1, body 11111111', '  call - -> summary, body 22222222', 'step b', '  compile -1 + p.2, body 33333333', 'end ok');
  const same = lines(['# h'], ['step a'], ['  compile p.1, body 11111111', 'r1'], ['  call - -> summary, body 22222222', 's1'], ['step b'], ['  compile -1 + p.2, body 33333333', 'r2'], ['end ok']);
  assert.deepEqual(counts(changedRequests(committed, same)), { requests: [], added: 0, removed: 0, unattributed: 0 });
  const moved = lines(['# h'], ['step a'], ['  compile p.1, body 11111111', 'r1'], ['  call - -> summary, body 2222aaaa', 's1'], ['step b'], ['  compile -1 + p.2, body 3333bbbb', 'r2'], ['end ok']);
  assert.deepEqual(counts(changedRequests(committed, moved)), { requests: ['s1', 'r2'], added: 2, removed: 2, unattributed: 0 });
});

test('a line no request owns counts apart, and a request that only went away names nothing on the run\'s side', () => {
  const committed = text('step a', '  compile p.1, body 11111111', '  wrote L1(p.1) [T:summary-l1-aaaa]', '  compile p.1 L1(p.1), body 44444444', 'end ok');
  const run = lines(['step a'], ['  compile p.1, body 11111111', 'r1'], ['  wrote L1(p.1) [T:summary-l1-bbbb]'], ['end ok']);
  assert.deepEqual(counts(changedRequests(committed, run)), { requests: [], added: 1, removed: 2, unattributed: 1 });
});

test('a request with several changed lines is named once, and an inserted line leaves the lines around it unchanged', () => {
  const committed = text('step a', '  compile p.1, body 11111111', '  compile p.2, body 22222222');
  const run = lines(['step a'], ['  compile p.1, body 11111111', 'r1'], ['  round + p.1.call1, body 55555555', 'r9'], ['  round + p.1.call2, body 66666666', 'r9'], ['  compile p.2, body 22222222', 'r2']);
  assert.deepEqual(counts(changedRequests(committed, run)), { requests: ['r9'], added: 2, removed: 0, unattributed: 0 });
});

test('the summary has a row per run, naming what changed, with a count it wasn\'t given shown as unknown', () => {
  const table = summaryTable([
    { run: 'H1/W1', record: 'same', ledgerOf: 'fixture', counts: { compiles: 70, refused: 0, compressions: 12, merges: 3, quarantines: 0, raw: 20, summarised: 40, out: 10, invariantLines: 0 }, tokens: { input: 23456, cacheRead: 100000, cacheWrite: 0, output: 900 } },
    { run: 'H3/W4', record: 'differs', changed: { requests: ['r3', 'r4'], added: 3, removed: 2 }, counts: {} },
  ]).split('\n');
  assert.equal(table.length, 4);
  assert.equal(table[0], '| run | record | request compiles | refused | compressions | merges | quarantines | ledger of | raw | summarised | left out | tokens sent | invariant lines |');
  assert.equal(table[1], '|---|---|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|', 'counts align right, the agent\'s name left');
  assert.equal(table[2], '| H1/W1 | same | 70 | 0 | 12 | 3 | 0 | fixture | 20 | 40 | 10 | 123456 | 0 |');
  assert.equal(table[3], '| H3/W4 | differs: 2 request(s), +3 -2 line(s) | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? | ? |');
});

test('a run\'s view shows each changed request\'s record line, its ledger and its transcript, sharing what the transcripts have shown', () => {
  const calls = [];
  const view = viewOf({
    run: 'H3/W4', record: 'differs',
    changed: { requests: ['r3', 'r4'], was: new Map(), stopped: [], added: 2, removed: 2, unattributed: 0 },
    lines: lines(['step a'], ['  compile p.3, body 33333333', 'r3'], ['  round + p.3.call1, body 44444444', 'r4']),
    ledger: (id) => (id === 'r3' ? ['raw: p.1-p.3'] : []),
    transcript: (id, seen) => { calls.push([id, seen.size]); seen.add(id); return [`transcript of ${id}`]; },
  });
  assert.match(view, /^## H3\/W4\n\n2 request\(s\) changed and 0 no longer sent: 2 record line\(s\) added and 2 removed\.\n/);
  assert.match(view, /### r3: `compile p\.3, body 33333333`\n\nA request the committed record doesn't have\.\n\nraw: p\.1-p\.3\n\n```text\ntranscript of r3\n```/);
  assert.match(view, /### r4: `round \+ p\.3\.call1, body 44444444`\n\nA request the committed record doesn't have\.\n\n```text\ntranscript of r4\n```/);
  assert.deepEqual(calls, [['r3', 0], ['r4', 1]], 'the second transcript knows what the first showed');
});

test('the step summary keeps within its bytes, showing views in order while they fit and naming each that didn\'t', () => {
  const view = (run, n) => ({ run, path: `${run}/view.md`, text: `${run}:${'x'.repeat(n)}\n` });
  const all = stepSummary({ table: 'T', views: [view('a', 10), view('b', 10)], budget: 1000 });
  assert.equal(all, 'T\n\na:xxxxxxxxxx\nb:xxxxxxxxxx\n');
  const some = stepSummary({ table: 'T', views: [view('a', 10), view('b', 2000), view('c', 10)], budget: 1000 });
  assert.ok(Buffer.byteLength(some) <= 1000);
  assert.match(some, /^T\n\na:x{10}\nc:x{10}\nThe view of b \(2003 bytes\) didn't fit within this summary's 1000 bytes: it's b\/view\.md in the job's evidence\.\n$/);
  const none = stepSummary({ table: 'T', views: [view('a', 1000)], budget: 1000 });
  assert.equal(none, 'T\n\nThe view of a (1003 bytes) didn\'t fit within this summary\'s 1000 bytes: it\'s a/view.md in the job\'s evidence.\n', 'a view larger than the whole budget is only named');
});

test('a changed request\'s heading keeps its record line short, since the line itself is in the record diff', () => {
  const long = `  round + ${Array.from({ length: 60 }, (_, i) => `p.${i}.in`).join(' ')}, body 44444444`;
  const view = viewOf({ run: 'R', record: 'differs', changed: { requests: ['r1'], added: 1, removed: 1, unattributed: 0 }, lines: lines([long, 'r1']), ledger: () => [], transcript: () => [] });
  const heading = view.split('\n').find((l) => l.startsWith('### r1: '));
  assert.equal(heading, `### r1: \`${long.trim().slice(0, 199)}…\``);
});

test('the step summary counts bytes, not characters, against GitHub\'s 1 MiB for a step', () => {
  assert.equal(STEP_SUMMARY_BYTES, 1_048_576);
  const wide = { run: 'a', path: 'a/view.md', text: `a:${'é'.repeat(600)}\n` };
  const out = stepSummary({ table: 'T', views: [wide], budget: 1000 });
  assert.equal(out, "T\n\nThe view of a (1203 bytes) didn't fit within this summary's 1000 bytes: it's a/view.md in the job's evidence.\n", '603 characters, but 1,203 bytes');
});

test('a request line removed with nothing of its kind added beside it is a request no longer sent, and the view shows its line under a heading of its own', () => {
  const committed = text('step a', '  compile p.1, body 11111111', '  call p.1 [T:call-merge-x] -> refused, body 22222222', '  call p.1 [T:call-merge-x] -> refused, body 33333333', 'step b', '  compile -1 + p.2, body 44444444', 'end ok');
  const run = lines(['step a'], ['  compile p.1, body 11111111', 'r1'], ['step b'], ['  compile -1 + p.2, body 44444444', 'r2'], ['end ok']);
  const changed = changedRequests(committed, run);
  assert.deepEqual(changed.requests, []);
  assert.deepEqual(changed.stopped, ['  call p.1 [T:call-merge-x] -> refused, body 22222222', '  call p.1 [T:call-merge-x] -> refused, body 33333333']);
  const view = viewOf({ run: 'H2/W7', record: 'differs', changed, lines: run, transcript: () => [], ledger: () => [] });
  assert.match(view, /0 request\(s\) changed and 2 no longer sent/);
  assert.equal((view.match(/^### no longer sent: `call p\.1 \[T:call-merge-x\] -> refused, body (22222222|33333333)`$/gm) ?? []).length, 2);
  assert.match(summaryTable([{ run: 'H2/W7', record: 'differs', changed, counts: {} }]), /differs: 0 request\(s\), 2 no longer sent, \+0 -2 line\(s\)/);
});

test('a changed request is paired with the line it replaced, and the view shows where in that line it moved', () => {
  const committed = text('step a', '  compile x.1 L1(a-b) L1(c) x.9 y.1, body 11111111', 'end ok');
  const run = lines(['step a'], ['  compile x.1 L2(a-c) x.9 y.1, body 22222222', 'r1'], ['end ok']);
  const changed = changedRequests(committed, run);
  assert.deepEqual(changed.requests, ['r1']);
  assert.deepEqual(changed.stopped, []);
  assert.equal(changed.was.get('r1'), '  compile x.1 L1(a-b) L1(c) x.9 y.1, body 11111111');
  assert.deepEqual(movedIn(changed.was.get('r1'), run[1].text), ['  compile x.1', '- L1(a-b) L1(c)', '+ L2(a-c)', '  x.9 y.1,', '  body', '- 11111111', '+ 22222222']);
  const view = viewOf({ run: 'H1/W9', record: 'differs', changed, lines: run, transcript: () => ['#0 user'], ledger: () => [] });
  assert.match(view, /Where its record line moved:\n\n```diff\n  compile x\.1\n- L1\(a-b\) L1\(c\)\n\+ L2\(a-c\)/);
});

test('a dry or refused compile is no request, so one that went away isn\'t a request no longer sent', () => {
  const committed = text('step a', '  compile p.1, body 11111111', '  compile dry + p.1.r2 ^ 4', '  compile refused BudgetExceeded [T:error-x-0123456789ab]', 'end ok');
  const run = lines(['step a'], ['  compile p.1, body 11111111', 'r1'], ['end ok']);
  assert.deepEqual(changedRequests(committed, run).stopped, []);
});

test('a request sent at another place with its line unchanged pairs with its old line, and isn\'t a request no longer sent', () => {
  const committed = text('step a', '  call p.1 [T:call-x-0123456789ab] -> summary, body 11111111', '  compile p.1, body 22222222', 'end ok');
  const run = lines(['step a'], ['  compile p.1, body 22222222', 'r2'], ['  call p.1 [T:call-x-0123456789ab] -> summary, body 11111111', 'r1'], ['end ok']);
  const changed = changedRequests(committed, run);
  assert.deepEqual(changed.stopped, []);
  assert.ok(changed.moved.has(changed.requests[0]), 'the reordered request is named, and marked as moved');
  const view = viewOf({ run: 'X', record: 'differs', changed, lines: run, transcript: () => [], ledger: () => [] });
  assert.match(view, /Sent at another place in the run, with its record line unchanged\./);
  assert.match(view, /0 no longer sent/);
});

test('within a hunk, a changed request pairs with the old line of its kind it shares most with, not the first in order', () => {
  const committed = text('step a', '  call a.1 a.2 a.3 [T:call-x-0123456789ab] -> summary, body 11111111', '  call b.1 b.2 b.3 [T:call-x-0123456789ab] -> summary, body 22222222', 'end ok');
  const run = lines(['step a'], ['  call b.1 b.2 b.3 b.4 [T:call-x-0123456789ab] -> summary, body 33333333', 'r2'], ['end ok']);
  const changed = changedRequests(committed, run);
  assert.equal(changed.was.get('r2'), '  call b.1 b.2 b.3 [T:call-x-0123456789ab] -> summary, body 22222222');
  assert.deepEqual(changed.stopped, ['  call a.1 a.2 a.3 [T:call-x-0123456789ab] -> summary, body 11111111']);
});

test('a moved span shows each removed and added run whole, however long', () => {
  const many = Array.from({ length: 200 }, (_, i) => `L1(x.${i})`).join(' ');
  const out = movedIn(`  compile a ${many} z, body 11111111`, '  compile a L2(x.0-x.199) z, body 22222222');
  assert.ok(out.some((l) => l === `- ${many}`), 'the 200 removed items, uncut');
});

test('a request whose head changed, though its line reads the same because the head is named on the line before, is changed in place, not sent elsewhere', () => {
  const committed = text('step a', '  compile p.1, head H:aaaaaaaa, body 11111111', '  round + p.1.r1, body 22222222', 'end ok');
  const run = lines(['step a'], ['  compile p.1, head H:bbbbbbbb, body 11111111', 'r1'], ['  round + p.1.r1, body 22222222', 'r2'], ['end ok']);
  const changed = changedRequests(committed, run);
  assert.deepEqual(changed.requests, ['r1', 'r2'], 'both send the new head');
  assert.ok(!changed.moved.has('r2'), 'r2 stayed in place; only its head changed');
});

test('a removed whole compile can\'t take the pairing of a changed compile written as a change from the one before', () => {
  const committed = text('step a', '  compile p.1 p.2 p.3, body 11111111', '  compile + p.9, body 22222222', 'end ok');
  const run = lines(['step a'], ['  compile + p.9 p.1 p.2 p.3, body 33333333', 'r2'], ['end ok']);
  const changed = changedRequests(committed, run);
  assert.equal(changed.was.get('r2'), '  compile + p.9, body 22222222', 'paired with the old change, not the whole compile it shares more items with');
  assert.deepEqual(changed.stopped, ['  compile p.1 p.2 p.3, body 11111111']);
});
