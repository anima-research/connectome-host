import type { PanelOp } from './web/panel-data.js';

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

/** The pin and settings panel ops that change the session they act on. */
export const PANEL_OPS_THAT_CHANGE_THE_SESSION: ReadonlySet<string> = new Set<PanelOp>([
  'settings-update',
  'settings-reset',
  'settings-cancel-transition',
  'pin-add',
  'pin-remove',
]);

/** The refusal every entry gives an action that would change the session
 *  while a switch is under way, or null when no switch is. */
export function refusedWhileSwitching(app: { switching?: boolean }, what: string): string | null {
  return app.switching
    ? `${what} refused: a session switch is under way. Nothing changed; try again once the switch has finished.`
    : null;
}

const running = new WeakMap<object, Map<symbol, string>>();

/** Holds a switch off while `work` runs, under `what`'s name, until it settles. */
export function trackRunning<T>(app: object, what: string, work: Promise<T>): Promise<T> {
  const names = running.get(app) ?? new Map<symbol, string>();
  running.set(app, names);
  const token = Symbol(what);
  names.set(token, what);
  return work.finally(() => names.delete(token));
}

/** The names of the work still running on `app`, each once. */
export function runningNames(app: object): string[] {
  return [...new Set(running.get(app)?.values() ?? [])];
}
