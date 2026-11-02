import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCompile } from '../lib/strategies/invariants.mjs';
const text = (t) => ({ type: 'text', text: t });
const call = (id) => ({ type: 'tool_use', id, name: 'look', input: {} });
const result = (id) => ({ type: 'tool_result', toolUseId: id, content: 'seen' });
const thinking = { type: 'thinking', thinking: 'why', signature: 'sig' };
const stored = (id, sequence, role, content) => ({ id, sequence, role, participant: role === 'user' ? 'Ann' : 'fixture', content });
const STORE = [
  stored('1', 1, 'user', [text('one')]),
  stored('2', 2, 'assistant', [text('two'), call('t1')]),
  stored('3', 3, 'user', [result('t1')]),
  stored('4', 4, 'assistant', [text('four')]),
];
const byId = new Map(STORE.map((m) => [m.id, m]));

const manager = ({ messages = STORE, summaries = {}, pins = [], config = {}, stats = null } = {}) => ({
  getAllMessages: () => messages,
  getSummary: (id) => (summaries[id] ? { id, level: 1, sourceLevel: 0, ...summaries[id] } : null),
  getStrategy: () => ({ config }),
  getRenderStats: () => stats,
  listPins: () => pins,
});

function compile(sent, { tokens = 100 } = {}) {
  const messages = [];
  const compiled = { messages: [], renderStats: { total: { tokens } }, provenance: { layout: { memberIds: [], units: [] } } };
  for (const item of sent) {
    const [source, content] = Array.isArray(item) ? item : [item, null];
    messages.push({ sources: [source] });
    if (source.startsWith('r:')) {
      const m = byId.get(source.slice(2).split('!')[0]);
      compiled.messages.push({ role: m.role, content: content ?? m.content });
    } else compiled.messages.push({ role: 'user', content: [text(`summary ${source}`)] });
  }
  return [compiled, messages];
}
const BUDGET = { maxTokens: 1_000, reserveForResponse: 0 };
const check = (m, sent, opts = {}, compileOpts = {}) => checkCompile(m, BUDGET, ...compile(sent, compileOpts), opts);
const named = (violations) => violations.map((v) => [v.invariant, v.detail]);

test('checkCompile: a compile that sends the store as stored, within its budget, breaks nothing', () => {
  assert.deepEqual(check(manager(), ['r:1', 'r:2', 'r:3', 'r:4']), []);
});

test('coverage: a stored body in no message sent, where the configuration compresses; a passthrough isn\'t held to it', () => {
  assert.deepEqual(named(check(manager(), ['r:1', 'r:2', 'r:3'])), [['coverage', '1 stored bodies in no message sent: start+4']]);
  assert.deepEqual(check(manager(), ['r:1', 'r:2', 'r:3'], { compresses: false }), []);
});

test('coverage: a stored message under two summaries sent', () => {
  const m = manager({ summaries: { S1: { sourceIds: ['1', '2'] }, S2: { sourceIds: ['2', '3'] } } });
  assert.deepEqual(named(check(m, ['s:S1@1', 's:S2@1', 'r:4'])), [['coverage', '1 stored messages under two summaries sent: start+2 in L1(start+1-start+2), L1(start+2-start+3)']]);
  const once = manager({ summaries: { S1: { sourceIds: ['1', '2'] }, S2: { sourceIds: ['3'] } } });
  assert.deepEqual(check(once, ['s:S1@1', 's:S2@1', 'r:4']), []);
});

test('coverage: what a message covers starts before what the message before it covers (store order)', () => {
  assert.deepEqual(named(check(manager(), ['r:1', 'r:4', 'r:2', 'r:3'])), [
    ['coverage', 'message 2 covers from start+2, before message 1\'s start+4'],
    ['coverage', 'message 3 covers from start+3, before message 1\'s start+4'],
  ]);
});

test('beside-sources: a stored message sent raw beside a summary of it', () => {
  const m = manager({ summaries: { S: { sourceIds: ['1'] } } });
  assert.deepEqual(named(check(m, ['s:S@1', 'r:1', 'r:2', 'r:3', 'r:4'])), [['beside-sources', '1 stored messages sent raw beside a summary of them: start+1 raw beside L1(start+1)']]);
  assert.deepEqual(check(m, ['s:S@1', 'r:2', 'r:3', 'r:4']), []);
});

test('budget: the compile\'s own count over the input budget and its grace; within the grace, or with enforcement off, breaks nothing', () => {
  assert.deepEqual(named(check(manager(), ['r:1', 'r:2', 'r:3', 'r:4'], {}, { tokens: 1_021 })), [['budget', '1021 tokens against an input budget of 1000 and a grace of 0.02']]);
  assert.deepEqual(check(manager(), ['r:1', 'r:2', 'r:3', 'r:4'], {}, { tokens: 1_020 }), []);
  assert.deepEqual(check(manager({ config: { enforceBudget: false } }), ['r:1', 'r:2', 'r:3', 'r:4'], {}, { tokens: 5_000 }), []);
});

