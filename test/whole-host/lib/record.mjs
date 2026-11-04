import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_AGENT, requestPairs } from './strategies/checks.mjs';
import { messageNames, spanName } from './strategies/names.mjs';

export const LONG_TEXT_BYTES = 4096;

const CANARY = /\[\[c:([^\]\s]+)\]\]/;
const MARK = /\[\[s:M[0-9a-f]{8}\]\]/g;
const REF = /\bimg_([0-9a-z]+)_(\d+)\b/g;
const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const longText = (s) => {
  const bytes = Buffer.byteLength(s, 'utf8');
  return bytes <= LONG_TEXT_BYTES ? s : canonical({ sha256: createHash('sha256').update(s).digest('hex').slice(0, 16), bytes, head: s.slice(0, 80), tail: s.slice(-80) });
};
const textOf = (content) => {
  if (typeof content === 'string') return content;
  const out = [];
  const walk = (x) => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (!x || typeof x !== 'object') return;
    if (typeof x.text === 'string') out.push(x.text);
    if (typeof x.thinking === 'string') out.push(x.thinking);
    if (x.type === 'tool_result') { if (typeof x.content === 'string') out.push(x.content); else walk(x.content); }
    if (x.type === 'tool_use') out.push(`${x.name ?? 'tool'} ${canonical(x.input ?? null)}`);
    if (x.type === 'image') out.push(`[image ${x.source?.media_type ?? x.mimeType ?? ''}]`.replace(' ]', ']'));
  };
  walk(content);
  return out.join('\n');
};

export function renderRecord(args) {
  return `${renderRecordLines(args).map((l) => l.text).join('\n')}\n`;
}

