/**
 * A template literal takes the backslash escapes and the ${} in its text, and a
 * script that doesn't parse never runs.
 */
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { describe, expect, test } from 'bun:test';
import { CURVE_PAGE_HTML } from '../src/modules/web-ui-curve-page.js';
import { RETRIEVAL_TRACE_PAGE_HTML } from '../src/modules/retrieval-trace-page.js';

const PAGES = [
  ['the context curve page', CURVE_PAGE_HTML, 'web-ui-curve-page.ts', 'CURVE_PAGE_HTML'],
  ['the retrieval trace page', RETRIEVAL_TRACE_PAGE_HTML, 'retrieval-trace-page.ts', 'RETRIEVAL_TRACE_PAGE_HTML'],
] as const;

const moduleSource = (file: string): string =>
  readFileSync(new URL(`../src/modules/${file}`, import.meta.url), 'utf8');

/** A template literal's line endings become \n, whatever the source's. */
function templateText(source: string, name: string): string {
  const text = '\n' + source.replace(/\r\n?/g, '\n');
  const declaration = `\nexport const ${name} = \``;
  const at = text.indexOf(declaration);
  if (at === -1) throw new Error(`no line starts with: export const ${name} = \``);
  const open = at + declaration.length;
  return text.slice(open, text.indexOf('`', open));
}

/** A browser ignores the body of a script with a src, even a bare or empty one,
 *  and ends a script at `</script` followed by whitespace, `/` or `>`. */
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
        // node:vm's Script parses its source as a classic script when it's
        // constructed, without running it.
        expect(() => new Script(script)).not.toThrow();
      }
    });
  }

  test('a module saved with CRLF line endings reads as the same template', () => {
    const crlf = moduleSource('web-ui-curve-page.ts').replace(/\r?\n/g, '\r\n');
    expect(templateText(crlf, 'CURVE_PAGE_HTML')).toBe(CURVE_PAGE_HTML);
  });
});
