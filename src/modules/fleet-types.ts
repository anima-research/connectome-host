/**
 * Shared wire-protocol types for the headless daemon ↔ FleetModule IPC.
 *
 * See docs/fleet-protocol.md for the protocol reference.
 */

export type IncomingCommand =
  /** Set which event types the child emits.  Supports glob: ["tool:*", "lifecycle"]. */
  | { type: 'subscribe'; events: string[] }
  /** Inject a user-like message; equivalent to typing in the child's TUI.
   *  `from: 'console'` sends it as a console line, as batch mode's are, for a
   *  reader at a shell; without it, it comes as the host's IPC line, whose
   *  note tells the agent a plain-prose reply won't reach the sender. */
  | { type: 'text'; content: string; from?: 'console' }
  /** Run a slash command in the child's commands.ts handler. With a corrId,
   *  each output line carries it and a `command-done` ends the answer. */
  | { type: 'command'; command: string; corrId?: string }
  /** Shut down; `graceful: false` changes only the reason `lifecycle:exiting` gives. */
  | { type: 'shutdown'; graceful?: boolean }
  /** Request a state snapshot. The child responds with a single 'snapshot'
   *  event carrying the full agent tree, exempt from subscription filtering.
   *  Used as a recovery verb (TUI cold start, reconnect, after restart) —
   *  not a query verb. */
  | { type: 'describe'; corrId?: string }
  /** Pull the child's lesson library. Response is `lessons-snapshot`. */
  | { type: 'request-lessons'; corrId?: string }
  /** Pull the child's workspace mount list. Response is `workspace-mounts-snapshot`. */
  | { type: 'request-workspace-mounts'; corrId?: string }
  /** Pull a recursive listing of one mount in the child. Response is `workspace-tree-snapshot`. */
  | { type: 'request-workspace-tree'; mount: string; corrId?: string }
  /** Read a workspace file from the child. Response is `workspace-file-snapshot`. */
  | { type: 'request-workspace-file'; path: string; corrId?: string }
  /** Cancel a specific in-process subagent by display name. Response is
   *  `cancel-subagent-result`. The child looks the agent up in its own
   *  SubagentModule, so this is the only way to stop a subagent that lives
   *  in a fleet child rather than the conductor. */
  | { type: 'cancel-subagent'; name: string; corrId?: string }
  /**
   * Run one operator-panel operation in the child, one of PANEL_OPS in
   * src/web/panel-data.ts. Response is a single `panel-response` with the same
   * corrId.
   */
  | { type: 'panel-request'; op: string; params?: Record<string, unknown>; corrId?: string }
  /** A switch's request of a fleet child, from its parent's install host:
   *  quiesce under the switch's reason and wait for its turns, answering
   *  whether it drained and who holds a turn; or end the switch's quiesce.
   *  Response is `update-response`. */
  | { type: 'update-request'; request: import('../update/quiesce.js').SwitchRequest; corrId: string };

/** Lifecycle events added by the headless runtime (not framework TraceEvents). */
export type LifecycleEvent =
  | { type: 'lifecycle'; phase: 'ready'; pid: number; dataDir: string; recipe?: string; idle?: boolean; turnWork?: boolean; agent?: string; ts?: number }
  | { type: 'lifecycle'; phase: 'turn-work-done'; texts?: number; ts?: number }
  | { type: 'lifecycle'; phase: 'idle'; texts?: number; ts?: number }
  | { type: 'lifecycle'; phase: 'exiting'; reason: string; ts?: number };

/** Output line from a slash-command run, surfaced as an event. */
export interface CommandOutputEvent {
  type: 'command-output';
  text: string;
  style: string | null;
  corrId?: string;
  ts?: number;
}

/** The end of the answer to a `command` that carried a corrId, with the
 *  error when the command threw, and `refused` when `/update` answered
 *  that it didn't do what was asked; its lines say why. No other command
 *  sets it. */
export interface CommandDoneEvent {
  type: 'command-done';
  corrId: string;
  error?: string;
  refused?: true;
  ts?: number;
}

/** Response to a {type:'describe'} request. Carries the child's full agent
 *  tree as folded by AgentTreeReducer. Always emitted regardless of the
 *  client's subscription filter. */
export interface SnapshotEvent {
  type: 'snapshot';
  corrId?: string;
  /** Wall-clock at which the child built the snapshot. Receivers should drop
   *  events with `ts < asOfTs` after applying. */
  asOfTs: number;
  child: {
    name: string;
    pid: number;
    recipe?: string;
    startedAt: number;
  };
  /** Serialized AgentTreeReducer state. Shape matches AgentTreeSnapshot in
   *  src/state/agent-tree-reducer.ts. */
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

/** Response to a {type:'cancel-subagent'} request. */
export interface CancelSubagentResultEvent {
  type: 'cancel-subagent-result';
  corrId?: string;
  /** Subagent display name the parent asked us to cancel. */
  name: string;
  /** True iff a matching live subagent was found and signalled to stop. */
  cancelled: boolean;
  /** Set when cancelled=false to explain why (e.g. "subagent module not
   *  loaded", "subagent not running"). */
  reason?: string;
  ts?: number;
}

/** Response to a {type:'panel-request'} request. `data` is the same
 *  wire-shaped JSON the WebUI host serves locally for the given op;
 *  `ok:false` carries the error plus an HTTP-ish `status` so the parent's
 *  proxy routes can answer faithfully (404 unknown agent, 429 preview
 *  cooldown, 501 unsupported build). */
export interface PanelResponseEvent {
  type: 'panel-response';
  corrId?: string;
  /** Echo of the requested op. */
  op: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  status?: number;
  ts?: number;
}

/** Response to a {type:'update-request'} request: `data` is
 *  answerSwitchRequest's answer, or `error` says why there's none. */
export interface UpdateResponseEvent {
  type: 'update-response';
  corrId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
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
 * A wire event from the child: a framework TraceEvent (typed loosely as
 * Record<string,unknown>), a lifecycle or command-output event, or the
 * response to a command.
 */
export type WireEvent =
  | LifecycleEvent
  | CommandOutputEvent
  | CommandDoneEvent
  | SnapshotEvent
  | LessonsSnapshotEvent
  | WorkspaceMountsSnapshotEvent
  | WorkspaceTreeSnapshotEvent
  | WorkspaceFileSnapshotEvent
  | CancelSubagentResultEvent
  | PanelResponseEvent
  | UpdateResponseEvent
  // Arbitrary framework TraceEvent passthrough. The child stamps every emitted
  // event with `ts: Date.now()`, so ts is always present on the wire even when
  // the underlying TraceEvent doesn't declare it.
  | (Record<string, unknown> & { type: string; ts?: number });

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
