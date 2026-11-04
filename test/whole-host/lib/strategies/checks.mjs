import { runVaryingMasker } from './compare.mjs';
import { cutMessage } from './cut.mjs';
import { CANARY } from './standin.mjs';

export function declaredProducts(records, script, products, store = null) {
  const segmentOf = new Map(script.map((s) => [s.id, s.segment]));
  const out = [];
  let judged = 0;
  let storeless = 0;
  for (const [segment, wanted] of Object.entries(products)) {
    if (!script.some((s) => s.segment === segment)) continue;
    const mine = records.filter((r) => segmentOf.get(r.step) === segment);
    const judgeable = wanted.filter((p) => !p.fromStore || store !== null);
    storeless += wanted.length - judgeable.length;
    judged += judgeable.length;
    const missing = judgeable.filter((p) => (p.fromStore ? !p.fromStore(store) : !mine.some((r) => p.test(r, mine)))).map((p) => p.name);
    if (missing.length) out.push({ segment, missing });
  }
  return withJudged(out, judged, storeless ? `${storeless} product${storeless === 1 ? '' : 's'} not judged, as ${storeless === 1 ? 'it needs' : 'they need'} the final store and the run has none` : null);
}

export function compileInvariants(log = []) {
  const flags = [];
  let judged = 0, unplaced = 0, unread = 0;
  const unjudged = new Map();
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const line of e.lines ?? []) {
      if (line.outcome === 'compiled') judged++;
      for (const v of line.violations ?? []) {
        if (v.invariant === 'unplaced') unplaced += v.count ?? 0;
        if (v.invariant === 'unreadable') unread++;
      }
      for (const u of line.unjudged ?? []) unjudged.set(u, (unjudged.get(u) ?? 0) + 1);
      if (line.outcome === 'unrecordable') flags.push({ check: 11, step: e.step, what: `${line.agent}:${line.kind}:unrecordable`, message: `the harness module couldn't record ${line.agent}'s ${line.kind} compile ${line.seq}: ${line.reason}`, ...(line.full ? { full: `the harness module couldn't record ${line.agent}'s ${line.kind} compile ${line.seq}: ${line.full}` } : {}) });
      for (const v of line.violations ?? []) flags.push({ check: 11, step: e.step, what: `${line.agent}:${line.kind}:${v.invariant}`, detail: v.detail, ...(v.full ? { full: v.full } : {}), message: COULDNT.has(v.invariant) ? `couldn't judge all of ${line.agent}'s ${line.kind} compile ${line.seq}: ${v.detail}` : `${line.agent}'s ${line.kind} compile ${line.seq} breaks ${v.invariant}: ${v.detail}` });
    }
  }
  const besides = [
    ...[...unjudged].map(([what, n]) => { const [part, ...why] = what.split(': '); return `${part} couldn't be judged in ${n}, as ${why.join(': ')}`; }),
    ...(unplaced ? [`store order couldn't place ${unplaced} of what was sent`] : []),
    ...(unread ? [`${unread} read${unread === 1 ? '' : 's'} an invariant needed failed`] : []),
  ];
  return withJudged(flags, judged, besides.length ? besides.join('; ') : null);
}

const COULDNT = new Set(['unplaced', 'unreadable']);

const BINDING_BETA = 'thinking-binding-controls-2026-08-01';

export function bindingControl(records) {
  const asked = records.filter((r) => r.kind === 'agent');
  const flags = asked.flatMap((r) => [
    ...(r.thinking?.block_binding?.prefix_mismatch_behavior !== 'drop_block' ? [{ check: 15, step: r.step ?? 'the run', what: 'no-drop-control', message: `request ${r.id} carries no drop control (its thinking setting: ${JSON.stringify(r.thinking ?? null)})` }] : []),
    ...(!(r.head?.headers?.beta ?? []).includes(BINDING_BETA) ? [{ check: 15, step: r.step ?? 'the run', what: 'no-binding-beta', message: `request ${r.id} doesn't ask for the ${BINDING_BETA} beta the control needs (its anthropic-beta: ${JSON.stringify(r.head?.headers?.beta ?? null)})` }] : []),
  ]);
  return withJudged(flags, asked.length);
}

export function pairing(records, log = [], agent = FIXTURE_AGENT) {
  const paired = requestPairs(records, log, agent);
  if (!paired) return withJudged([], 0);
  if (paired.disagree?.length) return withJudged([{ check: 13, step: 'the run', what: `${agent}:disagree`, ...cutMessage((cut) => `couldn't judge ${agent}'s pairing: by the clock ${cut(paired.disagree, 4)} pair, but the request doesn't end on the compile's last canary, so the two processes' stamps may not share a clock`) }], null);
  if (paired.unstamped.length) return withJudged([{ check: 13, step: 'the run', what: `${agent}:unstamped`, ...cutMessage((cut, whole) => `couldn't judge ${agent}'s pairing: ${cut(paired.unstamped, 4)}${!whole && paired.unstamped.length > 4 ? ` and ${paired.unstamped.length - 4} more` : ''} carry no clock stamp to order by`) }], null);
  return withJudged(paired.unpaired.map((l) => ({ check: 13, step: l.step ?? 'the run', what: `${agent}:unpaired`, message: `${agent}'s request compile ${l.seq} (assembly ${l.assembly}) went out in no request: none arrived at the stand-in after it and before the agent's next compile, so agent-framework never sent it, or the pairing went wrong` })), paired.pairs.length + paired.unpaired.length);
}

