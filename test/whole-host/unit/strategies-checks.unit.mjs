import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assemblies, bindingControl, budgets, compileInvariants, compileKinds, pairing, reloads, requestPairs, declaredProducts, everyTurnAnswers, wellFormed, windowsRaw, calibrationEdge, coverage, bookkeeping } from '../lib/strategies/checks.mjs';
import { continuation, products, configurations, L3_PRODUCT } from '../lib/strategies/script.mjs';
import { RUNS, WORKLOADS, runOf, toolBlocksLost } from '../lib/strategies/workloads.mjs';

const msg = (role, ...blocks) => ({ role, blocks });
const text = (canaries) => ({ type: 'text', chars: 10, ...(canaries ? { canaries } : {}) });
const call = (id) => ({ type: 'tool_use', chars: 10, toolUseId: id });
const result = (id, images) => ({ type: 'tool_result', chars: 10, toolUseId: id, ...(images ? { images } : {}) });

test('check 2 names each segment whose product no record in it shows, and only those', () => {
  const script = continuation();
  const wanted = products(configurations().H1);
  const records = [
    { id: 'r1', step: 'c.cm.1', kind: 'summariser', level: 1, answer: { shape: 'summary' } },
    { id: 'r2', step: 'c.tool', kind: 'agent', messages: [msg('user', text()), msg('assistant', call('a'), call('b')), msg('user', result('a'), result('b', 1))] },
    { id: 'r3', step: 'c.par', kind: 'agent', messages: [msg('assistant', call('a'), call('b'), call('c')), msg('user', result('a'), result('b'), result('c'))] },
  ];
  const missing = declaredProducts(records, script, wanted);
  assert.deepEqual(missing.map((m) => m.segment), ['close-merge', 'parallel', 'thinking-call', 'debt']);
  assert.deepEqual(missing[0].missing, ['a merge request', 'an L3 merge request']);
});

test('check 2: close-merge declares an L3 merge, which a merge at L3 meets with the merge product', () => {
  const script = continuation();
  const wanted = products(configurations().H1);
  const l1 = { id: 'r1', step: 'c.cm.1', kind: 'summariser', level: 1, answer: { shape: 'summary' } };
  const atLevel = (level) => ({ id: `m${level}`, step: 'c.cm.2', kind: 'summariser', level, answer: { shape: 'summary' } });
  const closeMerge = (records) => declaredProducts(records, script, wanted).find((m) => m.segment === 'close-merge')?.missing ?? [];
  assert.deepEqual(closeMerge([l1, atLevel(2)]), [L3_PRODUCT]);
  assert.deepEqual(closeMerge([l1, atLevel(3)]), []);
});

test('check 2: a configuration that doesn\'t summarise declares no summariser products', () => {
  const missing = declaredProducts([], continuation(), products(configurations().H3));
  assert.deepEqual(missing.map((m) => m.segment), ['tool-round', 'parallel', 'thinking-call']);
});

test('check 1 flags unclassified and refused requests, failure events and unsettled checkpoints', () => {
  const flags = everyTurnAnswers(
    [{ id: 'r1', step: 's', kind: 'agent' }, { id: 'r2', step: 's', kind: 'unclassified', reason: 'x' }, { id: 'r3', step: 't', kind: 'agent', refused: 'window' }],
    [{ kind: 'ipc', step: 'u', event: { type: 'inference:failed', error: 'boom' } }, { kind: 'settle', phase: 'end', step: 'v', settled: false }, { kind: 'settle', phase: 'end', step: 'w', settled: true }],
  );
  assert.deepEqual(flags.map((f) => f.step), ['s', 't', 'u', 'v']);
  assert.ok(flags.every((f) => f.check === 1));
});

test('check 3 flags roles out of turn and calls parted from their results, either way', () => {
  const ok = { id: 'ok', step: 's', kind: 'agent', messages: [msg('user', text()), msg('assistant', call('a')), msg('user', result('a'))] };
  const twice = { id: 'twice', step: 's', kind: 'agent', messages: [msg('user', text()), msg('user', text())] };
  const orphan = { id: 'orphan', step: 's', kind: 'agent', messages: [msg('user', text()), msg('assistant', text()), msg('user', result('a'))] };
  const unanswered = { id: 'unanswered', step: 's', kind: 'summariser', messages: [msg('assistant', call('a')), msg('user', text()), msg('assistant', text()), msg('user', text())] };
  // A call in the last message is the model's own turn to come, and waits for nothing.
  const lastCall = { id: 'last', step: 's', kind: 'agent', messages: [msg('user', text()), msg('assistant', call('a'))] };
  const flags = wellFormed([ok, twice, orphan, unanswered, lastCall]);
  assert.deepEqual(flags.map((f) => f.request), ['twice', 'orphan', 'unanswered']);
});

const carrying = (...canaries) => ({ type: 'text', chars: 10, canaries });
const summaryBlock = (...summaries) => ({ type: 'text', chars: 10, summaries });
const turnStep = (id, replies = 1) => ({ id, segment: 's', kind: 'channel', canaries: [`[[c:${id}.in]]`], replies: Array.from({ length: replies }, () => ({ text: 'x' })) });

test('check 6 without a store read still holds a request to the two turns before it, less what was suppressed before it', () => {
  const suppress = { id: 'x', segment: 's', kind: 'suppress', messages: [{ canary: '[[c:a.r1]]' }] };
  const before = [turnStep('a'), turnStep('b'), suppress, turnStep('c')];
  const after = [turnStep('a'), turnStep('b'), turnStep('c'), suppress];
  const req = (canaries) => ({ id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  const withoutSuppressed = req(['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]']);
  assert.deepEqual(windowsRaw([withoutSuppressed], before, [], null), [], 'a.r1 was suppressed before c, so it isn\'t wanted');
  assert.deepEqual(windowsRaw([withoutSuppressed], after, [], null).map((f) => f.message), ['the recent window lacks [[c:a.r1]]'], 'a suppression scripted after c excuses nothing at c');
  const lacking = windowsRaw([req(['[[c:a.in]]', '[[c:b.in]]', '[[c:c.in]]'])], before, [], null);
  assert.deepEqual(lacking.map((f) => f.message), ['the recent window lacks [[c:b.r1]]']);
});

test('check 6 with a store read holds a request to a message an operator suppressed only after it, which the final store no longer holds', () => {
  const after = [turnStep('a'), turnStep('b'), turnStep('c'), { id: 'x', segment: 's', kind: 'suppress', messages: [{ canary: '[[c:a.r1]]' }] }];
  const store = { messages: ['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]', '[[c:c.r1]]'].map((c, i) => ({ id: String(i + 1), canaries: [c] })), summaries: [] };
  const req = (canaries) => ({ id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'])], after, [], store).map((f) => f.message), ['the recent window lacks [[c:a.r1]]']);
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'])], after, [], store), []);
  const failedLater = [{ kind: 'ipc', step: 'a', event: { type: 'inference:failed' } }];
  assert.deepEqual(windowsRaw([req(['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'])], after, failedLater, store).map((f) => f.message), ['the recent window lacks [[c:a.r1]]'], 'a reply an operator suppressed was stored, even in a step that failed on a later round');
});

test('check 6 flags a request that loses a raw message of the head the host reported, or lacks the two turns before it raw', () => {
  const script = [turnStep('a'), turnStep('b', 2), turnStep('c'), turnStep('d')];
  const stored = (...canaries) => ({ canaries });
  const store = { messages: [stored(), stored('[[c:p.1.in]]'), stored('[[c:p.1.r1]]'), stored('[[c:p.2.in]]'), stored('[[c:p.2.r1]]'), ...['a.in', 'a.r1', 'b.in', 'b.r1', 'b.r2', 'c.in', 'c.r1', 'd.in'].map((c) => stored(`[[c:${c}]]`))], summaries: [] };
  const log = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { head: { messages: 3, tokens: 50 }, tail: { messages: 0, tokens: 0 } } } } } }];
  const head = msg('user', carrying('[[c:p.1.in]]', '[[c:p.1.r1]]'));
  const full = { id: 'ok', step: 'd', kind: 'agent', messages: [head, msg('assistant', summaryBlock('[[s:P1]]')), msg('user', carrying('[[c:b.in]]', '[[c:b.r1]]', '[[c:b.r2]]', '[[c:c.in]]', '[[c:c.r1]]', '[[c:d.in]]'))] };
  const noHead = { ...full, id: 'nohead', messages: [msg('user', carrying('[[c:p.1.in]]')), ...full.messages.slice(1)] };
  const noRecent = { ...full, id: 'norecent', messages: [head, msg('user', carrying('[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]', '[[c:c.r1]]'))] };
  const flags = [full, noHead, noRecent].flatMap((r) => windowsRaw([r], script, log, store));
  assert.deepEqual(flags.map((f) => f.request), ['nohead', 'norecent'], 'p.2, past the reported head, may fold');
  assert.match(flags[0].message, /p\.1\.r1/);
  assert.match(flags[1].message, /b\.r2/);
  const sized = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { tail: { messages: 0, tokens: 0 } } } } } }];
  assert.deepEqual(windowsRaw([full], script, sized, store).map((f) => f.message), ["no head size was reported at segment s's checkpoint"]);
  assert.deepEqual(windowsRaw([noHead, full], script, sized, store).map((f) => [f.request, f.message]), [['ok', "no head size was reported at segment s's checkpoint"]], 'once a segment, on its last request');
  assert.deepEqual(windowsRaw([noHead], script, [], store).filter((f) => /head/.test(f.message)), [], 'a segment that ends at no checkpoint, as a workload\'s, has no head to hold it to');
  assert.deepEqual(windowsRaw([noHead], script, log, null), [], 'with no store read, only the recent window is checked');
});
test('check 6 holds only a segment\'s last request to the head its checkpoint reported, since the panel describes that compile alone', () => {
  const script = [turnStep('a'), turnStep('b', 2), turnStep('c'), turnStep('d')];
  const stored = (...canaries) => ({ canaries });
  const store = { messages: [stored(), stored('[[c:p.1.in]]'), stored('[[c:p.1.r1]]'), stored('[[c:p.2.in]]'), stored('[[c:p.2.r1]]'), ...['a.in', 'a.r1', 'b.in', 'b.r1', 'b.r2', 'c.in', 'c.r1', 'd.in'].map((c) => stored(`[[c:${c}]]`))], summaries: [] };
  const log = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { head: { messages: 3, tokens: 50 }, tail: { messages: 0, tokens: 0 } } } } } }];
  // c's compile had a head of two messages, so p.1.r1 reached it inside P1; by the checkpoint the head had grown to three.
  const early = { id: 'early', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]')), msg('assistant', summaryBlock('[[s:P1]]')), msg('user', carrying('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:b.r2]]', '[[c:c.in]]'))] };
  const last = { id: 'last', step: 'd', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]', '[[c:p.1.r1]]')), msg('assistant', summaryBlock('[[s:P2]]')), msg('user', carrying('[[c:b.in]]', '[[c:b.r1]]', '[[c:b.r2]]', '[[c:c.in]]', '[[c:c.r1]]', '[[c:d.in]]'))] };
  const lastLost = { ...last, id: 'last-lost', messages: [msg('user', carrying('[[c:p.1.in]]')), ...last.messages.slice(1)] };
  assert.deepEqual(windowsRaw([early, last], script, log, store), []);
  assert.deepEqual(windowsRaw([early, lastLost], script, log, store).map((f) => [f.request, f.message]), [['last-lost', "the head window's [[c:p.1.r1]] isn't raw"]]);
});
test('check 6 asks a request for a head message only once it was stored, through the turn\'s own earlier replies', () => {
  const script = [turnStep('p.1', 2), turnStep('p.2')];
  const stored = (...canaries) => ({ canaries });
  const store = { messages: ['p.1.in', 'p.1.r1', 'p.1.r2', 'p.2.in', 'p.2.r1'].map((c) => stored(`[[c:${c}]]`)), summaries: [] };
  const log = [{ kind: 'checkpoint', name: 's', health: { data: { contextComposition: { fixture: { head: { messages: 5, tokens: 50 }, tail: { messages: 0, tokens: 0 } } } } } }];
  const first = { id: 'first', step: 'p.1', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]'))] };
  const second = { id: 'second', step: 'p.1', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]')), msg('assistant', carrying('[[c:p.1.r1]]'))] };
  const secondLost = { id: 'second-lost', step: 'p.1', kind: 'agent', messages: [msg('user', carrying('[[c:p.1.in]]'))] };
  assert.deepEqual(windowsRaw([first], script, log, store), [], 'the first request isn\'t asked for its own reply');
  assert.deepEqual(windowsRaw([first, second], script, log, store), []);
  const flags = windowsRaw([first, secondLost], script, log, store);
  assert.deepEqual(flags.map((f) => [f.request, f.message]), [['second-lost', "the head window's [[c:p.1.r1]] isn't raw"]]);
});
test('check 10 flags a multiplier at either clamp edge, wherever the health panel puts it, and nothing inside them', () => {
  const at = (m) => ({ kind: 'checkpoint', step: 's', name: 'n', health: { contextComposition: { fixture: { calibration: { multiplier: m } } } } });
  const flags = calibrationEdge([at(1.3), at(0.6), at(1.8), at(1.79), { kind: 'settle' }]);
  assert.deepEqual(flags.map((f) => f.message.match(/\(([\d.]+)\)/)[1]), ['0.6', '1.8']);
});

