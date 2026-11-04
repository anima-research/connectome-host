import { FIXTURE_AGENT, assemblies, judgedBy, requestPairs, withJudged } from './checks.mjs';
import { isUnreadable } from './invariants.mjs';
import { png } from './png.mjs';
import { hash32, prose, seeded } from './prose.mjs';
import { CHANNEL, READER, TOOL, continuation, prefix, products } from './script.mjs';

// A `document` is about six times the host's default 10,000-token message cap (framework-strategy.ts), so it's stored
// in shards.
const SIZES = {
  user: [450, 1800],
  call: [1200, 4500],
  result: [3000, 13500],
  reading: [9000, 12000],
  reply: [900, 3600],
  large: [45000, 60000],
  // A reply the host's default reply ceiling (recipe-fit.ts, 16,384 tokens) holds by the stand-in's prose rate.
  largeReply: [28000, 34000],
  document: [240000, 270000],
};

const PARTICIPANTS = ['Ash', 'Tavy', 'Wren'];
// agent-framework's preflight refuses a budget no store fits and names its floor; the panel refuses one at or below
// the response reserve.
const edge = (ctx) => ctx.reserve + 1000;
export const canary = (seed, step, part) => `[[c:${seed}.${step}.${part}]]`;

function image(seed) {
  const r = seeded(seed);
  return png(16, 16, (m) => Math.floor(r() * m));
}

function writer(ctx, workload) {
  const r = seeded(`${ctx.seed}:${workload}`);
  const between = ([lo, hi]) => lo + Math.floor(r() * (hi - lo + 1));
  const c = (step, part) => canary(ctx.seed, step, part);
  const id = (step) => `${ctx.seed}.${step}`;
  const turn = (step, o = {}) => {
    const sid = id(step);
    const canaries = [c(step, 'in')];
    const text = `${c(step, 'in')} ${o.user ?? prose(between(o.size ?? SIZES.user), `${sid}:in`)}`;
    const calls = o.calls ?? 1;
    const rounds = calls === 0 ? 0 : (o.rounds ?? 1);
    const replies = [];
    let k = 0;
    for (let i = 0; i < rounds; i++) {
      const roundCalls = [];
      for (let j = 0; j < calls; j++) {
        k++;
        const callCanary = c(step, `call${k}`);
        canaries.push(callCanary);
        const input = o.result ? o.result(k, callCanary) : { kind: 'prose', size: between(SIZES.result), canary: callCanary };
        roundCalls.push({ name: TOOL, input: o.arrival?.after === k ? { ...input, hold: true } : input, ...(o.callId?.(k) ? { id: o.callId(k) } : {}) });
      }
      replies.push({
        text: `${c(step, `r${i + 1}`)} ${prose(between(SIZES.call), `${sid}:r${i + 1}`)}`,
        ...(o.thinking && i === 0 ? { thinking: prose(o.thinking, `${sid}:think`) } : {}),
        calls: roundCalls,
      });
    }
    replies.push({ text: `${c(step, `r${rounds + 1}`)} ${prose(between(SIZES.reply), `${sid}:r${rounds + 1}`)}` });
    const arrival = o.arrival ? { after: c(step, `call${o.arrival.after}`), participant: 'Tavy', text: `${c(step, 'arr')} ${prose(between(SIZES.user), `${sid}:arr`)}` } : null;
    if (arrival) canaries.push(c(step, 'arr'));
    return {
      id: sid, segment: workload, kind: 'channel', channel: CHANNEL, participant: PARTICIPANTS[Math.floor(r() * PARTICIPANTS.length)], topic: workload,
      text, canaries, replies,
      ...(o.attach ? { images: [{ data: image(hash32(sid)), mimeType: 'image/png' }] } : {}),
      ...(arrival ? { arrival } : {}),
      ...(o.more ?? {}),
    };
  };
  const other = (step, kind, fields) => ({ id: id(step), segment: workload, kind, ...fields });
  return { turn, other, c, id, between, size: between, SIZES };
}

// Knowledge sorts a message by its tools' names, which in a host are the fixture server's one tool.
const PHASE_PLAN = [
  { calls: 1, rounds: 3 }, { calls: 1, rounds: 3 }, { calls: 1, rounds: 3 },
  { calls: 0 }, { calls: 0 }, { calls: 0 },
  { calls: 1, rounds: 3 }, { calls: 1, rounds: 3 },
  { calls: 1, rounds: 2 }, { calls: 1, rounds: 2 },
  { calls: 1, rounds: 3 }, { calls: 1, rounds: 3 },
  { calls: 2 },
  { calls: 1 },
  { calls: 0 },
  { calls: 1 }, { calls: 1 },
];
const phaseTurn = (n) => PHASE_PLAN[(n - 1) % PHASE_PLAN.length];

const READING_PLAN = [
  { calls: 1, rounds: 2 }, { calls: 1, rounds: 2 }, { calls: 1, rounds: 2 },
  { calls: 1 }, { calls: 1 }, { calls: 0 },
  { calls: 1, rounds: 2 }, { calls: 1 },
  { calls: 0, paste: true },
  { calls: 0 },
];
const readingTurn = (n) => READING_PLAN[(n - 1) % READING_PLAN.length];

