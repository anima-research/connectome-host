import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { createWireClient, type WireClient } from './wire';
import { createTreeStore, type StreamSource, type UiNode } from './tree';
import { TreeSidebar } from './TreeSidebar';
import { StreamPanel } from './Stream';
import { formatStreamEvent, withStreamLines, type StreamLine } from '@conhost/web/stream-lines';
import { UsagePanel } from './Usage';
import { LessonsPanel, type LessonRow } from './Lessons';
import { McplPanel, type McplServerRow, type McplLiveRow, type ToolClassRow } from './Mcpl';
import { SettingsPanel, type SettingsState } from './Settings';
import { DryContext, type DryContextData } from './DryContext';
import { PinsPanel, type PinsState, type PinCandidate } from './Pins';
import { FilesPanel, FileViewerModal, type Mount, type FlatEntry, type FileViewer } from './Files';
import { ContextPanel } from './Context';
import { ContextDocument } from './ContextDocument';
import { ObserverGateScreen } from './ObserverGate';
import {
  OpsAlertStrip, HealthPanel, CREDENTIAL_ALERT_KINDS,
  type OpsAlert, type HealthSnapshot, type CredentialInfo, type CredentialAction,
} from './Health';
import { BranchPanel } from './Branches';
import { UpdateBanner, UpdateDialog } from './Update';
import { commandFor, dialogStill, keptDismissal, type UpdateStatus, type UpdateWay } from '@conhost/web/update-text';
import { createQuotaPoll, quotaReadout, quotaTitle, quotaTone, quotaUnreadable } from './quota';
import { planHealthAlerts } from './health-alerts';
import { HealthReads, passedGrant } from './health-reads';
import { healthReadError } from '@conhost/web/health-lookup';
import {
  AGENT_TREE_SCOPES,
  WEB_PROTOCOL_VERSION,
  isChildScope,
  type WebUiServerMessage,
  type WelcomeMessage,
  type WelcomeMessageEntry,
  type HistoryPageMessage,
  type MessageBlock,
  type TokenUsage,
  type QuotaSnapshotData,
  type PerAgentCost,
  type CallLedgerSnapshot,
  type BranchRow,
  type HostModeSnapshot,
  type SurgeryResultMessage,
  type OperatorLogEntryWire,
} from '@conhost/web/protocol';
import {
  applyStreamEnded, applyTrace, conversationAgentOf, streamEventFor, toolCallState, treesShownFor,
} from '@conhost/web/agent-streams';
import {
  Lightbox,
  MediaView,
  HostModeToggle,
  SurgeryDialog,
  SelectionBar,
  type SurgeryRequest,
} from './Surgery';

type UiBlock =
  | { kind: 'text'; text: string; truncated?: boolean; streaming?: boolean }
  | { kind: 'thinking'; text: string; truncated?: boolean; streaming?: boolean }
  | { kind: 'redacted_thinking'; bytes: number }
  | {
      kind: 'tool_use'; id: string; name: string; inputJson: string; truncated?: boolean;
      status?: 'running' | 'done' | 'failed';
      durationMs?: number;
    }
  | { kind: 'tool_result'; toolUseId: string; text: string; isError?: boolean; truncated?: boolean }
  | { kind: 'media'; mediaType: string; ref?: string; toolUseId?: string }
  | { kind: 'tool_draft'; text: string; streaming?: boolean };

interface Message {
  id: string;
  storeId?: string;
  participant: 'user' | 'assistant' | 'system' | 'tool' | 'command' | 'trigger';
  speaker?: string;
  text: string;
  blocks?: UiBlock[];
  index?: number;
  timestamp?: number;
  lines?: Array<{ text: string; style?: 'user' | 'agent' | 'tool' | 'system' }>;
  streaming?: boolean;
  trigger?: {
    origin: string;
    source: string;
    author?: string;
    triggered: boolean;
  };
}

let messageCounter = 0;
const nextMessageId = () => `m${++messageCounter}`;
const isSyntheticId = (id: string): boolean => /^m\d+$/.test(id);
let streamIdSeq = 0;
const streamLineId = (): number => ++streamIdSeq;

function entryToMessage(e: WelcomeMessageEntry): Message {
  return {
    id: e.id ?? nextMessageId(),
    ...(e.id ? { storeId: e.id } : {}),
    participant: e.participant,
    ...(e.speaker !== undefined ? { speaker: e.speaker } : {}),
    text: e.text,
    blocks: (e.blocks ?? []) as UiBlock[],
    index: e.index,
    timestamp: e.timestamp,
  };
}

