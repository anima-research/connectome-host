import { CANARY } from './standin.mjs';

function canariesIn(content, inputs) {
  const texts = [];
  const walk = (b) => {
    if (typeof b === 'string') { texts.push(b); return; }
    if (!b || typeof b !== 'object') return;
    if (typeof b.text === 'string') texts.push(b.text);
    if (b.type === 'tool_result') { if (Array.isArray(b.content)) b.content.forEach(walk); else texts.push(String(b.content ?? '')); }
    if (inputs && b.type === 'tool_use') texts.push(JSON.stringify(b.input ?? null));
  };
  (Array.isArray(content) ? content : []).forEach(walk);
  return texts.flatMap((t) => t.match(CANARY) ?? []);
}

export const canariesOf = (content) => canariesIn(content, false);

export const namingCanaries = (content) => canariesIn(content, true);

export const shortCanary = (canary) => /^\[\[c:(.+)\]\]$/.exec(canary)?.[1] ?? canary;

export function messageNames(order, canaryOf) {
  const names = new Map(), anchors = new Map();
  let anchor = 'start', after = 0;
  for (const raw of order) {
    const id = String(raw);
    const canary = canaryOf(id);
    if (canary) {
      const short = shortCanary(canary);
      const n = (anchors.get(short) ?? 0) + 1;
      anchors.set(short, n);
      anchor = n === 1 ? short : `${short}:${n}`;
      after = 0;
      names.set(id, anchor);
    } else names.set(id, `${anchor}+${++after}`);
  }
  return (id) => names.get(String(id)) ?? null;
}

export const byStoreOrder = (a, b) => {
  const x = Number(a), y = Number(b);
  const nx = Number.isFinite(x), ny = Number.isFinite(y);
  return nx && ny ? x - y : nx ? -1 : ny ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

export const spanName = (prefix, first, last) => `${prefix}(${first === last ? first : `${first}-${last}`})`;
