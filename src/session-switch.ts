import type { PanelOp } from './web/panel-data.js';

export const SWITCH_UNDER_WAY = 'a session switch is under way, so this one isn\'t started; try again once it has finished';
export const HOST_STOPPING = 'the host is stopping, so it starts no session switch';

/** Resolves true once it has installed the switched-to session's framework, and false when the host began to
 *  stop first, having installed none. While it runs, `app.switchSettled` resolves when it settles, either way,
 *  to whether stopping a framework it had made failed. */
export async function switchSessionSteps<F extends { stop(): Promise<void> }>(
  app: { stopping?: boolean; switching?: boolean; switchSettled?: Promise<{ madeStopFailed: boolean }> },
  steps: {
    stopOld(): Promise<void>;
    make(): Promise<F>;
    install(next: F): Promise<void> | void;
    stopServer(): Promise<void>;
  },
  log: (line: string) => void = (line) => console.error(line),
): Promise<boolean> {
  if (app.stopping) throw new Error(HOST_STOPPING);
  if (app.switching) throw new Error(SWITCH_UNDER_WAY);
  app.switching = true;
  let madeStopFailed = false;
  let settled!: (outcome: { madeStopFailed: boolean }) => void;
  app.switchSettled = new Promise((resolve) => { settled = resolve; });
  try {
    await steps.stopOld();
    if (app.stopping) return false;
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
        madeStopFailed = true;
        const reason = error instanceof Error ? error.message : String(error);
        log(`[framework] the host began to stop during a session switch, and stopping the framework the switch had made failed: ${reason}`);
        throw error;
      } finally {
        await steps.stopServer();
      }
      return false;
    }
    await steps.install(next);
    return true;
  } finally {
    app.switching = false;
    settled({ madeStopFailed });
  }
}

/** What a caller says of a switch the host's stop left unfinished: which session the next start opens. */
export function switchLeftForStop(active: { name: string; id: string } | null | undefined): string {
  return 'The host began to stop during the session switch, so the switch didn\'t finish; the next start opens ' +
    (active ? `session ${active.name} [${active.id}].` : 'a new session.');
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

type NamedSession = { id: string; name: string };

export function refusedForAnotherSession(
  open: string,
  sessions: { findSession(nameOrId: string): NamedSession | null | undefined },
  chosenIn: string,
  what: string,
): string | null {
  if (chosenIn === open) return null;
  const label = (id: string): string => {
    try {
      const session = sessions.findSession(id);
      if (session?.id === id) return `session "${session.name}" [${id}]`;
    } catch { }
    return `session ${id}`;
  };
  return `${what} refused: it was chosen in ${label(chosenIn)}, and ${label(open)} is open now. Nothing changed; choose again in ${label(open)}.`;
}

const running = new WeakMap<object, Map<symbol, string | null>>();

/** Counts `work`, an operator's command or action, as running on `app` until it settles. A headless host's quiet
 *  waits for all such work; a session switch is held off only while work `changesSession` names runs. */
export function trackOperatorWork<T>(app: object, changesSession: string | null, work: Promise<T>): Promise<T> {
  const entries = running.get(app) ?? new Map<symbol, string | null>();
  running.set(app, entries);
  const token = Symbol(changesSession ?? 'operator work');
  entries.set(token, changesSession);
  return work.finally(() => entries.delete(token));
}

/** The names of the session-changing work still running on `app`, each once. */
export function sessionChangesRunning(app: object): string[] {
  return [...new Set([...running.get(app)?.values() ?? []].filter((name): name is string => name !== null))];
}

/** Whether any operator work is still running on `app`. */
export function operatorWorkRunning(app: object): boolean {
  return (running.get(app)?.size ?? 0) > 0;
}
