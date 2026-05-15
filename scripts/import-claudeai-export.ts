#!/usr/bin/env bun
/**
 * Import a claude.ai data export into conhost sessions.
 *
 * Each conversation in `conversations.json` becomes a new conhost session with
 * an isolated Chronicle store, named after the original conversation. The
 * conversation's messages are appended through context-manager's `MessageStore`
 * so the resulting sessions are indistinguishable from native conhost sessions.
 *
 * Block-level fidelity:
 *   - text         → TextContent
 *   - thinking     → TextContent wrapped in <recovered_thinking>…</recovered_thinking>
 *                    (original thinking + summaries preserved verbatim in metadata)
 *   - tool_use     → ToolUseContent (claude.ai-internal tool names kept as-is;
 *                    inert at replay since no module advertises them)
 *   - tool_result  → ToolResultContent
 *   - attachments  → leading <attachment …>{extracted_content}</attachment> text
 *   - files (no bytes) → trailing [image: name (file_uuid=…, bytes not in export)]
 *
 * Why wrapped <recovered_thinking> text and not native thinking blocks:
 *   The export omits cryptographic signatures (claude.ai never plumbed them).
 *   Probed empirically (scripts/test-historical-thinking.ts): the API rejects
 *   unsigned thinking blocks AND redacted_thinking with fabricated data. Wrapped
 *   text round-trips cleanly and lets the model run with extended thinking ON
 *   for the *new* turns (which is the cognitive mode the conversation was
 *   originally in on claude.ai web).
 *
 * Tree handling:
 *   The export records branches via `parent_message_uuid`. When a fork is
 *   present, the importer picks the canonical path by depth-first descent
 *   choosing, at each branch point, the subtree whose deepest leaf has the
 *   latest `created_at`. Orphan branches are discarded in v1 (the original
 *   conversation is preserved in `conversations.json` regardless).
 *
 * Run:
 *   bun scripts/import-claudeai-export.ts ../claudeai-export
 *
 * Options:
 *   --out <dir>       Conhost data dir (default: ./data)
 *   --agent <name>    Participant name for assistant turns (default: "agent",
 *                     matching conhost's default; must equal the recipe's
 *                     `agent.name` for messages to be recognized as assistant)
 *   --filter <regex>  Only import conversations whose name matches (case-insens.)
 *   --dry-run         Parse and report; don't write
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { SessionManager } from '../src/session-manager.js';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface Opts {
  exportDir: string;
  outDir: string;
  agentName: string;
  filter?: RegExp;
  dryRun: boolean;
  interactive: boolean;
}

function parseArgs(argv: string[]): Opts {
  const args = argv.slice(2);
  if (args.length === 0 || args[0]?.startsWith('-')) {
    console.error(
      'Usage: bun scripts/import-claudeai-export.ts <export-dir> [--out <dir>] [--agent <name>] [--filter <regex>] [--dry-run] [--no-interactive]',
    );
    process.exit(1);
  }
  const exportDir = resolve(args[0]!);
  let outDir = resolve(process.cwd(), 'data');
  let agentName = 'agent';
  let filter: RegExp | undefined;
  let dryRun = false;
  // Interactive by default if stdin is a TTY; --no-interactive forces off.
  let interactive = !!process.stdin.isTTY;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--out') outDir = resolve(args[++i]!);
    else if (a === '--agent') agentName = args[++i]!;
    else if (a === '--filter') filter = new RegExp(args[++i]!, 'i');
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--no-interactive') interactive = false;
    else if (a === '--interactive') interactive = true;
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return { exportDir, outDir, agentName, filter, dryRun, interactive };
}

// ---------------------------------------------------------------------------
// Export schema (subset — only what we read)
// ---------------------------------------------------------------------------

interface ExportTextBlock {
  type: 'text';
  text: string;
  citations?: unknown[];
  start_timestamp?: string;
  stop_timestamp?: string;
}
interface ExportThinkingBlock {
  type: 'thinking';
  thinking: string;
  summaries?: Array<{ summary: string }>;
  cut_off?: boolean;
  start_timestamp?: string;
  stop_timestamp?: string;
}
interface ExportToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  integration_name?: string;
  mcp_server_url?: string;
  display_content?: unknown;
  message?: string;
  is_mcp_app?: boolean;
}
interface ExportToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  name?: string;
  content: string | unknown[];
  structured_content?: unknown;
  display_content?: unknown;
  is_error?: boolean;
  integration_name?: string;
  message?: string;
}
type ExportContentBlock =
  | ExportTextBlock
  | ExportThinkingBlock
  | ExportToolUseBlock
  | ExportToolResultBlock;

interface ExportAttachment {
  file_name: string;
  file_size?: number;
  file_type?: string;
  extracted_content?: string;
}
interface ExportFileRef {
  file_uuid: string;
  file_name: string;
}

interface ExportMessage {
  uuid: string;
  parent_message_uuid: string;
  sender: 'human' | 'assistant';
  text: string;
  content: ExportContentBlock[];
  attachments: ExportAttachment[];
  files: ExportFileRef[];
  created_at: string;
  updated_at: string;
}

interface ExportConversation {
  uuid: string;
  name: string;
  summary?: string;
  created_at: string;
  updated_at: string;
  chat_messages: ExportMessage[];
}

const ROOT_PARENT = '00000000-0000-4000-8000-000000000000';

// ---------------------------------------------------------------------------
// Tree linearization
// ---------------------------------------------------------------------------

/**
 * Pick a canonical path through the message tree. For unbranched conversations
 * this is just topological order. For branched ones, at each fork point we
 * descend into the subtree whose deepest leaf has the latest `created_at`.
 *
 * Single DFS post-order populates a per-node `latestLeafTime` map so the main
 * descent is O(n) — no repeated subtree walks at branch points.
 */
