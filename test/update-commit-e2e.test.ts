/**
 * A real host started as an install's entry point starts it: from one of the
 * install's releases, with CONNECTOME_INSTALL_ROOT naming the install. It
 * commits its release, keeps the children file its launcher reads, and
 * records a fleet child in its store from the child's spawn, synced, so a
 * parent killed then leaves the record. A root none of whose releases holds
 * it is refused before the host writes anything. A host and fleet child the
 * switch quiesced before their stop boot quiesced, and the start ends the
 * switch's quiesce, and only the switch's. A host's update reads the
 * registry at start, and a headless host's /update restart quiesces it,
 * writes the mark and exits 75; a batch run reads no registry on its own,
 * and prints a command's follow-up before it stops.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsStore } from '@animalabs/chronicle';
import { connectWhenAccepting } from './ipc-connect.js';
import { SessionManager } from '../src/session-manager.js';
import {
  appendJournal, childrenFilePath, copyItemName, copyLabelPath, installPaths, moveCurrent, readCurrent, readJournal,
  readRecord, switchQuiesceReason, writeJsonAtomic, type ChildrenFile,
} from '../src/update/contract.js';
import type { SwitchRequest } from '../src/update/quiesce.js';
import { TRIAL_LOG_LINES, type TrialLog } from '../src/update/trial-log.js';
import { hostModeRecord, writeHostModeRecord } from './host-mode-record.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// No MCP servers, workspace or optional modules: the host starts offline.
const RECIPE = {
  name: 'Update commit',
  agent: { name: 'commit', systemPrompt: 'never asked to infer in this test' },
  modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
};

const dirs: string[] = [];
const hosts: ChildProcess[] = [];

/** The pids a host's children file lists, and the pid its child's own pid
 *  file holds, which a child writes as it starts and removes as it stops. */
function childPids(dir: string): number[] {
  const pids: unknown[] = [];
  try {
    pids.push(...(readRecord<ChildrenFile>(childrenFilePath(join(dir, 'data')), 'children file')?.children ?? []).map((c) => c.pid));
  } catch { /* unreadable: the pid file still says */ }
  try {
    pids.push(Number(readFileSync(join(dir, 'data', 'kid', 'headless.pid'), 'utf8').trim()));
  } catch { /* none */ }
  return pids.filter((pid): pid is number => typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0);
}

