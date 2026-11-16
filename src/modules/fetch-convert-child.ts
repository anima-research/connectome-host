/**
 * Turns one HTML document into markdown, in a process of its own, and exits.
 *
 * The HTML is untrusted and the conversion is synchronous, and it can run far
 * past any reasonable time or memory: a megabyte of nested `<div>`s keeps
 * Turndown busy for minutes, long runs of spaces send one of its regular
 * expressions quadratic, and a dense page takes 500 times its size in memory.
 * A thread can't contain that: terminating a worker doesn't stop a thread inside
 * a compiled regular expression, and Bun ignores a worker's memory limits. A
 * process can be killed whatever it's doing, so the parent does that at its
 * deadline (fetch-convert.ts), and this process watches itself from a second
 * thread, which still runs however busy the first is, so one whose parent
 * crashed still ends at its own deadline, a little after the parent's.
 *
 * The parent passes the limits as one JSON argument and the document as JSON on
 * stdin, and reads one JSON answer from stdout.
 */
import { Worker } from 'node:worker_threads';
import TurndownService from 'turndown';

const { memoryLimitBytes, deadlineMs, images: keepImages } = JSON.parse(process.argv[2]!) as { memoryLimitBytes: number; deadlineMs: number; images?: boolean };

// It looks every 50 ms, so memory can pass the limit by what's taken in between,
// and it times itself by performance.now(), which a change to the wall clock doesn't move.
const WATCHDOG = `
  const { workerData } = require('node:worker_threads');
  const started = performance.now();
  setInterval(() => {
    if (process.memoryUsage().rss > workerData.memoryLimitBytes || performance.now() - started > workerData.deadlineMs) {
      process.kill(process.pid, 'SIGKILL');
    }
  }, 50);
`;
new Worker(WATCHDOG, { eval: true, workerData: { memoryLimitBytes, deadlineMs } }).unref();

const { html, baseUrl: documentUrl } = JSON.parse(await new Response(Bun.stdin.stream()).text()) as { html: string; baseUrl?: string };