export function reloads(log = []) {
  const flags = [];
  const lines = new Map();
  const blobs = {};
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    Object.assign(blobs, e.blobs ?? {});
    for (const l of e.lines ?? []) lines.set(`${e.boot}:${l.seq}`, l);
  }
  const shape = (l) => {
    const mask = runVaryingMasker();
    const held = (id) => JSON.stringify(mask(blobs[id] ?? null));
    return {
      outcome: l.outcome,
      error: l.error?.class ?? null,
      messages: (l.messages ?? []).map((m) => ({ sources: m.sources, content: held(m.content) })),
      system: held(l.system),
    };
  };
  let judged = 0;
  for (const e of log) {
    if (e.kind !== 'reload') continue;
    const [before, after] = [e.before, e.after].map((at) => (at?.seq == null ? null : lines.get(`${at.boot}:${at.seq}`) ?? null));
    const step = e.step;
    if (!before || !after) { flags.push({ check: 12, step, message: `couldn't judge the reload: the log holds no dry compile line ${!before ? 'before the restart' : 'after it'}` }); continue; }
    const [a, b] = [shape(before), shape(after)];
    if (a.outcome === 'refused' && b.outcome === 'refused' && a.error === b.error) { flags.push({ check: 12, step, message: `couldn't judge the reload: the dry compile refused (${a.error}) both before the restart and after it` }); continue; }
    judged++;
    if (a.outcome !== b.outcome || a.error !== b.error) { flags.push({ check: 12, step, message: `after the restart the dry compile ${b.outcome === 'refused' ? `refused (${b.error})` : 'compiled'}, where before it ${a.outcome === 'refused' ? `refused (${a.error})` : 'compiled'}` }); continue; }
    const n = Math.max(a.messages.length, b.messages.length);
    const at = [...Array(n).keys()].find((i) => JSON.stringify(a.messages[i]) !== JSON.stringify(b.messages[i]));
    if (at !== undefined) flags.push({ check: 12, step, message: `after the restart the dry compile differs from the one before at message ${at} of ${a.messages.length} before and ${b.messages.length} after (sources ${JSON.stringify(a.messages[at]?.sources ?? null)} before, ${JSON.stringify(b.messages[at]?.sources ?? null)} after)` });
    if (a.system !== b.system) flags.push({ check: 12, step, message: 'after the restart the dry compile\'s system injections differ from the ones before' });
  }
  return withJudged(flags, judged);
}

export function withJudged(flags, judged, besides = null) {
  Object.defineProperty(flags, 'judged', { value: judged, enumerable: false });
  if (besides) Object.defineProperty(flags, 'besides', { value: besides, enumerable: false });
  return flags;
}

export function judgedBy(flags, check) {
  Object.defineProperty(flags, 'judgedBy', { value: check, enumerable: false });
  return flags;
}

export function everyTurnAnswers(records, log = [], script = []) {
  const mayFail = new Set(script.filter((s) => s.mayFail).map((s) => s.id));
  const retries = new Set(script.filter((s) => s.retries).map((s) => s.id));
  const owned = (e) => (mayFail.has(e.step) && (/^inference:(failed|exhausted)$/.test(e.event?.type ?? '') || (e.event?.type === 'ops:alert' && e.event.kind === 'context-refusal')))
    || (retries.has(e.step) && e.event?.type === 'inference:failed');
  const flags = [];
  withJudged(flags, records.length);
  for (const r of records) {
    if (r.kind === 'unclassified') flags.push({ check: 1, step: r.step, request: r.id, message: `unclassified request: ${r.reason}` });
    else if (r.refused) flags.push({ check: 1, step: r.step, request: r.id, message: `the stand-in refused it (${r.refused})` });
  }
  for (const e of log) {
    if (e.kind === 'ipc' && owned(e)) continue;
    if (e.kind === 'ipc' && /^inference:(failed|exhausted)$/.test(e.event?.type ?? '')) flags.push({ check: 1, step: e.step, message: `${e.event.type}: ${e.event.error ?? e.event.reason ?? ''}`.trim() });
    if (e.kind === 'ipc' && e.event?.type === 'ops:alert') flags.push({ check: 1, step: e.step, what: e.event.kind, message: `the host raised an operator alert, ${e.event.kind}: ${e.event.message ?? ''}`.trim() });
    if (e.kind === 'settle' && e.phase === 'end' && e.settled === false) flags.push({ check: 1, step: e.step, message: 'the checkpoint did not settle' });
    if (e.kind === 'undelivered') flags.push({ check: 1, step: e.step, message: `the turn's answer never reached its channel: the host reported mcpl:speech-route-failed${e.reason ? ` (${e.reason})` : ''}` });
  }
  for (const s of script) {
    for (const [agent, replies] of [['primary', s.replies], ['sub', s.sub?.replies]]) {
      if (!Array.isArray(replies) || !replies.length) continue;
      const used = records.filter((r) => r.kind === 'agent' && r.step === s.id && (r.agent ?? 'primary') === agent).length;
      if (used >= replies.length || (mayFail.has(s.id) && log.some((e) => e.kind === 'ipc' && e.step === s.id && owned(e)))) continue;
      flags.push({ check: 1, step: s.id, message: `${replies.length - used} of the step's ${replies.length} scripted ${agent === 'sub' ? 'subagent ' : ''}replies went unused, so what it scripts didn't all happen` });
    }
  }
  return flags;
}