export function linearize(messages: ExportMessage[]): { path: ExportMessage[]; branched: boolean } {
  const byParent = new Map<string, ExportMessage[]>();
  for (const m of messages) {
    const arr = byParent.get(m.parent_message_uuid) ?? [];
    arr.push(m);
    byParent.set(m.parent_message_uuid, arr);
  }

  // Iterative post-order to avoid recursion-depth limits on very long
  // chains, and to memoize each node's deepest-leaf time in one pass.
  const latestLeafTime = new Map<string, string>();
  // Build a flat post-order list by DFS from each root.
  const roots = byParent.get(ROOT_PARENT) ?? [];
  const stack: Array<{ msg: ExportMessage; childIdx: number }> = roots.map((r) => ({ msg: r, childIdx: 0 }));
  const postOrder: ExportMessage[] = [];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const kids = byParent.get(frame.msg.uuid) ?? [];
    if (frame.childIdx < kids.length) {
      const next = kids[frame.childIdx++]!;
      stack.push({ msg: next, childIdx: 0 });
    } else {
      postOrder.push(frame.msg);
      stack.pop();
    }
  }
  for (const node of postOrder) {
    const kids = byParent.get(node.uuid) ?? [];
    let best = node.created_at;
    for (const k of kids) {
      const t = latestLeafTime.get(k.uuid)!;
      if (t > best) best = t;
    }
    latestLeafTime.set(node.uuid, best);
  }

  let branched = false;
  const path: ExportMessage[] = [];
  let cursorParent = ROOT_PARENT;
  while (true) {
    const children = byParent.get(cursorParent) ?? [];
    if (children.length === 0) break;
    if (children.length > 1) branched = true;
    let pick = children[0]!;
    let pickT = latestLeafTime.get(pick.uuid)!;
    for (let i = 1; i < children.length; i++) {
      const t = latestLeafTime.get(children[i]!.uuid)!;
      if (t > pickT) {
        pick = children[i]!;
        pickT = t;
      }
    }
    path.push(pick);
    cursorParent = pick.uuid;
  }

  return { path, branched };
}

// ---------------------------------------------------------------------------
// Block transform
// ---------------------------------------------------------------------------

