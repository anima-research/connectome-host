import { existsSync, readFileSync } from 'node:fs';
import { bindingControl, budgets, compileInvariants, compilingAgents, ofSide, pairing, withJudged, reloads, declaredProducts, everyTurnAnswers, wellFormed, windowsRaw, coverage, bookkeeping, calibrationEdge, FIXTURE_AGENT, STREAM_BOUND } from './checks.mjs';
import { messageNames, spanName } from './names.mjs';

export function runChecks({ records, log, script, products, store, agent = FIXTURE_AGENT, side = agent === FIXTURE_AGENT ? 'primary' : 'sub', streamBound = STREAM_BOUND, windowTokens, binds = false, adaptive = false }) {
  const own = ofSide(side);
  const budget = budgets(records, script, log, { agent, streamBound, windowTokens });
  const ownRequests = records.filter(own).length;
  const laterTurns = new Set(script.filter((st) => Array.isArray(st.replies) && st.replies.length).slice(1).map((st) => st.id));
  const turnRequests = records.filter((r) => own(r) && laterTurns.has(r.step)).length;
  const missing = declaredProducts(records, script, products, store);
  const declared = Object.values(products ?? {}).flat().length;
  const sharing = compilingAgents(log).filter((a) => a !== FIXTURE_AGENT);
  const parts = [
    { check: 1, name: 'every turn answers', flags: everyTurnAnswers(records, log, script) },
    { check: 2, name: 'declared products', flags: [], judged: missing.judged, applies: declared > 0 ? `the run declares ${declared} product(s)` : null },
    { check: 3, name: 'request shape', flags: wellFormed(records) },
    { check: 3, name: 'budgets', flags: budget.flags, judged: budget.judged, applies: budget.requests > 0 ? `the run's agent made ${budget.requests} request(s)` : null },
    ...(store ? [{ check: 4, name: 'coverage', flags: coverage(records, store, script, log, { agent, side }), applies: ownRequests > 0 ? `a store was read and the run's agent made ${ownRequests} request(s)` : null }] : []),
    ...(store ? [(() => { const flags = bookkeeping(records, store, { side }); return { check: 5, name: 'bookkeeping', flags, applies: flags.written > 0 ? `the store holds ${flags.written} summar${flags.written === 1 ? 'y' : 'ies'} a summariser request wrote` : null }; })()] : []),
    { check: 6, name: 'windows raw', flags: windowsRaw(records, script, log, store, { agent, side }), applies: side === 'primary' && turnRequests > 0 ? `the run's agent made ${turnRequests} request(s) at a scripted turn after the first` : null },
    { check: 10, name: 'calibration edge', flags: calibrationEdge(log, { adaptive }), applies: adaptive && log.some((e) => (e.kind === 'checkpoint' || e.kind === 'health') && Object.keys(e.health?.data?.contextComposition ?? {}).length) ? 'an adaptive configuration\'s health panel reported its context composition' : null },
    { check: 11, name: 'compile invariants', flags: compileInvariants(log), applies: budget.requests > 0 ? 'the run\'s agent made requests' : null },
    { check: 12, name: 'reloads', flags: reloads(log), applies: script.some((s) => s.reloadCheck) ? 'the script restarts with a reload check' : null },
    ...[...new Set([...(budget.requests > 0 ? [agent] : []), ...compilingAgents(log)])].map((a) => ({
      check: 13, name: `pairing ${a}`,
      flags: a !== FIXTURE_AGENT && sharing.length > 1
        ? withJudged([{ check: 13, step: 'the run', what: `${a}:shared-side`, message: `couldn't judge ${a}'s pairing: ${sharing.join(' and ')} compile requests, and the stand-in tells only the configuration's own agent's requests from the rest` }], null)
        : pairing(records, log, a),
      applies: a === agent && budget.requests > 0 ? `${a} made ${budget.requests} request(s)` : `${a} compiled requests`,
    })),
    ...(binds ? [{ check: 15, name: 'binding control', flags: bindingControl(records), applies: 'the configuration\'s model binds thinking' }] : []),
  ];
  const judged = parts.map((p) => ({ check: p.check, name: p.name, judged: p.judged ?? p.flags.judged ?? null, ...(p.flags.besides ? { besides: p.flags.besides } : {}) }));
  const unjudged = parts.filter((p) => p.applies && (p.judged ?? p.flags.judged) === 0).map((p) => ({
    check: p.check, step: 'the run', what: `judged-none:${p.name}`,
    message: `couldn't judge: check ${p.check} (${p.name}) judged nothing, though it applies (${p.applies})`,
  }));
  const flags = [...parts.flatMap((p) => p.flags), ...unjudged];
  const unmarked = (store?.summaries ?? []).filter((s) => !s.number).map(summaryNamer(store));
  const notes = [...budget.notes, ...(unmarked.length ? [`check 5 doesn't judge ${unmarked.length} stored summar${unmarked.length === 1 ? 'y' : 'ies'} with no stand-in mark, which context-manager wrote without a summariser request: ${unmarked.slice(0, 5).join(', ')}`] : [])];
  return { flags, missing, headroom: budget.headroom, notes, judged };
}

