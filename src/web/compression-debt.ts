/**
 * One agent's compression debt, as context-manager's getCompressionDebt()
 * reports it. A report that couldn't read something says so: `failure` names
 * which read failed, `error` says what happened, what it means and what to
 * do, a line each, and each count it couldn't compute is `null`.
 */
export interface CompressionDebt {
  state?: 'healthy' | 'degraded' | 'critical' | 'unknown';
  /** What happened, what it means and what to do: a line saying what
   *  happened, then `Cause:`, `Effect:` and `Fix:` lines. An observer
   *  without 'ops' gets it empty. */
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

export type DebtTone = 'alarm' | 'unread' | 'warn' | 'quiet';

function failedRead(debt: CompressionDebt): 'quarantine-ledger' | 'report' | undefined {
  return debt.failure === 'quarantine-ledger' || debt.failure === 'report' ? debt.failure : undefined;
}

export function debtTone(debt: CompressionDebt): DebtTone {
  if (debt.state === 'critical') return 'alarm';
  if (failedRead(debt) !== undefined || debt.state === 'unknown') return 'unread';
  return debt.state === 'degraded' ? 'warn' : 'quiet';
}

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

export function debtAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 120 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

export function debtNextStep(debt: CompressionDebt): string | undefined {
  if (!debt.error) return undefined;
  const failed = failedRead(debt);
  if (failed === 'report') return 'To report it, run /bug, saying in your own words what this message shows.';
  if (failed === 'quarantine-ledger') {
    return "If the store's error says its data is damaged, nothing here repairs it: run /bug, saying in your own words what this message shows.";
  }
  return undefined;
}