export function renderRecordLines({ header, log, records, end, judged = null }) {
  const blobs = new Map();
  const batches = [];
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const [id, v] of Object.entries(e.blobs ?? {})) blobs.set(id, v);
    batches.push(e);
  }

  const nonces = new Map();
  const letters = (i) => (i < 26 ? String.fromCharCode(97 + i) : letters(Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)));
  // agent-framework mints an image ref's nonce per process (tool-image-ledger.ts), so each is named by its first appearance.
  const nameNonces = (s) => s.replace(REF, (_, nonce, n) => {
    if (!nonces.has(nonce)) nonces.set(nonce, `n${letters(nonces.size)}`);
    return `img_${nonces.get(nonce)}_${n}`;
  });

  const templates = [];
  const slot = new Map();
  const slug = (s) => String(s).toLowerCase().replace(/\d+/g, '#').replace(/[^a-z#]+/g, '-').replace(/^-+|-+$/g, '');
  const template = (role, text, key = null) => {
    const shaped = longText(nameNonces(text));
    const words = key ? null : text.split(/\s+/);
    const base = key ?? `${slug(role)}-${slug(words.slice(0, 3).join(' ')).slice(0, 40) || 'empty'}`;
    const k = `${base}\u0000${shaped}`;
    if (!slot.has(k)) { slot.set(k, templates.length); templates.push({ base, role, words, shaped }); }
    return `\u0001${slot.get(k)}\u0001`;
  };

  const primary = FIXTURE_AGENT;
  const stores = new Map();
  const storeOf = (agent) => {
    if (!stores.has(agent)) stores.set(agent, { ids: new Set(), reported: new Set(), present: new Map(), highest: [], canaries: new Map(), summaries: new Map(), order: null });
    return stores.get(agent);
  };
  const remember = (map, key, at, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push([at, value]); };
  const batchAt = new Map(batches.map((b, i) => [b, i]));
  const live = new Map();
  batches.forEach((b, i) => {
    for (const [agent, st] of Object.entries(b.store ?? {})) {
      const store = storeOf(agent);
      if (!live.has(agent)) live.set(agent, new Set());
      const here = live.get(agent);
      if (st.whole && Array.isArray(st.messages)) {
        const listed = new Set(st.messages.map(([id]) => String(id)));
        for (const id of [...here]) if (!listed.has(id)) { remember(store.present, id, i, false); here.delete(id); }
      }
      for (const [id, canaries] of Array.isArray(st.messages) ? st.messages : []) {
        store.ids.add(String(id));
        store.reported.add(String(id));
        remember(store.present, String(id), i, true);
        remember(store.canaries, String(id), i, CANARY.exec(canaries?.[0] ?? '')?.[1] ?? null);
        here.add(String(id));
      }
      for (const id of Array.isArray(st.removedMessages) ? st.removedMessages : []) { remember(store.present, String(id), i, false); here.delete(String(id)); }
      const top = Math.max(store.highest.at(-1)?.[1] ?? -Infinity, ...(Array.isArray(st.messages) ? st.messages : []).map(([id]) => Number(id)).filter(Number.isFinite));
      store.highest.push([i, top]);
      for (const sm of Array.isArray(st.summaries) ? st.summaries : []) remember(store.summaries, sm.id, i, sm);
    }
  });
  const reportedAnywhere = (id) => [...stores.values()].some((st) => st.reported.has(id));
  for (const b of batches) for (const l of b.lines ?? []) for (const m of l.messages ?? []) {
    if (m.sources.length !== 1 || !m.sources[0].startsWith('r:')) continue;
    const id = m.sources[0].slice(2).split('!')[0];
    if (!reportedAnywhere(id)) storeOf(l.agent).ids.add(id);
  }
  let now = -1;
  const asOf = (history) => {
    if (!history) return undefined;
    let value = history[0][1];
    for (const [at, v] of history) { if (at > now) break; value = v; }
    return value;
  };
  const heldNow = (agent, id) => {
    const store = storeOf(agent);
    const history = store.present.get(String(id));
    if (!history) return false;
    if (history[0][0] <= now) return asOf(history);
    let top = -Infinity;
    for (const [at, v] of store.highest) { if (at > now) break; top = v; }
    return Number(id) > top;
  };
  const canaryOf = (agent, id) => asOf(storeOf(agent).canaries.get(String(id))) ?? undefined;
  const summaryOf = (agent, id) => asOf(storeOf(agent).summaries.get(id));
  const isSummary = (agent, id) => storeOf(agent).summaries.has(id);
  const byId = (a, b) => {
    const x = Number(a), y = Number(b);
    const nx = Number.isFinite(x), ny = Number.isFinite(y);
    return nx && ny ? x - y : nx ? -1 : ny ? 1 : a < b ? -1 : a > b ? 1 : 0;
  };
  const positionOf = (agent, id) => {
    const store = storeOf(agent);
    if (!store.order) store.order = new Map([...store.ids].sort(byId).map((x, i) => [x, i]));
    return store.order.get(id);
  };
  const leaves = (agent, id, seen = new Set()) => {
    const sm = summaryOf(agent, id);
    if (!sm || seen.has(id)) return [];
    seen.add(id);
    return sm.sources.flatMap((src) => (isSummary(agent, src) && sm.sourceLevel > 0 ? leaves(agent, src, seen) : [String(src)]));
  };
  const namers = new Map();
  const nameOf = (agent, id) => {
    const key = `${agent}\u0000${now}`;
    if (!namers.has(key)) namers.set(key, messageNames([...storeOf(agent).reported].filter((x) => heldNow(agent, x)).sort(byId), (x) => canaryOf(agent, x)));
    return namers.get(key)(id) ?? `#${id}`;
  };
  const summaryName = (agent, id, level) => {
    const named = leaves(agent, id).filter((leaf) => heldNow(agent, leaf)).map((leaf) => nameOf(agent, leaf));
    return named.length ? spanName(`L${summaryOf(agent, id)?.level ?? level}`, named[0], named.at(-1)) : `L${summaryOf(agent, id)?.level ?? level}(-)`;
  };
  const leafName = (agent, leaf) => (isSummary(agent, leaf) ? summaryName(agent, leaf) : nameOf(agent, leaf));
  const summaryTemplate = (sm) => {
    const value = blobs.get(sm.content);
    const text = nameNonces(textOf(value?.content ?? value ?? ''));
    return template('summary', text, `summary-l${sm.level}-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`);
  };
  let marks = null;
  let marksAt = null;
  const markName = () => {
    if (!marks || marksAt !== now) {
      marks = new Map();
      marksAt = now;
      for (const [agent, store] of stores) for (const sm of [...store.summaries.keys()].map((id) => summaryOf(agent, id))) {
        const value = blobs.get(sm.content);
        for (const m of textOf(value?.content ?? value ?? '').match(MARK) ?? []) if (!marks.has(m)) marks.set(m, summaryName(agent, sm.id, sm.level));
      }
    }
    return marks;
  };
  const thinking = new Map();
  const ownerOf = (agent, slots, id) => [agent, ...slots, ...[...stores.keys()].filter((n) => n !== agent && !slots.includes(n))].find((n) => stores.has(n) && heldNow(n, id));
  const item = (m, agent, slots = []) => {
    const value = blobs.get(m.content);
    const raw = textOf(value?.content ?? value);
    if (m.sources.length === 1 && m.sources[0].startsWith('r:')) {
      const [id, why] = m.sources[0].slice(2).split('!');
      const bare = thinking.get(`${agent} ${id}`) === true && !(Array.isArray(value?.content) && value.content.some((b) => b?.type === 'thinking' || b?.type === 'redacted_thinking'));
      const after = `${why ? `!${why}` : ''}${bare ? ':no-thinking' : ''}`;
      const canary = CANARY.exec(raw)?.[1];
      const owner = canary ? ownerOf(agent, slots, id) : undefined;
      const named = owner ? `${owner === agent ? '' : `${owner}/`}${nameOf(owner, id)}` : canary;
      if (canary && !after) return { name: named, pos: positionOf(owner ?? agent, id), owner: owner ?? agent };
      if (canary) return { text: `${named}${after}` };
      const text = nameNonces(raw);
      const numbers = text.match(/\d+/g) ?? [];
      return { text: `[${template(value?.participant ?? 'message', text.replace(/\d+/g, '#'))}]${numbers.length ? `(${numbers.join(',')})` : ''}${after}` };
    }
    const ids = m.sources.map((s) => /^s:([^@]+)@?(.*)$/.exec(s));
    if (ids.every((x) => x && isSummary(agent, x[1]))) return { text: ids.map((x) => `${summaryName(agent, x[1], x[2])}${x[2].endsWith('~') ? '~' : ''}`).join('+') };
    const levels = m.sources.map((s) => (s.startsWith('s:') ? `L${s.split('@')[1] ?? '?'}` : s.split(':')[0])).join('+');
    const text = nameNonces(raw);
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 12);
    return { text: `${levels}[${template('summary', text, `summary-${levels.toLowerCase()}-${hash}`)}]` };
  };
  const items = (list) => {
    const out = [];
    for (const it of list) {
      const last = out.at(-1);
      if (it.name && last?.from && it.pos !== undefined && it.owner === last.owner && it.pos === last.end + 1) { last.to = it.name; last.end = it.pos; continue; }
      out.push(it.name ? { from: it.name, to: it.name, end: it.pos, owner: it.owner } : it);
    }
    return out.map((r) => r.text ?? (r.from === r.to ? r.from : `${r.from}-${r.to}`)).join(' ');
  };
  const previous = new Map();
  const keyOf = (it) => it.name ?? it.text;
  const sha8 = (v) => createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex').slice(0, 8);
  const sentAs = new Map();
  const rounds = new Map();
  for (const agent of new Set(batches.flatMap((b) => (b.lines ?? []).map((l) => l.agent)).filter(Boolean))) {
    const paired = requestPairs(records ?? [], log, agent, { side: agent === primary ? 'primary' : 'sub' });
    for (const { line, request } of paired?.pairs ?? []) sentAs.set(`${agent}|${line.boot}|${line.seq}`, request);
    for (const request of paired?.continuations ?? []) rounds.set(request.id, { agent, request });
  }
  const owned = new Set([...sentAs.values()].map((r) => r.id));
  for (const r of records ?? []) if (r.kind === 'agent' && !owned.has(r.id) && !rounds.has(r.id)) rounds.set(r.id, { agent: (r.agent ?? 'primary') === 'primary' ? primary : 'sub', request: r });
  const heads = new Map();
  const lastHead = new Map();
  const headText = (h) => [
    `model ${h.model}`,
    `max_tokens ${h.maxTokens}`,
    `stream ${h.stream}`,
    ...(h.toolChoice ? [`tool_choice ${canonical(h.toolChoice)}`] : []),
    ...(h.thinking ? [`thinking ${canonical(h.thinking)}`] : []),
    `system ${(h.system ?? []).map((b) => {
      const text = nameNonces(b.text ?? '');
      const numbers = text.match(/\d+/g) ?? [];
      return `[${template('system', text.replace(/\d+/g, '#'))}]${numbers.length ? `(${numbers.join(',')})` : ''}${b.cache ? `^${b.cache}` : ''}${b.other ? `{${String(b.other).slice(0, 8)}}` : ''}`;
    }).join(' ') || '-'}`,
    `tools ${(h.tools ?? []).map((t) => `${t.name}:${String(t.sha).slice(0, 8)}`).join(' ') || '-'}`,
    ...(h.headers ? [`headers beta ${(h.headers.beta ?? []).join('+') || '-'} version ${h.headers.version ?? '-'}`] : []),
    ...(h.path ? [`path ${h.path}`] : []),
    ...(h.query != null ? [`query ${h.query || '(empty)'}`] : []),
    ...(h.rest ? [`rest ${String(h.rest).slice(0, 8)}`] : []),
  ].join(', ');
  const messagesOf = (r) => (r.messages ?? []).map((m) => ({ role: m.role, digest: m.digest, cache: (m.blocks ?? []).map((b) => (b.contentCache ? [b.cache ?? null, b.contentCache] : b.cache ?? null)) }));
  const sentNote = (who, r) => {
    const head = r.head ? { ...r.head, stream: r.stream ?? null } : null;
    let note = '';
    if (head) {
      const key = sha8(head);
      if (!heads.has(key)) heads.set(key, headText(head));
      if (lastHead.get(who) !== key) { lastHead.set(who, key); note = `, head H:${key}`; }
    }
    return `${note}, body ${sha8(messagesOf(r))}`;
  };
  const lastCarried = new Map();
  const lastSent = new Map();
  const carriedBy = (r) => [...new Set((r.messages ?? []).flatMap((m) => (m.blocks ?? []).flatMap((b) => b.canaries ?? [])).map((c) => CANARY.exec(c)?.[1] ?? c))];
  const compileLine = (l, boot) => {
    const list = (l.messages ?? []).map((m) => item(m, l.agent, l.slots ?? []));
    const marks = (l.messages ?? []).flatMap((m, i) => (m.marker ? [i + 1] : []));
    const keys = list.map(keyOf);
    const whose = `${l.agent} ${l.kind}`;
    const before = previous.get(whose);
    previous.set(whose, keys);
    let dropped = -1;
    if (before) {
      for (let n = 0; n <= before.length && dropped < 0; n++) {
        const kept = before.length - n;
        if (kept <= keys.length && (kept > 0 || n === 0) && before.slice(n).every((k, i) => keys[i] === k)) dropped = n;
      }
    }
    const added = dropped < 0 ? null : list.slice(before.length - dropped);
    const shown = dropped < 0 ? items(list) : [dropped ? `-${dropped}` : '', added.length ? `+ ${items(added)}` : ''].filter(Boolean).join(' ') || '= (as before)';
    const sent = l.kind === 'request' ? sentAs.get(`${l.agent}|${boot ?? null}|${l.seq}`) : null;
    const text = `  compile${l.agent === primary ? '' : ` [${l.agent}]`}${l.kind === 'dry' ? ' dry' : ''} ${shown}${marks.length ? ` ^ ${marks.join(',')}` : ''}`;
    return sent ? { kind: 'compile', base: text, sent, agent: l.agent, compile: l, request: sent.id } : { text };
  };

  const lines = [];
  lines.push(`# whole-host record ${header.configuration}, from ${header.from}`);

  const totals = { compiles: 0, dry: 0, refused: 0, other: 0, calls: 0, rounds: 0, written: 0, actions: 0 };
  const receipt = new Map();
  const firstBoot = log.find((e) => e.kind === 'compiles' && e.at === 'boot');
  const taken = new Set();
  const receiptBoot = new Map();
  const known = new Map();
  const byStep = new Map();
  const at = (step) => { if (!byStep.has(step)) byStep.set(step, []); return byStep.get(step); };
  const steps = [];
  const seen = (step) => { if (!steps.includes(step)) steps.push(step); };
  const summariser = new Map((records ?? []).filter((r) => r.kind === 'summariser').map((r) => [r.id, r]));
  const unclassified = new Map((records ?? []).filter((r) => r.kind === 'unclassified').map((r) => [r.id, r]));
  const carriedIn = (r) => [...new Set((r.messages ?? []).flatMap((m) => m.blocks.flatMap((b) => b.canaries ?? [])).map((c) => CANARY.exec(c)?.[1] ?? c))];
  for (const e of log) {
    if (e.kind === 'send' && e.via === 'ipc' && e.command) { seen(e.step); at(e.step).push({ text: `  action ${e.command}` }); totals.actions++; }
    if (e.kind === 'request' && rounds.has(e.request?.id)) {
      const { agent, request } = rounds.get(e.request.id);
      seen(e.step);
      totals.rounds++;
      at(e.step).push({ kind: 'round', agent, sent: request, request: request.id, round: true });
    }
    if (e.kind === 'request' && summariser.has(e.request?.id)) {
      const r = summariser.get(e.request.id);
      totals.calls++;
      seen(e.step);
      const carried = carriedIn(r);
      const words = (r.texts ?? []).map((t) => {
        const text = nameNonces(t);
        const marked = text.match(MARK);
        if (marked) return marked.map((m) => markName().get(m) ?? `S(${m.slice(4, -2)})`).join('+');
        const numbers = text.match(/\d+/g) ?? [];
        return `[${template('call', text.replace(/\d+/g, '#'))}]${numbers.length ? `(${numbers.join(',')})` : ''}`;
      });
      at(e.step).push({ kind: 'call', base: `  call ${[carried.length ? carried.join(' ') : '-', ...words].join(' ')} -> ${r.answer?.shape ?? 'none'}`, sent: r, request: r.id });
    }
    if (e.kind === 'request' && unclassified.has(e.request?.id)) {
      const r = unclassified.get(e.request.id);
      seen(e.step);
      const carried = carriedIn(r);
      at(e.step).push({ kind: 'unclassified', base: `  unclassified ${carried.length ? carried.join(' ') : '-'}`, sent: r, request: r.id });
    }
    if (e.kind === 'compiles') {
      now = batchAt.get(e);
      for (const [agent, st] of Object.entries(e.store ?? {})) {
        const tag = agent === primary ? '' : ` [${agent}]`;
        if (receiptBoot.has(agent) && receiptBoot.get(agent) !== e.boot && !('receiptHead' in st)) receipt.delete(agent);
        receiptBoot.set(agent, e.boot);
        if ('receiptHead' in st) {
          if (st.receiptHead?.unreadable) { seen(e.step); at(e.step).push({ text: `  unreadable${tag} receipt: ${st.receiptHead.unreadable}` }); receipt.delete(agent); }
          else if (st.receiptHead) receipt.set(agent, st.receiptHead);
          else receipt.delete(agent);
        }
        for (const part of ['messages', 'summaries']) if (st[part] && !Array.isArray(st[part])) { seen(e.step); at(e.step).push({ text: `  unreadable${tag} ${part}: ${st[part].unreadable ?? 'not a list'}` }); }
        for (const [id, , more] of Array.isArray(st.messages) ? st.messages : []) thinking.set(`${agent} ${id}`, more?.thinking === true);
        const listed = Array.isArray(st.summaries) ? new Set(st.summaries.map((sm) => sm.id)) : null;
        const gone = st.whole && listed && taken.has(agent) ? [...known.keys()].filter((k) => k.startsWith(`${agent} `)).map((k) => k.slice(agent.length + 1)).filter((id) => !listed.has(id)) : [];
        const baseline = st.whole && e === firstBoot;
        taken.add(agent);
        for (const sm of Array.isArray(st.summaries) ? st.summaries : []) {
          const was = known.get(`${agent} ${sm.id}`);
          const now = canonical({ level: sm.level, sources: sm.sources, content: sm.content, parent: sm.parent ?? null });
          known.set(`${agent} ${sm.id}`, now);
          if (was === now || baseline) continue;
          seen(e.step); at(e.step).push({ text: `  wrote${agent === primary ? '' : ` [${agent}]`} ${summaryName(agent, sm.id, sm.level)} [${summaryTemplate(sm)}]` }); totals.written++;
        }
        const removed = [...(st.removed ?? []), ...gone];
        for (const id of removed) known.delete(`${agent} ${id}`);
        if (removed.length) { seen(e.step); at(e.step).push({ text: `  removed${agent === primary ? '' : ` [${agent}]`} ${removed.map((id) => leafName(agent, id)).join(' ')}` }); }
      }
      const batch = [];
      for (const l of e.lines ?? []) {
        if (l.kind === 'other') { totals.other++; continue; }
        seen(e.step);
        if (l.outcome === 'refused' || l.error) {
          totals.refused++;
          const text = typeof l.error?.message === 'string' ? (blobs.get(l.error.message) ?? l.error.message) : '';
          batch.push({ text: `  compile${l.agent === primary ? '' : ` [${l.agent}]`} refused ${l.error?.class ?? 'unknown'}${text ? ` [${template(`error-${l.error?.class ?? 'unknown'}`, String(text).replace(/\d+/g, '#'))}]` : ''}` });
          continue;
        }
        if (l.kind === 'dry') totals.dry++; else totals.compiles++;
        batch.push(compileLine(l, e.boot));
      }
      let next = null;
      for (let k = batch.length - 1; k >= 0; k--) {
        if (batch[k].request) next = batch[k].request;
        else if (next) batch[k].before = next;
      }
      at(e.step).push(...batch);
    }
    if (e.kind === 'checkpoint') { seen(e.step); at(e.step).push({ text: `checkpoint ${e.name}` }); }
  }
  const seqOf = new Map((records ?? []).map((r, i) => [r.id, r.seq ?? i]));
  for (const step of steps) {
    let key = -Infinity;
    const keyed = (byStep.get(step) ?? []).map((l, i) => {
      if (l.request && seqOf.has(l.request)) key = seqOf.get(l.request);
      return { l, key: l.request && seqOf.has(l.request) ? seqOf.get(l.request) : l.before && seqOf.has(l.before) ? seqOf.get(l.before) : key, i };
    });
    keyed.sort((a, b) => a.key - b.key || a.i - b.i);
    byStep.set(step, keyed.map(({ l }) => {
      if (l.kind === 'compile') {
        lastCarried.set(l.agent, carriedBy(l.sent));
        lastSent.set(l.agent, l.compile);
        return { text: `${l.base}${sentNote(l.agent, l.sent)}`, request: l.request, compile: l.compile };
      }
      if (l.kind === 'round') {
        const before = new Set(lastCarried.get(l.agent) ?? []);
        const carried = carriedBy(l.sent);
        lastCarried.set(l.agent, carried);
        const added = carried.filter((c) => !before.has(c));
        return { text: `  round${l.agent === primary ? '' : ` [${l.agent}]`} ${added.length ? `+ ${added.join(' ')}` : '='}${sentNote(l.agent, l.sent)}`, request: l.request, compile: lastSent.get(l.agent) ?? null, round: true };
      }
      if (l.kind === 'call') return { text: `${l.base}${sentNote('summariser', l.sent)}`, request: l.request };
      if (l.kind === 'unclassified') return { text: `${l.base}${sentNote('unclassified', l.sent)}`, request: l.request };
      const { before, ...line } = l;
      return line;
    }));
  }
  for (const step of steps) {
    const own = byStep.get(step) ?? [];
    const body = own.filter((l) => l.text.startsWith('  '));
    if (body.length) lines.push(`step ${step}`, ...body);
    lines.push(...own.filter((l) => !l.text.startsWith('  ')));
  }
  lines.push(`end ${end?.ok ? 'ok' : 'failed'}`);
  for (const [agent, head] of [...receipt.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const changes = (head.changes ?? []).map(([leaf, change]) => (change ? `${leafName(agent, leaf)}/${String(change[0]).split(':')[0]}/${change[1]}/${change[2]}` : `${leafName(agent, leaf)}/removed`));
    lines.push(`receipt ${agent} #${head.sequence}${changes.length ? ` changes ${changes.join(' ')}` : ''}`);
  }
  const unjudged = {};
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const l of e.lines ?? []) for (const u of l.unjudged ?? []) {
      const key = `${l.agent === primary ? '' : `[${l.agent}] `}${u}`;
      unjudged[key] = (unjudged[key] ?? 0) + 1;
    }
  }
  lines.push(`totals ${canonical(Object.keys(unjudged).length ? { ...totals, unjudged } : totals)}`);
  if (judged) lines.push(`judged ${judged.map((j) => `${j.check} ${j.name} ${j.judged ?? '?'}`).join(', ')}`);
  const names = nameTemplates(templates);
  const head = lines.findIndex((l) => typeof l === 'string' && !l.startsWith('#'));
  const block = ['templates', ...templates.map((t, i) => [names[i], t.shaped]).sort(([a], [b]) => (a < b ? -1 : 1))
    .flatMap(([name, text]) => `T:${name} = ${text.split('\n').join('\n  ')}`.split('\n'))];
  const headBlock = heads.size ? ['heads', ...[...heads.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, text]) => `H:${key} = ${text}`)] : [];
  lines.splice(head < 0 ? lines.length : head, 0, ...block, ...headBlock);
  const named = (text) => text.replace(/\u0001(\d+)\u0001/g, (_, i) => `T:${names[i]}`);
  return lines.map((l) => (typeof l === 'string' ? { text: named(l), request: null } : { ...l, text: named(l.text), request: l.request ?? null }));
}