const key = (f) => `${f.check}|${f.step}|${f.what ?? ''}`;

const META = new Set('.*+?()[]{}|^$');
function literal(match) {
  if (!match.startsWith('^') || !match.endsWith('$')) return false;
  const body = match.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') { i++; if (i >= body.length || !(META.has(body[i]) || body[i] === '\\')) return false; continue; }
    if (META.has(body[i])) return false;
  }
  return true;
}

export function readExpected(path, names) {
  if (!existsSync(path)) return [];
  const entries = JSON.parse(readFileSync(path, 'utf-8'));
  if (!Array.isArray(entries)) throw new Error(`${path} isn't a list of entries`);
  const byKey = new Map();
  entries.forEach((e, i) => {
    const bad = (why) => { throw new Error(`${path} entry ${i}: ${why}`); };
    if (!e || typeof e !== 'object') bad('isn\'t an object');
    for (const field of ['configuration', 'step', 'finding', 'reason']) if (typeof e[field] !== 'string' || !e[field]) bad(`has no ${field}`);
    if (!Number.isInteger(e.check)) bad('has no check number');
    if (typeof e.what !== 'string' || !e.what) bad('has no what: an entry covers one kind of flag, so its check\'s flags must name their kind');
    if (typeof e.match !== 'string' || !e.match) bad('has no match: an entry covers the flags whose whole detail (their message, where they have none) its match names, escaped and anchored');
    if (!literal(e.match)) bad('has a match that isn\'t an escaped literal between ^ and $, so it could cover flags other than the one it names');
    if (!names.includes(e.configuration)) bad(`names a configuration this run has none of: ${e.configuration}`);
    const k = `${e.configuration}|${key(e)}`;
    const others = byKey.get(k) ?? [];
    if (others.some((o) => o.match === e.match)) bad(`repeats another entry's configuration, check, step, what and match`);
    byKey.set(k, [...others, e]);
  });
  return entries;
}

export function perCheckReport({ configuration, candidate, expected = [] }) {
  const invalid = candidate.flags.filter((f) => f.check === 10 && f.what === 'clamp-edge');
  const entries = expected.filter((e) => e.configuration === configuration.name).map((e) => ({ e, re: new RegExp(e.match) }));
  const coverOf = (f) => entries.filter(({ e, re }) => key(e) === key(f) && re.test(f.detail ?? f.message ?? ''));
  const counted = candidate.flags.filter((f) => !invalid.includes(f));
  const covered = [];
  const flags = [];
  const met = new Set();
  for (const f of counted) {
    const by = coverOf(f);
    if (!by.length) { flags.push(f); continue; }
    if (by.length > 1) flags.push({ check: f.check, step: f.step, what: f.what, message: `expected-failures.json's entries for ${by.map((x) => x.e.finding).join(' and ')} both cover this flag, so neither can tell whether its own finding still shows: give them matches that don't overlap (${f.detail ?? f.message})` });
    covered.push({ f, finding: [...new Set(by.map((x) => x.e.finding))].join('; ') });
    for (const x of by) met.add(x);
  }
  for (const x of entries) {
    const { e } = x;
    if (!met.has(x)) flags.push({ check: e.check, step: e.step, what: e.what, message: `expected-failures.json expects a flag here for ${e.finding} matching /${e.match}/, and the run raised none: if ${e.finding} is fixed, the change that fixed it removes the entry` });
  }
  const missing = candidate.missing.flatMap((m) => m.missing.map((name) => ({ segment: m.segment, name })));
  const verdict = invalid.length ? 'invalid' : flags.length || missing.length ? 'flags' : 'pass';
  const lines = [];
  if (invalid.length) lines.push(`INVALID: ${invalid[0].message}${invalid.length > 1 ? ` (and ${invalid.length - 1} more)` : ''}. Its folds are clamped folds, not a store's.`);
  const findings = [...new Set(covered.map((c) => c.finding))];
  lines.push(`${configuration.name}: ${verdict === 'pass' ? 'no flags' : `${flags.length} flag(s), ${missing.length} missing product(s)`}${covered.length ? `, ${covered.length} expected (${findings.join(', ')})` : ''}.`);
  for (const f of flags) lines.push(`- check ${f.check} at ${f.step}${f.request ? ` (${f.request})` : ''}: ${f.message}`);
  for (const { f, finding } of covered) lines.push(`- check ${f.check} at ${f.step}${f.request ? ` (${f.request})` : ''}: ${f.message} [expected: ${finding}]`);
  for (const m of missing) lines.push(`- check 2, ${m.segment}: missing ${m.name}`);
  for (const n of candidate.notes ?? []) lines.push(`- ${n}`);
  if (candidate.judged?.length) lines.push(`- judged: ${candidate.judged.map((j) => `check ${j.check} ${j.name} ${j.judged ?? '?'}${j.besides ? ` (${j.besides})` : ''}`).join(', ')}`);
  if (candidate.headroom?.length) lines.push(`- budget headroom, each segment's least: ${candidate.headroom.map((h) => `${h.segment} ${h.bound - h.tokens} of ${h.bound}${h.kind === 'continuation' ? ' (a stream\'s fresh input through a continuation round, against the stream bound)' : ' (a compiled request\'s whole input, against the model\'s window)'}`).join(', ')}`);
  return { verdict, lines, invalid, flags, expected: covered.map((c) => c.f), missing };
}

