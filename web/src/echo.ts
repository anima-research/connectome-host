/** Ids `nextMessageId()` makes (`m<n>`): rows this client made itself, not
 *  ones the host stored. */
export const isSyntheticId = (id: string): boolean => /^m\d+$/.test(id);

export function newCorrId(): string {
  // crypto.randomUUID needs a secure context; a page served over plain http has getRandomValues.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface Place {
  session: { id: string; name: string };
  branch: { id: string; name: string };
}

export function placeOf(w: { session: { id: string; name?: string }; branch: { id: string; name?: string } }): Place {
  return {
    session: { id: w.session.id, name: w.session.name || w.session.id },
    branch: { id: w.branch.id, name: w.branch.name || w.branch.id },
  };
}

export function placeLabel(sentIn: Place | undefined, here: Place): string | undefined {
  if (!sentIn) return undefined;
  if (sentIn.session.id !== here.session.id) return `session ${sentIn.session.name}, branch ${sentIn.branch.name}`;
  if (sentIn.branch.id !== here.branch.id) return `branch ${sentIn.branch.name}`;
  return undefined;
}

export interface SentRow {
  id: string;
  corrId?: string;
  unsent?: 'refused' | 'unconfirmed';
  refusal?: string;
  sentIn?: Place;
  earlier?: string;
}

export function sentRowIndex(rows: ReadonlyArray<SentRow>, corrId: string | undefined): number {
  if (!corrId) return -1;
  return rows.findIndex((r) => r.corrId === corrId && isSyntheticId(r.id));
}

export function settleRefusal(rows: SentRow[], corrId: string, composerEmpty: boolean, reason?: string): boolean {
  const i = sentRowIndex(rows, corrId);
  if (i < 0) return false;
  if (composerEmpty) {
    rows.splice(i, 1);
    return true;
  }
  rows[i]!.unsent = 'refused';
  if (reason) rows[i]!.refusal = reason;
  return false;
}

function keptSends<R extends SentRow>(rows: ReadonlyArray<R>, window: ReadonlyArray<R>, here: Place): R[] {
  const welcomed = new Set(window.map((m) => m.corrId).filter((c) => c !== undefined));
  return rows
    .filter((m) => isSyntheticId(m.id) && m.corrId !== undefined && !welcomed.has(m.corrId))
    .map((m) => ({
      ...m,
      unsent: m.unsent ?? ('unconfirmed' as const),
      earlier: placeLabel(m.sentIn, here),
    }));
}

/**
 * Mark every send still waiting for its echo not confirmed, as a welcome this
 * client can't read leaves it: the reload that welcome asks for drops the row.
 */
export function markUnconfirmed(rows: SentRow[]): void {
  for (const r of rows) {
    if (isSyntheticId(r.id) && r.corrId !== undefined && !r.unsent) r.unsent = 'unconfirmed';
  }
}

export function rowsAfterWelcome<R extends SentRow & { index?: number }>(
  rows: ReadonlyArray<R>,
  window: ReadonlyArray<R>,
  startIndex: number,
  here: Place,
): R[] {
  const before = rows.filter((m) => typeof m.index === 'number' && m.index < startIndex && !isSyntheticId(m.id));
  return [...before, ...window, ...keptSends(rows, window, here)];
}

export function rowsAfterReset<R extends SentRow>(rows: ReadonlyArray<R>, window: ReadonlyArray<R>, here: Place): R[] {
  return [...window, ...keptSends(rows, window, here)];
}

export function settleByEntries(rows: SentRow[], entries: ReadonlyArray<{ corrId?: string }>): void {
  for (const e of entries) {
    const i = sentRowIndex(rows, e.corrId);
    if (i >= 0) rows.splice(i, 1);
  }
}

/** The host's reason for a refusal, without its leading "message not sent: ". */
const hostReason = (refusal?: string): string | undefined => refusal?.replace(/^message not sent:\s*/, '');

/** The composer's note for a refused send put back into it, with the host's reason. */
export function refusedNote(refusal?: string): string {
  const reason = hostReason(refusal);
  return `not sent: the host refused it${reason ? ` (${reason})` : ''}; the message is back here`;
}

export function unsentMark(row: SentRow): string | null {
  if (!row.unsent) return null;
  const reason = hostReason(row.refusal);
  const mark = row.unsent === 'refused'
    ? `not sent: the host refused it${reason ? ` (${reason})` : ''}`
    : 'not confirmed: it may not have reached the host';
  return row.earlier ? `${mark}; sent in ${row.earlier}` : mark;
}