const sha12 = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

export function nameTemplates(templates, hash = sha12) {
  const names = templates.map((t) => (t.words ? `${t.base}-${hash(t.shaped)}` : t.base));
  const holder = new Map();
  names.forEach((name, i) => {
    if (holder.has(name)) throw new Error(`two different texts take the template name ${name}: ${JSON.stringify(templates[holder.get(name)].shaped)} and ${JSON.stringify(templates[i].shaped)}`);
    holder.set(name, i);
  });
  return names;
}

export function unrecordable(records, log) {
  const sideOf = (agent) => (agent === FIXTURE_AGENT ? 'primary' : 'sub');
  const lines = log.filter((e) => e.kind === 'compiles').flatMap((e) => (e.lines ?? []).filter((l) => l.kind === 'request' && l.outcome === 'compiled'));
  const compiled = new Set(lines.map((l) => sideOf(l.agent)));
  const uncompiled = [...new Set(records.filter((r) => r.kind === 'agent').map((r) => r.agent ?? 'primary'))].filter((side) => !compiled.has(side));
  const begun = new Map();
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const id of e.submissions ?? []) {
      if (begun.has(id) && begun.get(id) !== e.boot) return `kv-unified submission ${id} was begun in boot ${begun.get(id)} and again in boot ${e.boot}, which a restart's later clock never allows, so the context manager would take the second as a duplicate and the record would show a host no resident runs`;
      if (!begun.has(id)) begun.set(id, e.boot);
    }
  }
  const others = [...new Set(lines.map((l) => l.agent).filter((a) => a !== FIXTURE_AGENT))];
  if (others.length > 1) return `${others.join(' and ')} each made request compiles, and the stand-in tells only the fixture's requests from the rest, so the record couldn't tell one agent's requests from another's`;
  if (uncompiled.length) return `the run sent ${uncompiled.join(' and ')} agent requests, and its log holds no compiled request line from the test module for ${uncompiled.length > 1 ? 'either' : 'that side'}, so its record couldn't tell their compiles from their rounds`;
  const unstamped = lines.filter((l) => l.outcome === 'compiled' && !/^\d+$/.test(String(l.stamp ?? ''))).length;
  if (unstamped) return `${unstamped} request compile(s) carry no stamp from the machine's monotonic clock, which the test module reads on Linux, so the record couldn't tell their requests from rounds`;
  return null;
}