export const FIXTURE_AGENT = 'fixture';

export const STREAM_BOUND = 150_000;

function panelAt(e, agent = FIXTURE_AGENT) {
  const data = e.health?.data ?? {};
  return { composition: data.contextComposition?.[agent], settings: data.runtimeSettings?.[agent] };
}

function lastRequests(records, script, log, agent = FIXTURE_AGENT) {
  const bySegment = segmentAgents(records, script);
  const out = [];
  for (const e of log) {
    if (e.kind !== 'checkpoint') continue;
    const agents = bySegment.get(e.name) ?? [];
    const request = agents.at(-1) ?? null;
    const answered = request ? agents.filter((r) => r !== request && r.step === request.step && !['error', 'refused'].includes(r.answer?.shape)).length : 0;
    out.push({ checkpoint: e, segment: e.name, request, agents, n: request ? answered + 1 : 0, ...panelAt(e, agent) });
  }
  return out;
}

export const ofSide = (side = 'primary') => (r) => r.kind === 'agent' && (r.agent ?? 'primary') === side;
export const primary = ofSide('primary');

function segmentAgents(records, script, side = 'primary') {
  const segmentOf = new Map(script.map((s) => [s.id, s.segment]));
  const bySegment = new Map();
  const mine = ofSide(side);
  for (const r of records) {
    if (!mine(r) || !segmentOf.has(r.step)) continue;
    const segment = segmentOf.get(r.step);
    bySegment.set(segment, [...(bySegment.get(segment) ?? []), r]);
  }
  return bySegment;
}

const segmentLasts = (records, script) => new Set([...segmentAgents(records, script).values()].map((agents) => agents.at(-1)));

// agent-framework's `compileUnpinningOnRefusal` compiles again within the assembly whose compile refused, and a host
// process numbers its compiles and assemblies from 1, so a seq that doesn't rise starts another process's lines.
export function assemblies(log = [], agent = FIXTURE_AGENT) {
  const out = [];
  let previous = null;
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const l of e.lines ?? []) {
      if (l.agent !== agent || l.kind !== 'request' || !['compiled', 'refused'].includes(l.outcome)) continue;
      const at = { ...l, step: e.step ?? null, boot: e.boot ?? null };
      const same = previous && at.boot === previous.boot && l.seq > previous.seq && l.assembly === previous.assembly;
      if (same) out[out.length - 1] = at;
      else out.push(at);
      previous = at;
    }
  }
  return out;
}

export function requestPairs(records, log = [], agent = FIXTURE_AGENT, { side = agent === FIXTURE_AGENT ? 'primary' : 'sub' } = {}) {
  const sent = assemblies(log, agent).filter((l) => l.outcome === 'compiled');
  if (!sent.length) return null;
  const requests = records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === side);
  const stampOf = (v) => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null);
  const unstamped = [...sent.filter((l) => stampOf(l.stamp) === null).map((l) => `compile ${l.seq}`), ...requests.filter((r) => stampOf(r.arrived) === null).map((r) => `request ${r.id}`)];
  if (unstamped.length) return { pairs: [], continuations: requests, unpaired: [], unstamped, disagree: [] };
  const events = [...sent.map((l) => ({ at: stampOf(l.stamp), line: l })), ...requests.map((r) => ({ at: stampOf(r.arrived), request: r }))]
    .sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.line ? 1 : -1));
  const pairs = [];
  const continuations = [];
  let latest = null;
  for (const e of events) {
    if (e.line) latest = e.line;
    else if (latest) { pairs.push({ line: latest, request: e.request }); latest = null; }
    else continuations.push(e.request);
  }
  const paired = new Set(pairs.map((p) => p.line));
  const blobs = Object.assign({}, ...log.filter((e) => e.kind === 'compiles').map((e) => e.blobs ?? {}));
  const lineCanary = (l) => {
    for (let i = (l.messages ?? []).length - 1; i >= 0; i--) {
      const found = JSON.stringify(blobs[l.messages[i].content] ?? '').match(CANARY);
      if (found) return found.at(-1);
    }
    return null;
  };
  const requestCanary = (r) => (r.messages ?? []).flatMap((m) => (m.blocks ?? []).flatMap((b) => b.canaries ?? [])).at(-1) ?? null;
  const disagree = pairs.filter(({ line, request }) => lineCanary(line) !== requestCanary(request)).map(({ line, request }) => `compile ${line.seq} and request ${request.id}`);
  return { pairs, continuations, unpaired: sent.filter((l) => !paired.has(l)), unstamped: [], disagree };
}

export function compilingAgents(log = []) {
  return [...new Set(log.filter((e) => e.kind === 'compiles').flatMap((e) => (e.lines ?? []).filter((l) => l.kind === 'request' && l.outcome === 'compiled').map((l) => l.agent)))];
}

