/** JSON.parse reads 1e400 as Infinity, and JSON.stringify shows a
 *  non-finite number as null. */
export function shown(value: unknown): string {
  return typeof value === 'number' && !Number.isFinite(value) ? String(value) : JSON.stringify(value) ?? String(value);
}
