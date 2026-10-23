/**
 * A load's repair of an agent's summaries, in the words its keeper reads: the
 * host's ops alert (index.ts), and the Web UI's Health tab, which imports it
 * as `@conhost/web/load-repair-alert`.
 *
 * context-manager repairs an agent's summary state each time it loads it, and
 * that repair can drop summaries: ones whose sources or range can't be read,
 * or whose links to other summaries are broken, with the summaries above
 * them. When a dropped summary held text, it reports the load
 * (`setLoadRepairHandler`, and the latest through
 * `getLatestLoadRepairReport()`). The report holds no summary text: the old
 * summaries are read back from the store's history.
 */

/** Why a load's repair dropped a summary that held text. */
export type LoadRepairDropReason = 'unreadable' | 'names-missing' | 'names-not-below' | 'names-non-child';

/** One summary holding text that a load's repair dropped. */
export interface LoadRepairDroppedSummary {
  id: string;
  /** Its stored level; null where that isn't a number. */
  level: number | null;
  /** Its stored size in tokens; null where that isn't a number. */
  tokens: number | null;
  reason: LoadRepairDropReason;
  /** The messages it covered: its range's end ids, each with its time (ISO),
   *  or null where the strategy's message view doesn't give that message;
   *  null where the range couldn't be read. */
  sourceRange: { first: string; last: string; firstAt: string | null; lastAt: string | null } | null;
}

/**
 * The report context-manager makes for a load whose repair dropped a summary
 * holding text, as its `LoadRepairReport` gives it. Declared here as well, as
 * the quarantine status is, so a context-manager without the report leaves
 * the host's alert unwired rather than failing its build.
 */
export interface LoadRepairReport {
  namespace: string;
  /** The Chronicle branch the repair wrote on. */
  branch: string;
  /** The state the repair rewrote. */
  stateId: string;
  /** The branch's sequence just before the repair's write. */
  sequenceBefore: number;
  dropped: LoadRepairDroppedSummary[];
  /** The sum of `dropped`'s tokens that are numbers. */
  droppedTokens: number;
  /** Empty summaries the same repair dropped, which held no text. */
  emptyDropped: number;
}

/** The ops alert's kind for a load repair. */
export const LOAD_REPAIR_KIND = 'memory-load-repair';

