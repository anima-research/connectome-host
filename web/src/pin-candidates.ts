/**
 * The local pin picker's candidates, each with the whole text of its row
 * where the transcript has that row loaded. The host cuts a candidate's
 * text at 160 characters, and the picker filters on it, so a phrase past
 * those found nothing. The host still decides which rows are offered: it
 * leaves out the rows a pin would hold nothing on, which the transcript
 * doesn't tell apart.
 */
export function withLoadedText<C extends { id: string; text: string }>(
  candidates: C[],
  rows: Iterable<{ storeId?: string; text: string }>,
): C[] {
  const loaded = new Map<string, string>();
  for (const row of rows) if (row.storeId) loaded.set(row.storeId, row.text);
  return candidates.map((c) => {
    const text = loaded.get(c.id);
    return text === undefined || text === c.text ? c : { ...c, text };
  });
}