test('check 10 says it couldn\'t judge where a health read failed, or where a completed adaptive run logged no end-of-run read at all', () => {
  const end = { kind: 'end', ok: true };
  const read = (health, more = {}) => ({ kind: 'health', name: 'end', step: 's.9', health, ...more });
  const whats = (log, adaptive = true) => calibrationEdge(log, { adaptive }).map((f) => f.what);
  assert.deepEqual(whats([read({ ok: true, data: { contextComposition: { fixture: { calibration: { multiplier: 1.2 } } } } }), end]), []);
  assert.deepEqual(whats([read({ ok: false, error: 'healthSnapshot threw' }), end]), ['unread-panel'], 'a panel op that failed');
  assert.deepEqual(whats([read({ ok: false, error: '' }), end]), ['unread-panel'], 'one that failed with an empty error');
  assert.deepEqual(whats([read({ ok: true, data: { contextComposition: {}, readFailures: { fixture: { contextComposition: 'getRenderStats threw' } } } }), end]), ['unread-panel'], 'a composition read that threw');
  assert.deepEqual(whats([read(undefined, { skipped: 'the run\'s last step stopped its host' }), end]), [], 'an end read the driver says it skipped');
  assert.deepEqual(whats([end]), ['no-end-read'], 'a completed adaptive run with no end read, read or skipped');
  assert.deepEqual(whats([end], false), [], 'not for a passthrough run');
  assert.deepEqual(whats([{ kind: 'end', ok: false }]), [], 'nor for a run that failed before its end');
});

const store = {
  messages: [
    { id: 'm1', canaries: ['[[c:a.in]]'] }, { id: 'm2', canaries: ['[[c:a.r1]]'] },
    { id: 'm3', canaries: ['[[c:b.in]]'] }, { id: 'm4', canaries: ['[[c:b.r1]]'] },
    { id: 'm5', canaries: ['[[c:c.in]]'] }, { id: 'm6', canaries: [] },
  ],
  summaries: [
    { id: 'L1-1', level: 1, sourceLevel: 0, sourceIds: ['m1', 'm2'], number: '[[s:C1]]', covers: ['[[c:a.in]]', '[[c:a.r1]]'] },
    { id: 'L1-2', level: 1, sourceLevel: 0, sourceIds: ['m3', 'm4', 'm6'], number: '[[s:C2]]', covers: ['[[c:b.in]]', '[[c:b.r1]]'] },
    { id: 'L2-1', level: 2, sourceLevel: 1, sourceIds: ['L1-1', 'L1-2'], number: '[[s:C3]]', covers: ['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]'] },
  ],
};

