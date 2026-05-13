#!/usr/bin/env bun
/**
 * Warmup a conhost session: drive its AutobiographicalStrategy to convergence
 * before the session is opened for real continuation.
 *
 * Bulk-imported sessions (from claude.ai exports, etc.) land in Chronicle with
 * thousands of raw messages and no L1/L2/L3 summaries. At runtime, autobio's
 * uncompressed-fallback would emit everything raw at first compile, blowing
 * the context window. This script pre-computes all summaries so the session
 * is openable.
 *
 * Compression is driven by the same model used at conversation time
 * (Sonnet 4.5 by default) — autobio's prompts are explicitly first-person
 * ("describe it as you would to yourself"), so the summarizer is literally
 * writing the friend's-Claude's own diary. Haiku here would be a different
 * voice wearing the same name.
 *
 * Resumable: autobio persists its compression and merge queues to Chronicle.
 * If interrupted, re-running this script picks up where it left off.
 *
 * Run:
 *   bun scripts/warmup-session.ts <session-name-or-id>
 *
 * Options:
 *   --data-dir <dir>   Conhost data dir (default: ./data)
 *   --model <id>       Compression model (default: claude-sonnet-4-5-20250929)
 *   --max-spend <usd>  Soft cap; halt gracefully if cost exceeds this
 *   --l1-budget <n>    L1 budget tokens (passed to autobio)
 *   --l2-budget <n>    Likewise L2
 *   --l3-budget <n>    Likewise L3
 *   --merge-threshold <n>  L1→L2 / L2→L3 merge threshold (default: 6)
 */

import { resolve } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import { AutobiographicalStrategy } from '@animalabs/agent-framework';
import { Membrane, AnthropicAdapter, type NormalizedResponse } from '@animalabs/membrane';
import { SessionManager } from '../src/session-manager.js';

// ---------------------------------------------------------------------------
// Pricing (approximate, USD per 1M tokens). Used for the --max-spend gate
// and the on-screen running cost.
// ---------------------------------------------------------------------------

const PRICING: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-5-20250929': { input: 3.0, output: 15.0 },
  'claude-opus-4-7': { input: 15.0, output: 75.0 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
};