export function workloadReport({ id, workload, owns = [], judged, breaches, completed, expected = [] }) {
  const isOwned = (f) => owns.some((o) => o.check === f.check && (o.what === undefined || o.what === f.what));
  const judgedFlags = judged.flags.filter((f) => !isOwned(f));
  const owned = judged.flags.length - judgedFlags.length;
  const flags = [...judgedFlags, ...breaches.map((b) => ({ check: 14, step: b.step ?? 'the run', ...(b.what ? { what: b.what } : {}), message: `${workload}'s property: ${b.message}` }))];
  const by = breaches.judgedBy;
  const byCounts = (judged.judged ?? []).filter((j) => j.check === by && typeof j.judged === 'number');
  const count = typeof breaches.judged === 'number' ? breaches.judged : byCounts.length ? byCounts.reduce((n, j) => n + j.judged, 0) : null;
  const counts = [...(judged.judged ?? []), ...(count === null ? [] : [{ check: 14, name: 'property', judged: count, ...(by !== undefined ? { besides: `judged by check ${by}` } : breaches.besides ? { besides: breaches.besides } : {}) }])];
  if (completed && !breaches.length && !(count > 0)) {
    const why = by !== undefined ? `is judged by check ${by}, which ${count === null ? 'gave no count' : 'judged nothing'}` : count === null ? 'gave no judged count and names no check that judges it' : 'judged nothing';
    flags.push({ check: 14, step: 'the run', what: 'judged-none:property', message: `couldn't judge: ${workload}'s property ${why}, though the run completed` });
  }
  const notes = [...(judged.notes ?? []), ...(owned ? [`${owned} flag(s) are ${workload}'s by design, judged by its property (runOf owns)`] : [])];
  return perCheckReport({ configuration: { name: id }, candidate: { flags, missing: judged.missing ?? [], notes, headroom: judged.headroom, judged: counts }, expected });
}

export function summaryNamer(store) {
  const canary = new Map((store?.messages ?? []).map((m) => [String(m.id), m.nameCanary]));
  const nameOf = messageNames((store?.messages ?? []).map((m) => m.id), (id) => canary.get(String(id)));
  const sums = new Map((store?.summaries ?? []).map((s) => [s.id, s]));
  const leaves = (s, seen = new Set()) => {
    if (!s || seen.has(s.id)) return [];
    seen.add(s.id);
    return s.sourceLevel === 0 ? s.sourceIds : s.sourceIds.flatMap((id) => leaves(sums.get(id), seen));
  };
  return (s) => {
    const ids = leaves(s);
    return ids.length ? spanName(`L${s.level}`, nameOf(ids[0]) ?? `#${ids[0]}`, nameOf(ids.at(-1)) ?? `#${ids.at(-1)}`) : `L${s.level}(-)`;
  };
}
