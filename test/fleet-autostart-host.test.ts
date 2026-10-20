/**
 * A real host launches its fleet's autoStart children through both places it
 * starts a framework: at its own start, and after a session switch, whose new
 * framework launches them again once the old one has stopped them. Each
 * place goes through startFramework, which starts the agents and then the
 * children (test/start-framework.test.ts pins that order). A Web UI client
 * welcomed again at the switch is told each child's recipe, as on `main`,
 * though the launches begin only as the Web UI is bound.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'node:net';
import { connectWhenAccepting } from './ipc-connect.js';

const INDEX_PATH = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'src', 'index.ts');

// No MCP servers, workspace or optional modules: both hosts start offline.
const RECIPE = {
  name: 'AutoStart host',
  agent: { name: 'parent', systemPrompt: 'never asked to infer in this test' },
  modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
};

const dirs: string[] = [];
const hosts: ChildProcess[] = [];
/** Each child's pid file. A child writes its own as it starts, and removes it as it shuts down. */
const pidFiles: string[] = [];

/** The pid a pid file holds, or null when there's none, including one its child removes as it's read. */
function pidIn(pidFile: string): string | null {
  try {
    return readFileSync(pidFile, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

afterEach(() => {
  for (const host of hosts.splice(0)) {
    try { if (host.exitCode === null) host.kill('SIGKILL'); } catch { /* gone */ }
  }
  // SIGKILL skips the host's exit handler, which stops its children, and a
  // child runs detached, so one a failed run leaves is stopped here, once it
  // has written its pid file.
  for (const pidFile of pidFiles.splice(0)) {
    const pid = Number(pidIn(pidFile));
    try { if (pid > 0) process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(25);
  }
}

/** Lines of command output the host sends on the socket. */
function outputs(socket: Socket): string[] {
  const lines: string[] = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const event = JSON.parse(line) as { type?: string; text?: string };
        if (event.type === 'command-output' && typeof event.text === 'string') lines.push(event.text);
      } catch { /* not ours */ }
    }
  });
  return lines;
}

describe('a host with autoStart children', () => {
  test('launches them at its start, and again after a session switch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-autostart-host-'));
    dirs.push(dir);
    const kidRecipe = join(dir, 'kid.json');
    writeFileSync(kidRecipe, JSON.stringify({ ...RECIPE, name: 'AutoStart child', agent: { ...RECIPE.agent, name: 'kid' } }));
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, JSON.stringify({
      ...RECIPE,
      modules: {
        ...RECIPE.modules,
        webui: { port: 0, host: '127.0.0.1' },
        fleet: { children: [{ name: 'kid', recipe: kidRecipe }] },
      },
    }));
    const host = spawn('bun', [INDEX_PATH, recipe, '--headless'], {
      // cwd is the temp dir, so the default MCPL config path can't pick up a real one.
      cwd: dir,
      env: { ...process.env, ANTHROPIC_API_KEY: 'sk-test-autostart-host', DATA_DIR: join(dir, 'data') },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    hosts.push(host);
    const exit = new Promise<number | null>((done) => host.once('exit', (code) => done(code)));
    let printed = '';
    host.stdout!.on('data', (chunk) => { printed += String(chunk); });

    const kidPid = join(dir, 'data', 'kid', 'headless.pid');
    pidFiles.push(kidPid);
    const pidNow = (): string | null => pidIn(kidPid);
    await until(() => pidNow() !== null, 20_000, 'the autoStart child starts with the host');
    const first = pidNow();

    const socketPath = join(dir, 'data', 'ipc.sock');
    await until(() => existsSync(socketPath), 15_000, 'the host serves its socket');
    // A Web UI client, connected once the host is up, and the children each welcome lists with their recipes.
    const listening = /\[webui\] listening on http:\/\/127\.0\.0\.1:(\d+)/;
    await until(() => listening.test(printed), 10_000, 'the host says where its Web UI listens');
    const port = Number(listening.exec(printed)![1]);
    const welcomes: Array<Array<{ name: string; recipe: string | null }>> = [];
    const page = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } } as unknown as undefined);
    page.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { type?: string; childTrees?: Array<{ name: string; recipe?: { name: string } }> };
      if (message.type === 'welcome') {
        welcomes.push((message.childTrees ?? []).map((tree) => ({ name: tree.name, recipe: tree.recipe?.name ?? null })));
      }
    });
    await until(() => welcomes.length === 1, 10_000, 'the Web UI welcomes the client');

    const socket = await connectWhenAccepting(socketPath);
    const lines = outputs(socket);
    socket.write(JSON.stringify({ type: 'command', command: '/session new' }) + '\n');
    await until(() => lines.includes('Session switched.'), 20_000, 'the session switch');
    await until(() => pidNow() !== null && pidNow() !== first, 20_000, "the new session's framework launches the child again");
    // The new framework's welcome lists the child with its recipe.
    await until(() => welcomes.length === 2, 10_000, 'the Web UI welcomes the client again after the switch');
    expect(welcomes[1]).toEqual([{ name: 'kid', recipe: 'AutoStart child' }]);
    page.close();

    socket.write(JSON.stringify({ type: 'shutdown' }) + '\n');
    expect(await exit).toBe(0);
    socket.destroy();
  }, 60_000);
});
