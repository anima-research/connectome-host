/**
 * Shared wire-protocol types for the headless daemon ↔ FleetModule IPC.
 *
 * Both `src/headless.ts` (child runtime) and `src/modules/fleet-module.ts`
 * (parent module) import from here so the JSONL envelope shapes stay
 * identical at both ends.
 *
 * See HEADLESS-FLEET-PLAN.md for the full protocol spec.
 */

// ---------------------------------------------------------------------------
// Parent → Child: commands
// ---------------------------------------------------------------------------

export type IncomingCommand =
  /** Set which event types the child emits.  Supports glob: ["tool:*", "lifecycle"]. */
  | { type: 'subscribe'; events: string[] }
  /** Inject a user-like message; equivalent to typing in the child's TUI. */
  | { type: 'text'; content: string }
  /** Run a slash command in the child's commands.ts handler. */
  | { type: 'command'; command: string }
  /** Graceful (default) or immediate shutdown. */
  | { type: 'shutdown'; graceful?: boolean }
  /** Request a state snapshot. The child responds with a single 'snapshot'
   *  event carrying the full agent tree, exempt from subscription filtering.
   *  Used as a recovery verb (TUI cold start, reconnect, after restart) — not
   *  a query verb. See UNIFIED-TREE-PLAN.md §3 for the lockstep model. */
  | { type: 'describe'; corrId?: string }
  /** Pull the child's lesson library. Response is `lessons-snapshot`. */
  | { type: 'request-lessons'; corrId?: string }
  /** Pull the child's workspace mount list. Response is `workspace-mounts-snapshot`. */
  | { type: 'request-workspace-mounts'; corrId?: string }
  /** Pull a recursive listing of one mount in the child. Response is `workspace-tree-snapshot`. */
  | { type: 'request-workspace-tree'; mount: string; corrId?: string }
  /** Read a workspace file from the child. Response is `workspace-file-snapshot`. */
  | { type: 'request-workspace-file'; path: string; corrId?: string };

// ---------------------------------------------------------------------------
// Child → Parent: events
// ---------------------------------------------------------------------------

/** Lifecycle events added by the headless runtime (not framework TraceEvents). */
export type LifecycleEvent =
  | { type: 'lifecycle'; phase: 'ready'; pid: number; dataDir: string; recipe?: string; ts?: number }
  | { type: 'lifecycle'; phase: 'idle'; ts?: number }
  | { type: 'lifecycle'; phase: 'exiting'; reason: string; ts?: number };

/** Output line from a slash-command run, surfaced as an event. */
export interface CommandOutputEvent {
  type: 'command-output';
  text: string;
  style: string | null;
  ts?: number;
}

/** Response to a {type:'describe'} request. Carries the child's full agent
 *  tree as folded by AgentTreeReducer. Always emitted regardless of the
 *  client's subscription filter. */
export interface SnapshotEvent {
  type: 'snapshot';
  corrId?: string;
  /** Wall-clock at which the child built the snapshot. Receivers should drop
   *  events with `timestamp < asOfTs` after applying. */
  asOfTs: number;
  child: {
    name: string;
    pid: number;
    recipe?: string;
    startedAt: number;
  };
  /** Serialized AgentTreeReducer state. Shape matches AgentTreeSnapshot in
   *  src/state/agent-tree-reducer.ts. Kept structurally typed here to avoid
   *  cross-cutting imports. */
  tree: {
    nodes: Array<Record<string, unknown>>;
    callIdIndex: Record<string, string>;
  };
  ts?: number;
}

/** Response to a {type:'request-lessons'} request. */
export interface LessonsSnapshotEvent {
  type: 'lessons-snapshot';
  corrId?: string;
  /** True iff the child has LessonsModule loaded. */
  loaded: boolean;
  lessons: Array<{
    id: string;
    content: string;
    confidence: number;
    tags: string[];
    deprecated: boolean;
    deprecationReason?: string;
    created?: number;
    updated?: number;
  }>;
  ts?: number;
}

/** Response to a {type:'request-workspace-mounts'} request. */
export interface WorkspaceMountsSnapshotEvent {
  type: 'workspace-mounts-snapshot';
  corrId?: string;
  loaded: boolean;
  mounts: Array<{ name: string; path: string; mode: string }>;
  ts?: number;
}

/** Response to a {type:'request-workspace-tree'} request. */
export interface WorkspaceTreeSnapshotEvent {
  type: 'workspace-tree-snapshot';
  corrId?: string;
  mount: string;
  entries: Array<{ path: string; size: number }>;
  ts?: number;
}

/** Response to a {type:'request-workspace-file'} request. */
export interface WorkspaceFileSnapshotEvent {
  type: 'workspace-file-snapshot';
  corrId?: string;
  path: string;
  totalLines: number;
  fromLine: number;
  toLine: number;
  content: string;
  truncated: boolean;
  /** Set on lookup failure (file not found, mount unknown, etc.). */
  error?: string;
  ts?: number;
}

/**
 * A wire event from the child.  In practice this is either a framework
 * TraceEvent (typed loosely as Record<string,unknown>), or one of our
 * lifecycle / command-output additions.
 */
export type WireEvent =
  | LifecycleEvent
  | CommandOutputEvent
  | SnapshotEvent
  | LessonsSnapshotEvent
  | WorkspaceMountsSnapshotEvent
  | WorkspaceTreeSnapshotEvent
  | WorkspaceFileSnapshotEvent
  // Arbitrary framework TraceEvent passthrough. The child stamps every emitted
  // event with `ts: Date.now()` in `emit()` (see headless.ts), so ts is always
  // present on the wire even when the underlying TraceEvent doesn't declare it.
  | (Record<string, unknown> & { type: string; ts?: number });

// ---------------------------------------------------------------------------
// Subscription matching (used by both ends)
// ---------------------------------------------------------------------------

/**
 * Match an event type against a subscription set.  Supports:
 *   - exact match: "inference:completed"
 *   - prefix wildcard: "tool:*"  (matches "tool:started", "tool:completed", ...)
 *   - global wildcard: "*"
 */
export function matchesSubscription(eventType: string, subscription: Set<string>): boolean {
  if (subscription.has('*')) return true;
  if (subscription.has(eventType)) return true;
  for (const pattern of subscription) {
    if (pattern.endsWith('*') && eventType.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Direct-routing helper for TUI input
// ---------------------------------------------------------------------------

export interface FleetRoute {
  /** Target child's name as parsed from the prefix. */
  childName: string;
  /** Message body after the prefix. */
  content: string;
}

/**
 * Parse a "@childname rest of message" line as a direct-route command,
 * bypassing the conductor agent.  Returns null if the line is not an
 * @-prefixed route (so TUI falls back to the default chat-to-conductor path).
 *
 * Accepted forms:
 *   "@miner hello there"     → { childName: "miner",  content: "hello there" }
 *   "@miner: hello"          → { childName: "miner",  content: "hello" }
 *   "@my-bot list channels"  → { childName: "my-bot", content: "list channels" }
 *
 * Rejected:
 *   "@miner"                 → null (no payload)
 *   "no prefix"              → null
 *   "@@escaped"              → null (literal @, e.g. paste of an email)
 */
export function parseFleetRoute(input: string): FleetRoute | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('@') || trimmed.startsWith('@@')) return null;
  const match = /^@([a-zA-Z0-9_.-]+)(?::|\s)\s*(.+)$/s.exec(trimmed);
  if (!match) return null;
  const childName = match[1]!;
  const content = match[2]!.trim();
  if (!content) return null;
  return { childName, content };
}