export function refuseUnrecordable(r) {
  const cannot = r.outcome === 'couldnt-run' ? null : unrecordable(r.records, r.log);
  if (cannot) Object.assign(r, { outcome: 'couldnt-run', reason: cannot });
  return cannot;
}

export const everyRunUpdated = (everyRun, results) => everyRun.every((n) => results.some((x) => x.run === n && x.record === 'updated'));

export function exitCode(results, { versions = 'same' } = {}) {
  if (results.some((r) => r.outcome === 'couldnt-run' || r.selfCheck?.outcome === 'couldnt-run')) return 2;
  if (versions !== 'same' && versions !== 'updated') return 1;
  return results.every((r) => r.outcome === 'pass' && (r.record === 'same' || r.record === 'updated') && (!r.selfCheck || r.selfCheck.outcome === 'same')) ? 0 : 1;
}

const versionList = (v) => Object.entries(v ?? {}).map(([k, x]) => `${k.replace('@animalabs/', '')} ${x}`).join(', ');

export function versionsText({ release, candidate }) {
  const without = (v, names) => Object.fromEntries(Object.entries(v ?? {}).filter(([k]) => !names.includes(k)));
  return `# whole-host versions\ncheckpoint ${release.tag}: ${versionList(without(release.versions, ['bun']))}\ncandidate: ${versionList(without(candidate.versions, ['bun', '@animalabs/connectome-host']))}\n`;
}