export function transformContent(msg: ExportMessage): ContentBlock[] {
  const out: ContentBlock[] = [];

  // Prepend attachment texts (user-side)
  for (const att of msg.attachments ?? []) {
    if (att.extracted_content) {
      const header = `<attachment name="${escapeAttr(att.file_name || 'attachment')}"${
        att.file_type ? ` type="${escapeAttr(att.file_type)}"` : ''
      }${att.file_size ? ` size="${att.file_size}"` : ''}>`;
      out.push({
        type: 'text',
        text: `${header}\n${att.extracted_content}\n</attachment>`,
      });
    }
  }

  for (const block of msg.content ?? []) {
    switch (block.type) {
      case 'text':
        if (block.text) out.push({ type: 'text', text: block.text });
        break;

      case 'thinking': {
        // Full thinking text is the load-bearing form: it's what the API
        // sees at replay and what the model reads as its prior reasoning.
        // The sidecar import-source.json captures provenance separately,
        // so we don't duplicate into message metadata.
        out.push({
          type: 'text',
          text: `<recovered_thinking>\n${block.thinking}\n</recovered_thinking>`,
        });
        break;
      }

      case 'tool_use':
        out.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input ?? {},
        });
        break;

      case 'tool_result': {
        // Membrane's ToolResultContent.content is string | ContentBlock[].
        // The export's `content` is usually a string or an array of {type,text}
        // sub-blocks; coerce conservatively to a string when in doubt so the
        // round-trip is safe.
        let content: string | ContentBlock[];
        if (typeof block.content === 'string') {
          content = block.content;
        } else if (Array.isArray(block.content)) {
          // Coerce sub-blocks to text where possible.
          const subTexts: ContentBlock[] = [];
          for (const sub of block.content as Array<Record<string, unknown>>) {
            if (sub.type === 'text' && typeof sub.text === 'string') {
              subTexts.push({ type: 'text', text: sub.text });
            }
          }
          content = subTexts.length > 0 ? subTexts : JSON.stringify(block.content);
        } else {
          content = JSON.stringify(block.content);
        }
        out.push({
          type: 'tool_result',
          toolUseId: block.tool_use_id,
          content,
          ...(block.is_error ? { isError: true } : {}),
        });
        break;
      }

      default: {
        // Unknown block type — claude.ai may add new ones (server_tool_use,
        // citations, etc.) without notice. Don't drop on the floor; emit a
        // grep-able marker so the operator can audit what was lost.
        const unknownType = (block as { type?: unknown }).type;
        out.push({
          type: 'text',
          text: `[unknown_block type=${JSON.stringify(unknownType)}]\n${JSON.stringify(block)}`,
        });
      }
    }
  }

  // Trailing file placeholders (images, etc., bytes not in dump)
  for (const f of msg.files ?? []) {
    out.push({
      type: 'text',
      text: `[image: ${f.file_name} (file_uuid=${f.file_uuid}, bytes not in export)]`,
    });
  }

  return out;
}

