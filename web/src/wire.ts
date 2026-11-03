import { createSignal, type Accessor } from 'solid-js';
import type {
  WebUiClientMessage,
  WebUiServerMessage,
} from '@conhost/web/protocol';
import { buildHelloIdentity } from './observer-identity.js';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

const OBSERVER_REFUSED_CLOSE_CODE = 4401;

export type ObserverAuthState = 'none' | 'authing' | 'observer' | 'denied' | 'unavailable';

export interface ObserverInfo {
  label: string;
  scopes: string[];
}

export interface WireClient {
  status: Accessor<ConnectionStatus>;
  observerState: Accessor<ObserverAuthState>;
  observer: Accessor<ObserverInfo | null>;
  lastMessage: Accessor<WebUiServerMessage | null>;
  onMessage(handler: (msg: WebUiServerMessage) => void): () => void;
  send(msg: WebUiClientMessage): void;
  close(): void;
}

export interface WireOptions {
  url?: string;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

export function createWireClient(opts: WireOptions = {}): WireClient {
  const url = opts.url ?? defaultWsUrl();
  const initialDelay = opts.initialDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 8000;

  const [status, setStatus] = createSignal<ConnectionStatus>('connecting');
  const [lastMessage, setLastMessage] = createSignal<WebUiServerMessage | null>(null);
  const [observerState, setObserverState] = createSignal<ObserverAuthState>('none');
  const [observer, setObserver] = createSignal<ObserverInfo | null>(null);
  const handlers = new Set<(m: WebUiServerMessage) => void>();

  let socket: WebSocket | null = null;
  let ackedThisSocket = false;
  let stopped = false;
  let delay = initialDelay;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  async function respondToAuthRequired(sock: WebSocket, host: string): Promise<void> {
    setObserverState('authing');
    const identity = await buildHelloIdentity(host);
    if (sock !== socket) return;
    if (!identity) {
      setObserverState('unavailable');
      return;
    }
    if (sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ type: 'observer-hello', identity }));
    }
  }

  function connect(): void {
    if (stopped) return;
    setStatus(socket ? 'reconnecting' : 'connecting');
    socket = new WebSocket(url);
    ackedThisSocket = false;

    socket.addEventListener('open', () => {
      delay = initialDelay;
      setStatus('open');
    });

    socket.addEventListener('message', (event) => {
      let parsed: WebUiServerMessage;
      try {
        parsed = JSON.parse(event.data) as WebUiServerMessage;
      } catch {
        console.warn('[wire] failed to parse message', event.data);
        return;
      }
      if (parsed.type === 'observer-auth-required' && socket) {
        void respondToAuthRequired(socket, parsed.host);
      } else if (parsed.type === 'observer-ack') {
        ackedThisSocket = true;
        // The cookie is set before the state changes: Solid runs what
        // reacts to the state inside that change, and that may read /healthz
        // at once.
        document.cookie = `fkm_obs=${parsed.sessionToken}; path=/; SameSite=Lax; max-age=${12 * 3600}`;
        setObserverState('observer');
        setObserver({ label: parsed.label, scopes: parsed.scopes });
      } else if (parsed.type === 'welcome' && !ackedThisSocket) {
        setObserverState('none');
        setObserver(null);
      }
      setLastMessage(parsed);
      for (const h of handlers) {
        try { h(parsed); } catch (err) { console.error('[wire] handler threw', err); }
      }
    });

    socket.addEventListener('close', (ev) => {
      socket = null;
      if (stopped) {
        setStatus('closed');
        return;
      }
      if (ev.code === OBSERVER_REFUSED_CLOSE_CODE) {
        if (observerState() !== 'unavailable') setObserverState('denied');
        setObserver(null);
        setStatus('closed');
        return;
      }
      setStatus('reconnecting');
      reconnectTimer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, maxDelay);
    });

    socket.addEventListener('error', () => {
      // Errors trigger a close immediately after; the close handler does the work.
    });
  }

  connect();

  return {
    status,
    observerState,
    observer,
    lastMessage,
    onMessage(handler) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    send(msg) {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.warn('[wire] dropping message; socket not open', msg.type);
        return;
      }
      socket.send(JSON.stringify(msg));
    },
    close() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      setStatus('closed');
    },
  };
}

function defaultWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}
