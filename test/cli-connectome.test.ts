import { afterEach, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { bare, send } from '../src/cli/connectome.js';
import { openHost } from '../src/cli/host-socket.js';
import { writeInstallCommand } from '../src/cli/install-command.js';
import { installPaths } from '../src/update/contract.js';
import type { UpdateStatus } from '../src/web/update-text.js';

const REPO = resolve(import.meta.dir, '..');
const BIN = join(REPO, 'src', 'cli', 'connectome.ts');
const made: string[] = [];
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function install(inside = ''): { work: string; root: string; data: string } {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'cli-')));
  made.push(top);
  const work = join(top, inside);
  mkdirSync(work, { recursive: true });
  const root = join(work, 'connectome-host');
  const data = join(work, 'resident-state');
  mkdirSync(data);
  release(root, '0.14.1', REPO);
  symlinkSync(join('releases', '0.14.1'), join(root, 'current'));
  writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: data, extraState: [] }));
  return { work, root, data };
}

function release(root: string, version: string, packageDir: string): void {
  const scope = join(root, 'releases', version, 'node_modules', '@animalabs');
  mkdirSync(scope, { recursive: true });
  symlinkSync(packageDir, join(scope, 'connectome-host'));
}

function moveCurrent(root: string, version: string): void {
  unlinkSync(join(root, 'current'));
  symlinkSync(join('releases', version), join(root, 'current'));
}

function stubPackage(root: string, body: string | null): string {
  const dir = join(root, 'stub-package');
  mkdirSync(join(dir, 'src', 'cli'), { recursive: true });
  if (body !== null) writeFileSync(join(dir, 'src', 'cli', 'connectome.ts'), body);
  return dir;
}

async function run(file: string, args: string[], cwd: string, spawned?: (child: ChildProcess) => void):
  Promise<{ status: number | null; out: string; err: string }> {
  const child = spawn(file, args, {
    cwd, env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
  });
  spawned?.(child);
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const status = await new Promise<number | null>((done) => child.on('close', (code) => done(code)));
  return { status, out, err };
}

function printed(child: ChildProcess, text: string, stream: 'stdout' | 'stderr' = 'stdout'): Promise<void> {
  let out = '';
  return new Promise((done) => child[stream]!.on('data', (chunk) => {
    out += chunk;
    if (out.includes(text)) done();
  }));
}

function runningNow(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return state !== '' && !state.startsWith('Z');
}

type Handler = (message: Record<string, unknown>, reply: (event: Record<string, unknown>) => void, socket: Socket) => void;

const RESPONSES = new Set(['command-output', 'command-done', 'panel-response']);

function fakeHost(data: string, handle: Handler,
  ready: Record<string, unknown> = { pid: 4242, dataDir: data, recipe: 'Resident', turnWork: false, agent: 'resident' }):
  Promise<void> {
  const server = createServer((socket) => {
    let subscription = ['*'];
    const wanted = (type: string) => RESPONSES.has(type) ||
      subscription.some((each) => each === '*' || each === type || (each.endsWith('*') && type.startsWith(each.slice(0, -1))));
    let first: string[] | null = [];
    const reply = (event: Record<string, unknown>) => {
      if (!wanted(String(event.type))) return;
      const line = `${JSON.stringify({ ...event, ts: Date.now() })}\n`;
      if (first) first.push(line);
      else socket.write(line);
    };
    reply({ type: 'lifecycle', phase: 'ready', ...ready });
    handle({ type: 'connected' }, reply, socket);
    socket.write(first.join(''));
    first = null;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const message = JSON.parse(line);
        if (message.type === 'subscribe') subscription = message.events;
        handle(message, reply, socket);
      }
    });
    socket.on('error', () => {});
  });
  servers.push(server);
  return new Promise((listening) => server.listen(join(data, 'ipc.sock'), () => listening()));
}

test('the package\'s bin, in a directory with no install, says there\'s none', async () => {
  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'cli-empty-')));
  made.push(empty);
  for (const args of [[], ['send', 'hello'], ['update']]) {
    const ran = await run(BIN, args, empty);
    expect(ran.status).toBe(1);
    expect(ran.err).toContain('no connectome-host install here');
  }
  const wrong = await run(BIN, ['frobnicate'], empty);
  expect(wrong.status).toBe(2);
  expect(wrong.err).toContain('there\'s no command frobnicate');
  const help = await run(BIN, ['help'], empty);
  expect(help.status).toBe(0);
  expect(help.out).toContain('connectome send <text>');
});

test('the package\'s bin is connectome-host, at the dispatcher, executable', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  expect(pkg.bin).toEqual({ 'connectome-host': 'src/cli/connectome.ts' });
  expect(statSync(BIN).mode & 0o111).toBe(0o111);
  expect(readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env bun\n')).toBe(true);
});

test('an install\'s own command, run from anywhere, says which install it is, that its host isn\'t running, and how it starts', async () => {
  const { root, data } = install();
  const written = writeInstallCommand(root, '/usr/bin:/bin');
  expect(written.path).toBe(join(root, 'connectome'));
  expect(statSync(written.path).mode & 0o111).toBe(0o111);
  expect(written.pathLine).toBe(`export PATH=${root}:"$PATH"`);
  expect(writeInstallCommand(root, `/usr/bin:${root}:/bin`).pathLine).toBeNull();
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'cli-elsewhere-')));
  made.push(elsewhere);
  const ran = await run(written.path, [], elsewhere);
  expect(ran.status).toBe(0);
  expect(ran.out).toContain(`connectome-host install at ${root}`);
  expect(ran.out).toContain('Release: 0.14.1');
  expect(ran.out).toContain(`Its host doesn't answer: there's no socket at ${join(data, 'ipc.sock')}: no host is running, ` +
    `or one is still starting.\nIf no host is running, have its service start it with \`${process.execPath} ${join(root, 'start.js')}\`, followed by the arguments it gives the host now, then ask again.`);
  unlinkSync(join(root, 'current'));
  const none = await run(written.path, [], elsewhere);
  expect(none.status).toBe(1);
  expect(none.err).toContain(`${root} has no current release: run setup again in ${dirname(root)}, which says how ` +
    'to put it right.');
});

test('a PATH entry that leads to the root through a link counts as the root on PATH', () => {
  const { work, root } = install();
  symlinkSync(root, join(work, 'linked-root'));
  expect(writeInstallCommand(root, `/usr/bin:${join(work, 'linked-root')}`).pathLine).toBeNull();
});

