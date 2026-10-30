import {
  createCliRenderer,
  CliRenderEvents,
  type CliRenderer,
  BoxRenderable,
  TextRenderable,
  TextareaRenderable,
  ScrollBoxRenderable,
  bold,
  dim,
  fg,
  decodePasteBytes,
  stripAnsiSequences,
} from '@opentui/core';
import { createWriteStream, mkdirSync } from 'node:fs';
import { sessionMarker } from './session-marker.js';
import type { AgentFramework, SessionUsage } from '@animalabs/agent-framework';
import type { AutobiographicalStrategy } from '@animalabs/context-manager';
import type { Membrane, NormalizedRequest } from '@animalabs/membrane';
import type { SubagentModule, ActiveSubagent } from './modules/subagent-module.js';
import { FleetTreeAggregator } from './state/fleet-tree-aggregator.js';
import type { AgentNode } from './state/agent-tree-reducer.js';
import { emptyUsage, foldUsageSample, type UsageCounts, type UsageSample } from './state/stream-usage.js';
import { STREAM_END_TRACES, TURN_RUNNING_TRACES, traceError } from './state/turn-trace.js';
import { createFailureLines, createTurnFailures, turnEndedLine, type FailureStep } from './state/turn-failures.js';
import { credentialActionHint, opsAlertLine, opsAlertOf, type OpsAlertEntry } from './state/ops-alerts.js';
import { failureHint } from './failure-hint.js';
import { TurnInterrupts, interruptSubagents } from './state/turn-interrupt.js';
import { switchFollowing, traceFollower } from './piped-turns.js';
import { type FleetModule } from './modules/fleet-module.js';
import type { WireEvent } from './modules/fleet-types.js';
import { parseFleetRoute } from './modules/fleet-types.js';
import { handleCommand, resetBranchState } from './commands.js';
import { refusedWhileSwitching, trackOperatorWork } from './session-switch.js';
import { formatQuotaReadout } from './quota-meter.js';
import { recipeModel } from './recipe.js';
import { takeRecipeWarnings } from './recipe-warnings.js';
import { bunFloorNotice } from './bun-floor-check.js';
import { hostUpdate } from './update/update.js';
import { effectiveContextBudgetTokens } from './recipe-fit.js';
import { storedInjectionMarkOf } from '@animalabs/agent-framework';
import { storedInjectionLabel } from './stored-injection.js';
import { speakerOf, type Speaker } from './speaker.js';

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

export function fmtElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  if (min < 60) return `${min}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m`;
}

export function ctxSeverity(ctx: number, budget?: number): 'ok' | 'warn' | 'high' {
  if (!budget || budget <= 0 || ctx <= 0) return 'ok';
  const frac = ctx / budget;
  return frac >= 0.9 ? 'high' : frac >= 0.75 ? 'warn' : 'ok';
}

const ALERT_KIND_PRIORITY = ['compression-quarantine', 'inference-exhausted'];

export function pickTopAlert(kinds: string[]): string | null {
  if (kinds.length === 0) return null;
  for (const p of ALERT_KIND_PRIORITY) {
    if (kinds.includes(p)) return p;
  }
  return kinds[kinds.length - 1] ?? null;
}

const MARKER_ROW = 1;

export function sliceViewport(len: number, cursor: number, avail: number): { start: number; end: number } {
  if (len <= avail) return { start: 0, end: len };
  const body = Math.max(1, avail - 2 * MARKER_ROW);
  const start = Math.max(0, Math.min(cursor - Math.floor(body / 2), len - body));
  const end = start + body;
  if (start === 0) return { start, end: Math.min(len, Math.max(1, avail - MARKER_ROW)) };
  if (end >= len) return { start: Math.max(0, len - Math.max(1, avail - MARKER_ROW)), end: len };
  return { start, end };
}

function headerMessage(message: string): string {
  return message.length > 70 ? `${message.slice(0, 67).replace(/[\uD800-\uDBFF]$/, '')}…` : message;
}

export function historyUserLine(
  msg: { participant: string; metadata?: unknown },
  text: string,
): { text: string; speaker: Speaker['kind'] } {
  const speaker = speakerOf(msg.participant, msg.metadata);
  return { text: `${speaker.kind === 'you' ? 'You' : speaker.label}: ${text}`, speaker: speaker.kind };
}

export function historyInjectionLine(
  msg: { content: ReadonlyArray<{ type: string; text?: unknown }>; metadata?: unknown; shardIndex?: number },
): string | null | undefined {
  const mark = storedInjectionMarkOf(msg.metadata);
  if (!mark) return undefined;
  if (typeof msg.shardIndex === 'number' && msg.shardIndex > 0) return null;
  const text = msg.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const line = text === '' ? storedInjectionLabel(mark) : `${storedInjectionLabel(mark)} ${text}`;
  return line.length > 120 ? `${line.slice(0, 117).replace(/[\uD800-\uDBFF]$/, '')}…` : line;
}

export function fleetNoticeLine(notice: string): string {
  const newline = notice.indexOf('\n');
  return `  ⚠ ${headerMessage(newline < 0 ? notice : `${notice.slice(0, newline)} …`)}`;
}

function hhmm(now = new Date()): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

export type QuitConfirmAction = 'kill' | 'detach' | 'cancel' | 'cancel-keep-input';
export function resolveQuitConfirm(raw: string): QuitConfirmAction {
  const c = raw.trim().toLowerCase();
  if (c === 'y' || c === 'yes' || c === 'q' || c === 'quit' || c === '/q' || c === '/quit') return 'kill';
  if (c === 'd' || c === 'detach') return 'detach';
  if (c === '' || c === 'n' || c === 'no' || c === 'cancel') return 'cancel';
  return 'cancel-keep-input';
}


export interface RootTurnEnd {
  status: 'idle' | 'error';
  background: 'show' | 'drop';
  line?: { text: string; tone: 'error' | 'note' };
}
export function rootTurnEnd(
  event: { type: string; error?: unknown; reason?: unknown },
  turnShowing: boolean,
): RootTurnEnd | null {
  // agent-framework sends inference:failed only for an attempt it started, so
  // a failure ends a turn even when the TUI didn't see the turn start.
  if (!turnShowing && event.type !== 'inference:failed') return null;
  switch (event.type) {
    case 'inference:completed':
    case 'inference:turn_ended':
      return { status: 'idle', background: 'show' };
    case 'inference:failed':
      return { status: 'error', background: 'drop', line: { text: `Error: ${traceError(event)}`, tone: 'error' } };
    case 'inference:aborted': {
      const reason = typeof event.reason === 'string' && event.reason !== '' ? `: ${event.reason}` : '';
      return { status: 'idle', background: 'drop', line: { text: `(turn aborted${reason})`, tone: 'note' } };
    }
    case 'inference:exhausted':
      // Alone, without a `failed` first, it ends a stream aborted for a
      // reason other than a stop, which agent-framework doesn't treat as
      // deliberate, so it shows as a failure; a stop ends with `aborted`.
      return { status: 'error', background: 'drop', line: { text: `(turn ended: ${traceError(event)})`, tone: 'error' } };
    default:
      return null;
  }
}

export function peekEndLine(
  event: { type: string; reason?: unknown; error?: unknown },
): { text: string; tone: 'dim' | 'warn' | 'error' } | null {
  switch (event.type) {
    case 'inference:turn_ended':
      return { text: '── turn ended by a tool ──', tone: 'dim' };
    case 'inference:aborted':
      return { text: `✗ turn aborted${typeof event.reason === 'string' && event.reason !== '' ? `: ${event.reason}` : ''}`, tone: 'warn' };
    case 'inference:failed':
      return { text: `✗ inference failed: ${traceError(event)}`, tone: 'error' };
    case 'inference:exhausted':
      return { text: `✗ turn ended: ${traceError(event)}`, tone: 'error' };
    default:
      return null;
  }
}

export function peekEndColor(tone: 'dim' | 'warn' | 'error'): string {
  return tone === 'dim' ? DIM_GRAY : tone === 'warn' ? YELLOW : RED;
}

export function formatWireEvent(evt: WireEvent): { text: string; color: string } | null {
  const type = typeof evt.type === 'string' ? evt.type : '';
  if (!type) return null;
  const get = (k: string): unknown => (evt as Record<string, unknown>)[k];

  switch (type) {
    case 'lifecycle': {
      const phase = get('phase') as string;
      const color = phase === 'ready' ? GREEN : phase === 'exiting' ? YELLOW : GRAY;
      return { text: `◆ lifecycle: ${phase}${get('reason') ? ` (${get('reason') as string})` : ''}`, color };
    }
    case 'inference:started': return { text: `─ inference started (${get('agentName') ?? '?'}) ─`, color: DIM_GRAY };
    case 'inference:completed': return { text: `─ inference completed ─`, color: DIM_GRAY };
    case 'inference:turn_ended':
    case 'inference:aborted':
    case 'inference:failed':
    case 'inference:exhausted': {
      const end = peekEndLine(evt as { type: string; reason?: unknown; error?: unknown });
      return end && { text: end.text, color: peekEndColor(end.tone) };
    }
    case 'inference:tokens': {
      return null;
    }
    case 'inference:content_block':
    case 'inference:usage':
    case 'usage:updated':
      return null;
    case 'ops:alert': {
      const kind = typeof get('kind') === 'string' ? get('kind') as string : 'unknown';
      const msg = typeof get('message') === 'string' ? get('message') as string : '';
      const who = typeof get('agentName') === 'string' ? ` [${get('agentName') as string}]` : '';
      return kind.endsWith('-clear')
        ? { text: `✓${who} ${kind}: ${msg}`, color: CYAN }
        : { text: `⚠${who} ${kind}: ${msg}`, color: RED };
    }
    case 'tool:started': return { text: `  ⟳ ${get('tool') as string}`, color: YELLOW };
    case 'tool:completed': return { text: `  ✓ ${get('tool') as string} (${get('durationMs') ?? '?'}ms)`, color: CYAN };
    case 'tool:failed': return { text: `  ✗ ${get('tool') as string}: ${get('error') as string}`, color: RED };
    case 'command-output': return { text: `  ${get('text') as string}`, color: GRAY };
    default:
      return { text: `· ${type}`, color: DIM_GRAY };
  }
}

export function escapeActs(status: string, rootTurnRunning: boolean): boolean {
  if (status === 'idle' || status === 'switching') return false;
  return status !== 'error' || rootTurnRunning;
}

export function escapeLine(
  outcome: 'aborted' | 'deferred' | 'idle',
  stopped: string,
): { text: string | null; endsTurn: boolean } {
  switch (outcome) {
    case 'aborted':
      return { text: stopped ? `  (${stopped})` : null, endsTurn: false };
    case 'deferred':
      return { text: `  (interrupting: the turn stops as soon as it can be aborted${stopped ? `; ${stopped}` : ''})`, endsTurn: false };
    case 'idle':
      return { text: stopped ? `  (no turn interrupted — ${stopped})` : '  (no turn interrupted)', endsTurn: true };
  }
}

export function rootTurnStep(
  showing: boolean,
  event: { type: string; error?: unknown; reason?: unknown },
): { showing: boolean; end: RootTurnEnd | null } {
  if (event.type === 'inference:started' || TURN_RUNNING_TRACES.has(event.type)) return { showing: true, end: null };
  if (!STREAM_END_TRACES.has(event.type)) return { showing, end: null };
  return { showing: false, end: rootTurnEnd(event, showing) };
}

export function shortAgentName(full: string): string {
  if (full.startsWith('spawn-')) return full.slice('spawn-'.length).replace(/-\d+$/, '');
  return full.replace(/-d\d+(-retry\d+)?-\d+$/, '');
}

interface AppContext {
  framework: AgentFramework;
  membrane: Membrane;
  sessionManager: import('./session-manager.js').SessionManager;
  recipe: import('./recipe.js').Recipe;
  branchState: import('./commands.js').BranchState;
  userMessageCount: number;
  quotaMeter?: import('./quota-meter.js').QuotaMeter | null;
  credentials?: import('./credential-state.js').CredentialMonitor | null;
  subscriptionUnmetered?: boolean;
  stopping?: boolean;
  switching?: boolean;
  switchSession(id: string): Promise<unknown>;
}

interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { total: number; currency: string };
  quota?: string | null;
}

interface TuiState {
  status: string;
  tool: string | null;
  toolStartedAt: number | null;
  subagents: ActiveSubagent[];
  viewMode: 'chat' | 'fleet' | 'peek' | 'peek-proc';
  tokens: TokenUsage;
  ctxTokens: number;
  peekTarget: string | null;
  peekProcTarget: string | null;
  peekProcAgent: string | null;
  pendingQuitConfirm: boolean;
}

type FleetNodeKind = 'researcher' | 'subagent' | 'fleet-child' | 'fleet-child-agent';