afterEach(async () => {
  // A host stopped with SIGTERM stops its fleet's children as it stops.
  for (const host of hosts.splice(0)) {
    if (host.exitCode !== null || host.signalCode !== null) continue;
    const exited = new Promise<void>((done) => host.once('exit', () => done()));
    host.kill('SIGTERM');
    if (await Promise.race([exited.then(() => true), Bun.sleep(15_000).then(() => false)])) continue;
    host.kill('SIGKILL');
    await exited;
  }
  // A child runs detached, so one its parent couldn't stop, such as after a
  // SIGKILL, is stopped here, by every pid the children file lists and the
  // one its pid file holds.
  for (const dir of dirs.splice(0)) {
    for (const pid of childPids(dir)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Start a host on `index`, as an install's entry point does when `root` is
 *  given, and otherwise as a host started on its own. With `kid`, the host
 *  is the fleet child's recipe on its data directory, started on its own.
 *  `more` adds to its environment. */
function startHost(
  dir: string, index: string, root: string | null, modules: Record<string, unknown> = {}, recipeFields: Record<string, unknown> = {},
  kid = false, more: Record<string, string> = {},
): { host: ChildProcess; stderr: () => string; exit: Promise<number | null> } {
  const recipe = kid ? join(dir, 'kid.json') : join(dir, 'recipe.json');
  if (!kid) writeFileSync(recipe, JSON.stringify({ ...RECIPE, ...recipeFields, modules: { ...RECIPE.modules, ...modules } }));
  const env: Record<string, string | undefined> = {
    ...process.env, ANTHROPIC_API_KEY: 'sk-test-update-commit', DATA_DIR: kid ? join(dir, 'data', 'kid') : join(dir, 'data'), ...more,
  };
  if (root !== null) env.CONNECTOME_INSTALL_ROOT = root;
  else delete env.CONNECTOME_INSTALL_ROOT;
  // The notice's other off switch, which a developer's shell may export.
  delete env.NO_UPDATE_NOTIFIER;
  const host = spawn('bun', [index, recipe, '--headless'], {
    // cwd is the temp dir, so the default MCPL config path can't pick up a real one.
    cwd: dir,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  hosts.push(host);
  let err = '';
  host.stderr!.on('data', (chunk) => { err += String(chunk); });
  // 'close' comes once the host has exited and its stderr is all read.
  const exit = new Promise<number | null>((done) => host.once('close', (code) => done(code)));
  return { host, stderr: () => err, exit };
}

async function until(check: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(25);
  }
}

/** An install whose `current` names 9.9.8, beside a 9.9.9 that is this
 *  checkout, as setup's link to an install would be, and a recipe for a
 *  fleet child. */
function install(): { dir: string; root: string; index: string; fleet: Record<string, unknown> } {
  const dir = mkdtempSync(join(tmpdir(), 'update-commit-e2e-'));
  dirs.push(dir);
  const root = join(dir, 'install');
  mkdirSync(join(root, 'releases', '9.9.8'), { recursive: true });
  symlinkSync(REPO_ROOT, join(root, 'releases', '9.9.9'));
  moveCurrent(root, '9.9.8');
  const kidRecipe = join(dir, 'kid.json');
  writeFileSync(kidRecipe, JSON.stringify({ ...RECIPE, name: 'Update commit child', agent: { ...RECIPE.agent, name: 'kid' } }));
  return {
    dir, root, index: join(root, 'releases', '9.9.9', 'src', 'index.ts'),
    fleet: { fleet: { children: [{ name: 'kid', recipe: kidRecipe }] } },
  };
}

/** As the install's launcher leaves it for a switch's trial from 9.9.8 to
 *  9.9.9: a copy of the data directory, with its label, and the journal's
 *  `trial-start` line. A release `current` doesn't name starts only so. */
function onTrial(dir: string, root: string): void {
  const { copy } = installPaths(root);
  const dataDir = join(dir, 'data');
  const name = copyItemName(0, dataDir);
  mkdirSync(join(copy, name), { recursive: true });
  const at = new Date().toISOString();
  writeJsonAtomic(copyLabelPath(copy), { v: 1, from: '9.9.8', at, items: [{ path: dataDir, name }], mark: 'm-1' });
  appendJournal(root, { at, step: 'trial-start', from: '9.9.8', to: '9.9.9', outcome: 'ok', mark: 'm-1' });
}

/** Ask a host over its socket what a fleet asks of its child for a switch
 *  (src/update/quiesce.ts), and wait for its answer. The connection first
 *  narrows its events to `lifecycle`, as a fleet's subscription can, and the
 *  answer comes all the same. */
async function askSwitch(socketPath: string, request: SwitchRequest): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  const socket = await connectWhenAccepting(socketPath);
  socket.setEncoding('utf8');
  const corrId = `switch-${request.op}`;
  try {
    return await new Promise((done) => {
      let buffer = '';
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let event: { type?: string; corrId?: string };
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type === 'update-response' && event.corrId === corrId) done(event as never);
        }
      });
      socket.write(JSON.stringify({ type: 'subscribe', events: ['lifecycle'] }) + '\n');
      socket.write(JSON.stringify({ type: 'update-request', corrId, request }) + '\n');
    });
  } finally {
    socket.destroy();
  }
}

/** As the last start before a switch leaves them: the install's host and its
 *  fleet child, each served on its own and stopped, quiesced either as the
 *  switch's request quiesces a host, for a switch to 9.9.9, or as an
 *  operator's quiesce leaves agent-framework's record, under `operator`. */