function escapeAttr(s: string): string {
  // & must be replaced first so the others' replacements aren't double-escaped.
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importConversation(
  conv: ExportConversation,
  opts: Opts,
  sessionMgr: SessionManager,
): Promise<{ sessionId: string; messageCount: number; branched: boolean } | null> {
  const { path, branched } = linearize(conv.chat_messages);
  if (path.length === 0) return null;

  if (opts.dryRun) {
    return { sessionId: '(dry-run)', messageCount: path.length, branched };
  }

  const meta = sessionMgr.createSession(conv.name || `Imported ${conv.uuid.slice(0, 8)}`);
  const storePath = sessionMgr.getStorePath(meta.id);
  const store = JsStore.openOrCreate({ path: storePath });
  try {
    const cm = await ContextManager.open({ store });
    try {
      for (const msg of path) {
        const content = transformContent(msg);
        if (content.length === 0) continue; // skip degenerate messages
        const participant = msg.sender === 'assistant' ? opts.agentName : 'user';
        cm.addMessage(participant, content, {
          sourceId: msg.uuid,
          exportSource: {
            conversationUuid: conv.uuid,
            originalParent: msg.parent_message_uuid,
            createdAt: msg.created_at,
            updatedAt: msg.updated_at,
            originalSender: msg.sender,
          },
        });
      }
    } finally {
      await cm.close?.();
    }
  } finally {
    store.close?.();
  }

  // Sidecar provenance file (next to the session dir, not inside the store)
  const sidecarPath = join(storePath, '..', `${meta.id}.import-source.json`);
  writeFileSync(
    sidecarPath,
    JSON.stringify(
      {
        conversationUuid: conv.uuid,
        name: conv.name,
        summary: conv.summary ?? null,
        createdAt: conv.created_at,
        updatedAt: conv.updated_at,
        originalMessageCount: conv.chat_messages.length,
        importedMessageCount: path.length,
        branched,
        importedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );

  // Update messageCount on the session entry so /session listings are accurate
  const idx = sessionMgr.load();
  if (idx.sessions[meta.id]) {
    idx.sessions[meta.id]!.messageCount = path.length;
    sessionMgr.save(idx);
  }

  return { sessionId: meta.id, messageCount: path.length, branched };
}

// ---------------------------------------------------------------------------
// Interactive selection UI
// ---------------------------------------------------------------------------

function formatRow(idx: number, selected: boolean, conv: ExportConversation): string {
  const id6 = conv.uuid.replace(/-/g, '').slice(0, 6);
  const date = formatShortDate(conv.updated_at || conv.created_at);
  const msgs = (conv.chat_messages?.length ?? 0).toString().padStart(4);
  const name = (conv.name || '(unnamed)').slice(0, 64);
  const mark = selected ? 'x' : ' ';
  return `  [${mark}] ${idx.toString().padStart(3)}  ${id6}  ${date}  ${msgs}msg  ${name}`;
}

function formatShortDate(iso: string | undefined): string {
  if (!iso) return '         ';
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '         ';
  return `${months[d.getMonth()]} ${d.getDate().toString().padStart(2, ' ')} ${d.getFullYear().toString().slice(2)}`;
}

/** Parse comma-and-range index spec like "1,3-5,7" into a set of 1-based indices. */
function parseToggleSpec(input: string, max: number): Set<number> {
  const out = new Set<number>();
  for (const piece of input.split(/[,\s]+/)) {
    if (!piece) continue;
    const dash = piece.indexOf('-');
    if (dash > 0) {
      const lo = parseInt(piece.slice(0, dash), 10);
      const hi = parseInt(piece.slice(dash + 1), 10);
      if (isNaN(lo) || isNaN(hi)) continue;
      for (let i = Math.max(1, lo); i <= Math.min(max, hi); i++) out.add(i);
    } else {
      const n = parseInt(piece, 10);
      if (!isNaN(n) && n >= 1 && n <= max) out.add(n);
    }
  }
  return out;
}

/**
 * Stdin line reader using readline's 'line' event. Robust to piped input
 * (unlike readline.question / readline/promises.question, which hang on
 * subsequent calls when stdin is a pipe — Bun 1.3 bug).
 */
function createLineReader(): { nextLine: (prompt?: string) => Promise<string | null>; close: () => void } {
  const { createInterface } = require('node:readline');
  const buf: string[] = [];
  let resolveNext: ((s: string | null) => void) | null = null;
  let closed = false;
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line: string) => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(line);
    } else {
      buf.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(null);
    }
  });
  return {
    nextLine(prompt?: string) {
      if (prompt) process.stdout.write(prompt);
      return new Promise<string | null>((resolve) => {
        if (buf.length > 0) resolve(buf.shift()!);
        else if (closed) resolve(null);
        else resolveNext = resolve;
      });
    },
    close() {
      rl.close();
    },
  };
}

