/**
 * SubagentModule — spawn and fork ephemeral subagents.
 *
 * Tools:
 *   subagent--spawn  — Fresh agent with system prompt + task, no inherited context
 *   subagent--fork   — Agent inheriting parent's compiled context
 *   subagent--hud    — Toggle fleet status HUD overlay
 *
 * By default, spawn/fork are async: they return immediately and deliver
 * results as user messages + inference-request events. Pass `sync: true`
 * to block until completion.
 *
 * Sync tasks are detachable: user can push them to background mid-flight
 * via Ctrl+B in TUI, or they auto-detach after `timeoutMs` if specified.
 * Both spawn and fork accept `timeoutMs` for per-task execution deadlines.
 */

import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
  TraceEvent,
  ContextManager,
} from '@animalabs/agent-framework';
import type { AgentFramework } from '@animalabs/agent-framework';
import { KnowledgeStrategy } from '@animalabs/agent-framework';
import { isToolResultContent, isToolUseContent } from '@animalabs/membrane';
import type { ContentBlock } from '@animalabs/membrane';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubagentModuleConfig {
  /** Maximum fork/spawn depth (default: 3) */
  maxDepth?: number;
  /** Current depth (incremented for child subagent modules) */
  currentDepth?: number;
  /** Default model for subagents */
  defaultModel?: string;
  /** Default max tokens per subagent inference */
  defaultMaxTokens?: number;
  /** Which parent agent this module serves (for fork context access) */
  parentAgentName?: string;
  /** Max concurrent subagent executions (default: 3) */
  maxConcurrent?: number;
  /** Max prompt tokens before failing fast (default: 190000) */
  maxPromptTokens?: number;
  /** Max execution time per subagent in ms (default: 600000 = 10 min) */
  maxExecutionMs?: number;
  /** Max restart attempts on transient errors (default: 2) */
  maxRetries?: number;
}

export interface SubagentResult {
  summary: string;
  findings: string[];
  issues: string[];
  toolCallsCount: number;
}

interface SpawnInput {
  name: string;
  systemPrompt: string;
  task: string;
  model?: string;
  maxTokens?: number;
  tools?: string[];
  sync?: boolean;
  timeoutMs?: number;
}

interface ForkInput {
  name: string;
  task: string;
  systemPrompt?: string;
  model?: string;
  maxTokens?: number;
  sync?: boolean;
  timeoutMs?: number;
}

/** Handle for an async (fire-and-forget) subagent. */
interface AsyncSubagentHandle {
  name: string;
  type: 'spawn' | 'fork';
  promise: Promise<SubagentResult>;
  parentAgentName: string;
}

/**
 * Handle for a sync subagent that can be detached mid-flight.
 * When detached, the blocking tool call resolves immediately and
 * the subagent continues running, delivering results async.
 */
interface DetachableHandle {
  name: string;
  type: 'spawn' | 'fork';
  promise: Promise<SubagentResult>;
  parentAgentName: string;
  detach: () => void;
}

/**
 * Non-retryable termination of a subagent. All abnormal-but-expected exits
 * (user cancel, zombie reclaim, depth limit, etc.) use this so the catch
 * path can distinguish "killed" from "transient network error".
 */
export class SubagentTerminated extends Error {
  constructor(
    public readonly reason: 'cancelled' | 'zombie' | 'killed',
    public readonly partialOutput: string,
    message?: string,
  ) {
    super(message ?? `Subagent terminated: ${reason}`);
    this.name = 'SubagentTerminated';
  }
}

/** Persisted subagent state (stored in Chronicle module state).
 *  'cancelled' = terminal-but-benign (user cancel, zombie reclaim, supersession).
 *  Postmortem 2026-05-28 P1 #4: separated from 'failed' so the TUI subagent
 *  list and the web admin tree agree on terminal cause. */
interface PersistedSubagent {
  name: string;
  type: 'spawn' | 'fork';
  task: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  /**
   * Last time we saw a trace event addressed to this subagent (token, tool
   * call, completion, etc.). Used as the staleness metric for zombie
   * detection: `startedAt` alone can't distinguish a slow-but-progressing
   * subagent from one that has been silently stuck for hours. Bumped on
   * every inference-lifecycle event in the trace listener; persisted so
   * it survives branch ops and session restores.
   */
  lastActivityAt: number;
  completedAt?: number;
  toolCallsCount: number;
  findingsCount: number;
  statusMessage?: string;
  parent?: string;
}

/** Observable state of an active subagent, for TUI display. See
 *  PersistedSubagent.status — 'cancelled' is the same dedicated benign-
 *  terminal state introduced for the postmortem 2026-05-28 P1 #4 fix. */
export interface ActiveSubagent {
  name: string;
  type: 'spawn' | 'fork';
  task: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  /** Last addressed trace event timestamp. See PersistedSubagent.lastActivityAt. */
  lastActivityAt: number;
  completedAt?: number;
  statusMessage?: string;
  toolCallsCount: number;
  findingsCount: number;
}

/** Live state captured for peek observability. */
interface LiveSubagentState {
  frameworkAgentName: string;
  displayName: string;
  systemPrompt: string;
  contextManager: ContextManager;
  currentStream: string;
  pendingToolCalls: Array<{ name: string; input?: unknown }>;
  /** Track callIds from tool_calls_yielded so we can route tool:* events back. */
  activeCallIds: Set<string>;
  /** When set, an inference request has been dispatched but no token has
   *  arrived yet — i.e., the agent is provably alive waiting on the LLM
   *  provider. Postmortem 2026-05-28 F3: between `inference:started` /
   *  `inference:stream_resumed` and the first `inference:tokens`, both
   *  `currentStream` and `pendingToolCalls` are empty even though the
   *  request is on the wire. The reaper / peek predicates must treat this
   *  as a protected state, otherwise slow rounds (Opus on 100–165K-token
   *  contexts routinely exceed 30s TTFT) get reaped mid-request. Cleared
   *  on first token, completion, failure, or new tool yield. */
  requestInFlightSince?: number;
}

/** Streaming event pushed to peek subscribers. */
export type SubagentStreamEvent =
  | { type: 'inference:started' }
  | { type: 'tokens'; content: string }
  | { type: 'tool_calls'; calls: Array<{ name: string; input?: unknown }> }
  | { type: 'tool:started'; tool: string; input?: unknown }
  | { type: 'tool:completed'; tool: string; durationMs: number }
  | { type: 'tool:failed'; tool: string; error: string }
  | { type: 'inference:completed' }
  | { type: 'inference:failed'; error: string }
  | { type: 'stream_resumed' }
  | { type: 'done'; summary: string; lastInputTokens?: number };

export type SubagentStreamCallback = (event: SubagentStreamEvent) => void;

/** Snapshot returned by peek(). */
export interface SubagentPeekSnapshot {
  name: string;
  type: 'spawn' | 'fork';
  task: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: number;
  elapsedMs: number;
  messageCount: number;
  lastMessageSnippet: string;
  currentStream: string;
  pendingToolCalls: Array<{ name: string; input?: unknown }>;
  toolCallsCount: number;
  /** True if the subagent appears stalled: running status, no active stream, elapsed > threshold. */
  isZombie: boolean;
}

// ---------------------------------------------------------------------------
// Fork materialisation
// ---------------------------------------------------------------------------

/**
 * Build the tool_result text the fork stream sees in place of the generic
 * "Subagent X forked. Running in background." that the parent stream sees.
 *
 * The wording frames the fork as a parallel continuation of the same self
 * rather than a separate agent — both streams inherit everything, the fork
 * stream's job is to set aside the broader agenda and pursue one intention.
 *
 * This addresses fork-disorientation by naming the dual-stream situation
 * explicitly and salient-placing it as the matching tool_result of the
 * fork tool_use the model just emitted.
 */
export function buildIntentionFramedForkResult(
  name: string,
  task: string,
  depth: number,
  maxDepth: number,
): string {
  const depthLine = depth < maxDepth
    ? `You are at depth ${depth} of ${maxDepth} (${maxDepth - depth} sub-fork levels remaining).`
    : `You are at depth ${depth} of ${maxDepth} — at max depth, you cannot sub-fork.`;
  return (
    `Two parallel streams of you continue from this point, both inheriting everything you've done so far. ` +
    `An instance of you still runs as the parent stream, carrying on the broader agenda; ` +
    `the self reading this is the fork — set aside that broader agenda and focus exclusively on the intention ` +
    `you set for this stream: ${task}\n\n` +
    `${depthLine}\n\n` +
    `When this intention is complete, return your findings via subagent--return so the parent stream can integrate them.`
  );
}

/** Structural subset of context-manager's Message — accepting this wider
 *  shape lets the helper be unit-tested without importing the framework. */
interface MinimalMessage {
  participant: string;
  content: ContentBlock[];
}

/**
 * Transform parent's compiled context into the fork stream's inherited view:
 *   1. find the assistant turn containing the fork tool_use with id === callToolUseId
 *   2. strip sibling subagent--fork tool_use blocks from that assistant turn
 *   3. find (or synthesise) the matching tool_result user turn; strip sibling
 *      fork tool_results from it; rewrite the matching one with intention framing
 *   4. drop every message after the matching tool_result (post-fork tail —
 *      peek calls, zombie returns, parent narrative — is the other major
 *      load-bearing source of parent-coherent evidence)
 *
 * Returns null if the matching tool_use cannot be located (e.g. compressed
 * away by the parent's strategy). Callers should fall back to wholesale
 * copy + synthetic intention-framed append in that case.
 */