export function compileKinds(records, log = [], agent = FIXTURE_AGENT) {
  const paired = requestPairs(records, log, agent);
  if (!paired) return null;
  const kinds = new Map();
  for (const { request } of paired.pairs) kinds.set(request.id, 'compiled');
  for (const r of paired.continuations) kinds.set(r.id, 'continuation');
  return { kinds, unpaired: paired.unpaired };
}

function inputOf(r) {
  const u = r?.usage;
  if (!u) return null;
  const parts = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens];
  return parts.every((x) => typeof x === 'number') ? parts.reduce((a, b) => a + b, 0) : null;
}

export function hostTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// connectome-host's `/budget` adds this to an agent's line when agent-framework breaks its stream mid-turn only at its
// window, for a model whose thinking binds (`windowInsteadOfBudget`, #508).
const WINDOW_GOVERNS = 'its stream doesn\'t break at this budget mid-turn';

function budgetReports(log, agent) {
  const governs = new Map();
  let current = null;
  for (const e of log) {
    if (e.kind === 'budget-report') {
      const line = (e.lines ?? []).find((l) => l.startsWith(`  ${agent}: `));
      current = line === undefined ? null : { boot: e.boot, figure: line.slice(agent.length + 4).split(' ')[0], window: line.includes(WINDOW_GOVERNS), windowFigure: / its (\S+) window can't hold/.exec(line)?.[1] ?? null };
    }
    if (e.kind === 'request' && e.request?.kind === 'agent') governs.set(e.request.id, current);
  }
  return governs;
}

// membrane's usage event sums the provider's `input_tokens`, which leave out cache reads and writes, over a stream's
// rounds, and agent-framework restarts rather than continues once that sum passes `maxStreamTokens`.
function streamFreshBefore(agentRequests, r, kinds) {
  let sum = 0;
  for (let i = agentRequests.indexOf(r) - 1; i >= 0; i--) {
    const x = agentRequests[i];
    if (x.step !== r.step) return null;
    // A provider error's round reports no usage, so membrane adds nothing for it.
    if (x.answer?.shape !== 'error') {
      if (typeof x.usage?.input_tokens !== 'number') return null;
      sum += x.usage.input_tokens;
    }
    if (kinds.get(x.id) === 'compiled') return sum;
  }
  return null;
}

// The stand-in counts tokens by its own model, several percent from context-manager's estimate either way, so it holds
// requests to the provider's window; context-manager's own count against its budget is check 11's. context-manager's
// `planVsActual.budgetMet` is false whenever a plan sits between its soft target and its budget, so it isn't read.
export function budgets(records, script, log = [], { agent = FIXTURE_AGENT, streamBound = STREAM_BOUND, windowTokens } = {}) {
  const flags = [];
  const headroom = [];
  let judged = 0;
  const paired = compileKinds(records, log, agent);
  const kinds = paired?.kinds ?? new Map();
  const reports = budgetReports(log, agent);
  const windowBoots = new Set();
  const side = agent === FIXTURE_AGENT ? 'primary' : 'sub';
  const own = records.filter((r) => r.kind === 'agent' && (r.agent ?? 'primary') === side);
  const agentRequests = own;
  if (!paired && own.length) {
    return { flags: [{ check: 3, step: 'the run', what: 'no-compile-lines', message: `couldn't judge ${agent}'s ${own.length} request(s): the log holds no request compile line of ${agent}'s, so nothing tells a compiled request from a continuation round` }], headroom: [], notes: [], judged: null, requests: own.length };
  }
  const bySegment = segmentAgents(own, script, side);
  for (const e of log) {
    if (e.kind === 'checkpoint' && !bySegment.has(e.name)) flags.push({ check: 3, step: e.step ?? e.name, message: `segment ${e.name} made no agent request` });
  }
  for (const [segment, agents] of bySegment) {
    const least = {};
    const room = (kind, r, tokens, bound) => {
      if (!least[kind] || bound - tokens < least[kind].bound - least[kind].tokens) least[kind] = { segment, kind, request: r.id, tokens, bound };
    };
    for (const r of agents) {
      // A provider error returns no usage, and agent-framework's retry is the request that reaches the window.
      if (r.answer?.shape === 'error') continue;
      if (kinds.get(r.id) === 'compiled') {
        const whole = inputOf(r);
        if (whole === null || windowTokens === undefined) { flags.push({ check: 3, step: r.step, request: r.id, message: whole === null ? 'couldn\'t judge it: the stand-in recorded no usage for it' : 'couldn\'t judge it: the check was given no window' }); continue; }
        judged++;
        room('compiled', r, whole, windowTokens);
        if (whole > windowTokens) flags.push({ check: 3, step: r.step, request: r.id, message: `the stand-in counts its whole input at ${whole} tokens, over the model's ${windowTokens}-token window` });
      } else {
        const report = reports.get(r.id) ?? null;
        if (report && report.figure !== hostTokens(streamBound)) { flags.push({ check: 3, step: r.step, request: r.id, message: `couldn't judge this continuation round: the host reports ${agent}'s stream budget as ${report.figure}, and the check holds continuations to ${streamBound} (${hostTokens(streamBound)})` }); continue; }
        if (report?.window && report.windowFigure !== (windowTokens === undefined ? undefined : hostTokens(windowTokens))) { flags.push({ check: 3, step: r.step, request: r.id, message: `couldn't judge this continuation round: the host reports that ${agent}'s window, ${report.windowFigure ?? 'which it doesn\'t name'}, governs its stream, and the stand-in refuses past ${windowTokens ?? 'no window it was given'}${windowTokens === undefined ? '' : ` (${hostTokens(windowTokens)})`}` }); continue; }
        if (report?.window) { windowBoots.add(report.boot); continue; }
        const whole = inputOf(r);
        if (whole === null || windowTokens === undefined) { flags.push({ check: 3, step: r.step, request: r.id, message: whole === null ? 'couldn\'t judge this continuation round: the stand-in recorded no usage for it' : 'couldn\'t judge this continuation round: the check was given no window' }); continue; }
        if (whole > windowTokens) flags.push({ check: 3, step: r.step, request: r.id, message: `the stand-in counts this continuation round's whole input at ${whole} tokens, over the model's ${windowTokens}-token window` });
        const fresh = streamFreshBefore(agentRequests, r, kinds);
        if (fresh === null) { flags.push({ check: 3, step: r.step, request: r.id, message: 'couldn\'t judge this continuation round: a request of its stream before it has no usage recorded, or its stream has no compiled request in its turn' }); continue; }
        judged++;
        room('continuation', r, fresh + r.usage.input_tokens, streamBound);
        if (fresh > streamBound && !report) flags.push({ check: 3, step: r.step, request: r.id, message: `couldn't judge this continuation round: its stream's fresh input before it was ${fresh} tokens, over the stream bound ${streamBound}, and no report of the host's stream budget for ${agent} came before it to say whether agent-framework breaks the stream there or only at the window` });
        else if (fresh > streamBound) flags.push({ check: 3, step: r.step, request: r.id, message: `a continuation round after its stream's fresh input reached ${fresh} tokens, over the stream bound ${streamBound}, past which agent-framework restarts rather than continues` });
      }
    }
    for (const k of ['compiled', 'continuation']) if (least[k]) headroom.push(least[k]);
  }
  const notes = [...windowBoots].map((boot) => `the host reported that ${agent}'s stream breaks mid-turn only at its window (boot ${boot}), so its continuation rounds weren't held to the stream bound`);
  return { flags, headroom, notes, judged, requests: own.length };
}

export function headCounts(log, agent = FIXTURE_AGENT) {
  const counts = new Map();
  for (const e of log) {
    if (e.kind !== 'checkpoint') continue;
    const head = panelAt(e, agent).composition?.head;
    if (typeof head?.messages === 'number') counts.set(e.name, head.messages);
  }
  return counts;
}

export function headStart(store, step) {
  const own = store.messages.findIndex((m) => m.canaries.includes(`[[c:${step}.in]]`));
  let start = 0;
  for (let i = 0; i < (own < 0 ? store.messages.length : own); i++) if (store.messages[i].topicTransition) start = i;
  return start;
}

export function windowsRaw(records, script, log, store, { agent = FIXTURE_AGENT, side = 'primary' } = {}) {
  const own = ofSide(side);
  const flags = [];
  let judged = 0;
  const turns = script.filter((s) => Array.isArray(s.replies) && s.replies.length);
  const before = new Map(turns.map((s, i) => [s.id, turns.slice(Math.max(0, i - 2), i)]));
  const segmentOf = new Map(turns.map((s) => [s.id, s.segment]));
  const heads = headCounts(log, agent);
  const lasts = segmentLasts(records, script);
  const checkpointed = new Set(log.filter((e) => e.kind === 'checkpoint').map((e) => e.name));
  const order = store ? store.messages.flatMap((m) => m.canaries.filter(conversational)) : [];
  const at = new Map(order.map((c, i) => [c, i]));
  const stepAt = new Map(script.map((s, i) => [s.id, i]));
  const suppressedAt = new Map();
  script.forEach((s, i) => { if (s.op === 'suppress' || s.kind === 'suppress') for (const m of s.messages ?? []) if (m.canary && !suppressedAt.has(m.canary)) suppressedAt.set(m.canary, i); });
  const suppressed = (c, stepId) => suppressedAt.has(c) && suppressedAt.get(c) < (stepAt.get(stepId) ?? Infinity);
  const failed = new Set(log.filter((e) => e.kind === 'ipc' && /^inference:(failed|exhausted)$/.test(e.event?.type ?? '')).map((e) => e.step));
  const failedReply = (c, stepId) => failed.has(stepId) && /\.r\d+\]\]$/.test(c);
  const held = (c, stepId, at_ = stepId) => (store ? at.has(c) || (suppressedAt.has(c) && !suppressed(c, at_)) : !suppressed(c, at_) && !failedReply(c, stepId));
  const gone = new Set();
  const asked = new Map();
  for (const r of records) {
    if (!own(r)) continue;
    const n = (asked.get(r.step) ?? 0) + 1;
    asked.set(r.step, n - (['error', 'refused'].includes(r.answer?.shape) ? 1 : 0));
    if (!before.has(r.step)) continue;
    let heldTo = 0;
    const carried = new Set((r.messages || []).flatMap((m) => m.blocks).flatMap((b) => b.canaries || []));
    const ownInput = at.get(`[[c:${r.step}.in]]`);
    if (store && ownInput !== undefined && lasts.has(r) && checkpointed.has(segmentOf.get(r.step))) {
      const storedBefore = new Set([...order.slice(0, ownInput + 1), ...Array.from({ length: n - 1 }, (_, k) => `[[c:${r.step}.r${k + 1}]]`)]);
      if (!heads.has(segmentOf.get(r.step))) {
        flags.push({ check: 6, step: r.step, request: r.id, message: `no head size was reported at segment ${segmentOf.get(r.step)}'s checkpoint` });
      } else {
        const from = headStart(store, r.step);
        const head = store.messages.slice(from, from + heads.get(segmentOf.get(r.step))).flatMap((m) => m.canaries.filter(conversational)).filter((c) => storedBefore.has(c));
        heldTo += head.length;
        const lost = head.filter((c) => !carried.has(c));
        if (lost.length) flags.push({ check: 6, step: r.step, request: r.id, message: `the head window's ${lost.join(' ')} isn't raw` });
      }
    }
    for (const t of before.get(r.step)) {
      const each = [`[[c:${t.id}.in]]`, ...t.replies.map((_, k) => `[[c:${t.id}.r${k + 1}]]`)];
      const wanted = each.filter((c) => held(c, t.id, r.step));
      if (store) for (const c of each) if (!wanted.includes(c) && !suppressedAt.has(c)) gone.add(c);
      heldTo += wanted.length;
      const missing = wanted.filter((c) => !carried.has(c));
      if (missing.length) flags.push({ check: 6, step: r.step, request: r.id, message: `the recent window lacks ${missing.join(' ')}` });
    }
    if (heldTo) judged++;
  }
  if (!store) return withJudged(flags, judged);
  let tailsGone = 0;
  const stepOf = new Map(script.map((s) => [s.id, s]));
  for (const { segment, request, n, composition } of lastRequests(records, script, log, agent)) {
    if (!request) continue;
    const size = composition?.tail?.messages;
    if (typeof size !== 'number') { flags.push({ check: 6, step: request.step, request: request.id, message: `no tail size was reported at segment ${segment}'s checkpoint` }); continue; }
    const step = stepOf.get(request.step);
    const earlier = (step?.replies ?? []).slice(0, Math.max(0, n - 1));
    const storedBefore = new Set([`[[c:${request.step}.in]]`, ...earlier.map((_, k) => `[[c:${request.step}.r${k + 1}]]`), ...earlier.flatMap((reply) => (reply.calls ?? []).map((c) => c.input?.canary))]);
    let at = -1;
    store.messages.forEach((m, i) => { if (m.canaries.some((c) => storedBefore.has(c))) at = i; });
    if (at < 0) { tailsGone++; continue; }
    judged++;
    const tail = store.messages.slice(Math.max(0, at - size + 1), at + 1).flatMap((m) => m.canaries.filter(conversational));
    const carried = new Set((request.messages || []).flatMap((m) => m.blocks).flatMap((b) => b.canaries || []));
    const lost = tail.filter((c) => !carried.has(c));
    if (lost.length) flags.push({ check: 6, step: request.step, request: request.id, message: `the reported tail's ${lost.join(' ')} isn't raw` });
  }
  const besides = [
    ...(gone.size ? [`${gone.size} recent message${gone.size === 1 ? '' : 's'} not asked for, as the final store doesn't hold ${gone.size === 1 ? 'it' : 'them'}`] : []),
    ...(tailsGone ? [`${tailsGone} checkpoint tail${tailsGone === 1 ? '' : 's'} not judged, as the final store doesn't hold ${tailsGone === 1 ? 'its' : 'their'} last input`] : []),
  ];
  return withJudged(flags, judged, besides.length ? besides.join('; ') : null);
}

