/**
 * agent-framework 0.33.0's traces don't say which events started a turn, so a line's wait counts from when the host
 * takes the line in. Lines the host queued while a turn ran are answered together, in the turn after it, so a line
 * taken in during a turn waits for the turn after it. The framework may retry a failed turn, or hold it and run it
 * again, so `inference:failed` doesn't end a wait.
 */

import { STREAM_END_TRACES, TURN_SETTLED_TRACES, traceError } from './state/turn-trace.js';
import { createTurnFailures, turnEndedLine } from './state/turn-failures.js';

export interface PipedOutput {
  write(text: string): void;
  log(line: string): void;
  error(line: string): void;
}

export interface PipedTurns {
  onTrace(event: { type: string; [key: string]: unknown }): void;
  waitForTurn(capMs?: number | null): Promise<void> & { cancel(): void };
  /** The host follows another framework, whose turns owe nothing to the
   *  failures counted so far, and a line waiting on the old one's turn is
   *  released. */
  switched(): void;
  holdCaps(): () => void;
  endAll(): void;
  running(): boolean;
  takenIn(): void;
  owed(): boolean;
  /** A turn is running, or a line is owed one: what setup's close asks. */
  unanswered(): boolean;
}

export const PIPED_TURN_CAP_MS = 120_000;

