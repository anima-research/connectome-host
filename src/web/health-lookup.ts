/**
 * The Web UI's health panel reads the /healthz snapshot through this, which
 * the server's tests can reach (the panel imports it as
 * `@conhost/web/health-lookup`).
 */

/**
 * The entry under `key` in one of the snapshot's maps, such as an agent's
 * entry in a per-agent section, or a section in an agent's readFailures.
 * The maps come from JSON.parse, so they have Object.prototype: this reads
 * an own key only, so an agent named `constructor` or `__proto__` that's
 * missing from a section reads as missing. A missing or null map has no
 * entries.
 */
export function healthEntry<T>(map: Record<string, T> | null | undefined, key: string): T | undefined {
  return map != null && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** The panel's line for a section an agent's read failed for, with what the
 *  error said when the snapshot carries it: an observer without 'ops' gets
 *  it empty. */
export function readFailureLine(section: string, message: string): string {
  return message ? `${section} couldn't be read: ${message}` : `${section} couldn't be read`;
}

/** What the panel says when /healthz answers with a failure: the answer's
 *  error when it has words, and otherwise its status, since an observer
 *  without 'ops' gets a failed read's error empty. */
export function healthReadError(status: number, body: { error?: unknown } | null): string {
  return typeof body?.error === 'string' && body.error ? body.error : `HTTP ${status}`;
}

/** The line under the credential's kind: its message, while the state isn't
 *  ok and the snapshot carries the text (an observer without 'ops' gets it
 *  empty, and then there's no line). */
export function credentialNote(credential: { kind?: string; message?: string }): string | undefined {
  return (credential.kind ?? 'ok') !== 'ok' && credential.message ? credential.message : undefined;
}

/** The last operator action, after "last action:": which, how it ended and
 *  `ago`, then what it said when the snapshot carries it. */
export function lastActionText(action: { id: string; ok: boolean; message: string }, ago: string): string {
  return `${action.id} ${action.ok ? 'ok' : 'FAILED'} ${ago}${action.message ? ` — ${action.message}` : ''}`;
}
