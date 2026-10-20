/**
 * One agent's compression debt, as context-manager's getCompressionDebt()
 * reports it, in the words of the Web UI's Health tab, which imports it as
 * `@conhost/web/compression-debt`.
 *
 * Since anima-research/context-manager#272, a report that couldn't read
 * something says so. `failure` names which read failed, `error` says what
 * happened, what it means and what to do, a line each, and each count it
 * couldn't compute is `null`. So the line shows only the counts the report
 * gives, never a 0 it couldn't compute, and the tab shows `error` whole, with
 * its line breaks, and the host's own next step under it.
 */
export interface CompressionDebt {
  state?: 'healthy' | 'degraded' | 'critical' | 'unknown';
  /** What happened, what it means and what to do: a line saying what
   *  happened, then `Cause:`, `Effect:` and `Fix:` lines. */
  error?: string;
  /** Which read failed, whenever `error` is set: the compression quarantine
   *  ledger, which compression needs, or the report itself. */
  failure?: 'quarantine-ledger' | 'report';
  pendingChunks?: number | null;
  oldestPendingAgeMs?: number | null;
  mergeQueueDepth?: number | null;
  mergeQuarantineCount?: number | null;
  compressionQuarantineCount?: number | null;
}

/** How the Health tab tones a debt line: `alarm` for critical, `unread` for a
 *  report that couldn't read something, as it tones a read that failed,
 *  `warn` for degraded, and `quiet` for anything else. */
export type DebtTone = 'alarm' | 'unread' | 'warn' | 'quiet';

/** The read the report says failed, when it names one of the two. */
function failedRead(debt: CompressionDebt): 'quarantine-ledger' | 'report' | undefined {
  return debt.failure === 'quarantine-ledger' || debt.failure === 'report' ? debt.failure : undefined;
}

export function debtTone(debt: CompressionDebt): DebtTone {
  if (debt.state === 'critical') return 'alarm';
  if (failedRead(debt) !== undefined || debt.state === 'unknown') return 'unread';
  return debt.state === 'degraded' ? 'warn' : 'quiet';
}

/** The line's head, then "N chunk(s) pending · oldest A · merge queue K":
 *  the oldest chunk's age only while some are pending, and the merge queue
 *  only when it holds any. A count or age the report didn't give as a number
 *  isn't shown as one. The head says what a person most needs: that
 *  compression has stalled, when the ledger it needs can't be read; that the
 *  debt can't be checked, when the report itself failed; and otherwise the
 *  state. */
export function debtSummary(debt: CompressionDebt): string {
  const failed = failedRead(debt);
  const head = failed === 'quarantine-ledger'
    ? `compression has stalled${debt.state === 'critical' ? ' · critical' : ''}`
    : failed === 'report' || debt.state === 'unknown'
      ? "compression debt can't be checked"
      : `compression debt: ${typeof debt.state === 'string' ? debt.state : '?'}`;
  const parts = [head];
  const pending = debt.pendingChunks;
  if (typeof pending === 'number') {
    parts.push(`${pending} chunk(s) pending`);
    if (pending > 0) {
      const age = debt.oldestPendingAgeMs;
      parts.push(typeof age === 'number' && Number.isFinite(age) ? `oldest ${debtAge(age)}` : 'age unknown');
    }
  }
  const queue = debt.mergeQueueDepth;
  if (typeof queue === 'number' && queue > 0) parts.push(`merge queue ${queue}`);
  return parts.join(' · ');
}

/** An age as a person reads it, rounded: minutes under two hours, hours from there. */
export function debtAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 120 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/** The host's own next step, under the report's message, which it refers to:
 *  for a report that failed, how this host reports a problem; for the
 *  ledger, the same when the store's data is damaged, since nothing in
 *  context-manager repairs that. The reporter describes the message in their
 *  own words, as /bug's rule keeps error text and paths out of its public
 *  issues (src/bug-report.ts). None without a message. */
export function debtNextStep(debt: CompressionDebt): string | undefined {
  if (!debt.error) return undefined;
  const failed = failedRead(debt);
  if (failed === 'report') return 'To report it, run /bug, saying in your own words what this message shows.';
  if (failed === 'quarantine-ledger') {
    return "If the store's error says its data is damaged, nothing here repairs it: run /bug, saying in your own words what this message shows.";
  }
  return undefined;
}
