/**
 * A real host started as an install's entry point starts it: from one of the
 * install's releases, with CONNECTOME_INSTALL_ROOT naming the install. It
 * commits its release, keeps the children file its launcher reads, and
 * records a fleet child in its store from the child's spawn, synced, so a
 * parent killed then leaves the record. A root none of whose releases holds
 * it is refused before the host writes anything.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsStore } from '@animalabs/chronicle';
import { connectWhenAccepting } from './ipc-connect.js';
import { SessionManager } from '../src/session-manager.js';
import {
  appendJournal, childrenFilePath, copyItemName, copyLabelPath, installPaths, moveCurrent, readCurrent, readJournal,
  readRecord, writeJsonAtomic, type ChildrenFile,
} from '../src/update/contract.js';

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
 *  given, and otherwise as a host started on its own. */
function startHost(
  dir: string, index: string, root: string | null, modules: Record<string, unknown> = {}, recipeFields: Record<string, unknown> = {},
): { host: ChildProcess; stderr: () => string; exit: Promise<number | null> } {
  const recipe = join(dir, 'recipe.json');
  writeFileSync(recipe, JSON.stringify({ ...RECIPE, ...recipeFields, modules: { ...RECIPE.modules, ...modules } }));
  const env: Record<string, string | undefined> = { ...process.env, ANTHROPIC_API_KEY: 'sk-test-update-commit', DATA_DIR: join(dir, 'data') };
  if (root !== null) env.CONNECTOME_INSTALL_ROOT = root;
  else delete env.CONNECTOME_INSTALL_ROOT;
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
    const { stderr } = startHost(dir, index, root, {}, { mcpServers: { working: { command: process.execPath, args: [server] } } });
    // The journal's line comes just after the move.
    await until(() => readJournal(root).some(({ step }) => step === 'commit'), 30_000, `the trial commits (stderr: ${stderr().slice(-1500)})`);
    expect(readCurrent(root)).toBe('9.9.9');
    expect(stderr()).not.toContain("couldn't connect the MCPL server");
    expect(readJournal(root).map(({ step }) => step)).toEqual(['trial-start', 'commit']);
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
