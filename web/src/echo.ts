/**
 * A message typed here and the row shown for it when it was sent, found again
 * by its send's `corrId`: when the host's echo of it arrives, when the host
 * refuses it, and when a reconnect's welcome replaces the transcript's tail.
 */

/** Ids `nextMessageId()` makes (`m<n>`): rows this client made itself, not
 *  ones the host stored. */
export const isSyntheticId = (id: string): boolean => /^m\d+$/.test(id);

/**
 * A send's `corrId`. The host stores it with the message, and the message's
 * entry goes to every client, so it has to be unique across clients, not a
 * per-client counter. Made from `crypto.getRandomValues`, which, unlike
 * `crypto.randomUUID`, a page served over plain http also has.
 */
export function newCorrId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SentRow {
  id: string;
  /** On a row typed here, and on a stored message's entry: the send's
   *  `corrId`. */
  corrId?: string;
  /** On a row typed here that no echo has replaced: `refused`, when the host
   *  refused it while the composer held another draft; `unconfirmed`, when a
   *  reconnect's welcome didn't hold it, so it may not have reached the host. */
  unsent?: 'refused' | 'unconfirmed';
}

/**
 * The row this client showed for the send `corrId` names, or -1: a row it
 * made itself (a stored row carrying the same `corrId` is the message already
 * in place). Nothing else about the message is compared, so an echo whose
 * text the host shortened, and another client's message that looks the same,
 * each find exactly the row whose send they are, or none.
 */
export function sentRowIndex(rows: ReadonlyArray<SentRow>, corrId: string | undefined): number {
  if (!corrId) return -1;
  return rows.findIndex((r) => r.corrId === corrId && isSyntheticId(r.id));
}

/**
 * Settle a send the host refused, in `rows`, which it changes. With the
 * composer empty, the row comes out, and true says to put the message back
 * there. With another draft in the composer, the row stays, marked refused,
 * so the message isn't lost. False when no row is the send's.
 */
export function settleRefusal(rows: SentRow[], corrId: string, composerEmpty: boolean): boolean {
  const i = sentRowIndex(rows, corrId);
  if (i < 0) return false;
  if (composerEmpty) {
    rows.splice(i, 1);
    return true;
  }
  rows[i]!.unsent = 'refused';
  return false;
}

/**
 * The rows a reconnect's welcome leaves, for the same session and branch:
 * the paged-in scrollback before its window, the window, and then each row
 * typed here that no echo replaced and the window doesn't hold. A refused
 * row keeps its mark; any other is marked unconfirmed, since its frame may
 * not have reached the host, and an echo that arrives later still replaces
 * it. Other rows this client made (command output, triggers) give way to the
 * window.
 */
export function rowsAfterWelcome<R extends SentRow & { index?: number }>(
  rows: ReadonlyArray<R>,
  window: ReadonlyArray<R>,
  startIndex: number,
): R[] {
  const before = rows.filter((m) => typeof m.index === 'number' && m.index < startIndex && !isSyntheticId(m.id));
  const welcomed = new Set(window.map((m) => m.corrId).filter((c) => c !== undefined));
  const unsettled = rows
    .filter((m) => isSyntheticId(m.id) && m.corrId !== undefined && !welcomed.has(m.corrId))
    .map((m) => (m.unsent ? m : { ...m, unsent: 'unconfirmed' as const }));
  return [...before, ...window, ...unsettled];
}
