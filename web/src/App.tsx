import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { createWireClient, type WireClient } from './wire';
import { createTreeStore, type StreamSource, type UiNode } from './tree';
import { TreeSidebar } from './TreeSidebar';
import { StreamPanel, formatStreamEvent, type StreamLine } from './Stream';
import { UsagePanel } from './Usage';
import { LessonsPanel, type LessonRow } from './Lessons';
import { McplPanel, type McplServerRow } from './Mcpl';
import { FilesPanel, FileViewerModal, type Mount, type FlatEntry, type FileViewer } from './Files';
import { ContextPanel } from './Context';
import { ContextDocument } from './ContextDocument';
import {
  WEB_PROTOCOL_VERSION,
  isProtocolCompatible,
  type WebUiServerMessage,
  type WelcomeMessage,
  type WelcomeMessageEntry,
  type HistoryPageMessage,
  type MessageBlock,
  type TokenUsage,
  type PerAgentCost,
} from '@conhost/web/protocol';

/** Client-side block: the wire MessageBlock plus live-stream bookkeeping. */
type UiBlock =
  | { kind: 'text'; text: string; truncated?: boolean; streaming?: boolean }
  | { kind: 'thinking'; text: string; truncated?: boolean; streaming?: boolean }
  | { kind: 'redacted_thinking'; bytes: number }
  | {
      kind: 'tool_use'; id: string; name: string; inputJson: string; truncated?: boolean;
      /** Live lifecycle from tool:* traces; undefined for historical calls. */
      status?: 'running' | 'done' | 'failed';
      durationMs?: number;
    }
  | { kind: 'tool_result'; toolUseId: string; text: string; isError?: boolean; truncated?: boolean }
  | { kind: 'media'; mediaType: string }
  /** Client-only: a tool call being written live (raw partial JSON from
   *  blockType 'tool_call' token deltas). Replaced by the parsed tool_use
   *  blocks when inference:tool_calls_yielded lands. */
  | { kind: 'tool_draft'; text: string; streaming?: boolean };

interface Message {
  id: string;
  participant: 'user' | 'assistant' | 'system' | 'tool' | 'command' | 'trigger';
  text: string;
  /** Ordered content blocks — present on server-sourced and streamed
   *  messages; absent on synthetic command/trigger rows. */
  blocks?: UiBlock[];
  /** Store slot index (paging cursor); absent on synthetic messages. */
  index?: number;
  /** Epoch millis. Server value for canonical entries; client clock for
   *  optimistic/streamed rows until the canonical entry replaces them. */
  timestamp?: number;
  /** Per-line style — only set for `command` messages from /slash output. */
  lines?: Array<{ text: string; style?: 'user' | 'agent' | 'tool' | 'system' }>;
  /** True if the message is mid-stream — render with a cursor cue. */
  streaming?: boolean;
  /** For 'trigger' participant: origin/source/author metadata for the box header. */
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
    participant: e.participant,
    text: e.text,
    blocks: (e.blocks ?? []) as UiBlock[],
    index: e.index,
    timestamp: e.timestamp,
  };
}

