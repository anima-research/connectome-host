/**
 * Shared shutdown plumbing (fragility audit, Group 1).
 *
 * Three small primitives used by the headless daemon, the TUI, and piped
 * mode so every exit path gets the same guarantees:
 *
 *   - `stopWithDeadline` — race a stop() promise against a deadline so a
 *     hung MCPL child / mid-stream inference / full-disk Chronicle flush
 *     can't park the process forever (audit 1.3, 1.6).
 *   - `createSignalHandler` — first SIGTERM/SIGINT triggers the graceful
 *     path; a second signal force-exits instead of being swallowed by the
 *     in-progress guard (audit 1.1, 1.3).
 *   - `readAlivePid` — PID-file liveness probe so a second instance on the
 *     same data dir refuses to start instead of stealing the socket and
 *     double-writing the Chronicle store (audit 1.2).
 */

import { readFileSync } from 'node:fs';

export type StopOutcome = 'stopped' | 'stop-failed' | 'timed-out';

/**
 * Await `stop()`, but give up after `deadlineMs`. Never rejects — a
 * rejection from `stop()` resolves as 'stop-failed' (logged), a hang
 * resolves as 'timed-out'. The caller decides what to do next (typically
 * `process.exit`); the hung stop() keeps running in the background but no
 * longer blocks the exit path.
 */
export async function stopWithDeadline(
  stop: () => Promise<void>,
  deadlineMs: number,
  log?: (msg: string) => void,
): Promise<StopOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<StopOutcome>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout('timed-out'), deadlineMs);
    // Don't let the deadline itself keep the event loop alive.
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    const stopped = (async (): Promise<StopOutcome> => {
      try {
        await stop();
        return 'stopped';
      } catch (err) {
        log?.(`stop() failed: ${String(err)}`);
        return 'stop-failed';
      }
    })();
    const outcome = await Promise.race([stopped, timeout]);
    if (outcome === 'timed-out') {
      log?.(`stop() exceeded ${deadlineMs}ms deadline`);
    }
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

export interface SignalHandlerOptions {
  /** Called on the first signal. Should initiate graceful shutdown. */
  onFirstSignal: (signal: string) => void;
  /** Called on the second (and later) signal. Should force-exit.
   *  Defaults to `process.exit(130)`. */
  onSecondSignal?: (signal: string) => void;
  log?: (msg: string) => void;
}

/**
 * Returns a `(signal) => void` suitable for `process.on('SIGTERM', ...)`.
 * First signal → graceful path; second signal → force path (default:
 * immediate `process.exit(130)`), so an operator's second Ctrl+C always
 * wins over a wedged stop().
 */
export function createSignalHandler(opts: SignalHandlerOptions): (signal: string) => void {
  let signals = 0;
  return (signal: string): void => {
    signals += 1;
    if (signals > 1) {
      opts.log?.(`second signal (${signal}) — forcing exit`);
      if (opts.onSecondSignal) opts.onSecondSignal(signal);
      else process.exit(130);
      return;
    }
    opts.log?.(`received ${signal} — shutting down`);
    opts.onFirstSignal(signal);
  };
}

/**
 * Read a PID file and probe whether that process is alive.
 * Returns the live PID, or null when the file is absent/garbage, names this
 * process itself, or names a process that no longer exists. `EPERM` from
 * `kill(pid, 0)` means the process exists but belongs to someone else —
 * that still counts as alive.
 */
export function readAlivePid(pidPath: string): number | null {
  let pid: number;
  try {
    const raw = readFileSync(pidPath, 'utf8').trim();
    pid = Number.parseInt(raw, 10);
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return pid;
    return null;
  }
}