test('shape: a result whose call isn\'t in the message before it, where the configuration compresses', () => {
  const m = manager({ summaries: { S: { sourceIds: ['1', '2'] } } });
  assert.deepEqual(named(check(m, ['s:S@1', 'r:3', 'r:4'])), [['shape', 'message 1: result start+2 call 1 answers no call in the message before it']]);
});

test('shape: a passthrough opening with a result whose call the store holds before the request\'s start; opening at the call breaks nothing', () => {
  assert.deepEqual(named(check(manager(), ['r:3', 'r:4'], { compresses: false })), [['shape', 'message 0: result start+2 call 1 answers no call in the message before it']]);
  assert.deepEqual(check(manager(), ['r:2', 'r:3', 'r:4'], { compresses: false }), []);
});

test('shape: a call, not in the last message, unanswered in the message after it', () => {
  const m = manager({ summaries: { S: { sourceIds: ['3'] } } });
  assert.deepEqual(named(check(m, ['r:1', 'r:2', 's:S@1', 'r:4'])), [['shape', 'message 1: call start+2 call 1 unanswered in the message after it']]);
});

test('thinking: a stored body\'s thinking sent without its calls; with them, nothing', () => {
  const withThinking = STORE.map((m) => (m.id === '2' ? { ...m, content: [thinking, text('two'), call('t1')] } : m));
  const m = manager({ messages: withThinking });
  const two = withThinking[1];
  byId.set('2', two);
  try {
    assert.deepEqual(named(check(m, ['r:1', ['r:2', [thinking, text('two')]]], { compresses: false })), [['thinking', 'message 1 carries body start+2\'s thinking without its calls start+2 call 1']]);
    assert.deepEqual(check(m, ['r:1', 'r:2', 'r:3', 'r:4']), []);
  } finally {
    byId.set('2', STORE[1]);
  }
});

test('pins: a summary sent over a pinned message at a level the pin doesn\'t allow; at an allowed level, nothing', () => {
  const pinned = (level) => manager({ summaries: { S: { sourceIds: ['1', '2'] } }, pins: [{ id: 'p1', firstMessageId: '1', lastMessageId: '2', level }] });
  assert.deepEqual(named(check(pinned(0), ['s:S@1', 'r:3', 'r:4'])).filter(([inv]) => inv === 'pins'), [['pins', 'summary L1(start+1-start+2) at L1 covers start+1, inside pin pin(start+1-start+2) allowing L0']]);
  assert.deepEqual(check(pinned(1), ['s:S@1', 'r:3', 'r:4']).filter((v) => v.invariant === 'pins'), []);
});

test('unreadable: a store or pins read that fails is a violation naming the read, never a compile judged clean; the manager\'s render stats aren\'t read at all', () => {
  const failing = (what) => () => { throw new Error(`${what} failed`); };
  assert.deepEqual(named(check({ ...manager(), getAllMessages: failing('store') }, ['r:1'])), [['unreadable', 'getAllMessages: store failed; no invariant was judged']]);
  assert.deepEqual(named(check({ ...manager(), listPins: failing('pins') }, ['r:1', 'r:2', 'r:3', 'r:4'])), [['unreadable', 'listPins: pins failed; pins weren\'t judged']]);
  const [compiled, messages] = compile(['r:1', 'r:2', 'r:3', 'r:4']);
  delete compiled.renderStats;
  assert.deepEqual(named(checkCompile({ ...manager(), getRenderStats: failing('stats') }, BUDGET, compiled, messages)), [], 'a compile\'s budget is judged on its own stats only');
});
const shard = (id, sequence, index, words, group = 'g1') => ({ ...stored(id, sequence, 'user', [text(words)]), bodyGroupId: group, shardIndex: index });

test('coverage is per shard: one shard\'s summary doesn\'t cover the other, and a partial raw copy holds only the shards whose text it carries', () => {
  const sharded = [...STORE, shard('5', 5, 0, 'first half'), shard('6', 6, 1, 'second half')];
  for (const m of sharded) byId.set(m.id, m);
  try {
    const m = manager({ messages: sharded, summaries: { S: { sourceIds: ['5'] } } });
    assert.deepEqual(named(check(m, ['r:1', 'r:2', 'r:3', 'r:4', 's:S@1'])), [['coverage', '1 stored bodies in no message sent: start+5 (shards start+6)']]);
    assert.deepEqual(check(m, ['r:1', 'r:2', 'r:3', 'r:4', 's:S@1', ['r:5!shards', [text('second half')]]]), [], 'the partial copy carries the second shard');
    assert.deepEqual(named(check(manager({ messages: sharded }), ['r:1', 'r:2', 'r:3', 'r:4', ['r:5!shards', [text('first half')]]])), [['coverage', '1 stored bodies in no message sent: start+5 (shards start+6)']]);
    assert.deepEqual(check(manager({ messages: sharded }), ['r:1', 'r:2', 'r:3', 'r:4', 'r:5']), [], 'a whole raw copy holds every shard');
  } finally {
    for (const m of sharded) if (!STORE.includes(m)) byId.delete(m.id);
  }
});

