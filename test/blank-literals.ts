/**
 * Test helper: blank the text of a source's literals, so a scan over code
 * doesn't read a call's shape inside a string, a template or a regular
 * expression. Used by test/direct-context-writes.test.ts and
 * test/web-ui-observers.test.ts.
 */

const KEYWORDS_BEFORE_AN_EXPRESSION = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/** `code` with the text of each string literal, template and regular
 *  expression blanked, each character a space (line breaks kept), so a
 *  call's shape inside one isn't found; a template's `${…}` stays code. */
export function blankLiterals(code: string): string {
  const out = code.split('');
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  // A `/` opens a regular expression where an expression can start: after an
  // operator or punctuation, or a keyword such as `return`; after a name, a
  // number, `)`, `]`, a postfix `++` or `--`, or a literal's closing quote
  // or backtick (a `/` inside one is the literal's, so one before it closes
  // it) it divides.
  const opensRegExp = (at: number): boolean => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(code[k]!)) k--;
    if (k < 0) return true;
    if (')]`\'"'.includes(code[k]!)) return false;
    if (k > 0 && (code.slice(k - 1, k + 1) === '++' || code.slice(k - 1, k + 1) === '--')) return false;
    if (!/[\w$]/.test(code[k]!)) return true;
    let from = k;
    while (from > 0 && /[\w$]/.test(code[from - 1]!)) from--;
    return KEYWORDS_BEFORE_AN_EXPRESSION.has(code.slice(from, k + 1));
  };
  const quoted = (at: number): number => {
    let k = at + 1;
    while (k < code.length && code[k] !== code[at]) k += code[k] === '\\' ? 2 : 1;
    blank(at + 1, k);
    return k + 1;
  };
  const regExp = (at: number): number => {
    let k = at + 1;
    let inClass = false;
    while (k < code.length && code[k] !== '\n' && (inClass || code[k] !== '/')) {
      if (code[k] === '[') inClass = true;
      else if (code[k] === ']') inClass = false;
      k += code[k] === '\\' ? 2 : 1;
    }
    blank(at + 1, k);
    return k + 1;
  };
  const template = (at: number): number => {
    let k = at + 1;
    while (k < code.length && code[k] !== '`') {
      if (code[k] === '$' && code[k + 1] === '{') { k = codeFrom(k + 2, true); continue; }
      const step = code[k] === '\\' ? 2 : 1;
      blank(k, k + step);
      k += step;
    }
    return k + 1;
  };
  /** Past the code from `at`: to the end, or (`inner`) past the `}` that closes a template's `${`. */
  function codeFrom(at: number, inner: boolean): number {
    let depth = 0;
    let k = at;
    while (k < code.length) {
      const c = code[k]!;
      if (c === '"' || c === "'") k = quoted(k);
      else if (c === '`') k = template(k);
      else if (c === '/' && code[k + 1] === '*') k = code.includes('*/', k + 2) ? code.indexOf('*/', k + 2) + 2 : code.length;
      else if (c === '/' && code[k + 1] === '/') k = code.includes('\n', k) ? code.indexOf('\n', k) : code.length;
      else if (c === '/' && opensRegExp(k)) k = regExp(k);
      else {
        if (c === '{') depth++;
        else if (c === '}' && inner && depth-- === 0) return k + 1;
        k++;
      }
    }
    return k;
  }
  codeFrom(0, false);
  return out.join('');
}