interface FleetNode {
  name: string;
  fullName: string;
  kind: FleetNodeKind;
  agent?: ActiveSubagent;
  reducerNode?: AgentNode;
  fleetChildName?: string;
  children: FleetNode[];
}

interface FleetLine {
  text: string;
  color: string;
}

const GREEN = '#00cc00';
const YELLOW = '#cccc00';
const CYAN = '#00cccc';
const MAGENTA = '#cc00cc';
const RED = '#cc0000';
const GRAY = '#888888';
const DIM_GRAY = '#555555';
const WHITE = '#cccccc';
const THINKING_DIM = '#8a7aa8';
const THINKING_PREFIX = '💭 ';

type StreamBlockType = 'text' | 'thinking' | 'tool_call' | 'tool_result';

export async function runTui(app: AppContext): Promise<void> {
  const membrane = app.membrane;

  const logDir = process.env.DATA_DIR || './data';
  mkdirSync(logDir, { recursive: true });
  const logPath = `${logDir}/tui-error.log`;
  const logStream = createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n${sessionMarker(new Date())}\n`);
  for (const warning of takeRecipeWarnings()) logStream.write(`warning: ${warning}\n`);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    logStream.write(chunk);
    return true;
  }) as typeof process.stderr.write;

  const renderer = await createCliRenderer({ exitOnCtrlC: false });

  let stopping = false;

  const recipeName = app.recipe?.name ?? 'connectome-host';
  const rootAgentName = app.recipe?.agent?.name ?? 'agent';
  process.stdout.write(`\x1b]0;${recipeName}\x07`);

  const state: TuiState = {
    status: 'idle',
    tool: null,
    toolStartedAt: null,
    subagents: [],
    viewMode: 'chat',
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ctxTokens: 0,
    peekTarget: null,
    peekProcTarget: null,
    peekProcAgent: null,
    pendingQuitConfirm: false,
  };

  const opsAlerts = new Map<string, OpsAlertEntry>();

  function handleOpsAlert(kind: string, agent: string, message: string): void {
    const line = opsAlertLine(opsAlerts, kind, agent, message);
    if (line === null) return;
    addEvent(line.text, line.cleared ? CYAN : RED);
    updateStatus();
  }

  let streaming = false;
  let currentStreamText: TextRenderable | null = null;
  let backgrounded = false;
  let backgroundBuffer = '';
  let rootTurnShowing = false;
  const interrupts = new TurnInterrupts((agentName, reason) => app.framework.abortInference(agentName, reason));
  let currentStreamBuffer = '';
  let verboseChat = false;

  let streamOutputTokens = 0;
  let spinnerFrame = 0;
  const SPINNER = ['·', '.', 'o', 'O'];

  type SubagentPhase = 'sending' | 'streaming' | 'invoking' | 'executing' | 'done' | 'failed';
  const subagentPhase = new Map<string, SubagentPhase>();
  const subagentFailureShown = new Set<string>();
  let turnFailures = createTurnFailures();
  const failedTurnHint = failureHint(app.recipe, process.env, app.credentials);
  const failureLines = createFailureLines();
  const PHASE_COLOR: Record<SubagentPhase, string> = {
    sending: YELLOW,
    streaming: CYAN,
    invoking: MAGENTA,
    executing: YELLOW,
    done: DIM_GRAY,
    failed: RED,
  };

  const rootBox = new BoxRenderable(renderer, {
    id: 'root',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
  });

  const scrollBox = new ScrollBoxRenderable(renderer, {
    id: 'conversation',
    flexGrow: 1,
    stickyScroll: true,
    stickyStart: 'bottom',
  });

  const fleetBox = new BoxRenderable(renderer, {
    id: 'fleet',
    flexGrow: 1,
    flexDirection: 'column',
    paddingLeft: 1,
    paddingTop: 1,
  });
  let fleetLineCounter = 0;
  const STATUS_INPUT_PADDING_ROWS = 3;

  function clearFleetBox(): void {
    for (const child of [...fleetBox.getChildren()]) {
      fleetBox.remove(child.id);
      child.destroy();
    }
  }

  const statusLeft = new TextRenderable(renderer, {
    id: 'status-left',
    content: formatStatusLeft(state),
    fg: GRAY,
  });

  const statusRight = new TextRenderable(renderer, {
    id: 'status-right',
    content: formatTokens(state.tokens, false),
    fg: DIM_GRAY,
  });

  const statusBox = new BoxRenderable(renderer, {
    id: 'status-box',
    height: 1,
    paddingLeft: 1,
    paddingRight: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
  });

  // Ctrl+J is a linefeed, which OpenTUI's Textarea binds to a newline by
  // default.
  const input = new TextareaRenderable(renderer, {
    id: 'input',
    placeholder: 'Type a message or /help — Alt+Enter for newline',
    wrapMode: 'word',
    keyBindings: [
      { name: 'return', action: 'submit' },
      { name: 'return', meta: true, action: 'newline' },
    ],
    onSubmit: () => { handleSubmit(); },
  });

  const INLINE_PASTE_THRESHOLD = 200;
  const pastedTexts: string[] = [];
  const PASTE_PLACEHOLDER = /\[paste #(\d+):[^\]]*\]/g;
  function formatPastePlaceholder(n: number, text: string): string {
    const head = text.replace(/\s+/g, ' ').trim().slice(0, 30).replace(/[[\]]/g, '·');
    const lines = text.split(/\r?\n/).length;
    const sizeHint = lines > 1 ? `${text.length}ch, ${lines}L` : `${text.length}ch`;
    return `[paste #${n}: "${head}…" ${sizeHint}]`;
  }
  (input as any).handlePaste = (event: { bytes: Uint8Array }) => {
    if (stopping) return;
    const text = stripAnsiSequences(decodePasteBytes(event.bytes));
    if (text.length <= INLINE_PASTE_THRESHOLD && !/[\r\n]/.test(text)) {
      (input as any).insertText(text);
      return;
    }
    pastedTexts.push(text);
    (input as any).insertText(formatPastePlaceholder(pastedTexts.length, text));
  };

  const inputBox = new BoxRenderable(renderer, {
    id: 'input-box',
    height: 1,
    paddingLeft: 1,
  });

  statusBox.add(statusLeft);
  statusBox.add(statusRight);
  inputBox.add(input);
  rootBox.add(scrollBox);
  rootBox.add(fleetBox);
  fleetBox.visible = false;
  rootBox.add(statusBox);
  rootBox.add(inputBox);
  renderer.root.add(rootBox);

  input.focus();

  const agentTranscripts = new Map<string, string>();
  const TRANSCRIPT_CAP = 30_000;
  const transcriptTotalLen = new Map<string, number>();

  const agentParent = new Map<string, string>();

  const agentContextTokens = new Map<string, number>();
  const streamUsage = new Map<string, UsageCounts>();

  const summaryCache = new Map<string, string>();
  const summarySnapshotLen = new Map<string, number>();
  const summaryPending = new Set<string>();
  const summaryBackoffUntil = new Map<string, number>();

  const SUMMARY_DELTA = 2000;
  const SUMMARY_WINDOW = 10_000;
  const SUMMARY_FAILURE_BACKOFF_MS = 30_000;

  function appendTranscript(agent: string, text: string) {
    const next = (agentTranscripts.get(agent) ?? '') + text;
    agentTranscripts.set(agent, next.length > TRANSCRIPT_CAP ? next.slice(-TRANSCRIPT_CAP) : next);
    transcriptTotalLen.set(agent, (transcriptTotalLen.get(agent) ?? 0) + text.length);
  }

  async function generateSummary(agentName: string) {
    if (summaryPending.has(agentName)) return;
    if (Date.now() < (summaryBackoffUntil.get(agentName) ?? 0)) return;
    const transcript = agentTranscripts.get(agentName);
    if (!transcript || transcript.length < 50) return;

    const totalLen = transcriptTotalLen.get(agentName) ?? 0;
    const lastLen = summarySnapshotLen.get(agentName) ?? 0;
    if (totalLen - lastLen < SUMMARY_DELTA && summaryCache.has(agentName)) return;

    summaryPending.add(agentName);
    try {
      const window = transcript.slice(-SUMMARY_WINDOW);
      const request: NormalizedRequest = {
        messages: [{
          participant: 'user',
          content: [{ type: 'text', text: `Agent activity stream:\n\n${window}\n\nWhat is this agent doing right now? Answer in 5-10 words.` }],
        }],
        system: 'You distill an agent\'s activity into a terse status phrase. 5-10 words max. No punctuation. Specific, not generic.',
        config: { model: 'claude-haiku-4-5-20251001', maxTokens: 40, temperature: 0.3 },
      };
      const response = await membrane.complete(request);
      const text = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text).join('').trim();
      summaryCache.set(agentName, text.length > 60 ? text.slice(0, 57) + '...' : text);
      summarySnapshotLen.set(agentName, totalLen);
      summaryBackoffUntil.delete(agentName);
      if (state.viewMode === 'fleet') updateFleetView();
    } catch {
      summaryBackoffUntil.set(agentName, Date.now() + SUMMARY_FAILURE_BACKOFF_MS);
    } finally {
      summaryPending.delete(agentName);
    }
  }

  let messageCounter = 0;

  const SCROLLBACK_CAP = 2000;
  function pruneScrollback() {
    const children = scrollBox.getChildren();
    if (children.length <= SCROLLBACK_CAP) return;
    for (const child of children.slice(0, children.length - SCROLLBACK_CAP)) {
      if (child === currentStreamText) continue;
      // OpenTUI's remove() only detaches a renderable; destroy() frees its
      // native text buffer.
      scrollBox.remove(child.id);
      child.destroy();
    }
  }

  function addLine(text: string, color: string = WHITE): TextRenderable | undefined {
    if (stopping) return undefined;
    const line = new TextRenderable(renderer, {
      id: `msg-${++messageCounter}`,
      content: text,
      fg: color,
    });
    scrollBox.add(line);
    pruneScrollback();
    return line;
  }

  function addEvent(text: string, color: string = WHITE) {
    addLine(`${hhmm()} ${text}`, color);
  }

  function showFailure(agent: string, label: string, step: Exclude<FailureStep, { show: 'ended' }>, color: string): void {
    failureLines.show(agent, `${hhmm()} ${label}`, step, (text) => {
      const line = addLine(text, color);
      return line && { setText: (next: string) => { line.content = next; }, get isDestroyed() { return line.isDestroyed; } };
    });
  }

  function getAgentBudget(name: string): number | undefined {
    try {
      const live = (app.framework as unknown as {
        getAgentRuntimeSettings?: (n: string) => { contextBudgetTokens?: number } | undefined;
      }).getAgentRuntimeSettings?.(name)?.contextBudgetTokens;
      if (typeof live === 'number' && live > 0) return live;
    } catch { }
    return name === rootAgentName && app.recipe
      ? effectiveContextBudgetTokens(app.recipe, recipeModel(app.recipe, process.env.MODEL))
      : undefined;
  }

  function updateStatus() {
    if (stopping) return;
    const topAlert = pickTopAlert([...opsAlerts.values()].map(a => a.kind));
    let left = formatStatusLeft(state, SPINNER[spinnerFrame], streamOutputTokens, opsAlerts.size, topAlert, interrupts.isRunning(rootAgentName));
    statusLeft.fg = opsAlerts.size > 0 ? RED : GRAY;

    const budget = getAgentBudget(rootAgentName);
    const right = formatTokens(state.tokens, verboseChat, state.ctxTokens, budget) + formatMemStats(getRootCM());
    const sev = ctxSeverity(state.ctxTokens, budget);
    statusRight.fg = sev === 'high' ? RED : sev === 'warn' ? YELLOW : DIM_GRAY;
    statusRight.content = right;

    const maxLeft = Math.max(12, renderer.terminalWidth - right.length - 4);
    if (left.length > maxLeft) left = left.slice(0, maxLeft - 1) + '…';
    statusLeft.content = left;
  }

  function getRootCM(): { getRenderStats?: () => unknown; getStrategy?: () => { getStats?: () => unknown } } | null {
    try {
      const ag = app.framework.getAgent(rootAgentName);
      if (!ag) return null;
      return ag.getContextManager() as any;
    } catch {
      return null;
    }
  }

  let currentStreamBlockType: StreamBlockType = 'text';

  let thinkingCollapsed = false;
  let thinkingCollapsedChars = 0;

  function finalizeCollapsedThinking() {
    if (!thinkingCollapsed) return;
    if (currentStreamText && currentStreamBlockType === 'thinking') {
      currentStreamText.content = `${THINKING_PREFIX}(thought, ~${fmtTokens(Math.ceil(thinkingCollapsedChars / 4))} tok)`;
    }
    thinkingCollapsed = false;
    thinkingCollapsedChars = 0;
  }

  function beginStream() {
    currentStreamBuffer = '';
    currentStreamBlockType = 'text';
    currentStreamText = new TextRenderable(renderer, {
      id: `stream-${++messageCounter}`,
      content: '',
      fg: WHITE,
    });
    scrollBox.add(currentStreamText);
    pruneScrollback();
    streaming = true;
  }

  function switchStreamBlock(blockType: StreamBlockType) {
    if (currentStreamBlockType === blockType && currentStreamText) return;
    if (blockType !== 'thinking') finalizeCollapsedThinking();
    if (blockType !== 'text' && blockType !== 'thinking') {
      currentStreamBlockType = blockType;
      return;
    }
    currentStreamBuffer = '';
    currentStreamBlockType = blockType;
    if (blockType === 'thinking') {
      if (!verboseChat) {
        thinkingCollapsed = true;
        thinkingCollapsedChars = 0;
      }
      currentStreamBuffer = thinkingCollapsed ? `${THINKING_PREFIX}thinking…` : THINKING_PREFIX;
      currentStreamText = new TextRenderable(renderer, {
        id: `stream-thinking-${++messageCounter}`,
        content: currentStreamBuffer,
        fg: THINKING_DIM,
      });
    } else {
      currentStreamText = new TextRenderable(renderer, {
        id: `stream-${++messageCounter}`,
        content: '',
        fg: WHITE,
      });
    }
    scrollBox.add(currentStreamText);
    pruneScrollback();
  }

  function streamToken(text: string) {
    if (!currentStreamText) return;
    if (thinkingCollapsed && currentStreamBlockType === 'thinking') {
      thinkingCollapsedChars += text.length;
      currentStreamText.content = `${THINKING_PREFIX}thinking… ~${fmtTokens(Math.ceil(thinkingCollapsedChars / 4))} tok`;
      return;
    }
    currentStreamBuffer += text;
    currentStreamText.content = currentStreamBuffer;
  }

  function endStream() {
    finalizeCollapsedThinking();
    streaming = false;
    currentStreamText = null;
    currentStreamBuffer = '';
    currentStreamBlockType = 'text';
  }

  const HISTORY_REPLAY_MAX = 50;

  function loadSessionHistory() {
    const agent = app.framework.getAgent(rootAgentName);
    if (!agent) return;
    const cm = agent.getContextManager();
    const all = cm.getAllMessages();
    if (all.length === 0) return;
    const messages = all.length > HISTORY_REPLAY_MAX ? all.slice(-HISTORY_REPLAY_MAX) : all;

    addLine(messages.length < all.length
      ? `── session history (last ${messages.length} of ${all.length} messages — full history in the web UI) ──`
      : `── session history (${messages.length} messages) ──`, DIM_GRAY);

    for (const msg of messages) {
      const injected = historyInjectionLine(msg);
      if (injected !== undefined) {
        if (injected !== null) addLine(injected, DIM_GRAY);
        continue;
      }

      const toolNames: string[] = [];

      for (const block of msg.content) {
        if (block.type === 'text' && (block as { text: string }).text.trim()) {
          if (msg.participant === 'user') {
            const line = historyUserLine(msg, (block as { text: string }).text);
            addLine(line.text, line.speaker === 'you' ? GREEN : line.speaker === 'host' ? DIM_GRAY : CYAN);
          } else {
            addLine((block as { text: string }).text, WHITE);
          }
        } else if (block.type === 'thinking') {
          const t = (block as { thinking?: string }).thinking;
          if (t && t.trim()) {
            const line = t.trim().replace(/\s+/g, ' ');
            addLine(`${THINKING_PREFIX}${line.length > 120 ? line.slice(0, 117) + '…' : line}`, THINKING_DIM);
          }
        } else if (block.type === 'tool_use') {
          toolNames.push((block as { name: string }).name);
        }
      }

      if (toolNames.length > 0) {
        addLine(`[tools] ${toolNames.join(', ')}`, YELLOW);
      }
    }

    addLine(`── end history ──`, DIM_GRAY);
  }

  function refreshFromStore() {
    // Reset streaming state BEFORE destroying renderables so nothing can
    // touch a freed native buffer through currentStreamText.
    streaming = false;
    currentStreamText = null;
    currentStreamBuffer = '';
    thinkingCollapsed = false;
    thinkingCollapsedChars = 0;

    const children = [...scrollBox.getChildren()];
    for (const child of children) {
      scrollBox.remove(child.id);
      child.destroy();
    }
    messageCounter = 0;
    state.status = 'idle';
    state.tool = null;

    loadSessionHistory();

    if (subMod) {
      subMod.restoreFromStore();
      state.subagents = [...subMod.activeSubagents.values()];

      agentParent.clear();
      for (const [child, parent] of subMod.parentMap) {
        agentParent.set(child, parent);
      }
    }

    const ws = app.framework.getModule('workspace');
    if (ws && 'materializeMount' in ws) {
      trackOperatorWork(app, "the _config mount's refresh", (ws as any).materializeMount('_config')).catch(() => {});
    }

    updateStatus();
  }

  const fmtK = fmtTokens;

  const expandedNodes = new Set<string>([rootAgentName]);
  const seenFleetHeaders = new Set<string>();
  let fleetCursor = 0;
  let fleetCursorLine = 0;
  let visibleNodeIds: string[] = [];
  const visibleNodes = new Map<string, FleetNode>();

  function buildFleetTree(): FleetNode {
    const root: FleetNode = {
      name: rootAgentName,
      fullName: rootAgentName,
      kind: 'researcher',
      children: [],
    };

    const byName = new Map<string, FleetNode>();
    for (const sa of state.subagents) {
      const fullName = [...(subMod?.activeSubagents ?? [])].find(([, entry]) => entry === sa)?.[0] ?? sa.name;
      const node: FleetNode = {
        name: sa.name,
        fullName,
        kind: 'subagent',
        agent: sa,
        children: [],
      };
      byName.set(sa.name, node);
    }

    for (const sa of state.subagents) {
      const parentFullName = agentParent.get(sa.name);
      if (parentFullName && parentFullName !== rootAgentName) {
        const short = byName.has(parentFullName) ? parentFullName : shortAgentName(parentFullName);
        const parentShort = byName.has(short) ? short : short.replace(/-retry\d+$/, '');
        if (byName.has(parentShort)) {
          byName.get(parentShort)!.children.push(byName.get(sa.name)!);
          continue;
        }
      }
      root.children.push(byName.get(sa.name)!);
    }

    const sortChildren = (children: FleetNode[]) => {
      children.sort((a, b) => {
        const aRunning = a.agent?.status === 'running' ? 0 : 1;
        const bRunning = b.agent?.status === 'running' ? 0 : 1;
        if (aRunning !== bRunning) return aRunning - bRunning;
        return (a.agent?.startedAt ?? 0) - (b.agent?.startedAt ?? 0);
      });
      for (const child of children) {
        if (child.children.length > 0) sortChildren(child.children);
      }
    };
    sortChildren(root.children);

    if (treeAggregator && fleetMod) {
      for (const fc of fleetMod.getChildren().values()) {
        const reducerNodes = treeAggregator.getChildNodes(fc.name);
        const childTreeRoots: FleetNode[] = reducerNodes
          .filter(n => n.parent === undefined)
          .map(n => buildAggregatorSubtree(n, reducerNodes, fc.name));
        const headerKey = `proc:${fc.name}`;
        if (!seenFleetHeaders.has(headerKey)) {
          seenFleetHeaders.add(headerKey);
          expandedNodes.add(headerKey);
        }
        const headerNode: FleetNode = {
          name: headerKey,
          fullName: fc.name,
          kind: 'fleet-child',
          fleetChildName: fc.name,
          children: childTreeRoots,
        };
        root.children.push(headerNode);
      }
    }

    return root;
  }

  function buildAggregatorSubtree(
    rootReducerNode: AgentNode,
    allNodes: AgentNode[],
    fleetChildName: string,
  ): FleetNode {
    const node: FleetNode = {
      name: `${fleetChildName}:${rootReducerNode.name}`,
      fullName: rootReducerNode.name,
      kind: 'fleet-child-agent',
      reducerNode: rootReducerNode,
      fleetChildName,
      children: allNodes
        .filter(n => n.parent === rootReducerNode.name)
        .map(child => buildAggregatorSubtree(child, allNodes, fleetChildName)),
    };
    return node;
  }

  const PHASE_PRIORITY: Partial<Record<SubagentPhase, number>> = {
    streaming: 5,
    invoking: 4,
    executing: 3,
    sending: 2,
  };

  function pickBusiest(phases: Iterable<SubagentPhase | undefined>): SubagentPhase | null {
    let best: SubagentPhase | null = null;
    let bestScore = -1;
    for (const phase of phases) {
      if (phase === undefined) continue;
      const score = PHASE_PRIORITY[phase];
      if (score !== undefined && score > bestScore) {
        best = phase;
        bestScore = score;
      }
    }
    return best;
  }

  function rollupActivePhase(nodes: AgentNode[]): SubagentPhase | null {
    return pickBusiest(nodes.map(n => n.phase as SubagentPhase));
  }

  function anyDescendantActive(): SubagentPhase | null {
    const phases: Array<SubagentPhase | undefined> = [];
    for (const sa of state.subagents) {
      if (sa.status === 'running') {
        phases.push(subagentPhase.get(sa.name) ?? 'sending');
      }
    }
    if (treeAggregator && fleetMod) {
      for (const childName of fleetMod.getChildren().keys()) {
        const phase = rollupActivePhase(treeAggregator.getChildNodes(childName));
        if (phase) phases.push(phase);
      }
    }
    return pickBusiest(phases);
  }

  function renderNode(node: FleetNode, depth: number, lines: FleetLine[]): void {
    const indent = '  '.repeat(depth);
    const isExpanded = expandedNodes.has(node.name);
    const hasChildren = node.children.length > 0;

    let nodeColor: string;
    if (node.kind === 'researcher') {
      if (state.status !== 'idle' && state.status !== 'error') {
        nodeColor = WHITE;
      } else {
        const descendant = anyDescendantActive();
        nodeColor = state.status === 'error' ? RED
          : descendant ? PHASE_COLOR[descendant]
          : GRAY;
      }
    } else if (node.kind === 'subagent') {
      const sa = node.agent!;
      if (sa.status === 'running') {
        const phase = subagentPhase.get(sa.name) ?? 'sending';
        nodeColor = PHASE_COLOR[phase];
      } else {
        nodeColor = sa.status === 'failed' ? RED : DIM_GRAY;
      }
    } else if (node.kind === 'fleet-child') {
      const fc = fleetMod?.getChildren().get(node.fleetChildName!);
      if (fc?.status === 'ready') {
        const active = rollupActivePhase(treeAggregator?.getChildNodes(node.fleetChildName!) ?? []);
        nodeColor = active ? PHASE_COLOR[active] : CYAN;
      } else {
        nodeColor = fc?.status === 'starting' ? YELLOW
          : fc?.status === 'crashed' ? RED
          : DIM_GRAY;
      }
    } else {
      const rn = node.reducerNode!;
      if (rn.status === 'failed') nodeColor = RED;
      else if (rn.phase === 'idle' || rn.phase === 'done' || rn.phase === 'cancelled') nodeColor = DIM_GRAY;
      else nodeColor = PHASE_COLOR[rn.phase as SubagentPhase] ?? GRAY;
    }

    const detailColor = node.kind === 'researcher'
      ? (state.status === 'idle' ? DIM_GRAY : GRAY)
      : (node.kind === 'subagent' && node.agent?.status === 'running' ? GRAY : DIM_GRAY);

    let statusTag: string;
    if (node.kind === 'researcher') {
      if (state.status === 'error') {
        statusTag = '✗ error';
      } else if (state.status !== 'idle') {
        statusTag = `… ${state.status}`;
      } else {
        const descendant = anyDescendantActive();
        statusTag = descendant ? `… ${descendant} (descendant)` : '✓ idle';
      }
    } else if (node.kind === 'subagent') {
      const sa = node.agent!;
      const endTime = sa.completedAt ?? Date.now();
      const elapsed = Math.floor((endTime - sa.startedAt) / 1000);
      if (sa.status !== 'running') {
        statusTag = sa.status === 'completed' ? `done ${fmtElapsed(elapsed)}`
          : sa.status === 'cancelled' ? `cancelled ${fmtElapsed(elapsed)}`
          : `failed ${fmtElapsed(elapsed)}`;
      } else {
        const phase = subagentPhase.get(sa.name) ?? 'sending';
        statusTag = `${phase} ${fmtElapsed(elapsed)}`;
      }
    } else if (node.kind === 'fleet-child') {
      const fc = fleetMod?.getChildren().get(node.fleetChildName!);
      const elapsed = fc ? Math.floor((Date.now() - fc.startedAt) / 1000) : 0;
      if (fc?.status === 'ready') {
        const active = rollupActivePhase(treeAggregator?.getChildNodes(node.fleetChildName!) ?? []);
        statusTag = active ? `${active} ${fmtElapsed(elapsed)}` : `ready ${fmtElapsed(elapsed)}`;
      } else {
        statusTag = fc ? `${fc.status} ${fmtElapsed(elapsed)}` : 'unknown';
      }
    } else {
      const rn = node.reducerNode!;
      const elapsed = rn.startedAt ? Math.floor(((rn.completedAt ?? Date.now()) - rn.startedAt) / 1000) : 0;
      statusTag = `${rn.phase} ${fmtElapsed(elapsed)}`;
    }

    let ctxTokens: number | undefined;
    if (node.kind === 'fleet-child-agent') {
      const v = node.reducerNode?.tokens.input;
      if (typeof v === 'number' && v > 0) ctxTokens = v;
    } else if (node.kind !== 'fleet-child') {
      ctxTokens = agentContextTokens.get(node.fullName) ?? agentContextTokens.get(node.name);
    }
    const ctxBudget = ctxTokens && node.kind !== 'fleet-child-agent' && node.kind !== 'fleet-child'
      ? getAgentBudget(node.fullName)
      : undefined;
    const ctxStr = ctxTokens
      ? (ctxBudget ? ` ${fmtK(ctxTokens)}/${fmtK(ctxBudget)}ctx` : ` ${fmtK(ctxTokens)}ctx`)
      : '';

    let compStr = '';
    if (node.kind === 'researcher') {
      try {
        const agent = app.framework.getAgent(rootAgentName);
        const cm = agent?.getContextManager();
        const strategy = (cm as any)?.strategy as AutobiographicalStrategy | undefined;
        if (strategy?.getStats) {
          const stats = strategy.getStats();
          if (stats.compressionCount > 0) {
            compStr = ` ${stats.compressionCount}comp`;
          }
        }
      } catch { }
    }

    const marker = hasChildren ? (isExpanded ? '▼' : '►') : '─';

    const isCursor = visibleNodeIds.length === fleetCursor;
    if (isCursor) fleetCursorLine = lines.length;
    const cursor = isCursor ? '→' : ' ';
    visibleNodeIds.push(node.name);
    visibleNodes.set(node.name, node);

    let hints = '';
    if (isCursor) {
      if (node.kind === 'subagent') {
        hints = node.agent?.status === 'running' ? '  ⏎:fold p:peek Del:stop' : '  ⏎:fold p:peek';
      } else if (node.kind === 'fleet-child') {
        const fc = fleetMod?.getChildren().get(node.fleetChildName!);
        hints = fc?.status === 'ready' ? '  ⏎:fold p:peek Del:stop' : '  ⏎:fold';
      } else if (node.kind === 'fleet-child-agent') {
        hints = '  ⏎:fold p:peek';
      } else {
        hints = '  ⏎:fold';
      }
    }

    const displayName = node.kind === 'fleet-child-agent' ? node.fullName
      : node.kind === 'fleet-child' ? `▣ ${node.fleetChildName}`
      : node.name;

    lines.push({
      text: `${cursor} ${indent}${marker} ${displayName}  [${statusTag}]${ctxStr}${compStr}${hints}`,
      color: nodeColor,
    });

    if (!isExpanded) return;

    const detail = indent + '    ';

    if (node.kind === 'researcher' && state.tool) {
      lines.push({ text: `  ${detail}tool: ${state.tool}`, color: detailColor });
    }
    if (node.kind === 'subagent' && node.agent) {
      const sa = node.agent;
      const task = sa.task.length > 60 ? sa.task.slice(0, 57) + '...' : sa.task;
      lines.push({ text: `  ${detail}task: ${task}`, color: detailColor });
      if (sa.statusMessage) {
        lines.push({ text: `  ${detail}tool: ${sa.statusMessage} (${sa.toolCallsCount} calls)`, color: detailColor });
      }
    }
    if (node.kind === 'fleet-child') {
      const fc = fleetMod?.getChildren().get(node.fleetChildName!);
      if (fc) {
        lines.push({ text: `  ${detail}pid: ${fc.pid ?? '-'}  events: ${fc.events.length}`, color: detailColor });
        if (fc.exitReason && fc.status !== 'ready' && fc.status !== 'starting') {
          lines.push({ text: `  ${detail}${fc.exitReason}`, color: detailColor });
        }
      }
    }
    if (node.kind === 'fleet-child-agent' && node.reducerNode) {
      const rn = node.reducerNode;
      if (rn.toolCallsCount > 0) {
        lines.push({ text: `  ${detail}tools: ${rn.toolCallsCount} calls`, color: detailColor });
      }
      if (rn.task) {
        const task = rn.task.length > 60 ? rn.task.slice(0, 57) + '...' : rn.task;
        lines.push({ text: `  ${detail}task: ${task}`, color: detailColor });
      }
    }

    const fullName = node.kind === 'fleet-child' || node.kind === 'fleet-child-agent'
      ? null
      : node.kind === 'researcher' ? rootAgentName
      : [...agentTranscripts.keys()].find(k => k === node.name || shortAgentName(k) === node.name);
    if (fullName) {
      const summary = summaryCache.get(fullName);
      if (summary) {
        lines.push({ text: `  ${detail}┈ ${summary}`, color: DIM_GRAY });
      } else if (summaryPending.has(fullName)) {
        lines.push({ text: `  ${detail}┈ …`, color: DIM_GRAY });
      }
    }

    for (const child of node.children) {
      renderNode(child, depth + 1, lines);
    }
  }

  let fleetNotice: string | null = null;
  let fleetNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  function showFleetNotice(text: string): void {
    if (stopping) return;
    fleetNotice = text;
    if (fleetNoticeTimer) clearTimeout(fleetNoticeTimer);
    fleetNoticeTimer = setTimeout(() => {
      fleetNotice = null;
      fleetNoticeTimer = null;
      if (state.viewMode === 'fleet') updateFleetView();
    }, 6000);
    addEvent(`  ${text}`, RED);
    if (state.viewMode === 'fleet') updateFleetView();
  }

  function fleetSummaryLine(): string {
    let running = 0, done = 0, failed = 0, cancelled = 0;
    for (const sa of state.subagents) {
      if (sa.status === 'running') running++;
      else if (sa.status === 'completed') done++;
      else if (sa.status === 'cancelled') cancelled++;
      else failed++;
    }
    if (treeAggregator && fleetMod) {
      for (const childName of fleetMod.getChildren().keys()) {
        for (const rn of treeAggregator.getChildNodes(childName)) {
          if (rn.status === 'failed') failed++;
          else if (rn.phase === 'done') done++;
          else if (rn.phase === 'cancelled') cancelled++;
          else if (PHASE_PRIORITY[rn.phase as SubagentPhase] !== undefined) running++;
        }
      }
    }
    const parts: string[] = [];
    const counts: string[] = [];
    if (running > 0) counts.push(`${running} running`);
    if (done > 0) counts.push(`${done} done`);
    if (failed > 0) counts.push(`${failed} failed`);
    if (cancelled > 0) counts.push(`${cancelled} cancelled`);
    parts.push(counts.length > 0 ? `agents: ${counts.join(' · ')}` : 'agents: none');
    if (fleetMod) {
      const children = [...fleetMod.getChildren().values()];
      if (children.length > 0) {
        const up = children.filter(c => c.status === 'ready' || c.status === 'starting').length;
        const crashed = children.filter(c => c.status === 'crashed').length;
        parts.push(`children: ${up}/${children.length} up${crashed > 0 ? ` (${crashed} crashed)` : ''}`);
      }
    }
    if (state.tokens.quota !== undefined) {
      if (state.tokens.quota) parts.push(`Σ ${state.tokens.quota}`);
    } else if (state.tokens.cost && state.tokens.cost.total > 0) {
      parts.push(`Σ $${state.tokens.cost.total.toFixed(state.tokens.cost.total < 1 ? 3 : 2)}`);
    }
    return `  ${parts.join('   ')}`;
  }

  function updateFleetView() {
    if (stopping) return;
    const tree = buildFleetTree();
    visibleNodeIds = [];
    visibleNodes.clear();
    fleetCursorLine = 0;

    const header: FleetLine[] = [];
    header.push({ text: '─── Agent Fleet ─── ↑↓:nav  ⏎/→:fold  p:peek  Del:stop  r:restart  Esc:chat ───', color: GRAY });
    if (fleetNotice) {
      header.push({ text: fleetNoticeLine(fleetNotice), color: RED });
    }
    const alerts = [...opsAlerts.values()];
    for (const a of alerts.slice(0, 3)) {
      const msg = headerMessage(a.message);
      header.push({ text: `  ⚠ [${a.agent}] ${a.kind}${a.count > 1 ? ` ×${a.count}` : ''} — ${msg}`, color: RED });
    }
    if (alerts.length > 3) {
      header.push({ text: `  ⚠ … and ${alerts.length - 3} more`, color: RED });
    }
    header.push({ text: fleetSummaryLine(), color: GRAY });
    header.push({ text: '', color: GRAY });

    const treeLines: FleetLine[] = [];
    renderNode(tree, 0, treeLines);

    if (fleetCursor >= visibleNodeIds.length) fleetCursor = visibleNodeIds.length - 1;
    if (fleetCursor < 0) fleetCursor = 0;

    const avail = Math.max(5, renderer.terminalHeight - STATUS_INPUT_PADDING_ROWS - header.length);
    const { start, end } = sliceViewport(treeLines.length, fleetCursorLine, avail);
    const lines: FleetLine[] = [...header];
    if (start > 0) lines.push({ text: `  ┈ ${start} lines above ┈`, color: DIM_GRAY });
    lines.push(...treeLines.slice(start, end));
    if (end < treeLines.length) lines.push({ text: `  ┈ ${treeLines.length - end} lines below ┈`, color: DIM_GRAY });

    clearFleetBox();
    for (const line of lines) {
      fleetBox.add(new TextRenderable(renderer, {
        id: `fleet-ln-${++fleetLineCounter}`,
        content: line.text,
        fg: line.color,
      }));
    }
  }

  function switchView(mode: 'chat' | 'fleet' | 'peek' | 'peek-proc') {
    state.viewMode = mode;
    scrollBox.visible = mode === 'chat';
    fleetBox.visible = mode !== 'chat';
    if (mode === 'chat') {
      input.focus();
    } else {
      input.blur();
      if (mode === 'fleet') updateFleetView();
      else if (mode === 'peek-proc') updatePeekProcView();
    }
  }

  function updatePeekProcView(): void {
    const name = state.peekProcTarget;
    if (!name || !fleetMod) return;
    const child = fleetMod.getChildren().get(name);
    const agentFilter = state.peekProcAgent ?? undefined;
    const key = procLogKey(name, agentFilter);

    const lines: FleetLine[] = [];
    const title = agentFilter ? `Peek: ${name} › ${agentFilter}` : `Peek proc: ${name}`;
    lines.push({ text: `─── ${title} ──────────────── Esc:back ───`, color: GRAY });
    lines.push({ text: '', color: GRAY });

    if (child && agentFilter) {
      const rn = treeAggregator?.getChildNodes(name).find(n => n.name === agentFilter);
      if (rn) {
        const elapsed = rn.startedAt ? Math.floor(((rn.completedAt ?? Date.now()) - rn.startedAt) / 1000) : 0;
        const phaseColor = rn.status === 'failed' ? RED
          : rn.phase === 'idle' || rn.phase === 'done' || rn.phase === 'cancelled' ? DIM_GRAY
          : PHASE_COLOR[rn.phase as SubagentPhase] ?? CYAN;
        const ctx = rn.tokens.input > 0 ? `  ${fmtK(rn.tokens.input)}ctx` : '';
        lines.push({ text: `  ${rn.phase}  ${fmtElapsed(elapsed)}  ${rn.toolCallsCount} tool calls${ctx}`, color: phaseColor });
        if (rn.task) {
          const task = rn.task.length > 70 ? rn.task.slice(0, 67) + '...' : rn.task;
          lines.push({ text: `  task: ${task}`, color: GRAY });
        }
        if (rn.parent) {
          lines.push({ text: `  parent: ${rn.parent} (in ${name})`, color: DIM_GRAY });
        }
      } else {
        lines.push({ text: `  (agent not currently tracked in ${name} — events stream as they arrive)`, color: DIM_GRAY });
      }
    } else if (child) {
      const elapsed = Math.floor((Date.now() - child.startedAt) / 1000);
      const timeStr = fmtElapsed(elapsed);
      const statusColor =
        child.status === 'ready' ? CYAN :
        child.status === 'starting' ? YELLOW :
        child.status === 'crashed' ? RED :
        DIM_GRAY;
      lines.push({
        text: `  ${child.status}  ${timeStr}  pid=${child.pid ?? '-'}  events=${child.events.length}`,
        color: statusColor,
      });
      lines.push({ text: `  recipe: ${child.recipePath}`, color: GRAY });
    } else {
      lines.push({ text: '  (child not found)', color: RED });
    }

    lines.push({ text: '', color: GRAY });

    const log = procPeekLogs.get(key);
    const pending = procPeekTokenLine.get(key);
    if (log && log.length > 0) {
      const available = renderer.terminalHeight - STATUS_INPUT_PADDING_ROWS;
      const maxLines = Math.max(5, available - lines.length - MARKER_ROW - (pending ? 1 : 0));
      const tail = log.slice(-maxLines);
      if (log.length > maxLines) {
        lines.push({ text: `  ┈ (${log.length - maxLines} lines above)`, color: DIM_GRAY });
      }
      for (const entry of tail) {
        lines.push({ text: `  ${entry.text}`, color: entry.color });
      }
    } else {
      lines.push({ text: agentFilter
        ? '  (no events from this agent yet)'
        : '  (no events yet — child may be idle)', color: DIM_GRAY });
    }

    if (pending) {
      lines.push({ text: `  ${pending}`, color: WHITE });
    }

    clearFleetBox();
    for (const line of lines) {
      fleetBox.add(new TextRenderable(renderer, {
        id: `fleet-ln-${++fleetLineCounter}`,
        content: line.text,
        fg: line.color,
      }));
    }
  }

  function enterPeekProc(name: string, agentFilter?: string): void {
    if (!fleetMod) return;
    const child = fleetMod.getChildren().get(name);
    if (!child) return;

    state.peekProcTarget = name;
    state.peekProcAgent = agentFilter ?? null;
    const key = procLogKey(name, agentFilter);
    const matches = (evt: WireEvent): boolean =>
      !agentFilter || (evt as { agentName?: string }).agentName === agentFilter;

    if (!procPeekLogs.has(key)) procPeekLogs.set(key, []);
    const log = procPeekLogs.get(key)!;
    const lastEvt = child.events[child.events.length - 1];
    if (log.length === 0) {
      for (const evt of child.events) {
        if (!matches(evt)) continue;
        const formatted = formatWireEvent(evt);
        if (formatted) log.push(formatted);
      }
    } else if (lastEvt && procPeekLastEvent.get(key) !== lastEvt) {
      appendProcPeekLog(key, '┈ re-attached — events emitted while detached are not shown ┈', DIM_GRAY);
    }
    if (lastEvt) procPeekLastEvent.set(key, lastEvt);

    if (procPeekUnsub) { procPeekUnsub(); procPeekUnsub = null; }
    procPeekUnsub = fleetMod.onChildEvent(name, (_childName, evt) => {
      procPeekLastEvent.set(key, evt);
      if (!matches(evt)) return;
      const type = typeof evt.type === 'string' ? evt.type : '';
      const active = state.viewMode === 'peek-proc'
        && state.peekProcTarget === name
        && state.peekProcAgent === (agentFilter ?? null);

      if (type === 'inference:tokens') {
        const content = (evt as { content?: string }).content ?? '';
        if (!content) return;
        const prev = procPeekTokenLine.get(key) ?? '';
        const merged = prev + content;
        const parts = merged.split('\n');
        for (let i = 0; i < parts.length - 1; i++) {
          if (parts[i]!.trim()) appendProcPeekLog(key, parts[i]!, WHITE);
        }
        procPeekTokenLine.set(key, parts[parts.length - 1]!);
        if (active) updatePeekProcView();
        return;
      }

      const pending = procPeekTokenLine.get(key);
      if (pending?.trim()) {
        appendProcPeekLog(key, pending, WHITE);
      }
      procPeekTokenLine.delete(key);

      const formatted = formatWireEvent(evt);
      if (!formatted) return;
      appendProcPeekLog(key, formatted.text, formatted.color);
      if (active) updatePeekProcView();
    });

    switchView('peek-proc');
  }

  function cleanupPeekProc(): void {
    if (procPeekUnsub) { procPeekUnsub(); procPeekUnsub = null; }
    if (state.peekProcTarget) {
      const key = procLogKey(state.peekProcTarget, state.peekProcAgent ?? undefined);
      const pending = procPeekTokenLine.get(key);
      if (pending?.trim()) {
        appendProcPeekLog(key, pending, WHITE);
      }
      procPeekTokenLine.delete(key);
    }
    state.peekProcTarget = null;
    state.peekProcAgent = null;
  }

  const PEEK_LOG_MAX_LINES = 500;
  const peekLogs = new Map<string, FleetLine[]>();
  const peekCurrentTool = new Map<string, string | null>();
  let peekUnsubscribe: (() => void) | null = null;

  function appendPeekLog(name: string, text: string, color: string) {
    if (!peekLogs.has(name)) peekLogs.set(name, []);
    const log = peekLogs.get(name)!;
    log.push({ text, color });
    if (log.length > PEEK_LOG_MAX_LINES) log.splice(0, log.length - PEEK_LOG_MAX_LINES);
  }

  function cleanupPeek() {
    if (peekUnsubscribe) {
      peekUnsubscribe();
      peekUnsubscribe = null;
    }
    state.peekTarget = null;
  }

  function enterPeek(name: string) {
    const sa = state.subagents.find(s => s.name === name);
    if (!sa) return;

    state.viewMode = 'peek';
    state.peekTarget = name;

    if (!peekLogs.has(name)) peekLogs.set(name, []);

    if (subMod) {
      subMod.peek(name).then(snapshots => {
        if (snapshots.length > 0 && state.viewMode === 'peek' && state.peekTarget === name) {
          const snap = snapshots[0]!;
          const log = peekLogs.get(name);
          if (log && log.length === 0) {
            if (snap.currentStream) {
              const streamLines = snap.currentStream.split('\n').slice(-10);
              for (const l of streamLines) {
                if (l.trim()) appendPeekLog(name, l, WHITE);
              }
            }
            if (snap.pendingToolCalls.length > 0) {
              for (const tc of snap.pendingToolCalls) {
                appendPeekLog(name, `⟳ ${tc.name}`, YELLOW);
                peekCurrentTool.set(name, tc.name);
              }
            }
          }
          updatePeekView();
        }
      }).catch(() => {});
    }

    updatePeekView();
  }

  function updatePeekView() {
    const name = state.peekTarget;
    if (!name) return;

    const lines: FleetLine[] = [];
    lines.push({ text: `─── Peek: ${name} ──────────────── Esc:back ───`, color: GRAY });
    lines.push({ text: '', color: GRAY });

    const sa = state.subagents.find(s => s.name === name);
    if (sa) {
      const endTime = sa.completedAt ?? Date.now();
      const elapsed = Math.floor((endTime - sa.startedAt) / 1000);
      const timeStr = fmtElapsed(elapsed);
      const statusColor = sa.status === 'running' ? CYAN : sa.status === 'failed' ? RED : DIM_GRAY;
      lines.push({ text: `  ${sa.status}  ${timeStr}  ${sa.toolCallsCount} tool calls`, color: statusColor });

      const task = sa.task.length > 70 ? sa.task.slice(0, 67) + '...' : sa.task;
      lines.push({ text: `  task: ${task}`, color: GRAY });
    }

    const log = peekLogs.get(name);
    if (peekCurrentTool.get(name)) {
      lines.push({ text: '', color: GRAY });
      lines.push({ text: `  ⟳ ${peekCurrentTool.get(name)}`, color: YELLOW });
    }

    lines.push({ text: '', color: GRAY });

    if (log && log.length > 0) {
      const available = renderer.terminalHeight - STATUS_INPUT_PADDING_ROWS;
      const maxLines = Math.max(5, available - lines.length - MARKER_ROW);
      const tail = log.slice(-maxLines);
      if (log.length > maxLines) {
        lines.push({ text: `  ┈ (${log.length - maxLines} lines above)`, color: DIM_GRAY });
      }
      for (const entry of tail) {
        lines.push({ text: `  ${entry.text}`, color: entry.color });
      }
    } else {
      lines.push({ text: '  (waiting for output)', color: DIM_GRAY });
    }

    clearFleetBox();
    for (const line of lines) {
      fleetBox.add(new TextRenderable(renderer, {
        id: `fleet-ln-${++fleetLineCounter}`,
        content: line.text,
        fg: line.color,
      }));
    }
  }

  function noteUsageSample(agent: string, sample: UsageSample | undefined): void {
    if (!sample) return;
    const step = foldUsageSample(streamUsage.get(agent), sample);
    streamUsage.set(agent, step.total);
    if (step.prompt === undefined) return;
    agentContextTokens.set(agent, step.prompt);
    const short = shortAgentName(agent);
    if (short !== agent) agentContextTokens.set(short, step.prompt);
    if (state.viewMode === 'fleet') updateFleetView();
    if (agent === rootAgentName) {
      state.ctxTokens = step.prompt;
      updateStatus();
    }
  }

  function showRootTurnEnd(end: RootTurnEnd): void {
    state.status = end.status;
    state.tool = null;
    state.toolStartedAt = null;
    if (backgrounded) {
      if (end.background === 'show') {
        if (backgroundBuffer.trim()) addLine(backgroundBuffer, WHITE);
        addEvent('  (researcher returned from background)', CYAN);
      }
      backgrounded = false;
      backgroundBuffer = '';
    }
    if (streaming) endStream();
    if (end.line) addEvent(end.line.text, end.line.tone === 'error' ? RED : YELLOW);
    updateStatus();
  }

  function onTrace(event: Record<string, unknown>) {
    const agent = event.agentName as string | undefined;
    interrupts.onTrace(event as { type: string; agentName?: unknown });
    let rootEnd: RootTurnEnd | null = null;
    if (agent === rootAgentName) {
      const step = rootTurnStep(rootTurnShowing, event as { type: string });
      rootTurnShowing = step.showing;
      rootEnd = step.end;
    }
    const failure = turnFailures.onTrace(event as { type: string; agentName?: unknown });
    if (agent === rootAgentName && failure && failure.show !== 'ended' && rootEnd?.line) {
      rootEnd = { status: rootEnd.status, background: rootEnd.background };
    }

    switch (event.type) {
      case 'inference:started': {
        if (agent) streamUsage.set(agent, emptyUsage());
        if (agent && agent !== rootAgentName) subagentFailureShown.delete(agent);
        if (agent === rootAgentName) {
          if (backgrounded) {
            state.status = 'background';
            streamOutputTokens = 0;
          } else {
            state.status = 'thinking';
            streamOutputTokens = 0;
            spinnerFrame = 0;
            beginStream();
          }
          updateStatus();
        }
        break;
      }

      case 'inference:content_block': {
        if (agent === rootAgentName && event.phase === 'block_start') {
          const bt = event.blockType as string;
          if (bt === 'text' || bt === 'thinking') {
            if (!streaming) beginStream();
            switchStreamBlock(bt);
          }
        }
        break;
      }

      case 'inference:tokens': {
        const content = event.content as string;
        const blockType = event.blockType as string | undefined;
        if (content) {
          if (agent === rootAgentName && backgrounded) {
            backgroundBuffer += content;
            streamOutputTokens += Math.ceil(content.length / 4);
          } else if (agent === rootAgentName && streaming) {
            if (blockType && (blockType === 'text' || blockType === 'thinking')
              && blockType !== currentStreamBlockType) {
              switchStreamBlock(blockType);
            }
            streamToken(content);
            streamOutputTokens += Math.ceil(content.length / 4);
            spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
            updateStatus();
          }
          if (agent) {
            appendTranscript(agent, content);
            const prev = agentContextTokens.get(agent);
            if (prev) {
              const delta = Math.ceil(content.length / 4);
              agentContextTokens.set(agent, prev + delta);
              const short = shortAgentName(agent);
              if (short !== agent) agentContextTokens.set(short, prev + delta);
            }
          }
        }
        break;
      }

      case 'inference:usage': {
        if (agent) noteUsageSample(agent, event.tokenUsage as UsageSample | undefined);
        break;
      }

      case 'inference:completed': {
        if (agent) noteUsageSample(agent, event.tokenUsage as UsageSample | undefined);
        updateStatus();
        break;
      }

      case 'usage:updated': {
        const { totals } = event as { totals: SessionUsage };
        state.tokens.input = totals.inputTokens;
        state.tokens.output = totals.outputTokens;
        state.tokens.cacheRead = totals.cacheReadTokens;
        state.tokens.cacheWrite = totals.cacheCreationTokens;
        if (totals.estimatedCost) state.tokens.cost = totals.estimatedCost;
        updateStatus();
        break;
      }

      case 'ops:alert': {
        const alert = opsAlertOf(event);
        handleOpsAlert(alert.kind, alert.agent, alert.message);
        break;
      }

      case 'inference:failed': {
        if (agent !== rootAgentName) {
          if (agent) {
            const short = shortAgentName(agent);
            subagentPhase.set(short, 'failed');
            subagentFailureShown.add(agent);
          }
          if (agent && failure && failure.show !== 'ended') showFailure(agent, `[${agent}] `, failure, DIM_GRAY);
          else addEvent(`[${agent}] Error: ${traceError(event)}`, DIM_GRAY);
        }
        break;
      }

      case 'inference:exhausted': {
        if (agent !== rootAgentName) {
          if (agent && subagentFailureShown.delete(agent)) break;
          if (agent) subagentPhase.set(shortAgentName(agent), 'failed');
          addEvent(`[${agent}] Error: ${traceError(event)}`, DIM_GRAY);
        }
        break;
      }

      case 'inference:tool_calls_yielded': {
        const calls = event.calls as Array<{ name: string; input?: unknown }>;
        const names = calls.map(c => c.name).join(', ');

        if (agent) {
          const toolSnippet = calls.map(c => {
            const inp = c.input ? JSON.stringify(c.input) : '';
            return `[tool: ${c.name}${inp ? ' ' + inp.slice(0, 200) : ''}]`;
          }).join('\n');
          appendTranscript(agent, '\n' + toolSnippet + '\n');

          for (const call of calls) {
            if (call.name === 'subagent--spawn' || call.name === 'subagent--fork') {
              const childName = (call.input as Record<string, unknown>)?.name as string | undefined;
              if (childName) {
                agentParent.set(childName, agent);
              }
            }
          }
        }

        if (agent === rootAgentName) {
          state.status = backgrounded ? 'background' : 'tools';
          state.tool = names;
          if (streaming) endStream();
          if (!backgrounded) addEvent(`[tools] ${names}`, YELLOW);
        } else {
          const short = shortAgentName(agent ?? '');
          addLine(`  [${short}] ${names}`, DIM_GRAY);
          const sa = state.subagents.find(s => s.name === agent || s.name === short);
          if (sa) {
            sa.toolCallsCount += calls.length;
            sa.statusMessage = names.split('--').pop();
          }
        }
        updateStatus();
        break;
      }

      case 'inference:stream_resumed': {
        if (agent === rootAgentName) {
          state.status = 'thinking';
          state.tool = null;
          beginStream();
          updateStatus();
        }
        break;
      }

      case 'process:received': {
        const pe = event.processEvent as { type: string; source?: string; metadata?: Record<string, unknown> } | undefined;
        if (pe?.source === 'wake:triggered' && pe.metadata) {
          const subs = (pe.metadata.subscriptions as string[]) ?? [];
          const summary = (pe.metadata.eventSummary as string) ?? '';
          const snippet = summary.length > 60 ? summary.slice(0, 57) + '...' : summary;
          const label = subs.join(', ');
          addEvent(`\u2691 wake triggered: ${label} \u2014 "${snippet}"`, YELLOW);
        }
        break;
      }

      case 'tool:started': {
        const tool = event.tool as string;
        if (agent === rootAgentName) {
          state.tool = tool;
          state.toolStartedAt = Date.now();
          updateStatus();
        }
        const toolInput = event.input as Record<string, unknown> | undefined;
        if (toolInput && (agent === rootAgentName || verboseChat)) {
          const short = agent === rootAgentName ? '' : `[${shortAgentName(agent ?? '')}] `;
          if (tool === 'files:write' && toolInput.filePath) {
            const fp = String(toolInput.filePath);
            addLine(`  ${short}write ${fp}`, DIM_GRAY);
          } else if (tool === 'files:materialize' && toolInput.targetDir) {
            const dir = String(toolInput.targetDir);
            const files = toolInput.files as string[] | undefined;
            const fileList = files ? files.join(', ') : 'all';
            const osc8Link = `\x1b]8;;file://${dir}\x07${dir}\x1b]8;;\x07`;
            addLine(`  ${short}materialize → ${osc8Link} (${fileList})`, DIM_GRAY);
          } else if (tool === 'lessons--create' && toolInput.content) {
            const content = String(toolInput.content);
            const tags = (toolInput.tags as string[] | undefined)?.join(', ') ?? '';
            const preview = content.length > 80 ? content.slice(0, 77) + '...' : content;
            addLine(`  ${short}+ lesson${tags ? ` [${tags}]` : ''}: ${preview}`, GREEN);
          }
        }
        break;
      }

      case 'tool:completed': {
        if (agent === rootAgentName) {
          state.toolStartedAt = null;
          const tool = event.tool as string;
          const durMs = typeof event.durationMs === 'number' ? event.durationMs : undefined;
          if (verboseChat || (durMs !== undefined && durMs >= 2000)) {
            addLine(`  ✓ ${tool}${durMs !== undefined ? ` (${(durMs / 1000).toFixed(1)}s)` : ''}`, DIM_GRAY);
          }
        }
        break;
      }

      case 'tool:failed': {
        const tool = event.tool as string;
        const error = event.error as string;
        if (agent === rootAgentName) {
          state.toolStartedAt = null;
          addEvent(`[tool error] ${tool}: ${error}`, RED);
        } else if (agent) {
          const short = shortAgentName(agent);
          addEvent(`  [${short}] tool error: ${tool}: ${error}`, RED);
        }
        break;
      }

      case 'branches:changed': {
        const branchEvent = event.event as string;
        const branch = event.branch as string;
        const previous = event.previous as string | undefined;
        const source = event.source as string;

        if (branchEvent === 'switched') {
          resetBranchState(app.branchState);
          refreshFromStore();
          addEvent(`Branch switched: ${previous ?? '?'} → ${branch} (via ${source})`, CYAN);
        } else if (branchEvent === 'created') {
          addEvent(`Branch created: ${branch} (via ${source})`, CYAN);
        } else if (branchEvent === 'deleted') {
          addEvent(`Branch deleted: ${branch} (via ${source})`, CYAN);
        }
        updateStatus();
        break;
      }
    }
    if (rootEnd) showRootTurnEnd(rootEnd);
    else if (agent === rootAgentName && STREAM_END_TRACES.has(event.type as string)) updateStatus();
    if (agent === rootAgentName && failure) {
      if (failure.show !== 'ended') showFailure(agent, '', failure, RED);
      else {
        const ended = turnEndedLine(failure, failedTurnHint(failure.errorType));
        if (ended) addEvent(ended, RED);
      }
    }
  }

  const rootTraces = traceFollower(onTrace as (e: unknown) => void);

  let subMod = app.framework.getAllModules().find(m => m.name === 'subagent') as SubagentModule | undefined;
  let fleetMod = app.framework.getAllModules().find(m => m.name === 'fleet') as FleetModule | undefined;

  let treeAggregator: FleetTreeAggregator | null = null;
  function initTreeAggregator(): void {
    treeAggregator?.dispose();
    treeAggregator = fleetMod ? new FleetTreeAggregator(fleetMod) : null;
    if (treeAggregator && fleetMod) {
      for (const childName of fleetMod.getChildren().keys()) {
        treeAggregator.registerChild(childName);
      }
      treeAggregator.onTreeUpdate(() => {
        if (state.viewMode === 'fleet') updateFleetView();
      });
    }
  }
  initTreeAggregator();

  let fleetOpsUnsub: (() => void) | null = null;
  function subscribeFleetOps(): void {
    fleetOpsUnsub?.();
    fleetOpsUnsub = fleetMod?.onChildEvent('*', (childName, evt) => {
      if (evt.type !== 'ops:alert') return;
      const alert = opsAlertOf(evt as Record<string, unknown>, childName);
      handleOpsAlert(alert.kind, alert.agent, alert.message);
    }) ?? null;
  }
  subscribeFleetOps();

  const procPeekLogs = new Map<string, FleetLine[]>();
  function procLogKey(child: string, agentFilter?: string): string {
    return agentFilter ? `${child}#${agentFilter}` : child;
  }
  const procPeekTokenLine = new Map<string, string>();
  const procPeekLastEvent = new Map<string, WireEvent>();
  let procPeekUnsub: (() => void) | null = null;

  function appendProcPeekLog(name: string, text: string, color: string): void {
    if (!procPeekLogs.has(name)) procPeekLogs.set(name, []);
    const log = procPeekLogs.get(name)!;
    log.push({ text, color });
    if (log.length > PEEK_LOG_MAX_LINES) log.splice(0, log.length - PEEK_LOG_MAX_LINES);
  }

  const subagentStreamUnsubs: Array<() => void> = [];
  const subscribedSubagents = new Set<string>();

  const peekTokenLine = new Map<string, string>();

  function subscribeSubagentStream(name: string) {
    if (subscribedSubagents.has(name) || !subMod) return;
    subscribedSubagents.add(name);

    if (!peekLogs.has(name)) peekLogs.set(name, []);

    const unsub = subMod.onPeekStream(name, (event) => {
      switch (event.type) {
        case 'inference:started':
          subagentPhase.set(name, 'sending');
          appendPeekLog(name, '── inference round ──', DIM_GRAY);
          peekCurrentTool.set(name, null);
          peekTokenLine.delete(name);
          break;

        case 'tokens': {
          if (subagentPhase.get(name) !== 'streaming') subagentPhase.set(name, 'streaming');
          const prev = peekTokenLine.get(name) ?? '';
          const merged = prev + event.content;
          const parts = merged.split('\n');
          if (parts.length > 1) {
            for (let i = 0; i < parts.length - 1; i++) {
              if (parts[i]!.trim()) appendPeekLog(name, parts[i]!, WHITE);
            }
          }
          peekTokenLine.set(name, parts[parts.length - 1]!);
          break;
        }

        case 'tool_calls': {
          subagentPhase.set(name, 'invoking');
          const pending = peekTokenLine.get(name);
          if (pending?.trim()) appendPeekLog(name, pending, WHITE);
          peekTokenLine.delete(name);
          const toolNames = event.calls.map(c => c.name).join(', ');
          appendPeekLog(name, `→ ${toolNames}`, YELLOW);
          break;
        }

        case 'tool:started':
          subagentPhase.set(name, 'executing');
          peekCurrentTool.set(name, event.tool);
          appendPeekLog(name, `  ⟳ ${event.tool}`, GRAY);
          break;

        case 'tool:completed':
          if (peekCurrentTool.get(name) === event.tool) peekCurrentTool.set(name, null);
          appendPeekLog(name, `  ✓ ${event.tool} (${event.durationMs}ms)`, DIM_GRAY);
          break;

        case 'tool:failed':
          if (peekCurrentTool.get(name) === event.tool) peekCurrentTool.set(name, null);
          appendPeekLog(name, `  ✗ ${event.tool}: ${event.error}`, RED);
          break;

        case 'stream_resumed':
          subagentPhase.set(name, 'sending');
          appendPeekLog(name, '── stream resumed ──', DIM_GRAY);
          peekCurrentTool.set(name, null);
          peekTokenLine.delete(name);
          break;

        case 'inference:completed':
          break;

        case 'inference:turn_ended':
        case 'inference:aborted':
        case 'inference:failed':
        case 'inference:exhausted': {
          const pending = peekTokenLine.get(name);
          if (pending?.trim()) appendPeekLog(name, pending, WHITE);
          peekTokenLine.delete(name);
          peekCurrentTool.set(name, null);
          const end = peekEndLine(event);
          if (end) appendPeekLog(name, end.text, peekEndColor(end.tone));
          break;
        }

        case 'done': {
          subagentPhase.set(name, 'done');
          const pendingTok = peekTokenLine.get(name);
          if (pendingTok?.trim()) appendPeekLog(name, pendingTok, WHITE);
          peekTokenLine.delete(name);
          peekCurrentTool.set(name, null);

          const summary = event.summary;
          const truncated = summary.length > 100 ? summary.slice(0, 97) + '...' : summary;
          appendPeekLog(name, `── done: ${truncated} ──`, DIM_GRAY);

          if (event.lastInputTokens) {
            agentContextTokens.set(name, event.lastInputTokens);
          }

          const limit = verboseChat ? 200 : 100;
          const chatTruncated = summary.length > limit ? summary.slice(0, limit - 3) + '...' : summary;
          addEvent(`  ◀ [${name}] ${chatTruncated}`, verboseChat ? CYAN : DIM_GRAY);
          break;
        }
      }

      if (state.viewMode === 'peek' && state.peekTarget === name) updatePeekView();
      if (state.viewMode === 'fleet') {
        state.subagents = [...subMod!.activeSubagents.values()];
        updateFleetView();
      }
    });
    subagentStreamUnsubs.push(unsub);
  }

  function resetObservabilityState(): void {
    for (const unsub of subagentStreamUnsubs) unsub();
    subagentStreamUnsubs.length = 0;
    subscribedSubagents.clear();
    peekLogs.clear();
    peekCurrentTool.clear();
    peekTokenLine.clear();
    procPeekLogs.clear();
    procPeekTokenLine.clear();
    procPeekLastEvent.clear();
    agentTranscripts.clear();
    transcriptTotalLen.clear();
    agentContextTokens.clear();
    streamUsage.clear();
    agentParent.clear();
    summaryCache.clear();
    summarySnapshotLen.clear();
    summaryPending.clear();
    summaryBackoffUntil.clear();
    subagentPhase.clear();
    subagentFailureShown.clear();
    state.subagents = [];
    seenFleetHeaders.clear();
    expandedNodes.clear();
    expandedNodes.add(rootAgentName);
    fleetCursor = 0;
    initTreeAggregator();
  }

  let releaseQuotaWatch: (() => void) | undefined;
  let unsubQuota: (() => void) | undefined;
  if (app.quotaMeter) {
    const meter = app.quotaMeter;
    state.tokens.quota = formatQuotaReadout(meter.getSnapshot());
    unsubQuota = meter.onChange((snapshot) => {
      state.tokens.quota = formatQuotaReadout(snapshot);
      updateStatus();
    });
    releaseQuotaWatch = meter.watch();
  } else if (app.subscriptionUnmetered) {
    state.tokens.quota = '';
  }
  if (app.credentials) {
    const state = app.credentials.snapshot();
    if (state.kind !== 'ok') handleOpsAlert(state.kind, rootAgentName, state.message + credentialActionHint(state));
  }

  const pollTimer = setInterval(() => {
    if (state.status !== 'idle' && state.status !== 'error') {
      spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
    }

    if (subMod) {
      state.subagents = [...subMod.activeSubagents.values()];
      for (const sa of state.subagents) {
        subscribeSubagentStream(sa.name);
      }
      if (state.viewMode === 'fleet') updateFleetView();
      else if (state.viewMode === 'peek') updatePeekView();
    }
    updateStatus();
    if (fleetMod) {
      if (treeAggregator) {
        const known = new Set(treeAggregator.getAllChildNames());
        for (const name of fleetMod.getChildren().keys()) {
          if (!known.has(name)) treeAggregator.registerChild(name);
        }
      }
      if (state.viewMode === 'peek-proc') updatePeekProcView();
    }
    if (state.viewMode === 'fleet') {
      generateSummary(rootAgentName);
      for (const sa of state.subagents) {
        const full = [...agentTranscripts.keys()].find(k => k === sa.name || shortAgentName(k) === sa.name);
        if (full) generateSummary(full);
      }
    }
  }, 500);

  renderer.keyInput.on('keypress', (key: { name?: string; ctrl?: boolean }) => {
    // OpenTUI's destroy hands the keys still buffered to these handlers,
    // so keys typed as the stop begins can reach them once it has: they
    // start nothing then.
    if (stopping) return;
    if (key.name === 'tab') {
      cleanupPeek();
      cleanupPeekProc();
      const next = state.viewMode === 'chat'
        ? ((subMod || fleetMod) ? 'fleet' : 'chat')
        : 'chat';
      switchView(next);
      updateStatus();
      return;
    }
    if (key.ctrl && key.name === 'f' && (subMod || fleetMod)) {
      cleanupPeek();
      cleanupPeekProc();
      switchView(state.viewMode === 'fleet' ? 'chat' : 'fleet');
      updateStatus();
      return;
    }
    if (key.ctrl && key.name === 'c') {
      if (!state.pendingQuitConfirm && promptQuitConfirmIfNeeded()) return;
      cleanup();
      return;
    }
    if (key.ctrl && key.name === 'v') {
      verboseChat = !verboseChat;
      addLine(verboseChat ? '(verbose: on — showing agent thoughts & subagent results)' : '(verbose: off)', DIM_GRAY);
      return;
    }
    if (key.ctrl && key.name === 'b' && (state.viewMode === 'chat' || state.viewMode === 'fleet')) {
      let acted = false;

      if (subMod?.hasDetachable()) {
        const detached = subMod.detachAll();
        if (detached > 0) {
          addLine(`  (${detached} sync subagent${detached > 1 ? 's' : ''} moved to background)`, CYAN);
          acted = true;
        }
      }

      if (streaming && state.status !== 'idle') {
        endStream();
        backgrounded = true;
        addLine('  (researcher moved to background — result will appear when done)', CYAN);
        updateStatus();
        acted = true;
      }

      if (!acted) {
        addLine('  (nothing to background)', DIM_GRAY);
      }
      return;
    }

    if (key.name === 'escape' && state.viewMode === 'chat') {
      if (escapeActs(state.status, interrupts.isRunning(rootAgentName))) {
        const reason = 'interrupted from the TUI';
        const cancelled = interruptSubagents(
          app.framework.getAllAgents().map(a => a.name),
          name => subMod?.isSubagentAgent(name) ?? false,
          interrupts,
          () => subMod?.cancelAll() ?? 0,
          reason,
        ).stopped;
        const agent = app.framework.getAgent(rootAgentName);
        if (agent) {
          const stopped = cancelled > 0 ? `${cancelled} subagent${cancelled > 1 ? 's' : ''} stopped` : '';
          const shown = escapeLine(interrupts.interrupt(rootAgentName, reason), stopped);
          if (shown.endsTurn) {
            if (streaming) endStream();
            if (backgrounded) {
              backgrounded = false;
              backgroundBuffer = '';
            }
            state.status = 'idle';
            state.tool = null;
          }
          if (shown.text) addLine(shown.text, YELLOW);
          if (shown.endsTurn) updateStatus();
        }
      }
      return;
    }

    if (state.viewMode === 'peek') {
      if (key.name === 'escape' || key.name === 'p') {
        cleanupPeek();
        switchView('fleet');
        updateStatus();
      }
      return;
    }

    if (state.viewMode === 'peek-proc') {
      if (key.name === 'escape' || key.name === 'p') {
        cleanupPeekProc();
        switchView('fleet');
        updateStatus();
      }
      return;
    }

    if (state.viewMode === 'fleet') {
      if (key.name === 'escape') {
        switchView('chat');
        updateStatus();
      } else if (key.name === 'up') {
        fleetCursor = Math.max(0, fleetCursor - 1);
        updateFleetView();
      } else if (key.name === 'down') {
        fleetCursor = Math.min(visibleNodeIds.length - 1, fleetCursor + 1);
        updateFleetView();
      } else if (key.name === 'return' || key.name === 'right') {
        const nodeId = visibleNodeIds[fleetCursor];
        if (nodeId) {
          if (expandedNodes.has(nodeId)) expandedNodes.delete(nodeId);
          else expandedNodes.add(nodeId);
          updateFleetView();
        }
      } else if (key.name === 'left') {
        const nodeId = visibleNodeIds[fleetCursor];
        if (nodeId) {
          expandedNodes.delete(nodeId);
          updateFleetView();
        }
      } else if (key.name === 'p') {
        const nodeId = visibleNodeIds[fleetCursor];
        const node = nodeId ? visibleNodes.get(nodeId) : undefined;
        if (node && node.kind !== 'researcher') {
          if (node.kind === 'fleet-child') {
            enterPeekProc(node.fleetChildName!);
          } else if (node.kind === 'fleet-child-agent') {
            enterPeekProc(node.fleetChildName!, node.fullName);
          } else {
            enterPeek(nodeId!);
          }
        }
      } else if (key.name === 'delete' || key.name === 'backspace') {
        const nodeId = visibleNodeIds[fleetCursor];
        const node = nodeId ? visibleNodes.get(nodeId) : undefined;
        if (node && node.kind !== 'researcher') {
          if (node.kind === 'fleet-child' && fleetMod) {
            const childName = node.fleetChildName!;
            const refused = refusedWhileSwitching(app, `stop ${childName}`);
            if (refused) {
              showFleetNotice(refused);
              return;
            }
            trackOperatorWork(app, `stop ${childName}`, fleetMod.handleToolCall({ id: `tui-kill-${Date.now()}`, name: 'kill', input: { name: childName } }))
              .then((res) => {
                if (!res.success) showFleetNotice(`stop ${childName} failed: ${res.error ?? 'unknown'}`);
                updateFleetView();
              })
              .catch((err: unknown) => showFleetNotice(`stop ${childName} failed: ${String(err)}`));
          } else if (node.kind === 'subagent') {
            const sa = state.subagents.find(s => s.name === nodeId);
            if (sa?.status === 'running' && subMod) {
              if (subMod.cancelSubagent(nodeId!)) {
                addLine(`  ■ [${nodeId}] stopped by user`, YELLOW);
              }
            }
          }
        }
      } else if (key.name === 'r') {
        const nodeId = visibleNodeIds[fleetCursor];
        const node = nodeId ? visibleNodes.get(nodeId) : undefined;
        if (node?.kind === 'fleet-child' && fleetMod) {
          const childName = node.fleetChildName!;
          const refused = refusedWhileSwitching(app, `restart ${childName}`);
          if (refused) {
            showFleetNotice(refused);
            return;
          }
          trackOperatorWork(app, `restart ${childName}`, fleetMod.handleToolCall({ id: `tui-restart-${Date.now()}`, name: 'restart', input: { name: childName } }))
            .then((res) => {
              if (!res.success) showFleetNotice(`restart ${childName} failed: ${res.error ?? 'unknown'}`);
              updateFleetView();
            })
            .catch((err: unknown) => showFleetNotice(`restart ${childName} failed: ${String(err)}`));
        }
      }
    }
  });

  let resolveExit: (() => void) | null = null;
  let rejectExit: ((error: unknown) => void) | null = null;

  function promptQuitConfirmIfNeeded(): boolean {
    const running = fleetMod
      ? [...fleetMod.getChildren().values()].filter((c) => c.status === 'ready' || c.status === 'starting')
      : [];
    if (running.length === 0) return false;
    if (state.viewMode !== 'chat') {
      cleanupPeek();
      cleanupPeekProc();
      switchView('chat');
    }
    addLine(`  ${running.length} child${running.length > 1 ? 'ren' : ''} still running: ${running.map(c => c.name).join(', ')}`, YELLOW);
    addLine('  Stop them before exit? [y/N/d]  — y=kill gracefully, d=detach and leave running, anything else cancels', YELLOW);
    state.pendingQuitConfirm = true;
    updateStatus();
    return true;
  }

  function handleSubmit() {
    if (stopping) return;
    const raw = ((input as any).plainText as string).trim();
    (input as any).clear();

    if (state.pendingQuitConfirm) {
      state.pendingQuitConfirm = false;
      const action = resolveQuitConfirm(raw);
      if (action === 'kill') {
        addLine('  (stopping children and exiting...)', GRAY);
        cleanup();
        return;
      }
      if (action === 'detach') {
        fleetMod?.setDetachMode(true);
        addLine('  (detaching — children stay running; next parent will adopt them)', CYAN);
        cleanup();
        return;
      }
      if (action === 'cancel-keep-input') {
        (input as any).insertText(raw);
        addLine('  (quit cancelled — your message was restored to the input; press Enter to send)', GRAY);
      } else {
        pastedTexts.length = 0;
        addLine('  (quit cancelled)', GRAY);
      }
      return;
    }

    if (!raw) { pastedTexts.length = 0; return; }

    const text = pastedTexts.length > 0
      ? raw.replace(PASTE_PLACEHOLDER, (m, n) => pastedTexts[parseInt(n, 10) - 1] ?? m)
      : raw;
    pastedTexts.length = 0;

    if (text.startsWith('/')) {
      const result = handleCommand(text, app);
      if (result.quit) {
        if (promptQuitConfirmIfNeeded()) return;
        cleanup();
        return;
      }
      if (text === '/clear' || text.startsWith('/clear ')) {
        // End any live stream first — its renderable is about to be
        // destroyed, and streamToken must not write to a freed buffer.
        if (streaming) endStream();
        const children = [...scrollBox.getChildren()];
        for (const child of children) {
          scrollBox.remove(child.id);
          child.destroy();
        }
      } else {
        for (const l of result.lines) {
          addLine(l.text, GRAY);
        }
      }

      if (result.branchChanged) {
        refreshFromStore();
      }

      if (result.asyncWork) {
        state.status = 'thinking';
        updateStatus();
        result.asyncWork.then(asyncResult => {
          for (const l of asyncResult.lines) {
            addLine(l.text, GRAY);
          }
          state.status = 'idle';
          updateStatus();
        }).catch(err => {
          addLine(`Async command failed: ${err}`, RED);
          state.status = 'error';
          updateStatus();
        });
      }

      if (result.switchToSessionId) {
        state.status = 'switching';
        updateStatus();
        interrupts.reset();
        rootTurnShowing = false;
        turnFailures = createTurnFailures();
        failureLines.clear();

        const sessionId = result.switchToSessionId;
        const follower = {
          follow: (source: Parameters<typeof rootTraces.follow>[0]) => { if (!stopping) rootTraces.follow(source); },
          stop: () => rootTraces.stop(),
        };
        void switchFollowing(follower, async () => {
          await app.switchSession(sessionId);
          if (stopping) return;
          subMod = app.framework.getAllModules().find(m => m.name === 'subagent') as SubagentModule | undefined;
          fleetMod = app.framework.getAllModules().find(m => m.name === 'fleet') as FleetModule | undefined;
          subscribeFleetOps();
          resetObservabilityState();
        }, () => app.framework).then(() => {
          if (stopping) return;
          const session = app.sessionManager.getActiveSession();
          refreshFromStore();
          addLine(`Session: ${session?.name ?? 'unknown'}`, GRAY);
          state.tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
            ...(state.tokens.quota !== undefined ? { quota: state.tokens.quota } : {}) };
          state.ctxTokens = 0;
          opsAlerts.clear();
          updateStatus();
        }).catch(err => {
          addLine(`Session switch failed: ${err}`, RED);
          state.status = 'error';
          updateStatus();
        });
      }

      if (result.switchToFleetView) {
        cleanupPeek();
        cleanupPeekProc();
        switchView('fleet');
        updateStatus();
      }

      if (result.switchToFleetPeek) {
        cleanupPeek();
        enterPeekProc(result.switchToFleetPeek);
        updateStatus();
      }
    } else {
      const route = parseFleetRoute(text);
      if (route && fleetMod) {
        const child = fleetMod.getChildren().get(route.childName);
        if (!child) {
          addLine(`  (unknown child: ${route.childName})`, RED);
          return;
        }
        addEvent(`You → @${route.childName}: ${route.content}`, CYAN);
        fleetMod.handleToolCall({
          id: `tui-route-${Date.now()}`,
          name: 'send',
          input: { name: route.childName, content: route.content },
        }).then((res) => {
          if (!res.success) addLine(`  (send to ${route.childName} failed: ${res.error ?? 'unknown'})`, RED);
        }).catch((err: unknown) => {
          addLine(`  (send to ${route.childName} failed: ${String(err)})`, RED);
        });
        return;
      }
      addEvent(`You: ${raw}`, GREEN);
      const agent = app.framework.getAgent(rootAgentName);
      const agentBusy = agent && (agent.state.status === 'streaming' || agent.state.status === 'inferring' || agent.state.status === 'waiting_for_tools');
      state.status = agentBusy ? 'queued' : 'thinking';
      updateStatus();
      app.framework.pushEvent({
        type: 'external-message', source: 'tui',
        content: text, metadata: {}, triggerInference: true,
      });
    }
  }

  const session = app.sessionManager.getActiveSession();
  addLine(`${recipeName}. Type /help for commands.`, GRAY);
  if (session) addLine(`Session: ${session.name}`, DIM_GRAY);
  addLine(`Error log: ${logPath}`, DIM_GRAY);
  rootTraces.follow(app.framework);
  loadSessionHistory();
  // Printed at start too, but the alternate screen OpenTUI draws on hides
  // that line.
  if (bunFloorNotice) addLine(bunFloorNotice, YELLOW);

  const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);
  const STOP_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
  const LOG_CLOSE_LIMIT_MS = 2_000;
  let logEnded = false;

  function cleanup() {
    if (stopping) return;
    stopping = true;
    app.stopping = true;
    // OpenTUI's destroy removes its own signal listeners, so a second stop
    // signal during the stop would end the process by default. These join the
    // stop instead, until it settles.
    for (const signal of STOP_SIGNALS) process.on(signal, cleanup);
    const step = (what: string, run: () => void): void => {
      try {
        run();
      } catch (error) {
        logStream.write(`stopping: ${what} failed (${describe(error)}); the stop goes on\n`);
      }
    };
    step('clearing the poll timer', () => clearInterval(pollTimer));
    step('clearing the fleet notice', () => { if (fleetNoticeTimer) clearTimeout(fleetNoticeTimer); });
    step('ending the trace subscription', () => rootTraces.stop());
    step('ending the fleet subscription', () => fleetOpsUnsub?.());
    step('ending the subagent tree', () => treeAggregator?.dispose());
    for (const unsub of subagentStreamUnsubs) step('ending a subagent stream', unsub);
    step('releasing the quota watch', () => releaseQuotaWatch?.());
    step('ending the quota subscription', () => unsubQuota?.());
    step('closing the peek', cleanupPeek);
    step('closing the fleet peek', cleanupPeekProc);
    step('destroying the renderer', () => renderer.destroy());
    step('resetting the title', () => { process.stdout.write('\x1b]0;\x07'); });
    process.stderr.write = origStderrWrite;
    const settled = async (): Promise<void> => {
      logEnded = true;
      await new Promise<void>((done) => {
        const limit = setTimeout(() => {
          console.error(`[host] tui-error.log hadn't taken its last lines after ${LOG_CLOSE_LIMIT_MS / 1000} s, so the TUI ends without them`);
          done();
        }, LOG_CLOSE_LIMIT_MS);
        logStream.end(() => { clearTimeout(limit); done(); });
      });
      for (const signal of STOP_SIGNALS) process.off(signal, cleanup);
    };
    // agent-framework's stop() gives a later call the stop under way, or the
    // one that finished, and after a failed stop whose storage is still open it
    // starts the teardown again.
    Promise.resolve().then(() => app.framework.stop()).then(async () => {
      await settled();
      resolveExit?.();
    }, async (error) => {
      await settled();
      rejectExit?.(error);
    });
  }

  hostUpdate.attachStop({
    supervised: false,
    stop: (_reason, farewell) => { setTimeout(() => { cleanup(); console.log(farewell); }, 0); },
  });

  // OpenTUI destroys the renderer itself on SIGTERM, SIGINT, SIGHUP and its
  // other exit signals, so the TUI stops on its destroy, as /quit does.
  renderer.on(CliRenderEvents.DESTROY, cleanup);
  // With the terminal gone (its window or SSH session closed), OpenTUI's
  // destroy fails turning raw mode off, and the title reset fails writing,
  // each as an error on stdin or stdout. Unheard, either would end the process
  // before the TUI stopped.
  let terminalReported = false;
  const terminalFailed = (error: unknown): void => {
    if (!terminalReported && !logEnded) {
      terminalReported = true;
      logStream.write(`terminal failed (${describe(error)}): stopping as /quit does\n`);
    }
    cleanup();
  };
  process.stdin.on('error', terminalFailed);
  process.stdout.on('error', terminalFailed);

  await new Promise<void>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
}

