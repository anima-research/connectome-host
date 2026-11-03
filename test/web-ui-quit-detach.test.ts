import { afterEach, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectWhenAccepting } from './ipc-connect.ts';

const INDEX = resolve(import.meta.dir, '..', 'src', 'index.ts');
const RECIPE = {
  name: 'Web UI detach',
  agent: { name: 'parent', systemPrompt: 'never asked to infer in this test' },
  modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false },
};

const dirs: string[] = [];
const hosts: ChildProcess[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const host of hosts.splice(0)) {
    if (host.exitCode !== null || host.signalCode !== null) continue;
    const exited = new Promise<void>((done) => host.once('exit', () => done()));
    host.kill('SIGKILL');
    await exited;
  }
  for (const dir of dirs.splice(0)) {
    let pid = 0;
    try { pid = Number(readFileSync(join(dir, 'data', 'kid', 'headless.pid'), 'utf8').trim()); } catch {}
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

async function until(check: () => boolean, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(25);
  }
}

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port!;
  server.stop(true);
  return port;
}

type Frame = { type?: string; corrId?: string; children?: string[]; lines?: Array<{ text: string }> };

async function openPage(port: number, ms: number): Promise<{ page: WebSocket; frames: Frame[] }> {
  const deadline = Date.now() + ms;
  for (;;) {
    const frames: Frame[] = [];
    const page = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    page.onmessage = (event) => { frames.push(JSON.parse(String(event.data))); };
    const opened = await new Promise<boolean>((done) => {
      page.onopen = () => done(true);
      page.onerror = () => done(false);
    });
    if (opened) {
      await until(() => frames.some((frame) => frame.type === 'welcome'), 15_000, 'the Web UI welcomes the page');
      return { page, frames };
    }
    if (Date.now() > deadline) throw new Error(`Timed out: the Web UI on port ${port} takes a page`);
    await Bun.sleep(250);
  }
}

for (const mode of ['headless', 'tui'] as const) {
  const title = mode === 'headless'
    ? "on a headless host, the Web UI's Detach & exit ends the host and leaves its fleet child running"
    : "on a TUI host, the Web UI's Detach & exit ends the host and leaves its fleet child running (Linux only)";
  test.skipIf(mode === 'tui' && process.platform !== 'linux')(title, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webui-detach-'));
    dirs.push(dir);
    const kidRecipe = join(dir, 'kid.json');
    writeFileSync(kidRecipe, JSON.stringify({ ...RECIPE, name: 'Web UI detach child', agent: { ...RECIPE.agent, name: 'kid' } }));
    const chosenPort = mode === 'tui' ? freePort() : 0;
    const recipe = join(dir, 'recipe.json');
    writeFileSync(recipe, JSON.stringify({ ...RECIPE, modules: {
      ...RECIPE.modules,
      webui: { host: '127.0.0.1', port: chosenPort },
      fleet: { children: [{ name: 'kid', recipe: kidRecipe }] },
    } }));
    const env: Record<string, string | undefined> = { ...process.env, ANTHROPIC_API_KEY: 'sk-test-webui-detach', DATA_DIR: join(dir, 'data') };
    delete env.CONNECTOME_INSTALL_ROOT;
    let host: ChildProcess;
    if (mode === 'headless') {
      host = spawn(process.execPath, [INDEX, recipe, '--headless'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } else {
      const quote = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
      const command = `stty cols 120 rows 40; exec ${[process.execPath, INDEX, recipe].map(quote).join(' ')}`;
      host = spawn('script', ['-qfec', command, '/dev/null'], { cwd: dir, env: { ...env, TERM: 'xterm-256color' }, stdio: ['pipe', 'pipe', 'pipe'] });
    }
    hosts.push(host);
    let stdout = '';
    let stderr = '';
    host.stdout!.on('data', (chunk) => { stdout += String(chunk); });
    host.stderr!.on('data', (chunk) => { stderr += String(chunk); });
    const exit = new Promise<number | null>((done) => host.once('close', (code) => done(code)));

    let port = chosenPort;
    if (mode === 'headless') {
      const listening = /\[webui\] listening on http:\/\/127\.0\.0\.1:(\d+)/;
      await until(() => listening.test(stdout), 30_000, `the host says where its Web UI listens (stderr: ${stderr.slice(-1500)})`);
      port = Number(listening.exec(stdout)![1]);
    }
    const { page, frames } = await openPage(port, 30_000);

    let pid = 0;
    for (let ask = 0; pid === 0; ask++) {
      const corrId = `status-${ask}`;
      page.send(JSON.stringify({ type: 'command', command: '/fleet status kid', corrId }));
      await until(() => frames.some((frame) => frame.type === 'command-result' && frame.corrId === corrId), 15_000, '/fleet status');
      const texts = frames.find((frame) => frame.corrId === corrId)!.lines!.map((line) => line.text);
      if (texts.some((text) => /^\s*status:\s+ready$/.test(text))) {
        pid = Number(/^\s*pid:\s+(\d+)$/.exec(texts.find((text) => /^\s*pid:/.test(text))!)![1]);
      } else {
        if (ask > 120) throw new Error(`the child never became ready: ${texts.join(' | ')}`);
        await Bun.sleep(250);
      }
    }

    page.send(JSON.stringify({ type: 'command', command: '/quit' }));
    await until(() => frames.some((frame) => frame.type === 'quit-confirm-required'), 15_000, 'the quit confirm');
    expect(frames.find((frame) => frame.type === 'quit-confirm-required')!.children).toEqual(['kid']);
    page.send(JSON.stringify({ type: 'quit-confirm', action: 'detach' }));
    expect(await exit).toBe(0);

    const socket = await connectWhenAccepting(join(dir, 'data', 'kid', 'ipc.sock'));
    sockets.push(socket);
    let heard = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { heard += chunk; });
    await until(() => heard.includes('\n'), 15_000, 'the child says it is ready');
    expect(JSON.parse(heard.slice(0, heard.indexOf('\n')))).toMatchObject({ type: 'lifecycle', phase: 'ready', pid });
  }, 90_000);
}
