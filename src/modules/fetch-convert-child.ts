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
 * thread, which still runs however busy the first is, so it can't outlive a
 * parent that crashed.
 *
 * The parent passes the limits as one JSON argument and the document as JSON on
 * stdin, and reads one JSON answer from stdout.
 */
import { Worker } from 'node:worker_threads';
import TurndownService from 'turndown';

const { memoryLimitBytes, deadlineMs } = JSON.parse(process.argv[2]!) as { memoryLimitBytes: number; deadlineMs: number };

const WATCHDOG = `
  const { workerData } = require('node:worker_threads');
  setInterval(() => {
    if (process.memoryUsage().rss > workerData.memoryLimitBytes || Date.now() > workerData.deadline) {
      process.kill(process.pid, 'SIGKILL');
    }
  }, 50);
`;
new Worker(WATCHDOG, { eval: true, workerData: { memoryLimitBytes, deadline: Date.now() + deadlineMs } }).unref();

const { html, baseUrl } = JSON.parse(await new Response(Bun.stdin.stream()).text()) as { html: string; baseUrl?: string };

/** An address this long says nothing to a reader, and a long base address multiplies with every relative link. */
const LONGEST_ADDRESS = 2_000;

/** What this file reads of the DOM nodes Turndown hands it. */
interface DomNode {
  nodeName: string;
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
    for (const row of Array.from(table.querySelectorAll?.('tr') ?? [])) columns = Math.max(columns, cellsOf(row).length);
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

function isFirstRow(row: DomNode): boolean {
  return tableOf(row)?.querySelector?.('tr') === row;
}

/** An element a browser wouldn't show. External stylesheets are out of reach, so this catches only what's marked on the element. */
function isHidden(node: DomNode): boolean {
  if (typeof node.getAttribute !== 'function') return false;
  if (node.getAttribute('hidden') !== null) return true;
  if (node.getAttribute('aria-hidden') === 'true') return true;
  return /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(node.getAttribute('style') ?? '');
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

const service = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', emDelimiter: '*', bulletListMarker: '-' });

// Turndown escapes markdown punctuation for a renderer, but a model reads this,
// and would quote snake_case back as snake\\_case.
service.escape = (text) => text;

service.addRule('followable-link', {
  filter: (node) => node.nodeName === 'A' && asDom(node).getAttribute?.('href') !== null,
  replacement: (content, node) => {
    const href = followable(asDom(node).getAttribute?.('href') ?? null);
    const text = content.trim();
    if (href === null) return text;
    return text === '' ? '' : `[${text}](${href.replace(/[()]/g, (c) => encodeURIComponent(c))})`;
  },
});

service.addRule('followable-image', {
  filter: 'img',
  replacement: (_content, node) => {
    const element = asDom(node);
    const alt = (element.getAttribute?.('alt') ?? '').replace(/\s+/g, ' ').trim();
    // A data: address is the image itself, and can run to megabytes of base64.
    const src = followable(element.getAttribute?.('src') ?? null);
    // HTML's empty alt marks an image as decoration, and a text reader gets nothing from its address.
    if (src === null || alt === '') return alt;
    return `![${alt}](${src})`;
  },
});

// Turndown alone flattens a table into one cell per line, which loses which
// value belongs to which column.
service.addRule('table-cell', {
  filter: (node) => CELL_NAMES.has(node.nodeName),
  replacement: (content, node) => {
    const flat = content.replace(/\s*\n\s*/g, ' ').trim();
    if (!inDataTable(asDom(node))) return flat === '' ? '' : `${content.trim()}\n\n`;
    return ` ${flat.replace(/\|/g, '\\|')} |`;
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