export function createPipedTurns(
  primaryAgentName: string,
  out: PipedOutput,
  hint: (errorType: string | undefined) => string | undefined = () => undefined,
  showsItself: (tool: string) => boolean = () => false,
  settledUnwaited: () => void = () => {},
): PipedTurns {
  const streams = new Map<string, 'open' | 'failed'>();
  let failures = createTurnFailures();
  let turnsStarted = 0;
  let lastTakenIn: number | null = null;
  let turnRunning = false;
  const waits: Array<{ after: number; taken: boolean; arm: () => void; hold: () => void; done: () => void }> = [];
  let held = 0;
  let lateTakeIns = 0;
  const end = (wait: (typeof waits)[number], takeInComing = !wait.taken): void => {
    waits.splice(waits.indexOf(wait), 1);
    if (takeInComing) lateTakeIns++;
    wait.done();
  };

  function onTrace(event: { type: string; [key: string]: unknown }): void {
    const agent = typeof event.agentName === 'string' ? event.agentName : undefined;
    switch (event.type) {
      case 'inference:started':
        if (agent === primaryAgentName && !turnRunning) {
          turnRunning = true;
          turnsStarted++;
        }
        if (agent !== undefined) streams.set(agent, 'open');
        failures.onTrace(event);
        out.write('\n');
        return;
      case 'inference:tokens':
        if (typeof event.content === 'string' && event.content !== '') out.write(event.content);
        return;
      case 'inference:tool_calls_yielded': {
        const calls = ((event.calls as Array<{ name: string }> | undefined) ?? []).filter((c) => !showsItself(c.name));
        if (calls.length === 0) out.write('\n');
        else out.log(`\n[tools] ${calls.map((c) => c.name).join(', ')}`);
        return;
      }
      case 'tool:started': {
        if (showsItself(String(event.tool))) return;
        const toolInput = event.input ? JSON.stringify(event.input) : '';
        const truncated = toolInput.length > 120 ? toolInput.slice(0, 120) + '...' : toolInput;
        out.log(`[tool] ${String(event.tool)}${truncated ? ' ' + truncated : ''}`);
        return;
      }
    }
    if (agent === undefined || !STREAM_END_TRACES.has(event.type)) return;
    const state = streams.get(agent);
    if (state === undefined) return;
    const step = failures.onTrace(event);
    const primary = agent === primaryAgentName;
    if (state === 'open') {
      if (event.type === 'inference:failed') {
        out.write('\n');
        if (step?.show === 'line') out.error(`Error: ${step.text}`);
      } else if (event.type === 'inference:exhausted') {
        out.write('\n');
        out.error(primary ? `(turn ended: ${traceError(event)})` : `Error: ${traceError(event)}`);
      } else if (primary && event.type === 'inference:aborted') {
        const reason = typeof event.reason === 'string' && event.reason !== '' ? `: ${event.reason}` : '';
        out.log(`\n(turn aborted${reason})`);
      } else {
        out.write('\n');
      }
    }
    const ended = primary && step?.show === 'ended' ? turnEndedLine(step, hint(step.errorType)) : undefined;
    if (ended) out.error(ended);
    if (!TURN_SETTLED_TRACES.has(event.type)) {
      streams.set(agent, 'failed');
      return;
    }
    streams.delete(agent);
    if (primary) {
      turnRunning = false;
      const ending = waits.filter((wait) => wait.taken && wait.after < turnsStarted);
      for (const wait of ending) end(wait);
      waits[0]?.arm();
      if (ending.length === 0 && waits.length === 0) settledUnwaited();
    }
  }

  function waitForTurn(capMs: number | null = PIPED_TURN_CAP_MS): Promise<void> & { cancel(): void } {
    let asked: (typeof waits)[number] | undefined;
    const answered = new Promise<void>((resolve) => {
      // A pending timer holds the event loop open, so it's cleared once the turn
      // settles.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let left = capMs;
      let since = 0;
      const wait = {
        after: turnsStarted,
        taken: false,
        arm: (): void => {
          if (capMs === null || left === null || timer !== undefined || held > 0) return;
          since = performance.now();
          timer = setTimeout(() => {
            if (!waits.includes(wait)) return;
            out.error(`(no answer after ${capMs / 1000} s: going on; it prints here when it comes)`);
            end(wait);
            waits[0]?.arm();
          }, left);
        },
        hold: (): void => {
          if (timer === undefined || left === null) return;
          clearTimeout(timer);
          timer = undefined;
          left = Math.max(0, left - (performance.now() - since));
        },
        done: (): void => { clearTimeout(timer); resolve(); },
      };
      asked = wait;
      waits.push(wait);
      if (waits[0] === wait) wait.arm();
    });
    const wait = asked!;
    return Object.assign(answered, {
      cancel: (): void => {
        if (!waits.includes(wait)) return;
        const first = waits[0] === wait;
        end(wait, false);
        if (first) waits[0]?.arm();
      },
    });
  }

  function switched(): void {
    lastTakenIn = null;
    lateTakeIns = 0;
    streams.clear();
    failures = createTurnFailures();
    turnRunning = false;
    for (const wait of waits.splice(0)) wait.done();
  }

  function holdCaps(): () => void {
    held++;
    waits[0]?.hold();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held--;
      if (held === 0) waits[0]?.arm();
    };
  }

  function endAll(): void {
    for (const wait of waits.splice(0)) wait.done();
  }

  function takenIn(): void {
    lastTakenIn = turnsStarted;
    if (lateTakeIns > 0) {
      lateTakeIns--;
      return;
    }
    const wait = waits.find((each) => !each.taken);
    if (wait === undefined) return;
    wait.taken = true;
    wait.after = turnsStarted;
  }

  const owed = (): boolean => lateTakeIns > 0 || (lastTakenIn !== null && turnsStarted <= lastTakenIn);
  return {
    onTrace, waitForTurn, switched, holdCaps, endAll, running: () => turnRunning, takenIn, owed,
    unanswered: () => turnRunning || owed(),
  };
}

export interface TraceSource {
  onTrace(listener: (event: unknown) => void, options?: { replay?: boolean }): () => void;
}

export function traceFollower(
  listener: (event: unknown) => void,
  options?: { replay?: boolean },
): { follow(source: TraceSource): void; stop(): void } {
  let off: (() => void) | undefined;
  const stop = (): void => {
    off?.();
    off = undefined;
  };
  return {
    follow(source) {
      stop();
      off = source.onTrace(listener, options);
    },
    stop,
  };
}

export async function switchFollowing<T>(
  traces: { follow(source: TraceSource): void; stop(): void },
  switchSession: () => Promise<T>,
  framework: () => TraceSource,
  stopped: () => void = () => {},
): Promise<T> {
  traces.stop();
  stopped();
  try {
    return await switchSession();
  } finally {
    traces.follow(framework());
  }
}
