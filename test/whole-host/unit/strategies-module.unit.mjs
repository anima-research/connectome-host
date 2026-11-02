import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessModule } from '../lib/strategies/module.mjs';
class Manager {
  constructor(tokens = 1_000) {
    this.tokens = tokens;
    this.messages = [{ id: 1, sequence: 1, content: [{ type: 'text', text: '[[c:a.in]] hello' }] }];
  }
  getAllMessages() { return this.messages; }
  getSummariesInRange() { return []; }
  getSummary() { return null; }
  getStrategy() { return {}; }
  getRenderStats() { return null; }
  getMaxSummaryLevel() { return 0; }
  listPins() { return []; }
  async compile() { return { messages: [], renderStats: { total: { tokens: this.tokens } }, provenance: { layout: { memberIds: [], units: [] } } }; }
}
const harness = (framework) => {
  const module = new HarnessModule(null);
  module.framework = framework;
  const Own = class extends Manager {};
  module.wrapManagerCompile(Own.prototype);
  return [module, Own];
};

test('module: a compile given no budget is held to the budget context-manager then takes, 100,000 with 4,000 reserved', async () => {
  const [module, Own] = harness(null);
  const over = new Own(98_000);
  over.messages = [];
  module.agentOf.set(over, 'fixture');
  await over.compile();
  await over.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
  const [defaulted, given] = module.lines;
  assert.equal(defaulted.budget, null, 'the line records the budget as passed');
  assert.deepEqual(defaulted.violations.map((v) => v.invariant), ['budget']);
  assert.match(defaulted.violations[0].detail, /98000 tokens against an input budget of 96000/);
  assert.deepEqual(given.violations, []);
});

test('module: a take covers an agent that compiled and has left the registry once more, from the manager kept at its compile, then forgets it', async () => {
  const registered = [];
  const managers = new Map();
  const [module, Own] = harness({ listAgents: () => registered.map((name) => ({ name })), getAgent: (name) => (registered.includes(name) ? { getContextManager: () => managers.get(name) } : null) });
  const sub = new Own();
  managers.set('sub', sub);
  registered.push('sub');
  module.agentOf.set(sub, 'sub');
  await sub.compile();
  registered.length = 0;
  sub.messages = [...sub.messages, { id: 2, sequence: 2, content: [{ type: 'text', text: '[[c:a.report]] done' }] }];
  const last = await module.answer({ op: 'take' });
  assert.deepEqual(last.store.sub.messages, [['1', ['[[c:a.in]]']], ['2', ['[[c:a.report]]']]], 'its store, read after it left');
  assert.equal(last.lines.length, 1);
  const after = await module.answer({ op: 'take' });
  assert.deepEqual(after.store, {}, 'once, then forgotten');
});