async function quiesceAndStop(dir: string, index: string, operator?: string): Promise<void> {
  for (const kid of [false, true]) {
    const dataDir = kid ? join(dir, 'data', 'kid') : join(dir, 'data');
    const { exit, stderr } = startHost(dir, index, null, {}, {}, kid);
    const socketPath = join(dataDir, 'ipc.sock');
    await until(() => existsSync(socketPath), 20_000, `the host serves its socket (stderr: ${stderr().slice(-1500)})`);
    if (operator === undefined) {
      expect(await askSwitch(socketPath, { op: 'quiesce', to: '9.9.9', waitMs: 5_000 }))
        .toMatchObject({ ok: true, data: { answered: true, drained: true, activeTurnAgents: [] } });
    }
    const socket = await connectWhenAccepting(socketPath);
    socket.write(JSON.stringify({ type: 'shutdown' }) + '\n');
    expect(await exit).toBe(0);
    socket.destroy();
    if (operator !== undefined) writeHostModeRecord(dataDir, operator);
    expect(hostModeRecord(dataDir)).toMatchObject({ quiesced: true, reason: operator ?? switchQuiesceReason('9.9.9') });
  }
}

/** The children file's entry for the fleet child, if it lists one. */
function kidIn(dir: string): ChildrenFile['children'][number] | undefined {
  return readRecord<ChildrenFile>(childrenFilePath(join(dir, 'data')), 'children file')?.children.find((c) => c.name === 'kid');
}

