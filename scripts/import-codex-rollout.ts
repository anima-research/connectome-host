#!/usr/bin/env bun
/** Import a Codex rollout JSONL as a KV-stable OpenAI Responses session. */

import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { SessionManager } from '../src/session-manager.js';

interface RolloutRecord {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface NativeItem {
  type?: string;
  id?: string;
  role?: string;
  [key: string]: unknown;
}

interface EffectiveItem {
  item: NativeItem;
  timestamp?: string;
  sourceLine: number;
  restoredByCompaction: boolean;
}

function usage(): never {
  console.error('Usage: bun scripts/import-codex-rollout.ts <rollout.jsonl> --out <instance-dir> [--agent <name>]');
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  if (!args[0] || args[0].startsWith('-')) usage();
  const source = resolve(args[0]);
  let outDir = '';
  let agentName = 'Codex';
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--out') outDir = resolve(args[++i] ?? '');
    else if (args[i] === '--agent') agentName = args[++i] ?? usage();
    else usage();
  }
  if (!outDir) usage();
  return { source, outDir, agentName };
}

/** Reconstruct the provider's current input window. A `compacted` record
 * replaces all prior response-item history with its canonical
 * `replacement_history`; later response items append normally. */
export function reconstructEffectiveHistory(records: RolloutRecord[]): EffectiveItem[] {
  let history: EffectiveItem[] = [];
  for (const [index, record] of records.entries()) {
    if (record.type === 'compacted') {
      const replacement = record.payload?.replacement_history;
      if (Array.isArray(replacement)) {
        history = replacement.map(item => ({
          item: item as NativeItem,
          timestamp: record.timestamp,
          sourceLine: index + 1,
          restoredByCompaction: true,
        }));
      }
      continue;
    }
    if (record.type === 'response_item' && record.payload) {
      history.push({
        item: record.payload as NativeItem,
        timestamp: record.timestamp,
        sourceLine: index + 1,
        restoredByCompaction: false,
      });
    }
  }
  return history;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return '';
      const value = part as Record<string, unknown>;
      return typeof value.text === 'string' ? value.text
        : typeof value.refusal === 'string' ? value.refusal
        : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** A human-readable Chronicle projection. `rawItem` is the load-bearing field:
 * the Responses formatter emits it verbatim and ignores the projection. */
export function projectItem(item: NativeItem): ContentBlock[] {
  const carrier = <T extends ContentBlock>(block: T): ContentBlock =>
    ({ ...block, rawItem: item } as ContentBlock);

  switch (item.type) {
    case 'message':
      return [carrier({ type: 'text', text: textFromContent(item.content) })];
    case 'reasoning':
      if (typeof item.encrypted_content === 'string') {
        return [carrier({ type: 'redacted_thinking', data: item.encrypted_content })];
      }
      return [carrier({ type: 'thinking', thinking: textFromContent(item.summary) })];
    case 'compaction':
      return [carrier({
        type: 'redacted_thinking',
        data: typeof item.encrypted_content === 'string' ? item.encrypted_content : '',
      })];
    case 'function_call':
      return [carrier({
        type: 'tool_use',
        id: String(item.call_id ?? item.id ?? ''),
        name: String(item.name ?? ''),
        input: (() => {
          try { return JSON.parse(String(item.arguments ?? '{}')) as Record<string, unknown>; }
          catch { return { _rawArguments: item.arguments }; }
        })(),
      })];
    case 'function_call_output':
      return [carrier({
        type: 'tool_result',
        toolUseId: String(item.call_id ?? ''),
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? null),
      })];
    default:
      // Custom tool calls/outputs and future item types stay opaque. The
      // zero-width projection avoids injecting synthetic text into the model.
      return [carrier({ type: 'text', text: '' })];
  }
}

function participantFor(item: NativeItem, agentName: string): string {
  if (item.type === 'message') return item.role === 'assistant' ? agentName : 'user';
  if (item.type === 'reasoning' || item.type === 'compaction' ||
      item.type === 'function_call' || item.type === 'custom_tool_call') return agentName;
  return 'user';
}

