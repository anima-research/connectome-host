export const SHOWN_FILE = 'CONNECTOME_SETUP_SHOWN';

// What a terminal acts on, or draws as nothing or as a space, rather than showing what it is: Unicode's control and
// format characters (tab, CR, ESC, C1, the marks that reorder text, zero-width characters), its line and paragraph
// separators, each space but the ASCII one, since another looks like it while bash reads it as part of a word, the
// characters Unicode means to be drawn as nothing (Default_Ignorable_Code_Point: the variation selectors, the Hangul
// fillers, U+034F), and the blank braille cell, U+2800, which is drawn as a space.
const UNSHOWN = /(?! )[\p{Cc}\p{Cf}\p{Z}\p{Default_Ignorable_Code_Point}\u2800]/gu;

export function shown(line: string): string {
  return line.replace(UNSHOWN, (character) => {
    const hex = character.codePointAt(0)!.toString(16);
    return hex.length <= 4 ? `\\u${hex.padStart(4, '0')}` : `\\u{${hex}}`;
  });
}

export function commandsShownNote(dir: string): string {
  return `Setup's agent runs each command in ${shown(dir)}, as you. You'll see each command whole as it starts. It ` +
    'doesn\'t wait for you. Each of its lines is on a line of its own, any character a terminal would hide or act on is ' +
    'shown as a code, such as \\u001b for Escape, and each key or token setup knows of is shown by its name in place of ' +
    'its value, such as <ANTHROPIC_API_KEY>.';
}
