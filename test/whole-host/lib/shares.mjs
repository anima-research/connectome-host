export function shares(ids, n, table = {}, checkpointKey = () => null) {
  const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 1; };
  const runSeconds = (id) => table.runs?.[id] ?? median(Object.values(table.runs ?? {}));
  const checkpointSeconds = (key) => (key === null ? 0 : table.checkpoints?.[key] ?? median(Object.values(table.checkpoints ?? {})));
  const out = Array.from({ length: n }, () => ({ seconds: 0, checkpoints: new Set(), ids: new Set() }));
  const whole = (id) => runSeconds(id) + checkpointSeconds(checkpointKey(id));
  for (const id of [...ids].sort((a, b) => whole(b) - whole(a) || ids.indexOf(a) - ids.indexOf(b))) {
    const key = checkpointKey(id);
    const adds = (share) => runSeconds(id) + (key !== null && !share.checkpoints.has(key) ? checkpointSeconds(key) : 0);
    const share = out.reduce((best, x) => (x.seconds + adds(x) < best.seconds + adds(best) ? x : best));
    share.seconds += adds(share);
    if (key !== null) share.checkpoints.add(key);
    share.ids.add(id);
  }
  return out.map((x) => ({ seconds: Math.round(x.seconds), ids: ids.filter((id) => x.ids.has(id)) }));
}