test('a raw copy context-manager marks altered (`!content`) but not partial carries every shard: covered, and beside a summary of one of them', () => {
  const sharded = [...STORE, shard('5', 5, 0, 'first half'), shard('6', 6, 1, 'second half')];
  for (const m of sharded) byId.set(m.id, m);
  try {
    assert.deepEqual(check(manager({ messages: sharded }), ['r:1', 'r:2', 'r:3', 'r:4', ['r:5!content', [text('first half, altered')]]]), []);
    const m = manager({ messages: sharded, summaries: { S: { sourceIds: ['6'] } } });
    assert.deepEqual(named(check(m, ['r:1', 'r:2', 'r:3', 'r:4', ['r:5!content', [text('first half, altered')]], 's:S@1'])), [['beside-sources', '1 stored messages sent raw beside a summary of them: start+6 raw beside L1(start+6)']]);
  } finally {
    for (const m of sharded) if (!STORE.includes(m)) byId.delete(m.id);
  }
});

test('bodies are context-manager\'s: two ingestions of one text, sharing a group id, are two bodies, so the second sent nowhere is a lost body', () => {
  const twice = [...STORE, shard('5', 5, 0, 'doc a'), shard('6', 6, 1, 'doc b'), shard('7', 7, 0, 'doc a'), shard('8', 8, 1, 'doc b')];
  for (const m of twice) byId.set(m.id, m);
  try {
    assert.deepEqual(named(check(manager({ messages: twice }), ['r:1', 'r:2', 'r:3', 'r:4', 'r:5'])), [['coverage', '1 stored bodies in no message sent: start+7']]);
    assert.deepEqual(check(manager({ messages: twice }), ['r:1', 'r:2', 'r:3', 'r:4', 'r:5', 'r:7']), []);
  } finally {
    for (const m of twice) if (!STORE.includes(m)) byId.delete(m.id);
  }
});

test('coverage: one carried text holds one shard, so of two shards with the same text, a partial copy carrying it once loses the other', () => {
  const twin = [...STORE, shard('5', 5, 0, 'same words'), shard('6', 6, 1, 'same words')];
  for (const m of twin) byId.set(m.id, m);
  try {
    assert.deepEqual(named(check(manager({ messages: twin }), ['r:1', 'r:2', 'r:3', 'r:4', ['r:5!shards', [text('same words')]]])), [['coverage', '1 stored bodies in no message sent: start+5 (shards start+6)']]);
    assert.deepEqual(check(manager({ messages: twin }), ['r:1', 'r:2', 'r:3', 'r:4', ['r:5!shards', [text('same wordssame words')]]]), [], 'carried twice, both held');
  } finally {
    for (const m of twin) if (!STORE.includes(m)) byId.delete(m.id);
  }
});

test('a view member its own slot doesn\'t hold is judged from the slot that holds it; one no slot holds is unreadable', () => {
  const shared = [stored('9', 9, 'user', [text('nine')])];
  const elsewhere = (ids) => ({ found: shared.filter((m) => ids.includes(m.id)), unfound: ids.filter((id) => !shared.some((m) => m.id === id)) });
  const [compiled, messages] = compile(['r:1', 'r:2', 'r:3', 'r:4']);
  compiled.provenance = { layout: { memberIds: ['1', '2', '3', '4', '9'], units: [{ k: 'r', t: 1 }, { k: 'r', t: 1 }, { k: 'r', t: 1 }, { k: 'r', t: 1 }, { k: 'o', n: 1 }] } };
  assert.deepEqual(named(checkCompile(manager(), BUDGET, compiled, messages, { elsewhere })), [['coverage', '1 stored bodies in no message sent: 9']], 'the shared slot\'s message is in the store judged');
  compiled.provenance.layout.memberIds.push('10');
  assert.deepEqual(named(checkCompile(manager(), BUDGET, compiled, messages, { elsewhere })).filter(([v]) => v === 'unreadable'), [['unreadable', 'view members no registered agent\'s slot holds: 10; what depends on it wasn\'t judged']]);
  assert.deepEqual(named(checkCompile(manager(), BUDGET, compiled, messages)).filter(([v]) => v === 'unreadable').length, 1, 'with nothing to read other slots by, every member it doesn\'t hold is unreadable');
});

test('unreadable: a summary or strategy read that fails is a violation naming it, never a throw or a default', () => {
  const failing = (what) => () => { throw new Error(`${what} failed`); };
  const m = { ...manager({ summaries: { S: { sourceIds: ['1', '2'] } } }), getSummary: failing('summary') };
  assert.deepEqual(named(check(m, ['s:S@1', 'r:3', 'r:4'])).filter(([v]) => v === 'unreadable'), [['unreadable', 'getSummary(S): summary failed; what depends on it wasn\'t judged']]);
  assert.deepEqual(named(check({ ...manager(), getStrategy: failing('strategy') }, ['r:1', 'r:2', 'r:3', 'r:4'])), [['unreadable', 'getStrategy: strategy failed; budget wasn\'t judged']]);
  assert.deepEqual(named(check(manager(), ['r:1', 'r:2', 'r:3', 'r:4'], { compresses: { unreadable: 'strategy failed' } })), [['unreadable', 'getStrategy: strategy failed; coverage wasn\'t judged']]);
});