function priceOf(model: string): { input: number; output: number } {
  return PRICING[model] ?? { input: 3.0, output: 15.0 };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Opts {
  sessionRef: string;
  dataDir: string;
  model: string;
  maxSpend: number | null;
  l1Budget?: number;
  l2Budget?: number;
  l3Budget?: number;
  mergeThreshold?: number;
}

function parseArgs(argv: string[]): Opts {
  const args = argv.slice(2);
  if (args.length === 0 || args[0]?.startsWith('-')) {
    console.error(
      'Usage: bun scripts/warmup-session.ts <session-name-or-id> [--data-dir <dir>] [--model <id>] [--max-spend <usd>] [--l1-budget <n>] [--l2-budget <n>] [--l3-budget <n>] [--merge-threshold <n>]',
    );
    process.exit(1);
  }
  const opts: Opts = {
    sessionRef: args[0]!,
    dataDir: resolve(process.cwd(), 'data'),
    model: 'claude-sonnet-4-5-20250929',
    maxSpend: null,
  };
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--data-dir') opts.dataDir = resolve(args[++i]!);
    else if (a === '--model') opts.model = args[++i]!;
    else if (a === '--max-spend') opts.maxSpend = parseFloat(args[++i]!);
    else if (a === '--l1-budget') opts.l1Budget = parseInt(args[++i]!);
    else if (a === '--l2-budget') opts.l2Budget = parseInt(args[++i]!);
    else if (a === '--l3-budget') opts.l3Budget = parseInt(args[++i]!);
    else if (a === '--merge-threshold') opts.mergeThreshold = parseInt(args[++i]!);
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Monitorable autobio (subclassed only to expose protected queue state)
// ---------------------------------------------------------------------------

class MonitoredAutobiographicalStrategy extends AutobiographicalStrategy {
  getQueueStats() {
    return {
      chunks: this.chunks.length,
      chunksCompressed: this.chunks.filter((c) => c.compressed).length,
      l1Queue: this.compressionQueue.length,
      mergeQueue: this.mergeQueue.length,
      summariesL1: this.summaries.filter((s) => s.level === 1).length,
      summariesL2: this.summaries.filter((s) => s.level === 2).length,
      summariesL3: this.summaries.filter((s) => s.level === 3).length,
      pending: this.pendingCompression !== null,
    };
  }
}

// ---------------------------------------------------------------------------
// Progress renderer
// ---------------------------------------------------------------------------

interface Spend {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

function renderProgress(
  strategy: MonitoredAutobiographicalStrategy,
  startedAt: number,
  initialL1Queue: number,
  spend: Spend,
  isTty: boolean,
): void {
  const s = strategy.getQueueStats();
  const elapsedMs = Date.now() - startedAt;
  const elapsedSec = elapsedMs / 1000;

  // Throughput: L1 chunks processed per second since start
  const l1Done = initialL1Queue - s.l1Queue;
  const l1Pct = initialL1Queue > 0 ? (l1Done / initialL1Queue) * 100 : 100;
  const throughput = l1Done > 0 ? l1Done / elapsedSec : 0;
  const remainingL1 = s.l1Queue;
  const etaSec = throughput > 0 ? remainingL1 / throughput : 0;

  const phase = s.l1Queue > 0 ? 'L1' : s.mergeQueue > 0 ? 'merges' : 'done';
  const line =
    `[${phase}] L1 ${l1Done}/${initialL1Queue} (${l1Pct.toFixed(1)}%) │ ` +
    `merges ${s.mergeQueue} queued │ ` +
    `L1/L2/L3 ${s.summariesL1}/${s.summariesL2}/${s.summariesL3} │ ` +
    `tok ${(spend.inputTokens / 1000).toFixed(0)}k in / ${(spend.outputTokens / 1000).toFixed(0)}k out │ ` +
    `$${spend.cost.toFixed(2)} │ ` +
    `${formatDuration(elapsedSec)} elapsed │ ` +
    `ETA ${formatDuration(etaSec)}`;

  if (isTty) {
    process.stderr.write(`\r\x1b[2K${line}`);
  } else {
    process.stderr.write(`${line}\n`);
  }
}

function formatDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '?';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Set ANTHROPIC_API_KEY');
    process.exit(1);
  }

  const sessionMgr = new SessionManager(opts.dataDir);
  const session = sessionMgr.findSession(opts.sessionRef);
  if (!session) {
    console.error(`No session matching "${opts.sessionRef}" in ${opts.dataDir}`);
    process.exit(1);
  }
  const storePath = sessionMgr.getStorePath(session.id);

  console.error(`Warming up session "${session.name}" (${session.id})`);
  console.error(`Store: ${storePath}`);
  console.error(`Model: ${opts.model}`);
  if (opts.maxSpend !== null) console.error(`Max spend: $${opts.maxSpend.toFixed(2)}`);

  // -- Membrane with token-spend hook --
  const price = priceOf(opts.model);
  const spend: Spend = { inputTokens: 0, outputTokens: 0, cost: 0 };
  const adapter = new AnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY });
  const membrane = new Membrane(adapter, {
    hooks: {
      afterResponse: (response: NormalizedResponse) => {
        const u = response.usage;
        if (u) {
          spend.inputTokens += u.inputTokens ?? 0;
          spend.outputTokens += u.outputTokens ?? 0;
          spend.cost =
            (spend.inputTokens * price.input + spend.outputTokens * price.output) / 1_000_000;
        }
        return response;
      },
    },
  });

  // -- Store + strategy + context manager --
  const store = JsStore.openOrCreate({ path: storePath });
  const strategy = new MonitoredAutobiographicalStrategy({
    compressionModel: opts.model,
    autoTickOnNewMessage: false, // we drive ticks manually
    ...(opts.l1Budget !== undefined && { l1BudgetTokens: opts.l1Budget }),
    ...(opts.l2Budget !== undefined && { l2BudgetTokens: opts.l2Budget }),
    ...(opts.l3Budget !== undefined && { l3BudgetTokens: opts.l3Budget }),
    ...(opts.mergeThreshold !== undefined && { mergeThreshold: opts.mergeThreshold }),
  });

  const cm = await ContextManager.open({
    store,
    strategy,
    membrane,
  });

  // -- Inspect initial state --
  const initialStats = strategy.getQueueStats();
  const totalMessages = cm.getAllMessages().length;
  console.error(
    `\nInitial state: ${totalMessages} messages, ${initialStats.chunks} chunks total ` +
      `(${initialStats.chunksCompressed} already compressed, ${initialStats.l1Queue} pending L1, ` +
      `${initialStats.mergeQueue} merges pending).`,
  );
  if (initialStats.l1Queue === 0 && initialStats.mergeQueue === 0) {
    console.error('Nothing to do — already converged.\n');
    store.close?.();
    return;
  }
  console.error('');

  // -- Drive to convergence --
  const isTty = process.stderr.isTTY ?? false;
  const startedAt = Date.now();
  const initialL1Queue = initialStats.l1Queue;

  // Periodic progress refresh (handles long Sonnet calls so the bar doesn't
  // freeze between ticks).
  const renderTimer = setInterval(
    () => renderProgress(strategy, startedAt, initialL1Queue, spend, isTty),
    isTty ? 1000 : 30_000,
  );

  let aborted = false;
  try {
    while (true) {
      const stats = strategy.getQueueStats();
      if (stats.l1Queue === 0 && stats.mergeQueue === 0) break;
      if (opts.maxSpend !== null && spend.cost >= opts.maxSpend) {
        aborted = true;
        break;
      }
      await cm.tick();
    }
  } finally {
    clearInterval(renderTimer);
    renderProgress(strategy, startedAt, initialL1Queue, spend, isTty);
    if (isTty) process.stderr.write('\n');
  }

  const finalStats = strategy.getQueueStats();
  console.error('');
  if (aborted) {
    console.error(
      `Halted at $${spend.cost.toFixed(2)} (--max-spend $${opts.maxSpend?.toFixed(2)}). ` +
        `Re-run to resume — autobio state persists in Chronicle.`,
    );
  } else if (finalStats.l1Queue === 0 && finalStats.mergeQueue === 0) {
    console.error(
      `Converged. ${finalStats.summariesL1} L1 + ${finalStats.summariesL2} L2 + ${finalStats.summariesL3} L3 summaries. ` +
        `Total: ${spend.inputTokens.toLocaleString()} in / ${spend.outputTokens.toLocaleString()} out, $${spend.cost.toFixed(2)}.`,
    );
  } else {
    console.error(
      `Stopped with work remaining (L1=${finalStats.l1Queue}, merges=${finalStats.mergeQueue}). Re-run to continue.`,
    );
  }

  store.close?.();
}

main().catch((e) => {
  console.error('\n', e);
  process.exit(1);
});
