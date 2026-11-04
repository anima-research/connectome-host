import { createHash } from 'node:crypto';
import { namingCanaries, messageNames, shortCanary, spanName } from './names.mjs';
import { CANARY } from './standin.mjs';
import { cutError, cutText } from './cut.mjs';

export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJSON(v))).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`no JSON for ${value}`);
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error(`no JSON for a ${typeof value}`);
  }
  return JSON.stringify(value);
}

export const digest = (value) => createHash('sha256').update(canonicalJSON(value)).digest('hex').slice(0, 16);

export function sourceStrings(sources, name = (id) => id) {
  if (!sources || typeof sources !== 'object') return ['o'];
  if (sources.kind === 'raw') {
    return sources.bodies.map((b) => (b.complete ? `r:${name(String(b.messageId))}` : `r:${name(String(b.messageId))}!${(b.missing ?? ['unknown']).join('+')}`));
  }
  if (sources.kind === 'summary') return sources.summaries.map((s) => `s:${s.id}@${s.level}${s.partial ? '~' : ''}`);
  if (sources.kind === 'injection') return [`i:${sources.namespace}`];
  return ['o'];
}

export function normalizeMessage(message) {
  const { cacheBreakpoint, ...rest } = message;
  const blockMarkers = [];
  const content = (Array.isArray(rest.content) ? rest.content : []).map((block, i) => {
    if (!block || typeof block !== 'object') return block;
    const { cache_control: cc, ...b } = block;
    if (cc !== undefined) blockMarkers.push([i, cc]);
    if (b.type === 'image' && b.source && typeof b.source.data === 'string') {
      return { ...b, source: { ...b.source, data: undefined, sha256: createHash('sha256').update(b.source.data).digest('hex') } };
    }
    return b;
  });
  const marker = cacheBreakpoint === undefined && blockMarkers.length === 0 ? null : { message: cacheBreakpoint ?? null, blocks: blockMarkers };
  return { message: { ...rest, content }, marker };
}

export function readable(read) {
  try {
    if (typeof read !== 'function') return { unreadable: 'no such reader' };
    const value = read();
    return value === undefined ? { unreadable: 'returned undefined' } : value;
  } catch (err) {
    const { shown, full } = cutError(err, 200);
    return { unreadable: shown, ...(full ? { full } : {}) };
  }
}

const detailOf = (write) => {
  const { shown, full } = cutText(write);
  return { detail: shown, ...(full ? { full } : {}) };
};

export const isUnreadable = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.unreadable === 'string' && Object.keys(v).every((k) => k === 'unreadable' || k === 'full');

export function readSummaries(manager, name = (id) => String(id)) {
  const listed = readable(() => manager.getSummariesInRange({}));
  if (isUnreadable(listed)) return listed;
  const out = new Map();
  for (const t of listed) {
    const s = readable(() => manager.getSummary(t.id));
    if (isUnreadable(s) || s === null) return { unreadable: `getSummary(${t.id}) ${isUnreadable(s) ? s.unreadable : 'is null though listed'}` };
    out.set(String(s.id), { id: String(s.id), level: s.level, sourceLevel: s.sourceLevel, sources: (s.sourceIds ?? []).map((x) => (s.sourceLevel === 0 ? name(x) : String(x))), parent: s.parentId ?? null, tokens: s.tokens, content: s.content });
  }
  return out;
}