describe('a host started from an install', () => {
  test('commits its release on a real start, and lists its fleet child in the children file until it stops it', async () => {
    const { dir, root, index, fleet } = install();
    onTrial(dir, root);
    const { exit } = startHost(dir, index, root, fleet);
    const socketPath = join(dir, 'data', 'ipc.sock');
    await until(() => existsSync(socketPath), 15_000, 'the host serves its socket');
    expect(readCurrent(root)).toBe('9.9.9');

    // The child launches once the parent's agents have started, and serves
    // its own socket once it has started too. The journal holds the parent's
    // commit only; that the child gets no install root is the fleet's unit
    // test's (fleet-children-file.test.ts).
    await until(() => typeof kidIn(dir)?.pid === 'number', 20_000, 'the children file lists the running child');
    expect(kidIn(dir)!.dataDir).toBe(join(dir, 'data', 'kid'));
    await until(() => existsSync(join(dir, 'data', 'kid', 'ipc.sock')), 20_000, 'the child serves its socket');
    expect(readJournal(root).map(({ step, from, to, outcome }) => ({ step, from, to, outcome }))).toEqual([
      { step: 'trial-start', from: '9.9.8', to: '9.9.9', outcome: 'ok' },
      { step: 'commit', from: '9.9.8', to: '9.9.9', outcome: 'ok' },
    ]);

    const socket = await connectWhenAccepting(socketPath);
    socket.write(JSON.stringify({ type: 'shutdown' }) + '\n');
    expect(await exit).toBe(0);
    socket.destroy();
    // The parent stopped its child before it exited, and the file says so.
    expect(kidIn(dir)!.pid).toBeNull();
    expect(readCurrent(root)).toBe('9.9.9');
  }, 60_000);

  test("a parent killed as soon as its child is spawned leaves the child in its store's record", async () => {
    const { dir, root, index, fleet } = install();
    onTrial(dir, root);
    const { host, exit } = startHost(dir, index, root, fleet);
    await until(() => typeof kidIn(dir)?.pid === 'number', 35_000, 'the children file lists the running child');
    const pid = kidIn(dir)!.pid;
    host.kill('SIGKILL');
    await exit;
    const sessions = new SessionManager(join(dir, 'data'));
    const store = JsStore.openOrCreate({ path: sessions.getStorePath(sessions.load().activeSessionId) });
    try {
      const record = store.getStateJson('modules/fleet/state') as { children?: Record<string, { pid: number | null }> } | null;
      expect(record?.children?.kid?.pid).toBe(pid);
    } finally {
      store.close();
    }
  }, 60_000);

  test('a trial whose MCPL server connects commits, so a working server reads as connected when the commit runs', async () => {
    const { dir, root, index } = install();
    onTrial(dir, root);
    // A stdio server that answers just enough of the handshake to connect.
    const server = join(dir, 'working-mcpl.mjs');
    writeFileSync(server, [
      "import { createInterface } from 'node:readline';",
      "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
      "createInterface({ input: process.stdin }).on('line', (line) => {",
      '  let msg; try { msg = JSON.parse(line); } catch { return; }',
      '  if (msg.id === undefined || msg.method === undefined) return;',
      "  if (msg.method === 'initialize') {",
      "    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'working', version: '0.0.0' } } });",
      "  } else if (msg.method === 'tools/list') {",
      "    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });",
      '  } else {',
      "    send({ jsonrpc: '2.0', id: msg.id, result: {} });",
      '  }',
      '});',
    ].join('\n'));
    const { host, stderr, exit } = startHost(dir, index, root, {}, { mcpServers: { working: { command: process.execPath, args: [server] } } });
    // The journal's line comes just after the move.
    await until(() => readJournal(root).some(({ step }) => step === 'commit'), 30_000, `the trial commits (stderr: ${stderr().slice(-1500)})`);
    expect(readCurrent(root)).toBe('9.9.9');
    expect(stderr()).not.toContain("couldn't connect the MCPL server");
    expect(readJournal(root).map(({ step }) => step)).toEqual(['trial-start', 'commit']);
    // Committed, it keeps no trial log: headless's SIGTERM ends it through process.exit, which runs exit handlers.
    // Its handlers go on just after its socket listens, so a SIGTERM before then would end it with none run.
    const log = join(dir, 'data', 'headless.log');
    await until(() => existsSync(log) && readFileSync(log, 'utf-8').includes('socket listening at'), 30_000, 'headless listens');
    host.kill('SIGTERM');
    expect(await exit).toBe(0);
    expect(existsSync(installPaths(root).trialLog)).toBe(false);
  }, 60_000);

  test("a trial whose MCPL server doesn't connect stops before its commit, and says which", async () => {
    const { dir, root, index } = install();
    onTrial(dir, root);
    const server = join(dir, 'no-such-server');
    const { stderr, exit } = startHost(dir, index, root, {}, { mcpServers: { lost: { command: server } } });
    expect(await exit).toBe(1);
    expect(stderr()).toContain("This release couldn't connect the MCPL server lost, so it starts none of its agents, and the next start goes back to 9.9.8: ");
    expect(readCurrent(root)).toBe('9.9.8');
    expect(readJournal(root).map(({ step }) => step)).toEqual(['trial-start']);
    // What it wrote as it ended is kept for the release that falls back, readable by this user alone.
    const log = readRecord<TrialLog>(installPaths(root).trialLog, 'trial log');
    expect(log).toMatchObject({ v: 1, release: '9.9.9', mark: 'm-1' });
    expect(log!.lines.length).toBeGreaterThan(0);
    expect(log!.lines.length).toBeLessThanOrEqual(TRIAL_LOG_LINES);
    expect(log!.lines.some((line) => line.startsWith("Fatal error: Error: This release couldn't connect the MCPL server lost"))).toBe(true);
    expect(statSync(installPaths(root).trialLog).mode & 0o777).toBe(0o600);
  }, 60_000);

  test('a host started on its own keeps no children file, though its fleet starts a child', async () => {
    const { dir, fleet } = install();
    const { exit } = startHost(dir, join(REPO_ROOT, 'src', 'index.ts'), null, fleet);
    await until(() => existsSync(join(dir, 'data', 'kid', 'ipc.sock')), 30_000, 'the child serves its socket');
    expect(existsSync(childrenFilePath(join(dir, 'data')))).toBe(false);
    const socket = await connectWhenAccepting(join(dir, 'data', 'ipc.sock'));
    socket.write(JSON.stringify({ type: 'shutdown' }) + '\n');
    expect(await exit).toBe(0);
    socket.destroy();
    expect(existsSync(childrenFilePath(join(dir, 'data')))).toBe(false);
  }, 60_000);

  test('a root none of whose releases holds it is refused before anything is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-commit-e2e-'));
    dirs.push(dir);
    const root = join(dir, 'install');
    mkdirSync(join(root, 'releases', '9.9.9'), { recursive: true });

    const { stderr, exit } = startHost(dir, join(REPO_ROOT, 'src', 'index.ts'), root);
    expect(await exit).toBe(1);
    expect(stderr()).toContain(`CONNECTOME_INSTALL_ROOT names the install at ${root}, but none of its releases holds this host`);
    expect(existsSync(join(dir, 'data'))).toBe(false);
    expect(readCurrent(root)).toBeNull();
  }, 30_000);
});