export function App() {
  const wire = createWireClient();
  const treeStore = createTreeStore();

  // Use a store rather than a signal so the streaming token append can
  // mutate the last message's `text` in place. Replacing the message object
  // (as a plain signal would force) makes <For> remount the DOM, which
  // replays the msg-enter fade — visible as a wholesale flicker on every
  // token. Keyed-by-id mutation keeps the same DOM element throughout.
  const [messages, setMessages] = createStore<Message[]>([]);
  const [welcome, setWelcome] = createSignal<WelcomeMessage | null>(null);
  /** History paging state: slot index of the earliest loaded message +
   *  store total. Null until the first welcome. */
  const [historyInfo, setHistoryInfo] = createSignal<{ startIndex: number; totalCount: number } | null>(null);
  const [historyLoading, setHistoryLoading] = createSignal(false);
  /** Server protocol version when it doesn't match this bundle (stale
   *  dist/web or old host) — renders a persistent banner. */
  const [protoMismatch, setProtoMismatch] = createSignal<number | null>(null);
  /** Store ids of server-sourced messages currently rendered — dedupe set
   *  for message-appended / history-page / re-welcome overlap. */
  let knownIds = new Set<string>();
  /** session.id + '/' + branch.id of the last welcome; same key → soft
   *  merge (keep paged-in scrollback), changed key → hard reset. */
  let welcomeKey: string | null = null;
  /** Whether the operator is pinned to the bottom of the scroll pane.
   *  Autoscroll only fires when true, so reading history isn't yanked. */
  let atBottom = true;
  let historyCorrSeq = 0;
  let pendingHistoryCorr: string | null = null;
  let pendingHistoryTimer: number | undefined;
  const [usage, setUsage] = createSignal<TokenUsage>({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const [perAgentCost, setPerAgentCost] = createSignal<PerAgentCost[]>([]);
  const [draft, setDraft] = createSignal('');
  /** Currently-focused tree node + the panel mode rendered on its behalf.
   *  `mode` decides whether the side panel shows live stream events or a
   *  static usage breakdown; clicking the row opens 'stream', clicking the
   *  token badge opens 'usage'. Both share the same panel slot. */
  type PanelMode = 'stream' | 'usage';
  const [focusedId, setFocusedId] = createSignal<string | null>(null);
  const [focusedNode, setFocusedNode] = createSignal<UiNode | null>(null);
  const [panelMode, setPanelMode] = createSignal<PanelMode | null>(null);
  const [streamLines, setStreamLines] = createSignal<StreamLine[]>([]);
  /** Default-collapsed; the parent root and freshly-spawned fleet children
   *  auto-expand once on first sight, so users see structure without a click. */
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set(['process:local']));
  const seenAutoExpand = new Set<string>(['process:local']);
  /** Names of fleet children the server says are still running when /quit
   *  was invoked. Non-null = the quit-confirm modal is open. */
  const [quitConfirm, setQuitConfirm] = createSignal<string[] | null>(null);

  /** Right-sidebar tab selection. The Tree is the most-used surface so it's
   *  the default; lessons / mcp / files are operator-driven panels. */
  type SidebarTab = 'tree' | 'lessons' | 'mcp' | 'files' | 'context';
  const [sidebarTab, setSidebarTab] = createSignal<SidebarTab>('tree');
  const [mainView, setMainView] = createSignal<'chat' | 'context'>('chat');

  /** Scope shared by Lessons / Files / Recipe panels. 'local' means the
   *  parent process; otherwise the fleet child's name. The scope is shared
   *  so an operator can pin a child of interest and see all three views
   *  without re-selecting per panel. */
  const [panelScope, setPanelScope] = createSignal<string>('local');
  const availableScopes = (): Array<{ id: string; label: string }> => {
    const w = welcome();
    const local = { id: 'local', label: w?.recipe.name ?? 'parent' };
    const children = (w?.childTrees ?? []).map(c => ({
      id: c.name,
      label: c.recipe?.name ? `${c.name} · ${c.recipe.name}` : c.name,
    }));
    return [local, ...children];
  };

  /** Lessons panel state — populated by 'lessons-list' responses to a
   *  'request-lessons' message. */
  const [lessons, setLessons] = createSignal<LessonRow[]>([]);
  const [lessonsLoaded, setLessonsLoaded] = createSignal(false);
  const [lessonsModuleLoaded, setLessonsModuleLoaded] = createSignal(false);
  const refreshLessons = (): void => {
    setLessonsLoaded(false);
    wire.send({ type: 'request-lessons', scope: panelScope() });
  };

  /** MCPL panel state — populated by 'mcpl-list' responses, which the server
   *  also re-sends after every mutation so the panel auto-refreshes. */
  const [mcplServers, setMcplServers] = createSignal<McplServerRow[]>([]);
  const [mcplLoaded, setMcplLoaded] = createSignal(false);
  const [mcplConfigPath, setMcplConfigPath] = createSignal('');
  const refreshMcpl = (): void => {
    setMcplLoaded(false);
    wire.send({ type: 'request-mcpl' });
  };

  /** Workspace files panel state — mounts list + per-mount tree cache. */
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

  /** Switch the shared panel scope. Invalidates cached lessons/files so the
   *  new scope's data is re-fetched on next access. MCPL config is global,
   *  so it doesn't follow scope. */
  const changePanelScope = (scope: string): void => {
    if (scope === panelScope()) return;
    setPanelScope(scope);
    setLessonsLoaded(false);
    setLessons([]);
    setMountsLoaded(false);
    setMounts([]);
    setTreesByMount(new Map<string, FlatEntry[]>());
    setExpandedMounts(new Set<string>());
    // Re-request whichever tab the operator is currently looking at; the
    // others will lazy-load when they're opened.
    if (sidebarTab() === 'lessons') refreshLessons();
    if (sidebarTab() === 'files') refreshMounts();
  };
  /** Pending-token buffer for the active stream; flushes on newline or non-token event. */
  let streamTokenBuffer = '';

  /** Per-childName ring buffer of recent child-event payloads. Used to
   *  backfill the stream pane when an operator opens a fleet child / agent
   *  view — events fan out to every connected client regardless of focus, so
   *  we capture them as they pass through. */
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

  // Append-to-last-assistant streaming buffer. createStore lets us mutate
  // the existing message's blocks in place — Solid's <For> sees the same
  // item reference and only updates the changed text, instead of remounting
  // the row (which would replay the entrance animation).
  //
  // Tokens are routed by trace blockType: 'text' → visible prose, 'thinking'
  // → a live thinking block, 'tool_call' → a live "writing tool call" draft
  // (raw partial JSON; replaced by the parsed call on tool_calls_yielded).
  // (Previously ALL tokens were appended to the visible text, so enabling
  // extended thinking polluted the markdown.)
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

  /** block_complete → clear the open block's streaming flag (a finished
   *  thinking block auto-collapses to its header). */
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

  /** Attach yielded tool calls to the streaming assistant message as
   *  tool_use blocks (status: running). Results pair up later via the
   *  tool_result blocks arriving in message-appended frames. */
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
      // The parsed calls supersede any live tool_draft scaffolding.
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

  /** Flip a tool_use block's lifecycle from tool:* traces, matched by callId
   *  over the most recent messages. */
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

  // -------------------------------------------------------------------------
  // Windowed history: welcome merge, upward paging, live appends
  // -------------------------------------------------------------------------

  const applyWelcome = (msg: WelcomeMessage): void => {
    if (!isProtocolCompatible(msg.protocolVersion)) {
      setProtoMismatch(msg.protocolVersion);
      return;
    }
    setProtoMismatch(null);
    setWelcome(msg);
    const key = `${msg.session.id}/${msg.branch.id}`;
    const entries = msg.messages.map(entryToMessage);

    if (key !== welcomeKey) {
      // Session/branch changed (or first connect): hard reset.
      welcomeKey = key;
      knownIds = new Set(entries.map((m) => m.id).filter((id) => !isSyntheticId(id)));
      setMessages(entries);
      setHistoryInfo({ startIndex: msg.history.startIndex, totalCount: msg.history.totalCount });
      atBottom = true;
      queueScroll();
      return;
    }

    // Same session+branch (reconnect / setApp re-welcome): keep paged-in
    // older scrollback, replace the tail with the canonical window. Synthetic
    // rows (optimistic user msgs, command output, triggers) are dropped —
    // the canonical entries carry the durable conversation.
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
      // Canonical assistant message replaces the streamed scaffold (brings
      // authoritative block order, signatures, redacted blocks).
      if (incoming.participant === 'assistant' && last?.participant === 'assistant' && last.streaming) {
        // Preserve live tool statuses the trace stream already delivered.
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
      // Server echo of a message typed here: adopt into the optimistic row.
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

  const requestOlder = (): void => {
    const info = historyInfo();
    if (!info || info.startIndex <= 0 || historyLoading() || protoMismatch() !== null) return;
    const corrId = `h${++historyCorrSeq}`;
    pendingHistoryCorr = corrId;
    setHistoryLoading(true);
    wire.send({ type: 'request-history', corrId, beforeIndex: info.startIndex, limit: 200 });
    window.clearTimeout(pendingHistoryTimer);
    pendingHistoryTimer = window.setTimeout(() => {
      if (pendingHistoryCorr === corrId) {
        pendingHistoryCorr = null;
        setHistoryLoading(false);
      }
    }, 10_000);
  };

  const applyHistoryPage = (msg: HistoryPageMessage): void => {
    if (msg.corrId !== pendingHistoryCorr) return;
    pendingHistoryCorr = null;
    window.clearTimeout(pendingHistoryTimer);
    setHistoryLoading(false);
    const fresh = msg.entries.filter((e) => !(e.id && knownIds.has(e.id)));
    for (const e of fresh) if (e.id) knownIds.add(e.id);
    // Prepending grows the pane upward; restore the operator's viewport by
    // offsetting scrollTop by the height delta after the DOM settles.
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
  };

  const onScrollPane = (): void => {
    if (!scrollPane) return;
    atBottom = scrollPane.scrollHeight - scrollPane.scrollTop - scrollPane.clientHeight < 80;
    if (scrollPane.scrollTop < 400) requestOlder();
  };

  /** toolUseId → result block, across all loaded messages. Rendered inline
   *  under the matching tool_use; standalone all-paired result rows hide. */
  const toolResults = createMemo(() => {
    const map = new Map<string, { text: string; isError?: boolean; truncated?: boolean }>();
    for (const m of messages) {
      for (const b of m.blocks ?? []) {
        if (b.kind === 'tool_result') map.set(b.toolUseId, b);
      }
    }
    return map;
  });

  /** ids of all tool_use blocks currently loaded — lets a pure-tool_result
   *  message know its content is already displayed inline. */
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
      setStreamLines((prev) => [...prev, ...lines.map(s => ({
        id: streamLineId(),
        kind: 'token' as const,
        text: s,
        color: 'text-cyan-200',
      }))]);
    }
  };

  const flushStreamBuffer = (): void => {
    if (streamTokenBuffer.length === 0) return;
    const text = streamTokenBuffer;
    streamTokenBuffer = '';
    setStreamLines((prev) => [...prev, {
      id: streamLineId(),
      kind: 'token' as const,
      text,
      color: 'text-cyan-200',
    }]);
  };

  /** Tear down any peek subscription tied to the currently focused node.
   *  Idempotent — safe to call when nothing's focused or when the focused
   *  node was a non-peek source. */
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
      // Re-clicking same node in stream mode closes the panel.
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
      // Replay buffered child-events for this child so the panel isn't blank.
      const buf = childEventBuffers.get(node.streamSource.childName);
      if (buf) for (const ev of buf) ingestStreamEvent(ev);
    } else if (node.streamSource.kind === 'child-event-agent') {
      // Replay only events attributable to this agent inside the child.
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
      // Re-clicking the same usage badge toggles closed.
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

  const toggleExpand = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const cancelSubagent = (name: string, childName?: string): void => {
    wire.send({ type: 'cancel-subagent', name, ...(childName ? { childName } : {}) });
  };

  const fleetStop = (name: string): void => {
    wire.send({ type: 'fleet-stop', name });
  };

  const fleetRestart = (name: string): void => {
    wire.send({ type: 'fleet-restart', name });
  };

  /** Stop the focused stream's underlying node, dispatched by stream source kind. */
  const stopFocusedNode = (): void => {
    const node = focusedNode();
    if (!node) return;
    const src = node.streamSource;
    if (src.kind === 'peek') cancelSubagent(src.scope);
    else if (src.kind === 'child-event-all') fleetStop(src.childName);
    else if (src.kind === 'child-event-agent') {
      // For a subagent inside a fleet child, route the cancel to that
      // child's SubagentModule rather than killing the whole child. The
      // main framework agent of a child is not a subagent — for that we
      // still have no per-agent kill verb, so fall back to fleetStop.
      if (node.kind === 'subagent') cancelSubagent(src.agentName, src.childName);
      else fleetStop(src.childName);
    }
  };

  /** Whether the current focused node has a sensible stop affordance. */
  const canStopFocused = (): boolean => {
    const node = focusedNode();
    if (!node) return false;
    const src = node.streamSource;
    if (src.kind === 'peek') {
      return node.agent?.status === 'running';
    }
    return src.kind === 'child-event-all' || src.kind === 'child-event-agent';
  };

  /** Auto-expand newly-discovered fleet-child folders the first time they
   *  appear, so the user sees their agents without an extra click. */
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
      // Protocol mismatch: this bundle was compiled against a different wire
      // shape than the server speaks. Stop folding frames entirely (they may
      // parse but mean something else) — only a fresh `welcome` (e.g. after
      // the host restarts on the matching version) can lift the freeze. The
      // banner tells the operator to rebuild/reload.
      if (protoMismatch() !== null && msg.type !== 'welcome') return;
      treeStore.ingest(msg);
      autoExpandNewFleetChildren();
      // Capture child-events into the per-childName ring buffer so a future
      // openStream() can backfill the panel from local history.
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
        appendStreamToken,
        appendToolUseBlocks,
        updateToolStatus,
        handleContentBlock,
        finishStream,
        queueScroll,
        openQuitConfirm: (children) => setQuitConfirm(children),
        setLessons: (loaded, moduleLoaded, list) => {
          setLessonsLoaded(loaded);
          setLessonsModuleLoaded(moduleLoaded);
          setLessons(list);
        },
        setMcpl: (configPath, servers) => {
          setMcplLoaded(true);
          setMcplConfigPath(configPath);
          setMcplServers(servers);
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
      });
    });
    onCleanup(() => {
      detach();
      wire.close();
    });
  });

  /** Route a server message into the stream pane *if* it matches the focused
   *  node's StreamSource. Each kind has its own match rule. */
  const handleStreamMessage = (msg: WebUiServerMessage): void => {
    if (panelMode() !== 'stream') return;
    const node = focusedNode();
    if (!node) return;
    const src = node.streamSource;
    if (src.kind === 'none') return;

    if (src.kind === 'peek' && msg.type === 'peek' && msg.scope === src.scope) {
      ingestStreamEvent(msg.event);
      return;
    }

    if (msg.type !== 'child-event') return;

    if (src.kind === 'child-event-all' && msg.childName === src.childName) {
      ingestStreamEvent(msg.event);
      return;
    }

    if (
      src.kind === 'child-event-agent'
      && msg.childName === src.childName
      && (msg.event as { agentName?: string }).agentName === src.agentName
    ) {
      ingestStreamEvent(msg.event);
      return;
    }
  };

  const ingestStreamEvent = (event: { type: string; [k: string]: unknown }): void => {
    if ((event.type === 'inference:tokens' || event.type === 'tokens') && typeof event.content === 'string') {
      appendStreamPaneToken(event.content);
      return;
    }
    flushStreamBuffer();
    const line = formatStreamEvent(event);
    if (line) setStreamLines((prev) => [...prev, line]);
  };

  const submit = (): void => {
    const text = draft().trim();
    if (!text) return;
    setDraft('');
    if (text.startsWith('/')) {
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
      <Header welcome={welcome()} usage={usage()} status={wire.status()} />
      <ReconnectBanner status={wire.status()} />
      <Show when={protoMismatch() !== null}>
        <div class="bg-amber-950/60 border-b border-amber-900 px-4 py-1.5 text-xs text-amber-200 flex items-center gap-2">
          <span class="w-2 h-2 rounded-full bg-amber-500" />
          <span>
            Protocol mismatch — server speaks v{protoMismatch()}, this bundle expects v{WEB_PROTOCOL_VERSION}.
            Rebuild the SPA (<code class="font-mono">bun run build:web</code>) and/or restart the host, then reload.
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
          </div>
          <div
            ref={scrollPane}
            class="flex-1 overflow-y-auto px-4 py-3 space-y-3"
            onScroll={onScrollPane}
          >
            <Show when={mainView() === 'context'} fallback={<>
            <Show when={(historyInfo()?.startIndex ?? 0) > 0}>
              <button
                type="button"
                class="w-full text-center text-xs font-mono text-neutral-500 hover:text-neutral-300 py-1.5 border border-dashed border-neutral-800 rounded"
                onClick={requestOlder}
                disabled={historyLoading()}
              >
                {historyLoading()
                  ? 'loading…'
                  : `▲ ${historyInfo()!.startIndex} older message${historyInfo()!.startIndex === 1 ? '' : 's'} — scroll or click to load`}
              </button>
            </Show>
            <Show when={messages.length === 0}>
              <div class="text-neutral-500 text-sm italic">
                Connected. Type a message or /help to begin.
              </div>
            </Show>
            <For each={messages}>{(m) => (
              <MessageView msg={m} results={toolResults()} toolUseIds={toolUseIds()} />
            )}</For>
            </>}>
              <ContextDocument agent={panelScope() === 'local' ? undefined : panelScope()} />
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
              onClose={closePanel}
            />
          )}
        </Show>
        <aside class="w-72 border-l border-neutral-800 bg-neutral-950 shrink-0 flex flex-col">
          <SidebarTabs
            current={sidebarTab()}
            onSelect={(tab) => {
              setSidebarTab(tab);
              // Lazy-load tab data on first open. Mutations re-broadcast a
              // fresh list so we don't need to re-fetch after every change.
              if (tab === 'lessons' && !lessonsLoaded()) refreshLessons();
              if (tab === 'mcp' && !mcplLoaded()) refreshMcpl();
              if (tab === 'files' && !mountsLoaded()) refreshMounts();
            }}
          />
          <div class="flex-1 min-h-0">
            <Show when={sidebarTab() === 'tree'}>
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
                scope={panelScope()}
                scopes={availableScopes()}
                onScopeChange={changePanelScope}
                onRefresh={refreshLessons}
              />
            </Show>
            <Show when={sidebarTab() === 'mcp'}>
              <McplPanel
                loaded={mcplLoaded()}
                configPath={mcplConfigPath()}
                servers={mcplServers()}
                onRefresh={refreshMcpl}
                onAdd={(input) => wire.send({ type: 'mcpl-add', ...input })}
                onRemove={(id) => wire.send({ type: 'mcpl-remove', id })}
                onSetEnv={(id, env) => wire.send({ type: 'mcpl-set-env', id, env })}
              />
            </Show>
            <Show when={sidebarTab() === 'files'}>
              <FilesPanel
                loaded={mountsLoaded()}
                moduleLoaded={workspaceModuleLoaded()}
                mounts={mounts()}
                treesByMount={treesByMount()}
                expandedMounts={expandedMounts()}
                scope={panelScope()}
                scopes={availableScopes()}
                onScopeChange={changePanelScope}
                onRefreshMounts={refreshMounts}
                onExpandMount={expandMount}
                onCollapseMount={collapseMount}
                onOpenFile={requestFile}
              />
            </Show>
            <Show when={sidebarTab() === 'context'}>
              <ContextPanel agent={panelScope() === 'local' ? undefined : panelScope()} />
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
    case 'child-event-all': return 'fleet child';
    case 'child-event-agent': return `agent in ${src.childName}`;
    default: return undefined;
  }
}

