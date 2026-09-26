/** Dependency-free operator viewer for the authenticated retrieval trace endpoint. */
export const RETRIEVAL_TRACE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Retrieval traces</title>
<style>
  :root { color-scheme: dark; font: 15px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  body { max-width: 1240px; margin: 2rem auto; padding: 0 1rem 4rem; background: #0c0e14; color: #d8deea; }
  header { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; margin-bottom: 1rem; }
  h1 { font-size: 1.45rem; line-height: 1.2; margin: 0 auto 0 0; }
  h2 { font-size: 1rem; margin: 0; }
  button, label { font: inherit; }
  button { cursor: pointer; padding: .42rem .78rem; background: #1c2434; color: inherit; border: 1px solid #3a4863; border-radius: .45rem; }
  button:hover { background: #263249; }
  code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .note { color: #9ca9bd; margin: .5rem 0 1.25rem; }
  .error { color: #ff9b9b; }
  .trace { border: 1px solid #283247; border-radius: .65rem; margin: .8rem 0; background: #111722; overflow: hidden; }
  .trace > summary { cursor: pointer; padding: .8rem .95rem; color: #e7bf76; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .trace[open] > summary { border-bottom: 1px solid #283247; }
  .trace-body { padding: 1rem; display: grid; gap: 1.15rem; }
  .trace-meta { display: flex; flex-wrap: wrap; gap: .45rem .75rem; color: #aebbd0; }
  .section { display: grid; gap: .65rem; }
  .section-heading { display: flex; align-items: baseline; gap: .55rem; }
  .count { color: #8fa0b9; font-size: .88rem; }
  .lesson-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 330px), 1fr)); gap: .65rem; }
  .lesson-card { border: 1px solid #33415b; border-radius: .55rem; background: #151d2a; padding: .8rem; min-width: 0; }
  .lesson-card.selected { border-color: #4f8e78; background: #14231f; box-shadow: inset 3px 0 #63b392; }
  .lesson-head { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin-bottom: .55rem; }
  .lesson-id { color: #e7bf76; font-weight: 700; }
  .confidence { color: #aebbd0; margin-left: auto; }
  .lesson-content { margin: .45rem 0 .7rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  .chips { display: flex; flex-wrap: wrap; gap: .3rem; }
  .chip, .badge { display: inline-block; border: 1px solid #3a4863; border-radius: 999px; padding: .12rem .45rem; color: #b9c7dc; background: #111722; font-size: .78rem; }
  .badge.selected { color: #a9e6cd; border-color: #4f8e78; background: #183027; font-weight: 700; }
  .candidate-list { display: grid; gap: .5rem; }
  .candidate { border: 1px solid #2f3b52; border-radius: .5rem; background: #131a26; overflow: hidden; }
  .candidate.selected { border-color: #4f8e78; }
  .candidate > summary { cursor: pointer; padding: .7rem .8rem; display: grid; grid-template-columns: auto auto 1fr auto; gap: .5rem; align-items: baseline; }
  .candidate-preview { color: #b7c2d3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .candidate-body { border-top: 1px solid #2f3b52; padding: .8rem; }
  .matches { display: grid; gap: .35rem; margin-top: .7rem; }
  .match { color: #9facc0; font-size: .85rem; padding-left: .65rem; border-left: 2px solid #34445f; overflow-wrap: anywhere; }
  .decision { display: grid; gap: .5rem; border: 1px solid #283247; border-radius: .5rem; padding: .75rem; background: #0f141e; }
  .empty { color: #8998ae; border: 1px dashed #344158; border-radius: .5rem; padding: .75rem; }
  .raw { border: 1px solid #283247; border-radius: .5rem; background: #0f141e; }
  .raw > summary { cursor: pointer; padding: .65rem .8rem; color: #9facc0; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; padding: .85rem; border-top: 1px solid #283247; color: #c8d4e8; max-height: 65vh; overflow: auto; }
  @media (max-width: 700px) {
    body { margin-top: 1rem; }
    .candidate > summary { grid-template-columns: auto 1fr auto; }
    .candidate-preview { grid-column: 1 / -1; }
  }
</style>
</head>
<body>
<header>
  <h1>Retrieval traces</h1>
  <label><input id="inputs" type="checkbox"> include exact conversation inputs</label>
  <button id="refresh" type="button">refresh</button>
</header>
<p class="note">Newest first. In-memory only; reset on Host restart. "Raw output" is selector text returned to the application, not hidden chain-of-thought.</p>
<div id="status" class="note"></div>
<main id="traces"></main>
<script>
const root = document.getElementById('traces');
const status = document.getElementById('status');
const inputs = document.getElementById('inputs');

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function percentage(value) {
  return Number.isFinite(value) ? Math.round(value * 100) + '%' : 'unknown';
}

function localTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function appendChips(parent, values) {
  const chips = element('div', 'chips');
  for (const value of values || []) chips.append(element('span', 'chip', value));
  parent.append(chips);
}

function lessonCard(lesson, selected) {
  const card = element('article', 'lesson-card' + (selected ? ' selected' : ''));
  const head = element('div', 'lesson-head');
  head.append(element('code', 'lesson-id', lesson.id || 'unknown lesson'));
  if (selected) head.append(element('span', 'badge selected', 'SELECTED'));
  head.append(element('span', 'confidence', percentage(lesson.confidence) + ' confidence'));
  card.append(head, element('p', 'lesson-content', lesson.content || '(no lesson content recorded)'));
  appendChips(card, lesson.tags);
  return card;
}

function matchText(match) {
  const location = match.field === 'tag' ? 'tag ' + (match.tag || '') : 'content';
  return match.concept + ' -> ' + location + ' matched "' + match.keyword + '"';
}

function candidateCard(candidate, selectedIds) {
  const selected = selectedIds.has(candidate.id);
  const details = element('details', 'candidate' + (selected ? ' selected' : ''));
  if (selected) details.open = true;
  const summary = element('summary');
  summary.append(element('code', 'lesson-id', candidate.id));
  if (selected) summary.append(element('span', 'badge selected', 'SELECTED'));
  summary.append(element('span', 'candidate-preview', candidate.content || '(no content)'));
  summary.append(element('span', 'confidence', percentage(candidate.confidence)));

  const body = element('div', 'candidate-body');
  body.append(element('p', 'lesson-content', candidate.content || '(no lesson content recorded)'));
  appendChips(body, candidate.tags);
  const matches = element('div', 'matches');
  const seen = new Set();
  for (const match of candidate.matches || []) {
    const text = matchText(match);
    if (!seen.has(text)) {
      seen.add(text);
      matches.append(element('div', 'match', text));
    }
  }
  if (matches.childElementCount) body.append(matches);
  details.append(summary, body);
  return details;
}

function renderSelected(trace, body) {
  const section = element('section', 'section');
  const lessons = trace.injected && Array.isArray(trace.injected.lessons) ? trace.injected.lessons : [];
  const ids = trace.injected && Array.isArray(trace.injected.lessonIds) ? trace.injected.lessonIds : [];
  const heading = element('div', 'section-heading');
  heading.append(element('h2', '', 'Selected lessons'), element('span', 'count', lessons.length + ' injected'));
  section.append(heading);
  if (lessons.length) {
    const grid = element('div', 'lesson-grid');
    for (const lesson of lessons) grid.append(lessonCard(lesson, true));
    section.append(grid);
  } else if (ids.length) {
    const fallback = element('div', 'empty', 'Selected IDs: ' + ids.join(', ') + ' (structured snapshots unavailable)');
    section.append(fallback);
  } else {
    section.append(element('div', 'empty', 'No lessons were injected for this run.'));
  }
  body.append(section);
}

function renderCandidates(trace, body) {
  const section = element('section', 'section');
  const candidates = Array.isArray(trace.candidates) ? trace.candidates : [];
  const selectedIds = new Set(trace.injected && Array.isArray(trace.injected.lessonIds) ? trace.injected.lessonIds : []);
  const heading = element('div', 'section-heading');
  const selection = trace.candidateSelection;
  const countText = !selection ? candidates.length + ' mechanically matched'
    : selection.mode === 'full-library' ? candidates.length + ' (whole eligible library)'
    : candidates.length + ' BM25-shortlisted of ' + selection.eligible + ' eligible';
  heading.append(element('h2', '', 'Candidate lessons'), element('span', 'count', countText));
  section.append(heading);
  if (candidates.length) {
    const list = element('div', 'candidate-list');
    for (const candidate of candidates) list.append(candidateCard(candidate, selectedIds));
    section.append(list);
  } else {
    section.append(element('div', 'empty', 'No candidate lessons matched this run.'));
  }
  body.append(section);
}

function renderDecision(trace, body) {
  const decision = element('section', 'decision');
  decision.append(element('h2', '', 'Decision details'));
  const concepts = trace.conceptExtraction && Array.isArray(trace.conceptExtraction.parsedValues)
    ? trace.conceptExtraction.parsedValues : [];
  const relevant = Array.isArray(trace.relevantLessonIds) ? trace.relevantLessonIds : [];
  const conceptLine = element('div');
  conceptLine.append(element('strong', '', 'Concepts: '));
  conceptLine.append(document.createTextNode(concepts.length ? concepts.join(', ') : 'none'));
  const relevanceLine = element('div');
  relevanceLine.append(element('strong', '', 'Relevant IDs: '));
  relevanceLine.append(document.createTextNode(relevant.length ? relevant.join(', ') : 'none'));
  const injectionLine = element('div');
  injectionLine.append(element('strong', '', 'Injection: '));
  const namespace = trace.injected && trace.injected.namespace ? trace.injected.namespace : 'none';
  const position = trace.injected && trace.injected.position ? trace.injected.position : 'none';
  injectionLine.append(document.createTextNode(namespace + ' / ' + position));
  decision.append(conceptLine, relevanceLine, injectionLine);
  body.append(decision);
}

function traceSummary(trace) {
  const selected = trace.injected && Array.isArray(trace.injected.lessonIds) ? trace.injected.lessonIds : [];
  return '#' + trace.id + '  ' + (trace.agentName || 'unknown agent') + '  ' +
    (trace.outcome || 'running') + '  ' + localTime(trace.startedAt) +
    '  selected: ' + selected.length;
}

function renderTrace(trace, index) {
  const details = element('details', 'trace');
  if (index === 0) details.open = true;
  details.append(element('summary', '', traceSummary(trace)));
  const body = element('div', 'trace-body');
  const meta = element('div', 'trace-meta');
  const reasoning = trace.config && trace.config.requestedReasoning;
  meta.append(
    element('span', '', 'agent: ' + (trace.agentName || 'unknown')),
    element('span', '', 'model: ' + ((trace.config && trace.config.model) || 'unknown')),
    element('span', '', 'reasoning effort: ' + (reasoning ? reasoning.effort : 'default')),
    element('span', '', 'cache: ' + (trace.cache && trace.cache.hit ? 'hit' : 'miss')),
    element('span', '', 'duration: ' + (Number.isFinite(trace.durationMs) ? trace.durationMs + ' ms' : 'running'))
  );
  body.append(meta);
  renderSelected(trace, body);
  renderCandidates(trace, body);
  renderDecision(trace, body);
  const raw = element('details', 'raw');
  raw.append(element('summary', '', 'Raw JSON (diagnostic)'), element('pre', '', JSON.stringify(trace, null, 2)));
  body.append(raw);
  details.append(body);
  return details;
}

async function load() {
  status.className = 'note';
  status.textContent = 'loading...';
  root.replaceChildren();
  try {
    const url = '/debug/retrieval?limit=100&includeInputs=' + (inputs.checked ? '1' : '0');
    const response = await fetch(url, { credentials: 'same-origin' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || ('HTTP ' + response.status));
    status.textContent = payload.enabled
      ? payload.traces.length + ' retained run(s)'
      : 'retrieval module is not enabled';
    payload.traces.forEach(function(trace, index) {
      root.append(renderTrace(trace, index));
    });
  } catch (error) {
    status.textContent = String(error);
    status.className = 'error';
  }
}

document.getElementById('refresh').addEventListener('click', load);
inputs.addEventListener('change', load);
load();
</script>
</body>
</html>`;
