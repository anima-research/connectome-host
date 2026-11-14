/**
 * From a document's bytes to the text an agent reads: telling text from
 * binary, decoding, and converting HTML to markdown in a process that can be
 * killed (fetch-convert-child.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FetchRefusal } from './fetch-http.js';

const CHILD_PATH = fileURLToPath(new URL('./fetch-convert-child.ts', import.meta.url));

/** How long one document's conversion may run. An ordinary 5 MiB page takes about a second. */
const CONVERT_TIMEOUT_MS = 15_000;
/** How much memory it may take. An ordinary 5 MiB page takes a few hundred MiB; a hostile one, 500 times its size. */
const CONVERT_MEMORY_BYTES = 1024 * 1024 * 1024;
/** How long past its deadline the child lets itself live, for the parent to be the one to kill it. */
const CHILD_GRACE_MS = 2_000;
/** Conversions at once, so a batch of big pages can't take many times the memory limit between them. */
const MOST_AT_ONCE = 2;

let running = 0;
const waiting: Array<() => void> = [];

async function turnToConvert(): Promise<() => void> {
  if (running < MOST_AT_ONCE) running++;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  // A finished conversion hands its turn straight to the next in line.
  return () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
}

export interface ConvertOptions {
  timeoutMs?: number;
  memoryLimitBytes?: number;
  /** Told of the process doing the work, so a test can check on it. */
  onChild?: (child: ChildProcess) => void;
}

function convertInChild(html: string, baseUrl: string | undefined, options: ConvertOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? CONVERT_TIMEOUT_MS;
  const memoryLimitBytes = options.memoryLimitBytes ?? CONVERT_MEMORY_BYTES;
  return new Promise<string>((resolve, reject) => {
    // Nothing of the host's environment goes with it, its credentials above
    // all, and --no-env-file keeps Bun from reading any .env file back in.
    const child = spawn(
      process.execPath,
      ['--no-env-file', CHILD_PATH, JSON.stringify({ memoryLimitBytes, deadlineMs: timeoutMs + CHILD_GRACE_MS })],
      { cwd: dirname(CHILD_PATH), env: {}, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    options.onChild?.(child);
    const stdin = child.stdin!;
    const stdout = child.stdout!;
    // Nothing here keeps the host from exiting: the child ends itself.
    child.unref();
    (stdout as unknown as { unref?: () => void }).unref?.();

    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
      child.kill('SIGKILL');
    };
    const refuse = (reason: string): void => finish(() => reject(new FetchRefusal(`its HTML couldn't be converted, because ${reason}.`)));
    const timer = setTimeout(() => refuse(`that took more than ${Math.round(timeoutMs / 1000)} seconds`), timeoutMs);
    timer.unref();

    // The answer is held to a few times the document, so a child gone wrong
    // can't fill this process's memory in its place.
    const mostOutput = html.length * 8 + 1024 * 1024;
    const chunks: Buffer[] = [];
    let received = 0;
    stdout.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > mostOutput) refuse('what it turned into was far larger than the page');
      else chunks.push(chunk);
    });
    // A child killed before reading its input breaks this pipe, and close says why.
    stdin.on('error', () => {});
    stdout.on('error', () => {});
    child.on('error', (error) => refuse(`its converter couldn't start (${error.message})`));
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        // Only the child's own watchdog kills it before the deadline here.
        refuse(signal === 'SIGKILL' ? 'that took more memory or time than this tool allows' : `its converter stopped (${signal ?? `exit ${code}`})`);
        return;
      }
      try {
        const answer = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { markdown?: string; error?: string };
        if (typeof answer.markdown === 'string') finish(() => resolve(answer.markdown!));
        else refuse(`its converter failed (${answer.error ?? 'no reason given'})`);
      } catch {
        refuse('its converter gave an answer that could not be read');
      }
    });
    stdin.end(JSON.stringify({ html, ...(baseUrl === undefined ? {} : { baseUrl }) }));
  });
}

/**
 * Markdown for a document, with its relative links resolved against `baseUrl`
 * when there is one. A conversion past its time or memory limit is killed and
 * refused, with a FetchRefusal.
 */
export async function htmlToMarkdown(html: string, baseUrl: string | undefined, options: ConvertOptions = {}): Promise<string> {
  const done = await turnToConvert();
  try {
    return await convertInChild(html, baseUrl, options);
  } finally {
    done();
  }
}

/** The media type of a Content-Type header, lower-cased, without its parameters. */
export function mediaType(contentType: string | undefined): string | undefined {
  const type = contentType?.split(';')[0]?.trim().toLowerCase();
  return type === '' ? undefined : type;
}

export function isHtmlType(type: string | undefined): boolean {
  return type === 'text/html' || type === 'application/xhtml+xml';
}

export function isHtmlPath(path: string): boolean {
  return /\.x?html?$/i.test(path);
}

const BYTE_ORDER_MARKS: Array<[number[], string]> = [
  [[0xef, 0xbb, 0xbf], 'utf-8'],
  [[0xff, 0xfe], 'utf-16le'],
  [[0xfe, 0xff], 'utf-16be'],
];

function markedEncoding(bytes: Buffer): string | undefined {
  return BYTE_ORDER_MARKS.find(([mark]) => mark.every((byte, index) => bytes[index] === byte))?.[1];
}

/** Whether bytes hold binary data: a NUL early on, which text in the encodings served here doesn't have, UTF-16 being told apart by its byte-order mark. */
export function looksBinary(bytes: Buffer): boolean {
  return markedEncoding(bytes) === undefined && bytes.subarray(0, 8192).includes(0);
}

/**
 * Bytes as text. As a browser does, it takes the encoding from a byte-order
 * mark first, then the charset in the header, then for HTML a `<meta>` near the
 * start, and otherwise UTF-8, as it does for one this runtime doesn't know. A
 * multi-byte character cut off at the end of a prefix read is left out, rather
 * than shown as a replacement.
 */
export function decodeText(bytes: Buffer, contentType: string | undefined, html = false): string {
  const declared = contentType?.match(/charset\s*=\s*"?([^";\s]+)/i)?.[1];
  const inMeta = html ? bytes.subarray(0, 1024).toString('latin1').match(/<meta\b[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i)?.[1] : undefined;
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(markedEncoding(bytes) ?? declared ?? inMeta ?? 'utf-8');
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(bytes, { stream: true });
}

/**
 * Whether a page is likely to read very differently in a browser: it has
 * scripts, and next to no text, or very little for the size of its HTML. Such
 * a page is often an empty shell its scripts fill, which this tool can't run.
 * A short page that's simply short, like example.com, has little HTML too.
 */
export function looksLikeScriptShell(html: string, markdown: string): boolean {
  const chars = markdown.trim().length;
  return chars < 500 && (chars < 100 || chars < html.length / 20) && /<script[\s>]/i.test(html);
}