test('an install\'s own command, or a link to it, runs the release its current names, with the words given', async () => {
  const { root } = install();
  const { path } = writeInstallCommand(root, '');
  release(root, '0.15.0', stubPackage(root, 'export async function main(root: string, argv: string[]) { ' +
    'console.log("0.15.0 answers", root, JSON.stringify(argv)); return 7; }\n'));
  moveCurrent(root, '0.15.0');
  const ran = await run(path, ['update', 'back keep'], root);
  expect(ran.status).toBe(7);
  expect(ran.out).toContain(`0.15.0 answers ${root} ["update","back keep"]`);
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'cli-link-')));
  made.push(elsewhere);
  symlinkSync(path, join(elsewhere, 'connectome'));
  const linked = await run(join(elsewhere, 'connectome'), ['send'], elsewhere);
  expect(linked.status).toBe(7);
  expect(linked.out).toContain(`0.15.0 answers ${root} ["send"]`);
});

test('an install whose current release has no command that loads says so, and how it still updates', async () => {
  const { root } = install('my resident');
  const { path } = writeInstallCommand(root, '');
  release(root, '0.13.0', stubPackage(root, null));
  moveCurrent(root, '0.13.0');
  const ran = await run(path, [], root);
  expect(ran.status).toBe(1);
  expect(ran.err).toContain('has no connectome command that loads');
  expect(ran.err).toContain('If its host still starts, its /update, in the TUI or the Web UI, updates it.');
  expect(ran.err).toContain(`If this release is broken, \`bun '${join(root, 'start.js')}' --go-back\` asks the next start`);
  expect(ran.err).not.toContain('    at ');
  rmSync(join(root, 'stub-package'), { recursive: true });
  stubPackage(root, 'export const notMain = 1;\n');
  const noMain = await run(path, [], root);
  expect(noMain.status).toBe(1);
  expect(noMain.err).toContain('it has no main to call');
  expect(noMain.err).not.toContain('    at ');
});

test('help lists the commands, and a word that isn\'t one is a usage error', async () => {
  const { root } = install();
  const { path } = writeInstallCommand(root, '');
  const help = await run(path, ['help'], root);
  expect(help.status).toBe(0);
  expect(help.out).toContain('\n  connectome\n');
  expect(help.out).toContain('connectome send <text>');
  expect(help.out).toContain('connectome update [check | install');
  expect(help.out).toContain('Words it doesn\'t take are a usage error, which exits 2 before any host is looked for. ' +
    'It exits 1 when the host answers no, such as an install with nothing newer offered or one that failed, a check ' +
    'that couldn\'t read the registry or a back that couldn\'t read the Go back offer: the host\'s words on stdout ' +
    'say why. When no host answers a word it takes, it asks nothing and exits 1, saying so on stderr. The exception ' +
    'is back when nothing listens on the host\'s socket: then back says whether a Go back is offered, and back keep ' +
    'or back restore asks the next start to go back.');
  expect(help.out).toContain('\n  connectome help\n');
  expect(help.out).toContain('Its own refusals go to stderr, and what the host answers to update to stdout, a refusal ' +
    'or a failure it answers included; an error that stops the host\'s update command goes to stderr. send prints only ' +
    'what the agent says on stdout, and its own notes on stderr.');
  for (const word of ['check, or no word', 'install', 'restart', 'restart wait', 'restart now', 'restart resume', 'back',
    'back keep', 'back restore']) {
    expect(help.out).toMatch(new RegExp(`\\n +${word}: `));
  }
  const wrong = await run(path, ['frobnicate'], root);
  expect(wrong.status).toBe(2);
  expect(wrong.err).toContain('there\'s no command frobnicate');
});

test('the package\'s bin, in a directory with an install, runs that install\'s own command', async () => {
  const { work, root } = install();
  writeInstallCommand(root, '');
  release(root, '0.15.0', stubPackage(root, 'export async function main(root: string, argv: string[]) { ' +
    'console.log("0.15.0 answers", JSON.stringify(argv)); return 7; }\n'));
  moveCurrent(root, '0.15.0');
  const ran = await run(BIN, ['update', 'check'], work);
  expect(ran.status).toBe(7);
  expect(ran.out).toContain('0.15.0 answers ["update","check"]');
  const help = await run(BIN, ['help'], work);
  expect(help.status).toBe(7);
  expect(help.out).toContain('0.15.0 answers ["help"]');
  rmSync(join(root, 'stub-package'), { recursive: true });
  stubPackage(root, 'export async function main() { process.kill(process.pid, "SIGKILL"); }\n');
  const killed = await run(BIN, ['update'], work);
  expect(killed.status).toBe(1);
  expect(killed.err).toContain(`${join(root, 'connectome')} ended on SIGKILL, so whether what it asked of the host ` +
    'happened isn\'t known here.');
});

test('the package\'s bin, by an install without its own command, says so and how setup writes it', async () => {
  const { work, root, data } = install();
  const setup = join(REPO, 'src', 'update', 'setup.ts');
  const ran = await run(BIN, ['send', 'hello'], work);
  expect(ran.status).toBe(1);
  expect(ran.err).toContain(`connectome: ${root} is an install without its own connectome command, which setup ` +
    `writes beside its start.js. Run setup again from ${work}: \`DATA_DIR=${data} bun ${setup}\`.`);
  writeFileSync(join(root, 'install.json'), '{}');
  const unread = await run(BIN, ['send', 'hello'], work);
  expect(unread.status).toBe(1);
  expect(unread.err).toContain(`Run setup again from ${work}, with the DATA_DIR the service gives the host: ` +
    `\`bun ${setup}\`.`);
});

const STATUS: UpdateStatus = {
  running: '0.14.1', install: true, checks: true,
  check: { at: '2026-10-26T06:30:00.000Z', ok: true, candidate: '0.15.0', costs: [], bunFloorUnmet: null, runningDeprecated: null },
  installing: null, lastInstall: null, installed: null, goBack: null, restart: null, operatorQuiesced: null,
  switchQuiesceLeft: false, lastSwitch: null, problems: [],
};

test('with its host running, bare says so and gives the update state as the host gives it, from its last reading', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  const asked: string[] = [];
  await fakeHost(data, (message, reply) => {
    asked.push(String(message.type));
    if (message.type === 'panel-request' && message.op === 'health') {
      reply({ type: 'panel-response', corrId: `${message.corrId}-other`, op: 'health', ok: false, error: 'not yours' });
      reply({ type: 'panel-response', corrId: message.corrId, op: 'health', ok: true, data: { update: STATUS } });
    }
  });
  const ran = await run(path, [], root);
  expect(ran.status).toBe(0);
  expect(ran.out).not.toContain('not yours');
  expect(ran.out).toContain('Its host is running: pid 4242, recipe Resident.');
  expect(ran.out).toContain('Its update state, as the running host gives it, from its last read of the registry at ' +
    '2026-10-26T06:30:00.000Z:\n  connectome-host 0.14.1.\n');
  expect(ran.out).toContain('\n  connectome-host 0.15.0 is out; this host runs 0.14.1.');
  expect(ran.out).toContain('To take it: connectome update install, then connectome update restart.');
  expect(ran.out).not.toContain('older release');
  expect(asked).not.toContain('text');
  expect(asked).not.toContain('command');
});

