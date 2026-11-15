import { connect } from 'node:net';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { ContractError, installPaths } from '../update/contract.js';
import { readInstallRecord } from '../update/launcher.js';

const READY_WAIT_MS = 5_000;

export interface HostReady {
  pid: number;
  recipe: string;
  turnWork?: boolean;
  agent?: string;
}

export type HostEvent = Record<string, unknown> & { type: string };

export interface HostClient {
  ready: HostReady;
  subscribe(events: string[]): void;
  send(message: Record<string, unknown>): boolean;
  onEvent(listener: (event: HostEvent) => void): void;
  request(message: Record<string, unknown>, timeoutMs?: number): Promise<HostEvent | null>;
  closed: Promise<void>;
  close(): void;
}

export type NoHost = { reason: string; down: boolean };

export function dataDirOf(root: string): string {
  const { dataDir } = readInstallRecord(root);
  if (!isAbsolute(dataDir)) {
    throw new ContractError(`The install record at ${installPaths(root).install} names its data directory as ` +
      `${JSON.stringify(dataDir)}, not an absolute path, so where its host's socket is can't be told. Write the data ` +
      'directory\'s absolute path there as dataDir, as setup writes it: setup keeps the dataDir it finds.');
  }
  return dataDir;
}

export function socketOf(root: string): string {
  return join(dataDirOf(root), 'ipc.sock');
}

export async function openHost(root: string): Promise<HostClient | NoHost> {
  return openSocket(socketOf(root));
}

export async function openSocket(socketPath: string): Promise<HostClient | NoHost> {
  const socket = connect({ path: socketPath });
  socket.setEncoding('utf8');
  const listeners: Array<(event: HostEvent) => void> = [];
  const pending = new Map<string, (event: HostEvent | null) => void>();
  let buffer = '';
  let ready: HostReady | null = null;
  let ended = false;
  let settle!: (value: HostClient | NoHost) => void;
  const opened = new Promise<HostClient | NoHost>((resolve) => { settle = resolve; });
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const end = () => {
    if (ended) return;
    ended = true;
    for (const answer of pending.values()) answer(null);
    pending.clear();
    markClosed();
  };
  let corr = 0;
  const early: HostEvent[] = [];
  const client: HostClient = {
    get ready() { return ready as HostReady; },
    subscribe: (events) => client.send({ type: 'subscribe', events }),
    send: (message) => {
      if (ended) return false;
      socket.write(`${JSON.stringify(message)}\n`);
      return true;
    },
    onEvent: (listener) => {
      listeners.push(listener);
      for (const event of early.splice(0)) listener(event);
    },
    request: (message, timeoutMs) => {
      if (ended) return Promise.resolve(null);
      const corrId = `connectome-${process.pid}-${++corr}`;
      const answer = new Promise<HostEvent | null>((resolve) => {
        const timer = timeoutMs === undefined ? null : setTimeout(() => {
          pending.delete(corrId);
          resolve(null);
        }, timeoutMs);
        pending.set(corrId, (event) => {
          if (timer !== null) clearTimeout(timer);
          resolve(event);
        });
      });
      client.send({ ...message, corrId });
      return answer;
    },
    closed,
    close: () => { end(); socket.destroy(); },
  };
  const timer = setTimeout(() => {
    settle({ reason: `the socket ${socketPath} accepted the connection, but no host said it was ready within ` +
      `${READY_WAIT_MS / 1000} s`, down: false });
    client.close();
  }, READY_WAIT_MS);
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let event: HostEvent;
      try {
        event = JSON.parse(line) as HostEvent;
      } catch {
        continue;
      }
      if (ready === null) {
        if (event.type === 'lifecycle' && event.phase === 'ready') {
          ready = {
            pid: Number(event.pid),
            recipe: String(event.recipe ?? ''),
            ...(typeof event.turnWork === 'boolean' ? { turnWork: event.turnWork } : {}),
            ...(typeof event.agent === 'string' ? { agent: event.agent } : {}),
          };
          clearTimeout(timer);
          settle(client);
        }
        continue;
      }
      if (event.replay === true) continue;
      const corrId = typeof event.corrId === 'string' ? event.corrId : null;
      const answer = corrId === null ? undefined : pending.get(corrId);
      if (answer !== undefined) {
        pending.delete(corrId!);
        answer(event);
      }
      if (listeners.length === 0) early.push(event);
      for (const listener of listeners) listener(event);
    }
  });
  socket.on('error', (error: NodeJS.ErrnoException) => {
    clearTimeout(timer);
    if (ready === null) settle(whyNoHost(socketPath, error));
    end();
  });
  socket.on('close', () => {
    clearTimeout(timer);
    if (ready === null) settle({ reason: `the socket ${socketPath} closed before a host said it was ready`, down: false });
    end();
  });
  return opened;
}

function whyNoHost(socketPath: string, error: NodeJS.ErrnoException): NoHost {
  if (error.code === 'ENOENT') {
    return { reason: `there's no socket at ${socketPath}: no host is running, or one is still starting`, down: true };
  }
  if (error.code === 'ECONNREFUSED') {
    return {
      reason: `nothing answers on the socket ${socketPath}: a host that ended left it, or one hasn't started answering`,
      down: true,
    };
  }
  if (error.code === 'EACCES' || error.code === 'EPERM') {
    const owner = ownerOf(socketPath);
    const me = whoAmI();
    if (owner !== null && owner.uid !== process.getuid?.()) {
      const whose = owner.path === socketPath ? `the socket ${socketPath} is` : `${owner.path}, which holds the socket ` +
        `${socketPath}, is`;
      return {
        reason: owner.name === null
          ? `${whose} owned by uid ${owner.uid}, so ${me} can't connect to the socket: run this as that user`
          : `${whose} ${owner.name}'s, so ${me} can't connect to the socket: run this as ${owner.name}, ` +
            `such as \`sudo -iu ${owner.name} <command>\``,
        down: false,
      };
    }
    return { reason: `${me} can't connect to the socket ${socketPath} (${error.code})`, down: false };
  }
  return { reason: `the socket ${socketPath} couldn't be reached: ${error.message}`, down: false };
}

function whoAmI(): string {
  try {
    return userInfo().username;
  } catch {
    return `uid ${process.getuid?.() ?? '?'}`;
  }
}

function ownerOf(path: string): { path: string; uid: number; name: string | null } | null {
  for (let at = path; at !== dirname(at); at = dirname(at)) {
    let uid: number;
    try {
      uid = statSync(at).uid;
    } catch {
      continue;
    }
    const named = spawnSync('id', ['-nu', String(uid)], { encoding: 'utf8' });
    return { path: at, uid, name: named.status === 0 && named.stdout.trim() ? named.stdout.trim() : null };
  }
  return null;
}
