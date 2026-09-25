/**
 * Liveness — "is the MCPL link up, and is the agent actually answering?"
 *
 * A green "connected" dot is not enough: a server can be connected while the
 * agent's event loop is stuck (inbound messages pile up, nothing answers), and
 * a server can fail its handshake at boot with nothing visible outside the
 * process's stderr. This folds the relevant trace events into a tiny snapshot
 * the web UI broadcasts and renders in an always-visible strip.
 *
 * Pure TS, no Node deps: the SPA imports the helpers below too.
 */

/** How a turn ended. AF's terminal trace set is turn_ended, aborted, failed,
 *  exhausted (ModuleContext.onTrace), plus completed for a streamed answer. */
export type TurnOutcome = 'completed' | 'turn_ended' | 'aborted' | 'failed';

export interface LivenessServer {
  id: string;
  connected: boolean;
  /** A background reconnect loop is running. */
  retrying?: boolean;
  /** Last inbound MCPL event (channel message or push event), any kind. */
  lastInboundAt?: number;
  /** Last connect failure; cleared on reconnect or when the server is (re)added. */
  lastError?: { message: string; attempt: number; willRetry: boolean; at: number };
}

export interface LivenessAgent {
  name: string;
  lastStartedAt?: number;
  lastEndedAt?: number;
  lastOutcome?: TurnOutcome;
  /** Set when the last turn ended in failure. */
  lastFailure?: string;
  /** Oldest waking event addressed to this agent since its last activity
   *  (a turn start or any turn end). Set only when unset. */
  pendingWakeSince?: number;
  /** Doesn't answer broadcast wakes (ephemeral subagent, subconscious,
   *  a conversation router's dormant trunk): never flagged unanswered. */
  wakeExempt?: boolean;
}

export interface LivenessSnapshot {
  /** Server clock when the snapshot was built (heartbeat + skew reference). */
  at: number;
  /** When tracking began — "never" means "not since this". */
  since: number;
  servers: LivenessServer[];
  agents: LivenessAgent[];
}

type Trace = { type: string; timestamp?: number; [k: string]: unknown };

export interface LivenessTrackerOptions {
  now?: number;
  /** Agents a waking event reaches: its explicit targets, or the host's
   *  broadcast set when it names none. Default: explicit targets only. */
  wakeTargets?: (explicit: string[] | undefined) => string[];
}

/** The server re-broadcasts the snapshot this often; the SPA calls the host
 *  quiet after missing a few. Shared so the two can't drift. */
export const LIVENESS_HEARTBEAT_MS = 30_000;

const MAX_TEXT = 200;
const clip = (s: unknown): string => String(s ?? '').slice(0, MAX_TEXT);

/** An operator Stop surfaces as `inference:exhausted` "Stream aborted: …". */
const OPERATOR_ABORT = /^Stream aborted:/;

type AgentState = Omit<LivenessAgent, 'name' | 'wakeExempt'>;

export class LivenessTracker {
  readonly since: number;
  private readonly wakeTargets: (explicit: string[] | undefined) => string[];
  private servers = new Map<string, Omit<LivenessServer, 'id' | 'connected' | 'retrying'>>();
  private agents = new Map<string, AgentState>();

  constructor(opts: LivenessTrackerOptions = {}) {
    this.since = opts.now ?? Date.now();
    this.wakeTargets = opts.wakeTargets ?? ((explicit) => explicit ?? []);
  }