export function materialiseStructuralFork(
  compiled: ReadonlyArray<MinimalMessage>,
  callToolUseId: string,
  forkName: string,
  forkTask: string,
  depth: number,
  maxDepth: number,
): MinimalMessage[] | null {
  // 1. Locate the assistant turn whose content includes the fork tool_use we're materialising.
  let forkAssistantIdx = -1;
  for (let i = 0; i < compiled.length; i++) {
    const content = compiled[i].content;
    if (!Array.isArray(content)) continue;
    const hit = content.some(b =>
      isToolUseContent(b) && b.id === callToolUseId && b.name === 'subagent--fork',
    );
    if (hit) { forkAssistantIdx = i; break; }
  }
  if (forkAssistantIdx < 0) return null;

  const forkAssistantMsg = compiled[forkAssistantIdx];
  const siblingForkIds = new Set<string>();
  for (const b of forkAssistantMsg.content) {
    if (!isToolUseContent(b)) continue;
    if (b.name === 'subagent--fork' && b.id !== callToolUseId) {
      siblingForkIds.add(b.id);
    }
  }

  // 2. Find the next user-side message holding the matching tool_result (if any).
  // Stop searching at the next assistant turn — the matching tool_result must
  // be in the immediately following tool-result turn or it's not there yet.
  let matchingResultIdx = -1;
  for (let i = forkAssistantIdx + 1; i < compiled.length; i++) {
    const m = compiled[i];
    if (!Array.isArray(m.content)) continue;
    const hit = m.content.some(b => isToolResultContent(b) && b.toolUseId === callToolUseId);
    if (hit) { matchingResultIdx = i; break; }
    // If this message contains any tool_use, it's a new assistant turn — bail.
    if (m.content.some(b => isToolUseContent(b))) break;
  }

  const out: MinimalMessage[] = [];

  // Pre-fork history verbatim. Blocks are shared by reference everywhere in
  // the framework's context flow — no cloning here either.
  for (let i = 0; i < forkAssistantIdx; i++) {
    out.push({ participant: compiled[i].participant, content: compiled[i].content });
  }

  // Fork assistant turn with sibling fork tool_use blocks stripped. The
  // matching tool_use is excluded from siblingForkIds by construction, so
  // this filter always keeps at least one block.
  const trimmedAssistantContent = forkAssistantMsg.content.filter(b => {
    if (!isToolUseContent(b)) return true;
    return !(b.name === 'subagent--fork' && siblingForkIds.has(b.id));
  });
  out.push({ participant: forkAssistantMsg.participant, content: trimmedAssistantContent });

  // Matching tool_result user turn — rewritten with intention framing; siblings stripped.
  const intentionFramed = buildIntentionFramedForkResult(forkName, forkTask, depth, maxDepth);
  if (matchingResultIdx >= 0) {
    const matchingMsg = compiled[matchingResultIdx];
    const trimmedResultContent: ContentBlock[] = [];
    for (const b of matchingMsg.content) {
      if (isToolResultContent(b)) {
        if (siblingForkIds.has(b.toolUseId)) continue;
        if (b.toolUseId === callToolUseId) {
          trimmedResultContent.push({
            type: 'tool_result',
            toolUseId: callToolUseId,
            content: intentionFramed,
          });
          continue;
        }
      }
      trimmedResultContent.push(b);
    }
    if (trimmedResultContent.length === 0) {
      // All siblings, nothing else — synthesise the matching result alone.
      trimmedResultContent.push({
        type: 'tool_result',
        toolUseId: callToolUseId,
        content: intentionFramed,
      });
    }
    out.push({ participant: matchingMsg.participant, content: trimmedResultContent });
  } else {
    // Parent's tool_result for this fork isn't in compiled context yet — synthesise it.
    out.push({
      participant: 'user',
      content: [{
        type: 'tool_result',
        toolUseId: callToolUseId,
        content: intentionFramed,
      }],
    });
  }

  // Post-fork tail intentionally dropped.
  return out;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

export class SubagentModule implements Module {
  readonly name = 'subagent';

  private ctx: ModuleContext | null = null;
  private config: SubagentModuleConfig;
  private framework: AgentFramework | null = null;
  private maxDepth: number;
  private currentDepth: number;
  private asyncHandles = new Map<string, AsyncSubagentHandle>();
  private detachableHandles = new Map<string, DetachableHandle>();

  // Concurrency control — adaptive rate-limit-aware semaphore
  private configuredMaxConcurrent: number;   // User's ceiling
  private effectiveConcurrent: number;       // Current effective limit (may be reduced)
  private activeConcurrent = 0;
  private waitQueue: Array<() => void> = [];
  private consecutiveSuccesses = 0;
  private lastRateLimitAt = 0;
  private rateLimitCooldownMs = 30_000;      // Delay after rate limit before releasing next slot

  // Periodic zombie reaper. The pre-existing reaper only ran on-demand
  // inside acquireSlot, which meant zombies persisted indefinitely when
  // no new spawns happened — production traces showed a stale subagent
  // holding a slot for 7 days before a fresh spawn finally tripped the
  // demand-driven reap. This interval gives us a steady heartbeat reap
  // independent of spawn activity.
  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  // Postmortem 2026-05-28 F3: bumped from 30_000ms. With the in-flight guard
  // closing the "request on wire" false-positive window, the threshold is
  // less load-bearing — but 30s was still tight enough that JIT pauses, GC,
  // or transient hiccups under heavy fleet load could trip the reaper on a
  // genuinely-progressing-but-pausing agent. 60s sweep cadence is also
  // friendlier when the fleet is already throttled by 429s (reaping under
  // throttling is counterproductive — the slot isn't stuck, it's queued).
  private static readonly REAPER_INTERVAL_MS = 60_000;

  // Prompt size guard
  private maxPromptTokens: number;

  // Per-subagent execution deadline
  private maxExecutionMs: number;

  // Retry on transient errors
  private maxRetries: number;

  /** Observable registry of active/recent subagents for TUI display. */
  readonly activeSubagents = new Map<string, ActiveSubagent>();

  /** Parent agent name for each subagent (for fleet tree reconstruction). */
  readonly parentMap = new Map<string, string>();

  // Stashed results from subagent--return tool calls, keyed by framework agent name
  private returnedResults = new Map<string, string>();

  // Live state for peek observability
  private liveSubagents = new Map<string, LiveSubagentState>();          // keyed by displayName
  private frameworkNameIndex = new Map<string, string>();                 // frameworkAgentName → displayName
  private callIdIndex = new Map<string, string>();                        // toolCallId → displayName
  private streamSubscribers = new Map<string, Set<SubagentStreamCallback>>();  // displayName → callbacks
  private lastInputTokens = new Map<string, number>();  // displayName → last known input token count
  private cancellationHandles = new Map<string, { reject: (err: Error) => void }>();  // displayName → cancel
  private agentDepths = new Map<string, number>();  // framework agent name → fork depth

  constructor(config: SubagentModuleConfig = {}) {
    this.config = config;
    this.maxDepth = config.maxDepth ?? 3;
    this.currentDepth = config.currentDepth ?? 0;
    this.configuredMaxConcurrent = config.maxConcurrent ?? 5;
    this.effectiveConcurrent = this.configuredMaxConcurrent;
    this.maxPromptTokens = config.maxPromptTokens ?? 190_000;
    this.maxExecutionMs = config.maxExecutionMs ?? 600_000;
    this.maxRetries = config.maxRetries ?? 2;
  }

  /** Set the framework reference. Must be called after framework creation. */
  setFramework(framework: AgentFramework): void {
    this.framework = framework;

    // Subscribe to traces for peek observability + streaming fanout
    framework.onTrace((event: TraceEvent) => {
      // Events with agentName: inference lifecycle
      const agentName = 'agentName' in event ? (event as { agentName: string }).agentName : null;

      if (agentName) {
        const displayName = this.frameworkNameIndex.get(agentName);
        if (!displayName) return;
        const live = this.liveSubagents.get(displayName);
        if (!live) return;

        // Bump lastActivityAt on every addressed event. This is the staleness
        // metric the periodic reaper consults — without it, the only signal
        // is `startedAt`, which can't distinguish a 10-hour-but-progressing
        // subagent from one that has been silently stuck. Look up the
        // ActiveSubagent record by entry-key (a separate index, since
        // displayName isn't the activeSubagents key directly).
        for (const sa of this.activeSubagents.values()) {
          if (sa.name === displayName) {
            sa.lastActivityAt = Date.now();
            break;
          }
        }

        // inference:usage is emitted at runtime but not in the TraceEvent union — handle it first
        if ((event as { type: string }).type === 'inference:usage') {
          const roundUsage = (event as { tokenUsage?: { input?: number } }).tokenUsage;
          if (roundUsage?.input) this.lastInputTokens.set(displayName, roundUsage.input);
          return;
        }

        // Postmortem 2026-05-28 F3: track the request-in-flight window.
        // `inference:started` and `inference:stream_resumed` dispatch a new
        // LLM request; the first `inference:tokens`, `inference:completed`,
        // `inference:failed`, or `inference:tool_calls_yielded` signals the
        // provider has responded. Between those, the reaper / peek predicates
        // treat `requestInFlightSince` as proof the agent isn't stuck.
        switch (event.type) {
          case 'inference:started':
            live.currentStream = '';
            live.pendingToolCalls = [];
            live.activeCallIds.clear();
            live.requestInFlightSince = Date.now();
            this.emit(displayName, { type: 'inference:started' });
            break;
          case 'inference:tokens': {
            const content = (event as { content?: string }).content ?? '';
            live.currentStream += content;
            live.requestInFlightSince = undefined;
            this.emit(displayName, { type: 'tokens', content });
            break;
          }
          case 'inference:tool_calls_yielded': {
            const calls = (event as { calls?: Array<{ id: string; name: string; input?: unknown }> }).calls ?? [];
            live.pendingToolCalls = calls.map(c => ({ name: c.name, input: c.input }));
            live.currentStream = '';
            live.requestInFlightSince = undefined;
            // Index callIds so we can route tool:* events back
            for (const c of calls) {
              live.activeCallIds.add(c.id);
              this.callIdIndex.set(c.id, displayName);
            }
            this.emit(displayName, { type: 'tool_calls', calls: calls.map(c => ({ name: c.name, input: c.input })) });
            break;
          }
          case 'inference:stream_resumed':
            live.currentStream = '';
            live.pendingToolCalls = [];
            live.requestInFlightSince = Date.now();
            this.emit(displayName, { type: 'stream_resumed' });
            break;
          case 'inference:completed': {
            const usage = (event as { tokenUsage?: { input?: number } }).tokenUsage;
            if (usage?.input) this.lastInputTokens.set(displayName, usage.input);
            live.requestInFlightSince = undefined;
            this.emit(displayName, { type: 'inference:completed' });
            break;
          }
          case 'inference:failed': {
            const error = (event as { error?: string }).error ?? 'Unknown error';
            live.requestInFlightSince = undefined;
            this.emit(displayName, { type: 'inference:failed', error });
            break;
          }
        }
        return;
      }

      // Events with callId: tool lifecycle (no agentName)
      const callId = 'callId' in event ? (event as { callId: string }).callId : null;
      if (callId) {
        const displayName = this.callIdIndex.get(callId);
        if (!displayName) return;

        switch (event.type) {
          case 'tool:started': {
            const e = event as { tool: string; input?: unknown };
            this.emit(displayName, { type: 'tool:started', tool: e.tool, input: e.input });
            break;
          }
          case 'tool:completed': {
            const e = event as { tool: string; durationMs: number };
            this.callIdIndex.delete(callId);
            this.emit(displayName, { type: 'tool:completed', tool: e.tool, durationMs: e.durationMs });
            break;
          }
          case 'tool:failed': {
            const e = event as { tool: string; error: string };
            this.callIdIndex.delete(callId);
            this.emit(displayName, { type: 'tool:failed', tool: e.tool, error: e.error });
            break;
          }
        }
      }
    });
  }

  private getFramework(): AgentFramework {
    if (!this.framework) throw new Error('SubagentModule: framework not set. Call setFramework() after creating the framework.');
    return this.framework;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
    // Restore in-memory state from Chronicle (for session restore / branch switch)
    this.restoreFromStore();

    // Periodic zombie reap independent of acquireSlot demand. See reaperTimer
    // comment above. Wrapped in try/catch — a reap-loop bug must not crash
    // the module.
    this.reaperTimer = setInterval(() => {
      try {
        const reclaimed = this.reclaimZombieSlots();
        if (reclaimed > 0) {
          // Persist updated statuses so chronicle reflects the reap.
          this.persistState();
        }
      } catch (error) {
        console.error('[subagent] periodic reaper error:', error);
      }
    }, SubagentModule.REAPER_INTERVAL_MS);
    // Don't keep the event loop alive just for the reaper.
    if (typeof (this.reaperTimer as { unref?: () => void }).unref === 'function') {
      (this.reaperTimer as { unref: () => void }).unref();
    }
  }

  async stop(): Promise<void> {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
    this.ctx = null;
  }

  /**
   * Persist subagent registry to Chronicle module state.
   * Called after each lifecycle transition so branch ops get correct fleet.
   */
  private persistState(): void {
    if (!this.ctx) return;
    const agents: Record<string, PersistedSubagent> = {};
    for (const [key, sa] of this.activeSubagents) {
      agents[key] = {
        name: sa.name,
        type: sa.type,
        task: sa.task,
        status: sa.status,
        startedAt: sa.startedAt,
        lastActivityAt: sa.lastActivityAt,
        completedAt: sa.completedAt,
        toolCallsCount: sa.toolCallsCount,
        findingsCount: sa.findingsCount,
        statusMessage: sa.statusMessage,
        parent: this.parentMap.get(sa.name),
      };
    }
    this.ctx.setState({ agents });
  }

  /**
   * Restore activeSubagents + parentMap from Chronicle module state.
   * Marks any 'running' entries as 'cancelled' since the actual processes are gone.
   * Postmortem 2026-05-28 P1 #4: use 'cancelled' (not 'completed') so the
   * operator can tell host-interruption from genuine completion in the TUI.
   */
  restoreFromStore(): void {
    if (!this.ctx) return;
    const persisted = this.ctx.getState<{ agents?: Record<string, PersistedSubagent> }>();
    if (!persisted?.agents) return;

    this.activeSubagents.clear();
    this.parentMap.clear();

    for (const [key, pa] of Object.entries(persisted.agents)) {
      const sa: ActiveSubagent = {
        name: pa.name,
        type: pa.type,
        task: pa.task,
        status: pa.status === 'running' ? 'cancelled' : pa.status,
        startedAt: pa.startedAt,
        // Fallback for records from versions before lastActivityAt was added:
        // treat them as if their last activity was their start time. Affects
        // only the staleness heuristic, which will simply flag them as stale
        // immediately on next reaper sweep — correct, because by definition
        // the process owning them is gone.
        lastActivityAt: pa.lastActivityAt ?? pa.startedAt,
        completedAt: pa.completedAt ?? (pa.status === 'running' ? Date.now() : undefined),
        toolCallsCount: pa.toolCallsCount,
        findingsCount: pa.findingsCount,
        statusMessage: pa.status === 'running' ? 'interrupted (branch/session switch)' : pa.statusMessage,
      };
      this.activeSubagents.set(key, sa);
      if (pa.parent) {
        this.parentMap.set(pa.name, pa.parent);
      }
    }
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'spawn',
        description: 'Spawn a fresh subagent with a system prompt and task. Async by default — returns immediately and delivers results as a message. Pass sync:true to block until completion.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short name for the subagent' },
            systemPrompt: { type: 'string', description: 'System prompt for the subagent' },
            task: { type: 'string', description: 'The task for the subagent to perform' },
            model: { type: 'string', description: 'Model override (optional)' },
            maxTokens: { type: 'number', description: 'Max output tokens per inference (optional). Defaults to the recipe-level subagent default, else the parent agent\'s maxTokens.' },
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tool names the subagent can use (default: all). Note: subagent--return is always included automatically.',
            },
            sync: { type: 'boolean', description: 'If true, block until subagent completes (default: false)' },
            timeoutMs: { type: 'number', description: 'Execution timeout in milliseconds. Sync tasks default to 600s (auto-detaches to background). Async tasks have no default timeout — only set this if you need a hard deadline.' },
          },
          required: ['name', 'systemPrompt', 'task'],
        },
      },
      {
        name: 'fork',
        description:
          "Fork the current conversation into two parallel streams that share all memory of what you've done so far. " +
          "Both streams are continuations of the same self — one carries on with the broader agenda, the other focuses " +
          "exclusively on a new intention (the `task`). The tool_result you receive identifies which stream you are. " +
          "Async by default; pass sync:true to block until completion.",
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short name for the forked stream' },
            task: { type: 'string', description: 'The intention this fork stream should pursue' },
            systemPrompt: { type: 'string', description: 'Override system prompt (optional, defaults to parent)' },
            model: { type: 'string', description: 'Model override (optional)' },
            maxTokens: { type: 'number', description: 'Max output tokens per inference (optional). Defaults to the recipe-level subagent default, else the parent agent\'s maxTokens.' },
            sync: { type: 'boolean', description: 'If true, block until fork completes (default: false)' },
            timeoutMs: { type: 'number', description: 'Execution timeout in milliseconds. Sync tasks default to 600s (auto-detaches to background). Async tasks have no default timeout — only set this if you need a hard deadline.' },
          },
          required: ['name', 'task'],
        },
      },
      {
        name: 'hud',
        description: 'Toggle the subagent fleet HUD overlay. When enabled, a compact fleet status summary is injected before each inference.',
        inputSchema: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', description: 'Enable or disable the fleet HUD' },
          },
          required: ['enabled'],
        },
      },
      {
        name: 'concurrency',
        description: 'View or adjust subagent concurrency. Omit maxConcurrent to just view status. Concurrency auto-adapts to rate limits (halves on 429, recovers after successes).',
        inputSchema: {
          type: 'object',
          properties: {
            maxConcurrent: { type: 'number', description: 'Set new concurrency ceiling (min 1)' },
          },
        },
      },
      {
        name: 'peek',
        description: 'Peek at a running subagent\'s live state: status, elapsed time, message count, last message snippet, current streaming output, and pending tool calls. Omit name to peek at all running subagents.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Subagent name to peek at (omit for all)' },
          },
        },
      },
      {
        name: 'return',
        description: 'Return results from a fork or spawn back to the parent agent. Call this when you have completed your task. Your result text will be delivered to the parent as the tool result of the fork/spawn call. This ends your execution.',
        inputSchema: {
          type: 'object',
          properties: {
            result: { type: 'string', description: 'Your findings, summary, or results to return to the parent' },
          },
          required: ['result'],
        },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const caller = call.callerAgentName;
    switch (call.name) {
      case 'spawn':
        return this.handleSpawn(call.input as SpawnInput, caller);
      case 'fork':
        return this.handleFork(call.input as ForkInput, caller, call.id);
      case 'hud':
        return this.handleHud(call.input as { enabled: boolean });
      case 'concurrency':
        return this.handleConcurrency(call.input as { maxConcurrent?: number });
      case 'peek':
        return this.handlePeek(call.input as { name?: string }, caller);
      case 'return': {
        // Stash the result keyed by the tool call ID. The completion path
        // in runSpawn/runFork will pick it up via the callIdIndex → displayName.
        const result = (call.input as { result: string }).result;
        // Find which subagent is calling this via the callIdIndex
        const callerName = this.callIdIndex.get(call.id);
        if (callerName) {
          this.returnedResults.set(callerName, result);
        }
        return { success: true, data: 'Result received.', endTurn: true };
      }
      default:
        return { success: false, error: `Unknown tool: ${call.name}`, isError: true };
    }
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    // When an async subagent completes, deliverAsyncResult() pushes an
    // inference-request event.  Convert it into a proper requestInference
    // response so the framework (and EventGate) can route it normally.
    if (event.type === 'inference-request' && 'source' in event && event.source === 'subagent') {
      return { requestInference: [(event as { agentName: string }).agentName] };
    }
    return {};
  }

  async gatherContext(agentName: string): Promise<import('@animalabs/context-manager').ContextInjection[]> {
    if (!this.ctx) return [];
    const persisted = this.ctx.getState<{ hudEnabled?: boolean }>() ?? {};
    if (!persisted.hudEnabled) return [];

    // Postmortem 2026-05-28 P3 #8: scope the Fleet Status HUD to the
    // calling agent's descendants. Pre-fix the HUD injected the whole
    // fleet roster every turn, which (a) encouraged peer-coordination
    // anti-patterns and (b) amplified false zombie/failed flags across
    // the orchestrator's context.
    const allowed = this.getDescendantDisplayNames(agentName);

    const lines: string[] = [];
    for (const [, sa] of this.activeSubagents) {
      if (!allowed.has(sa.name)) continue;
      const elapsed = sa.completedAt
        ? Math.floor((sa.completedAt - sa.startedAt) / 1000)
        : Math.floor((Date.now() - sa.startedAt) / 1000);
      const parent = this.parentMap.get(sa.name) ?? 'agent';
      const parentShort = parent.replace(/^(spawn|fork)-/, '').replace(/-d\d+-\d+$/, '').replace(/-retry\d+$/, '');
      const task = sa.task.length > 50 ? sa.task.slice(0, 47) + '...' : sa.task;
      lines.push(`  ${sa.name} [${sa.type}] ${sa.status} ${elapsed}s ${sa.toolCallsCount}calls parent:${parentShort} "${task}"`);
    }

    // Also show async handles still running, but only those owned by the
    // caller (or its descendants — but async handles aren't parent-indexed
    // separately, so conservatively skip them when scoping is in effect
    // and the caller has no descendants to begin with).
    for (const [name] of this.asyncHandles) {
      if (!allowed.has(name)) continue;
      if (!this.activeSubagents.has(name) && !this.activeSubagents.has(`spawn-${name}`)) {
        lines.push(`  ${name} [async] pending`);
      }
    }

    if (lines.length === 0) return [];

    return [{
      namespace: 'subagent-fleet',
      position: 'afterUser',
      content: [{ type: 'text', text: `[Fleet Status]\n${lines.join('\n')}` }],
    }];
  }

  // =========================================================================
  // Concurrency Control (adaptive, rate-limit-aware)
  // =========================================================================

  /**
   * Acquire a concurrency slot. Returns how long the caller waited (0 = immediate).
   * Throws if the slot is not acquired within `slotTimeoutMs`.
   */
  private async acquireSlot(slotTimeoutMs = 120_000): Promise<{ waitedMs: number }> {
    if (this.activeConcurrent < this.effectiveConcurrent) {
      this.activeConcurrent++;
      return { waitedMs: 0 };
    }

    // Before queueing, try to reclaim slots from zombie subagents
    const reclaimedZombies = this.reclaimZombieSlots();
    if (reclaimedZombies > 0 && this.activeConcurrent < this.effectiveConcurrent) {
      this.activeConcurrent++;
      return { waitedMs: 0 };
    }

    const startWait = Date.now();
    return new Promise<{ waitedMs: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove ourselves from the wait queue
        const idx = this.waitQueue.indexOf(onSlot);
        if (idx >= 0) this.waitQueue.splice(idx, 1);

        // Last-chance zombie reclamation before failing
        const reclaimed = this.reclaimZombieSlots();
        if (reclaimed > 0 && this.activeConcurrent < this.effectiveConcurrent) {
          this.activeConcurrent++;
          resolve({ waitedMs: Date.now() - startWait });
          return;
        }

        // Surface which subagents currently hold the slots, with silence
        // and total runtime. Without this the caller only sees "5/5 in
        // use" and has no signal for which to cancel. In production this
        // lack of detail meant the parent agent couldn't self-rescue —
        // it had to wait days for the demand-driven reaper to fire on
        // its own.
        const holders = this.describeSlotHolders();
        const holderLines = holders.length > 0
          ? `\nSlots held by:\n${holders.map(h => `  - ${h}`).join('\n')}`
          : '';

        reject(new Error(
          `Timed out waiting for a concurrency slot after ${slotTimeoutMs}ms ` +
          `(${this.activeConcurrent}/${this.effectiveConcurrent} slots in use, ` +
          `${this.waitQueue.length} still queued). ` +
          `Limit parallel forks/spawns to ${this.effectiveConcurrent}.` +
          holderLines
        ));
      }, slotTimeoutMs);

      const onSlot = () => {
        clearTimeout(timer);
        resolve({ waitedMs: Date.now() - startWait });
      };

      this.waitQueue.push(onSlot);
    });
  }

  /**
   * Summarize subagents currently holding concurrency slots. Used to enrich
   * the slot-acquisition timeout error so the calling agent can decide
   * which stale forks to cancel rather than helplessly waiting on the
   * demand-driven reaper.
   */
  private describeSlotHolders(): string[] {
    const lines: string[] = [];
    const now = Date.now();
    for (const sa of this.activeSubagents.values()) {
      if (sa.status !== 'running') continue;
      const silentS = Math.floor((now - sa.lastActivityAt) / 1000);
      const runtimeS = Math.floor((now - sa.startedAt) / 1000);
      const live = this.liveSubagents.get(sa.name);
      const streamState = live?.currentStream ? 'streaming' :
        live?.pendingToolCalls?.length ? `awaiting ${live.pendingToolCalls.length} tool(s)` :
        'idle';
      lines.push(
        `${sa.name} [${sa.type}] runtime=${runtimeS}s silent=${silentS}s ${streamState}`
      );
    }
    return lines;
  }

  /**
   * Scan for zombie subagents and force-release their concurrency slots.
   * A zombie is a subagent in 'running' status whose `lastActivityAt` is
   * older than ZOMBIE_THRESHOLD_MS AND has no active inference stream AND
   * no pending tool calls. Using `lastActivityAt` instead of `startedAt`
   * lets us distinguish a 10-hour-but-progressing subagent from one that
   * has been silently stuck for hours — the latter is what kept locking
   * concurrency slots for days in production.
   *
   * Returns the number of slots reclaimed.
   */
  private reclaimZombieSlots(): number {
    // Postmortem 2026-05-28 F3: bumped from 30_000ms — 30s was too tight for
    // Opus on 100–165K-token contexts with rate-limited MCP tools; single-
    // round TTFT routinely exceeds it. The `requestInFlightSince` guard
    // (below) is the primary defence; the threshold bump is belt-and-braces
    // for legitimate post-request pauses.
    const ZOMBIE_THRESHOLD_MS = 120_000;
    let reclaimed = 0;

    for (const [displayName, live] of this.liveSubagents) {
      let entry: ActiveSubagent | undefined;
      for (const e of this.activeSubagents.values()) {
        if (e.name === displayName) { entry = e; break; }
      }
      if (!entry || entry.status !== 'running') continue;

      const silentMs = Date.now() - entry.lastActivityAt;
      // Postmortem 2026-05-28 F3: `!live.requestInFlightSince` protects the
      // "request dispatched, awaiting first token" window. Before this, the
      // guard `!currentStream && pendingToolCalls.length===0` was true while
      // the next round's request was on the wire, and the reaper killed
      // progressing agents mid-request. Forensic signature in production:
      // last message in store is an unconsumed `tool_result`.
      const isZombie = silentMs > ZOMBIE_THRESHOLD_MS
        && !live.currentStream
        && live.pendingToolCalls.length === 0
        && !live.requestInFlightSince;

      if (isZombie) {
        const elapsedTotal = Date.now() - entry.startedAt;
        console.error(
          `[subagent] Reclaiming zombie slot: "${displayName}" ` +
          `(silent for ${(silentMs / 1000).toFixed(0)}s, total runtime ` +
          `${(elapsedTotal / 1000).toFixed(0)}s, no active stream)`
        );

        // Cancel the zombie's framework agent
        try {
          const agent = this.getFramework().getAgent(live.frameworkAgentName);
          if (agent) agent.cancelStream();
        } catch { /* best-effort */ }

        // Cancel via cancellation handle (unblocks the Promise.race in runSpawn/runFork)
        const handle = this.cancellationHandles.get(displayName);
        if (handle) {
          const partial = live.currentStream ?? '';
          handle.reject(new SubagentTerminated(
            'zombie',
            partial,
            `Zombie detected: "${displayName}" silent for ${(silentMs / 1000).toFixed(0)}s ` +
            `(total runtime ${(elapsedTotal / 1000).toFixed(0)}s). Slot reclaimed.`,
          ));
          this.cancellationHandles.delete(displayName);
        }

        // Postmortem 2026-05-28 P1 #4: zombie reclaim is terminal-but-benign,
        // not a fault. Land on 'cancelled' so the TUI and the reducer-driven
        // web tree agree (the reducer maps the trace-side `inference:aborted`
        // emitted by the cancellation handle to 'cancelled' as well).
        entry.status = 'cancelled';
        entry.completedAt = Date.now();
        entry.statusMessage = 'zombie — slot reclaimed';

        // Release the slot (the finally block in runSpawn/runFork will also
        // call releaseSlot, but that's safe — activeConcurrent just goes to
        // max(0, activeConcurrent-1) effectively)
        this.activeConcurrent = Math.max(0, this.activeConcurrent - 1);
        reclaimed++;
      }
    }

    return reclaimed;
  }

  private releaseSlot(): void {
    if (this.activeConcurrent <= 0) return; // Guard against double-release (e.g., zombie reclamation + finally)
    this.activeConcurrent--;
    if (this.waitQueue.length > 0 && this.activeConcurrent < this.effectiveConcurrent) {
      this.activeConcurrent++;
      this.waitQueue.shift()!();
    }
  }

  /** Format a concurrency notice for tool results (empty string if no wait). */
  private concurrencyNotice(waitedMs: number): string {
    if (waitedMs <= 0) return '';
    const secs = (waitedMs / 1000).toFixed(1);
    return `[Concurrency notice: this agent waited ${secs}s for a slot ` +
      `(${this.effectiveConcurrent} concurrent limit). ` +
      `To avoid delays, limit parallel forks/spawns to ${this.effectiveConcurrent}.]\n\n`;
  }

  /** Call on successful subagent completion — gradually recovers concurrency. */
  private onSubagentSuccess(): void {
    this.consecutiveSuccesses++;
    // After 3 consecutive successes, try increasing by 1
    if (this.consecutiveSuccesses >= 3 && this.effectiveConcurrent < this.configuredMaxConcurrent) {
      this.effectiveConcurrent++;
      this.consecutiveSuccesses = 0;
    }
  }

  /** Call on rate limit error — halves concurrency and applies cooldown. */
  private async onRateLimitHit(): Promise<void> {
    const prev = this.effectiveConcurrent;
    this.effectiveConcurrent = Math.max(1, Math.floor(this.effectiveConcurrent / 2));
    this.consecutiveSuccesses = 0;
    this.lastRateLimitAt = Date.now();
    console.error(
      `[subagent] Rate limit hit — concurrency ${prev} → ${this.effectiveConcurrent}, ` +
      `cooling down ${this.rateLimitCooldownMs}ms`
    );
    await new Promise(resolve => setTimeout(resolve, this.rateLimitCooldownMs));
  }

  private isRateLimitError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return msg.includes('rate') || msg.includes('429') || msg.includes('too many');
  }

  /** Transient = worth retrying the whole subagent from scratch. */
  private isTransientError(err: Error): boolean {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('timeout') ||
      msg.includes('idle') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up') ||
      msg.includes('network') ||
      msg.includes('stream aborted') ||
      msg.includes('overloaded') ||
      msg.includes('529') ||
      msg.includes('500') ||
      msg.includes('502') ||
      msg.includes('503') ||
      this.isRateLimitError(err)
    );
  }

  /** Set concurrency ceiling at runtime. Also raises effective if below new ceiling. */
  setConcurrency(n: number): void {
    this.configuredMaxConcurrent = Math.max(1, n);
    if (this.effectiveConcurrent > this.configuredMaxConcurrent) {
      this.effectiveConcurrent = this.configuredMaxConcurrent;
    }
    // If we were throttled below the new ceiling, let waiters through
    while (this.waitQueue.length > 0 && this.activeConcurrent < this.effectiveConcurrent) {
      this.activeConcurrent++;
      this.waitQueue.shift()!();
    }
  }

  /** Get current concurrency status for observability. */
  getConcurrencyStatus(): { configured: number; effective: number; active: number; queued: number } {
    return {
      configured: this.configuredMaxConcurrent,
      effective: this.effectiveConcurrent,
      active: this.activeConcurrent,
      queued: this.waitQueue.length,
    };
  }

  // =========================================================================
  // Subagent Cancellation
  // =========================================================================

  /**
   * Force-stop a running subagent. Aborts the active HTTP stream and
   * causes runSpawn/runFork to return with a "[Stopped by user]" result.
   * Returns true if the subagent was found and cancelled.
   */
  cancelSubagent(displayName: string): boolean {
    // Cancel children first (bottom-up) so their results propagate before the parent dies
    this.cancelChildren(displayName);

    const handle = this.cancellationHandles.get(displayName);
    if (!handle) return false;

    // Abort the active inference stream (cancels the HTTP request)
    const live = this.liveSubagents.get(displayName);
    const partial = live?.currentStream ?? '';
    if (live) {
      try {
        const agent = this.getFramework().getAgent(live.frameworkAgentName);
        if (agent) agent.cancelStream();
      } catch { /* best-effort */ }
    }

    // Unblock the Promise.race in runSpawn/runFork
    handle.reject(new SubagentTerminated('cancelled', partial, `Subagent "${displayName}" cancelled by user`));
    return true;
  }

  /**
   * Cancel all running subagents (e.g. on user Esc).
   * Returns the number of subagents cancelled.
   */
  cancelAll(): number {
    // Collect all cancellable names first to avoid mutation during iteration
    const names = [...this.cancellationHandles.keys()];
    let count = 0;
    for (const name of names) {
      if (this.cancelSubagent(name)) count++;
    }
    return count;
  }

  /**
   * Compute the set of descendant display names rooted at the given framework
   * agent name. Walks `parentMap` (displayName → callerFrameworkAgentName)
   * top-down. Excludes the root itself.
   *
   * Postmortem 2026-05-28 P3 #8: used by peek() and gatherContext() to
   * scope observability surfaces to the caller's subtree. Prevents peer
   * agents from inspecting each other and saturating context with
   * cross-fleet roster information they have no legitimate use for.
   */
  private getDescendantDisplayNames(rootFrameworkAgentName: string): Set<string> {
    const result = new Set<string>();
    const queue: string[] = [rootFrameworkAgentName];
    while (queue.length > 0) {
      const parentFw = queue.shift()!;
      for (const [childDisplayName, parentName] of this.parentMap) {
        if (parentName === parentFw && !result.has(childDisplayName)) {
          result.add(childDisplayName);
          const childLive = this.liveSubagents.get(childDisplayName);
          if (childLive) queue.push(childLive.frameworkAgentName);
        }
      }
    }
    return result;
  }

  /**
   * Cancel all children (direct + transitive) of the given display name.
   * Uses the parentMap to find descendants via framework agent names.
   */
  private cancelChildren(displayName: string): void {
    const live = this.liveSubagents.get(displayName);
    if (!live) return;

    // Find direct children: entries in parentMap whose parent is this agent's framework name
    const frameworkName = live.frameworkAgentName;
    const children: string[] = [];
    for (const [childName, parentFrameworkName] of this.parentMap) {
      if (parentFrameworkName === frameworkName) {
        children.push(childName);
      }
    }

    // Cancel each child (which recursively cancels its children)
    for (const child of children) {
      this.cancelSubagent(child);
    }
  }

  // =========================================================================
  // Peek Observability
  // =========================================================================

  private registerLive(
    displayName: string,
    frameworkAgentName: string,
    systemPrompt: string,
    contextManager: ContextManager,
  ): void {
    this.liveSubagents.set(displayName, {
      frameworkAgentName,
      displayName,
      systemPrompt,
      contextManager,
      currentStream: '',
      pendingToolCalls: [],
      activeCallIds: new Set(),
    });
    this.frameworkNameIndex.set(frameworkAgentName, displayName);
  }

  private unregisterLive(displayName: string, frameworkAgentName: string): void {
    // Clean up callId index entries for this subagent
    const live = this.liveSubagents.get(displayName);
    if (live) {
      for (const callId of live.activeCallIds) {
        this.callIdIndex.delete(callId);
      }
    }
    this.liveSubagents.delete(displayName);
    this.frameworkNameIndex.delete(frameworkAgentName);
  }

  /** Fan out a stream event to all subscribers for this subagent + wildcard. */
  private emit(displayName: string, event: SubagentStreamEvent): void {
    for (const key of [displayName, '*']) {
      const subs = this.streamSubscribers.get(key);
      if (!subs) continue;
      for (const cb of subs) {
        try { cb(event); } catch { /* subscriber error — don't break the loop */ }
      }
    }
  }

  /**
   * Subscribe to a running subagent's live stream. Receives all inference
   * and tool events as they happen. Returns an unsubscribe function.
   *
   * If name is '*', subscribes to events from ALL subagents (events are
   * the same type — use peek() to get the subagent name if needed).
   */
  onPeekStream(name: string, callback: SubagentStreamCallback): () => void {
    if (!this.streamSubscribers.has(name)) {
      this.streamSubscribers.set(name, new Set());
    }
    this.streamSubscribers.get(name)!.add(callback);

    return () => {
      const subs = this.streamSubscribers.get(name);
      if (subs) {
        subs.delete(callback);
        if (subs.size === 0) this.streamSubscribers.delete(name);
      }
    };
  }

  /**
   * Peek at a running subagent's live state: full context, streaming output,
   * pending tool calls. Returns null if the subagent is not running.
   * If name is omitted, returns snapshots for all running subagents.
   *
   * Postmortem 2026-05-28 P3 #8: when a `callerFrameworkAgentName` is
   * supplied (the normal tool-call path threads it through `handlePeek`),
   * the result is scoped to the caller's descendants — peers/cousins are
   * filtered out. Internal callers without a known identity (omit the arg)
   * keep the global view for backward compatibility.
   */
  async peek(name?: string, callerFrameworkAgentName?: string): Promise<SubagentPeekSnapshot[]> {
    const allowed = callerFrameworkAgentName
      ? this.getDescendantDisplayNames(callerFrameworkAgentName)
      : null;
    if (name) {
      if (allowed && !allowed.has(name)) return [];
      const snapshot = await this.peekOne(name);
      return snapshot ? [snapshot] : [];
    }
    const results: SubagentPeekSnapshot[] = [];
    for (const displayName of this.liveSubagents.keys()) {
      if (allowed && !allowed.has(displayName)) continue;
      const snapshot = await this.peekOne(displayName);
      if (snapshot) results.push(snapshot);
    }
    return results;
  }

  private async peekOne(displayName: string): Promise<SubagentPeekSnapshot | null> {
    const live = this.liveSubagents.get(displayName);
    if (!live) return null;

    // Find the matching ActiveSubagent entry for status/metadata
    let entry: ActiveSubagent | undefined;
    for (const e of this.activeSubagents.values()) {
      if (e.name === displayName) { entry = e; break; }
    }

    let messageCount = 0;
    let lastMessageSnippet = '';
    try {
      const compiled = await live.contextManager.compile();
      messageCount = compiled.messages.length;
      // Extract a short snippet from the last message for observability
      // without dumping the entire context into the caller's window.
      if (compiled.messages.length > 0) {
        const last = compiled.messages[compiled.messages.length - 1];
        const textBlocks = last.content
          .filter((b: ContentBlock) => b.type === 'text')
          .map((b: ContentBlock) => (b as { type: 'text'; text: string }).text);
        const fullText = textBlocks.join(' ');
        lastMessageSnippet = fullText.length > 500 ? fullText.slice(-500) : fullText;
      }
    } catch {
      // Context manager may be mid-modification; return what we have
    }

    const elapsedMs = entry ? Date.now() - entry.startedAt : 0;

    // Zombie detection. Postmortem 2026-05-28 F2: this previously keyed off
    // `startedAt`, which flagged any subagent >30s old as a zombie the moment
    // it was between tokens — saturating peers' context with false alarms and
    // driving an orchestrator-level retry storm. Now keyed off `lastActivityAt`
    // and gated by `!requestInFlightSince` to match the reaper.
    const ZOMBIE_THRESHOLD_MS = 120_000;
    const silentMs = entry ? Date.now() - entry.lastActivityAt : 0;
    const isZombie = (entry?.status === 'running')
      && silentMs > ZOMBIE_THRESHOLD_MS
      && !live.currentStream
      && live.pendingToolCalls.length === 0
      && !live.requestInFlightSince;

    return {
      name: displayName,
      type: entry?.type ?? 'spawn',
      task: entry?.task ?? '',
      status: entry?.status ?? 'running',
      startedAt: entry?.startedAt ?? 0,
      elapsedMs,
      messageCount,
      lastMessageSnippet,
      currentStream: live.currentStream,
      pendingToolCalls: live.pendingToolCalls,
      toolCallsCount: entry?.toolCallsCount ?? 0,
      isZombie,
    };
  }

  // =========================================================================
  // Execution Timeout
  // =========================================================================

  /**
   * Resolve a subagent's maxTokens budget through the cascade:
   *   1. per-call `maxTokens` on the fork/spawn input
   *   2. recipe-level `defaultMaxTokens` on this module's config
   *   3. parent agent's `maxTokens` (by default, subagents inherit their caller's budget)
   *   4. last-resort framework fallback (4096) — only reached if there's no parent at all
   */
  private resolveMaxTokens(callMaxTokens: number | undefined, parentAgentName?: string): number {
    if (callMaxTokens !== undefined) return callMaxTokens;
    if (this.config.defaultMaxTokens !== undefined) return this.config.defaultMaxTokens;
    const parentName = parentAgentName ?? this.config.parentAgentName;
    if (parentName) {
      const parent = this.framework?.getAgent(parentName);
      if (parent) return parent.maxTokens;
    }
    return 4096;
  }

  private withTimeout<T>(promise: Promise<T>, name: string, timeoutMs?: number): Promise<T> {
    if (timeoutMs === undefined) return promise;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Subagent ${name} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      ),
    ]);
  }

  // =========================================================================
  // Prompt Size Estimation
  // =========================================================================

  private estimatePromptTokens(
    systemPrompt: string,
    messages: Array<{ content: ContentBlock[] }>,
    tools: ToolDefinition[],
  ): number {
    let tokens = Math.ceil(systemPrompt.length / 4) + 50; // system + overhead

    for (const msg of messages) {
      tokens += 50; // per-message overhead (role, formatting)
      for (const block of msg.content) {
        tokens += Math.ceil(JSON.stringify(block).length / 4);
      }
    }

    for (const tool of tools) {
      tokens += 100; // per-tool overhead
      tokens += Math.ceil(JSON.stringify(tool).length / 4);
    }

    return tokens;
  }

  // =========================================================================
  // Tool Handlers
  // =========================================================================

  private async handleSpawn(input: SpawnInput, callerAgentName?: string): Promise<ToolResult> {
    const callerDepth = callerAgentName ? (this.agentDepths.get(callerAgentName) ?? 0) : 0;
    if (callerDepth >= this.maxDepth) {
      return {
        success: false,
        isError: true,
        error: `Max subagent depth ${this.maxDepth} reached (caller at depth ${callerDepth})`,
      };
    }

    const parentAgentName = callerAgentName ?? this.config.parentAgentName ?? 'agent';

    // Sync mode: block until completion, but detachable mid-flight.
    // Default timeout applies (600s) — auto-detaches to background.
    if (input.sync) {
      const timeoutMs = input.timeoutMs ?? this.maxExecutionMs;
      const promise = this.runSpawn(input, callerAgentName, callerDepth, timeoutMs);
      const result = await this.runDetachable(input.name, 'spawn', promise, parentAgentName, input.timeoutMs);
      return result;
    }

    // Async mode (default): fire-and-forget, deliver result as message.
    // No default timeout — async agents run until they finish unless
    // the caller explicitly sets timeoutMs.
    const promise = this.runSpawn(input, callerAgentName, callerDepth, input.timeoutMs);
    this.asyncHandles.set(input.name, { name: input.name, type: 'spawn', promise, parentAgentName });

    promise
      .then(result => this.deliverAsyncResult(input.name, result, parentAgentName))
      .catch(err => this.deliverAsyncError(input.name, err, parentAgentName));

    return { success: true, data: `Subagent '${input.name}' spawned. Running in background.` };
  }

  private async handleFork(input: ForkInput, callerAgentName?: string, callToolUseId?: string): Promise<ToolResult> {
    const callerDepth = callerAgentName ? (this.agentDepths.get(callerAgentName) ?? 0) : 0;
    if (callerDepth >= this.maxDepth) {
      return {
        success: false,
        isError: true,
        error: `Max subagent depth ${this.maxDepth} reached (caller at depth ${callerDepth})`,
      };
    }

    const parentAgentName = callerAgentName ?? this.config.parentAgentName ?? 'agent';

    // Sync mode: block until completion, but detachable mid-flight.
    // Default timeout applies (600s) — auto-detaches to background.
    if (input.sync) {
      const timeoutMs = input.timeoutMs ?? this.maxExecutionMs;
      const promise = this.runFork(input, callerAgentName, callerDepth, timeoutMs, callToolUseId);
      const result = await this.runDetachable(input.name, 'fork', promise, parentAgentName, input.timeoutMs);
      return result;
    }

    // Async mode (default): fire-and-forget, deliver result as message.
    // No default timeout — async agents run until they finish unless
    // the caller explicitly sets timeoutMs.
    const promise = this.runFork(input, callerAgentName, callerDepth, input.timeoutMs, callToolUseId);
    this.asyncHandles.set(input.name, { name: input.name, type: 'fork', promise, parentAgentName });

    promise
      .then(result => this.deliverAsyncResult(input.name, result, parentAgentName))
      .catch(err => this.deliverAsyncError(input.name, err, parentAgentName));

    return { success: true, data: `Subagent '${input.name}' forked. Running in background.` };
  }

  private deliverAsyncResult(name: string, result: SubagentResult, parentAgentName: string): void {
    this.asyncHandles.delete(name);
    if (!this.ctx) return;

    this.ctx.addMessage('user', [{
      type: 'text',
      text: `[Subagent '${name}' returned]\n\n${result.summary}`,
    }]);
    this.ctx.pushEvent({
      type: 'inference-request',
      agentName: parentAgentName,
      reason: `subagent-completed:${name}`,
      source: 'subagent',
    });
  }

  private deliverAsyncError(name: string, err: unknown, parentAgentName: string): void {
    this.asyncHandles.delete(name);
    if (!this.ctx) return;

    const message = err instanceof Error ? err.message : String(err);
    this.ctx.addMessage('user', [{
      type: 'text',
      text: `[Subagent '${name}' failed]\n\nError: ${message}`,
    }]);
    this.ctx.pushEvent({
      type: 'inference-request',
      agentName: parentAgentName,
      reason: `subagent-failed:${name}`,
      source: 'subagent',
    });
  }

  // =========================================================================
  // Detachable sync → async transition
  // =========================================================================

  /**
   * Run a sync subagent with the ability to detach mid-flight.
   * Returns a ToolResult — either the completed result (if it finishes in time)
   * or a "moved to background" acknowledgment (if detached by user or timeout).
   */
  private async runDetachable(
    name: string,
    type: 'spawn' | 'fork',
    promise: Promise<SubagentResult>,
    parentAgentName: string,
    autoDetachMs?: number,
  ): Promise<ToolResult> {
    let detachResolve: ((value: 'detached') => void) | null = null;
    const detachPromise = new Promise<'detached'>(resolve => { detachResolve = resolve; });

    const handle: DetachableHandle = {
      name,
      type,
      promise,
      parentAgentName,
      detach: () => detachResolve?.('detached'),
    };
    this.detachableHandles.set(name, handle);

    // Optional auto-detach timeout (sync → async after N ms)
    let autoTimer: ReturnType<typeof setTimeout> | null = null;
    if (autoDetachMs !== undefined) {
      autoTimer = setTimeout(() => {
        if (this.detachableHandles.has(name)) {
          handle.detach();
        }
      }, autoDetachMs);
    }

    type RaceResult =
      | { kind: 'completed'; result: SubagentResult }
      | { kind: 'error'; error: unknown }
      | { kind: 'detached' };

    try {
      const winner: RaceResult = await Promise.race([
        promise.then(
          (result): RaceResult => ({ kind: 'completed', result }),
          (err): RaceResult => ({ kind: 'error', error: err }),
        ),
        detachPromise.then((): RaceResult => ({ kind: 'detached' })),
      ]);

      if (autoTimer) clearTimeout(autoTimer);
      this.detachableHandles.delete(name);

      if (winner.kind === 'completed') {
        return { success: true, data: winner.result };
      }

      if (winner.kind === 'error') {
        const err = winner.error;
        return {
          success: false,
          isError: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      // Detached: transition to async — wire up result delivery
      this.asyncHandles.set(name, { name, type, promise, parentAgentName });
      promise
        .then(result => this.deliverAsyncResult(name, result, parentAgentName))
        .catch(err => this.deliverAsyncError(name, err, parentAgentName));

      return {
        success: true,
        data: `Subagent '${name}' moved to background. Results will be delivered as a message when complete.`,
      };
    } catch {
      if (autoTimer) clearTimeout(autoTimer);
      this.detachableHandles.delete(name);
      return { success: false, isError: true, error: `Unexpected error in detachable handler for '${name}'` };
    }
  }

  /**
   * Detach a currently-blocking sync subagent, converting it to async.
   * Returns true if the subagent was found and detached.
   */
  detachSubagent(name: string): boolean {
    const handle = this.detachableHandles.get(name);
    if (!handle) return false;
    handle.detach();
    return true;
  }

  /**
   * Detach all currently-blocking sync subagents.
   * Returns the number of subagents detached.
   */
  detachAll(): number {
    let count = 0;
    for (const handle of this.detachableHandles.values()) {
      handle.detach();
      count++;
    }
    return count;
  }

  /**
   * Check if any sync subagents are currently blocking (and thus detachable).
   */
  hasDetachable(): boolean {
    return this.detachableHandles.size > 0;
  }

  private handleHud(input: { enabled: boolean }): ToolResult {
    if (!this.ctx) return { success: false, isError: true, error: 'Module not started' };
    const persisted = this.ctx.getState<{ agents?: unknown; hudEnabled?: boolean }>() ?? {};
    this.ctx.setState({ ...persisted, hudEnabled: input.enabled });
    return { success: true, data: { hudEnabled: input.enabled } };
  }

  private handleConcurrency(input: { maxConcurrent?: number }): ToolResult {
    if (input.maxConcurrent !== undefined) {
      this.setConcurrency(input.maxConcurrent);
    }
    return { success: true, data: this.getConcurrencyStatus() };
  }

  private async handlePeek(input: { name?: string }, caller?: string): Promise<ToolResult> {
    const snapshots = await this.peek(input.name, caller);
    if (snapshots.length === 0) {
      return {
        success: true,
        data: { message: input.name ? `No running subagent named '${input.name}'` : 'No running subagents' },
      };
    }
    return { success: true, data: snapshots };
  }

  // =========================================================================
  // Subagent Execution
  // =========================================================================

  private async runSpawn(input: SpawnInput, _callerAgentName?: string, callerDepth = 0, executionTimeoutMs?: number): Promise<SubagentResult> {
    const { waitedMs } = await this.acquireSlot();
    const childDepth = callerDepth + 1;

    const now = Date.now();
    const entry: ActiveSubagent = {
      name: input.name, type: 'spawn', task: input.task,
      status: 'running', startedAt: now, lastActivityAt: now,
      toolCallsCount: 0, findingsCount: 0,
    };
    const entryKey = `spawn-${input.name}`;
    this.activeSubagents.set(entryKey, entry);
    if (_callerAgentName) this.parentMap.set(input.name, _callerAgentName);
    this.persistState();

    try {
      const framework = this.getFramework();
      const model = input.model ?? this.config.defaultModel ?? 'claude-haiku-4-5-20251001';
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        const agentName = `spawn-${input.name}-${Date.now()}`;
        const { agent, contextManager, cleanup } = await framework.createEphemeralAgent({
          name: agentName,
          model,
          systemPrompt: input.systemPrompt,
          maxTokens: this.resolveMaxTokens(input.maxTokens, _callerAgentName),
          maxStreamTokens: 200_000,
          strategy: new KnowledgeStrategy({
            headWindowTokens: 2_000,
            recentWindowTokens: 80_000,
            compressionModel: model,
            autoTickOnNewMessage: true,
            maxMessageTokens: 10_000,
          }),
          allowedTools: this.filterToolNames(input.tools, callerDepth),
        });

        // Track depth for recursive fork/spawn calls from this agent
        this.agentDepths.set(agentName, childDepth);

        // Register live state for peek observability
        this.registerLive(input.name, agentName, input.systemPrompt, contextManager);

        try {
          contextManager.addMessage('user', [{ type: 'text', text: input.task }]);

          // Pre-validate prompt size
          const { messages } = await contextManager.compile();
          const tools = framework.getAllTools().filter(t => agent.canUseTool(t.name));
          const est = this.estimatePromptTokens(agent.systemPrompt, messages, tools);
          if (est > this.maxPromptTokens) {
            throw new Error(
              `Prompt too large for subagent ${input.name}: ~${est} tokens ` +
              `(limit: ${this.maxPromptTokens}). Reduce context or task size.`
            );
          }

          // Race execution against both timeout and user cancellation
          const cancelPromise = new Promise<never>((_, reject) => {
            this.cancellationHandles.set(input.name, { reject });
          });

          let { speech, toolCallsCount } = await Promise.race([
            this.withTimeout(
              framework.runEphemeralToCompletion(agent, contextManager),
              input.name,
              executionTimeoutMs,
            ),
            cancelPromise,
          ]);

          this.cancellationHandles.delete(input.name);

          // Prefer explicit return over speech capture
          const returned = this.returnedResults.get(input.name);
          if (returned) {
            speech = returned;
            this.returnedResults.delete(input.name);
          } else if (!speech.trim()) {
            speech = this.extractLastAssistantText(contextManager);
          }

          entry.status = 'completed';
          entry.completedAt = Date.now();
          entry.toolCallsCount = toolCallsCount;
          this.onSubagentSuccess();
          const notice = this.concurrencyNotice(waitedMs);
          const finalSummary = notice + speech;
          this.emit(input.name, { type: 'done', summary: finalSummary, lastInputTokens: this.lastInputTokens.get(input.name) });
          return { summary: finalSummary, findings: [], issues: [], toolCallsCount };
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          this.cancellationHandles.delete(input.name);

          // Non-retryable termination (user cancel, zombie reclaim, etc.).
          // Postmortem 2026-05-28 P1 #4: terminal-but-benign — 'cancelled',
          // not 'completed'. Before this, the TUI subagent list rendered these
          // as "done" while the reducer-driven web tree rendered them red.
          if (lastError instanceof SubagentTerminated) {
            entry.status = 'cancelled';
            entry.completedAt = Date.now();
            entry.statusMessage = lastError.reason;
            const notice = this.concurrencyNotice(waitedMs);
            const label = lastError.reason === 'cancelled' ? 'Stopped by user' : `Terminated: ${lastError.reason}`;
            const summary = notice + `[${label}] ` + (lastError.partialOutput || '(no output yet)');
            this.emit(input.name, { type: 'done', summary, lastInputTokens: this.lastInputTokens.get(input.name) });
            return { summary, findings: [], issues: [], toolCallsCount: entry.toolCallsCount };
          }

          if (this.isRateLimitError(lastError)) await this.onRateLimitHit();
          if (!this.isTransientError(lastError) || attempt === this.maxRetries) break;

          const delay = Math.min(5_000 * (attempt + 1), 30_000);
          console.error(
            `[subagent] ${input.name} attempt ${attempt + 1}/${this.maxRetries + 1} failed: ` +
            `${lastError.message}. Restarting in ${delay}ms...`
          );
          entry.statusMessage = `Retry ${attempt + 1}: ${lastError.message}`;
          await new Promise(resolve => setTimeout(resolve, delay));
        } finally {
          this.agentDepths.delete(agentName);
          this.unregisterLive(input.name, agentName);
          cleanup();
        }
      }

      entry.status = 'failed';
      entry.completedAt = Date.now();
      entry.statusMessage = lastError!.message;
      throw lastError!;
    } finally {
      this.persistState();
      this.releaseSlot();
    }
  }

  private async runFork(input: ForkInput, callerAgentName?: string, callerDepth = 0, executionTimeoutMs?: number, callToolUseId?: string): Promise<SubagentResult> {
    const { waitedMs } = await this.acquireSlot();
    const childDepth = callerDepth + 1;

    const now = Date.now();
    const entry: ActiveSubagent = {
      name: input.name, type: 'fork', task: input.task,
      status: 'running', startedAt: now, lastActivityAt: now,
      toolCallsCount: 0, findingsCount: 0,
    };
    this.activeSubagents.set(input.name, entry);
    if (callerAgentName) this.parentMap.set(input.name, callerAgentName);
    this.persistState();

    try {
      const framework = this.getFramework();

      // Dynamic parent resolution: prefer the caller agent (enables recursive forks),
      // fall back to the configured parent agent for backward compat.
      const parentAgent = callerAgentName
        ? framework.getAgent(callerAgentName)
        : (this.config.parentAgentName ? framework.getAgent(this.config.parentAgentName) : null);

      const systemPrompt = input.systemPrompt
        ?? (parentAgent ? parentAgent.systemPrompt : 'You are a research assistant.');

      const model = input.model ?? this.config.defaultModel ?? 'claude-haiku-4-5-20251001';
      let lastError: Error | null = null;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        // Unique agent name: include depth + timestamp to prevent collisions when
        // a child fork uses the same display name as its parent (e.g. both called
        // "fork-level-2"). Without this, the child overwrites the parent in the
        // framework's agents Map, and the parent's completion promise never resolves.
        const suffix = attempt === 0 ? `d${childDepth}-${Date.now()}` : `d${childDepth}-retry${attempt}-${Date.now()}`;
        const agentName = `${input.name}-${suffix}`;

        const { agent, contextManager, cleanup } = await framework.createEphemeralAgent({
          name: agentName,
          model,
          systemPrompt,
          maxTokens: this.resolveMaxTokens(input.maxTokens, callerAgentName),
          maxStreamTokens: 200_000,
          strategy: new KnowledgeStrategy({
            headWindowTokens: 2_000,
            recentWindowTokens: 80_000,
            compressionModel: model,
            autoTickOnNewMessage: true,
            maxMessageTokens: 10_000,
          }),
          allowedTools: this.filterToolNames(undefined, callerDepth),
        });

        // Track depth for recursive fork/spawn calls from this agent
        this.agentDepths.set(agentName, childDepth);

        // Register live state for peek observability
        this.registerLive(input.name, agentName, systemPrompt, contextManager);

        try {
          // Materialise the fork's inherited context structurally:
          //  - locate the parent's matching subagent--fork tool_use by id
          //  - strip sibling fork tool_use blocks (and their tool_results) from
          //    the parent's last assistant turn — they read as fleet-dispatch
          //    evidence and convince the model it's the parent
          //  - rewrite the matching tool_result with intention-stream framing
          //    that names the dual-self situation explicitly
          //  - drop everything after that tool_result (post-fork peek/wait
          //    turns are the other big chunk of parent-coherence signal)
          // If parent context is compressed past the fork point and the
          // matching tool_use can't be located, fall back to wholesale copy
          // plus a synthetic intention-framed fork tool_use/tool_result.
          if (parentAgent) {
            const parentCM = parentAgent.getContextManager();
            const { messages: compiled } = await parentCM.compile();
            const transformed = callToolUseId
              ? materialiseStructuralFork(
                  compiled,
                  callToolUseId,
                  input.name,
                  input.task,
                  childDepth,
                  this.maxDepth,
                )
              : null;

            const seen = new Set<string>();
            const addMsg = (msg: { participant: string; content: ContentBlock[] }) => {
              const key = msg.participant + '\0' + JSON.stringify(msg.content);
              if (seen.has(key)) return;
              seen.add(key);
              const participant = msg.participant === parentAgent.name ? agentName : msg.participant;
              contextManager.addMessage(participant, msg.content);
            };

            if (transformed) {
              for (const msg of transformed) addMsg(msg);
            } else {
              // Fallback path: matching tool_use not located (parent compressed it
              // away, or no callToolUseId). Wholesale copy is safe here because
              // the cascade-bait — the matching fork tool_use and its siblings —
              // got compressed away with the rest of the assistant turn. Append
              // a synthetic intention-framed result so the child still gets the
              // dual-stream framing as the salient last message.
              for (const msg of compiled) addMsg(msg);

              const fallbackForkId = `fork-${input.name}-${crypto.randomUUID()}`;
              contextManager.addMessage(agentName, [{
                type: 'tool_use',
                id: fallbackForkId,
                name: 'subagent--fork',
                input: { name: input.name, task: input.task },
              }] as ContentBlock[]);
              contextManager.addMessage('user', [{
                type: 'tool_result',
                toolUseId: fallbackForkId,
                content: buildIntentionFramedForkResult(input.name, input.task, childDepth, this.maxDepth),
              }] as ContentBlock[]);
            }
          }

          // Pre-validate prompt size
          const { messages } = await contextManager.compile();
          const tools = framework.getAllTools().filter(t => agent.canUseTool(t.name));
          const est = this.estimatePromptTokens(agent.systemPrompt, messages, tools);
          if (est > this.maxPromptTokens) {
            throw new Error(
              `Prompt too large for subagent ${input.name}: ~${est} tokens ` +
              `(limit: ${this.maxPromptTokens}). Reduce context or task size.`
            );
          }

          // Race execution against both timeout and user cancellation
          const cancelPromise = new Promise<never>((_, reject) => {
            this.cancellationHandles.set(input.name, { reject });
          });

          let { speech, toolCallsCount } = await Promise.race([
            this.withTimeout(
              framework.runEphemeralToCompletion(agent, contextManager),
              input.name,
              executionTimeoutMs,
            ),
            cancelPromise,
          ]);

          this.cancellationHandles.delete(input.name);

          // Prefer explicit return over speech capture
          const returned = this.returnedResults.get(input.name);
          if (returned) {
            speech = returned;
            this.returnedResults.delete(input.name);
          } else if (!speech.trim()) {
            speech = this.extractLastAssistantText(contextManager);
          }

          entry.status = 'completed';
          entry.completedAt = Date.now();
          entry.toolCallsCount = toolCallsCount;
          this.onSubagentSuccess();
          const notice = this.concurrencyNotice(waitedMs);
          const finalSummary = notice + speech;
          this.emit(input.name, { type: 'done', summary: finalSummary, lastInputTokens: this.lastInputTokens.get(input.name) });
          return { summary: finalSummary, findings: [], issues: [], toolCallsCount };
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          this.cancellationHandles.delete(input.name);

          // Non-retryable termination (user cancel, zombie reclaim, etc.).
          // See P1 #4 comment in runSpawn — 'cancelled', not 'completed'.
          if (lastError instanceof SubagentTerminated) {
            entry.status = 'cancelled';
            entry.completedAt = Date.now();
            entry.statusMessage = lastError.reason;
            const notice = this.concurrencyNotice(waitedMs);
            const label = lastError.reason === 'cancelled' ? 'Stopped by user' : `Terminated: ${lastError.reason}`;
            const summary = notice + `[${label}] ` + (lastError.partialOutput || '(no output yet)');
            this.emit(input.name, { type: 'done', summary, lastInputTokens: this.lastInputTokens.get(input.name) });
            return { summary, findings: [], issues: [], toolCallsCount: entry.toolCallsCount };
          }

          if (this.isRateLimitError(lastError)) await this.onRateLimitHit();
          if (!this.isTransientError(lastError) || attempt === this.maxRetries) break;

          const delay = Math.min(5_000 * (attempt + 1), 30_000);
          console.error(
            `[subagent] ${input.name} attempt ${attempt + 1}/${this.maxRetries + 1} failed: ` +
            `${lastError.message}. Restarting in ${delay}ms...`
          );
          entry.statusMessage = `Retry ${attempt + 1}: ${lastError.message}`;
          await new Promise(resolve => setTimeout(resolve, delay));
        } finally {
          this.agentDepths.delete(agentName);
          this.unregisterLive(input.name, agentName);
          cleanup();
        }
      }

      entry.status = 'failed';
      entry.completedAt = Date.now();
      entry.statusMessage = lastError!.message;
      throw lastError!;
    } finally {
      this.persistState();
      this.releaseSlot();
    }
  }

  /**
   * Extract the last assistant text from a context manager's messages.
   * Fallback when the streaming speech capture is empty (e.g., agent's
   * last action was a tool call, or speech was reset on stream_resumed).
   */
  private extractLastAssistantText(contextManager: ContextManager): string {
    try {
      const messages = contextManager.getAllMessages();
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.participant === 'user' || msg.participant === 'User') continue;
        const texts = msg.content
          .filter((b: ContentBlock) => b.type === 'text')
          .map((b: ContentBlock) => (b as { type: 'text'; text: string }).text);
        if (texts.length > 0) return texts.join('\n');
      }
    } catch {
      // best-effort
    }
    return '(no text output)';
  }

  /**
   * Build the allowedTools list for a subagent.
   * Removes subagent tools if at depth limit.
   *
   */
  private filterToolNames(allowedTools?: string[], callerDepth = 0): 'all' | string[] {
    // Always include subagent--return — subagents need it to deliver results
    const ensureReturn = (list: string[]) => {
      if (!list.includes('subagent--return')) list.push('subagent--return');
      return list;
    };

    // Use per-agent depth (from caller) rather than the module's static depth
    if (callerDepth + 1 >= this.maxDepth) {
      const allTools = this.getFramework().getAllTools();
      const filtered = allTools
        .filter(t => !t.name.startsWith('subagent--'))
        .map(t => t.name);
      if (allowedTools) {
        const allowed = new Set(allowedTools);
        return ensureReturn(filtered.filter(n => allowed.has(n)));
      }
      return ensureReturn(filtered);
    }
    return allowedTools ? ensureReturn(allowedTools) : 'all';
  }

}