export function App() {
  const wire = createWireClient();
  const treeStore = createTreeStore();
  const treesShown = (): boolean => treesShownFor(wire.observerState(), wire.observer()?.scopes ?? null);

  // A store, so a streaming token can mutate the last message in place: <For>
  // remounts a row given a new object, even one with the same id, which
  // replays the msg-enter fade on every token.
  const [messages, setMessages] = createStore<Message[]>([]);
  const [welcome, setWelcome] = createSignal<WelcomeMessage | null>(null);
  const [historyInfo, setHistoryInfo] = createSignal<{ startIndex: number; totalCount: number } | null>(null);
  const [historyLoading, setHistoryLoading] = createSignal(false);
  const [protoMismatch, setProtoMismatch] = createSignal<number | null>(null);
  let knownIds = new Set<string>();
  let welcomeKey: string | null = null;
  const [shownSession, setShownSession] = createSignal<string | null>(null);
  let atBottom = true;
  let historyCorrSeq = 0;
  let pendingHistoryCorr: string | null = null;
  let pendingHistoryTimer: number | undefined;
  const [usage, setUsage] = createSignal<TokenUsage>({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const quota = createQuotaPoll();
  const [perAgentCost, setPerAgentCost] = createSignal<PerAgentCost[]>([]);
  const [callLedger, setCallLedger] = createSignal<CallLedgerSnapshot | null>(null);
  const [draft, setDraft] = createSignal('');
  type PanelMode = 'stream' | 'usage' | 'branches';
  const [focusedId, setFocusedId] = createSignal<string | null>(null);
  const [focusedNode, setFocusedNode] = createSignal<UiNode | null>(null);
  const usageQuotaScope = (): string | null => {
    const src = focusedNode()?.streamSource;
    return src && (src.kind === 'child-event-all' || src.kind === 'child-event-agent') ? src.childName : null;
  };
  const focusedQuota = createQuotaPoll(usageQuotaScope);
  const [panelMode, setPanelMode] = createSignal<PanelMode | null>(null);
  const [streamLines, setStreamLines] = createSignal<StreamLine[]>([]);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set(['process:local']));
  const seenAutoExpand = new Set<string>(['process:local']);
  const [quitConfirm, setQuitConfirm] = createSignal<string[] | null>(null);

  /** agent-framework sends no `hard-down-clear`, so a `hard-down` row leaves
   *  only by a dismissal. */
  const [opsAlerts, setOpsAlerts] = createSignal<Map<string, OpsAlert>>(new Map());
  const alertList = createMemo(() =>
    [...opsAlerts().values()].sort((a, b) => b.at - a.at));

  const upsertOpsAlert = (kind: string, agent: string, message: string, bump = true, actions?: CredentialAction[]): void => {
    const key = `${agent}:${kind}`;
    setOpsAlerts((prev) => {
      const next = new Map(prev);
      const existing = next.get(key);
      next.set(key, {
        key,
        kind,
        agent,
        message,
        at: Date.now(),
        count: existing ? existing.count + (bump ? 1 : 0) : 1,
        scope: 'local',
        ...(actions ? { actions } : existing?.actions ? { actions: existing.actions } : {}),
      });
      return next;
    });
  };
  const removeOpsAlert = (key: string): void => {
    setOpsAlerts((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  };

  const applyOpsAlertTrace = (e: { [k: string]: unknown }): void => {
    const kind = typeof e.kind === 'string' ? e.kind : 'unknown';
    const agent = typeof e.agentName === 'string' ? e.agentName : '?';
    const message = typeof e.message === 'string' ? e.message : '';
    if (kind.endsWith('-clear')) {
      removeOpsAlert(`${agent}:${kind.slice(0, -'-clear'.length)}`);
      return;
    }
    upsertOpsAlert(kind, agent, message, true, readActions((e.data as { actions?: unknown } | undefined)?.actions));
  };

  const readActions = (raw: unknown): CredentialAction[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const out: CredentialAction[] = [];
    for (const a of raw) {
      const id = (a as { id?: unknown })?.id;
      const label = (a as { label?: unknown })?.label;
      if (typeof id !== 'string' || typeof label !== 'string') continue;
      const hint = (a as { hint?: unknown })?.hint;
      out.push({ id, label, ...(typeof hint === 'string' ? { hint } : {}) });
    }
    return out.length > 0 ? out : undefined;
  };

  const [credentialState, setCredentialState] = createSignal<{ scope: string; info: CredentialInfo } | null>(null);
  const credentialForScope = (): CredentialInfo | null => {
    const c = credentialState();
    return c && c.scope === panelScope() ? c.info : null;
  };

  let credentialFrameSeq = 0;
  const applyCredentialState = (c: CredentialInfo | undefined, scope: string, from: 'frame' | 'health' = 'frame'): void => {
    if (!c || c.subscription === false) return;
    if (from === 'frame') credentialFrameSeq++;
    setCredentialState({ scope, info: c });
    if (scope !== 'local') return;
    const agent = c.agent ?? '?';
    const kind = c.kind ?? 'ok';
    for (const k of CREDENTIAL_ALERT_KINDS) {
      const key = `${agent}:${k}`;
      if (k === kind) {
        if (opsAlerts().get(key)?.message !== c.message) {
          upsertOpsAlert(kind, agent, c.message ?? kind, false, c.actions);
        }
      } else {
        removeOpsAlert(key);
      }
    }
  };

  const runCredentialAction = (actionId: string, scope: string): void => {
    if (actionId === 'set-token') {
      const who = scope === 'local' ? 'this host' : `fleet child "${scope}"`;
      const token = window.prompt(`Paste the replacement token for ${who} (kept in memory; written to the credentials file only when that process loaded one):`);
      if (!token || !token.trim()) return;
      wire.send({ type: 'credential-action', scope, action: 'set-token', token: token.trim() });
      return;
    }
    if (actionId !== 'refresh' && actionId !== 'login' && actionId !== 'recheck') return;
    wire.send({ type: 'credential-action', scope, action: actionId });
  };

  const [health, setHealth] = createSignal<HealthSnapshot | null>(null);
  const [healthErr, setHealthErr] = createSignal<string | null>(null);
  const healthReads = new HealthReads();

  const reconcileHealthAlerts = (h: HealthSnapshot): void => {
    applyCredentialState(h.credential, 'local');
    const plan = planHealthAlerts(h, opsAlerts());
    for (const key of plan.remove) removeOpsAlert(key);
    for (const u of plan.upsert) {
      upsertOpsAlert(u.kind, u.agent, u.message, false);
    }
  };

  const loadHealth = async (force = false): Promise<void> => {
    if (healthReads.denied && !force) return;
    if (force) healthReads.denied = false;
    const scope = panelScope();
    const frameSeqAtStart = credentialFrameSeq;
    const asked = healthReads.ask();
    try {
      const res = await fetch(`/healthz${scopeQuery()}`, { credentials: 'same-origin' });
      if (!passedGrant(res.status)) {
        if (healthReads.refused(asked)) setHealthErr('403');
        return;
      }
      healthReads.answered(asked);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(healthReadError(res.status, body));
      }
      const h = (await res.json()) as HealthSnapshot;
      if (scope !== panelScope()) return;
      if (scope === 'local' && !healthReads.takeLocal(asked)) return;
      setHealth(h);
      setHealthErr(null);
      if (scope === 'local') {
        reconcileHealthAlerts(h);
        takeLocalUpdate(h.update ?? null);
      }
      else if (h.credential && credentialFrameSeq === frameSeqAtStart) applyCredentialState(h.credential, scope, 'health');
    } catch (e) {
      if (scope !== panelScope()) return;
      setHealthErr(e instanceof Error ? e.message : String(e));
    }
  };

  const reconcileLocalAlerts = async (): Promise<void> => {
    if (healthReads.denied) return;
    const asked = healthReads.ask();
    try {
      const res = await fetch('/healthz', { credentials: 'same-origin' });
      if (passedGrant(res.status)) healthReads.answered(asked);
      if (!res.ok) return;
      const h = (await res.json()) as HealthSnapshot;
      if (!healthReads.takeLocal(asked)) return;
      reconcileHealthAlerts(h);
      takeLocalUpdate(h.update ?? null);
    } catch { }
  };

  const [localUpdate, setLocalUpdate] = createSignal<UpdateStatus | null>(null);
  const [dismissedUpdate, setDismissedUpdate] = createSignal<string | null>(null);
  const [updateDialog, setUpdateDialog] = createSignal<'restart' | 'back' | null>(null);

  const takeLocalUpdate = (update: UpdateStatus | null): void => {
    setLocalUpdate(update);
    setDismissedUpdate((line) => keptDismissal(update, line));
    setUpdateDialog((open) => dialogStill(open, update));
  };

  const sendUpdateWay = (way: UpdateWay): void => {
    setUpdateDialog(null);
    const status = localUpdate();
    const command = status === null ? null : commandFor(way, status);
    if (isObserver() || command === null) return;
    setMainView('chat');
    wire.send({ type: 'command', command });
  };
  const runUpdateWay = (way: UpdateWay): void => {
    if (way === 'restart' || way === 'back') setUpdateDialog(way);
    else sendUpdateWay(way);
  };
  const refreshLocalUpdate = (): void => {
    if (panelScope() === 'local') void loadHealth();
    else void reconcileLocalAlerts();
  };
  createEffect(on(() => wire.observerState(), (state) => {
    if (state === 'observer') void loadHealth(true);
  }));

  const [branches, setBranches] = createSignal<BranchRow[]>([]);
  const [branchesCurrentId, setBranchesCurrentId] = createSignal<string | null>(null);
  const [branchesLoading, setBranchesLoading] = createSignal(false);

  const refreshBranches = (): void => {
    setBranchesLoading(true);
    wire.send({ type: 'request-branches' });
  };

  const checkoutBranch = (name: string): void => {
    wire.send({ type: 'command', command: `/checkout ${name}` });
  };

  const features = (): Set<string> => new Set(welcome()?.features ?? []);
  const isObserver = (): boolean => wire.observerState() === 'observer';
  const canRollback = (): boolean => features().has('rollback') && !isObserver();
  const canSuppress = (): boolean => features().has('suppress') && !isObserver();
  const canQuiesce = (): boolean => features().has('quiesce') && !isObserver();

  const [hostMode, setHostMode] = createSignal<HostModeSnapshot | null>(null);
  const [hostModeBusy, setHostModeBusy] = createSignal(false);
  const [surgery, setSurgery] = createSignal<SurgeryRequest | null>(null);
  const [surgeryPending, setSurgeryPending] = createSignal(false);
  const [surgeryResult, setSurgeryResult] = createSignal<SurgeryResultMessage | null>(null);
  let retryAfterQuiesce: { note: string } | null = null;
  let pendingSurgeryCorrId: string | null = null;
  const [selecting, setSelecting] = createSignal(false);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [opLog, setOpLog] = createSignal<OperatorLogEntryWire[]>([]);
  const [opLogPath, setOpLogPath] = createSignal<string | undefined>(undefined);
  const [opLogLoading, setOpLogLoading] = createSignal(false);

  const previewOf = (m: Message): string => {
    const who = m.participant === 'assistant' ? (conversationAgentOf(welcome()) ?? 'assistant') : m.participant;
    const body = (m.text || (m.blocks ?? []).map((b) => b.kind === 'tool_use' ? `⚙ ${b.name}` : b.kind === 'media' ? `📎 ${b.mediaType}` : '').filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim();
    return `${who}: ${body.slice(0, 90)}${body.length > 90 ? '…' : ''}`;
  };

  const beginRollback = (storeId: string, preview?: string, chosenIn: string | null = shownSession()): void => {
    if (!canRollback() || chosenIn === null) return;
    const idx = messages.findIndex((m) => m.storeId === storeId);
    const after = idx >= 0 ? messages.slice(idx + 1).filter((m) => m.storeId) : [];
    setSurgeryResult(null);
    setSurgery({
      op: 'rollback',
      sessionId: chosenIn,
      messageIds: [storeId],
      previews: [
        `new tail → ${idx >= 0 ? previewOf(messages[idx]) : (preview ?? storeId)}`,
        ...after.slice(0, 12).map((m) => `leaves: ${previewOf(m)}`),
        ...(after.length > 12 ? [`… and ${after.length - 12} more`] : []),
      ],
      ...(idx >= 0 ? { affected: after.length } : {}),
    });
  };

  const toggleSelected = (storeId: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(storeId)) next.delete(storeId); else next.add(storeId);
      return next;
    });
  };
  const clearSelection = (): void => { setSelected(new Set<string>()); setSelecting(false); };
  const startSelecting = (storeId?: string): void => {
    if (!canSuppress()) return;
    setSelecting(true);
    if (storeId) setSelected((prev) => new Set(prev).add(storeId));
  };
  const beginSuppressSelected = (): void => {
    const ids = [...selected()];
    const chosenIn = shownSession();
    if (ids.length === 0 || chosenIn === null) return;
    const byId = new Map(messages.filter((m) => m.storeId).map((m) => [m.storeId!, m]));
    setSurgeryResult(null);
    setSurgery({
      op: 'suppress',
      sessionId: chosenIn,
      messageIds: ids,
      previews: ids.map((id) => { const m = byId.get(id); return m ? previewOf(m) : id; }),
    });
  };

  const sendSurgery = (req: SurgeryRequest, note: string): void => {
    setSurgeryPending(true);
    const corrId = `srg-${Date.now()}`;
    pendingSurgeryCorrId = corrId;
    if (req.op === 'rollback') {
      wire.send({ type: 'rollback', messageId: req.messageIds[0], sessionId: req.sessionId, ...(note ? { note } : {}), corrId });
    } else {
      wire.send({ type: 'suppress', messageIds: req.messageIds, sessionId: req.sessionId, ...(note ? { note } : {}), corrId });
    }
  };
  const confirmSurgery = (note: string): void => {
    const req = surgery();
    if (req) sendSurgery(req, note);
  };
  const quiesceHost = (reason: string): void => {
    if (!canQuiesce()) return;
    setHostModeBusy(true);
    wire.send({ type: 'host-quiesce', ...(reason.trim() ? { reason: reason.trim() } : {}) });
  };
  const resumeHost = (): void => {
    if (!canQuiesce()) return;
    setHostModeBusy(true);
    wire.send({ type: 'host-resume' });
  };
  const quiesceAndRetry = (note: string): void => {
    retryAfterQuiesce = { note };
    setSurgeryResult(null);
    setSurgeryPending(true);
    quiesceHost(note || `${surgery()?.op ?? 'surgery'} via webui`);
  };
  const onHostMode = (hm: HostModeSnapshot): void => {
    setHostMode(hm);
    setHostModeBusy(false);
    if (retryAfterQuiesce && hm.mode === 'quiesced') {
      const req = surgery();
      const { note } = retryAfterQuiesce;
      retryAfterQuiesce = null;
      if (req) sendSurgery(req, note); else setSurgeryPending(false);
    } else if (retryAfterQuiesce && hm.mode !== 'quiescing') {
      retryAfterQuiesce = null;
      setSurgeryPending(false);
    }
  };
  const onSurgeryResult = (r: SurgeryResultMessage): void => {
    if (r.corrId !== pendingSurgeryCorrId) return;
    pendingSurgeryCorrId = null;
    setSurgeryPending(false);
    setSurgeryResult(r);
    if (r.ok) clearSelection();
    if (panelMode() === 'branches') { refreshBranches(); refreshOpLog(); }
  };
  const closeSurgery = (): void => {
    if (surgeryPending()) return;
    retryAfterQuiesce = null;
    setSurgery(null);
    setSurgeryResult(null);
  };
  const stampFor = (scope: string, chosenIn: string | undefined): { sessionId?: string } =>
    isChildScope(scope) ? {} : { sessionId: chosenIn ?? '' };
  const panelKey = (): string =>
    isChildScope(panelScope()) ? `child|${panelScope()}` : `local|${shownSession() ?? ''}`;
  const dropWhatWasPrepared = (): void => {
    retryAfterQuiesce = null;
    pendingSurgeryCorrId = null;
    setSurgery(null);
    setSurgeryResult(null);
    setSurgeryPending(false);
    clearSelection();
    pendingHistoryCorr = null;
    setHistoryLoading(false);
    setBulkRemaining(0);
    setBranches([]);
    setBranchesCurrentId(null);
    if (isChildScope(panelScope())) return;
    setSettingsLoaded(false);
    setSettingsState(null);
    setPinsLoaded(false);
    setPinsState(null);
    if (sidebarTab() === 'settings') refreshSettings();
    if (sidebarTab() === 'pins') refreshPins();
  };
  const refreshOpLog = (): void => {
    if (!features().has('operator-log')) return;
    setOpLogLoading(true);
    wire.send({ type: 'request-operator-log', limit: 200 });
  };

  type SidebarTab = 'tree' | 'lessons' | 'mcp' | 'files' | 'context' | 'settings' | 'pins' | 'health';
  const [sidebarTab, setSidebarTab] = createSignal<SidebarTab>('tree');
  const [mainView, setMainView] = createSignal<'chat' | 'context' | 'dry'>('chat');
  const [dryContext, setDryContext] = createSignal<DryContextData | null>(null);

  const [panelScope, setPanelScope] = createSignal<string>('local');
  const scopeQuery = (): string =>
    panelScope() !== 'local' ? `?scope=${encodeURIComponent(panelScope())}` : '';
  const availableScopes = (): Array<{ id: string; label: string }> => {
    const w = welcome();
    const local = { id: 'local', label: w?.recipe.name ?? 'parent' };
    const children = (w?.childTrees ?? []).map(c => ({
      id: c.name,
      label: c.recipe?.name ? `${c.name} · ${c.recipe.name}` : c.name,
    }));
    return [local, ...children];
  };

  const [lessons, setLessons] = createSignal<LessonRow[]>([]);
  const [lessonsLoaded, setLessonsLoaded] = createSignal(false);
  const [lessonsModuleLoaded, setLessonsModuleLoaded] = createSignal(false);
  const refreshLessons = (): void => {
    setLessonsLoaded(false);
    wire.send({ type: 'request-lessons', scope: panelScope() });
  };

  const [mcplServers, setMcplServers] = createSignal<McplServerRow[]>([]);
  const [mcplLive, setMcplLive] = createSignal<McplLiveRow[]>([]);
  const [mcplToolClasses, setMcplToolClasses] = createSignal<ToolClassRow[] | undefined>(undefined);
  const [mcplLoaded, setMcplLoaded] = createSignal(false);
  const [mcplConfigPath, setMcplConfigPath] = createSignal('');
  const refreshMcpl = (): void => {
    setMcplLoaded(false);
    wire.send({ type: 'request-mcpl', scope: panelScope() });
  };
  const clearMcpl = (): void => {
    setMcplLoaded(false);
    setMcplServers([]);
    setMcplLive([]);
    setMcplToolClasses(undefined);
  };

  const [settingsState, setSettingsState] = createSignal<SettingsState | null>(null);
  const [settingsLoaded, setSettingsLoaded] = createSignal(false);
  const refreshSettings = (): void => {
    setSettingsLoaded(false);
    wire.send({ type: 'request-settings', scope: panelScope() });
  };

  const [pinsState, setPinsState] = createSignal<PinsState | null>(null);
  const [pinsLoaded, setPinsLoaded] = createSignal(false);
  const refreshPins = (): void => {
    setPinsLoaded(false);
    wire.send({ type: 'request-pins', scope: panelScope() });
  };

  const [mounts, setMounts] = createSignal<Mount[]>([]);
  const [mountsLoaded, setMountsLoaded] = createSignal(false);
  const [workspaceModuleLoaded, setWorkspaceModuleLoaded] = createSignal(false);
  const [treesByMount, setTreesByMount] = createSignal<Map<string, FlatEntry[]>>(new Map());
  const [expandedMounts, setExpandedMounts] = createSignal<Set<string>>(new Set());
  const [openFile, setOpenFile] = createSignal<FileViewer | null>(null);
  const [fileLoading, setFileLoading] = createSignal(false);
  const refreshMounts = (): void => {
    setMountsLoaded(false);
    setTreesByMount(new Map<string, FlatEntry[]>());
    setExpandedMounts(new Set<string>());
    wire.send({ type: 'request-workspace-mounts', scope: panelScope() });
  };
  const expandMount = (name: string): void => {
    setExpandedMounts(prev => new Set(prev).add(name));
    if (!treesByMount().has(name)) {
      wire.send({ type: 'request-workspace-tree', mount: name, scope: panelScope() });
    }
  };
  const collapseMount = (name: string): void => {
    setExpandedMounts(prev => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  };
  const requestFile = (path: string): void => {
    setOpenFile(null);
    setFileLoading(true);
    wire.send({ type: 'request-workspace-file', path, scope: panelScope() });
  };

  const changePanelScope = (scope: string): void => {
    if (scope === panelScope()) return;
    setPanelScope(scope);
    setLessonsLoaded(false);
    setLessons([]);
    setMountsLoaded(false);
    setMounts([]);
    setTreesByMount(new Map<string, FlatEntry[]>());
    setExpandedMounts(new Set<string>());
    setOpenFile(null);
    setFileLoading(false);
    clearMcpl();
    setSettingsLoaded(false);
    setSettingsState(null);
    setPinsLoaded(false);
    setPinsState(null);
    setHealth(null);
    setHealthErr(null);
    const tab = sidebarTab();
    if (tab === 'lessons') refreshLessons();
    if (tab === 'files') refreshMounts();
    if (tab === 'mcp') refreshMcpl();
    if (tab === 'settings') refreshSettings();
    if (tab === 'pins') refreshPins();
    if (tab === 'health') void loadHealth(true);
  };
  let streamTokenBuffer = '';

  const FLEET_BACKFILL_LIMIT = 80;
  const childEventBuffers = new Map<string, Array<{ type: string; [k: string]: unknown }>>();
  const recordChildEvent = (childName: string, event: { type: string; [k: string]: unknown }): void => {
    let buf = childEventBuffers.get(childName);
    if (!buf) {
      buf = [];
      childEventBuffers.set(childName, buf);
    }
    buf.push(event);
    if (buf.length > FLEET_BACKFILL_LIMIT) buf.splice(0, buf.length - FLEET_BACKFILL_LIMIT);
  };

  let scrollPane: HTMLDivElement | undefined;

  const appendStreamToken = (token: string, blockType?: string): void => {
    if (blockType === 'tool_result') return;
    const kind: 'text' | 'thinking' | 'tool_draft' =
      blockType === 'thinking' ? 'thinking'
      : blockType === 'tool_call' ? 'tool_draft'
      : 'text';
    setMessages(produce((arr) => {
      let last = arr[arr.length - 1];
      if (!last || !last.streaming) {
        arr.push({
          id: nextMessageId(),
          participant: 'assistant',
          text: '',
          blocks: [],
          streaming: true,
          timestamp: Date.now(),
        });
        last = arr[arr.length - 1]!;
      }
      const blocks = (last.blocks ??= []);
      let blk = blocks[blocks.length - 1];
      if (!blk || blk.kind !== kind || !(blk as { streaming?: boolean }).streaming) {
        blk = { kind, text: '', streaming: true } as UiBlock;
        blocks.push(blk);
      }
      (blk as { text: string }).text += token;
      if (kind === 'text') last.text += token;
    }));
    queueScroll();
  };

  const handleContentBlock = (phase: string): void => {
    if (phase !== 'block_complete') return;
    setMessages(produce((arr) => {
      const last = arr[arr.length - 1];
      if (!last?.streaming || !last.blocks) return;
      for (let i = last.blocks.length - 1; i >= 0; i--) {
        const b = last.blocks[i] as { streaming?: boolean };
        if (b.streaming) { b.streaming = false; break; }
      }
    }));
  };

  const appendToolUseBlocks = (calls: Array<{ id: string; name: string; input?: unknown }>): void => {
    setMessages(produce((arr) => {
      let last = arr[arr.length - 1];
      if (!last || !last.streaming) {
        arr.push({
          id: nextMessageId(),
          participant: 'assistant',
          text: '',
          blocks: [],
          streaming: true,
          timestamp: Date.now(),
        });
        last = arr[arr.length - 1]!;
      }
      let blocks = (last.blocks ??= []);
      if (blocks.some((b) => b.kind === 'tool_draft')) {
        last.blocks = blocks = blocks.filter((b) => b.kind !== 'tool_draft');
      }
      for (const b of blocks) {
        if ((b as { streaming?: boolean }).streaming) (b as { streaming?: boolean }).streaming = false;
      }
      for (const c of calls) {
        let inputJson: string;
        try { inputJson = JSON.stringify(c.input, null, 2) ?? 'null'; } catch { inputJson = '[unserializable]'; }
        blocks.push({ kind: 'tool_use', id: c.id, name: c.name, inputJson, status: 'running' });
      }
    }));
    queueScroll();
  };

  const updateToolStatus = (callId: string, status: 'done' | 'failed', durationMs?: number): void => {
    setMessages(produce((arr) => {
      for (let i = arr.length - 1; i >= 0 && i >= arr.length - 12; i--) {
        const blocks = arr[i]!.blocks;
        if (!blocks) continue;
        for (const b of blocks) {
          if (b.kind === 'tool_use' && b.id === callId) {
            b.status = status;
            if (durationMs !== undefined) b.durationMs = durationMs;
            return;
          }
        }
      }
    }));
  };

  const finishStream = (): void => {
    setMessages(produce((arr) => {
      const last = arr[arr.length - 1];
      if (last && last.streaming) {
        last.streaming = false;
        if (last.blocks) {
          for (const b of last.blocks) {
            if ((b as { streaming?: boolean }).streaming) (b as { streaming?: boolean }).streaming = false;
          }
        }
      }
    }));
  };

  const queueScroll = (): void => {
    queueMicrotask(() => {
      if (scrollPane && atBottom) scrollPane.scrollTop = scrollPane.scrollHeight;
    });
  };

  const applyWelcome = (msg: WelcomeMessage): void => {
    if (msg.protocolVersion !== WEB_PROTOCOL_VERSION) {
      setProtoMismatch(msg.protocolVersion);
      return;
    }
    setProtoMismatch(null);
    setWelcome(msg);
    if (panelScope() !== 'local' && !msg.childTrees.some((c) => c.name === panelScope())) {
      changePanelScope('local');
    }
    if (shownSession() !== null && msg.session.id !== shownSession()) {
      clearMcpl();
      if (sidebarTab() === 'mcp') refreshMcpl();
      closePanel();
    }
    if (msg.session.id !== shownSession()) dropWhatWasPrepared();
    setShownSession(msg.session.id);
    const key = `${msg.session.id}/${msg.branch.id}`;
    const entries = msg.messages.map(entryToMessage);

    if (key !== welcomeKey) {
      welcomeKey = key;
      knownIds = new Set(entries.map((m) => m.id).filter((id) => !isSyntheticId(id)));
      setMessages(entries);
      setHistoryInfo({ startIndex: msg.history.startIndex, totalCount: msg.history.totalCount });
      atBottom = true;
      queueScroll();
      return;
    }

    setMessages(produce((arr) => {
      const kept = arr.filter(
        (m) => typeof m.index === 'number' && m.index < msg.history.startIndex && !isSyntheticId(m.id),
      );
      arr.length = 0;
      arr.push(...kept, ...entries);
    }));
    knownIds = new Set(
      messages.map((m) => m.id).filter((id) => !isSyntheticId(id)),
    );
    setHistoryInfo((prev) => ({
      startIndex: Math.min(prev?.startIndex ?? msg.history.startIndex, msg.history.startIndex),
      totalCount: msg.history.totalCount,
    }));
    queueScroll();
  };

  const applyAppended = (entry: WelcomeMessageEntry): void => {
    if (entry.id && knownIds.has(entry.id)) return;
    if (entry.id) knownIds.add(entry.id);
    const incoming = entryToMessage(entry);
    setMessages(produce((arr) => {
      const last = arr[arr.length - 1];
      if (incoming.participant === 'assistant' && last?.participant === 'assistant' && last.streaming) {
        const statusById = new Map<string, { status?: 'running' | 'done' | 'failed'; durationMs?: number }>();
        for (const b of last.blocks ?? []) {
          if (b.kind === 'tool_use') statusById.set(b.id, { status: b.status, durationMs: b.durationMs });
        }
        for (const b of incoming.blocks ?? []) {
          if (b.kind === 'tool_use') {
            const s = statusById.get(b.id);
            if (s?.status) { b.status = s.status; b.durationMs = s.durationMs; }
          }
        }
        arr[arr.length - 1] = incoming;
        return;
      }
      if (incoming.participant === 'user') {
        for (let i = arr.length - 1; i >= Math.max(0, arr.length - 3); i--) {
          const m = arr[i]!;
          if (m.participant === 'user' && isSyntheticId(m.id) && m.text === incoming.text) {
            arr[i] = incoming;
            return;
          }
        }
      }
      arr.push(incoming);
    }));
    setHistoryInfo((prev) => prev
      ? { ...prev, totalCount: Math.max(prev.totalCount, (entry.index ?? prev.totalCount) + 1) }
      : prev);
    queueScroll();
  };

  const HISTORY_PAGE_CAP = 500;
  const [bulkRemaining, setBulkRemaining] = createSignal(0);
  const [bulkLoaded, setBulkLoaded] = createSignal(0);

  const requestOlder = (limit = 200): void => {
    const info = historyInfo();
    if (!info || info.startIndex <= 0 || historyLoading() || protoMismatch() !== null) return;
    const corrId = `h${++historyCorrSeq}`;
    pendingHistoryCorr = corrId;
    setHistoryLoading(true);
    wire.send({ type: 'request-history', corrId, beforeIndex: info.startIndex, limit: Math.min(limit, HISTORY_PAGE_CAP) });
    window.clearTimeout(pendingHistoryTimer);
    pendingHistoryTimer = window.setTimeout(() => {
      if (pendingHistoryCorr === corrId) {
        pendingHistoryCorr = null;
        setHistoryLoading(false);
        setBulkRemaining(0);
      }
    }, 10_000);
  };

  const loadOlder = (n: number): void => {
    const info = historyInfo();
    if (!info || info.startIndex <= 0) return;
    const want = Math.min(n, info.startIndex);
    setBulkLoaded(0);
    setBulkRemaining(want);
    requestOlder(Math.min(want, HISTORY_PAGE_CAP));
  };
  const stopLoadOlder = (): void => { setBulkRemaining(0); };

  const applyHistoryPage = (msg: HistoryPageMessage): void => {
    if (msg.corrId !== pendingHistoryCorr) return;
    pendingHistoryCorr = null;
    window.clearTimeout(pendingHistoryTimer);
    setHistoryLoading(false);
    if (msg.sessionId !== shownSession()) {
      setBulkRemaining(0);
      return;
    }
    const fresh = msg.entries.filter((e) => !(e.id && knownIds.has(e.id)));
    for (const e of fresh) if (e.id) knownIds.add(e.id);
    const prevScrollHeight = scrollPane?.scrollHeight ?? 0;
    const prevScrollTop = scrollPane?.scrollTop ?? 0;
    setMessages(produce((arr) => arr.unshift(...fresh.map(entryToMessage))));
    setHistoryInfo((prev) => ({
      startIndex: msg.startIndex,
      totalCount: msg.totalCount > 0 ? msg.totalCount : prev?.totalCount ?? 0,
    }));
    requestAnimationFrame(() => {
      if (scrollPane) scrollPane.scrollTop = scrollPane.scrollHeight - prevScrollHeight + prevScrollTop;
    });
    const remaining = Math.max(0, bulkRemaining() - msg.entries.length);
    setBulkLoaded((v) => v + msg.entries.length);
    setBulkRemaining(remaining);
    if (remaining > 0 && msg.startIndex > 0 && msg.entries.length > 0) {
      requestOlder(Math.min(remaining, HISTORY_PAGE_CAP));
    } else if (remaining > 0) {
      setBulkRemaining(0);
    }
  };

  const onScrollPane = (): void => {
    if (!scrollPane) return;
    atBottom = scrollPane.scrollHeight - scrollPane.scrollTop - scrollPane.clientHeight < 80;
    if (scrollPane.scrollTop < 400) requestOlder();
  };

  const toolResults = createMemo(() => {
    const map = new Map<string, { text: string; isError?: boolean; truncated?: boolean }>();
    for (const m of messages) {
      for (const b of m.blocks ?? []) {
        if (b.kind === 'tool_result') map.set(b.toolUseId, b);
      }
    }
    return map;
  });

  const toolUseIds = createMemo(() => {
    const set = new Set<string>();
    for (const m of messages) {
      for (const b of m.blocks ?? []) {
        if (b.kind === 'tool_use') set.add(b.id);
      }
    }
    return set;
  });

  const appendStreamPaneToken = (text: string): void => {
    streamTokenBuffer += text;
    const newlineIdx = streamTokenBuffer.lastIndexOf('\n');
    if (newlineIdx < 0) return;
    const completed = streamTokenBuffer.slice(0, newlineIdx);
    streamTokenBuffer = streamTokenBuffer.slice(newlineIdx + 1);
    if (completed) {
      const lines = completed.split('\n').filter(s => s.length > 0);
      setStreamLines((prev) => withStreamLines(prev, lines.map(s => ({
        id: streamLineId(),
        kind: 'token' as const,
        text: s,
        color: 'text-cyan-200',
      }))));
    }
  };

  const flushStreamBuffer = (): void => {
    if (streamTokenBuffer.length === 0) return;
    const text = streamTokenBuffer;
    streamTokenBuffer = '';
    setStreamLines((prev) => withStreamLines(prev, [{
      id: streamLineId(),
      kind: 'token' as const,
      text,
      color: 'text-cyan-200',
    }]));
  };

  const teardownPeek = (): void => {
    const node = focusedNode();
    if (node && panelMode() === 'stream' && node.streamSource.kind === 'peek') {
      wire.send({ type: 'subscribe-peek', scope: node.streamSource.scope, active: false });
    }
  };

  const closePanel = (): void => {
    teardownPeek();
    setFocusedId(null);
    setFocusedNode(null);
    setPanelMode(null);
    setStreamLines([]);
    streamTokenBuffer = '';
  };

  const openStream = (node: UiNode): void => {
    if (node.streamSource.kind === 'none') return;
    if (focusedId() === node.id && panelMode() === 'stream') {
      closePanel();
      return;
    }
    teardownPeek();
    setFocusedId(node.id);
    setFocusedNode(node);
    setPanelMode('stream');
    setStreamLines([]);
    streamTokenBuffer = '';
    if (node.streamSource.kind === 'peek') {
      wire.send({ type: 'subscribe-peek', scope: node.streamSource.scope, active: true });
    } else if (node.streamSource.kind === 'child-event-all') {
      const buf = childEventBuffers.get(node.streamSource.childName);
      if (buf) for (const ev of buf) ingestStreamEvent(ev);
    } else if (node.streamSource.kind === 'child-event-agent') {
      const buf = childEventBuffers.get(node.streamSource.childName);
      if (buf) {
        for (const ev of buf) {
          if ((ev as { agentName?: string }).agentName === node.streamSource.agentName) {
            ingestStreamEvent(ev);
          }
        }
      }
    }
  };

  const openUsage = (node: UiNode): void => {
    if (focusedId() === node.id && panelMode() === 'usage') {
      closePanel();
      return;
    }
    teardownPeek();
    setFocusedId(node.id);
    setFocusedNode(node);
    setPanelMode('usage');
    setStreamLines([]);
    streamTokenBuffer = '';
  };

  const openBranches = (): void => {
    if (panelMode() === 'branches') {
      closePanel();
      return;
    }
    teardownPeek();
    setFocusedId(null);
    setFocusedNode(null);
    setPanelMode('branches');
    setStreamLines([]);
    streamTokenBuffer = '';
    refreshBranches();
  };

  const toggleExpand = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const cancelSubagent = (name: string, childName?: string): void => {
    wire.send({ type: 'cancel-subagent', name, ...(childName ? { childName } : { sessionId: shownSession() ?? '' }) });
  };

  const fleetStop = (name: string): void => {
    wire.send({ type: 'fleet-stop', name });
  };

  const fleetRestart = (name: string): void => {
    wire.send({ type: 'fleet-restart', name });
  };

  const stopFocusedNode = (): void => {
    const node = focusedNode();
    if (!node) return;
    const src = node.streamSource;
    if (src.kind === 'peek') cancelSubagent(src.scope);
    else if (src.kind === 'child-event-all') fleetStop(src.childName);
    else if (src.kind === 'child-event-agent') {
      if (node.kind === 'subagent') cancelSubagent(src.agentName, src.childName);
      else fleetStop(src.childName);
    }
  };

  const canStopFocused = (): boolean => {
    const node = focusedNode();
    if (!node) return false;
    const src = node.streamSource;
    if (src.kind === 'peek') {
      return node.agent?.status === 'running';
    }
    return src.kind === 'child-event-all' || src.kind === 'child-event-agent';
  };

  const autoExpandNewFleetChildren = (): void => {
    const roots = treeStore.build();
    const visit = (node: UiNode): void => {
      if (node.kind === 'fleet-child' && !seenAutoExpand.has(node.id)) {
        seenAutoExpand.add(node.id);
        setExpanded((prev) => {
          const next = new Set(prev);
          next.add(node.id);
          return next;
        });
      }
      for (const c of node.children) visit(c);
    };
    for (const r of roots) visit(r);
  };

  onMount(() => {
    const detach = wire.onMessage((msg) => {
      if (treesShown()) treeStore.ingest(msg);
      autoExpandNewFleetChildren();
      if (msg.type === 'child-event') {
        recordChildEvent(msg.childName, msg.event);
      }
      handleStreamMessage(msg);
      handleServerMessage(msg, wire, {
        applyWelcome,
        applyAppended,
        applyHistoryPage,
        appendMessage: (m) => setMessages(produce(arr => arr.push(m))),
        setUsage,
        setPerAgentCost,
        setCallLedger,
        appendStreamToken,
        appendToolUseBlocks,
        updateToolStatus,
        handleContentBlock,
        finishStream,
        queueScroll,
        openQuitConfirm: (children) => setQuitConfirm(children),
        currentScope: panelScope,
        setLessons: (loaded, moduleLoaded, list) => {
          setLessonsLoaded(loaded);
          setLessonsModuleLoaded(moduleLoaded);
          setLessons(list);
        },
        setMcpl: (configPath, servers, live, toolClasses) => {
          setMcplLoaded(true);
          setMcplConfigPath(configPath);
          setMcplServers(servers);
          setMcplLive(live);
          setMcplToolClasses(toolClasses);
        },
        setSettings: (state) => {
          if (!isChildScope(panelScope()) && state.sessionId !== shownSession()) return;
          setSettingsLoaded(true);
          setSettingsState(state);
        },
        setPins: (state) => {
          if (!isChildScope(panelScope()) && state.sessionId !== shownSession()) return;
          setPinsLoaded(true);
          setPinsState(state);
        },
        setMounts: (loaded, moduleLoaded, list) => {
          setMountsLoaded(loaded);
          setWorkspaceModuleLoaded(moduleLoaded);
          setMounts(list);
        },
        setMountTree: (mountName, entries) => {
          setTreesByMount(prev => {
            const next = new Map(prev);
            next.set(mountName, entries);
            return next;
          });
        },
        setOpenFile: (file) => {
          setOpenFile(file);
          setFileLoading(false);
        },
        onOpsAlert: applyOpsAlertTrace,
        onCredentialState: (state, scope) => applyCredentialState(state, scope),
        setBranchesList: (list, currentId) => {
          setBranches(list);
          setBranchesCurrentId(currentId);
          setBranchesLoading(false);
        },
        onBranchChanged: (branch) => {
          setWelcome((w) => (w ? { ...w, branch } : w));
          if (panelMode() === 'branches') refreshBranches();
        },
        setHostMode: (hm) => { if (hm) onHostMode(hm); else setHostMode(null); },
        requestHostMode: () => { if (features().has('quiesce')) wire.send({ type: 'request-host-mode' }); },
        onTurnSettled: () => {
          if (features().has('quiesce') && hostMode()?.mode === 'quiescing') wire.send({ type: 'request-host-mode' });
        },
        conversationAgent: () => conversationAgentOf(welcome()),
        onSurgeryResult,
        setOperatorLog: (entries, path) => { setOpLog(entries); setOpLogPath(path); setOpLogLoading(false); },
        onOperatorAction: () => { if (panelMode() === 'branches') refreshOpLog(); },
        onCommandAnswer: refreshLocalUpdate,
      });
    });
    onCleanup(() => {
      detach();
      wire.close();
    });

    void loadHealth();
    const healthTimer = window.setInterval(() => {
      void loadHealth();
      if (panelScope() !== 'local') void reconcileLocalAlerts();
    }, 15_000);
    onCleanup(() => window.clearInterval(healthTimer));
  });

  const handleStreamMessage = (msg: WebUiServerMessage): void => {
    if (panelMode() !== 'stream') return;
    const node = focusedNode();
    if (!node) return;
    const event = streamEventFor(node.streamSource, msg as Parameters<typeof streamEventFor>[1]);
    if (event) ingestStreamEvent(event);
  };

  const ingestStreamEvent = (event: { type: string; [k: string]: unknown }): void => {
    if ((event.type === 'inference:tokens' || event.type === 'tokens') && typeof event.content === 'string') {
      appendStreamPaneToken(event.content);
      return;
    }
    flushStreamBuffer();
    const line = formatStreamEvent(event);
    if (line) setStreamLines((prev) => withStreamLines(prev, [line]));
  };

  const submit = (): void => {
    const text = draft().trim();
    if (!text) return;
    setDraft('');
    if (text.startsWith('/')) {
      if (text === '/clear' || text.startsWith('/clear ')) {
        setMessages(produce((arr) => { arr.length = 0; }));
        setStreamLines([]);
        return;
      }
      wire.send({ type: 'command', command: text });
      return;
    }
    const route = parseRoute(text);
    if (route) {
      setMessages(produce((arr) => arr.push({
        id: nextMessageId(),
        participant: 'user',
        text: `→ @${route.childName}: ${route.content}`,
        timestamp: Date.now(),
      })));
      queueScroll();
      wire.send({ type: 'route-to-child', childName: route.childName, content: route.content });
      return;
    }
    setMessages(produce((arr) => arr.push({
      id: nextMessageId(),
      participant: 'user',
      text,
      timestamp: Date.now(),
    })));
    queueScroll();
    wire.send({ type: 'user-message', content: text });
  };

  const interrupt = (): void => {
    wire.send({ type: 'interrupt' });
  };

  const respondQuit = (action: 'kill-children' | 'detach' | 'cancel'): void => {
    wire.send({ type: 'quit-confirm', action });
    setQuitConfirm(null);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div class="flex flex-col h-screen">
      <Header
        welcome={welcome()}
        usage={usage()}
        quota={quota()}
        status={wire.status()}
        branchPanelOpen={panelMode() === 'branches'}
        onBranchClick={openBranches}
        hostMode={features().has('quiesce') ? hostMode() : null}
        hostModeBusy={hostModeBusy()}
        hostModeReadOnly={!canQuiesce()}
        onQuiesce={quiesceHost}
        onResume={resumeHost}
      />
      <Lightbox />
      <Show when={surgery()}>
        {(req) => (
          <SurgeryDialog
            request={req()}
            pending={surgeryPending()}
            result={surgeryResult()}
            canQuiesce={canQuiesce()}
            hostMode={hostMode()}
            onConfirm={confirmSurgery}
            onQuiesceAndRetry={quiesceAndRetry}
            onClose={closeSurgery}
          />
        )}
      </Show>
      <ReconnectBanner status={wire.status()} />
      <OpsAlertStrip
        alerts={alertList()}
        onDismiss={removeOpsAlert}
        onAction={(alert, id) => runCredentialAction(id, alert.scope ?? 'local')}
      />
      <UpdateBanner
        status={localUpdate()}
        dismissed={dismissedUpdate()}
        onDismiss={(line) => setDismissedUpdate(line)}
        onWay={isObserver() ? undefined : runUpdateWay}
      />
      <Show when={!isObserver() && updateDialog() !== null && localUpdate()}>
        {(status) => (
          <UpdateDialog
            kind={updateDialog()!}
            status={status()}
            onWay={sendUpdateWay}
            onClose={() => setUpdateDialog(null)}
          />
        )}
      </Show>
      <Show when={wire.observerState() === 'observer' && wire.observer()}>
        {(info) => (
          <div class="bg-violet-950/60 border-b border-violet-900 px-4 py-1.5 text-xs text-violet-200 flex items-center gap-2">
            <span class="w-2 h-2 rounded-full bg-violet-500" />
            <span>
              Observing as <span class="font-semibold">{info().label}</span> — read-only, scopes:{' '}
              <code class="font-mono">{info().scopes.join(', ')}</code>. Content outside your scopes is elided.
            </span>
          </div>
        )}
      </Show>
      <Show when={wire.observerState() === 'denied' || wire.observerState() === 'unavailable'}>
        <ObserverGateScreen state={wire.observerState() as 'denied' | 'unavailable'} />
      </Show>
      <Show when={protoMismatch() !== null}>
        <div class="bg-amber-950/60 border-b border-amber-900 px-4 py-1.5 text-xs text-amber-200 flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-amber-500" />
          <span>
            Protocol mismatch — server speaks v{protoMismatch()}, this bundle expects v{WEB_PROTOCOL_VERSION}.
            Reload the page. If this is still shown and the host runs from a clone, rebuild the SPA (<code class="font-mono">bun run build:web</code>) and reload. If it's still shown, restart the host and reload.
          </span>
        </div>
      </Show>
      <Show when={quitConfirm()}>
        {(list) => (
          <QuitConfirmModal
            childNames={list()}
            onAction={respondQuit}
          />
        )}
      </Show>
      <FileViewerModal
        file={openFile()}
        loading={fileLoading()}
        onClose={() => { setOpenFile(null); setFileLoading(false); }}
      />

      <div class="flex flex-1 min-h-0">
        <main class="flex-1 flex flex-col min-w-0">
          <div class="flex border-b border-neutral-800 bg-neutral-900/40 text-[11px] font-mono">
            <button type="button" class={`px-3 py-1.5 ${mainView() === 'chat' ? 'text-neutral-100 bg-neutral-900 border-b border-cyan-700' : 'text-neutral-500 hover:text-neutral-300'}`} onClick={() => setMainView('chat')}>Chat</button>
            <button type="button" class={`px-3 py-1.5 ${mainView() === 'context' ? 'text-neutral-100 bg-neutral-900 border-b border-cyan-700' : 'text-neutral-500 hover:text-neutral-300'}`} onClick={() => setMainView('context')}>Context</button>
            <Show when={dryContext()}>
              <button type="button" class={`px-3 py-1.5 ${mainView() === 'dry' ? 'text-amber-200 bg-neutral-900 border-b border-amber-600' : 'text-amber-500/70 hover:text-amber-300'}`} onClick={() => setMainView('dry')}>Dry run</button>
            </Show>
          </div>
          <div
            ref={scrollPane}
            class="flex-1 overflow-y-auto px-4 py-3 space-y-3"
            onScroll={onScrollPane}
          >
            <Show when={mainView() === 'dry'}>
              <DryContext data={dryContext()} onClose={() => { setDryContext(null); setMainView('chat'); }} />
            </Show>
            <Show when={mainView() === 'context'} fallback={<Show when={mainView() === 'chat'}>
            <Show when={(historyInfo()?.startIndex ?? 0) > 0}>
              <div class="flex items-center gap-1 text-xs font-mono text-neutral-500 py-1 px-2 border border-dashed border-neutral-800 rounded">
                <button
                  type="button"
                  class="flex-1 text-left hover:text-neutral-300 disabled:text-neutral-600"
                  onClick={() => requestOlder(200)}
                  disabled={historyLoading()}
                  title="scroll to the top or click to load 200 older messages"
                >
                  {bulkRemaining() > 0
                    ? `loading older… ${bulkLoaded().toLocaleString()} / ${(bulkLoaded() + bulkRemaining()).toLocaleString()}`
                    : historyLoading()
                      ? 'loading…'
                      : `▲ ${historyInfo()!.startIndex.toLocaleString()} older message${historyInfo()!.startIndex === 1 ? '' : 's'} — scroll or click to load`}
                </button>
                <Show when={bulkRemaining() > 0} fallback={
                  <>
                    <span class="text-neutral-700">load</span>
                    <For each={[200, 1000, 5000].filter((n) => n <= (historyInfo()?.startIndex ?? 0) || n === 200)}>{(n) => (
                      <button
                        type="button"
                        class="px-1.5 py-0.5 rounded border border-neutral-800 hover:border-neutral-600 hover:text-neutral-200 disabled:text-neutral-700"
                        disabled={historyLoading()}
                        title={`load the ${Math.min(n, historyInfo()?.startIndex ?? 0).toLocaleString()} older messages just above (500 per request)`}
                        onClick={() => loadOlder(n)}
                      >{n >= 1000 ? `${n / 1000}k` : n}</button>
                    )}</For>
                    <button
                      type="button"
                      class="px-1.5 py-0.5 rounded border border-neutral-800 hover:border-amber-800 hover:text-amber-200 disabled:text-neutral-700"
                      disabled={historyLoading()}
                      title={`load ALL ${historyInfo()!.startIndex.toLocaleString()} older messages — heavy for large stores`}
                      onClick={() => loadOlder(historyInfo()!.startIndex)}
                    >all</button>
                  </>
                }>
                  <button
                    type="button"
                    class="px-1.5 py-0.5 rounded border border-rose-900/60 text-rose-300 hover:bg-rose-950/40"
                    onClick={stopLoadOlder}
                    title="stop after the current page"
                  >stop</button>
                </Show>
              </div>
            </Show>
            <Show when={messages.length === 0}>
              <div class="text-neutral-500 text-sm italic">
                Connected. Type a message or /help to begin.
              </div>
            </Show>
            <For each={messages}>{(m) => (
              <MessageRow
                storeId={m.storeId}
                canRollback={canRollback() && !!m.storeId}
                canSuppress={canSuppress() && !!m.storeId}
                selecting={selecting()}
                selected={!!m.storeId && selected().has(m.storeId)}
                onRollback={() => m.storeId && beginRollback(m.storeId)}
                onSelect={() => m.storeId && (selecting() ? toggleSelected(m.storeId) : startSelecting(m.storeId))}
              >
                <MessageView msg={m} results={toolResults()} toolUseIds={toolUseIds()} />
              </MessageRow>
            )}</For>
            <Show when={selecting()}>
              <SelectionBar count={selected().size} onSuppress={beginSuppressSelected} onClear={clearSelection} />
            </Show>
            </Show>}>
              <ContextDocument
                scope={panelScope()}
                session={shownSession()}
                canRollback={canRollback() && panelScope() === 'local'}
                onRollback={(id, preview, chosenIn) => beginRollback(id, preview, chosenIn)}
              />
            </Show>
          </div>

          <div class="border-t border-neutral-800 px-4 py-3 bg-neutral-950 relative">
            <CommandSuggestions
              draft={draft()}
              onPick={(cmd) => setDraft(cmd + ' ')}
            />
            <div class="flex gap-2">
              <textarea
                class="flex-1 bg-neutral-900 text-neutral-100 border border-neutral-800 rounded px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-neutral-600 font-mono text-sm"
                rows="2"
                placeholder="Type a message, /help, or @childname"
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={onKey}
              />
              <div class="flex flex-col gap-1">
                <button
                  type="button"
                  class="px-4 py-1.5 bg-neutral-800 hover:bg-neutral-700 rounded text-sm"
                  onClick={submit}
                >
                  Send
                </button>
                <button
                  type="button"
                  class="px-4 py-1.5 bg-rose-900/40 hover:bg-rose-900/60 text-rose-200 rounded text-xs font-mono"
                  onClick={interrupt}
                  title="Cancel any in-flight inference (Esc parity)"
                >
                  Stop
                </button>
              </div>
            </div>
          </div>
        </main>

        <Show when={focusedNode() && panelMode() === 'stream'}>
          {(_) => {
            const node = focusedNode()!;
            return (
              <StreamPanel
                label={node.label}
                scopeHint={streamHint(node.streamSource)}
                lines={streamLines()}
                onClose={closePanel}
                onStop={stopFocusedNode}
                canStop={canStopFocused()}
              />
            );
          }}
        </Show>
        <Show when={focusedNode() && panelMode() === 'usage'}>
          {(_) => (
            <UsagePanel
              node={focusedNode()!}
              sessionUsage={usage()}
              perAgentCost={perAgentCost()}
              callLedger={callLedger()}
              quota={usageQuotaScope() === null ? quota() : focusedQuota()}
              onClose={closePanel}
            />
          )}
        </Show>
        <Show when={panelMode() === 'branches'}>
          <BranchPanel
            branches={branches()}
            currentId={branchesCurrentId() ?? welcome()?.branch.id ?? null}
            loading={branchesLoading()}
            readOnly={wire.observerState() === 'observer'}
            onCheckout={checkoutBranch}
            onRefresh={() => { refreshBranches(); refreshOpLog(); }}
            onClose={closePanel}
            operatorLog={features().has('operator-log') ? opLog() : null}
            operatorLogPath={opLogPath()}
            operatorLogLoading={opLogLoading()}
            onRefreshLog={refreshOpLog}
          />
        </Show>
        <aside class="w-96 xl:w-[30rem] border-l border-neutral-800 bg-neutral-950 shrink-0 flex flex-col">
          <SidebarTabs
            current={sidebarTab()}
            onSelect={(tab) => {
              setSidebarTab(tab);
              if (tab === 'lessons' && !lessonsLoaded()) refreshLessons();
              if (tab === 'mcp' && !mcplLoaded()) refreshMcpl();
              if (tab === 'files' && !mountsLoaded()) refreshMounts();
              if (tab === 'settings' && !settingsLoaded()) refreshSettings();
              if (tab === 'pins' && !pinsLoaded()) refreshPins();
            }}
          />
          <ScopeBar
            scopes={availableScopes()}
            scope={panelScope()}
            onChange={changePanelScope}
          />
          <div class="flex-1 min-h-0">
            <Show when={sidebarTab() === 'tree' && !treesShown() && wire.observer() !== null}>
              <div class="p-4 text-xs text-neutral-500">
                The agent tree shows for a grant with every scope but debug ({AGENT_TREE_SCOPES.join(', ')}).
              </div>
            </Show>
            <Show when={sidebarTab() === 'tree' && treesShown()}>
              <TreeSidebar
                roots={treeStore.build()}
                selectedId={focusedId()}
                expanded={expanded()}
                onToggleExpand={toggleExpand}
                onSelectStream={openStream}
                onSelectUsage={openUsage}
                onCancelSubagent={cancelSubagent}
                onFleetStop={fleetStop}
                onFleetRestart={fleetRestart}
              />
            </Show>
            <Show when={sidebarTab() === 'lessons'}>
              <LessonsPanel
                loaded={lessonsLoaded()}
                moduleLoaded={lessonsModuleLoaded()}
                lessons={lessons()}
                onRefresh={refreshLessons}
              />
            </Show>
            <Show when={sidebarTab() === 'mcp'}>
              <McplPanel
                loaded={mcplLoaded()}
                configPath={mcplConfigPath()}
                servers={mcplServers()}
                live={mcplLive()}
                toolClasses={mcplToolClasses()}
                readOnly={panelScope() !== 'local'}
                onRefresh={refreshMcpl}
                onAdd={(input) => wire.send({ type: 'mcpl-add', ...input })}
                onRemove={(id) => wire.send({ type: 'mcpl-remove', id })}
                onSetEnv={(id, env) => wire.send({ type: 'mcpl-set-env', id, env })}
              />
            </Show>
            <Show when={sidebarTab() === 'settings' ? panelKey() : null} keyed>
              {(_shown) => (
                <SettingsPanel
                  loaded={settingsLoaded()}
                  state={settingsState()}
                  scope={panelScope()}
                  onRefresh={refreshSettings}
                  onApply={(patch) => wire.send({ type: 'settings-update', scope: panelScope(), ...stampFor(panelScope(), settingsState()?.sessionId), ...patch })}
                  onReset={(keys, persist) =>
                    wire.send({ type: 'settings-reset', scope: panelScope(), ...stampFor(panelScope(), settingsState()?.sessionId), ...(keys ? { keys } : {}), persist })}
                  onCancelTransition={() => wire.send({ type: 'settings-cancel-transition', scope: panelScope(), ...stampFor(panelScope(), settingsState()?.sessionId) })}
                  onDryContext={(ctx) => { setDryContext(ctx as DryContextData); setMainView('dry'); }}
                />
              )}
            </Show>
            <Show when={sidebarTab() === 'pins' ? panelKey() : null} keyed>
              {(_shown) => (
                <PinsPanel
                  loaded={pinsLoaded()}
                  state={pinsState()}
                  agent={pinsState()?.agent}
                  candidates={panelScope() === 'local'
                    ? messages
                        .filter((m) => m.index !== undefined && m.id)
                        .map<PinCandidate>((m) => ({
                          id: m.id, index: m.index!, participant: m.participant, text: m.text ?? '',
                        }))
                    : pinsState()?.candidates ?? []}
                  onRefresh={refreshPins}
                  onAdd={(input) => wire.send({ type: 'pin-add', scope: panelScope(), ...stampFor(panelScope(), pinsState()?.sessionId), ...input })}
                  onRemove={(pinId) => wire.send({ type: 'pin-remove', scope: panelScope(), ...stampFor(panelScope(), pinsState()?.sessionId), pinId })}
                />
              )}
            </Show>
            <Show when={sidebarTab() === 'files'}>
              <FilesPanel
                loaded={mountsLoaded()}
                moduleLoaded={workspaceModuleLoaded()}
                mounts={mounts()}
                treesByMount={treesByMount()}
                expandedMounts={expandedMounts()}
                onRefreshMounts={refreshMounts}
                onExpandMount={expandMount}
                onCollapseMount={collapseMount}
                onOpenFile={requestFile}
              />
            </Show>
            <Show when={sidebarTab() === 'context'}>
              <ContextPanel scope={panelScope()} />
            </Show>
            <Show when={sidebarTab() === 'health'}>
              <HealthPanel
                health={health()}
                error={healthErr()}
                ledger={callLedger()?.rows}
                onRefresh={() => void loadHealth(true)}
                credential={credentialForScope()}
                onCredentialAction={(id) => runCredentialAction(id, panelScope())}
                update={panelScope() === 'local' ? localUpdate() : null}
                onUpdateWay={isObserver() ? undefined : runUpdateWay}
              />
            </Show>
          </div>
          <RecipePane welcome={welcome()} scope={panelScope()} />
        </aside>
      </div>
    </div>
  );
}

function streamHint(src: StreamSource): string | undefined {
  switch (src.kind) {
    case 'peek': return 'subagent';
    case 'trace-agent': return 'agent';
    case 'child-event-all': return 'fleet child';
    case 'child-event-agent': return `agent in ${src.childName}`;
    default: return undefined;
  }
}

interface HandlerHooks {
  applyWelcome: (w: WelcomeMessage) => void;
  applyAppended: (entry: WelcomeMessageEntry) => void;
  applyHistoryPage: (msg: HistoryPageMessage) => void;
  appendMessage: (msg: Message) => void;
  setUsage: (u: TokenUsage) => void;
  setPerAgentCost: (c: PerAgentCost[]) => void;
  setCallLedger: (ledger: CallLedgerSnapshot | null) => void;
  appendStreamToken: (token: string, blockType?: string) => void;
  appendToolUseBlocks: (calls: Array<{ id: string; name: string; input?: unknown }>) => void;
  updateToolStatus: (callId: string, status: 'done' | 'failed', durationMs?: number) => void;
  handleContentBlock: (phase: string) => void;
  finishStream: () => void;
  queueScroll: () => void;
  openQuitConfirm: (children: string[]) => void;
  currentScope: () => string;
  setLessons: (loaded: boolean, moduleLoaded: boolean, lessons: LessonRow[]) => void;
  setMcpl: (configPath: string, servers: McplServerRow[], live: McplLiveRow[], toolClasses?: ToolClassRow[]) => void;
  setSettings: (state: SettingsState) => void;
  onCredentialState: (state: CredentialInfo, scope: string) => void;
  setPins: (state: PinsState) => void;
  setMounts: (loaded: boolean, moduleLoaded: boolean, mounts: Mount[]) => void;
  setMountTree: (mount: string, entries: FlatEntry[]) => void;
  setOpenFile: (file: FileViewer) => void;
  onOpsAlert: (event: { [k: string]: unknown }) => void;
  setBranchesList: (branches: BranchRow[], currentId: string) => void;
  onBranchChanged: (branch: { id: string; name: string }) => void;
  setHostMode: (hostMode: HostModeSnapshot | null) => void;
  requestHostMode: () => void;
  onTurnSettled: () => void;
  conversationAgent: () => string | undefined;
  onSurgeryResult: (result: SurgeryResultMessage) => void;
  setOperatorLog: (entries: OperatorLogEntryWire[], path?: string) => void;
  onOperatorAction: () => void;
  onCommandAnswer: () => void;
}

function staleScope(msgScope: string | undefined, current: string): boolean {
  return msgScope !== undefined && msgScope !== current;
}

function handleServerMessage(
  msg: WebUiServerMessage,
  _wire: WireClient,
  hooks: HandlerHooks,
): void {
  switch (msg.type) {
    case 'welcome': {
      hooks.applyWelcome(msg);
      hooks.setUsage(msg.usage);
      hooks.setPerAgentCost(msg.perAgentCost ?? []);
      hooks.setCallLedger(msg.callLedger ?? null);
      hooks.setHostMode(msg.hostMode ?? null);
      return;
    }
    case 'host-mode':
      hooks.setHostMode(msg.hostMode);
      return;
    case 'surgery-result':
      hooks.onSurgeryResult(msg);
      return;
    case 'operator-log':
      hooks.setOperatorLog(msg.entries, msg.path);
      return;
    case 'message-appended':
      hooks.applyAppended(msg.entry);
      return;
    case 'history-page':
      hooks.applyHistoryPage(msg);
      return;
    case 'usage':
      hooks.setUsage(msg.usage);
      if (msg.perAgentCost) hooks.setPerAgentCost(msg.perAgentCost);
      return;
    case 'call-ledger':
      hooks.setCallLedger(msg.ledger);
      return;
    case 'trace':
      if (typeof msg.event.type === 'string') applyTrace(msg.event, hooks, hooks.conversationAgent());
      return;
    case 'stream-ended':
      applyStreamEnded(msg.agentName, hooks, hooks.conversationAgent());
      return;
    case 'command-result': {
      hooks.appendMessage({
        id: nextMessageId(),
        participant: 'command',
        text: msg.lines.map(l => l.text).join('\n'),
        lines: msg.lines,
      });
      hooks.queueScroll();
      hooks.onCommandAnswer();
      return;
    }
    case 'branch-changed':
      hooks.onBranchChanged(msg.branch);
      return;
    case 'branches-list':
      hooks.setBranchesList(msg.branches, msg.currentId);
      return;
    case 'session-changed':
      return;
    case 'inbound-trigger': {
      hooks.appendMessage({
        id: nextMessageId(),
        participant: 'trigger',
        text: msg.text,
        timestamp: msg.timestamp,
        trigger: {
          origin: msg.origin,
          source: msg.source,
          author: msg.author,
          triggered: msg.triggered,
        },
      });
      hooks.queueScroll();
      return;
    }
    case 'quit-confirm-required':
      hooks.openQuitConfirm(msg.children);
      return;
    case 'lessons-list':
      if (staleScope(msg.scope, hooks.currentScope())) return;
      hooks.setLessons(true, msg.loaded, msg.lessons);
      return;
    case 'mcpl-list':
      if (staleScope(msg.scope, hooks.currentScope())) return;
      hooks.setMcpl(msg.configPath, msg.servers, msg.live ?? [], msg.toolClasses);
      return;
    case 'settings-state':
      if (staleScope(msg.scope, hooks.currentScope())) return;
      hooks.setSettings(msg as unknown as SettingsState);
      return;
    case 'credential-state':
      hooks.onCredentialState(msg as unknown as CredentialInfo, msg.scope ?? 'local');
      return;
    case 'pins-list':
      if (staleScope(msg.scope, hooks.currentScope())) return;
      hooks.setPins(msg as unknown as PinsState);
      return;
    case 'workspace-mounts':
      if (staleScope(msg.scope, hooks.currentScope())) return;
      hooks.setMounts(true, msg.loaded, msg.mounts);
      return;
    case 'workspace-tree':
      if (staleScope(msg.scope, hooks.currentScope())) return;
      hooks.setMountTree(msg.mount, msg.entries);
      return;
    case 'workspace-file':
      if (staleScope(msg.scope, hooks.currentScope())) return;
      hooks.setOpenFile(msg);
      return;
    case 'error':
      console.warn('[server error]', msg.message);
      hooks.appendMessage({
        id: nextMessageId(),
        participant: 'system',
        text: `Error: ${msg.message}`,
      });
      hooks.queueScroll();
      return;
    default:
      return;
  }
}

function Header(props: {
  welcome: WelcomeMessage | null;
  usage: TokenUsage;
  quota: QuotaSnapshotData | null;
  status: string;
  branchPanelOpen: boolean;
  onBranchClick(): void;
  hostMode: HostModeSnapshot | null;
  hostModeBusy: boolean;
  hostModeReadOnly: boolean;
  onQuiesce(reason: string): void;
  onResume(): void;
}) {
  const fmt = (n: number): string => {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(1) + 'k';
    return (n / 1_000_000).toFixed(2) + 'M';
  };

  const statusColor = (): string => {
    switch (props.status) {
      case 'open': return 'bg-emerald-500';
      case 'connecting':
      case 'reconnecting': return 'bg-amber-500';
      default: return 'bg-rose-500';
    }
  };

  return (
    <div class="border-b border-neutral-800 bg-neutral-950 px-4 py-2 flex items-center gap-3 text-sm">
      <div class={`w-2 h-2 rounded-full ${statusColor()}`} title={props.status} />
      <div class="font-semibold text-neutral-200">
        {props.welcome?.recipe.name ?? 'connectome-host'}
      </div>
      <Show when={props.welcome?.session.name}>
        <div class="text-neutral-500">
          · {props.welcome!.session.name}
        </div>
      </Show>
      <Show when={props.welcome?.branch.name}>
        <button
          type="button"
          class={`text-xs font-mono px-1.5 py-0.5 rounded ${
            props.welcome!.branch.name !== 'main'
              ? 'text-amber-400 bg-amber-950/30 hover:bg-amber-950/60'
              : 'text-neutral-400 bg-neutral-900 hover:bg-neutral-800'
          } ${props.branchPanelOpen ? 'ring-1 ring-cyan-800' : ''}`}
          title="Chronicle branches — click to browse lineage"
          onClick={() => props.onBranchClick()}
        >
          ⑂ {props.welcome!.branch.name}
        </button>
      </Show>
      <Show when={props.hostMode}>
        <HostModeToggle
          hostMode={props.hostMode}
          busy={props.hostModeBusy}
          readOnly={props.hostModeReadOnly}
          onQuiesce={props.onQuiesce}
          onResume={props.onResume}
        />
      </Show>
      <div class="ml-auto text-xs font-mono text-neutral-500">
        {fmt(props.usage.input)} in
        <span class="ml-2">{fmt(props.usage.output)} out</span>
        <Show when={props.usage.cacheRead > 0}>
          <span class="ml-2">{fmt(props.usage.cacheRead)} cache</span>
        </Show>
        <Show when={props.quota?.subscription && props.quota.windows.length > 0}>
          <span class={`ml-3 ${quotaTone(props.quota!)}`} title={quotaTitle(props.quota!)}>
            {quotaReadout(props.quota!)}
          </span>
        </Show>
        <Show when={quotaUnreadable(props.quota ?? null)}>
          <span class="ml-3 text-amber-400" title={`Subscription quota unreadable${props.quota!.error ? `: ${props.quota!.error}` : ''}`}>
            quota: unreadable
          </span>
        </Show>
        <Show when={!props.quota?.subscription && props.usage.cost && props.usage.cost.total > 0}>
          <span
            class="ml-3 text-emerald-300"
            title={`Estimated cost (${props.usage.cost!.currency})`}
          >
            ${props.usage.cost!.total.toFixed(props.usage.cost!.total < 1 ? 4 : 2)}
          </span>
        </Show>
      </div>
    </div>
  );
}

type ToolResultInfo = { text: string; isError?: boolean; truncated?: boolean };

function MessageRow(props: {
  storeId?: string;
  canRollback: boolean;
  canSuppress: boolean;
  selecting: boolean;
  selected: boolean;
  onRollback(): void;
  onSelect(): void;
  children: JSX.Element;
}) {
  const actionable = (): boolean => !!props.storeId && (props.canRollback || props.canSuppress);
  return (
    <div class={`group relative ${actionable() ? 'pr-2' : ''} ${props.selected ? 'ring-1 ring-rose-800/70 rounded bg-rose-950/10' : ''}`}>
      <Show when={actionable()}>
        <div class={`absolute right-0 top-0 z-10 flex gap-1 ${props.selecting ? '' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'} transition-opacity`}>
          <Show when={props.canRollback && !props.selecting}>
            <button
              type="button"
              class="px-1.5 py-0.5 rounded border bg-neutral-900/95 border-neutral-700 text-neutral-400 hover:border-amber-700 hover:text-amber-200 text-[10px] font-mono leading-tight shadow"
              title="roll back: fork the chronicle here and make this message the tail of the live branch (the current branch keeps everything after it)"
              onClick={props.onRollback}
            >⏪ roll back</button>
          </Show>
          <Show when={props.canSuppress}>
            <button
              type="button"
              class={`px-1.5 py-0.5 rounded border text-[10px] font-mono leading-tight shadow ${props.selected ? 'bg-rose-900/70 border-rose-700 text-rose-100' : 'bg-neutral-900/95 border-neutral-700 text-neutral-400 hover:border-rose-700 hover:text-rose-200'}`}
              title={props.selecting ? (props.selected ? 'deselect' : 'select for suppression') : 'suppress: select this message (and more), then confirm in the bar below'}
              onClick={props.onSelect}
            >{props.selected ? '✓ selected' : props.selecting ? '⊘ select' : '⊘ suppress'}</button>
          </Show>
        </div>
      </Show>
      {props.children}
    </div>
  );
}

function MessageView(props: {
  msg: Message;
  results: Map<string, ToolResultInfo>;
  toolUseIds: Set<string>;
}) {
  // Access fields via props.msg.X directly (not a destructured local) so Solid
  // tracks reactive reads against the store. Otherwise the message would
  // capture a snapshot at render time and never update mid-stream.

  if (props.msg.participant === 'user') {
    return (
      <div class="msg-enter">
        <div class="text-xs text-neutral-500 mb-1">{props.msg.speaker ?? 'you'}<TimeChip ts={props.msg.timestamp} /></div>
        <div class="font-mono text-sm whitespace-pre-wrap text-neutral-200">{props.msg.text}</div>
        <MediaChips blocks={props.msg.blocks} />
      </div>
    );
  }

  if (props.msg.participant === 'assistant') {
    return (
      <div class="msg-enter">
        <div class="text-xs text-neutral-500 mb-1">
          assistant
          <TimeChip ts={props.msg.timestamp} />
          <Show when={props.msg.streaming}>
            <span class="animate-pulse ml-2">▍</span>
          </Show>
        </div>
        <Show
          when={(props.msg.blocks?.length ?? 0) > 0}
          fallback={<div class="prose-mini text-neutral-100" innerHTML={renderMarkdown(props.msg.text)} />}
        >
          <For each={props.msg.blocks}>{(block, idx) => (
            <BlockView block={block} msgId={props.msg.id} idx={idx()} results={props.results} />
          )}</For>
        </Show>
      </div>
    );
  }

  if (props.msg.participant === 'tool') {
    const allPaired = (): boolean => {
      const blocks = props.msg.blocks ?? [];
      if (blocks.length === 0) return false;
      return blocks.every((b) =>
        b.kind === 'tool_result' ? props.toolUseIds.has(b.toolUseId) : b.kind === 'media',
      );
    };
    return (
      <Show when={!allPaired()}>
        <div class="msg-enter">
          <div class="text-xs text-neutral-500 mb-1">tool<TimeChip ts={props.msg.timestamp} /></div>
          <For each={props.msg.blocks ?? []}>{(block, idx) => (
            <BlockView block={block} msgId={props.msg.id} idx={idx()} results={props.results} />
          )}</For>
        </div>
      </Show>
    );
  }

  if (props.msg.participant === 'command') {
    return (
      <div class="msg-enter font-mono text-xs bg-neutral-900/60 border border-neutral-800 rounded px-3 py-2 whitespace-pre-wrap">
        <For each={props.msg.lines ?? [{ text: props.msg.text }]}>{(line) => (
          <div class={lineStyleClass(line.style)}>{line.text || ' '}</div>
        )}</For>
      </div>
    );
  }

  if (props.msg.participant === 'trigger') {
    const t = props.msg.trigger!;
    const tone = t.triggered
      ? 'border-amber-700/60 bg-amber-950/20'
      : 'border-neutral-800 bg-neutral-900/40';
    return (
      <div class={`msg-enter rounded border px-3 py-2 ${tone}`}>
        <div class="flex items-center gap-2 text-[10px] uppercase tracking-wider mb-1">
          <span class="text-amber-300 font-semibold">incoming</span>
          <span class="font-mono text-neutral-300">{t.origin}</span>
          <Show when={t.author}>
            <span class="text-neutral-500">· {t.author}</span>
          </Show>
          <TimeChip ts={props.msg.timestamp} />
          <Show when={!t.triggered}>
            <span class="ml-auto text-neutral-600 italic">(gated, no wake)</span>
          </Show>
        </div>
        <div class="font-mono text-sm whitespace-pre-wrap text-neutral-200">{props.msg.text}</div>
      </div>
    );
  }

  return (
    <div class="msg-enter text-xs text-neutral-500 font-mono whitespace-pre-wrap">
      {props.msg.text}
    </div>
  );
}

function TimeChip(props: { ts?: number }) {
  const label = (): string => {
    const d = new Date(props.ts!);
    const now = new Date();
    const hms = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return d.toDateString() === now.toDateString()
      ? hms
      : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hms}`;
  };
  return (
    <Show when={props.ts}>
      <span
        class="ml-2 text-[10px] font-mono text-neutral-600"
        title={new Date(props.ts!).toISOString()}
      >{label()}</span>
    </Show>
  );
}

function ToolPayload(props: { raw: string; isError?: boolean }) {
  const parsed = createMemo<
    | { kind: 'fields'; entries: Array<[string, unknown]> }
    | { kind: 'text'; text: string }
    | { kind: 'raw'; text: string }
  >(() => {
    const t = props.raw.trim();
    if (!t) return { kind: 'raw', text: props.raw };
    let v: unknown;
    try { v = JSON.parse(t); } catch { return { kind: 'raw', text: props.raw }; }
    if (typeof v === 'string') {
      const s: string = v;
      const inner = s.trim();
      if (/^[[{]/.test(inner)) {
        try { v = JSON.parse(inner); } catch { return { kind: 'text', text: s }; }
      } else {
        return { kind: 'text', text: s };
      }
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return { kind: 'fields', entries: Object.entries(v as Record<string, unknown>) };
    }
    try { return { kind: 'raw', text: JSON.stringify(v, null, 2) }; }
    catch { return { kind: 'raw', text: props.raw }; }
  });

  const tone = (): string => props.isError
    ? 'text-rose-300 bg-rose-950/20 border-rose-900/40'
    : 'text-neutral-300 bg-neutral-900/70 border-neutral-800';

  const fieldIsBlock = (val: unknown): boolean =>
    typeof val === 'string' && (val.includes('\n') || val.length > 80);

  const inlineValue = (val: unknown): string => {
    if (typeof val === 'string') return val;
    try { return JSON.stringify(val); } catch { return String(val); }
  };

  return (
    <div class={`font-mono text-[11px] rounded px-2 py-1.5 overflow-x-auto border ${tone()}`}>
      <Show when={parsed().kind === 'fields'} fallback={
        <div class="whitespace-pre-wrap">{(parsed() as { text: string }).text}</div>
      }>
        <For each={(parsed() as { entries: Array<[string, unknown]> }).entries}>{([k, val]) => (
          <Show when={fieldIsBlock(val)} fallback={
            <div class="leading-relaxed">
              <span class="text-neutral-500">{k}:</span> <span class="whitespace-pre-wrap">{inlineValue(val)}</span>
            </div>
          }>
            <div class="mt-1 first:mt-0">
              <div class="text-[10px] uppercase tracking-wider text-neutral-500">{k}</div>
              <div class="whitespace-pre-wrap">{val as string}</div>
            </div>
          </Show>
        )}</For>
      </Show>
    </div>
  );
}

const [expandedBlocks, setExpandedBlocks] = createSignal<Set<string>>(new Set());
const [expandedKinds, setExpandedKinds] = createSignal<Set<string>>(new Set());
const [collapsedOverrides, setCollapsedOverrides] = createSignal<Set<string>>(new Set());
const blockKinds = new Map<string, string>();
const isBlockOpen = (key: string, kind: string): boolean =>
  expandedBlocks().has(key) || (expandedKinds().has(kind) && !collapsedOverrides().has(key));
const toggleBlock = (key: string, kind = ''): void => {
  blockKinds.set(key, kind);
  if (isBlockOpen(key, kind)) {
    if (expandedBlocks().has(key)) {
      setExpandedBlocks((prev) => { const next = new Set(prev); next.delete(key); return next; });
    }
    if (kind && expandedKinds().has(kind)) {
      setCollapsedOverrides((prev) => new Set(prev).add(key));
    }
  } else {
    setCollapsedOverrides((prev) => { if (!prev.has(key)) return prev; const next = new Set(prev); next.delete(key); return next; });
    setExpandedBlocks((prev) => new Set(prev).add(key));
  }
};
const toggleKind = (kind: string): void => {
  const opening = !expandedKinds().has(kind);
  setExpandedKinds((prev) => { const next = new Set(prev); if (opening) next.add(kind); else next.delete(kind); return next; });
  setCollapsedOverrides((prev) => { const next = new Set(prev); for (const [k, kd] of blockKinds) if (kd === kind) next.delete(k); return next; });
  if (!opening) {
    setExpandedBlocks((prev) => { const next = new Set(prev); for (const [k, kd] of blockKinds) if (kd === kind) next.delete(k); return next; });
  }
};

function BlockView(props: {
  block: UiBlock;
  msgId: string;
  idx: number;
  results: Map<string, ToolResultInfo>;
}) {
  const key = (): string => `${props.msgId}:${props.idx}`;
  const b = props.block;

  if (b.kind === 'text') {
    return <TextBlockView block={b} />;
  }
  if (b.kind === 'thinking') {
    return <ThinkingBlockView block={b} blockKey={key()} />;
  }
  if (b.kind === 'redacted_thinking') {
    return (
      <div class="my-1 inline-block text-[11px] font-mono text-violet-400/70 bg-violet-950/20 border border-violet-900/40 rounded px-2 py-0.5">
        🔒 redacted thinking ({b.bytes.toLocaleString()} bytes)
      </div>
    );
  }
  if (b.kind === 'tool_use') {
    return <ToolBlockView block={b} blockKey={key()} result={props.results.get(b.id)} />;
  }
  if (b.kind === 'tool_result') {
    return (
      <div class="my-1">
        <div class="text-[10px] uppercase tracking-wider mb-0.5 text-neutral-600">
          tool result{b.isError ? ' · error' : ''}{b.truncated ? ' · truncated' : ''}
        </div>
        <ToolPayload raw={b.text} isError={b.isError} />
      </div>
    );
  }
  if (b.kind === 'tool_draft') {
    return (
      <div class="my-1 border-l-2 border-amber-800/60 pl-2">
        <div class="text-[11px] font-mono text-amber-400/80 flex items-center gap-1.5">
          <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          <span>writing tool call…</span>
        </div>
        <div class="mt-0.5 font-mono text-[11px] text-amber-200/50 whitespace-pre-wrap">{b.text}</div>
      </div>
    );
  }
  return <MediaView mediaType={b.mediaType} mediaRef={b.ref} />;
}

function TextBlockView(props: { block: Extract<UiBlock, { kind: 'text' }> }) {
  const html = createMemo(() => renderMarkdown(props.block.text));
  return (
    <Show
      when={!props.block.streaming}
      fallback={
        <div class="font-mono text-sm whitespace-pre-wrap text-neutral-100">{props.block.text}</div>
      }
    >
      <div class="prose-mini text-neutral-100" innerHTML={html()} />
      <Show when={props.block.truncated}>
        <div class="text-[10px] font-mono text-neutral-600 italic">· truncated for display ·</div>
      </Show>
    </Show>
  );
}

function ThinkingBlockView(props: {
  block: Extract<UiBlock, { kind: 'thinking' }>;
  blockKey: string;
}) {
  const KIND = 'thinking';
  const open = (): boolean => props.block.streaming === true || isBlockOpen(props.blockKey, KIND);
  const allOpen = (): boolean => expandedKinds().has(KIND);
  return (
    <div class="my-1.5 border-l-2 border-violet-800/60 pl-2">
      <div class="group/hdr flex items-center gap-2">
        <button
          type="button"
          class="text-[11px] font-mono text-violet-400/80 hover:text-violet-300 flex items-center gap-1.5"
          onClick={() => toggleBlock(props.blockKey, KIND)}
        >
          <span>{open() ? '▾' : '▸'}</span>
          <span>💭 thinking · {props.block.text.length.toLocaleString()} chars</span>
          <Show when={props.block.streaming}>
            <span class="animate-pulse text-violet-300">▍</span>
          </Show>
          <Show when={props.block.truncated}>
            <span class="text-neutral-600 italic">truncated</span>
          </Show>
        </button>
        <button
          type="button"
          class={`text-[10px] font-mono px-1 rounded border transition-opacity ${allOpen() ? 'border-violet-800 text-violet-300 opacity-100' : 'border-neutral-800 text-neutral-500 opacity-0 group-hover/hdr:opacity-100 hover:text-violet-300'}`}
          title={allOpen() ? 'collapse every thinking block in the loaded history' : 'expand every thinking block in the loaded history'}
          onClick={() => toggleKind(KIND)}
        >{allOpen() ? '⤡ all thinking' : '⤢ all thinking'}</button>
      </div>
      <Show when={open()}>
        <div class="mt-1 text-[13px] leading-relaxed text-violet-200/60 italic whitespace-pre-wrap">
          {props.block.text}
        </div>
      </Show>
    </div>
  );
}

function ToolBlockView(props: {
  block: Extract<UiBlock, { kind: 'tool_use' }>;
  blockKey: string;
  result?: ToolResultInfo;
}) {
  const kind = (): string => `tool:${props.block.name}`;
  const open = (): boolean => isBlockOpen(props.blockKey, kind());
  const allOpen = (): boolean => expandedKinds().has(kind());
  const dot = (): string => ({
    running: 'bg-amber-400 animate-pulse',
    failed: 'bg-rose-500',
    done: 'bg-emerald-500',
    unknown: 'bg-neutral-600',
  })[toolCallState(props.block.status, props.result)];
  const duration = (): string => {
    const ms = props.block.durationMs;
    if (ms === undefined) return '';
    return ms < 1000 ? ` · ${ms}ms` : ` · ${(ms / 1000).toFixed(1)}s`;
  };
  return (
    <div class="my-1">
      <div class="group/hdr flex items-center gap-2">
        <button
          type="button"
          class="font-mono text-xs text-amber-400 bg-amber-950/20 hover:bg-amber-950/40 border border-amber-900/30 px-2 py-1 rounded flex items-center gap-2"
          onClick={() => toggleBlock(props.blockKey, kind())}
        >
          <span class={`w-1.5 h-1.5 rounded-full ${dot()}`} />
          <span>{open() ? '▾' : '▸'} {props.block.name}{duration()}</span>
          <Show when={props.result?.isError}>
            <span class="text-rose-400">error</span>
          </Show>
        </button>
        <button
          type="button"
          class={`text-[10px] font-mono px-1.5 py-0.5 rounded border transition-opacity ${allOpen() ? 'border-amber-800 text-amber-300 opacity-100' : 'border-neutral-800 text-neutral-500 opacity-0 group-hover/hdr:opacity-100 hover:text-amber-300'}`}
          title={allOpen() ? `collapse every ${props.block.name} call in the loaded history` : `expand every ${props.block.name} call in the loaded history (input + result)`}
          onClick={() => toggleKind(kind())}
        >{allOpen() ? `⤡ all ${props.block.name}` : `⤢ all ${props.block.name}`}</button>
      </div>
      <Show when={open()}>
        <div class="mt-1 ml-3 space-y-1">
          <div class="text-[10px] uppercase tracking-wider text-neutral-600">
            input{props.block.truncated ? ' · truncated' : ''}
          </div>
          <ToolPayload raw={props.block.inputJson} />
          <Show when={props.result} fallback={
            <div class="text-[11px] font-mono text-neutral-600 italic">
              {props.block.status === 'running' ? 'running…' : 'no result loaded'}
            </div>
          }>
            <div class="text-[10px] uppercase tracking-wider text-neutral-600">
              result{props.result!.isError ? ' · error' : ''}{props.result!.truncated ? ' · truncated' : ''}
            </div>
            <ToolPayload raw={props.result!.text} isError={props.result!.isError} />
          </Show>
        </div>
      </Show>
    </div>
  );
}

function MediaChips(props: { blocks?: UiBlock[] }) {
  return (
    <For each={(props.blocks ?? []).filter((b): b is Extract<UiBlock, { kind: 'media' }> => b.kind === 'media')}>{(b) => (
      <MediaView mediaType={b.mediaType} mediaRef={b.ref} />
    )}</For>
  );
}

interface CommandHint {
  name: string;
  blurb: string;
}

const COMMANDS: CommandHint[] = [
  { name: '/help', blurb: 'list commands' },
  { name: '/status', blurb: 'agent + branch status' },
  { name: '/recipe', blurb: 'current recipe info' },
  { name: '/usage', blurb: 'session token usage' },
  { name: '/budget', blurb: 'show or set stream token budget' },
  { name: '/branches', blurb: 'list Chronicle branches' },
  { name: '/checkout', blurb: 'switch to named branch' },
  { name: '/checkpoint', blurb: 'save current state as named checkpoint' },
  { name: '/restore', blurb: 'switch to checkpoint' },
  { name: '/undo', blurb: 'revert before last agent turn' },
  { name: '/redo', blurb: 're-apply last undone action' },
  { name: '/nudge', blurb: 'run inference on current context, no new events' },
  { name: '/history', blurb: 'recent messages' },
  { name: '/lessons', blurb: 'list active lessons' },
  { name: '/export', blurb: 'export lessons to ./output/' },
  { name: '/session', blurb: 'list/new/switch/rename/delete sessions' },
  { name: '/newtopic', blurb: 'reset head window with summary' },
  { name: '/mcp', blurb: 'list/add/remove/env MCPL servers' },
  { name: '/tools', blurb: 'each tool\'s effective class and its source' },
  { name: '/fleet', blurb: 'list/peek/stop/restart fleet children' },
  { name: '/clear', blurb: 'clear conversation display' },
  { name: '/quit', blurb: 'export lessons + exit' },
];

function CommandSuggestions(props: { draft: string; onPick: (cmd: string) => void }) {
  const filtered = (): CommandHint[] => {
    const d = props.draft.trim();
    if (!d.startsWith('/')) return [];
    const head = d.split(/\s/)[0]!.toLowerCase();
    if (d.includes(' ')) return [];
    return COMMANDS.filter(c => c.name.startsWith(head)).slice(0, 8);
  };

  return (
    <Show when={filtered().length > 0}>
      <div class="absolute bottom-full left-0 right-0 mx-4 mb-1 bg-neutral-900 border border-neutral-800 rounded shadow-lg max-h-60 overflow-y-auto">
        <For each={filtered()}>{(c) => (
          <button
            type="button"
            class="w-full text-left px-3 py-1.5 hover:bg-neutral-800 flex items-center gap-3 text-xs"
            onClick={() => props.onPick(c.name)}
          >
            <span class="font-mono text-neutral-200 w-24">{c.name}</span>
            <span class="text-neutral-500">{c.blurb}</span>
          </button>
        )}</For>
      </div>
    </Show>
  );
}

type SidebarTabId = 'tree' | 'lessons' | 'mcp' | 'files' | 'context' | 'settings' | 'pins' | 'health';

function SidebarTabs(props: {
  current: SidebarTabId;
  onSelect: (tab: SidebarTabId) => void;
}) {
  const tabs: Array<{ id: SidebarTabId; label: string; title: string }> = [
    { id: 'tree', label: 'Tree', title: 'Agent + fleet tree' },
    { id: 'lessons', label: 'Lessons', title: 'Lesson library' },
    { id: 'mcp', label: 'MCP', title: 'MCPL servers' },
    { id: 'files', label: 'Files', title: 'Workspace mounts + files' },
    { id: 'context', label: 'Context', title: 'Compiled context makeup' },
    { id: 'settings', label: 'Settings', title: 'Live context budget / tail, with preview' },
    { id: 'pins', label: 'Pins', title: 'Protected ranges — constrain what the fold plan may fold' },
    { id: 'health', label: 'Health', title: 'Runtime settings, failures, quarantine' },
  ];
  return (
    <div class="flex border-b border-neutral-800 bg-neutral-900/40 text-[11px]">
      <For each={tabs}>{(t) => (
        <button
          type="button"
          class={`flex-1 px-2 py-1.5 font-mono ${
            props.current === t.id
              ? 'text-neutral-100 bg-neutral-900 border-b border-cyan-700'
              : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-900/60'
          }`}
          title={t.title}
          onClick={() => props.onSelect(t.id)}
        >
          {t.label}
        </button>
      )}</For>
    </div>
  );
}

function ScopeBar(props: {
  scopes: Array<{ id: string; label: string }>;
  scope: string;
  onChange: (scope: string) => void;
}) {
  return (
    <Show when={props.scopes.length > 1}>
      <div class="flex items-center gap-2 px-3 py-1.5 border-b border-neutral-800 bg-neutral-900/20 font-mono">
        <span class="text-neutral-600 uppercase tracking-wider text-[10px] shrink-0" title="Which process the panels below inspect — the host or a fleet child">
          inspecting
        </span>
        <select
          class="flex-1 min-w-0 bg-neutral-900 border border-neutral-700 rounded px-1.5 py-0.5
                 text-[11px] text-neutral-100 focus:outline-none focus:ring-1 focus:ring-cyan-700"
          value={props.scope}
          onChange={(e) => props.onChange(e.currentTarget.value)}
        >
          <For each={props.scopes}>{(s) => (
            <option value={s.id} selected={s.id === props.scope}>{s.label}</option>
          )}</For>
        </select>
      </div>
    </Show>
  );
}

function QuitConfirmModal(props: {
  childNames: string[];
  onAction: (action: 'kill-children' | 'detach' | 'cancel') => void;
}) {
  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div class="bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl max-w-md w-full mx-4 p-5">
        <div class="text-amber-300 text-sm font-semibold mb-2">
          Quit requested
        </div>
        <p class="text-neutral-300 text-sm mb-3">
          {props.childNames.length === 1
            ? `1 fleet child is still running:`
            : `${props.childNames.length} fleet children are still running:`}
        </p>
        <ul class="text-xs font-mono text-neutral-400 mb-4 space-y-0.5">
          <For each={props.childNames}>{(n) => <li>· {n}</li>}</For>
        </ul>
        <div class="grid grid-cols-1 gap-2">
          <button
            type="button"
            class="px-3 py-1.5 rounded bg-rose-900/40 hover:bg-rose-900/60 text-rose-100 text-sm text-left"
            onClick={() => props.onAction('kill-children')}
            title="Stop each child gracefully, then exit."
          >
            <span class="font-semibold">Stop children & exit</span>
            <span class="text-rose-200/70 text-xs ml-2">graceful kill, then host shuts down</span>
          </button>
          <button
            type="button"
            class="px-3 py-1.5 rounded bg-amber-900/30 hover:bg-amber-900/50 text-amber-100 text-sm text-left"
            onClick={() => props.onAction('detach')}
            title="Leave the children running; the host process exits anyway."
          >
            <span class="font-semibold">Detach & exit</span>
            <span class="text-amber-200/70 text-xs ml-2">children orphan, host exits</span>
          </button>
          <button
            type="button"
            class="px-3 py-1.5 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-sm text-left"
            onClick={() => props.onAction('cancel')}
            title="Cancel the quit request."
          >
            <span class="font-semibold">Cancel</span>
            <span class="text-neutral-500 text-xs ml-2">stay running</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ReconnectBanner(props: { status: string }) {
  const [droppedSince, setDroppedSince] = createSignal<number | null>(null);
  const [now, setNow] = createSignal(Date.now());

  const updateDropTime = (): void => {
    if (props.status === 'open' || props.status === 'connecting') {
      setDroppedSince(null);
    } else if (droppedSince() === null) {
      setDroppedSince(Date.now());
    }
  };
  const trackStatus = (): void => { void props.status; updateDropTime(); };

  onMount(() => {
    trackStatus();
    const interval = setInterval(() => {
      trackStatus();
      setNow(Date.now());
    }, 1000);
    onCleanup(() => clearInterval(interval));
  });

  const elapsed = (): string => {
    const dropped = droppedSince();
    if (dropped === null) return '';
    const sec = Math.floor((now() - dropped) / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ${sec % 60}s`;
    return `${Math.floor(min / 60)}h ${min % 60}m`;
  };

  return (
    <Show when={droppedSince() !== null}>
      <div class="bg-rose-950/60 border-b border-rose-900 px-4 py-1.5 text-xs text-rose-200 flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
        <span>Disconnected — retrying ({elapsed()} elapsed). Check the host process.</span>
      </div>
    </Show>
  );
}

