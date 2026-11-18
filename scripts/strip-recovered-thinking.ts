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
 * are removed (the importer's exact shape). A message of such blocks alone
 * keeps one short `[earlier thinking left out]` text block in their place, so
 * turns keep their order and roles. Text blocks that mention the tag
 * alongside other text are reported and left alone: they are someone's words,
 * not the importer's (the host leaves the tagged spans in them out of a
 * refusing model's requests). bodyGroup shards are reported and left alone.
 * Edits go through ContextManager.editMessage() (event-sourced; the original
 * stays in history).
 *
 * DRY-RUN BY DEFAULT: prints what it would change. A dry run reads a
 * throwaway copy of the store, so it writes nothing to the store itself
 * (opening a store registers strategy state and takes its lock). Run --apply
 * with the agent STOPPED, on a copy of the store first. Expect a one-time
 * cache re-warm.
 *
 * Only the store's current branch is read and edited. Other branches (see
 * /branches) keep their blocks; the summary says how many there are. Switch
 * to one with /checkout and run the script again to edit it.
 *
 * Run it from a checkout of a host that has src/recovered-thinking.ts (the
 * release that brought the per-model filter, or later); the store it edits can
 * come from an older host.
 *
 * Usage:
 *   bun scripts/strip-recovered-thinking.ts <store-path> [--empty-only] [--apply]
 *
 *   --empty-only  Remove only empty tags (keep non-empty recovered thinking).
 *                 Opus 5, Opus 5.5 and Fable refuse non-empty blocks too.
 *
 * Exit status: 0 when no block the run was asked to remove is left in the
 * store (or, on a dry run, would be left), 2 when some are (mixed blocks or
 * bodyGroup shards: the summary says which), 1 on bad arguments or failure.
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, AutobiographicalStrategy } from '@animalabs/context-manager';
import type { ContentBlock } from '@animalabs/membrane';
import { classifyRecoveredThinking, LEFT_OUT, type RecoveredThinkingVerdict } from '../src/recovered-thinking.js';

export type BlockVerdict = RecoveredThinkingVerdict;

export function classifyBlock(block: ContentBlock, emptyOnly = false): BlockVerdict {
  return classifyRecoveredThinking(block, emptyOnly);
}

/** The content a message should have after stripping, or null if unchanged.
 *  A message of removed blocks alone keeps the placeholder (`placeholder`).
 *  `keptNonEmpty` counts non-empty blocks `--empty-only` keeps. */
export function stripBlocks(
  content: ContentBlock[],
  emptyOnly = false,
): { keep: ContentBlock[]; removed: number; mixed: number; keptNonEmpty: number; placeholder: boolean } | null {
  let mixed = 0;
  let keptNonEmpty = 0;
  const keep = content.filter((b) => {
    const v = classifyBlock(b, emptyOnly);
    if (v === 'mixed') mixed++;
    if (emptyOnly && v === 'keep' && classifyBlock(b) === 'remove') keptNonEmpty++;
    return v !== 'remove';
  });
  const removed = content.length - keep.length;
  if (removed === 0 && mixed === 0 && keptNonEmpty === 0) return null;
  const placeholder = removed > 0 && keep.length === 0;
  if (placeholder) keep.push({ type: 'text', text: LEFT_OUT });
  return { keep, removed, mixed, keptNonEmpty, placeholder };
}

const USAGE = 'Usage: bun scripts/strip-recovered-thinking.ts <store-path> [--empty-only] [--apply]';
const FLAGS = new Set(['--apply', '--empty-only']);

/** The parsed arguments, or an error naming what's wrong. Anything unknown
 *  is refused before the store is opened, so a misspelled flag can't change
 *  what --apply edits. */
export function parseStripArgs(args: string[]): { storePath: string; apply: boolean; emptyOnly: boolean } | { error: string } {
  const unknown = args.filter((a) => a.startsWith('-') && !FLAGS.has(a));
  if (unknown.length > 0) return { error: `unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.join(' ')}` };
  const paths = args.filter((a) => !a.startsWith('-'));
  if (paths.length !== 1) return { error: paths.length === 0 ? 'no store path' : `one store path, not ${paths.length}` };
  return { storePath: paths[0]!, apply: args.includes('--apply'), emptyOnly: args.includes('--empty-only') };
}

