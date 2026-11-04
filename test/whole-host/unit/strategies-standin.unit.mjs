import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countTokens, repairMarks, startStandin as startServer, tokensSent } from '../lib/strategies/standin.mjs';

const ANSWER_BOUND_MS = 10_000;
const started = new Set();
after(async () => { for (const s of started) await s.close(); });
async function startStandin(options) {
  const s = await startServer(options);
  started.add(s);
  return s;
}

const TOOLS = [{ name: 'time--now', description: 'now', input_schema: { type: 'object', properties: {} } }];
const NOTE = '[host note: this message arrived over IPC and carries no channel locus.]';
const CHAT = 'Write the memory of events since the most recent memory system notification. Speak in the first person from your own perspective. Target ~200 tokens. Output only the memory body.';
const MERGE = 'You have just reviewed the slices of recent experience above (raw conversation), in chronological order. They cover the stretch of experience you are about to consolidate into a single L2 memory. Write a memory that preserves the through-line. Target ~200 tokens. Output only the memory body — no preamble, no meta-commentary about summarizing.';
const WITNESSED = 'Write the memory of this slice of the log. This part of the record predates your own first turn. Target ~200 tokens.';
const READING = 'You have just been reading a substantial body of text — approximately 4000 tokens total in this piece, of which what you just read is a portion. Target ~200 tokens.';
const READING_MERGE = 'You have just re-experienced the portions of text you read above (raw passages from a larger piece), in chronological order. They cover a contiguous stretch of a substantial body of text you have been reading — approximately 9000 tokens in total across all of it. The portions above cover the stretch you are now consolidating at L2.\n\nReflect across the stretch. Target ~200 tokens.';
// Knowledge's other three openings, as context-manager's knowledge.ts writes them (leadSuffix empty).
const SYNTHESIS = 'Capture the reasoning and conclusions from this discussion. What connections were drawn? What hypotheses were formed or rejected? What decisions were made about what to investigate next? Preserve the logic chain.  Aim for about 200 tokens.';
const LESSON = 'Record what knowledge was captured. What lessons were created or updated? What was the evidence basis? Note any confidence gaps or unresolved questions.  Aim for about 200 tokens.';
const SUBAGENT = 'Summarize the subagent work. What tasks were dispatched, what did each return, and what was the coordinator\'s synthesis of the results? Collapse dispatch/wait mechanics.  Aim for about 200 tokens.';
const FRONTDESK = 'Starting from my last message, please describe everything that has happened. Aim for about 200 tokens. Describe it as you would to yourself, as if you are remembering what has happened.';
const KNOWLEDGE = 'Summarize the research performed. What was searched for, what sources were consulted, and what was found? Aim for about 200 tokens.';

const prose = (n, seed = 1) => {
  const words = 'river stone lantern harbor quiet orchard ledger signal meadow copper window thread'.split(' ');
  let s = ''; let k = seed;
  while (s.length < n) { k = (k * 1103515245 + 12345) % 2147483648; s += words[k % words.length] + ' '; }
  return s.slice(0, n);
};

function agentBody({ canary, history = [], model = 'claude-opus-5-5', stream = true, max_tokens = 2048, tail = [], extra = {} }) {
  return {
    model, max_tokens, stream, system: 'You are the fixture agent.', tools: TOOLS,
    messages: [...history, { role: 'user', content: [{ type: 'text', text: `user: ${canary} ${prose(300)}` }, { type: 'text', text: NOTE }, ...tail] }],
    ...extra,
  };
}

function summariserBody({ canaries = ['[[c:x.1]]'], summaries = [], instruction = CHAT, model = 'claude-opus-5-5', max_tokens = 16000, textChars = 400 }) {
  const messages = [];
  for (const s of summaries) {
    messages.push({ role: 'user', content: [{ type: 'text', text: 'Context Manager: [CM] Recall memory L2-6.' }] });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `${s} ${prose(200, 7)}` }] });
  }
  const last = { role: 'user', content: [] };
  for (const c of canaries) last.content.push({ type: 'text', text: `user: ${c} ${prose(textChars, 3)}` }, { type: 'text', text: NOTE });
  last.content.push({ type: 'text', text: `Context Manager: ${instruction}` });
  messages.push(last);
  return { model, max_tokens, stream: false, tools: TOOLS, messages };
}

async function post(url, body, path = '/v1/messages', headers = {}) {
  try {
    return await read(await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(ANSWER_BOUND_MS) }));
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new Error(`the stand-in sent no whole answer to POST ${path} within ${ANSWER_BOUND_MS} ms`);
    throw error;
  }
}

async function read(res) {
  const type = res.headers.get('content-type') || '';
  if (!type.includes('event-stream')) return { status: res.status, json: await res.json() };
  const raw = await res.text();
  const events = raw.split('\n\n').filter(Boolean).map((chunk) => JSON.parse(chunk.split('\n').find((l) => l.startsWith('data: ')).slice(6)));
  const start = events.find((e) => e.type === 'message_start').message;
  const blocks = [];
  for (const e of events) {
    if (e.type === 'content_block_start') blocks[e.index] = { ...e.content_block };
    if (e.type === 'content_block_delta') {
      const b = blocks[e.index];
      if (e.delta.type === 'text_delta') b.text += e.delta.text;
      if (e.delta.type === 'thinking_delta') b.thinking += e.delta.thinking;
      if (e.delta.type === 'signature_delta') b.signature = (b.signature || '') + e.delta.signature;
      if (e.delta.type === 'input_json_delta') b._json = (b._json || '') + e.delta.partial_json;
    }
  }
  for (const b of blocks) if (b.type === 'tool_use') { b.input = JSON.parse(b._json || '{}'); delete b._json; }
  const delta = events.find((e) => e.type === 'message_delta');
  return { status: res.status, stream: true, json: { ...start, content: blocks, stop_reason: delta.delta.stop_reason, usage: { ...start.usage, ...delta.usage } } };
}

const textOf = (msg) => msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