/** What relative addresses resolve against: the document's `<base href>` where it has one, as in a browser, and otherwise its own address. */
const baseUrl = ((): string | undefined => {
  // The first <base> that isn't inside a comment: a comment is matched whole, to its end or the text's, and passed over.
  const tags = html.slice(0, 65_536).matchAll(/<!--[\s\S]*?(?:-->|$)|<base\b[^>]*>/gi);
  const tag = Array.from(tags, (found) => found[0]).find((found) => !found.startsWith('<!--'));
  const href = tag?.match(/\bhref\s*=\s*["']?([^"'\s>]+)/i)?.[1];
  if (href === undefined) return documentUrl;
  try {
    const base = documentUrl === undefined ? new URL(href) : new URL(href, documentUrl);
    return base.protocol === 'http:' || base.protocol === 'https:' ? base.href : documentUrl;
  } catch {
    return documentUrl;
  }
})();

/** An address this long says nothing to a reader, and a long base address multiplies with every relative link. */
const LONGEST_ADDRESS = 2_000;

/** What this file reads of the DOM nodes Turndown hands it. */
interface DomNode {
  nodeName: string;
  nodeType?: number;
  nodeValue?: string | null;
  parentNode: DomNode | null;
  childNodes: ArrayLike<DomNode>;
  querySelector?(selector: string): DomNode | null;
  querySelectorAll?(selector: string): ArrayLike<DomNode>;
  getAttribute?(name: string): string | null;
}

const asDom = (node: unknown): DomNode => node as DomNode;

const CELL_NAMES = new Set(['TH', 'TD']);

function cellsOf(row: DomNode): DomNode[] {
  return Array.from(row.childNodes).filter((node) => CELL_NAMES.has(node.nodeName));
}

/** How many columns a cell takes: its colspan, held to a most a real table has. A rowspan isn't followed. */
function spanOf(cell: DomNode): number {
  const span = Number.parseInt(cell.getAttribute?.('colspan') ?? '', 10);
  return span > 1 ? Math.min(span, 100) : 1;
}

const COLUMNS = new WeakMap<DomNode, number>();

/**
 * How many columns a table holds data in, or 0 for a table used for layout: a
 * single column, or tables nested inside, as older sites build whole pages.
 * Those read better as plain blocks than as one enormous row.
 */
function dataColumns(table: DomNode): number {
  const known = COLUMNS.get(table);
  if (known !== undefined) return known;
  let columns = 0;
  if (!table.querySelector?.('table')) {
    for (const row of Array.from(table.querySelectorAll?.('tr') ?? [])) {
      columns = Math.max(columns, cellsOf(row).reduce((sum, cell) => sum + spanOf(cell), 0));
    }
    if (columns < 2) columns = 0;
  }
  COLUMNS.set(table, columns);
  return columns;
}

function tableOf(node: DomNode): DomNode | null {
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    if (parent.nodeName === 'TABLE') return parent;
  }
  return null;
}

const inDataTable = (node: DomNode): boolean => {
  const table = tableOf(node);
  return table !== null && dataColumns(table) > 0;
};

const FIRST_ROWS = new WeakMap<DomNode, DomNode | null>();

/** Whether a row is the first its table shows, which the header line follows: a hidden row before it writes nothing. */
function isFirstRow(row: DomNode): boolean {
  const table = tableOf(row);
  if (table === null) return false;
  let first = FIRST_ROWS.get(table);
  if (first === undefined) {
    // Shown: neither it nor what holds it within the table, a thead say, is hidden.
    const shown = (candidate: DomNode): boolean => {
      for (let node: DomNode | null = candidate; node !== null && node !== table; node = node.parentNode) if (isHidden(node)) return false;
      return true;
    };
    first = Array.from(table.querySelectorAll?.('tr') ?? []).find(shown) ?? null;
    FIRST_ROWS.set(table, first);
  }
  return first === row;
}

/** Whether a style attribute ends with the element not displayed: comments aside, the last declaration of a property wins, unless an earlier one is !important. */
function styleHides(style: string): boolean {
  const final = new Map<string, { value: string; important: boolean }>();
  // Comments and quoted strings hold no declarations, and a semicolon inside one ends none.
  for (const declaration of style.replace(/\/\*[\s\S]*?\*\/|"[^"]*"|'[^']*'/g, '').split(';')) {
    const colon = declaration.indexOf(':');
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const written = declaration.slice(colon + 1).trim().toLowerCase();
    const important = /!\s*important$/.test(written);
    if (final.get(property)?.important && !important) continue;
    final.set(property, { value: written.replace(/\s*!\s*important$/, ''), important });
  }
  const visibility = final.get('visibility')?.value;
  return final.get('display')?.value === 'none' || visibility === 'hidden' || visibility === 'collapse';
}

/**
 * An element marked as not shown, on the element itself: the `hidden`
 * attribute, aria-hidden, or a style attribute's display: none or visibility:
 * hidden or collapse. That's a reduction, not a guarantee: a stylesheet's rules are out of
 * reach, and text can be kept from the eye in ways no list covers (opacity,
 * size, colour, position). Those are left in, opacity: 0 among them, since
 * pages that fade their content in start it that way.
 */
function isHidden(node: DomNode): boolean {
  if (typeof node.getAttribute !== 'function') return false;
  if (node.getAttribute('hidden') !== null) return true;
  if (node.getAttribute('aria-hidden') === 'true') return true;
  return styleHides(node.getAttribute('style') ?? '');
}

/** An address to follow from the page: absolute, and never one that runs or embeds something. */
function followable(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value === '') return null;
  try {
    const url = baseUrl === undefined ? new URL(value) : new URL(value, baseUrl);
    if (url.href.length > LONGEST_ADDRESS) return null;
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null;
  } catch {
    // A relative address with no page to resolve it against, as in a local file.
    return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.length > LONGEST_ADDRESS ? null : value;
  }
}

/** An address as it goes between markdown's round brackets: its own are percent-encoded, so one of them can't end it early. encodeURIComponent leaves them be. */
const inBrackets = (address: string): string => address.replace(/[()]/g, (bracket) => (bracket === '(' ? '%28' : '%29'));

const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', emDelimiter: '*', bulletListMarker: '-' });

// Turndown escapes markdown punctuation for a renderer, but a model reads this,
// and would quote snake_case back as snake\\_case.
service.escape = (text) => text;