test('module: with recording off the agent\'s compiles reach the manager as called and nothing is recorded, ticks are still counted and reads still answer; with it on, the same calls are recorded as request compiles', async () => {
  const boot = (record) => {
    const module = new HarnessModule('/nowhere', { record });
    module.connect = () => {};
    const Own = class extends Manager {};
    const manager = new Own();
    const calls = [];
    const Agent = class {
      async compileWithInjections(budget, injections, opts) { calls.push(['compileWithInjections', budget, injections, opts]); await this.getContextManager().compile(budget, undefined, opts); return 'with injections'; }
      async compileContext(budget) { calls.push(['compileContext', budget]); await this.getContextManager().compile(budget); return 'context'; }
      getContextManager() { return manager; }
    };
    const agent = Object.assign(new Agent(), { name: 'fixture' });
    module.setFramework({ getPrimaryAgentName: () => 'fixture', getAgent: (name) => (name === 'fixture' ? agent : null), listAgents: () => [{ name: 'fixture' }] });
    return { module, manager, Own, agent, calls };
  };
  const budget = { maxTokens: 1_000, reserveForResponse: 0 };
  const drive = async ({ agent, calls }) => {
    const opts = { thinkingBinding: { mode: 'bound' } };
    const results = [await agent.compileWithInjections(budget, ['notice'], opts), await agent.compileContext(budget)];
    assert.deepEqual(calls, [['compileWithInjections', budget, ['notice'], opts], ['compileContext', budget]], 'each call reaches the agent\'s own method with its arguments, options included');
    assert.deepEqual(results, ['with injections', 'context'], 'and its result comes back');
  };
  const off = boot(false);
  await drive(off);
  assert.deepEqual(off.module.lines, [], 'no line is recorded, not only none handed over');
  let finish;
  const strategy = { tick: () => new Promise((resolve) => { finish = resolve; }) };
  const second = new off.Own();
  second.getStrategy = () => strategy;
  await second.compile();
  const ticking = strategy.tick();
  assert.equal(off.module.ticksInFlight(second), 1, 'a second manager\'s tick, watched from its compile');
  finish();
  await ticking;
  assert.equal(off.module.ticksInFlight(second), 0);
  assert.deepEqual((await off.module.answer({ op: 'messages', agent: 'fixture' })).map((m) => m.canaries), [['[[c:a.in]]']]);
  assert.deepEqual(await off.module.answer({ op: 'state', agent: 'fixture' }), { maxLevel: 0 });
  const on = boot(true);
  await drive(on);
  const taken = await on.module.answer({ op: 'take' });
  assert.deepEqual(taken.lines.map((l) => [l.agent, l.kind, l.assembly]), [['fixture', 'request', 1], ['fixture', 'request', 2]], 'the same calls, recorded as the agent\'s request compiles');
  assert.ok(taken.store.fixture);
});

test('module: a compile\'s view member another agent\'s slot holds is read from that agent\'s manager', async () => {
  const shared = new Manager();
  shared.messages = [{ id: 9, sequence: 9, content: [{ type: 'text', text: '[[c:a.chat]] hi' }] }];
  const [module, Own] = harness({ listAgents: () => [{ name: 'fixture' }, { name: 'reader' }], getAgent: (name) => (name === 'fixture' ? { getContextManager: () => shared } : null) });
  const reader = new Own();
  const { nameOf, ...read } = module.elsewhere(reader, ['9', '10']);
  assert.deepEqual(read, { found: shared.messages, unfound: ['10'], from: ['fixture'] }, 'and which agent\'s slot held them');
  assert.deepEqual([nameOf('9'), nameOf('10')], ['fixture/a.chat', null], 'named in the store that holds it, with its agent');
  shared.messages = [...shared.messages, { id: 11, sequence: 11, content: [{ type: 'tool_use', id: 't1', name: 'deliver_summary', input: { text: '[[c:h1.read]] words' } }] }];
  assert.equal(module.elsewhere(reader, ['11']).nameOf('11'), 'fixture/h1.read', 'a message whose only block is a call, by its call\'s canary');
  assert.deepEqual({ ...module.elsewhere(shared, ['9']), nameOf: undefined }, { found: [], unfound: ['9'], from: [], nameOf: undefined }, 'never its own slot');
});

test('module: a reader\'s compile judges the members of its view another agent\'s slot holds, through the compile it records', async () => {
  const shared = new Manager();
  shared.messages = [{ id: 9, sequence: 9, content: [{ type: 'text', text: '[[c:a.chat]] hi' }] }];
  const module = new HarnessModule(null);
  module.framework = { listAgents: () => [{ name: 'fixture' }], getAgent: (name) => (name === 'fixture' ? { getContextManager: () => shared } : null) };
  const Reader = class extends Manager {
    async compile() { return { messages: [], renderStats: { total: { tokens: 1 } }, provenance: { layout: { memberIds: ['9'], units: [{ k: 'o', n: 1 }] } } }; }
  };
  module.wrapManagerCompile(Reader.prototype);
  const reader = new Reader();
  reader.messages = [];
  module.agentOf.set(reader, 'reader');
  await reader.compile({ maxTokens: 1_000, reserveForResponse: 0 });
  assert.deepEqual(module.lines[0].violations, [{ invariant: 'coverage', detail: '1 stored bodies in no message sent: fixture/a.chat' }], 'the shared slot\'s member is judged, not unreadable');
  assert.deepEqual(module.lines[0].slots, ['fixture'], 'the line names the agent whose slot supplied it');
  const Plain = class extends Manager {};
  module.wrapManagerCompile(Plain.prototype);
  const own = new Plain();
  own.messages = [];
  module.agentOf.set(own, 'fixture');
  await own.compile({ maxTokens: 1_000, reserveForResponse: 0 });
  assert.equal('slots' in module.lines[1], false, 'a compile no other slot supplied names none');
});