test('a partial copy\'s shards are those context-manager\'s layout names raw: a text an earlier summarised shard shares stands for the raw one', () => {
  const twin = [...STORE, shard('5', 5, 0, 'same words'), shard('6', 6, 1, 'same words')];
  for (const m of twin) byId.set(m.id, m);
  try {
    const m = manager({ messages: twin, summaries: { S: { sourceIds: ['5'] } } });
    const [compiled, messages] = compile(['r:1', 'r:2', 'r:3', 'r:4', 's:S@1', ['r:5!shards', [text('same words')]]]);
    compiled.provenance.layout = { memberIds: ['1', '2', '3', '4', '5', '6'], units: [{ k: 'r', t: 1 }, { k: 'r', t: 1 }, { k: 'r', t: 1 }, { k: 'r', t: 1 }, { k: 's', n: 1, sm: [['S', 1, 'llm', 0, 5]] }, { k: 'r', t: 1, p: 1 }] };
    assert.deepEqual(checkCompile(m, BUDGET, compiled, messages), []);
  } finally {
    for (const m of twin) if (!STORE.includes(m)) byId.delete(m.id);
  }
});

test('unreadable: a summary sent that the store doesn\'t return, and a compile with no layout, are named, never judged clean', () => {
  assert.deepEqual(named(check(manager(), ['s:GONE@1', 'r:3', 'r:4'])), [
    ['shape', 'message 1: result start+2 call 1 answers no call in the message before it'],
    ['unreadable', 'getSummary(GONE): no such summary; what depends on it wasn\'t judged'],
  ], 'coverage, order and pins give no verdict on sources they couldn\'t read; shape, which needs none, still does');
  const [compiled, messages] = compile(['r:1', 'r:2', 'r:3', 'r:4']);
  delete compiled.provenance;
  assert.deepEqual(named(checkCompile(manager(), BUDGET, compiled, messages)), [['unreadable', 'the compile gave no layout, so its view\'s members beyond its own slot weren\'t read; what depends on it wasn\'t judged']]);
});

test('store order takes a partial copy\'s shards from context-manager\'s layout too, so a text an earlier shard shares doesn\'t put the copy out of order', () => {
  const body = [...STORE, shard('5', 5, 0, 'same words'), shard('6', 6, 1, 'other words'), shard('7', 7, 2, 'same words')];
  for (const m of body) byId.set(m.id, m);
  try {
    const m = manager({ messages: body, summaries: { U: { sourceIds: ['5'] }, T: { sourceIds: ['6'] } } });
    const [compiled, messages] = compile(['r:1', 'r:2', 'r:3', 'r:4', 's:U@1', 's:T@1', ['r:5!shards', [text('same words')]]]);
    compiled.provenance.layout = { memberIds: ['1', '2', '3', '4', '5', '6', '7'], units: [{ k: 'r', t: 1 }, { k: 'r', t: 1 }, { k: 'r', t: 1 }, { k: 'r', t: 1 }, { k: 's', n: 1, sm: [['U', 1, 'llm', 0, 5]] }, { k: 's', n: 1, sm: [['T', 1, 'llm', 0, 5]] }, { k: 'r', t: 1, p: 1 }] };
    assert.deepEqual(checkCompile(m, BUDGET, compiled, messages), []);
  } finally {
    for (const m of body) if (!STORE.includes(m)) byId.delete(m.id);
  }
});

test('a raw source the compile sent that its layout doesn\'t list is read from the slot that holds it too', () => {
  const shared = [stored('9', 9, 'user', [text('nine')])];
  for (const m of shared) byId.set(m.id, m);
  try {
    const asked = [];
    const elsewhere = (ids) => { asked.push(...ids); return { found: shared.filter((m) => ids.includes(m.id)), unfound: ids.filter((id) => !shared.some((m) => m.id === id)) }; };
    const [compiled, messages] = compile(['r:1', 'r:2', 'r:3', 'r:4', 'r:9']);
    compiled.provenance.layout = { memberIds: ['1', '2', '3', '4'], units: [{ k: 'r', t: 1 }, { k: 'r', t: 1 }, { k: 'r', t: 1 }, { k: 'r', t: 1 }] };
    assert.deepEqual(checkCompile(manager(), BUDGET, compiled, messages, { elsewhere }), []);
    assert.deepEqual(asked, ['9']);
  } finally {
    for (const m of shared) byId.delete(m.id);
  }
});

