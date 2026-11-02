import { assemblies, FIXTURE_AGENT } from './checks.mjs';
import { byStoreOrder, messageNames, spanName } from './names.mjs';

function namesAt(log, line) {
  const stores = new Map(), summaries = new Map();
  const batch = log.findIndex((e) => e.kind === 'compiles' && (e.lines ?? []).includes(line));
  for (const e of log.slice(0, batch + 1)) {
    if (e.kind !== 'compiles') continue;
    for (const [name, store] of Object.entries(e.store ?? {})) {
      if (!stores.has(name)) { stores.set(name, new Map()); summaries.set(name, new Map()); }
      for (const [id, canaries] of Array.isArray(store?.messages) ? store.messages : []) stores.get(name).set(String(id), canaries?.[0] ?? null);
      for (const id of store?.removedMessages ?? []) stores.get(name).delete(String(id));
      for (const s of Array.isArray(store?.summaries) ? store.summaries : []) summaries.get(name).set(String(s.id), s);
      for (const id of store?.removed ?? []) summaries.get(name).delete(String(id));
    }
  }
  const inOrder = (ids) => [...ids].sort(byStoreOrder);
  const named = new Map([...stores].map(([name, canaries]) => [name, messageNames(inOrder(canaries.keys()), (id) => canaries.get(id))]));
  const order = [line.agent, ...(line.slots ?? []), ...[...stores.keys()].filter((n) => n !== line.agent && !(line.slots ?? []).includes(n))];
  const messageName = (id) => {
    for (const name of order) if (stores.get(name)?.has(id)) return name === line.agent ? named.get(name)(id) : `${name}/${named.get(name)(id)}`;
    return null;
  };
  const summaryName = (id, level) => {
    const name = order.find((n) => summaries.get(n)?.has(id));
    if (!name) return `L${level}(-)`;
    const leaves = (sid, seen = new Set()) => {
      const s = summaries.get(name).get(sid);
      if (!s || seen.has(sid)) return [];
      seen.add(sid);
      return (s.sources ?? []).flatMap((src) => (s.sourceLevel > 0 ? leaves(String(src), seen) : [String(src)]));
    };
    const position = new Map(inOrder(stores.get(name).keys()).map((x, i) => [x, i]));
    const ids = leaves(id).filter((x) => position.has(x)).sort((a, b) => position.get(a) - position.get(b));
    const label = ids.length ? spanName(`L${summaries.get(name).get(id).level ?? level}`, named.get(name)(ids[0]), named.get(name)(ids.at(-1))) : `L${level}(-)`;
    return name === line.agent ? label : `${name}/${label}`;
  };
  return { messageName, summaryName };
}

// context-manager's layout of a compile (buildRenderedLayout): the view's members in order, and one unit per raw
// member (`p` where its body went out incomplete), per run under the same summaries, and per run left out.
function fates(layout) {
  if (!Array.isArray(layout?.memberIds) || !Array.isArray(layout?.units)) return null;
  const ids = layout.memberIds.map(String);
  const raw = [], incomplete = [], out = [], under = new Map();
  let at = 0;
  for (const u of layout.units) {
    if (u.k === 'r') (u.p ? incomplete : raw).push(ids[at++]);
    else {
      const run = ids.slice(at, at + u.n);
      at += u.n;
      if (u.k === 'o') out.push(...run);
      else for (const [id, level] of u.sm ?? []) under.set(id, { level, ids: [...(under.get(id)?.ids ?? []), ...run] });
    }
  }
  if (at !== ids.length) return null;
  const summarised = new Set([...under.values()].flatMap((s) => s.ids));
  return { ids, raw, incomplete, under, out, counts: { raw: raw.length + incomplete.length, summarised: summarised.size, out: out.length } };
}

export function ledgerOf(log, line) {
  const f = fates(line?.layout);
  if (!f) return [`- no ledger: the compile line carries no layout context-manager gave${line?.layout?.unreadable ? ` (${line.layout.unreadable})` : ''}`];
  const { messageName, summaryName } = namesAt(log, line);
  const position = new Map(f.ids.map((id, i) => [id, i]));
  const name = (id) => messageName(id) ?? `#${id}`;
  const spans = (ids) => {
    const runs = [];
    for (const id of ids) {
      const last = runs.at(-1);
      if (last && position.get(id) === position.get(last.to) + 1) { last.to = id; last.n++; } else runs.push({ from: id, to: id, n: 1 });
    }
    return runs.map((r) => (r.n === 1 ? name(r.from) : `${name(r.from)}–${name(r.to)} (${r.n})`)).join(', ') || 'none';
  };
  return [
    `- raw (${f.raw.length}): ${spans(f.raw)}`,
    ...(f.incomplete.length ? [`- raw, its body incomplete (${f.incomplete.length}): ${spans(f.incomplete)}`] : []),
    ...[...f.under].map(([id, s]) => `- in ${summaryName(id, s.level)} (${s.ids.length}): ${spans(s.ids)}`),
    `- left out (${f.out.length}): ${spans(f.out)}`,
  ];
}

export function moduleCounts(log, records, agent = FIXTURE_AGENT) {
  const agents = [...new Set(log.filter((e) => e.kind === 'compiles').flatMap((e) => (e.lines ?? []).filter((l) => l.kind === 'request').map((l) => l.agent)))];
  const asm = agents.flatMap((a) => assemblies(log, a));
  const made = asm.filter((l) => l.outcome === 'compiled');
  const summariser = records.filter((r) => r.kind === 'summariser');
  const quarantine = new Map();
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const [a, st] of Object.entries(e.store ?? {})) if (st && 'quarantine' in st) quarantine.set(a, st.quarantine);
  }
  const reported = [...quarantine.values()];
  const known = reported.every((q) => typeof q?.compression === 'number' && typeof q?.merge === 'number');
  const last = fates(assemblies(log, agent).filter((l) => l.outcome === 'compiled').at(-1)?.layout)?.counts;
  return {
    compiles: made.length,
    refused: asm.length - made.length,
    compressions: summariser.filter((r) => r.level === 1).length,
    merges: summariser.filter((r) => typeof r.level === 'number' && r.level > 1).length,
    ...(reported.length && known ? { quarantines: reported.reduce((n, q) => n + q.compression + q.merge, 0) } : {}),
    ...(last ? { raw: last.raw, summarised: last.summarised, out: last.out } : {}),
    invariantLines: log.filter((e) => e.kind === 'compiles').flatMap((e) => e.lines ?? []).filter((l) => (l.violations ?? []).length > 0).length,
  };
}