export function versionChanges(committed, now) {
  const parse = (text) => new Map(text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => {
    const [, kind, tag, list] = /^(\w+)(?: (\S+))?: (.*)$/.exec(l) ?? [];
    return [kind, { tag, packages: new Map((list ?? '').split(', ').filter(Boolean).map((p) => { const at = p.lastIndexOf(' '); return [p.slice(0, at), p.slice(at + 1)]; })) }];
  }));
  const a = parse(committed);
  const b = parse(now);
  const out = [];
  for (const kind of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(kind) ?? { packages: new Map() };
    const y = b.get(kind) ?? { packages: new Map() };
    if (x.tag !== y.tag) out.push(`${kind} ${x.tag ?? 'none'} → ${y.tag ?? 'none'}`);
    for (const name of new Set([...x.packages.keys(), ...y.packages.keys()])) {
      if (x.packages.get(name) !== y.packages.get(name)) out.push(`${kind} ${name} ${x.packages.get(name) ?? 'none'} → ${y.packages.get(name) ?? 'none'}`);
    }
  }
  return out;
}

export function compareVersions(recordsDir, now, { update = false } = {}) {
  const file = join(recordsDir, 'versions.txt');
  if (update) { mkdirSync(recordsDir, { recursive: true }); writeFileSync(file, now); return { state: 'updated', changes: [] }; }
  if (!existsSync(file)) return { state: 'missing', changes: [] };
  const committed = readFileSync(file, 'utf-8');
  return committed === now ? { state: 'same', changes: [] } : { state: 'differs', changes: versionChanges(committed, now) };
}