function writeRecipe(instanceDir: string, agentName: string): string {
  const recipeDir = join(instanceDir, 'recipes');
  mkdirSync(recipeDir, { recursive: true });
  const path = join(recipeDir, 'codex-rollout.json');
  const recipe = {
    name: `${agentName} rollout revival`,
    description: 'Stateless OpenAI Responses continuation imported from a Codex rollout.',
    version: '1',
    agent: {
      name: agentName,
      provider: 'openai-responses',
      model: 'gpt-5.6-sol',
      systemPrompt: 'The native imported Responses history contains the authoritative developer and system instructions.',
      maxTokens: 128000,
      maxStreamTokens: 900000,
      contextBudgetTokens: 1000000,
      strategy: { type: 'passthrough' },
      responses: {
        reasoningEffort: 'high',
        reasoningContext: 'all_turns',
        compactThreshold: 850000,
      },
    },
    modules: {
      subagents: false,
      lessons: false,
      retrieval: false,
      wake: false,
    },
  };
  writeFileSync(path, JSON.stringify(recipe, null, 2) + '\n');
  return path;
}

async function main() {
  const opts = parseArgs(process.argv);
  const raw = readFileSync(opts.source, 'utf8');
  const records = raw.trim().split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) as RolloutRecord; }
    catch (error) { throw new Error(`Invalid JSON at ${opts.source}:${index + 1}: ${String(error)}`); }
  });
  const history = reconstructEffectiveHistory(records);
  if (history.length === 0) throw new Error('Rollout contains no effective response items.');

  const dataDir = join(opts.outDir, 'data');
  const sourceDir = join(opts.outDir, 'source');
  mkdirSync(sourceDir, { recursive: true });
  const snapshotPath = join(sourceDir, basename(opts.source));
  writeFileSync(snapshotPath, raw);

  const sessionManager = new SessionManager(dataDir);
  const session = sessionManager.createSession(`Codex ${basename(opts.source).replace(/^rollout-|\.jsonl$/g, '')}`);
  const storePath = sessionManager.getStorePath(session.id);
  const store = JsStore.openOrCreate({ path: storePath });
  try {
    const cm = await ContextManager.open({ store });
    try {
      for (const entry of history) {
        cm.addMessage(
          participantFor(entry.item, opts.agentName),
          projectItem(entry.item),
          {
            sourceId: entry.item.id ?? `rollout-line-${entry.sourceLine}`,
            codexRollout: {
              sourceLine: entry.sourceLine,
              sourceTimestamp: entry.timestamp,
              restoredByCompaction: entry.restoredByCompaction,
              nativeType: entry.item.type,
            },
          },
        );
      }
    } finally {
      await cm.close?.();
    }
  } finally {
    store.close?.();
  }

  const meta = records.find(record => record.type === 'session_meta')?.payload ?? {};
  const turnContexts = records.filter(record => record.type === 'turn_context');
  const latestTurn = turnContexts.at(-1)?.payload ?? {};
  const compacted = records.filter(record => record.type === 'compacted');
  const sidecarPath = join(dirname(storePath), `${session.id}.import-source.json`);
  writeFileSync(sidecarPath, JSON.stringify({
    source: opts.source,
    snapshot: snapshotPath,
    agentName: opts.agentName,
    importedAt: new Date().toISOString(),
    originalRecordCount: records.length,
    importedMessageCount: history.length,
    effectiveItemCount: history.length,
    compactionCount: compacted.length,
    latestWindowId: compacted.at(-1)?.payload?.window_id ?? null,
    model: latestTurn.model ?? 'gpt-5.6-sol',
    sessionMeta: meta,
  }, null, 2) + '\n');

  const index = sessionManager.load();
  index.sessions[session.id]!.messageCount = history.length;
  sessionManager.save(index);
  const recipePath = writeRecipe(opts.outDir, opts.agentName);
  writeFileSync(join(opts.outDir, '.env.example'), [
    `DATA_DIR=${dataDir}`,
    'OPENAI_API_KEY=',
    '',
  ].join('\n'));
  writeFileSync(join(opts.outDir, 'README.md'), [
    '# Codex rollout Connectome instance',
    '',
    `Imported from \`${opts.source}\`.`,
    '',
    'Run from the connectome-host checkout:',
    '',
    '```sh',
    `DATA_DIR=${dataDir} OPENAI_API_KEY=... bun src/index.ts ${recipePath}`,
    '```',
    '',
    'The session uses provider-native Responses items and passthrough context management.',
    'Do not run the Claude warmup importer; it would normalize the native prefix.',
    '',
  ].join('\n'));

  console.log(JSON.stringify({
    instanceDir: opts.outDir,
    dataDir,
    recipePath,
    sessionId: session.id,
    importedItems: history.length,
    compactions: compacted.length,
    snapshotPath,
  }, null, 2));
}

if (import.meta.main) await main();