function arrivals(standin) {
  const seen = [];
  let waiters = [];
  standin.onRequest((r) => { seen.push(r); waiters = waiters.filter((w) => (seen.length >= w.n ? (w.resolve(), false) : true)); });
  const until = (n) => (seen.length >= n ? Promise.resolve() : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${seen.length} of ${n} requests reached onRequest within ${ANSWER_BOUND_MS} ms`)), ANSWER_BOUND_MS);
    waiters.push({ n, resolve: () => { clearTimeout(timer); resolve(); } });
  }));
  return { seen, until };
}

const step = (id, replies = [{ text: `[[c:${id}.r1]] noted.` }], more = {}) => ({ id, segment: 'test', kind: 'text', canaries: [`[[c:${id}.in]]`], replies, ...more });

async function withStandin(opts, fn) {
  const standin = await startStandin({ configuration: { windowTokens: 50_000, ...opts } });
  try { return await fn(standin); } finally { await standin.close(); }
}

test('T1/T3: an agent request carrying the step\'s canary gets the step\'s replies in order, streamed or not', () => withStandin({}, async (s) => {
  s.setStep(step('a', [{ text: '[[c:a.r1]] first' }, { text: '[[c:a.r2]] second' }]));
  const one = await post(s.url, agentBody({ canary: '[[c:a.in]]' }));
  assert.equal(one.status, 200);
  assert.equal(one.stream, true);
  assert.equal(textOf(one.json), '[[c:a.r1]] first');
  assert.equal(one.json.stop_reason, 'end_turn');
  const two = await post(s.url, agentBody({ canary: '[[c:a.in]]', stream: false }));
  assert.equal(two.stream, undefined);
  assert.equal(textOf(two.json), '[[c:a.r2]] second');
}));

test('T3: a reply\'s blocks come thinking, text, then calls, and a reply that calls stops for tool use', () => withStandin({}, async (s) => {
  const input = { size: 400, kind: 'prose', canary: '[[c:b.call1]]' };
  s.setStep(step('b', [{ thinking: 'I should look.', text: '[[c:b.r1]] looking', calls: [{ name: 'fixture--result', input }] }]));
  for (const stream of [true]) {
    const r = await post(s.url, agentBody({ canary: '[[c:b.in]]', stream }));
    assert.deepEqual(r.json.content.map((b) => b.type), ['thinking', 'text', 'tool_use']);
    assert.equal(r.json.content[0].thinking, 'I should look.');
    assert.equal(typeof r.json.content[0].signature, 'string');
    assert.equal(r.json.content[2].name, 'fixture--result');
    assert.deepEqual(r.json.content[2].input, input);
    assert.equal(typeof r.json.content[2].id, 'string');
    assert.equal(r.json.stop_reason, 'tool_use');
  }
}));

test('T1/T3: a tool round\'s second request is the step\'s when its last message carries the call\'s canary', () => withStandin({}, async (s) => {
  s.setStep({ ...step('t', [{ text: '[[c:t.r1]] calling', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:t.call1]]' } }] }, { text: '[[c:t.r2]] done' }]), canaries: ['[[c:t.in]]', '[[c:t.call1]]'] });
  const first = await post(s.url, agentBody({ canary: '[[c:t.in]]' }));
  const call = first.json.content.find((b) => b.type === 'tool_use');
  const second = {
    model: 'claude-opus-5-5', max_tokens: 2048, stream: true, system: 'You are the fixture agent.', tools: TOOLS,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'user: [[c:t.in]] go' }] },
      { role: 'assistant', content: first.json.content },
      { role: 'user', content: [{ type: 'text', text: 'user: Clock: Wednesday 2031-01-01, 00:10 UTC' }, { type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: `[[c:t.call1]] ${prose(280)}` }] }] },
    ],
  };
  const r = await post(s.url, second);
  assert.equal(textOf(r.json), '[[c:t.r2]] done');
}));

test('T1/T2: a request with no canary of the step, with max_tokens 0, or past the step\'s replies is refused as unclassified, at once', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  s.setStep(step('u'));
  const stranger = await post(s.url, agentBody({ canary: '[[c:other.in]]' }));
  assert.equal(stranger.status, 400);
  assert.equal(stranger.json.error.type, 'invalid_request_error');
  assert.match(stranger.json.error.message, /stand-in.*unclassified/);
  assert.equal(seen.at(-1).kind, 'unclassified');
  const keepalive = await post(s.url, agentBody({ canary: '[[c:u.in]]', max_tokens: 0 }));
  assert.equal(keepalive.status, 400);
  assert.equal(seen.at(-1).kind, 'unclassified');
  assert.equal((await post(s.url, agentBody({ canary: '[[c:u.in]]' }))).status, 200);
  const extra = await post(s.url, agentBody({ canary: '[[c:u.in]]' }));
  assert.equal(extra.status, 400);
  assert.equal(seen.at(-1).kind, 'unclassified');
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.kind), ['unclassified', 'unclassified', 'agent', 'unclassified']);
  for (const r of records.filter((x) => x.kind === 'unclassified')) assert.equal(typeof r.reason, 'string');
}));

test('T1: each compression instruction context-manager sends is a summariser request, though its message carries the slice\'s canaries', () => withStandin({}, async (s) => {
  const { seen } = arrivals(s);
  s.setStep(step('k', []));
  for (const instruction of [CHAT, MERGE, WITNESSED, READING, READING_MERGE, KNOWLEDGE, SYNTHESIS, LESSON, SUBAGENT, FRONTDESK]) {
    const r = await post(s.url, summariserBody({ canaries: ['[[c:k.in]]'], instruction }));
    assert.equal(r.status, 200, instruction.slice(0, 40));
    assert.equal(seen.at(-1).kind, 'summariser', instruction.slice(0, 40));
  }
  await post(s.url, summariserBody({ instruction: `${CHAT}\n\nWrite the memory as plain text directly in your response — do not call any tools for this.` }));
  assert.equal(seen.at(-1).kind, 'summariser');
  await post(s.url, summariserBody({ instruction: 'Please consolidate these 3 L1 summaries (2 synthesis, 1 research) into a single cohesive memory. Aim for about 200 tokens.' }));
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.level), [1, 2, 1, 1, 2, 1, 1, 1, 1, 1, 1, 2]);
  assert.deepEqual(records.map((r) => r.retry), [false, false, false, false, false, false, false, false, false, false, true, false]);
}));

test('T4/T5: a summary answer opens with an id that is a function of what its request carries, then untagged padding to the target its instruction states, and the record lists what each call was sent', async () => {
  const one = await startStandin({ configuration: { windowTokens: 50_000 } });
  const other = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    one.setStep(step('p', []));
    other.setStep(step('p', []));
    const a = summariserBody({ canaries: ['[[c:p.1]]'], textChars: 4000, instruction: CHAT.replace('~200', '~60') });
    const b = summariserBody({ canaries: ['[[c:p.2]]', '[[c:p.3]]'], summaries: ['[[s:M0000aaaa]]'], textChars: 400 });
    const [small, big] = [await post(one.url, a), await post(one.url, b)];
    const [big2, small2] = [await post(other.url, b), await post(other.url, a)];
    const [x, y] = [textOf(small.json), textOf(big.json)];
    assert.match(x, /^\[\[s:M[0-9a-f]{8}\]\] Memory [0-9a-f]{8}, carried 1 canaries to c:p\.1: /);
    assert.match(y, /^\[\[s:M[0-9a-f]{8}\]\] Memory [0-9a-f]{8}, carried 2 canaries to c:p\.3: /);
    const idOf = (t) => t.match(/^\[\[s:M[0-9a-f]{8}\]\]/)[0];
    assert.notEqual(idOf(x), idOf(y));
    assert.equal(textOf(small2.json), x);
    assert.equal(textOf(big2.json), y);
    const retargeted = await post(one.url, summariserBody({ canaries: ['[[c:p.1]]'], textChars: 4000, instruction: CHAT.replace('~200', '~61') }));
    assert.notEqual(idOf(textOf(retargeted.json)), idOf(x));
    assert.equal(/<|>/.test(x + y), false);
    assert.equal(/\[\[c:/.test(x + y), false, 'a summary carries no canary in the form a message carries one');
    for (const [r, target] of [[small, 60], [big, 200]]) {
      assert.ok(Math.abs(r.json.usage.output_tokens - target) <= target * 0.05, `${r.json.usage.output_tokens} for a target of ${target}`);
    }
    records = await one.close();
    assert.deepEqual(records[1].sent, { canaries: ['[[c:p.2]]', '[[c:p.3]]'], summaries: ['[[s:M0000aaaa]]'] });
    assert.equal(records[1].answer.summary, idOf(y));
  } finally {
    if (!records) await one.close();
    await other.close();
  }
});

test('T1/T4: a compression instruction that states no target is refused as unclassified', () => withStandin({}, async (s) => {
  s.setStep(step('nt', []));
  const r = await post(s.url, summariserBody({ instruction: CHAT.replace('Target ~200 tokens. ', '') }));
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /no target/);
}));
test('T4: an answer never runs past what max_tokens allows: one that would is cut there, with a max_tokens stop, as a provider cuts it', () => withStandin({}, async (s) => {
  const scripted = `[[c:m.r1]] ${prose(4_000)}`;
  s.setStep(step('m', [{ text: scripted }, { text: scripted }]));
  const summary = await post(s.url, summariserBody({ canaries: ['[[c:m.1]]'], textChars: 40_000, max_tokens: 100 }));
  assert.ok(summary.json.usage.output_tokens <= 100, String(summary.json.usage.output_tokens));
  assert.equal(summary.json.stop_reason, 'max_tokens');
  assert.ok(textOf(summary.json).length <= 100 * 2.2, `the summary itself is cut to what 100 tokens of prose hold: ${textOf(summary.json).length} chars`);
  for (const stream of [false, true]) {
    const reply = (await post(s.url, agentBody({ canary: '[[c:m.in]]', stream, max_tokens: 50 }))).json;
    assert.ok(reply.usage.output_tokens <= 50, String(reply.usage.output_tokens));
    assert.equal(reply.stop_reason, 'max_tokens');
    const text = textOf(reply);
    assert.ok(text.length > 0 && text.length <= 50 * 2.2, `${stream ? 'streamed' : 'whole'}: the text itself is cut to what 50 tokens of prose hold: ${text.length} chars`);
    assert.ok(scripted.startsWith(text), 'the answer is its own beginning, cut');
  }
  const fits = await post(s.url, summariserBody({ canaries: ['[[c:m.2]]'], max_tokens: 16_000 }));
  assert.equal(fits.json.stop_reason, 'end_turn', 'an answer within the ceiling ends as it would');
  const none = await post(s.url, { ...summariserBody({ canaries: ['[[c:m.3]]'] }), max_tokens: undefined });
  assert.equal(none.status, 400, 'a request without max_tokens is refused, as the API refuses it');
}));

test('T6: a step\'s bad answers go one each, in order, to the next first attempts, from that step on; a retry is answered well', () => withStandin({}, async (s) => {
  s.setStep(step('bad', [], { badAnswers: ['thinking-only', 'empty', 'max-tokens'] }));
  const retry = (instruction) => summariserBody({ instruction: `${instruction}\n\nWrite the memory directly as plain prose — do not wrap it in <thinking> or any other tags; begin immediately with the memory text itself.` });
  const got = [];
  got.push((await post(s.url, summariserBody({}))).json);
  got.push((await post(s.url, retry(CHAT))).json);
  s.setStep(step('bad.cp', []));
  for (let i = 0; i < 3; i++) got.push((await post(s.url, summariserBody({}))).json);
  assert.match(textOf(got[0]), /^<thinking>[\s\S]*<\/thinking>$/);
  assert.equal(got[0].stop_reason, 'end_turn');
  assert.match(textOf(got[1]), /^\[\[s:M[0-9a-f]{8}\]\] /, 'the retry gets a good answer');
  assert.deepEqual(got[2].content, [{ type: 'text', text: '' }]);
  assert.equal(got[3].stop_reason, 'max_tokens');
  assert.match(textOf(got[4]), /^\[\[s:M[0-9a-f]{8}\]\] /);
}));
test('T20: with refuseMerges every merge request is refused and an L1 answered; with rejectMerges every merge request is rejected for its request', async () => {
  for (const [opts, check] of [
    [{ refuseMerges: true }, (r) => assert.equal(r.json.stop_reason, 'refusal')],
    [{ rejectMerges: true }, (r) => { assert.equal(r.status, 400); assert.equal(r.json.error.type, 'invalid_request_error'); }],
  ]) {
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, ...opts });
    try {
      s.setStep(step('m', []));
      check(await post(s.url, summariserBody({ instruction: MERGE })));
      const l1 = await post(s.url, summariserBody({}));
      assert.equal(l1.status, 200);
      assert.equal(l1.json.stop_reason, 'end_turn');
    } finally { await s.close(); }
  }
});

test('T3/T22: a call goes with the id its reply names, and a reply\'s error answers its request with that provider error', () => withStandin({}, async (s) => {
  s.setStep(step('e', [{ text: '[[c:e.r1]] calling', calls: [{ id: 'toolu_same', name: 'time--now', input: {} }, { id: 'toolu_same', name: 'time--now', input: {} }] }, { error: { status: 529, type: 'overloaded_error', message: 'busy' } }]));
  const one = await post(s.url, agentBody({ canary: '[[c:e.in]]' }));
  assert.deepEqual(one.json.content.filter((b) => b.type === 'tool_use').map((b) => b.id), ['toolu_same', 'toolu_same']);
  const two = await post(s.url, agentBody({ canary: '[[c:e.in]]', stream: false }));
  assert.equal(two.status, 529);
  assert.equal(two.json.error.type, 'overloaded_error');
}));

test('T23: a step\'s subagent requests are told by the marker in their system prompt and get its own replies, and a text of `also` in the last message names a request the step\'s', () => withStandin({}, async (s) => {
  s.setStep(step('sub', [{ text: '[[c:sub.r1]] primary' }, { text: '[[c:sub.r2]] after the note' }], {
    sub: { marker: '[[sub:x]]', canaries: ['[[c:sub.task]]'], replies: [{ text: '[[c:sub.s1]] the subagent' }] },
    also: ['were set aside'],
  }));
  const sub = await post(s.url, { ...agentBody({ canary: '[[c:sub.task]]' }), system: '[[sub:x]] You are a subagent.' });
  assert.equal(textOf(sub.json), '[[c:sub.s1]] the subagent');
  const primary = await post(s.url, agentBody({ canary: '[[c:sub.in]]' }));
  assert.equal(textOf(primary.json), '[[c:sub.r1]] primary');
  const noted = await post(s.url, { ...agentBody({ canary: '' }), messages: [{ role: 'user', content: [{ type: 'text', text: '[refusal-rewind] The 1 most recent turn(s) were set aside because …' }] }] });
  assert.equal(textOf(noted.json), '[[c:sub.r2]] after the note');
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.agent), ['sub', 'primary', 'primary']);
}));

test('T24: a step with namedAnywhere is told by its canary or an `also` text in any message of the request, and a step without it only by its last message', () => withStandin({}, async (s) => {
  const earlier = (text) => [{ role: 'user', content: [{ type: 'text', text }] }, { role: 'assistant', content: [{ type: 'text', text: 'read' }] }, { role: 'user', content: [{ type: 'text', text: 'and then' }] }];
  s.setStep(step('any', [{ text: '[[c:any.r1]] by canary' }, { text: '[[c:any.r2]] by note' }], { namedAnywhere: true, also: ['addressed message'] }));
  assert.equal(textOf((await post(s.url, { ...agentBody({ canary: '' }), messages: earlier('[[c:any.in]] held') })).json), '[[c:any.r1]] by canary');
  assert.equal(textOf((await post(s.url, { ...agentBody({ canary: '' }), messages: earlier('[tune-out wake: chat — 1 addressed message]') })).json), '[[c:any.r2]] by note');
  s.setStep(step('last', [{ text: '[[c:last.r1]] never' }], { also: ['addressed message'] }));
  const missed = await post(s.url, { ...agentBody({ canary: '' }), messages: earlier('[[c:last.in]] [tune-out wake: chat — 1 addressed message]') });
  assert.notEqual(missed.status, 200);
  const records = await s.close();
  assert.deepEqual(records.map((r) => r.kind), ['agent', 'agent', 'unclassified']);
}));

test('T10: the same request always counts the same, at about 1.3 times context-manager\'s own estimate of prose, and an image counts by its size', () => withStandin({}, async (s) => {
  s.setStep(step('n', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]));
  const body = agentBody({ canary: '[[c:n.in]]' });
  const one = (await post(s.url, body)).json.usage;
  const two = (await post(s.url, body)).json.usage;
  const total = (u) => u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  assert.equal(total(one), total(two));
  const big = 29_000;
  const counted = s.countTokens({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: prose(big, 9) }] }] });
  const cmEstimate = Math.ceil(big / 2.9);
  assert.ok(counted > cmEstimate * 1.2 && counted < cmEstimate * 1.4, `${counted} vs ${cmEstimate}`);
  const png = (w, h) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b.toString('base64'); };
  const withImage = (w, h) => ({ model: 'm', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(w, h) } }] }] });
  const small = s.countTokens(withImage(100, 100));
  const large = s.countTokens(withImage(750, 1000));
  assert.ok(large - small > 900, `${small} → ${large}`);
}));

test('T10b: denser text counts more tokens a character (prose, then code, JSON and base64), and a prose opening doesn\'t price a dense body as prose', () => withStandin({}, async (s) => {
  const count = async (text) => s.countTokens({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text }] }] });
  const empty = await count('');
  const rate = async (text) => (await count(text) - empty) / text.length;
  const code = (n) => 'const value_1 = read(index, total);\n'.repeat(Math.ceil(n / 36)).slice(0, n);
  const json = JSON.stringify({ rows: Array.from({ length: 300 }, (_, i) => ({ id: i, name: `row ${i}` })) });
  const base64 = Buffer.from(Array.from({ length: 4500 }, (_, i) => (i * 37) % 256)).toString('base64');
  const rates = [await rate(prose(6000, 3)), await rate(code(6000)), await rate(json), await rate(base64)];
  assert.ok(rates[0] < rates[1] && rates[1] < rates[2] && rates[2] < rates[3], rates.join(' < '));
  const opening = prose(2500, 4);
  const body = code(30_000);
  const mixed = await count(`${opening}${body}`) - empty;
  const apart = (await count(opening) - empty) + (await count(body) - empty);
  assert.ok(Math.abs(mixed - apart) <= apart * 0.02, `priced in stretches, as its parts are: ${mixed} vs ${apart}`);
  assert.ok(mixed > (await count(prose(32_500, 4)) - empty) * 1.1, 'not as prose');
}));

test('T11: a request over the window is refused as the API refuses it', () => withStandin({ windowTokens: 1000 }, async (s) => {
  s.setStep(step('o'));
  const r = await post(s.url, agentBody({ canary: '[[c:o.in]]', history: [{ role: 'user', content: [{ type: 'text', text: prose(8000) }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] }));
  assert.equal(r.status, 400);
  assert.equal(r.json.error.type, 'invalid_request_error');
  assert.match(r.json.error.message, /^prompt is too long: \d+ tokens > 1000 maximum$/);
}));

test('T12: a marked prefix is written, read back byte for byte while live on the virtual clock, and its lifetime follows its marker', () => withStandin({}, async (s) => {
  s.setStep(step('c', Array.from({ length: 8 }, (_, i) => ({ text: `r${i}` }))));
  const history = (ttl, text = prose(4000, 5)) => [
    { role: 'user', content: [{ type: 'text', text: `user: ${text}` }] },
    { role: 'assistant', content: [{ type: 'text', text: 'stored reply', cache_control: ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' } }] },
  ];
  const ask = async (h) => (await post(s.url, agentBody({ canary: '[[c:c.in]]', history: h }))).json.usage;
  s.setClock(0);
  const first = await ask(history());
  assert.ok(first.cache_creation_input_tokens > 1000);
  assert.equal(first.cache_read_input_tokens, 0);
  assert.equal(first.cache_creation.ephemeral_5m_input_tokens, first.cache_creation_input_tokens);
  s.setClock(4 * 60_000);
  const second = await ask(history());
  assert.equal(second.cache_read_input_tokens, first.cache_creation_input_tokens);
  assert.equal(second.cache_creation_input_tokens, 0);
  s.setClock(8 * 60_000);
  assert.equal((await ask(history())).cache_read_input_tokens, first.cache_creation_input_tokens);
  s.setClock(14 * 60_000);
  assert.equal((await ask(history())).cache_read_input_tokens, 0);
  await ask(history('1h'));
  s.setClock(40 * 60_000);
  const hour = await ask(history('1h'));
  assert.ok(hour.cache_read_input_tokens > 1000);
  assert.equal((await ask(history('1h', prose(4000, 6)))).cache_read_input_tokens, 0);
}));

test('T12: a cache entry is the model\'s own', () => withStandin({}, async (s) => {
  s.setStep(step('cm', [{ text: 'a' }, { text: 'b' }]));
  const h = [{ role: 'user', content: [{ type: 'text', text: prose(4000, 5), cache_control: { type: 'ephemeral' } }] }, { role: 'assistant', content: [{ type: 'text', text: 'x' }] }];
  await post(s.url, agentBody({ canary: '[[c:cm.in]]', history: h }));
  const other = await post(s.url, agentBody({ canary: '[[c:cm.in]]', history: h, model: 'claude-opus-4-6' }));
  assert.equal(other.json.usage.cache_read_input_tokens, 0);
}));

test('T12: the lookback counts 20 positions back from a marker, its own included, with a run of tool_use blocks, or of tool_result blocks, as one', () => withStandin({}, async (s) => {
  s.setStep({ ...step('lb', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]), canaries: ['[[c:lb.in]]'] });
  const marked = { type: 'ephemeral' };
  const opening = { role: 'user', content: [{ type: 'text', text: prose(2000, 5), cache_control: marked }] };
  const unmarkedOpening = { role: 'user', content: [{ type: 'text', text: prose(2000, 5) }] };
  const ask = (n, k) => ({ role: 'user', content: [{ type: 'text', text: `user: [[c:lb.in]] ${n}`, cache_control: marked }, ...k] });
  const first = await post(s.url, { model: 'claude-opus-5-5', max_tokens: 64, stream: false, messages: [opening, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, ask(1, [])] });
  assert.ok(first.json.usage.cache_creation_input_tokens > 0, 'premise: the opening is written');
  const calls = (n) => Array.from({ length: n }, (_, i) => ({ type: 'tool_use', id: `lb${i}`, name: 'time--now', input: {} }));
  const results = (n) => Array.from({ length: n }, (_, i) => ({ type: 'tool_result', tool_use_id: `lb${i}`, content: `out ${i}` }));
  const turn = (n) => [{ role: 'assistant', content: [{ type: 'text', text: 'checking' }, ...calls(n)] }, { role: 'user', content: results(n) }];
  const wide = await post(s.url, { model: 'claude-opus-5-5', max_tokens: 64, stream: false, messages: [unmarkedOpening, ...turn(25), ask(2, [])] });
  assert.equal(wide.json.usage.cache_read_input_tokens > 0, true, `a run of calls and a run of results are one position each: ${JSON.stringify(wide.json.usage)}`);
  const long = await post(s.url, { model: 'claude-opus-5-5', max_tokens: 64, stream: false, messages: [unmarkedOpening, ...Array.from({ length: 21 }, () => turn(1)).flat(), ask(3, [])] });
  assert.equal(long.json.usage.cache_read_input_tokens, 0, `past 20 positions, nothing is read back: ${JSON.stringify(long.json.usage)}`);
}));

test('T12: the messages cache keys on the thinking configuration\'s mode and budget, and the tools and system caches don\'t', () => withStandin({}, async (s) => {
  s.setStep(step('tk', Array.from({ length: 6 }, (_, i) => ({ text: `r${i}` }))));
  const ask = async (thinking) => {
    const body = agentBody({ canary: '[[c:tk.in]]', history: [
      { role: 'user', content: [{ type: 'text', text: `user: ${prose(4000, 5)}` }] },
      { role: 'assistant', content: [{ type: 'text', text: 'stored reply', cache_control: { type: 'ephemeral' } }] },
    ], extra: thinking ? { thinking } : {} });
    body.system = [{ type: 'text', text: `You are the fixture agent. ${prose(3000, 9)}`, cache_control: { type: 'ephemeral' } }];
    const r = await post(s.url, body);
    assert.equal(r.status, 200);
    return r.json.usage;
  };
  const first = await ask(null);
  assert.ok(first.cache_creation_input_tokens > 0 && first.cache_read_input_tokens === 0, 'premise: the system and the messages are written');
  const whole = (await ask(null)).cache_read_input_tokens;
  assert.equal(whole, first.cache_creation_input_tokens, 'premise: the same request reads both');
  const adaptive = await ask({ type: 'adaptive' });
  assert.ok(adaptive.cache_read_input_tokens > 0 && adaptive.cache_read_input_tokens < whole, `a new mode reads the system's prefix only (${adaptive.cache_read_input_tokens} of ${whole})`);
  assert.equal((await ask({ type: 'adaptive', display: 'summarized' })).cache_read_input_tokens, whole, 'the same mode with another display reads what it wrote');
  assert.equal((await ask({ type: 'enabled', budget_tokens: 1024 })).cache_read_input_tokens, adaptive.cache_read_input_tokens, 'another mode reads the system\'s prefix only');
  assert.equal((await ask({ type: 'enabled', budget_tokens: 2048 })).cache_read_input_tokens, adaptive.cache_read_input_tokens, 'and so does another budget');
}));