interface HandlerHooks {
  /** Merge (or hard-reset on session/branch change) a welcome frame. */
  applyWelcome: (w: WelcomeMessage) => void;
  /** Fold a message-appended push into the timeline (id-deduped). */
  applyAppended: (entry: WelcomeMessageEntry) => void;
  /** Prepend a history page with scroll-anchor preservation. */
  applyHistoryPage: (msg: HistoryPageMessage) => void;
  /** Append a single message at the end (used for command-result, errors, etc.). */
  appendMessage: (msg: Message) => void;
  setUsage: (u: TokenUsage) => void;
  setPerAgentCost: (c: PerAgentCost[]) => void;
  appendStreamToken: (token: string, blockType?: string) => void;
  /** Attach yielded tool calls to the streaming assistant message. */
  appendToolUseBlocks: (calls: Array<{ id: string; name: string; input?: unknown }>) => void;
  /** Flip a tool_use block's live status from tool:* traces. */
  updateToolStatus: (callId: string, status: 'done' | 'failed', durationMs?: number) => void;
  /** Handle inference:content_block phases (auto-collapse finished blocks). */
  handleContentBlock: (phase: string) => void;
  finishStream: () => void;
  queueScroll: () => void;
  /** Show the quit-confirm modal with the given list of running children. */
  openQuitConfirm: (children: string[]) => void;
  /** Apply a lessons-list response from the server. */
  setLessons: (loaded: boolean, moduleLoaded: boolean, lessons: LessonRow[]) => void;
  /** Apply an mcpl-list response from the server. */
  setMcpl: (configPath: string, servers: McplServerRow[]) => void;
  /** Apply a workspace-mounts response. */
  setMounts: (loaded: boolean, moduleLoaded: boolean, mounts: Mount[]) => void;
  /** Apply a workspace-tree response for one mount. */
  setMountTree: (mount: string, entries: FlatEntry[]) => void;
  /** Apply a workspace-file response. */
  setOpenFile: (file: FileViewer) => void;
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
      return;
    }
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
    case 'trace': {
      const e = msg.event;
      switch (e.type) {
        case 'inference:tokens': {
          const content = e.content;
          if (typeof content === 'string') {
            hooks.appendStreamToken(content, typeof e.blockType === 'string' ? e.blockType : undefined);
          }
          return;
        }
        case 'inference:content_block': {
          if (typeof e.phase === 'string') hooks.handleContentBlock(e.phase);
          return;
        }
        case 'inference:completed':
        case 'inference:failed':
          hooks.finishStream();
          return;
        case 'inference:tool_calls_yielded': {
          const calls = (e.calls as Array<{ id: string; name: string; input?: unknown }> | undefined) ?? [];
          if (calls.length === 0) return;
          hooks.appendToolUseBlocks(calls);
          return;
        }
        case 'tool:completed': {
          if (typeof e.callId === 'string') {
            hooks.updateToolStatus(e.callId, 'done',
              typeof e.durationMs === 'number' ? e.durationMs : undefined);
          }
          return;
        }
        case 'tool:failed': {
          if (typeof e.callId === 'string') {
            hooks.updateToolStatus(e.callId, 'failed',
              typeof e.durationMs === 'number' ? e.durationMs : undefined);
          }
          return;
        }
        default:
          return;
      }
    }
    case 'command-result': {
      hooks.appendMessage({
        id: nextMessageId(),
        participant: 'command',
        text: msg.lines.map(l => l.text).join('\n'),
        lines: msg.lines,
      });
      hooks.queueScroll();
      return;
    }
    case 'branch-changed':
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
      hooks.setLessons(true, msg.loaded, msg.lessons);
      return;
    case 'mcpl-list':
      hooks.setMcpl(msg.configPath, msg.servers);
      return;
    case 'workspace-mounts':
      hooks.setMounts(true, msg.loaded, msg.mounts);
      return;
    case 'workspace-tree':
      hooks.setMountTree(msg.mount, msg.entries);
      return;
    case 'workspace-file':
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
  status: string;
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
      <Show when={props.welcome?.branch.name && props.welcome.branch.name !== 'main'}>
        <div class="text-amber-400 text-xs font-mono px-1.5 py-0.5 bg-amber-950/30 rounded">
          {props.welcome!.branch.name}
        </div>
      </Show>
      <div class="ml-auto text-xs font-mono text-neutral-500">
        {fmt(props.usage.input)} in
        <span class="ml-2">{fmt(props.usage.output)} out</span>
        <Show when={props.usage.cacheRead > 0}>
          <span class="ml-2">{fmt(props.usage.cacheRead)} cache</span>
        </Show>
        <Show when={props.usage.cost && props.usage.cost.total > 0}>
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
        <div class="text-xs text-neutral-500 mb-1">you<TimeChip ts={props.msg.timestamp} /></div>
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
    // A message whose payload is entirely tool_results that are already
    // rendered inline under their tool_use blocks carries no new
    // information — hide it. Unpaired results render standalone.
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
    // Bordered box with an origin chip — emphasises that the agent didn't
    // generate this; the world did. Dim when the gate filtered it (no wake).
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

