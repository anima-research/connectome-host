/**
 * The framework's traces from create() on, held for a sink that attaches
 * later. create() replays its early traces (registry restore, work a stop
 * cut off, resumed tune-out epochs) only to a listener attached before
 * start(), which drops the replay buffer; the headless runtime attaches its
 * sink, for the agent tree, the socket and the host's idle, after start().
 * This listener bridges the gap: it takes the replay and everything after,
 * holds it in order, and hands it all to the sink once, then forwards live.
 */
import type { AgentFramework, TraceEvent } from '@animalabs/agent-framework';

export interface BootTraceHold {
  /**
   * Deliver what is held, oldest first, then everything that follows, to
   * `sink`. Takes effect once; a second call does nothing and reports
   * nothing lost. Reports how many boot traces were lost before the sink,
   * which the sink may want to say: those the hold dropped past its cap, and
   * those the framework's replay said it didn't keep; and, of the
   * `inference:started` traces the hold dropped, the latest for each agent.
   */
  handOver(sink: (event: TraceEvent) => void): { lost: number; lostStarts: TraceEvent[] };
}

/** As many early traces as the framework itself keeps for replay. */
export const BOOT_TRACE_CAP = 1000;

/**
 * The hold keeps the FIRST `cap` traces, not the latest: what it exists for
 * is the boot, and a restart's notices come first.
 */
export function holdBootTraces(framework: Pick<AgentFramework, 'onTrace'>, cap = BOOT_TRACE_CAP): BootTraceHold {
  let held: TraceEvent[] | null = [];
  let dropped = 0;
  const lostStarts = new Map<unknown, TraceEvent>();
  let sink: ((event: TraceEvent) => void) | null = null;
  framework.onTrace((event) => {
    const lost = (event as { type: string }).type === 'dendrite:early-traces-dropped'
      ? (event as unknown as { dropped?: unknown }).dropped : undefined;
    if (sink) sink(event);
    else if (typeof lost === 'number') dropped += lost;
    else if (held) {
      if (held.length < cap) held.push(event);
      else {
        dropped++;
        if ((event as { type: string }).type === 'inference:started') {
          const agentName = (event as { agentName?: unknown }).agentName;
          lostStarts.delete(agentName);
          lostStarts.set(agentName, event);
        }
      }
    }
  }, { replay: true });
  return {
    handOver(next) {
      if (sink) return { lost: 0, lostStarts: [] };
      const replay = held ?? [];
      held = null;
      sink = next;
      for (const event of replay) next(event);
      return { lost: dropped, lostStarts: [...lostStarts.values()] };
    },
  };
}
