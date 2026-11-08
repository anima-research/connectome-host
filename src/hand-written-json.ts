/**
 * Some editors, notably on Windows, save UTF-8 with a leading byte order
 * mark (U+FEFF). `readFileSync(…, 'utf-8')` keeps it, and `JSON.parse`
 * refuses it, with the mark invisible in the message and in the editor.
 */
export function parseHandWrittenJson(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}
