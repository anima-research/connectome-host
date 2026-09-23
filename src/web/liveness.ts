/**
 * Liveness — "is the MCPL link up, and is the agent actually answering?"
 *
 * A green "connected" dot is not enough: a server can be connected while the
 * agent's event loop is stuck (inbound messages pile up, nothing answers), and
 * a server can fail its handshake for hours with nothing visible outside the
 * process's stderr. This folds the relevant trace events into a tiny snapshot
 * the web UI broadcasts and renders in an always-visible strip.
 *
 * Pure TS, no Node deps: the SPA imports `unansweredSince` from here too.
 */

export interface LivenessServer {
  id: string;
  connected: boolean;
  /** A background reconnect loop is running. */
  retrying?: boolean;
  /** Last inbound MCPL event (channel message or push event), any kind. */
  lastInboundAt?: number;
  /** Last inbound event that asked for inference (would wake the agent). */
  lastWakeAt?: number;
  /** Last connect failure; cleared on reconnect. */
  lastError?: { message: string; attempt: number; willRetry: boolean; at: number };
}

export interface LivenessAgent {
  name: string;
  lastStartedAt?: number;
  lastCompletedAt?: number;
  lastFailedAt?: number;
  lastFailure?: string;
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

const MAX_TEXT = 200;
const clip = (s: unknown): string => String(s ?? '').slice(0, MAX_TEXT);

export class LivenessTracker {
  readonly since: number;
  private servers = new Map<string, Omit<LivenessServer, 'id' | 'connected' | 'retrying'>>();
  private agents = new Map<string, Omit<LivenessAgent, 'name'>>();

  constructor(now = Date.now()) {
    this.since = now;
  }

  /** Fold one trace event. Returns true when it changed the snapshot. */
  observe(e: Trace): boolean {
    const at = typeof e.timestamp === 'number' ? e.timestamp : Date.now();
    switch (e.type) {
      case 'process:received': {
        const pe = e.processEvent as { type?: string; serverId?: unknown; triggerInference?: unknown } | undefined;
        if (!pe || (pe.type !== 'mcpl:channel-incoming' && pe.type !== 'mcpl:push-event')) return false;
        if (typeof pe.serverId !== 'string') return false;
        const s = this.server(pe.serverId);
        s.lastInboundAt = at;
        if (pe.triggerInference === true) s.lastWakeAt = at;
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
      case 'mcpl:server-closed':
        // Connection state itself is read live at snapshot time; this only
        // needs to trigger a broadcast.
        return typeof e.serverId === 'string';
      case 'inference:started':
      case 'inference:completed':
      case 'inference:failed':
      case 'inference:exhausted': {
        if (typeof e.agentName !== 'string') return false;
        const a = this.agents.get(e.agentName) ?? {};
        this.agents.set(e.agentName, a);
        if (e.type === 'inference:started') a.lastStartedAt = at;
        else if (e.type === 'inference:completed') a.lastCompletedAt = at;
        else { a.lastFailedAt = at; a.lastFailure = clip(e.error); }
        return true;
      }
      default:
        return false;
    }
  }

  /** Merge tracked times with the live connection list and agent roster.
   *  Only listed servers/agents appear, so removed servers and transient
   *  subagents don't linger in the strip. */
  snapshot(
    live: ReadonlyArray<{ id: string; connected: boolean; retrying?: boolean }>,
    agentNames: readonly string[],
    now = Date.now(),
  ): LivenessSnapshot {
    return {
      at: now,
      since: this.since,
      servers: live.map((l) => ({
        id: l.id,
        connected: l.connected,
        ...(l.retrying ? { retrying: true } : {}),
        ...this.servers.get(l.id),
      })),
      agents: agentNames.map((name) => ({ name, ...this.agents.get(name) })),
    };
  }

  private server(id: string) {
    let s = this.servers.get(id);
    if (!s) { s = {}; this.servers.set(id, s); }
    return s;
  }
}

/**
 * If waking inbound events have been sitting unanswered for longer than
 * `thresholdMs` — i.e. the newest wake is older than the threshold AND the
 * agent hasn't started or finished a turn since it — return that wake's
 * time. Otherwise undefined.
 */
export function unansweredSince(
  snap: LivenessSnapshot,
  agent: LivenessAgent,
  now: number,
  thresholdMs = 5 * 60_000,
): number | undefined {
  let wake = 0;
  for (const s of snap.servers) wake = Math.max(wake, s.lastWakeAt ?? 0);
  if (!wake) return undefined;
  const active = Math.max(agent.lastStartedAt ?? 0, agent.lastCompletedAt ?? 0, agent.lastFailedAt ?? 0);
  if (active >= wake) return undefined;
  return now - wake > thresholdMs ? wake : undefined;
}
