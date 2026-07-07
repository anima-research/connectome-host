/**
 * Session-switch orchestration (fragility audit 1.4).
 *
 * The old inline `switchSession` did:
 *   export → stop old framework → setActiveSession(new) → createFramework(new)
 * with no failure handling: if createFramework threw (MCPL spawn failure,
 * corrupt target store), the app was stranded on a *stopped* framework and
 * sessions.json already named the broken session active — so the next
 * process start booted straight back into the session that just failed.
 * Two concurrent switches could also interleave (headless dispatch is
 * fire-and-forget per line).
 *
 * This factory owns the ordering, the rollback, and the concurrency guard;
 * `src/index.ts` supplies the IO. Pure enough to unit-test with fakes.
 */

export interface SessionSwitchIO<F> {
  /** Currently-active session id (rollback target), or null if none. */
  getActiveSessionId(): string | null;
  /** Best-effort pre-switch export (lessons). Errors are swallowed. */
  exportBeforeSwitch(): void;
  /** The framework instance currently live. */
  getCurrentFramework(): F;
  stopFramework(framework: F): Promise<void>;
  setActiveSession(id: string): void;
  getStorePath(id: string): string;
  createFramework(storePath: string): Promise<F>;
  /** Install + start the new framework: assign app.framework, start(),
   *  rebind synesthete/mcpl-log/webui, reset per-session counters. */
  activate(framework: F, storePath: string): void;
  log?(msg: string): void;
}

/**
 * Returns the switchSession function. Guarantees:
 *  - only one switch in flight (a concurrent call rejects immediately);
 *  - on createFramework failure, the active-session pointer is rolled back
 *    and a framework for the previous session is restored (best-effort),
 *    then the original error is re-thrown so callers can surface it.
 */
export function createSessionSwitcher<F>(io: SessionSwitchIO<F>): (id: string) => Promise<void> {
  let inFlight = false;

  return async function switchSession(id: string): Promise<void> {
    if (inFlight) {
      throw new Error('session switch already in progress');
    }
    inFlight = true;
    try {
      const previousId = io.getActiveSessionId();

      try {
        io.exportBeforeSwitch();
      } catch (err) {
        io.log?.(`pre-switch export failed (continuing): ${String(err)}`);
      }

      await io.stopFramework(io.getCurrentFramework());
      io.setActiveSession(id);

      try {
        const storePath = io.getStorePath(id);
        const next = await io.createFramework(storePath);
        io.activate(next, storePath);
      } catch (err) {
        // Roll back: re-point the active session at the previous one and
        // try to restore a framework for it so the app isn't stranded on a
        // stopped framework with a broken session marked active.
        if (previousId !== null && previousId !== id) {
          io.log?.(
            `switch to session ${id} failed (${String(err)}); rolling back to ${previousId}`,
          );
          io.setActiveSession(previousId);
          try {
            const prevStorePath = io.getStorePath(previousId);
            const restored = await io.createFramework(prevStorePath);
            io.activate(restored, prevStorePath);
          } catch (restoreErr) {
            // Active-session pointer is rolled back at least; the next
            // process start boots the previous (known-good) session.
            io.log?.(`rollback framework restore failed: ${String(restoreErr)}`);
          }
        }
        throw err;
      }
    } finally {
      inFlight = false;
    }
  };
}
