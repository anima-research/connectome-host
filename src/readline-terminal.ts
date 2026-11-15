import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import { sessionMarker } from './session-marker.js';

export const READLINE_LOG = 'readline-error.log';

export interface ReadlineTerminal {
  logPath: string;
  logging(): boolean;
  say(line: string): void;
  end(): void;
}

export interface ShownPrompt {
  showing(): boolean;
  redraw(): void;
}

type StdWrite = typeof process.stdout.write;
type WriteCallback = (err?: Error | null) => void;

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function openReadlineTerminal(dataDir: string, prompt: ShownPrompt): ReadlineTerminal {
  const logPath = join(dataDir, READLINE_LOG);
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const saved = { error: console.error, warn: console.warn, log: console.log, info: console.info, debug: console.debug };
  let atLineStart = true;
  let ended = false;
  let fd: number | null = null;

  function say(line: string): void {
    const atPrompt = !ended && prompt.showing();
    if (atPrompt && process.stdout.isTTY) stdoutWrite.call(process.stdout, '\r\x1b[K');
    else if (!ended && !atLineStart) stdoutWrite.call(process.stdout, '\n');
    stderrWrite.call(process.stderr, `${line}\n`);
    atLineStart = true;
    if (atPrompt) prompt.redraw();
  }

  function logFailed(error: unknown): void {
    say(`[host] ${logPath} can't be written (${describe(error)}), so the host's diagnostics print here instead`);
  }

  function append(chunk: string | Uint8Array): boolean {
    if (fd === null) return false;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    try {
      for (let at = 0; at < bytes.length;) {
        const wrote = writeSync(fd, bytes, at);
        if (wrote <= 0) throw new Error('the log took none of a write');
        at += wrote;
      }
      return true;
    } catch (error) {
      try { closeSync(fd); } catch {}
      fd = null;
      logFailed(error);
      return false;
    }
  }

  function toLog(chunk: string | Uint8Array): void {
    if (!append(chunk)) stderrWrite.call(process.stderr, chunk);
  }

  try {
    fd = openSync(logPath, 'a', 0o600);
  } catch (error) {
    logFailed(error);
  }
  append(`\n${sessionMarker(new Date())}\n`);

  process.stdout.write = function (this: unknown, chunk: string | Uint8Array, ...rest: unknown[]): boolean {
    if (chunk.length > 0) {
      atLineStart = typeof chunk === 'string' ? chunk.endsWith('\n') : chunk[chunk.length - 1] === 0x0a;
    }
    return (stdoutWrite as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  } as StdWrite;
  process.stderr.write = function (
    this: unknown,
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | WriteCallback,
    cb?: WriteCallback,
  ): boolean {
    toLog(typeof chunk === 'string' && typeof encodingOrCb === 'string' ? Buffer.from(chunk, encodingOrCb) : chunk);
    const done = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (done) process.nextTick(done, null);
    return true;
  } as StdWrite;
  // Bun's console writes to descriptors 1 and 2 itself, not through the
  // methods above: its stderr lines are sent to the log here, and its stdout
  // lines, which always end their line, are noted as having done so.
  console.error = (...args: unknown[]) => { toLog(`${format(...args)}\n`); };
  console.warn = (...args: unknown[]) => { toLog(`${format(...args)}\n`); };
  for (const method of ['log', 'info', 'debug'] as const) {
    const print = saved[method];
    console[method] = (...args: unknown[]) => { print(...args); atLineStart = true; };
  }

  function end(): void {
    if (ended) return;
    ended = true;
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    Object.assign(console, saved);
    if (fd !== null) {
      try { closeSync(fd); } catch {}
      fd = null;
    }
  }

  return { logPath, logging: () => fd !== null, say, end };
}
