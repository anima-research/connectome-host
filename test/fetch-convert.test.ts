import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decodeText, htmlToMarkdown, isHtmlPath, looksBinary, looksLikeScriptShell, mediaType } from '../src/modules/fetch-convert.js';
import { FetchRefusal } from '../src/modules/fetch-http.js';

const page = (body: string, head = ''): string => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe('htmlToMarkdown', () => {
  test('keeps what a reader sees, and drops what only a browser uses', async () => {
    const markdown = await htmlToMarkdown(page(
      `<h1>KEEP_H1</h1><!-- DROP_COMMENT --><p>KEEP_P</p><nav>KEEP_NAV</nav><footer>KEEP_FOOTER</footer>
       <pre><code>KEEP_CODE</code></pre>
       <input value="DROP_INPUT" placeholder="DROP_PLACEHOLDER"><span title="DROP_TITLEATTR">KEEP_SPAN</span>
       <svg><text>DROP_SVG</text></svg><template>DROP_TEMPLATE</template><iframe src="https://x.test/DROP_IFRAME"></iframe>`,
      `<title>KEEP_TITLE</title><meta name="description" content="DROP_META"><style>.x{content:"DROP_STYLE"}</style><script>var a="DROP_SCRIPT";</script>`,
    ), 'https://x.test/');
    for (const kept of ['KEEP_TITLE', 'KEEP_H1', 'KEEP_P', 'KEEP_NAV', 'KEEP_FOOTER', 'KEEP_CODE', 'KEEP_SPAN']) {
      expect(markdown).toContain(kept);
    }
    expect(markdown).not.toContain('DROP');
    expect(markdown).toContain('# KEEP_H1');
  });

  test('scripts do not run', async () => {
    const markdown = await htmlToMarkdown(page(
      `<p id="t">NOT_RUN</p><script>document.getElementById('t').textContent='RAN'</script>`,
    ), undefined);
    expect(markdown).toContain('NOT_RUN');
    expect(markdown).not.toContain('RAN');
  });

  const HIDING = [
    ['the hidden attribute', 'hidden'],
    ['aria-hidden', 'aria-hidden="true"'],
    ['display:none', 'style="display:none"'],
    ['display : none among other styles', 'style="color:red; display : none"'],
    ['visibility:hidden', 'style="visibility:hidden"'],
  ] as const;

  test.each(HIDING)('text hidden by %s, where instructions to a model tend to hide, is dropped', async (_label, how) => {
    const markdown = await htmlToMarkdown(page(`<p>shown</p><div ${how}><p><b>HIDDEN_TEXT</b></p></div>`), undefined);
    expect(markdown).toContain('shown');
    expect(markdown).not.toContain('HIDDEN');
  });

  // Every kind of element that has a conversion rule of its own, since a rule
  // used to win over the hiding check, and only div, span and pre were dropped.
  test.each([
    ['p'], ['h1'], ['h2'], ['h6'], ['ul', '<li>HIDDEN_TEXT</li>'], ['ol', '<li>HIDDEN_TEXT</li>'], ['a'], ['strong'], ['b'], ['em'], ['i'], ['code'], ['pre'],
    ['blockquote'], ['div'], ['span'], ['section'], ['table', '<tr><td>HIDDEN_TEXT</td></tr>'],
  ])('a hidden <%s> is dropped', async (tag, inner = 'HIDDEN_TEXT') => {
    const markdown = await htmlToMarkdown(page(`<p>shown</p><${tag} hidden>${inner}</${tag}>`), undefined);
    expect(markdown).toBe('shown');
  });

  test.each([
    ['<li>', '<ul><li>shown</li><li hidden>HIDDEN_TEXT</li></ul>'],
    ['<tr>', '<table><tr><td>shown</td><td>too</td></tr><tr hidden><td>HIDDEN_TEXT</td><td>x</td></tr></table>'],
    ['<td>', '<table><tr><td>shown</td><td hidden>HIDDEN_TEXT</td></tr></table>'],
    ['<img>', '<p>shown</p><img hidden alt="HIDDEN_TEXT" src="https://x.test/i.png">'],
  ])('a hidden %s is dropped', async (_tag, html) => {
    const markdown = await htmlToMarkdown(page(html), undefined);
    expect(markdown).toContain('shown');
    expect(markdown).not.toContain('HIDDEN');
  });

  test('an element that only mentions display:none in a value is kept', async () => {
    const markdown = await htmlToMarkdown(page('<div style="background:url(display:none.png)">SHOWN</div>'), undefined);
    expect(markdown).toContain('SHOWN');
  });

  test('text comes through as written, with nothing escaped for a markdown renderer', async () => {
    const markdown = await htmlToMarkdown(page('<p>snake_case and *stars* and [1706.03762] and 1. first and a\\b</p>'), undefined);
    expect(markdown).toBe('snake_case and *stars* and [1706.03762] and 1. first and a\\b');
  });

  test('a table keeps its columns', async () => {
    const markdown = await htmlToMarkdown(page(
      `<table>
         <thead><tr><th>Name</th><th>Age</th></tr></thead>
         <tbody><tr><td>Ada</td><td>36</td></tr><tr><td>Lin | Lee</td><td><b>41</b></td></tr></tbody>
       </table>`,
    ), undefined);
    expect(markdown.trim()).toBe(
      '| Name | Age |\n| --- | --- |\n| Ada | 36 |\n| Lin \\| Lee | **41** |',
    );
  });

  test('a cell whose text already reads \\| stays apart from a bar the cell escaped, and other backslashes stay as they are', async () => {
    const markdown = await htmlToMarkdown(page(
      '<table><tr><td>k</td><td>v</td></tr><tr><td>a\\|b</td><td>C:\\Users\\ada</td></tr><tr><td>x\\\\|y</td><td>ends\\</td></tr></table>',
    ), undefined);
    expect(markdown).toBe(
      '| k | v |\n| --- | --- |\n| a\\\\\\|b | C:\\Users\\ada |\n| x\\\\\\\\\\|y | ends\\ |',
    );
  });

  test('a table with no thead gets its header line after the first row', async () => {
    const markdown = await htmlToMarkdown(page('<p>before</p><table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table><p>after</p>'), undefined);
    expect(markdown).toBe('before\n\n| a | b |\n| --- | --- |\n| c | d |\n\nafter');
  });

  test('a single-column table reads as blocks, not as rows', async () => {
    const markdown = await htmlToMarkdown(page('<table><tr><td>one</td></tr><tr><td>two</td></tr></table>'), undefined);
    expect(markdown).toBe('one\n\ntwo');
  });

  test('a table holding tables is layout: it reads as blocks, and the table inside it stays a table', async () => {
    const markdown = await htmlToMarkdown(page(
      '<table><tr><td>Site name</td><td><table><tr><td>a</td><td>b</td></tr></table></td></tr></table>',
    ), undefined);
    expect(markdown).toBe('Site name\n\n| a | b |\n| --- | --- |');
  });

  test('a table whose first row spans the columns gets a header line as wide as the table', async () => {
    const markdown = await htmlToMarkdown(page('<table><tr><th colspan="2">Title</th></tr><tr><td>k</td><td>v</td></tr></table>'), undefined);
    expect(markdown).toBe('| Title |\n| --- | --- |\n| k | v |');
  });

  test('a decorative image, marked by its empty alt, leaves nothing, nor does a link around it', async () => {
    const markdown = await htmlToMarkdown(page('<p>text</p><img src="/spacer.gif" alt=""><a href="/x"><img src="/logo.svg" alt=""></a><img src="/noalt.png">'), 'https://x.test/');
    expect(markdown).toBe('text');
  });

  test('links and images resolve against the page, so they can be followed', async () => {
    const markdown = await htmlToMarkdown(page(
      '<a href="/docs/a">root</a> <a href="b#c">sibling</a> <a href="https://other.test/d">other</a> <img src="/i.png" alt="pic">',
    ), 'https://x.test/base/page.html');
    expect(markdown).toContain('[root](https://x.test/docs/a)');
    expect(markdown).toContain('[sibling](https://x.test/base/b#c)');
    expect(markdown).toContain('[other](https://other.test/d)');
    expect(markdown).toContain('![pic](https://x.test/i.png)');
  });

  test('a link in a local file, with no page to resolve against, stays as written', async () => {
    const markdown = await htmlToMarkdown(page('<a href="other.html">next</a>'), undefined);
    expect(markdown).toContain('[next](other.html)');
  });

  test('a link that would run something keeps its text and loses its address', async () => {
    const markdown = await htmlToMarkdown(page('<a href="javascript:alert(1)">click</a> <a href="data:text/html,x">data</a>'), 'https://x.test/');
    expect(markdown).toContain('click');
    expect(markdown).toContain('data');
    expect(markdown).not.toContain('javascript');
    expect(markdown).not.toContain('data:');
  });

  test('an image embedded as data keeps its alt text and not its megabytes', async () => {
    const markdown = await htmlToMarkdown(page(`<img alt="chart" src="data:image/png;base64,${'A'.repeat(200_000)}">`), 'https://x.test/');
    expect(markdown).toBe('chart');
  });

  test('an address too long to be useful keeps its text and loses the address', async () => {
    const markdown = await htmlToMarkdown(page(`<a href="/${'x'.repeat(3_000)}">read</a>`), 'https://x.test/');
    expect(markdown).toBe('read');
  });

  test('deep nesting fails as a refusal instead of taking the process down', async () => {
    const error = await htmlToMarkdown('<div>'.repeat(10_000) + 'x', undefined).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(FetchRefusal);
  });
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return !isAlive(pid);
}

describe('the converting process', () => {
  // Each of these took a thread that terminate() couldn't stop, or would have
  // run for minutes to hours, so each is refused only if the process really dies.
  test.each([
    ['nested elements', () => '<div>'.repeat(200_000) + 'x'],
    // A quadratic regular expression: a compiled one, which a worker thread can't be stopped in.
    ['a long run of spaces in <pre>', () => `<pre>${' '.repeat(2_000_000)}x</pre>`],
  ])('%s past the time limit is killed, and the host keeps running meanwhile', async (_label, html) => {
    let ticks = 0;
    const ticker = setInterval(() => { ticks++; }, 20);
    let child: ChildProcess | undefined;
    const started = Date.now();
    const error = await htmlToMarkdown(html(), undefined, { timeoutMs: 1_000, onChild: (c) => { child = c; } }).then(() => null, (e: unknown) => e);
    clearInterval(ticker);
    expect(error).toBeInstanceOf(FetchRefusal);
    expect((error as Error).message).toContain('more than 1 seconds');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(ticks).toBeGreaterThan(20);
    expect(await gone(child!.pid!, 2_000)).toBe(true);
  }, 15_000);

  test('a page past the memory limit is killed before it gets there', async () => {
    let child: ChildProcess | undefined;
    const error = await htmlToMarkdown('<p>'.repeat(3_000_000), undefined, { memoryLimitBytes: 300 * 1024 * 1024, onChild: (c) => { child = c; } }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(FetchRefusal);
    expect((error as Error).message).toContain('more memory or time');
    expect(await gone(child!.pid!, 2_000)).toBe(true);
  }, 30_000);

  test('an ordinary page is well inside those limits', async () => {
    const html = page('<div><p>Some <b>text</b> and a <a href="/x">link</a>.</p></div>\n'.repeat(20_000));
    const markdown = await htmlToMarkdown(html, 'https://x.test/');
    expect(markdown).toContain('[link](https://x.test/x)');
  }, 20_000);

  test('at most two run at once, and the rest wait their turn', async () => {
    let alive = 0;
    let most = 0;
    const seen: number[] = [];
    const onChild = (child: ChildProcess) => {
      alive++;
      most = Math.max(most, alive);
      seen.push(child.pid!);
      child.once('close', () => { alive--; });
    };
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => htmlToMarkdown(page(`<p>page ${i}</p>`), undefined, { onChild })));
    expect(results.map((r) => r.trim())).toEqual([0, 1, 2, 3, 4, 5].map((i) => `page ${i}`));
    expect(seen).toHaveLength(6);
    expect(most).toBe(2);
  }, 20_000);

  test('a refused conversion gives up its turn', async () => {
    await Promise.all(Array.from({ length: 3 }, () => htmlToMarkdown('<div>'.repeat(200_000) + 'x', undefined, { timeoutMs: 100 }).catch(() => null)));
    expect((await htmlToMarkdown(page('<p>next</p>'), undefined)).trim()).toBe('next');
  }, 15_000);

  test('holds none of the host\'s environment, and reads no .env file', async () => {
    process.env.FETCH_CANARY_SECRET = 'do-not-inherit';
    const shows = async (pid: number) => new TextDecoder().decode(Bun.spawnSync(['ps', 'eww', '-o', 'command=', '-p', String(pid)]).stdout).includes('FETCH_CANARY_SECRET');
    try {
      // This way of looking does show an inherited variable, or its silence
      // would mean nothing. The same program as the child, since macOS hides the
      // environment of its own programs, such as sleep, from ps.
      const control = Bun.spawn([process.execPath, '-e', 'await Bun.sleep(5000)'], { env: process.env });
      await new Promise((done) => setTimeout(done, 100));
      const controlShows = await shows(control.pid);
      control.kill();
      expect(controlShows).toBe(true);

      let child: ChildProcess | undefined;
      const running = htmlToMarkdown('<div>'.repeat(200_000) + 'x', undefined, { timeoutMs: 1_500, onChild: (c) => { child = c; } }).catch(() => null);
      await new Promise((done) => setTimeout(done, 300));
      expect(child!.spawnargs).toContain('--no-env-file');
      expect(await shows(child!.pid!)).toBe(false);
      await running;
    } finally {
      delete process.env.FETCH_CANARY_SECRET;
    }
  }, 15_000);

  test('does not keep the host from exiting, and does not outlive it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fetch-orphan-'));
    const script = join(dir, 'host.ts');
    writeFileSync(script, `
      import { htmlToMarkdown } from ${JSON.stringify(resolve('src/modules/fetch-convert.ts'))};
      void htmlToMarkdown('<pre>' + ' '.repeat(2_000_000) + 'x</pre>', undefined, {
        timeoutMs: 1_000,
        onChild: (child) => console.log(child.pid),
      }).catch(() => {});
      // Nothing else to do, so a host in this state would exit here on its own.
    `);
    try {
      const started = Date.now();
      const host = Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'ignore' });
      const output = await new Response(host.stdout).text();
      await host.exited;
      const pid = Number(output.trim());
      expect(Number.isInteger(pid) && pid > 0, `host printed ${JSON.stringify(output)}`).toBe(true);
      // Its deadline, 1 second, and its grace past that, 2: killed by its own
      // watchdog, since the host that would have killed it may be gone.
      expect(await gone(pid, 6_000)).toBe(true);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('telling what a document is', () => {
  test('mediaType', () => {
    expect(mediaType('Text/HTML; charset=utf-8')).toBe('text/html');
    expect(mediaType(undefined)).toBeUndefined();
    expect(mediaType(' ; x=1')).toBeUndefined();
  });

  test('isHtmlPath', () => {
    expect(isHtmlPath('a/b.html')).toBe(true);
    expect(isHtmlPath('a/b.HTM')).toBe(true);
    expect(isHtmlPath('a/b.xhtml')).toBe(true);
    expect(isHtmlPath('a/html.md')).toBe(false);
  });

  test('looksBinary', () => {
    expect(looksBinary(Buffer.from('plain text ✓'))).toBe(false);
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x00, 0x47]))).toBe(true);
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
    expect(looksBinary(Buffer.from('﻿hi', 'utf16le'))).toBe(false);
  });

  test('decodeText takes a byte-order mark first, over any charset the header names', () => {
    const utf16 = (text: string, littleEndian: boolean) => {
      const bytes = Buffer.from(`\ufeff${text}`, 'utf16le');
      return littleEndian ? bytes : bytes.swap16();
    };
    expect(decodeText(utf16('héllo', true), undefined)).toBe('héllo');
    expect(decodeText(utf16('héllo', false), undefined)).toBe('héllo');
    expect(decodeText(utf16('héllo', true), 'text/plain; charset=utf-8')).toBe('héllo');
    expect(decodeText(Buffer.from('\ufeffhéllo'), 'text/plain; charset=latin1')).toBe('héllo');
  });

  test('decodeText reads a <meta> charset in HTML, behind what the header says', () => {
    const cyrillic = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    const html = (meta: string) => Buffer.concat([Buffer.from(`<html><head>${meta}</head><body>`), cyrillic]);
    expect(decodeText(html('<meta charset="windows-1251">'), undefined, true)).toContain('Привет');
    expect(decodeText(html('<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">'), undefined, true)).toContain('Привет');
    expect(decodeText(html('<meta charset="windows-1251">'), 'text/html; charset=latin1', true)).not.toContain('Привет');
    // A file that merely mentions one isn't HTML, and isn't read as if it were.
    expect(decodeText(html('<meta charset="windows-1251">'), undefined, false)).not.toContain('Привет');
  });

  test('decodeText follows the charset, and survives one it does not know', () => {
    expect(decodeText(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'text/plain; charset=latin1')).toBe('café');
    expect(decodeText(Buffer.from('café'), 'text/plain; charset=no-such-charset')).toBe('café');
    expect(decodeText(Buffer.from('café'), undefined)).toBe('café');
  });

  test('decodeText leaves out a character cut in half by a prefix read', () => {
    const whole = Buffer.from('ab✓');
    expect(decodeText(whole.subarray(0, whole.length - 1), undefined)).toBe('ab');
  });

  test('looksLikeScriptShell', () => {
    expect(looksLikeScriptShell('<div id=root></div><script src=a.js></script>', 'Loading')).toBe(true);
    expect(looksLikeScriptShell('<p>hi</p>', 'hi')).toBe(false);
    expect(looksLikeScriptShell('<script></script>', 'x'.repeat(600))).toBe(false);
    // Short and complete: example.com, whose HTML is a few times its text.
    expect(looksLikeScriptShell(`<html><script>a()</script><p>${'x'.repeat(170)}</p></html>`, 'x'.repeat(170))).toBe(false);
    // Some text in a page that's nearly all script, as a large app's shell is.
    expect(looksLikeScriptShell(`<script>${'a'.repeat(100_000)}</script>`, 'x'.repeat(300))).toBe(true);
  });
});