describe('a host the switch quiesced before its stop', () => {
  /** Start the trial with its fleet child, and stop it once the child serves
   *  its socket, which it does only after its own start has resumed or not,
   *  and after the parent's has, since the parent launches it after that. */
  async function startTrial(dir: string, root: string, index: string, fleet: Record<string, unknown>): Promise<string> {
    onTrial(dir, root);
    const { stderr, exit } = startHost(dir, index, root, fleet);
    await until(() => existsSync(join(dir, 'data', 'kid', 'ipc.sock')), 40_000, `the child serves its socket (stderr: ${stderr().slice(-1500)})`);
    expect(readJournal(root).map(({ step }) => step)).toEqual(['trial-start', 'commit']);
    expect(readCurrent(root)).toBe('9.9.9');
    const socket = await connectWhenAccepting(join(dir, 'data', 'ipc.sock'));
    socket.write(JSON.stringify({ type: 'shutdown' }) + '\n');
    expect(await exit).toBe(0);
    socket.destroy();
    return stderr();
  }

  test("boots quiesced, commits, and ends the switch's quiesce once framework.start() has run, in its fleet child too", async () => {
    const { dir, root, index, fleet } = install();
    const reason = switchQuiesceReason('9.9.9');
    await quiesceAndStop(dir, index);
    const stderr = await startTrial(dir, root, index, fleet);
    expect(stderr).toContain(`BOOTING QUIESCED (persisted: ${reason}`);
    expect(hostModeRecord(join(dir, 'data'))?.quiesced).toBe(false);
    expect(hostModeRecord(join(dir, 'data', 'kid'))?.quiesced).toBe(false);
  }, 120_000);

  test("an operator's quiesce stays through the switch's start, in its fleet child too", async () => {
    const { dir, root, index, fleet } = install();
    const reason = 'an operator checking the disk';
    await quiesceAndStop(dir, index, reason);
    const stderr = await startTrial(dir, root, index, fleet);
    expect(stderr).toContain(`BOOTING QUIESCED (persisted: ${reason}`);
    expect(hostModeRecord(join(dir, 'data'))).toMatchObject({ quiesced: true, reason });
    expect(hostModeRecord(join(dir, 'data', 'kid'))).toMatchObject({ quiesced: true, reason });
  }, 120_000);
});

