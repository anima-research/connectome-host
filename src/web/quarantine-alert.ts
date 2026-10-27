/**
 * context-manager's quarantine status counts records (`count`), and one span
 * can hold several.
 */
export interface QuarantineCounts {
  count?: number;
  spans?: readonly unknown[];
}

/** The status context-manager's quarantine alarm hands its handler. */
export interface QuarantineStatus {
  count: number;
  keys: string[];
  spans?: readonly unknown[];
}

export function quarantineSpans(q: QuarantineCounts): number | undefined {
  if (!Array.isArray(q.spans)) return undefined;
  const records = q.count ?? 0;
  const spans = q.spans.length;
  const fits = records > 0 ? spans >= 1 && spans <= records : spans === 0;
  return fits ? spans : undefined;
}

export function quarantineHeld(q: QuarantineCounts): string {
  const records = q.count ?? 0;
  const spans = quarantineSpans(q);
  return spans !== undefined
    ? `${spans} span(s) in compression quarantine (${records} record(s))`
    : `${records} quarantine record(s) in compression quarantine (one span can hold several)`;
}

/** context-manager's quarantine alarm calls with records held at every
 *  alarm interval, and once with none when an episode it alarmed for in this
 *  process ends (an episode alarmed before a restart gets no all-clear). The
 *  all-clear goes under a kind of its own, so agent-framework's webhook
 *  cooldown for the alarm's kind can't swallow it. */
export function quarantineAlarm(status: QuarantineStatus): { kind: string; message: string; data: Record<string, unknown> } {
  if (status.count === 0) {
    return {
      kind: 'compression-quarantine-clear',
      message: 'compression quarantine EMPTY — all debt paid; alarm stands down.',
      data: { count: 0 },
    };
  }
  return {
    kind: 'compression-quarantine',
    message: `${quarantineHeld(status)} — spans stay raw and WILL eventually exhaust the context budget. ` +
      'Operator action required (inspect refusing content; branch, pin, or clear).',
    data: { count: status.count, keys: status.keys },
  };
}