test('store order: a partial copy\'s shards are assigned to the messages that carry them in order, so a later message carrying a text an earlier shard shares isn\'t put before the message between', () => {
  const body = [...STORE, shard('5', 5, 0, 'same words'), shard('6', 6, 1, 'other words'), shard('7', 7, 2, 'same words')];
  for (const m of body) byId.set(m.id, m);
  try {
    const [compiled, messages] = compile(['r:1', 'r:2', 'r:3', 'r:4', ['r:5!shards', [text('same words')]], ['r:5!shards', [text('other words')]], ['r:5!shards', [text('same words')]]]);
    compiled.provenance.layout = { memberIds: ['1', '2', '3', '4', '5', '6', '7'], units: ['1', '2', '3', '4', '5', '6', '7'].map(() => ({ k: 'r', t: 1, p: 1 })) };
    assert.deepEqual(checkCompile(manager({ messages: body }), BUDGET, compiled, messages), []);
  } finally {
    for (const m of body) if (!STORE.includes(m)) byId.delete(m.id);
  }
});

test('unreadable: with a summary unreadable, store order gives no verdict; with it readable, the same compile is out of order', () => {
  assert.deepEqual(named(check(manager(), ['s:GONE@1', 'r:4', 'r:1'])), [['unreadable', 'getSummary(GONE): no such summary; what depends on it wasn\'t judged']]);
  assert.deepEqual(named(check(manager({ summaries: { S: { sourceIds: ['2', '3'] } } }), ['s:S@1', 'r:4', 'r:1'])), [['coverage', 'message 2 covers from start+1, before message 1\'s start+4']]);
});

test('unreadable: with a summary unreadable, pins give no verdict; with it readable, the same pin is broken', () => {
  const pinned = (summaries) => manager({ summaries, pins: [{ id: 'p1', firstMessageId: '1', lastMessageId: '2', level: 0 }] });
  const pins = (m, sent) => named(check(m, sent)).filter(([v]) => v === 'pins');
  assert.deepEqual(pins(pinned({ S: { sourceIds: ['1', '2'] } }), ['s:GONE@1', 's:S@1', 'r:3', 'r:4']), []);
  assert.deepEqual(pins(pinned({ S: { sourceIds: ['1', '2'] }, GONE: { sourceIds: [] } }), ['s:GONE@1', 's:S@1', 'r:3', 'r:4']), [['pins', 'summary L1(start+1-start+2) at L1 covers start+1, inside pin pin(start+1-start+2) allowing L0']]);
});

test('a flag names stored messages, summaries and pins by canary and place, and a call by the canary in its input, so ids shifted by a write elsewhere rename nothing', () => {
  const details = (shift) => {
    const id = (n) => String(n + shift);
    const messages = [
      stored(id(1), 1, 'user', [text('[[c:a.in]] one')]),
      stored(id(2), 2, 'assistant', [text('[[c:a.r1]] two'), { type: 'tool_use', id: `toolu_fx${1 + shift}`, name: 'look', input: { canary: '[[c:a.call1]]' } }]),
      stored(id(3), 3, 'user', [{ type: 'tool_result', toolUseId: `toolu_fx${1 + shift}`, content: 'seen' }]),
      stored(id(4), 4, 'assistant', [text('four')]),
    ];
    for (const m of messages) byId.set(m.id, m);
    try {
      const m = manager({ messages, summaries: { [`L1-${1 + shift}`]: { sourceIds: [id(1), id(2)] } }, pins: [{ id: `pin-${1 + shift}`, firstMessageId: id(1), lastMessageId: id(2), level: 0 }] });
      return named(check(m, [`s:L1-${1 + shift}@1`, `r:${id(3)}`, `r:${id(4)}`, `r:${id(1)}`]));
    } finally {
      for (const m of messages) byId.delete(m.id);
      for (const m of STORE) byId.set(m.id, m);
    }
  };
  assert.deepEqual(details(0), [
    ['beside-sources', '1 stored messages sent raw beside a summary of them: a.in raw beside L1(a.in-a.r1)'],
    ['coverage', 'message 3 covers from a.in, before message 2\'s a.r1+2'],
    ['shape', 'message 1: result a.call1 answers no call in the message before it'],
    ['pins', 'summary L1(a.in-a.r1) at L1 covers a.in, inside pin pin(a.in-a.r1) allowing L0'],
  ]);
  assert.deepEqual(details(1), details(0), 'every id one higher, as a write in another store leaves them');
});

test('shape names the call involved, so a tool-use id two stored calls reuse names the one whose pairing broke', () => {
  const messages = [
    stored('1', 1, 'assistant', [text('[[c:a.r1]] one'), { type: 'tool_use', id: 't1', name: 'look', input: { canary: '[[c:a.call1]]' } }]),
    stored('2', 2, 'user', [{ type: 'tool_result', toolUseId: 't1', content: 'seen' }]),
    stored('3', 3, 'assistant', [text('[[c:a.r2]] two'), { type: 'tool_use', id: 't1', name: 'look', input: { canary: '[[c:a.call2]]' } }]),
    stored('4', 4, 'user', [{ type: 'tool_result', toolUseId: 't1', content: 'seen' }]),
  ];
  for (const m of messages) byId.set(m.id, m);
  try {
    assert.deepEqual(named(check(manager({ messages, summaries: { S: { sourceIds: ['3'] } } }), ['r:1', 'r:2', 's:S@1', 'r:4'])).filter(([v]) => v === 'shape'), [
      ['shape', 'message 3: result a.call2 answers no call in the message before it'],
    ]);
  } finally {
    for (const m of messages) byId.delete(m.id);
    for (const m of STORE) byId.set(m.id, m);
  }
});

