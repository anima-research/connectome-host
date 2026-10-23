/**
 * JSON a person writes by hand, or edits: the recipe, the MCPL servers file
 * and the agent overlay, the Anthropic credentials file and the observer
 * grants. Some editors, notably on Windows, save UTF-8 with a leading byte
 * order mark (U+FEFF). `readFileSync(…, 'utf-8')` keeps it, and `JSON.parse`
 * refuses it on Bun and Node alike ("Unrecognized token"), with the mark
 * invisible in the message and in the editor. So such a file reads as broken
 * though it looks right.
 *
 * Exactly one leading mark is skipped, as agent-framework does for
 * `gate.json` and the tool presentation file. A second is text, and the
 * parse refuses it as before. A file without the mark reads exactly as
 * `JSON.parse` reads it.
 */
export function parseHandWrittenJson(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}
