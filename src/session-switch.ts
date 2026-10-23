/**
 * The host's session switch, as steps, so its contract with a stop can be
 * tested on its own: once the TUI's stop has begun (`app.stopping`, which
 * only the TUI's stop sets), a switch makes nothing more, and stops what it
 * has already made.
 *
 * The stop doesn't wait for a switch under way, since the switch can be the
 * TUI's or the Web UI's and nothing bounds it. So the switch looks after
 * itself. Making a framework starts its modules, the Web UI's among them,
 * which opens the Web UI's server again if the stop has already closed it,
 * so a framework made after the stop began is stopped, and the server closed,
 * rather than installed. A making that fails once the stop has begun closes
 * the server too, since it may have started the Web UI's module before it
 * failed. Once the host is stopping, the TUI draws nothing, and the Web UI's
 * answer to a failed switch goes to a connection the switch's close has
 * just ended, so a failed making, or a failed stop of the framework the
 * switch made, is also logged (`log`).
 */
export async function switchSessionSteps<F extends { stop(): Promise<void> }>(
  app: { stopping?: boolean },
  steps: {
    /** Stop the framework the host holds now. */
    stopOld(): Promise<void>;
    /** Make the switched-to session's framework. */
    make(): Promise<F>;
    /** Make it the one the host holds, and start it. */
    install(next: F): Promise<void> | void;
    /** Close the Web UI's server. */
    stopServer(): Promise<void>;
  },
  log: (line: string) => void = (line) => console.error(line),
): Promise<void> {
  if (app.stopping) throw new Error('the host is stopping, so it starts no session switch');
  await steps.stopOld();
  if (app.stopping) return;
  let next: F;
  try {
    next = await steps.make();
  } catch (error) {
    if (app.stopping) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`[framework] the host began to stop during a session switch, and making the switched-to session's framework failed: ${reason}`);
      await steps.stopServer();
    }
    throw error;
  }
  if (app.stopping) {
    try {
      await next.stop();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`[framework] the host began to stop during a session switch, and stopping the framework the switch had made failed: ${reason}`);
      throw error;
    } finally {
      await steps.stopServer();
    }
    return;
  }
  await steps.install(next);
}