// context-manager prunes older tool results by design, so only inputs and replies must stay.
const conversational = (c) => /\.(in|r\d+)\]\]$/.test(c);

export function coverage(records, store, script = [], log = [], { agent = FIXTURE_AGENT, side = 'primary' } = {}) {
  const own = ofSide(side);
  const sub = side !== 'primary';
  const counted = sub ? () => true : conversational;
  const flags = [];
  let judged = 0;
  let inputGone = 0;
  const segmentOf = new Map(script.map((s) => [s.id, s.segment]));
  const heads = headCounts(log, agent);
  const lasts = segmentLasts(records, script);
  const covers = new Map(store.summaries.filter((s) => s.number).map((s) => [s.number, s.covers]));
  const order = store.messages.flatMap((m) => m.canaries.filter(counted));
  const at = new Map(order.map((c, i) => [c, i]));
  const asked = new Map();
  for (const r of records) {
    if (!own(r)) continue;
    const n = (asked.get(r.step) ?? 0) + 1;
    asked.set(r.step, n - (['error', 'refused'].includes(r.answer?.shape) ? 1 : 0));
    const shown = [];
    const unknown = [];
    for (const m of r.messages || []) {
      for (const b of m.blocks) {
        shown.push(...(b.canaries || []).filter(counted));
        for (const s of b.summaries || []) {
          if (covers.has(s)) shown.push(...covers.get(s).filter(counted));
          else unknown.push(s);
        }
      }
    }
    const ownInput = sub ? Math.max(-1, ...shown.map((x) => at.get(x) ?? -1)) : at.get(`[[c:${r.step}.in]]`);
    if (ownInput === undefined || ownInput < 0) { inputGone++; continue; }
    judged++;
    for (const s of new Set(unknown)) flags.push({ check: 4, step: r.step, request: r.id, what: 'unmapped-summary', message: `summary ${s} is in the request, and no store read maps it` });
    const size = lasts.has(r) ? heads.get(segmentOf.get(r.step)) : undefined;
    const from = headStart(store, r.step);
    const head = size === undefined ? null : new Set(store.messages.slice(from, from + size).flatMap((m) => m.canaries));
    const boundary = store.messages.slice(0, from).flatMap((m) => m.canaries.filter(conversational)).length;
    const raw = (c, i) => (head ? (head.has(c) ? 'head' : 'rest') : i >= boundary ? 'from' : 'before');
    const summary = (i) => (head ? 'rest' : i >= boundary ? 'from' : 'before');
    const within = { head: 'its head window', rest: 'messages past its head window', from: "what was stored from its head's start on", before: "what was stored before its head's start" };
    const last = {};
    for (const m of r.messages || []) {
      for (const b of m.blocks) {
        const items = [
          ...(b.canaries || []).filter(counted).map((c) => [c, at.get(c)]).map(([c, i]) => [c, i, raw(c, i)]),
          ...(b.summaries || []).filter((x) => covers.has(x)).map((x) => [x, Math.min(...covers.get(x).filter(counted).map((c) => at.get(c) ?? Infinity))]).map(([x, i]) => [x, i, summary(i)]),
        ].filter(([, i]) => Number.isFinite(i));
        for (const item of items) {
          const before = last[item[2]];
          if (before && item[1] < before[1] && !flags.some((f) => f.request === r.id && /store order/.test(f.message))) {
            flags.push({ check: 4, step: r.step, request: r.id, what: 'store-order', message: `it carries ${item[0]} after ${before[0]}, out of store order${head || boundary > 0 ? ` within ${within[item[2]]}` : ''}` });
          }
          last[item[2]] = item;
        }
      }
    }
    const count = new Map();
    for (const c of shown) count.set(c, (count.get(c) ?? 0) + 1);
    const wanted = [...order.slice(0, ownInput + 1), ...(sub ? [] : Array.from({ length: n - 1 }, (_, k) => `[[c:${r.step}.r${k + 1}]]`))];
    const missing = wanted.filter((c) => !count.has(c));
    const twice = wanted.filter((c) => count.get(c) > 1);
    if (missing.length) flags.push({ check: 4, step: r.step, request: r.id, what: 'not-reached', ...cutMessage((cut, whole) => `${missing.length} stored message(s) reach the request neither raw nor in a summary: ${cut(missing, 5, ' ')}${!whole && missing.length > 5 ? ' …' : ''}`) });
    if (twice.length) flags.push({ check: 4, step: r.step, request: r.id, what: 'more-than-once', ...cutMessage((cut, whole) => `${twice.length} message(s) reach the request more than once: ${cut(twice, 5, ' ')}${!whole && twice.length > 5 ? ' …' : ''}`) });
  }
  return withJudged(flags, judged, inputGone ? `${inputGone} request${inputGone === 1 ? '' : 's'} not judged, as the final store doesn't hold ${inputGone === 1 ? 'its' : 'their'} own input` : null);
}

