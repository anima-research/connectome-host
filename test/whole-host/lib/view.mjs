const SENT = /^ {2}(compile|round|call|unclassified)\b(?: \[(?!T:)([^\]]+)\])?/;
const HEAD = /, head (H:[0-9a-f]{8})/;
function effectiveHeads(texts) {
  const last = new Map();
  return texts.map((t) => {
    const m = SENT.exec(t);
    if (!m) return null;
    const who = m[1] === 'call' ? 'summariser' : m[1] === 'unclassified' ? 'unclassified' : m[2] ?? '';
    const named = HEAD.exec(t)?.[1];
    if (named) last.set(who, named);
    return last.get(who) ?? null;
  });
}

function lcsSteps(a, b) {
  const width = b.length + 1;
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] = a[i] === b[j] ? common[(i + 1) * width + j + 1] + 1 : Math.max(common[(i + 1) * width + j], common[i * width + j + 1]);
    }
  }
  const steps = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { steps.push(['=', i++, j++]); continue; }
    if (j < b.length && (i === a.length || common[i * width + j + 1] >= common[(i + 1) * width + j])) { steps.push(['+', i, j++]); continue; }
    steps.push(['-', i++, j]);
  }
  return steps;
}

function lineDiff(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let tail = 0;
  while (tail < before.length - start && tail < after.length - start && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const added = [];
  const hunks = [];
  let removed = 0;
  let hunk = null;
  for (const [op, i, j] of lcsSteps(before.slice(start, before.length - tail), after.slice(start, after.length - tail))) {
    if (op === '=') { hunk = null; continue; }
    if (!hunk) { hunk = { before: [], after: [] }; hunks.push(hunk); }
    if (op === '+') { added.push(start + j); hunk.after.push(start + j); } else { removed++; hunk.before.push(start + i); }
  }
  return { added, removed, hunks };
}

export function changedRequests(committed, lines) {
  const before = committed.split('\n');
  if (before.at(-1) === '') before.pop();
  const after = lines.map((l) => l.text);
  const { added, removed } = lineDiff(before, after);
  const sent = (texts) => effectiveHeads(texts).map((head, k) => `${texts[k].replace(HEAD, '')}\u0000${head ?? ''}`);
  const sentBefore = sent(before), sentAfter = sent(after);
  const bySent = lineDiff(sentBefore, sentAfter);
  const requests = [...new Set(bySent.added.map((k) => lines[k].request).filter(Boolean))];
  const formOf = (t) => { const m = SENT.exec(t); return m && /, body [0-9a-f]{8}$/.test(t) ? { kind: `${m[1]} ${m[2] ?? ''}`, form: /^ [-+=]/.test(t.slice(m[0].length)) ? 'delta' : 'whole' } : null; };
  const kindOf = (t) => formOf(t)?.kind ?? null;
  const was = new Map();
  const moved = new Set();
  const gone = bySent.hunks.map((h) => h.before.filter((k) => kindOf(before[k])));
  const came = bySent.hunks.map((h) => h.after.filter((k) => lines[k].request && kindOf(after[k])));
  const take = (c, k) => { if (!was.has(lines[c].request)) was.set(lines[c].request, before[k]); };
  for (const [g, list] of gone.entries()) {
    for (const k of [...list]) {
      for (const [h, cs] of came.entries()) {
        const at = cs.findIndex((c) => sentAfter[c] === sentBefore[k]);
        if (at < 0) continue;
        const [c] = cs.splice(at, 1);
        take(c, k);
        moved.add(lines[c].request);
        list.splice(list.indexOf(k), 1);
        break;
      }
    }
  }
  const shared = (x, y) => {
    const count = new Map();
    for (const t of x.split(' ')) count.set(t, (count.get(t) ?? 0) + 1);
    let n = 0;
    for (const t of y.split(' ')) if (count.get(t) > 0) { n++; count.set(t, count.get(t) - 1); }
    return n;
  };
  const stopped = [];
  for (const [h, list] of gone.entries()) {
    const cs = came[h];
    for (const c of [...cs]) {
      const ofKind = list.filter((k) => kindOf(before[k]) === kindOf(after[c]));
      const sameForm = ofKind.filter((k) => formOf(before[k]).form === formOf(after[c]).form);
      const kin = sameForm.length ? sameForm : ofKind;
      if (!kin.length) continue;
      const best = kin.reduce((a, k) => (shared(before[k], after[c]) > shared(before[a], after[c]) ? k : a));
      take(c, best);
      list.splice(list.indexOf(best), 1);
      cs.splice(cs.indexOf(c), 1);
    }
    stopped.push(...list.map((k) => before[k]));
  }
  return { requests, was, moved, stopped, added: added.length, removed, unattributed: added.filter((k) => !lines[k].request).length };
}

// GitHub fails a step whose summary passes 1 MiB (docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands#step-isolation-and-limits).
export const STEP_SUMMARY_BYTES = 1024 * 1024;
const HEADING_CHARS = 200;

const COLUMNS = [
  ['request compiles', (c) => c.counts?.compiles],
  ['refused', (c) => c.counts?.refused],
  ['compressions', (c) => c.counts?.compressions],
  ['merges', (c) => c.counts?.merges],
  ['quarantines', (c) => c.counts?.quarantines],
  ['ledger of', (c) => c.ledgerOf],
  ['raw', (c) => c.counts?.raw],
  ['summarised', (c) => c.counts?.summarised],
  ['left out', (c) => c.counts?.out],
  ['tokens sent', (c) => (c.tokens ? (c.tokens.input ?? 0) + (c.tokens.cacheRead ?? 0) + (c.tokens.cacheWrite ?? 0) : undefined)],
  ['invariant lines', (c) => c.counts?.invariantLines],
];

export function summaryTable(rows) {
  const cell = (v) => (v === undefined || v === null ? '?' : String(v));
  const record = (r) => (r.record === 'differs' ? `differs: ${r.changed.requests.length} request(s)${r.changed.stopped?.length ? `, ${r.changed.stopped.length} no longer sent` : ''}, +${r.changed.added} -${r.changed.removed} line(s)` : r.record ?? 'none');
  const escaped = (t) => t.replaceAll('|', '\\|');
  const counted = (r) => `${r.flags ?? '?'} flag(s)`;
  const outcome = (r) => {
    const main = r.outcome === undefined ? '?' : r.outcome === 'couldnt-run' ? `couldn't run: ${r.reason ?? 'no reason given'}` : r.outcome === 'flags' ? counted(r) : r.outcome === 'invalid' ? `invalid: ${counted(r)}` : r.outcome;
    const self = !r.selfCheck ? '' : `; self-check ${r.selfCheck.outcome === 'couldnt-run' ? `couldn't run: ${r.selfCheck.reason ?? 'no reason given'}` : r.selfCheck.outcome}`;
    return escaped(`${main}${self}`);
  };
  return [
    `| run | outcome | record | ${COLUMNS.map(([name]) => name).join(' | ')} |`,
    `|---|---|---|${COLUMNS.map(([name]) => (name === 'ledger of' ? '---' : '---:')).join('|')}|`,
    ...rows.map((r) => `| ${r.run} | ${outcome(r)} | ${record(r)} | ${COLUMNS.map(([, of]) => cell(of(r))).join(' | ')} |`),
  ].join('\n');
}

const FLAGS_SHOWN = 20;

export function summaryOf({ versionNote = null, rows, flagged = [] }) {
  const clean = rows.every((r) => r.outcome === 'pass' && ['same', 'updated'].includes(r.record) && (!r.selfCheck || r.selfCheck.outcome === 'same'));
  const parts = [...(versionNote ? [versionNote] : []), summaryTable(rows)];
  if (!clean || versionNote) {
    parts.push("Each run's `report.txt`, record and view are under its directory in this job's evidence, its name with `/` written as `_`. Where the change meant to move a request, `node test/whole-host/run.mjs --update-records` rewrites the records to commit with it. A flag that a known finding explains is an entry in `test/whole-host/expected-failures.json` (`docs/whole-host-records.md`, \"Expected failures\").");
  }
  for (const { run, flags } of flagged) {
    const shown = flags.slice(0, FLAGS_SHOWN).map((f) => `- check ${f.check} at ${f.step}${f.request ? ` (${f.request})` : ''}: ${f.message}`);
    const more = flags.length > FLAGS_SHOWN ? [`- ${flags.length - FLAGS_SHOWN} more in ${run.replaceAll('/', '_')}/report.txt`] : [];
    parts.push([`### ${run}: ${flags.length} flag(s)`, ...shown, ...more].join('\n'));
  }
  return parts.join('\n\n');
}

const CONTEXT_ITEMS = 2;

export function movedIn(was, now) {
  const a = was.trim().split(' ');
  const b = now.trim().split(' ');
  const steps = lcsSteps(a, b);
  const groups = [];
  let group = null;
  steps.forEach(([op, i, j], k) => {
    if (op === '=') { group = null; return; }
    if (!group) { group = { at: k, gone: [], came: [] }; groups.push(group); }
    if (op === '-') group.gone.push(a[i]); else group.came.push(b[j]);
  });
  const cap = (items) => items.join(' ');
  const out = [];
  let shownTo = -1;
  for (const g of groups) {
    const end = g.at + g.gone.length + g.came.length;
    const before = steps.slice(Math.max(shownTo + 1, g.at - CONTEXT_ITEMS), g.at).filter(([op]) => op === '=').map(([, , j]) => b[j]);
    const after = steps.slice(end, end + CONTEXT_ITEMS).filter(([op]) => op === '=').map(([, , j]) => b[j]);
    if (before.length) out.push(`  ${g.at - before.length > shownTo + 1 ? '… ' : ''}${before.join(' ')}`);
    else if (g.at > shownTo + 1) out.push('  …');
    if (g.gone.length) out.push(`- ${cap(g.gone)}`);
    if (g.came.length) out.push(`+ ${cap(g.came)}`);
    if (after.length) out.push(`  ${after.join(' ')}`);
    shownTo = end + after.length - 1;
  }
  if (shownTo < steps.length - 1) out.push('  …');
  return out;
}

export function viewOf({ run, record, changed, lines, transcript, ledger }) {
  const out = [`## ${run}`, ''];
  if (record === 'missing') out.push('No record is committed for this run, so every request is shown.', '');
  else out.push(`${changed.requests.length} request(s) changed and ${changed.stopped?.length ?? 0} no longer sent: ${changed.added} record line(s) added and ${changed.removed} removed${changed.unattributed ? `, ${changed.unattributed} of the added belonging to no request (such as a summary written or removed, a dry compile, an action, a checkpoint or the totals)` : ''}.`, '');
  const lineOf = new Map();
  const short = (t) => (t.length > HEADING_CHARS ? `${t.slice(0, HEADING_CHARS - 1)}…` : t);
  for (const l of lines) if (l.request && !lineOf.has(l.request)) lineOf.set(l.request, short(l.text.trim()));
  const seen = new Set();
  const fullOf = new Map();
  for (const l of lines) if (l.request && !fullOf.has(l.request)) fullOf.set(l.request, l.text);
  for (const id of changed.requests) {
    out.push(`### ${id}: \`${lineOf.get(id) ?? '(no line)'}\``, '');
    const was = changed.was?.get(id);
    if (changed.moved?.has(id)) out.push('Sent at another place in the run, with its record line unchanged.', '');
    else if (was && fullOf.has(id)) out.push('Where its record line moved:', '', '```diff', ...movedIn(was, fullOf.get(id)), '```', '');
    else if (record !== 'missing') out.push('A request the committed record doesn\'t have.', '');
    const owned = ledger(id);
    if (owned?.length) out.push(...owned, '');
    out.push('```text', ...transcript(id, seen), '```', '');
  }
  for (const line of changed.stopped ?? []) {
    out.push(`### no longer sent: \`${short(line.trim())}\``, '', 'The committed record has this request and the run no longer sends it, so there is no body to show; its line is:', '', '```text', line.trim(), '```', '');
  }
  return `${out.join('\n')}\n`;
}

export function stepSummary({ table, views, budget = STEP_SUMMARY_BYTES }) {
  const bytes = (s) => Buffer.byteLength(s, 'utf8');
  const head = `${table}\n\n`;
  const notes = views.map((v) => `The view of ${v.run} (${bytes(v.text)} bytes) didn't fit within this summary's ${budget} bytes: it's ${v.path} in the job's evidence.\n`);
  if (bytes(head) + notes.reduce((n, x) => n + bytes(x), 0) > budget) return `${head}${views.length} views didn't fit within this summary's ${budget} bytes: each is <run>/view.md in the job's evidence.\n`;
  let used = bytes(head);
  const shown = [];
  const skipped = [];
  views.forEach((v, i) => {
    const rest = notes.slice(i + 1).reduce((n, x) => n + bytes(x), 0);
    if (used + bytes(v.text) + rest <= budget) { shown.push(v.text); used += bytes(v.text); } else { skipped.push(notes[i]); used += bytes(notes[i]); }
  });
  return head + shown.join('') + skipped.join('');
}
