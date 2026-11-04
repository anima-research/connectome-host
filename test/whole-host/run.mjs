#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, sh } from './lib/common.mjs';
import { installCandidate, readPacks } from './lib/install.mjs';
import { EPOCH, EXPECTED_FAILURES, asRun, contentsOf, keptWhole, laneVersion, stackVersions } from './lib/strategies/lane.mjs';
import { hostFacts, runScript } from './lib/strategies/driver.mjs';
import { startStandin, tokensSent } from './lib/strategies/standin.mjs';
import { judge, judgedAgent } from './lib/strategies/judge.mjs';
import { FIXTURE_AGENT } from './lib/strategies/checks.mjs';
import { readExpected, workloadReport } from './lib/strategies/report.mjs';
import { RUNS, runOf } from './lib/strategies/workloads.mjs';
import { configurations } from './lib/strategies/script.mjs';
import { compareVersions, everyRunUpdated, exitCode, refuseUnrecordable, renderRecordLines, versionsText } from './lib/record.mjs';
import { changedRequests, stepSummary, summaryOf, viewOf } from './lib/view.mjs';
import { generatedTexts, transcriptOf } from './lib/strategies/transcript.mjs';
import { ledgerOf, moduleCounts } from './lib/strategies/ledger.mjs';
import { shares } from './lib/shares.mjs';
import { selfCheckOf } from './lib/strategies/compare.mjs';
import { cutError } from './lib/strategies/cut.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const LABEL = '[whole-host]';
const RECORDS = join(HERE, 'records');
const versionsOnly = (versions) => Object.fromEntries(Object.entries(versions).map(([k, v]) => [k, String(v).replace(/ \((?:source|git) [0-9a-f]+\)$| \(sha512-[^)]*\)$/, '')]));


const { opt, flag } = parseArgs(process.argv.slice(2));
const fail = (message) => { console.error(`${LABEL} ${message}`); process.exit(2); };
const stack = JSON.parse(readFileSync(join(HERE, 'stack.json'), 'utf-8'));
const all = configurations();
const everyRun = RUNS;
const listed = String(opt('runs', everyRun.join(','))).split(',').map((s) => s.trim()).filter(Boolean);
const unknown = listed.filter((n) => !everyRun.includes(n));
if (unknown.length) fail(`no run ${unknown.join(', ')}; there are ${everyRun.join(', ')}`);
const shard = /^(\d+)\/(\d+)$/.exec(opt('shard', '1/1'));
if (!shard || +shard[1] < 1 || +shard[1] > +shard[2]) fail(`--shard takes i/n with 1 <= i <= n, not ${opt('shard')}`);
const runOptions = { prefixTurns: stack.prefixTurns ?? {} };
const checkpointKey = (id) => runOf(id, all, {}, runOptions).from;
const share = shares(listed, +shard[2], stack.seconds, checkpointKey)[+shard[1] - 1];
const names = share.ids;
if (!names.length) { console.log(`${LABEL} shard ${shard[0]} holds none of ${listed.join(', ')}`); process.exit(0); }
if (+shard[2] > 1) console.log(`${LABEL} shard ${shard[0]}: ${names.length} of ${listed.length} runs, about ${share.seconds} s by stack.json's seconds`);
const work = opt('workdir') ? resolve(opt('workdir')) : mkdtempSync(join(tmpdir(), 'whole-host-'));
if (opt('workdir') && existsSync(work) && readdirSync(work).length) fail(`--workdir ${work} isn't empty: the release is installed there and every run's store starts there, so give it an empty or new directory`);
mkdirSync(work, { recursive: true });
const out = resolve(opt('out', join(work, 'out')));
mkdirSync(out, { recursive: true });
const lane = laneVersion();
const checkpointsDir = opt('checkpoints') ? resolve(opt('checkpoints')) : null;
const npmCi = (cwd) => sh('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd, timeout: 900_000 });
const named = (versions) => Object.entries(versions).map(([k, v]) => `${k.replace('@animalabs/', '')}@${v}`).join(' ');

function installRelease(dir) {
  const repository = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).repository?.url ?? '').replace(/^git\+/, '');
  if (!repository) fail('package.json names no repository to clone the release from');
  sh('git', ['clone', '--quiet', '--depth', '1', '--branch', stack.release, '--', repository, dir], { timeout: 300_000 });
  npmCi(dir);
  return { hostDir: dir, installDir: dir, versions: stackVersions(dir, { installDir: dir }) };
}

