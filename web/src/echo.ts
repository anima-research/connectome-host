/**
 * A message typed here and the row shown for it when it was sent, found again
 * by its send's `corrId`: when the host's echo of it arrives, when the host
 * refuses it, when a history page brings its stored copy, and when a welcome
 * replaces the transcript.
 *
 * Only a send, a user message sent with its `corrId`, is followed this way.
 * A routed message's row carries none, since the host routes it to the child
 * and no echo of it comes here, so it gives way with the other rows this
 * client made (command output, triggers).
 *
 * The composer relies on the host carrying the `corrId` back on the stored
 * message's entry. A host from before that, as under `bun run dev` against an
 * older running host, shows each send twice until a reload, and after a
 * reconnect marks this client's copy 'not confirmed' beside the stored one.
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

/** A session and a branch, each by id, with the name a mark gives it: where
 *  a send was made, or what a welcome is for. */
export interface Place {
  session: { id: string; name: string };
  branch: { id: string; name: string };
}

/** The place a welcome is for, naming each part by its name or, without
 *  one, its id. */
export function placeOf(w: { session: { id: string; name?: string }; branch: { id: string; name?: string } }): Place {
  return {
    session: { id: w.session.id, name: w.session.name || w.session.id },
    branch: { id: w.branch.id, name: w.branch.name || w.branch.id },
  };
}

/** What a kept send's mark names when it was sent somewhere other than
 *  `here`: its session and branch when the session differs, or else its
 *  branch. A send with no recorded place, made before any welcome, names
 *  none. */
export function placeLabel(sentIn: Place | undefined, here: Place): string | undefined {
  if (!sentIn) return undefined;
  if (sentIn.session.id !== here.session.id) return `session ${sentIn.session.name}, branch ${sentIn.branch.name}`;
  if (sentIn.branch.id !== here.branch.id) return `branch ${sentIn.branch.name}`;
  return undefined;
}

export interface SentRow {
  id: string;
  /** On a row typed here, and on a stored message's entry: the send's
   *  `corrId`. */
  corrId?: string;
  /** On a row typed here that no echo has replaced: `refused`, when the host
   *  refused it while the composer held another draft; `unconfirmed`, when a
   *  welcome didn't hold it, so it may not have reached the host. */
  unsent?: 'refused' | 'unconfirmed';
  /** On a refused row: the host's reason. */
  refusal?: string;
  /** On a row typed here: where it was sent, as the composer knew it then. A
   *  send the host took after switching sessions, before this client's
   *  welcome for the new one, names the old session, and one it took after
   *  switching branches, before branch-changed reached this client, the old
   *  branch: the frames carry no place. Its echo replaces the row either
   *  way. */
  sentIn?: Place;
  /** On a kept send whose recorded place isn't the latest welcome's: that
   *  place, as its mark names it (placeLabel). */
  earlier?: string;
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
 * there. With a draft in the composer, the row stays, marked refused with the
 * host's reason, so the message isn't lost. False when no row is the send's.
 */
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

/**
 * The sends typed here that a welcome's window doesn't hold, to keep after
 * it: a refused one keeps its mark, and any other is marked unconfirmed,
 * since its frame may not have reached the host. An echo that arrives later
 * still replaces it. Each names the place it was sent in where that isn't
 * `here`, the welcome's.
 */
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
 * The rows a welcome for the same session and branch leaves, as after a
 * reconnect: the paged-in scrollback before its window, the window, and the
 * sends kept after it (keptSends), each naming the place it was sent in
 * where that isn't `here`, the welcome's.
 */
export function rowsAfterWelcome<R extends SentRow & { index?: number }>(
  rows: ReadonlyArray<R>,
  window: ReadonlyArray<R>,
  startIndex: number,
  here: Place,
): R[] {
  const before = rows.filter((m) => typeof m.index === 'number' && m.index < startIndex && !isSyntheticId(m.id));
  return [...before, ...window, ...keptSends(rows, window, here)];
}

/**
 * The rows a welcome for another session or branch leaves, or the first
 * welcome: its window, and the sends kept after it (keptSends), each naming
 * the place it was sent in where that isn't `here`, the welcome's.
 */
export function rowsAfterReset<R extends SentRow>(rows: ReadonlyArray<R>, window: ReadonlyArray<R>, here: Place): R[] {
  return [...window, ...keptSends(rows, window, here)];
}

/**
 * Take out of `rows`, which it changes, each send typed here whose stored
 * copy is among `entries`, as from a history page: the stored copy stands in
 * its place in the history.
 */
export function settleByEntries(rows: SentRow[], entries: ReadonlyArray<{ corrId?: string }>): void {
  for (const e of entries) {
    const i = sentRowIndex(rows, e.corrId);
    if (i >= 0) rows.splice(i, 1);
  }
}

/** What a kept send's row says of it, or null for a row that isn't kept. The
 *  host's image refusals begin 'message not sent: ', which the mark says
 *  already. */
export function unsentMark(row: SentRow): string | null {
  if (!row.unsent) return null;
  const reason = row.refusal?.replace(/^message not sent:\s*/, '');
  const mark = row.unsent === 'refused'
    ? `not sent: the host refused it${reason ? ` (${reason})` : ''}`
    : 'not confirmed: it may not have reached the host';
  return row.earlier ? `${mark}; sent in ${row.earlier}` : mark;
}