// An agent turns the tool-result guard on with `toolsets--open` on its settings, then `agent_settings`.
function guardTurn(w, step) {
  const t = w.turn(step, { calls: 0 });
  const said = (k) => `${w.c(step, `r${k}`)} ${prose(200, `${w.id(step)}:r${k}`)}`;
  return {
    ...t,
    replies: [
      { text: said(1), calls: [{ name: 'toolsets--open', input: { toolset: 'settings' } }] },
      { text: said(2), calls: [{ name: 'toolsets--act', input: { tool: 'agent_settings', args: { action: 'update', tool_result_guard: true } } }] },
      { text: said(3) },
    ],
    also: ['agent_settings', 'tool_result_guard'],
  };
}

function subagentTurn(w, ctx, step, rounds) {
  const marker = `[[knowledge:${ctx.seed}]]`;
  const sid = w.id(step);
  const subCanaries = [w.c(step, 'task')];
  const subReplies = rounds.map((round, i) => {
    const calls = round.calls.map((input, j) => {
      const callCanary = w.c(step, `s${i + 1}call${j + 1}`);
      subCanaries.push(callCanary);
      return { name: TOOL, input: { ...input, canary: callCanary } };
    });
    return { text: `${w.c(step, `s${i + 1}`)} ${prose(w.between(SIZES.call), `${sid}:s${i + 1}`)}`, calls, settle: true };
  });
  const report = w.c(step, 'report');
  subReplies.push({ text: `${report} ${prose(w.between(SIZES.reply), `${sid}:report`)}`, settle: true });
  const t = w.turn(step, { calls: 0 });
  return {
    ...t,
    canaries: [...t.canaries, report],
    replies: [
      { text: `${w.c(step, 'r1')} ${prose(200, `${sid}:r1`)}`, calls: [{ name: 'subagent--spawn', input: { name: `knowledge-${ctx.seed}`, systemPrompt: `${marker} You are the fixture's knowledge subagent.`, task: `${w.c(step, 'task')} ${prose(w.between(SIZES.user), `${sid}:task`)}`, sync: true } }] },
      { text: `${w.c(step, 'r2')} ${prose(w.between(SIZES.reply), `${sid}:r2`)}` },
    ],
    sub: { marker, canaries: subCanaries, replies: subReplies },
  };
}

// agent-framework's coordinator ends a tune-out past its wake budget, and a reader's plain prose has no destination
// (the host asks it again), so the reader reports with `deliver_summary` and ends with `skip_reply`.
function tunedOut(w, steps, count, o = {}) {
  const t = w.turn('tune', { calls: 0 });
  steps.push({
    ...t,
    replies: [
      { text: `${w.c('tune', 'r1')} ${prose(200, `${w.id('tune')}:r1`)}`, calls: [{ name: 'tune_out', input: { channelId: CHANNEL, cadenceSeconds: 86400, maxWakes: 64 } }] },
      { text: `${w.c('tune', 'r2')} ${prose(200, `${w.id('tune')}:r2`)}` },
    ],
    namedAnywhere: true,
  });
  for (let k = 1; k <= count; k++) {
    for (const step of o.before?.[k] ?? []) steps.push(step);
    const held = w.turn(`h${k}`, { calls: 0 });
    steps.push({
      ...held,
      tags: ['chat:addressed'],
      reader: 'Subconscious',
      ...(o.mayFail?.(k) ? { mayFail: true } : {}),
      replies: [],
      sub: {
        marker: READER,
        canaries: [w.c(`h${k}`, 'in')],
        namedAnywhere: true,
        also: ['addressed message'],
        replies: [
          { calls: [{ name: 'deliver_summary', input: { text: `${w.c(`h${k}`, 'read')} ${prose(w.between(SIZES.reply), `${w.id(`h${k}`)}:read`)}`, channelId: CHANNEL } }] },
          { calls: [{ name: 'skip_reply', input: {} }] },
        ],
      },
    });
  }
}

function markdownPaste(seed, step, target) {
  const window = target * 4;
  let s = `${canary(seed, step, 'in')} `;
  const fill = (to) => { if (s.length < to) s += prose(Math.round(to) - s.length, `${seed}.${step}:${s.length}`); };
  const kind = step.endsWith('h') ? 'headings' : step.endsWith('i') ? 'fence' : 'blank';
  if (kind === 'headings') { fill(0.4 * window); s += '\n## Notes\n'; fill(0.75 * window); s += '\n### Detail\n'; }
  else if (kind === 'fence') { fill(0.3 * window); s += '\n```\nconst x = 1;\n```\n'; fill(0.75 * window); s += '\n\n'; }
  else { fill(0.4 * window); s += '\n\n'; fill(0.75 * window); s += '\n'; }
  fill(2.5 * window);
  return s;
}

const entries = (run, kind) => run.log.filter((e) => e.kind === kind);
const readsOf = (run, op) => entries(run, 'read').filter((e) => e.op === op);

const blocksOf = (record) => (record.messages ?? []).flatMap((m, i) => m.blocks.map((b) => ({ i, role: m.role, b })));

