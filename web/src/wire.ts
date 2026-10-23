/**
 * WS client with exponential-backoff reconnect.
 *
 * Designed for one connection per page; the SPA holds a single instance.
 * Subscriptions are signal-based: callers watch `messages` / `status` and
 * react to changes.
 */

import { createSignal, type Accessor } from 'solid-js';
import type {
  WebUiClientMessage,
  WebUiServerMessage,
} from '@conhost/web/protocol';
import { buildHelloIdentity } from './observer-identity.js';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * Observer-auth state (docs/observability.md, browser side).
 *   'none'        — basic-auth / open server; historical behavior
 *   'authing'     — server demanded observer auth; hello sent
 *   'observer'    — key-authenticated; `observer()` carries label + scopes
 *   'denied'      — this device's key holds no grant on this agent
 *   'unavailable' — WebCrypto absent (insecure context) — password only
 */
export type ObserverAuthState = 'none' | 'authing' | 'observer' | 'denied' | 'unavailable';

export interface ObserverInfo {
  label: string;
  scopes: string[];
}

export interface WireClient {
  status: Accessor<ConnectionStatus>;
  /** Observer-auth state for this connection. */
  observerState: Accessor<ObserverAuthState>;
  /** Grant info after a successful observer handshake. */
  observer: Accessor<ObserverInfo | null>;
  /** Last received message, or null. Useful for reactive folds. */
  lastMessage: Accessor<WebUiServerMessage | null>;
  /** Subscribe to all incoming messages. Returns an unsubscribe fn. */
  onMessage(handler: (msg: WebUiServerMessage) => void): () => void;
  /** Send a message. No-ops with a console warning if the socket is closed. */
  send(msg: WebUiClientMessage): void;
  /** Manually close the connection (also cancels reconnects). */
  close(): void;
}

export interface WireOptions {
  /** WS URL. Default: derives from window.location with /ws path. */
  url?: string;
  /** Initial reconnect delay in ms. Default: 500. */
  initialDelayMs?: number;
  /** Max reconnect delay in ms. Default: 8000. */
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
  /** Whether this socket's connection signed in as an observer. A welcome on
   *  a connection that didn't is a full client's: the host sends an observer
   *  its ack before its welcome. */
  let ackedThisSocket = false;
  let stopped = false;
  let delay = initialDelay;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Server demanded observer auth → sign and reply with this device's key.
   *  Failure paths surface via observerState so the UI can show the
   *  fingerprint-grant screen or fall back to password sign-in. */
  async function respondToAuthRequired(sock: WebSocket, host: string): Promise<void> {
    setObserverState('authing');
    const identity = await buildHelloIdentity(host);
    // A later connection's state is its own.
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
      // Observer handshake frames are handled here (the wire owns the
      // socket); they also fan out to handlers for any UI that cares.
      if (parsed.type === 'observer-auth-required' && socket) {
        void respondToAuthRequired(socket, parsed.host);
      } else if (parsed.type === 'observer-ack') {
        ackedThisSocket = true;
        setObserverState('observer');
        setObserver({ label: parsed.label, scopes: parsed.scopes });
        // Session cookie lets the SPA hit /debug/* and /healthz over HTTP.
        document.cookie = `fkm_obs=${parsed.sessionToken}; path=/; SameSite=Lax; max-age=${12 * 3600}`;
      } else if (parsed.type === 'welcome' && !ackedThisSocket) {
        // A full client's connection, whatever an earlier one on this page
        // signed in as: a password signed in from another tab since, say.
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
      if (ev.code === 4401) {
        // Observer auth rejected — reconnect loops would spam the server;
        // hold until the user acts (grant lands / password). The server also
        // closes never-authenticated connections with 4401 on timeout, so
        // don't overwrite 'unavailable' (no WebCrypto — a hello was never
        // possible) with 'denied' (a key exists but holds no grant).
        if (observerState() !== 'unavailable') setObserverState('denied');
        // A refused connection holds no grant, whatever an earlier one held.
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