export function bookkeeping(records, store, { side = 'primary' } = {}) {
  const counted = side === 'sub' ? () => true : conversational;
  const flags = [];
  let judged = 0;
  let written = 0;
  let answersGone = 0;
  let sourcesUnknown = 0;
  const byNumber = new Map(store.summaries.filter((s) => s.number).map((s) => [s.number, s]));
  const byId = new Map(store.summaries.map((s) => [s.id, s]));
  const messages = new Map(store.messages.map((m) => [m.id, m]));
  for (const r of records) {
    const number = r.kind === 'summariser' ? r.answer?.summary : null;
    if (!number) continue;
    const s = byNumber.get(number);
    if (!s) { answersGone++; continue; }
    written++;
    const unread = s.sourceIds.filter((id) => !(s.sourceLevel === 0 ? messages.has(id) : byId.has(id)));
    if (unread.length) { flags.push({ check: 5, step: r.step, request: r.id, what: 'unread-source', ...cutMessage((cut) => `summary ${number} (${s.id}) has ${unread.length} source(s) the store read doesn't hold: ${cut(unread, 5)}`) }); continue; }
    const sentCanaries = new Set(r.sent?.canaries || []);
    const sentSummaries = new Set(r.sent?.summaries || []);
    const shown = (child, seen = new Set()) => {
      if (seen.has(child.id)) return 'unseen';
      seen.add(child.id);
      if (child.number && sentSummaries.has(child.number)) return 'shown';
      if (child.sourceLevel > 0 && child.sourceIds.length && child.sourceIds.every((id) => byId.has(id) && shown(byId.get(id), seen) === 'shown')) return 'shown';
      const covered = child.covers.filter(counted);
      if (!covered.length) return 'unknown';
      return covered.every((c) => sentCanaries.has(c)) ? 'shown' : 'unseen';
    };
    const unseen = [];
    let held = 0;
    for (const id of s.sourceIds) {
      if (s.sourceLevel === 0) {
        const own = messages.get(id).canaries.filter(counted);
        if (!own.length) { sourcesUnknown++; continue; }
        held++;
        if (own.some((c) => !sentCanaries.has(c))) unseen.push(id);
      } else {
        const seenAs = shown(byId.get(id));
        if (seenAs === 'unknown') { sourcesUnknown++; continue; }
        held++;
        if (seenAs === 'unseen') unseen.push(id);
      }
    }
    if (held) judged++;
    if (unseen.length) flags.push({ check: 5, step: r.step, request: r.id, ...cutMessage((cut) => `summary ${number} (${s.id}, L${s.level}) declares ${unseen.length} source(s) its request didn't show: ${cut(unseen, 5)}`) });
  }
  Object.defineProperty(flags, 'written', { value: written, enumerable: false });
  const besides = [
    ...(answersGone ? [`${answersGone} summariser answer${answersGone === 1 ? '' : 's'} not judged, as the final store doesn't hold ${answersGone === 1 ? 'its' : 'their'} summary`] : []),
    ...(sourcesUnknown ? [`${sourcesUnknown} source${sourcesUnknown === 1 ? '' : 's'} not judged, as nothing ${sourcesUnknown === 1 ? 'it covers' : 'they cover'} carries a canary to tell by`] : []),
  ];
  return withJudged(flags, judged, besides.length ? besides.join('; ') : null);
}