test('send delivers its text and prints what the agent says until it goes quiet', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  const sent: unknown[] = [];
  let child: ChildProcess | undefined;
  let runningAtIdle = false;
  await fakeHost(data, async (message, reply, socket) => {
    if (message.type !== 'text') return;
    sent.push(`${message.from}: ${message.content}`);
    reply({ type: 'lifecycle', phase: 'idle', texts: 0 });
    for (const said of ['Hello back.', 'Anything else?']) {
      reply({ type: 'inference:started', agentName: 'resident' });
      reply({ type: 'inference:completed', agentName: 'resident', durationMs: 5 });
      reply({ type: 'inference:speech', agentName: 'resident', content: said });
      await printed(child!, said);
    }
    await Bun.sleep(300);
    runningAtIdle = runningNow(child!.pid);
    socket.write(`${JSON.stringify({ type: 'lifecycle', phase: 'idle', texts: 1 })}\n` +
      `${JSON.stringify({ type: 'inference:speech', agentName: 'resident', content: 'After it went quiet.' })}\n`);
  });
  const ran = await run(path, ['send', 'hello', 'there'], root, (spawned) => { child = spawned; });
  expect(ran.status).toBe(0);
  expect(sent).toEqual(['console: hello there']);
  expect(ran.out).toBe('Hello back.\nAnything else?\n');
  expect(runningAtIdle).toBe(true);
});

test('send to a host with no turn work in flight sends at once', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  await fakeHost(data, (message, reply) => {
    if (message.type !== 'text') return;
    reply({ type: 'inference:started', agentName: 'resident' });
    reply({ type: 'inference:completed', agentName: 'resident', durationMs: 5 });
    reply({ type: 'inference:speech', agentName: 'resident', content: 'At once.' });
    reply({ type: 'lifecycle', phase: 'turn-work-done', texts: 1 });
  }, { pid: 4242, dataDir: data, recipe: 'Resident', turnWork: false, agent: 'resident' });
  const ran = await run(path, ['send', 'hello'], root);
  expect({ status: ran.status, out: ran.out, err: ran.err }).toEqual({
    status: 0, out: 'At once.\n', err: 'connectome: wrote the line to the host\'s socket; what the agent says in reply prints here.\n',
  });
});

test('send to a host in a turn waits for its turn work to end, prints nothing of that turn, and then sends', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  const order: string[] = [];
  await fakeHost(data, (message, reply) => {
    if (message.type === 'connected') {
      setTimeout(() => {
        reply({ type: 'inference:failed', agentName: 'resident', error: 'an earlier turn\'s failure' });
        reply({ type: 'inference:completed', agentName: 'resident', durationMs: 900 });
        reply({ type: 'inference:speech', agentName: 'resident', content: 'A channel reply.' });
        order.push('turn-work-done');
        reply({ type: 'lifecycle', phase: 'turn-work-done', texts: 0 });
      }, 300);
      return;
    }
    if (message.type !== 'text') return;
    order.push(`text: ${message.content}`);
    reply({ type: 'inference:started', agentName: 'resident' });
    reply({ type: 'inference:completed', agentName: 'resident', durationMs: 5 });
    reply({ type: 'inference:speech', agentName: 'resident', content: 'Your reply.' });
    reply({ type: 'lifecycle', phase: 'turn-work-done', texts: 1 });
  }, { pid: 4242, dataDir: data, recipe: 'Resident', turnWork: true, agent: 'resident' });
  const ran = await run(path, ['send', 'hello'], root);
  expect(ran.status).toBe(0);
  expect(order).toEqual(['turn-work-done', 'text: hello']);
  expect(ran.out).toBe('Your reply.\n');
  expect(ran.err).toBe('connectome: the agent is in a turn. This waits for it to end, then sends.\n' +
    'connectome: wrote the line to the host\'s socket; what the agent says in reply prints here.\n');
});

test('send to a host whose connection closes while it waits for the turn to end says nothing was sent', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  const asked: string[] = [];
  await fakeHost(data, (message, _reply, socket) => {
    asked.push(String(message.type));
    if (message.type === 'connected') setTimeout(() => socket.destroy(), 200);
  }, { pid: 4242, dataDir: data, recipe: 'Resident', turnWork: true, agent: 'resident' });
  const ran = await run(path, ['send', 'hello'], root);
  expect(ran.status).toBe(1);
  expect(asked).not.toContain('text');
  expect(ran.err).toContain('the connection closed before the agent\'s turn ended, so nothing was sent. The host ' +
    'stopping closes it, and so does another connectome command connecting. The host also closes it when output for ' +
    'it backs up and stays backed up for 5 minutes, as when this command is suspended.');
});

test('send that waits for the turn to end keeps waiting past its limit while the host keeps sending events, another agent\'s included', async () => {
  const { root, data } = install();
  let lastAt = Infinity;
  await fakeHost(data, (message, reply) => {
    if (message.type !== 'connected') return;
    let beats = 0;
    const beat = setInterval(() => {
      reply({ type: 'inference:tokens', agentName: 'spawn-scout-1', content: '.' });
      if (++beats === 5) {
        clearInterval(beat);
        lastAt = Date.now();
      }
    }, 100);
  }, { pid: 4242, dataDir: data, recipe: 'Resident', turnWork: true, agent: 'resident' });
  const err: string[] = [];
  const status = await send({ root, argv: ['hello'], out: () => {}, err: (line) => err.push(line) }, 300);
  expect(status).toBe(1);
  expect(Date.now() - lastAt).toBeGreaterThanOrEqual(290);
  expect(err.join('\n')).toContain('nothing was sent');
});

test('send follows only the agent ready names: another agent\'s start, failure and end are ignored', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  await fakeHost(data, (message, reply) => {
    if (message.type !== 'text') return;
    reply({ type: 'inference:started', agentName: 'spawn-scout-1' });
    reply({ type: 'inference:exhausted', agentName: 'spawn-scout-1', error: 'the scout gave up' });
    reply({ type: 'inference:aborted', agentName: 'spawn-scout-1', durationMs: 5, reason: 'cancelled' });
    reply({ type: 'lifecycle', phase: 'turn-work-done', texts: 1 });
  }, { pid: 4242, dataDir: data, recipe: 'Resident', turnWork: false, agent: 'resident' });
  const ran = await run(path, ['send', 'hello'], root);
  expect(ran.status).toBe(1);
  expect(ran.err).not.toContain('scout');
  expect(ran.err).toContain('the agent started no turn for it');
});

test('send whose turn gives up after its reply printed exits 0', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  await fakeHost(data, (message, reply) => {
    if (message.type !== 'text') return;
    reply({ type: 'inference:started', agentName: 'resident' });
    reply({ type: 'inference:completed', agentName: 'resident', durationMs: 5 });
    reply({ type: 'inference:speech', agentName: 'resident', content: 'Said it.' });
    reply({ type: 'inference:exhausted', agentName: 'resident', error: 'a later round gave up' });
    reply({ type: 'lifecycle', phase: 'turn-work-done', texts: 1 });
  }, { pid: 4242, dataDir: data, recipe: 'Resident', turnWork: false, agent: 'resident' });
  const ran = await run(path, ['send', 'hello'], root);
  expect({ status: ran.status, out: ran.out }).toEqual({ status: 0, out: 'Said it.\n' });
  expect(ran.err).toContain('connectome: resident\'s inference gave up: a later round gave up');
});

