import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetReportDone, hostEnv, lastTake, readSettle, shutdownFailure } from '../lib/strategies/driver.mjs';

const answer = ({ ready = true, pending = false, queue = 0, compressed = 30, drained = true, deferredWrites = 0, activeTurnAgents = [], parkedAdmissions = 0, ok = true } = {}) => ({
  ok,
  maintenance: { ran: true, agents: [{ agentName: 'fixture', ready, ...(ready ? {} : { pending: pending ? 'Compressing chunk 31' : `${queue} chunks pending` }), progress: { totalChunks: 32, chunksCompressed: compressed, l1QueueLength: queue, mergeQueueLength: 0, summaryCounts: { l1: compressed, l2: 1, l3: 0 }, pending } }] },
  hostMode: { drained, deferredWrites, activeTurnAgents, parkedAdmissions },
});

test('R7: a settle is settled only when every agent is ready, the host is drained and nothing it deferred is still to land', () => {
  assert.equal(readSettle(answer(), null).settled, true);
  for (const [what, a] of [
    ['a deferred write', answer({ deferredWrites: 1 })],
    ['a host not drained', answer({ drained: false, activeTurnAgents: ['fixture'] })],
    ['an agent not ready', answer({ ready: false, pending: true })],
    ['an answer that isn\'t ok', answer({ ok: false })],
  ]) assert.equal(readSettle(a, null).settled, false, what);
  const two = answer();
  two.maintenance.agents.push({ ...two.maintenance.agents[0], agentName: 'reader', ready: false, pending: 'Compressing chunk 3', progress: { ...two.maintenance.agents[0].progress, pending: true } });
  assert.equal(readSettle(two, null).settled, false, 'one agent of two not ready');
  two.maintenance.agents[1] = { ...two.maintenance.agents[0], agentName: 'reader' };
  assert.equal(readSettle(two, null).settled, true, 'both ready');
});

test('R7c: a compression the host\'s auto-tick started holds the settle while the test module counts it, though maintenance looks settled', () => {
  assert.equal(readSettle(answer(), null, { fixture: 0 }).settled, true);
  const read = readSettle(answer(), null, { fixture: 1 });
  assert.equal(read.settled, false);
  assert.equal(read.inFlight, true);
  assert.deepEqual(read.ticking, ['fixture 1']);
});

test('R7: work is in flight while a compression runs, a turn is alive or a wake is parked, and otherwise isn\'t', () => {
  assert.equal(readSettle(answer({ ready: false, pending: true }), null).inFlight, true);
  assert.equal(readSettle(answer({ drained: false, activeTurnAgents: ['fixture'] }), null).inFlight, true);
  assert.equal(readSettle(answer({ drained: false, parkedAdmissions: 1 }), null).inFlight, true);
  assert.equal(readSettle(answer({ ready: false, queue: 2 }), null).inFlight, false);
  assert.equal(readSettle(answer({ deferredWrites: 1 }), null).inFlight, false);
});

test('R7: a pass moved the work on when its progress or its deferred writes differ from the pass before, and the first pass always has', () => {
  const before = answer({ ready: false, queue: 2, compressed: 29 });
  assert.equal(readSettle(before, null).moved, true);
  const seen = readSettle(before, null).progress;
  assert.equal(readSettle(answer({ ready: false, queue: 1, compressed: 30 }), seen).moved, true, 'a chunk compressed');
  assert.equal(readSettle(answer({ ready: false, queue: 2, compressed: 29 }), seen).moved, false, 'nothing changed');
  const deferred = readSettle(answer({ deferredWrites: 2 }), null).progress;
  assert.equal(readSettle(answer({ deferredWrites: 1 }), deferred).moved, true, 'a deferred write landed');
  assert.equal(readSettle(answer({ deferredWrites: 2 }), deferred).moved, false, 'none landed');
});

test('D12: `/budget`\'s output is whole once it holds the agent\'s own line, or a line that is no part of the report, and not before', () => {
  const header = '--- Stream Token Budgets ---';
  assert.equal(budgetReportDone([], 'fixture'), false);
  assert.equal(budgetReportDone([header], 'fixture'), false);
  assert.equal(budgetReportDone([header, '  other: 150.0k (last: 0, 0%)'], 'fixture'), false, 'another agent\'s line: ours is still to come');
  assert.equal(budgetReportDone([header, '  fixture: 150.0k (last: 0, 0%)'], 'fixture'), true);
  assert.equal(budgetReportDone([header, '  fixture: 150.0k (last: 0, 0%); its stream doesn\'t break at this budget mid-turn: for its size, only before a request its 1.0M window can\'t hold'], 'fixture'), true);
  assert.equal(budgetReportDone([header, '  fixturette: 1.0k (last: 0, 0%)'], 'fixture'), false, 'another agent whose name starts with ours');
  assert.equal(budgetReportDone(['No agents.'], 'fixture'), true);
  assert.equal(budgetReportDone(['Unknown command: /budget'], 'fixture'), true, 'a host without the report doesn\'t hold the run');
});

