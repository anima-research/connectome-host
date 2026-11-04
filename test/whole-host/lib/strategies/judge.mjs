import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { readStore } from './read-store.mjs';
import { runChecks } from './report.mjs';
import { FIXTURE_AGENT, STREAM_BOUND } from './checks.mjs';
import { products } from './script.mjs';
import { cutMessage } from './cut.mjs';

const agentOf = (configuration) => configuration.agent?.name ?? FIXTURE_AGENT;

export function judgedAgent(configuration, log = []) {
  const own = agentOf(configuration);
  if (configuration.judges !== 'subagent') return { agent: own, namespace: `agents/${own}`, isolate: false };
  const name = log.flatMap((e) => (e.kind === 'compiles' ? e.lines ?? [] : [])).find((l) => l.kind === 'request' && l.agent && l.agent !== own)?.agent;
  if (!name) throw new Error(`no compile line names a subagent of ${own} to judge, though the configuration judges its subagent`);
  return { agent: name, namespace: `subagent/${name}`, isolate: true };
}

export const streamBoundFor = (configuration, launched = null) => launched ?? configuration.streamBound ?? configuration.agent?.maxStreamTokens ?? STREAM_BOUND;

export function launchStreamBound(log, agent) {
  const blobs = Object.assign({}, ...log.filter((e) => e.kind === 'compiles').map((e) => e.blobs ?? {}));
  for (const e of log) {
    if (e.kind !== 'compiles') continue;
    for (const l of e.lines ?? []) {
      if (l.agent !== agent) continue;
      for (const m of l.messages ?? []) {
        const hit = /- Stream budget: ([\d,]+) tokens/.exec(JSON.stringify(blobs[m.content] ?? ''));
        if (hit) return Number(hit[1].replace(/,/g, ''));
      }
    }
  }
  return null;
}

function auditTopology({ installDir, storePath, namespace }) {
  const script = join(installDir, 'node_modules', '@animalabs', 'context-manager', 'dist', 'scripts', 'audit-topology.js');
  const copy = mkdtempSync(join(tmpdir(), 'judge-audit-'));
  try {
    cpSync(storePath, copy, { recursive: true });
    const run = spawnSync(process.execPath, [script, copy, '--namespace', namespace], { encoding: 'utf-8', timeout: 120_000 });
    return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}${run.error ? String(run.error) : ''}` };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

export async function judge({ records, log, script, storeCopy, configuration, installDir, run, readers = {}, declared = products(configuration) }) {
  const read = readers.readStore ?? readStore;
  const audit = readers.audit ?? auditTopology;
  const flags = [];
  if (!run?.ok) flags.push({ check: 1, step: 'the run', message: `the run failed: ${run?.failure?.reason ?? run?.failure ?? 'no reason given'}`, ...(run?.failure?.full ? { full: `the run failed: ${run.failure.full}` } : {}) });
  let store = null;
  let target;
  try {
    target = judgedAgent(configuration, log);
  } catch (e) {
    if (run?.ok) throw e;
    const own = agentOf(configuration);
    target = { agent: own, namespace: `agents/${own}`, isolate: false };
  }
  const launched = target.isolate ? launchStreamBound(log, target.agent) : null;
  if (target.isolate && launched === null) flags.push({ check: 3, step: 'the run', what: 'no-launch-budget', message: `couldn't judge ${target.agent}'s continuation rounds: no compile sent it a launch notice stating its stream budget` });
  if (run?.ok && configuration.summarises !== false && storeCopy) {
    const { namespace, isolate } = target;
    store = await read({ installDir, storePath: storeCopy, namespace, isolate }).catch((e) => {
      if (!/^no summaries in /.test(String(e?.message))) throw e;
      flags.push({ check: 5, step: 'the run', what: 'no-summaries', message: `the store kept no summaries in ${namespace}, though the configuration compresses` });
      return null;
    });
    // context-manager's audit-topology CLI can't open an isolated message slot, so a subagent's violations are its read's.
    const audited = isolate
      ? { status: store?.violations?.length ? 2 : 0, output: (store?.violations ?? []).join('\n') }
      : audit({ installDir, storePath: storeCopy, namespace });
    if (audited.status === 2) flags.push({ check: 5, step: 'the run', ...cutMessage((cut) => `audit-topology found violations: ${cut(audited.output.trim(), 600)}`) });
    else if (audited.status !== 0) throw new Error(`audit-topology couldn't run (exit ${audited.status}): ${audited.output.trim()}`);
  } else if (configuration.summarises !== false && run?.ok) {
    throw new Error('the run succeeded but left no store copy to judge');
  }
  const checked = runChecks({ records, log, script, products: declared, store, agent: target.agent, streamBound: streamBoundFor(configuration, launched), windowTokens: configuration.windowTokens, binds: configuration.binds === true, adaptive: (configuration.agent?.strategy?.type ?? 'autobiographical') !== 'passthrough' && configuration.agent?.strategy?.adaptiveResolution !== false });
  return { flags: [...flags, ...checked.flags], missing: checked.missing, headroom: checked.headroom, notes: checked.notes, judged: checked.judged };
}