const summarises = (configuration) => configuration.summarises !== false;

export const WORKLOADS = {
  prefix: {
    from: null,
    property: 'none: it writes the continuation\'s checkpoint and is no run of its own',
    steps: (ctx) => prefix(ctx.prefixTurns),
    check: () => [],
  },

  continuation: {
    from: 'prefix',
    property: 'each segment produces what it exists to produce (check 2)',
    steps: () => continuation(),
    check: () => judgedBy([], 2),
    products: (configuration) => products(configuration),
  },

  W1: {
    from: null,
    turns: 70,
    property: 'grows: L1, L2 and L3 summaries form as the store grows (configurations that summarise)',
    steps(ctx) {
      const w = writer(ctx, 'W1');
      const steps = [];
      for (let n = 1; n <= this.turns; n++) steps.push(w.turn(n, { ...phaseTurn(n), ...(n === this.turns ? { more: { reads: ['state'] } } : {}) }));
      if (ctx.configurationName === 'H4') tunedOut(w, steps, 6, { before: { 4: [w.other('undo', 'command', { command: '/undo' })] } });
      return steps;
    },
    check(run, ctx) {
      if (!summarises(ctx.configuration)) return withJudged([{ step: null, message: 'couldn\'t judge: the property needs a configuration that summarises, and this one doesn\'t' }], 0);
      const last = readsOf(run, 'state').at(-1);
      if (!last) return withJudged([{ step: null, message: 'couldn\'t judge: the run logged no state read' }], 0);
      const got = last.answer?.maxLevel;
      return withJudged(typeof got === 'number' && got >= 3 ? [] : [{ step: last.step ?? null, message: `the store reached L${got ?? '?'} in ${this.turns} turns, short of L3` }], 1);
    },
  },

  W2: {
    from: null,
    turns: 70,
    property: 'reads: a store of reading-sized tool results, attachments and a paste reaches L3 by its end (the store is ready after each turn, which the driver\'s settle requires)',
    steps(ctx) {
      const w = writer(ctx, 'W2');
      const steps = [];
      for (let n = 1; n <= this.turns; n++) {
        const plan = readingTurn(n);
        steps.push(w.turn(n, {
          calls: plan.calls,
          rounds: plan.rounds,
          ...(plan.paste ? { size: SIZES.document } : {}),
          attach: n % 7 === 0,
          result: (k, canaryText) => ({ kind: 'prose', size: w.between(SIZES.reading), canary: canaryText }),
          ...(n === this.turns ? { more: { reads: ['state'] } } : {}),
        }));
      }
      return steps;
    },
    check(run, ctx) {
      return WORKLOADS.W1.check.call(this, run, ctx);
    },
  },

  W4: {
    from: 'checkpoint',
    turns: 4,
    property: 'thinking: no call this workload makes goes out parted from the thinking that led to it, which comes ahead of it in its message',
    steps(ctx) {
      const w = writer(ctx, 'W4');
      return Array.from({ length: this.turns }, (_, i) => w.turn(i + 1, { thinking: w.between(SIZES.call), callId: () => `t${ctx.seed}_${i + 1}` }));
    },
    check(run, ctx) {
      const own = new RegExp(`^t${ctx.seed}_\\d+$`);
      const out = [];
      let judged = 0;
      for (const r of run.records.filter((x) => x.kind === 'agent')) {
        for (const m of r.messages ?? []) {
          let since = 0;
          const parted = [];
          m.blocks.forEach((b, k) => {
            if (b.type !== 'tool_use') return;
            if (own.test(String(b.toolUseId))) {
              judged++;
              if (!m.blocks.slice(since, k).some((x) => x.type === 'thinking' || x.type === 'redacted_thinking')) parted.push(b.toolUseId);
            }
            since = k + 1;
          });
          if (parted.length) out.push({ step: r.step, message: `request ${r.id}: a call went out without its thinking (${parted.join(', ')})` });
        }
      }
      return withJudged(out, judged);
    },
  },

  W5: {
    from: 'checkpoint',
    turns: 12,
    property: 'shards: a body larger than the message cap, stored in parts, that context-manager sends whole never goes out without its tool blocks',
    steps(ctx) {
      const w = writer(ctx, 'W5');
      const steps = [guardTurn(w, 'g')];
      for (let n = 1; n <= this.turns; n++) {
        const big = n % 2 === 0;
        const t = w.turn(n, {
          callId: () => `t${ctx.seed}_${n}`,
          result: (k, canaryText) => (big
            ? { kind: 'mixed', size: w.between(SIZES.large), width: 64, height: 48, canary: canaryText }
            : { kind: 'prose', size: w.between(SIZES.result), canary: canaryText }),
          more: { reads: ['messages'] },
        });
        if (n % 4 === 1) t.replies[0].text = `${w.c(n, 'r1')} ${prose(w.between(SIZES.largeReply), `${w.id(n)}:large`)}`;
        steps.push(t);
      }
      return steps;
    },
    check(run, ctx) {
      return toolBlocksLost(run, Array.from({ length: this.turns }, (_, i) => `t${ctx.seed}_${i + 1}`));
    },
  },

  // A call the fixture server never answers is answered with an error by agent-framework once the recipe's
  // `requestTimeoutMs` passes.
  W6: {
    from: 'checkpoint',
    turns: 12,
    property: 'tools: no request carries a mark of membrane\'s pairing repair, which would mean context-manager handed it a result without its call or a call without its result; context-manager\'s own repair marks, the designed output for the suppression it scripts, are counted beside (marks are found by their text, which the fixture\'s tool output never quotes; check 11 judges each compile\'s pairs)',
    recipe: { fixtureServer: { requestTimeoutMs: 2000 } },
    needs: { webui: true },
    steps(ctx) {
      const w = writer(ctx, 'W6');
      const steps = [];
      for (let n = 1; n <= this.turns; n++) {
        switch (n % 4) {
          case 0:
            steps.push(w.turn(n, { calls: 2 }));
            break;
          case 1:
            steps.push(w.turn(n, { rounds: 2, callId: () => `t${ctx.seed}_reuse_${n}` }));
            break;
          case 2:
            steps.push(w.turn(n, n === 2 ? { result: (k, canaryText) => ({ kind: 'prose', size: 400, canary: canaryText, hold: true }), more: { also: ['server didn\'t answer within'] } } : {}));
            break;
          default:
            steps.push(w.turn(n));
            steps.push(w.other(`${n}.suppress`, 'suppress', { messages: [{ canary: w.c(n, 'r1') }] }));
        }
      }
      return steps;
    },
    // membrane 0.8.0's normalizer repairs both shapes on the wire (normalize-tool-pairs.ts), so a request that
    // reaches the stand-in shows them only as its repair marks.
    check(run, ctx) {
      const requests = run.records.filter((r) => r.kind === 'agent');
      const marks = requests.flatMap((r) => (r.messages ?? []).flatMap((m) => m.blocks.flatMap((b) => (b.repairs ?? []).map((mark) => ({ r, mark })))));
      const membrane = marks.filter((x) => x.mark.startsWith('membrane:'));
      const own = marks.length - membrane.length;
      const out = membrane.map(({ r, mark }) => ({ step: r.step, request: r.id, message: `request ${r.id} carries membrane's ${mark.slice('membrane:'.length)} repair mark, so context-manager handed it a call or result unpaired` }));
      const held = `${ctx.seed}.2`;
      const at = run.log.filter((e) => e.step === held);
      if (!at.some((e) => e.kind === 'notice' && e.peer === 'server' && e.notice === 'held')) out.push({ step: held, message: 'the fixture server held no call at this step, so the call it should hold never reached it' });
      else if (!at.some((e) => e.kind === 'ipc' && e.event?.type === 'tool:failed' && String(e.event.error ?? '').includes('didn\'t answer within'))) out.push({ step: held, message: 'the call the fixture server held never timed out at this step' });
      return withJudged(out, requests.length + 1, `${requests.length} request(s), ${membrane.length} membrane repair mark(s), ${own} of context-manager's own, and the held call's timeout`);
    },
  },

  W7: {
    from: 'checkpoint',
    turns: 21,
    property: 'failures: at each step, the merges the stand-in refuses raise one off-path refusal alert each, and nothing else raises one',
    variants: ['merges-refused', 'merges-rejected', 'fable-no-tools', 'no-tools'],
    owns: (variant) => (variant === 'merges-refused' ? [{ check: 1, what: 'refusal-offpath' }] : []),
    fromEmpty: (variant) => variant === 'fable-no-tools' || variant === 'no-tools',
    standin: (variant) => ({ refuseMerges: variant === 'merges-refused', rejectMerges: variant === 'merges-rejected' }),
    recipe: (variant) => ({
      ...(variant === 'fable-no-tools' || variant === 'no-tools' ? { agent: { allowedTools: [] } } : {}),
      ...(variant === 'fable-no-tools' ? { agent: { allowedTools: [], strategy: { compressionModel: 'claude-fable-5-1' } } } : {}),
    }),
    steps(ctx) {
      const w = writer(ctx, 'W7');
      const noTools = ['fable-no-tools', 'no-tools'].includes(ctx.variant);
      const turns = noTools ? 32 : this.turns;
      if (ctx.configurationName === 'H2') {
        const rounds = [];
        for (let n = 1; n <= turns; n++) {
          const plan = phaseTurn(n);
          for (let k = 0; plan.calls && k < (plan.rounds ?? 1); k++) rounds.push({ calls: Array.from({ length: plan.calls }, () => ({ kind: 'prose', size: w.between(SIZES.result) })) });
        }
        return [subagentTurn(w, ctx, 1, rounds)];
      }
      const steps = [];
      for (let n = 1; n <= turns; n++) {
        if (noTools) steps.push(w.turn(n, { calls: 0, size: SIZES.reading }));
        else steps.push(w.turn(n, ctx.variant === 'merges-refused' ? phaseTurn(n) : {}));
      }
      return steps;
    },
    check(run, ctx) {
      const out = [];
      const calls = run.records.filter((r) => r.kind === 'summariser');
      if (ctx.variant === 'merges-refused') {
        const refused = calls.filter((r) => r.answer?.shape === 'refusal');
        const alerts = run.log.filter((e) => e.kind === 'ipc' && e.event?.type === 'ops:alert' && e.event.kind === 'refusal-offpath');
        if (!refused.length) return withJudged([{ step: null, message: 'couldn\'t judge: the stand-in refused no merge' }], 0);
        const count = (list) => list.reduce((m, x) => m.set(x.step, (m.get(x.step) ?? 0) + 1), new Map());
        const byStep = count(refused);
        const alertsBy = count(alerts);
        for (const step of new Set([...byStep.keys(), ...alertsBy.keys()])) {
          const n = byStep.get(step) ?? 0;
          const a = alertsBy.get(step) ?? 0;
          if (n !== a) out.push({ step, message: `${n} refused merge(s) at this step raised ${a} off-path refusal alert(s), where each raises one and nothing else does` });
        }
        return withJudged(out, refused.length);
      }
      return judgedBy(out, 1);
    },
  },

  W8: {
    from: 'checkpoint',
    turns: 16,
    property: 'tight: with the budget lowered to the edge and restored, a configuration that compiled every turn before the lowering does so again within two steps of the restore',
    variants: ['enforced', 'unenforced'],
    recipe: (variant) => ({ agent: { strategy: { enforceBudget: variant === 'enforced' } } }),
    steps(ctx) {
      const w = writer(ctx, 'W8');
      const underCut = (n) => n >= 5 && n <= 14;
      const budget = ctx.budget;
      const cut = (step, tokens) => w.other(`${step}.budget`, 'panel', { op: 'settings-update', params: { contextBudgetTokens: tokens, immediate: true }, edge: { reserve: ctx.reserve } });
      if (ctx.configurationName === 'H4') {
        const forReader = (step, tokens) => { const c = cut(step, tokens); return { ...c, params: { ...c.params, agent: 'Subconscious' } }; };
        const steps = [];
        tunedOut(w, steps, this.turns, { mayFail: underCut, before: { 5: [forReader('h5', Math.round(budget * 0.6))], 9: [forReader('h9', edge(ctx))], 13: [forReader('h13', budget)] } });
        return steps;
      }
      const steps = [];
      for (let n = 1; n <= this.turns; n++) {
        if (n === 5) steps.push(cut(n, Math.round(budget * 0.6)));
        if (n === 9) steps.push(cut(n, edge(ctx)));
        if (n === 13) steps.push(cut(n, budget));
        steps.push(w.turn(n, underCut(n) ? { more: { mayFail: true } } : {}));
      }
      return steps;
    },
    check(run, ctx) {
      if (ctx.configurationName === 'H4') return restoredWithin(run, 'Subconscious', (k) => `${ctx.seed}.h${k}`, 'the reader\'s turn');
      return restoredWithin(run, FIXTURE_AGENT, (n) => `${ctx.seed}.${n}`, 'step');
    },
  },

  W9: {
    from: 'checkpoint',
    turns: 20,
    property: 'lifecycle: a store closed and reopened compiles the request it compiled before it closed (check 12, on dry compiles either side of the restart)',
    needs: { webui: true, subagents: true },
    steps(ctx) {
      const w = writer(ctx, 'W9');
      const { budget, adaptive, folding, native } = ctx;
      const dry = { op: 'dry-compile', budget: { maxTokens: budget, reserveForResponse: ctx.reserve } };
      const panel = (step, op, params) => w.other(step, 'panel', { op, params });
      const command = (step, text, more = {}) => w.other(step, 'command', { command: text, ...more });
      const steps = [];
      for (let n = 1; n <= this.turns; n++) {
        if (n === 9) for (const k of ['a', 'b', 'c']) steps.push(w.turn(`9${k}`, { calls: 0, size: SIZES.reading }));
        if (n === 16) steps.push({ ...guardTurn(w, '16g'), namedAnywhere: true });
        steps.push(w.turn(n, { ...(n === 18 && native ? { arrival: { after: 1 } } : {}), ...(n >= 16 ? { more: { namedAnywhere: true } } : {}) }));
        switch (n) {
          case 2:
            if (adaptive) for (const k of ['h', 'i', 'j']) steps.push({ ...w.turn(`2${k}`, { calls: 0 }), text: markdownPaste(ctx.seed, `2${k}`, 3000) });
            break;
          case 3:
            steps.push(w.other('3.reopen', 'restart', { reloadCheck: true }));
            break;
          case 4:
            steps.push(panel(`4.pins`, 'pins', {}));
            break;
          case 5:
            steps.push({ ...panel('5.tail', 'settings-update', { tailTokens: 15000 }), expect: summarises(ctx.configuration) ? 'ok' : 'refused' });
            if (folding === 'kv-stable') steps.push(panel('5.prepare', 'settings-update', { contextBudgetTokens: Math.round(budget * 0.6), transitionPaceTokens: 10000 }));
            break;
          case 6:
            steps.push(w.other('6.witnessed', 'restart', { agent: { strategy: { witnessedBeforeSequence: { sequenceOf: w.c(6, 'r2') }, witnessedIdentityReminder: 'This stretch is a record you inherited, not your own experience.' } } }));
            break;
          case 7: {
            const fork = w.turn('7f', { calls: 0 });
            const marker = `[[fork:${ctx.seed}]]`;
            steps.push({
              ...fork,
              canaries: [...fork.canaries, w.c('7f', 'task'), w.c('7f', 'f1')],
              replies: [
                { text: `${w.c('7f', 'r1')} forking`, calls: [{ name: 'subagent--fork', input: { name: `fork-${ctx.seed}`, task: `${w.c('7f', 'task')} ${prose(300, `${w.id('7f')}:task`)}`, systemPrompt: `${marker} You are the fork.`, sync: true } }] },
                { text: `${w.c('7f', 'r2')} ${prose(300, `${w.id('7f')}:r2`)}` },
              ],
              sub: { marker, canaries: [w.c('7f', 'task')], replies: [{ text: `${w.c('7f', 'f1')} ${prose(400, `${w.id('7f')}:f1`)}` }] },
            });
            break;
          }
          case 8:
            steps.push(w.other('8.prompt', 'restart', { agent: { systemPrompt: 'You are the strategy fixture\'s agent, with a prompt an operator changed.' } }));
            if (folding === 'kv-stable') steps.push(panel('8.prepare', 'settings-update', { contextBudgetTokens: Math.round(budget * 0.6), transitionPaceTokens: 50000 }));
            break;
          case 10:
            steps.push({ ...panel('10.pin', 'pin-add', { firstMessageId: { canary: w.c(1, 'in') }, lastMessageId: { canary: w.c(1, 'r2') }, name: `w9-${ctx.seed}` }), expect: summarises(ctx.configuration) ? 'ok' : 'refused' });
            break;
          case 11:
            steps.push({ ...panel('11.pin-level', 'pin-add', { firstMessageId: { canary: w.c(2, 'in') }, lastMessageId: { canary: w.c(2, 'r2') }, level: 1 }), expect: summarises(ctx.configuration) ? 'ok' : 'refused' });
            break;
          case 13:
            steps.push(command('13.undo', '/undo', { reads: [dry] }));
            steps.push(command('13.redo', '/redo', { reads: [dry] }));
            break;
          case 14:
            if (summarises(ctx.configuration)) steps.push(panel('14.unpin', 'pin-remove', { pinId: { pin: `w9-${ctx.seed}` } }));
            break;
          case 15:
            steps.push(command('15.newtopic', '/newtopic A new topic.', summarises(ctx.configuration) ? {} : { expect: 'failed' }));
            break;
          case 17:
            steps.push(w.other('17.suppress', 'suppress', { messages: [{ canary: w.c(16, 'in') }] }));
            break;
          case 19:
            steps.push(w.other('19.head', 'restart', { agent: { strategy: { headWindowTokens: 8000 } } }));
            break;
          default:
            break;
        }
      }
      return steps;
    },
    check: () => judgedBy([], 12),
  },

  W11: {
    from: 'checkpoint',
    turns: 14,
    property: 'protections: pins and document marks an operator puts on older messages stay placed through a budget cut and a restore, as context-manager\'s pins promise (a compile that can\'t hold them refuses instead), and the pins invariant holds each compile to them',
    steps(ctx) {
      const w = writer(ctx, 'W11');
      const budget = ctx.budget;
      const pin = (step, first, last, opts = {}) => w.other(step, 'panel', { op: 'pin-add', params: { firstMessageId: first, lastMessageId: last, ...opts } });
      const steps = [];
      for (let n = 1; n <= this.turns; n++) {
        if (n === 9) steps.push(w.other('9.budget', 'panel', { op: 'settings-update', params: { contextBudgetTokens: Math.round(budget * 0.35), immediate: true }, edge: { reserve: ctx.reserve } }));
        if (n === 13) steps.push(w.other('13.budget', 'panel', { op: 'settings-update', params: { contextBudgetTokens: budget, immediate: true } }));
        const failFirst = n === 2 && ctx.configurationName === 'H1';
        const t = w.turn(n, { more: { ...(n >= 9 && n < 13 ? { mayFail: true } : {}), ...(failFirst ? { retries: true } : {}) } });
        if (failFirst) t.replies = [{ error: { status: 529, type: 'overloaded_error', message: 'stand-in: overloaded, once' } }, ...t.replies];
        steps.push(t);
        switch (n) {
          case 2:
            steps.push(pin('2.level0', { storeAt: 0.10 }, { storeAt: 0.10 }, { level: 0 }));
            steps.push(pin('2.max0', { storeAt: 0.14 }, { storeAt: 0.14 }, { maxLevel: 0 }));
            break;
          case 3:
            steps.push(pin('3.result', { storeAt: 0.30, withBlock: 'tool_result' }, { storeAt: 0.30, withBlock: 'tool_result' }));
            break;
          case 4:
            steps.push(pin('4.max2', { storeAt: 0.45 }, { storeAt: 0.45 }, { maxLevel: 2 }));
            steps.push(pin('4.level1', { storeAt: 0.55 }, { storeAt: 0.55 }, { level: 1 }));
            break;
          case 8:
            steps.push(pin('8.document', { storeAt: 0.20 }, { storeAt: 0.20 }, { kind: 'document', maxLevel: 1 }));
            steps.push(pin('8.level1', { canary: w.c(1, 'in') }, { canary: w.c(1, 'r2') }, { level: 1 }));
            break;
          case 12:
          case 14:
            steps.push(w.other(`${n}.pins`, 'panel', { op: 'pins', params: {} }));
            break;
          default:
            break;
        }
      }
      return steps;
    },
    // context-manager 0.24.0's README: "`listPins` and `unpin` manage the pins", and "A compile whose budget can't
    // hold the raw pins beside the rest refuses with `OverBudgetError`".
    check(run, ctx) {
      const panels = entries(run, 'panel');
      const pinsAt = (step) => panels.filter((e) => e.step === `${ctx.seed}.${step}`).at(-1)?.response?.data?.pins;
      const placed = pinsAt('8.level1') ?? [];
      if (!placed.length) return withJudged([{ step: `${ctx.seed}.8.level1`, message: 'couldn\'t judge: the panel listed no pin once the last was added' }], 0);
      const named = (p) => `${p.kind}${p.level !== undefined ? ` at L${p.level}` : ''}${p.maxLevel !== undefined ? ` to L${p.maxLevel}` : ''}`;
      const protection = (p) => JSON.stringify([p.kind, p.level, p.maxLevel, p.firstMessageId, p.lastMessageId]);
      const out = [];
      let judged = 0;
      let before = [];
      for (const step of ['2.level0', '2.max0', '3.result', '4.max2', '4.level1', '8.document', '8.level1']) {
        const listed = pinsAt(step);
        if (!Array.isArray(listed)) { out.push({ step: `${ctx.seed}.${step}`, message: 'couldn\'t judge: the panel\'s answer to this pin holds no list' }); before = null; continue; }
        if (before) {
          judged++;
          const gone = before.filter((p) => !listed.some((q) => q.id === p.id));
          const added = listed.filter((p) => !before.some((q) => q.id === p.id));
          if (gone.length || added.length !== 1) out.push({ step: `${ctx.seed}.${step}`, message: `adding this pin listed ${added.length} new pin(s) or mark(s), and ${gone.length} listed before it are gone${gone.length ? `: ${gone.map(named).join(', ')}` : ''}` });
        }
        before = listed;
      }
      for (const step of ['12.pins', '14.pins']) {
        const listed = pinsAt(step);
        if (!Array.isArray(listed)) { out.push({ step: `${ctx.seed}.${step}`, message: 'couldn\'t judge: the panel\'s pins answer holds no list' }); continue; }
        judged += placed.length;
        const now = new Map(listed.map((p) => [p.id, p]));
        const gone = placed.filter((p) => !now.has(p.id));
        const changed = placed.filter((p) => now.has(p.id) && protection(now.get(p.id)) !== protection(p));
        if (gone.length) out.push({ step: `${ctx.seed}.${step}`, message: `${gone.length} of the ${placed.length} pins and marks placed by step 8 are gone: ${gone.map(named).join(', ')}` });
        if (changed.length) out.push({ step: `${ctx.seed}.${step}`, message: `${changed.length} of the ${placed.length} pins and marks placed by step 8 no longer protect what they did: ${changed.map((p) => `${named(p)} is now ${named(now.get(p.id))}${now.get(p.id).firstMessageId !== p.firstMessageId || now.get(p.id).lastMessageId !== p.lastMessageId ? ' over another range' : ''}`).join(', ')}` });
      }
      return withJudged(out, judged);
    },
  },
};

