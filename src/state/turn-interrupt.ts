import { TURN_RUNNING_TRACES, TURN_SETTLED_TRACES } from './turn-trace.js';

/**
 * An operator's interrupt of an agent's turn, as the TUI's Escape and the
 * Web UI's interrupt send it.
 *
 * agent-framework 0.22.3's `abortInference` stops a turn only while it holds
 * its model call or its stream: inferring, streaming, waiting on tools
 * beside its stream, or at the boundary after a round's tools while the
 * round is stored. While the turn compiles its context, after
 * `inference:started` and before the call, the agent is still idle and it
 * returns false, and so it does while a failed turn waits to be tried again,
 * or runs tools between model calls with no stream open. A reset then would
 * show the turn as ended while it ran on. So an interrupt that finds nothing
 * to abort while a turn is running is kept, and the turn is aborted at the
 * first trace naming its agent that comes once it can be, which sends
 * `inference:aborted`, the end every surface follows. The tool traces name
 * no agent, so a turn running tools is aborted at its next model call, and a
 * retry once its stream has started.
 *
 * A kept interrupt is forgotten when its turn settles (TURN_SETTLED_TRACES),
 * when it aborts the turn, and at a reset. A start doesn't end a turn: a
 * failed attempt's retry, a budget restart and a guard retry each start the
 * same turn again with no end before it (turn-trace.ts). 0.22.3 ends a turn
 * it drops after `inference:started` (its agent replaced or removed, or the
 * framework stopping or stopped and started again) with `inference:aborted`,
 * which forgets the interrupt, but sends no end when another turn of the
 * agent's name has already begun. Traces carry no turn id, so the follower
 * can't tell that turn from the dropped one, and an interrupt kept for the
 * dropped turn aborts it. It sends none either for an ephemeral run its idle
 * watchdog disposes, whose name isn't used again, nor for a failed attempt
 * whose held retry it drops (turn-trace.ts). Where the agent goes on, an
 * interrupt kept for that turn then aborts the agent's next one. A surface
 * starts again with a new follower when the host switches sessions (reset,
 * or one per framework).
 *
 * The abort for a kept interrupt runs on a microtask, after the trace that
 * prompted it has reached every listener: for an inference that holds no
 * stream the framework sends its `inference:aborted` at once, and inside
 * that trace's delivery it would reach the surfaces before the trace itself.
 * A stream's `inference:aborted` comes later, when the stream ends. Out of
 * the delivery, it's out of the framework's catch around each listener too,
 * so a throw from the abort is caught here, the immediate one too, and read
 * as nothing aborted: it's logged once for each interrupt, and the interrupt
 * is kept, or stays kept, while its turn runs, to be tried at the turn's next
 * trace.
 *
 * Fed every trace by its surface's own subscription. It holds which agents
 * have a turn running, which have an interrupt kept, and which have had a
 * failed abort logged, and calls only the abort it's given, and
 * console.error when that throws. A try that finds nothing to abort yet
 * changes nothing: `abortInference` then emits nothing and returns false.
 */
export class TurnInterrupts {
  /** Agents whose turn has started, or been seen running (TURN_RUNNING_TRACES)
   *  when its start was missed, and not settled. */
  private readonly running = new Set<string>();
  /** Kept interrupts: the agent, and the reason it's aborted with. */
  private readonly pending = new Map<string, string>();
  /** Agents whose abort has thrown since their interrupt, logged once. */
  private readonly failureLogged = new Set<string>();

  constructor(private readonly abort: (agentName: string, reason: string) => boolean) {}

  /** Interrupt the agent's turn: at once if it can be aborted, else when it
   *  can be, if a turn is running. */
  interrupt(agentName: string, reason: string): 'aborted' | 'deferred' | 'idle' {
    this.failureLogged.delete(agentName);
    if (this.tryAbort(agentName, reason)) {
      this.pending.delete(agentName);
      return 'aborted';
    }
    if (!this.running.has(agentName)) return 'idle';
    this.pending.set(agentName, reason);
    return 'deferred';
  }