function RecipePane(props: { welcome: WelcomeMessage | null; scope: string }) {
  const displayed = (): { name: string; description?: string; agentModel?: string; scopeLabel: string } | null => {
    if (!props.welcome) return null;
    if (props.scope === 'local') {
      return {
        name: props.welcome.recipe.name,
        ...(props.welcome.recipe.description ? { description: props.welcome.recipe.description } : {}),
        ...(props.welcome.agents[0]?.model ? { agentModel: props.welcome.agents[0].model } : {}),
        scopeLabel: 'parent',
      };
    }
    const child = props.welcome.childTrees.find(c => c.name === props.scope);
    if (!child) return null;
    if (!child.recipe) {
      return { name: child.name, scopeLabel: 'child' };
    }
    return {
      name: child.recipe.name,
      ...(child.recipe.description ? { description: child.recipe.description } : {}),
      ...(child.recipe.agentModel ? { agentModel: child.recipe.agentModel } : {}),
      scopeLabel: `child · ${child.name}`,
    };
  };

  return (
    <div class="border-t border-neutral-800 px-3 py-2 text-[11px] space-y-0.5">
      <div class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold flex items-center gap-2">
        <span>recipe</span>
        <Show when={displayed()}>
          <span class="text-neutral-600 normal-case tracking-normal">· {displayed()!.scopeLabel}</span>
        </Show>
      </div>
      <Show when={displayed()} fallback={<div class="text-neutral-600 italic">…</div>}>
        <div class="text-neutral-300">{displayed()!.name}</div>
        <Show when={displayed()!.description}>
          <div class="text-neutral-500 truncate" title={displayed()!.description}>
            {displayed()!.description}
          </div>
        </Show>
        <Show when={displayed()!.agentModel}>
          <div class="text-neutral-600 font-mono">
            {displayed()!.agentModel}
          </div>
        </Show>
      </Show>
    </div>
  );
}

function lineStyleClass(style?: string): string {
  switch (style) {
    case 'user': return 'text-emerald-400';
    case 'agent': return 'text-neutral-100';
    case 'tool': return 'text-amber-400';
    case 'system': return 'text-neutral-300';
    default: return 'text-neutral-300';
  }
}

function parseRoute(input: string): { childName: string; content: string } | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('@') || trimmed.startsWith('@@')) return null;
  const m = /^@([a-zA-Z0-9_.-]+)(?::|\s)\s*([\s\S]+)$/.exec(trimmed);
  if (!m) return null;
  const content = m[2]!.trim();
  if (!content) return null;
  return { childName: m[1]!, content };
}

marked.setOptions({ async: false, breaks: false, gfm: true });

// marked 14 has no built-in sanitizer, and the default DOMPurify config
// drops <script>, on* handlers and dangerous URL schemes.
function renderMarkdown(src: string): string {
  if (!src) return '';
  try {
    const html = marked.parse(src) as string;
    return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  } catch {
    return escapeHtml(src);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]!);
}