function restoredWithin(run, agent, stepOf, noun) {
  const firstByStep = new Map();
  for (const a of assemblies(run.log, agent)) if (!firstByStep.has(a.step)) firstByStep.set(a.step, a);
  const outcome = (n) => firstByStep.get(stepOf(n))?.outcome ?? 'no request';
  const before = [1, 2, 3, 4].filter((n) => outcome(n) !== 'compiled');
  if (before.length) return withJudged([{ step: stepOf(before[0]), message: `couldn't judge the restore: ${before.map((n) => `${noun} ${n} ${outcome(n)}`).join(', ')}, before the budget was lowered` }], 0);
  return withJudged([15, 16].filter((n) => outcome(n) !== 'compiled').map((n) => ({ step: stepOf(n), message: `${noun} ${n}: ${outcome(n)} ${n - 13} turn(s) after the budget was restored` })), 2);
}

export function toolBlocksLost(run, calls = []) {
  const reads = readsOf(run, 'messages');
  const failed = reads.find((read) => !Array.isArray(read.answer ?? []));
  if (failed) return withJudged([{ step: failed.step ?? null, message: `couldn't judge: the store's messages couldn't be read${isUnreadable(failed.answer) ? ` (${failed.answer.unreadable})` : ''}` }], 0);
  const toolIds = new Map();
  const groupOf = new Map();
  for (const m of reads.flatMap((read) => read.answer ?? [])) {
    if (!groupOf.has(m.id)) groupOf.set(m.id, m.bodyGroupId ?? m.id);
    if (!m.bodyGroupId) continue;
    const ids = toolIds.get(m.bodyGroupId) ?? new Set();
    for (const b of m.blocks) if (b.type === 'tool_use' || b.type === 'tool_result') ids.add(`${b.type}:${b.id ?? b.toolUseId}`);
    if (ids.size) toolIds.set(m.bodyGroupId, ids);
  }
  const paired = requestPairs(run.records, run.log, FIXTURE_AGENT);
  if (!paired) return withJudged([{ step: null, message: 'couldn\'t judge: the log holds no request compile line to pair with the requests' }], 0);
  const out = [];
  let judged = calls.length;
  const stored = new Set(reads.flatMap((read) => read.answer ?? []).flatMap((m) => m.blocks).filter((b) => b.type === 'tool_use' || b.type === 'tool_result').map((b) => `${b.type}:${b.id ?? b.toolUseId}`));
  const unstored = calls.flatMap((id) => [`tool_use:${id}`, `tool_result:${id}`]).filter((key) => !stored.has(key));
  if (unstored.length) out.push({ step: null, message: `the store holds none of these blocks of the workload's calls: ${unstored.join(', ')}` });
  for (const { line, request } of paired.pairs) {
    const sent = new Set(blocksOf(request).filter((x) => x.b.type === 'tool_use' || x.b.type === 'tool_result').map((x) => `${x.b.type}:${x.b.toolUseId}`));
    const whole = new Set((line.messages ?? []).flatMap((m) => m.sources ?? []).filter((s) => /^r:[^!]+$/.test(s)).map((s) => groupOf.get(s.slice(2))).filter(Boolean));
    for (const key of whole) {
      if (!toolIds.has(key)) continue;
      judged++;
      const lost = [...toolIds.get(key)].filter((id) => !sent.has(id));
      if (lost.length) out.push({ step: request.step, message: `request ${request.id}: ${key} went out whole but without its tool blocks ${[...new Set(lost)].join(', ')}` });
    }
  }
  return withJudged(out, judged);
}

