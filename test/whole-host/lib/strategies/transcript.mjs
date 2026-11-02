import { createHash } from 'node:crypto';
import { runVaryingMasker } from './compare.mjs';
import { toolResult } from './results.mjs';
import { TOOL } from './script.mjs';
import { CANARY, SUMMARY, markerOf, pngSize } from './standin.mjs';

const KEY = 32;
const STRIDE = 16;
const HEAD = 40;
const NAMED = 200;

const MARK = new RegExp(`${CANARY.source}|${SUMMARY.source}`);
const markOf = (text) => text.match(MARK)?.[0] ?? null;
const digest = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);
const count = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const oneLine = (s) => s.replace(/\s+/g, ' ');
const headOf = (s) => {
  const t = s.trimStart();
  return t.length > HEAD ? `${oneLine(t.slice(0, HEAD))}…` : oneLine(t);
};

export function generatedTexts({ steps = [], answers = [] }) {
  const texts = [];
  const known = new Set();
  const add = (text, kind) => {
    if (typeof text !== 'string' || text.length < KEY || known.has(text)) return;
    known.add(text);
    texts.push({ name: markOf(text) ?? kind, text });
  };
  const walk = (v) => {
    if (typeof v === 'string') { if (MARK.test(v)) add(v, '(text)'); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    if (v.name === TOOL && v.input && typeof v.input === 'object') {
      const result = toolResult(v.input);
      if (!result.isError) for (const b of result.content) if (b.type === 'text') add(b.text, '(result)');
    }
    Object.values(v).forEach(walk);
  };
  walk(steps);
  for (const content of answers) {
    for (const b of content ?? []) {
      if (b.type === 'text') add(b.text, '(reply)');
      else if (b.type === 'thinking') add(b.thinking, '(thinking)');
      else walk(b);
    }
  }
  const index = new Map();
  texts.forEach(({ text }, e) => {
    for (let at = 0; at + KEY <= text.length; at += STRIDE) {
      const key = text.slice(at, at + KEY);
      const hits = index.get(key);
      if (hits) hits.push(e, at); else index.set(key, [e, at]);
    }
  });
  return { texts, index };
}

function partsOf(s, generated, from = 0, to = s.length) {
  const { texts, index } = generated;
  const parts = [];
  let i = from;
  let free = from;
  while (i + KEY <= to) {
    if (!index.has(s.slice(i, i + KEY))) { i++; continue; }
    let best = null;
    for (let j = i; j < i + STRIDE && j + KEY <= to; j++) {
      const hits = index.get(s.slice(j, j + KEY)) ?? [];
      for (let h = 0; h < hits.length; h += 2) {
        const g = texts[hits[h]].text;
        const at = hits[h + 1];
        let back = 0;
        while (back < at && j - back > free && s.charCodeAt(j - back - 1) === g.charCodeAt(at - back - 1)) back++;
        let fwd = KEY;
        while (at + fwd < g.length && j + fwd < to && s.charCodeAt(j + fwd) === g.charCodeAt(at + fwd)) fwd++;
        const c = { e: hits[h], from: at - back, start: j - back, length: back + fwd };
        if (!best || c.length > best.length || (c.length === best.length && (c.start < best.start || (c.start === best.start && g.length < texts[best.e].text.length)))) best = c;
      }
    }
    if (best.start > free) parts.push(...partsOf(s, generated, free, best.start));
    parts.push({ run: best });
    i = free = best.start + best.length;
  }
  if (free < to) parts.push({ text: s.slice(free, to) });
  return parts;
}

function runPart({ e, from, length }, { texts }) {
  const { name, text } = texts[e];
  const to = from + length;
  const span = from === 0 && to === text.length ? `${count(length)} chars` : `chars ${count(from)}–${count(to)} of ${count(text.length)}`;
  let said = text.slice(from, to);
  if (said.startsWith(name)) said = said.slice(name.length).trimStart();
  return `⟪${name} ${span}: ${headOf(said)}⟫`;
}

export function transcriptOf(body, generated, seen = new Set()) {
  const lines = [];
  const mask = runVaryingMasker();
  const stack = (label, text, shortest = NAMED) => {
    const masked = mask(text);
    if (masked.length < shortest) return masked;
    const key = digest(masked);
    if (seen.has(key)) return `(as above: ${label ?? JSON.stringify(headOf(masked))}, ${count(masked.length)} chars, ${key})`;
    seen.add(key);
    return masked;
  };
  const emit = (indent, header, content) => {
    const pad = '  '.repeat(indent);
    if (content === undefined) { lines.push(`${pad}${header}`); return; }
    const rows = content.split('\n');
    if (rows.length === 1) { lines.push(`${pad}${header}: ${content}`); return; }
    lines.push(`${pad}${header}:`);
    for (const row of rows) lines.push(`${pad}    | ${row}`);
  };
  const rendered = (s) => partsOf(s, generated).map((p) => (p.run ? runPart(p.run, generated) : stack(null, p.text))).join('');
  const renderedJson = (v) => {
    if (typeof v === 'string') return `"${partsOf(v, generated).map((p) => (p.run ? runPart(p.run, generated) : stack(null, JSON.stringify(p.text).slice(1, -1)))).join('')}"`;
    if (Array.isArray(v)) return `[${v.map(renderedJson).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${renderedJson(x)}`).join(',')}}`;
    return JSON.stringify(v ?? null);
  };
  const cache = (b) => (b?.cache_control != null ? ` [cache ${markerOf(b.cache_control)}]` : '');
  const blocksOf = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []);

  const block = (b, indent) => {
    switch (b.type) {
      case 'text': return emit(indent, `text${cache(b)}`, rendered(b.text ?? ''));
      case 'thinking': {
        const said = b.thinking ?? '';
        return emit(indent, `thinking${cache(b)} ${typeof b.signature === 'string' && b.signature ? 'signed' : 'unsigned'}`, rendered(said));
      }
      case 'redacted_thinking': return emit(indent, `redacted_thinking${cache(b)}`, `${count((b.data ?? '').length)} chars`);
      case 'image': {
        const src = b.source ?? {};
        if (src.type !== 'base64') return emit(indent, `image${cache(b)}`, JSON.stringify(mask(src)));
        const data = src.data ?? '';
        const size = pngSize(data);
        const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
        return emit(indent, `image${cache(b)}`, `${src.media_type}${size ? ` ${size.width}×${size.height}` : ''}, ${count(bytes)} bytes`);
      }
      case 'tool_use': return emit(indent, `tool_use ${mask(String(b.id))} ${b.name}${cache(b)}`, renderedJson(b.input ?? {}));
      case 'tool_result':
        emit(indent, `tool_result ${mask(String(b.tool_use_id))}${b.is_error ? ' (error)' : ''}${cache(b)}`);
        for (const inner of blocksOf(b.content)) block(inner, indent + 1);
        return undefined;
      default: {
        const { cache_control: _c, ...rest } = b;
        return emit(indent, `${b.type}${cache(b)}`, stack(null, JSON.stringify(rest)));
      }
    }
  };

  const system = typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : Array.isArray(body.system) ? body.system : [];
  system.forEach(({ type, text, cache_control: _c, ...rest }, i) => {
    const other = { ...(type !== 'text' ? { type: type ?? null } : {}), ...rest };
    emit(0, `system[${i}]${cache(system[i])}${Object.keys(other).length ? ` ${JSON.stringify(mask(other))}` : ''}`, stack(`system[${i}]`, text ?? ''));
  });
  for (const tool of body.tools ?? []) {
    const { cache_control: _c, name, description, input_schema: schema, ...rest } = tool;
    const shown = [`description: ${description ?? ''}`, `input_schema: ${JSON.stringify(schema ?? null)}`, ...(Object.keys(rest).length ? [`other: ${JSON.stringify(rest)}`] : [])];
    emit(0, `tool ${name}${cache(tool)}`, stack(`tool ${name}`, shown.join('\n'), 0));
  }
  (body.messages ?? []).forEach((m, i) => {
    const { role, content: _c, cache_control: _m, ...envelope } = m;
    emit(0, `#${i} ${role}${cache(m)}${Object.keys(envelope).length ? ` ${JSON.stringify(mask(envelope))}` : ''}`);
    for (const b of blocksOf(m.content)) block(b, 1);
  });
  return lines;
}
