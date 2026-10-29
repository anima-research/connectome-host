import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectWhenAccepting } from './ipc-connect.js';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

function linesWritten(path: string) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').slice(0, -1).map((line) => JSON.parse(line));
}

async function withChild(
  body: (send: (command: object) => void, events: Array<Record<string, unknown>>, dir: string, closed: () => boolean) => Promise<void>,
  env: Record<string, string> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'headless-command-done-'));
  const child = spawn(process.execPath, [new URL('./mock-headless-command-child.ts', import.meta.url).pathname], {
    env: { ...process.env, ...env, DATA_DIR: dir }, stdio: 'ignore',
  });
  try {
    await until(() => existsSync(join(dir, 'ipc.sock')), 'socket');
    const socket = await connectWhenAccepting(join(dir, 'ipc.sock'));
    const events: Array<Record<string, unknown>> = [];
    let ended = false;
    socket.on('close', () => { ended = true; });
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) events.push(JSON.parse(line));
      }
    });
    await until(() => events.some((event) => event.type === 'lifecycle' && event.phase === 'ready'), 'ready');
    const send = (command: object) => socket.write(`${JSON.stringify(command)}\n`);
    send({ type: 'subscribe', events: [] });
    await body(send, events, dir, () => ended);
    socket.destroy();
  } finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a command with a corrId gets each line with it, and then command-done after its follow-up', async () => {
  await withChild(async (send, events, dir) => {
    const release = join(dir, 'release');
    send({
      type: 'command', corrId: 'c1',
      command: `/puppet delayed ${JSON.stringify({ release, done: join(dir, 'done'), result: 'DELAYED-RESULT' })}`,
    });
    await until(() => events.some((event) => event.type === 'command-output'), 'first line');
    expect(events.some((event) => event.type === 'command-done')).toBe(false);
    writeFileSync(release, '');
    await until(() => events.some((event) => event.type === 'command-done'), 'done');
    send({ type: 'command', corrId: 'barrier', command: '/no-such-barrier' });
    await until(() => events.some((event) => event.type === 'command-done' && event.corrId === 'barrier'), 'barrier');
    const answer = events.filter((event) => (event.type === 'command-output' || event.type === 'command-done') &&
      event.corrId !== 'barrier');
    expect(answer.every((event) => event.corrId === 'c1')).toBe(true);
    expect(answer.filter((event) => event.type === 'command-done')).toHaveLength(1);
    expect(answer.at(-1)!.type).toBe('command-done');
    expect(answer.at(-1)!.error).toBeUndefined();
    expect(answer.some((event) => String(event.text).includes('DELAYED-RESULT'))).toBe(true);
  });
});

test('a command whose follow-up fails ends with command-done carrying the error, once, after its lines', async () => {
  await withChild(async (send, events) => {
    send({ type: 'command', corrId: 'u1', command: '/update' });
    await until(() => events.some((event) => event.type === 'command-done'), 'done');
    const answer = events.filter((event) => event.corrId === 'u1');
    expect(answer.map((event) => event.type)).toEqual(['command-output', 'command-done']);
    expect(answer[0]!.text).toBe('Reading the registry…');
    expect(String(answer[1]!.error)).toContain('update isn\'t set up');
  });
});

test('an answer that says it didn\'t do what was asked ends with command-done marked refused, and one that did isn\'t marked', async () => {
  await withChild(async (send, events, dir) => {
    const release = join(dir, 'release');
    writeFileSync(release, '');
    send({ type: 'command', corrId: 'did', command: `/puppet delayed ${JSON.stringify({ release, done: join(dir, 'done'), result: 'DID-RESULT' })}` });
    send({ type: 'command', corrId: 'no', command: '/update restart wait' });
    const doneOf = (corrId: string) => events.find((event) => event.type === 'command-done' && event.corrId === corrId);
    await until(() => doneOf('did') !== undefined && doneOf('no') !== undefined, 'both answers');
    const { ts: _no, ...refused } = doneOf('no')!;
    expect(refused).toEqual({ type: 'command-done', corrId: 'no', refused: true });
    expect(events.some((event) => event.corrId === 'no' && String(event.text).includes('nothing to wait longer for'))).toBe(true);
    const { ts: _did, ...did } = doneOf('did')!;
    expect(did).toEqual({ type: 'command-done', corrId: 'did' });
  });
});