function formatStatusLeft(
  state: TuiState,
  spinnerChar?: string,
  outputTokens?: number,
  alertCount = 0,
  topAlertKind: string | null = null,
  rootTurnRunning = false,
): string {
  const sColor = state.status === 'idle' ? '✓' : state.status === 'error' ? '✗' : state.status === 'background' ? '↓' : state.status === 'queued' ? '⏳' : '…';
  let bar = `[${sColor} ${state.status}`;
  if (alertCount > 0) {
    const kind = topAlertKind && topAlertKind.length > 26 ? topAlertKind.slice(0, 25) + '…' : topAlertKind;
    bar += ` | ⚠ ${alertCount}${kind ? ` · ${kind}` : ''}`;
  }
  if (spinnerChar !== undefined && state.status !== 'idle' && state.status !== 'error' && state.status !== 'background') {
    bar += ` ${spinnerChar}`;
    if (state.status === 'thinking' && outputTokens !== undefined && outputTokens > 0) {
      const tokStr = outputTokens >= 1000 ? (outputTokens / 1000).toFixed(1) + 'k' : String(outputTokens);
      bar += ` ${tokStr} tok`;
    }
  }
  if (state.tool) {
    const tool = state.tool.length > 40 ? state.tool.slice(0, 37) + '…' : state.tool;
    bar += ` | ${tool}`;
    if (state.toolStartedAt) {
      const secs = Math.floor((Date.now() - state.toolStartedAt) / 1000);
      if (secs >= 5) bar += ` ${fmtElapsed(secs)}`;
    }
  }
  const running = state.subagents.filter(s => s.status === 'running').length;
  if (running > 0) {
    bar += ` | ${running} sub`;
  }
  if (state.viewMode === 'fleet' || state.viewMode === 'peek') {
    bar += state.viewMode === 'peek' ? ` | peek: ${state.peekTarget}` : ' | fleet view';
  } else if (state.viewMode === 'peek-proc') {
    bar += state.peekProcAgent
      ? ` | peek: ${state.peekProcTarget}›${state.peekProcAgent}`
      : ` | peek-proc: ${state.peekProcTarget}`;
  } else if (state.viewMode === 'chat') {
    if (escapeActs(state.status, rootTurnRunning)) {
      bar += state.status === 'background' || state.status === 'error' ? ' Esc:stop' : ' Ctrl+B:bg Esc:stop';
    }
    if (running > 0) bar += ' Tab:fleet';
  }
  bar += ']';
  return bar;
}

