import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { perCheckReport, readExpected, runChecks, summaryNamer, workloadReport } from '../lib/strategies/report.mjs';
import { calibrationEdge } from '../lib/strategies/checks.mjs';

const configuration = { name: 'H1/W1' };
const flag = (check, step, message = 'm') => ({ check, step, message });

test('the report passes a run with no flag and every product', () => {
  const r = perCheckReport({ configuration, candidate: { flags: [], missing: [] } });
  assert.equal(r.verdict, 'pass');
  assert.match(r.lines[0], /^H1\/W1: no flags\.$/);
});

test('an expected failure covers the flags its key and match name, and names its finding; an entry no flag meets fails the run; another configuration\'s entry covers nothing', () => {
  const shape = (step) => ({ check: 11, step, what: 'fixture:request:shape', message: 'fixture\'s request compile 45 breaks shape' });
  const entry = (step, more = {}) => ({ configuration: 'H1/W1', check: 11, step, what: 'fixture:request:shape', finding: 'D1', reason: 'passthrough cuts a call from its result', match: '^fixture\'s request compile 45 breaks shape$', ...more });
  const covered = perCheckReport({ configuration, candidate: { flags: [shape('p.42'), shape('p.42'), shape('p.45')], missing: [] }, expected: [entry('p.42'), entry('p.45')] });
  assert.equal(covered.verdict, 'pass');
  assert.equal(covered.expected.length, 3);
  assert.match(covered.lines[0], /^H1\/W1: no flags, 3 expected \(D1\)\.$/);
  assert.ok(covered.lines.some((l) => /check 11 at p\.45: .*\[expected: D1\]/.test(l)));
  const fixed = perCheckReport({ configuration, candidate: { flags: [shape('p.42')], missing: [] }, expected: [entry('p.42'), entry('p.45')] });
  assert.equal(fixed.verdict, 'flags');
  assert.deepEqual(fixed.flags.map((f) => [f.check, f.step, f.what]), [[11, 'p.45', 'fixture:request:shape']]);
  assert.match(fixed.flags[0].message, /expects a flag here for D1 matching \/\^fixture's request compile 45 breaks shape\$\/, and the run raised none: if D1 is fixed, the change that fixed it removes the entry/);
  const unrelated = perCheckReport({ configuration, candidate: { flags: [shape('p.42'), { check: 11, step: 'p.42', what: 'fixture:request:coverage', message: 'm' }], missing: [] }, expected: [entry('p.42', { configuration: 'passthrough' })] });
  assert.equal(unrelated.flags.length, 2, 'an entry for another configuration covers nothing here');
  assert.equal(unrelated.expected.length, 0);
});

test('a flag two entries both cover is a flag of its own, naming both findings, since neither can then tell whether its finding still shows', () => {
  const pins = { check: 11, step: 'p.9', what: 'fixture:request:pins', detail: 'summary 4 at L1 covers 1, inside pin p1 allowing L0', message: 'm' };
  const entry = (finding, match) => ({ configuration: configuration.name, check: 11, step: 'p.9', what: 'fixture:request:pins', match, finding, reason: 'r' });
  const r = perCheckReport({ configuration, candidate: { flags: [pins], missing: [] }, expected: [entry('D3', '^summary 4 at L1 covers 1, inside pin p1 allowing L0$'), entry('D3b', '^summary 4 at L1 covers 1, inside pin p1 allowing L0$')] });
  assert.equal(r.verdict, 'flags');
  assert.equal(r.flags.length, 1);
  assert.match(r.flags[0].message, /entries for D3 and D3b both cover this flag/);
  assert.equal(perCheckReport({ configuration, candidate: { flags: [pins], missing: [] }, expected: [entry('D3', '^summary 4 at L1 covers 1, inside pin p1 allowing L0$')] }).verdict, 'pass');
});

test('the expected failures read: none without the file, and an entry missing a field or an anchored match, naming an unknown configuration or repeating a key throws, naming it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'expected-'));
  const at = (entries) => { const p = join(dir, `e${Math.random()}.json`); writeFileSync(p, JSON.stringify(entries)); return p; };
  const good = { configuration: 'H1/W1', check: 11, step: 'p.42', what: 'fixture:request:shape', finding: 'D1', reason: 'r', match: '^m$' };
  assert.deepEqual(readExpected(join(dir, 'absent.json'), ['H1/W1']), []);
  assert.deepEqual(readExpected(at([good]), ['H1/W1', 'H3/W1']), [good]);
  assert.throws(() => readExpected(at([{ ...good, finding: '' }]), ['H1/W1']), /entry 0: has no finding/);
  assert.throws(() => readExpected(at([good, { ...good, check: '11' }]), ['H1/W1']), /entry 1: has no check number/);
  assert.throws(() => readExpected(at([{ ...good, configuration: 'H9' }]), ['H1/W1']), /entry 0: names a configuration this run has none of: H9/);
  assert.throws(() => readExpected(at([good, { ...good, reason: 'another' }]), ['H1/W1']), /entry 1: repeats another entry/);
  assert.throws(() => readExpected(at({ entries: [] }), ['H1/W1']), /isn't a list of entries/);
  const { what, ...noWhat } = good;
  assert.throws(() => readExpected(at([noWhat]), ['H1/W1']), /entry 0: has no what: an entry covers one kind of flag/);
  const { match, ...noMatch } = good;
  assert.throws(() => readExpected(at([noMatch]), ['H1/W1']), /entry 0: has no match: an entry covers the flags whose whole detail/);
  for (const loose of ['m$', '^m', 'm', '^m\\$', '^known|other$', '^.*$', '^m+$', '^[mn]$', '^lost \\d messages$', '^a\\sb$', '^\\w$', '^\\bm$']) assert.throws(() => readExpected(at([{ ...good, match: loose }]), ['H1/W1']), /entry 0: has a match that isn't an escaped literal between \^ and \$/, loose);
  assert.equal(readExpected(at([{ ...good, match: '^a\\.b \\(c\\) \\$5 \\\\ \\[d\\]$' }]), ['H1/W1']).length, 1, 'an escaped metacharacter or backslash is literal');
  const pins = { ...good, what: 'fixture:request:pins' };
  assert.equal(readExpected(at([{ ...pins, match: '^allowing L0$' }, { ...pins, match: '^allowing L1$', finding: 'D39' }]), ['H1/W1']).length, 2, 'entries sharing a key, each with its own match');
  assert.throws(() => readExpected(at([{ ...pins, match: '^x$' }, { ...pins, match: '^x$', reason: 'again' }]), ['H1/W1']), /entry 1: repeats another entry's configuration, check, step, what and match/);
});

test('an entry\'s match covers the flags whose whole detail it names: D3 and D39 at one step each cover their own, a pins flag of a third shape is a flag, and an entry whose match no flag meets fails the run', () => {
  const pins = (detail) => ({ check: 11, step: 'p.9', what: 'fixture:request:pins', detail, message: `fixture's request compile 9 breaks pins: ${detail}` });
  const entry = (finding, match) => ({ configuration: 'H1/W1', check: 11, step: 'p.9', what: 'fixture:request:pins', match, finding, reason: 'r' });
  const d3 = entry('D3', '^summary 4 sent over raw pin p1, allowing L0$');
  const d39 = entry('D39', '^summary 7 sent under level pin p2, allowing L1$');
  const both = perCheckReport({ configuration, candidate: { flags: [pins('summary 4 sent over raw pin p1, allowing L0'), pins('summary 7 sent under level pin p2, allowing L1')], missing: [] }, expected: [d3, d39] });
  assert.equal(both.verdict, 'pass');
  assert.match(both.lines[0], /^H1\/W1: no flags, 2 expected \(D3, D39\)\.$/);
  assert.ok(both.lines.some((l) => /allowing L1 \[expected: D39\]$/.test(l)));
  const third = perCheckReport({ configuration, candidate: { flags: [pins('summary 4 sent over raw pin p1, allowing L0'), pins('summary 7 sent under level pin p2, allowing L1'), pins('pin p3 names no stored message')], missing: [] }, expected: [d3, d39] });
  assert.deepEqual(third.flags.map((f) => f.detail), ['pin p3 names no stored message'], 'a pins flag neither match finds isn\'t covered');
  const gone = perCheckReport({ configuration, candidate: { flags: [pins('summary 4 sent over raw pin p1, allowing L0')], missing: [] }, expected: [d3, d39] });
  assert.equal(gone.flags.length, 1);
  assert.match(gone.flags[0].message, /expects a flag here for D39 matching \/\^summary 7 sent under level pin p2, allowing L1\$\/, and the run raised none/);
  const noDetail = perCheckReport({ configuration, candidate: { flags: [{ check: 4, step: 'p.9', what: 'more-than-once', message: '3 stored message(s) reach the request more than once' }], missing: [] }, expected: [{ configuration: 'H1/W1', check: 4, step: 'p.9', what: 'more-than-once', match: '^3 stored message\\(s\\) reach the request more than once$', finding: 'D3', reason: 'r' }] });
  assert.equal(noDetail.verdict, 'pass', 'a flag with no detail is matched by its message');
});

test('a clamp-edge calibration makes the run invalid, and the first line says so', () => {
  const r = perCheckReport({ configuration, candidate: { flags: [{ ...flag(10, 'c.cm.cp', 'calibration at the clamp edge (1.8)'), what: 'clamp-edge' }, flag(1, 's')], missing: [] } });
  assert.equal(r.verdict, 'invalid');
  assert.match(r.lines[0], /^INVALID: calibration at the clamp edge \(1\.8\)/);
  const unjudged = perCheckReport({ configuration, candidate: { flags: [{ check: 10, step: 'the run', what: 'judged-none:calibration edge', message: 'couldn\'t judge: check 10 (calibration edge) judged nothing' }], missing: [] } });
  assert.equal(unjudged.verdict, 'flags', 'a check 10 that judged nothing is a flag, with no claim that folds were clamped');
  assert.ok(!unjudged.lines.some((l) => /clamped/.test(l)));
  for (const what of ['unread-panel', 'no-end-read']) {
    const unread = perCheckReport({ configuration, candidate: { flags: [{ check: 10, step: 'the run', what, message: 'couldn\'t judge calibration at the run\'s end' }], missing: [] } });
    assert.equal(unread.verdict, 'flags', `${what} is a couldn't-judge flag, not an invalid run`);
    assert.ok(!unread.lines.some((l) => /clamped|INVALID/.test(l)), `${what} makes no claim that folds were clamped`);
  }
});

test('K1b: the report names each operator alert by its kind, and prints the checks\' notes', () => {
  const alert = (kind) => ({ check: 1, step: 'c.debt', what: kind, message: `the host raised an operator alert, ${kind}: x` });
  const r = perCheckReport({
    configuration,
    candidate: { flags: [alert('compression-quarantine'), alert('mcpl-down')], missing: [], notes: ['a note from the checks'] },
  });
  assert.ok(r.lines.some((l) => /compression-quarantine/.test(l)) && r.lines.some((l) => /mcpl-down/.test(l)));
  assert.ok(r.lines.includes('- a note from the checks'));
});

test('K2d: the checks carry check 3\'s note that the host reported its window governs the agent\'s stream', () => {
  const usage = { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 };
  const r1 = { id: 'r1', step: 'a', kind: 'agent', arrived: '11', maxTokens: 2_048, usage, messages: [{ role: 'user', digest: 'd1', blocks: [{ type: 'text', canaries: ['[[c:a.in]]'] }] }], answer: { shape: 'reply', toolUseIds: ['t1'] } };
  const r2 = { ...r1, id: 'r2', arrived: '21', messages: [...r1.messages, { role: 'assistant', digest: 'd2', blocks: [{ type: 'tool_use', toolUseId: 't1' }] }, { role: 'user', digest: 'd3', blocks: [] }], answer: { shape: 'reply', toolUseIds: [] } };
  const report = { kind: 'budget-report', boot: 1, lines: ['--- Stream Token Budgets ---', '  fixture: 150.0k (last: 0, 0%); its stream doesn\'t break at this budget mid-turn: for its size, only before a request its 1.0M window can\'t hold'] };
  const checkpoint = { kind: 'checkpoint', name: 's', step: 's.cp', health: { data: { contextComposition: { fixture: { planVsActual: { budgetMet: true } } }, runtimeSettings: { fixture: { effectiveContextBudgetTokens: 20_000 } } } } };
  const compiled = { kind: 'compiles', step: 'a', lines: [{ seq: 1, agent: 'fixture', kind: 'request', assembly: 1, outcome: 'compiled', stamp: '10', messages: [{ sources: ['r:1'], content: 'x1' }] }], blobs: { x1: { role: 'user', content: [{ type: 'text', text: '[[c:a.in]] words' }] } } };
  const log = [compiled, report, { kind: 'request', request: { id: 'r1', kind: 'agent' } }, { kind: 'request', request: { id: 'r2', kind: 'agent' } }, checkpoint];
  const { notes } = runChecks({ records: [r1, r2], log, script: [{ id: 'a', segment: 's' }], products: [], store: null, windowTokens: 1_000_000 });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /window/);
});

test('check 13 judges every agent that compiles, each with its own count, so a reader\'s compile no request took is a flag', () => {
  const usage = { input_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const req = (id, agent, canary, arrived) => ({ id, step: 'a', kind: 'agent', agent, arrived, maxTokens: 2_048, usage, messages: [{ role: 'user', digest: `d.${id}`, blocks: [{ type: 'text', canaries: [canary] }] }], answer: { shape: 'reply', toolUseIds: [] } });
  const blob = (canary) => ({ role: 'user', content: [{ type: 'text', text: `${canary} words` }] });
  const line = (seq, agent, content) => ({ seq, agent, kind: 'request', assembly: seq, outcome: 'compiled', stamp: String(seq * 10), messages: [{ sources: ['r:1'], content }] });
  const log = [{ kind: 'compiles', step: 'a', lines: [line(1, 'fixture', 'x1'), line(2, 'Subconscious', 'xs'), line(3, 'Subconscious', 'xl')], blobs: { x1: blob('[[c:a.in]]'), xs: blob('[[c:a.wake]]'), xl: blob('[[c:a.lost]]') } }];
  const { flags, judged } = runChecks({ records: [req('r1', 'primary', '[[c:a.in]]', '11'), req('s1', 'sub', '[[c:a.wake]]', '21')], log, script: [{ id: 'a', segment: 's', kind: 'channel' }], products: [], store: null, windowTokens: 1_000_000 });
  assert.deepEqual(Object.fromEntries(judged.filter((j) => j.check === 13).map((j) => [j.name, j.judged])), { 'pairing fixture': 1, 'pairing Subconscious': 2 });
  assert.deepEqual(flags.filter((f) => f.check === 13).map((f) => [f.step, f.what]), [['a', 'Subconscious:unpaired']]);
});

test('check 13 can\'t judge two agents besides the configuration\'s own, since the stand-in pools their requests: a couldn\'t-judge flag naming both, not a pairing', () => {
  const usage = { input_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const req = (id, agent, canary, arrived) => ({ id, step: 'a', kind: 'agent', agent, arrived, maxTokens: 2_048, usage, messages: [{ role: 'user', digest: `d.${id}`, blocks: [{ type: 'text', canaries: [canary] }] }], answer: { shape: 'reply', toolUseIds: [] } });
  const blob = (canary) => ({ role: 'user', content: [{ type: 'text', text: `${canary} words` }] });
  const line = (seq, agent, content) => ({ seq, agent, kind: 'request', assembly: seq, outcome: 'compiled', stamp: String(seq * 10), messages: [{ sources: ['r:1'], content }] });
  const log = [{ kind: 'compiles', step: 'a', lines: [line(1, 'fixture', 'x1'), line(2, 'Subconscious', 'xs'), line(3, 'knowledge', 'xk')], blobs: { x1: blob('[[c:a.in]]'), xs: blob('[[c:a.wake]]'), xk: blob('[[c:a.task]]') } }];
  const { flags, judged } = runChecks({ records: [req('r1', 'primary', '[[c:a.in]]', '11'), req('s1', 'sub', '[[c:a.wake]]', '21'), req('k1', 'sub', '[[c:a.task]]', '31')], log, script: [{ id: 'a', segment: 's', kind: 'channel' }], products: [], store: null, windowTokens: 1_000_000 });
  assert.deepEqual(flags.filter((f) => f.check === 13).map((f) => f.what), ['Subconscious:shared-side', 'knowledge:shared-side']);
  assert.match(flags.find((f) => f.what === 'knowledge:shared-side').message, /couldn't judge knowledge's pairing: Subconscious and knowledge compile requests/);
  assert.deepEqual(Object.fromEntries(judged.filter((j) => j.check === 13).map((j) => [j.name, j.judged])), { 'pairing fixture': 1, 'pairing Subconscious': null, 'pairing knowledge': null }, 'counted as unknown, so no judged-none flag doubles it');
});

test('judged: every check reports how many items it judged; zero where check 3, 11, 12 or 13 applies is a couldn\'t-judge flag, and the report prints the counts', () => {
  const usage = { input_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const r1 = { id: 'r1', step: 'a', kind: 'agent', agent: 'primary', arrived: '11', maxTokens: 2_048, usage, messages: [{ role: 'user', digest: 'd1', blocks: [{ type: 'text', canaries: ['[[c:a.in]]'] }] }], answer: { shape: 'reply', toolUseIds: [] } };
  const script = [{ id: 'a', segment: 's', kind: 'channel' }];
  const none = runChecks({ records: [r1], log: [], script, products: [], store: null, windowTokens: 1_000_000 });
  const what = none.flags.filter((f) => /^judged-none:/.test(f.what ?? '')).map((f) => [f.check, f.what]);
  assert.deepEqual(what, [[11, 'judged-none:compile invariants'], [13, 'judged-none:pairing fixture']]);
  assert.match(none.flags.find((f) => f.check === 11).message, /couldn't judge: check 11 \(compile invariants\) judged nothing, though it applies/);
  assert.deepEqual(none.flags.filter((f) => f.check === 3).map((f) => f.what), ['no-compile-lines'], 'check 3 can\'t tell a compiled request from a round without the lines, and says so itself');
  const counts = Object.fromEntries(none.judged.map((j) => [`${j.check} ${j.name}`, j.judged]));
  assert.equal(counts['3 budgets'], null, 'counted as unknown, so no judged-none flag doubles check 3\'s own');
  assert.equal(counts['3 request shape'], 1);
  assert.equal(counts['11 compile invariants'], 0);
  const restarted = runChecks({ records: [r1], log: [], script: [...script, { id: 'r', segment: 's', kind: 'restart', reloadCheck: true }], products: [], store: null, windowTokens: 1_000_000 });
  assert.deepEqual(restarted.flags.filter((f) => /^judged-none:/.test(f.what ?? '')).map((f) => f.check), [11, 12, 13]);
  const line = { kind: 'compiles', step: 'a', lines: [{ seq: 1, agent: 'fixture', kind: 'request', assembly: 1, outcome: 'compiled', stamp: '10', messages: [{ sources: ['r:1'], content: 'x1' }] }], blobs: { x1: { role: 'user', content: [{ type: 'text', text: '[[c:a.in]] words' }] } } };
  const unused = runChecks({ records: [{ ...r1, usage: undefined }], log: [line], script, products: [], store: null, windowTokens: 1_000_000 });
  assert.ok(unused.flags.some((f) => f.what === 'judged-none:budgets'));
  assert.deepEqual(runChecks({ records: [], log: [], script: [], products: [], store: null }).flags, []);
  const report = perCheckReport({ configuration, candidate: { flags: [], missing: [], judged: none.judged } });
  assert.ok(report.lines.some((l) => /^- judged: check 1 every turn answers 1, check 2 declared products 0, check 3 request shape 1, check 3 budgets \?, /.test(l)));
});

test('a workload run that lacks a product its segments declare fails, and says which', () => {
  const judged = { flags: [], missing: [{ segment: 'close-merge', missing: ['an L3 merge request'] }], notes: [], judged: [] };
  const r = workloadReport({ id: 'H1/continuation', workload: 'continuation', judged, breaches: [], completed: true });
  assert.equal(r.verdict, 'flags');
  assert.ok(r.lines.includes('- check 2, close-merge: missing an L3 merge request'));
  const whole = workloadReport({ id: 'H1/continuation', workload: 'continuation', judged: { ...judged, missing: [] }, breaches: [], completed: true });
  assert.equal(whole.verdict, 'pass');
});

test('a completed run whose workload property judged nothing is a couldn\'t-judge flag, and one that judged something or didn\'t complete is not', () => {
  const judged = { flags: [], missing: [], notes: [], judged: [] };
  const property = (n, flags = []) => Object.defineProperty([...flags], 'judged', { value: n, enumerable: false });
  const none = workloadReport({ id: 'H1/W1', workload: 'W1', judged, breaches: property(0), completed: true });
  assert.equal(none.verdict, 'flags');
  assert.ok(none.flags.some((f) => f.check === 14 && f.what === 'judged-none:property'));
  assert.equal(workloadReport({ id: 'H1/W1', workload: 'W1', judged, breaches: property(3), completed: true }).verdict, 'pass');
  assert.ok(!workloadReport({ id: 'H1/W1', workload: 'W1', judged, breaches: property(0), completed: false }).flags.some((f) => f.what === 'judged-none:property'), 'a run that stopped early is failed for that, not for this');
});

test('check 2 counts the declared products it judged, and judging none of them where some are declared is a flag', () => {
  const wanted = { s: [{ name: 'a reply', test: (r) => r.kind === 'agent' }] };
  const judged = (script) => runChecks({ records: [], log: [], script, products: wanted, store: null });
  const none = judged([{ id: 'x', segment: 'other' }]);
  assert.ok(none.flags.some((f) => f.check === 2 && f.what === 'judged-none:declared products'), 'its segment never ran, so nothing was judged');
  const ran = judged([{ id: 'a', segment: 's' }]);
  assert.equal(ran.judged.find((j) => j.check === 2).judged, 1);
  assert.deepEqual(ran.missing, [{ segment: 's', missing: ['a reply'] }]);
  assert.ok(!ran.flags.some((f) => f.check === 2));
});

test('R15: check 15 runs only for a binding configuration, and one whose agent sent nothing it could judge is a couldn\'t-judge flag', () => {
  const run = (binds, records) => runChecks({ records, log: [], script: [], products: [], store: null, windowTokens: 1_000_000, binds });
  assert.equal(run(false, []).judged.some((j) => j.check === 15), false);
  assert.deepEqual(run(true, []).flags.filter((f) => f.check === 15).map((f) => f.what), ['judged-none:binding control']);
  const one = run(true, [{ id: 'r1', step: 'a', kind: 'agent', thinking: null, messages: [], answer: { shape: 'reply', toolUseIds: [] } }]);
  assert.deepEqual(one.flags.filter((f) => f.check === 15).map((f) => f.what), ['no-drop-control', 'no-binding-beta']);
  assert.equal(one.judged.find((j) => j.check === 15).judged, 1);
});

test('checks 4, 6 and 10 apply where they can anchor, and judging none there is a flag', () => {
  const usage = { input_tokens: 1_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const req = (id, step, canaries) => ({ id, step, kind: 'agent', agent: 'primary', maxTokens: 2_048, usage, messages: [{ role: 'user', digest: id, blocks: [{ type: 'text', canaries }] }], answer: { shape: 'reply', toolUseIds: [] } });
  const script = [{ id: 'a', segment: 's', kind: 'channel', replies: [{ text: 'x' }] }, { id: 'b', segment: 's', kind: 'channel', replies: [{ text: 'x' }] }];
  const what = (r) => r.flags.filter((f) => /^judged-none:/.test(f.what ?? '')).map((f) => f.check).filter((c) => [4, 6, 10].includes(c));
  const emptyStore = { messages: [], summaries: [] };
  assert.deepEqual(what(runChecks({ records: [req('r1', 'a', [])], log: [], script, products: [], store: emptyStore, windowTokens: 1_000_000 })), [4]);
  const suppressed = [script[0], { id: 'x', segment: 's', kind: 'suppress', messages: [{ canary: '[[c:a.in]]' }, { canary: '[[c:a.r1]]' }] }, script[1]];
  assert.ok(what(runChecks({ records: [req('r2', 'b', [])], log: [], script: suppressed, products: [], store: null, windowTokens: 1_000_000 })).includes(6));
  const quiet = runChecks({ records: [], log: [], script, products: [], store: { messages: [{ id: '7', canaries: ['[[c:q.3.in]]'], nameCanary: '[[c:q.3.in]]' }, { id: '8', canaries: [] }], summaries: [{ id: 'L1-9', level: 1, sourceLevel: 0, sourceIds: ['8'], number: null, covers: [] }] } });
  assert.ok(quiet.notes.some((n) => /doesn't judge 1 stored summary with no stand-in mark.*: L1\(q\.3\.in\+1\)/.test(n)), 'named as check 11 names it, not by its store id');
  assert.ok(!quiet.flags.some((f) => f.check === 5));
  const composition = { contextComposition: { fixture: { head: { messages: 4 } } } };
  const checkpoint = { kind: 'checkpoint', name: 's', step: 's.cp', health: { data: composition } };
  assert.deepEqual(what(runChecks({ records: [], log: [checkpoint], script, products: [], store: null, adaptive: true })), [10]);
  assert.deepEqual(what(runChecks({ records: [], log: [checkpoint], script, products: [], store: null, adaptive: false })), []);
  const end = { kind: 'health', name: 'end', step: 's.9', health: { data: composition } };
  assert.deepEqual(what(runChecks({ records: [], log: [end], script, products: [], store: null, adaptive: true })), [10], 'an end-of-run panel reporting the composition with no multiplier is a couldn\'t-judge flag');
  assert.deepEqual(what(runChecks({ records: [], log: [{ ...end, health: { data: { contextComposition: {} } } }], script, products: [], store: null, adaptive: true })), [], 'a panel that reports no context composition, as after a tune-out, holds nothing check 10 could judge');
  const judgedEnd = runChecks({ records: [], log: [{ ...end, health: { data: { contextComposition: { fixture: { calibration: { multiplier: 1.8 } } } } } }], script, products: [], store: null, adaptive: true });
  assert.equal(judgedEnd.judged.find((j) => j.check === 10).judged, 1);
  assert.match(judgedEnd.flags.find((f) => f.check === 10).message, /calibration at the clamp edge \(1\.8\) at the run's end/);
});

test('check 5 applies where the store holds a summary a summariser request wrote, so one whose sources it can\'t judge is a couldn\'t-judge flag', () => {
  const store = { messages: [{ id: 't1', canaries: ['[[c:a.call1]]'] }], summaries: [{ id: 'L1-1', level: 1, sourceLevel: 0, sourceIds: ['t1'], number: '[[s:C1]]', covers: ['[[c:a.call1]]'] }] };
  const call = { id: 'c1', step: 'a', kind: 'summariser', answer: { summary: '[[s:C1]]' }, sent: { canaries: [], summaries: [] } };
  const { flags, judged } = runChecks({ records: [call], log: [], script: [{ id: 'a', segment: 's' }], products: [], store, windowTokens: 1_000_000 });
  assert.equal(judged.find((j) => j.check === 5).judged, 0);
  assert.deepEqual(flags.filter((f) => f.check === 5).map((f) => f.what), ['judged-none:bookkeeping']);
  const unstored = runChecks({ records: [call], log: [], script: [{ id: 'a', segment: 's' }], products: [], store: { messages: store.messages, summaries: [] }, windowTokens: 1_000_000 });
  assert.deepEqual(unstored.flags.filter((f) => f.check === 5), [], 'an answered request whose summary the store doesn\'t hold wrote nothing check 5 could judge, so it doesn\'t apply');
  assert.equal(unstored.judged.find((j) => j.check === 5).judged, 0);
});

test('check 5 through runChecks holds a subagent\'s L2 merge to its L1 sources by every canary they cover, and the fixture\'s by its conversational ones only', () => {
  const store = {
    messages: [{ id: 'k1', canaries: ['[[c:k.task]]'] }, { id: 'k2', canaries: ['[[c:k.s1]]'] }],
    summaries: [
      { id: 'L1-1', level: 1, sourceLevel: 0, sourceIds: ['k1'], number: '[[s:C1]]', covers: ['[[c:k.task]]'] },
      { id: 'L1-2', level: 1, sourceLevel: 0, sourceIds: ['k2'], number: '[[s:C2]]', covers: ['[[c:k.s1]]'] },
      { id: 'L2-3', level: 2, sourceLevel: 1, sourceIds: ['L1-1', 'L1-2'], number: '[[s:C3]]', covers: ['[[c:k.task]]', '[[c:k.s1]]'] },
    ],
  };
  const merge = (canaries) => ({ id: 'm1', step: 'k', kind: 'summariser', agent: 'sub', answer: { summary: '[[s:C3]]' }, sent: { canaries, summaries: [] } });
  const check5 = (r) => ({ judged: r.judged.find((j) => j.check === 5)?.judged, flags: r.flags.filter((f) => f.check === 5).map((f) => f.request ?? f.what) });
  const args = { log: [], script: [{ id: 'k', segment: 's' }], products: [], store, windowTokens: 1_000_000 };
  assert.deepEqual(check5(runChecks({ ...args, records: [merge(['[[c:k.task]]', '[[c:k.s1]]'])], agent: 'spawn-k' })), { judged: 1, flags: [] }, 'both L1s shown raw');
  assert.deepEqual(check5(runChecks({ ...args, records: [merge(['[[c:k.task]]'])], agent: 'spawn-k' })), { judged: 1, flags: ['m1'] }, 'L1-2\'s source not shown');
  assert.deepEqual(check5(runChecks({ ...args, records: [merge(['[[c:k.task]]'])] })).flags, ['judged-none:bookkeeping'], 'the fixture\'s rule counts no .task or .sN canary, so it judges none and says so');
});

test('the report\'s note names a summary of a call-only message by the call\'s canary, as check 11 and the record do, not by place', () => {
  const store = { messages: [{ id: '4', canaries: [], nameCanary: '[[c:q.2.call1]]' }, { id: '5', canaries: [] }], summaries: [{ id: 'L1-3', level: 1, sourceLevel: 0, sourceIds: ['4', '5'], number: null, covers: [] }] };
  assert.equal(summaryNamer(store)(store.summaries[0]), 'L1(q.2.call1-q.2.call1+1)');
});

test('a clamp edge check 10 finds makes the report invalid, as found, not as a test spells it', () => {
  const at = (m) => ({ kind: 'checkpoint', step: 'c.cm.cp', name: 'n', health: { contextComposition: { fixture: { calibration: { multiplier: m } } } } });
  const flags = calibrationEdge([at(1.8)]);
  const r = perCheckReport({ configuration, candidate: { flags, missing: [] } });
  assert.equal(r.verdict, 'invalid');
  assert.match(r.lines[0], /^INVALID: calibration at the clamp edge \(1\.8\)/);
});

test('the report prints what a check couldn\'t judge beside its count', () => {
  const report = perCheckReport({ configuration: { name: 'C' }, candidate: { flags: [], missing: [], judged: [{ check: 11, name: 'compile invariants', judged: 4, besides: 'store order couldn\'t place 3 of what was sent' }, { check: 12, name: 'reloads', judged: 0 }] } });
  assert.ok(report.lines.includes('- judged: check 11 compile invariants 4 (store order couldn\'t place 3 of what was sent), check 12 reloads 0'));
});

test('what check 11 couldn\'t place reaches the report as a couldn\'t-judge flag with its count beside check 11\'s judged compiles, never as a breach', () => {
  const lines = [{ seq: 1, agent: 'fixture', kind: 'request', outcome: 'compiled', violations: [{ invariant: 'unplaced', count: 3, detail: '3 parts: a.in, b.in, c.in' }] }];
  const candidate = runChecks({ records: [], log: [{ kind: 'compiles', step: 'q.1', lines }], script: [{ id: 'q', segment: 's', kind: 'channel' }], products: [], store: { messages: [], summaries: [] } });
  const eleven = candidate.judged.find((j) => j.check === 11);
  assert.equal(eleven.judged, 1);
  assert.match(eleven.besides, /store order couldn't place 3 of what was sent/);
  const flag = candidate.flags.find((f) => f.check === 11);
  assert.match(flag.message, /^couldn't judge all of /);
  const report = perCheckReport({ configuration: { name: 'C' }, candidate });
  assert.ok(report.lines.some((l) => /check 11 compile invariants 1 \(store order couldn't place 3 of what was sent\)/.test(l)));
  assert.ok(!report.lines.some((l) => /breaks/.test(l)));
  assert.ok(report.lines.some((l) => /^- check 11 at q\.1: couldn't judge all of /.test(l)), 'the couldn\'t-judge flag itself reaches the rendered report');
});
