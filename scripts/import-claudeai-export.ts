#!/usr/bin/env bun
/**
 * Import a claude.ai data export into conhost sessions.
 *
 * Each conversation in `conversations.json` becomes a new conhost session with
 * an isolated Chronicle store, named after the original conversation.
 *
 * Block-level fidelity:
 *   - text         → TextContent
 *   - thinking     → TextContent wrapped in <recovered_thinking>…</recovered_thinking>
 *                    (the export's thinking summaries are not imported)
 *   - tool_use     → ToolUseContent (claude.ai-internal tool names kept as-is;
 *                    inert at replay since no module advertises them)
 *   - tool_result  → ToolResultContent
 *   - attachments  → leading <attachment …>{extracted_content}</attachment> text
 *   - files (no bytes) → trailing [image: name (file_uuid=…, bytes not in export)]
 *
 * Thinking is imported as wrapped text because the export carries no
 * signatures, and the API refuses unsigned thinking blocks and
 * redacted_thinking with fabricated data.
 *
 * Tree handling:
 *   The export records branches via `parent_message_uuid`. When a fork is
 *   present, the importer picks, at each branch point, the subtree holding the
 *   latest `created_at`. Other branches are not imported.
 *
 * Run:
 *   bun scripts/import-claudeai-export.ts ../claudeai-export
 *
 * Options:
 *   --out <dir>       Conhost data dir (default: ./data)
 *   --agent <name>    Participant name for assistant turns. Default: "Claude",
 *                     what the bundled `claude-export-revive.json` recipe pins
 *                     `agent.name` to. The chosen value is written into the
 *                     per-session import-source sidecar, so warmup and conhost
 *                     can read it back without re-passing the flag.
 *   --filter <regex>  Only import conversations whose name matches (case-insens.)
 *   --dry-run         Parse and report; don't write
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { SessionManager } from '../src/session-manager.js';
import { createLineReader } from './lib/line-reader.js';

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
  let agentName = 'Claude';
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

export function linearize(messages: ExportMessage[]): { path: ExportMessage[]; branched: boolean } {
  const byParent = new Map<string, ExportMessage[]>();
  for (const m of messages) {
    const arr = byParent.get(m.parent_message_uuid) ?? [];
    arr.push(m);
    byParent.set(m.parent_message_uuid, arr);
  }

  const latestLeafTime = new Map<string, string>();
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

/** The API requires every tool_use id and tool_result tool_use_id to be a
 *  non-empty string. */
export function transformContent(msg: ExportMessage): ContentBlock[] {
  const out: ContentBlock[] = [];

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

  const pendingToolUseIds: string[] = [];

  for (const [blockIdx, block] of (msg.content ?? []).entries()) {
    switch (block.type) {
      case 'text':
        if (block.text) out.push({ type: 'text', text: block.text });
        break;

      case 'thinking': {
        out.push({
          type: 'text',
          text: `<recovered_thinking>\n${block.thinking}\n</recovered_thinking>`,
        });
        break;
      }

      case 'tool_use': {
        let id = (block.id as string | null | undefined) ?? '';
        if (!id) {
          id = `toolu_imported_${msg.uuid}_${blockIdx}`;
          pendingToolUseIds.push(id);
        }
        out.push({
          type: 'tool_use',
          id,
          name: block.name,
          input: block.input ?? {},
        });
        break;
      }

      case 'tool_result': {
        let toolUseId = (block.tool_use_id as string | null | undefined) ?? '';
        if (!toolUseId) {
          toolUseId = pendingToolUseIds.shift() ?? `toolu_imported_orphan_${msg.uuid}_${blockIdx}`;
        }
        let content: string | ContentBlock[];
        if (typeof block.content === 'string') {
          content = block.content;
        } else if (Array.isArray(block.content)) {
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
          toolUseId,
          content,
          ...(block.is_error ? { isError: true } : {}),
        });
        break;
      }

      default: {
        const unknownType = (block as { type?: unknown }).type;
        out.push({
          type: 'text',
          text: `[unknown_block type=${JSON.stringify(unknownType)}]\n${JSON.stringify(block)}`,
        });
      }
    }
  }

  for (const f of msg.files ?? []) {
    out.push({
      type: 'text',
      text: `[image: ${f.file_name} (file_uuid=${f.file_uuid}, bytes not in export)]`,
    });
  }

  return out;
}

/** The Anthropic API takes tool_use blocks only in assistant turns and
 *  tool_result blocks only in user turns, each in the message right after its
 *  tool_use. */
export function splitMixedToolMessages(
  blocks: ContentBlock[],
  sourceParticipant: string,
): Array<{ participant: string; content: ContentBlock[] }> {
  if (sourceParticipant === 'user' || blocks.length === 0) {
    return blocks.length === 0 ? [] : [{ participant: sourceParticipant, content: blocks }];
  }
  const out: Array<{ participant: string; content: ContentBlock[] }> = [];
  let preTool: ContentBlock[] = [];
  let pendingResults: ContentBlock[] = [];
  const flushPre = () => {
    if (preTool.length > 0) {
      out.push({ participant: sourceParticipant, content: preTool });
      preTool = [];
    }
  };
  const flushResults = () => {
    if (pendingResults.length > 0) {
      out.push({ participant: 'user', content: pendingResults });
      pendingResults = [];
    }
  };
  for (const block of blocks) {
    if (block.type === 'tool_result') {
      flushPre();
      pendingResults.push(block);
    } else {
      flushResults();
      preTool.push(block);
    }
  }
  flushResults();
  flushPre();
  return out;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
        const blocks = transformContent(msg);
        if (blocks.length === 0) continue;
        const sourceParticipant = msg.sender === 'assistant' ? opts.agentName : 'user';
        const messages = splitMixedToolMessages(blocks, sourceParticipant);
        for (const [idx, m] of messages.entries()) {
          cm.addMessage(m.participant, m.content, {
            sourceId: messages.length > 1 ? `${msg.uuid}#${idx}` : msg.uuid,
            exportSource: {
              conversationUuid: conv.uuid,
              originalParent: msg.parent_message_uuid,
              createdAt: msg.created_at,
              updatedAt: msg.updated_at,
              originalSender: msg.sender,
              ...(messages.length > 1 ? { splitIndex: idx, splitTotal: messages.length } : {}),
            },
          });
        }
      }
    } finally {
      await cm.close?.();
    }
  } finally {
    store.close?.();
  }

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
        agentName: opts.agentName,
        originalMessageCount: conv.chat_messages.length,
        importedMessageCount: path.length,
        branched,
        importedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );

  const idx = sessionMgr.load();
  if (idx.sessions[meta.id]) {
    idx.sessions[meta.id]!.messageCount = path.length;
    sessionMgr.save(idx);
  }

  return { sessionId: meta.id, messageCount: path.length, branched };
}

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

export function parseToggleSpec(input: string, max: number): Set<number> {
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

async function chooseInteractively(conversations: ExportConversation[]): Promise<ExportConversation[] | null> {
  const reader = createLineReader();
  try {
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
      if (raw === null) break;
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

  if (preImportActive && !opts.dryRun) {
    try {
      sessionMgr.setActiveSession(preImportActive);
    } catch {
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
