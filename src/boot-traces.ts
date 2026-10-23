/**
 * The framework's traces from create() on, held for a sink that attaches
 * later. create() replays its early traces (registry restore, work a stop
 * cut off, resumed tune-out epochs) only to a listener attached before
 * start(), which drops the replay buffer; the headless runtime attaches its
 * tree-and-socket sink after start(). This listener bridges the gap: it
 * takes the replay and everything after, holds it in order, and hands it
 * all to the sink once, then forwards live.
 */
import type { AgentFramework, TraceEvent } from '@animalabs/agent-framework';

export interface BootTraceHold {
  /**
   * Deliver what is held, oldest first, then everything that follows, to
   * `sink`. Takes effect once; a second call does nothing. Returns how many
   * traces the hold dropped past its cap, which the sink may want to say.
   */
  handOver(sink: (event: TraceEvent) => void): number;
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
  let sink: ((event: TraceEvent) => void) | null = null;
  framework.onTrace((event) => {
    if (sink) sink(event);
    else if (held) {
      if (held.length < cap) held.push(event);
      else dropped++;
    }
  }, { replay: true });
  return {
    handOver(next) {
      if (sink) return 0;
      const replay = held ?? [];
      held = null;
      sink = next;
      for (const event of replay) next(event);
      return dropped;
    },
  };
}
