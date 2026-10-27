/**
 * A trial writes to the service's stdout and stderr, which the launcher's
 * execve leaves it, and headless.log opens only once a start has committed,
 * so none of the install's own files would hold what a trial that ends
 * before its commit wrote.
 *
 * While a host runs on trial, armTrialLog keeps the end of what it writes
 * through console's log, info, warn, error and debug and through
 * process.stdout's and process.stderr's write, each passed on unchanged.
 * Bun's console writes to the descriptors itself, past those write methods,
 * so both are wrapped, and a console call is kept as node:util's format
 * renders its arguments, which lays out an object on fewer lines than Bun's
 * console does.
 *
 * What doesn't pass through those isn't kept: console's other methods, such
 * as dir, table and trace; Bun's own report of an error nothing caught,
 * which its printer writes past console; everything, if a signal ends the
 * process, such as a stop's SIGTERM or the OOM killer's SIGKILL, since a
 * signal nothing handles runs no exit handler; and what a child process
 * writes to the descriptors it inherits, such as an MCPL server's stderr.
 * Only the service's log, or the terminal the host was started in, has
 * those.
 */
import { writeSync } from 'node:fs';
import { format } from 'node:util';
import {
  installPaths, readCurrent, readJournal, readRecord, unfinishedTrial, writeJsonAtomic, type JournalLine,
} from './contract.js';
import type { ReleaseHere } from './host.js';

export const TRIAL_LOG_LINES = 40;
export const TRIAL_LOG_CHARS = 64 * 1024;

export interface TrialLog {
  v: 1;
  release: string;
  mark: string;
  lines: string[];
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

let armed: { root: string; release: string; mark: string; tail: string } | null = null;

function keep(text: string): void {
  if (armed !== null) armed.tail = (armed.tail + text).slice(-TRIAL_LOG_CHARS);
}

export function armTrialLog(here: ReleaseHere): void {
  let trial: JournalLine | null;
  try {
    trial = unfinishedTrial(readJournal(here.root), readCurrent(here.root));
  } catch {
    return;
  }
  if (trial === null || trial.to !== here.release || typeof trial.mark !== 'string') return;
  armed = { root: here.root, release: here.release, mark: trial.mark, tail: '' };
  for (const method of CONSOLE_METHODS) {
    const original = console[method];
    console[method] = function (this: unknown, ...args: unknown[]): void {
      if (armed !== null) {
        const onItsOwnLine = `\n${format(...args)}\n`;
        keep(onItsOwnLine);
      }
      original.apply(this, args);
    };
  }
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write as (...args: unknown[]) => boolean;
    stream.write = function (this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
      if (armed !== null) {
        keep(typeof chunk === 'string' ? chunk
          : chunk instanceof Uint8Array ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf-8')
          : String(chunk));
      }
      return original.call(this, chunk, ...rest);
    } as typeof stream.write;
  }
  process.on('exit', writeTrialLog);
}

export function disarmTrialLog(): void {
  armed = null;
}

function writeTrialLog(): void {
  const state = armed;
  if (state === null) return;
  const lines = state.tail.split('\n').filter((line) => line.trim() !== '').slice(-TRIAL_LOG_LINES);
  const log: TrialLog = { v: 1, release: state.release, mark: state.mark, lines };
  try {
    writeJsonAtomic(installPaths(state.root).trialLog, log, 0o600);
  } catch (error) {
    writeSync(2, `[update] ${state.release}'s last lines couldn't be kept for the release that falls back from it ` +
      `(${installPaths(state.root).trialLog}): ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

export function readTrialLog(root: string, fallback: JournalLine): string[] | null {
  const log = readRecord<TrialLog>(installPaths(root).trialLog, 'trial log');
  if (log === null || log.mark !== fallback.mark || log.release !== fallback.from) return null;
  if (!Array.isArray(log.lines)) return null;
  return log.lines.filter((line): line is string => typeof line === 'string');
}
