import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compareVersions, exitCode, nameTemplates, refuseUnrecordable, renderRecord, renderRecordLines, unrecordable, versionChanges, versionsText } from '../lib/record.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedRequests } from '../lib/view.mjs';
import * as recordLib from '../lib/record.mjs';

const header = { configuration: 'H1/W1', release: { tag: 'v0.0.1', versions: { '@animalabs/connectome-host': '0.0.1' } }, from: 'empty', candidate: { versions: { '@animalabs/connectome-host': '0.0.2' } } };
const text = (t) => ({ participant: 'user', content: [{ type: 'text', text: t }] });
const blobs = {
  b1: text('[[c:p.1.in]] hello'),
  b2: { participant: 'fixture', content: [{ type: 'text', text: '[[c:p.1.r1]] hi' }] },
  b3: text('Clock: 12:10 UTC'),
  b4: text('[[c:p.2.in]] more'),
  b5: { participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: '[[c:p.2.call1]] [image: image/png, ~352KB, ref img_k7x3q2_1]' }] },
  b6: text('Clock: 12:20 UTC'),
  s1: { participant: 'summary', content: 'what happened first' },
  b7: { participant: 'user', content: [{ type: 'tool_result', toolUseId: 't2', content: 'ref img_zz9yy8_1 then ref img_k7x3q2_1' }] },
};
const m = (id, content, marker) => ({ sources: [`r:${id}`], content, ...(marker ? { marker: { message: true } } : {}) });
const line = (seq, messages, more = {}) => ({ seq, agent: 'fixture', kind: 'request', assembly: seq, outcome: 'compiled', stamp: String(seq * 10), messages, ...more });
const log = [
  { kind: 'send', via: 'ipc', step: 'p.name', command: '/session rename fixture' },
  { kind: 'send', via: 'channel', step: 'p.1' },
  { kind: 'compiles', step: 'p.1', blobs, lines: [line(1, [m(1, 'b1', true)])] },
  { kind: 'send', via: 'channel', step: 'p.2' },
  { kind: 'compiles', step: 'p.2', blobs: {}, lines: [line(2, [m(1, 'b1'), m(2, 'b2'), m(3, 'b3'), m(4, 'b4', true)]), line(3, [m(1, 'b1'), m(2, 'b2'), m(3, 'b3'), m(4, 'b4'), m(5, 'b5', true)])] },
  { kind: 'request', step: 'p.2', request: { id: 'r9', kind: 'summariser' } },
  { kind: 'compiles', step: 'p.3', blobs: {}, store: { fixture: {
    messages: [['1', ['[[c:p.1.in]]']], ['2', ['[[c:p.1.r1]]']]],
    summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sources: ['1', '2'], parent: null, content: 's1' }],
    receiptHead: { sequence: 5, receiptHash: 'abcdef0123456789abcdef', changes: [['L1-1', ['sum:L1-1', 1, 5]], ['6', ['raw:6', 0, 5]]] },
  } }, lines: [
    line(4, [m(3, 'b3'), m(4, 'b4'), m(5, 'b5'), m(6, 'b6')]),
    line(5, [{ sources: ['s:L1-1@1'], content: 's1' }, m(6, 'b6'), m(7, 'b7')]),
    line(6, [], { outcome: 'refused', error: { class: 'BudgetExceeded', message: 'over by 1234 tokens' } }),
  ] },
  { kind: 'checkpoint', step: 'p.end', name: 'prefix' },
];
const records = [{ id: 'r9', kind: 'summariser', step: 'p.2', messages: [{ blocks: [{ canaries: ['[[c:p.1.in]]'] }, { canaries: ['[[c:p.1.r1]]'] }] }], answer: { shape: 'summary' } }];

test('a record names messages by their canaries, writes each compile as what changed, and keeps the stack\'s texts once', () => {
  const r = renderRecord({ header, log, records, end: { ok: true } }).split('\n');
  const body = r.slice(r.indexOf('step p.name')).filter(Boolean).map((l) => l.replace(/, body [0-9a-f]{8}$/, ', body HASH'));
  assert.deepEqual(body, [
    'step p.name',
    '  action /session rename fixture',
    'step p.1',
    '  compile p.1.in ^ 1',
    'step p.2',
    '  compile + p.1.r1 [T:user-clock-#-#-utc-9b6932fc9102](12,10) p.2.in ^ 4',
    '  compile + p.2.call1 ^ 5',
    '  call p.1.in p.1.r1 -> summary, body HASH',
    'step p.3',
    '  wrote L1(p.1.in-p.1.r1) [T:summary-l1-bda55950e5d0]',
    '  compile -2 + [T:user-clock-#-#-utc-9b6932fc9102](12,20)',
    '  compile L1(p.1.in-p.1.r1) [T:user-clock-#-#-utc-9b6932fc9102](12,20) [T:user-ref-img-na-#-then-9f1032607484](1,1)',
    '  compile refused BudgetExceeded [T:error-budgetexceeded-over-by-#-9ed7cf715b80]',
    'checkpoint prefix',
    'end ok',
    'receipt fixture #5 changes L1(p.1.in-p.1.r1)/sum/1/5 #6/raw/0/5',
    'totals {"actions":1,"calls":1,"compiles":5,"dry":0,"other":0,"refused":1,"rounds":0,"written":1}',
  ]);
  assert.equal(r.indexOf('templates'), 1, 'the texts block comes first, after the header line');
  const templates = r.slice(r.indexOf('templates') + 1, r.indexOf('step p.name'));
  assert.ok(templates.every((l) => l.startsWith('T:') || l.startsWith('  ')), 'and holds only the texts');
  assert.ok(templates.includes('T:user-clock-#-#-utc-9b6932fc9102 = Clock: #:# UTC'), 'numbers written as #, their values on the line');
  assert.ok(templates.includes('T:user-ref-img-na-#-then-9f1032607484 = ref img_na_# then ref img_nb_#'), 'each nonce named by the order it first appears');
  assert.ok(templates.includes('T:summary-l1-bda55950e5d0 = what happened first'));
});

test('texts that share their first words are each named from their own text, whatever order they first appear in', () => {
  const recs = (texts) => texts.map((t, i) => ({ id: `r${i}`, kind: 'summariser', step: 'p.2', texts: [t], messages: [{ role: 'user', digest: 'd1', blocks: [{}] }], answer: { shape: 'summary' } }));
  const withCalls = (n) => [...log.slice(0, 5), ...Array.from({ length: n }, (_, i) => ({ kind: 'request', step: 'p.2', request: { id: `r${i}`, kind: 'summariser' } })), ...log.slice(6)];
  const texts = ['You have just reviewed the slices above.', 'You have just been reading a body of text.', 'You have just reviewed the memories above.\nWrite one.'];
  const named = (order) => {
    const r = renderRecord({ header, log: withCalls(order.length), records: recs(order.map((i) => texts[i])), end: { ok: true } }).split('\n');
    return r.slice(r.indexOf('templates') + 1, r.indexOf('step p.name')).filter((l) => /^T:call-|^  /.test(l));
  };
  const own = (t) => `T:call-you-have-just-${createHash('sha256').update(t).digest('hex').slice(0, 12)}`;
  const all = named([0, 1, 2]);
  for (const t of texts) assert.ok(all.includes(`${own(t)} = ${t.split('\n')[0]}`), `${t.split('\n')[0]} is named by its own hash`);
  assert.ok(all.includes('  Write one.'), 'a later line indented');
  assert.deepEqual(named([2, 1, 0]), all, 'the order they first appear in changes no name');
  assert.ok(named([0]).includes(`${own(texts[0])} = ${texts[0]}`), 'and with the others gone, its name is the same');
});

