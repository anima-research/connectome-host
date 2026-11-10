#!/usr/bin/env bun
/**
 * Remove <recovered_thinking> text blocks from a session store.
 *
 * Older versions of scripts/import-claudeai-export.ts wrote each historical
 * `thinking` block as a text block `<recovered_thinking>\n…\n</recovered_thinking>`
 * inside the assistant turn, empty ones included. Since 2026-11-09 some models
 * (Opus 5, Opus 5.5, Fable) refuse any request carrying one (stop_reason
 * "refusal", category "reasoning_extraction", 0 output tokens), so an imported
 * agent on those models stops answering. The host now leaves the blocks out of
 * those models' requests on its own (src/recovered-thinking.ts); this script
 * is for hosts older than that, or to take the blocks out of the store for
 * good. It removes those blocks; nothing else is touched.
 *
 * Only whole text blocks that consist of one <recovered_thinking>…</recovered_thinking>
 * are removed (the importer's exact shape). Text blocks that mention the tag
 * alongside other text are reported and left alone. A message that would be
 * left with no content is skipped, as are bodyGroup shards. Edits go through
 * ContextManager.editMessage() (event-sourced; the original stays in history).
 *
 * DRY-RUN BY DEFAULT: prints what it would change. Run with the agent STOPPED,
 * on a copy of the store first. Expect a one-time cache re-warm.
 *
 * Usage:
 *   bun scripts/strip-recovered-thinking.ts <store-path> [--empty-only] [--apply]
 *
 *   --empty-only  Remove only empty tags (keep non-empty recovered thinking).
 *                 Opus 5, Opus 5.5 and Fable refuse non-empty blocks too.
 */

import { existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { classifyRecoveredThinking, type RecoveredThinkingVerdict } from '../src/recovered-thinking.js';

export type BlockVerdict = RecoveredThinkingVerdict;

export function classifyBlock(block: ContentBlock, emptyOnly = false): BlockVerdict {
  return classifyRecoveredThinking(block, emptyOnly);
}

/** The content a message should have after stripping, or null if unchanged. */
export function stripBlocks(
  content: ContentBlock[],
  emptyOnly = false,
): { keep: ContentBlock[]; removed: number; mixed: number } | null {
  let mixed = 0;
  const keep = content.filter((b) => {
    const v = classifyBlock(b, emptyOnly);
    if (v === 'mixed') mixed++;
    return v !== 'remove';
  });
  const removed = content.length - keep.length;
  if (removed === 0 && mixed === 0) return null;
  return { keep, removed, mixed };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const storePath = args.find((a) => !a.startsWith('--'));
  const apply = args.includes('--apply');
  const emptyOnly = args.includes('--empty-only');
  if (!storePath || !existsSync(storePath)) {
    console.error('Usage: bun scripts/strip-recovered-thinking.ts <store-path> [--empty-only] [--apply]');
    process.exit(1);
  }

  const strategy = new AutobiographicalStrategy({
    compressionModel: 'repair-only-never-called',
    targetChunkTokens: 1_000_000,
    recentWindowTokens: 0,
    autoTickOnNewMessage: false,
  });
  const manager = await ContextManager.open({
    path: storePath,
    strategy,
    membrane: { complete: async () => ({ content: [{ type: 'text', text: '' }] }) },
  } as never);

  let edited = 0;
  let removedBlocks = 0;
  let skipped = 0;
  let mixedBlocks = 0;
  for (const m of manager.getAllMessages()) {
    const r = stripBlocks(m.content as ContentBlock[], emptyOnly);
    if (!r) continue;
    if (r.mixed > 0) {
      mixedBlocks += r.mixed;
      console.warn(`LEAVE msg ${m.id}: ${r.mixed} text block(s) mention <recovered_thinking> with other text`);
    }
    if (r.removed === 0) continue;
    if (r.keep.length === 0) {
      skipped++;
      console.warn(`SKIP msg ${m.id}: would be left empty`);
      continue;
    }
    const groupId = (m as { bodyGroupId?: string }).bodyGroupId;
    if (groupId) {
      skipped++;
      console.warn(`SKIP shard msg ${m.id} (bodyGroup ${groupId})`);
      continue;
    }
    edited++;
    removedBlocks += r.removed;
    if (apply) manager.editMessage(m.id, r.keep);
    else console.log(`would edit msg ${m.id} (${m.participant}): remove ${r.removed}, keep ${r.keep.length}`);
  }

  console.log(`\n=== strip-recovered-thinking ${apply ? 'APPLIED' : 'DRY-RUN'} ===`);
  console.log(`Store: ${storePath}`);
  console.log(`Messages ${apply ? 'edited' : 'to edit'}: ${edited}, blocks removed: ${removedBlocks}`);
  if (skipped > 0) console.log(`Skipped (would be empty, or bodyGroup shard): ${skipped}. These still carry the tag.`);
  if (mixedBlocks > 0) console.log(`Mixed blocks left alone: ${mixedBlocks}`);
  if (!apply && edited > 0) console.log('Dry-run only: re-run with --apply to edit.');
  manager.close();
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}
