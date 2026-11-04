import { prose, seeded } from './prose.mjs';

export const TOOL = 'mcpl--fixture--result';
export const CHANNEL = 'chat';
export const READER = '[[reader]]';
const PARTICIPANTS = ['Ash', 'Tavy', 'Wren'];
const MINUTE = 60_000;

export function configurations() {
  const agent = { model: 'claude-opus-4-6', cacheKeepalive: { enabled: false } };
  const run = (name, more, summarises = true) => ({ name, agent: { ...agent, ...more.agent }, ...(more.modules ? { modules: more.modules } : {}), ...(more.subconscious ? { subconscious: more.subconscious } : {}), ...(more.judges ? { judges: more.judges } : {}), maintenanceIntervalMs: 0, binds: false, summarises });
  return {
    H1: run('H1', {}),
    H1b: { ...run('H1b', { agent: { model: 'claude-opus-5-5' } }), binds: true, thinks: true },
    H2: run('H2', { modules: { subagents: true }, judges: 'subagent' }),
    H3: run('H3', { agent: { strategy: { type: 'passthrough' } } }, false),
    H4: run('H4', { subconscious: { enabled: true, systemPrompt: `${READER} You read what the resident has tuned out, and tell them what matters.` } }),
    C3h: run('C3h', { agent: { strategy: { adaptiveResolution: false } } }),
    C5h: run('C5h', { agent: { strategy: { foldingStrategy: 'flat-profile' } } }),
    C6h: run('C6h', { agent: { strategy: { foldingStrategy: 'kv-stable' } } }),
    C8h: run('C8h', { agent: { strategy: { foldingStrategy: 'oldest-first' } } }),
  };
}

const canary = (id, part) => `[[c:${id}.${part}]]`;

function turn(id, segment, { chars, replyChars = 2400, calls = [], rounds = null, thinking = null, more = {} }) {
  const r = seeded(`${id}:sizes`);
  const input = `${canary(id, 'in')} ${prose(chars, `${id}:in`)}`;
  const replies = [];
  const canaries = [canary(id, 'in')];
  const allRounds = rounds ?? (calls.length ? [calls] : []);
  if (allRounds.length || thinking) {
    let k = 0;
    allRounds.forEach((roundCalls, i) => {
      const reply = { text: `${canary(id, `r${i + 1}`)} ${prose(1200 + 15 * Math.floor(r() * 80), `${id}:r${i + 1}`)}` };
      if (thinking && i === 0) reply.thinking = prose(thinking, `${id}:think`);
      reply.calls = roundCalls.map((c) => {
        const callCanary = canary(id, `call${++k}`);
        canaries.push(callCanary);
        return { name: TOOL, input: { ...c, canary: callCanary } };
      });
      replies.push(reply);
    });
    const last = allRounds.length + 1;
    replies.push({ text: `${canary(id, `r${last}`)} ${prose(replyChars, `${id}:r${last}`)}` });
  } else {
    replies.push({ text: `${canary(id, 'r1')} ${prose(replyChars, `${id}:r1`)}` });
  }
  const participant = PARTICIPANTS[Math.floor(r() * PARTICIPANTS.length)];
  return { id, segment, kind: 'channel', channel: CHANNEL, participant, topic: segment, text: input, canaries, replies, ...more };
}

const advance = (id, segment, ms) => ({ id, segment, kind: 'advance', ms });
const checkpoint = (id, segment, more = {}) => ({ id, segment, kind: 'checkpoint', name: segment, ...more });

export const L3_PRODUCT = 'an L3 merge request';

export function prefix(turns) {
  const steps = [{ id: 'p.name', segment: 'prefix', kind: 'command', command: '/session rename fixture' }];
  for (let i = 1; i <= turns; i++) {
    const id = `p.${i}`;
    const r = seeded(id);
    steps.push(advance(`${id}.adv`, 'prefix', 4 * MINUTE));
    if (i === 1) steps.push(turn(id, 'prefix', { chars: 2250, replyChars: 1800 }));
    else if (i % 17 === 0) steps.push(turn(id, 'prefix', { chars: 90_000 }));
    else if (i % 13 === 0) steps.push(turn(id, 'prefix', { chars: 4500, calls: [{ kind: 'json', size: 9000 }, { kind: 'prose', size: 13_500 }, { kind: 'code', size: 10_500 }] }));
    else if (i % 11 === 0) steps.push(turn(id, 'prefix', { chars: 4500, thinking: 6000, calls: [{ kind: 'prose', size: 12_000 }] }));
    else if (i % 7 === 0) steps.push(turn(id, 'prefix', { chars: 3750, calls: [{ kind: 'prose', size: 18_000 }] }));
    else steps.push(turn(id, 'prefix', { chars: 1800 + 15 * Math.floor(r() * 900), replyChars: 1200 + 15 * Math.floor(r() * 500) }));
  }
  steps.push(checkpoint('p.end', 'prefix', { copyStore: true }));
  return steps;
}