test('T12: the messages cache keys on whether any image is sent, in a message or a tool result, and the tools and system caches don\'t', () => withStandin({}, async (s) => {
  s.setStep(step('im', Array.from({ length: 6 }, (_, i) => ({ text: `r${i}` }))));
  const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
  const ask = async (tail) => {
    const body = agentBody({ canary: '[[c:im.in]]', tail, history: [
      { role: 'user', content: [{ type: 'text', text: `user: ${prose(4000, 5)}` }] },
      { role: 'assistant', content: [{ type: 'text', text: 'stored reply', cache_control: { type: 'ephemeral' } }] },
    ] });
    body.system = [{ type: 'text', text: `You are the fixture agent. ${prose(3000, 9)}`, cache_control: { type: 'ephemeral' } }];
    const r = await post(s.url, body);
    assert.equal(r.status, 200);
    return r.json.usage;
  };
  const first = await ask([]);
  const whole = (await ask([])).cache_read_input_tokens;
  assert.ok(whole > 0 && whole === first.cache_creation_input_tokens, 'premise: the same request reads what the first wrote');
  const inResult = await ask([{ type: 'tool_result', tool_use_id: 'x', content: [IMAGE] }]);
  assert.ok(inResult.cache_read_input_tokens > 0 && inResult.cache_read_input_tokens < whole, `an image in a tool result after the marker reads the system's prefix only (${inResult.cache_read_input_tokens} of ${whole})`);
  assert.equal((await ask([IMAGE])).cache_read_input_tokens, whole, 'an image in a message reads what that request wrote');
  assert.equal((await ask([])).cache_read_input_tokens, whole, 'and the request without one still reads its own');
}));