test('send to an older host, whose ready says nothing of turn work, sends nothing and says why', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  const asked: string[] = [];
  await fakeHost(data, (message) => { asked.push(String(message.type)); }, { pid: 4242, dataDir: data, recipe: 'Resident' });
  const ran = await run(path, ['send', 'hello'], root);
  expect(ran.status).toBe(1);
  expect(asked.filter((type) => type !== 'connected')).toEqual([]);
  expect(ran.err).toContain('connectome: nothing was sent: the running host is an older release than this command');
  expect(ran.err).toContain(`A host started with \`${process.execPath} ${join(root, 'start.js')}\` runs this release: have its service start it that way, followed by the arguments it gives the host now, and restart it. Then connectome send works.`);
});

test('bare, at an older host, says it is older and how a host on this release starts, and still gives its update state', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  await fakeHost(data, (message, reply) => {
    if (message.type === 'panel-request' && message.op === 'health') {
      reply({ type: 'panel-response', corrId: message.corrId, op: 'health', ok: true, data: { update: STATUS } });
    }
  }, { pid: 4242, dataDir: data, recipe: 'Resident' });
  const ran = await run(path, [], root);
  expect(ran.status).toBe(0);
  expect(ran.out).toContain('Its host is running: pid 4242, recipe Resident.\nThat host is an older release than this ' +
    'command, so connectome send and connectome update refuse it; its own /update, in the TUI or the Web UI, still ' +
    'works. A host started with ' +
    `\`${process.execPath} ${join(root, 'start.js')}\` runs this release: have its service start it that way, followed by the ` +
    'arguments it gives the host now, and restart it.\n');
  expect(ran.out).toContain('connectome-host 0.15.0 is out');
  expect(ran.out).toContain('To take it: /update install, then /update restart.');
  expect(ran.out).not.toContain('connectome update install');
});

test('bare, before the host has read the registry, says how to read it', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  await fakeHost(data, (message, reply) => {
    if (message.type === 'panel-request' && message.op === 'health') {
      reply({ type: 'panel-response', corrId: message.corrId, op: 'health', ok: true, data: { update: { ...STATUS, check: null } } });
    }
  });
  const ran = await run(path, [], root);
  expect(ran.status).toBe(0);
  expect(ran.out).toContain('Its update state, as the running host gives it:\n  connectome-host 0.14.1.\n' +
    '  The registry hasn\'t been read yet: connectome update check reads it.\n');
});

test('send isn\'t ended by an idle from before its line (texts 0), and ends at the idle that covers it', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  await fakeHost(data, (message, reply) => {
    if (message.type !== 'text') return;
    reply({ type: 'inference:started', agentName: 'resident' });
    reply({ type: 'lifecycle', phase: 'idle', texts: 0 });
    setTimeout(() => {
      reply({ type: 'inference:speech', agentName: 'resident', content: 'Covered.' });
      reply({ type: 'lifecycle', phase: 'idle', texts: 1 });
    }, 200);
  }, { pid: 4242, dataDir: data, recipe: 'Resident', turnWork: false, agent: 'resident' });
  const ran = await run(path, ['send', 'hello'], root);
  expect({ status: ran.status, out: ran.out }).toEqual({ status: 0, out: 'Covered.\n' });
});

test('send whose host keeps a script or subagent running after its turn prints the reply and ends at the turn work\'s end', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  await fakeHost(data, (message, reply) => {
    if (message.type !== 'text') return;
    reply({ type: 'inference:started', agentName: 'resident' });
    reply({ type: 'inference:completed', agentName: 'resident', durationMs: 5 });
    reply({ type: 'inference:speech', agentName: 'resident', content: 'Started the server.' });
    reply({ type: 'lifecycle', phase: 'turn-work-done', texts: 1 });
  }, { pid: 4242, dataDir: data, recipe: 'Resident', turnWork: false, agent: 'resident', idle: false });
  const ran = await run(path, ['send', 'hello'], root);
  expect({ status: ran.status, out: ran.out, err: ran.err }).toEqual({
    status: 0, out: 'Started the server.\n', err: 'connectome: wrote the line to the host\'s socket; what the agent says in reply prints here.\n',
  });
});

test('send isn\'t ended by the end of turn work that came before its line, and ends at the end that covers it', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  let child: ChildProcess | undefined;
  let runningAfterStale = false;
  await fakeHost(data, async (message, reply) => {
    if (message.type !== 'text') return;
    reply({ type: 'inference:started', agentName: 'resident' });
    reply({ type: 'lifecycle', phase: 'turn-work-done', texts: 0 });
    await Bun.sleep(300);
    runningAfterStale = runningNow(child!.pid);
    reply({ type: 'inference:started', agentName: 'resident' });
    reply({ type: 'inference:completed', agentName: 'resident', durationMs: 5 });
    reply({ type: 'inference:speech', agentName: 'resident', content: 'Yours.' });
    reply({ type: 'lifecycle', phase: 'turn-work-done', texts: 1 });
  }, { pid: 4242, dataDir: data, recipe: 'Resident', turnWork: false, agent: 'resident' });
  const ran = await run(path, ['send', 'hello'], root, (spawned) => { child = spawned; });
  expect(runningAfterStale).toBe(true);
  expect({ status: ran.status, out: ran.out }).toEqual({ status: 0, out: 'Yours.\n' });
});

test('send whose line the agent takes no turn for says so and exits 1', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  await fakeHost(data, (message, reply) => {
    if (message.type !== 'text') return;
    reply({ type: 'lifecycle', phase: 'turn-work-done', texts: 1 });
  }, { pid: 4242, dataDir: data, recipe: 'Resident', turnWork: false, agent: 'resident' });
  const ran = await run(path, ['send', 'hello'], root);
  expect(ran.status).toBe(1);
  expect(ran.err).toContain('the host took the message, and the agent started no turn for it before its turn work ' +
    'ended. A wake gate may have declined it, or be holding it to batch it with others. If it\'s held, the agent ' +
    'can answer it later. Sending it again won\'t undo a decline, and could deliver it twice.');
});

test('send to a host that replays its boot to it, as to a first client, takes none of that boot\'s turn for its line\'s', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  await fakeHost(data, (message, reply) => {
    if (message.type === 'connected') {
      reply({ type: 'inference:started', agentName: 'resident', replay: true });
      reply({ type: 'inference:failed', agentName: 'resident', error: 'HTTP 500 at boot', replay: true });
      reply({ type: 'inference:aborted', agentName: 'resident', reason: 'stopped at boot', replay: true });
      return;
    }
    if (message.type !== 'text') return;
    reply({ type: 'lifecycle', phase: 'turn-work-done', texts: 1 });
  });
  const ran = await run(path, ['send', 'hello'], root);
  expect(ran.status).toBe(1);
  expect(ran.err).not.toContain('at boot');
  expect(ran.err).toContain('the host took the message, and the agent started no turn for it before its turn work ended.');
});

