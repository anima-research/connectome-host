/**
 * InstructionsModule — injects a shared, living instructions document into
 * every agent's context on every turn.
 *
 * The document is a CLAUDE.md analogue maintained in a workspace mount:
 * operators (or the agents themselves, on a read-write mount) edit one file,
 * and the current content reaches the resident agent AND every ephemeral
 * subagent via the framework's gatherContext hook before each inference.
 * Nothing is persisted to Chronicle — position 'system' injections are
 * per-turn overlays, so edits take effect on the next turn and stale copies
 * never accumulate in history.
 *
 * Fail-open by design: a missing mount, missing file, any read error, or a
 * read that hasn't finished within its budget yields no injection (never a
 * blocked inference). An agent running without its instructions must not be
 * a silent state, so each distinct reason is logged and raised once as an
 * `instructions-unavailable` ops alert, which the TUI, the ops webhook and
 * the status channels show. Once the file loads again,
 * `instructions-unavailable-clear` stands it down, and a later loss alerts
 * afresh, whatever its reason.
 *
 * One read is in flight at a time in each session. A turn that comes while
 * it's pending waits on it rather than starting another, until its budget,
 * counted from the read's start, runs out; a turn after that injects nothing
 * at once. So a read that never finishes (a FIFO at the path, which
 * agent-framework 0.22.1 opens and waits on) leaves agents without their
 * instructions until it finishes, the session is switched or the host
 * restarts, and no further read starts in that session. A stop can't cancel
 * the read, since readFileFromDisk takes no signal: the module lets go of
 * it, and the next session's first turn starts a read of its own.
 *
 * The host keeps one instance across session switches, as it keeps the
 * notices module, so an alert raised in one session is stood down in the
 * next once the file loads there.
 *
 * Requires the workspace module: the configured path is a mount-prefixed
 * workspace path ("<mountName>/<relativePath>"). validateRecipe enforces the
 * pairing. The file is read through WorkspaceModule.readFileFromDisk, which
 * refuses a file that is itself a link unless its mount follows links (a
 * recipe's mounts don't), and reads a file only if its canonical path lies
 * inside the mount, which it checks after opening the file.
 *
 * Reads ask readFileFromDisk for at most maxBytes. At 0.22.1 that holds for
 * a file larger than maxBytes when the read starts, but a file that grows
 * past it during the read is read to its end, so the module cuts what it is
 * given at maxBytes too (gatherContext).
 */

