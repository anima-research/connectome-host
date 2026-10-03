/**
 * @deprecated modules.instructions is deprecated. Not recommended for new recipes: it delivers content
 * through context injection, which is deprecated (agent-framework#171) —
 * injected blocks are per-compile overlays, re-anchored on every compile,
 * that break prompt-cache prefixes across activations. Put stable instructions in agent.systemPrompt.
 *
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
 * Fail-open by design: a missing mount, missing file, or any read error
 * yields no injection (never a blocked inference), with a warning logged
 * once per distinct error rather than every turn.
 *
 * Requires the workspace module: the configured path is a mount-prefixed
 * workspace path ("<mountName>/<relativePath>") resolved through
 * WorkspaceModule.resolveAbsolutePath, so mount scoping and the
 * path-traversal guard apply. validateRecipe enforces the pairing.
 *
 * Symlink policy: resolveAbsolutePath's traversal guard is lexical, and a
 * symlink inside the mount pointing outside it would otherwise smuggle
 * arbitrary host-readable files into the trusted instructions block. Before
 * reading, both the mount root and the resolved file are realpath'd and the
 * file must remain inside the root — the same guard WorkspaceModule applies
 * to its own image reads. (The right long-term home for this is a safe-read
 * API on WorkspaceModule itself; agent-framework is a separately released
 * package, so this module enforces the policy locally until one exists.)
 *
 * Reads are bounded: at most maxBytes is ever loaded (the file is read
 * through a handle, not readFile), so an oversized or growing mounted file
 * cannot balloon memory past the configured cap.
 */

import { promises as fs } from 'node:fs';
import { sep } from 'node:path';
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

/**
 * The slice of WorkspaceModule this module depends on. Structural so tests
 * can substitute a stub resolver; production wiring passes the real
 * WorkspaceModule (which satisfies this shape).
 */
export interface WorkspacePathResolver {
  resolveAbsolutePath(mountPrefixedPath: string): string | null;
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
}

export const DEFAULT_INSTRUCTIONS_PATH = 'instructions/AGENTS.md';
export const DEFAULT_INSTRUCTIONS_HEADER =
  '# Shared operating instructions (live document)';
export const DEFAULT_INSTRUCTIONS_MAX_BYTES = 32768;

export class InstructionsModule implements Module {
  readonly name = 'instructions';

  // gatherContext is a stat + (on change) one file read — well under 2s.
  // A modest explicit budget keeps a wedged filesystem from eating the
  // registry-wide 15s default before inference proceeds without us.
  readonly contextTimeoutMs = 2000;

  private readonly path: string;
  private readonly header: string;
  private readonly maxBytes: number;
  private readonly position: 'system' | 'beforeUser' | 'afterUser';

  private workspace: WorkspacePathResolver | null = null;

  /** Cache keyed by (realpath, mtimeMs, size) — reread only when the file
   *  changes. The realpath in the key covers a symlink retargeted between
   *  turns to a different in-mount file with identical stat numbers. */
  private cached: {
    realFile: string;
    mtimeMs: number;
    size: number;
    injections: ContextInjection[];
  } | null = null;

  /** Error messages already warned about — fail-open must not spam per turn. */
  private warned = new Set<string>();

  constructor(config: InstructionsModuleConfig = {}) {
    this.path = config.path ?? DEFAULT_INSTRUCTIONS_PATH;
    this.header = config.header ?? DEFAULT_INSTRUCTIONS_HEADER;
    this.maxBytes = config.maxBytes ?? DEFAULT_INSTRUCTIONS_MAX_BYTES;
    this.position = config.position ?? 'system';
  }

  /** Peer injection (same pattern as setFramework/setIdentity elsewhere). */
  setWorkspace(workspace: WorkspacePathResolver): void {
    this.workspace = workspace;
  }

  async start(_ctx: ModuleContext): Promise<void> {}

  async stop(): Promise<void> {
    this.cached = null;
    this.warned.clear();
  }

  getTools(): ToolDefinition[] {
    // Passive module — no tools, only gatherContext. The file itself is
    // read/edited through the workspace module's own tools.
    return [];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    return {
      success: false,
      error: `InstructionsModule has no tool "${call.name}"`,
      isError: true,
    };
  }

