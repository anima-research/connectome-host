/**
 * Piped mode's view of the agent's turns (`--no-tui`, or batch mode when
 * stdin isn't a TTY): it prints every agent's prose and each tool call as
 * they stream, and waits for the turn an input line started before it reads
 * the next line. Kept apart from the framework so tests can drive it with
 * traces.
 *
 * The wait follows the primary agent alone, by the name the framework's
 * agent was created with: a sync subagent streams inside the primary's
 * turn, and its end isn't the end of the line's turn. The wait ends at one
 * of the primary's TURN_SETTLED_TRACES (state/turn-trace.ts). At
 * `inference:failed` it prints the error and keeps waiting, since the
 * framework may retry the turn, or hold it and run it again, and either
 * answers the line. The wait's cap still bounds it: a turn held longer than
 * the cap lets the next line go in, with a line on stderr saying so, and
 * that turn's answer prints if it comes while piped mode still runs; after
 * a batch's last line, the host goes on to its teardown.
 * The framework's traces don't say which events started a turn, so the wait
 * can't tell its line's turn from another turn of the primary's, such as a
 * wake's.
 */

import { STREAM_END_TRACES, TURN_SETTLED_TRACES, traceError } from './state/turn-trace.js';

export interface PipedOutput {
  /** Text to stdout as it comes: prose, and the line breaks around it. */
  write(text: string): void;
  /** A line to stdout. */
  log(line: string): void;
  /** A line to stderr. */
  error(line: string): void;
}

export interface PipedTurns {
  onTrace(event: { type: string; [key: string]: unknown }): void;
  /** Resolves when the primary agent's turn settles, or after `capMs`. */
  waitForTurn(capMs?: number): Promise<void>;
}

/** The longest a line waits for its turn. */
export const PIPED_TURN_CAP_MS = 120_000;

export function createPipedTurns(primaryAgentName: string, out: PipedOutput): PipedTurns {
  /** Each agent's stream from its start until it settles: 'open' until its
   *  first end, 'failed' after a failure, while a retry or a held turn can
   *  still answer. An end that finds none comes after the stream settled, as
   *  the `turn_ended` after a tool-ended turn's `completed` does, and is
   *  nothing new. agent-framework 0.22.3 sends it before the turn releases
   *  the agent, and starts no next turn of the agent until then
   *  (state/turn-trace.ts). */
  const streams = new Map<string, 'open' | 'failed'>();
  let settle: (() => void) | null = null;

  function onTrace(event: { type: string; [key: string]: unknown }): void {
    const agent = typeof event.agentName === 'string' ? event.agentName : undefined;
    switch (event.type) {
      case 'inference:started':
        if (agent !== undefined) streams.set(agent, 'open');
        out.write('\n');
        return;
      case 'inference:tokens':
        if (typeof event.content === 'string' && event.content !== '') out.write(event.content);
        return;
      case 'inference:tool_calls_yielded': {
        const calls = (event.calls as Array<{ name: string }> | undefined) ?? [];
        out.log(`\n[tools] ${calls.map((c) => c.name).join(', ')}`);
        return;
      }
      case 'tool:started': {
        const toolInput = event.input ? JSON.stringify(event.input) : '';
        const truncated = toolInput.length > 120 ? toolInput.slice(0, 120) + '...' : toolInput;
        out.log(`[tool] ${String(event.tool)}${truncated ? ' ' + truncated : ''}`);
        return;
      }
    }
    if (agent === undefined || !STREAM_END_TRACES.has(event.type)) return;
    const state = streams.get(agent);
    if (state === undefined) return;
    const primary = agent === primaryAgentName;
    // A stream's first end closes its prose line, and for the primary says
    // how its turn ended. An end after an end, such as `exhausted` after
    // `failed`, prints nothing.
    if (state === 'open') {
      if (event.type === 'inference:failed') {
        out.error(`\nError: ${traceError(event)}`);
      } else if (primary && event.type === 'inference:aborted') {
        const reason = typeof event.reason === 'string' && event.reason !== '' ? `: ${event.reason}` : '';
        out.log(`\n(turn aborted${reason})`);
      } else if (primary && event.type === 'inference:exhausted') {
        out.log(`\n(turn ended: ${traceError(event)})`);
      } else {
        out.write('\n');
      }
    }
    if (!TURN_SETTLED_TRACES.has(event.type)) {
      streams.set(agent, 'failed');
      return;
    }
    // Settled: a later end of this stream finds nothing (see `streams`).
    streams.delete(agent);
    if (primary) {
      const done = settle;
      settle = null;
      done?.();
    }
  }

  function waitForTurn(capMs = PIPED_TURN_CAP_MS): Promise<void> {
    return new Promise((resolve) => {
      // The timer only caps the wait. Clear it once the turn settles: a
      // pending timer held the event loop open, so a batch run sat out the
      // cap after `Done.` before the process exited.
      const timer = setTimeout(() => {
        if (settle !== done) return;
        settle = null;
        out.error(`(no answer after ${capMs / 1000} s: going on without it)`);
        resolve();
      }, capMs);
      const done = (): void => { clearTimeout(timer); resolve(); };
      settle = done;
    });
  }

  return { onTrace, waitForTurn };
}

/** What sends traces: a framework, whose onTrace returns the listener's
 *  unsubscribe. */
export interface TraceSource {
  onTrace(listener: (event: unknown) => void): () => void;
}

/**
 * Follows one framework's traces at a time. Following a framework stops
 * following the last.
 */
export function traceFollower(listener: (event: unknown) => void): { follow(source: TraceSource): void; stop(): void } {
  let off: (() => void) | undefined;
  const stop = (): void => {
    off?.();
    off = undefined;
  };
  return {
    follow(source) {
      stop();
      off = source.onTrace(listener);
    },
    stop,
  };
}

/**
 * A session switch under a trace follower. The switch stops the framework
 * and makes another, so this stops following before it, and follows
 * whichever framework the host holds after it, also when it throws: the new
 * one, or after a failed switch whatever the host was left with, which can
 * be the old framework, stopped (a stopped framework keeps its listeners,
 * so a late trace of its own can still arrive). The switch's error then
 * goes on to the caller.
 */
export async function switchFollowing(
  traces: { follow(source: TraceSource): void; stop(): void },
  switchSession: () => Promise<unknown>,
  framework: () => TraceSource,
): Promise<void> {
  traces.stop();
  try {
    await switchSession();
  } finally {
    traces.follow(framework());
  }
}
