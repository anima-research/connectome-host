import { createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { marked } from 'marked';
import { createWireClient, type WireClient } from './wire';
import { createTreeStore } from './tree';
import { TreeSidebar } from './Tree';
import type {
  WebUiServerMessage,
  WelcomeMessage,
  WelcomeMessageEntry,
  TokenUsage,
} from '@conhost/web/protocol';

interface Message {
  id: string;
  participant: 'user' | 'assistant' | 'system' | 'tool' | 'command';
  text: string;
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  /** Per-line style — only set for `command` messages from /slash output. */
  lines?: Array<{ text: string; style?: 'user' | 'agent' | 'tool' | 'system' }>;
  /** True if the message is mid-stream — render with a cursor cue. */
  streaming?: boolean;
}

let messageCounter = 0;
const nextMessageId = () => `m${++messageCounter}`;

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

  const [messages, setMessages] = createSignal<Message[]>([]);
  const [welcome, setWelcome] = createSignal<WelcomeMessage | null>(null);
  const [usage, setUsage] = createSignal<TokenUsage>({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const [draft, setDraft] = createSignal('');

  let scrollPane: HTMLDivElement | undefined;

  // Append-to-last-assistant streaming buffer. Solid signals don't deep-equal,
  // so we mutate-then-replace the array reference.
  const appendStreamToken = (token: string): void => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.streaming) {
        const next = prev.slice();
        next[next.length - 1] = { ...last, text: last.text + token };
        return next;
      }
      return [...prev, {
        id: nextMessageId(),
        participant: 'assistant',
        text: token,
        streaming: true,
      }];
    });
    queueScroll();
  };

  const finishStream = (): void => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || !last.streaming) return prev;
      const next = prev.slice();
      next[next.length - 1] = { ...last, streaming: false };
      return next;
    });
  };

  const queueScroll = (): void => {
    queueMicrotask(() => {
      if (scrollPane) scrollPane.scrollTop = scrollPane.scrollHeight;
    });
  };

  onMount(() => {
    const detach = wire.onMessage((msg) => {
      treeStore.ingest(msg);
      handleServerMessage(msg, wire, {
        setWelcome,
        setMessages,
        setUsage,
        appendStreamToken,
        finishStream,
        queueScroll,
      });
    });
    onCleanup(() => {
      detach();
      wire.close();
    });
  });

  const submit = (): void => {
    const text = draft().trim();
    if (!text) return;
    setDraft('');
    if (text.startsWith('/')) {
      wire.send({ type: 'command', command: text });
      return;
    }
    // @childname routing — bypass the conductor agent.
    const route = parseRoute(text);
    if (route) {
      setMessages((prev) => [...prev, {
        id: nextMessageId(),
        participant: 'user',
        text: `→ @${route.childName}: ${route.content}`,
      }]);
      queueScroll();
      wire.send({ type: 'route-to-child', childName: route.childName, content: route.content });
      return;
    }
    // Optimistically append the user's message — server will echo via traces
    // but the immediate feedback feels right.
    setMessages((prev) => [...prev, {
      id: nextMessageId(),
      participant: 'user',
      text,
    }]);
    queueScroll();
    wire.send({ type: 'user-message', content: text });
  };

  const interrupt = (): void => {
    wire.send({ type: 'interrupt' });
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

      <div class="flex flex-1 min-h-0">
        <main class="flex-1 flex flex-col min-w-0">
          <div
            ref={scrollPane}
            class="flex-1 overflow-y-auto px-4 py-3 space-y-3"
          >
            <Show when={messages().length === 0}>
              <div class="text-neutral-500 text-sm italic">
                Connected. Type a message or /help to begin.
              </div>
            </Show>
            <For each={messages()}>{(m) => <MessageView msg={m} />}</For>
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

        <aside class="w-72 border-l border-neutral-800 bg-neutral-950 shrink-0 flex flex-col">
          <div class="flex-1 min-h-0">
            <TreeSidebar scopes={treeStore.scopes()} />
          </div>
          <RecipePane welcome={welcome()} />
        </aside>
      </div>
    </div>
  );
}

interface HandlerHooks {
  setWelcome: (w: WelcomeMessage) => void;
  setMessages: (updater: (prev: Message[]) => Message[]) => void;
  setUsage: (u: TokenUsage) => void;
  appendStreamToken: (token: string) => void;
  finishStream: () => void;
  queueScroll: () => void;
}

