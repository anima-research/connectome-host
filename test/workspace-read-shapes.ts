/**
 * agent-framework's workspace `read` answers with the page as text blocks in
 * `data` and its fields in `structured`; a result may also carry the fields in
 * `data` itself.
 */
export const READ_PAGE = '     1\tfirst line\n     2\tsecond, with "quotes"';

export const READ_FIELDS = { path: 'work/notes.txt', totalLines: 3, fromLine: 1, toLine: 2, content: READ_PAGE };

export const readResultShapes = {
  data: { success: true, data: READ_FIELDS },
  structured: {
    success: true,
    data: [
      { type: 'text', text: 'work/notes.txt, lines 1–2 of 3; continue with offset 3' },
      { type: 'text', text: READ_PAGE },
    ],
    structured: READ_FIELDS,
  },
} as const;