test('T12: a marked prefix shorter than its model\'s minimum isn\'t written: 4,096 tokens for Claude Opus 4.6, 512 for Claude Opus 5.5', () => withStandin({}, async (s) => {
  s.setStep(step('mn', Array.from({ length: 8 }, (_, i) => ({ text: `r${i}` }))));
  const marked = (model, chars) => agentBody({ canary: '[[c:mn.in]]', model, history: [{ role: 'user', content: [{ type: 'text', text: `user: ${prose(chars, 4)}` }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }], tail: [{ type: 'text', text: 'end', cache_control: { type: 'ephemeral' } }] });
  for (const [model, minimum, under, over] of [['claude-opus-4-6', 4096, 7000, 10_000], ['claude-opus-5-5', 512, 200, 1600]]) {
    const short = marked(model, under);
    const long = marked(model, over);
    assert.ok(countTokens(short) < minimum && countTokens(long) >= minimum, `premise: ${countTokens(short)} under ${minimum}, ${countTokens(long)} not`);
    const shortUsage = (await post(s.url, short)).json.usage;
    assert.equal(shortUsage.cache_creation_input_tokens, 0, `${model}: a ${countTokens(short)}-token prefix isn't written`);
    assert.equal(shortUsage.input_tokens, countTokens(short), 'and goes as input');
    assert.equal((await post(s.url, short)).json.usage.cache_read_input_tokens, 0, 'so nothing reads it');
    assert.equal((await post(s.url, long)).json.usage.cache_creation_input_tokens, countTokens(long), `${model}: a ${countTokens(long)}-token prefix is written`);
  }
}));

test('T1/T12: a request carrying a field the stand-in\'s cache doesn\'t model, or naming a model it knows no minimum for, is refused as unclassified, naming it; its record keeps its head', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep(step('uf'));
    for (const [extra, named] of [[{ tool_choice: { type: 'auto' } }, '`tool_choice`'], [{ speed: 'fast' }, '`speed`'], [{ output_config: { effort: 'high' } }, '`output_config`'], [{ model: 'claude-sonnet-4-5' }, 'claude-sonnet-4-5']]) {
      const r = await post(s.url, agentBody({ canary: '[[c:uf.in]]', extra }));
      assert.equal(r.status, 400);
      assert.ok(r.json.error.message.includes(named), `${r.json.error.message} names ${named}`);
    }
    records = await s.close();
  } finally { if (!records) await s.close(); }
  assert.deepEqual(records.map((r) => r.kind), ['unclassified', 'unclassified', 'unclassified', 'unclassified']);
  assert.deepEqual(records[0].head.toolChoice, { type: 'auto' });
  assert.match(records[1].head.rest, /^[0-9a-f]{16}$/);
});

