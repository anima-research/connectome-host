/**
 * The Web UI's live push of a long message, on the real context-manager:
 * it stores the message as a run of shards, one add each in one synchronous
 * loop, and the push sends the run as one entry, the same entry the welcome
 * gives after a reload.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, type ModuleContext } from '@animalabs/agent-framework';
import { ContextManager } from '@animalabs/context-manager';
import {
  WebUiModule,
  __getSharedServerPortForTests,
  __resetSharedServerForTests,
} from '../src/modules/web-ui-module.js';

const AUTH = `Basic ${Buffer.from('admin:pw').toString('base64')}`;
/** Barnaby-2576's probe text: 70,016 characters, past the 64 KiB a wire
 *  entry's text block carries. */
const LONG = `long-echo-probe ${'c'.repeat(70_000)}`;

type Frame = { type: string; entry?: Record<string, unknown>; [k: string]: unknown };

let webUiModule: WebUiModule;
let port: number;
let cm: ContextManager;
let root: string;
let app: unknown;
/** Every frame the module sends, with the server-side client it went to,
 *  recorded at the moment it's sent. */
const sends: Array<{ client: unknown; frame: Frame }> = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'webui-live-shards-'));
  // adaptiveResolution is what turns on ingestion chunking; the host sets it
  // for autobiographical and frontdesk unless a recipe opts out.
  const strategy = new AutobiographicalStrategy({
    compressionModel: 'claude-sonnet-4-5-20250929',
    autoTickOnNewMessage: false,
    adaptiveResolution: true,
  });
  cm = await ContextManager.open({ path: join(root, 'store'), strategy });

  webUiModule = new WebUiModule({ port: 0, host: '127.0.0.1', basicAuth: { username: 'admin', password: 'pw' } });
  await webUiModule.start({} as ModuleContext);
  port = __getSharedServerPortForTests()!;
  const module = webUiModule as unknown as { send: (client: unknown, frame: Frame) => void };
  const send = module.send.bind(webUiModule);
  module.send = (client, frame) => {
    sends.push({ client, frame });
    send(client, frame);
  };
  app = {
    framework: {
      getAllAgents: () => [{ name: 'agent', getContextManager: () => cm }],
      getAllModules: () => [],
      onTrace: () => {},
      pushEvent: () => {},
    },
    sessionManager: { getActiveSession: () => ({ id: 's', name: 's', manuallyNamed: true }) },
    recipe: { name: 'recipe', agent: {} },
  };
  webUiModule.setApp(app as never);
});

afterAll(async () => {
  await webUiModule.stop();
  await __resetSharedServerForTests();
  cm.close();
  rmSync(root, { recursive: true, force: true });
});

/** An operator connection, once welcomed: its frames as they arrive, its
 *  welcome, and the server-side client the module sends to. */
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { origin: `http://127.0.0.1:${port}`, authorization: AUTH },
  } as unknown as undefined);
  const frames: Frame[] = [];
  ws.addEventListener('message', (ev) => frames.push(JSON.parse(String(ev.data))));
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws never opened')), 5000);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
    ws.addEventListener('error', (e) => { clearTimeout(t); reject(e as unknown as Error); });
  });
  const deadline = performance.now() + 5000;
  while (!frames.some((f) => f.type === 'welcome')) {
    if (performance.now() >= deadline) throw new Error('timed out waiting for the welcome');
    await new Promise((r) => setTimeout(r, 25));
  }
  const welcome = frames.find((f) => f.type === 'welcome')!;
  const client = sends.filter((s) => s.frame.type === 'welcome').at(-1)!.client;
  return { ws, welcome, client };
}

/** The entries the module has pushed to one client as message-appended. */
function appendedTo(client: unknown): Array<Record<string, unknown>> {
  return sends.filter((s) => s.client === client && s.frame.type === 'message-appended').map((s) => s.frame.entry!);
}

describe('the live push of a long message', () => {
  test('its shards go out as one entry, once the loop is done, and it is the entry a reload gives', async () => {
    const c = await connect();
    // A message ahead of it, so the run's first slot isn't the store's first.
    cm.addMessage('user', [{ type: 'text', text: 'hello' }]);
    const before = cm.getMessageCount();
    expect(before).toBeGreaterThan(0);
    const already = appendedTo(c.client).length;
    cm.addMessage('user', [{ type: 'text', text: LONG }], { corrId: 'c-long' });
    expect(cm.getMessageCount() - before).toBeGreaterThan(1);
    // Held while context-manager's loop runs: nothing has gone out yet.
    expect(appendedTo(c.client).slice(already)).toEqual([]);
    await Promise.resolve();
    const live = appendedTo(c.client).slice(already);
    expect(live).toHaveLength(1);
    expect(live[0]!.index).toBe(before);
    expect(live[0]!.corrId).toBe('c-long');
    const blocks = live[0]!.blocks as Array<{ kind: string; text?: string; truncated?: boolean }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.truncated).toBe(true);
    expect(LONG.startsWith(blocks[0]!.text!)).toBe(true);

    // A reload's welcome joins the same run into the same entry.
    const again = await connect();
    const messages = again.welcome.messages as Array<Record<string, unknown>>;
    expect(messages.at(-1)).toEqual(live[0]!);
    again.ws.close();
    c.ws.close();
  });

  test('a message added right after a run, before its microtask, goes out after the joined entry', async () => {
    const c = await connect();
    cm.addMessage('user', [{ type: 'text', text: LONG }]);
    cm.addMessage('agent', [{ type: 'text', text: 'ok' }]);
    const live = appendedTo(c.client);
    expect(live).toHaveLength(2);
    expect((live[0]!.blocks as Array<{ text?: string }>)[0]!.text!.startsWith('long-echo-probe ')).toBe(true);
    expect(live[1]!.blocks).toEqual([{ kind: 'text', text: 'ok' }]);
    await Promise.resolve();
    expect(appendedTo(c.client)).toHaveLength(2);
    c.ws.close();
  });

  test('two runs back to back go out as two entries, in order', async () => {
    const c = await connect();
    cm.addMessage('user', [{ type: 'text', text: `first ${LONG}` }]);
    cm.addMessage('user', [{ type: 'text', text: `second ${LONG}` }]);
    await Promise.resolve();
    const texts = appendedTo(c.client).map((e) => (e.blocks as Array<{ text?: string }>)[0]!.text!);
    expect(texts).toHaveLength(2);
    expect(texts[0]!.startsWith('first ')).toBe(true);
    expect(texts[1]!.startsWith('second ')).toBe(true);
    c.ws.close();
  });

  test('a message stored whole goes out at once', async () => {
    const c = await connect();
    cm.addMessage('user', [{ type: 'text', text: 'short' }], { corrId: 'c-short' });
    expect(appendedTo(c.client)).toEqual([
      expect.objectContaining({ blocks: [{ kind: 'text', text: 'short' }], corrId: 'c-short' }),
    ]);
    c.ws.close();
  });

  test("a run still held when the session switches isn't pushed into the new session", async () => {
    const c = await connect();
    cm.addMessage('user', [{ type: 'text', text: LONG }]);
    webUiModule.setApp(app as never);
    await Promise.resolve();
    expect(appendedTo(c.client)).toEqual([]);
    c.ws.close();
  });
});