/** At most this many spans are named for a level before "and N more spans". */
const SPANS_NAMED_PER_LEVEL = 3;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A stored time as a number, or undefined where it isn't one a Date reads. */
function timeOf(iso: string | null | undefined): number | undefined {
  if (typeof iso !== 'string') return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const day = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const clock = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

/** A span of time in UTC: "2026-10-03 14:02–16:40 UTC" within a day, otherwise
 *  "2026-10-01 09:10 – 2026-10-05 22:01 UTC". */
function spanText(start: number, end: number): string {
  // Within one minute, as the words show it, a span is that minute.
  if (day(start) === day(end) && clock(start) === clock(end)) return `${day(start)} ${clock(start)} UTC`;
  if (day(start) === day(end)) return `${day(start)} ${clock(start)}–${clock(end)} UTC`;
  return `${day(start)} ${clock(start)} – ${day(end)} ${clock(end)} UTC`;
}

/** "A", "A and B", "A, B and C". */
function listText(items: readonly string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items.join('');
}

/** What one level's dropped summaries covered: the spans that can be named,
 *  by time where their messages have times and by message ids otherwise, and
 *  how many ranges couldn't be read. */
interface LevelSpans {
  named: string[];
  unread: number;
}

function levelSpans(drops: readonly LoadRepairDroppedSummary[]): LevelSpans {
  const timed: Array<[number, number]> = [];
  const byIds: string[] = [];
  let unread = 0;
  for (const drop of drops) {
    const range = drop.sourceRange;
    if (!range) { unread++; continue; }
    const first = timeOf(range.firstAt), last = timeOf(range.lastAt);
    if (first !== undefined && last !== undefined) timed.push(first <= last ? [first, last] : [last, first]);
    else byIds.push(range.first === range.last ? `message ${range.first}` : `messages ${range.first} to ${range.last}`);
  }
  // Spans that overlap or touch are one span of the agent's memory.
  timed.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of timed) {
    const previous = merged[merged.length - 1];
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return { named: [...merged.map(([start, end]) => spanText(start, end)), ...new Set(byIds)], unread };
}

/** A level's spans as the words name them: at most three, then how many more,
 *  then how many couldn't be read. */
function spansText({ named, unread }: LevelSpans): string {
  const shown = named.slice(0, SPANS_NAMED_PER_LEVEL);
  const more = named.length - shown.length;
  if (more > 0) shown.push(more === 1 ? '1 more span' : `${more} more spans`);
  if (unread > 0) shown.push(unread === 1 ? "a span whose range couldn't be read" : `${unread} spans whose ranges couldn't be read`);
  return listText(shown);
}

/** "level 1", "levels 2–3", "levels 1, 3 and 5". */
function levelsText(levels: number[]): string {
  if (levels.length === 1) return `level ${levels[0]}`;
  const consecutive = levels.every((level, i) => i === 0 || level === levels[i - 1]! + 1);
  if (consecutive) return `levels ${levels[0]}–${levels[levels.length - 1]}`;
  return `levels ${listText(levels.map(String))}`;
}

/**
 * What changed, merged per level: each level's spans, then the level, with
 * levels whose spans are all the same joined, so one damaged summary and the
 * summaries above it read as one memory changing at several levels rather
 * than several memories lost. A level with a range that couldn't be read is
 * never joined, since its spans can't be shown to be the same. Summaries
 * whose level couldn't be read come last.
 */
export function loadRepairSpans(report: Pick<LoadRepairReport, 'dropped'>): string {
  const byLevel = new Map<number | null, LoadRepairDroppedSummary[]>();
  for (const drop of report.dropped) {
    const list = byLevel.get(drop.level) ?? [];
    list.push(drop);
    byLevel.set(drop.level, list);
  }
  const groups = new Map<string, { spans: LevelSpans; levels: number[] }>();
  const levels = [...byLevel.keys()].filter((level): level is number => level !== null).sort((a, b) => a - b);
  for (const level of levels) {
    const spans = levelSpans(byLevel.get(level)!);
    const key = spans.unread > 0 ? `\u0001${level}` : spans.named.join('\u0000');
    const group = groups.get(key) ?? { spans, levels: [] };
    group.levels.push(level);
    groups.set(key, group);
  }
  const parts = [...groups.values()].map(({ spans, levels: joined }) => `${spansText(spans)} at ${levelsText(joined)}`);
  const unreadLevel = byLevel.get(null);
  if (unreadLevel) parts.push(`${spansText(levelSpans(unreadLevel))} at a level that couldn't be read`);
  // Once any part holds "and" (several spans, or several levels joined),
  // parts are set apart with semicolons.
  if (parts.some((part) => part.includes(' and '))) return parts.join('; ');
  return listText(parts);
}

/** How much summary text left what renders. */
function tokensText(report: Pick<LoadRepairReport, 'dropped' | 'droppedTokens'>): string {
  const unread = report.dropped.filter((drop) => typeof drop.tokens !== 'number' || !Number.isFinite(drop.tokens)).length;
  const n = report.droppedTokens;
  // Where some sizes couldn't be read and the rest add up to none (every one
  // unread included), "at least 0" would say nothing.
  if (unread > 0 && n === 0) return "summaries whose total size couldn't be read";
  const tokens = `${n.toLocaleString('en-US')} ${n === 1 ? 'token' : 'tokens'} of summary text`;
  return unread > 0 ? `summaries holding at least ${tokens}` : `summaries holding ${tokens}`;
}

/** What the agent may be told was removed: "some of your summaries from
 *  between Oct 1 and Oct 5 (UTC) were removed." where every dropped
 *  summary's messages have times; "…were removed, among them ones from
 *  between … (UTC)." where only some do; and no days where none do. */
function removedText(report: Pick<LoadRepairReport, 'dropped'>): string {
  const times: number[] = [];
  let untimed = 0;
  // Times only from summaries whose messages both have one, as the keeper's
  // spans take them, so the agent's days and the keeper's spans agree.
  for (const drop of report.dropped) {
    const first = timeOf(drop.sourceRange?.firstAt), last = timeOf(drop.sourceRange?.lastAt);
    if (first === undefined || last === undefined) untimed++;
    else times.push(first, last);
  }
  if (times.length === 0) return 'some of your summaries were removed.';
  // A loop, not Math.min(...times): a report can hold more times than a call
  // takes arguments.
  let min = times[0]!, max = times[0]!;
  for (const ms of times) {
    if (ms < min) min = ms;
    if (ms > max) max = ms;
  }
  const first = new Date(min), last = new Date(max);
  const sameYear = first.getUTCFullYear() === last.getUTCFullYear();
  const name = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${sameYear ? '' : `, ${d.getUTCFullYear()}`}`;
  const days = day(min) === day(max) ? name(first) : `between ${name(first)} and ${name(last)}`;
  // UTC days, as the keeper's spans are: the agent may read days in its own
  // time zone.
  return untimed === 0
    ? `some of your summaries from ${days} (UTC) were removed.`
    : `some of your summaries were removed, among them ones from ${days} (UTC).`;
}

/** Where the old summaries are, and how to read them back: from a copy taken
 *  while the host is stopped. Chronicle's open takes an exclusive lock, so a
 *  running host's store can't be opened beside it, and whether a copy taken
 *  while the host runs reads older sequences consistently isn't known. */
export function loadRepairReadBack(report: Pick<LoadRepairReport, 'branch' | 'stateId' | 'sequenceBefore'>, storePath?: string): string {
  const store = storePath ? `a copy of ${storePath}` : "a copy of the agent's store";
  // An observer without the ops scope gets the report with its branch
  // emptied (HEALTH_STRINGS), so the line names no branch then.
  const branch = report.branch === '' ? 'switch to the branch the repair ran on, which /healthz shows an observer with the ops scope' : `switchBranch(${JSON.stringify(report.branch)})`;
  return `The old summaries are still in the store's history: in ${store} taken while the host is stopped, open it with Chronicle's JsStore.open({ path }), `
    + `${branch}, then getStateJsonAt(${JSON.stringify(report.stateId)}, ${report.sequenceBefore}).`;
}

/** The report's first two sentences: what changed, and what the agent sees now. */
function loadRepairHeadline(report: LoadRepairReport, agent: string): string {
  const spans = loadRepairSpans(report);
  return `${agent}'s memory changed at load: context-manager's load repair dropped ${tokensText(report)}${spans ? `, covering ${spans}` : ''}. `
    + 'The repair removed summaries, not messages: those the store holds show raw or under the summaries that remain, until '
    + 'compression covers them again.';
}

/**
 * The keeper's words for one report, a sentence or two each: what changed and
 * what the agent sees now; whether to worry; where the old summaries are; and
 * words the keeper could pass on to the agent: what was removed, then that
 * its messages weren't. The Health tab shows them as they are, without the
 * store's path, which the host's panel doesn't have; the ops alert adds where
 * to read the rest.
 */
export function loadRepairLines(report: LoadRepairReport, agent: string, storePath?: string): string[] {
  return [
    loadRepairHeadline(report, agent),
    "A repair looks the same whether it's an upgrade's one-time cleanup or damage (a crash, a bad write, two writers on one store), "
      + 'so one on a store this context-manager version has opened before is worth chasing.',
    loadRepairReadBack(report, storePath),
    `If you tell ${agent}, you could say: "When your memory was loaded, ${removedText(report)} `
      + 'Your messages weren\'t: those still in your history are shown in full or under the summaries that remain, until '
      + 'they\'re summarized again."',
  ];
}

