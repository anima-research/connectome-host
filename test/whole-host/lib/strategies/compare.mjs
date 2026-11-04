import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REF = /\bimg_([0-9a-z]+)_(\d+)\b/g;
const FORK = /\b(fork-[^\s"]*?-)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g;

// agent-framework 0.32.0 names a tool-result image `img_<nonce>_<seq>`, its nonce minted by a ledger that lives only
// as long as its process (tool-image-ledger.ts).
export function runVaryingMasker() {
  const forks = new Map();
  const nonces = new Map();
  const nth = (map, key) => { if (!map.has(key)) map.set(key, map.size + 1); return map.get(key); };
  const mask = (value) => {
    if (typeof value === 'string') {
      return value.replace(REF, (_, nonce, n) => `img_N${nth(nonces, nonce)}_${n}`).replace(FORK, (_, prefix, uuid) => `${prefix}UUID${nth(forks, uuid)}`);
    }
    if (Array.isArray(value)) return value.map(mask);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'signature' && value.type === 'thinking' ? '(masked)' : mask(v)]));
  };
  return mask;
}

export const maskRunVarying = (value) => runVaryingMasker()(value);

export function sameBodies(onDir, offDir) {
  const files = (dir) => (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => /^r\d+\.json$/.test(f))
    .sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)));
  const read = (dir) => files(dir).map((f) => maskRunVarying(JSON.parse(readFileSync(join(dir, f), 'utf-8'))));
  const [a, b] = [read(onDir), read(offDir)];
  if (!a.length) return { outcome: 'differs', at: 0, detail: `no request bodies were saved in ${onDir}` };
  const at = a.findIndex((x, i) => JSON.stringify(x) !== JSON.stringify(b[i]));
  if (at === -1 && a.length === b.length) return { outcome: 'same', requests: a.length };
  const i = at === -1 ? Math.min(a.length, b.length) : at;
  const field = a[i] && b[i] ? Object.keys({ ...a[i], ...b[i] }).find((k) => JSON.stringify(a[i][k]) !== JSON.stringify(b[i][k])) : null;
  return { outcome: 'differs', at: i, files: [files(onDir)[i], files(offDir)[i]], detail: `${a.length} requests with recording on, ${b.length} with it off${field ? `; its ${field} differs` : ''}` };
}

export function selfCheckOf({ on, off, onBodies, offBodies }) {
  if (!on.ok) return { outcome: 'couldnt-run', reason: `the run with recording on failed: ${on.reason ?? 'no reason given'}` };
  if (off.couldnt) return { outcome: 'couldnt-run', reason: `the run with recording off couldn't run: ${off.couldnt}` };
  if (!off.ok) return { outcome: 'couldnt-run', reason: `the run with recording off failed: ${off.reason ?? 'no reason given'}` };
  const recorded = (off.log ?? []).filter((e) => e.kind === 'compiles').length;
  if (recorded) return { outcome: 'couldnt-run', reason: `the run with recording off logged ${recorded} compile batch${recorded === 1 ? '' : 'es'}, so the test module recorded though its recording was off` };
  return sameBodies(onBodies, offBodies);
}
