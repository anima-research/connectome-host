import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework, type ModuleContext, type ProcessEvent } from '@animalabs/agent-framework';
import { Membrane, MockAdapter } from '@animalabs/membrane';
import { connectWhenAccepting } from './ipc-connect.js';
import { send } from '../src/cli/connectome.js';
import { TuiModule } from '../src/modules/tui-module.js';
import { SURFACE_TAG_KEY, SurfaceAnswers, readlineAnswer, surfaceTagOf, tuiAnswer } from '../src/surfaces.js';
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
  async function withChild(body: (dir: string, connect: (subscribe: string[] | null) => Promise<Send>) => Promise<void>) {
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
        if (subscribe) send({ type: 'subscribe', events: subscribe });
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
      expect(answer.anotherAgent).toBeNull();
      expect(answer.anotherBoot).toBe("another client on this host's socket, not the one that sent this turn");
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

  test("of a stream with rounds, answers for the reply after its last call", async () => {
    await withChild(async (dir, connect) => {
      const send = await connect(['inference:speech']);
      send({ type: 'text', content: JSON.stringify({ stream: ['Looking around.', 'Found it. It was here.'] }), from: 'console' });
      await until(() => answers(dir).length === 1, 'the turn');
      const id = answers(dir)[0].tag.connection;
      const ask = (text: string) => send({ type: 'text', content: JSON.stringify({ ask: { text, final: true, connections: [id] } }), from: 'console' });
      ask('Found it.');
      ask('It was here.');
      await until(() => answers(dir).length === 3, 'the asks');
      expect(answers(dir).slice(1).map((a) => a.asked)).toEqual([
        'the terminal that sent this turn (`connectome send`)',
        'the terminal that sent this turn (`connectome send`)',
      ]);
    });
  });

  test("writes a round's prose as inference:prose when the framework asks about it, not when the round ends, and answers for it", async () => {
    await withChild(async (dir, connect) => {
      const send = await connect(['inference:speech', 'inference:prose']);
      send({ type: 'text', content: JSON.stringify({ stream: ['Looking around.', 'Found it.'] }), from: 'console' });
      await until(() => answers(dir).length === 1, 'the turn');
      await until(() => send.frames.some((f) => f.type === 'inference:speech'), 'the reply');
      expect(send.frames.filter((f) => f.type === 'inference:prose')).toEqual([]);
      const id = answers(dir)[0].tag.connection;
      send({ type: 'text', content: JSON.stringify({ ask: { text: 'Looking around.', final: false, connections: [id] } }), from: 'console' });
      await until(() => answers(dir).length === 2, 'the ask');
      expect(answers(dir)[1].asked).toBe('the terminal that sent this turn (`connectome send`)');
      await until(() => send.frames.some((f) => f.type === 'inference:prose'), 'the prose frame');
      expect(send.frames.filter((f) => f.type === 'inference:prose').map((f) => [f.agentName, f.content])).toEqual([['fixture', 'Looking around.']]);
    });
  });

  test("writes a round's prose to no client but the one that sent the turn, and to none not subscribed to inference:prose", async () => {
    await withChild(async (dir, connect) => {
      const sender = await connect(['inference:speech', 'inference:prose']);
      sender({ type: 'text', content: JSON.stringify({ stream: 'Hi.' }), from: 'console' });
      await until(() => answers(dir).length === 1, 'the turn');
      const senderId = answers(dir)[0].tag.connection;
      const another = await connect(['inference:speech', 'inference:prose']);
      another({ type: 'text', content: JSON.stringify({ ask: { text: 'A note.', final: false, connections: [senderId] } }), from: 'console' });
      await until(() => answers(dir).length === 2, 'the ask for the turn of a client that has left');
      another({ type: 'text', content: JSON.stringify({ stream: 'After the first ask.' }), from: 'console' });
      await until(() => another.frames.some((f) => f.type === 'inference:speech' && f.content === 'After the first ask.'), 'the first barrier');
      const speechOnly = await connect(['inference:speech']);
      speechOnly({ type: 'text', content: JSON.stringify({ stream: 'Hi.' }), from: 'console' });
      await until(() => answers(dir).length === 4, 'the second turn');
      const id = answers(dir)[3].tag.connection;
      speechOnly({ type: 'text', content: JSON.stringify({ ask: { text: 'A note.', final: false, connections: [id] } }), from: 'console' });
      await until(() => answers(dir).length === 5, 'the ask for an unsubscribed connection');
      speechOnly({ type: 'text', content: JSON.stringify({ stream: 'After the second ask.' }), from: 'console' });
      await until(() => speechOnly.frames.some((f) => f.type === 'inference:speech' && f.content === 'After the second ask.'), 'the second barrier');
      expect(senderId).toMatch(UUID);
      expect([answers(dir)[1].asked, answers(dir)[4].asked]).toEqual([null, null]);
      expect([...sender.frames, ...another.frames, ...speechOnly.frames].filter((f) => f.type === 'inference:prose')).toEqual([]);
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
      expect(answers(dir)[0].anotherBoot).toBe("another client on this host's socket, not the one that sent this turn");
    });
  });

  test("a text without from carries a note that a plain reply won't reach its sender only while the sender doesn't take inference:speech and the framework has no channel registry", async () => {
    const NOTE = "[host note: the client that sent this wasn't subscribed to inference:speech when it arrived, so a " +
      "plain-prose reply won't reach it unless it subscribes.]";
    await withChild(async (dir, connect) => {
      const unsubscribed = await connect(['lifecycle']);
      unsubscribed({ type: 'text', content: 'hello' });
      await until(() => answers(dir).length === 1, 'the first turn');
      expect(answers(dir)[0].texts).toEqual(['hello', NOTE]);
      unsubscribed({ type: 'text', content: 'hello', from: 'console' });
      await until(() => answers(dir).length === 2, 'the console line');
      expect(answers(dir)[1].texts).toEqual(['hello']);
      const subscribed = await connect(['inference:speech']);
      subscribed({ type: 'text', content: 'hello' });
      await until(() => answers(dir).length === 3, 'the subscribed client');
      expect(answers(dir)[2].texts).toEqual(['hello']);
      subscribed({ type: 'text', content: JSON.stringify({ registry: true }), from: 'console' });
      await until(() => answers(dir).length === 4, 'the registry');
      const withRegistry = await connect(['lifecycle']);
      withRegistry({ type: 'text', content: 'hello' });
      await until(() => answers(dir).length === 5, 'the turn with a registry');
      expect(answers(dir)[4].texts).toEqual(['hello']);
    });
  });

  test("a client that didn't send the turn is named only once it has subscribed itself, so a second connectome send during a turn isn't", async () => {
    await withChild(async (dir, connect) => {
      const send = await connect(null);
      send({ type: 'text', content: 'hello', from: 'console' });
      await until(() => answers(dir).length === 1, 'the answers');
      expect(answers(dir)[0].final).toBe('the terminal that sent this turn (`connectome send`)');
      expect(answers(dir)[0].anotherBoot).toBeNull();
    });
  });
});

