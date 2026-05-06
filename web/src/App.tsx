import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { createWireClient, type WireClient } from './wire';
import { createTreeStore, type StreamSource, type UiNode } from './tree';
import { TreeSidebar } from './Tree';
import { StreamPanel, formatStreamEvent, type StreamLine } from './Stream';
import { UsagePanel } from './Usage';
import { LessonsPanel, type LessonRow } from './Lessons';
import { McplPanel, type McplServerRow } from './Mcpl';
import { FilesPanel, FileViewerModal, type Mount, type FlatEntry, type FileViewer } from './Files';
import type {
  WebUiServerMessage,
  WelcomeMessage,
  WelcomeMessageEntry,
  TokenUsage,
  PerAgentCost,
} from '@conhost/web/protocol';

interface Message {
  id: string;
  participant: 'user' | 'assistant' | 'system' | 'tool' | 'command' | 'trigger';
  text: string;
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
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
let streamIdSeq = 0;
const streamLineId = (): number => ++streamIdSeq;

function entryToMessage(e: WelcomeMessageEntry): Message {
  return {
    id: e.id ?? nextMessageId(),
    participant: e.participant,
    text: e.text,
    toolCalls: e.toolCalls,
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
  type SidebarTab = 'tree' | 'lessons' | 'mcp' | 'files';
  const [sidebarTab, setSidebarTab] = createSignal<SidebarTab>('tree');

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
  // the existing message's `text` field in place — Solid's <For> sees the
  // same item reference and only updates the changed text, instead of
  // remounting the row (which would replay the entrance animation).
  const appendStreamToken = (token: string): void => {
    setMessages(produce((arr) => {
      const last = arr[arr.length - 1];
      if (last && last.streaming) {
        last.text = last.text + token;
      } else {
        arr.push({
          id: nextMessageId(),
          participant: 'assistant',
          text: token,
          streaming: true,
        });
      }
    }));
    queueScroll();
  };

  const finishStream = (): void => {
    setMessages(produce((arr) => {
      const last = arr[arr.length - 1];
      if (last && last.streaming) last.streaming = false;
    }));
  };

  const queueScroll = (): void => {
    queueMicrotask(() => {
      if (scrollPane) scrollPane.scrollTop = scrollPane.scrollHeight;
    });
  };

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

  const cancelSubagent = (name: string): void => {
    wire.send({ type: 'cancel-subagent', name });
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
      // Agent inside a fleet child — there's no per-agent kill verb yet, so
      // stopping the whole child is the closest analogue.
      fleetStop(src.childName);
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
      treeStore.ingest(msg);
      autoExpandNewFleetChildren();
      // Capture child-events into the per-childName ring buffer so a future
      // openStream() can backfill the panel from local history.
      if (msg.type === 'child-event') {
        recordChildEvent(msg.childName, msg.event);
      }
      handleStreamMessage(msg);
      handleServerMessage(msg, wire, {
        setWelcome,
        resetMessages: (m) => setMessages(m),
        appendMessage: (m) => setMessages(produce(arr => arr.push(m))),
        setUsage,
        setPerAgentCost,
        appendStreamToken,
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
      })));
      queueScroll();
      wire.send({ type: 'route-to-child', childName: route.childName, content: route.content });
      return;
    }
    setMessages(produce((arr) => arr.push({
      id: nextMessageId(),
      participant: 'user',
      text,
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
          <div
            ref={scrollPane}
            class="flex-1 overflow-y-auto px-4 py-3 space-y-3"
          >
            <Show when={messages.length === 0}>
              <div class="text-neutral-500 text-sm italic">
                Connected. Type a message or /help to begin.
              </div>
            </Show>
            <For each={messages}>{(m) => <MessageView msg={m} />}</For>
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
  setWelcome: (w: WelcomeMessage) => void;
  /** Replace the messages array wholesale (used on welcome). */
  resetMessages: (msgs: Message[]) => void;
  /** Append a single message at the end (used for command-result, errors, etc.). */
  appendMessage: (msg: Message) => void;
  setUsage: (u: TokenUsage) => void;
  setPerAgentCost: (c: PerAgentCost[]) => void;
  appendStreamToken: (token: string) => void;
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
      hooks.setWelcome(msg);
      hooks.resetMessages(msg.messages.map(entryToMessage));
      hooks.setUsage(msg.usage);
      hooks.setPerAgentCost(msg.perAgentCost ?? []);
      hooks.queueScroll();
      return;
    }
    case 'usage':
      hooks.setUsage(msg.usage);
      if (msg.perAgentCost) hooks.setPerAgentCost(msg.perAgentCost);
      return;
    case 'trace': {
      const e = msg.event;
      switch (e.type) {
        case 'inference:tokens': {
          const content = e.content;
          if (typeof content === 'string') hooks.appendStreamToken(content);
          return;
        }
        case 'inference:completed':
        case 'inference:failed':
          hooks.finishStream();
          return;
        case 'inference:tool_calls_yielded': {
          const calls = (e.calls as Array<{ id: string; name: string; input?: unknown }> | undefined) ?? [];
          if (calls.length === 0) return;
          hooks.appendMessage({
            id: nextMessageId(),
            participant: 'tool',
            text: '',
            toolCalls: calls.map(c => ({ id: c.id, name: c.name, input: c.input })),
          });
          hooks.queueScroll();
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

function MessageView(props: { msg: Message }) {
  // Access fields via props.msg.X directly (not a destructured local) so Solid
  // tracks reactive reads against the store. Otherwise the message would
  // capture a snapshot at render time and never update mid-stream.

  if (props.msg.participant === 'user') {
    return (
      <div class="msg-enter">
        <div class="text-xs text-neutral-500 mb-1">you</div>
        <div class="font-mono text-sm whitespace-pre-wrap text-neutral-200">{props.msg.text}</div>
      </div>
    );
  }

  if (props.msg.participant === 'assistant') {
    return (
      <div class="msg-enter">
        <div class="text-xs text-neutral-500 mb-1">
          assistant
          <Show when={props.msg.streaming}>
            <span class="animate-pulse ml-2">▍</span>
          </Show>
        </div>
        <div class="prose-mini text-neutral-100" innerHTML={renderMarkdown(props.msg.text)} />
      </div>
    );
  }

  if (props.msg.participant === 'tool') {
    return (
      <div class="msg-enter">
        <div class="text-xs text-neutral-500 mb-1">tool calls</div>
        <For each={props.msg.toolCalls ?? []}>{(call) => (
          <div class="font-mono text-xs text-amber-400 bg-amber-950/20 px-2 py-1 rounded mb-1">
            {call.name}
          </div>
        )}</For>
      </div>
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
  current: 'tree' | 'lessons' | 'mcp' | 'files';
  onSelect: (tab: 'tree' | 'lessons' | 'mcp' | 'files') => void;
}) {
  const tabs: Array<{ id: 'tree' | 'lessons' | 'mcp' | 'files'; label: string; title: string }> = [
    { id: 'tree', label: 'Tree', title: 'Agent + fleet tree' },
    { id: 'lessons', label: 'Lessons', title: 'Lesson library' },
    { id: 'mcp', label: 'MCP', title: 'MCPL servers' },
    { id: 'files', label: 'Files', title: 'Workspace mounts + files' },
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
