/**
 * The context curve page (/curve) and the retrieval trace page
 * (/debug/retrieval/view) are HTML held in template literals, which the web
 * UI serves as they are. A template literal takes the backslash escapes and
 * the ${} in its text: the \' that broke the curve page (#246) reached the
 * browser as a bare apostrophe, so its script didn't parse. A script that
 * doesn't parse never runs, and since a parse error never reaches the page's
 * own error line, the page stays on its loading line while the host logs
 * nothing. An escape that still parses, such as a regex's \s, would change a
 * script silently. So each page's text must be its template exactly as
 * written, and its inline script must parse.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { CURVE_PAGE_HTML } from '../src/modules/web-ui-curve-page.js';
import { RETRIEVAL_TRACE_PAGE_HTML } from '../src/modules/retrieval-trace-page.js';

const PAGES = [
  ['the context curve page', CURVE_PAGE_HTML, 'web-ui-curve-page.ts', 'CURVE_PAGE_HTML'],
  ['the retrieval trace page', RETRIEVAL_TRACE_PAGE_HTML, 'retrieval-trace-page.ts', 'RETRIEVAL_TRACE_PAGE_HTML'],
] as const;

const moduleSource = (file: string): string =>
  readFileSync(new URL(`../src/modules/${file}`, import.meta.url), 'utf8');

/** The text of the template literal `name` is exported as, as its module's
 *  source writes it: from the backtick after the export to the next one. Its
 *  line endings become \n, as a template literal's do, so a checkout with
 *  CRLF endings reads the same. */
function templateText(source: string, name: string): string {
  const text = source.replace(/\r\n?/g, '\n');
  const declaration = `\nexport const ${name} = \``;
  const at = text.indexOf(declaration);
  if (at === -1) throw new Error(`no line starts with: export const ${name} = \``);
  const open = at + declaration.length;
  return text.slice(open, text.indexOf('`', open));
}

/** The body of each inline script: one with no src attribute, since a
 *  browser ignores the body of a script with a src, even a bare or empty one.
 *  As in a browser, a script ends at `</script` followed by whitespace, `/`
 *  or `>`. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script[\s/>]/gi)]
    .filter((match) => !/(?:^|\s)src(?=[\s=/]|$)/i.test(match[1]))
    .map((match) => match[2]);
}

describe('pages served from a string', () => {
  for (const [name, html, file, constant] of PAGES) {
    test(`${name}'s text is its template as written: no backslash escape, no \${}`, () => {
      expect(html).toBe(templateText(moduleSource(file), constant));
    });

    test(`${name}'s inline script parses`, () => {
      const scripts = inlineScripts(html);
      expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) {
        expect(script.trim()).not.toBe('');
        // The Function constructor parses a script as a function body, without
        // running it. That's a little looser than a browser's parse of a
        // classic script, which also refuses a top-level return or new.target.
        // node:vm's Script would parse it as a classic script, but under bun
        // 1.3.14, CI's pin, it doesn't parse its source when it's constructed.
        expect(() => new Function(script)).not.toThrow();
      }
    });
  }

  test('a module saved with CRLF line endings reads as the same template', () => {
    const crlf = moduleSource('web-ui-curve-page.ts').replace(/\r?\n/g, '\r\n');
    expect(templateText(crlf, 'CURVE_PAGE_HTML')).toBe(CURVE_PAGE_HTML);
  });
});