describe('headless on a real framework', () => {
});

describe('headless on a real framework, a turn whose rounds end with tool calls', () => {
  const TERMINAL = '[delivered] plain speech → sent to the terminal that sent this turn (`connectome send`) · this turn\'s routing posted it to no channel';
  async function withRounds(mode: 'notes' | 'kept', body: (dir: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'surface-receipts-rounds-'));
    const child = spawn(process.execPath, [new URL('./mock-headless-framework-child.ts', import.meta.url).pathname], {
      env: { ...process.env, DATA_DIR: dir, CHILD_MODE: mode }, stdio: 'ignore',
    });
    try {
      await until(() => existsSync(join(dir, 'ipc.sock')), 'the socket');
      await body(dir);
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }
  async function client(dir: string, events: string[]) {
    const socket = await connectWhenAccepting(join(dir, 'ipc.sock'));
    const frames: Array<Record<string, unknown>> = [];
    let buffered = '';
    socket.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const lines = buffered.split('\n');
      buffered = lines.pop()!;
      for (const line of lines) if (line.trim()) frames.push(JSON.parse(line));
    });
    socket.write(`${JSON.stringify({ type: 'subscribe', events })}\n`);
    const log = () => existsSync(join(dir, 'headless.log')) ? readFileSync(join(dir, 'headless.log'), 'utf8') : '';
    await until(() => log().includes(`subscription set: ${events.join(', ')}`), 'the host to take the subscription');
    return { socket, frames, say: (content: string) => socket.write(`${JSON.stringify({ type: 'text', content, from: 'console' })}\n`) };
  }
  const receipts = (context: string[]) => context.filter((t) => t.startsWith('[delivered]') || t.startsWith('[send-undeliverable]'));

  async function contextAfter(dir: string, since: number): Promise<string[]> {
    const path = join(dir, 'context.json');
    await until(() => existsSync(path) && statSync(path).mtimeMs > since, 'a context written after the turn ended', 20_000);
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  const idle = (frames: Array<Record<string, unknown>>) => frames.some((f) => f.type === 'lifecycle' && f.phase === 'idle' && Number(f.texts) >= 1);

  test("each note the framework routes reaches the terminal that sent the turn as inference:prose, and the resident is told so", async () => {
    await withRounds('notes', async (dir) => {
      const terminal = await client(dir, ['inference:speech', 'inference:prose', 'lifecycle']);
      try {
        terminal.say('please');
        await until(() => idle(terminal.frames), 'the turn to end', 20_000);
        const ended = Date.now();
        expect(terminal.frames.filter((f) => f.type === 'inference:prose' || f.type === 'inference:speech').map((f) => [f.type, f.content])).toEqual([
          ['inference:prose', 'First note.'],
          ['inference:prose', 'Second note.'],
          ['inference:speech', 'The reply.'],
        ]);
        expect(receipts(await contextAfter(dir, ended))).toEqual([TERMINAL]);
      } finally {
        terminal.socket.destroy();
      }
    });
  }, 60_000);

  test("connectome send prints each note, and the reply last", async () => {
    await withRounds('notes', async (dir) => {
      const root = join(dir, 'install');
      mkdirSync(root);
      writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: dir, extraState: [] }));
      const out: string[] = [];
      const sent = send({ root, argv: ['please'], out: (line) => out.push(line), err: () => {} });
      expect(await sent).toBe(0);
      expect(out).toEqual(['First note.', 'Second note.', 'The reply.']);
    });
  }, 60_000);

  test('words a round keeps with skip_reply never reach the terminal, and nothing says they did', async () => {
    await withRounds('kept', async (dir) => {
      const terminal = await client(dir, ['inference:speech', 'inference:prose', 'lifecycle']);
      try {
        terminal.say('please');
        await until(() => idle(terminal.frames), 'the turn to end', 20_000);
        const context = await contextAfter(dir, Date.now());
        expect(context).toContain('Kept words.');
        expect(terminal.frames.filter((f) => f.type === 'inference:prose' || f.type === 'inference:speech')).toEqual([]);
        expect(context.filter((t) => t.includes('sent to the terminal'))).toEqual([]);
      } finally {
        terminal.socket.destroy();
      }
    });
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

  test("reads a tag back only when its surface is known and its connection, if it has one, is a string", () => {
    const read = (tag: unknown) => surfaceTagOf({ [SURFACE_TAG_KEY]: tag });
    expect(read({ surface: 'web-ui', connection: 'p-1' })).toEqual({ surface: 'web-ui', connection: 'p-1' });
    expect(read({ surface: 'readline' })).toEqual({ surface: 'readline' });
    expect(read({ surface: 'web-ui', connection: 7 })).toBeUndefined();
    expect(read({ surface: 'headless', connection: null })).toBeUndefined();
    expect(read({ surface: 'nowhere', connection: 'p-1' })).toBeUndefined();
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

  test("readline names the terminal, or standard output when it isn't one, for every agent; the TUI names itself for its root agent only, and not while that agent's turn is in the background", () => {
    const question = { agentName: 'helper', text: 'Hi.', final: false, connections: [] };
    expect(readlineAnswer(true)(question)).toBe('the terminal this host runs in');
    expect(readlineAnswer(false)(question)).toBe("this host's standard output");
    let showing = true;
    const tuiAnswers = tuiAnswer('resident', () => showing);
    expect(tuiAnswers({ ...question, agentName: 'resident' })).toBe('the TUI');
    expect(tuiAnswers(question)).toBeUndefined();
    showing = false;
    expect(tuiAnswers({ ...question, agentName: 'resident' })).toBeUndefined();
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
    expect(all.filter((t) => t.startsWith('[delivered]')).at(-1)).toBe('[delivered] plain speech → sent to the terminal that sent this turn (`connectome send`) · this turn\'s routing posted it to no channel');
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
  const surfaces = new SurfaceAnswers();
  const pushed: Array<{ metadata?: Record<string, unknown> }> = [];
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'surface-receipts-webui-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
    webUi = new WebUiModule({ port: 0, host: '127.0.0.1', staticDir: dir, surfaces });
    await webUi.start({} as ModuleContext);
    port = __getSharedServerPortForTests()!;
    webUi.setApp(appShowing('main'));
  });
  function appShowing(agentName: string): never {
    const cm = { getAllMessages: () => [], currentBranch: () => ({ id: 'b1', name: 'main' }) };
    const agent = { name: agentName, model: 'test-model', state: { status: 'idle' }, getContextManager: () => cm };
    return {
      framework: {
        getAllAgents: () => [agent], getAgent: () => agent, getAllModules: () => [], getModule: () => undefined,
        getSessionUsage: () => { throw new Error('no usage here'); }, onTrace: () => () => {},
        getHostModeStatus: () => ({ quiesced: false }),
        pushEvent: (event: { metadata?: Record<string, unknown> }) => { pushed.push(event); },
      },
      sessionManager: { getActiveSession: () => ({ id: 's1', name: 'first' }), findSession: (id: string) => (id === 's1' ? { id: 's1', name: 'first' } : null) },
      frameworkSessionId: 's1',
      recipe: { name: 'test', agent: { name: agentName } },
      branchState: { checkpoints: new Map(), undoStack: [], redoStack: [] },
    } as never;
  }
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
    const ask = (connections: string[], agentName = 'main') => surfaces.answer('web-ui', { agentName, text: 'Hi.', final: false, connections });
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

  test("the answer follows the module's app and the server's life: none once the module stops, the new app's agent after setApp, and none once the server stops", async () => {
    const sender = await page();
    sender.send(JSON.stringify({ type: 'user-message', content: 'hi again' }));
    const before = pushed.length;
    await until(() => pushed.length === before + 1, 'the pushed text');
    const tag = pushed[before]!.metadata?.[SURFACE_TAG_KEY] as { connection: string };
    const ask = (agentName: string) => surfaces.answer('web-ui', { agentName, text: 'Hi.', final: false, connections: [tag.connection] });
    expect(ask('main')).toBe('the Web UI page that sent this turn');
    await webUi.stop();
    expect(ask('main')).toBeUndefined();
    webUi.setApp(appShowing('other'));
    await until(() => ask('other') === 'the Web UI page that sent this turn', "the page welcomed again for the new app");
    expect(ask('main')).toBeUndefined();
    await stopWebUiServer();
    expect(ask('other')).toBeUndefined();
    sender.close();
  });
});