test('store order reads which shards each message carries, so a complete body context-manager split across messages in reverse is out of order', () => {
  const body = [...STORE, shard('5', 5, 0, 'first words'), shard('6', 6, 1, 'second words')];
  for (const m of body) byId.set(m.id, m);
  try {
    const sent = (texts) => {
      const [compiled, messages] = compile(['r:1', 'r:2', 'r:3', 'r:4', ...texts.map((t) => ['r:5', [text(t)]])]);
      compiled.provenance.layout = { memberIds: ['1', '2', '3', '4', '5', '6'], units: ['1', '2', '3', '4', '5', '6'].map(() => ({ k: 'r', t: 1 })) };
      return named(checkCompile(manager({ messages: body }), BUDGET, compiled, messages));
    };
    assert.deepEqual(sent(['first words', 'second words']), []);
    assert.deepEqual(sent(['second words', 'first words']), [['coverage', 'message 5 covers from start+5, before message 4\'s start+6']]);
  } finally {
    for (const m of body) if (!STORE.includes(m)) byId.delete(m.id);
  }
});

test('a reused tool-use id is named by the occurrence involved at an unanswered call and in a thinking detail, and a sent result the store doesn\'t hold by the stored one', () => {
  const callBlock = (canary) => ({ type: 'tool_use', id: 't1', name: 'look', input: { canary } });
  const withStore = (messages, run) => {
    for (const m of messages) byId.set(m.id, m);
    try { return run(); } finally {
      for (const m of messages) byId.delete(m.id);
      for (const m of STORE) byId.set(m.id, m);
    }
  };
  const reused = [
    stored('1', 1, 'assistant', [text('[[c:a.r1]] one'), callBlock('[[c:a.call1]]')]),
    stored('2', 2, 'user', [{ type: 'tool_result', toolUseId: 't1', content: 'seen' }]),
    stored('3', 3, 'assistant', [thinking, text('[[c:a.r2]] two'), callBlock('[[c:a.call2]]')]),
    stored('4', 4, 'user', [{ type: 'tool_result', toolUseId: 't1', content: 'seen' }]),
    stored('5', 5, 'user', [text('[[c:a.in2]] next')]),
  ];
  withStore(reused, () => {
    const unanswered = named(check(manager({ messages: reused, summaries: { S: { sourceIds: ['1', '2'] } } }), ['s:S@1', 'r:3', 'r:5']));
    assert.deepEqual(unanswered.filter(([v]) => v === 'shape'), [['shape', 'message 1: call a.call2 unanswered in the message after it']]);
    const [compiled, messages] = compile(['r:1', 'r:2', ['r:3', [thinking, text('[[c:a.r2]] two')]], 'r:4', 'r:5']);
    assert.deepEqual(named(checkCompile(manager({ messages: reused }), BUDGET, compiled, messages)).filter(([v]) => v === 'thinking'), [['thinking', 'message 2 carries body a.r2\'s thinking without its calls a.call2']]);
  });
  const orphan = [
    stored('1', 1, 'user', [text('[[c:b.in]] one')]),
    stored('2', 2, 'user', [{ type: 'tool_result', toolUseId: 't9', content: 'seen' }]),
  ];
  withStore(orphan, () => {
    const [compiled, messages] = compile(['r:1', ['r:1', [{ type: 'tool_result', toolUseId: 't9', content: 'seen' }]], 'r:2']);
    assert.deepEqual(named(checkCompile(manager({ messages: orphan }), BUDGET, compiled, messages)).filter(([v]) => v === 'shape').slice(0, 1), [['shape', 'message 1: result b.in+1 result 1 answers no call in the message before it']], 'a result sent with no stored key is named by where the store holds one');
  });
});

test('store order places nothing it can\'t identify: a message of a split body holding none of its shards\' text, such as one sent capped, is named in an unplaced flag with its count, not ordered by the body\'s head', () => {
  const body = [...STORE, shard('5', 5, 0, 'first words'), shard('6', 6, 1, 'second words'), shard('7', 7, 2, 'third words, long')];
  for (const m of body) byId.set(m.id, m);
  try {
    const [compiled, messages] = compile(['r:1', 'r:2', 'r:3', 'r:4', ['r:5', [text('first words')]], ['r:5', [text('second words')]], ['r:5', [text('third wo')]]]);
    compiled.provenance.layout = { memberIds: ['1', '2', '3', '4', '5', '6', '7'], units: ['1', '2', '3', '4', '5', '6', '7'].map(() => ({ k: 'r', t: 1 })) };
    const violations = checkCompile(manager({ messages: body }), BUDGET, compiled, messages);
    assert.deepEqual(named(violations).filter(([v, d]) => v === 'unplaced' || d.includes('covers from')), [['unplaced', 'store order couldn\'t place 1 of what was sent, so it judged the order without it: message 6\'s copy of start+5, which holds none of its shards\' text, where the body goes out in 3 messages']]);
    assert.equal(violations.find((v) => v.invariant === 'unplaced').count, 1);
  } finally {
    for (const m of body) if (!STORE.includes(m)) byId.delete(m.id);
  }
});

