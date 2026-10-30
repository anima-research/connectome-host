import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, type ModuleContext, type ProcessEvent } from '@animalabs/agent-framework';
import { Membrane, MockAdapter } from '@animalabs/membrane';
import { connectWhenAccepting } from './ipc-connect.js';
import {
  SURFACE_TAG_KEY,
  SurfaceAnswers,
  TuiModule,
  readlineAnswer,
  surfaceAnswers,
  tuiAnswer,
} from '../src/modules/tui-module.js';
import { WebUiModule, __getSharedServerPortForTests, pagesAnswer, stopWebUiServer } from '../src/modules/web-ui-module.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function until(check: () => boolean, label: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

describe('headless', () => {
  type Send = ((command: object) => void) & { socket: { destroy(): void }; frames: Array<Record<string, unknown>> };
  async function withChild(body: (dir: string, connect: (subscribe: string[]) => Promise<Send>) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), 'surface-receipts-'));
    const child = spawn(process.execPath, [new URL('./mock-headless-answer-child.ts', import.meta.url).pathname], {
      env: { ...process.env, DATA_DIR: dir }, stdio: 'ignore',
    });
    const sockets: Array<{ destroy(): void }> = [];
    try {
      await until(() => existsSync(join(dir, 'ipc.sock')), 'socket');
      await body(dir, async (subscribe) => {
        const socket = await connectWhenAccepting(join(dir, 'ipc.sock'));
        sockets.push(socket);
        const frames: Array<Record<string, unknown>> = [];
        let buffered = '';
        socket.on('data', (chunk: Buffer) => {
          buffered += chunk.toString('utf8');
          const lines = buffered.split('\n');
          buffered = lines.pop()!;
          for (const line of lines) if (line.trim()) frames.push(JSON.parse(line));
        });
        const send = Object.assign((command: object) => { socket.write(`${JSON.stringify(command)}\n`); }, { socket, frames });
        send({ type: 'subscribe', events: subscribe });
        return send;
      });
    } finally {
      for (const socket of sockets) socket.destroy();
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const answers = (dir: string) => existsSync(join(dir, 'answers.jsonl'))
    ? readFileSync(join(dir, 'answers.jsonl'), 'utf8').split('\n').slice(0, -1).map((line) => JSON.parse(line))
    : [];

  test("answers for the primary's final speech, naming the terminal that sent the turn, and for nothing else", async () => {
    await withChild(async (dir, connect) => {
      const send = await connect(['inference:speech']);
      send({ type: 'text', content: 'hello', from: 'console' });
      await until(() => answers(dir).length === 1, 'the answers');
      const [answer] = answers(dir);
      expect(answer.tag.surface).toBe('headless');
      expect(answer.tag.connection).toMatch(UUID);
      expect(answer.final).toBe('the terminal that sent this turn (`connectome send`)');
      await until(() => send.frames.some((f) => f.type === 'inference:speech'), 'the speech frame');
      expect(send.frames.filter((f) => f.type === 'inference:speech').map((f) => f.content)).toEqual(['Hi there.']);
      expect(answer.round).toBeNull();
      expect(answer.notWritten).toBeNull();
      expect(answer.anotherAgent).toBeNull();
      expect(answer.anotherBoot).toBe('the terminal now connected (`connectome send`), not the one that sent this turn');
    });
  });

  test('answers for a reply it wrote to a client that has since left', async () => {
    await withChild(async (dir, connect) => {
      const first = await connect(['inference:speech']);
      first({ type: 'text', content: 'hello', from: 'console' });
      await until(() => answers(dir).length === 1, 'the first turn');
      const id = answers(dir)[0].tag.connection;
      first.socket.destroy();
      const second = await connect(['inference:speech']);
      second({ type: 'text', content: JSON.stringify({ ask: { text: 'Hi there.', connections: [id] } }), from: 'console' });
      await until(() => answers(dir).length === 2, 'the ask');
      expect(answers(dir)[1].asked).toBe('the terminal that sent this turn (`connectome send`)');
    });
  });

  test("answers from the latest stream only: a later stream written to no client leaves nothing to answer from, even for the same words", async () => {
    await withChild(async (dir, connect) => {
      const first = await connect(['inference:speech']);
      first({ type: 'text', content: 'hello', from: 'console' });
      await until(() => answers(dir).length === 1, 'the first turn');
      const second = await connect([]);
      second({ type: 'text', content: JSON.stringify({ stream: 'Hi there.' }), from: 'console' });
      await until(() => answers(dir).length === 2, 'the second turn');
      const id = answers(dir)[1].tag.connection;
      expect(id).toMatch(UUID);
      expect(id).not.toBe(answers(dir)[0].tag.connection);
      second({ type: 'text', content: JSON.stringify({ ask: { text: 'Hi there.', connections: [id] } }), from: 'console' });
      await until(() => answers(dir).length === 3, 'the ask');
      expect(answers(dir)[2].asked).toBeNull();
    });
  });

  test("of a stream with rounds, answers for the reply after its last call and not for a round's prose, which the relay never wrote", async () => {
    await withChild(async (dir, connect) => {
      const send = await connect(['inference:speech']);
      send({ type: 'text', content: JSON.stringify({ stream: ['Looking around.', 'Found it. It was here.'] }), from: 'console' });
      await until(() => answers(dir).length === 1, 'the turn');
      const id = answers(dir)[0].tag.connection;
      const ask = (text: string, final: boolean) => send({ type: 'text', content: JSON.stringify({ ask: { text, final, connections: [id] } }), from: 'console' });
      ask('Looking around.', false);
      ask('Looking around.', true);
      ask('Found it.', true);
      ask('It was here.', true);
      await until(() => answers(dir).length === 5, 'the asks');
      expect(answers(dir).slice(1).map((a) => a.asked)).toEqual([
        null,
        null,
        'the terminal that sent this turn (`connectome send`)',
        'the terminal that sent this turn (`connectome send`)',
      ]);
    });
  });

  test("answers for words the relay wrote as one run that the framework joins with a newline, as it joins a reply's text blocks", async () => {
    await withChild(async (dir, connect) => {
      const send = await connect(['inference:speech']);
      send({ type: 'text', content: JSON.stringify({ stream: 'Hello.World.' }), from: 'console' });
      await until(() => answers(dir).length === 1, 'the turn');
      const id = answers(dir)[0].tag.connection;
      send({ type: 'text', content: JSON.stringify({ ask: { text: 'Hello.\nWorld.', connections: [id] } }), from: 'console' });
      await until(() => answers(dir).length === 2, 'the ask');
      expect(answers(dir)[1].asked).toBe('the terminal that sent this turn (`connectome send`)');
    });
  });

  test("answers for a reply whose text blocks the stream interleaved with thinking, matching the text blocks alone", async () => {
    await withChild(async (dir, connect) => {
      const send = await connect(['inference:speech']);
      send({ type: 'text', content: JSON.stringify({ blocks: [
        { content: 'Hello.', blockType: 'text' },
        { content: 'considering it', blockType: 'thinking' },
        { content: 'World.', blockType: 'text' },
      ] }), from: 'console' });
      await until(() => answers(dir).length === 1, 'the turn');
      const id = answers(dir)[0].tag.connection;
      send({ type: 'text', content: JSON.stringify({ ask: { text: 'Hello.\nWorld.', connections: [id] } }), from: 'console' });
      await until(() => answers(dir).length === 2, 'the ask');
      expect(answers(dir)[1].asked).toBe('the terminal that sent this turn (`connectome send`)');
      await until(() => send.frames.some((f) => f.type === 'inference:speech'), 'the speech frame');
      const speech = send.frames.filter((f) => f.type === 'inference:speech').map((f) => String(f.content));
      expect(speech).toHaveLength(1);
      expect(speech[0]!.indexOf('Hello.')).toBeGreaterThanOrEqual(0);
      expect(speech[0]!.indexOf('World.')).toBeGreaterThan(speech[0]!.indexOf('Hello.'));
    });
  });

  test("two host processes give their first connections different ids", async () => {
    const firstIds: string[] = [];
    for (let boot = 0; boot < 2; boot++) {
      await withChild(async (dir, connect) => {
        const send = await connect(['inference:speech']);
        send({ type: 'text', content: 'hello', from: 'console' });
        await until(() => answers(dir).length === 1, 'the turn');
        firstIds.push(answers(dir)[0].tag.connection);
      });
    }
    expect(firstIds[0]).toMatch(UUID);
    expect(firstIds[1]).not.toBe(firstIds[0]);
  });

  test('a client not subscribed to speech was shown nothing', async () => {
    await withChild(async (dir, connect) => {
      const send = await connect([]);
      send({ type: 'text', content: 'hello', from: 'console' });
      await until(() => answers(dir).length === 1, 'the answers');
      expect(answers(dir)[0].final).toBeNull();
      // A reply on the same socket, after any speech frame the turn wrote.
      send({ type: 'request-lessons', corrId: 'after-the-turn' });
      await until(() => send.frames.some((f) => f.type === 'lessons-snapshot'), 'the reply after the turn');
      expect(send.frames.filter((f) => f.type === 'inference:speech')).toEqual([]);
    });
  });

  test('a client that is not a console is named as a client on the socket', async () => {
    await withChild(async (dir, connect) => {
      const send = await connect(['inference:speech']);
      send({ type: 'text', content: 'hello' });
      await until(() => answers(dir).length === 1, 'the answers');
      expect(answers(dir)[0].final).toBe("the client that sent this turn on this host's socket");
      expect(answers(dir)[0].anotherBoot).toBe("the client now connected on this host's socket, not the one that sent this turn");
    });
  });
});