test('a stored message sent without its thinking, or altered or in part, says so, and never joins a range', () => {
  const reply = (c, withThinking) => ({ participant: 'fixture', content: [...(withThinking ? [{ type: 'thinking', thinking: 'hm', signature: 's' }] : []), { type: 'text', text: `[[c:${c}]] ok` }] });
  const b = { u1: text('[[c:q.1.in]] a'), r1: reply('q.1.r1', true), r1bare: reply('q.1.r1', false), u2: text('[[c:q.2.in]] b'), r2: reply('q.2.r1', false) };
  const store = { fixture: { messages: [['1', ['[[c:q.1.in]]']], ['2', ['[[c:q.1.r1]]'], { thinking: true }], ['3', ['[[c:q.2.in]]']], ['4', ['[[c:q.2.r1]]']]] } };
  const lg = [
    { kind: 'send', via: 'channel', step: 'q.1' },
    { kind: 'compiles', step: 'q.1', blobs: b, store, lines: [
      line(1, [m(1, 'u1'), m(2, 'r1'), m(3, 'u2'), m(4, 'r2')]),
      line(2, [m(1, 'u1'), m(2, 'r1bare'), m(3, 'u2'), { sources: ['r:4!content'], content: 'r2' }]),
      line(3, [m(1, 'u1'), m(2, 'r1bare'), m(3, 'u2'), m(4, 'r2')]),
    ] },
  ];
  const compiles = (l) => renderRecord({ header, log: l, records: [], end: { ok: true } }).split('\n').filter((x) => x.startsWith('  compile'));
  assert.deepEqual(compiles(lg), [
    '  compile q.1.in-q.2.r1',
    '  compile q.1.in q.1.r1:no-thinking q.2.in q.2.r1!content',
    '  compile q.1.in q.1.r1:no-thinking q.2.in-q.2.r1',
  ], 'the thinking left out by the bytes sent, the body altered by its provenance');
  const stripped = JSON.parse(JSON.stringify(lg));
  stripped[1].store.fixture.messages.push(['2', ['[[c:q.1.r1]]'], { thinking: false }]);
  assert.equal(compiles(stripped)[1], '  compile q.1.in-q.2.in q.2.r1!content', 'a stored copy whose thinking went is sent as it is, so it says nothing, and joins its range');
});

test('two runs whose image nonces differ write the same record', () => {
  const other = JSON.parse(JSON.stringify(log).replaceAll('k7x3q2', 'a1b2c3').replaceAll('zz9yy8', 'q0q0q0'));
  assert.equal(renderRecord({ header, log: other, records, end: { ok: true } }), renderRecord({ header, log, records, end: { ok: true } }));
});