// agent-framework's Subconscious reader merges the residents' shared slot into its view read-only, so its compiles
// send messages its own slot doesn't hold; a view member is read from the registered agent whose slot holds it.
function readCompile(manager, compiled, messages, elsewhere) {
  const own = readable(() => manager.getAllMessages());
  if (isUnreadable(own)) return own;
  const ownIds = new Set(own.map((m) => String(m.id)));
  const layout = compiled?.provenance?.layout;
  const sentIds = messages.flatMap((m) => m.sources).filter((s) => s.startsWith('r:')).map((s) => s.slice(2).split('!')[0]);
  const members = [...new Set([...(layout?.memberIds ?? []).map(String), ...sentIds])].filter((id) => !ownIds.has(id));
  const { found = [], unfound = members, nameOf: foundName = () => null } = members.length && elsewhere ? elsewhere(members) : {};
  const stored = [...own, ...found];
  let ownName = null;
  const nameOf = (id) => {
    if (!ownName) {
      const byId = new Map(own.map((m) => [String(m.id), m]));
      ownName = messageNames([...byId.keys()], (x) => namingCanaries(byId.get(x).content)[0]);
    }
    return ownName(id) ?? foundName(String(id)) ?? String(id);
  };
  const laidOut = Array.isArray(layout?.memberIds) && Array.isArray(layout?.units);
  const unfoundText = unfound.length ? cutText((cut) => `view members no registered agent's slot holds: ${cut(unfound, 8)}`) : null;
  const failed = [
    ...(laidOut ? [] : ['the compile gave no layout, so its view\'s members beyond its own slot weren\'t read']),
    ...(unfoundText ? [unfoundText.shown] : []),
  ];
  const wholeOf = new Map(unfoundText?.full ? [[unfoundText.shown, unfoundText.full]] : []);
  const layoutRaw = new Set();
  if (laidOut) {
    let at = 0;
    for (const u of layout.units) {
      if (u.k === 'r') layoutRaw.add(String(layout.memberIds[at++]));
      else at += u.n ?? 0;
    }
  }
  const inOrder = [...stored].sort((a, b) => a.sequence - b.sequence);
  const bodyOf = new Map();
  const membersOf = new Map();
  // context-manager's bodies (body-runs.ts continuesBody): a group id names its content, so two
  // ingestions of one text share it, and a message continues the body before it only with the same
  // group id at a higher shard index.
  let key = null;
  inOrder.forEach((m, i) => {
    const prev = inOrder[i - 1];
    const continues = !!prev?.bodyGroupId && prev.bodyGroupId === m.bodyGroupId && (m.shardIndex ?? 0) > (prev.shardIndex ?? 0);
    if (!continues) key = String(m.id);
    bodyOf.set(String(m.id), key);
    membersOf.set(key, [...(membersOf.get(key) ?? []), m]);
  });
  const sequenceOf = new Map(stored.map((m) => [String(m.id), m.sequence]));
  const expanded = new Map();
  const leaves = (summaryId) => {
    if (expanded.has(summaryId)) return expanded.get(summaryId);
    expanded.set(summaryId, []);
    const s = readable(() => manager.getSummary(summaryId));
    if (isUnreadable(s) || s === null) {
      failed.push(`getSummary(${summaryId}): ${isUnreadable(s) ? s.unreadable : 'no such summary'}`);
      return [];
    }
    const out2 = [];
    if (s) for (const src of s.sourceIds ?? []) out2.push(...(s.sourceLevel === 0 ? [String(src)] : leaves(String(src))));
    const set = [...new Set(out2)];
    expanded.set(summaryId, set);
    return set;
  };
  const blocks = (m) => (Array.isArray(m?.content) ? m.content : []);
  const textOf = (m) => blocks(m).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
  const sent = compiled.messages ?? [];

  // A summary counts once however many messages carry it: the host sends a recalled memory as a question and its answer.
  const raw = new Map(), summariesSent = new Set();
  messages.forEach((m, i) => {
    for (const s of m.sources) {
      if (s.startsWith('r:')) {
        const [id, missing] = s.slice(2).split('!');
        const body = bodyOf.get(id) ?? id;
        const copy = raw.get(body) ?? { everyShard: false, text: '', parts: [] };
        const part = { i, from: copy.text.length, to: copy.text.length + textOf(sent[i]).length };
        raw.set(body, { everyShard: copy.everyShard || !(missing ?? '').split('+').includes('shards'), text: copy.text + textOf(sent[i]), parts: [...copy.parts, part] });
      } else if (s.startsWith('s:')) summariesSent.add(s.slice(2).split('@')[0]);
    }
  });
  const bySummary = new Map();
  for (const id of summariesSent) for (const leaf of leaves(id)) bySummary.set(leaf, [...(bySummary.get(leaf) ?? []), id]);
  // A raw copy of a body holds a shard when it carries every shard (context-manager marks one that
  // doesn't `!shards`; `!content` alone is every shard, altered), or when it carries that shard's text
  // (a shard with no text, by any raw copy of its body), among the shards context-manager's layout names raw.
  const partlyHeld = new Set();
  const carriedIn = new Map();
  const rawStart = new Map();
  for (const [body, copy] of raw) {
    const shards = [...(membersOf.get(body) ?? [])].sort((x, y) => (x.shardIndex ?? 0) - (y.shardIndex ?? 0));
    const named = shards.filter((m) => layoutRaw.has(String(m.id)));
    const walk = named.length ? named : shards;
    rawStart.set(body, Math.min(...walk.map((m) => m.sequence)));
    for (const m of walk) if (textOf(m).length === 0) partlyHeld.add(String(m.id));
    const taken = [];
    for (let more = true; more;) {
      more = false;
      for (const m of walk) {
        const text = textOf(m);
        if (text.length === 0) continue;
        let at = copy.text.indexOf(text);
        while (at >= 0 && taken.some(([from, to]) => at < to && at + text.length > from)) at = copy.text.indexOf(text, at + 1);
        if (at < 0) continue;
        more = true;
        taken.push([at, at + text.length]);
        partlyHeld.add(String(m.id));
        const part = copy.parts.find((p) => p.from <= at && at < p.to);
        if (part) carriedIn.set(`${part.i}:${body}`, Math.min(carriedIn.get(`${part.i}:${body}`) ?? Infinity, m.sequence));
      }
    }
  }
  const held = (body, m) => {
    const copy = raw.get(body);
    return !!copy && (copy.everyShard || partlyHeld.has(String(m.id)));
  };
  return { stored, inOrder, bodyOf, membersOf, sequenceOf, leaves, blocks, textOf, sent, raw, bySummary, held, failed, wholeOf, carriedIn, rawStart, nameOf };
}