test('T13: when the model binds thinking, a block whose request changed is refused, or set aside uncounted under the drop control; otherwise it\'s taken', async () => {
  const DROP = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
  for (const [binds, control] of [[true, false], [true, true], [false, false]]) {
    await withStandin({ binds }, async (s) => {
      s.setStep({ ...step('g', [{ thinking: 'plan', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:g.call1]]' } }] }, { text: 'ok' }, { text: 'ok' }, { text: 'ok' }]), canaries: ['[[c:g.in]]', '[[c:g.call1]]'] });
      const opening = { ...agentBody({ canary: '[[c:g.in]]' }), ...(control ? { thinking: DROP } : {}) };
      const first = (await post(s.url, opening)).json;
      const call = first.content.find((b) => b.type === 'tool_use');
      const next = (prefix, reply) => ({
        ...opening, messages: [
          prefix,
          { role: 'assistant', content: reply },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: `[[c:g.call1]] ${prose(280)}` }] }] },
        ],
      });
      assert.equal((await post(s.url, next(opening.messages[0], first.content))).status, 200, 'the block sent after the prefix it was minted under is taken');
      const count = async (body) => s.countTokens(body);
      assert.ok(await count(next(opening.messages[0], first.content)) > await count(next(opening.messages[0], first.content.filter((b) => b.type !== 'thinking'))), 'and it counts, under the drop control too');
      const changedPrefix = { role: 'user', content: [{ type: 'text', text: 'user: [[c:g.in]] something else entirely' }] };
      const changed = next(changedPrefix, first.content);
      const withoutBlock = next(changedPrefix, first.content.filter((b) => b.type !== 'thinking'));
      const r = await post(s.url, changed);
      if (binds && !control) {
        assert.equal(r.status, 400);
        assert.equal(r.json.error.message, 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.', 'the provider\'s own wording, which hosts read as a binding refusal');
        const reordered = { role: 'user', content: opening.messages[0].content.map(({ type, ...rest }) => ({ ...rest, type })) };
        assert.equal((await post(s.url, next(reordered, first.content))).status, 200, 'the same prefix with its keys in another order keeps the binding');
      } else if (binds) {
        assert.equal(r.status, 200);
        assert.equal(await count(changed), await count(withoutBlock), 'the block set aside counts for nothing');
        const billed = r.json.usage.input_tokens + r.json.usage.cache_read_input_tokens + r.json.usage.cache_creation_input_tokens;
        assert.equal(billed, await count(withoutBlock), 'nor is it billed');
        await withStandin({ binds, windowTokens: await count(withoutBlock) }, async (t) => {
          t.setStep({ ...step('g', [{ text: 'ok' }]), canaries: ['[[c:g.in]]', '[[c:g.call1]]'] });
          assert.equal((await post(t.url, changed)).status, 200, 'nor counted against the window: it fits once the block is set aside');
        });
      } else {
        assert.equal(r.status, 200);
        assert.ok(await count(changed) > await count(withoutBlock), 'a block the model reads counts');
      }
    });
  }
});

test('T25: each request\'s record carries its head, everything it sends but its messages: the fields it names by value, and the rest in one digest, so a change in any of them shows', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep({ ...step('t', [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }, { text: 'f' }, { text: 'g' }, { text: 'h' }, { text: 'i' }, { text: 'j' }, { text: 'k' }, { text: 'l' }]), canaries: ['[[c:t.in]]'] });
    const base = agentBody({ canary: '[[c:t.in]]', stream: false });
    const variants = [
      base,
      base,
      { ...base, tools: base.tools.map((t, i) => (i === 0 ? { ...t, description: `${t.description} (changed)` } : t)) },
      { ...base, system: [{ type: 'text', text: base.system, cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      { ...base, thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } } },
      { ...base, metadata: { user_id: 'u' } },
    ];
    for (const v of variants) assert.equal((await post(s.url, v)).status, 200);
    assert.equal((await post(s.url, { ...base, metadata: { user_id: 'v' } })).status, 200);
    assert.equal((await post(s.url, base, '/v1/messages', { 'anthropic-beta': 'b2-2026, b1-2026,b2-2026' })).status, 200);
    assert.equal((await post(s.url, { ...base, system: [{ type: 'text', text: base.system, citations: { enabled: true } }] })).status, 200);
    assert.equal((await post(s.url, { ...base, system: [{ type: 'text', text: base.system, citations: { enabled: false } }] })).status, 200);
    assert.equal((await post(s.url, { ...base, system: [{ text: base.system }] })).status, 200);
    assert.equal((await post(s.url, { ...base, system: [{ text: base.system, citations: { enabled: true } }] })).status, 200);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  const [same, again, tool, system, thinking, more, otherUser, beta, cited, uncited, typeless, typelessCited] = records;
  assert.deepEqual(same.head, again.head, 'the same body, the same head');
  assert.deepEqual(same.head.tools.map((t) => t.name), ['time--now']);
  assert.notEqual(tool.head.tools[0].sha, same.head.tools[0].sha, 'a tool\'s description moves its definition\'s digest');
  assert.deepEqual(system.head.system, [{ text: same.head.system[0].text, cache: '1h' }], 'a system block keeps its text and its marker');
  assert.deepEqual(thinking.head.thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  assert.equal(same.head.rest, null, 'nothing else on the body');
  assert.match(more.head.rest, /^[0-9a-f]{16}$/, 'a field no part names is still digested');
  assert.notEqual(otherUser.head.rest, more.head.rest, 'by its value');
  assert.deepEqual(same.head.headers, { beta: [], version: '2023-06-01' }, 'the headers that change what a provider does');
  assert.deepEqual(beta.head.headers, { beta: ['b1-2026', 'b2-2026'], version: '2023-06-01' }, 'betas as a set');
  assert.match(cited.head.system[0].other ?? '', /^[0-9a-f]{16}$/, 'a system block\'s other fields are digested');
  assert.equal('other' in same.head.system[0], false);
  assert.notEqual(uncited.head.system[0].other, cited.head.system[0].other, 'by its value');
  assert.match(typeless.head.system[0].other ?? '', /^[0-9a-f]{16}$/, 'a block that lost its type differs from one that has it');
  assert.notEqual(typelessCited.head.system[0].other, cited.head.system[0].other, 'and so does one that lost it beside another field');
});

test('T13d: on a configuration that doesn\'t bind, thinking altered in the latest assistant message is refused with the page\'s 400, and the same thinking after a changed request ahead of it, or altered in an earlier message, is taken', () => withStandin({}, async (s) => {
  s.setStep({ ...step('th', [{ text: 'first', thinking: 'a thought' }, { text: 'b' }, { text: 'c' }, { text: 'd' }]), canaries: ['[[c:th.in]]'] });
  const opening = agentBody({ canary: '[[c:th.in]]', stream: false });
  const first = await post(s.url, opening);
  const thought = first.json.content.find((b) => b.type === 'thinking');
  assert.ok(thought?.signature, 'premise: the reply carries signed thinking');
  const next = (reply, system = opening.system, earlier = []) => ({ ...opening, system, messages: [...earlier, ...opening.messages, { role: 'assistant', content: reply }, { role: 'user', content: [{ type: 'text', text: 'user: [[c:th.in]] and then' }] }] });
  const altered = await post(s.url, next([{ ...thought, thinking: `${thought.thinking} (changed)` }, { type: 'text', text: 'first' }]));
  assert.equal(altered.status, 400);
  assert.match(altered.json.error.message, /^messages\.1\.content\.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified$/);
  assert.equal((await post(s.url, next([thought, { type: 'text', text: 'first' }], 'You are the fixture agent, with another prompt.'))).status, 200, 'the request ahead changed, the thinking didn\'t');
  const older = [{ role: 'user', content: [{ type: 'text', text: 'user: before' }] }, { role: 'assistant', content: [{ ...thought, thinking: 'not what was signed' }, { type: 'text', text: 'old' }] }];
  assert.equal((await post(s.url, next([thought, { type: 'text', text: 'first' }], opening.system, older))).status, 200, 'the page says nothing of an earlier message');
}));

