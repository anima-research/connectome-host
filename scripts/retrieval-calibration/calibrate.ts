/**
 * Calibrate RetrievalModule's relevanceThreshold on a labelled set.
 *
 *   bun scripts/retrieval-calibration/calibrate.ts [dataset.json] [--max-candidates N]
 *
 * Runs the real pipeline (local models) over every turn with the threshold at
 * 0, so each candidate's rerank score is recorded, then reports:
 *   - candidate recall: labelled-relevant lessons that reached the reranker
 *   - precision / recall / F1 over (turn, lesson) pairs at each threshold
 *   - false-alarm rate: share of no-relevant-lesson turns that would inject anything
 *   - per-turn latency
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { RetrievalModule, type RecentMessage } from '../../src/modules/retrieval-module.js';
import { LlamaRetrievalModels } from '../../src/modules/retrieval-models.js';
import type { Lesson } from '../../src/modules/lessons-module.js';

interface Dataset {
  agentName: string;
  lessons: Array<{ id: string; content: string; tags: string[] }>;
  turns: Array<{ id: string; relevant: string[]; messages: RecentMessage[] }>;
}

const args = process.argv.slice(2);
const flag = args.indexOf('--max-candidates');
const maxCandidates = flag >= 0 ? Number(args[flag + 1]) : undefined;
const path = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--max-candidates')
  ?? join(dirname(import.meta.path), 'dataset.json');
const data: Dataset = JSON.parse(readFileSync(path, 'utf-8'));

const lessons: Lesson[] = data.lessons.map(l => ({
  ...l, confidence: 0.8, evidence: [], created: Date.now(), updated: Date.now(), deprecated: false,
}));
const known = new Set(lessons.map(l => l.id));
for (const turn of data.turns) {
  for (const id of turn.relevant) if (!known.has(id)) throw new Error(`${turn.id}: unknown lesson ${id}`);
}

const models = new LlamaRetrievalModels();
let t = performance.now();
await models.prepare();
console.log(`models ready in ${((performance.now() - t) / 1000).toFixed(1)} s`);

interface Scored { turn: string; gold: Set<string>; scores: Map<string, number>; ms: number }
let current: RecentMessage[] = [{ participant: 'user', text: 'warm-up' }];
const mod = new RetrievalModule({ models, relevanceThreshold: 0, maxInjectedLessons: 1000, maxCandidates });
(mod as unknown as { ctx: unknown }).ctx = {
  getModule: () => ({ getLessons: () => lessons, recordRetrieval: () => {} }),
  queryMessages: () => ({
    messages: current.map(m => ({ participant: m.participant, content: [{ type: 'text', text: m.text }] })),
    totalCount: current.length,
  }),
};
t = performance.now();
await mod.gatherContext(data.agentName); // embeds the library once
console.log(`library of ${lessons.length} embedded + warm-up turn in ${(performance.now() - t).toFixed(0)} ms`);

const results: Scored[] = [];
for (const turn of data.turns) {
  current = turn.messages;
  t = performance.now();
  await mod.gatherContext(data.agentName);
  const ms = performance.now() - t;
  const [trace] = mod.getRetrievalTraces();
  if (trace.outcome === 'error') throw new Error(`${turn.id}: ${trace.error}`);
  if (trace.outcome === 'cache-hit') throw new Error(`${turn.id}: duplicate conversation in dataset`);
  results.push({
    turn: turn.id,
    gold: new Set(turn.relevant),
    scores: new Map(trace.candidates.map(c => [c.id, c.rerankScore])),
    ms,
  });
}
await models.dispose();

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const goldTotal = results.reduce((n, r) => n + r.gold.size, 0);
const reached = results.reduce((n, r) => n + [...r.gold].filter(id => r.scores.has(id)).length, 0);
console.log(`\nturns: ${results.length} (${results.filter(r => r.gold.size === 0).length} with nothing relevant), lessons: ${lessons.length}`);
console.log(`candidate recall: ${reached}/${goldTotal} labelled-relevant lessons reached the reranker`);
for (const r of results) {
  const missed = [...r.gold].filter(id => !r.scores.has(id));
  if (missed.length) console.log(`  ${r.turn}: missed ${missed.join(', ')}`);
}

console.log('\nthreshold  precision  recall   F1     false-alarm-turns');
let best = { f1: -1, threshold: 0 };
for (let i = 1; i < 20; i++) {
  const threshold = i / 20;
  let tp = 0, fp = 0;
  let alarms = 0;
  for (const r of results) {
    const predicted = [...r.scores].filter(([, s]) => s >= threshold).map(([id]) => id);
    tp += predicted.filter(id => r.gold.has(id)).length;
    fp += predicted.filter(id => !r.gold.has(id)).length;
    if (r.gold.size === 0 && predicted.length > 0) alarms++;
  }
  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp / goldTotal;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  if (f1 > best.f1) best = { f1, threshold };
  const negatives = results.filter(r => r.gold.size === 0).length;
  console.log(`${threshold.toFixed(2).padStart(9)}  ${precision.toFixed(3).padStart(9)}  ${recall.toFixed(3).padStart(6)}  ${f1.toFixed(3)}  ${alarms}/${negatives}`);
}
console.log(`\nbest F1 ${best.f1.toFixed(3)} at threshold ${best.threshold.toFixed(2)}`);

console.log('\nper-turn scores of labelled-relevant lessons, and the best-scoring wrong lesson:');
for (const r of results) {
  const gold = [...r.gold].map(id => `${id}=${(r.scores.get(id) ?? NaN).toFixed(2)}`).join(' ');
  const [wrongId, wrong] = [...r.scores].filter(([id]) => !r.gold.has(id)).sort((a, b) => b[1] - a[1])[0] ?? ['-', NaN];
  console.log(`  ${r.turn}  ${gold || '(none)'}  | top wrong: ${wrongId}=${wrong.toFixed(2)}`);
}

const ms = results.map(r => r.ms).sort((a, b) => a - b);
console.log(`\nlatency per turn (warm document cache): median ${ms[Math.floor(ms.length / 2)].toFixed(0)} ms, max ${ms.at(-1)!.toFixed(0)} ms`);
