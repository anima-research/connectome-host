import type { TraceEvent } from '@animalabs/agent-framework';
import type { AgentPhase } from './agent-tree-reducer.js';

export interface AgentPhaseState {
  phase: AgentPhase;
  /** When the agent entered this phase (ms). */
  since: number;
}

export interface AgentPhaseChange extends AgentPhaseState {
  agentName: string;
}

/** Where a turn stands, as the tree's node status has it: what a later event may do depends on it. */
type TurnStatus = 'running' | 'finished' | 'stopped';

const TRANSITIONS: Readonly<Record<string, { phase: AgentPhase; status?: TurnStatus }>> = {
  'inference:started': { phase: 'sending', status: 'running' },
  'inference:tokens': { phase: 'streaming' },
  'inference:tool_calls_yielded': { phase: 'invoking' },
  'inference:completed': { phase: 'done', status: 'finished' },
  'inference:turn_ended': { phase: 'done', status: 'finished' },
  'inference:failed': { phase: 'attempt-failed', status: 'running' },
  'inference:exhausted': { phase: 'failed', status: 'finished' },
  'inference:aborted': { phase: 'cancelled', status: 'stopped' },
  'dendrite:agent-interrupted': { phase: 'cancelled', status: 'stopped' },
};

interface Tracked extends AgentPhaseState {
  status: TurnStatus;
}

/**
 * This process's agents' phases, in the web UI's tree's words, for clients that
 * may not read the traces they come from: those carry messages and tool calls.
 *
 * It isn't the tree's reducer, though a test holds the two to the same phases.
 * That reducer guesses nodes from tool calls so a page can draw them, naming
 * them with whatever the call's input says, and it keeps them for good. That's
 * content a `health` client may not read, and growth a host can't afford. So an
 * agent is here from its first turn, by the name the framework gives it, until
 * it ends. A fleet child reports its own, in its own process.
 */
export class AgentPhases {
  private readonly phases = new Map<string, Tracked>();
  /** Who made each tool call still running: tool events name only the call. */
  private readonly callOwners = new Map<string, string>();

  constructor(agentNames: readonly string[] = [], now: number = Date.now()) {
    for (const name of agentNames) this.phases.set(name, { phase: 'idle', since: now, status: 'running' });
  }

  /** Takes one trace event and returns the phase it changed, if it did. */
  apply(event: TraceEvent | { type: string }): AgentPhaseChange[] {
    const e = event as { type: string; agentName?: unknown; callId?: unknown; calls?: unknown; timestamp?: unknown; reason?: unknown };
    const at = typeof e.timestamp === 'number' ? e.timestamp : Date.now();

    if (e.type === 'tool:started') {
      const owner = typeof e.callId === 'string' ? this.callOwners.get(e.callId) : undefined;
      return owner === undefined ? [] : this.enter(owner, 'executing', at);
    }
    if (e.type === 'tool:completed' || e.type === 'tool:failed') {
      if (typeof e.callId === 'string') this.callOwners.delete(e.callId);
      return [];
    }
    if (typeof e.agentName !== 'string') return [];
    const agentName = e.agentName;
    const known = this.phases.get(agentName);

    if (e.type === 'dendrite:agent-created') {
      return known && known.status !== 'running' ? this.enter(agentName, 'idle', at, 'running') : [];
    }
    if (e.type === 'dendrite:agent-ended') {
      const changes = known
        ? this.enter(agentName, e.reason === 'completed' ? 'done' : e.reason === 'failed' ? 'failed' : 'cancelled', at)
        : [];
      this.phases.delete(agentName);
      for (const [callId, owner] of this.callOwners) if (owner === agentName) this.callOwners.delete(callId);
      return changes;
    }

    const transition = TRANSITIONS[e.type];
    if (!transition) return [];
    // Only a turn's start admits an agent, so a late event can't bring one back after it ended.
    if (!known && e.type !== 'inference:started') return [];
    // A stopped turn stays stopped until its next start.
    if (e.type === 'inference:exhausted' && known?.status === 'stopped') return [];
    if (e.type === 'inference:tool_calls_yielded' && Array.isArray(e.calls)) {
      for (const call of e.calls as Array<{ id?: unknown }>) {
        if (typeof call?.id === 'string') this.callOwners.set(call.id, agentName);
      }
    }
    return this.enter(agentName, transition.phase, at, transition.status);
  }

  snapshot(): Record<string, AgentPhaseState> {
    return Object.fromEntries([...this.phases].map(([name, { phase, since }]) => [name, { phase, since }]));
  }

  private enter(agentName: string, phase: AgentPhase, at: number, status?: TurnStatus): AgentPhaseChange[] {
    const known = this.phases.get(agentName);
    const changed = known?.phase !== phase;
    const since = changed || !known ? at : known.since;
    this.phases.set(agentName, { phase, since, status: status ?? known?.status ?? 'running' });
    return changed ? [{ agentName, phase, since }] : [];
  }
}
