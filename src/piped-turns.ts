/**
 * Piped mode's view of the agent's turns (`--no-tui`, or batch mode when
 * stdin isn't a TTY): it prints every agent's prose and each tool call as
 * they stream, but for a tool that shows the person what it does itself,
 * and waits for the turn an input line started before it takes the next
 * line.
 *
 * The wait follows the primary agent alone, by the name the framework's
 * agent was created with: a sync subagent streams inside the primary's
 * turn, and its end isn't the end of the line's turn. The wait ends at one
 * of the primary's TURN_SETTLED_TRACES. At `inference:failed` it prints
 * the error, unless it repeats the error the turn's last failure printed,
 * and keeps waiting, since the framework may retry the turn, or
 * hold it and run it again, and either answers the line. The wait's cap
 * still bounds it, counted from when no wait asked before it is left: at
 * the ask, or when the last of those ends, by its turn or its own cap; and
 * not while the terminal asks the person something (holdCaps). A
 * turn held longer than the cap lets the next line go in, with a line on
 * stderr saying so, and that turn's answer prints if it
 * comes while piped mode still runs; after a batch's last line, the host
 * goes on to its teardown. The framework's traces don't say which events
 * started a turn, so a wait ends at the end of the first turn of the
 * primary's that starts after the wait was asked for: ask for it before the
 * line goes in, and a line that goes in while a turn runs waits for the turn
 * after that one, which the framework starts for every request queued while
 * the agent was busy. Another turn of the primary's that starts first, such
 * as a wake's, ends it too. A turn of the primary's that ends no wait, with
 * none left, such as one whose wait its cap ended, or a wake's, is told to
 * `settledUnwaited`.
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
  waitForTurn(capMs?: number | null): Promise<void>;
  /** The host follows another framework, whose turns owe nothing to the
   *  failures counted so far, and a line waiting on the old one's turn is
   *  released. */
  switched(): void;
  holdCaps(): () => void;
}

/** The longest a line waits for its turn. */
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
  let turnRunning = false;
  const waits: Array<{ after: number; arm: () => void; hold: () => void; done: () => void }> = [];
  let held = 0;
  const end = (wait: (typeof waits)[number]): void => {
    waits.splice(waits.indexOf(wait), 1);
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
      const ending = waits.filter((wait) => wait.after < turnsStarted);
      for (const wait of ending) end(wait);
      waits[0]?.arm();
      if (ending.length === 0 && waits.length === 0) settledUnwaited();
    }
  }

  function waitForTurn(capMs: number | null = PIPED_TURN_CAP_MS): Promise<void> {
    return new Promise((resolve) => {
      // A pending timer holds the event loop open, so it's cleared once the turn
      // settles.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let left = capMs;
      let since = 0;
      const wait = {
        after: turnsStarted,
        arm: (): void => {
          if (capMs === null || left === null || timer !== undefined || held > 0) return;
          since = Date.now();
          timer = setTimeout(() => {
            if (!waits.includes(wait)) return;
            out.error(`(no answer after ${capMs / 1000} s: going on without it)`);
            end(wait);
            waits[0]?.arm();
          }, left);
        },
        hold: (): void => {
          if (timer === undefined || left === null) return;
          clearTimeout(timer);
          timer = undefined;
          left = Math.max(0, left - (Date.now() - since));
        },
        done: (): void => { clearTimeout(timer); resolve(); },
      };
      waits.push(wait);
      if (waits[0] === wait) wait.arm();
    });
  }

  function switched(): void {
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

  return { onTrace, waitForTurn, switched, holdCaps };
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
): Promise<T> {
  traces.stop();
  try {
    return await switchSession();
  } finally {
    traces.follow(framework());
  }
}