test('module: another slot is read only on the compiling manager\'s branch, so a fork\'s copy of a message never stands for the resident\'s', () => {
  const resident = new Manager();
  resident.messages = [{ id: 9, sequence: 9, content: [{ type: 'text', text: 'as stored' }] }];
  const fork = new Manager();
  fork.messages = [{ id: 9, sequence: 9, content: [{ type: 'text', text: 'edited on the fork' }] }];
  fork.getDerivation = () => ({ branch: 'fork-1', parentBranch: 'main' });
  const [module, Own] = harness({ listAgents: () => [{ name: 'fork' }, { name: 'fixture' }], getAgent: (name) => ({ getContextManager: () => (name === 'fork' ? fork : resident) }) });
  assert.deepEqual(module.elsewhere(new Own(), ['9']).found, resident.messages);
  const onFork = new Own();
  onFork.getDerivation = () => ({ branch: 'fork-1', parentBranch: 'main' });
  assert.deepEqual(module.elsewhere(onFork, ['9']).found, fork.messages);
});

test('module: an ended agent\'s tick still in flight counts in ticks, and its manager is read on each take until it settles, the change its tick made included', async () => {
  let registered = ['sub'];
  const managers = new Map();
  const [module, Own] = harness({ listAgents: () => registered.map((name) => ({ name })), getAgent: (name) => (registered.includes(name) ? { getContextManager: () => managers.get(name) } : null) });
  let finish;
  const strategy = { tick: () => new Promise((resolve) => { finish = resolve; }) };
  const sub = new Own();
  sub.getStrategy = () => strategy;
  managers.set('sub', sub);
  module.agentOf.set(sub, 'sub');
  await sub.compile();
  const ticking = strategy.tick();
  registered = [];
  assert.deepEqual(await module.answer({ op: 'ticks' }), { 'sub (ended)': 1 });
  const during = await module.answer({ op: 'take' });
  assert.deepEqual(during.store.sub.messages, [['1', ['[[c:a.in]]']]]);
  sub.messages = [...sub.messages, { id: 2, sequence: 2, content: [{ type: 'text', text: '[[c:a.summary]] done' }] }];
  finish();
  await ticking;
  assert.deepEqual(await module.answer({ op: 'ticks' }), {});
  const after = await module.answer({ op: 'take' });
  assert.deepEqual(after.store.sub.messages, [['2', ['[[c:a.summary]]']]], 'what its tick wrote after it left');
  assert.deepEqual((await module.answer({ op: 'take' })).store, {}, 'then forgotten');
});

test('module: with recording off, an ended agent\'s tick in flight still counts in ticks', async () => {
  let registered = ['fixture', 'sub'];
  const fixtureManager = new (class extends Manager {})();
  const Own = class extends Manager {};
  const sub = new Own();
  let finish;
  const strategy = { tick: () => new Promise((resolve) => { finish = resolve; }) };
  sub.getStrategy = () => strategy;
  const module = new HarnessModule('/nowhere', { record: false });
  module.connect = () => {};
  const Agent = class { getContextManager() { return this.manager; } };
  const agents = { fixture: Object.assign(new Agent(), { name: 'fixture', manager: fixtureManager }), sub: Object.assign(new Agent(), { name: 'sub', manager: sub }) };
  module.setFramework({ getPrimaryAgentName: () => 'fixture', getAgent: (name) => (registered.includes(name) ? agents[name] : null), listAgents: (o) => (o?.includeEnded ? ['fixture', 'sub'] : registered).map((name) => ({ name })) });
  module.wrapManagerCompile(Own.prototype);
  await sub.compile();
  const ticking = strategy.tick();
  registered = ['fixture'];
  const during = await module.answer({ op: 'ticks' });
  assert.deepEqual(Object.entries(during).filter(([name]) => name.endsWith('(ended)')).map(([, n]) => n), [1], 'the ended agent\'s tick, though nothing recorded its name');
  finish();
  await ticking;
  assert.deepEqual(await module.answer({ op: 'ticks' }), { fixture: 0 });
});