test('send to a host already in a turn hears an end of it that comes right behind ready, and sends', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  let texts = 0;
  await fakeHost(data, (message, reply) => {
    if (message.type === 'connected') reply({ type: 'lifecycle', phase: 'turn-work-done', texts: 0 });
    if (message.type !== 'text') return;
    texts += 1;
    reply({ type: 'inference:started', agentName: 'resident' });
    reply({ type: 'inference:speech', agentName: 'resident', content: 'Heard.' });
    setTimeout(() => reply({ type: 'lifecycle', phase: 'turn-work-done', texts: 1 }), 200);
  }, { pid: 4242, dataDir: data, recipe: 'Resident', turnWork: true, agent: 'resident' });
  const ran = await run(path, ['send', 'hello'], root);
  expect({ status: ran.status, out: ran.out }).toEqual({ status: 0, out: 'Heard.\n' });
  expect(texts).toBe(1);
});

test('update asks an older host, whose ready says nothing of turn work, nothing, and says why', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  const asked: string[] = [];
  await fakeHost(data, (message) => { asked.push(String(message.type)); }, { pid: 4242, dataDir: data, recipe: 'Resident' });
  const ran = await run(path, ['update', 'check'], root);
  expect(ran.status).toBe(1);
  expect(asked.filter((type) => type !== 'connected' && type !== 'subscribe')).toEqual([]);
  expect(ran.err).toContain('the running host is an older release');
  expect(ran.err).toContain(`A host started with \`${process.execPath} ${join(root, 'start.js')}\` runs this release: have its service start it that way, followed by the arguments it gives the host now, and restart it. Then connectome update works.`);
});

test('send that waits on the agent\'s turn past its limit sends nothing and says so', async () => {
  const { root, data } = install();
  const asked: string[] = [];
  await fakeHost(data, (message) => { asked.push(String(message.type)); }, { pid: 4242, dataDir: data, recipe: 'Resident', turnWork: true, agent: 'resident' });
  const err: string[] = [];
  const status = await send({ root, argv: ['hello'], out: () => {}, err: (line) => err.push(line) }, 300);
  expect(status).toBe(1);
  expect(asked).not.toContain('text');
  expect(err.join('\n')).toContain('while the agent was in a turn, so this stopped waiting, and nothing was sent.');
});

test('send isn\'t ended by the end of a turn from before its text, and prints its own turn\'s reply', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  await fakeHost(data, (message, reply) => {
    if (message.type !== 'text') return;
    reply({ type: 'inference:completed', agentName: 'resident', durationMs: 900 });
    reply({ type: 'lifecycle', phase: 'idle', texts: 0 });
    setTimeout(() => {
      reply({ type: 'inference:started', agentName: 'resident' });
      reply({ type: 'inference:completed', agentName: 'resident', durationMs: 5 });
      reply({ type: 'inference:speech', agentName: 'resident', content: 'Your reply.' });
      reply({ type: 'lifecycle', phase: 'idle', texts: 1 });
    }, 200);
  });
  const ran = await run(path, ['send', 'hello'], root);
  expect(ran.status).toBe(0);
  expect(ran.out).toBe('Your reply.\n');
});

test('send whose agent\'s turn ends without saying anything here says so on stderr and exits 0', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  await fakeHost(data, (message, reply) => {
    if (message.type !== 'text') return;
    reply({ type: 'inference:started', agentName: 'resident' });
    reply({ type: 'inference:completed', agentName: 'resident', durationMs: 5 });
    reply({ type: 'lifecycle', phase: 'turn-work-done', texts: 1 });
  });
  const ran = await run(path, ['send', 'hello'], root);
  expect(ran.status).toBe(0);
  expect(ran.out).toBe('');
  expect(ran.err).toContain('the agent\'s turn ended without saying anything here');
});

test('send whose agent fails without a reply says so and exits 1', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  await fakeHost(data, (message, reply) => {
    if (message.type !== 'text') return;
    reply({ type: 'inference:started', agentName: 'resident' });
    reply({ type: 'inference:exhausted', agentName: 'resident', error: 'HTTP 529 overloaded' });
    reply({ type: 'lifecycle', phase: 'idle', texts: 1 });
  });
  const ran = await run(path, ['send', 'hello'], root);
  expect(ran.status).toBe(1);
  expect(ran.out).toBe('');
  expect(ran.err).toContain('resident\'s inference gave up: HTTP 529 overloaded');
  expect(ran.err).toContain('the agent\'s turn ended without a reply');
});

test('send whose turn is stopped after a failed attempt ends at the quiet that follows, saying why, and exits 1', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  let child: ChildProcess | undefined;
  let runningAtIdle = false;
  await fakeHost(data, async (message, reply) => {
    if (message.type !== 'text') return;
    reply({ type: 'inference:started', agentName: 'resident' });
    reply({ type: 'inference:failed', agentName: 'resident', error: 'HTTP 500' });
    reply({ type: 'inference:aborted', agentName: 'resident', durationMs: 5, reason: 'shutdown' });
    await printed(child!, 'turn was stopped', 'stderr');
    await Bun.sleep(300);
    runningAtIdle = runningNow(child!.pid);
    reply({ type: 'lifecycle', phase: 'idle', texts: 1 });
  });
  const ran = await run(path, ['send', 'hello'], root, (spawned) => { child = spawned; });
  expect(runningAtIdle).toBe(true);
  expect(ran.status).toBe(1);
  expect(ran.out).toBe('');
  expect(ran.err).toContain('resident\'s inference failed: HTTP 500');
  expect(ran.err).toContain('resident\'s turn was stopped: shutdown');
  expect(ran.err).toContain('the agent\'s turn ended without a reply');
});

test('send whose agent fails an attempt it retries prints the retry\'s reply, ends at the quiet after it, and exits 0', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  await fakeHost(data, (message, reply) => {
    if (message.type !== 'text') return;
    reply({ type: 'inference:started', agentName: 'resident' });
    reply({ type: 'inference:failed', agentName: 'resident', error: 'HTTP 500' });
    setTimeout(() => {
      reply({ type: 'inference:started', agentName: 'resident' });
      reply({ type: 'inference:completed', agentName: 'resident', durationMs: 5 });
      reply({ type: 'inference:speech', agentName: 'resident', content: 'Here after a retry.' });
      reply({ type: 'lifecycle', phase: 'idle', texts: 1 });
    }, 200);
  });
  const ran = await run(path, ['send', 'hello'], root);
  expect(ran.status).toBe(0);
  expect(ran.out).toBe('Here after a retry.\n');
  expect(ran.err).toContain('resident\'s inference failed: HTTP 500');
});

