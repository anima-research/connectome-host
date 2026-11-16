/** The variable that names the file through which an install's command says its own lines to the person. */
export const SHOWN_FILE = 'CONNECTOME_SETUP_SHOWN';

// What a terminal acts on, or draws as nothing or as a space, rather than showing what it is: Unicode's control and
// format characters, its line and paragraph separators, each space but the ASCII one, the characters Unicode means to
// be drawn as nothing, and the blank braille cell, U+2800, which is drawn as a space.
const UNSHOWN = /(?! )[\p{Cc}\p{Cf}\p{Z}\p{Default_Ignorable_Code_Point}\u2800]/gu;

/** The line with each character a terminal would hide or act on shown as its code, such as \u001b. */
export function shown(line: string): string {
  return line.replace(UNSHOWN, (character) => {
    const hex = character.codePointAt(0)!.toString(16);
    return hex.length <= 4 ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`;
  });
}