  /** Fold one trace event. Returns true when it changed the snapshot. */
  observe(e: Trace): boolean {
    const at = typeof e.timestamp === 'number' ? e.timestamp : Date.now();
    switch (e.type) {
      case 'process:received': {
        const pe = e.processEvent as
          { type?: string; serverId?: unknown; triggerInference?: unknown; targetAgents?: unknown } | undefined;
        if (!pe || (pe.type !== 'mcpl:channel-incoming' && pe.type !== 'mcpl:push-event')) return false;
        if (typeof pe.serverId !== 'string') return false;
        this.server(pe.serverId).lastInboundAt = at;
        if (pe.triggerInference === true) {
          const explicit = Array.isArray(pe.targetAgents)
            ? pe.targetAgents.filter((n): n is string => typeof n === 'string')
            : undefined;
          for (const name of this.wakeTargets(explicit)) {
            const a = this.agent(name);
            if (a.pendingWakeSince === undefined) a.pendingWakeSince = at; // oldest, not newest
          }
        }
        return true;
      }
      case 'mcpl:server-connect-failed':
        if (typeof e.serverId !== 'string') return false;
        this.server(e.serverId).lastError = {
          message: clip(e.error),
          attempt: Number(e.attempt ?? 0),
          willRetry: e.willRetry === true,
          at,
        };
        return true;
      case 'mcpl:server-reconnected':
        if (typeof e.serverId !== 'string') return false;
        delete this.server(e.serverId).lastError;
        return true;
      case 'module:added': {
        // A runtime connect emits only module:added; treat it as a clear.
        // Exactly `mcpl:<id>`; `mcpl:<id>:tools-refreshed` is a tool-list refresh.
        const m = typeof e.moduleName === 'string' ? /^mcpl:([^:]+)$/.exec(e.moduleName) : null;
        if (!m) return false;
        delete this.server(m[1]).lastError;
        return true;
      }
      case 'mcpl:server-closed':
        // Connection state itself is read live at snapshot time; this only
        // needs to trigger a broadcast.
        return typeof e.serverId === 'string';
      case 'inference:started': {
        if (typeof e.agentName !== 'string') return false;
        const a = this.agent(e.agentName);
        a.lastStartedAt = at;
        delete a.pendingWakeSince;
        return true;
      }
      case 'inference:completed':
      case 'inference:turn_ended':
      case 'inference:aborted':
      case 'inference:failed':
      case 'inference:exhausted': {
        if (typeof e.agentName !== 'string') return false;
        const a = this.agent(e.agentName);
        a.lastEndedAt = at;
        delete a.pendingWakeSince;
        if (e.type === 'inference:completed') a.lastOutcome = 'completed';
        else if (e.type === 'inference:turn_ended') a.lastOutcome = 'turn_ended';
        else if (e.type === 'inference:aborted') a.lastOutcome = 'aborted';
        else if (e.type === 'inference:exhausted' && OPERATOR_ABORT.test(String(e.error ?? ''))) a.lastOutcome = 'aborted';
        else { a.lastOutcome = 'failed'; a.lastFailure = clip(e.error); return true; }
        delete a.lastFailure;
        return true;
      }
      default:
        return false;
    }
  }

  /** Merge tracked state with the live connection list and agent roster.
   *  Only listed servers/agents appear, and entries no longer listed are
   *  pruned (subagents get unique names, so the maps would otherwise grow). */
  snapshot(
    live: ReadonlyArray<{ id: string; connected: boolean; retrying?: boolean }>,
    agents: ReadonlyArray<{ name: string; wakeExempt?: boolean }>,
    now = Date.now(),
  ): LivenessSnapshot {
    const liveIds = new Set(live.map((l) => l.id));
    for (const id of this.servers.keys()) if (!liveIds.has(id)) this.servers.delete(id);
    const names = new Set(agents.map((a) => a.name));
    for (const name of this.agents.keys()) if (!names.has(name)) this.agents.delete(name);
    return {
      at: now,
      since: this.since,
      servers: live.map((l) => ({
        id: l.id,
        connected: l.connected,
        ...(l.retrying ? { retrying: true } : {}),
        ...this.servers.get(l.id),
      })),
      agents: agents.map((a) => ({ name: a.name, ...(a.wakeExempt ? { wakeExempt: true } : {}), ...this.agents.get(a.name) })),
    };
  }

  private server(id: string) {
    let s = this.servers.get(id);
    if (!s) { s = {}; this.servers.set(id, s); }
    return s;
  }

  private agent(name: string): AgentState {
    let a = this.agents.get(name);
    if (!a) { a = {}; this.agents.set(name, a); }
    return a;
  }
}

/** A turn is in flight: started after the last turn ended. */
export function isBusy(agent: LivenessAgent): boolean {
  return agent.lastStartedAt !== undefined && agent.lastStartedAt > (agent.lastEndedAt ?? -Infinity);
}

/**
 * If a waking event addressed to this agent has gone unanswered (no turn
 * started or ended since) for longer than `thresholdMs`, return when the
 * oldest such wake arrived. Otherwise undefined. Exempt agents never warn.
 */
export function unansweredSince(
  agent: LivenessAgent,
  now: number,
  thresholdMs = 5 * 60_000,
): number | undefined {
  if (agent.wakeExempt || agent.pendingWakeSince === undefined) return undefined;
  return now - agent.pendingWakeSince > thresholdMs ? agent.pendingWakeSince : undefined;
}
