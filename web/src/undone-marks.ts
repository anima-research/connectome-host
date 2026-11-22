import type { UndoneMarksMessage } from '@conhost/web/protocol';

/** A transcript row as an undone-marks frame reads it. */
export interface MarkableRow {
  /** Its store id, which the frame names it by; a row only the page made has none. */
  storeId?: string;
  /** Its index in the record. */
  index?: number;
  /** Out of the conversation agent's window as undone. */
  undone?: boolean;
}

/**
 * Apply an undone-marks frame to the rows the page holds, in place: each row
 * from `fromIndex` on that the frame names is marked undone, and each it
 * doesn't name is unmarked. The host sends `fromIndex` 0, so this covers
 * every row the page holds, a history page's and a row that came in live
 * among them, wherever it is in the record.
 */
export function applyUndoneMarksTo(rows: MarkableRow[], marks: Pick<UndoneMarksMessage, 'fromIndex' | 'undone'>): void {
  const undone = new Set(marks.undone);
  for (const row of rows) {
    if (!row.storeId || typeof row.index !== 'number' || row.index < marks.fromIndex) continue;
    if (undone.has(row.storeId)) row.undone = true;
    else if (row.undone) delete row.undone;
  }
}
