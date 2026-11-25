import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectWhenAccepting } from './ipc-connect.js';

const REPO = join(import.meta.dir, '..');
const INDEX = join(REPO, 'src', 'index.ts');
const PROBE = join(import.meta.dir, 'probe-subscription-gc.preload.ts');

const RECIPE = {
  name: 'gc',
  description: 'gc',
  agent: { name: 'agent', provider: 'mock', systemPrompt: 'Never asked.' },
  modules: {
    subagents: false, lessons: false, retrieval: false, wake: false, workspace: false, webui: false,
    subscriptionGc: { serverId: 'zulipp' },
  },
  mcpServers: { zulip: { command: 'false' } },
};

const startLine = '[agent-settings] modules.subscriptionGc.serverId is "zulipp", and this host has no server "zulipp" ' +
  '(its servers: "zulip"), so subscription cleanup closes no channel. Name the server it is to watch, or set ' +
  'modules.subscriptionGc to false.';
const inactiveLine = '[agent-settings] modules.subscriptionGc watches server "zulipp", which modules.subscriptionGc.serverId ' +
  'names, and this host has no server "zulipp", so it closes no channel. Ambient traffic from server "zulip" isn\'t counted. ' +
  'modules.subscriptionGc.serverId names the one server it watches, and modules.subscriptionGc: false turns it off.';
const settingsWarning = 'Idle cleanup watches server "zulipp", which this host doesn\'t have, so these limits are stored and ' +
  "not in force, and no channel auto-closes. Only the host's operator can change the server " +
  '(modules.subscriptionGc.serverId in the recipe): tell them if these limits matter to you.';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gc-host-'));
  writeFileSync(join(root, 'recipe.json'), JSON.stringify(RECIPE));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function until(check: () => boolean, label: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(20);
  }
}

// Under Bun, console lines bypass the headless runtime's redirect and reach
// the child's own stdout and stderr (headless.ts). headless.log takes the
// warnings queued before the runtime started.
test('a real start names the missing server once, a session switch does not again, and each start\'s module knows the host\'s servers', async () => {
  const data = join(root, 'data');
  const log = join(data, 'headless.log');
  const child = Bun.spawn([process.execPath, '--no-env-file', '--preload', PROBE, INDEX, join(root, 'recipe.json'), '--headless'], {
    cwd: root,
    env: {
      PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: root, DATA_DIR: data, CONNECTOME_UPDATE_CHECK: '0',
      GC_PROBE_SERVER: 'zulip',
      ...(process.env.TMPDIR !== undefined ? { TMPDIR: process.env.TMPDIR } : {}),
    },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
  });
  const streams = { out: '', err: '' };
  const decoder = new TextDecoder();
  const read = async (stream: ReadableStream<Uint8Array>, into: 'out' | 'err') => {
    for await (const chunk of stream) streams[into] += decoder.decode(chunk, { stream: true });
  };
  const reading = Promise.all([read(child.stdout, 'out'), read(child.stderr, 'err')]);
  const probes = () => streams.out.split('\n').filter((line) => line.startsWith('GC_PROBED=')).length;
  try {
    await until(() => existsSync(join(data, 'ipc.sock')) || child.exitCode !== null, 'socket');
    expect(child.exitCode).toBeNull();
    await until(() => probes() === 1, 'the first start\'s probe');
    const socket = await connectWhenAccepting(join(data, 'ipc.sock'));
    const events: Array<Record<string, unknown>> = [];
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
    socket.write(`${JSON.stringify({ type: 'subscribe', events: [] })}\n`);
    socket.write(`${JSON.stringify({ type: 'command', corrId: 'n1', command: '/session new second' })}\n`);
    await until(() => events.some((event) => event.type === 'command-done' && event.corrId === 'n1'), 'the switch');
    await until(() => probes() === 2, 'the second start\'s probe');
    socket.destroy();
  } finally {
    child.kill('SIGTERM');
    await child.exited;
    await reading;
  }
  const out = streams.out.split('\n');
  const err = streams.err.split('\n');
  const logged = readFileSync(log, 'utf8').split('\n');
  expect(err.filter((line) => line === startLine)).toHaveLength(1);
  expect(logged.filter((line) => line.includes(startLine))).toHaveLength(1);
  expect(logged.find((line) => line.includes(startLine))).toEndWith(`] warning: ${startLine}`);
  expect(out.filter((line) => line.startsWith('GC_PROBED='))).toEqual(['GC_PROBED=yes', 'GC_PROBED=yes']);
  const settings = out.filter((line) => line.startsWith('GC_SETTINGS=')).map((line) => JSON.parse(line.slice('GC_SETTINGS='.length)));
  expect(settings).toHaveLength(2);
  for (const answer of settings) {
    expect(answer.channel_idle_server).toBe('zulipp');
    expect(answer.channel_idle_warning).toBe(settingsWarning);
  }
  expect(err.filter((line) => line === inactiveLine)).toHaveLength(2);
}, 90_000);