console.log(`${LABEL} lane ${lane.slice(0, 12)} · release ${stack.release} · work ${work}`);
let release;
try { release = installRelease(join(work, 'release')); } catch (e) { fail(`installing ${stack.release} failed: ${e.message}`); }
console.log(`${LABEL} checkpoints from ${named(release.versions)}`);

let packs;
try { packs = readPacks(String(opt('overlay', '')).split(',').map((s) => s.trim()).filter(Boolean).map((p) => resolve(p))); } catch (e) { fail(e.message); }
let candidate;
try { candidate = installCandidate({ root: ROOT, packs, dir: join(work, 'candidate'), leaveOut: [work, out], npmCi }); } catch (e) { fail(`installing the candidate failed: ${e.message}`); }
console.log(`${LABEL} candidate ${named(candidate.versions)}${packs.length ? `, with ${packs.map((p) => p.name).join(', ')} laid over` : ''}`);

const expected = (() => {
  try { return readExpected(EXPECTED_FAILURES, everyRun); } catch (e) { return fail(`the expected failures couldn't be read: ${e.message}`); }
})();
const slug = (id) => id.replaceAll('/', '_');
const readJsonLines = (path) => (existsSync(path) ? readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

async function drive(job, side, { storeDir, epoch, dir, scratch = dir, rawDir = null, hostLogs = { dir, at: relative(out, dir) } }) {
  const facts = hostFacts({ hostDir: side.hostDir, configuration: job.configuration });
  const configuration = asRun(job.configuration, facts);
  rmSync(dir, { recursive: true, force: true });
  if (rawDir) rmSync(rawDir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(storeDir, { recursive: true });
  const standin = await startStandin({ configuration, ...job.standin, ...(rawDir ? { rawDir } : {}) });
  const logPath = join(dir, 'log.jsonl');
  const steps = job.steps();
  let run;
  let records;
  try {
    run = await runScript({ steps, configuration, standin, hostDir: side.hostDir, facts, work: join(scratch, 'work'), storeDir, epoch, logPath, hostLogs });
  } finally {
    records = await standin.close();
  }
  writeFileSync(join(dir, 'records.json'), JSON.stringify(records));
  return { run, records, log: readJsonLines(logPath), steps, configuration };
}

const checkpoints = new Map();
const seconds = { runs: {}, checkpoints: {} };
let checkpointTime = 0;
const since = (t) => Math.round((performance.now() - t) / 100) / 10;
async function checkpointOf(from) {
  if (!checkpoints.has(from)) {
    try { await makeCheckpoint(from); } catch (e) { const c = cutError(e, 2000); checkpoints.set(from, { failed: c.shown, ...(c.full ? { failedFull: c.full } : {}) }); }
  }
  return checkpoints.get(from);
}

async function makeCheckpoint(from) {
  const t = performance.now();
  const job = runOf(from, all, hostFacts({ hostDir: release.hostDir, configuration: all[from.split('/')[0]] }), runOptions);
  const key = createHash('sha256').update(JSON.stringify({ lane, release: release.versions, from, configuration: job.configuration, epoch: EPOCH, steps: job.steps() })).digest('hex').slice(0, 16);
  const kept = checkpointsDir ? join(checkpointsDir, 'workloads', `${slug(from)}-${key}`) : null;
  const texts = (dir) => ({ steps: job.steps(), answers: join(dir, 'answers') });
  if (kept && existsSync(kept) && !keptWhole(kept)) rmSync(kept, { recursive: true, force: true });
  if (kept && keptWhole(kept)) {
    checkpoints.set(from, { ...JSON.parse(readFileSync(join(kept, 'checkpoint.json'), 'utf-8')), storeDir: join(kept, 'store'), ...texts(kept) });
    console.log(`${LABEL} checkpoint ${from}: reused ${kept}`);
  } else {
    const dir = kept ? `${kept}.writing-${process.pid}` : join(work, 'checkpoints', slug(from));
    rmSync(dir, { recursive: true, force: true });
    let d;
    const hostLogs = { dir: join(out, 'checkpoints', slug(from)), at: `checkpoints/${slug(from)}` };
    rmSync(hostLogs.dir, { recursive: true, force: true });
    try { d = await drive(job, release, { storeDir: join(dir, 'store'), epoch: EPOCH, dir, rawDir: join(dir, 'raw'), hostLogs }); } catch (e) { if (kept) rmSync(dir, { recursive: true, force: true }); throw e; }
    mkdirSync(join(dir, 'answers'), { recursive: true });
    for (const f of readdirSync(join(dir, 'raw'))) if (/^r\d+\.answer\.json$/.test(f)) renameSync(join(dir, 'raw', f), join(dir, 'answers', f));
    rmSync(join(dir, 'raw'), { recursive: true, force: true });
    if (!d.run.ok) {
      if (kept) rmSync(dir, { recursive: true, force: true });
      checkpoints.set(from, { failed: d.run.failure?.reason ?? 'no reason given', ...(d.run.failure?.full ? { failedFull: d.run.failure.full } : {}) });
    }
    else if (!kept) checkpoints.set(from, { storeDir: join(dir, 'store'), clockEnd: d.run.clockEnd, ...texts(dir) });
    else {
      writeFileSync(join(dir, 'checkpoint.json'), `${JSON.stringify({ from, key, clockEnd: d.run.clockEnd, contents: contentsOf(dir) })}\n`);
      try { renameSync(dir, kept); } catch (e) {
        rmSync(dir, { recursive: true, force: true });
        if (!keptWhole(kept)) throw new Error(`the checkpoint couldn't be kept at ${kept} (${e.message}), and nothing whole is there`);
      }
      checkpoints.set(from, { ...JSON.parse(readFileSync(join(kept, 'checkpoint.json'), 'utf-8')), storeDir: join(kept, 'store'), ...texts(kept) });
    }
    seconds.checkpoints[from] = since(t);
    checkpointTime += seconds.checkpoints[from];
  }
}

async function driven(id, { recording = true, rawDir = null, dir }) {
  try {
    const job = runOf(id, all, hostFacts({ hostDir: candidate.hostDir, configuration: all[id.split('/')[0]] }), runOptions);
    if (!recording) job.configuration = { ...job.configuration, recording: false };
    let epoch = EPOCH;
    const scratch = join(work, 'runs', basename(dir));
    const storeDir = join(scratch, 'store');
    if (job.from) {
      const cp = await checkpointOf(job.from);
      if (cp.failed) return { couldnt: `its checkpoint ${job.from} failed: ${cp.failed}`, ...(cp.failedFull ? { couldntFull: `its checkpoint ${job.from} failed: ${cp.failedFull}` } : {}) };
      cpSync(cp.storeDir, storeDir, { recursive: true });
      epoch = cp.clockEnd + 24 * 60 * 60_000;
    }
    return { job, d: await drive(job, candidate, { storeDir, epoch, dir, scratch, rawDir }), scratch, storeDir };
  } catch (e) { const c = cutError(e, 2000); return { couldnt: c.shown, ...(c.full ? { couldntFull: c.full } : {}) }; }
}

async function workloadRun(id, { rawDir = null, dir }) {
  const run = await driven(id, { rawDir, dir });
  if (run.couldnt) return { outcome: 'couldnt-run', reason: run.couldnt, ...(run.couldntFull ? { reasonFull: run.couldntFull } : {}) };
  const { job, d, scratch, storeDir } = run;
  const copy = join(scratch, 'judged-store');
  cpSync(storeDir, copy, { recursive: true });
  const sessions = existsSync(join(copy, 'sessions')) ? readdirSync(join(copy, 'sessions')).map((s) => join(copy, 'sessions', s)) : [];
  let judged;
  try {
    judged = await judge({ records: d.records, log: d.log, script: d.steps, storeCopy: sessions[0] ?? null, configuration: d.configuration, installDir: candidate.installDir, run: d.run, declared: job.products });
  } catch (e) { const c = cutError(e, 2000); return { outcome: 'couldnt-run', reason: `the run couldn't be judged: ${c.shown}`, ...(c.full ? { reasonFull: `the run couldn't be judged: ${c.full}` } : {}) }; }
  const breaches = d.run.ok ? job.check({ log: d.log, records: d.records }) : [];
  const report = workloadReport({ id, workload: job.workload, owns: job.owns, judged, breaches, completed: d.run.ok, expected });
  writeFileSync(join(dir, 'report.txt'), `${report.lines.join('\n')}\n`);
  return {
    reported: true,
    outcome: report.verdict === 'pass' ? 'pass' : report.verdict,
    failures: report.flags,
    lines: report.lines,
    judged: report.judged,
    log: d.log,
    records: d.records,
    end: { ok: d.run.ok, reason: d.run.failure?.reason },
    from: job.from ?? 'empty',
    steps: d.steps,
    agent: (() => { try { return judgedAgent(d.configuration, d.log).agent; } catch { return d.configuration.agent?.name ?? FIXTURE_AGENT; } })(),
  };
}

const results = [];
const rows = [];
const views = [];
const reportCouldnt = (dir, id, r) => {
  mkdirSync(dir, { recursive: true });
  (r.reported ? appendFileSync : writeFileSync)(join(dir, 'report.txt'), `${id}: couldn't run: ${r.reason}\n${r.reasonFull ? `  whole: ${r.reasonFull}\n` : ''}`);
};
for (const id of names) {
  const dir = join(out, slug(id));
  const t = performance.now();
  const before = checkpointTime;
  const bodies = join(work, 'runs', slug(id), 'raw');
  let r = null;
  let row;
  let record = null;
  let selfCheck = null;
  let stage = 'it couldn\'t be run';
  try {
    r = await workloadRun(id, { dir, rawDir: bodies });
    seconds.runs[id] = Math.round((since(t) - (checkpointTime - before)) * 10) / 10;
    console.log((r.lines?.length ? r.lines : [`${id}: couldn't run: ${r.reason}`]).join('\n'));
    stage = 'its record couldn\'t be checked';
    if (refuseUnrecordable(r)) console.log(`${LABEL} ${id}: couldn't run: ${r.reason}`);
    let text = null;
    if (r.outcome !== 'couldnt-run') {
      stage = 'its record couldn\'t be written';
      const recordLines = renderRecordLines({ header: { configuration: id, from: r.from }, log: r.log, records: r.records, end: r.end, judged: r.judged });
      text = `${recordLines.map((l) => l.text).join('\n')}\n`;
      writeFileSync(join(dir, `${slug(id)}.record`), text);
      const committed = join(RECORDS, `${slug(id)}.record`);
      record = flag('update-records') ? 'updated' : existsSync(committed) && readFileSync(committed, 'utf-8') === text ? 'same' : existsSync(committed) ? 'differs' : 'missing';
      let changed = null;
      if (record === 'differs' || record === 'missing') {
        stage = 'its view couldn\'t be written';
        changed = changedRequests(record === 'missing' ? '' : readFileSync(committed, 'utf-8'), recordLines);
        const answersIn = (dir) => (existsSync(dir) ? readdirSync(dir) : []).filter((f) => /^r\d+\.answer\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')));
        const cp = r.from === 'empty' ? null : checkpoints.get(r.from);
        const generated = generatedTexts({ steps: [...(cp?.steps ?? []), ...r.steps], answers: [...(cp ? answersIn(cp.answers) : []), ...answersIn(bodies)] });
        const owner = new Map(recordLines.filter((l) => l.request).map((l) => [l.request, l]));
        const view = viewOf({
          run: id, record, changed, lines: recordLines,
          ledger: (request) => {
            const l = owner.get(request);
            if (!l?.compile) return [];
            return [l.round ? 'As context-manager compiled it for the turn:' : 'As context-manager compiled it:', ...ledgerOf(r.log, l.compile)];
          },
          transcript: (request, seen) => transcriptOf(JSON.parse(readFileSync(join(bodies, `${request}.json`), 'utf-8')), generated, seen),
        });
        writeFileSync(join(dir, 'view.md'), view);
        views.push({ run: id, path: `${slug(id)}/view.md`, text: view });
        console.log(`${LABEL} ${id}: the record ${record === 'missing' ? 'isn\'t committed' : 'differs from the committed one'}; the run's is ${slug(id)}/${slug(id)}.record in this job's evidence, and what changed is in ${slug(id)}/view.md`);
      }
      stage = 'its counts couldn\'t be read';
      row = { run: id, outcome: r.outcome, flags: r.failures?.length ?? 0, record, changed, ledgerOf: r.agent, counts: moduleCounts(r.log, r.records, r.agent), tokens: tokensSent(r.records) };
    } else {
      reportCouldnt(dir, id, r);
      row = { run: id, outcome: r.outcome, reason: r.reason, record: 'couldn\'t run' };
    }
    if (flag('self-check') && r.outcome !== 'couldnt-run') {
      stage = 'its self-check couldn\'t run';
      const offDir = join(out, `${slug(id)}.recording-off`);
      const offBodies = join(work, 'runs', `${slug(id)}.recording-off`, 'raw');
      const off = await driven(id, { recording: false, dir: offDir, rawDir: offBodies });
      selfCheck = selfCheckOf({
        on: { ok: r.end?.ok === true, reason: r.end?.reason },
        off: off.couldnt ? { couldnt: off.couldnt } : { ok: off.d.run.ok, reason: off.d.run.failure?.reason, log: off.d.log },
        onBodies: bodies, offBodies,
      });
      row.selfCheck = selfCheck;
      if (selfCheck.outcome === 'differs') {
        mkdirSync(join(dir, 'self-check'), { recursive: true });
        const [on, offFile] = selfCheck.files ?? [];
        if (on) cpSync(join(bodies, on), join(dir, 'self-check', `recording-on-${on}`));
        if (offFile) cpSync(join(offBodies, offFile), join(dir, 'self-check', `recording-off-${offFile}`));
      }
      console.log(`${LABEL} ${id}: self-check: ${selfCheck.outcome === 'same' ? `the stand-in received the same ${selfCheck.requests} requests with the test module's recording off` : selfCheck.outcome === 'couldnt-run' ? `couldn't run: ${selfCheck.reason}` : `request ${selfCheck.at} differs with recording off: ${selfCheck.detail}`}`);
    }
    if (record === 'updated') {
      stage = 'its record couldn\'t be committed';
      mkdirSync(RECORDS, { recursive: true });
      writeFileSync(join(RECORDS, `${slug(id)}.record`), text);
    }
  } catch (e) {
    const c = cutError(e, 2000);
    r = { ...(r ?? {}), outcome: 'couldnt-run', reason: `${stage}: ${c.shown}`, ...(c.full ? { reasonFull: `${stage}: ${c.full}` } : {}) };
    if (seconds.runs[id] === undefined) seconds.runs[id] = Math.round((since(t) - (checkpointTime - before)) * 10) / 10;
    record = null;
    selfCheck = null;
    reportCouldnt(dir, id, r);
    row = { run: id, outcome: r.outcome, reason: r.reason, record: 'couldn\'t run' };
    console.log(`${LABEL} ${id}: couldn't run: ${r.reason}`);
  }
  rows.push(row);
  results.push({ run: id, outcome: r.outcome, reason: r.reason, failures: r.failures, record, ...(selfCheck ? { selfCheck } : {}) });
}
const versionsNow = versionsText({ release: { tag: stack.release, versions: versionsOnly(release.versions) }, candidate: { versions: versionsOnly(candidate.versions) } });
const everyUpdated = everyRunUpdated(everyRun, results);
if (flag('update-records') && !everyUpdated) console.log(`${LABEL} records/versions.txt is left as it was: it names the stack every committed record was made with, and this invocation updated ${results.filter((x) => x.record === 'updated').length} of ${everyRun.length} records`);
const { state: versions, changes: versionMoves } = compareVersions(RECORDS, versionsNow, { update: flag('update-records') && everyUpdated });
const versionNote = versions === 'differs' ? `Versions differ from the committed records/versions.txt: ${versionMoves.join('; ')}.` : versions === 'missing' ? 'No records/versions.txt is committed.' : null;
if (versionNote) console.log(`${LABEL} ${versionNote}`);
const table = summaryOf({ versionNote, rows, flagged: results.filter((x) => x.failures?.length).map((x) => ({ run: x.run, flags: x.failures })), overlay: String(opt('overlay', '')) });
writeFileSync(join(out, 'summary.md'), `${table}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, stepSummary({ table, views }));
writeFileSync(join(out, 'run.json'), JSON.stringify({ lane, release: { tag: stack.release, versions: release.versions }, candidate: { versions: candidate.versions, overlays: packs }, versions, seconds, results }, null, 1));
if (flag('update-seconds')) {
  const merged = { runs: { ...stack.seconds?.runs, ...seconds.runs }, checkpoints: { ...stack.seconds?.checkpoints, ...seconds.checkpoints } };
  const written = join(HERE, `stack.json.${process.pid}`);
  writeFileSync(written, `${JSON.stringify({ ...stack, seconds: merged }, null, 2)}\n`);
  renameSync(written, join(HERE, 'stack.json'));
  console.log(`${LABEL} wrote ${Object.keys(seconds.runs).length} runs' and ${Object.keys(seconds.checkpoints).length} checkpoints' seconds into stack.json`);
}
process.exit(exitCode(results, { versions }));
