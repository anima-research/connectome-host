/**
 * readFileFromDisk takes no signal, so a stop can't cancel a read: the
 * module lets go of one under way. It keeps at most maxBytes, for a file
 * that grows while it's read too.
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
  ModuleContextInjection,
} from '@animalabs/agent-framework';
import { unknownToolResult } from './unknown-tool.js';

export interface WorkspaceDiskReader {
  readFileFromDisk(
    mountPrefixedPath: string,
    options: { maxBytes: number },
  ): Promise<DiskRead>;
}

type DiskRead = { bytes: Buffer; size: number; truncated: boolean };

interface PendingRead {
  outcome: Promise<{ read: DiskRead } | { error: unknown }>;
  deadline: number;
}

export interface InstructionsModuleConfig {
  path?: string;
  header?: string;
  maxBytes?: number;
  position?: 'system' | 'beforeUser' | 'afterUser';
  agentName: string;
}

export const DEFAULT_INSTRUCTIONS_PATH = 'instructions/AGENTS.md';
export const DEFAULT_INSTRUCTIONS_HEADER =
  '# Shared operating instructions (live document)';
export const DEFAULT_INSTRUCTIONS_MAX_BYTES = 32768;

export class InstructionsModule implements Module {
  readonly name = 'instructions';

  // agent-framework's registry skips a module whose gatherContext answers
  // after its budget, 15 s unless the module declares one. The read's own
  // budget is three quarters of this one (readBudgetMs), so a read that hangs
  // raises the alert before the registry gives up on the turn.
  readonly contextTimeoutMs: number = 2000;

  private readonly path: string;
  private readonly header: string;
  private readonly maxBytes: number;
  private readonly position: 'system' | 'beforeUser' | 'afterUser';
  private readonly agentName: string;

  private workspace: WorkspaceDiskReader | null = null;
  private ctx: ModuleContext | null = null;

  private warned = new Set<string>();
  private alerted = false;
  private pending: PendingRead | null = null;
  private generation = 0;

  constructor(config: InstructionsModuleConfig) {
    this.path = config.path ?? DEFAULT_INSTRUCTIONS_PATH;
    this.header = config.header ?? DEFAULT_INSTRUCTIONS_HEADER;
    this.maxBytes = config.maxBytes ?? DEFAULT_INSTRUCTIONS_MAX_BYTES;
    this.position = config.position ?? 'system';
    this.agentName = config.agentName;
  }

  setWorkspace(workspace: WorkspaceDiskReader): void {
    this.workspace = workspace;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }

  async stop(): Promise<void> {
    this.generation++;
    this.pending = null;
    this.workspace = null;
    this.warned.clear();
    this.ctx = null;
  }

  getTools(): ToolDefinition[] {
    return [];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const heading = this.header.trim();
    return unknownToolResult(
      this,
      call.name,
      `Your instructions are read from the workspace file ${this.path} each turn and put in your context` +
      (heading ? ` under the heading ${JSON.stringify(heading)}` : '') +
      ', so the text there is the current one. If ' +
      (heading ? 'that heading is' : 'they are') +
      " missing from your context, the file couldn't be read, and whoever runs this host can see why in " +
      "its log. workspace--read shows the workspace's stored copy, which on a read-only mount can be older than the file; " +
      'on a mount running direct it reads the file itself. workspace--edit changes the file where its mount allows writing.',
    );
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  async gatherContext(_agentName: string): Promise<ModuleContextInjection[]> {
    if (!this.ctx) return [];
    const workspace = this.workspace;
    if (!workspace) {
      this.unavailable('the workspace module isn\'t wired, so no instructions can be read');
      return [];
    }
    const generation = this.generation;
    const pending = this.pending ?? this.startRead(workspace);
    const outcome = await this.within(pending);
    if (this.generation !== generation) return [];
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
    const { bytes, size, truncated: over } = outcome.read;

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
          : 1;
        if (expected > trailing + 1) cut = lead;
      }
      content =
        bytes.subarray(0, cut).toString('utf-8') +
        `\n\n[truncated: first ${cut} of ${size} bytes]`;
    } else {
      content = bytes.toString('utf-8');
    }

    this.warned.clear();
    if (this.alerted) {
      this.alerted = false;
      this.notifyOps('instructions-unavailable-clear', `"${this.path}" loaded again; agents have their instructions`);
    }
    const injection: ModuleContextInjection = {
      namespace: 'instructions',
      position: this.position,
      content: [{ type: 'text', text: `${this.header}\n\n${content}` }],
    };
    if (this.position !== 'system') injection.placedEachCompile = true;
    return [injection];
  }

  private get readBudgetMs(): number {
    return this.contextTimeoutMs * 0.75;
  }

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
    // Any other code is given in the read's own words, which name the path or,
    // for a mount that's unavailable, the mount. That includes
    // `parent_symlink`, for a link among the path's directories that leads
    // neither out of the mount nor into a nested mount's directory: its message
    // names the link and, where it leads somewhere, its target, and for a
    // linked directory the mount's followSymlinks setting, so a remedy of the
    // host's own would be wrong for some of them. It includes `other_mount`
    // too, for a path in, or reached through a link into, a nested mount's
    // directory, whose message names that mount and the path to use there.
    return error instanceof Error ? error.message : String(error);
  }

  private unavailable(reason: string): void {
    if (this.warned.has(reason)) return;
    this.warned.add(reason);
    console.error(`InstructionsModule: no instructions injected: ${reason}`);
    this.alerted = true;
    this.notifyOps('instructions-unavailable', `no instructions injected: ${reason}`);
  }

  /** Called on the context object: the real ModuleContext's notifyOps reads
   *  `this`. */
  private notifyOps(kind: string, message: string): void {
    this.ctx?.notifyOps?.(kind, this.agentName, message);
  }
}
