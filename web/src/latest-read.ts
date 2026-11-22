/**
 * One panel figure's reads, each counted: a response that comes back after a
 * newer read started is dropped, so an older figure never replaces a newer
 * one. A poll's tick starts a read only while none is pending: were each tick
 * to supersede the read before it, a read slower than the poll would be
 * dropped at every tick, and the figure would never land. A read asked for (a
 * scope change, a refresh) still supersedes a pending one.
 */
export class LatestRead {
  private latest = 0;
  private pending = false;

  /** Starts a read asked for: its number. */
  begin(): number {
    this.pending = true;
    return ++this.latest;
  }

  /** Starts a poll's read: its number, or `null` while the latest read is pending. */
  poll(): number | null {
    return this.pending ? null : this.begin();
  }

  /** Whether a newer read has started since `read` did. */
  superseded(read: number): boolean {
    return read !== this.latest;
  }

  /** `read` has answered or failed. */
  settled(read: number): void {
    if (read === this.latest) this.pending = false;
  }
}

/**
 * How long a read the coverage poll waits on may go unanswered before it
 * fails. A tick starts no read while one is pending, so a read that never
 * answered would stop the poll until a scope change or a refresh.
 */
export const READ_TIMEOUT_MS = 30_000;

/**
 * GETs a panel figure from the host as JSON. A refusal fails with the host's
 * `error`, or the HTTP status. With `timeoutMs`, a read that hasn't answered
 * by then (its body included) fails too.
 */
export async function readFigure<T>(url: string, timeoutMs?: number): Promise<T> {
  const signal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(url, { credentials: 'same-origin', ...(signal ? { signal } : {}) });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } catch (e) {
    if (signal?.aborted) throw new Error(`The host didn't answer in ${timeoutMs! / 1000} s.`);
    throw e;
  }
}