service.addRule('followable-link', {
  filter: (node) => node.nodeName === 'A' && asDom(node).getAttribute?.('href') !== null,
  replacement: (content, node) => {
    const href = followable(asDom(node).getAttribute?.('href') ?? null);
    const text = content.trim();
    // A heading's permalink, a link whose whole text is a mark: it says nothing, once per heading.
    if (/^[¶#§🔗]$/u.test(text)) return '';
    if (href === null) return text;
    return text === '' ? '' : `[${text}](${inBrackets(href)})`;
  },
});

/** Whether an image's own size says it is an icon, a spacer or a tracking pixel: under 50 pixels either way. One that states no size isn't judged. */
function isSmall(image: DomNode): boolean {
  return ['width', 'height'].some((side) => {
    const size = Number.parseInt(image.getAttribute?.(side) ?? '', 10);
    return size >= 0 && size < 50;
  });
}

service.addRule('followable-image', {
  filter: 'img',
  replacement: (_content, node) => {
    const element = asDom(node);
    const alt = (element.getAttribute?.('alt') ?? '').replace(/\s+/g, ' ').trim();
    // A data: address is the image itself, and can run to megabytes of base64.
    // For a reader that can look, a page that loads its images late names them in data-src.
    const src = followable(element.getAttribute?.('src') ?? null)
      ?? (keepImages ? followable(element.getAttribute?.('data-src') ?? null) : null);
    if (src === null) return alt;
    // HTML's empty alt marks an image as decoration, and a text reader gets
    // nothing from its address. A reader that can look gets it all the same,
    // unless the image is too small to be more than decoration: a chart often
    // has no alt text either.
    if (alt === '' && !(keepImages && !isSmall(element))) return '';
    return `![${alt}](${inBrackets(src)})`;
  },
});

// Turndown alone flattens a table into one cell per line, which loses which
// value belongs to which column.
service.addRule('table-cell', {
  filter: (node) => CELL_NAMES.has(node.nodeName),
  replacement: (content, node) => {
    const flat = content.replace(/\s*\n\s*/g, ' ').trim();
    if (!inDataTable(asDom(node))) return flat === '' ? '' : `${content.trim()}\n\n`;
    // A bar in a cell's text is written \|. Backslashes just before one are
    // doubled, so text that already reads \| can't pass for a bar the cell
    // escaped; backslashes anywhere else stay as the page has them.
    const text = flat.replace(/\\*\|/g, (run) => `${'\\'.repeat((run.length - 1) * 2 + 1)}|`);
    // A cell across several columns is followed by empty ones, so the cells after it stay under their headings.
    return ` ${text} |${' |'.repeat(spanOf(asDom(node)) - 1)}`;
  },
});
service.addRule('table-row', {
  filter: 'tr',
  replacement: (content, node) => {
    const row = asDom(node);
    if (!inDataTable(row)) return content;
    const line = `|${content.replace(/\n/g, ' ')}`;
    if (!isFirstRow(row)) return `${line}\n`;
    return `${line}\n|${' --- |'.repeat(dataColumns(tableOf(row)!))}\n`;
  },
});
service.addRule('table-section', {
  filter: ['thead', 'tbody', 'tfoot'],
  replacement: (content) => content,
});
service.addRule('table', {
  filter: 'table',
  replacement: (content, node) => {
    const body = dataColumns(asDom(node)) > 0 ? content.replace(/\n{2,}/g, '\n') : content;
    return `\n\n${body.trim()}\n\n`;
  },
});

// Added last, since Turndown asks the most recently added rule first, and asks
// every rule before anything given to its own remove(): a hidden paragraph or
// heading would match the rule for its kind and be kept. An SVG element's
// nodeName keeps its lower case, so names compare in lower case.
const NOT_TEXT = new Set(['script', 'style', 'template', 'iframe', 'object', 'embed', 'svg', 'canvas', 'math', 'link', 'meta']);

/** An element's text as its text nodes hold it, without what a hidden element inside it holds. */
function shownText(node: DomNode): string {
  if (node.nodeType === 3) return node.nodeValue ?? '';
  if (isHidden(node) || NOT_TEXT.has(node.nodeName.toLowerCase())) return '';
  return Array.from(node.childNodes, shownText).join('');
}

// Turndown's rule for a fenced block takes the code element's whole text
// without visiting what's inside it, hidden elements and all, so this one
// stands in for it, the same but for the text it takes.
service.addRule('fenced-code-shown', {
  filter: (node) => node.nodeName === 'PRE' && asDom(node).childNodes[0]?.nodeName === 'CODE',
  replacement: (_content, node) => {
    const code = asDom(node).childNodes[0]!;
    const language = (code.getAttribute?.('class') ?? '').match(/language-(\S+)/)?.[1] ?? '';
    const text = shownText(code).replace(/\n$/, '');
    // A fence longer than any run of backticks that starts a line of the code.
    const longest = Math.max(2, ...Array.from(text.matchAll(/^`{3,}/gm), (run) => run[0].length));
    const fence = '`'.repeat(longest + 1);
    return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
  },
});

service.addRule('not-for-a-reader', {
  filter: (node) => NOT_TEXT.has(node.nodeName.toLowerCase()) || isHidden(asDom(node)),
  replacement: () => '',
});

let answer: { markdown: string } | { error: string };
try {
  answer = { markdown: service.turndown(html) };
} catch (error) {
  answer = { error: error instanceof Error ? error.message : String(error) };
}
await Bun.write(Bun.stdout, JSON.stringify(answer));
process.exit(0);