export function continuation() {
  const steps = [{ id: 'c.name', segment: 'name', kind: 'command', command: '/session rename fixture' }];
  const seg = (name, list) => { steps.push(...list, checkpoint(`c.${name}.cp`, name)); };
  seg('close-merge', [
    advance('c.cm.1.adv', 'close-merge', 4 * MINUTE), turn('c.cm.1', 'close-merge', { chars: 10_500, replyChars: 6000 }),
    advance('c.cm.2.adv', 'close-merge', 4 * MINUTE), turn('c.cm.2', 'close-merge', { chars: 90_000, replyChars: 4500 }),
    advance('c.cm.3.adv', 'close-merge', 4 * MINUTE), turn('c.cm.3', 'close-merge', { chars: 13_500, replyChars: 7500 }),
    advance('c.cm.4.adv', 'close-merge', 4 * MINUTE), turn('c.cm.4', 'close-merge', { chars: 9000, replyChars: 4500 }),
  ]);
  seg('tool-round', [
    advance('c.tool.adv', 'tool-round', 4 * MINUTE),
    turn('c.tool', 'tool-round', { chars: 3750, calls: [{ kind: 'prose', size: 18_000 }, { kind: 'image', width: 400, height: 300 }] }),
  ]);
  seg('parallel', [
    advance('c.par.adv', 'parallel', 4 * MINUTE),
    turn('c.par', 'parallel', { chars: 3750, calls: [{ kind: 'json', size: 7500 }, { kind: 'prose', size: 10_500 }, { kind: 'code', size: 9000 }] }),
  ]);
  seg('thinking-call', [
    advance('c.think.adv', 'thinking-call', 4 * MINUTE),
    turn('c.think', 'thinking-call', { chars: 4500, thinking: 9000, calls: [{ kind: 'prose', size: 12_000 }] }),
  ]);
  // The compressions a long tool turn's closes start park at agent-framework's provider gate until the turn ends.
  seg('debt', [
    advance('c.debt.adv', 'debt', 4 * MINUTE),
    turn('c.debt', 'debt', {
      chars: 4500,
      rounds: [[{ kind: 'prose', size: 22_500 }], [{ kind: 'code', size: 19_500 }], [{ kind: 'json', size: 19_500 }], [{ kind: 'prose', size: 22_500 }]],
      more: { badAnswers: ['thinking-only', 'empty', 'max-tokens'] },
    }),
  ]);
  steps.at(-1).copyStore = true;
  return steps;
}

export function products(configuration) {
  const summarises = configuration.summarises !== false;
  const steps = continuation();
  const long = canary(steps.filter((s) => s.segment === 'close-merge' && s.kind === 'channel').reduce((a, b) => (b.text.length > a.text.length ? b : a)).id, 'in');
  const imageCall = steps.find((s) => s.segment === 'tool-round' && s.kind === 'channel').replies.flatMap((r) => r.calls ?? []).find((c) => c.input.kind === 'image').input.canary;
  const thinkingCalls = steps.find((s) => s.segment === 'thinking-call' && s.kind === 'channel').replies.flatMap((r) => r.calls ?? []).map((c) => c.input.canary);
  return {
    'close-merge': summarises
      ? [
        { name: 'an L1 compression request', test: (r) => r.kind === 'summariser' && r.level === 1 && r.answer?.shape === 'summary' },
        { name: 'a merge request', test: (r) => r.kind === 'summariser' && r.level >= 2 && r.answer?.shape === 'summary' },
        { name: L3_PRODUCT, test: (r) => r.kind === 'summariser' && r.level >= 3 && r.answer?.shape === 'summary' },
        { name: 'the long message stored in parts', fromStore: (store) => storedInParts(store, long) },
      ]
      : [],
    'tool-round': [
      { name: 'a request carrying both results, one an image', test: (r) => r.kind === 'agent' && resultsIn(r.messages.at(-1)) === 2 && r.messages.at(-1).blocks.some((b) => b.type === 'tool_result' && b.images > 0) },
    ],
    parallel: [
      { name: 'a request carrying the three results', test: (r) => r.kind === 'agent' && resultsIn(r.messages.at(-1)) === 3 },
      { name: 'the tool round\'s image as its placeholder', test: (r) => r.kind === 'agent' && r.messages.some((m) => m.blocks.some((b) => b.type === 'tool_result' && (b.canaries || []).includes(imageCall) && !b.images && b.placeholders > 0)) },
    ],
    'thinking-call': [
      { name: 'the call\'s request carrying the reply\'s thinking', test: (r) => r.kind === 'agent' && r.messages.some((m) => m.role === 'assistant' && thinkingLedCalls(m).some((id) => resultFor(r, id, thinkingCalls))) },
    ],
    debt: summarises
      ? [
        { name: 'a compression after the turn, and none between its rounds', test: (r, mine) => r.kind === 'summariser' && parkedThrough(mine) && r.seq > Math.max(...mine.filter((x) => x.kind === 'agent').map((x) => x.seq)) },
        { name: 'a thinking-only answer', test: (r) => r.answer?.shape === 'thinking-only' },
        { name: 'an empty answer', test: (r) => r.answer?.shape === 'empty' },
        { name: 'an answer cut at max_tokens', test: (r) => r.answer?.shape === 'max-tokens' },
      ]
      : [],
  };
}

const resultsIn = (message) => (message?.blocks || []).filter((b) => b.type === 'tool_result').length;

function thinkingLedCalls(message) {
  const thought = message.blocks.findIndex((b) => b.type === 'thinking' && typeof b.signature === 'string' && b.signature.startsWith('fx1.'));
  return thought < 0 ? [] : message.blocks.slice(thought + 1).filter((b) => b.type === 'tool_use').map((b) => b.toolUseId);
}

const resultFor = (record, id, canaries) => record.messages.some((m) => m.role === 'user' && m.blocks.some((b) => b.type === 'tool_result' && b.toolUseId === id && (b.canaries ?? []).some((c) => canaries.includes(c))));

function storedInParts(store, input) {
  const first = store.messages.find((m) => m.canaries.includes(input));
  return Boolean(first?.bodyGroupId) && store.messages.filter((m) => m.bodyGroupId === first.bodyGroupId).length >= 2;
}

function parkedThrough(records) {
  const agents = records.filter((x) => x.kind === 'agent').map((x) => x.seq);
  if (agents.length < 2) return false;
  const [first, last] = [Math.min(...agents), Math.max(...agents)];
  return !records.some((x) => x.kind === 'summariser' && x.seq > first && x.seq < last);
}