async function main(): Promise<void> {
  const parsed = parseStripArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`${parsed.error}\n${USAGE}`);
    process.exit(1);
  }
  const { storePath, apply, emptyOnly } = parsed;
  if (!existsSync(storePath)) {
    console.error(`no store at ${storePath}\n${USAGE}`);
    process.exit(1);
  }

  const strategy = new AutobiographicalStrategy({
    compressionModel: 'repair-only-never-called',
    targetChunkTokens: 1_000_000,
    recentWindowTokens: 0,
    autoTickOnNewMessage: false,
  });
  // A dry run promises no writes: it opens a copy, removed afterwards.
  const scratch = apply ? undefined : mkdtempSync(join(tmpdir(), 'strip-recovered-thinking-'));
  const openPath = scratch ? join(scratch, 'store') : storePath;
  if (scratch) cpSync(storePath, openPath, { recursive: true });
  const manager = await ContextManager.open({
    path: openPath,
    strategy,
    membrane: { complete: async () => ({ content: [{ type: 'text', text: '' }] }) },
  } as never);

  let edited = 0;
  let removedBlocks = 0;
  let placeholders = 0;
  let skippedShards = 0;
  let mixedBlocks = 0;
  let keptNonEmpty = 0;
  for (const m of manager.getAllMessages()) {
    const r = stripBlocks(m.content as ContentBlock[], emptyOnly);
    if (!r) continue;
    keptNonEmpty += r.keptNonEmpty;
    if (r.mixed > 0) {
      mixedBlocks += r.mixed;
      console.warn(`LEAVE msg ${m.id}: ${r.mixed} text block(s) mention <recovered_thinking> with other text`);
    }
    if (r.removed === 0) continue;
    const groupId = (m as { bodyGroupId?: string }).bodyGroupId;
    if (groupId) {
      skippedShards++;
      console.warn(`SKIP shard msg ${m.id} (bodyGroup ${groupId}): ${r.removed} block(s) left in place`);
      continue;
    }
    edited++;
    removedBlocks += r.removed;
    if (r.placeholder) placeholders++;
    if (apply) manager.editMessage(m.id, r.keep);
    else console.log(`would edit msg ${m.id} (${m.participant}): remove ${r.removed}, keep ${r.keep.length}${r.placeholder ? ' (placeholder)' : ''}`);
  }

  console.log(`\n=== strip-recovered-thinking ${apply ? 'APPLIED' : 'DRY-RUN'} ===`);
  console.log(`Store: ${storePath}`);
  console.log(`Messages ${apply ? 'edited' : 'to edit'}: ${edited}, blocks removed: ${removedBlocks}`);
  if (placeholders > 0) console.log(`Messages of thinking alone, given the placeholder "${LEFT_OUT}": ${placeholders}`);
  if (keptNonEmpty > 0) console.log(`Non-empty blocks kept (--empty-only): ${keptNonEmpty}. Opus 5, Opus 5.5 and Fable refuse these too.`);
  const left = skippedShards > 0 || mixedBlocks > 0;
  if (skippedShards > 0) console.log(`bodyGroup shards left alone: ${skippedShards}. These still carry the tag.`);
  if (mixedBlocks > 0) console.log(`Mixed blocks left alone: ${mixedBlocks}. These still carry the tag.`);
  const branches = manager.listBranches();
  const current = manager.currentBranch();
  console.log(`Branch: ${current.name} (only this branch was ${apply ? 'edited' : 'read'})`);
  if (branches.length > 1) {
    console.log(`Other branches not ${apply ? 'edited' : 'read'}: ${branches.length - 1}. Switch to one with /checkout and run again to cover it.`);
  }
  if (!apply && edited > 0) console.log('Dry-run only (on a copy; the store was not written): re-run with --apply to edit.');
  manager.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (left) process.exitCode = 2;
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
  });
}
