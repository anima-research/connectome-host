/**
 * Matching the host's echo of a message typed here to the row shown for it
 * when it was sent.
 */

/** Ids `nextMessageId()` makes (`m<n>`): rows this client made itself, not
 *  ones the host stored. */
export const isSyntheticId = (id: string): boolean => /^m\d+$/.test(id);

interface Row {
  id: string;
  participant: string;
  text: string;
  blocks?: ReadonlyArray<{ kind: string }>;
}

const mediaCount = (row: Row): number => (row.blocks ?? []).filter((b) => b.kind === 'media').length;

/**
 * The row a stored user message is the echo of, or -1. The host stores the
 * messages it accepts in the order they were sent (its framework takes events
 * one at a time), and a message it refuses has its row taken out when the
 * refusal arrives, by `corrId`. So an echo belongs to the OLDEST row still
 * waiting that matches it: matching newest first would swap two sends that
 * look alike, such as two messages of images alone.
 */
export function pendingEchoIndex(rows: ReadonlyArray<Row>, incoming: Row, window = 12): number {
  for (let i = Math.max(0, rows.length - window); i < rows.length; i++) {
    const r = rows[i]!;
    if (
      r.participant === 'user'
      && isSyntheticId(r.id)
      && r.text === incoming.text
      && mediaCount(r) === mediaCount(incoming)
    ) return i;
  }
  return -1;
}