export function checkCompile(manager, budget, compiled, messages, { compresses = true, elsewhere } = {}) {
  const out = [];
  const read = readCompile(manager, compiled, messages, elsewhere);
  if (isUnreadable(read)) return [{ invariant: 'unreadable', detail: `getAllMessages: ${read.unreadable}; no invariant was judged` }];
  const { stored, inOrder, bodyOf, membersOf, sequenceOf, leaves, blocks, textOf, sent, raw, bySummary, held, failed, wholeOf, carriedIn, rawStart, nameOf } = read;
  const bySequence = new Map(stored.map((m) => [m.sequence, String(m.id)]));
  const summaryNames = new Map();
  const summaryName = (id) => {
    if (!summaryNames.has(id)) {
      const s = readable(() => manager.getSummary(id));
      const ids = leaves(id).filter((b) => sequenceOf.has(b)).sort((a, b) => sequenceOf.get(a) - sequenceOf.get(b));
      summaryNames.set(id, isUnreadable(s) || !s || !ids.length ? id : spanName(`L${s.level}`, nameOf(ids[0]), nameOf(ids.at(-1))));
    }
    return summaryNames.get(id);
  };
  const storedAt = new Map(stored.map((m) => [String(m.id), m]));
  const blockAt = (key) => {
    const cut = key.lastIndexOf('#');
    const m = storedAt.get(key.slice(0, cut));
    return [m, Number(key.slice(cut + 1))];
  };
  const callAt = (key) => {
    const [m, k] = blockAt(key);
    const canary = JSON.stringify(blocks(m)[k]?.input ?? '').match(CANARY)?.[0];
    return canary ? shortCanary(canary) : `${nameOf(m.id)} call ${blocks(m).slice(0, k + 1).filter((b) => b?.type === 'tool_use').length}`;
  };
  const callName = (toolUseId) => {
    for (const m of inOrder) {
      const at = blocks(m).filter((b) => b?.type === 'tool_use').findIndex((b) => b.id === toolUseId);
      if (at < 0) continue;
      const canary = JSON.stringify(blocks(m).filter((b) => b?.type === 'tool_use')[at].input ?? '').match(CANARY)?.[0];
      return canary ? shortCanary(canary) : `${nameOf(m.id)} call ${at + 1}`;
    }
    for (const m of inOrder) {
      const at = blocks(m).filter((b) => b?.type === 'tool_result').findIndex((b) => b.toolUseId === toolUseId);
      if (at >= 0) return `${nameOf(m.id)} result ${at + 1}`;
    }
    return toolUseId;
  };
  if (isUnreadable(compresses)) out.push({ invariant: 'unreadable', detail: `getStrategy: ${compresses.unreadable}; coverage wasn't judged` });
  const compressing = compresses === true;
  const summaryUnread = failed.some((f) => f.startsWith('getSummary('));
  const uncovered = [], twice = [], beside = [];
  for (const [body, members] of summaryUnread ? [] : membersOf) {
    const lost = compressing ? members.filter((m) => !bySummary.has(String(m.id)) && !held(body, m)) : [];
    if (lost.length === members.length) uncovered.push(nameOf(body));
    else if (lost.length) uncovered.push(`${nameOf(body)} (shards ${lost.map((m) => nameOf(m.id)).join(', ')})`);
    for (const m of members) {
      const under = bySummary.get(String(m.id)) ?? [];
      if (under.length > 1) twice.push(`${nameOf(m.id)} in ${under.map(summaryName).join(', ')}`);
      if (under.length === 0 || !held(body, m)) continue;
      beside.push(`${nameOf(m.id)} raw beside ${under.map(summaryName).join(', ')}`);
    }
  }
  if (uncovered.length) out.push({ invariant: 'coverage', ...detailOf((cut) => `${uncovered.length} stored bodies in no message sent: ${cut(uncovered, 8)}`) });
  if (twice.length) out.push({ invariant: 'coverage', ...detailOf((cut) => `${twice.length} stored messages under two summaries sent: ${cut(twice, 4, '; ')}`) });
  if (beside.length) out.push({ invariant: 'beside-sources', ...detailOf((cut) => `${beside.length} stored messages sent raw beside a summary of them: ${cut(beside, 4, '; ')}`) });

  const unplaced = [];
  const firstCarried = (i, head) => {
    const body = bodyOf.get(head) ?? head;
    const carried = carriedIn.get(`${i}:${body}`);
    if (carried !== undefined) return carried;
    const copy = raw.get(body);
    const spread = new Set(copy.parts.map((p) => p.i)).size;
    const start = rawStart.get(body);
    if (start !== Infinity && spread === 1 && copy.everyShard) return start;
    unplaced.push(start === Infinity
      ? `message ${i}'s copy of ${head}, which no slot read holds`
      : `message ${i}'s copy of ${nameOf(body)}, which holds none of its shards' text, where ${spread > 1 ? `the body goes out in ${spread} messages` : 'the copy doesn\'t carry every shard'}`);
    return Infinity;
  };
  // After a head-window reset context-manager starts the head at the newest topic transition message (a 'Context
  // Manager' message opening "[Topic Transition]") and sends it first, then the history from before it.
  const transitions = inOrder.filter((x) => x.participant === 'Context Manager' && blocks(x).some((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.startsWith('[Topic Transition]')));
  const headStart = transitions.length ? transitions.at(-1).sequence : null;
  let inHead = false;
  let last = -Infinity, lastAt = -1;
  messages.forEach((m, i) => {
    if (summaryUnread) return;
    let first = Infinity;
    for (const s of m.sources) {
      if (s.startsWith('r:')) {
        const [head, missing] = s.slice(2).split('!');
        first = Math.min(first, firstCarried(i, head));
      }
      else if (s.startsWith('s:')) {
        const id = s.slice(2).split('@')[0];
        const at = leaves(id).filter((b) => sequenceOf.has(b)).map((b) => sequenceOf.get(b));
        if (at.length) first = Math.min(first, ...at);
        else unplaced.push(`message ${i}'s summary ${id}, none of whose messages a slot read holds`);
      }
    }
    if (first === Infinity) return;
    if (lastAt === -1 && first === headStart) inHead = true;
    if (inHead && first < headStart) { inHead = false; last = -Infinity; }
    if (first < last) out.push({ invariant: 'coverage', detail: `message ${i} covers from ${nameOf(bySequence.get(first))}, before message ${lastAt}'s ${nameOf(bySequence.get(last))}` });
    if (first >= last) { last = first; lastAt = i; }
  });
  if (unplaced.length) out.push({ invariant: 'unplaced', count: unplaced.length, detail: `store order couldn't place ${unplaced.length} of what was sent, so it judged the order without ${unplaced.length === 1 ? 'it' : 'them'}: ${unplaced.join('; ')}` });

  // context-manager's grace is 0.02 when `overBudgetGraceRatio` is unset. The count is the compile's own
  // `renderStats`, a dry compile's included: `getRenderStats()` is the manager's last live compile's, which in a host
  // another compile of the same manager can replace before this line is written. context-manager gives render stats
  // only for a strategy with `getRenderStats` (isRenderStatsCapable).
  const unjudged = [];
  const configured = readable(() => manager.getStrategy().config ?? {});
  if (isUnreadable(configured)) out.push({ invariant: 'unreadable', detail: `getStrategy: ${configured.unreadable}; budget wasn't judged` });
  const config = isUnreadable(configured) ? {} : configured;
  const tokens = !isUnreadable(configured) && compiled?.renderStats?.total?.tokens;
  if (!isUnreadable(configured) && typeof tokens !== 'number') {
    const strategy = readable(() => manager.getStrategy());
    if (isUnreadable(strategy)) out.push({ invariant: 'unreadable', detail: `getStrategy: ${strategy.unreadable}; budget wasn't judged` });
    else if (typeof strategy?.getRenderStats === 'function') out.push({ invariant: 'unreadable', detail: `the compile gave no render stats, though its strategy ${strategy.constructor?.name || 'unnamed'} reports them; budget wasn't judged` });
    else unjudged.push(`budget: ${strategy?.constructor?.name || 'an unnamed strategy'} gives no render stats`);
  }
  const input = budget.maxTokens - (budget.reserveForResponse ?? 0);
  const grace = Math.max(0, config.overBudgetGraceRatio ?? 0.02);
  if (config.enforceBudget !== false && typeof tokens === 'number' && tokens > Math.floor(input * (1 + grace))) {
    out.push({ invariant: 'budget', detail: `${tokens} tokens against an input budget of ${input} and a grace of ${grace}` });
  }

  // A passthrough strategy sends every message from its window's start as stored, so a pair the store holds apart goes
  // out apart: it only promises not to open with a result whose call lies before the request's start, and not to leave
  // out a message of a pair inside the request's own span.
  const callOf = new Map(), answered = new Map(), lastCall = new Map();
  for (const m of inOrder) {
    blocks(m).forEach((b, k) => {
      if (b?.type === 'tool_use') lastCall.set(b.id, `${m.id}#${k}`);
      else if (b?.type === 'tool_result' && lastCall.has(b.toolUseId)) {
        callOf.set(`${m.id}#${k}`, lastCall.get(b.toolUseId));
        answered.set(lastCall.get(b.toolUseId), `${m.id}#${k}`);
      }
    });
  }
  const storedKeys = (i, type, id) => (messages[i]?.sources ?? []).filter((s) => s.startsWith('r:')).flatMap((s) => {
    const head = s.slice(2).split('!')[0];
    return (membersOf.get(bodyOf.get(head) ?? head) ?? []).flatMap((m) => blocks(m).flatMap((b, k) =>
      b?.type === type && (type === 'tool_use' ? b.id : b.toolUseId) === id ? [`${m.id}#${k}`] : []));
  });
  const carried = new Set(messages.flatMap((m) => m.sources).filter((s) => s.startsWith('r:'))
    .flatMap((s) => { const head = s.slice(2).split('!')[0]; return (membersOf.get(bodyOf.get(head) ?? head) ?? []).map((m) => String(m.id)); }));
  const carriedSequences = [...carried].map((id) => sequenceOf.get(id)).filter((n) => typeof n === 'number');
  const spanStart = Math.min(...carriedSequences), spanEnd = Math.max(...carriedSequences);
  const messageOf = (key) => key.slice(0, key.lastIndexOf('#'));
  const leftOut = (key) => {
    const at = sequenceOf.get(messageOf(key));
    return typeof at === 'number' && at >= spanStart && at <= spanEnd && !carried.has(messageOf(key));
  };
  const beforeStart = (key) => (sequenceOf.get(messageOf(key)) ?? Infinity) < spanStart;
  sent.forEach((m, i) => {
    blocks(m).forEach((b, j) => {
      if (b?.type === 'tool_result' && ![...blocks(sent[i - 1]), ...blocks(m).slice(0, j)].some((c) => c?.type === 'tool_use' && c.id === b.toolUseId)) {
        const keys = storedKeys(i, 'tool_result', b.toolUseId);
        const parted = compressing
          ? keys.some((key) => callOf.has(key))
          : keys.some((key) => callOf.has(key) && (leftOut(callOf.get(key)) || (i === 0 && beforeStart(callOf.get(key)))));
        if (keys.length === 0 || parted) {
          const callKey = keys.map((key) => callOf.get(key)).find(Boolean);
          const named = callKey ? callAt(callKey) : callName(b.toolUseId);
          out.push({ invariant: 'shape', detail: `message ${i}: result ${named} answers no call in the message before it` });
        }
      }
      if (b?.type === 'tool_use' && i < sent.length - 1 && ![...blocks(m).slice(j + 1), ...blocks(sent[i + 1])].some((c) => c?.type === 'tool_result' && c.toolUseId === b.id)) {
        const keys = storedKeys(i, 'tool_use', b.id);
        const parted = compressing ? keys.some((key) => answered.has(key)) : keys.some((key) => answered.has(key) && leftOut(answered.get(key)));
        if (keys.length === 0 || parted) {
          out.push({ invariant: 'shape', detail: `message ${i}: call ${keys.length ? callAt(keys[0]) : callName(b.id)} unanswered in the message after it` });
        }
      }
    });
  });

  const storedById = new Map(stored.map((m) => [String(m.id), m]));
  sent.forEach((m, i) => {
    const hasThinking = blocks(m).some((b) => b?.type === 'thinking' || b?.type === 'redacted_thinking');
    for (const s of messages[i]?.sources ?? []) {
      if (!s.startsWith('r:')) continue;
      const body = storedById.get(s.slice(2).split('!')[0]);
      const calls = blocks(body).flatMap((b, k) => (b?.type === 'tool_use' ? [[b.id, `${body.id}#${k}`]] : []));
      if (!hasThinking || calls.length === 0) continue;
      const missing = calls.filter(([id]) => !blocks(m).some((b) => b?.type === 'tool_use' && b.id === id));
      if (missing.length) out.push({ invariant: 'thinking', detail: `message ${i} carries body ${nameOf(body.id)}'s thinking without its calls ${missing.map(([, key]) => callAt(key)).join(', ')}` });
    }
  });

  const pins = readable(() => manager.listPins());
  if (isUnreadable(pins)) out.push({ invariant: 'unreadable', detail: `listPins: ${pins.unreadable}; pins weren't judged` });
  else if (!summaryUnread) {
    for (const p of pins) {
      const from = sequenceOf.get(String(p.firstMessageId)), to = sequenceOf.get(String(p.lastMessageId));
      if (from === undefined || to === undefined) {
        out.push({ invariant: 'unreadable', detail: `pin ${spanName('pin', nameOf(p.firstMessageId), nameOf(p.lastMessageId))} names a message the compile's view doesn't hold; that pin wasn't judged` });
        continue;
      }
      const allowed = p.level ?? p.maxLevel ?? 0;
      for (const m of messages) for (const s of m.sources) {
        if (!s.startsWith('s:')) continue;
        const [id, lvl] = s.slice(2).replace('~', '').split('@');
        if (Number(lvl) <= allowed) continue;
        const inside = leaves(id).find((b) => { const q = sequenceOf.get(b); return q !== undefined && q >= from && q <= to; });
        if (inside) out.push({ invariant: 'pins', detail: `summary ${summaryName(id)} at L${lvl} covers ${nameOf(inside)}, inside pin ${spanName('pin', nameOf(p.firstMessageId), nameOf(p.lastMessageId))} allowing L${allowed}` });
      }
    }
  }
  for (const f of failed) out.push({ invariant: 'unreadable', detail: `${f}; what depends on it wasn't judged`, ...(wholeOf.get(f) ? { full: `${wholeOf.get(f)}; what depends on it wasn't judged` } : {}) });
  return Object.defineProperty(dedupe(out), 'unjudged', { value: unjudged, enumerable: false });
}

const dedupe = (violations) => [...new Map(violations.map((v) => [`${v.invariant}|${v.detail}`, v])).values()];