/** Where to read the rest of a running host's alert: the Health tab and
 *  /healthz hold the latest report a strategy made, which a later load in the
 *  same session (a branch switch, or state taken up from the store) can
 *  replace. */
const HOST_POINTER = 'The message is in failures.log; the Health tab shows the latest repair, and /healthz its full report.';

/** Where to read the rest of the alert a host on trial sends for a repair its
 *  store audit caused: no strategy of the host's made that report, so the
 *  Health tab and /healthz never hold it. */
export const AUDIT_POINTER = "The message is in failures.log and among the update's audit lines.";

/** What the host sends through the framework's ops-alert channel for one
 *  load-repair report: its message in the keeper's words, ending with where
 *  to read the rest (`pointer`), since agent-framework's webhook keeps only a
 *  long message's start and end, and the report's fields as its data. */
export function loadRepairAlert(
  report: LoadRepairReport, agent: string, storePath?: string, pointer: string = HOST_POINTER,
): { kind: string; message: string; data: Record<string, unknown> } {
  return {
    kind: LOAD_REPAIR_KIND,
    message: [...loadRepairLines(report, agent, storePath), pointer].join(' '),
    // Top-level fields, so each is bounded on its own on the way to the
    // failures log and the trace: a long `dropped` list is cut there without
    // taking the rest with it. The store's path is a field too, since a long
    // message's middle, where the read-back line names it, can be cut there.
    data: { ...report, ...(storePath ? { store: storePath } : {}) },
  };
}

/**
 * Send each load-repair report a strategy makes through the framework's
 * ops-alert channel: its message in the keeper's words, under the agent's
 * name, with the store's path in the read-back line. Duck-typed on both
 * sides, as the quarantine alarm is, so a context-manager that doesn't
 * report load repairs, or a framework without notifyOps, leaves it unwired.
 * Returns whether it was wired.
 */
export function wireLoadRepairAlert(
  strategy: unknown,
  framework: unknown,
  agent: string,
  storePath?: string,
): boolean {
  const repairCapable = strategy as { setLoadRepairHandler?: (fn: (report: LoadRepairReport) => void) => void } | null;
  const ops = framework as { notifyOps?: (kind: string, agent: string, message: string, data?: Record<string, unknown>) => void } | null;
  if (typeof repairCapable?.setLoadRepairHandler !== 'function' || typeof ops?.notifyOps !== 'function') return false;
  repairCapable.setLoadRepairHandler((report) => {
    const alert = loadRepairAlert(report, agent, storePath);
    ops.notifyOps!(alert.kind, agent, alert.message, alert.data);
  });
  return true;
}