test('an answer refused without a follow-up, as /update back at a host that isn\'t an install, ends with command-done marked refused', async () => {
  await withChild(async (send, events) => {
    send({ type: 'command', corrId: 'back', command: '/update back' });
    await until(() => events.some((event) => event.type === 'command-done' && event.corrId === 'back'), 'done');
    const answer = events.filter((event) => event.corrId === 'back').map(({ ts: _ts, ...rest }) => rest);
    expect(answer.at(-1)).toEqual({ type: 'command-done', corrId: 'back', refused: true });
    expect(answer.some((event) => String(event.text).includes('wasn\'t started through an install\'s entry point'))).toBe(true);
  }, { UPDATE_NOT_AN_INSTALL: '1' });
});

test('a command with a corrId that isn\'t a string command is refused with command-done', async () => {
  await withChild(async (send, events) => {
    send({ type: 'command', corrId: 'n1', command: 42 });
    await until(() => events.some((event) => event.type === 'command-done'), 'done');
    expect(events.filter((event) => event.corrId === 'n1').map(({ ts: _ts, ...rest }) => rest)).toEqual([
      { type: 'command-done', corrId: 'n1', error: 'command must be a string' },
    ]);
  });
});

test('/quit with a corrId gets its command-done before the host closes the connection', async () => {
  await withChild(async (send, events, _dir, closed) => {
    send({ type: 'command', corrId: 'q1', command: '/quit' });
    await until(closed, 'closed');
    expect(events.filter((event) => event.corrId === 'q1').map(({ ts: _ts, ...rest }) => rest)).toEqual([
      { type: 'command-output', text: 'Goodbye.', style: 'system', corrId: 'q1' },
      { type: 'command-done', corrId: 'q1' },
    ]);
  });
});

test('a command without a corrId gets exactly the lines it got before, and no command-done', async () => {
  await withChild(async (send, events, dir) => {
    const release = join(dir, 'release');
    send({ type: 'command', command: `/puppet delayed ${JSON.stringify({ release, done: join(dir, 'done'), result: 'UNCORRELATED' })}` });
    await until(() => events.some((event) => String(event.text).includes('puppet: executing delayed')), 'started');
    writeFileSync(release, '');
    await until(() => events.some((event) => String(event.text).includes('UNCORRELATED')), 'follow-up');
    const puppet = events.length;
    send({ type: 'command', command: '/no-such-command' });
    await until(() => events.some((event) => String(event.text).includes('/no-such-command.')), 'first answer');
    send({ type: 'command', command: '/no-such-command-either' });
    await until(() => events.some((event) => String(event.text).includes('/no-such-command-either')), 'second answer');
    send({ type: 'command', corrId: 'barrier', command: '/no-such-barrier' });
    await until(() => events.some((event) => event.type === 'command-done' && event.corrId === 'barrier'), 'barrier');
    expect(events.slice(0, puppet).filter((event) => event.type !== 'lifecycle')
      .every((event) => event.type === 'command-output' && !('corrId' in event))).toBe(true);
    const answer = events.slice(puppet).filter((event) => event.corrId !== 'barrier');
    expect(answer.map(({ ts: _ts, ...rest }) => rest)).toEqual([
      { type: 'command-output', text: 'Unknown command: /no-such-command. Type /help.', style: 'system' },
      { type: 'command-output', text: 'Unknown command: /no-such-command-either. Type /help.', style: 'system' },
    ]);
  });
});

test('a text from a console reaches the agent as a console line, with no IPC note; one without reaches it with the note', async () => {
  await withChild(async (send, _events, dir) => {
    const pushed = () => linesWritten(join(dir, 'pushed.jsonl'));
    send({ type: 'text', content: 'from a console', from: 'console' });
    await until(() => pushed().length === 1, 'the console line');
    send({ type: 'text', content: 'from a fleet parent' });
    await until(() => pushed().length === 2, 'the parent line');
    const [console, parent] = pushed();
    expect(console).toEqual([{ type: 'text', text: 'from a console' }]);
    expect(parent[0]).toEqual({ type: 'text', text: 'from a fleet parent' });
    expect(parent[1].text).toContain('A plain-prose reply will NOT reach the sender');
  });
});

test('a line the fixture is still writing isn\'t read: a file with no line ended yet reads as none, and one with a line after the last ended one reads as those ended', () => {
  const dir = mkdtempSync(join(tmpdir(), 'headless-command-done-lines-'));
  try {
    const path = join(dir, 'pushed.jsonl');
    writeFileSync(path, '');
    expect(linesWritten(path)).toEqual([]);
    writeFileSync(path, '[{"type":"te');
    expect(linesWritten(path)).toEqual([]);
    writeFileSync(path, '[{"type":"text","text":"whole"}]\n[{"type":"te');
    expect(linesWritten(path)).toEqual([[{ type: 'text', text: 'whole' }]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
