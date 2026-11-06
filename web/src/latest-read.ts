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