describe("a host's update, on a real start", () => {
  test('reads the registry at start, logs a newer release once with its cost, and /update says the same over its socket', async () => {
    const { dir, root, index } = install();
    moveCurrent(root, '9.9.9');
    const running = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string }).version;
    const asked: string[] = [];
    const registry = Bun.serve({
      port: 0,
      fetch: (request) => {
        asked.push(new URL(request.url).pathname);
        return Response.json({ versions: { [running]: {}, '99.0.0': { connectomeRelease: { breaking: true, cacheWrite: false } } } });
      },
    });
    try {
      const { stderr } = startHost(dir, index, root, {}, {}, false, {
        CONNECTOME_UPDATE_CHECK: '1', npm_config_registry: `http://127.0.0.1:${registry.port}`,
      });
      await until(() => stderr().includes('[update] Notes:'), 20_000, 'the start logs the notice');
      expect(stderr()).toContain(`[update] connectome-host 99.0.0 is out; this host runs ${running}.\n[update] Breaking: 99.0.0.`);
      expect(asked).toEqual(['/@animalabs%2fconnectome-host']);

      const socketPath = join(dir, 'data', 'ipc.sock');
      await until(() => existsSync(socketPath), 15_000, 'the host serves its socket');
      const socket = await connectWhenAccepting(socketPath);
      const said: string[] = [];
      let buffered = '';
      let health: { update?: Record<string, unknown> } | null = null;
      socket.on('data', (chunk) => {
        buffered += String(chunk);
        for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
          const event = JSON.parse(buffered.slice(0, at)) as { type?: string; text?: string; corrId?: string; data?: unknown };
          buffered = buffered.slice(at + 1);
          if (event.type === 'command-output' && typeof event.text === 'string') said.push(event.text);
          if (event.type === 'panel-response' && event.corrId === 'h1') health = event.data as typeof health;
        }
      });
      socket.write(JSON.stringify({ type: 'command', command: '/update' }) + '\n');
      await until(() => said.some((line) => line.startsWith('To take it:')), 15_000, '/update answers');
      expect(said).toContain(`connectome-host 99.0.0 is out; this host runs ${running}.`);
      expect(said).toContain('Notes: https://github.com/anima-research/connectome-host/blob/v99.0.0/CHANGELOG.md');
      // Seen at start, the release isn't logged again, though /update read the registry again.
      expect(asked).toHaveLength(2);
      expect(stderr().split('is out; this host runs').length).toBe(2);
      // The health snapshot, which /healthz and a fleet parent read, carries it too.
      socket.write(JSON.stringify({ type: 'panel-request', op: 'health', corrId: 'h1' }) + '\n');
      await until(() => health !== null, 15_000, 'the health snapshot answers');
      expect(health!.update).toMatchObject({
        running, install: true, checks: true, installed: null, goBack: null, restart: null, lastSwitch: null,
        check: { ok: true, candidate: '99.0.0', costs: [{ version: '99.0.0', breaking: true, cacheWrite: false }] },
      });
      socket.destroy();
    } finally {
      registry.stop(true);
    }
  }, 60_000);

  test('/update restart quiesces a headless host, writes the mark and exits 75, for the next start to switch', async () => {
    const { dir, root, index } = install();
    moveCurrent(root, '9.9.9');
    // A newer release in place, as Update leaves one.
    const placed = join(root, 'releases', '9.9.10', 'node_modules', '@animalabs', 'connectome-host');
    mkdirSync(join(placed, 'src', 'update'), { recursive: true });
    writeFileSync(join(placed, 'package.json'), JSON.stringify({ version: '9.9.10' }));
    writeFileSync(join(placed, 'src', 'index.ts'), '');
    writeFileSync(join(placed, 'src', 'update', 'launcher.ts'), '');
    const { stderr, exit } = startHost(dir, index, root);
    const socketPath = join(dir, 'data', 'ipc.sock');
    await until(() => existsSync(socketPath), 20_000, `the host serves its socket (stderr: ${stderr().slice(-1500)})`);
    const socket = await connectWhenAccepting(socketPath);
    socket.write(JSON.stringify({ type: 'command', command: '/update restart' }) + '\n');
    expect(await exit).toBe(75);
    socket.destroy();
    expect(readRecord<{ to: string; why: string }>(installPaths(root).mark, 'mark')).toMatchObject({ to: '9.9.10', why: 'update' });
    expect(hostModeRecord(join(dir, 'data'))).toMatchObject({ quiesced: true, reason: switchQuiesceReason('9.9.10') });
    expect(readCurrent(root)).toBe('9.9.9');
  }, 60_000);

  // Readline mode needs a terminal, which util-linux's `script` gives it; macOS's
  // `script` takes other arguments, so this runs on Linux alone.
  test.skipIf(process.platform !== 'linux')(
    '/update restart in readline mode, with the Web UI up, stops the process and leaves the mark (Linux only)', async () => {
      const { dir, root, index } = install();
      moveCurrent(root, '9.9.9');
      const placed = join(root, 'releases', '9.9.10', 'node_modules', '@animalabs', 'connectome-host');
      mkdirSync(join(placed, 'src', 'update'), { recursive: true });
      writeFileSync(join(placed, 'package.json'), JSON.stringify({ version: '9.9.10' }));
      writeFileSync(join(placed, 'src', 'index.ts'), '');
      writeFileSync(join(placed, 'src', 'update', 'launcher.ts'), '');
      const recipe = join(dir, 'recipe.json');
      writeFileSync(recipe, JSON.stringify({ ...RECIPE, modules: { ...RECIPE.modules, webui: { host: '127.0.0.1', port: 0 } } }));
      const env: Record<string, string | undefined> = {
        ...process.env, ANTHROPIC_API_KEY: 'sk-test-update-commit', DATA_DIR: join(dir, 'data'), CONNECTOME_INSTALL_ROOT: root,
      };
      delete env.NO_UPDATE_NOTIFIER;
      const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
      const command = [process.execPath, index, recipe, '--no-tui'].map(quote).join(' ');
      const host = spawn('script', ['-qfec', command, '/dev/null'], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
      hosts.push(host);
      let out = '';
      host.stdout!.on('data', (chunk) => { out += String(chunk); });
      host.stderr!.on('data', (chunk) => { out += String(chunk); });
      const exit = new Promise<number | null>((done) => host.once('close', (code) => done(code)));
      await until(() => out.includes('connectome-host (readline mode)'), 30_000, `readline mode starts (output: ${out.slice(-1500)})`);
      host.stdin!.write('/update restart\r');
      // Its Web UI's server would keep the process, and with it the install's lock, if the stop left it up.
      expect(await exit).toBe(0);
      expect(out).toContain('Stopping to switch to 9.9.10: once it has stopped, start the host again, and that start does it.');
      expect(readRecord<{ to: string; why: string }>(installPaths(root).mark, 'mark')).toMatchObject({ to: '9.9.10', why: 'update' });
      expect(readCurrent(root)).toBe('9.9.9');
    }, 60_000);
});