function formatTokens(tokens: TokenUsage, verbose: boolean, ctxTokens = 0, ctxBudget?: number): string {
  const parts: string[] = [];

  if (ctxTokens > 0) {
    parts.push(ctxBudget && ctxBudget > 0
      ? `ctx:${fmtTokens(ctxTokens)}/${fmtTokens(ctxBudget)}`
      : `ctx:${fmtTokens(ctxTokens)}`);
  }

  const total = tokens.input + tokens.output;
  if (total > 0) {
    let s = `Σ ${fmtTokens(tokens.input)}in ${fmtTokens(tokens.output)}out`;
    if (tokens.cacheRead > 0) s += ` ${fmtTokens(tokens.cacheRead)}hit`;
    if (tokens.cacheWrite > 0) s += ` ${fmtTokens(tokens.cacheWrite)}write`;
    if (tokens.quota === undefined && tokens.cost && tokens.cost.total > 0) {
      s += ` $${tokens.cost.total.toFixed(tokens.cost.total < 1 ? 3 : 2)}`;
    }
    parts.push(s);
  }
  if (tokens.quota) parts.push(tokens.quota);

  parts.push(verbose ? 'C-v:terse' : 'C-v:verbose');
  return parts.join('  ');
}

function formatMemStats(
  cm: { getRenderStats?: () => unknown; getStrategy?: () => { getStats?: () => unknown } } | null,
): string {
  if (!cm) return '';
  try {
    if (typeof cm.getRenderStats === 'function') {
      const r = cm.getRenderStats() as {
        head?: { messages: number; tokens: number };
        tail?: { messages: number; tokens: number };
        summaries?: {
          l1?: { count: number; tokens: number };
          l2?: { count: number; tokens: number };
          l3?: { count: number; tokens: number };
        };
        pending?: { chunks: number; merges: number };
      } | null;
      if (!r) return '';
      const sumLevel = (lvl?: { count: number; tokens: number }) =>
        lvl && lvl.count > 0 ? `${lvl.count}/${fmtTokens(lvl.tokens)}t` : null;
      const parts: string[] = [];
      const l1 = sumLevel(r.summaries?.l1);
      const l2 = sumLevel(r.summaries?.l2);
      const l3 = sumLevel(r.summaries?.l3);
      if (l1) parts.push(`L1=${l1}`);
      if (l2) parts.push(`L2=${l2}`);
      if (l3) parts.push(`L3=${l3}`);
      if (r.tail && r.tail.messages > 0) parts.push(`tail=${r.tail.messages}msg/${fmtTokens(r.tail.tokens)}t`);
      const tags: string[] = [];
      if (r.pending && r.pending.chunks > 0) tags.push(`${r.pending.chunks} pending`);
      if (r.pending && r.pending.merges > 0) tags.push(`${r.pending.merges} merge`);
      if (parts.length === 0 && tags.length === 0) return '';
      return `  mem: ${parts.join(' ')}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}`;
    }
    const strategy = cm.getStrategy?.();
    if (!strategy?.getStats) return '';
    const s = strategy.getStats() as {
      l1?: number; l2?: number; l3?: number;
      pendingMerges?: number;
      chunksTotal?: number; chunksCompressed?: number;
    };
    const l1 = s.l1 ?? 0;
    const l2 = s.l2 ?? 0;
    const l3 = s.l3 ?? 0;
    if (l1 === 0 && l2 === 0 && l3 === 0) return '';
    const pending = (s.chunksTotal ?? 0) - (s.chunksCompressed ?? 0);
    let out = `  mem: L1=${l1}`;
    if (l2 > 0) out += ` L2=${l2}`;
    if (l3 > 0) out += ` L3=${l3}`;
    if (pending > 0) out += ` (${pending} pending)`;
    if ((s.pendingMerges ?? 0) > 0) out += ` (${s.pendingMerges} merge)`;
    return out;
  } catch {
    return '';
  }
}
