/**
 * What a release on trial wrote as it ended, kept for the release that falls
 * back from it (contract.ts). A trial writes to the service's stdout and
 * stderr, which the launcher's execve leaves it, and headless.log opens only
 * once a start has committed, so none of the install's own files would hold
 * what a trial that ends before its commit wrote.
 *
 * While a host runs on trial, armTrialLog keeps the end of what it writes
 * through console's log, info, warn, error and debug and through
 * process.stdout's and process.stderr's write, each passed on unchanged. Bun's console writes to
 * the descriptors itself, past those write methods, so both are wrapped, and
 * a console call is kept as node:util's format renders its arguments, which
 * lays out an object on fewer lines than Bun's console does. What's kept is
 * one text in the order it was written, so a write to stdout that leaves its
 * line open shares that line with a write to stderr after it. If the process
 * exits before its commit, the last lines are written to the install's trial
 * log (installPaths' trialLog) with the trial's mark. The commit disarms it
 * (disarmTrialLog), so nothing is kept after, and the wraps only pass what's
 * written on, formatting and decoding nothing.
 *
 * What doesn't pass through those isn't kept: console's other methods, such
 * as dir, table and trace; Bun's own report of an error nothing caught,
 * which its printer writes past console; everything, if a
 * signal ends the process, such as a stop's SIGTERM or the OOM killer's
 * SIGKILL, since a signal nothing handles runs no exit handler, and the
 * host's own handlers start only after the commit (headless.ts); what a start
 * writes before it knows its release (releaseHere); and what a child process
 * writes to the descriptors it inherits, such as an MCPL server's stderr. Only
 * the service's log, or the terminal the host was started in, has those.
 *
 * There is one trial log: the next trial that ends before its commit
 * replaces it, and readTrialLog gives it only for the fallback whose mark it
 * names.
 */
import { writeSync } from 'node:fs';
import { format } from 'node:util';
import {
  installPaths, readCurrent, readJournal, readRecord, unfinishedTrial, writeJsonAtomic, type JournalLine,
} from './contract.js';
import type { ReleaseHere } from './host.js';

/** How many of its last lines a trial keeps, from at most its last
 *  TRIAL_LOG_CHARS characters written. */
export const TRIAL_LOG_LINES = 40;
export const TRIAL_LOG_CHARS = 64 * 1024;

/** The trial log: the lines a trial kept, and which trial kept them. */
export interface TrialLog {
  v: 1;
  /** The release on trial, and the mark its trial-start line names. */
  release: string;
  mark: string;
  lines: string[];
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** The trial this host is, and the end of what it has written, while armed. */
let armed: { root: string; release: string; mark: string; tail: string } | null = null;

function keep(text: string): void {
  if (armed !== null) armed.tail = (armed.tail + text).slice(-TRIAL_LOG_CHARS);
}

/**
 * Start keeping what this host writes, if it's the release on trial: the
 * journal's trial under way (unfinishedTrial) names it and `current` names
 * another. Any other start, and one whose journal or `current` can't be read,
 * keeps nothing, and the start's own reads report what couldn't be read.
 */
export function armTrialLog(here: ReleaseHere): void {
  let trial: JournalLine | null;
  try {
    trial = unfinishedTrial(readJournal(here.root), readCurrent(here.root));
  } catch {
    return;
  }
  if (trial === null || trial.to !== here.release || typeof trial.mark !== 'string') return;
  armed = { root: here.root, release: here.release, mark: trial.mark, tail: '' };
  // The wraps stay once disarmed, passing everything on: putting the
  // originals back would undo any wrap made over these since.
  for (const method of CONSOLE_METHODS) {
    const original = console[method];
    console[method] = function (this: unknown, ...args: unknown[]): void {
      // A console line starts a line of its own, even after a write that left
      // one open; the empty lines this leaves are dropped at the exit. Once
      // disarmed, nothing is formatted.
      if (armed !== null) keep(`\n${format(...args)}\n`);
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

/** Stop keeping what this host writes: the commit calls it once `current`
 *  names this release. */
export function disarmTrialLog(): void {
  armed = null;
}

/** The exit handler: write the trial's last lines, if it's still armed, so
 *  only before the commit. */
function writeTrialLog(): void {
  const state = armed;
  if (state === null) return;
  const lines = state.tail.split('\n').filter((line) => line.trim() !== '').slice(-TRIAL_LOG_LINES);
  const log: TrialLog = { v: 1, release: state.release, mark: state.mark, lines };
  try {
    writeJsonAtomic(installPaths(state.root).trialLog, log, 0o600);
  } catch (error) {
    // The exit goes on: this line reaches the service's log, which has the rest.
    writeSync(2, `[update] ${state.release}'s last lines couldn't be kept for the release that falls back from it ` +
      `(${installPaths(state.root).trialLog}): ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/** The lines the trial `fallback` fell back from kept, or null when the
 *  trial log isn't that trial's: there is none, or a later or earlier
 *  trial's. A trial log that can't be read throws, naming the file. */
export function readTrialLog(root: string, fallback: JournalLine): string[] | null {
  const log = readRecord<TrialLog>(installPaths(root).trialLog, 'trial log');
  if (log === null || log.mark !== fallback.mark || log.release !== fallback.from) return null;
  if (!Array.isArray(log.lines)) return null;
  return log.lines.filter((line): line is string => typeof line === 'string');
}
