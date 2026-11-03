/**
 * The maps come from JSON.parse, so they have Object.prototype: this reads
 * an own key only, so an agent named `constructor` or `__proto__` that's
 * missing from a section reads as missing.
 */
export function healthEntry<T>(map: Record<string, T> | null | undefined, key: string): T | undefined {
  return map != null && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

export function readFailureLine(section: string, message: string): string {
  return message ? `${section} couldn't be read: ${message}` : `${section} couldn't be read`;
}

export function healthReadError(status: number, body: { error?: unknown } | null): string {
  return typeof body?.error === 'string' && body.error ? body.error : `HTTP ${status}`;
}

export function credentialNote(credential: { kind?: string; message?: string }): string | undefined {
  return (credential.kind ?? 'ok') !== 'ok' && credential.message ? credential.message : undefined;
}

export function lastActionText(action: { id: string; ok: boolean; message: string }, ago: string): string {
  return `${action.id} ${action.ok ? 'ok' : 'FAILED'} ${ago}${action.message ? ` — ${action.message}` : ''}`;
}
