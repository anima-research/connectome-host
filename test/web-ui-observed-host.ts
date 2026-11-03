import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import type { ModuleContext } from '@animalabs/agent-framework';
import {
  WebUiModule,
  __getSharedServerPortForTests,
  stopWebUiServer,
} from '../src/modules/web-ui-module.js';
import { observerStatement, saveObserversFile, type ObserverScope } from '../src/modules/web-ui-observers.js';

export function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  const id = `ed25519:${raw.toString('base64url')}`;
  return { id, privateKey };
}

export function helloFor(kp: ReturnType<typeof makeKeypair>, host: string, timestamp = new Date().toISOString()) {
  const proof = cryptoSign(null, Buffer.from(observerStatement(host, timestamp), 'utf8'), kp.privateKey);
  return {
    scheme: 'ed25519' as const,
    id: kp.id,
    proof: proof.toString('base64url'),
    timestamp,
  };
}

export const BASIC = `Basic ${Buffer.from('admin:pw').toString('base64')}`;

type Frame = Record<string, unknown>;

export interface Connection {
  ws: WebSocket;
  frames: Frame[];
  until(type: string, match?: (frame: Frame) => boolean): Promise<Frame>;
  framesOf(type: string): Frame[];
}

export interface ObservedHost {
  module: WebUiModule;
  port: number;
  emitTrace(event: Record<string, unknown>): void;
  operator(): Promise<Connection>;
  observer(label: string): Promise<Connection>;
  rebind(): void;
  /** A socket keeps its frames in order, so a frame sent before the fence's
   *  welcome reaches each client before it. */
  fence(connections: Connection[]): Promise<void>;
  stop(): Promise<void>;
}

export async function startObservedHost(options: {
  grants: Record<string, ObserverScope[]>;
  framework?: Record<string, unknown>;
  frameworkSessionId?: string;
  sessionManager?: Record<string, unknown>;
  config?: Record<string, unknown>;
}): Promise<ObservedHost> {
  const tmp = mkdtempSync(join(tmpdir(), 'webui-observed-host-'));
  const keys = new Map<string, ReturnType<typeof makeKeypair>>();
  for (const label of Object.keys(options.grants)) keys.set(label, makeKeypair());
  const observersPath = join(tmp, 'observers.json');
  saveObserversFile(observersPath, {
    observers: [...keys].map(([label, kp]) => ({ key: kp.id, label, scopes: options.grants[label]! })),
  });
  const module = new WebUiModule({
    port: 0,
    host: '127.0.0.1',
    basicAuth: { username: 'admin', password: 'pw' },
    observersPath,
    ...options.config,
  } as ConstructorParameters<typeof WebUiModule>[0]);
  await module.start({} as ModuleContext);
  const port = __getSharedServerPortForTests()!;
  let listener: ((event: Record<string, unknown>) => void) | undefined;
  const app = {
    framework: {
      getAllAgents: () => [],
      getAllModules: () => [],
      onTrace: (l: (event: Record<string, unknown>) => void) => {
        listener = l;
        return () => {};
      },
      pushEvent: () => {},
      ...options.framework,
    },
    frameworkSessionId: options.frameworkSessionId ?? 's',
    sessionManager: {
      findSession: (id: string) => (id === 's' ? { id: 's', name: 's', manuallyNamed: true } : null),
      ...options.sessionManager,
    },
    recipe: { name: 'recipe', agent: {} },
  };
  module.setApp(app as never);

  async function connect(headers?: Record<string, string>): Promise<Connection> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, (headers ? { headers } : undefined) as never);
    const frames: Frame[] = [];
    ws.addEventListener('message', (ev) => frames.push(JSON.parse(String(ev.data)) as Frame));
    return {
      ws,
      frames,
      framesOf: (type) => frames.filter((f) => f.type === type),
      until: async (type, match = () => true) => {
        const deadline = performance.now() + 5000;
        for (;;) {
          const found = frames.find((f) => f.type === type && match(f));
          if (found) return found;
          if (performance.now() >= deadline) throw new Error(`timed out waiting for ${type}`);
          await new Promise((r) => setTimeout(r, 10));
        }
      },
    };
  }

  return {
    module,
    port,
    emitTrace: (event) => listener!(event),
    rebind: () => module.setApp(app as never),
    operator: async () => {
      const c = await connect({ origin: `http://127.0.0.1:${port}`, authorization: BASIC });
      await c.until('welcome');
      return c;
    },
    observer: async (label) => {
      const c = await connect();
      await c.until('observer-auth-required');
      c.ws.send(JSON.stringify({ type: 'observer-hello', identity: helloFor(keys.get(label)!, `127.0.0.1:${port}`) }));
      await c.until('welcome');
      return c;
    },
    fence: async (connections) => {
      const before = connections.map((c) => c.framesOf('welcome').length);
      (module as unknown as { refreshAllWelcomes(): void }).refreshAllWelcomes();
      await Promise.all(connections.map(async (c, i) => {
        const deadline = performance.now() + 5000;
        while (c.framesOf('welcome').length <= before[i]!) {
          if (performance.now() >= deadline) throw new Error('timed out waiting for the fence');
          await new Promise((r) => setTimeout(r, 10));
        }
      }));
    },
    stop: async () => {
      await module.stop();
      await stopWebUiServer();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