describe('headless on a real framework', () => {
  test("a turn sent while the previous turn is still being asked about waits for it, and each turn's receipt names the terminal that sent it", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'surface-receipts-framework-'));
    const child = spawn(process.execPath, [new URL('./mock-headless-framework-child.ts', import.meta.url).pathname], {
      env: { ...process.env, DATA_DIR: dir }, stdio: 'ignore',
    });
    const sockets: Array<{ destroy(): void }> = [];
    try {
      await until(() => existsSync(join(dir, 'ipc.sock')), 'the socket');
      const connect = async () => {
        const socket = await connectWhenAccepting(join(dir, 'ipc.sock'));
        sockets.push(socket);
        socket.write(`${JSON.stringify({ type: 'subscribe', events: ['inference:speech'] })}\n`);
        return (content: string) => socket.write(`${JSON.stringify({ type: 'text', content, from: 'console' })}\n`);
      };
      const first = await connect();
      first('first');
      await until(() => existsSync(join(dir, 'asked-one')), "turn 1's ask", 20_000);
      const second = await connect();
      second('second');
      await until(() => existsSync(join(dir, 'taken-second')), 'the framework to take the second text in', 20_000);
      await Bun.sleep(200);
      expect(readFileSync(join(dir, 'starts'), 'utf8')).toBe('1');
      writeFileSync(join(dir, 'release'), '');
      const context = (): string[] => existsSync(join(dir, 'context.json')) ? JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8')) : [];
      const receipts = () => context().filter((t) => t.startsWith('[delivered]') || t.startsWith('[send-undeliverable]'));
      await until(() => receipts().length === 2, 'both receipts', 20_000);
      const turnLines = (t: string) => ['first', 'Reply one.', 'second', 'Reply two.'].includes(t) || t.startsWith('[delivered]') || t.startsWith('[send-undeliverable]');
      expect(context().filter(turnLines)).toEqual([
        'first',
        'Reply one.',
        '[delivered] plain speech → sent to the terminal that sent this turn (`connectome send`) · no channel posted it',
        'second',
        'Reply two.',
        '[delivered] plain speech → sent to the terminal that sent this turn (`connectome send`) · no channel posted it',
      ]);
    } finally {
      for (const socket of sockets) socket.destroy();
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('headless on a real framework, a turn no surface opened', () => {
  test("keeps the notice's word of another surface while a subscribed client was written the reply", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'headless-wake-'));
    const child = spawn(process.execPath, [new URL('./mock-headless-framework-child.ts', import.meta.url).pathname], {
      env: { ...process.env, DATA_DIR: dir, CHILD_MODE: 'wake' }, stdio: 'ignore',
    });
    let socket: { destroy(): void } | undefined;
    try {
      await until(() => existsSync(join(dir, 'ipc.sock')), 'the socket');
      const client = await connectWhenAccepting(join(dir, 'ipc.sock'));
      socket = client;
      let received = '';
      (client as unknown as { on(event: 'data', listener: (chunk: unknown) => void): void }).on('data', (chunk) => { received += String(chunk); });
      client.write(`${JSON.stringify({ type: 'subscribe', events: ['inference:speech'] })}\n`);
      const log = () => existsSync(join(dir, 'headless.log')) ? readFileSync(join(dir, 'headless.log'), 'utf8') : '';
      await until(() => log().includes('subscription set: inference:speech'), 'the host to take the subscription');
      writeFileSync(join(dir, 'wake'), '');
      const context = (): string[] => existsSync(join(dir, 'context.json')) ? JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8')) : [];
      const notices = () => context().filter((t) => t.startsWith('[send-undeliverable]'));
      await until(() => notices().length === 1, 'the notice', 20_000);
      await until(() => received.includes('"inference:speech"'), 'the speech frame');
      const speech = received.split('\n').filter((line) => line.includes('"inference:speech"'));
      expect(speech.map((line) => JSON.parse(line).content)).toEqual(['Woken reply.']);
      expect(notices()[0]).toContain('; if another surface showed it (a reply thread, the console), that copy stands');
    } finally {
      socket?.destroy();
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('the TUI module', () => {
  const rows = new Map<string, { metadata?: Record<string, unknown> }>();
  const module = (answers: SurfaceAnswers) => {
    const tui = new TuiModule(answers);
    void tui.start({ getMessage: (id: string) => rows.get(id) ?? null } as unknown as ModuleContext);
    return tui;
  };
  afterEach(() => rows.clear());

  test("keeps a surface's tag on the message it adds, and adds no note to a fleet parent's text", async () => {
    const tag = { surface: 'headless', connection: 'c-1' };
    const added = await module(new SurfaceAnswers()).onProcess({
      type: 'external-message', source: 'headless', content: 'from a parent', metadata: { [SURFACE_TAG_KEY]: tag },
    } as unknown as ProcessEvent, {} as never);
    expect(added.addMessages).toEqual([{ participant: 'user', content: [{ type: 'text', text: 'from a parent' }], metadata: { [SURFACE_TAG_KEY]: tag } }]);
    const unknown = await module(new SurfaceAnswers()).onProcess({
      type: 'external-message', source: 'headless', content: 'from elsewhere', metadata: { [SURFACE_TAG_KEY]: { surface: 'nowhere' } },
    } as unknown as ProcessEvent, {} as never);
    expect(unknown.addMessages).toEqual([{ participant: 'user', content: [{ type: 'text', text: 'from elsewhere' }] }]);
  });

  test('asks each surface whose messages opened the turn, in a fixed order, and joins their places', async () => {
    const answers = new SurfaceAnswers();
    const asked: unknown[] = [];
    answers.answerFor('web-ui', (q) => { asked.push(['web-ui', q]); return 'the Web UI page that sent this turn'; });
    answers.answerFor('tui', (q) => { asked.push(['tui', q]); return 'the TUI'; });
    answers.answerFor('headless', (q) => { asked.push(['headless', q]); return 'the terminal that sent this turn (`connectome send`)'; });
    rows.set('m1', { metadata: { [SURFACE_TAG_KEY]: { surface: 'web-ui', connection: 'page-1' } } });
    rows.set('m2', { metadata: { [SURFACE_TAG_KEY]: { surface: 'tui' } } });
    rows.set('m3', { metadata: {} });
    rows.set('m4', { metadata: { [SURFACE_TAG_KEY]: { surface: 'web-ui', connection: 'page-2' } } });
    rows.set('m5', { metadata: { [SURFACE_TAG_KEY]: { surface: 'web-ui', connection: 'page-1' } } });
    rows.set('m6', { metadata: { [SURFACE_TAG_KEY]: { surface: 'web-ui', connection: 42 } } });
    rows.set('m7', { metadata: { [SURFACE_TAG_KEY]: 'headless' } });
    const answer = await module(answers).onSpeechRouted('resident', 'Hi.', {
      final: true, openedBy: { reason: 'external-message', source: 'tui', timestamp: 1, messages: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'] },
    });
    expect(answer).toEqual({ sentTo: 'the TUI and the Web UI page that sent this turn' });
    expect(asked).toEqual([
      ['tui', { agentName: 'resident', text: 'Hi.', final: true, connections: [] }],
      ['web-ui', { agentName: 'resident', text: 'Hi.', final: true, connections: ['page-1', 'page-2'] }],
    ]);
  });

  test("names no place, answering {}, for a turn no surface's message opened or whose surfaces answer nothing or fail, and keeps one surface's place when another fails", async () => {
    const answers = new SurfaceAnswers();
    answers.answerFor('tui', () => undefined);
    answers.answerFor('headless', () => { throw new Error('broken'); });
    rows.set('m1', { metadata: { [SURFACE_TAG_KEY]: { surface: 'tui' } } });
    rows.set('m2', { metadata: { [SURFACE_TAG_KEY]: { surface: 'headless', connection: 'c-1' } } });
    const tui = module(answers);
    const opened = (messages: string[]) => ({ final: true, openedBy: { reason: 'r', source: 's', timestamp: 1, messages } });
    const errors: unknown[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      expect(await tui.onSpeechRouted('resident', 'Hi.', { final: true })).toEqual({});
      expect(await tui.onSpeechRouted('resident', 'Hi.', opened(['m-unknown']))).toEqual({});
      expect(await tui.onSpeechRouted('resident', 'Hi.', opened(['m1', 'm2']))).toEqual({});
      answers.answerFor('tui', () => 'the TUI');
      expect(await tui.onSpeechRouted('resident', 'Hi.', opened(['m1', 'm2']))).toEqual({ sentTo: 'the TUI' });
    } finally {
      console.error = error;
    }
    expect(errors).toHaveLength(2);
  });

  test("a headless opener that answers no, alone or beside a Web UI page that could have shown it, gets {} and only headless is asked", async () => {
    const answers = new SurfaceAnswers();
    const asked: string[] = [];
    answers.answerFor('headless', () => { asked.push('headless'); return undefined; });
    rows.set('m1', { metadata: { [SURFACE_TAG_KEY]: { surface: 'headless', connection: 'c-gone' } } });
    const tui = module(answers);
    const opened = { final: true, openedBy: { reason: 'external-message', source: 'headless', timestamp: 1, messages: ['m1'] } };
    expect(await tui.onSpeechRouted('resident', 'Hi.', opened)).toEqual({});
    answers.answerFor('web-ui', () => { asked.push('web-ui'); return 'a Web UI page open now, not the one that sent this turn'; });
    expect(await tui.onSpeechRouted('resident', 'Hi.', opened)).toEqual({});
    expect(asked).toEqual(['headless', 'headless']);
  });

  test("readline names the terminal, or standard output when it isn't one, for every agent; the TUI names itself for its root agent only", () => {
    const question = { agentName: 'helper', text: 'Hi.', final: false, connections: [] };
    expect(readlineAnswer(true)(question)).toBe('the terminal this host runs in');
    expect(readlineAnswer(false)(question)).toBe("this host's standard output");
    expect(tuiAnswer('resident')({ ...question, agentName: 'resident' })).toBe('the TUI');
    expect(tuiAnswer('resident')(question)).toBeUndefined();
  });
});

describe('in a framework', () => {
  const dirs: string[] = [];
  const frameworks: AgentFramework[] = [];
  afterEach(async () => {
    for (const framework of frameworks.splice(0)) await framework.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function host(answers: SurfaceAnswers) {
    const dir = mkdtempSync(join(tmpdir(), 'surface-receipts-af-')); dirs.push(dir);
    const adapter = new MockAdapter();
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new Membrane(adapter),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'Resident.', proseRouting: 'locus' }],
      modules: [new TuiModule(answers)],
    });
    frameworks.push(framework);
    await framework.start();
    // The channel registry an MCPL channel server's start makes, as on a host with Discord configured.
    await (framework as unknown as { initializeMcpl(servers: []): Promise<void> }).initializeMcpl([]);
    return { framework, adapter };
  }
  const texts = (framework: AgentFramework) => framework.getAgent('resident')!.getContextManager().getAllMessages()
    .map((m) => m.content.map((b) => (b as { text?: string }).text ?? '').join(''));
  const send = async (framework: AgentFramework, surface: string, source = 'cli') => {
    framework.pushEvent({ type: 'external-message', source, content: 'hello', metadata: { [SURFACE_TAG_KEY]: { surface, connection: 'c-1' } } } as unknown as ProcessEvent);
    await framework.runUntilIdle();
  };

  test("a reply the sending surface showed isn't reported undeliverable, its receipt names the surface, and no tag reaches the provider", async () => {
    const answers = new SurfaceAnswers();
    answers.answerFor('headless', ({ final, connections }) => final && connections.includes('c-1') ? 'the terminal that sent this turn (`connectome send`)' : undefined);
    const { framework, adapter } = await host(answers);
    await send(framework, 'headless', 'headless');
    const all = texts(framework);
    expect(all.filter((t) => t.startsWith('hello'))).toEqual(['hello']);
    expect(all.filter((t) => t.includes('[send-undeliverable]'))).toEqual([]);
    expect(all.filter((t) => t.startsWith('[delivered]')).at(-1)).toBe('[delivered] plain speech → sent to the terminal that sent this turn (`connectome send`) · no channel posted it');
    const requests = adapter.getRequestLog().map((r) => JSON.stringify(r.request));
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request).not.toContain(SURFACE_TAG_KEY);
  });

  test("a surface answers only for a turn it sent: another surface's turn keeps its notice", async () => {
    const answers = new SurfaceAnswers();
    answers.answerFor('tui', () => 'the TUI');
    const { framework } = await host(answers);
    await send(framework, 'headless');
    const notices = texts(framework).filter((t) => t.includes('[send-undeliverable]'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('; if another surface showed it (a reply thread, the console), that copy stands');
  });
});

describe('the Web UI', () => {
  let dir: string;
  let webUi: WebUiModule;
  let port: number;
  const pushed: Array<{ metadata?: Record<string, unknown> }> = [];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'surface-receipts-webui-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
    webUi = new WebUiModule({ port: 0, host: '127.0.0.1', staticDir: dir });
    await webUi.start({} as ModuleContext);
    port = __getSharedServerPortForTests()!;
    const cm = { getAllMessages: () => [], currentBranch: () => ({ id: 'b1', name: 'main' }) };
    const agent = { name: 'main', model: 'test-model', state: { status: 'idle' }, getContextManager: () => cm };
    webUi.setApp({
      framework: {
        getAllAgents: () => [agent], getAgent: () => agent, getAllModules: () => [], getModule: () => undefined,
        getSessionUsage: () => { throw new Error('no usage here'); }, onTrace: () => () => {},
        getHostModeStatus: () => ({ quiesced: false }),
        pushEvent: (event: { metadata?: Record<string, unknown> }) => { pushed.push(event); },
      },
      sessionManager: { getActiveSession: () => ({ id: 's1', name: 'first' }), findSession: (id: string) => (id === 's1' ? { id: 's1', name: 'first' } : null) },
      frameworkSessionId: 's1',
      recipe: { name: 'test', agent: { name: 'main' } },
      branchState: { checkpoints: new Map(), undoStack: [], redoStack: [] },
    } as never);
  });
  afterAll(async () => {
    await webUi.stop();
    await stopWebUiServer();
    rmSync(dir, { recursive: true, force: true });
  });

  async function page() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } } as unknown as undefined);
    const frames: Array<{ type: string }> = [];
    ws.addEventListener('message', (ev) => frames.push(JSON.parse(String(ev.data))));
    await new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve()); ws.addEventListener('error', (e) => reject(e)); });
    await until(() => frames.some((f) => f.type === 'welcome'), 'the welcome');
    return ws;
  }

  test('a page is named only while it is welcomed and holds the messages scope', () => {
    const page = (connection: string, more: Record<string, unknown> = {}) => ({ connection, welcomed: true, auth: 'full', scopes: null, ...more });
    const ask = (pages: ReturnType<typeof page>[], connections: string[], agentName = 'main') => pagesAnswer(pages as never, { agentName, connections }, 'main');
    expect(ask([page('p1')], ['p1'])).toBe('the Web UI page that sent this turn');
    expect(ask([page('p1')], ['p0'])).toBe('a Web UI page open now, not the one that sent this turn');
    expect(ask([page('p1', { welcomed: false })], ['p1'])).toBeUndefined();
    expect(ask([page('p1', { auth: 'observer', scopes: new Set(['health']) })], ['p1'])).toBeUndefined();
    expect(ask([page('p1', { auth: 'observer', scopes: new Set(['messages']) })], ['p1'])).toBe('the Web UI page that sent this turn');
    expect(ask([], ['p1'])).toBeUndefined();
    expect(ask([page('p1')], ['p1'], 'helper')).toBeUndefined();
    expect(pagesAnswer([page('p1')] as never, { agentName: 'main', connections: ['p1'] }, undefined)).toBeUndefined();
  });

  test('a page tags what it sends, and is named while it is open', async () => {
    const sender = await page();
    sender.send(JSON.stringify({ type: 'user-message', content: 'hi' }));
    await until(() => pushed.length === 1, 'the pushed text');
    const tag = pushed[0]!.metadata?.[SURFACE_TAG_KEY] as { surface: string; connection: string };
    expect(tag.surface).toBe('web-ui');
    expect(tag.connection).toMatch(UUID);
    const ask = (connections: string[], agentName = 'main') => surfaceAnswers.answer('web-ui', { agentName, text: 'Hi.', final: false, connections });
    expect(ask([tag.connection])).toBe('the Web UI page that sent this turn');
    expect(ask(['a-page-from-another-boot'])).toBe('a Web UI page open now, not the one that sent this turn');
    expect(ask([tag.connection], 'helper')).toBeUndefined();
    const other = await page();
    other.send(JSON.stringify({ type: 'user-message', content: 'hi too' }));
    await until(() => pushed.length === 2, 'the second page\'s text');
    const otherTag = pushed[1]!.metadata?.[SURFACE_TAG_KEY] as { connection: string };
    expect(otherTag.connection).toMatch(UUID);
    expect(otherTag.connection).not.toBe(tag.connection);
    other.close();
    sender.close();
    await until(() => ask([tag.connection]) === undefined, 'the closed page named by nothing');
  });
});
