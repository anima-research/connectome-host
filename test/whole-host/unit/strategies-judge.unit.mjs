import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, launchStreamBound, streamBoundFor } from '../lib/strategies/judge.mjs';
import { configurations, continuation } from '../lib/strategies/script.mjs';
import { asRun } from '../lib/strategies/lane.mjs';

const store = { messages: [], summaries: [] };
const counting = (audit = { status: 0, output: '' }) => {
  const calls = { read: 0, audit: 0 };
  return {
    calls,
    readers: {
      readStore: async () => { calls.read++; return store; },
      audit: () => { calls.audit++; return audit; },
    },
  };
};
const side = (configuration, over = {}) => ({
  records: [], log: [], script: continuation(), storeCopy: '/nowhere/session', configuration, installDir: '/nowhere', run: { ok: true, failure: null }, ...over,
});

test('K2d: the judge holds a reported window against its configuration\'s stand-in window', async () => {
  const usage = { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 };
  const r1 = { id: 'r1', step: 'a', kind: 'agent', arrived: '11', maxTokens: 2_048, usage, messages: [{ role: 'user', digest: 'd1', blocks: [{ type: 'text', canaries: ['[[c:a.in]]'] }] }], answer: { shape: 'reply', toolUseIds: ['t1'] } };
  const r2 = { ...r1, id: 'r2', arrived: '21', messages: [...r1.messages, { role: 'assistant', digest: 'd2', blocks: [{ type: 'tool_use', toolUseId: 't1' }] }, { role: 'user', digest: 'd3', blocks: [] }], answer: { shape: 'reply', toolUseIds: [] } };
  const report = (window) => ({ kind: 'budget-report', boot: 1, lines: ['--- Stream Token Budgets ---', `  fixture: 150.0k (last: 0, 0%); its stream doesn't break at this budget mid-turn: for its size, only before a request its ${window} window can't hold`] });
  const checkpoint = { kind: 'checkpoint', name: 's', step: 's.cp', health: { data: { contextComposition: { fixture: { planVsActual: { budgetMet: true } } }, runtimeSettings: { fixture: { effectiveContextBudgetTokens: 20_000 } } } } };
  const sent = (id) => ({ kind: 'request', request: { id, kind: 'agent' } });
  const compiled = { kind: 'compiles', lines: [{ seq: 1, agent: 'fixture', kind: 'request', assembly: 1, outcome: 'compiled', stamp: '10', messages: [{ sources: ['r:1'], content: 'x1' }] }], blobs: { x1: { role: 'user', content: [{ type: 'text', text: '[[c:a.in]] words' }] } } };
  const configuration = asRun(configurations().H1, { window: 1_000_000 });
  const run = (window) => judge({ ...side(configuration, { records: [r1, r2], script: [{ id: 'a', segment: 's' }], log: [compiled, report(window), sent('r1'), sent('r2'), checkpoint] }), readers: counting().readers });
  assert.equal(configuration.windowTokens, 1_000_000, 'the host\'s window for the model');
  assert.equal((await run('1.0M')).notes.length, 1, 'the stand-in\'s window, as the host writes it');
  assert.ok((await run('200.0k')).flags.some((f) => f.check === 3 && f.request === 'r2' && /couldn't judge/.test(f.message)), 'another window');
});

test('a run that failed counts against its side, naming its failure, and its store is not read', async () => {
  const { calls, readers } = counting();
  const judged = await judge({ ...side(configurations().H1, { run: { ok: false, failure: { reason: 'the host exited' } } }), readers });
  const failed = judged.flags.filter((f) => f.check === 1 && f.step === 'the run');
  assert.equal(failed.length, 1);
  assert.match(failed[0].message, /the host exited/);
  assert.deepEqual(calls, { read: 0, audit: 0 });
});

test('the store is read and audited where the configuration keeps summaries, and only there', async () => {
  const kept = counting();
  await judge({ ...side(configurations().H1), readers: kept.readers });
  assert.deepEqual(kept.calls, { read: 1, audit: 1 });
  const none = counting();
  await judge({ ...side(configurations().H3), readers: none.readers });
  assert.deepEqual(none.calls, { read: 0, audit: 0 });
});

test('the audit\'s violations are a check 5 flag on the run; an audit that could not run leaves the side unjudged', async () => {
  const violated = counting({ status: 2, output: 'L2 overlaps L2' });
  const judged = await judge({ ...side(configurations().H1), readers: violated.readers });
  const audit = judged.flags.filter((f) => f.check === 5 && f.step === 'the run');
  assert.equal(audit.length, 1);
  assert.match(audit[0].message, /L2 overlaps L2/);
  const broken = counting({ status: 1, output: 'no such namespace' });
  await assert.rejects(judge({ ...side(configurations().H1), readers: broken.readers }), /no such namespace/);
});

test('a run that succeeded with no store copy leaves the side unjudged where summaries are kept', async () => {
  const { readers } = counting();
  await assert.rejects(judge({ ...side(configurations().H1, { storeCopy: null }), readers }), /no store copy/);
  const judged = await judge({ ...side(configurations().H3, { storeCopy: null }), readers });
  assert.ok(Array.isArray(judged.flags));
});

test('a store that kept no summaries, where the configuration compresses, is a check 5 flag; another failure to read it leaves the side unjudged', async () => {
  const audit = () => ({ status: 0, output: '' });
  const empty = { readStore: async () => { throw new Error('no summaries in agents/fixture at /tmp/x, from a configuration that compresses'); }, audit };
  const judged = await judge({ ...side(configurations().H1), readers: empty });
  const flag = judged.flags.filter((f) => f.check === 5 && f.what === 'no-summaries');
  assert.equal(flag.length, 1, 'one flag, keyed so an expected failure can name it');
  assert.equal(flag[0].message, 'the store kept no summaries in agents/fixture, though the configuration compresses', 'the same message whichever copy of the store was read');
  const unreadable = { readStore: async () => { throw new Error('getSummary(L1-3) is null, though getSummariesInRange lists it'); }, audit };
  await assert.rejects(judge({ ...side(configurations().H1), readers: unreadable }), /getSummary/);
});

test('a run is judged by its configuration\'s agent, or, where it judges its subagent, by the first other agent its compile lines name, in that agent\'s own slot', async () => {
  const { judgedAgent } = await import('../lib/strategies/judge.mjs');
  assert.deepEqual(judgedAgent(configurations().H1, []), { agent: 'fixture', namespace: 'agents/fixture', isolate: false });
  const log = [{ kind: 'compiles', lines: [{ kind: 'request', agent: 'fixture' }, { kind: 'dry', agent: 'spawn-x' }] }, { kind: 'compiles', lines: [{ kind: 'request', agent: 'spawn-knowledge-1-2' }] }];
  assert.deepEqual(judgedAgent({ ...configurations().H2 }, log), { agent: 'spawn-knowledge-1-2', namespace: 'subagent/spawn-knowledge-1-2', isolate: true });
  assert.throws(() => judgedAgent(configurations().H2, log.slice(0, 1)), /no compile line names a subagent/);
});

test('H2 is judged by its subagent: its own store, read in its own slot, its violations flagged, and its stream bound the one its launch notice states', async () => {
  const configuration = configurations().H2;
  const launch = { role: 'user', content: [{ type: 'text', text: "Launch of spawn 'knowledge-1':\n- Stream budget: 500,000 tokens (fixture's: 320,000 tokens).\n" }] };
  const log = [{ kind: 'compiles', step: 'k', blobs: { l1: launch }, lines: [{ seq: 1, agent: 'knowledge-1', kind: 'request', assembly: 1, outcome: 'compiled', stamp: '10', messages: [{ sources: ['r:1'], content: 'l1' }] }] }];
  assert.equal(launchStreamBound(log, 'knowledge-1'), 500_000);
  assert.equal(streamBoundFor(configuration, launchStreamBound(log, 'knowledge-1')), 500_000, 'the bound check 3 is given is the notice\'s, not the configuration\'s');
  assert.notEqual(streamBoundFor(configuration), 500_000, 'which differs from the one it would be given otherwise');
  const asked = [];
  const readers = { readStore: async (args) => { asked.push(args); return { ...store, violations: ['L1 L1-0: 2 leaves 1..3, 1 hole(s) e.g. 2'] }; }, audit: () => { throw new Error('the audit CLI can\'t open an isolated slot'); } };
  const judged = await judge({ ...side(configuration, { log }), readers });
  assert.deepEqual(asked.map((a) => [a.namespace, a.isolate]), [['subagent/knowledge-1', true]]);
  assert.ok(judged.flags.some((f) => f.check === 5 && /violations: L1 L1-0/.test(f.message)));
  assert.ok(!judged.flags.some((f) => f.what === 'no-launch-budget'));
  const unstated = await judge({ ...side(configuration, { log: [{ ...log[0], blobs: { l1: { role: 'user', content: [{ type: 'text', text: 'hello' }] } } }] }), readers });
  assert.ok(unstated.flags.some((f) => f.what === 'no-launch-budget'), 'with no stated budget its rounds can\'t be judged, and the run says so');
});

test('H2\'s check 3 holds a subagent\'s continuation round to the stream budget its launch notice states', async () => {
  const configuration = asRun(configurations().H2, { window: 1_000_000 });
  const notice = (n) => ({ role: 'user', content: [{ type: 'text', text: `Launch of spawn 'knowledge-1':\n- Stream budget: ${n} tokens (fixture's: 320,000 tokens).\n` }] });
  const usage = (input) => ({ input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  const r1 = { id: 'r1', step: 'k', kind: 'agent', agent: 'sub', arrived: '11', maxTokens: 2_048, usage: usage(400_000), messages: [{ role: 'user', digest: 'd1', blocks: [{ type: 'text', canaries: ['[[c:k.in]]'] }] }], answer: { shape: 'reply', toolUseIds: ['t1'] } };
  const r2 = { ...r1, id: 'r2', arrived: '21', usage: usage(100), messages: [...r1.messages, { role: 'assistant', digest: 'd2', blocks: [{ type: 'tool_use', toolUseId: 't1' }] }, { role: 'user', digest: 'd3', blocks: [{ type: 'tool_result', toolUseId: 't1' }] }], answer: { shape: 'reply', toolUseIds: [] } };
  const log = (n) => [
    { kind: 'compiles', step: 'k', blobs: { l1: notice(n), x1: { role: 'user', content: [{ type: 'text', text: '[[c:k.in]] words' }] } }, lines: [{ seq: 1, agent: 'knowledge-1', kind: 'request', assembly: 1, outcome: 'compiled', stamp: '10', messages: [{ sources: ['r:1'], content: 'l1' }, { sources: ['r:2'], content: 'x1' }] }] },
    { kind: 'request', step: 'k', request: { id: 'r1', kind: 'agent' } },
    { kind: 'request', step: 'k', request: { id: 'r2', kind: 'agent' } },
  ];
  const overBound = async (n) => (await judge({ ...side(configuration, { records: [r1, r2], script: [{ id: 'k', segment: 's' }], log: log(n) }), readers: counting().readers })).flags.filter((f) => f.check === 3 && /stream bound/.test(f.message));
  assert.deepEqual(await overBound('500,000'), [], '400,000 fresh tokens before the round are within the 500,000 the notice states');
  const flagged = await overBound('300,000');
  assert.deepEqual(flagged.map((f) => f.request), ['r2']);
  assert.match(flagged[0].message, /over the stream bound 300000/);
});

test('a failed H2 run that never reached its subagent is judged as the failed run it is', async () => {
  const { readers } = counting();
  const judged = await judge({ ...side(configurations().H2, { run: { ok: false, failure: { reason: 'the host exited' } } }), readers });
  assert.ok(judged.flags.some((f) => f.check === 1 && f.step === 'the run' && /the host exited/.test(f.message)));
});