function handleServerMessage(
  msg: WebUiServerMessage,
  _wire: WireClient,
  hooks: HandlerHooks,
): void {
  switch (msg.type) {
    case 'welcome': {
      hooks.setWelcome(msg);
      hooks.setMessages(() => msg.messages.map(entryToMessage));
      hooks.setUsage(msg.usage);
      hooks.queueScroll();
      return;
    }
    case 'usage':
      hooks.setUsage(msg.usage);
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
          hooks.setMessages((prev) => [...prev, {
            id: nextMessageId(),
            participant: 'tool',
            text: '',
            toolCalls: calls.map(c => ({ id: c.id, name: c.name, input: c.input })),
          }]);
          hooks.queueScroll();
          return;
        }
        default:
          return;
      }
    }
    case 'command-result': {
      hooks.setMessages((prev) => [...prev, {
        id: nextMessageId(),
        participant: 'command',
        text: msg.lines.map(l => l.text).join('\n'),
        lines: msg.lines,
      }]);
      hooks.queueScroll();
      return;
    }
    case 'branch-changed':
      // Welcome refresh follows; nothing to do here. The fresh welcome will
      // reset messages and tree state.
      return;
    case 'session-changed':
      return;
    case 'error':
      console.warn('[server error]', msg.message);
      hooks.setMessages((prev) => [...prev, {
        id: nextMessageId(),
        participant: 'system',
        text: `Error: ${msg.message}`,
      }]);
      hooks.queueScroll();
      return;
    default:
      // child-event / branch-changed / session-changed / peek not yet handled
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
      </div>
    </div>
  );
}

function MessageView(props: { msg: Message }) {
  const m = props.msg;

  if (m.participant === 'user') {
    return (
      <div class="msg-enter">
        <div class="text-xs text-neutral-500 mb-1">you</div>
        <div class="font-mono text-sm whitespace-pre-wrap text-neutral-200">{m.text}</div>
      </div>
    );
  }

  if (m.participant === 'assistant') {
    return (
      <div class="msg-enter">
        <div class="text-xs text-neutral-500 mb-1">
          assistant
          {m.streaming ? <span class="animate-pulse ml-2">▍</span> : null}
        </div>
        <div class="prose-mini text-neutral-100" innerHTML={renderMarkdown(m.text)} />
      </div>
    );
  }

  if (m.participant === 'tool') {
    return (
      <div class="msg-enter">
        <div class="text-xs text-neutral-500 mb-1">tool calls</div>
        <For each={m.toolCalls ?? []}>{(call) => (
          <div class="font-mono text-xs text-amber-400 bg-amber-950/20 px-2 py-1 rounded mb-1">
            {call.name}
          </div>
        )}</For>
      </div>
    );
  }

  if (m.participant === 'command') {
    return (
      <div class="msg-enter font-mono text-xs bg-neutral-900/60 border border-neutral-800 rounded px-3 py-2 whitespace-pre-wrap">
        <For each={m.lines ?? [{ text: m.text }]}>{(line) => (
          <div class={lineStyleClass(line.style)}>{line.text || ' '}</div>
        )}</For>
      </div>
    );
  }

  return (
    <div class="msg-enter text-xs text-neutral-500 font-mono whitespace-pre-wrap">
      {m.text}
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
    // Only show suggestions for the leading token; don't continue showing them
    // once the user starts typing arguments.
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

function RecipePane(props: { welcome: WelcomeMessage | null }) {
  return (
    <div class="border-t border-neutral-800 px-3 py-2 text-[11px] space-y-0.5">
      <div class="text-neutral-500 uppercase tracking-wider text-[10px] font-semibold">
        recipe
      </div>
      <Show when={props.welcome} fallback={<div class="text-neutral-600 italic">…</div>}>
        <div class="text-neutral-300">{props.welcome!.recipe.name}</div>
        <Show when={props.welcome!.recipe.description}>
          <div class="text-neutral-500 truncate" title={props.welcome!.recipe.description}>
            {props.welcome!.recipe.description}
          </div>
        </Show>
        <div class="text-neutral-600 font-mono">
          <Show when={props.welcome!.agents.length > 0}>
            {props.welcome!.agents[0]!.model}
          </Show>
        </div>
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

/** Parse "@childname rest of message" → route. Mirrors parseFleetRoute in the
 *  server's fleet-types.ts. Returns null on a non-route input or empty payload. */
function parseRoute(input: string): { childName: string; content: string } | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('@') || trimmed.startsWith('@@')) return null;
  const m = /^@([a-zA-Z0-9_.-]+)(?::|\s)\s*([\s\S]+)$/.exec(trimmed);
  if (!m) return null;
  const content = m[2]!.trim();
  if (!content) return null;
  return { childName: m[1]!, content };
}

// Configure marked once. Synchronous mode keeps render() safe to call from JSX.
marked.setOptions({ async: false, breaks: false, gfm: true });

function renderMarkdown(src: string): string {
  if (!src) return '';
  try {
    return marked.parse(src) as string;
  } catch {
    return escapeHtml(src);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]!);
}
