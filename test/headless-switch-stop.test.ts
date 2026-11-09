import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectWhenAccepting } from './ipc-connect.ts';

const FIXTURE = join(import.meta.dir, 'mock-headless-switch-stop-child.ts');

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${what}`);
    await Bun.sleep(10);
  }
}

interface Host {
  dir: string;
  events: Array<Record<string, unknown>>;
  command(text: string, corrId: string): void;
  signal(name: NodeJS.Signals): void;
  exited: Promise<number | null>;
}

async function withHost(body: (host: Host) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-switch-stop-')));
  const child = spawn(process.execPath, [FIXTURE], { env: { ...process.env, ...env, DATA_DIR: dir }, stdio: 'ignore' });
  const exited = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
  try {
    await until(() => existsSync(join(dir, 'ipc.sock')), 'the socket');
    const socket = await connectWhenAccepting(join(dir, 'ipc.sock'));
    const events: Array<Record<string, unknown>> = [];
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        events.push(JSON.parse(buffer.slice(0, at)));
        buffer = buffer.slice(at + 1);
      }
    });
    socket.on('error', () => { /* the host closes it as it exits */ });
    await until(() => events.some((e) => e.type === 'lifecycle' && e.phase === 'ready'), 'the host\'s ready');
    await body({
      dir,
      events,
      command: (text, corrId) => { socket.write(`${JSON.stringify({ type: 'command', command: text, corrId })}\n`); },
      signal: (name) => { child.kill(name); },
      exited,
    });
    socket.destroy();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
}

const seen = (dir: string, name: string): boolean => existsSync(join(dir, name));
const said = (host: Host, corrId: string): string[] =>
  host.events.filter((e) => e.type === 'command-output' && e.corrId === corrId).map((e) => String(e.text));
const done = (host: Host, corrId: string): Record<string, unknown> | undefined =>
  host.events.find((e) => e.type === 'command-done' && e.corrId === corrId);

for (const [what, env, answer, code] of [
  ['makes its framework: it stops what the switch made rather than starting it, says the switch didn\'t finish, and exits 0', {},
    { said: 'The host began to stop during the session switch, so the switch didn\'t finish; the next start opens session later [s2].' }, 0],
  ['fails to make its framework: it answers with the failure and exits 0', { FIXTURE_MAKE: 'fail' },
    { error: 'making the next framework failed' }, 0],
  ['makes a framework whose stop fails: it answers with the failure and exits 1', { FIXTURE_NEXT_STOP: 'fail' },
    { error: 'the next framework\'s stop failed' }, 1],
] as const) {
  test(`a headless host that gets SIGTERM while a session switch ${what}, stopping nothing before the switch settles`, async () => {
    await withHost(async (host) => {
      host.command('/session new later', 'c3');
      await until(() => seen(host.dir, 'making'), 'the switch\'s make');
      writeFileSync(join(host.dir, 'stop-go'), '');
      host.signal('SIGTERM');
      const log = join(host.dir, 'headless.log');
      await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('waiting for the session switch under way'), 'the shutdown waiting for the switch');
      writeFileSync(join(host.dir, 'make-go'), '');
      await until(() => done(host, 'c3') !== undefined, 'the command\'s end');
      expect('said' in answer ? { said: said(host, 'c3').at(-1) } : { error: done(host, 'c3')!.error }).toEqual(answer);
      expect(await host.exited).toBe(code);
      expect(seen(host.dir, 'started-next')).toBe(false);
      expect(readFileSync(join(host.dir, 'order'), 'utf8').trim().split('\n'))
        .toEqual('FIXTURE_MAKE' in env ? ['make settled', 'stop first'] : ['make settled', 'stop next', 'stop first']);
    }, env);
  }, 60_000);
}

test('a headless host whose switch makes its framework while the shutdown flushes, and fails to stop it, exits 1, with no wait to log', async () => {
  await withHost(async (host) => {
    host.command('/session new later', 'c5');
    await until(() => seen(host.dir, 'making'), 'the switch\'s make');
    writeFileSync(join(host.dir, 'stop-go'), '');
    host.signal('SIGTERM');
    await until(() => done(host, 'c5') !== undefined, 'the command\'s end');
    expect(done(host, 'c5')!.error).toBe('the next framework\'s stop failed');
    expect(await host.exited).toBe(1);
    expect(readFileSync(join(host.dir, 'order'), 'utf8').trim().split('\n')).toEqual(['make settled', 'stop next', 'stop first']);
    expect(readFileSync(join(host.dir, 'headless.log'), 'utf8')).not.toContain('waiting for the session switch under way');
  }, { FIXTURE_MAKE: 'on-stop', FIXTURE_NEXT_STOP: 'fail' });
}, 60_000);

test('a headless host that gets SIGTERM while a session switch installs its framework waits for the install, then stops the framework it installed, and exits 0', async () => {
  await withHost(async (host) => {
    host.command('/session new later', 'c6');
    writeFileSync(join(host.dir, 'make-go'), '');
    await until(() => seen(host.dir, 'installing'), 'the switch\'s install');
    writeFileSync(join(host.dir, 'stop-go'), '');
    host.signal('SIGTERM');
    const log = join(host.dir, 'headless.log');
    await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('waiting for the session switch under way'), 'the shutdown waiting for the switch');
    writeFileSync(join(host.dir, 'install-go'), '');
    await until(() => done(host, 'c6') !== undefined, 'the command\'s end');
    expect(said(host, 'c6').at(-1)).toBe('Session switched.');
    expect(await host.exited).toBe(0);
    expect(seen(host.dir, 'started-next')).toBe(true);
    expect(readFileSync(join(host.dir, 'order'), 'utf8').trim().split('\n')).toEqual(['make settled', 'stop next']);
  }, { FIXTURE_INSTALL: 'held' });
}, 60_000);

test('once a headless host has begun to stop, /session new and /session switch are refused with why, creating no session and starting no switch', async () => {
  await withHost(async (host) => {
    host.signal('SIGTERM');
    await until(() => seen(host.dir, 'stopping-first'), 'the shutdown\'s stop of the framework it holds');
    host.command('/session new later', 'c2');
    await until(() => done(host, 'c2') !== undefined, 'the command\'s end');
    expect({ said: said(host, 'c2'), created: seen(host.dir, 'created-later'), making: seen(host.dir, 'making') })
      .toEqual({ said: ['The host is stopping, so it starts no session switch.'], created: false, making: false });
    host.command('/session switch first', 'c4');
    await until(() => done(host, 'c4') !== undefined, 'the second command\'s end');
    expect(said(host, 'c4')).toEqual(['The host is stopping, so it starts no session switch.']);
    writeFileSync(join(host.dir, 'stop-go'), '');
    expect(await host.exited).toBe(0);
  });
}, 60_000);