  /** Whether an interrupt is kept for the agent's turn. */
  isPending(agentName: string): boolean {
    return this.pending.has(agentName);
  }

  /** Whether the agent has a turn running: started, or seen running when
   *  its start was missed, and not settled, a failed attempt waiting to be
   *  tried again included, and, since nothing tells them apart, one whose
   *  retry the framework dropped with no trace, until the agent's next turn
   *  settles. A turn whose start was missed counts only from its first tool
   *  call or resumed stream, so one that answers with neither, or fails
   *  before either, doesn't. */
  isRunning(agentName: string): boolean {
    return this.running.has(agentName);
  }

  onTrace(trace: { type: string; agentName?: unknown }): void {
    const agentName = typeof trace.agentName === 'string' ? trace.agentName : undefined;
    if (agentName === undefined) return;
    if (TURN_SETTLED_TRACES.has(trace.type)) {
      this.running.delete(agentName);
      this.pending.delete(agentName);
      return;
    }
    if (trace.type === 'inference:started' || TURN_RUNNING_TRACES.has(trace.type)) this.running.add(agentName);
    if (!this.pending.has(agentName)) return;
    queueMicrotask(() => {
      const reason = this.pending.get(agentName);
      if (reason !== undefined && this.tryAbort(agentName, reason)) this.pending.delete(agentName);
    });
  }

  /** The abort, with a throw read as nothing aborted, and logged once for
   *  each interrupt. */
  private tryAbort(agentName: string, reason: string): boolean {
    try {
      return this.abort(agentName, reason);
    } catch (err) {
      if (!this.failureLogged.has(agentName)) {
        this.failureLogged.add(agentName);
        console.error(`[interrupt] aborting ${agentName}'s turn failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return false;
    }
  }

  /** Forget every turn: the framework these traces came from is gone. */
  reset(): void {
    this.running.clear();
    this.pending.clear();
  }
}

/**
 * An operator's interrupt, for each agent named: its turn is aborted at once
 * if its model call is in flight, else as soon as it can be (TurnInterrupts),
 * which sends inference:aborted, the end every surface takes as the turn's.
 * An agent the framework can't abort and the follower has no turn for is
 * left as it is. One agent's abort failing doesn't stop the rest, since the
 * follower reads a throw as nothing aborted. Returns the agents whose turn
 * was aborted and those whose turn will be.
 */
export function interruptAgents(
  agentNames: readonly string[],
  interrupts: Pick<TurnInterrupts, 'interrupt'>,
  reason: string,
): { aborted: string[]; deferred: string[] } {
  const aborted: string[] = [];
  const deferred: string[] = [];
  for (const name of agentNames) {
    const outcome = interrupts.interrupt(name, reason);
    if (outcome === 'aborted') aborted.push(name);
    else if (outcome === 'deferred') deferred.push(name);
  }
  return { aborted, deferred };
}

/**
 * An operator's interrupt of the subagents: each subagent's turn goes to
 * the follower first, then the subagent module stops their runs (stopRuns,
 * its cancelAll), so each run's partial result still reaches its caller.
 * The module's stop ends only a turn whose stream is open: agent-framework
 * 0.22.3's cancelStream cancels an open stream and sets the agent idle, and
 * an ephemeral agent's cleanup does nothing, so a subagent's turn whose
 * model call is in flight before its first token, or that is compiling,
 * waiting to try a failed attempt again or running tools between model
 * calls, goes on unless the follower aborts it. Taken first, a turn whose
 * model call is in flight, streaming or not, is aborted at once, rather
 * than left idle by the module's stop with an interrupt kept, and any other
 * is kept and aborted once it can be. Returns the runs stopped, and the
 * subagents' turns aborted and kept.
 */
export function interruptSubagents(
  agentNames: readonly string[],
  isSubagent: (agentName: string) => boolean,
  interrupts: Pick<TurnInterrupts, 'interrupt'>,
  stopRuns: () => number,
  reason: string,
): { stopped: number; aborted: string[]; deferred: string[] } {
  const turns = interruptAgents(agentNames.filter(isSubagent), interrupts, reason);
  return { stopped: stopRuns(), ...turns };
}
