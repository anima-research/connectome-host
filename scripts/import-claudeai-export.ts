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
}

function parseArgs(argv: string[]): Opts {
  const args = argv.slice(2);
  if (args.length === 0 || args[0]?.startsWith('-')) {
    console.error(
      'Usage: bun scripts/import-claudeai-export.ts <export-dir> [--out <dir>] [--agent <name>] [--filter <regex>] [--dry-run]',
    );
    process.exit(1);
  }
  const exportDir = resolve(args[0]!);
  let outDir = resolve(process.cwd(), 'data');
  let agentName = 'agent';
  let filter: RegExp | undefined;
  let dryRun = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--out') outDir = resolve(args[++i]!);
    else if (a === '--agent') agentName = args[++i]!;
    else if (a === '--filter') filter = new RegExp(args[++i]!, 'i');
    else if (a === '--dry-run') dryRun = true;
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return { exportDir, outDir, agentName, filter, dryRun };
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
 * recurse into the subtree whose deepest leaf has the latest `created_at`.
 */
function linearize(messages: ExportMessage[]): { path: ExportMessage[]; branched: boolean } {
  const byParent = new Map<string, ExportMessage[]>();
  for (const m of messages) {
    const arr = byParent.get(m.parent_message_uuid) ?? [];
    arr.push(m);
    byParent.set(m.parent_message_uuid, arr);
  }

  let branched = false;
  function deepestLeafTime(msg: ExportMessage): string {
    const children = byParent.get(msg.uuid) ?? [];
    if (children.length === 0) return msg.created_at;
    let best = msg.created_at;
    for (const c of children) {
      const t = deepestLeafTime(c);
      if (t > best) best = t;
    }
    return best;
  }

  const path: ExportMessage[] = [];
  let cursorParent = ROOT_PARENT;
  while (true) {
    const children = byParent.get(cursorParent) ?? [];
    if (children.length === 0) break;
    if (children.length > 1) branched = true;
    // Pick the child whose subtree extends latest in time
    let pick = children[0]!;
    let pickT = deepestLeafTime(pick);
    for (let i = 1; i < children.length; i++) {
      const t = deepestLeafTime(children[i]!);
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

function transformContent(
  msg: ExportMessage,
): { content: ContentBlock[]; recoveredThinking: Array<{ thinking: string; summaries?: string[] }> } {
  const out: ContentBlock[] = [];
  const recoveredThinking: Array<{ thinking: string; summaries?: string[] }> = [];

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
        recoveredThinking.push({
          thinking: block.thinking,
          summaries: block.summaries?.map((s) => s.summary),
        });
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
    }
  }

  // Trailing file placeholders (images, etc., bytes not in dump)
  for (const f of msg.files ?? []) {
    out.push({
      type: 'text',
      text: `[image: ${f.file_name} (file_uuid=${f.file_uuid}, bytes not in export)]`,
    });
  }

  return { content: out, recoveredThinking };
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
        const { content, recoveredThinking } = transformContent(msg);
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
          ...(recoveredThinking.length > 0 && {
            recoveredThinking,
          }),
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

async function main() {
  const opts = parseArgs(process.argv);
  const convPath = join(opts.exportDir, 'conversations.json');
  if (!existsSync(convPath)) {
    console.error(`No conversations.json at ${convPath}`);
    process.exit(1);
  }
  const conversations: ExportConversation[] = JSON.parse(readFileSync(convPath, 'utf-8'));

  const filtered = opts.filter
    ? conversations.filter((c) => opts.filter!.test(c.name))
    : conversations;

  console.log(
    `Importing ${filtered.length}/${conversations.length} conversation(s) into ${opts.outDir}${
      opts.dryRun ? ' (DRY RUN)' : ''
    }\n`,
  );

  const sessionMgr = new SessionManager(opts.outDir);
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

  console.log(
    `\n${succeeded}/${filtered.length} imported${branchedCount > 0 ? `, ${branchedCount} had branches (linearized)` : ''}.`,
  );
  if (!opts.dryRun) {
    console.log(`\nOpen one with:`);
    console.log(`  bun src/index.ts <recipe.json> --session <name-or-id>`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
