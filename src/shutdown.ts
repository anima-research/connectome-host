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

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

/**
 * Hard ceiling on graceful shutdown, shared by every run mode (headless
 * daemon, TUI, piped). If `framework.stop()` hangs — stuck MCPL stdio child,
 * uncancellable inference, full-disk Chronicle flush — the deadline still lets
 * the process exit rather than parking forever. One constant, three call sites
 * (previously three independent `15_000` literals — the exact duplicate-literal
 * smell audit 2.12 flagged for ZOMBIE_THRESHOLD_MS).
 */
export const SHUTDOWN_DEADLINE_MS = 15_000;

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

/**
 * Run `stop()` under the deadline, then finalize the exit decision.
 *
 * Always calls `onResolved` (this unblocks whatever the caller is awaiting on
 * to leave its run loop). Then, when stop() did NOT cleanly complete
 * ('timed-out' / 'stop-failed'), forces `process.exit(1)` — because a hung or
 * failed stop() leaves live handles (MCPL stdio children, fleet child sockets,
 * the web-ui Bun.serve listener) pinning the event loop, so merely resolving
 * the promise is not enough: without an explicit exit the process parks even
 * though the deadline fired.
 *
 * This is the exact seam the TUI cleanup used to get wrong (audit 1.6): it
 * `.finally(() => resolveExit())`-ed and discarded the outcome, so a hung
 * stop() unblocked the await but never exited, and `docker stop`'s single
 * SIGTERM rode out the grace period to SIGKILL. Headless and piped modes
 * force-exit unconditionally; the TUI deliberately lets a CLEAN stop fall
 * through to its natural, terminal-restoring return, which is why
 * `forceExitOnClean` defaults to false.
 *
 * `exit` is injectable purely so tests can observe the decision without
 * killing the test runner; production passes nothing and gets `process.exit`.
 */
export async function finalizeShutdown(opts: {
  stop: () => Promise<void>;
  deadlineMs: number;
  onResolved?: () => void;
  exit?: (code: number) => void;
  forceExitOnClean?: boolean;
  log?: (msg: string) => void;
}): Promise<StopOutcome> {
  const outcome = await stopWithDeadline(opts.stop, opts.deadlineMs, opts.log);
  opts.onResolved?.();
  if (outcome !== 'stopped' || opts.forceExitOnClean) {
    (opts.exit ?? ((code: number) => process.exit(code)))(outcome === 'stopped' ? 0 : 1);
  }
  return outcome;
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

/**
 * Acquire the double-start lock (audit 1.2). Two headless instances on one
 * data dir means two writers on the same append-only Chronicle store —
 * undefined behavior. A bare probe-then-write has a TOCTOU: two instances
 * started simultaneously both read no-live-pid and both proceed. We acquire
 * the PID file ATOMICALLY with `{ flag: 'wx' }` so the create itself is the
 * mutex; the loser gets EEXIST and re-probes.
 *
 * On EEXIST the owner is re-probed FIRST, before any unlink: a simultaneous
 * starter may have just written its live pid, and unlinking that would delete
 * a live owner's file and let both instances run (the exact double-writer race
 * this guards). We only reclaim the file when the owner is genuinely dead — a
 * stale pid left by a crashed instance.
 *
 * Throws on refusal (live owner / lost the create race). Returns normally when
 * the pid file is now owned, or — on a non-EEXIST write failure such as a
 * read-only dir — best-effort proceeds after logging.
 *
 * `probe` is injectable for tests so the EEXIST-with-live-owner branch can be
 * exercised deterministically; production uses `readAlivePid`.
 */
export function acquirePidFile(
  pidPath: string,
  log: (msg: string) => void,
  probe: (p: string) => number | null = readAlivePid,
): void {
  for (let attempt = 0; ; attempt++) {
    const alivePid = probe(pidPath);
    if (alivePid !== null) {
      const msg =
        `refusing to start: another headless instance (pid ${alivePid}) ` +
        `is already running (from ${pidPath})`;
      log(msg);
      throw new Error(msg);
    }
    try {
      writeFileSync(pidPath, String(process.pid), { flag: 'wx' });
      return; // we own the pid file
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 3) {
        // Lost the atomic create — someone else holds the pid file. Re-probe
        // FIRST: only reclaim if the owner is genuinely dead. A live owner
        // (a simultaneous starter that just won the create) makes us refuse
        // rather than delete its file and double-write.
        const owner = probe(pidPath);
        if (owner !== null) {
          const msg =
            `refusing to start: another headless instance (pid ${owner}) ` +
            `holds ${pidPath}`;
          log(msg);
          throw new Error(msg);
        }
        try { unlinkSync(pidPath); } catch { /* another racer may have won it */ }
        continue;
      }
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // Kept losing the create race to another starting instance — refuse
        // rather than fall through to a non-atomic overwrite.
        const msg = `refusing to start: lost the pid-file create race on ${pidPath}`;
        log(msg);
        throw new Error(msg);
      }
      // Non-EEXIST write failure (e.g. read-only dir): best-effort, proceed.
      log(`pid file write failed: ${String(err)}`);
      return;
    }
  }
}