async function chooseInteractively(conversations: ExportConversation[]): Promise<ExportConversation[] | null> {
  const reader = createLineReader();
  try {
    // Top-level menu
    while (true) {
      const raw = await reader.nextLine(
        `\n${conversations.length} conversation(s) found. Import [A]ll, [C]hoose, e[X]it? `,
      );
      if (raw === null) return null;
      const ans = raw.trim().toLowerCase();
      if (ans === '' || ans === 'a') return conversations;
      if (ans === 'x' || ans === 'q') return null;
      if (ans === 'c') break;
      console.log('Please enter A, C, or X.');
    }

    // Toggle UI
    const selected = new Array<boolean>(conversations.length).fill(false);
    const render = () => {
      console.log('');
      for (let i = 0; i < conversations.length; i++) {
        console.log(formatRow(i + 1, selected[i]!, conversations[i]!));
      }
      const count = selected.filter((s) => s).length;
      console.log(`\n${count}/${conversations.length} selected.`);
    };
    render();
    console.log(
      'Toggle: number(s)/range (e.g. "1,3-5"), "a" all, "n" none, "i" invert, "l" relist, [enter] commit, "x" abort.',
    );
    while (true) {
      const raw = await reader.nextLine('> ');
      if (raw === null) break; // EOF == commit
      const input = raw.trim();
      if (input === '') break;
      const cmd = input.toLowerCase();
      if (cmd === 'x' || cmd === 'q') return null;
      if (cmd === 'a') {
        selected.fill(true);
        render();
        continue;
      }
      if (cmd === 'n') {
        selected.fill(false);
        render();
        continue;
      }
      if (cmd === 'i') {
        for (let i = 0; i < selected.length; i++) selected[i] = !selected[i];
        render();
        continue;
      }
      if (cmd === 'l') {
        render();
        continue;
      }
      const toToggle = parseToggleSpec(input, conversations.length);
      if (toToggle.size === 0) {
        console.log('  (no valid indices in input)');
        continue;
      }
      for (const i of toToggle) selected[i - 1] = !selected[i - 1];
      // Show what just toggled, not the full list — keeps the scroll usable.
      const summary = [...toToggle]
        .sort((a, b) => a - b)
        .map((i) => `${i}${selected[i - 1] ? '✓' : '·'}`)
        .join(' ');
      const count = selected.filter((s) => s).length;
      console.log(`  toggled: ${summary}  (${count}/${conversations.length} selected)`);
    }

    const chosen = conversations.filter((_, i) => selected[i]);
    if (chosen.length === 0) {
      console.log('Nothing selected — aborting.');
      return null;
    }
    return chosen;
  } finally {
    reader.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const convPath = join(opts.exportDir, 'conversations.json');
  if (!existsSync(convPath)) {
    console.error(`No conversations.json at ${convPath}`);
    process.exit(1);
  }
  const conversations: ExportConversation[] = JSON.parse(readFileSync(convPath, 'utf-8'));

  const afterRegex = opts.filter
    ? conversations.filter((c) => opts.filter!.test(c.name))
    : conversations;

  let filtered: ExportConversation[];
  if (opts.interactive) {
    const chosen = await chooseInteractively(afterRegex);
    if (chosen === null) {
      console.log('Aborted.');
      process.exit(0);
    }
    filtered = chosen;
  } else {
    filtered = afterRegex;
  }

  console.log(
    `\nImporting ${filtered.length}/${conversations.length} conversation(s) into ${opts.outDir}${
      opts.dryRun ? ' (DRY RUN)' : ''
    }\n`,
  );

  const sessionMgr = new SessionManager(opts.outDir);

  // Snapshot pre-import activeSessionId so a bulk import doesn't silently
  // steal the operator's working session. createSession() unconditionally
  // sets activeSessionId; after a 24-convo import we'd land on whichever
  // conversation was last in the file. Restored at the end.
  const preImportActive = sessionMgr.load().activeSessionId || null;

  let succeeded = 0;
  let branchedCount = 0;
  for (const conv of filtered) {
    try {
      const res = await importConversation(conv, opts, sessionMgr);
      if (!res) {
        console.log(`  SKIP  ${conv.name} (no messages)`);
        continue;
      }
      const tag = res.branched ? ' [branched: kept latest-leaf path]' : '';
      console.log(
        `  ${res.sessionId.padEnd(10)} ${String(res.messageCount).padStart(4)} msgs  ${conv.name}${tag}`,
      );
      succeeded++;
      if (res.branched) branchedCount++;
    } catch (err) {
      console.error(`  FAIL  ${conv.name}: ${(err as Error).message}`);
    }
  }

  // Restore the pre-import active session (no-op if there wasn't one — but
  // we still leave activeSessionId as the last-imported id rather than the
  // first, which feels less wrong if the operator had no active session).
  if (preImportActive && !opts.dryRun) {
    try {
      sessionMgr.setActiveSession(preImportActive);
    } catch {
      // Pre-import active session may have been deleted; leave default.
    }
  }

  console.log(
    `\n${succeeded}/${filtered.length} imported${branchedCount > 0 ? `, ${branchedCount} had branches (linearized)` : ''}.`,
  );
  if (!opts.dryRun) {
    console.log(`\nOpen one with:`);
    console.log(`  bun src/index.ts <recipe.json> --session <name-or-id>`);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