test('check 4: each message stored before a request reaches it raw or in a summary, once, and an unmapped summary is flagged', () => {
  const ok = { id: 'ok', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:b.in]]', '[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]'))] };
  const merged = { id: 'merged', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const lost = { id: 'lost', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const twice = { id: 'twice', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:b.in]]', '[[c:c.in]]'))] };
  const unmapped = { id: 'unmapped', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]', '[[s:P9]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const flags = [ok, merged, lost, twice, unmapped].flatMap((r) => coverage([r], store));
  assert.deepEqual(flags.map((f) => f.request), ['lost', 'twice', 'unmapped']);
  assert.match(flags[0].message, /b\.in.*b\.r1/);
});

test('check 4: a step\'s later request also needs that step\'s earlier replies', () => {
  const first = { id: 'one', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const second = { id: 'two', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const flags = coverage([first, second], store);
  assert.deepEqual(flags.map((f) => f.request), ['two']);
  assert.match(flags[0].message, /c\.r1/);
});

test('check 5: a summary declares only what its request showed, a child by its number or by all it covers', () => {
  const shown = (number, canaries, summaries = []) => ({ id: number, step: 's', kind: 'summariser', answer: { summary: number }, sent: { canaries, summaries } });
  const flags = bookkeeping([
    shown('[[s:C1]]', ['[[c:a.in]]', '[[c:a.r1]]']),
    shown('[[s:C2]]', ['[[c:b.in]]']),
    shown('[[s:C3]]', ['[[c:a.in]]', '[[c:a.r1]]'], ['[[s:C2]]']),
  ], store);
  assert.deepEqual(flags.map((f) => f.request), ['[[s:C2]]']);
  const childUnseen = bookkeeping([shown('[[s:C3]]', ['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]'])], store);
  assert.match(childUnseen[0].message, /L1-1/);
  // A level above shown its grandchildren's numbers, as an L3 merge is shown L1 memories.
  const l3store = { ...store, summaries: [...store.summaries, { id: 'L3-1', level: 3, sourceLevel: 2, sourceIds: ['L2-1'], number: '[[s:C4]]', covers: ['[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]'] }] };
  assert.deepEqual(bookkeeping([shown('[[s:C4]]', [], ['[[s:C1]]', '[[s:C2]]'])], l3store), []);
  assert.equal(bookkeeping([shown('[[s:C4]]', [], ['[[s:C1]]'])], l3store).length, 1);
  const holed = { ...store, messages: store.messages.filter((m) => m.id !== store.summaries.find((x) => x.number === '[[s:C1]]').sourceIds[0]) };
  const unread = bookkeeping([shown('[[s:C1]]', ['[[c:a.in]]', '[[c:a.r1]]'])], holed);
  assert.deepEqual(unread.map((f) => f.what), ['unread-source']);
  assert.equal(unread.judged, 0);
  const tooled = { ...store, messages: [...store.messages, { id: 't1', canaries: ['[[c:a.call1]]'] }], summaries: [...store.summaries, { id: 'L1-9', level: 1, sourceLevel: 0, sourceIds: ['t1'], number: '[[s:C9]]', covers: ['[[c:a.call1]]'] }] };
  const nothingHeld = bookkeeping([shown('[[s:C9]]', [])], tooled);
  assert.deepEqual(nothingHeld, []);
  assert.equal(nothingHeld.judged, 0, 'a summary of tool results alone holds no source to its request, so it isn\'t counted as judged');
  const merged = { ...tooled, summaries: [...tooled.summaries, { id: 'L2-9', level: 2, sourceLevel: 1, sourceIds: ['L1-9'], number: '[[s:C10]]', covers: ['[[c:a.call1]]'] }] };
  const unshownChild = bookkeeping([shown('[[s:C10]]', [])], merged);
  assert.deepEqual(unshownChild, [], 'a child covering no conversational message, its number not sent, may have gone as its sources raw, which carry nothing to judge by');
  assert.equal(unshownChild.judged, 0, 'so it isn\'t judged, and nothing passes on it');
  const shownChild = bookkeeping([shown('[[s:C10]]', [], ['[[s:C9]]'])], merged);
  assert.deepEqual(shownChild, []);
  assert.equal(shownChild.judged, 1, 'its number sent shows it');
  assert.equal(bookkeeping([shown('[[s:C1]]', ['[[c:a.in]]', '[[c:a.r1]]'])], store).judged, 1);
});

test('K1: check 1 flags the operator alerts the host raises, naming each one\'s kind and message', () => {
  const alert = (step, kind, message) => ({ kind: 'ipc', step, event: { type: 'ops:alert', kind, agentName: 'fixture', message } });
  const flags = everyTurnAnswers([], [
    alert('c.debt', 'compression-quarantine', '1 span(s) in compression quarantine'),
    alert('c.cm.2', 'context-maintenance-failed', 'the tick threw'),
    alert('c.par', 'mcpl-down', 'MCPL server unreachable'),
    { kind: 'ipc', step: 'c.par', event: { type: 'inference:speech' } },
  ]);
  assert.deepEqual(flags.map((f) => [f.check, f.step]), [[1, 'c.debt'], [1, 'c.cm.2'], [1, 'c.par']]);
  assert.match(flags[0].message, /compression-quarantine.*1 span\(s\) in compression quarantine/);
  assert.match(flags[1].message, /context-maintenance-failed.*the tick threw/);
  assert.deepEqual(flags.map((f) => f.what), ['compression-quarantine', 'context-maintenance-failed', 'mcpl-down'], 'K1b: each carries its kind');
  const designed = [{ id: 'w.over', segment: 'w', mayFail: true }, { id: 'w.next', segment: 'w' }];
  const owned = everyTurnAnswers([], [
    { kind: 'ipc', step: 'w.over', event: { type: 'inference:failed' } },
    alert('w.over', 'context-refusal', 'the context was refused'),
    alert('w.over', 'mcpl-down', 'MCPL server unreachable'),
    alert('w.next', 'context-refusal', 'the context was refused'),
  ], designed);
  assert.deepEqual(owned.map((f) => [f.step, f.what]), [['w.over', 'mcpl-down'], ['w.next', 'context-refusal']]);
});

// A checkpoint's health panel as connectome-host 0.15.0 reports the last live compile.
const panel = (name, { budget = 20_000, budgetMet = true, exhausted = false, head, tail } = {}) => ({
  kind: 'checkpoint', name, step: `${name}.cp`,
  health: { data: {
    contextComposition: { fixture: { planVsActual: { planned: 15_000, actual: 15_000, budgetMet, exhausted }, ...(head !== undefined ? { head: { messages: head } } : {}), ...(tail !== undefined ? { tail: { messages: tail } } : {}) } },
    runtimeSettings: { fixture: budget === null ? {} : { contextBudgetTokens: budget, effectiveContextBudgetTokens: budget } },
  } },
});

const asked = (id, step, messageTokens, input, messages, toolUseIds, cached = 0) => ({ id, step, kind: 'agent', maxTokens: 2_048, usage: { input_tokens: input - cached, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 }, messages, answer: { shape: 'reply', stop: toolUseIds.length ? 'tool_use' : 'end_turn', toolUseIds } });
const wholeInput = (r) => r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens;
const opened = (id, step, messageTokens, input = messageTokens + 8_000, calls = [], cached = 0) => asked(id, step, messageTokens, input, [{ role: 'user', digest: `in.${id}`, blocks: [text()] }], calls, cached);
const continued = (before, id, messageTokens, input = messageTokens + 8_000, calls = [], cached = wholeInput(before)) => asked(id, before.step, messageTokens, input, [
  ...before.messages,
  { role: 'assistant', digest: `reply.${before.id}`, blocks: [text(), ...before.answer.toolUseIds.map(call)] },
  { role: 'user', digest: `results.${before.id}`, blocks: before.answer.toolUseIds.map((id) => result(id)) },
], calls, cached);
const started = { kind: 'ipc', event: { type: 'inference:started', agentName: 'fixture' } };
const resumed = { kind: 'ipc', event: { type: 'inference:stream_resumed', agentName: 'fixture' } };
const sent = (id) => ({ kind: 'request', request: { id, kind: 'agent' } });
const budgetReport = (...lines) => ({ kind: 'budget-report', boot: 1, lines: ['--- Stream Token Budgets ---', ...lines], ms: 5 });
const WINDOW_CLAUSE = '; its stream doesn\'t break at this budget mid-turn: for its size, only before a request its 1.0M window can\'t hold';
const compiledAs = (records, compiled, agent = 'fixture') => {
  const turn = new Map();
  const canaryOf = (r) => `[[c:${r.step}.${r.id}]]`;
  const marked = records.map((r) => {
    const key = `${r.agent ?? 'primary'}|${r.step}`;
    if (compiled.includes(r.id)) turn.set(key, canaryOf(r));
    const canary = turn.get(key);
    const arrived = { arrived: String((records.indexOf(r) + 1) * 10) };
    return canary ? { ...r, ...arrived, messages: [...r.messages.slice(0, -1), { ...r.messages.at(-1), blocks: [...r.messages.at(-1).blocks, text([canary])] }] } : { ...r, ...arrived };
  });
  const sentFrom = records.filter((r) => compiled.includes(r.id));
  const steps = [...new Set(sentFrom.map((r) => r.step))];
  const entries = steps.map((step) => ({
    kind: 'compiles', step,
    lines: sentFrom.map((r, i) => [r, i]).filter(([r]) => r.step === step).map(([r, i]) => ({ seq: i + 1, agent, kind: 'request', assembly: i + 1, outcome: 'compiled', stamp: String((records.indexOf(r) + 1) * 10 - 5), messages: [{ sources: ['r:1'], content: `x.${r.id}` }] })),
    blobs: Object.fromEntries(sentFrom.filter((r) => r.step === step).map((r) => [`x.${r.id}`, { role: 'user', content: [{ type: 'text', text: `${canaryOf(r)} words` }] }])),
  }));
  return [marked, entries];
};
const crossingAs = () => {
  const r1 = opened('r1', 'a', 15_000, 29_000, ['t1']);
  const r2 = continued(r1, 'r2', 16_000, 31_000, ['t2']);
  return compiledAs([r1, r2, continued(r2, 'r3', 17_000, 32_000)], ['r1']);
};
const crossing = () => crossingAs()[0];
const R1_COMPILED = crossingAs()[1];
const under = (report) => [...(report ? [report] : []), ...R1_COMPILED, sent('r1'), sent('r2'), sent('r3'), panel('s')];

test('K2e: with the module\'s compile lines, a request is compiled when it arrives after its agent\'s latest compile stamped before it, so a restart that sends what a continuation would is compiled', () => {
  const withCanary = (r, canary, arrived) => ({ ...r, arrived: String(arrived), messages: [...r.messages.slice(0, -1), { ...r.messages.at(-1), blocks: [{ type: 'text', canaries: [canary] }] }] });
  const r1 = withCanary(opened('r1', 'a', 15_000, 23_000, ['t1']), '[[c:a.in]]', 11);
  const r2 = withCanary(continued(r1, 'r2', 19_000, 25_000, ['t2']), '[[c:a.call1]]', 31);
  const r3 = withCanary(continued(r2, 'r3', 20_000, 26_000), '[[c:a.call2]]', 41);
  const b = (id, canary) => ({ [id]: { role: 'user', content: [{ type: 'text', text: `${canary} words` }] } });
  const line = (seq, assembly, content, stamp, outcome = 'compiled') => ({ seq, agent: 'fixture', kind: 'request', assembly, outcome, ...(stamp ? { stamp: String(stamp) } : {}), messages: [{ sources: ['r:1'], content }] });
  const log = [
    { kind: 'compiles', step: 'a', lines: [line(1, 1, 'x1', 10), line(2, 2, 'x2', null, 'refused'), line(3, 2, 'x2', 30), { ...line(4, 3, 'x9', 35), kind: 'dry' }, line(5, 4, 'x5', 50)], blobs: { ...b('x1', '[[c:a.in]]'), ...b('x2', '[[c:a.call1]]'), ...b('x9', '[[c:a.call2]]'), ...b('x5', '[[c:z.in]]') } },
  ];
  const paired = compileKinds([r1, r2, r3], log);
  assert.deepEqual(Object.fromEntries(paired.kinds), { r1: 'compiled', r2: 'compiled', r3: 'continuation' }, 'a refused compile, retried in its assembly, and a dry compile take no request');
  assert.deepEqual(paired.unpaired.map((l) => l.seq), [5], 'a compile no request was sent from');
  assert.equal(compileKinds([r1], [{ kind: 'compiles', lines: [{ ...line(1, 1, 'x1', 10), agent: 'other' }], blobs: b('x1', '[[c:a.in]]') }]), null, 'no line for the agent: nothing to pair by');
  for (const boot of [2, 1]) {
    const twoProcesses = [
      { kind: 'compiles', step: 'a', boot: 1, lines: [line(1, 1, 'x1', 10)], blobs: b('x1', '[[c:a.in]]') },
      { kind: 'compiles', step: 'a', boot, lines: [line(1, 1, 'x2', 30)], blobs: b('x2', '[[c:a.call1]]') },
    ];
    assert.deepEqual(Object.fromEntries(compileKinds([r1, r2], twoProcesses).kinds), { r1: 'compiled', r2: 'compiled' }, `each process's assembly 1 is its own (second boot numbered ${boot})`);
  }
});

test('K2d: a continuation under a report that the window governs the agent\'s stream, at the stand-in\'s window, isn\'t held to the stream bound, and a note says so', () => {
  const { flags, headroom, notes } = budgets(crossing(), [turnStep('a')], under(budgetReport(`  fixture: 30.0k (last: 0, 0%)${WINDOW_CLAUSE}`)), { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags, []);
  assert.deepEqual(headroom.map((h) => h.kind), ['compiled'], 'no continuation headroom against a bound that doesn\'t govern it');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /window/);
});

test('K2d: under a report that the window governs, a window other than the stand-in\'s makes every continuation couldn\'t-judge, smaller or larger', () => {
  for (const [printed, standin] of [['500.0k', 1_000_000], ['2.0M', 1_000_000], ['1.0M', 200_000]]) {
    const clause = WINDOW_CLAUSE.replace('1.0M', printed);
    const { flags, notes } = budgets(crossing(), [turnStep('a')], under(budgetReport(`  fixture: 30.0k (last: 0, 0%)${clause}`)), { streamBound: 30_000, windowTokens: standin });
    assert.deepEqual(flags.map((f) => f.request), ['r2', 'r3'], `${printed} against ${standin}`);
    for (const f of flags) assert.match(f.message, new RegExp(`couldn't judge.*${printed.replace('.', '\\.')}.*${standin}`));
    assert.deepEqual(notes, []);
  }
  const unnamed = budgets(crossing(), [turnStep('a')], under(budgetReport('  fixture: 30.0k (last: 0, 0%); its stream doesn\'t break at this budget mid-turn')), { streamBound: 30_000, windowTokens: 1_000_000 }).flags;
  assert.deepEqual(unnamed.map((f) => f.request), ['r2', 'r3'], 'a clause that names no window');
});

test('K2d: a continuation under a report without that clause is held to the stream bound', () => {
  const { flags, notes } = budgets(crossing(), [turnStep('a')], under(budgetReport('  fixture: 30.0k (last: 0, 0%)')), { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags.map((f) => f.request), ['r3']);
  assert.match(flags[0].message, /31000.*30000/);
  assert.deepEqual(notes, []);
});

test('K2d: with no report for the agent, only a continuation after a round over the stream bound is couldn\'t-judge', () => {
  for (const log of [under(null), under(budgetReport()), under(budgetReport('  other: 30.0k (last: 0, 0%)'))]) {
    const { flags } = budgets(crossing(), [turnStep('a')], log, { streamBound: 30_000, windowTokens: 1_000_000 });
    assert.deepEqual(flags.map((f) => f.request), ['r3'], JSON.stringify(log.map((e) => e.kind)));
    assert.match(flags[0].message, /couldn't judge/);
  }
  const late = budgets(crossing(), [turnStep('a')], [...R1_COMPILED, sent('r1'), sent('r2'), sent('r3'), budgetReport(`  fixture: 30.0k (last: 0, 0%)${WINDOW_CLAUSE}`), panel('s')], { streamBound: 30_000, windowTokens: 1_000_000 }).flags;
  assert.deepEqual(late.map((f) => f.request), ['r3']);
  assert.match(late[0].message, /couldn't judge/);
});

test('K2d: a report whose figure isn\'t the stream bound as the host formats it makes every continuation under it couldn\'t-judge', () => {
  const { flags, headroom } = budgets(crossing(), [turnStep('a')], under(budgetReport('  fixture: 150.0k (last: 0, 0%)')), { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags.map((f) => f.request), ['r2', 'r3'], 'r2 follows a round under the bound and is still couldn\'t-judge');
  for (const f of flags) assert.match(f.message, /couldn't judge.*150\.0k.*30000.*30\.0k/);
  assert.deepEqual(headroom.map((h) => h.kind), ['compiled']);
  assert.deepEqual(budgets(crossing(), [turnStep('a')], under(budgetReport('  fixture: 1.0M (last: 0, 0%)')), { streamBound: 1_000_000, windowTokens: 1_000_000 }).flags, [], 'a million, as the host writes it');
  assert.deepEqual(budgets(crossing(), [turnStep('a')], under(budgetReport('  fixture: 150.0k (last: 0, 0%)')), { windowTokens: 1_000_000 }).flags, [], 'the default bound, as the host writes it');
});

test('K2b: a compiled request is held to the model\'s window by the stand-in\'s count of its whole input, every one of them, and context-manager\'s budgetMet flags nothing', () => {
  const script = [turnStep('a'), { ...turnStep('b'), segment: 't' }];
  const [records, lines] = compiledAs([opened('r1', 'a', 17_952, 30_000), opened('r2', 'a', 18_000, 31_000), opened('r3', 'b', 10_000, 18_000)], ['r1', 'r2', 'r3']);
  const log = [...lines, panel('s'), panel('t', { budgetMet: false, exhausted: true })];
  const { flags, headroom } = budgets(records, script, log, { windowTokens: 30_000 });
  assert.deepEqual(flags.map((f) => [f.check, f.step, f.request]), [[3, 'a', 'r2']]);
  assert.match(flags[0].message, /31000.*30000-token window/);
  assert.deepEqual(headroom.map((h) => [h.segment, h.kind, h.request, h.tokens, h.bound]), [['s', 'compiled', 'r2', 31_000, 30_000], ['t', 'compiled', 'r3', 18_000, 30_000]], 'the least headroom of each segment, against the window');
});

test('K2b: a continuation round is held to the stream bound by its stream\'s fresh input before it, flagged only once that sum is over it', () => {
  const script = [turnStep('a')];
  const r1 = opened('r1', 'a', 15_000, 29_000, ['t1']);
  const r2 = continued(r1, 'r2', 22_000, 31_000, ['t2']);
  const [records, lines] = compiledAs([r1, r2, continued(r2, 'r3', 23_000, 32_000)], ['r1']);
  const log = [...lines, budgetReport('  fixture: 30.0k (last: 0, 0%)'), sent('r1'), sent('r2'), sent('r3'), panel('s')];
  const { flags, headroom } = budgets(records, script, log, { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags.map((f) => f.request), ['r3'], 'r2 may cross the bound, since r1\'s fresh 29,000 was under it; r3 follows r1\'s and r2\'s fresh 31,000');
  assert.match(flags[0].message, /31000.*30000/);
  assert.deepEqual(headroom.filter((h) => h.kind === 'continuation').map((h) => [h.request, h.tokens, h.bound]), [['r3', 32_000, 30_000]]);
  assert.equal(budgets(records, script, [...lines, panel('s')], { windowTokens: 1_000_000 }).flags.length, 0, 'under agent-framework 0.28.0\'s default bound, 150,000, none is over');
  assert.deepEqual(budgets(records, script, [...lines, panel('s', { budgetMet: false })], { windowTokens: 1_000_000 }).flags, [], 'context-manager\'s budgetMet is no flag');
});

test('K2b: a continuation is held to its stream\'s fresh input so far, as membrane sums it, not to the whole input of the request before it', () => {
  const script = [turnStep('a')];
  const w1 = opened('w1', 'a', 20_000, 31_000, ['t1'], 2_000);
  const [warm, warmLines] = compiledAs([w1, continued(w1, 'w2', 21_000, 32_000)], ['w1']);
  assert.deepEqual(budgets(warm, script, [...warmLines, budgetReport('  fixture: 30.0k (last: 0, 0%)'), panel('s')], { streamBound: 30_000, windowTokens: 1_000_000 }).flags, []);
  const x1 = opened('x1', 'a', 12_000, 20_000, ['t1']);
  const x2 = continued(x1, 'x2', 14_000, 25_000, ['t2'], 10_000);
  const [missed, missedLines] = compiledAs([x1, x2, continued(x2, 'x3', 15_000, 27_000)], ['x1']);
  const { flags } = budgets(missed, script, [...missedLines, budgetReport('  fixture: 30.0k (last: 0, 0%)'), sent('x1'), sent('x2'), sent('x3'), panel('s')], { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags.map((f) => f.request), ['x3']);
  assert.match(flags[0].message, /fresh input reached 35000 tokens, over the stream bound 30000/);
  const wide = budgets(warm, script, [...warmLines, budgetReport('  fixture: 300.0k (last: 0, 0%)'), panel('s')], { streamBound: 300_000, windowTokens: 31_500 }).flags;
  assert.deepEqual(wide.map((f) => f.request), ['w2']);
  assert.match(wide[0].message, /continuation round's whole input at 32000 tokens, over the model's 31500-token window/);
});

test('K2b: for a second agent, check 3 judges its own requests (the stand-in\'s sub records) and none of the primary\'s', () => {
  const sub = (r) => ({ ...r, agent: 'sub' });
  const s1 = sub(opened('s1', 'a', 2_000, 10_000, ['t1']));
  const s2 = sub(continued(s1, 's2', 2_100, 11_000, ['t2']));
  const s3 = sub(continued(s2, 's3', 2_200, 12_000));
  const p1 = { ...opened('p1', 'b', 1_000, 9_000), agent: 'primary' };
  const script = [turnStep('a'), turnStep('b')];
  const [subMarked, subLines] = compiledAs([s1, s2, s3, p1], ['s1'], 'knowledge-1');
  const [records, primaryLines] = compiledAs(subMarked, ['p1']);
  const log = [...subLines, ...primaryLines, sent('s1'), sent('s2'), sent('s3'), sent('p1')];
  const forSub = budgets(records, script, log, { agent: 'knowledge-1', streamBound: 100_000, windowTokens: 1_000_000 });
  assert.deepEqual(forSub.flags, []);
  assert.equal(forSub.requests, 3);
  assert.equal(forSub.judged, 3, 'the subagent\'s compiled request and its two continuation rounds');
  assert.deepEqual(forSub.headroom.map((h) => [h.kind, h.request]), [['compiled', 's1'], ['continuation', 's3']]);
  const forPrimary = budgets(records, script, log, { streamBound: 100_000, windowTokens: 1_000_000 });
  assert.equal(forPrimary.requests, 1);
  assert.equal(forPrimary.judged, 1);
});

test('K2b: a request the stand-in answered with a provider error isn\'t judged, and adds nothing to its stream\'s fresh input; the retry is judged', () => {
  const script = [turnStep('a')];
  const failed = { ...opened('r1', 'a', 20_000, 31_000, ['t1']), usage: undefined, answer: { shape: 'error', status: 529 } };
  const retry = opened('r2', 'a', 20_000, 29_000, ['t1']);
  const next = continued(retry, 'r3', 21_000, 30_000);
  const [records, lines] = compiledAs([failed, retry, next], ['r1']);
  const { flags, judged } = budgets(records, script, [...lines, budgetReport('  fixture: 30.0k (last: 0, 0%)'), sent('r1'), sent('r2'), sent('r3'), panel('s')], { streamBound: 30_000, windowTokens: 1_000_000 });
  assert.deepEqual(flags, [], 'the error\'s missing usage is no couldn\'t-judge');
  assert.equal(judged, 2, 'the retry and its continuation');
});

test('K2b: a run with no compile line of the agent\'s, a compiled request with no usage, a check given no window, and a segment with no agent request each say the check couldn\'t judge', () => {
  const script = [turnStep('a'), { ...turnStep('b'), segment: 't' }];
  const lineless = budgets([opened('r1', 'a', 1_000)], [turnStep('a')], [panel('s')], { windowTokens: 1_000_000 });
  assert.deepEqual(lineless.flags.map((f) => [f.check, f.step, f.what]), [[3, 'the run', 'no-compile-lines']]);
  assert.match(lineless.flags[0].message, /couldn't judge fixture's 1 request\(s\): the log holds no request compile line of fixture's/);
  assert.equal(lineless.judged, null, 'judged none, and counted as unknown rather than as nothing judged');
  const primaryLine = compiledAs([opened('p1', 'a', 1_000)], ['p1'])[1];
  const subLineless = budgets([{ ...opened('s1', 'a', 1_000), agent: 'sub' }], [turnStep('a')], [...primaryLine, panel('s')], { agent: 'knowledge-1', windowTokens: 1_000_000 }).flags;
  assert.match(subLineless[0].message, /couldn't judge knowledge-1's 1 request\(s\)/, 'the primary\'s lines don\'t stand for a second agent\'s');
  const [unusedRecords, unusedLines] = compiledAs([{ ...opened('r1', 'a', 1_000), usage: undefined }], ['r1']);
  const unused = budgets(unusedRecords, [turnStep('a')], [...unusedLines, panel('s')], { windowTokens: 1_000_000 }).flags;
  assert.deepEqual(unused.map((f) => f.request), ['r1']);
  assert.match(unused[0].message, /couldn't judge.*no usage/);
  const [one, oneLine] = compiledAs([opened('r1', 'a', 1_000)], ['r1']);
  const windowless = budgets(one, [turnStep('a')], [...oneLine, panel('s')]).flags;
  assert.deepEqual(windowless.map((f) => f.request), ['r1']);
  assert.match(windowless[0].message, /couldn't judge.*no window/);
  const [two, twoLines] = compiledAs([opened('r1', 'a', 1_000), opened('r2', 'b', 1_000)], ['r1', 'r2']);
  assert.deepEqual(budgets(two, script, [...twoLines, panel('s'), panel('t', { budget: 30_000 })], { windowTokens: 1_000_000 }).flags, [], 'a budget that moved between checkpoints bounds nothing the check reads');
  assert.equal(budgets([], [turnStep('a')], [panel('s')], { windowTokens: 1_000_000 }).flags.length, 1, 'a checkpoint whose segment made no agent request is a flag');
});

test('K2b: a continuation round with no usage recorded, or with no window given, is couldn\'t-judge, as a compiled request is', () => {
  const script = [turnStep('a')];
  const r1 = opened('r1', 'a', 10_000, 12_000, ['t1']);
  const [records, lines] = compiledAs([r1, { ...continued(r1, 'r2', 11_000, 13_000), usage: undefined }], ['r1']);
  const { flags, judged } = budgets(records, script, [...lines, sent('r1'), sent('r2'), panel('s')], { windowTokens: 1_000_000 });
  assert.deepEqual(flags.map((f) => f.request), ['r2']);
  assert.match(flags[0].message, /couldn't judge this continuation round: the stand-in recorded no usage for it/);
  assert.equal(judged, 1, 'the compiled request alone');
  const [whole, wholeLines] = compiledAs([r1, continued(r1, 'r2', 11_000, 13_000)], ['r1']);
  const windowless = budgets(whole, script, [...wholeLines, sent('r1'), sent('r2'), panel('s')]).flags;
  assert.deepEqual(windowless.map((f) => f.request), ['r1', 'r2']);
  assert.match(windowless[1].message, /couldn't judge this continuation round: the check was given no window/);
});

test('W5 judges only bodies stored in parts that context-manager sent whole: one without its tool blocks flags and one with them counts; one sent altered or missing a shard, and an ordinary message, count for nothing; a failed read is couldn\'t-judge', () => {
  const run = (read, sources, ...blocks) => ({
    log: [
      { kind: 'read', op: 'messages', answer: read },
      { kind: 'compiles', step: 'w', lines: [{ seq: 1, agent: 'fixture', kind: 'request', assembly: 1, outcome: 'compiled', stamp: '10', messages: sources.map((id) => ({ sources: [`r:${id}`], content: 'x' })) }], blobs: { x: { role: 'user', content: [{ type: 'text', text: '[[c:w.in]] words' }] } } },
    ],
    records: [{ id: 'r1', kind: 'agent', step: 'w', arrived: '11', messages: [msg('user', ...blocks, text(['[[c:w.in]]']))] }],
  });
  const plain = [{ id: '1', blocks: [{ type: 'tool_use', id: 't1' }] }, { id: '2', blocks: [{ type: 'tool_result', toolUseId: 't1' }] }];
  const parts = [{ id: '3', bodyGroupId: 'g', blocks: [{ type: 'tool_result', toolUseId: 't2' }] }, { id: '4', bodyGroupId: 'g', blocks: [{ type: 'text' }] }];
  const ordinary = toolBlocksLost(run(plain, ['1', '2'], call('t1'), result('t1')));
  assert.deepEqual([ordinary.length, ordinary.judged], [0, 0], 'an unsharded message isn\'t what W5 judges');
  const kept = toolBlocksLost(run([...plain, ...parts], ['1', '2', '3', '4'], call('t1'), result('t1'), result('t2')));
  assert.deepEqual([kept.length, kept.judged], [0, 1]);
  const lost = toolBlocksLost(run([...plain, ...parts], ['1', '2', '3', '4'], call('t1'), result('t1')));
  assert.equal(lost.judged, 1);
  assert.match(lost[0].message, /g went out whole but without its tool blocks tool_result:t2/);
  const altered = toolBlocksLost(run([...plain, ...parts], ['1', '2', '3!content', '4!content'], call('t1'), result('t1')));
  assert.deepEqual([altered.length, altered.judged], [0, 0], 'a body context-manager sent altered, as its pairing repair does when a call\'s result isn\'t sent, isn\'t judged: check 3 judges the pairs');
  const partial = toolBlocksLost(run([...plain, ...parts], ['1', '2', '3!shards'], call('t1'), result('t1')));
  assert.deepEqual([partial.length, partial.judged], [0, 0], 'a body missing a shard isn\'t judged');
  const unread = toolBlocksLost({ log: [{ kind: 'read', op: 'messages', step: 'w', answer: { unreadable: 'the store is closed' } }], records: [] });
  assert.equal(unread.judged, 0);
  assert.match(unread[0].message, /couldn't judge: the store's messages couldn't be read \(the store is closed\)/);
});

test('requestPairs: each compiled assembly takes the request that arrives after it, before its agent compiles again; a refusal retried in its assembly counts once; a subagent\'s requests pair only with its own lines', () => {
  const withCanary = (r, canary, agent, arrived) => ({ ...r, ...(agent ? { agent } : {}), arrived: String(arrived), messages: [...r.messages.slice(0, -1), { ...r.messages.at(-1), blocks: [{ type: 'text', canaries: [canary] }] }] });
  const p1 = withCanary(opened('p1', 'a', 1_000, undefined, ['t1']), '[[c:a.in]]', 'primary', 11);
  const s1 = withCanary(opened('s1', 'a', 900), '[[c:a.task]]', 'sub', 21);
  const p2 = withCanary(continued(p1, 'p2', 1_100), '[[c:a.in]]', 'primary', 31);
  const p3 = withCanary(opened('p3', 'a', 1_000), '[[c:b.in]]', 'primary', 41);
  const b = (id, canary) => ({ [id]: { role: 'user', content: [{ type: 'text', text: `${canary} words` }] } });
  const line = (seq, agent, assembly, content, stamp, outcome = 'compiled') => ({ seq, agent, kind: 'request', assembly, outcome, ...(stamp ? { stamp: String(stamp) } : {}), messages: [{ sources: ['r:1'], content }] });
  const log = [
    { kind: 'compiles', step: 'a', boot: 1, lines: [line(1, 'fixture', 1, 'x1', 10), line(2, 'knowledge', 1, 'xs', 20), line(3, 'fixture', 2, 'x3', null, 'refused'), line(4, 'fixture', 2, 'x3', 40)], blobs: { ...b('x1', '[[c:a.in]]'), ...b('xs', '[[c:a.task]]'), ...b('x3', '[[c:b.in]]') } },
    { kind: 'compiles', step: 'b', boot: 1, lines: [line(5, 'fixture', 3, 'x5', null, 'refused')], blobs: b('x5', '[[c:b.again]]') },
  ];
  assert.deepEqual(assemblies(log).map((l) => [l.seq, l.outcome, l.step]), [[1, 'compiled', 'a'], [4, 'compiled', 'a'], [5, 'refused', 'b']], 'a retried refusal counts once, by its last line; a refusal not retried stays');
  const primary = requestPairs([p1, s1, p2, p3], log);
  assert.deepEqual(primary.pairs.map(({ line: l, request }) => [l.seq, request.id]), [[1, 'p1'], [4, 'p3']]);
  assert.deepEqual(primary.continuations.map((r) => r.id), ['p2']);
  assert.deepEqual([primary.unpaired, primary.disagree], [[], []]);
  const sub = requestPairs([p1, s1, p2, p3], log, 'knowledge');
  assert.deepEqual(sub.pairs.map(({ line: l, request }) => [l.seq, request.id]), [[2, 's1']], 'the second agent\'s lines pair with the stand-in\'s sub requests alone');
  assert.equal(requestPairs([p1], []), null);
});

test('requestPairs by the clock: a round between two compiles carrying one canary stays a round', () => {
  const at = (id, canary, arrived) => {
    const r = opened(id, 'h', 1_000);
    return { ...r, arrived: String(arrived), messages: [{ ...r.messages[0], blocks: [text(canary ? [canary] : undefined)] }] };
  };
  const b = (id, canary) => ({ [id]: { role: 'user', content: [{ type: 'text', text: canary ? `${canary} words` : '[Tune-out wake: chat \u2014 1 addressed message]' }] } });
  const line = (seq, content, stamp) => ({ seq, agent: 'fixture', kind: 'request', assembly: seq, outcome: 'compiled', stamp: String(stamp), messages: [{ sources: ['r:1'], content }] });
  const restart = [{ kind: 'compiles', step: 'h', lines: [line(1, 'x', 10), line(2, 'x', 40)], blobs: b('x', '[[c:h.in]]') }];
  const rounds = requestPairs([at('r1', '[[c:h.in]]', 11), at('ra', '[[c:h.in]]', 21), at('rb', '[[c:h.in]]', 41)], restart);
  assert.deepEqual(rounds.pairs.map(({ line: l, request }) => [l.seq, request.id]), [[1, 'r1'], [2, 'rb']], 'the round sent before the second compile doesn\'t take it');
  assert.deepEqual(rounds.continuations.map((r) => r.id), ['ra']);
});

test('requestPairs by the clock: a compile never sent leaves the next compile\'s request to it, though the request carries its canary', () => {
  const at = (id, canary, arrived) => {
    const r = opened(id, 'h', 1_000);
    return { ...r, arrived: String(arrived), messages: [{ ...r.messages[0], blocks: [text(canary ? [canary] : undefined)] }] };
  };
  const b = (id, canary) => ({ [id]: { role: 'user', content: [{ type: 'text', text: canary ? `${canary} words` : '[Tune-out wake: chat \u2014 1 addressed message]' }] } });
  const line = (seq, content, stamp) => ({ seq, agent: 'fixture', kind: 'request', assembly: seq, outcome: 'compiled', stamp: String(stamp), messages: [{ sources: ['r:1'], content }] });
  const unsent = [{ kind: 'compiles', step: 'h', lines: [line(1, 'x', 10), line(2, 'x', 20), line(3, 'x', 30)], blobs: b('x', '[[c:h.in]]') }];
  const retried = requestPairs([at('r1', '[[c:h.in]]', 11), at('r3', '[[c:h.in]]', 31)], unsent);
  assert.deepEqual(retried.pairs.map(({ line: l, request }) => [l.seq, request.id]), [[1, 'r1'], [3, 'r3']]);
  assert.deepEqual(retried.unpaired.map((l) => l.seq), [2], 'named unsent, though the next request carries its canary');
  const wake = [{ kind: 'compiles', step: 'h', lines: [line(1, 'w', 10)], blobs: b('w', null) }];
  assert.deepEqual(requestPairs([at('r1', null, 11)], wake).pairs.map(({ request }) => request.id), ['r1'], 'a compile and request with no canary at all');
});

test('requestPairs: a compile or request with no stamp, or a pair whose request doesn\'t end on its compile\'s last canary, leaves check 13 unable to judge the agent, never pairing silently', () => {
  const r1 = { ...opened('r1', 'h', 1_000), messages: [{ role: 'user', digest: 'd', blocks: [text(['[[c:h.in]]'])] }] };
  const b = { x: { role: 'user', content: [{ type: 'text', text: '[[c:h.in]] words' }] }, y: { role: 'user', content: [{ type: 'text', text: '[[c:h.other]] words' }] } };
  const line = (content, stamp) => ({ seq: 1, agent: 'fixture', kind: 'request', assembly: 1, outcome: 'compiled', ...(stamp ? { stamp } : {}), messages: [{ sources: ['r:1'], content }] });
  const log = (l) => [{ kind: 'compiles', step: 'h', lines: [l], blobs: b }];
  assert.deepEqual(pairing([{ ...r1, arrived: '11' }], log(line('x'))).map((f) => f.what), ['fixture:unstamped'], 'a compile with no stamp');
  assert.deepEqual(pairing([r1], log(line('x', '10'))).map((f) => f.what), ['fixture:unstamped'], 'a request with no arrival stamp');
  assert.deepEqual(pairing([{ ...r1, arrived: '11' }], log(line('y', '10'))).map((f) => f.what), ['fixture:disagree']);
  assert.equal(pairing([{ ...r1, arrived: '11' }], log(line('y', '10'))).judged, null);
  assert.deepEqual(pairing([{ ...r1, arrived: '11' }], log(line('x', '10'))), []);
});

test('check 13: a request compile no stand-in request took is a flag at its batch\'s step; a run whose compiles all paired, or with no compile lines, has none', () => {
  const r1 = { ...opened('r1', 'a', 1_000, undefined, ['t1']), arrived: '11' };
  r1.messages[0] = { ...r1.messages[0], blocks: [{ type: 'text', canaries: ['[[c:a.in]]'] }] };
  const b = (id, canary) => ({ [id]: { role: 'user', content: [{ type: 'text', text: `${canary} words` }] } });
  const line = (seq, assembly, content, stamp) => ({ seq, agent: 'fixture', kind: 'request', assembly, outcome: 'compiled', stamp: String(stamp), messages: [{ sources: ['r:1'], content }] });
  const log = [
    { kind: 'compiles', step: 'a', lines: [line(1, 1, 'x1', 10)], blobs: b('x1', '[[c:a.in]]') },
    { kind: 'compiles', step: 'b', lines: [line(2, 2, 'x2', 20)], blobs: b('x2', '[[c:b.in]]') },
  ];
  const flags = pairing([r1], log);
  assert.deepEqual(flags.map((f) => [f.check, f.step, f.what]), [[13, 'b', 'fixture:unpaired']]);
  assert.match(flags[0].message, /compile 2 \(assembly 2\) went out in no request: none arrived at the stand-in after it/);
  assert.deepEqual(pairing([r1], log.slice(0, 1)), []);
  assert.deepEqual(pairing([r1], []), [], 'no compile lines: nothing to pair');
});

test('check 12: the dry compile after a restart matches the one before, with image-ref nonces masked; a difference, a changed outcome and a missing line are flags', () => {
  const dry = (seq, contents, system = 'sys', outcome = 'compiled') => ({ seq, agent: 'fixture', kind: 'dry', outcome, ...(outcome === 'refused' ? { error: { class: 'OverBudgetError' } } : {}), messages: contents.map((content, i) => ({ sources: [`r:m${i}`], content })), system });
  const blobs = { a: 'one [ref img_loxiqa_1]', b: 'two', a2: 'one [ref img_68l20r_1]', c: 'three', sys: [{ text: 'x' }] };
  const run = (before, after) => [
    { kind: 'compiles', boot: 1, lines: [before], blobs },
    { kind: 'compiles', boot: 2, lines: [after], blobs: {} },
    { kind: 'reload', step: 'r.restart', agent: 'fixture', before: { boot: 1, seq: before.seq }, after: { boot: 2, seq: after.seq } },
  ];
  assert.deepEqual(reloads(run(dry(7, ['a', 'b']), dry(1, ['a2', 'b']))), [], 'a nonce made fresh by the new process is no difference');
  const changed = reloads(run(dry(7, ['a', 'b']), dry(1, ['a', 'c'])));
  assert.deepEqual(changed.map((f) => [f.check, f.step]), [[12, 'r.restart']]);
  assert.match(changed[0].message, /differs from the one before at message 1 of 2 before and 2 after/);
  assert.match(reloads(run(dry(7, ['a']), dry(1, [], 'sys', 'refused')))[0].message, /refused \(OverBudgetError\), where before it compiled/);
  const moved = dry(1, ['a', 'b']);
  moved.messages[1] = { ...moved.messages[1], sources: ['r:m9'] };
  const resourced = reloads(run(dry(7, ['a', 'b']), moved));
  assert.equal(resourced.length, 1);
  assert.match(resourced[0].message, /differs from the one before at message 1 of 2 before and 2 after \(sources \["r:m1"\] before, \["r:m9"\] after\)/, 'the same content from another stored message');
  const resystemed = reloads(run(dry(7, ['a', 'b']), dry(1, ['a', 'b'], 'c')));
  assert.deepEqual(resystemed.map((f) => f.message), ['after the restart the dry compile\'s system injections differ from the ones before']);
  const missing = reloads([{ kind: 'compiles', boot: 1, lines: [dry(7, ['a'])], blobs }, { kind: 'reload', step: 'r.restart', before: { boot: 1, seq: 7 }, after: { boot: 2, seq: null } }]);
  assert.match(missing[0].message, /couldn't judge the reload: the log holds no dry compile line after it/);
});

test('check 11: each breach a compile line carries is a flag, named by agent, kind and invariant, and so is a compile the module couldn\'t record', () => {
  const log = [
    { kind: 'compiles', step: 'a', lines: [
      { seq: 1, agent: 'fixture', kind: 'request', outcome: 'compiled', violations: [] },
      { seq: 2, agent: 'fixture', kind: 'request', outcome: 'compiled', violations: [{ invariant: 'budget', detail: '30100 tokens against an input budget of 29952 and a grace of 0' }] },
    ] },
    { kind: 'settle', step: 'b' },
    { kind: 'compiles', step: 'b', lines: [
      { seq: 3, agent: 'fixture', kind: 'other', outcome: 'refused', violations: [] },
      { seq: 4, agent: 'researcher', kind: 'dry', outcome: 'unrecordable', reason: 'getAllMessages threw' },
      { seq: 5, agent: 'researcher', kind: 'request', outcome: 'compiled', violations: [{ invariant: 'coverage', detail: '1 stored bodies in no message sent: m9' }, { invariant: 'shape', detail: 'message 2: result t1 answers no call in the message before it' }] },
    ] },
  ];
  const flags = compileInvariants(log);
  assert.deepEqual(flags.map((f) => [f.check, f.step, f.what]), [
    [11, 'a', 'fixture:request:budget'],
    [11, 'b', 'researcher:dry:unrecordable'],
    [11, 'b', 'researcher:request:coverage'],
    [11, 'b', 'researcher:request:shape'],
  ]);
  assert.match(flags[0].message, /fixture's request compile 2 breaks budget: 30100 tokens/);
  assert.match(flags[1].message, /couldn't record researcher's dry compile 4: getAllMessages threw/);
  assert.deepEqual(compileInvariants([]), [], 'a log with no compile lines has nothing to flag');
  assert.equal(flags.besides, undefined, 'nothing unplaced, nothing beside the count');
  const unplaced = compileInvariants([{ kind: 'compiles', step: 'a', lines: [
    { seq: 1, agent: 'fixture', kind: 'request', outcome: 'compiled', violations: [{ invariant: 'unplaced', count: 2, detail: 'store order couldn\'t place 2 of what was sent' }] },
    { seq: 2, agent: 'fixture', kind: 'request', outcome: 'compiled', violations: [{ invariant: 'unplaced', count: 1, detail: 'store order couldn\'t place 1 of what was sent' }] },
  ] }]);
  assert.deepEqual([unplaced.length, unplaced.judged, unplaced.besides], [2, 2, 'store order couldn\'t place 3 of what was sent'], 'each a flag, the compiles judged, and the count beside them');
  assert.match(unplaced[0].message, /^couldn't judge all of fixture's request compile 1: store order couldn't place 2/, 'a couldn\'t-judge, not a breach');
  const besides = compileInvariants([{ kind: 'compiles', step: 'a', lines: [
    { seq: 1, agent: 'fixture', kind: 'request', outcome: 'compiled', violations: [], unjudged: ['budget: PassthroughStrategy gives no render stats'] },
    { seq: 2, agent: 'fixture', kind: 'request', outcome: 'compiled', violations: [{ invariant: 'unreadable', detail: 'listPins: failed; pins weren\'t judged' }], unjudged: ['budget: PassthroughStrategy gives no render stats'] },
  ] }]);
  assert.deepEqual(besides.map((f) => [f.what, f.message]), [['fixture:request:unreadable', 'couldn\'t judge all of fixture\'s request compile 2: listPins: failed; pins weren\'t judged']], 'a budget its strategy gives no stats for is counted, not flagged');
  assert.equal(besides.besides, 'budget couldn\'t be judged in 2, as PassthroughStrategy gives no render stats; 1 read an invariant needed failed');
});

// K3b and K6b: a store whose head window was reset at a topic transition (context-manager's marker).
const resetStore = {
  messages: [
    { id: 'm1', canaries: ['[[c:a.in]]'] }, { id: 'm2', canaries: ['[[c:a.r1]]'] },
    { id: 'm3', canaries: [], topicTransition: true },
    { id: 'm4', canaries: ['[[c:b.in]]'] }, { id: 'm5', canaries: ['[[c:b.r1]]'] },
    { id: 'm6', canaries: ['[[c:c.in]]'] },
  ],
  summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sourceIds: ['m1', 'm2'], number: '[[s:C1]]', covers: ['[[c:a.in]]', '[[c:a.r1]]'] }],
};
const resetScript = [turnStep('a'), turnStep('b'), turnStep('c')];
const headOf3 = [panel('s', { head: 3, tail: 0 })];

test('K3b: after a head-window reset, store order holds within the head window and within what follows it, not across them', () => {
  // context-manager renders the head (from the transition on) first, then the summary of what came before it.
  const correct = { id: 'correct', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  const swappedHead = { id: 'swapped-head', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.r1]]')), msg('assistant', carrying('[[c:b.in]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  const swappedRest = { id: 'swapped-rest', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]'), summaryBlock('[[s:C1]]'))] };
  const order = (r) => coverage([r], resetStore, resetScript, headOf3).filter((f) => /store order/.test(f.message)).map((f) => f.request);
  assert.deepEqual([correct, swappedHead, swappedRest].flatMap(order), ['swapped-head', 'swapped-rest']);
  // With no head size reported, the request splits at its head's start alone: what was stored from there on, and what was stored before.
  const unsized = (r) => coverage([r], resetStore).filter((f) => /store order/.test(f.message)).map((f) => f.request);
  assert.deepEqual([correct, swappedHead, swappedRest].flatMap(unsized), ['swapped-head']);
});

test('check 4 holds only a segment\'s last request to the head its checkpoint reported; an earlier one splits at the head\'s start alone', () => {
  const store = {
    messages: [...resetStore.messages, { id: 'm7', canaries: ['[[c:c.r1]]'] }, { id: 'm8', canaries: ['[[c:d.in]]'] }],
    summaries: resetStore.summaries,
  };
  const script = [...resetScript, turnStep('d')];
  const headOf2 = [panel('s', { head: 2, tail: 0 })];
  // c's compile had a head of three messages (m3, b.in, b.r1); by the checkpoint it had shrunk to two.
  const early = { id: 'early', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  const last = { id: 'last', step: 'd', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]')), msg('assistant', carrying('[[c:c.r1]]')), msg('user', carrying('[[c:d.in]]'))] };
  const lastSwapped = { ...last, id: 'last-swapped', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', summaryBlock('[[s:C1]]')), ...last.messages.slice(3)] };
  const earlySwapped = { ...early, id: 'early-swapped', messages: [msg('user', carrying('[[c:b.r1]]')), msg('assistant', carrying('[[c:b.in]]')), early.messages[2]] };
  const order = (rs) => coverage(rs, store, script, headOf2).filter((f) => /store order/.test(f.message)).map((f) => f.request);
  assert.deepEqual(order([early, last]), []);
  assert.deepEqual(order([early, lastSwapped]), ['last-swapped'], 'b.r1 is past the reported head, so it comes after the history before the head');
  assert.deepEqual(order([earlySwapped, last]), ['early-swapped'], 'from the head\'s start on, an earlier request still runs in store order');
});

test('K6b: check 6\'s head window starts at the last topic transition stored before the request', () => {
  const r = { id: 'after-reset', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:b.in]]')), msg('assistant', carrying('[[c:b.r1]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  assert.deepEqual(windowsRaw([r], resetScript, headOf3, resetStore).filter((f) => /head window/.test(f.message)), [], 'a.in and a.r1 are before the head now, and may fold');
  const lost = { ...r, id: 'lost', messages: [msg('user', carrying('[[c:b.in]]')), msg('user', summaryBlock('[[s:C1]]'), carrying('[[c:c.in]]'))] };
  assert.match(windowsRaw([lost], resetScript, headOf3, resetStore).find((f) => /head window/.test(f.message))?.message ?? '', /b\.r1/);
});

test('K3: check 4 flags a request whose raw messages and summaries don\'t run in store order', () => {
  const inOrder = { id: 'in-order', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:b.in]]', '[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]'))] };
  const merge = { id: 'merge', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('user', carrying('[[c:c.in]]'))] };
  const swapped = { id: 'swapped', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C2]]', '[[s:C1]]')), msg('user', carrying('[[c:c.in]]'))] };
  const rawFirst = { id: 'raw-first', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:c.in]]')), msg('user', summaryBlock('[[s:C3]]'))] };
  // A raw message inside a summary's span is there twice, which check 4 names as that, not as out of order.
  const twice = { id: 'twice', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('user', carrying('[[c:b.in]]', '[[c:c.in]]'))] };
  const flags = [inOrder, merge, swapped, rawFirst, twice].flatMap((r) => coverage([r], store)).filter((f) => /store order/.test(f.message));
  assert.deepEqual(flags.map((f) => f.request), ['swapped', 'raw-first']);
});

test('K4: check 6 holds a segment\'s last request to the raw tail the host reported, past the two turns before it, among what was stored before it', () => {
  const script = [turnStep('q'), turnStep('p'), turnStep('a'), turnStep('b'), turnStep('c')];
  const stored = (...canaries) => ({ canaries });
  const store = { messages: [...['q.in', 'q.r1', 'p.in', 'p.r1', 'a.in', 'a.r1', 'b.in', 'b.r1'].map((c) => stored(`[[c:${c}]]`)), stored(), stored('[[c:c.in]]'), stored('[[c:c.r1]]')], summaries: [] };
  const all = ['q.in', 'q.r1', 'p.in', 'p.r1', 'a.in', 'a.r1', 'b.in', 'b.r1', 'c.in'].map((c) => `[[c:${c}]]`);
  const without = (c) => all.filter((x) => x !== c);
  const req = (id, step, canaries) => ({ id, step, kind: 'agent', messages: [msg('user', carrying(...canaries))] });
  const log = [panel('s', { head: 1, tail: 7 })];
  // The tail's 7 newest before c's request: p.r1 .. b.r1, the clock row, c.in. c.r1 came after it.
  // Held to that tail, b's request would need q.r1; it isn't the request the panel describes.
  assert.deepEqual(windowsRaw([req('b-early', 'b', without('[[c:q.r1]]')), req('ok', 'c', all)], script, log, store), []);
  const folded = windowsRaw([req('folded', 'c', without('[[c:p.r1]]'))], script, log, store);
  assert.deepEqual(folded.map((f) => [f.check, f.request]), [[6, 'folded']], 'p.r1 is past the two turns before c, inside the reported tail');
  assert.match(folded[0].message, /tail.*p\.r1/);
  const errored = { ...req('err', 'c', all), answer: { shape: 'error', status: 529 } };
  assert.deepEqual(windowsRaw([errored, req('retry', 'c', all)], script, log, store), [], 'an error gave c no reply, so its retry is held to the tail before c.r1');
  const noTail = windowsRaw([req('ok', 'c', all)], script, [panel('s', { head: 1 })], store);
  assert.deepEqual(noTail.map((f) => f.message), ["no tail size was reported at segment s's checkpoint"]);
});

test('K5: close-merge declares its long message stored in parts, from the store, and parallel the tool round\'s image reaching it as its placeholder', () => {
  const script = continuation();
  const wanted = products(configurations().H1);
  const segment = (missing, name) => missing.find((m) => m.segment === name)?.missing ?? [];
  const parts = { messages: [{ id: 'm1', canaries: ['[[c:c.cm.2.in]]'], bodyGroupId: 'g', shardIndex: 0 }, { id: 'm2', canaries: [], bodyGroupId: 'g', shardIndex: 1 }], summaries: [] };
  const whole = { messages: [{ id: 'm1', canaries: ['[[c:c.cm.2.in]]'] }], summaries: [] };
  const LONG = 'the long message stored in parts';
  assert.ok(!segment(declaredProducts([], script, wanted, parts), 'close-merge').includes(LONG));
  assert.ok(segment(declaredProducts([], script, wanted, whole), 'close-merge').includes(LONG));
  assert.ok(!segment(declaredProducts([], script, wanted, null), 'close-merge').includes(LONG), 'with no store read, the store\'s product waits on none');
  const PLACEHOLDER = 'the tool round\'s image as its placeholder';
  const imageCall = script.find((s) => s.id === 'c.tool').replies[0].calls.find((c) => c.input.kind === 'image').input.canary;
  const carryingResult = (images, placeholders) => ({ id: 'r', step: 'c.par', kind: 'agent', messages: [msg('user', { type: 'tool_result', chars: 61, toolUseId: 't', canaries: [imageCall], ...(images ? { images } : {}), ...(placeholders ? { placeholders } : {}) })] });
  assert.ok(!segment(declaredProducts([carryingResult(0, 1)], script, wanted, null), 'parallel').includes(PLACEHOLDER));
  assert.ok(segment(declaredProducts([carryingResult(1, 0)], script, wanted, null), 'parallel').includes(PLACEHOLDER), 'an image still in it isn\'t its placeholder');
  assert.ok(segment(declaredProducts([carryingResult(0, 0)], script, wanted, null), 'parallel').includes(PLACEHOLDER), 'a result that lost its image and holds no placeholder isn\'t one either');
});

test('check 4: a request the stand-in answered with an error gives its step no reply, so its retry needs none', () => {
  const failed = { id: 'r3', step: 'c', kind: 'agent', answer: { shape: 'error', status: 529 }, messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  const retry = { id: 'r4', step: 'c', kind: 'agent', answer: { shape: 'reply' }, messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:c.in]]'))] };
  assert.deepEqual(coverage([failed, retry], store).map((f) => f.request), [], 'the retry is held to what the step had stored, not to a reply the error never gave');
});

test('check 4 on a subagent: its requests are held to its own store up to the last canary each carries, whatever the canaries are named', () => {
  const sub = {
    messages: [{ id: 's1', canaries: ['[[c:k.task]]'] }, { id: 's2', canaries: ['[[c:k.s1]]'] }, { id: 's3', canaries: ['[[c:k.s1call1]]'] }, { id: 's4', canaries: ['[[c:k.s2]]'] }],
    summaries: [{ id: 'L1-9', level: 1, sourceLevel: 0, sourceIds: ['s2', 's3'], number: '[[s:C9]]', covers: ['[[c:k.s1]]', '[[c:k.s1call1]]'] }],
  };
  const whole = { id: 'whole', step: 'k', kind: 'agent', agent: 'sub', messages: [msg('user', carrying('[[c:k.task]]')), msg('assistant', summaryBlock('[[s:C9]]')), msg('user', carrying('[[c:k.s2]]'))] };
  const lost = { id: 'lost', step: 'k', kind: 'agent', agent: 'sub', messages: [msg('user', carrying('[[c:k.task]]')), msg('user', carrying('[[c:k.s2]]'))] };
  const primaryOnly = coverage([whole, lost], sub);
  assert.equal(primaryOnly.judged, 0, 'the primary\'s side judges none of a subagent\'s requests');
  const flags = coverage([whole, lost], sub, [], [], { side: 'sub' });
  assert.equal(flags.judged, 2);
  assert.deepEqual(flags.map((f) => [f.request, f.what]), [['lost', 'not-reached']]);
  assert.match(flags[0].message, /\[\[c:k\.s1\]\] \[\[c:k\.s1call1\]\]/);
});

test('check 6 counts a request as judged only where it held it to some message', () => {
  const script = [{ id: 'a', segment: 's', replies: [{}] }, { id: 'b', segment: 's', replies: [{}] }, { id: 'c', segment: 's', replies: [{}] }];
  const empty = { messages: [], summaries: [] };
  const r = { id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:c.in]]'))] };
  assert.equal(windowsRaw([r], script, [], empty).judged, 0, 'nothing stored, so nothing to hold it to');
  assert.equal(windowsRaw([r], script, [], null).judged, 1, 'without a store read, the script\'s turns hold it');
});

test('the continuation runs from its configuration\'s prefix, which is written from empty at the length stack.json pins', () => {
  const facts = { budget: 100_000, maxTokens: 16_000 };
  const lengths = JSON.parse(readFileSync(new URL('../stack.json', import.meta.url), 'utf-8'));
  const pinned = Object.entries(lengths.prefixTurns);
  assert.deepEqual(pinned.map(([config]) => config).sort(), ['H1', 'H3'], 'the configurations stack.json pins a prefix length for');
  for (const [config, turns] of pinned) {
    const cont = runOf(`${config}/continuation`, configurations(), facts, lengths);
    assert.equal(cont.from, `${config}/prefix`);
    assert.ok(Object.keys(cont.products).length > 0, 'and declares its segments\' products');
    const pre = runOf(`${config}/prefix`, configurations(), facts, lengths);
    assert.equal(pre.from, null);
    assert.equal(pre.steps().filter((st) => st.kind === 'channel').length, turns);
  }
  for (const id of RUNS) {
    const from = runOf(id, configurations(), facts, lengths).from;
    if (from) assert.doesNotThrow(() => runOf(from, configurations(), facts, lengths), `${id} starts from ${from}, a run that exists`);
  }
  assert.equal(runOf('H3/W4', configurations(), facts, lengths).from, 'H3/W1', 'a workload that starts from its configuration\'s checkpoint still does');
});

test('C15: on a binding model every agent request carries the drop control and asks for the beta it needs; a request without either is flagged, and only agent requests are judged', () => {
  const control = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
  const asks = (...beta) => ({ headers: { beta, version: '2023-06-01' } });
  const records = [
    { id: 'r1', step: 'a', kind: 'agent', thinking: control, head: asks('other-beta', 'thinking-binding-controls-2026-08-01') },
    { id: 'r2', step: 'b', kind: 'agent', thinking: { type: 'adaptive' }, head: asks('thinking-binding-controls-2026-08-01') },
    { id: 'r3', step: 'b', kind: 'agent', thinking: null, head: asks('thinking-binding-controls-2026-08-01') },
    { id: 'r4', step: 'c', kind: 'agent', thinking: control, head: asks('other-beta') },
    { id: 'r5', step: 'b', kind: 'summariser', thinking: null, head: asks() },
  ];
  const flags = bindingControl(records);
  assert.equal(flags.judged, 4);
  assert.deepEqual(flags.map((f) => [f.check, f.step, f.what, f.message.split(' ')[1]]), [[15, 'b', 'no-drop-control', 'r2'], [15, 'b', 'no-drop-control', 'r3'], [15, 'c', 'no-binding-beta', 'r4']]);
  assert.deepEqual([...bindingControl([records[0]])], []);
});

test('check 2: thinking-call and debt each pass when their segment produced what it declares, and debt fails a compression between the turn\'s rounds', () => {
  const script = [{ id: 't.1', segment: 'thinking-call', kind: 'channel' }, { id: 'd.1', segment: 'debt', kind: 'channel' }];
  const wanted = products(configurations().H1);
  const thinkingWanted = { 'thinking-call': wanted['thinking-call'] };
  const missing = [{ segment: 'thinking-call', missing: [wanted['thinking-call'][0].name] }];
  const call = { type: 'tool_use', toolUseId: 'toolu_t1' };
  const answering = (canary) => ({ role: 'user', blocks: [{ type: 'tool_result', toolUseId: 'toolu_t1', canaries: [canary] }] });
  const result = answering('[[c:c.think.call1]]');
  const request = (assistantBlocks, rest = [result]) => ({ id: 'a1', seq: 1, step: 't.1', kind: 'agent', messages: [msg('user', carrying('[[c:t.1.in]]')), { role: 'assistant', blocks: assistantBlocks }, ...rest] });
  assert.deepEqual(declaredProducts([request([{ type: 'thinking', signature: 'fx1.abc' }, call])], script, thinkingWanted), [], 'signed thinking leading a call, with the call\'s result');
  assert.deepEqual(declaredProducts([request([{ type: 'thinking', signature: 'fx1.abc' }], [])], script, thinkingWanted), missing, 'signed thinking with no call isn\'t a thinking-led call');
  assert.deepEqual(declaredProducts([request([call, { type: 'thinking', signature: 'fx1.abc' }])], script, thinkingWanted), missing, 'thinking after the call doesn\'t lead it');
  assert.deepEqual(declaredProducts([request([{ type: 'thinking', signature: 'fx1.abc' }, call], [])], script, thinkingWanted), missing, 'a call with no result in the request');
  assert.deepEqual(declaredProducts([request([{ type: 'thinking', signature: 'fx1.abc' }, call], [answering('[[c:p.11.call1]]')])], script, thinkingWanted), missing, 'a thinking-led call the prefix made isn\'t the segment\'s');
  const debtWanted = { debt: wanted.debt };
  const agent = (seq) => ({ id: `d${seq}`, seq, step: 'd.1', kind: 'agent', messages: [], answer: { shape: 'reply' } });
  const answered = (seq, shape) => ({ id: `s${seq}`, seq, step: 'd.1', kind: 'summariser', messages: [], answer: { shape } });
  const parked = [agent(1), agent(2), answered(3, 'summary'), answered(4, 'thinking-only'), answered(5, 'empty'), answered(6, 'max-tokens')];
  assert.deepEqual(declaredProducts(parked, script, debtWanted), []);
  const between = [agent(1), answered(2, 'summary'), agent(3), answered(4, 'thinking-only'), answered(5, 'empty'), answered(6, 'max-tokens')];
  assert.deepEqual(declaredProducts(between, script, debtWanted), [{ segment: 'debt', missing: [wanted.debt[0].name] }]);
});

test('check 12: a fork call\'s UUID and its result\'s are masked together across a dry compile\'s messages, so a result that names another call is a difference', () => {
  const dry = (seq, contents) => ({ seq, agent: 'fixture', kind: 'dry', outcome: 'compiled', messages: contents.map((content, i) => ({ sources: [`r:m${i}`], content })), system: 'sys' });
  const uuid = (c) => `${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}`;
  const blobs = { callA: `call fork-w9-${uuid('a')}`, resA: `result fork-w9-${uuid('a')}`, callB: `call fork-w9-${uuid('b')}`, resB: `result fork-w9-${uuid('b')}`, resC: `result fork-w9-${uuid('c')}`, sys: [] };
  const run = (before, after) => [
    { kind: 'compiles', boot: 1, lines: [before], blobs },
    { kind: 'compiles', boot: 2, lines: [after], blobs: {} },
    { kind: 'reload', step: 'r.restart', agent: 'fixture', before: { boot: 1, seq: before.seq }, after: { boot: 2, seq: after.seq } },
  ];
  assert.deepEqual(reloads(run(dry(7, ['callA', 'resA']), dry(1, ['callB', 'resB']))), [], 'a fresh UUID for the same call and result');
  assert.match(reloads(run(dry(7, ['callA', 'resA']), dry(1, ['callB', 'resC'])))[0].message, /differs from the one before at message 1/);
});

test('check 5 holds a subagent\'s summary to every source it covers, as check 4 does, since a subagent\'s inputs and replies carry their own canaries', () => {
  const store = { messages: [{ id: 'k1', canaries: ['[[c:k.task]]'] }, { id: 'k2', canaries: ['[[c:k.s1]]'] }], summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sourceIds: ['k1', 'k2'], number: '[[s:C1]]', covers: ['[[c:k.task]]', '[[c:k.s1]]'] }] };
  const call = (canaries) => ({ id: 'c1', step: 'k', kind: 'summariser', answer: { summary: '[[s:C1]]' }, sent: { canaries, summaries: [] } });
  const primary = bookkeeping([call([])], store);
  assert.equal(primary.judged, 0, 'by the primary\'s rule these are no turn\'s input or reply');
  const sub = bookkeeping([call(['[[c:k.task]]', '[[c:k.s1]]'])], store, { side: 'sub' });
  assert.deepEqual(sub, []);
  assert.equal(sub.judged, 1);
  assert.deepEqual(bookkeeping([call(['[[c:k.task]]'])], store, { side: 'sub' }).map((f) => f.request), ['c1'], 'a source its request didn\'t show');
});

test('requestPairs: a request stamped the same nanosecond as a compile doesn\'t pair with it', () => {
  const r = { ...opened('r1', 'h', 1_000), arrived: '10', messages: [{ role: 'user', digest: 'd', blocks: [text(['[[c:h.in]]'])] }] };
  const log = [{ kind: 'compiles', step: 'h', lines: [{ seq: 1, agent: 'fixture', kind: 'request', assembly: 1, outcome: 'compiled', stamp: '10', messages: [{ sources: ['r:1'], content: 'x' }] }], blobs: { x: { role: 'user', content: [{ type: 'text', text: '[[c:h.in]] words' }] } } }];
  const paired = requestPairs([r], log);
  assert.deepEqual([paired.pairs.length, paired.unpaired.map((l) => l.seq)], [0, [1]]);
});

test('assemblies: a retry is in the same process, so a restarted process reusing an assembly number with a higher seq starts its own', () => {
  const line = (seq, assembly, outcome = 'compiled') => ({ seq, agent: 'fixture', kind: 'request', assembly, outcome, messages: [] });
  const log = [
    { kind: 'compiles', step: 'a', boot: 1, lines: [line(3, 2)] },
    { kind: 'compiles', step: 'b', boot: 2, lines: [line(5, 2)] },
    { kind: 'compiles', step: 'b', boot: 2, lines: [line(6, 3, 'refused'), line(7, 3)] },
  ];
  assert.deepEqual(assemblies(log).map((l) => [l.boot, l.seq]), [[1, 3], [2, 5], [2, 7]]);
});

test('check 4 counts, beside what it judged, each request it couldn\'t judge because the final store doesn\'t hold its own input', () => {
  const ok = { id: 'ok', step: 'c', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C1]]')), msg('assistant', carrying('[[c:b.in]]', '[[c:b.r1]]')), msg('user', carrying('[[c:c.in]]'))] };
  const gone = { id: 'gone', step: 'z', kind: 'agent', messages: [msg('user', summaryBlock('[[s:C3]]')), msg('assistant', carrying('[[c:z.in]]'))] };
  const both = coverage([ok, gone], store);
  assert.equal(both.judged, 1);
  assert.equal(both.besides, '1 request not judged, as the final store doesn\'t hold its own input');
  assert.equal(coverage([ok], store).besides, undefined, 'nothing is said where every request was judged');
});

test('check 6 counts, beside what it judged, each message of the two turns before a request that it didn\'t ask for because the final store doesn\'t hold it', () => {
  const turns = [turnStep('a'), turnStep('b'), turnStep('c')];
  const withoutA = { messages: ['[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]', '[[c:c.r1]]'].map((c, i) => ({ id: String(i + 1), canaries: [c] })), summaries: [] };
  const req = { id: 'r', step: 'c', kind: 'agent', messages: [msg('user', carrying('[[c:a.in]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'))] };
  const flags = windowsRaw([req], turns, [], withoutA);
  assert.deepEqual([...flags], []);
  assert.equal(flags.besides, '1 recent message not asked for, as the final store doesn\'t hold it');
  const whole = { ...withoutA, messages: [{ id: '0', canaries: ['[[c:a.in]]'] }, { id: '00', canaries: ['[[c:a.r1]]'] }, ...withoutA.messages.slice(1)] };
  assert.equal(windowsRaw([{ ...req, messages: [msg('user', carrying('[[c:a.in]]', '[[c:a.r1]]', '[[c:b.in]]', '[[c:b.r1]]', '[[c:c.in]]'))] }], turns, [], whole).besides, undefined);
});

test('W1 and W2 hold the store to L3 by its end: L3 passes, L2 flags, and a run with no state read, or a configuration that doesn\'t summarise, is couldn\'t-judge', () => {
  const ran = (maxLevel) => ({ log: [{ kind: 'read', op: 'state', step: 'w.70', answer: { maxLevel } }], records: [] });
  for (const w of ['W1', 'W2']) {
    const atL3 = WORKLOADS[w].check(ran(3), { configuration: {} });
    assert.deepEqual([atL3.length, atL3.judged], [0, 1], w);
    const atL2 = WORKLOADS[w].check(ran(2), { configuration: {} });
    assert.equal(atL2.judged, 1);
    assert.deepEqual(atL2.map((f) => f.message), ['the store reached L2 in 70 turns, short of L3'], w);
    const unread = WORKLOADS[w].check({ log: [], records: [] }, { configuration: {} });
    assert.deepEqual([unread.judged, unread[0].message], [0, 'couldn\'t judge: the run logged no state read'], w);
    const plain = WORKLOADS[w].check(ran(3), { configuration: { summarises: false } });
    assert.deepEqual([plain.judged, plain[0].message], [0, 'couldn\'t judge: the property needs a configuration that summarises, and this one doesn\'t'], w);
  }
});

test('W4 flags a call of its own that goes out without thinking ahead of it in its message, and counts each message carrying one', () => {
  const think = { type: 'thinking', chars: 10 };
  const ran = (...blocks) => ({ log: [], records: [{ id: 'r1', kind: 'agent', step: '7.1', messages: [msg('assistant', ...blocks)] }] });
  const led = WORKLOADS.W4.check(ran(think, text(), call('t7_1')), { seed: 7 });
  assert.deepEqual([led.length, led.judged], [0, 1]);
  const bare = WORKLOADS.W4.check(ran(text(), call('t7_1')), { seed: 7 });
  assert.deepEqual(bare.map((f) => f.message), ['request r1: a call went out without its thinking (t7_1)']);
  const after = WORKLOADS.W4.check(ran(call('t7_1'), think), { seed: 7 });
  assert.equal(after.length, 1, 'thinking after the call isn\'t what led to it');
  const other = WORKLOADS.W4.check(ran(text(), call('toolu_fx000001')), { seed: 7 });
  assert.deepEqual([other.length, other.judged], [0, 0], 'a call the workload didn\'t make isn\'t its to judge');
});

test('W5 takes a body from every read, so one removed before the last read still flags where it went out whole without its tool blocks', () => {
  const parts = [{ id: '3', bodyGroupId: 'g', blocks: [{ type: 'tool_result', toolUseId: 't2' }] }, { id: '4', bodyGroupId: 'g', blocks: [{ type: 'text' }] }];
  const run = {
    log: [
      { kind: 'read', op: 'messages', step: 'w', answer: parts },
      { kind: 'compiles', step: 'w', lines: [{ seq: 1, agent: 'fixture', kind: 'request', assembly: 1, outcome: 'compiled', stamp: '10', messages: ['3', '4'].map((id) => ({ sources: [`r:${id}`], content: 'x' })) }], blobs: { x: { role: 'user', content: [{ type: 'text', text: '[[c:w.in]] words' }] } } },
      { kind: 'read', op: 'messages', step: 'z', answer: [] },
    ],
    records: [{ id: 'r1', kind: 'agent', step: 'w', arrived: '11', messages: [msg('user', text(['[[c:w.in]]']))] }],
  };
  const lost = toolBlocksLost(run);
  assert.equal(lost.judged, 1);
  assert.match(lost[0].message, /g went out whole but without its tool blocks tool_result:t2/);
});

test('W6 flags each membrane repair mark a request carries, and counts context-manager\'s own marks beside without flagging them', () => {
  const ran = (...records) => ({ log: [], records });
  const request = (id, ...repairs) => ({ id, kind: 'agent', step: '3.3', messages: [msg('user', { type: 'text', chars: 10, ...(repairs.length ? { repairs } : {}) })] });
  const designed = WORKLOADS.W6.check(ran(request('r1'), request('r2', 'context-manager:omitted')));
  assert.deepEqual([designed.length, designed.judged, designed.besides], [0, 2, '2 request(s), 0 membrane repair mark(s), 1 of context-manager\'s own']);
  const repaired = WORKLOADS.W6.check(ran(request('r1', 'membrane:orphan'), request('r2', 'membrane:pending', 'context-manager:stub')));
  assert.deepEqual(repaired.map((f) => [f.request, f.message]), [
    ['r1', 'request r1 carries membrane\'s orphan repair mark, so context-manager handed it a call or result unpaired'],
    ['r2', 'request r2 carries membrane\'s pending repair mark, so context-manager handed it a call or result unpaired'],
  ]);
  assert.equal(repaired.besides, '2 request(s), 2 membrane repair mark(s), 1 of context-manager\'s own');
});

test('W8 judges the restore: steps 15 and 16 compile again once 1 to 4 did, a later one that doesn\'t flags, and one before the cut that didn\'t compile is couldn\'t-judge', () => {
  const ran = (outcomes) => ({
    log: Object.entries(outcomes).map(([n, outcome], i) => ({ kind: 'compiles', step: `5.${n}`, boot: 1, lines: [{ seq: i + 1, agent: 'fixture', kind: 'request', assembly: i + 1, outcome }] })),
    records: [],
  });
  const all = Object.fromEntries([1, 2, 3, 4, 10, 15, 16].map((n) => [n, n === 10 ? 'refused' : 'compiled']));
  const restored = WORKLOADS.W8.check(ran(all), { seed: 5, configurationName: 'C6h' });
  assert.deepEqual([restored.length, restored.judged], [0, 2], 'a refusal under the cut is the budget\'s');
  const late = WORKLOADS.W8.check(ran({ ...all, 15: 'refused' }), { seed: 5, configurationName: 'C6h' });
  assert.deepEqual(late.map((f) => f.message), ['step 15: refused 2 turn(s) after the budget was restored']);
  const { 16: _, ...without16 } = all;
  assert.deepEqual(WORKLOADS.W8.check(ran(without16), { seed: 5, configurationName: 'C6h' }).map((f) => f.message), ['step 16: no request 3 turn(s) after the budget was restored']);
  const early = WORKLOADS.W8.check(ran({ ...all, 2: 'refused' }), { seed: 5, configurationName: 'C6h' });
  assert.deepEqual([early.judged, early[0].message], [0, 'couldn\'t judge the restore: step 2 refused, before the budget was lowered']);
});

test('W8, H4\'s reader and W11 let a turn end unanswered only between a cut and its restore, and H1/W11\'s scripted 529 makes its step one that retries', () => {
  const steps = (w, ctx) => WORKLOADS[w].steps({ seed: 5, budget: 100_000, reserve: 4_000, configuration: {}, ...ctx });
  const failing = (list) => list.filter((s) => s.mayFail).map((s) => s.id);
  assert.deepEqual(failing(steps('W8', { configurationName: 'C6h' })), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((n) => `5.${n}`));
  assert.deepEqual(failing(steps('W11', { configurationName: 'C6h' })), [9, 10, 11, 12].map((n) => `5.${n}`));
  assert.deepEqual(failing(steps('W8', { configurationName: 'H4' })), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((k) => `5.h${k}`), 'H4\'s reader takes W8\'s window');
  const h1 = steps('W11', { configurationName: 'H1' });
  assert.deepEqual(h1.filter((s) => s.retries).map((s) => s.id), ['5.2']);
  assert.ok(!h1.find((s) => s.id === '5.2').mayFail, 'the retried turn must still answer');
});

test('W11 flags a pin or mark placed by step 8 that the panel no longer lists after the cut or after the restore, counting pins times reads', () => {
  const snapshot = (step, pins) => ({ kind: 'panel', step: `9.${step}`, op: step.endsWith('pins') ? 'pins' : 'pin-add', response: { ok: true, data: { pins } } });
  const placed = [{ id: 'p1', kind: 'pin', level: 0 }, { id: 'd1', kind: 'document', maxLevel: 1 }];
  const ran = (...log) => ({ log, records: [] });
  const held = WORKLOADS.W11.check(ran(snapshot('8.level1', placed), snapshot('12.pins', placed), snapshot('14.pins', placed)), { seed: 9 });
  assert.deepEqual([held.length, held.judged], [0, 4]);
  const cut = WORKLOADS.W11.check(ran(snapshot('8.level1', placed), snapshot('12.pins', placed.slice(0, 1)), snapshot('14.pins', placed)), { seed: 9 });
  assert.equal(cut.judged, 4);
  assert.deepEqual(cut.map((f) => [f.step, f.message]), [['9.12.pins', '1 of the 2 pins and marks placed by step 8 are gone: document to L1']]);
  const unplaced = WORKLOADS.W11.check(ran(snapshot('12.pins', placed)), { seed: 9 });
  assert.deepEqual([unplaced.judged, unplaced[0].message], [0, 'couldn\'t judge: the panel listed no pin once the last was added']);
});

test('a property another check judges names it: the continuation check 2, W7 without refused merges check 1, and W9 check 12', () => {
  assert.equal(WORKLOADS.continuation.check().judgedBy, 2);
  for (const variant of ['merges-rejected', 'fable-no-tools', 'no-tools']) {
    const flags = WORKLOADS.W7.check({ log: [], records: [] }, { variant });
    assert.deepEqual([flags.length, flags.judgedBy], [0, 1], variant);
  }
  assert.equal(WORKLOADS.W9.check().judgedBy, 12);
});

test('check 1 flags a turn whose answer never reached its channel, and a step that retries a scripted error owns only the failure agent-framework retries', () => {
  const undelivered = everyTurnAnswers([], [{ kind: 'undelivered', step: 's.3', reason: 'no route' }], []);
  assert.deepEqual(undelivered.map((f) => f.message), ['the turn\'s answer never reached its channel: the host reported mcpl:speech-route-failed (no route)']);
  const ev = (type) => ({ kind: 'ipc', step: 's.2', event: { type, error: 'overloaded' } });
  const retries = [{ id: 's.2', retries: true }];
  assert.deepEqual([...everyTurnAnswers([], [ev('inference:failed')], retries)], [], 'the retried failure is the step\'s own');
  assert.deepEqual(everyTurnAnswers([], [ev('inference:exhausted')], retries).map((f) => f.message), ['inference:exhausted: overloaded'], 'ending without an answer is not');
  assert.deepEqual([...everyTurnAnswers([], [ev('inference:exhausted')], [{ id: 's.2', mayFail: true }])], [], 'a step that may fail owns it');
});

test('check 12 can\'t judge a reload whose dry compiles refused alike on both sides, and judges one whose refusal changed', () => {
  const line = (outcome, error) => ({ seq: 1, kind: 'dry', outcome, ...(error ? { error: { class: error } } : {}), messages: [] });
  const log = (a, b) => [{ kind: 'compiles', boot: 1, lines: [a], blobs: {} }, { kind: 'compiles', boot: 2, lines: [b], blobs: {} }, { kind: 'reload', step: 'r', before: { boot: 1, seq: 1 }, after: { boot: 2, seq: 1 } }];
  const alike = reloads(log(line('refused', 'OverBudgetError'), line('refused', 'OverBudgetError')));
  assert.deepEqual([alike.judged, alike.map((f) => f.message)], [0, ['couldn\'t judge the reload: the dry compile refused (OverBudgetError) both before the restart and after it']]);
  const moved = reloads(log(line('refused', 'OverBudgetError'), line('compiled')));
  assert.deepEqual([moved.judged, moved.map((f) => f.message)], [1, ['after the restart the dry compile compiled, where before it refused (OverBudgetError)']]);
  const same = reloads(log(line('compiled'), line('compiled')));
  assert.deepEqual([same.length, same.judged], [0, 1]);
});