test('send whose agent fails an attempt and whose retry says nothing here reports the failure, says the turn said nothing here, and exits 0', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  await fakeHost(data, (message, reply) => {
    if (message.type !== 'text') return;
    reply({ type: 'inference:started', agentName: 'resident' });
    reply({ type: 'inference:failed', agentName: 'resident', error: 'HTTP 500' });
    reply({ type: 'inference:started', agentName: 'resident' });
    reply({ type: 'inference:completed', agentName: 'resident', durationMs: 5 });
    reply({ type: 'lifecycle', phase: 'turn-work-done', texts: 1 });
  });
  const ran = await run(path, ['send', 'hello'], root);
  expect(ran.status).toBe(0);
  expect(ran.out).toBe('');
  expect(ran.err).toContain('resident\'s inference failed: HTTP 500');
  expect(ran.err).not.toContain('turn ended without a reply');
  expect(ran.err).toContain('the agent\'s turn ended without saying anything here');
});

test('send whose agent fails an attempt and then gives up ends at the quiet that follows and exits 1', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  let child: ChildProcess | undefined;
  let runningAtIdle = false;
  await fakeHost(data, async (message, reply) => {
    if (message.type !== 'text') return;
    reply({ type: 'inference:started', agentName: 'resident' });
    reply({ type: 'inference:failed', agentName: 'resident', error: 'HTTP 529 overloaded' });
    reply({ type: 'inference:exhausted', agentName: 'resident', error: 'HTTP 529 overloaded' });
    await printed(child!, 'gave up', 'stderr');
    await Bun.sleep(300);
    runningAtIdle = runningNow(child!.pid);
    reply({ type: 'lifecycle', phase: 'idle', texts: 1 });
  });
  const ran = await run(path, ['send', 'hello'], root, (spawned) => { child = spawned; });
  expect(runningAtIdle).toBe(true);
  expect(ran.status).toBe(1);
  expect(ran.err).toContain('resident\'s inference gave up: HTTP 529 overloaded');
});

test('send stops waiting once nothing has come from the host for its limit, and says the agent may still be working', async () => {
  const { root, data } = install();
  let beats = 0;
  await fakeHost(data, (message, reply) => {
    if (message.type !== 'text') return;
    reply({ type: 'inference:started', agentName: 'resident' });
    const beat = setInterval(() => {
      reply({ type: 'inference:tokens', agentName: 'resident', content: '.' });
      if (++beats === 5) {
        clearInterval(beat);
        lastAt = Date.now();
      }
    }, 100);
  });
  let lastAt = Infinity;
  const err: string[] = [];
  const status = await send({ root, argv: ['hello'], out: () => {}, err: (line) => err.push(line) }, 600);
  const endedAt = Date.now();
  expect(status).toBe(1);
  expect(beats).toBe(5);
  expect(endedAt - lastAt).toBeGreaterThanOrEqual(590);
  expect(err.join('\n')).toContain('nothing came from the host for 0.01 minutes, and it hadn\'t said the agent\'s turn ' +
    'ended, so this stopped waiting. The message was sent, and the agent may still be working on it.');
});

test('a client whose connection the host has ended gets false from send', async () => {
  const { root, data } = install();
  await fakeHost(data, (message, _reply, socket) => {
    if (message.type === 'connected') setTimeout(() => socket.end(), 0);
  });
  const host = await openHost(root);
  if ('reason' in host) throw new Error(host.reason);
  await host.closed;
  expect(host.send({ type: 'text', content: 'late' })).toBe(false);
});

test('send with no host answering sends nothing, starts nothing, and says so', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  const started = join(root, 'started');
  writeFileSync(join(root, 'start.js'), `require('node:fs').writeFileSync(${JSON.stringify(started)}, '');\n`);
  const ran = await run(path, ['send', 'hello'], root);
  expect(ran.status).toBe(1);
  expect(ran.err).toContain(`nothing was sent: there's no socket at ${join(data, 'ipc.sock')}`);
  expect(ran.err).toContain(`If no host is running, have its service start it with \`${process.execPath} ${join(root, 'start.js')}\`, followed by the arguments it gives the host now, then send again.`);
  expect(ran.err).not.toContain('wrote the line');
  expect(existsSync(started)).toBe(false);
  const empty = await run(path, ['send', ' '], root);
  expect({ status: empty.status, err: empty.err }).toEqual({ status: 2, err: 'connectome: usage: connectome send <text>\n' });
  expect(existsSync(join(data, 'ipc.sock'))).toBe(false);
  expect(existsSync(join(data, 'headless.pid'))).toBe(false);
});

test('send whose connection closes before the agent goes quiet says what was and wasn\'t seen', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  let speak = true;
  let start = false;
  await fakeHost(data, (message, reply, socket) => {
    if (message.type !== 'text') return;
    if (start) reply({ type: 'inference:started', agentName: 'resident' });
    if (speak) reply({ type: 'inference:speech', agentName: 'resident', content: 'Starting on it.' });
    socket.end();
  });
  const ran = await run(path, ['send', 'hello'], root);
  expect(ran.status).toBe(1);
  expect(ran.out).toBe('Starting on it.\n');
  expect(ran.err).toContain('the connection closed before the agent\'s turn ended, so the rest of its reply wasn\'t seen ' +
    'here. The host stopping closes it, and so does another connectome command connecting. The host also closes it ' +
    'when output for it backs up and stays backed up for 5 minutes, as when this command is suspended.');
  speak = false;
  const silent = await run(path, ['send', 'hello'], root);
  expect(silent.status).toBe(1);
  expect(silent.out).toBe('');
  expect(silent.err).toContain('the connection closed before any reply. If the host hadn\'t read the message yet, it never reached');
  expect(silent.err).toContain('the host drops what it hadn\'t read. The host also closes it when output for it ' +
    'backs up and stays backed up for 5 minutes, as when this command is suspended.');
  start = true;
  const begun = await run(path, ['send', 'hello'], root);
  expect(begun.status).toBe(1);
  expect(begun.err).toContain('the connection closed before the agent\'s turn ended, so its reply wasn\'t seen here');
  expect(begun.err).not.toContain('never reached');
});