function multipliers(value, out = []) {
  if (!value || typeof value !== 'object') return out;
  if (value.calibration && typeof value.calibration.multiplier === 'number') out.push(value.calibration.multiplier);
  for (const v of Object.values(value)) multipliers(v, out);
  return out;
}

export function calibrationEdge(log = [], { low = 0.6, high = 1.8, adaptive = false } = {}) {
  const flags = [];
  let judged = 0;
  for (const e of log) {
    if (e.kind !== 'checkpoint' && e.kind !== 'health') continue;
    if (e.skipped) continue;
    const where = e.kind === 'health' ? 'the run\'s end' : `checkpoint ${e.name}`;
    const failed = e.health?.ok === false ? e.health.error || 'the panel read failed' : Object.entries(e.health?.data?.readFailures ?? {}).map(([agent, f]) => (f?.contextComposition ? `${agent}'s context composition: ${f.contextComposition}` : null)).filter(Boolean).join('; ');
    if (failed) flags.push({ check: 10, step: e.step ?? 'the run', what: 'unread-panel', message: `couldn't judge calibration at ${where}: the health panel's read failed (${failed})` });
    for (const m of multipliers(e.health)) {
      judged++;
      if (Math.abs(m - low) < 1e-9 || Math.abs(m - high) < 1e-9) flags.push({ check: 10, step: e.step ?? 'the run', what: 'clamp-edge', message: `calibration at the clamp edge (${m}) at ${where}: the run is invalid` });
    }
  }
  if (adaptive && log.some((e) => e.kind === 'end' && e.ok) && !log.some((e) => e.kind === 'health' && e.name === 'end')) {
    flags.push({ check: 10, step: 'the run', what: 'no-end-read', message: 'couldn\'t judge calibration at the run\'s end: the run completed and logged no end-of-run health read, read or skipped' });
  }
  return withJudged(flags, judged);
}