  async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    return {};
  }

  /**
   * Same injection for every agent — resident and ephemeral subagents alike
   * share the one living document (that is the point of the module).
   */
  async gatherContext(_agentName: string): Promise<ContextInjection[]> {
    if (!this.workspace) {
      this.warnOnce('workspace module not wired — no instructions injected');
      return [];
    }

    const absPath = this.workspace.resolveAbsolutePath(this.path);
    if (!absPath) {
      this.warnOnce(
        `cannot resolve "${this.path}" — unknown mount or path escapes it; no instructions injected`,
      );
      return [];
    }
    // Mount root, via the same resolver (a bare mount name resolves to the
    // root). Needed for the realpath containment check below.
    const mountName = this.path.slice(0, this.path.indexOf('/'));
    const mountRoot = this.workspace.resolveAbsolutePath(mountName);
    if (!mountRoot) {
      this.warnOnce(
        `cannot resolve mount "${mountName}" root; no instructions injected`,
      );
      return [];
    }

    try {
      // Symlink guard: resolveAbsolutePath's containment is lexical only, so
      // realpath both ends and require the real file to still live under the
      // real mount root. Runs before the cache consult — a symlink swapped
      // since last turn must never serve (or seed) cached content.
      const realRoot = await fs.realpath(mountRoot);
      const realFile = await fs.realpath(absPath);
      if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
        this.cached = null;
        this.warnOnce(
          `"${this.path}" resolves outside its mount after following symlinks; no instructions injected`,
        );
        return [];
      }

      // Handle-based read: stat and read against one open descriptor (no
      // stat-then-read race), loading at most maxBytes regardless of file
      // size — readFile would buffer the whole file first.
      const handle = await fs.open(realFile, 'r');
      try {
        const stat = await handle.stat();
        if (
          this.cached &&
          this.cached.realFile === realFile &&
          this.cached.mtimeMs === stat.mtimeMs &&
          this.cached.size === stat.size
        ) {
          return this.cached.injections;
        }

        const readLen = Math.min(stat.size, this.maxBytes);
        const buf = Buffer.alloc(readLen);
        let filled = 0;
        while (filled < readLen) {
          const { bytesRead } = await handle.read(buf, filled, readLen - filled, filled);
          if (bytesRead === 0) break; // file shrank mid-read; keep what we have
          filled += bytesRead;
        }

        let content: string;
        if (stat.size > this.maxBytes) {
          // Back the cut up to a UTF-8 sequence boundary so a multibyte
          // character split at the cap never decodes to U+FFFD right before
          // the marker. The bytes past the cap were never read, so detect a
          // straddle from the kept tail alone: find the last lead byte and
          // drop the sequence iff it declares more bytes than were kept.
          let cut = filled;
          let lead = filled - 1;
          let trailing = 0;
          while (lead >= 0 && (buf[lead]! & 0xc0) === 0x80) {
            lead--;
            trailing++;
          }
          if (lead >= 0) {
            const b = buf[lead]!;
            const expected =
              (b & 0x80) === 0 ? 1
              : (b & 0xe0) === 0xc0 ? 2
              : (b & 0xf0) === 0xe0 ? 3
              : (b & 0xf8) === 0xf0 ? 4
              : 1; // invalid lead — leave it; decoding was lossy anyway
            if (expected > trailing + 1) cut = lead;
          }
          content =
            buf.subarray(0, cut).toString('utf-8') +
            `\n\n[truncated: first ${cut} of ${stat.size} bytes]`;
        } else {
          content = buf.subarray(0, filled).toString('utf-8');
        }

        const injections: ContextInjection[] = [
          {
            namespace: 'instructions',
            position: this.position,
            content: [{ type: 'text', text: `${this.header}\n\n${content}` }],
          },
        ];
        this.cached = { realFile, mtimeMs: stat.mtimeMs, size: stat.size, injections };
        // Recovered — let a future recurrence of a previous error warn again.
        this.warned.clear();
        return injections;
      } finally {
        await handle.close();
      }
    } catch (error) {
      // Fail open: missing file or any read error never blocks inference.
      this.cached = null;
      this.warnOnce(error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    console.error(`InstructionsModule: ${message}`);
  }
}