test('R7b: an answer with no deferred-write count isn\'t settled, so a host that stops reporting it fails the settle', () => {
  const unreported = answer();
  delete unreported.hostMode.deferredWrites;
  assert.equal(readSettle(unreported, null).settled, false);
  assert.equal(readSettle(answer(), null).settled, true);
});

test('R12: a configuration whose model binds thinking boots its host with the start-up binding probe off; any other, without the setting', () => {
  const base = { standinUrl: 'http://127.0.0.1:1', control: '/tmp/c', clock: 5 };
  assert.equal(hostEnv({ ...base, configuration: { binds: true } }).THINKING_BINDING_PROBE, 'off');
  assert.equal('THINKING_BINDING_PROBE' in hostEnv({ ...base, configuration: { binds: false } }), false);
  assert.equal(hostEnv({ ...base, configuration: {} }).ANTHROPIC_BASE_URL, 'http://127.0.0.1:1');
  const env = hostEnv({ ...base, configuration: {} });
  assert.ok('AGENT_TIMEZONE' in env && env.AGENT_TIMEZONE === undefined, 'an inherited AGENT_TIMEZONE is overridden to nothing, so the host keeps TZ\'s UTC');
  for (const name of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_CREDENTIALS_FILE', 'ANTHROPIC_OAUTH_AUTO_REFRESH']) assert.ok(name in env && env[name] === undefined, `an inherited ${name} is overridden to nothing, so the host keeps the fixture's API key`);
  for (const name of ['MODEL', 'COUNT_TOKENS_MODEL']) assert.ok(name in env && env[name] === undefined, `an inherited ${name} is overridden to nothing, so the recipe's model is the one sent`);
});

test('R13: a host\'s shutdown fails the run when it doesn\'t exit in time or exits other than cleanly', () => {
  assert.equal(shutdownFailure({ boot: 2, timedOut: false, exited: { code: 0, signal: null }, seconds: 30 }), null);
  assert.match(shutdownFailure({ boot: 2, timedOut: false, exited: { code: 1, signal: null }, seconds: 30 }), /boot 2: the host exited \(1\) on its shutdown/);
  assert.match(shutdownFailure({ boot: 2, timedOut: false, exited: { code: null, signal: 'SIGSEGV' }, seconds: 30 }), /exited \(SIGSEGV\)/);
  assert.match(shutdownFailure({ boot: 3, timedOut: true, exited: { code: null, signal: 'SIGKILL' }, seconds: 30 }), /boot 3: the host didn't exit within 30 s/);
});

test('R14: the self-check\'s second arm boots the test module with recording off, and every other run with it on', () => {
  const base = { standinUrl: 'http://127.0.0.1:1', control: '/tmp/c', clock: 5 };
  assert.equal(hostEnv({ ...base, configuration: { recording: false } }).FIXTURE_RECORD, 'off');
  const on = hostEnv({ ...base, configuration: {} });
  assert.ok('FIXTURE_RECORD' in on && on.FIXTURE_RECORD === undefined, 'the recording arm sets it to nothing');
  assert.equal({ ...{ FIXTURE_RECORD: 'off' }, ...on }.FIXTURE_RECORD, undefined, 'so a runner\'s own FIXTURE_RECORD=off, which spawnHost spreads first, can\'t turn recording off');
});

test('a last take the module refuses at a host\'s shutdown fails the run, since the compiles since the last settle are lost, and logs the loss', async () => {
  const logged = [];
  const failed = [];
  const at = { boot: 2, log: (kind, fields) => logged.push({ kind, ...fields }), fail: (reason) => failed.push(reason) };
  await lastTake({ ...at, take: async () => { throw new Error('the module stopped before flushing'); } });
  assert.deepEqual(logged, [{ kind: 'compiles', boot: 2, lost: 'the module stopped before flushing' }]);
  assert.deepEqual(failed, ['boot 2\'s last take of the module\'s compiles failed: the module stopped before flushing']);
  await lastTake({ ...at, take: async () => {} });
  assert.equal(failed.length, 1, 'a take that answers fails nothing');
});
