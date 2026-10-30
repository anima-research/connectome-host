import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { send } from '../src/cli/connectome.ts';
import { connectWhenAccepting } from './ipc-connect.ts';

const CHILD = join(import.meta.dir, 'mock-headless-thinking-child.ts');
const REPLY = 'Hello.World.';

async function withHost(body: (dir: string) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-speech-')));
  const child = spawn(process.execPath, [CHILD], { cwd: dir, env: { ...process.env, ...env, DATA_DIR: dir }, stdio: 'ignore' });
  const closed = new Promise((resolve) => child.once('close', resolve));
  try {
    const deadline = Date.now() + 20_000;
    while (!existsSync(join(dir, 'ipc.sock'))) {
      if (Date.now() > deadline) throw new Error('the host never listened');
      await Bun.sleep(10);
    }
    await body(dir);
  } finally {
    child.kill('SIGTERM');
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function turnFrames(dir: string, turns = 1): Promise<Array<Record<string, unknown>>> {
  const socket = await connectWhenAccepting(join(dir, 'ipc.sock'));
  const frames: Array<Record<string, unknown>> = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      frames.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
    }
  });
  socket.write(`${JSON.stringify({ type: 'subscribe', events: ['inference:speech', 'inference:tokens', 'inference:started', 'inference:completed', 'inference:tool_calls_yielded', 'inference:turn_ended', 'lifecycle'] })}\n`);
  const deadline = Date.now() + 20_000;
  for (let turn = 1; turn <= turns; turn++) {
    socket.write(`${JSON.stringify({ type: 'text', content: `hello ${turn}`, from: 'console' })}\n`);
    while (frames.filter((f) => f.type === 'lifecycle' && f.phase === 'idle' && Number(f.texts) >= 1).length < turn) {
      if (Date.now() > deadline) throw new Error(`turn ${turn} never ended`);
      await Bun.sleep(10);
    }
  }
  socket.destroy();
  return frames;
}

test("a client subscribed to inference:speech gets the round's text without its thinking, which stays on inference:tokens", async () => {
  await withHost(async (dir) => {
    const frames = await turnFrames(dir);
    expect(frames.filter((f) => f.type === 'inference:speech').map((f) => f.content)).toEqual([REPLY]);
    const thinking = frames.filter((f) => f.type === 'inference:tokens' && f.blockType === 'thinking').map((f) => f.content).join('');
    expect(thinking).toBe('Weighing the question.One more thing to say.');
  });
}, 60_000);

test("a final round with no text sends inference:speech with no text, so a parent doesn't keep an earlier reply as the latest", async () => {
  await withHost(async (dir) => {
    const frames = await turnFrames(dir);
    expect(frames.filter((f) => f.type === 'inference:speech').map((f) => f.content)).toEqual(['']);
  }, { CHILD_REPLY: 'thinking-only' });
}, 60_000);

test("a turn that ends on an end-turn tool sends no inference:speech, so the earlier reply stays the latest", async () => {
  await withHost(async (dir) => {
    const frames = await turnFrames(dir, 2);
    const calls = frames.filter((f) => f.type === 'inference:tool_calls_yielded')
      .flatMap((f) => (f.calls as Array<{ name: string }>).map((call) => call.name));
    expect(calls).toEqual(['skip_reply']);
    expect(frames.filter((f) => f.type === 'inference:turn_ended')).toHaveLength(1);
    expect(frames.filter((f) => f.type === 'inference:speech').map((f) => f.content)).toEqual([REPLY]);
  }, { CHILD_REPLY: 'then-skip' });
}, 60_000);

test("a final round after an ordinary tool's round sends its own text alone, without the tool round's", async () => {
  await withHost(async (dir) => {
    const frames = await turnFrames(dir);
    expect(frames.some((f) => f.type === 'inference:tool_calls_yielded')).toBe(true);
    expect(frames.filter((f) => f.type === 'inference:speech').map((f) => f.content)).toEqual(['Done.']);
  }, { CHILD_REPLY: 'tool-then-reply' });
}, 60_000);

test("a final round with no blocks at all, after an ordinary tool's round, sends inference:speech with no text", async () => {
  await withHost(async (dir) => {
    const frames = await turnFrames(dir);
    expect(frames.some((f) => f.type === 'inference:tool_calls_yielded')).toBe(true);
    expect(frames.filter((f) => f.type === 'inference:turn_ended')).toHaveLength(0);
    expect(frames.filter((f) => f.type === 'inference:speech').map((f) => f.content)).toEqual(['']);
  }, { CHILD_REPLY: 'tool-then-empty' });
}, 60_000);

for (const [mode, what] of [['then-silent', 'that speaks'], ['then-silent-tool', 'that calls a tool and then speaks']] as const) {
  test(`a silent heartbeat's stream ${what} sends no inference:speech, and the next turn's reply sends its own`, async () => {
    await withHost(async (dir) => {
      const frames = await turnFrames(dir, 2);
      expect(frames.filter((f) => f.type === 'inference:started').map((f) => f.silent === true)).toEqual([false, true, false]);
      const silent = frames.slice(frames.findIndex((f) => f.type === 'inference:started' && f.silent === true));
      const silentEnd = silent.findIndex((f) => f.type === 'inference:completed');
      const heard = silent.slice(0, silentEnd);
      expect(heard.filter((f) => f.type === 'inference:tokens' && f.blockType === 'text').map((f) => f.content).join('')).toContain('Private self-check.');
      expect(heard.some((f) => f.type === 'inference:tool_calls_yielded')).toBe(mode === 'then-silent-tool');
      expect(frames.filter((f) => f.type === 'inference:speech').map((f) => f.content)).toEqual([REPLY, 'After.']);
    }, { CHILD_REPLY: mode });
  }, 60_000);
}

test("connectome send prints nothing for a final round with no text, and says the turn ended without saying anything", async () => {
  await withHost(async (dir) => {
    const root = join(dir, 'install');
    mkdirSync(root);
    writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: dir, extraState: [] }));
    const out: string[] = [];
    const err: string[] = [];
    const status = await send({ root, argv: ['hello'], out: (line) => out.push(line), err: (line) => err.push(line) });
    expect(status).toBe(0);
    expect(out).toEqual([]);
    expect(err.some((line) => line.includes("the agent's turn ended without saying anything here"))).toBe(true);
  }, { CHILD_REPLY: 'thinking-only' });
}, 60_000);

test("connectome send prints the reply alone, without the agent's thinking", async () => {
  await withHost(async (dir) => {
    const root = join(dir, 'install');
    mkdirSync(root);
    writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: dir, extraState: [] }));
    const out: string[] = [];
    const status = await send({ root, argv: ['hello'], out: (line) => out.push(line), err: () => {} });
    expect(status).toBe(0);
    expect(out).toEqual([REPLY]);
  });
}, 60_000);