// ---------------------------------------------------------------------------
// Block rendering — the interiority layer
// ---------------------------------------------------------------------------

/** Compact timestamp chip for message headers. Time-only for today,
 *  "Jul 5 14:22:07" otherwise; full ISO on hover. */
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

/**
 * Readable rendering for tool inputs/results. Raw payloads are JSON (tool
 * inputs always; shell/MCPL results usually — often DOUBLE-encoded), which
 * renders as escape-soup. Strategy:
 *   - parse; unwrap one level of double-encoding ("\"{...}\"")
 *   - object → per-field rows: long/multiline strings as real pre-wrapped
 *     text (the `think` tool's `thought`, shell `command`s, file contents),
 *     short values inline
 *   - bare string → pre-wrapped text
 *   - arrays/other/unparseable → pretty JSON / raw fallback
 */
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
    // Double-encoded payload: a JSON string that itself contains JSON.
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

/** Expand/collapse state for thinking + tool blocks, keyed `${msgId}:${idx}`.
 *  Module-scope signal: one timeline per page, and survival across <For>
 *  row recycling is exactly what we want. */
const [expandedBlocks, setExpandedBlocks] = createSignal<Set<string>>(new Set());
const toggleBlock = (key: string): void => {
  setExpandedBlocks((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
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
    // Standalone (unpaired) result — its tool_use isn't loaded.
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
  // media
  return (
    <div class="my-1 inline-block text-[11px] font-mono text-sky-400/80 bg-sky-950/20 border border-sky-900/40 rounded px-2 py-0.5">
      📎 {b.mediaType}
    </div>
  );
}

function TextBlockView(props: { block: Extract<UiBlock, { kind: 'text' }> }) {
  // While streaming: plain pre-wrap text — no markdown reparse per token.
  // Once final: parse once via memo (recomputes only if text changes again).
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
  // Expanded while streaming (watch the mind move), collapsed once done —
  // unless the operator pinned it open.
  const open = (): boolean => props.block.streaming === true || expandedBlocks().has(props.blockKey);
  return (
    <div class="my-1.5 border-l-2 border-violet-800/60 pl-2">
      <button
        type="button"
        class="text-[11px] font-mono text-violet-400/80 hover:text-violet-300 flex items-center gap-1.5"
        onClick={() => toggleBlock(props.blockKey)}
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
  const open = (): boolean => expandedBlocks().has(props.blockKey);
  const dot = (): string => {
    if (props.block.status === 'running') return 'bg-amber-400 animate-pulse';
    if (props.block.status === 'failed' || props.result?.isError) return 'bg-rose-500';
    if (props.block.status === 'done' || props.result) return 'bg-emerald-500';
    return 'bg-neutral-600';
  };
  const duration = (): string => {
    const ms = props.block.durationMs;
    if (ms === undefined) return '';
    return ms < 1000 ? ` · ${ms}ms` : ` · ${(ms / 1000).toFixed(1)}s`;
  };
  return (
    <div class="my-1">
      <button
        type="button"
        class="font-mono text-xs text-amber-400 bg-amber-950/20 hover:bg-amber-950/40 border border-amber-900/30 px-2 py-1 rounded flex items-center gap-2"
        onClick={() => toggleBlock(props.blockKey)}
      >
        <span class={`w-1.5 h-1.5 rounded-full ${dot()}`} />
        <span>{open() ? '▾' : '▸'} {props.block.name}{duration()}</span>
        <Show when={props.result?.isError}>
          <span class="text-rose-400">error</span>
        </Show>
      </button>
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
    <For each={(props.blocks ?? []).filter((b) => b.kind === 'media')}>{(b) => (
      <div class="mt-1 inline-block mr-1 text-[11px] font-mono text-sky-400/80 bg-sky-950/20 border border-sky-900/40 rounded px-2 py-0.5">
        📎 {(b as Extract<UiBlock, { kind: 'media' }>).mediaType}
      </div>
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
  { name: '/history', blurb: 'recent messages' },
  { name: '/lessons', blurb: 'list active lessons' },
  { name: '/export', blurb: 'export lessons to ./output/' },
  { name: '/session', blurb: 'list/new/switch/rename/delete sessions' },
  { name: '/newtopic', blurb: 'reset head window with summary' },
  { name: '/mcp', blurb: 'list/add/remove/env MCPL servers' },
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

function SidebarTabs(props: {
  current: 'tree' | 'lessons' | 'mcp' | 'files' | 'context';
  onSelect: (tab: 'tree' | 'lessons' | 'mcp' | 'files' | 'context') => void;
}) {
  const tabs: Array<{ id: 'tree' | 'lessons' | 'mcp' | 'files' | 'context'; label: string; title: string }> = [
    { id: 'tree', label: 'Tree', title: 'Agent + fleet tree' },
    { id: 'lessons', label: 'Lessons', title: 'Lesson library' },
    { id: 'mcp', label: 'MCP', title: 'MCPL servers' },
    { id: 'files', label: 'Files', title: 'Workspace mounts + files' },
    { id: 'context', label: 'Context', title: 'Compiled context makeup' },
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

/** Stub used while a tab's full content isn't shipped yet. Replaced as each
 *  panel lands. */
function PlaceholderPanel(props: { label: string }) {
  return (
    <div class="px-3 py-3 text-xs text-neutral-600 italic">
      {props.label} — coming soon.
    </div>
  );
}

function QuitConfirmModal(props: {
  childNames: string[];
  onAction: (action: 'kill-children' | 'detach' | 'cancel') => void;
}) {
  // Centered overlay rather than a corner banner — quit is a deliberate
  // action, so the dialog should command attention.
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
  /** Pick the displayed recipe based on the current panel scope: parent
   *  process when scope is 'local', otherwise the matching child entry
   *  from welcome.childTrees (recipe summary loaded by the host). */
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

// marked v14 has no built-in sanitizer (the `sanitize` option was removed),
// and assistant output is the *primary* untrusted input on this admin
// surface — a tool result, mined-knowledge ingestion, or peeked subagent
// line that contains literal HTML lands here. Pipe through DOMPurify before
// innerHTML so <script>, <img onerror=...>, javascript: hrefs, etc. are
// stripped. The default DOMPurify config already drops <script>, on*
// handlers, and dangerous URL schemes.
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
