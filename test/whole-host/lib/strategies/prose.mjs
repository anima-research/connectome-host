export const WORDS = ('river stone lantern harbor quiet orchard ledger signal meadow copper window thread garden compass winter '
  + 'bridge morning letter answer kettle market island pencil shadow ribbon station velvet canyon basket').split(' ');

export function hash32(s) {
  let x = 2166136261;
  for (const ch of s) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0;
  return x;
}

export function seeded(seed) {
  let a = (typeof seed === 'number' ? seed : hash32(String(seed))) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function prose(chars, seed) {
  const r = typeof seed === 'function' ? seed : seeded(seed);
  let s = '';
  while (s.length < chars) {
    const n = 6 + Math.floor(r() * 12);
    const words = Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]);
    s += `${words[0][0].toUpperCase()}${words.join(' ').slice(1)}. `;
  }
  const out = s.slice(0, Math.max(0, chars));
  return out.endsWith(' ') ? `${out.slice(0, -1)}.` : out;
}
