import type { TraceEvent } from '@animalabs/agent-framework';
import { AgentTreeReducer, REDUCER_REQUIRED_EVENTS, type AgentPhase } from './agent-tree-reducer.js';

export interface AgentPhaseState {
  phase: AgentPhase;
  /** When the agent entered this phase (ms). */
  since: number;
}

export interface AgentPhaseChange extends AgentPhaseState {
  agentName: string;
}

const PHASE_EVENTS: ReadonlySet<string> = new Set(REDUCER_REQUIRED_EVENTS);

/**
 * Each agent's phase, as the web UI's tree shows it, kept on the server for
 * clients that may not read the traces it comes from: those carry messages and
 * tool calls, and a phase carries neither.
 *
 * A page's reducer lasts as long as the page. This one lasts as long as the
 * host, so it forgets a finished tool call's route and an agent that ended.
 */
export class AgentPhases {
  private readonly tree = new AgentTreeReducer();
  private readonly phases = new Map<string, AgentPhaseState>();

  constructor(agentNames: readonly string[] = [], now: number = Date.now()) {
    this.tree.seedFrameworkAgents([...agentNames]);
    for (const name of agentNames) this.phases.set(name, { phase: 'idle', since: now });
  }

  /** Takes one trace event and returns the phases it changed. */
  apply(event: TraceEvent | { type: string }): AgentPhaseChange[] {
    if (!PHASE_EVENTS.has(event.type)) return [];
    const { type, agentName, callId } = event as { type: string; agentName?: unknown; callId?: unknown };
    // Tokens arrive far oftener than anything else, and change nothing once streaming.
    if (type === 'inference:tokens' && typeof agentName === 'string' && this.phases.get(agentName)?.phase === 'streaming') {
      return [];
    }
    this.tree.applyEvent(event);
    const changes: AgentPhaseChange[] = [];
    for (const node of this.tree.getNodes()) {
      if (this.phases.get(node.name)?.phase === node.phase) continue;
      const since = node.lastEventAt ?? Date.now();
      this.phases.set(node.name, { phase: node.phase, since });
      changes.push({ agentName: node.name, phase: node.phase, since });
    }
    if ((type === 'tool:completed' || type === 'tool:failed') && typeof callId === 'string') this.tree.forgetCall(callId);
    if (type === 'dendrite:agent-ended' && typeof agentName === 'string') {
      this.tree.forgetAgent(agentName);
      this.phases.delete(agentName);
    }
    return changes;
  }

  snapshot(): Record<string, AgentPhaseState> {
    return Object.fromEntries([...this.phases].map(([name, state]) => [name, { ...state }]));
  }
}
