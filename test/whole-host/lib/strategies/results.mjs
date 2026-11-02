import { png } from './png.mjs';
import { WORDS, prose, seeded } from './prose.mjs';

export const KINDS = ['prose', 'code', 'json', 'image', 'mixed'];
const MAX_TEXT = 2_000_000;
const MAX_SIDE = 2048;

const IDENTS = ['value', 'index', 'record', 'buffer', 'offset', 'cursor', 'result', 'total', 'entry', 'count'];
const CALLS = ['read', 'merge', 'split', 'store', 'parse', 'apply', 'shift', 'fold'];

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function words(pick, length) {
  let s = '';
  while (s.length < length) s += (s ? ' ' : '') + WORDS[pick(WORDS.length)];
  return s.slice(0, length);
}

const proseOf = (canary, size, r) => (size > canary.length ? `${canary} ${prose(size - canary.length - 1, r)}` : canary);

function code(canary, size, pick) {
  let s = canary;
  while (s.length < size) {
    const lhs = `${IDENTS[pick(IDENTS.length)]}_${pick(64)}`;
    const args = [IDENTS[pick(IDENTS.length)], IDENTS[pick(IDENTS.length)]].join(', ');
    s += `\n${'  '.repeat(pick(3))}const ${lhs} = ${CALLS[pick(CALLS.length)]}(${args});`;
  }
  return s.slice(0, size);
}

function jsonText(canary, size, pick) {
  let s = `{"canary":${JSON.stringify(canary)},"rows":[`;
  const tail = ']}';
  let first = true;
  for (;;) {
    const row = `${first ? '' : ','}"${words(pick, 20 + pick(60))}"`;
    if (s.length + row.length + tail.length > size) break;
    s += row;
    first = false;
  }
  const room = size - s.length - tail.length;
  const shell = first ? 2 : 3;
  s += room >= shell ? `${first ? '' : ','}"${words(pick, room - shell)}"` : ' '.repeat(room);
  return s + tail;
}

function jsonFloor(canary) { return `{"canary":${JSON.stringify(canary)},"rows":[]}`.length; }

const isWhole = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const refuse = (text) => ({ content: [{ type: 'text', text }], isError: true });

export function toolResult(args) {
  const a = args && typeof args === 'object' ? args : {};
  if (!KINDS.includes(a.kind)) return refuse(`kind must be one of ${KINDS.join(', ')} (got ${JSON.stringify(a.kind)})`);
  if (typeof a.canary !== 'string' || a.canary === '') return refuse(`canary must be a non-empty string (got ${JSON.stringify(a.canary)})`);
  const r = seeded(canonical(a));
  const pick = (m) => Math.floor(r() * m);
  if (a.kind === 'mixed') {
    if (!isWhole(a.width, 1, MAX_SIDE) || !isWhole(a.height, 1, MAX_SIDE) || !isWhole(a.size, a.canary.length * 2, MAX_TEXT)) {
      return refuse(`mixed needs width and height from 1 to ${MAX_SIDE} and a size from ${a.canary.length * 2} to ${MAX_TEXT} (got ${JSON.stringify([a.width, a.height, a.size])})`);
    }
    const half = Math.floor(a.size / 2);
    return { content: [{ type: 'text', text: proseOf(a.canary, half, r) }, { type: 'image', data: png(a.width, a.height, pick), mimeType: 'image/png' }, { type: 'text', text: proseOf(a.canary, a.size - half, r) }] };
  }
  if (a.kind === 'image') {
    if (!isWhole(a.width, 1, MAX_SIDE) || !isWhole(a.height, 1, MAX_SIDE)) {
      return refuse(`width and height must be whole numbers from 1 to ${MAX_SIDE} (got ${JSON.stringify(a.width)} by ${JSON.stringify(a.height)})`);
    }
    return { content: [{ type: 'image', data: png(a.width, a.height, pick), mimeType: 'image/png' }, { type: 'text', text: a.canary }] };
  }
  const floor = a.kind === 'json' ? jsonFloor(a.canary) : a.canary.length;
  if (!isWhole(a.size, floor, MAX_TEXT)) {
    return refuse(`size must be a whole number of characters from ${floor} to ${MAX_TEXT} for this kind and canary (got ${JSON.stringify(a.size)})`);
  }
  const text = a.kind === 'prose' ? proseOf(a.canary, a.size, r) : (a.kind === 'code' ? code : jsonText)(a.canary, a.size, pick);
  return { content: [{ type: 'text', text }] };
}
