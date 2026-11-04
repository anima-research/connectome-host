export function cutText(write) {
  let cut = false;
  const part = (whole) => (value, n, sep = ', ') => {
    const items = Array.isArray(value) ? value : null;
    if (whole) return items ? items.join(sep) : String(value);
    if ((items ?? String(value)).length > Math.abs(n)) cut = true;
    const kept = (items ?? String(value)).slice(n < 0 ? n : 0, n < 0 ? undefined : n);
    return items ? kept.join(sep) : kept;
  };
  const shown = write(part(false), false);
  return cut ? { shown, full: write(part(true), true) } : { shown };
}

export function cutError(error, n) {
  const c = cutText((cut) => cut(error?.message ?? error, n));
  const whole = typeof error?.full === 'string' ? error.full : null;
  return whole && whole !== c.shown ? { shown: c.shown, full: whole } : c;
}

export function cutThrow(write) {
  const { shown, full } = cutText(write);
  const e = new Error(shown);
  if (full) e.full = full;
  return e;
}

export const cutMessage = (write) => {
  const { shown, full } = cutText(write);
  return { message: shown, ...(full ? { full } : {}) };
};