import type {
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '@animalabs/agent-framework';
import type { ContextInjection } from '@animalabs/context-manager';
import { unknownToolResult } from './unknown-tool.js';

/**
 * The slice of WorkspaceModule this module reads through: its disk read,
 * whose refusals are WorkspaceReadErrors (a `code` and a message naming the
 * mount-prefixed path). Structural so tests can stand in for it; production
 * wiring passes the real WorkspaceModule, which satisfies this shape.
 */
export interface WorkspaceDiskReader {
  readFileFromDisk(
    mountPrefixedPath: string,
    options: { maxBytes: number },
  ): Promise<DiskRead>;
}

type DiskRead = { bytes: Buffer; size: number; truncated: boolean };

/** A read of the file under way, which every turn of its session that comes
 *  while it's pending waits on, so a read that never finishes is one read
 *  waiting, not one for each turn. */
interface PendingRead {
  /** What the read gave, or why it gave nothing. */
  outcome: Promise<{ read: DiskRead } | { error: unknown }>;
  /** When its budget runs out, counted from its start, on the monotonic
   *  clock (performance.now), so a step in the wall clock doesn't move it. */
  deadline: number;
}

export interface InstructionsModuleConfig {
  /** Workspace path "<mountName>/<relativePath>". Default "instructions/AGENTS.md". */
  path?: string;
  /** Heading line prepended to the injected block. */
  header?: string;
  /** Truncate content beyond this many bytes (with an explicit marker). Default 32768. */
  maxBytes?: number;
  /** Where the block lands in the compiled context. Default 'system'. */
  position?: 'system' | 'beforeUser' | 'afterUser';
  /** The agent the host runs, whose name the module's ops alerts carry: the
   *  host gives it, as it gives the notices module the same name, which
   *  posts only that agent's alerts. Not a recipe field. */
  agentName: string;
}

export const DEFAULT_INSTRUCTIONS_PATH = 'instructions/AGENTS.md';
export const DEFAULT_INSTRUCTIONS_HEADER =
  '# Shared operating instructions (live document)';
export const DEFAULT_INSTRUCTIONS_MAX_BYTES = 32768;

export class InstructionsModule implements Module {
  readonly name = 'instructions';

  // gatherContext is one file read. A modest explicit budget keeps a wedged
  // filesystem from eating the registry-wide 15s default before inference
  // proceeds without us. The read's own budget is three quarters of it
  // (readBudgetMs), so a read that hangs raises the alert before the
  // registry gives up on the turn with only a line on stderr.
  readonly contextTimeoutMs: number = 2000;

  private readonly path: string;
  private readonly header: string;
  private readonly maxBytes: number;
  private readonly position: 'system' | 'beforeUser' | 'afterUser';
  private readonly agentName: string;

  private workspace: WorkspaceDiskReader | null = null;
  private ctx: ModuleContext | null = null;

  /** Reasons already warned about — fail-open must not spam per turn. */
  private warned = new Set<string>();
  /** Whether an instructions-unavailable alert is up, awaiting its clear. */
  private alerted = false;
  /** The read in flight, if one is. */
  private pending: PendingRead | null = null;
  /** Moved by each stop, so a turn that waited on a read across one, whether
   *  the read settled before the stop or after, sees that its session
   *  ended. */
  private generation = 0;

  constructor(config: InstructionsModuleConfig) {
    this.path = config.path ?? DEFAULT_INSTRUCTIONS_PATH;
    this.header = config.header ?? DEFAULT_INSTRUCTIONS_HEADER;
    this.maxBytes = config.maxBytes ?? DEFAULT_INSTRUCTIONS_MAX_BYTES;
    this.position = config.position ?? 'system';
    this.agentName = config.agentName;
  }

  /** Peer injection (same pattern as setFramework/setIdentity elsewhere). */
  setWorkspace(workspace: WorkspaceDiskReader): void {
    this.workspace = workspace;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }

  async stop(): Promise<void> {
    // The host keeps this module across session switches, and what it reads
    // belongs to the session that's ending: the next session gives its own
    // workspace, whose mounts can be other directories (the `_config` mount
    // sits in each session's store). The module lets go of a read under
    // way, which runs on, since readFileFromDisk takes no signal; what it
    // gives then changes nothing. The reasons warned about go, so the next
    // session's first failing read raises the alert again for the TUI,
    // which drops its alerts at a switch. An alert that's up stays marked,
    // so the next session's first successful read stands it down where it's
    // still shown: the web UI's alert strip and the notices module's episode
    // outlive the switch. Until the next start, a turn that reaches the
    // module injects nothing and changes nothing (gatherContext). One that
    // reaches it after the next start is the new session's in all the module
    // holds, and reads and alerts for that session as its own turns do.
    this.generation++;
    this.pending = null;
    this.workspace = null;
    this.warned.clear();
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    // Passive module — no tools, only gatherContext. The file itself is
    // read/edited through the workspace module's own tools.
    return [];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    // True whether or not the last read worked: the module fails open, so the
    // agent is told how to tell, not that the text is there.
    const heading = this.header.trim();
    return unknownToolResult(
      this,
      call.name,
      `Your instructions are read from the workspace file ${this.path} each turn and put in your context` +
      (heading ? ` under the heading ${JSON.stringify(heading)}` : '') +
      ', so the text there is the current one. If ' +
      (heading ? 'that heading is' : 'they are') +
      " missing from your context, the file couldn't be read, and whoever runs this host can see why in " +
      "its log. workspace--read shows the workspace's stored copy, which on a read-only mount can be older " +
      'than the file. workspace--edit changes the file where its mount allows writing.',
    );
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  /**
   * Same injection for every agent — resident and ephemeral subagents alike
   * share the one living document (that is the point of the module).
   */
  async gatherContext(_agentName: string): Promise<ContextInjection[]> {
    // A module that isn't started, stopped or given the next session's
    // workspace but not yet started, belongs to no running session: a turn
    // that reaches it then injects nothing and changes nothing.
    if (!this.ctx) return [];
    const workspace = this.workspace;
    if (!workspace) {
      this.unavailable('the workspace module isn\'t wired, so no instructions can be read');
      return [];
    }
    const generation = this.generation;
    const pending = this.pending ?? this.startRead(workspace);
    const outcome = await this.within(pending);
    // Its session stopped while this turn waited: the next one reads afresh.
    if (this.generation !== generation) return [];
    // Fail open: a missing file, any read error or a read that hasn't
    // finished never blocks inference.
    if (outcome === 'late') {
      this.unavailable(
        `reading "${this.path}" hasn't finished after ${this.readBudgetMs / 1000} s, and no other read ` +
        'starts until it finishes, the session is switched or the host restarts',
      );
      return [];
    }
    if ('error' in outcome) {
      this.unavailable(this.reasonFor(outcome.error));
      return [];
    }
    const read = outcome.read;
    // A read cut at the cap is of a file over it. agent-framework 0.22.1
    // reads a file that grows after the read's size check whole, so the cap
    // on what's injected is held here too. Once the host's agent-framework floor includes
    // anima-research/agent-framework#409, readFileFromDisk keeps maxBytes
    // itself, and this second condition can go.
    const over = read.truncated || read.bytes.byteLength > this.maxBytes;
    const bytes = over ? read.bytes.subarray(0, this.maxBytes) : read.bytes;
    const size = Math.max(read.size, read.bytes.byteLength);

    let content: string;
    if (over) {
      // Back the cut up to a UTF-8 sequence boundary so a multibyte
      // character split at the cap never decodes to U+FFFD right before
      // the marker. The bytes past the cap aren't kept, so detect a
      // straddle from the kept tail alone: find the last lead byte and
      // drop the sequence iff it declares more bytes than were kept.
      let cut = bytes.length;
      let lead = bytes.length - 1;
      let trailing = 0;
      while (lead >= 0 && (bytes[lead]! & 0xc0) === 0x80) {
        lead--;
        trailing++;
      }
      if (lead >= 0) {
        const b = bytes[lead]!;
        const expected =
          (b & 0x80) === 0 ? 1
          : (b & 0xe0) === 0xc0 ? 2
          : (b & 0xf0) === 0xe0 ? 3
          : (b & 0xf8) === 0xf0 ? 4
          : 1; // invalid lead — leave it; decoding was lossy anyway
        if (expected > trailing + 1) cut = lead;
      }
      content =
        bytes.subarray(0, cut).toString('utf-8') +
        `\n\n[truncated: first ${cut} of ${size} bytes]`;
    } else {
      content = bytes.toString('utf-8');
    }

    // Recovered: stand down an alert that's up, and let a later loss warn
    // again, whatever its reason.
    this.warned.clear();
    if (this.alerted) {
      this.alerted = false;
      this.notifyOps('instructions-unavailable-clear', `"${this.path}" loaded again; agents have their instructions`);
    }
    return [
      {
        namespace: 'instructions',
        position: this.position,
        content: [{ type: 'text', text: `${this.header}\n\n${content}` }],
      },
    ];
  }

  /** How long a read may take: three quarters of the registry's budget for
   *  this module, counted from the read's start. */
  private get readBudgetMs(): number {
    return this.contextTimeoutMs * 0.75;
  }

  /** Start the one read in flight. Once it settles, the next turn reads
   *  afresh, unless a stop has already put another in its place. */
  private startRead(workspace: WorkspaceDiskReader): PendingRead {
    const pending: PendingRead = {
      outcome: workspace.readFileFromDisk(this.path, { maxBytes: this.maxBytes }).then(
        (read) => ({ read }),
        (error: unknown) => ({ error }),
      ),
      deadline: performance.now() + this.readBudgetMs,
    };
    void pending.outcome.then(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }

  /** What the read gave, or 'late' once its deadline has passed: at once for
   *  a turn that comes after it, so a read that hangs costs later turns no
   *  wait. */
  private async within(pending: PendingRead): Promise<{ read: DiskRead } | { error: unknown } | 'late'> {
    const left = pending.deadline - performance.now();
    if (left <= 0) return 'late';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), left);
    });
    try {
      return await Promise.race([pending.outcome, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Why the read gave nothing, with what puts it right where the read's
   *  own message (which names the mount-prefixed path) doesn't say. */
  private reasonFor(error: unknown): string {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'symlink') return `"${this.path}" is a link, which its mount doesn't follow: put the file itself at that path`;
    // On a mount that doesn't follow links, a recipe's default, the read
    // refuses a file that is itself a link before it checks where the file
    // lies, so an escape comes from a linked directory on the path. On one
    // that follows them (`followSymlinks`), the file itself can be the link
    // that leads out. Either way a file put "at that path" would still go
    // through the link, so the remedy is to move it.
    if (code === 'escape') {
      return `"${this.path}" leads outside its mount through a link, the file itself or a directory on its path: ` +
        'move the file into the mount, so that neither it nor a directory on its path is a link that leads out';
    }
    return error instanceof Error ? error.message : String(error);
  }

  /** No instructions this turn: log it and raise one ops alert per distinct
   *  reason until the file loads again or the session ends, under the host's
   *  agent's name, since one loss reaches every agent it runs, subagents
   *  included. */
  private unavailable(reason: string): void {
    if (this.warned.has(reason)) return;
    this.warned.add(reason);
    console.error(`InstructionsModule: no instructions injected: ${reason}`);
    this.alerted = true;
    this.notifyOps('instructions-unavailable', `no instructions injected: ${reason}`);
  }

  /** Through the context object, which the real ModuleContext's notifyOps
   *  reads as `this`; absent on a framework without it. */
  private notifyOps(kind: string, message: string): void {
    this.ctx?.notifyOps?.(kind, this.agentName, message);
  }
}