test('update runs /update with the same words in the host and prints its answer until it ends', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  const asked: string[] = [];
  let child: ChildProcess | undefined;
  let runningAtDone = false;
  await fakeHost(data, async (message, reply, socket) => {
    if (message.type !== 'command') return;
    asked.push(String(message.command));
    if (typeof message.corrId !== 'string') {
      socket.end();
      return;
    }
    reply({ type: 'command-output', text: 'Reading the registry, then installing…', style: 'system', corrId: message.corrId });
    reply({ type: 'command-output', text: 'Another client\'s line.', style: 'system', corrId: 'someone-else' });
    reply({ type: 'command-output', text: 'See /update-log and /updates.', style: 'system', corrId: message.corrId });
    reply({ type: 'command-output', text: 'Installed 0.15.0: /update restart switches to it.', style: 'system', corrId: message.corrId });
    if (String(message.command) !== '/update install') {
      reply({ type: 'command-done', corrId: message.corrId });
      return;
    }
    await printed(child!, 'restart switches to it.');
    await Bun.sleep(300);
    runningAtDone = runningNow(child!.pid);
    reply({ type: 'command-done', corrId: message.corrId });
  });
  const ran = await run(path, ['update', 'install'], root, (spawned) => { child = spawned; });
  expect(ran.status).toBe(0);
  expect(asked).toEqual(['/update install']);
  expect(ran.out).toBe('Reading the registry, then installing…\nSee /update-log and /updates.\n' +
    'Installed 0.15.0: connectome update restart switches to it.\n');
  expect(runningAtDone).toBe(true);
  const checked = await run(path, ['update', 'check'], root);
  expect(checked.status).toBe(0);
  expect(asked.at(-1)).toBe('/update check');
});

test('update the host answers no to prints its words and exits 1', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  const nothing = 'No release newer than 0.14.1 is offered, so nothing was installed: Update offers final releases ' +
    'that aren\'t deprecated.';
  await fakeHost(data, (message, reply) => {
    if (message.type !== 'command') return;
    reply({ type: 'command-output', text: 'Reading the registry, then installing…', style: 'system', corrId: message.corrId });
    reply({ type: 'command-output', text: nothing, style: 'system', corrId: message.corrId });
    reply({ type: 'command-done', corrId: message.corrId, refused: true });
  });
  const ran = await run(path, ['update', 'install'], root);
  expect(ran.status).toBe(1);
  expect(ran.out).toBe(`Reading the registry, then installing…\n${nothing}\n`);
  expect(ran.err).toBe('');
});

test('update whose command fails in the host says so and exits 1', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  await fakeHost(data, (message, reply) => {
    if (message.type === 'command') {
      reply({ type: 'command-done', corrId: message.corrId, error: 'registry unreachable: try /update again' });
    }
  });
  const ran = await run(path, ['update'], root);
  expect(ran.status).toBe(1);
  expect(ran.err).toContain('registry unreachable: try connectome update again');
  expect(ran.out).toBe('');
});

test('update whose connection closes before its answer ends exits 1 and says how it ended isn\'t known', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  await fakeHost(data, (message, reply, socket) => {
    if (message.type !== 'command') return;
    reply({ type: 'command-output', text: 'Restarting unless refused…', style: 'system', corrId: message.corrId });
    socket.end();
  });
  const ran = await run(path, ['update', 'restart'], root);
  expect(ran.status).toBe(1);
  expect(ran.out).toBe('Restarting unless refused…\n');
  expect(ran.err).toContain('closed the connection before its answer ended, so how it ended isn\'t known');
});

test('update with words /update doesn\'t take is a usage error, and with no host answering nothing is asked', async () => {
  const { root } = install();
  const { path } = writeInstallCommand(root, '');
  for (const words of [['sideways'], ['check', 'extra'], ['install', 'now'], ['restart', 'now', 'please'],
    ['back', 'later'], ['back', 'keep', 'soon']]) {
    const wrong = await run(path, ['update', ...words], root);
    expect(wrong.status).toBe(2);
    expect(wrong.err).toBe('connectome: usage: connectome update [check | install | restart [wait | now | resume | ' +
      '<version>] | back [(keep | restore) [<version>]]]\n');
  }
  const ran = await run(path, ['update', 'install'], root);
  expect(ran.status).toBe(1);
  expect(ran.err).toContain('no host answers');
  expect(ran.err).toContain(`If no host is running, have its service start it with \`${process.execPath} ${join(root, 'start.js')}\`, followed by the arguments it gives the host now, then ask again.`);
});

test('update with a word it doesn\'t take is a usage error before any host is looked for, a listening one included', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  let connections = 0;
  await fakeHost(data, (message) => {
    if (message.type === 'connected') connections += 1;
  });
  const wrong = await run(path, ['update', 'sideways'], root);
  expect(wrong.status).toBe(2);
  expect(wrong.err).toStartWith('connectome: usage: connectome update ');
  expect(connections).toBe(0);
});

function offerGoBack(root: string, data: string): void {
  release(root, '0.13.0', REPO);
  mkdirSync(join(root, 'copy', '0-data'), { recursive: true });
  writeFileSync(join(root, 'copy', 'copy.json'), JSON.stringify({
    v: 1, from: '0.13.0', at: '2026-10-25T00:00:00.000Z', items: [{ path: data, name: '0-data' }],
  }));
}

test('update back with no host answering, where the copy can\'t be read, says so without a stack trace', async () => {
  const { root } = install();
  const { path } = writeInstallCommand(root, '');
  mkdirSync(join(root, 'copy'));
  writeFileSync(join(root, 'copy', 'copy.json'), '{"v": 1, "from": "0.13.0"}');
  const ran = await run(path, ['update', 'back'], root);
  expect(ran.status).toBe(1);
  expect(ran.err).toContain('whether a Go back is offered can\'t be told');
  expect(ran.err).not.toContain('    at ');
});

test('update back with no host answering asks the next start to go back, as start.js --go-back does', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  const none = await run(path, ['update', 'back', 'keep'], root);
  expect(none.status).toBe(1);
  expect(none.err).toContain('no Go back is offered');
  offerGoBack(root, data);
  const shown = await run(path, ['update', 'back'], root);
  expect({ status: shown.status, err: shown.err }).toEqual({ status: 0, err: '' });
  expect(shown.out).toContain('Going back to 0.13.0 is offered');
  expect(shown.out).toContain('- connectome update back keep 0.13.0: ');
  expect(shown.out).toContain('- connectome update back restore 0.13.0: ');
  expect(existsSync(join(root, 'mark.json'))).toBe(false);
  const wrong = await run(path, ['update', 'back', 'restore', '0.12.0'], root);
  expect(wrong.status).toBe(1);
  expect(wrong.err).toContain('the Go back offered is to 0.13.0, not 0.12.0');
  expect(existsSync(join(root, 'mark.json'))).toBe(false);
  const asked = await run(path, ['update', 'back', 'keep', '0.13.0'], root);
  expect(asked.status).toBe(0);
  expect(asked.err).toContain('The next start goes back to 0.13.0, keeping the newer data');
  const mark = JSON.parse(readFileSync(join(root, 'mark.json'), 'utf8'));
  expect(mark).toMatchObject({ to: '0.13.0', why: 'go-back', keepData: true });
  const restored = await run(path, ['update', 'back', 'restore', '0.13.0'], root);
  expect(restored.status).toBe(0);
  const restoring = JSON.parse(readFileSync(join(root, 'mark.json'), 'utf8'));
  expect(restoring).toMatchObject({ to: '0.13.0', why: 'go-back' });
  expect(restoring.keepData ?? false).toBe(false);
  unlinkSync(join(root, 'current'));
  const noCurrent = await run(path, ['update', 'back', 'keep'], root);
  expect(noCurrent.status).toBe(1);
  expect(noCurrent.err).toContain('has no current release');
});