test('store order judges each repeated intact copy of a body where it stands, so a later copy sent out of order is flagged', () => {
  const body = [...STORE, shard('5', 5, 0, 'first half'), shard('6', 6, 1, 'second half'), stored('8', 8, 'user', [text('eight')])];
  for (const m of body) byId.set(m.id, m);
  try {
    const intact = [text('first halfsecond half')];
    const order = (sent) => named(check(manager({ messages: body }), sent)).filter(([v, d]) => v === 'unplaced' || d.includes('covers from'));
    assert.deepEqual(order(['r:1', 'r:2', 'r:3', 'r:4', ['r:5', intact], 'r:8', ['r:5', intact]]), [['coverage', 'message 6 covers from start+5, before message 5\'s start+7']]);
    assert.deepEqual(order(['r:1', 'r:2', 'r:3', 'r:4', ['r:5', intact], ['r:5', intact], 'r:8']), [], 'two copies in order');
  } finally {
    for (const m of body) if (!STORE.includes(m)) byId.delete(m.id);
  }
});

test('store order takes the body\'s first shard for a one-message copy only where it carries every shard: a partial copy holding none of its shards\' text is unplaced, not ordered by the head', () => {
  const body = [...STORE, shard('5', 5, 0, 'first words'), shard('6', 6, 1, 'second words'), shard('7', 7, 2, 'third words, long')];
  for (const m of body) byId.set(m.id, m);
  try {
    const order = (sent) => named(check(manager({ messages: body, summaries: { S: { sourceIds: ['6'] } } }), sent)).filter(([v, d]) => v === 'unplaced' || d.includes('covers from'));
    assert.deepEqual(order(['r:1', 'r:2', 'r:3', 'r:4', 's:S@1', ['r:5!shards', [text('third wo')]]]), [['unplaced', 'store order couldn\'t place 1 of what was sent, so it judged the order without it: message 5\'s copy of start+5, which holds none of its shards\' text, where the copy doesn\'t carry every shard']]);
    assert.deepEqual(order(['r:1', 'r:2', 'r:3', 'r:4', 's:S@1', ['r:5!content', [text('altered')]]]), [['coverage', 'message 5 covers from start+5, before message 4\'s start+6']], 'a one-message copy carrying every shard, altered, starts at the body\'s first shard');
  } finally {
    for (const m of body) if (!STORE.includes(m)) byId.delete(m.id);
  }
});

test('store order places each copy by the shards whose text it carries, not at the body\'s first shard, where context-manager\'s layout sends only some of the body raw', () => {
  const body = [...STORE, shard('5', 5, 0, 'first words'), shard('6', 6, 1, 'second words'), shard('7', 7, 2, 'third words')];
  for (const m of body) byId.set(m.id, m);
  try {
    const [compiled, messages] = compile(['r:1', 'r:2', 'r:3', 'r:4', ['r:6!shards', [text('second wordsthird words')]], 's:S@1', ['r:6!shards', [text('second wordsthird words')]]]);
    const r = { k: 'r', t: 1 };
    compiled.provenance.layout = { memberIds: ['1', '2', '3', '4', '5', '6', '7'], units: [r, r, r, r, { k: 's', n: 1 }, r, r] };
    const violations = checkCompile(manager({ messages: body, summaries: { S: { sourceIds: ['5'] } } }), BUDGET, compiled, messages);
    assert.deepEqual(named(violations).filter(([v, d]) => v === 'unplaced' || d.includes('covers from')), [['coverage', 'message 5 covers from start+5, before message 4\'s start+6']]);
  } finally {
    for (const m of body) if (!STORE.includes(m)) byId.delete(m.id);
  }
});

test('store order places an intact copy sent after a partial one at its body\'s first shard, each occurrence of a shard\'s text taken once and in order', () => {
  const body = [...STORE, shard('5', 5, 0, 'first words'), shard('6', 6, 1, 'second words'), shard('7', 7, 2, 'third words')];
  for (const m of body) byId.set(m.id, m);
  try {
    const order = (sent, summaries) => named(check(manager({ messages: body, summaries }), sent)).filter(([v, d]) => v === 'unplaced' || d.includes('covers from'));
    assert.deepEqual(order(['r:1', 'r:2', 'r:3', 'r:4', ['r:5!shards', [text('first words')]], 's:S@1', ['r:5', [text('first wordssecond wordsthird words')]]], { S: { sourceIds: ['6'] } }), [['coverage', 'message 6 covers from start+5, before message 5\'s start+6']]);
  } finally {
    for (const m of body) if (!STORE.includes(m)) byId.delete(m.id);
  }
  const same = [...STORE, shard('5', 5, 0, 'the same words'), shard('6', 6, 1, 'other words'), shard('7', 7, 2, 'the same words')];
  for (const m of same) byId.set(m.id, m);
  try {
    assert.deepEqual(named(check(manager({ messages: same, summaries: { S: { sourceIds: ['6'] } } }), ['r:1', 'r:2', 'r:3', 'r:4', ['r:5!shards', [text('the same words')]], 's:S@1', ['r:5!shards', [text('the same words')]]])).filter(([v, d]) => v === 'unplaced' || d.includes('covers from')), [], 'a later occurrence of a text two shards share is the later shard');
  } finally {
    for (const m of same) if (!STORE.includes(m)) byId.delete(m.id);
  }
});