test('T1: a request to count_tokens, or to any route but /v1/messages, is recorded as unclassified, naming its route, and refused', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep(step('ct'));
  const body = { model: 'claude-opus-5-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'user: [[c:ct.in]] count me' }] }] };
  const counted = await post(s.url, body, '/v1/messages/count_tokens');
  const elsewhere = await post(s.url, body, '/v1/models');
  assert.deepEqual([counted.status, elsewhere.status], [404, 404]);
  const records = await s.close();
  assert.deepEqual(records.map((r) => [r.kind, r.reason]), [
    ['unclassified', 'it goes to POST /v1/messages/count_tokens, which no run sends and the stand-in doesn\'t model'],
    ['unclassified', 'it goes to POST /v1/models, which no run sends and the stand-in doesn\'t model'],
  ]);
});

test('T25b: a request to another path ending in /v1/messages, one with an empty query, and a system block whose cache_control is null each record a head of their own', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  s.setStep({ ...step('u', [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }]), canaries: ['[[c:u.in]]'] });
  const base = agentBody({ canary: '[[c:u.in]]', stream: false });
  for (const [body, path] of [[base, '/v1/messages'], [base, '/proxy/v1/messages'], [base, '/v1/messages?'], [{ ...base, system: [{ type: 'text', text: base.system }] }, '/v1/messages'], [{ ...base, system: [{ type: 'text', text: base.system, cache_control: null }] }, '/v1/messages']]) {
    assert.equal((await post(s.url, body, path)).status, 200, path);
  }
  const [plain, prefixed, emptyQuery, absent, nulled] = await s.close();
  assert.equal('path' in plain.head || 'query' in plain.head, false, 'the path every host sends, with no query, adds nothing');
  assert.equal(prefixed.head.path, '/proxy/v1/messages');
  assert.equal(emptyQuery.head.query, '');
  assert.deepEqual([absent.head.system[0].cache, nulled.head.system[0].cache], [null, 'null']);
  assert.notDeepEqual(absent.head, nulled.head);
});

test('T26: a reply marked settle waits until releaseHeld, after onHeld names its request; an ordinary reply is answered at once', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  try {
    const heldSeen = [];
    s.onHeld((h) => heldSeen.push(h));
    s.setStep({ ...step('q', [{ text: '[[c:q.r1]] held', settle: true }, { text: '[[c:q.r2]] plain' }]), canaries: ['[[c:q.in]]'] });
    let answered = null;
    const first = post(s.url, agentBody({ canary: '[[c:q.in]]', stream: false })).then((r) => { answered = r; return r; });
    for (const until = performance.now() + 5000; !heldSeen.length;) {
      if (performance.now() > until) assert.fail('onHeld named no request within 5 s');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(Object.keys(heldSeen[0]).sort(), ['agent', 'id', 'step']);
    assert.equal(heldSeen[0].step, 'q');
    const second = await post(s.url, agentBody({ canary: '[[c:q.in]]', stream: false }));
    assert.equal(textOf(second.json), '[[c:q.r2]] plain', 'the next request is answered while the first is held');
    assert.equal(answered, null, 'the held one is still waiting');
    s.releaseHeld();
    assert.equal(textOf((await first).json), '[[c:q.r1]] held');
  } finally { await s.close(); }
});

test('T27: a summary\'s id comes from what its request carries as sets (target, canaries, recalled summaries), not its wording, order or repeats', () => withStandin({}, async (s) => {
  s.setStep(step('i', []));
  const idOf = async (body) => textOf((await post(s.url, body)).json).match(/^\[\[s:M[0-9a-f]{8}\]\]/)[0];
  const base = await idOf(summariserBody({ canaries: ['[[c:i.1]]', '[[c:i.2]]'] }));
  assert.equal(await idOf(summariserBody({ canaries: ['[[c:i.2]]', '[[c:i.1]]', '[[c:i.2]]'] })), base, 'order and repeats leave it');
  assert.equal(await idOf(summariserBody({ canaries: ['[[c:i.1]]', '[[c:i.2]]'], instruction: CHAT.replace('Speak in the first person', 'Use the first person'), textChars: 900 })), base, 'rewording and longer text leave it');
  assert.notEqual(await idOf(summariserBody({ canaries: ['[[c:i.1]]', '[[c:i.2]]'], summaries: ['[[s:M0123abcd]]'] })), base, 'a recalled summary moves it');
  const recalled = await idOf(summariserBody({ canaries: ['[[c:i.1]]', '[[c:i.2]]'], summaries: ['[[s:M0123abcd]]', '[[s:M89abcdef]]'] }));
  assert.equal(await idOf(summariserBody({ canaries: ['[[c:i.1]]', '[[c:i.2]]'], summaries: ['[[s:M89abcdef]]', '[[s:M0123abcd]]', '[[s:M89abcdef]]'] })), recalled, 'recalled summaries\' order and repeats leave it');
  assert.notEqual(await idOf(summariserBody({ canaries: ['[[c:i.1]]', '[[c:i.3]]'] })), base, 'another canary moves it');
}));

test('T13b: a model that thinks leads every reply with signed thinking minted for its own request, and a scripted reply\'s thinking stands', async () => {
  await withStandin({ binds: true, thinks: true }, async (s) => {
    s.setStep({ ...step('h', [{ text: 'first' }, { thinking: 'scripted', text: 'second' }]), canaries: ['[[c:h.in]]'] });
    const opening = agentBody({ canary: '[[c:h.in]]' });
    const one = (await post(s.url, opening)).json;
    assert.equal(one.content[0].type, 'thinking');
    assert.ok(one.content[0].thinking.length > 0 && typeof one.content[0].signature === 'string');
    const again = { ...opening, messages: [opening.messages[0], { role: 'assistant', content: one.content }, { role: 'user', content: [{ type: 'text', text: 'user: [[c:h.in]] and then?' }] }] };
    const two = await post(s.url, again);
    assert.equal(two.status, 200, 'its thinking, sent back after the prefix it was minted under, is taken by a binding model');
    assert.equal(two.json.content[0].thinking, 'scripted');
  });
  await withStandin({}, async (s) => {
    s.setStep({ ...step('k', [{ text: 'plain' }]), canaries: ['[[c:k.in]]'] });
    const one = (await post(s.url, agentBody({ canary: '[[c:k.in]]' }))).json;
    assert.deepEqual(one.content.map((b) => b.type), ['text'], 'a model that doesn\'t think replies without thinking');
  });
});

test('T13c: a thinking model\'s thinking comes from its request as the run-varying mask reads it, so an image ref\'s nonce doesn\'t change the words', () => withStandin({ thinks: true }, async (s) => {
  s.setStep({ ...step('q', [{ text: 'one' }, { text: 'two' }, { text: 'three' }]), canaries: ['[[c:q.in]]'] });
  const ask = (ref) => ({ ...agentBody({ canary: '[[c:q.in]]' }), messages: [{ role: 'user', content: [{ type: 'text', text: `user: [[c:q.in]] see ${ref}` }] }] });
  const [one, two, other] = [await post(s.url, ask('img_abc123_4')), await post(s.url, ask('img_def456_4')), await post(s.url, ask('img_abc123_5'))].map((r) => r.json.content[0].thinking);
  assert.equal(one, two, 'the nonce masked');
  assert.notEqual(one, other, 'the ref\'s number still moves it');
}));

test('T7/T14/T15: summariser requests are answered at once, every arrival is reported, and close() returns each request\'s normalised record', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  const { seen, until } = arrivals(s);
  s.setClock(123);
  s.setStep(step('r', [{ text: '[[c:r.r1]] ok' }, { text: '[[c:r.r2]] ok' }]));
  // Answered before the step's agent requests come, since agent-framework's provider gate can
  // keep a turn's request waiting on a compression in flight.
  assert.equal((await post(s.url, summariserBody({ canaries: ['[[c:r.in]]'] }))).status, 200);
  await post(s.url, agentBody({ canary: '[[c:r.in]]' }));
  await until(2);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['at', 'clock', 'id', 'kind', 'seq', 'step']);
  assert.equal(seen[0].clock, 123);
  assert.equal(seen[0].step, 'r');
  const records = await s.close();
  const [summ, agent] = records;
  assert.equal(agent.kind, 'agent');
  assert.equal(agent.model, 'claude-opus-5-5');
  assert.equal(agent.maxTokens, 2048);
  assert.equal(agent.stream, true);
  assert.equal(agent.system.chars, 'You are the fixture agent.'.length);
  assert.match(agent.system.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(agent.tools, ['time--now']);
  assert.equal(agent.messages.at(-1).role, 'user');
  assert.deepEqual(agent.messages.at(-1).blocks[0].canaries, ['[[c:r.in]]']);
  assert.equal(typeof agent.usage.input_tokens, 'number');
  assert.equal(summ.kind, 'summariser');
  assert.equal(summ.answer.shape, 'summary');
});