test('module: a compile is judged against the store as it stands when the compile returns, so a message stored while it awaited and not sent is uncovered', async () => {
  const [module, Own] = harness(null);
  let release;
  const Held = class extends Own {
    async compile() {
      await new Promise((resolve) => { release = resolve; });
      return { messages: [], renderStats: { total: { tokens: 1 } }, provenance: { layout: { memberIds: [], units: [] } } };
    }
  };
  module.wrapManagerCompile(Held.prototype);
  const held = new Held();
  held.messages = [];
  module.agentOf.set(held, 'fixture');
  const compiling = held.compile({ maxTokens: 1_000, reserveForResponse: 0 });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  held.messages = [{ id: 2, sequence: 2, content: [{ type: 'text', text: '[[c:a.r1]] stored meanwhile' }] }];
  release();
  await compiling;
  assert.deepEqual(module.lines.at(-1).violations, [{ invariant: 'coverage', detail: '1 stored bodies in no message sent: a.r1' }]);
});

test('module: each kv-unified submission a strategy begins is taken with the next batch, in order; a begin that throws is not one', async () => {
  const [module, Own] = harness({ listAgents: () => [], getAgent: () => null });
  const begun = [];
  const strategy = { beginKvUnifiedSubmission: ({ submissionId }) => { if (submissionId.endsWith(':x')) throw new Error('No kv-unified presentation draft'); begun.push(submissionId); } };
  const manager = new Own();
  manager.getStrategy = () => strategy;
  module.agentOf.set(manager, 'fixture');
  await manager.compile();
  strategy.beginKvUnifiedSubmission({ submissionId: 'fixture:0:1767690000000:0', requestHash: 'h', layoutHash: 'l' });
  assert.throws(() => strategy.beginKvUnifiedSubmission({ submissionId: 'fixture:0:1767690000000:x' }));
  strategy.beginKvUnifiedSubmission({ submissionId: 'fixture:0:1767690000000:1' });
  assert.deepEqual(begun, ['fixture:0:1767690000000:0', 'fixture:0:1767690000000:1'], 'the strategy still begins each');
  assert.deepEqual((await module.answer({ op: 'take' })).submissions, ['fixture:0:1767690000000:0', 'fixture:0:1767690000000:1']);
  assert.equal('submissions' in (await module.answer({ op: 'take' })), false, 'taken once');
});

test('module: with recording off it installs nothing on a strategy\'s submissions; with it on, it observes them', async () => {
  const Strategy = class { beginKvUnifiedSubmission() {} };
  for (const record of [false, true]) {
    const module = new HarnessModule('/nowhere', { record });
    const Own = class extends Manager {};
    module.wrapManagerCompile(Own.prototype);
    const manager = new Own();
    const strategy = new Strategy();
    manager.getStrategy = () => strategy;
    module.agentOf.set(manager, 'fixture');
    await manager.compile();
    assert.equal(Object.prototype.hasOwnProperty.call(strategy, 'beginKvUnifiedSubmission'), record, record ? 'observed' : 'left as it is');
  }
});

test('module: a manager\'s tick started by its first add, before any compile, is counted, with recording on or off', async () => {
  for (const record of [true, false]) {
    const module = new HarnessModule('/nowhere', { record });
    let finish;
    const strategy = { tick: () => new Promise((resolve) => { finish = resolve; }) };
    const Forked = class extends Manager {
      addMessage() { this.getStrategy().tick(); return 'm1'; }
    };
    module.wrapManagerCompile(Forked.prototype);
    const fork = new Forked();
    fork.getStrategy = () => strategy;
    assert.equal(fork.addMessage('user', []), 'm1', 'the add returns as it would');
    assert.equal(module.ticksInFlight(fork), 1, `recording ${record ? 'on' : 'off'}`);
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(module.ticksInFlight(fork), 0);
  }
});