export function wellFormed(records) {
  const flags = [];
  let judged = 0;
  for (const r of records) {
    if (r.kind !== 'agent' && r.kind !== 'summariser') continue;
    judged++;
    const ms = r.messages || [];
    for (let i = 1; i < ms.length; i++) {
      if (ms[i].role === ms[i - 1].role) { flags.push({ check: 3, step: r.step, request: r.id, message: `messages ${i - 1} and ${i} are both ${ms[i].role}'s` }); break; }
    }
    for (let i = 0; i < ms.length; i++) {
      const calls = new Set(ms[i].blocks.filter((b) => b.type === 'tool_use').map((b) => b.toolUseId));
      const results = new Set(ms[i].blocks.filter((b) => b.type === 'tool_result').map((b) => b.toolUseId));
      const before = new Set((ms[i - 1]?.blocks || []).filter((b) => b.type === 'tool_use').map((b) => b.toolUseId));
      const after = new Set((ms[i + 1]?.blocks || []).filter((b) => b.type === 'tool_result').map((b) => b.toolUseId));
      for (const id of results) if (!before.has(id)) flags.push({ check: 3, step: r.step, request: r.id, message: `message ${i}'s result ${id} answers no call in the message before it` });
      if (i < ms.length - 1) for (const id of calls) if (!after.has(id)) flags.push({ check: 3, step: r.step, request: r.id, message: `message ${i}'s call ${id} has no result in the message after it` });
    }
  }
  return withJudged(flags, judged);
}
