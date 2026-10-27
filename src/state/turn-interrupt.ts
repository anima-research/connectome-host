import { TURN_RUNNING_TRACES, TURN_SETTLED_TRACES } from './turn-trace.js';

export class TurnInterrupts {
  private readonly running = new Set<string>();
  private readonly pending = new Map<string, string>();
  private readonly failureLogged = new Set<string>();

  constructor(private readonly abort: (agentName: string, reason: string) => boolean) {}

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

  isPending(agentName: string): boolean {
    return this.pending.has(agentName);
  }

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

  reset(): void {
    this.running.clear();
    this.pending.clear();
  }
}

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
