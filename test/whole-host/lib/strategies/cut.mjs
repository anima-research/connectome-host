export function cutText(write) {
  let cut = false;
  const part = (whole) => (value, n, sep = ', ') => {
    const items = Array.isArray(value) ? value : null;
    if (whole) return items ? items.join(sep) : String(value);
    if (items ? items.length > n : String(value).length > n) cut = true;
    return items ? items.slice(0, n).join(sep) : String(value).slice(0, n);
  };
  const shown = write(part(false), false);
  return cut ? { shown, full: write(part(true), true) } : { shown };
}

export const cutError = (error, n) => cutText((cut) => cut(error?.message ?? error, n));

export const cutMessage = (write) => {
  const { shown, full } = cutText(write);
  return { message: shown, ...(full ? { full } : {}) };
};