test('a summariser call shows its own words as templates, and its body hash moves when anything else it sends does', () => {
  const asked = (texts, digest = 'd1', more = {}) => [{ id: 'r9', kind: 'summariser', step: 'p.2', model: 'm', maxTokens: more.maxTokens ?? 16000, stream: false, texts,
    head: { model: 'm', maxTokens: more.maxTokens ?? 16000, toolChoice: null, thinking: null, system: [{ text: 'You summarise.', cache: null }], tools: [{ name: 't', sha: more.toolSha ?? '0123456789abcdef' }], rest: null },
    messages: [{ role: 'user', digest, blocks: [{ canaries: ['[[c:p.1.in]]'] }, { canaries: ['[[c:p.1.r1]]'] }, {}] }], answer: { shape: 'summary' }, ...more }];
  const recordOf = (recs) => renderRecord({ header, log, records: recs, end: { ok: true } });
  const callOf = (recs) => recordOf(recs).split('\n').find((l) => l.startsWith('  call '));
  const plain = callOf(asked(['Summarise in about 400 tokens, phase: research.']));
  assert.match(plain, /^  call p\.1\.in p\.1\.r1 \[T:call-summarise-in-about-[0-9a-f]{12}\]\(400\) -> summary, head H:[0-9a-f]{8}, body [0-9a-f]{8}$/);
  const reworded = recordOf(asked(['Summarise in about 400 tokens, phase: .']));
  assert.notEqual(reworded, recordOf(asked(['Summarise in about 400 tokens, phase: research.'])), 'a change to its words');
  assert.ok(reworded.split('\n').some((l) => /^T:call-summarise-in-about-[0-9a-f]{12} = Summarise in about # tokens, phase: \.$/.test(l)), 'and the words show in its template');
  assert.notEqual(callOf(asked(['Summarise in about 400 tokens, phase: research.'], 'd2')), plain, 'a change to a carried message\'s content');
  const limited = recordOf(asked(['Summarise in about 400 tokens, phase: research.'], 'd1', { maxTokens: 8000 })).split('\n');
  assert.notEqual(limited.find((l) => l.startsWith('  call ')), plain, 'a change to its limits names another head');
  assert.ok(limited.some((l) => /^H:[0-9a-f]{8} = model m, max_tokens 8000, stream false, system \[T:system-you-summarise-[0-9a-f]{12}\], tools t:01234567$/.test(l)), 'and the heads block says what the head is');
  const retooled = recordOf(asked(['Summarise in about 400 tokens, phase: research.'], 'd1', { toolSha: 'fedcba9876543210' })).split('\n');
  assert.ok(retooled.some((l) => /, tools t:fedcba98$/.test(l)), 'a tool\'s changed definition shows as its hash');
  assert.equal(callOf(asked(['Summarise in about 400 tokens, phase: research.'])), plain, 'the same request, the same line');
});

test('a summary a summariser call carries is named as the store names it, not written out again', () => {
  const recs = [{ id: 'r9', kind: 'summariser', step: 'p.2', texts: ['a: [[s:M0000beef]] Memory beef, what happened first', 'Merge these.'],
    messages: [{ role: 'user', digest: 'd1', blocks: [{}, {}] }], answer: { shape: 'summary' } }];
  const line = renderRecord({ header, log, records: recs, end: { ok: true } }).split('\n').find((l) => l.startsWith('  call '));
  assert.match(line, /^  call - S\(M0000beef\) \[T:call-merge-these-[0-9a-f]{12}\] -> summary, body [0-9a-f]{8}$/, 'a mark the store didn\'t report is named by the mark');
  const marked = JSON.parse(JSON.stringify(log));
  marked.find((e) => e.kind === 'compiles' && e.blobs?.s1).blobs.s1 = { participant: 'summary', content: '[[s:M0000beef]] Memory beef, what happened first' };
  const named = renderRecord({ header, log: marked, records: recs, end: { ok: true } }).split('\n').find((l) => l.startsWith('  call '));
  assert.match(named, /^  call - L1\(p\.1\.in-p\.1\.r1\) \[T:call-merge-these-[0-9a-f]{12}\] -> summary, body [0-9a-f]{8}$/, 'a mark the store reported is named as the store names its summary');
});

test('a stored message no compile sends still holds its place, so its neighbours never join across it', () => {
  const b = { u1: text('[[c:q.1.in]] a'), r1: { participant: 'fixture', content: [{ type: 'text', text: '[[c:q.1.r1]] b' }] }, r2: { participant: 'fixture', content: [{ type: 'text', text: '[[c:q.2.r1]] d' }] } };
  const store = { fixture: { messages: [['1', ['[[c:q.1.in]]']], ['2', ['[[c:q.1.r1]]']], ['3', ['[[c:q.2.in]]']], ['4', ['[[c:q.2.r1]]']]] } };
  const lg = [{ kind: 'compiles', step: 'q.2', blobs: b, store, lines: [line(1, [m(1, 'u1'), m(2, 'r1'), m(4, 'r2')])] }];
  const compiles = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n').filter((x) => x.startsWith('  compile'));
  assert.deepEqual(compiles, ['  compile q.1.in-q.1.r1 q.2.r1']);
});

test('each agent\'s store is its own: lines of another agent than the fixture\'s name it, and its summaries are named from its own store', () => {
  const b = { u1: text('[[c:q.1.in]] a'), s1: { participant: 'summary', content: 'first' }, t1: text('[[c:t.1.in]] x'), s2: { participant: 'summary', content: 'second' } };
  const store = {
    fixture: { messages: [['1', ['[[c:q.1.in]]']]], summaries: [{ id: 'L1-0', level: 1, sourceLevel: 0, sources: ['1'], parent: null, content: 's1' }] },
    reader: { messages: [['1', ['[[c:t.1.in]]']]], summaries: [{ id: 'L1-0', level: 1, sourceLevel: 0, sources: ['1'], parent: null, content: 's2' }] },
  };
  const lg = [{ kind: 'compiles', step: 'q.1', blobs: b, store, lines: [
    line(1, [{ sources: ['s:L1-0@1'], content: 's1' }]),
    { ...line(1, [{ sources: ['s:L1-0@1~'], content: 's2' }]), agent: 'reader' },
  ] }];
  const r = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n');
  assert.ok(r.some((x) => /^  wrote L1\(q\.1\.in\) /.test(x)), 'the fixture\'s summary is named from its own store');
  assert.ok(r.some((x) => /^  wrote \[reader\] L1\(t\.1\.in\) /.test(x)), 'the reader\'s summary is named from the reader\'s store');
  assert.ok(r.includes('  compile L1(q.1.in)'));
  assert.ok(r.includes('  compile [reader] L1(t.1.in)~'), 'a partial summary keeps its mark');
});

test('a receipt that removes a leaf, a failed run, and a batch with no lines each render', () => {
  const lg = [
    { kind: 'compiles', step: 'q.1', blobs: { u1: text('[[c:q.1.in]] a') }, store: { fixture: { messages: [['1', ['[[c:q.1.in]]']]], receiptHead: { sequence: 3, changes: [['1', ['raw:1', 0, 3]], ['7', null]] } } }, lines: [line(1, [m(1, 'u1')])] },
    { kind: 'compiles', step: 'q.2', lost: 'the module stopped before flushing' },
  ];
  const r = renderRecord({ header, log: lg, records: [], end: { ok: false, reason: 'the host exited with code 1 after 1234 ms' } }).split('\n');
  assert.ok(r.includes('receipt fixture #3 changes q.1.in/raw/0/3 #7/removed'));
  assert.ok(r.includes('end failed'), 'a failure\'s text, which varies, stays in the report');
});

test('a sent compile names its head when it changes and its body, and a continuation round gets a line of its own', () => {
  const head = { model: 'm', maxTokens: 100, toolChoice: null, thinking: null, system: [], tools: [], rest: null };
  const req = (id, canaries, digest) => ({ id, arrived: id === 'a1' ? '11' : '21', kind: 'agent', agent: 'primary', step: 'q.1', stream: true, head, messages: [{ role: 'user', digest, blocks: canaries.map((c) => ({ type: 'text', canaries: [`[[c:${c}]]`] })) }], answer: { shape: 'reply' } });
  const recs = [req('a1', ['q.1.in'], 'd1'), req('a2', ['q.1.in', 'q.1.call1'], 'd2')];
  const lg = [
    { kind: 'compiles', step: 'q.1', blobs: { u1: text('[[c:q.1.in]] a') }, lines: [line(1, [m(1, 'u1')])] },
    { kind: 'request', step: 'q.1', request: { id: 'a1', kind: 'agent' } },
    { kind: 'request', step: 'q.1', request: { id: 'a2', kind: 'agent' } },
  ];
  const r = renderRecord({ header, log: lg, records: recs, end: { ok: true } }).split('\n');
  assert.match(r.find((l) => l.startsWith('  compile')), /^  compile q\.1\.in, head H:[0-9a-f]{8}, body [0-9a-f]{8}$/);
  assert.match(r.find((l) => l.startsWith('  round')), /^  round \+ q\.1\.call1, body [0-9a-f]{8}$/, 'the round carries the call, under the head already named');
  assert.equal(r.filter((l) => l.startsWith('H:')).length, 1);
  const reworded = renderRecord({ header, log: lg, records: [recs[0], { ...recs[1], messages: [{ ...recs[1].messages[0], digest: 'd3' }] }], end: { ok: true } }).split('\n');
  assert.notEqual(reworded.find((l) => l.startsWith('  round')), r.find((l) => l.startsWith('  round')), 'a change to what the round sends moves its line');
});

test('a turn\'s compile comes before its rounds, as the stand-in received them, though the module\'s batch reaches the log after the requests', () => {
  const head = { model: 'm', maxTokens: 100, toolChoice: null, thinking: null, system: [], tools: [], rest: null };
  const req = (id, seq, canaries, digest) => ({ id, seq, arrived: String(seq * 10 + 1), kind: 'agent', agent: 'primary', step: 'q.1', stream: true, head, messages: [{ role: 'user', digest, blocks: canaries.map((c) => ({ type: 'text', canaries: [`[[c:${c}]]`] })) }], answer: { shape: 'reply' } });
  const recs = [req('a1', 1, ['q.1.in'], 'd1'), req('a2', 2, ['q.1.in', 'q.1.r1', 'q.1.call1'], 'd2'), req('a3', 3, ['q.1.in', 'q.1.r1', 'q.1.call1', 'q.1.r2', 'q.1.call2'], 'd3')];
  const lg = [
    { kind: 'request', step: 'q.1', request: { id: 'a1', kind: 'agent' } },
    { kind: 'request', step: 'q.1', request: { id: 'a2', kind: 'agent' } },
    { kind: 'request', step: 'q.1', request: { id: 'a3', kind: 'agent' } },
    { kind: 'compiles', step: 'q.1', blobs: { u1: text('[[c:q.1.in]] a') }, lines: [line(1, [m(1, 'u1')])] },
  ];
  const lines = renderRecordLines({ header, log: lg, records: recs, end: { ok: true } });
  const body = lines.filter((l) => l.text.startsWith('  ')).map((l) => l.text.replace(/, (head H:|body ).*$/, ''));
  assert.deepEqual(body, ['  compile q.1.in', '  round + q.1.r1 q.1.call1', '  round + q.1.r2 q.1.call2']);
  const rounds = lines.filter((l) => l.round);
  assert.deepEqual(rounds.map((l) => l.compile?.seq), [1, 1], 'each round belongs to the compile that sent its turn');
});

test('the thinking a store reported holds across batches, and a message reported again without the bit has none', () => {
  const reply = (c, withThinking) => ({ participant: 'fixture', content: [...(withThinking ? [{ type: 'thinking', thinking: 'hm', signature: 's' }] : []), { type: 'text', text: `[[c:${c}]] ok` }] });
  const b = { u1: text('[[c:q.1.in]] a'), r1: reply('q.1.r1', true), r1bare: reply('q.1.r1', false), u2: text('[[c:q.2.in]] b'), r2: reply('q.2.r1', false) };
  const sent = [m(1, 'u1'), m(2, 'r1bare'), m(3, 'u2'), m(4, 'r2')];
  const lg = [
    { kind: 'compiles', step: 'q.1', blobs: b, store: { fixture: { messages: [['1', ['[[c:q.1.in]]']], ['2', ['[[c:q.1.r1]]'], { thinking: true }], ['3', ['[[c:q.2.in]]']], ['4', ['[[c:q.2.r1]]']]] } }, lines: [line(1, [m(1, 'u1'), m(2, 'r1'), m(3, 'u2'), m(4, 'r2')])] },
    { kind: 'compiles', step: 'q.2', blobs: {}, lines: [line(2, sent)] },
    { kind: 'compiles', step: 'q.3', blobs: {}, store: { fixture: { messages: [['2', ['[[c:q.1.r1]]']]] } }, lines: [line(3, sent)] },
  ];
  const compiles = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n').filter((x) => x.startsWith('  compile'));
  assert.deepEqual(compiles, [
    '  compile q.1.in-q.2.r1',
    '  compile q.1.in q.1.r1:no-thinking q.2.in-q.2.r1',
    '  compile q.1.in-q.2.r1',
  ], 'the bit from the first batch marks the second; the third batch\'s report without it clears it');
});

test('a body sent without all its shards says so and stands outside any range', () => {
  const b = { u1: text('[[c:q.1.in]] a'), r1: { participant: 'fixture', content: [{ type: 'text', text: '[[c:q.1.r1]] ok' }] }, u2: text('[[c:q.2.in]] b'), r2: { participant: 'fixture', content: [{ type: 'text', text: '[[c:q.2.r1]] ok' }] } };
  const lg = [{ kind: 'compiles', step: 'q.1', blobs: b, lines: [line(1, [m(1, 'u1'), m(2, 'r1'), { sources: ['r:3!shards'], content: 'u2' }, m(4, 'r2')])] }];
  const compile = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n').find((x) => x.startsWith('  compile'));
  assert.equal(compile, '  compile q.1.in-q.1.r1 q.2.in!shards q.2.r1');
});

test('a stack text up to 4,096 bytes is written whole, and a longer one as its hash, size, head and tail', () => {
  const block = (n) => {
    const lg = [{ kind: 'compiles', step: 'q.1', blobs: { u1: text('[[c:q.1.in]] a'), t1: text('x'.repeat(n)) }, lines: [line(1, [m(1, 'u1'), m(2, 't1')])] }];
    return renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n').find((l) => l.startsWith('T:user-x'));
  };
  assert.equal(block(4096), `T:user-${'x'.repeat(40)}-${createHash('sha256').update('x'.repeat(4096)).digest('hex').slice(0, 12)} = ${'x'.repeat(4096)}`);
  assert.match(block(4097), /^T:user-x{40}-[0-9a-f]{12} = \{"bytes":4097,"head":"x{80}","sha256":"[0-9a-f]{16}","tail":"x{80}"\}$/);
});

test('the 4,096 is bytes, not characters: 2,048 two-byte characters are written whole, and one more is shaped', () => {
  const block = (t) => {
    const lg = [{ kind: 'compiles', step: 'q.1', blobs: { u1: text('[[c:q.1.in]] a'), t1: text(t) }, lines: [line(1, [m(1, 'u1'), m(2, 't1')])] }];
    return renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n').find((l) => / = /.test(l) && l.includes('é'));
  };
  assert.ok(block('é'.repeat(2048)).endsWith(` = ${'é'.repeat(2048)}`));
  assert.match(block('é'.repeat(2049)), /\{"bytes":4098,/);
});

test('a heads entry names the request\'s anthropic-beta and anthropic-version headers', () => {
  const req = { id: 'a1', seq: 1, arrived: '11', kind: 'agent', agent: 'primary', step: 'q.1', stream: true, head: { model: 'm', maxTokens: 1, toolChoice: null, thinking: null, system: [], tools: [], rest: null, headers: { beta: ['b-one', 'b-two'], version: '2023-06-01' } }, messages: [{ role: 'user', digest: 'd', blocks: [{ type: 'text', canaries: ['[[c:q.1.in]]'] }] }], answer: { shape: 'reply' } };
  const lg = [{ kind: 'request', step: 'q.1', request: { id: 'a1', kind: 'agent' } }, { kind: 'compiles', step: 'q.1', blobs: { u1: text('[[c:q.1.in]] a') }, lines: [line(1, [m(1, 'u1')])] }];
  const heads = renderRecord({ header, log: lg, records: [req], end: { ok: true } }).split('\n').filter((l) => l.startsWith('H:'));
  assert.equal(heads.length, 1);
  assert.match(heads[0], /, headers beta b-one\+b-two version 2023-06-01/);
});

test('a cache marker nested in a tool result\'s content moves its compile line\'s body hash', () => {
  const req = (contentCache) => ({ id: 'a1', seq: 1, arrived: '11', kind: 'agent', agent: 'primary', step: 'q.1', stream: true, messages: [{ role: 'user', digest: 'd', blocks: [{ type: 'tool_result', canaries: ['[[c:q.1.in]]'], cache: null, ...(contentCache ? { contentCache } : {}) }] }], answer: { shape: 'reply' } });
  const lg = [{ kind: 'request', step: 'q.1', request: { id: 'a1', kind: 'agent' } }, { kind: 'compiles', step: 'q.1', blobs: { u1: text('[[c:q.1.in]] a') }, lines: [line(1, [m(1, 'u1')])] }];
  const compile = (r) => renderRecord({ header, log: lg, records: [r], end: { ok: true } }).split('\n').find((l) => l.startsWith('  compile'));
  assert.notEqual(compile(req(null)), compile(req([null, '5m'])));
  assert.notEqual(compile(req([null, '5m'])), compile(req(['5m', null])), 'and so does where among the content it sits');
});

test('a store read the recorder couldn\'t make is a line of the record, and the rest of the record still renders', () => {
  const lg = [
    { kind: 'compiles', step: 'q.1', blobs: { u1: text('[[c:q.1.in]] a') }, store: { fixture: { messages: { unreadable: 'getAllMessages threw' }, summaries: { unreadable: 'no such reader' } } }, lines: [line(1, [m(1, 'u1')])] },
  ];
  const r = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n');
  assert.ok(r.includes('  unreadable messages: getAllMessages threw'));
  assert.ok(r.includes('  unreadable summaries: no such reader'));
  assert.ok(r.includes('  compile q.1.in'));
});

test('the record\'s receipt is the last head the store reported: one it couldn\'t read is a line, and one reset to none names none', () => {
  const head = (sequence) => ({ sequence, receiptHash: 'h', parentReceiptHash: null, requestHash: 'r', layoutHash: 'l', changes: [] });
  const batch = (i, receiptHead) => ({ kind: 'compiles', step: `q.${i}`, blobs: { [`u${i}`]: text(`[[c:q.${i}.in]] a`) }, store: { fixture: { receiptHead } }, lines: [line(i, [m(i, `u${i}`)])] });
  const render = (...heads) => renderRecord({ header, log: heads.map((h, i) => batch(i + 1, h)), records: [], end: { ok: true } }).split('\n');
  assert.ok(render(head(3), head(4)).includes('receipt fixture #4'));
  const unread = render(head(3), { unreadable: 'getStrategy threw' });
  assert.ok(unread.includes('  unreadable receipt: getStrategy threw'));
  assert.ok(!unread.some((l) => l.startsWith('receipt ')), 'and no receipt is named from it');
  assert.ok(!render(head(3), null).some((l) => l.startsWith('receipt ')), 'a head reset to none leaves no receipt');
});

test('a sent compile names each new head where it changes, and its body hash moves with what it sent, cache markers included', () => {
  const head = (maxTokens) => ({ model: 'm', maxTokens, toolChoice: null, thinking: null, system: [], tools: [], rest: null });
  const req = (id, seq, step, h, digest = `d${seq}`, cache = null) => ({ id, seq, arrived: String(seq * 10 + 1), kind: 'agent', agent: 'primary', step, stream: true, head: h, messages: [{ role: 'user', digest, blocks: [{ type: 'text', canaries: [`[[c:${step}.in]]`], cache }] }], answer: { shape: 'reply' } });
  const lg = ['q.1', 'q.2', 'q.3'].flatMap((step, i) => [
    { kind: 'request', step, request: { id: `a${i + 1}`, kind: 'agent' } },
    { kind: 'compiles', step, blobs: { [`u${i + 1}`]: text(`[[c:${step}.in]] a`) }, lines: [line(i + 1, [m(i + 1, `u${i + 1}`)])] },
  ]);
  const recs = [req('a1', 1, 'q.1', head(100)), req('a2', 2, 'q.2', head(200)), req('a3', 3, 'q.3', head(200))];
  const compiles = (rs) => renderRecord({ header, log: lg, records: rs, end: { ok: true } }).split('\n').filter((l) => l.startsWith('  compile'));
  const [c1, c2, c3] = compiles(recs);
  assert.match(c1, /, head H:[0-9a-f]{8}, body [0-9a-f]{8}$/);
  assert.match(c2, /, head H:[0-9a-f]{8}, body [0-9a-f]{8}$/);
  assert.notEqual(c1.match(/H:[0-9a-f]{8}/)[0], c2.match(/H:[0-9a-f]{8}/)[0], 'the second request\'s head differs, and is named');
  assert.doesNotMatch(c3, /head H:/, 'the third request\'s head is the second\'s, so it isn\'t named again');
  const message = compiles([recs[0], req('a2', 2, 'q.2', head(200), 'dX'), recs[2]]);
  assert.notEqual(message[1], c2, 'a change to a compiled request\'s message moves its line');
  assert.deepEqual([message[0], message[2]], [c1, c3], 'and no other request\'s');
  const marker = compiles([recs[0], req('a2', 2, 'q.2', head(200), 'd2', '1h'), recs[2]]);
  assert.notEqual(marker[1], c2, 'and so does a cache marker on it');
  assert.deepEqual([marker[0], marker[2]], [c1, c3], 'again moving no other request\'s line');
});

test('the requests a view shows are those whose lines a rendered record moved', () => {
  const head = { model: 'm', maxTokens: 100, toolChoice: null, thinking: null, system: [], tools: [], rest: null };
  const req = (id, seq, digest) => ({ id, seq, arrived: String(seq * 10 + 1), kind: 'agent', agent: 'primary', step: 'q.1', stream: true, head, messages: [{ role: 'user', digest, blocks: [{ type: 'text', canaries: ['[[c:q.1.in]]'] }] }], answer: { shape: 'reply' } });
  const lg = [
    { kind: 'request', step: 'q.1', request: { id: 'a1', kind: 'agent' } },
    { kind: 'request', step: 'q.1', request: { id: 'a2', kind: 'agent' } },
    { kind: 'compiles', step: 'q.1', blobs: { u1: text('[[c:q.1.in]] a') }, lines: [line(1, [m(1, 'u1')])] },
  ];
  const committed = renderRecord({ header, log: lg, records: [req('a1', 1, 'd1'), req('a2', 2, 'd2')], end: { ok: true } });
  const moved = renderRecordLines({ header, log: lg, records: [req('a1', 1, 'd1'), req('a2', 2, 'dX')], end: { ok: true } });
  assert.deepEqual(changedRequests(committed, moved).requests, ['a2']);
  assert.deepEqual(changedRequests(committed, renderRecordLines({ header, log: lg, records: [req('a1', 1, 'd1'), req('a2', 2, 'd2')], end: { ok: true } })).requests, []);
});

test('a head two requests share, changed for both, names both as changed, though only the first line names it', () => {
  const head = (maxTokens) => ({ model: 'm', maxTokens, toolChoice: null, thinking: null, system: [], tools: [], rest: null });
  const req = (id, seq, h) => ({ id, seq, arrived: String(seq * 10 + 1), kind: 'agent', agent: 'primary', step: 'q.1', stream: true, head: h, messages: [{ role: 'user', digest: 'd', blocks: [{ type: 'text', canaries: ['[[c:q.1.in]]'] }] }], answer: { shape: 'reply' } });
  const lg = [
    { kind: 'request', step: 'q.1', request: { id: 'a1', kind: 'agent' } },
    { kind: 'compiles', step: 'q.1', blobs: { u1: text('[[c:q.1.in]] a') }, lines: [line(1, [m(1, 'u1')])] },
    { kind: 'request', step: 'q.1', request: { id: 'a2', kind: 'agent' } },
  ];
  const at = (h) => ({ header, log: lg, records: [req('a1', 1, h), req('a2', 2, h)], end: { ok: true } });
  const committed = renderRecord(at(head(100)));
  const moved = renderRecordLines(at(head(200)));
  assert.equal(moved.filter((l) => /head H:/.test(l.text)).length, 1, 'only the first line names the head');
  assert.deepEqual(changedRequests(committed, moved).requests, ['a1', 'a2']);
});

test('an agent request no compile pairs with, of a side no agent compiled for, still has a line', () => {
  const sub = { id: 's1', seq: 2, kind: 'agent', agent: 'sub', step: 'q.1', stream: true, messages: [{ role: 'user', digest: 'd', blocks: [{ type: 'text', canaries: ['[[c:q.1.k]]'] }] }], answer: { shape: 'reply' } };
  const lg = [
    { kind: 'compiles', step: 'q.1', blobs: { u1: text('[[c:q.1.in]] a') }, lines: [line(1, [m(1, 'u1')])] },
    { kind: 'request', step: 'q.1', request: { id: 's1', kind: 'agent' } },
  ];
  const r = renderRecordLines({ header, log: lg, records: [sub], end: { ok: true } });
  const own = r.find((l) => l.request === 's1');
  assert.ok(own, 'it has a line');
  assert.match(own.text, /^  round \[sub\] \+ q\.1\.k, body [0-9a-f]{8}$/);
});

test('a request moved to a head another request already used names it as changed, though its line is the same', () => {
  const head = (maxTokens) => ({ model: 'm', maxTokens, toolChoice: null, thinking: null, system: [], tools: [], rest: null });
  const req = (id, seq, step, h) => ({ id, seq, kind: 'agent', agent: 'primary', step, stream: true, head: h, messages: [{ role: 'user', digest: `d${step}`, blocks: [{ type: 'text', canaries: [`[[c:${step}.in]]`] }] }], answer: { shape: 'reply' } });
  const lg = [
    { kind: 'request', step: 'q.1', request: { id: 'a1', kind: 'agent' } },
    { kind: 'compiles', step: 'q.1', blobs: { u1: text('[[c:q.1.in]] a') }, lines: [line(1, [m(1, 'u1')])] },
    { kind: 'request', step: 'q.1', request: { id: 'a2', kind: 'agent' } },
    { kind: 'request', step: 'q.2', request: { id: 'a3', kind: 'agent' } },
    { kind: 'compiles', step: 'q.2', blobs: { u2: text('[[c:q.2.in]] b') }, lines: [line(2, [m(1, 'u1'), m(2, 'u2')])] },
  ];
  const at = (h1, h3) => ({ header, log: lg, records: [req('a1', 1, 'q.1', h1), req('a2', 2, 'q.1', h1), req('a3', 3, 'q.2', h3)], end: { ok: true } });
  const committed = renderRecord(at(head(100), head(200)));
  const moved = renderRecordLines(at(head(200), head(200)));
  assert.deepEqual(changedRequests(committed, moved).requests, ['a1', 'a2'], 'a2 sends the head a3 already used, and its line is unchanged');
});

test('a run is unrecordable where a side sent agent requests with no request compile of its own, or a request compile carries no clock stamp', () => {
  const compiles = (agent, stamp) => ({ kind: 'compiles', lines: [{ kind: 'request', agent, outcome: 'compiled', ...(stamp === undefined ? {} : { stamp }) }] });
  const agentReq = (agent) => ({ kind: 'agent', agent });
  assert.equal(unrecordable([agentReq('primary')], [compiles('fixture', '12')]), null);
  assert.match(unrecordable([agentReq('primary'), agentReq('sub')], [compiles('fixture', '12')]), /sent sub agent requests, and its log holds no compiled request line/);
  assert.match(unrecordable([agentReq('primary')], []), /sent primary agent requests/);
  assert.match(unrecordable([agentReq('primary')], [compiles('fixture')]), /1 request compile\(s\) carry no stamp/);
  assert.equal(unrecordable([], []), null, 'a run with no agent request has nothing to tell apart');
  const refused = { kind: 'compiles', lines: [{ kind: 'request', agent: 'fixture', outcome: 'refused' }] };
  assert.match(unrecordable([agentReq('primary')], [refused]), /sent primary agent requests, and its log holds no compiled request line/, 'a refused compile sent nothing, so no request pairs with it');
});

test('a new boot whose store reports no receipt head names none, where the boot before had one', () => {
  const head = (sequence) => ({ sequence, receiptHash: 'h', parentReceiptHash: null, requestHash: 'r', layoutHash: 'l', changes: [] });
  const batch = (i, boot, st) => ({ kind: 'compiles', step: `q.${i}`, boot, blobs: { [`u${i}`]: text(`[[c:q.${i}.in]] a`) }, store: { fixture: st }, lines: [{ ...line(i, [m(i, `u${i}`)]), boot }] });
  const render = (...batches) => renderRecord({ header, log: batches, records: [], end: { ok: true } }).split('\n');
  assert.ok(render(batch(1, 1, { receiptHead: head(3) }), batch(2, 1, { messages: [] })).includes('receipt fixture #3'), 'the same boot keeps it');
  assert.ok(!render(batch(1, 1, { receiptHead: head(3) }), batch(2, 2, { messages: [] })).some((l) => l.startsWith('receipt ')), 'a restart whose recorder reported none clears it');
  assert.ok(render(batch(1, 1, { receiptHead: head(3) }), batch(2, 2, { receiptHead: head(1) })).includes('receipt fixture #1'));
});

test('the record\'s own agent is the fixture\'s, though another agent compiled first', () => {
  const lg = [
    { kind: 'compiles', step: 'q.1', blobs: { k1: text('[[c:q.1.task]] a') }, lines: [line(1, [m(1, 'k1')], { agent: 'spawn-k' })] },
    { kind: 'compiles', step: 'q.1', blobs: { u1: text('[[c:q.1.in]] b') }, lines: [line(2, [m(2, 'u1')])] },
  ];
  const compiles = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n').filter((l) => l.startsWith('  compile'));
  assert.deepEqual(compiles, ['  compile [spawn-k] q.1.task', '  compile q.1.in']);
});

test('a run unrecordable() refuses becomes couldn\'t-run with its reason, the outcome run.mjs writes no record for, and makes the whole run exit 2', () => {
  const r = { outcome: 'pass', records: [{ kind: 'agent', agent: 'primary' }], log: [] };
  assert.match(refuseUnrecordable(r), /sent primary agent requests/);
  assert.equal(r.outcome, 'couldnt-run', 'run.mjs writes a record only for a run that isn\'t couldn\'t-run');
  assert.match(r.reason, /sent primary agent requests/);
  const ok = { outcome: 'pass', records: [{ kind: 'agent', agent: 'primary' }], log: [{ kind: 'compiles', lines: [{ kind: 'request', agent: 'fixture', outcome: 'compiled', stamp: '7' }] }] };
  assert.equal(refuseUnrecordable(ok), null);
  assert.equal(ok.outcome, 'pass');
  const earlier = { outcome: 'couldnt-run', reason: 'the host didn\'t start', records: [], log: [] };
  assert.equal(refuseUnrecordable(earlier), null, 'a run that already couldn\'t run keeps its own reason');
  assert.equal(earlier.reason, 'the host didn\'t start');
  assert.equal(exitCode([{ outcome: 'pass', record: 'same' }, { outcome: r.outcome, record: null }]), 2);
  assert.equal(exitCode([{ outcome: 'pass', record: 'same' }, { outcome: 'pass', record: 'differs' }]), 1);
  assert.equal(exitCode([{ outcome: 'pass', record: 'same', selfCheck: { outcome: 'same' } }]), 0);
  assert.equal(exitCode([{ outcome: 'pass', record: 'same', selfCheck: { outcome: 'couldnt-run' } }]), 2);
});

test('a request the stand-in couldn\'t classify gets a line of its own with its body, so a changed one is named and its view can show it', () => {
  const head = { model: 'm', maxTokens: 100, toolChoice: null, thinking: null, system: [], tools: [], rest: null };
  const odd = (digest) => ({ id: 'r1', seq: 1, kind: 'unclassified', reason: 'its compression instruction states no target length', step: 'q.1', stream: true, head, messages: [{ role: 'user', digest, blocks: [{ type: 'text', canaries: ['[[c:q.1.in]]'] }] }], answer: { shape: 'refused' } });
  const lg = [{ kind: 'request', step: 'q.1', request: { id: 'r1', kind: 'unclassified' } }];
  const at = (digest) => ({ header, log: lg, records: [odd(digest)], end: { ok: false } });
  const lines = renderRecord(at('d1')).split('\n').filter((l) => l.startsWith('  unclassified'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^  unclassified q\.1\.in, head H:[0-9a-f]{8}, body [0-9a-f]{8}$/);
  assert.deepEqual(changedRequests(renderRecord(at('d1')), renderRecordLines(at('d2'))).requests, ['r1'], 'a reworded instruction moves its body, and the view names it');
});

test('a summary is named by its sources\' canaries as they stood at each compile, so a later edit doesn\'t rename an earlier line', () => {
  const sum = { participant: 'summary', content: 'what happened' };
  const sumLine = (seq) => line(seq, [{ sources: ['s:L1-1@1'], content: 's1' }]);
  const store = (canary) => ({ fixture: { messages: [['9', [canary]]], summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sources: ['9'], parent: null, content: 's1' }] } });
  const lg = [
    { kind: 'compiles', step: 'q.1', blobs: { s1: sum }, store: store('[[c:a.in]]'), lines: [sumLine(1)] },
    { kind: 'compiles', step: 'q.2', blobs: {}, store: store('[[c:b.in]]'), lines: [sumLine(2)] },
  ];
  const compiles = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n').filter((l) => l.startsWith('  compile'));
  assert.match(compiles[0], /L1\(a\.in\)/, 'the first compile sent the summary while its source carried a.in');
  assert.match(compiles[1], /L1\(b\.in\)/);
});

test('no record names a version: versions go in one file, a change in them is named once, and a differing file fails the run as a record does', () => {
  const body = renderRecord({ header, log: [], records: [], end: { ok: true } });
  assert.ok(!/0\.0\.[12]|v0\.0\.1/.test(body), 'the record carries no version');
  assert.match(body.split('\n')[0], /^# whole-host record H1\/W1, from empty$/);
  const at = (cm, { host = '0.21.0', bun = '1.4.4' } = {}) => versionsText({ release: { tag: 'v0.21.0', versions: { '@animalabs/connectome-host': '0.21.0', '@animalabs/context-manager': '0.24.0', bun } }, candidate: { versions: { '@animalabs/connectome-host': host, '@animalabs/context-manager': cm, bun } } });
  assert.equal(at('0.24.0'), '# whole-host versions\ncheckpoint v0.21.0: connectome-host 0.21.0, context-manager 0.24.0\ncandidate: context-manager 0.24.0\n', 'it names the checkpoint release and its stack, and the candidate\'s stack, but not the candidate itself or the Bun that ran');
  assert.deepEqual(versionChanges(at('0.24.0'), at('0.24.1')), ['candidate context-manager 0.24.0 → 0.24.1']);
  assert.deepEqual(versionChanges(at('0.24.0'), at('0.24.0')), []);
  assert.equal(at('0.24.0', { host: '0.22.0' }), at('0.24.0'), 'a release\'s version bump of the checkout changes nothing it compares');
  assert.equal(at('0.24.0', { bun: '1.4.9' }), at('0.24.0'), 'another Bun inside the engines range changes nothing it compares');
  const pass = [{ outcome: 'pass', record: 'same' }];
  assert.equal(exitCode(pass, { versions: 'same' }), 0);
  assert.equal(exitCode(pass, { versions: 'differs' }), 1);
  assert.equal(exitCode(pass, { versions: 'missing' }), 1);
  assert.equal(exitCode(pass, { versions: 'updated' }), 0);
});

test('a template is named from its own text alone, so a text leaving the set renames no other', () => {
  const sm = (n) => ({ participant: 'user', content: [{ type: 'text', text: `Context Manager: [CM] ${n}` }] });
  const compileWith = (texts) => [{ kind: 'compiles', step: 'q.1', blobs: Object.fromEntries(texts.map((t, i) => [`b${i}`, sm(t)])), lines: [line(1, texts.map((_, i) => m(i + 1, `b${i}`)))] }];
  const names = (texts) => renderRecord({ header, log: compileWith(texts), records: [], end: { ok: true } }).split('\n').filter((l) => l.startsWith('T:')).map((l) => l.split(' = ')[0]);
  const both = names(['Recall memory.', 'The conversation resumes.']);
  const one = names(['Recall memory.']);
  assert.equal(both.length, 2);
  assert.ok(both.includes(one[0]), 'the recall text keeps its name when the other text leaves');
  assert.match(one[0], /^T:user-context-manager-cm-[0-9a-f]{12}$/);
});

test('a stored message without a canary is named by the nearest earlier one with a canary and its place after it, in summaries and the receipt alike', () => {
  const st = { fixture: {
    messages: [['1', ['[[c:a.in]]']], ['2', []], ['3', []], ['4', ['[[c:a.r1]]']], ['5', []]],
    summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sources: ['2', '3'], parent: null, content: 's1' }],
    receiptHead: { sequence: 2, receiptHash: 'h', changes: [['5', ['raw:5', 0, 2]], ['L1-1', ['sum:L1-1', 1, 2]]] },
  } };
  const lg = [{ kind: 'compiles', step: 'q.1', blobs: { s1: { participant: 'summary', content: 'x' } }, store: st, lines: [line(1, [{ sources: ['s:L1-1@1'], content: 's1' }])] }];
  const r = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n');
  assert.ok(r.some((l) => /^  compile L1\(a\.in\+1-a\.in\+2\)/.test(l)), 'the summary of two uncanaried messages names both');
  assert.ok(r.includes('receipt fixture #2 changes a.r1+1/raw/0/2 L1(a.in+1-a.in+2)/sum/1/2'));
});

test('a run where two agents besides the fixture make request compiles is refused, since the stand-in pools their requests', () => {
  const compiles = (agent) => ({ kind: 'compiles', lines: [{ kind: 'request', agent, outcome: 'compiled', stamp: '9' }] });
  assert.equal(unrecordable([{ kind: 'agent', agent: 'sub' }], [compiles('fixture'), compiles('spawn-a')]), null);
  assert.match(unrecordable([{ kind: 'agent', agent: 'sub' }], [compiles('fixture'), compiles('spawn-a'), compiles('spawn-b')]), /spawn-a and spawn-b each made request compiles/);
});

test('versions.txt is compared on disk: missing, the same, differing with the moves named, and written by an update', () => {
  const dir = mkdtempSync(join(tmpdir(), 'versions-'));
  try {
    const at = (cm) => versionsText({ release: { tag: 'v1', versions: {} }, candidate: { versions: { '@animalabs/context-manager': cm } } });
    assert.deepEqual(compareVersions(dir, at('1.0.0')), { state: 'missing', changes: [] });
    assert.deepEqual(compareVersions(dir, at('1.0.0'), { update: true }), { state: 'updated', changes: [] });
    assert.equal(readFileSync(join(dir, 'versions.txt'), 'utf-8'), at('1.0.0'));
    assert.deepEqual(compareVersions(dir, at('1.0.0')), { state: 'same', changes: [] });
    assert.deepEqual(compareVersions(dir, at('1.0.1')), { state: 'differs', changes: ['candidate context-manager 1.0.0 → 1.0.1'] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('two different texts that would take one key make the record refuse to be written, naming both', () => {
  const t = (shaped) => ({ base: 'call-same-words', words: ['same'], shaped });
  assert.deepEqual(nameTemplates([t('one'), t('two')]).length, 2);
  assert.throws(() => nameTemplates([t('one'), t('two')], () => '000000000000'), /two different texts take the template name call-same-words-000000000000: "one" and "two"/);
});

test('a summary is named by its sources as they stood at each compile, so one whose sources change later keeps its earlier name on earlier lines', () => {
  const sum = { participant: 'summary', content: 'what happened' };
  const sumLine = (seq) => line(seq, [{ sources: ['s:L1-1@1'], content: 's1' }]);
  const store = (sources) => ({ fixture: { messages: [['1', ['[[c:a.in]]']], ['2', ['[[c:b.in]]']], ['3', ['[[c:c.in]]']]], summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sources, parent: null, content: 's1' }] } });
  const lg = [
    { kind: 'compiles', step: 'q.1', blobs: { s1: sum }, store: store(['1', '2']), lines: [sumLine(1)] },
    { kind: 'compiles', step: 'q.2', blobs: {}, store: store(['1', '2', '3']), lines: [sumLine(2)] },
  ];
  const compiles = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n').filter((l) => l.startsWith('  compile'));
  assert.match(compiles[0], /L1\(a\.in-b\.in\)/, 'its sources at the first compile');
  assert.match(compiles[1], /L1\(a\.in-c\.in\)/);
});

test('an agent\'s names count only the messages its own store reports, not another slot\'s raw members its compile carried', () => {
  const st = { reader: { messages: [['1', ['[[c:t.in]]']], ['3', []]], summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sources: ['3'], parent: null, content: 's1' }] } };
  const lg = [{ kind: 'compiles', step: 'q.1', blobs: { s1: { participant: 'summary', content: 'x' }, f2: text('[[c:f.in]] fixture words') }, store: st, lines: [
    { ...line(1, [m(2, 'f2'), { sources: ['s:L1-1@1'], content: 's1' }]), agent: 'reader' },
  ] }];
  const r = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n');
  assert.ok(r.some((l) => /^  compile \[reader\] .*L1\(t\.in\+1\)/.test(l)), 'the fixture\'s message 2, carried raw, doesn\'t shift the reader\'s message 3 to t.in+2');
});

test('a run where a kv-unified submission id one boot began is begun again in a later boot is refused, naming the id and both boots', () => {
  const batch = (boot, submissions) => ({ kind: 'compiles', boot, submissions, lines: [{ kind: 'request', agent: 'fixture', outcome: 'compiled', stamp: '9' }] });
  assert.equal(unrecordable([], [batch(1, ['fixture:0:1767690000000:0', 'fixture:0:1767690000000:1']), batch(2, ['fixture:0:1767690001000:0'])]), null);
  assert.match(unrecordable([], [batch(1, ['fixture:2:1767690000000:0']), batch(2, ['fixture:2:1767690000000:0'])]), /submission fixture:2:1767690000000:0 was begun in boot 1 and again in boot 2/);
  assert.equal(unrecordable([], [batch(1, ['a']), batch(1, ['b'])]), null, 'one boot\'s later batches add ids of their own');
});

test('a message a store reports removed stops anchoring names from that batch on, as check 11 reads the live store', () => {
  const sum = { participant: 'summary', content: 'what happened' };
  const sumLine = (seq) => line(seq, [{ sources: ['s:L1-1@1'], content: 's1' }]);
  const summaries = [{ id: 'L1-1', level: 1, sourceLevel: 0, sources: ['3'], parent: null, content: 's1' }];
  const lg = [
    { kind: 'compiles', step: 'q.1', blobs: { s1: sum }, store: { fixture: { messages: [['1', ['[[c:a.in]]']], ['2', ['[[c:b.in]]']], ['3', []]], summaries } }, lines: [sumLine(1)] },
    { kind: 'compiles', step: 'q.2', blobs: {}, store: { fixture: { messages: [], removedMessages: ['2'], summaries } }, lines: [sumLine(2)] },
  ];
  const compiles = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n').filter((l) => l.startsWith('  compile'));
  assert.match(compiles[0], /L1\(b\.in\+1\)/, 'while message 2 is held');
  assert.match(compiles[1], /L1\(a\.in\+1\)/, 'once it is removed');
});

test('a raw message is named by the shared namer through the store that holds it: a repeated canary by its occurrence, another slot\'s member with its owner', () => {
  const lg = [{ kind: 'compiles', step: 'q.1', blobs: { a1: text('[[c:a.in]] first'), a2: text('[[c:a.in]] again'), f1: text('[[c:f.in]] the fixture\'s') }, store: {
    fixture: { messages: [['1', ['[[c:a.in]]']], ['2', ['[[c:a.in]]']], ['5', ['[[c:f.in]]']]], summaries: [] },
    reader: { messages: [['9', ['[[c:r.in]]']]], summaries: [] },
  }, lines: [
    line(1, [m(1, 'a1'), m(2, 'a2')]),
    { ...line(2, [m(5, 'f1')]), agent: 'reader', slots: ['fixture'] },
  ] }];
  const r = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n').filter((l) => l.startsWith('  compile'));
  assert.match(r[0], /^  compile a\.in-a\.in:2\b/, 'two occurrences, told apart');
  assert.match(r[1], /^  compile \[reader\] fixture\/f\.in\b/, 'the fixture\'s message in the reader\'s compile, with its owner');
});

test('a summary\'s ends are the messages its store holds at that compile, so a removed source no longer names an end', () => {
  const sum = { participant: 'summary', content: 'what happened' };
  const summaries = [{ id: 'L1-1', level: 1, sourceLevel: 0, sources: ['2', '3'], parent: null, content: 's1' }];
  const lg = [
    { kind: 'compiles', step: 'q.1', blobs: { s1: sum }, store: { fixture: { messages: [['1', ['[[c:a.in]]']], ['2', ['[[c:b.in]]']], ['3', []]], summaries } }, lines: [line(1, [{ sources: ['s:L1-1@1'], content: 's1' }])] },
    { kind: 'compiles', step: 'q.2', blobs: {}, store: { fixture: { messages: [], removedMessages: ['2'], summaries } }, lines: [line(2, [{ sources: ['s:L1-1@1'], content: 's1' }])] },
  ];
  const r = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n').filter((l) => l.startsWith('  compile'));
  assert.match(r[0], /L1\(b\.in-b\.in\+1\)/);
  assert.match(r[1], /L1\(a\.in\+1\)/, 'message 2 is removed, so the summary ends at 3 alone, named after a.in');
});

test('a message another slot\'s store reports, carried raw in a later compile, doesn\'t move an agent\'s own messages apart in its earlier lines', () => {
  const b = { a: text('[[c:a.in]] one'), c: text('[[c:c.in]] three'), f: text('[[c:f.in]] the fixture\'s') };
  const store = { reader: { messages: [['1', ['[[c:a.in]]']], ['3', ['[[c:c.in]]']]], summaries: [] }, fixture: { messages: [['2', ['[[c:f.in]]']]], summaries: [] } };
  const rl = (seq, ms) => ({ ...line(seq, ms), agent: 'reader', slots: ['fixture'] });
  const lg = [
    { kind: 'compiles', step: 'q.1', blobs: b, store, lines: [rl(1, [m(1, 'a'), m(3, 'c')])] },
    { kind: 'compiles', step: 'q.2', blobs: {}, lines: [rl(2, [m(1, 'a'), m(2, 'f'), m(3, 'c')])] },
  ];
  const r = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n').filter((l) => l.startsWith('  compile'));
  assert.match(r[0], /^  compile \[reader\] a\.in-c\.in\b/, 'the reader\'s 1 and 3 are adjacent in its own store');
});

test('a message first reported in a later batch anchors an earlier compile\'s names only if it\'s newer than every message reported by then, so a restored older message doesn\'t', () => {
  const sum = { participant: 'summary', content: 'what happened' };
  const summaries = [{ id: 'L1-1', level: 1, sourceLevel: 0, sources: ['3'], parent: null, content: 's1' }];
  const lg = [
    { kind: 'compiles', step: 'q.1', blobs: { s1: sum }, store: { fixture: { messages: [['1', ['[[c:a.in]]']], ['3', []]], summaries } }, lines: [line(1, [{ sources: ['s:L1-1@1'], content: 's1' }])] },
    { kind: 'compiles', step: 'q.2', blobs: {}, store: { fixture: { messages: [['2', ['[[c:b.in]]']]], summaries } }, lines: [line(2, [{ sources: ['s:L1-1@1'], content: 's1' }])] },
  ];
  const r = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n').filter((l) => l.startsWith('  compile'));
  assert.match(r[0], /L1\(a\.in\+1\)/, 'message 2, older than 3, isn\'t held until it\'s reported');
  assert.match(r[1], /L1\(b\.in\+1\)/);
});

test('a canary the stand-in and names.mjs accept, such as one with an at sign, names the same message in the record', () => {
  const lg = [{ kind: 'compiles', step: 'q.1', blobs: { a: text('[[c:a.in@x]] one') }, store: { fixture: { messages: [['1', ['[[c:a.in@x]]']]], summaries: [] } }, lines: [line(1, [m(1, 'a')])] }];
  const r = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n').filter((l) => l.startsWith('  compile'));
  assert.match(r[0], /^  compile a\.in@x\b/);
});

test('the record\'s totals count the compiles each part of check 11 couldn\'t judge, and why, by agent', () => {
  const unjudged = log.map((e) => (e.kind === 'compiles' && e.step === 'p.2' ? { ...e, lines: e.lines.map((l, i) => ({ ...l, unjudged: ['budget: PassthroughStrategy gives no render stats'], ...(i === 1 ? { agent: 'Subconscious' } : {}) })) } : e));
  const totals = renderRecord({ header, log: unjudged, records, end: { ok: true } }).split('\n').find((l) => l.startsWith('totals '));
  assert.deepEqual(JSON.parse(totals.slice('totals '.length)).unjudged, { 'budget: PassthroughStrategy gives no render stats': 1, '[Subconscious] budget: PassthroughStrategy gives no render stats': 1 });
  const plain = renderRecord({ header, log, records, end: { ok: true } }).split('\n').find((l) => l.startsWith('totals '));
  assert.equal(JSON.parse(plain.slice('totals '.length)).unjudged, undefined, 'a run with every compile judged carries no such count');
});

test('a compile that sent no request keeps its place before the request its own batch compiled next, though a request logged before the batch sorts after both', () => {
  const lg = [
    { kind: 'request', step: 'q', request: { id: 'r9', kind: 'summariser' } },
    { kind: 'compiles', step: 'q', blobs, lines: [
      { seq: 1, agent: 'fixture', kind: 'dry', outcome: 'compiled', messages: [m(1, 'b1')] },
      line(1, [m(1, 'b1'), m(4, 'b4', true)]),
    ] },
  ];
  const recs = [
    { id: 'a1', seq: 3, kind: 'agent', agent: 'primary', step: 'q', arrived: '15', messages: [] },
    { id: 'r9', seq: 5, kind: 'summariser', step: 'q', messages: [{ blocks: [{ canaries: ['[[c:p.1.in]]'] }] }], answer: { shape: 'summary' } },
  ];
  const r = renderRecord({ header, log: lg, records: recs, end: { ok: true } }).split('\n');
  const step = r.slice(r.indexOf('step q') + 1, r.indexOf('end ok'));
  const dry = step.findIndex((l) => l.startsWith('  compile dry'));
  const sent = step.findIndex((l) => l.startsWith('  compile ') && !l.startsWith('  compile dry'));
  const call = step.findIndex((l) => l.startsWith('  call '));
  assert.ok(dry >= 0 && sent >= 0 && call >= 0, step.join('\n'));
  assert.ok(dry < sent && sent < call, `the batch's order, then the call that arrived after its request:\n${step.join('\n')}`);
});

test('a whole listing at the run\'s first boot is the store as the run began, writing nothing; one for an agent first seen later writes what it holds; one after a restart reports what went since', () => {
  const sum = (id, sources, content) => ({ id, level: 1, sourceLevel: 0, sources, parent: null, content });
  const said = (t) => ({ participant: 'summary', content: t });
  const held = [['1', ['[[c:a.in]]']], ['2', ['[[c:b.in]]']], ['4', []]];
  const lg = [
    { kind: 'compiles', step: null, at: 'boot', boot: 1, blobs: { s1: said('one'), s2: said('two'), s3: said('three'), s4: said('four') }, store: { fixture: { whole: true, messages: held, summaries: [sum('L1-1', ['1'], 's1'), sum('L1-2', ['2'], 's2'), sum('L1-4', ['4'], 's4')] } }, lines: [] },
    { kind: 'compiles', step: 'q.1', boot: 1, blobs: {}, store: { fixture: { summaries: [sum('L1-3', ['1'], 's3')] }, sub: { whole: true, messages: [['9', ['[[c:s.in]]']]], summaries: [sum('S-1', ['9'], 's1')] } }, lines: [line(1, [{ sources: ['s:L1-4@1'], content: 's4' }])] },
    { kind: 'compiles', step: 'q.2', at: 'boot', boot: 2, blobs: {}, store: { fixture: { whole: true, messages: [['1', ['[[c:a.in]]']], ['4', []]], summaries: [sum('L1-1', ['1'], 's1'), sum('L1-3', ['1'], 's3'), sum('L1-4', ['4'], 's4')] } }, lines: [] },
    { kind: 'compiles', step: 'q.3', boot: 2, blobs: {}, lines: [line(1, [{ sources: ['s:L1-4@1'], content: 's4' }])] },
  ];
  const r = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n');
  const section = (step) => { const at = r.indexOf(`step ${step}`); const next = r.findIndex((l, i) => i > at && !l.startsWith('  ')); return r.slice(at + 1, next); };
  assert.deepEqual(r.filter((l) => l.startsWith('  wrote')).map((l) => l.split(' [T:')[0]), ['  wrote L1(a.in)', '  wrote [sub] L1(s.in)'], 'L1-1 and L1-2 were the store as the run began, so the only lines are q.1\'s');
  assert.deepEqual(section('q.1').filter((l) => l.startsWith('  wrote')).map((l) => l.split(' [T:')[0]), ['  wrote L1(a.in)', '  wrote [sub] L1(s.in)'], 'step q.1 wrote one, and every summary of an agent first seen there is new');
  assert.deepEqual(section('q.2'), ['  removed L1(-)'], 'the restart\'s listing lacks L1-2 and its one source, so it is named as a delta reporting both would name it, and nothing else changed');
  assert.match(section('q.1').find((l) => l.startsWith('  compile')), /L1\(b\.in\+1\)/, 'message 4, which L1-4 covers, is named past message 2 while 2 is held');
  assert.match(section('q.3').find((l) => l.startsWith('  compile')), /L1\(a\.in\+1\)/, 'and past message 1 once the restart\'s listing lacks 2');
});

test('a restart\'s whole listing of an empty store reports every summary it held as removed', () => {
  const sum = (id, sources, content) => ({ id, level: 1, sourceLevel: 0, sources, parent: null, content });
  const lg = [
    { kind: 'compiles', step: null, at: 'boot', boot: 1, blobs: { s1: { participant: 'summary', content: 'one' } }, store: { fixture: { whole: true, messages: [['1', ['[[c:a.in]]']]], summaries: [sum('L1-1', ['1'], 's1')] } }, lines: [] },
    { kind: 'compiles', step: 'q.1', at: 'boot', boot: 2, blobs: {}, store: { fixture: { whole: true, messages: [], summaries: [] } }, lines: [] },
  ];
  const r = renderRecord({ header, log: lg, records: [], end: { ok: true } }).split('\n');
  const at = r.indexOf('step q.1');
  assert.ok(at >= 0, r.join('\n'));
  assert.ok(r[at + 1]?.startsWith('  removed L1('), r.join('\n'));
});

test('a request\'s head line names its URL\'s query when it has one', () => {
  const head = { model: 'm', maxTokens: 100, toolChoice: null, thinking: null, system: [], tools: [], rest: null };
  const req = (id, query) => ({ id, arrived: '11', kind: 'agent', agent: 'primary', step: 'q.1', stream: true, head: { ...head, ...(query ? { query } : {}) }, messages: [{ role: 'user', digest: 'd1', blocks: [{ type: 'text', canaries: ['[[c:q.1.in]]'] }] }], answer: { shape: 'reply' } });
  const lg = [
    { kind: 'compiles', step: 'q.1', blobs: { u1: text('[[c:q.1.in]] a') }, lines: [line(1, [m(1, 'u1')])] },
    { kind: 'request', step: 'q.1', request: { id: 'a1', kind: 'agent' } },
  ];
  const heads = (r) => renderRecord({ header, log: lg, records: [r], end: { ok: true } }).split('\n').filter((l) => l.startsWith('H:'));
  assert.ok(heads(req('a1', 'beta=true'))[0].endsWith(', query beta=true'), heads(req('a1', 'beta=true'))[0]);
  assert.ok(!heads(req('a1', null))[0].includes('query'));
});

test('versions.txt is updated only when every run was updated, by name: a list that repeats one run and leaves out another is not every run', () => {
  const every = ['a', 'b', 'c'];
  const updated = (run) => ({ run, record: 'updated' });
  assert.equal(recordLib.everyRunUpdated(every, [updated('a'), updated('b'), updated('c')]), true);
  assert.equal(recordLib.everyRunUpdated(every, [updated('a'), updated('b'), updated('b')]), false);
  assert.equal(recordLib.everyRunUpdated(every, [updated('a'), updated('b'), { run: 'c', record: 'same' }]), false);
});

test('a record ends with each check\'s judged count, so a drop that stays above zero moves a line', () => {
  const judged = [{ check: 1, name: 'every turn answers', judged: 12 }, { check: 4, name: 'coverage', judged: 7 }, { check: 13, name: 'pairing fixture', judged: null }];
  const text = renderRecord({ header, log: [], records: [], end: { ok: true }, judged });
  const tail = text.trimEnd().split('\n').slice(-2);
  assert.match(tail[0], /^totals /);
  assert.equal(tail[1], 'judged 1 every turn answers 12, 4 coverage 7, 13 pairing fixture ?');
  assert.ok(!/^judged /m.test(renderRecord({ header, log: [], records: [], end: { ok: true } })), 'a record made with no counts has no judged line');
});
