export async function switchSessionSteps<F extends { stop(): Promise<void> }>(
  app: { stopping?: boolean },
  steps: {
    stopOld(): Promise<void>;
    make(): Promise<F>;
    install(next: F): Promise<void> | void;
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
