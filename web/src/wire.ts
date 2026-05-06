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

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface WireClient {
  status: Accessor<ConnectionStatus>;
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
  const handlers = new Set<(m: WebUiServerMessage) => void>();

  let socket: WebSocket | null = null;
  let stopped = false;
  let delay = initialDelay;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect(): void {
    if (stopped) return;
    setStatus(socket ? 'reconnecting' : 'connecting');
    socket = new WebSocket(url);

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
      setLastMessage(parsed);
      for (const h of handlers) {
        try { h(parsed); } catch (err) { console.error('[wire] handler threw', err); }
      }
    });

    socket.addEventListener('close', () => {
      socket = null;
      if (stopped) {
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