test('T28: with a raw directory, each answer\'s content goes beside its request as r<n>.answer.json, a refused request leaves none, and tokensSent sums what the answers billed', async () => {
  const rawDir = mkdtempSync(join(tmpdir(), 'standin-raw-'));
  try {
    const s = await startStandin({ configuration: { windowTokens: 50_000 }, rawDir });
    s.setStep(step('w', [{ text: '[[c:w.r1]] noted', thinking: 'a thought' }, { text: '[[c:w.r2]] again' }]));
    const summBody = summariserBody({ canaries: ['[[c:w.in]]'] });
    const marked = agentBody({ canary: '[[c:w.in]]', history: [{ role: 'user', content: [{ type: 'text', text: `user: ${prose(2000, 4)}` }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] });
    marked.messages.at(-1).content.at(-1).cache_control = { type: 'ephemeral' };
    assert.ok(countTokens(marked) >= 512, 'premise: the marked prefix is over the model\'s minimum');
    const refusedBody = agentBody({ canary: '[[c:other.in]]' });
    const summ = await post(s.url, summBody);
    const agent = await post(s.url, marked);
    const again = await post(s.url, marked);
    const refused = await post(s.url, refusedBody);
    const records = await s.close();
    assert.equal(refused.status, 400);
    assert.deepEqual(readdirSync(rawDir).sort(), ['r1.answer.json', 'r1.json', 'r2.answer.json', 'r2.json', 'r3.answer.json', 'r3.json', 'r4.json']);
    const saved = (name) => JSON.parse(readFileSync(join(rawDir, name), 'utf-8'));
    assert.deepEqual([saved('r1.json'), saved('r2.json'), saved('r3.json'), saved('r4.json')], [summBody, marked, marked, refusedBody], 'each body as it was sent');
    assert.deepEqual(saved('r1.answer.json'), summ.json.content);
    assert.deepEqual(saved('r2.answer.json'), agent.json.content);
    assert.deepEqual(saved('r3.answer.json'), again.json.content);
    const billed = [summ.json.usage, agent.json.usage, again.json.usage];
    const sum = (k) => billed.reduce((t, u) => t + u[k], 0);
    assert.ok(sum('cache_creation_input_tokens') > 0 && sum('cache_read_input_tokens') > 0, 'the marked prefix was written, then read');
    assert.deepEqual(tokensSent(records), { input: sum('input_tokens'), cacheRead: sum('cache_read_input_tokens'), cacheWrite: sum('cache_creation_input_tokens'), output: sum('output_tokens') });
  } finally { rmSync(rawDir, { recursive: true, force: true }); }
});

test('T29: every cache marker moves the record: on the system, a message block or inside a tool result it shows as sent, a plain one as its TTL and any other shape whole; on a tool or the body it is held in that one\'s digest', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep({ ...step('k', Array.from({ length: 16 }, (_, i) => ({ text: `r${i}` }))), canaries: ['[[c:k.in]]'] });
    const odd = { type: 'ephemeral', ttl: '1h', scope: 'x' };
    const base = { ...agentBody({ canary: '[[c:k.in]]', stream: false }), system: [{ type: 'text', text: 'You are the fixture agent.' }] };
    const text = (cc) => ({ type: 'text', text: 'user: [[c:k.in]] hello', ...(cc !== null ? { cache_control: cc } : {}) });
    const nested = (cc) => ({ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '[[c:k.in]] one' }, { type: 'text', text: 'two', ...(cc !== null ? { cache_control: cc } : {}) }] });
    const bodies = [
      { ...base, messages: [{ role: 'user', content: [text(null)] }] },
      { ...base, messages: [{ role: 'user', content: [text({ type: 'ephemeral' })] }] },
      { ...base, messages: [{ role: 'user', content: [text({ type: 'ephemeral', ttl: '1h' })] }] },
      { ...base, messages: [{ role: 'user', content: [text(odd)] }] },
      { ...base, messages: [{ role: 'user', content: [text({ type: 'persistent' })] }] },
      { ...base, messages: [{ role: 'user', content: [nested(null)] }] },
      { ...base, messages: [{ role: 'user', content: [nested(odd)] }] },
      { ...base, system: [{ type: 'text', text: 'You are the fixture agent.', cache_control: odd }], messages: [{ role: 'user', content: [text(null)] }] },
      { ...base, tools: [{ ...TOOLS[0], cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: [text(null)] }] },
      { ...base, cache_control: { type: 'ephemeral' }, messages: [{ role: 'user', content: [text(null)] }] },
      { ...base, messages: [{ role: 'user', content: [text(false)] }] },
      { ...base, messages: [{ role: 'user', content: [text({ type: 'ephemeral', ttl: '' })] }] },
      { ...base, system: [{ type: 'text', text: 'You are the fixture agent.', cache_control: false }], messages: [{ role: 'user', content: [text(null)] }] },
      { ...base, messages: [{ role: 'user', content: [nested(false)] }] },
    ];
    for (const body of bodies) assert.equal((await post(s.url, body)).status, 200, 'the stand-in judges no marker; the record shows it');
    records = await s.close();
  } finally { if (!records) await s.close(); }
  const [none, plain, hour, oddBlock, persistent, nestedNone, nestedOdd, system, tool, top, falsy, emptyTtl, systemFalse, nestedFalse] = records;
  const shown = '{"scope":"x","ttl":"1h","type":"ephemeral"}';
  assert.deepEqual([none, plain, hour, oddBlock, persistent].map((r) => r.messages[0].blocks[0].cache ?? null), [null, '5m', '1h', shown, '{"type":"persistent"}']);
  assert.equal('contentCache' in nestedNone.messages[0].blocks[0], false);
  assert.deepEqual(nestedOdd.messages[0].blocks[0].contentCache, [null, shown]);
  assert.deepEqual(system.head.system, [{ text: 'You are the fixture agent.', cache: shown }]);
  assert.notEqual(tool.head.tools[0].sha, none.head.tools[0].sha, 'a tool\'s marker is in its definition\'s digest');
  assert.notEqual(top.head.rest, none.head.rest, 'the body\'s marker is in its rest');
  assert.deepEqual([falsy, emptyTtl].map((r) => r.messages[0].blocks[0].cache), ['false', '{"ttl":"","type":"ephemeral"}'], 'a falsy marker and an empty ttl are shown as sent, not as none or 5m');
  assert.equal(systemFalse.head.system[0].cache, 'false', 'on a system block');
  assert.deepEqual(nestedFalse.messages[0].blocks[0].contentCache, [null, 'false'], 'inside a tool result');
});

test('T30: a request\'s messages are masked together, so a result answering another fork than its call digests apart, and the same pair under other UUIDs alike', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep({ ...step('f', [{ text: 'a' }, { text: 'b' }, { text: 'c' }]), canaries: ['[[c:f.in]]'] });
    const pair = (call, answered) => ({ ...agentBody({ canary: '[[c:f.in]]', stream: false }), messages: [
      { role: 'user', content: [{ type: 'text', text: 'user: [[c:f.in]] fork it' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: `fork-fork-x-${call}`, name: 'subagent--fork', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `fork-fork-x-${answered}`, content: [{ type: 'text', text: '[[c:f.in]] done' }] }] },
    ] });
    const [u1, u2, u3] = ['0f8e2c1a-1b2c-4d5e-8f90-a1b2c3d4e5f6', '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d', '11111111-2222-4333-8444-555555555555'];
    for (const body of [pair(u1, u1), pair(u3, u3), pair(u1, u2)]) assert.equal((await post(s.url, body)).status, 200);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  const [matched, other, crossed] = records;
  assert.deepEqual(other.messages.map((m) => m.digest), matched.messages.map((m) => m.digest), 'the same pairing under other UUIDs');
  assert.equal(crossed.messages[1].digest, matched.messages[1].digest);
  assert.notEqual(crossed.messages[2].digest, matched.messages[2].digest, 'a result naming another fork');
});

test('T31: each request\'s record carries when it arrived, in nanoseconds on the process\'s monotonic clock, after it was sent and before it was answered', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  const stamps = [];
  try {
    s.setStep({ ...step('h', [{ text: 'a' }, { text: 'b' }]), canaries: ['[[c:h.in]]'] });
    for (let i = 0; i < 2; i++) {
      const before = process.hrtime.bigint();
      assert.equal((await post(s.url, agentBody({ canary: '[[c:h.in]]', stream: false }))).status, 200);
      stamps.push([before, process.hrtime.bigint()]);
    }
    records = await s.close();
  } finally { if (!records) await s.close(); }
  records.forEach((r, i) => {
    assert.match(r.arrived, /^\d+$/);
    assert.ok(BigInt(r.arrived) > stamps[i][0] && BigInt(r.arrived) < stamps[i][1], `${r.arrived} within its post`);
  });
});

