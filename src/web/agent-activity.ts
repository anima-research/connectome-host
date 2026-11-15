/** A turn's wait for its error policy's next try, as agent-framework's
 *  healthSnapshot() reports it (from the release that adds it). */
export interface AgentRetrying {
  since?: number;
  until?: number;
  nextTry?: number;
  maxTries?: number;
  retryClass?: string;
}

/** How long until a time `ms` away, for a retry's countdown: seconds under
 *  two minutes, then minutes, then hours and minutes. */
export function waitText(ms: number): string {
  const sec = Math.ceil(ms / 1000);
  if (sec < 120) return `${sec}s`;
  const min = Math.round(sec / 60);
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
}

/** What an agent's health row says it is doing. agent-framework's `status` is
 *  its agent's state machine, which reads `idle` between a failed call and
 *  its retry: the failed call reset it. `retrying` and `turnAlive` say what it
 *  doesn't, from the agent-framework release that adds them; before it, the
 *  row reads `status` as it always did. */
export function agentActivity(
  a: { status?: string; turnAlive?: boolean; retrying?: AgentRetrying | null },
  /** The snapshot's `at`, the host's time when it was taken: `until` is the
   *  host's clock, and the browser's may be minutes off. Without an `at` it
   *  can read, it counts from this process's clock. */
  at: string | undefined,
  inFor: (ms: number) => string = waitText,
): { word: string; detail?: string } {
  const r = a.retrying;
  if (r) {
    const parts: string[] = [];
    if (r.retryClass) parts.push(r.retryClass);
    if (typeof r.nextTry === 'number') parts.push(typeof r.maxTries === 'number' ? `try ${r.nextTry} of ${r.maxTries}` : `try ${r.nextTry}`);
    if (typeof r.until === 'number') {
      const taken = Date.parse(at ?? '');
      const now = Number.isFinite(taken) ? taken : Date.now();
      parts.push(r.until > now ? `in ${inFor(r.until - now)}` : 'due now');
    }
    return parts.length ? { word: 'retrying', detail: parts.join(' · ') } : { word: 'retrying' };
  }
  if (a.turnAlive && a.status === 'idle') return { word: 'idle+turn-alive' };
  return { word: a.status ?? '?' };
}