describe('a slash command in batch mode', () => {
  test("prints a follow-up before the next line and before the batch stops, and reads no registry on its own", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-commit-e2e-'));
    dirs.push(dir);
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, JSON.stringify(RECIPE));
    const asked: string[] = [];
    // It answers after a moment, so /update's follow-up comes later than its first line.
    const registry = Bun.serve({ port: 0, fetch: async (request) => {
      asked.push(request.url);
      await Bun.sleep(300);
      return Response.json({ versions: {} });
    } });
    try {
      // The notice's reads turned on, as a host's would be: a batch run still doesn't make them.
      const env: Record<string, string | undefined> = {
        ...process.env, ANTHROPIC_API_KEY: 'sk-test-update-commit', DATA_DIR: join(dir, 'data'),
        CONNECTOME_UPDATE_CHECK: '1', npm_config_registry: `http://127.0.0.1:${registry.port}`,
      };
      delete env.CONNECTOME_INSTALL_ROOT;
      delete env.NO_UPDATE_NOTIFIER;
      const host = spawn('bun', [join(REPO_ROOT, 'src', 'index.ts'), recipe], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
      hosts.push(host);
      let out = '';
      host.stdout!.on('data', (chunk) => { out += String(chunk); });
      host.stdin!.end('/update\n/update bogus\n/update install\n');
      const code = await new Promise<number | null>((done) => host.once('close', (status) => done(status)));
      const lines = out.split('\n');
      const at = (start: string) => lines.findIndex((line) => line.startsWith(start));
      const last = (start: string) => lines.findLastIndex((line) => line.startsWith(start));
      // /update's answer waits on its read of the registry, and comes before the next line.
      expect(at('No newer release is offered')).toBeGreaterThan(at('> /update'));
      expect(at('> /update bogus')).toBeGreaterThan(at('No newer release is offered'));
      expect(at('Usage: /update')).toBeGreaterThan(at('> /update bogus'));
      expect(at('> /update install')).toBeGreaterThan(at('Usage: /update'));
      // Not an install, so Update's answer, its follow-up, is the refusal, and
      // it comes before the batch's end though no line of input follows it.
      expect(at('Reading the registry, then installing')).toBeGreaterThan(at('> /update install'));
      expect(last("This host wasn't started through an install's entry point")).toBeGreaterThan(at('Reading the registry, then installing'));
      expect(at('Done.')).toBeGreaterThan(last("This host wasn't started through an install's entry point"));
      expect(code).toBe(0);
      // /update's own read, and none on its own.
      expect(asked).toHaveLength(1);
    } finally {
      registry.stop(true);
    }
  }, 60_000);
});