test('T32: a message\'s other envelope fields are in its digest, its own cache marker among them, so adding or changing one moves it', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep({ ...step('e', [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }]), canaries: ['[[c:e.in]]'] });
    const ask = (extra) => ({ ...agentBody({ canary: '[[c:e.in]]', stream: false }), messages: [{ role: 'user', content: [{ type: 'text', text: 'user: [[c:e.in]] hello' }], ...extra }] });
    for (const extra of [{}, { name: 'ash' }, { name: 'tavy' }, { cache_control: { type: 'ephemeral' } }]) assert.equal((await post(s.url, ask(extra))).status, 200);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  const [plain, named, renamed, marked] = records.map((r) => r.messages[0].digest);
  assert.notEqual(named, plain, 'a field added');
  assert.notEqual(renamed, named, 'a field changed');
  assert.notEqual(marked, plain, 'a marker on the message itself');
});

test('T33: a message\'s digest leaves out only the markers its record keeps, a block\'s and a tool result\'s blocks\' when not null, so a marker anywhere else, or a null one, moves it', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep({ ...step('m', [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }]), canaries: ['[[c:m.in]]'] });
    const image = { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' };
    const result = (inner = {}, outer = {}, source = {}) => ({ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '[[c:m.in]] one', ...inner }, { type: 'image', source: { ...image, ...source } }], ...outer });
    const ask = (block) => ({ ...agentBody({ canary: '[[c:m.in]]', stream: false }), messages: [{ role: 'user', content: [block] }] });
    const marker = { cache_control: { type: 'ephemeral' } };
    for (const block of [result(), result(marker), result({}, marker), result({}, {}, marker), result({}, { cache_control: null })]) assert.equal((await post(s.url, ask(block))).status, 200);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  const [plain, inner, outer, deeper, nulled] = records.map((r) => r.messages[0].digest);
  assert.equal(inner, plain, 'a tool result block\'s marker is in contentCache');
  assert.equal(outer, plain, 'the block\'s own marker is its cache');
  assert.notEqual(deeper, plain, 'a marker on an image\'s source is kept nowhere else, so the digest takes it');
  assert.notEqual(nulled, plain, 'a null marker isn\'t kept as a marker, so the digest takes it');
});

test('T18: each message in a record has a digest that a cache marker on any of its blocks and a tool image ref\'s nonce leave unchanged and a change in its text moves, and an answer records the tool_use ids it minted', async () => {
  const standin = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    standin.setStep({ ...step('d', [{ text: '[[c:d.r1]] calling', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:d.call1]]' } }, { name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:d.call2]]' } }] }, { text: '[[c:d.r2]] done' }, { text: '[[c:d.r3]] again' }]), canaries: ['[[c:d.in]]', '[[c:d.call1]]'] });
    const head = { model: 'claude-opus-5-5', max_tokens: 2048, stream: true, system: 'You are the fixture agent.', tools: TOOLS };
    const opening = (ref, marked) => ({ role: 'user', content: [{ type: 'text', text: `user: [[c:d.in]] look at ${ref}`, ...(marked ? { cache_control: { type: 'ephemeral' } } : {}) }] });
    const first = await post(standin.url, { ...head, messages: [opening('img_abc123_4', false)] });
    const ids = first.json.content.filter((b) => b.type === 'tool_use').map((b) => b.id);
    const round = [{ role: 'assistant', content: first.json.content }, { role: 'user', content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: '[[c:d.call1]] ok' }] })) }];
    await post(standin.url, { ...head, messages: [opening('img_def456_4', true), ...round] });
    await post(standin.url, { ...head, messages: [opening('img_abc123_5', false), ...round] });
    records = await standin.close();
    const [one, two, three] = records;
    assert.ok(records.every((r) => r.kind === 'agent'), 'all three are the step\'s');
    assert.match(one.messages[0].digest, /^[0-9a-f]{16}$/);
    assert.equal(two.messages[0].digest, one.messages[0].digest, 'a cache marker and a ref\'s nonce leave it as it was');
    assert.notEqual(three.messages[0].digest, one.messages[0].digest, 'a change elsewhere in it, the ref\'s number here, changes it');
    assert.deepEqual(three.messages.slice(1).map((m) => m.digest), two.messages.slice(1).map((m) => m.digest), 'the round carried unchanged keeps its digests');
    assert.notEqual(two.messages[1].digest, two.messages[2].digest);
    assert.equal(ids.length, 2);
    assert.deepEqual(one.answer.toolUseIds, ids, 'the ids it minted, in order');
    assert.deepEqual(two.answer.toolUseIds, [], 'an answer that calls no tool mints none');
  } finally { if (!records) await standin.close(); }
});


test('T13e: where the model binds, thinking a host edited is refused with the page\'s 400 in any assistant message, under the drop control too, and a block whose text verifies but whose request changed is still refused, or set aside under the drop control', async () => {
  const DROP = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } };
  const modified = (i) => `messages.${i}.content.0: \`thinking\` or \`redacted_thinking\` blocks in the latest assistant message cannot be modified`;
  for (const control of [false, true]) {
    await withStandin({ binds: true }, async (s) => {
      s.setStep({ ...step('g', [{ thinking: 'plan', calls: [{ name: 'fixture--result', input: { size: 300, kind: 'prose', canary: '[[c:g.call1]]' } }] }, ...Array.from({ length: 6 }, () => ({ text: 'ok' }))]), canaries: ['[[c:g.in]]', '[[c:g.call1]]'] });
      const opening = { ...agentBody({ canary: '[[c:g.in]]' }), ...(control ? { thinking: DROP } : {}) };
      const first = (await post(s.url, opening)).json;
      const call = first.content.find((b) => b.type === 'tool_use');
      const next = (reply, prefix = opening.messages[0], more = []) => ({
        ...opening, messages: [
          prefix,
          { role: 'assistant', content: reply },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: [{ type: 'text', text: `[[c:g.call1]] ${prose(280)}` }] }] },
          ...more,
        ],
      });
      const later = [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: [{ type: 'text', text: 'user: [[c:g.in]] and then' }] }];
      assert.equal((await post(s.url, next(first.content))).status, 200, 'the block as it was minted is taken');
      const altered = first.content.map((b) => (b.type === 'thinking' ? { ...b, thinking: `${b.thinking} (trimmed)` } : b));
      const latest = await post(s.url, next(altered));
      assert.deepEqual([latest.status, latest.json.error?.message], [400, modified(1)], 'edited in the latest assistant message');
      const earlier = await post(s.url, next(altered, opening.messages[0], later));
      assert.deepEqual([earlier.status, earlier.json.error?.message], [400, modified(1)], 'edited in an earlier one');
      const changedPrefix = { role: 'user', content: [{ type: 'text', text: 'user: [[c:g.in]] something else entirely' }] };
      const moved = await post(s.url, next(first.content, changedPrefix, later));
      if (control) assert.equal(moved.status, 200, 'its text verifies, so only its request changed, and the drop control sets it aside');
      else assert.deepEqual([moved.status, moved.json.error?.message], [400, 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.']);
    });
  }
});

test('a request\'s head keeps its URL\'s query, so a move to an endpoint that adds one moves the record', async () => {
  const s = await startStandin({ configuration: { windowTokens: 50_000 } });
  let records = null;
  try {
    s.setStep({ ...step('t', [{ text: 'a' }, { text: 'b' }]), canaries: ['[[c:t.in]]'] });
    const base = agentBody({ canary: '[[c:t.in]]', stream: false });
    assert.equal((await post(s.url, base)).status, 200);
    assert.equal((await post(s.url, base, '/v1/messages?beta=true')).status, 200);
    records = await s.close();
  } finally { if (!records) await s.close(); }
  assert.deepEqual(records.map((r) => r.head.query ?? null), [null, 'beta=true']);
});

test('repair marks: membrane\'s textified results and pending result, and context-manager\'s dropped-block, moved-result and stub texts, each by who wrote it', () => {
  assert.deepEqual(repairMarks('text', 'user: [orphan tool_result for toolu_1]: out; [duplicate tool_result for toolu_2, an error]: x'), ['membrane:orphan', 'membrane:duplicate']);
  assert.deepEqual(repairMarks('tool_result', '[pending]'), ['membrane:pending']);
  assert.deepEqual(repairMarks('text', 'a reply that says [pending] in passing'), [], 'only a result that is nothing but `[pending]` is membrane\'s');
  assert.deepEqual(repairMarks('text', 'user: [tool call omitted]'), ['context-manager:omitted']);
  assert.deepEqual(repairMarks('text', '[tool result moved during context repair]'), ['context-manager:moved']);
  assert.deepEqual(repairMarks('tool_result', '[this call\'s result isn\'t shown in this context. If you need its output and the tool only reads, call it again; you\'ll get what it returns now.]'), ['context-manager:stub']);
  assert.deepEqual(repairMarks('text', 'plain words'), []);
});
