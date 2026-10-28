export const SWITCH_UNDER_WAY = 'a session switch is under way, so this one isn\'t started; try again once it has finished';

export async function switchSessionSteps<F extends { stop(): Promise<void> }>(
  app: { stopping?: boolean; switching?: boolean },
  steps: {
    stopOld(): Promise<void>;
    make(): Promise<F>;
    install(next: F): Promise<void> | void;
    stopServer(): Promise<void>;
  },
  log: (line: string) => void = (line) => console.error(line),
): Promise<void> {
  if (app.stopping) throw new Error('the host is stopping, so it starts no session switch');
  if (app.switching) throw new Error(SWITCH_UNDER_WAY);
  app.switching = true;
  try {
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
  } finally {
    app.switching = false;
  }
}