test('update back for a release other than the offer\'s is refused at once, with no wait for a held lock', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  offerGoBack(root, data);
  writeFileSync(installPaths(root).lock, JSON.stringify({ v: 1, pid: process.pid, bootId: null, at: new Date().toISOString() }));
  const ran = await run(path, ['update', 'back', 'keep', '0.12.0'], root);
  expect(ran.status).toBe(1);
  expect(ran.err).toContain('the Go back offered is to 0.13.0, not 0.12.0');
  expect(ran.err).not.toContain('Waiting up to');
  expect(existsSync(join(root, 'mark.json'))).toBe(false);
});

test('update back for the offer\'s release is refused when the offer moves while it waits for the lock', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  offerGoBack(root, data);
  release(root, '0.12.0', REPO);
  const holder = spawn('sleep', ['30']);
  writeFileSync(installPaths(root).lock, JSON.stringify({ v: 1, pid: holder.pid, bootId: null, at: new Date().toISOString() }));
  try {
    const ran = await run(path, ['update', 'back', 'keep', '0.13.0'], root, async (child) => {
      let err = '';
      await new Promise<void>((waiting) => child.stderr!.on('data', (chunk) => {
        err += chunk;
        if (err.includes('Waiting up to')) waiting();
      }));
      const label = join(root, 'copy', 'copy.json');
      writeFileSync(label, JSON.stringify({ ...JSON.parse(readFileSync(label, 'utf8')), from: '0.12.0' }));
      holder.kill('SIGKILL');
    });
    expect(ran.status).toBe(1);
    expect(ran.err).toContain('the Go back offered is to 0.12.0, not 0.13.0');
    expect(existsSync(join(root, 'mark.json'))).toBe(false);
  } finally {
    holder.kill('SIGKILL');
  }
});

test.skipIf(process.getuid?.() === 0)('update back with a socket this user can\'t reach asks for nothing and says why', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  offerGoBack(root, data);
  await fakeHost(data, () => {});
  chmodSync(data, 0o000);
  try {
    for (const words of [['back'], ['back', 'keep', '0.13.0'], ['back', 'restore']]) {
      const ran = await run(path, ['update', ...words], root);
      expect(ran.status, words.join(' ')).toBe(1);
      expect(ran.err, words.join(' ')).toContain(`can't connect to the socket ${join(data, 'ipc.sock')}`);
      expect(ran.out, words.join(' ')).not.toContain('is offered');
    }
  } finally {
    chmodSync(data, 0o755);
  }
  expect(existsSync(join(root, 'mark.json'))).toBe(false);
});

test.skipIf(process.getuid?.() === 0)('a socket this user can\'t reach is named as that, not as no host running', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  await fakeHost(data, () => {});
  chmodSync(data, 0o000);
  try {
    const ran = await run(path, ['send', 'hello'], root);
    expect(ran.status).toBe(1);
    expect(ran.err).toContain(`can't connect to the socket ${join(data, 'ipc.sock')}`);
    expect(ran.err).not.toContain('no host is running');
    expect(ran.err).not.toContain('start it');
  } finally {
    chmodSync(data, 0o755);
  }
});

test('a socket left by a host that ended, and one that closes before ready, are each named as that', async () => {
  const { root, data } = install();
  const { path } = writeInstallCommand(root, '');
  const sock = join(data, 'ipc.sock');
  const left = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(sock)})`]);
  while (!existsSync(sock)) await Bun.sleep(10);
  left.kill('SIGKILL');
  await new Promise((done) => left.on('close', done));
  const refused = await run(path, ['send', 'hello'], root);
  expect(refused.status).toBe(1);
  expect(refused.err).toContain(`nothing answers on the socket ${sock}: a host that ended left it, or one hasn't started answering`);
  unlinkSync(sock);
  const server = createServer((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((listening) => server.listen(sock, () => listening()));
  const closed = await run(path, ['send', 'hello'], root);
  expect(closed.status).toBe(1);
  expect(closed.err).toContain(`the socket ${sock} closed before a host said it was ready`);
});

test('an install record without an absolute data directory path says to write one, and one with none, to run setup again', async () => {
  const { root } = install();
  const { path } = writeInstallCommand(root, '');
  writeFileSync(join(root, 'install.json'), JSON.stringify({ v: 1, dataDir: 'data', extraState: [] }));
  const relative = await run(path, ['send', 'hello'], root);
  expect(relative.status).toBe(1);
  expect(relative.err).toContain('not an absolute path');
  expect(relative.err).toContain('Write the data directory\'s absolute path there as dataDir, as setup writes it: setup keeps the dataDir it finds.');
  const said: string[] = [];
  expect(await bare({ root, argv: [], out: (line) => said.push(line), err: (line) => said.push(line) })).toBe(1);
  expect(said.join('\n')).toContain('not an absolute path');
  unlinkSync(join(root, 'install.json'));
  const missing = await run(path, ['send', 'hello'], root);
  expect(missing.status).toBe(1);
  expect(missing.err).toContain('Run setup again');
  expect(missing.err).not.toContain('    at ');
});

test('bare waits longer than a moment for the health request by default', async () => {
  const { root, data } = install();
  await fakeHost(data, (message, reply) => {
    if (message.type !== 'panel-request' || message.op !== 'health') return;
    setTimeout(() => reply({ type: 'panel-response', corrId: message.corrId, op: 'health', ok: true, data: { update: STATUS } }), 400);
  });
  const out: string[] = [];
  const status = await bare({ root, argv: [], out: (line) => out.push(line), err: (line) => out.push(line) });
  expect(status).toBe(0);
  expect(out.join('\n')).not.toContain('Its update state couldn\'t be read');
  expect(out.join('\n')).toContain('Its update state, as the running host gives it, from its last read of the registry');
});

test('bare whose host doesn\'t answer the health request gives up and says so', async () => {
  const { root, data } = install();
  const asked: string[] = [];
  let askedAt = Infinity;
  await fakeHost(data, (message) => {
    asked.push(`${message.type}:${message.op ?? ''}`);
    if (message.op === 'health') askedAt = Date.now();
  });
  const out: string[] = [];
  const status = await bare({ root, argv: [], out: (line) => out.push(line), err: (line) => out.push(line) }, 300);
  const endedAt = Date.now();
  expect(endedAt - askedAt).toBeGreaterThanOrEqual(200);
  expect(asked).toContain('panel-request:health');
  expect(status).toBe(0);
  expect(out.join('\n')).toContain('Its host is running: pid 4242');
  expect(out.join('\n')).toContain('Its update state couldn\'t be read: no answer came within 0.3 s');
});