test('store order names every part it couldn\'t place, however many, and a raw copy of a body no slot read holds', () => {
  const summaries = Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((x) => [x, { sourceIds: ['99'] }]));
  const many = check(manager({ summaries }), ['r:1', 's:A@1', 's:B@1', 's:C@1', 's:D@1', 's:E@1', 'r:2', 'r:3', 'r:4']).find((v) => v.invariant === 'unplaced');
  assert.equal(many.count, 5);
  for (const x of ['A', 'B', 'C', 'D', 'E']) assert.ok(many.detail.includes(`summary ${x},`), x);
  const ghost = stored('42', 42, 'user', [text('ghost')]);
  byId.set('42', ghost);
  try {
    assert.deepEqual(named(check(manager(), ['r:1', 'r:4', 'r:42', 'r:2'])).filter(([v, d]) => v === 'unplaced' || d.includes('covers from')), [
      ['coverage', 'message 3 covers from start+2, before message 1\'s start+4'],
      ['unplaced', 'store order couldn\'t place 1 of what was sent, so it judged the order without it: message 2\'s copy of 42, which no slot read holds'],
    ]);
  } finally {
    byId.delete('42');
  }
});

test('budget: a compile whose strategy gives no render stats isn\'t judged for its budget and says why, beside the violations; one whose strategy gives them and didn\'t is a couldn\'t-judge', () => {
  class PassthroughStrategy { config = {}; }
  class AutobiographicalStrategy { config = {}; getRenderStats() { return null; } }
  const statless = (strategy) => {
    const [compiled, messages] = compile(['r:1', 'r:2', 'r:3', 'r:4']);
    delete compiled.renderStats;
    return checkCompile({ ...manager(), getStrategy: () => strategy }, BUDGET, compiled, messages);
  };
  const passthrough = statless(new PassthroughStrategy());
  assert.deepEqual([named(passthrough), passthrough.unjudged], [[], ['budget: PassthroughStrategy gives no render stats']]);
  const capable = statless(new AutobiographicalStrategy());
  assert.deepEqual([named(capable), capable.unjudged], [[['unreadable', 'the compile gave no render stats, though its strategy AutobiographicalStrategy reports them; budget wasn\'t judged']], []]);
  const [compiled, messages] = compile(['r:1', 'r:2', 'r:3', 'r:4']);
  delete compiled.renderStats;
  const snapshot = checkCompile({ ...manager(), getStrategy: () => new AutobiographicalStrategy(), getRenderStats: () => ({ total: { tokens: 99_999 } }) }, BUDGET, compiled, messages);
  assert.deepEqual(named(snapshot), [['unreadable', 'the compile gave no render stats, though its strategy AutobiographicalStrategy reports them; budget wasn\'t judged']], 'not judged on the manager\'s last live compile\'s stats, over budget or under');
  assert.deepEqual(check(manager(), ['r:1', 'r:2', 'r:3', 'r:4']).unjudged, [], 'with stats, judged');
});

test('store order names a summary none of whose messages the store holds as unplaced, and judges the rest', () => {
  const violations = check(manager({ summaries: { S: { sourceIds: ['99'] } } }), ['r:1', 's:S@1', 'r:4', 'r:2']);
  assert.deepEqual(named(violations).filter(([v, d]) => v === 'unplaced' || d.includes('covers from')), [
    ['coverage', 'message 3 covers from start+2, before message 2\'s start+4'],
    ['unplaced', 'store order couldn\'t place 1 of what was sent, so it judged the order without it: message 1\'s summary S, none of whose messages a slot read holds'],
  ]);
});

test('check 11 names a stored message whose only block is a call by the canary in the call\'s input', () => {
  const callOnly = [...STORE, stored('5', 5, 'assistant', [{ type: 'tool_use', id: 't5', name: 'deliver_summary', input: { text: '[[c:h1.read]] words' } }])];
  for (const m of callOnly) byId.set(m.id, m);
  try {
    assert.deepEqual(named(check(manager({ messages: callOnly }), ['r:1', 'r:2', 'r:3', 'r:4'])).filter(([v]) => v === 'coverage'), [['coverage', '1 stored bodies in no message sent: h1.read']]);
  } finally {
    for (const m of callOnly) if (!STORE.includes(m)) byId.delete(m.id);
  }
});