export const RUNS = [
  'H1/continuation', 'H3/continuation',
  'H1/W1', 'H4/W1',
  'C3h/W2', 'H1/W2', 'H1b/W2',
  'H3/W4',
  'C5h/W5',
  'C8h/W6',
  'C3h/W7/merges-refused', 'C3h/W7/fable-no-tools', 'C3h/W7/no-tools',
  'H1/W7/merges-refused', 'H1/W7/merges-rejected', 'H2/W7/merges-refused',
  'C3h/W8/unenforced', 'C6h/W8/enforced', 'H1/W8/enforced', 'H4/W8/unenforced',
  'H3/W9', 'C3h/W9', 'C6h/W9', 'H1/W9',
  'C6h/W11', 'H1/W11',
];

export function seedOf(id) {
  return 100 + (hash32(id) % 900000);
}

const merge = (a = {}, b = {}) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v;
  return out;
};

export function runOf(id, configurations, facts, { prefixTurns = {} } = {}) {
  const [configName, workloadName, variant = null] = id.split('/');
  const base = configurations[configName];
  const workload = WORKLOADS[workloadName];
  if (!base || !workload || (variant !== null && !(workload.variants ?? []).includes(variant))) throw new Error(`no run ${id}: no such configuration, workload or variant`);
  const recipe = typeof workload.recipe === 'function' ? workload.recipe(variant) : workload.recipe ?? {};
  const modules = {
    ...(workload.needs?.webui ? { webui: { host: '127.0.0.1', port: 0 } } : {}),
    ...(workload.needs?.subagents ? { subagents: true } : {}),
  };
  const configuration = merge(merge(base, Object.keys(modules).length ? { modules } : {}), recipe);
  const strategy = configuration.agent?.strategy ?? {};
  const adaptive = strategy.type !== 'passthrough' && strategy.adaptiveResolution !== false;
  const seed = seedOf(id);
  const ctx = {
    seed,
    variant,
    configuration,
    configurationName: configName,
    budget: facts.budget,
    reserve: facts.maxTokens,
    adaptive,
    folding: adaptive ? strategy.foldingStrategy ?? 'kv-unified' : null,
    native: configuration.agent?.formatter !== 'anthropic-xml',
    prefixTurns: prefixTurns[configName],
  };
  const fromEmpty = workload.from === null || workload.fromEmpty?.(variant) || configName === 'H2';
  return {
    id,
    workload: workloadName,
    variant,
    seed,
    configuration,
    standin: typeof workload.standin === 'function' ? workload.standin(variant) : {},
    from: WORKLOADS[workload.from] ? `${configName}/${workload.from}` : fromEmpty ? null : `${configName}/${base.summarises === false ? 'W1' : 'W2'}`,
    steps: () => workload.steps(ctx),
    check: (run) => workload.check(run, ctx),
    owns: typeof workload.owns === 'function' ? workload.owns(variant) : workload.owns ?? [],
    products: workload.products ? workload.products(configuration) : [],
  };
}
